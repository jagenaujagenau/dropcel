import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { log } from "../lib/log";
import { AppState } from "./app-state";
import type { DeployOutcome, DeployProgress, Deployer, DeployRequest } from "./deployer";
import { refreshGitInfo } from "./git";
import { HeldChangesService } from "./held-changes";
import { Ipc } from "./ipc";
import { advance, isTerminal } from "./state-machine";
import type { DeploymentState, DeployTarget } from "./types";

/**
 * The deployment queue: one active deployment per project, changes debounced,
 * bursts coalesced. If files change while a deployment is running, exactly one
 * follow-up deployment runs afterwards — never a pile-up. This is the queue's
 * one invariant: a save never produces two deployments.
 *
 * Per project, a debounce fiber sleeps out the quiet window before starting a
 * deploy; a change that arrives mid-sleep interrupts and restarts it. Once a
 * deploy is running, further changes coalesce into a single pending target
 * (production always wins) consulted when the run finishes. Cancellation is
 * fiber interruption — it reaches the deployer's `handle.cancel()` through
 * `Effect.callback`'s interruption finalizer, same as a remote cancel PATCH
 * would need to.
 *
 * Every dependency is injected so the whole thing runs deterministically
 * under `TestClock` and a mock deployer in tests.
 */

export interface QueueProject {
  id: string;
  name: string;
  path: string;
  autoDeploy: boolean;
}

export interface TransitionInfo {
  url?: string | null;
  error?: string | null;
  exitCode?: number | null;
  /** On ready: digest of the content that was deployed. */
  contentDigest?: string | null;
}

export interface PipelineOptions {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxRetries: 2,
  baseDelayMs: 3_000,
};

export interface QueueDeps {
  deployer: Deployer;
  /**
   * Persist + broadcast every state change. This is the one dependency that
   * can't reduce to a `Context` requirement — it calls back into
   * `ReadyEffects` (persist/tray/clipboard/notify), which the queue must
   * not depend on directly (that would be a cycle: `ReadyEffects` doesn't
   * need the queue, but wiring it in would still couple two independently
   * testable services for no reason). Effect-returning, not
   * Promise-returning, so the queue's own pipeline never crosses back and
   * forth between execution models.
   */
  onTransition: (
    projectId: string,
    deploymentId: string,
    state: DeploymentState,
    info?: TransitionInfo,
  ) => Effect.Effect<void>;
  debounceMs?: number;
  pipeline?: PipelineOptions;
}

// ---- one deployment attempt, wrapped in Effect (formerly pipeline.ts) ------

/** Local-only failure (never crosses a boundary) — Data, not Schema. */
class DeployFailure extends Data.TaggedError("DeployFailure")<{
  outcome: DeployOutcome;
}> {}

/**
 * Build the Effect for one deployment attempt. Fails with DeployFailure so
 * the retry policy can inspect `retryable`; succeeds with the outcome
 * (including cancellation, which must never be retried). Interruption
 * (fiber cancellation) runs the finalizer, which cancels the CLI/API run in
 * flight — the queue's cancel path relies on exactly this.
 */
function attempt(
  deployer: Deployer,
  req: DeployRequest,
  onProgress: (p: DeployProgress) => void,
): Effect.Effect<DeployOutcome, DeployFailure> {
  return Effect.callback<DeployOutcome, DeployFailure>((resume) => {
    const handle = deployer.deploy(req, onProgress);
    void handle.done.then((outcome) => {
      if (outcome.ok || outcome.canceled) resume(Effect.succeed(outcome));
      else resume(Effect.fail(new DeployFailure({ outcome })));
    });
    return Effect.sync(() => handle.cancel());
  });
}

/**
 * Execute a deployment with automatic retries for transient failures.
 * Resolves with the final outcome — retries exhausted means the last
 * failure. Never fails: exhaustion and non-retryable failures alike resolve
 * as an unsuccessful DeployOutcome.
 */
function executeDeployment(
  deployer: Deployer,
  req: DeployRequest,
  onProgress: (p: DeployProgress) => void,
  onRetry: (attemptNumber: number) => void,
  options: PipelineOptions,
): Effect.Effect<DeployOutcome> {
  let attemptNumber = req.attempt;

  // suspend: each retry re-evaluates with the current attempt number.
  return Effect.suspend(() =>
    attempt(deployer, { ...req, attempt: attemptNumber }, onProgress),
  ).pipe(
    Effect.tapError((f) =>
      Effect.sync(() => {
        // Only announce a retry when the policy will actually run one.
        if (f.outcome.retryable && attemptNumber - req.attempt < options.maxRetries) {
          attemptNumber += 1;
          onRetry(attemptNumber);
        }
      }),
    ),
    // v3's exponential ∩ recurs(n) ∩ whileInput(retryable), as v4 retry options.
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(options.baseDelayMs)),
      times: options.maxRetries,
      while: (f: DeployFailure) => f.outcome.retryable,
    }),
    Effect.catch((f: DeployFailure) => Effect.succeed(f.outcome)),
  );
}

// ---- per-project slot --------------------------------------------------

interface Slot {
  /** Sleeping out the debounce window; a new change interrupts + restarts it. */
  readonly debounceFiber: Fiber.Fiber<void> | null;
  /** The one run allowed per project — everything else coalesces. */
  readonly active: { readonly fiber: Fiber.Fiber<void> } | null;
  /** A change arrived mid-deployment → run once more when done. Production
   * always wins over preview when both are pending (see `mergeTarget`). */
  readonly pendingTarget: DeployTarget | null;
}

const emptySlot: Slot = { debounceFiber: null, active: null, pendingTarget: null };

const mergeTarget = (
  pending: DeployTarget | null,
  incoming: DeployTarget,
): DeployTarget => (pending === "production" ? "production" : incoming);

// ---- the service ------------------------------------------------------

export interface DeployQueueShape {
  readonly setPaused: (paused: boolean) => Effect.Effect<void>;
  readonly setOffline: (offline: boolean) => Effect.Effect<void>;
  readonly isOffline: () => Effect.Effect<boolean>;
  /** Filesystem change: debounce, then deploy to production. */
  readonly notifyChange: (projectId: string) => Effect.Effect<void>;
  /** Explicit deploy (UI button or post-debounce). */
  readonly enqueue: (projectId: string, target: DeployTarget) => Effect.Effect<void>;
  readonly cancel: (projectId: string) => Effect.Effect<void>;
  /** Forget a project (folder was deleted). Cancels any in-flight work. */
  readonly remove: (projectId: string) => Effect.Effect<void>;
  readonly isActive: (projectId: string) => Effect.Effect<boolean>;
}

export class DeployQueue extends Context.Service<DeployQueue, DeployQueueShape>()(
  "dropcel/core/DeployQueue",
) {}

export const make = (deps: QueueDeps) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const held = yield* HeldChangesService;
    const appState = yield* AppState;
    const ipc = yield* Ipc;
    const slots = yield* Ref.make(new Map<string, Slot>());
    const pausedRef = yield* Ref.make(false);
    const offlineRef = yield* Ref.make(false);
    const debounceMs = deps.debounceMs ?? 2_000;
    const pipelineOptions = deps.pipeline ?? DEFAULT_PIPELINE_OPTIONS;

    /** The project as the queue needs it — resolved from `AppState` on every
     * call, same freshness guarantee the old `getProject` closure gave. */
    const getProject = (projectId: string): Effect.Effect<QueueProject | undefined> =>
      SubscriptionRef.get(appState.projects).pipe(
        Effect.map((projects) => {
          const p = projects.find((x) => x.id === projectId);
          return p ? { id: p.id, name: p.name, path: p.path, autoDeploy: p.autoDeploy } : undefined;
        }),
      );

    /** Persist a new deployment row (with fresh git info), returns its id. */
    const createDeployment = Effect.fn("DeployQueue.createDeployment")(function* (
      projectId: string,
      target: DeployTarget,
    ) {
      const project = (yield* SubscriptionRef.get(appState.projects)).find(
        (p) => p.id === projectId,
      );
      const git = project
        ? yield* refreshGitInfo(ipc, appState, projectId, project.name)
        : null;
      const dep = yield* ipc.db.insertDeployment(
        projectId,
        target,
        git?.branch ?? null,
        git?.sha ?? null,
      );
      yield* appState.upsertDeployment(dep);
      return dep.id;
    });

    /**
     * Guard (content-digest): skip an auto-deploy when the project's files
     * are byte-identical to what the last successful deploy shipped. A
     * guard failure must never block deploys — errors resolve to `false`.
     */
    const shouldSkipAuto = (projectId: string): Effect.Effect<boolean> =>
      Effect.fn("DeployQueue.shouldSkipAuto")(function* () {
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === projectId,
        );
        if (!project) return false;
        const latest = (yield* SubscriptionRef.get(appState.latestByProject))[projectId];
        if (latest && latest.state !== "ready") return false;
        const current = yield* ipc.files.contentDigest(project.name);
        const deployed = yield* ipc.db.getSetting(`content_digest:${projectId}`);
        const identical = Boolean(deployed) && current === deployed;
        if (identical) {
          log.info("queue", `skipping auto-deploy of ${project.name}: content unchanged`);
        }
        return identical;
      })().pipe(Effect.catch(() => Effect.succeed(false)));

    const getSlot = (projectId: string): Effect.Effect<Slot> =>
      Ref.get(slots).pipe(Effect.map((m) => m.get(projectId) ?? emptySlot));

    /** Reads the slot, creating (and persisting) an empty one if absent. */
    const ensureSlot = (projectId: string): Effect.Effect<Slot> =>
      Ref.modify(slots, (m) => {
        const existing = m.get(projectId);
        if (existing) return [existing, m] as const;
        const next = new Map(m);
        next.set(projectId, emptySlot);
        return [emptySlot, next] as const;
      });

    /** No-ops if the project was removed — nothing left to update. */
    const updateSlot = (projectId: string, f: (s: Slot) => Slot): Effect.Effect<void> =>
      Ref.update(slots, (m) => {
        const existing = m.get(projectId);
        if (!existing) return m;
        const next = new Map(m);
        next.set(projectId, f(existing));
        return next;
      });

    /** Clears active + pendingTarget together, returning what was pending.
     * No-ops (returns null) if the project was removed in the meantime. */
    const takePendingAndClearActive = (projectId: string): Effect.Effect<DeployTarget | null> =>
      Ref.modify(slots, (m) => {
        const existing = m.get(projectId);
        if (!existing) return [null, m] as const;
        const next = new Map(m);
        next.set(projectId, { ...existing, active: null, pendingTarget: null });
        return [existing.pendingTarget, next] as const;
      });

    const forkInto = <A>(effect: Effect.Effect<A>): Effect.Effect<Fiber.Fiber<A>> =>
      Effect.forkIn(effect, scope);

    /** Fire-and-forget interruption — never blocks the caller, matching
     * clearTimeout()/AbortController.abort()'s synchronous, non-waiting
     * nature. The fiber's own finalizers still run to completion. */
    const interruptForget = (fiber: Fiber.Fiber<unknown, unknown>): Effect.Effect<void> =>
      Fiber.interrupt(fiber).pipe(Effect.forkDetach, Effect.asVoid);

    // ---- deploy dispatch --------------------------------------------------

    const enqueue: (projectId: string, target: DeployTarget) => Effect.Effect<void> =
      Effect.fn("DeployQueue.enqueue")(function* (projectId, target) {
        const project = yield* getProject(projectId);
        if (!project) {
          log.warn("queue", `cannot deploy unknown project ${projectId}`);
          return;
        }
        const slot = yield* ensureSlot(projectId);
        if (slot.active) {
          // Coalesce: production wins over preview if both are requested.
          yield* updateSlot(projectId, (s) => ({
            ...s,
            pendingTarget: mergeTarget(s.pendingTarget, target),
          }));
          return;
        }
        // Reserve the slot synchronously — before the fork returns — so a
        // concurrent enqueue() for the same project (same synchronous tick,
        // e.g. a burst of calls before createDeployment resolves) always
        // sees `active` and coalesces instead of racing a second deploy.
        const fiber = yield* forkInto(runDeployCycle(projectId, target));
        yield* updateSlot(projectId, (s) => ({ ...s, active: { fiber } }));
      });

    /** Auto path: consult the skip guard (content unchanged → no deploy). A
     * guard failure must never block deploys. */
    const enqueueAutoUnlessSkipped: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.enqueueAutoUnlessSkipped",
    )(function* (projectId) {
      const skip = yield* shouldSkipAuto(projectId);
      if (skip) return;
      // Folder = truth: what's in the folder IS production.
      yield* enqueue(projectId, "production");
    });

    /** One deployment run, with retries, from creation through a terminal
     * state. Wrapped in `onExit` so cleanup — clearing the slot and chaining
     * a coalesced follow-up — runs no matter how the cycle ends: normal
     * completion, or interruption (cancel / app shutdown / scope close). */
    const runDeployCycle = (projectId: string, target: DeployTarget): Effect.Effect<void> => {
      let deploymentId: string | null = null;
      let state: DeploymentState = "queued";

      // `onTransition` is Effect-returning (see `QueueDeps`), but `setState`
      // is called from plain, non-Effect contexts (the deployer's raw
      // `onProgress` callback) as well as from inside `body`'s Effect.gen —
      // `Effect.runFork` is the fire-and-forget bridge in both cases,
      // preserving the original `void onTransition(...)` semantics exactly.
      const setState = (next: DeploymentState, info?: TransitionInfo) => {
        if (deploymentId === null || isTerminal(state)) return;
        state = next;
        Effect.runFork(deps.onTransition(projectId, deploymentId, state, info));
      };

      const body = Effect.gen(function* () {
        const project = yield* getProject(projectId);
        if (!project) return;

        const created = yield* createDeployment(projectId, target).pipe(Effect.result);
        if (Result.isFailure(created)) {
          log.warn("queue", `failed to create deployment record for ${projectId}`);
          return;
        }
        deploymentId = created.success;
        state = "queued";
        Effect.runFork(deps.onTransition(projectId, deploymentId, state));

        const onProgress = (p: DeployProgress) => {
          const next = advance(state, p.phase);
          if (next !== state) setState(next, p.url ? { url: p.url } : undefined);
          else if (p.url) Effect.runFork(deps.onTransition(projectId, deploymentId!, state, { url: p.url }));
        };

        // Entering the pipeline: mark preparing before the CLI produces output.
        setState("preparing");

        const outcome = yield* executeDeployment(
          deps.deployer,
          {
            deploymentId,
            projectName: project.name,
            projectPath: project.path,
            target,
            attempt: 1,
          },
          onProgress,
          () => {
            // On retry the pipeline restarts; reflect it in the UI.
            state = "preparing";
            Effect.runFork(deps.onTransition(projectId, deploymentId!, state));
          },
          pipelineOptions,
        );

        if (outcome.canceled) {
          setState("canceled", { exitCode: outcome.exitCode });
        } else if (outcome.ok) {
          setState("ready", {
            url: outcome.url,
            exitCode: outcome.exitCode,
            contentDigest: outcome.contentDigest ?? null,
          });
        } else {
          setState("failed", {
            url: outcome.url,
            error: outcome.error,
            exitCode: outcome.exitCode,
          });
        }
      });

      return body.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Interruption (user cancel / app shutdown) never reaches the
            // ok/failed/canceled branches above — this is the only place a
            // cancel is reflected as the terminal "canceled" state.
            if (Exit.hasInterrupts(exit)) setState("canceled");

            const pending = yield* takePendingAndClearActive(projectId);
            if (pending === "production") {
              // A change that arrived mid-deploy may already be included in
              // what just shipped — the guard prevents an identical
              // follow-up, but "production" pending bypasses it: an explicit
              // production request always redeploys.
              yield* enqueue(projectId, "production");
            } else if (pending) {
              yield* enqueueAutoUnlessSkipped(projectId);
            }
          }),
        ),
      );
    };

    // ---- filesystem-change debounce ---------------------------------------

    const debounceFire: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.debounceFire",
    )(function* (projectId) {
      yield* updateSlot(projectId, (s) => ({ ...s, debounceFiber: null }));
      // Went offline during the debounce window: hold, don't deploy.
      if (yield* Ref.get(offlineRef)) {
        yield* held.mark(projectId, "offline");
        return;
      }
      yield* enqueueAutoUnlessSkipped(projectId);
    });

    const notifyChange: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.notifyChange",
    )(function* (projectId) {
      if (yield* Ref.get(pausedRef)) return;
      const project = yield* getProject(projectId);
      if (!project || !project.autoDeploy) return;
      if (yield* Ref.get(offlineRef)) {
        yield* held.mark(projectId, "offline");
        return;
      }
      const slot = yield* ensureSlot(projectId);
      // A change during the wait restarts it — same semantics as
      // clearTimeout + setTimeout.
      if (slot.debounceFiber) yield* interruptForget(slot.debounceFiber);
      const fiber = yield* forkInto(
        Effect.sleep(Duration.millis(debounceMs)).pipe(
          Effect.flatMap(() => debounceFire(projectId)),
        ),
      );
      yield* updateSlot(projectId, (s) => ({ ...s, debounceFiber: fiber }));
    });

    // ---- lifecycle ----------------------------------------------------

    const cancel: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.cancel",
    )(function* (projectId) {
      const slot = yield* getSlot(projectId);
      if (slot.debounceFiber) yield* interruptForget(slot.debounceFiber);
      yield* updateSlot(projectId, (s) => ({ ...s, debounceFiber: null, pendingTarget: null }));
      if (slot.active) yield* interruptForget(slot.active.fiber);
    });

    const remove: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.remove",
    )(function* (projectId) {
      yield* cancel(projectId);
      yield* Ref.update(slots, (m) => {
        if (!m.has(projectId)) return m;
        const next = new Map(m);
        next.delete(projectId);
        return next;
      });
    });

    const isActive = (projectId: string): Effect.Effect<boolean> =>
      Ref.get(slots).pipe(Effect.map((m) => m.get(projectId)?.active != null));

    /**
     * Offline: hold auto-deploys instead of producing doomed CLI runs. Edits
     * accumulate as a dirty set; reconnecting deploys each dirty project once
     * — Dropbox semantics ("sync when back online").
     */
    const setOffline: (offline: boolean) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.setOffline",
    )(function* (offline) {
      yield* Ref.set(offlineRef, offline);
      if (!offline) {
        // Only projects with no remaining hold reason drain; the rest
        // deploy when their other holds (account switch, git operation)
        // clear.
        const freed = yield* held.release("offline");
        for (const projectId of freed) yield* notifyChange(projectId);
      }
    });

    const setPaused = (paused: boolean): Effect.Effect<void> => Ref.set(pausedRef, paused);

    const isOffline = (): Effect.Effect<boolean> => Ref.get(offlineRef);

    return DeployQueue.of({
      setPaused,
      setOffline,
      isOffline,
      notifyChange,
      enqueue,
      cancel,
      remove,
      isActive,
    });
  });

export const layer = (
  deps: QueueDeps,
): Layer.Layer<DeployQueue, never, HeldChangesService | AppState | Ipc> =>
  Layer.effect(DeployQueue, make(deps));
