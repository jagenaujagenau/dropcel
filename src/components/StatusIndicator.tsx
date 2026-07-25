import { cn, formatDuration, formatElapsed, timeAgo } from "../lib/utils";
import { useNow } from "../lib/useNow";
// The vocabulary lives in `core/project-list.ts`, not here: this module used
// to keep its own label table, which said "Ready" where the card's pill said
// "Live" for the same deployment.
import { isDeploying, statusLabel } from "../core/project-list";
import type { Deployment } from "../core/types";

export { isDeploying };

export function StatusDot({ state }: { state: string | undefined }) {
  return (
    <span
      className={cn(
        "inline-block h-[7px] w-[7px] rounded-full shrink-0",
        state === "ready" && "bg-success",
        state === "failed" && "bg-danger",
        state === "canceled" && "bg-faint",
        isDeploying(state) && "bg-warning animate-pulse-soft",
        !state && "bg-border-strong",
      )}
    />
  );
}

export function StatusLabel({
  deployment,
  className,
}: {
  deployment: Deployment | undefined;
  className?: string;
}) {
  const state = deployment?.state;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-muted", className)}>
      <StatusDot state={state} />
      {statusLabel(state)}
    </span>
  );
}

/**
 * The trailing timing text on a project row/card.
 *
 * While a deployment is in flight this is the only part of the UI that moves,
 * so it counts *up* from `startedAt` rather than showing the `—` that a null
 * `durationMs` would otherwise produce for the entire build — the stretch
 * where the user most wants evidence something is happening. Once terminal it
 * settles into the final duration plus a relative age that keeps ticking
 * (see `useNow` for why that needs driving at all).
 */
export function DeploymentTiming({
  deployment,
  className,
}: {
  deployment: Deployment | undefined;
  className?: string;
}) {
  const now = useNow();
  if (!deployment) return null;

  const live = isDeploying(deployment.state);
  const built = formatDuration(deployment.durationMs);
  return (
    <span
      className={cn("text-[11px] tabular-nums text-faint", className)}
      // Build time moves to the tooltip rather than being dropped: it is still
      // worth having, just not worth the ambiguity of sitting inline.
      title={live ? undefined : `Built in ${built}`}
    >
      {/*
        Only the age, not "12s · 3m ago". Two durations side by side read as
        one range — there was no way to tell which number was the build and
        which was the age without already knowing. Age is the one that answers
        the question people actually ask of this row ("is this current?"), so
        it is the one that stays.
      */}
      {live ? formatElapsed(deployment.startedAt, now) : timeAgo(deployment.startedAt, now)}
    </span>
  );
}

/**
 * How long the build took, on its own — for the table, which has the width to
 * give it a column of its own with a heading. That heading is what the card
 * could not provide: side by side and unlabelled, the two numbers read as a
 * range rather than as two different measurements.
 */
export function DeploymentDuration({
  deployment,
  className,
}: {
  deployment: Deployment | undefined;
  className?: string;
}) {
  const now = useNow();
  if (!deployment) return null;
  return (
    <span className={cn("text-[11px] tabular-nums text-faint", className)}>
      {isDeploying(deployment.state)
        ? formatElapsed(deployment.startedAt, now)
        : formatDuration(deployment.durationMs)}
    </span>
  );
}
