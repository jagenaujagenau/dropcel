import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AccountSessionService } from "./account-session";
import { AppState, type AppStateShape } from "./app-state";
import { refreshGitInfo, shouldHoldAutoDeploy } from "./git";
import { HeldChangesService } from "./held-changes";
import { Ipc, type IpcShape } from "./ipc";
import { DeployQueue } from "./queue";

/**
 * "Gate (git)": the check that holds auto-deploys while a git operation is
 * mid-flight or a branch lock is violated — CONTEXT.md's name for what used
 * to live unnamed in `composition.ts` as `notifyChangeGitGated` plus three
 * module-level mutables (`pendingSwitchMirror`, `gitHoldTimers`,
 * `integrationChecked`). The timers and the git-operation hold now live
 * inside this service's own construction (a `Ref<Map>` per instance,
 * forked fibers instead of `setInterval`), so a second `make()` call (tests)
 * never shares state with another. Manual deploys never go through here —
 * they call `DeployQueue.enqueue` directly.
 */

export interface AutoDeployGateShape {
  /**
   * Hold while a merge/rebase is in flight (re-checking every 15s until it
   * clears, since the concluding writes happen inside the ignored .git dir)
   * or while the opt-in branch lock doesn't match. A checkout back to the
   * locked branch rewrites tracked files, which re-enters this path
   * naturally. An unresolved account switch holds everything, unconditionally.
   */
  readonly notifyChangeGitGated: (projectId: string) => Effect.Effect<void>;
}

export class AutoDeployGate extends Context.Service<AutoDeployGate, AutoDeployGateShape>()(
  "dropcel/core/AutoDeployGate",
) {}

const RECHECK_INTERVAL_MS = 15_000;

export const make = (deps: { ipc: IpcShape; appState: AppStateShape }) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const held = yield* HeldChangesService;
    const deployQueue = yield* DeployQueue;
    const accountSession = yield* AccountSessionService;
    const { ipc, appState } = deps;

    /** projectId → the fiber re-checking its in-flight git operation. */
    const timers = yield* Ref.make(new Map<string, Fiber.Fiber<void>>());

    const refreshGit = Effect.fn("AutoDeployGate.refreshGit")(function* (projectId: string) {
      const project = (yield* SubscriptionRef.get(appState.projects)).find(
        (p) => p.id === projectId,
      );
      if (!project) return null;
      return yield* refreshGitInfo(ipc, appState, projectId, project.name);
    });

    const stopTimer: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "AutoDeployGate.stopTimer",
    )(function* (projectId) {
      const fiber = (yield* Ref.get(timers)).get(projectId);
      if (fiber) yield* Fiber.interrupt(fiber);
    });

    const clearGitHold: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "AutoDeployGate.clearGitHold",
    )(function* (projectId) {
      yield* stopTimer(projectId);
      yield* held.releaseOne(projectId, "git-operation");
    });

    /** One re-check pass, 15s out. Loops on itself while the operation is
     * still in flight; on the first pass the operation is gone (or the
     * project vanished), releases the hold and — if nothing else holds the
     * project and the gate no longer applies — deploys the pending change. */
    const holdTimerLoop: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "AutoDeployGate.holdTimerLoop",
    )(function* (projectId) {
      while (true) {
        yield* Effect.sleep(Duration.millis(RECHECK_INTERVAL_MS));
        const fresh = yield* refreshGit(projectId);
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === projectId,
        );
        if (project && fresh?.operation) continue; // still mid-operation — recheck again
        const freed = yield* held.releaseOne(projectId, "git-operation");
        if (project && freed && !shouldHoldAutoDeploy(fresh, project.lockedBranch).hold) {
          yield* deployQueue.notifyChange(projectId);
        }
        return;
      }
    });

    const startHoldTimer: (projectId: string) => Effect.Effect<void> = Effect.fn(
      "AutoDeployGate.startHoldTimer",
    )(function* (projectId) {
      if ((yield* Ref.get(timers)).has(projectId)) return;
      const fiber = yield* Effect.forkIn(
        // Always drop the map entry on the way out — natural completion
        // above, or interruption via `clearGitHold`/`stopTimer` — so a
        // finished timer never blocks the next one from starting.
        holdTimerLoop(projectId).pipe(
          Effect.ensuring(
            Ref.update(timers, (m) => {
              if (!m.has(projectId)) return m;
              const next = new Map(m);
              next.delete(projectId);
              return next;
            }),
          ),
        ),
        scope,
      );
      yield* Ref.update(timers, (m) => new Map(m).set(projectId, fiber));
    });

    const notifyChangeGitGated: AutoDeployGateShape["notifyChangeGitGated"] = Effect.fn(
      "AutoDeployGate.notifyChangeGitGated",
    )(function* (projectId) {
      const project = (yield* SubscriptionRef.get(appState.projects)).find(
        (p) => p.id === projectId,
      );
      if (!project) return;
      // Unresolved account switch: linked projects would deploy against
      // the previous account and fail — hold everything until the user
      // chooses.
      const accountState = yield* SubscriptionRef.get(accountSession.state);
      if (accountState.pendingSwitch) {
        yield* held.mark(projectId, "account-switch");
        return;
      }
      const git = yield* refreshGit(projectId);
      const verdict = shouldHoldAutoDeploy(git, project.lockedBranch);
      if (!verdict.hold) {
        yield* clearGitHold(projectId);
        yield* deployQueue.notifyChange(projectId);
        return;
      }
      if (git?.operation) {
        yield* held.mark(projectId, "git-operation");
        yield* startHoldTimer(projectId);
      }
    });

    return AutoDeployGate.of({ notifyChangeGitGated });
  });

export const layer: Layer.Layer<
  AutoDeployGate,
  never,
  Ipc | AppState | HeldChangesService | DeployQueue | AccountSessionService
> = Layer.effect(
  AutoDeployGate,
  Effect.gen(function* () {
    const ipc = yield* Ipc;
    const appState = yield* AppState;
    return yield* make({ ipc, appState });
  }),
);
