import { cn } from "../lib/utils";
import type { Deployment } from "../core/types";

const LABELS: Record<string, string> = {
  detected: "Detected",
  queued: "Queued",
  preparing: "Preparing",
  uploading: "Uploading",
  building: "Building",
  ready: "Ready",
  failed: "Failed",
  canceled: "Canceled",
};

export function isDeploying(state: string | undefined): boolean {
  return ["queued", "preparing", "uploading", "building"].includes(state ?? "");
}

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
      {state ? LABELS[state] ?? state : "No deployments"}
    </span>
  );
}
