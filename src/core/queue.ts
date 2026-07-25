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
import * as Semaphore from "effect/Semaphore";
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

/** Across all projects, not per-project — a burst of newly-detected projects
 * (e.g. the first reconcile of a full folder) would otherwise all start
 * deploying (and polling the Vercel API) at once. Projects beyond this cap
 * simply stay "queued" until a slot frees. */
const MAX_CONCURRENT_DEPLOYS = 4;

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
  /**
   * Whether an unresolved account switch is currently blocking auto-deploys.
   *
   * `AutoDeployGate` checks this too, but it isn't the only way into
   * `notifyChange`: `setOffline(false)`'s drain below and `composition`'s
   * startup `drainPersistedDirty` both call it directly, and both used to
   * sail straight past the account-switch hold. That's how a user could go
   * offline with edits piled up, switch Vercel accounts, come back online,
   * and have every held project deploy under the *new* account — precisely
   * what the hold exists to prevent. Startup was worse: `drainPersistedDirty`
   * runs before `refreshAuth()` has even resolved.
   *
   * Checking it here — beside the `offline` hold, at the one entry point every
   * auto-deploy passes through — makes it unbypassable rather than something
   * each new caller has to remember. Injected (rather than a
   * `AccountSessionService` context requirement) to keep the queue
   * independently testable; defaults to "nothing pending".
   */
  accountSwitchPending?: Effect.Effect<boolean>;
  /**
   * What to do with a project whose `offline` hold just cleared.
   *
   * Defaults to this queue's own `notifyChange`, which is what makes the
   * offline behaviour testable here with nothing else running. In the real
   * app it is wired to `AutoDeployGate`, because a project that has been
   * waiting out an outage has to re-pass the **Gate** — the user may have
   * started a rebase, switched branches, or signed out while it waited, and
   * going straight to `notifyChange` skipped all of that.
   */
  drainHeld?: (projectId: string) => Effect.Effect<void>;
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
  /** The most recent failure's server-directed wait, read by the schedule
   * below. Held here because a `Schedule` sees its own output, not the error
   * that triggered it. */
  let lastRetryAfterMs: number | null = null;

  // suspend: each retry re-evaluates with the current attempt number.
  return Effect.suspend(() =>
    attempt(deployer, { ...req, attempt: attemptNumber }, onProgress),
  ).pipe(
    Effect.tapError((f) =>
      Effect.sync(() => {
        lastRetryAfterMs = f.outcome.retryAfterMs ?? null;
        // Only announce a retry when the policy will actually run one.
        if (f.outcome.retryable && attemptNumber - req.attempt < options.maxRetries) {
          attemptNumber += 1;
          onRetry(attemptNumber);
        }
      }),
    ),
    /**
     * Exponential backoff, except when the server told us how long to wait.
     *
     * Vercel answers a rate-limited request with `Retry-After`, and its Hobby
     * limits (60 deployments per 5 minutes, 1 concurrent) are low enough that
     * a folder-watcher meets them in ordinary use. Retrying on our own 3s/6s
     * schedule then gave up well before the window cleared — turning a limit
     * that resolves in a minute into a visible deployment failure, while the
     * retries themselves added to the pressure. Deferring to the header is
     * both more likely to succeed and better behaviour toward the API.
     *
     * `modifyDelay` rather than a separate schedule so the attempt *count*
     * stays governed by `times` either way.
     */
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(options.baseDelayMs)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(
            lastRetryAfterMs != null ? Duration.millis(lastRetryAfterMs) : duration,
          ),
        ),
      ),
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
  /**
   * Whether anything pending was an *explicit* user request rather than a
   * filesystem change.
   *
   * The target alone can't answer this: auto-deploys are production too
   * ("folder = truth"), so `pendingTarget === "production"` says nothing about
   * where the request came from. Without this flag the follow-up path treated
   * every coalesced auto change as a manual production deploy and skipped the
   * content-digest guard — meaning a save that landed mid-deploy always
   * produced a second, byte-identical deployment, even though the guard exists
   * precisely to prevent that (and the README promises it).
   *
   * Sticky once set: if a manual deploy and an auto change both coalesce, the
   * manual one's "always redeploy" semantics win.
   */
  readonly pendingManual: boolean;
}

const emptySlot: Slot = {
  debounceFiber: null,
  active: null,
  pendingTarget: null,
  pendingManual: false,
};

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
    const deploySemaphore = yield* Semaphore.make(MAX_CONCURRENT_DEPLOYS);
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

    /** Clears active + pending state together, returning what was pending
     * (target, and whether any of it was an explicit user request).
     * No-ops (returns a null target) if the project was removed meanwhile. */
    const takePendingAndClearActive = (
      projectId: string,
    ): Effect.Effect<{ target: DeployTarget | null; manual: boolean }> =>
      Ref.modify(slots, (m) => {
        const existing = m.get(projectId);
        if (!existing) return [{ target: null, manual: false }, m] as const;
        const next = new Map(m);
        next.set(projectId, {
          ...existing,
          active: null,
          pendingTarget: null,
          pendingManual: false,
        });
        return [
          { target: existing.pendingTarget, manual: existing.pendingManual },
          next,
        ] as const;
      });

    const forkInto = <A>(effect: Effect.Effect<A>): Effect.Effect<Fiber.Fiber<A>> =>
      Effect.forkIn(effect, scope);

    /** Fire-and-forget interruption — never blocks the caller, matching
     * clearTimeout()/AbortController.abort()'s synchronous, non-waiting
     * nature. The fiber's own finalizers still run to completion. */
    const interruptForget = (fiber: Fiber.Fiber<unknown, unknown>): Effect.Effect<void> =>
      Fiber.interrupt(fiber).pipe(Effect.forkDetach, Effect.asVoid);

    // ---- deploy dispatch --------------------------------------------------

    /** `manual` distinguishes an explicit user request (Redeploy, Deploy
     * Preview) from a filesystem-driven one; see `Slot.pendingManual`. */
    const enqueueWith: (
      projectId: string,
      target: DeployTarget,
      manual: boolean,
    ) => Effect.Effect<void> = Effect.fn("DeployQueue.enqueue")(function* (
      projectId,
      target,
      manual,
    ) {
        const project = yield* getProject(projectId);
        if (!project) {
          log.warn("queue", `cannot deploy unknown project ${projectId}`);
          return;
        }
        const slot = yield* ensureSlot(projectId);
        if (slot.active) {
          // Coalesce: production wins over preview if both are requested, and
          // a manual request anywhere in the burst keeps its bypass-the-guard
          // semantics for the whole follow-up.
          yield* updateSlot(projectId, (s) => ({
            ...s,
            pendingTarget: mergeTarget(s.pendingTarget, target),
            pendingManual: s.pendingManual || manual,
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

    /** The public entry point — always an explicit user request. */
    const enqueue = (projectId: string, target: DeployTarget): Effect.Effect<void> =>
      enqueueWith(projectId, target, true);

    /** Auto path: consult the skip guard (content unchanged → no deploy). A
     * guard failure must never block deploys. */
    const enqueueAutoUnlessSkipped: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "DeployQueue.enqueueAutoUnlessSkipped",
    )(function* (projectId) {
      const skip = yield* shouldSkipAuto(projectId);
      if (skip) return;
      // Folder = truth: what's in the folder IS production — which is exactly
      // why the target can't be used to tell this apart from a manual deploy.
      yield* enqueueWith(projectId, "production", false);
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

        // Bounded across all projects: a project stays "queued" here until a
        // permit frees up, rather than every newly-detected project starting
        // its pipeline (and API polling) at once.
        const outcome = yield* deploySemaphore.withPermit(
          Effect.gen(function* () {
            // Entering the pipeline: mark preparing before the CLI produces output.
            setState("preparing");
            return yield* executeDeployment(
              deps.deployer,
              {
                deploymentId: deploymentId!,
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
          }),
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
            if (!pending.target) return;
            if (pending.manual) {
              // An explicit user request always redeploys, guard or not —
              // "Redeploy" that decides not to is a broken button.
              yield* enqueueWith(projectId, pending.target, true);
            } else {
              // A change that arrived mid-deploy is very often already part of
              // what just shipped (the manifest is collected *after* the
              // debounce). The digest guard is what turns that into a no-op
              // instead of a second, byte-identical deployment.
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
      // Checked before `offline` so a project freed by reconnecting can't slip
      // through to a deploy under an account the user hasn't confirmed. If it
      // is also offline, the offline hold gets marked on the re-drain after
      // the switch resolves.
      if (yield* deps.accountSwitchPending ?? Effect.succeed(false)) {
        yield* held.mark(projectId, "account-switch");
        return;
      }
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
        const drain = deps.drainHeld ?? notifyChange;
        for (const projectId of freed) yield* drain(projectId);
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
