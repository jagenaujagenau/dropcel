import { Globe } from "lucide-react";
import { snapshotByProjectAtom, useAtomState } from "../core/atoms";
import { cn } from "../lib/utils";

/**
 * Deployment snapshot thumbnail. Vercel's dashboard screenshots have no
 * public CLI/API, so the app captures its own: after every Ready deployment
 * a headless Chromium renders the site to a PNG (see src-tauri/screenshot.rs)
 * which is shown here. Without a compatible browser installed this stays a
 * quiet placeholder — never an error.
 */
export function SitePreview({
  projectId,
  hasDeployment,
  className,
}: {
  projectId: string;
  hasDeployment: boolean;
  className?: string;
}) {
  const snapshot = useAtomState(snapshotByProjectAtom, {})[projectId];

  return (
    <div
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-border bg-surface-hover",
        className,
      )}
    >
      {snapshot ? (
        <img
          src={snapshot}
          alt="Latest deployment"
          className="absolute inset-0 h-full w-full object-cover object-top"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-faint">
          <Globe className="h-5 w-5" />
          <span className="text-[10px]">
            {hasDeployment ? "Snapshot after next deploy" : "No deployment yet"}
          </span>
        </div>
      )}
    </div>
  );
}
