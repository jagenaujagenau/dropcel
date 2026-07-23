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
