import { useAtomValue } from "@effect/atom-react";
import { projectSnapshotAtom } from "../core/atoms";
import type { Framework } from "../core/types";
import { cn } from "../lib/utils";
import { FrameworkIcon } from "./FrameworkIcon";

/**
 * Deployment snapshot thumbnail. Vercel's dashboard screenshots have no
 * public CLI/API, so the app captures its own: after every Ready deployment
 * a headless Chromium renders the site to a PNG (see src-tauri/screenshot.rs)
 * which is shown here. Before that first screenshot exists, the project's
 * framework mark stands in — never an error.
 */
export function SitePreview({
  projectId,
  framework,
  hasDeployment,
  className,
}: {
  projectId: string;
  framework: Framework;
  hasDeployment: boolean;
  className?: string;
}) {
  const snapshot = useAtomValue(projectSnapshotAtom(projectId));

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
          className="absolute inset-0 h-full w-full object-cover object-top motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-out motion-safe:group-hover:scale-[1.04]"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-faint">
          <FrameworkIcon framework={framework} className="h-10 w-10" />
          <span className="text-[10px]">
            {hasDeployment ? "No snapshot available" : "No deployment yet"}
          </span>
        </div>
      )}
    </div>
  );
}
