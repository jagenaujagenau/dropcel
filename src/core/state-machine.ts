import type { DeploymentState } from "./types";

/**
 * The deployment lifecycle as an explicit transition table. Every state
 * change in the app goes through `transition`, so illegal jumps (e.g.
 * ready → building) are impossible by construction rather than by
 * discipline.
 *
 *   detected → queued → preparing → uploading → building → ready
 *                                                        ↘ failed
 *   (any non-terminal state) → canceled | failed
 */

const TRANSITIONS: Record<DeploymentState, readonly DeploymentState[]> = {
  detected: ["queued"],
  queued: ["preparing", "canceled", "failed"],
  preparing: ["uploading", "building", "canceled", "failed"],
  // The CLI sometimes skips explicit upload output for tiny projects.
  uploading: ["building", "ready", "canceled", "failed"],
  building: ["ready", "canceled", "failed"],
  ready: [],
  failed: [],
  canceled: [],
};

export const TERMINAL_STATES: readonly DeploymentState[] = [
  "ready",
  "failed",
  "canceled",
];

export function isTerminal(state: DeploymentState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: DeploymentState, to: DeploymentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export type TransitionResult =
  | { ok: true; state: DeploymentState }
  | { ok: false; error: string };

export function transition(
  from: DeploymentState,
  to: DeploymentState,
): TransitionResult {
  if (canTransition(from, to)) return { ok: true, state: to };
  return {
    ok: false,
    error: `illegal deployment transition: ${from} → ${to}`,
  };
}

/**
 * Advance monotonically: log-driven phase detection can observe phases out of
 * order or repeat them; this only ever moves forward along the pipeline.
 */
const PIPELINE_ORDER: DeploymentState[] = [
  "detected",
  "queued",
  "preparing",
  "uploading",
  "building",
];

export function advance(
  current: DeploymentState,
  observed: DeploymentState,
): DeploymentState {
  if (isTerminal(current)) return current;
  const a = PIPELINE_ORDER.indexOf(current);
  const b = PIPELINE_ORDER.indexOf(observed);
  if (b > a && canTransition(current, observed)) return observed;
  // Skipped intermediate phases: walk forward one legal step at a time.
  if (b > a) {
    let state = current;
    while (PIPELINE_ORDER.indexOf(state) < b) {
      const next = PIPELINE_ORDER[PIPELINE_ORDER.indexOf(state) + 1];
      if (!canTransition(state, next)) break;
      state = next;
    }
    return state;
  }
  return current;
}
