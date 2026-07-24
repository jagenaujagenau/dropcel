import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AppStateShape } from "./app-state";
import type { IpcShape } from "./ipc";

/**
 * Git-aware auto-deploy policy. Two independent guards:
 *
 * 1. Mid-operation hold — a merge/rebase/cherry-pick/bisect in flight means
 *    the working tree is transiently broken (conflict markers, half-applied
 *    commits); deploying it wastes a build and produces a scary failure.
 * 2. Branch lock (opt-in, per project) — auto-deploys only run while the
 *    repo is on the locked branch.
 *
 * Manual deploys bypass both: clicking Deploy is explicit intent.
 */

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  sha: string | null;
  operation: string | null;
}

export interface HoldVerdict {
  hold: boolean;
  reason: string | null;
}

export function shouldHoldAutoDeploy(
  git: GitStatus | null,
  lockedBranch: string | null,
): HoldVerdict {
  if (!git?.isRepo) return { hold: false, reason: null };
  if (git.operation) {
    return { hold: true, reason: `${git.operation} in progress` };
  }
  if (lockedBranch) {
    if (!git.branch) {
      return { hold: true, reason: `locked to ${lockedBranch} — detached HEAD` };
    }
    if (git.branch !== lockedBranch) {
      return { hold: true, reason: `locked to ${lockedBranch} — on ${git.branch}` };
    }
  }
  return { hold: false, reason: null };
}

export const shortSha = (sha: string | null | undefined): string | null =>
  sha ? sha.slice(0, 7) : null;

/**
 * Re-read a project's git status from disk and persist it into `AppState`.
 * Shared by every caller that needs fresh git info before deciding whether
 * to deploy or gate (`DeployQueue.createDeployment`, `AutoDeployGate`, the
 * reconciler's `onProjectPresent` hook) — one implementation, not three.
 */
export const refreshGitInfo = (
  ipc: IpcShape,
  appState: AppStateShape,
  projectId: string,
  projectName: string,
): Effect.Effect<GitStatus | null> =>
  Effect.gen(function* () {
    const git = yield* ipc.git.info(projectName).pipe(Effect.catch(() => Effect.succeed(null)));
    yield* SubscriptionRef.update(appState.gitByProject, (m) => ({ ...m, [projectId]: git }));
    return git;
  });
