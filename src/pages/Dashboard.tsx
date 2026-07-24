import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranch,
  LayoutGrid,
  List,
  Lock,
  MoreVertical,
  WifiOff,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { ProjectContextMenu, type ProjectMenuState } from "../components/ProjectContextMenu";
import {
  gitStatusAtom,
  heldReasonsAtom,
  latestDeploymentAtom,
  presentOnDiskAtom,
  projectSnapshotAtom,
  projectsAtom,
  reconcile,
  rootFolderAtom,
  setProjectsLocal,
  useAtomState,
} from "../core/atoms";
import type { HoldReason } from "../core/held-changes";
import { LogViewerDialog } from "../components/LogViewerDialog";
import { SitePreview } from "../components/SitePreview";
import { TriangleField } from "../components/TriangleField";
import { StatusLabel } from "../components/StatusIndicator";
import { FRAMEWORK_LABELS, publicUrlOf, type Framework, type Project } from "../core/types";
import * as ipc from "../lib/ipc";
import { cn, formatDuration, timeAgo } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";

/**
 * The one screen, two densities: cards (snapshot-first) or a table
 * (scannable at many projects). Both answer the same three questions —
 * live? URL? why failed? — and share the right-click menu. The choice
 * persists across launches.
 */

type View = "grid" | "table";

/** Above this count, scanning the grid/table by eye stops being enough. */
const SEARCH_THRESHOLD = 7;

export function Dashboard() {
  const projects = useAtomState(projectsAtom, []);
  const presentOnDisk = useAtomState(presentOnDiskAtom, new Set<string>());
  const [menu, setMenu] = useState<ProjectMenuState | null>(null);
  const [view, setView] = useState<View>("grid");
  const [search, setSearch] = useState("");

  useEffect(() => {
    void ipc.db
      .getSetting("dashboard_view")
      .then((v) => v === "table" && setView("table"))
      .catch(() => {});
  }, []);

  const changeView = (v: View) => {
    setView(v);
    void ipc.db.setSetting("dashboard_view", v).catch(() => {});
  };

  const visible = projects.filter((p) => presentOnDisk.has(p.name));
  if (visible.length === 0) return <EmptyState />;

  const query = search.trim().toLowerCase();
  const matching = query ? visible.filter((p) => p.name.toLowerCase().includes(query)) : visible;

  const onRowMenu = (p: Project) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, project: p });
  };

  return (
    <div className="p-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="shrink-0 text-xs text-muted">
          {query
            ? `${matching.length} of ${visible.length} projects`
            : `${visible.length} ${visible.length === 1 ? "project" : "projects"}`}
        </p>
        <div className="flex items-center gap-2">
          {visible.length > SEARCH_THRESHOLD && (
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name…"
              className="h-7 w-48 text-xs"
            />
          )}
          <div className="flex shrink-0 rounded-md border border-border p-0.5">
            <ViewButton
              active={view === "grid"}
              onClick={() => changeView("grid")}
              title="Card view"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </ViewButton>
            <ViewButton
              active={view === "table"}
              onClick={() => changeView("table")}
              title="Table view"
            >
              <List className="h-3.5 w-3.5" />
            </ViewButton>
          </div>
        </div>
      </div>

      {matching.length === 0 ? (
        <p className="mt-8 text-center text-xs text-faint">No projects match "{search.trim()}".</p>
      ) : view === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,400px))] gap-3">
          {matching.map((p) => (
            <ProjectCard key={p.id} project={p} onContextMenu={onRowMenu(p)} />
          ))}
        </div>
      ) : (
        <ProjectTable projects={matching} onRowMenu={onRowMenu} />
      )}

      {menu && <ProjectContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-[5px] px-2 py-1 transition-colors",
        active ? "bg-surface-hover text-foreground" : "text-faint hover:text-muted",
      )}
    >
      {children}
    </button>
  );
}

function UrlLine({ url, className }: { url: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <button
        className="flex min-w-0 items-center gap-1 text-xs text-muted hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          void openUrl(url);
        }}
        title="Open in browser"
      >
        <span className="truncate" title={url}>
          {url.replace("https://", "")}
        </span>
        <ExternalLink className="h-3 w-3 shrink-0" />
      </button>
      <button
        className="shrink-0 text-muted hover:text-foreground"
        title="Copy URL"
        onClick={(e) => {
          e.stopPropagation();
          void writeText(url).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <Check key="check" className="icon-in h-3 w-3 text-success" />
        ) : (
          <Copy key="copy" className="icon-in h-3 w-3" />
        )}
      </button>
    </div>
  );
}

function AutoSwitch({ project }: { project: Project }) {
  return (
    <Switch
      checked={project.autoDeploy}
      aria-label="Auto deploy"
      onCheckedChange={(v) => {
        void ipc.db
          .setAutoDeploy(project.id, v)
          .then(() => ipc.db.listProjects())
          .then(setProjectsLocal);
      }}
    />
  );
}

/** Visible entry point to the right-click menu (Redeploy, View Build Log,
 * Move to Trash, …) — right-click alone isn't discoverable. */
function MenuButton({
  onOpen,
  className,
}: {
  onOpen: (e: React.MouseEvent) => void;
  className?: string;
}) {
  return (
    <button
      className={cn(
        "rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover:opacity-100",
        className,
      )}
      title="Project menu"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e);
      }}
    >
      <MoreVertical className="h-3.5 w-3.5" />
    </button>
  );
}

function GitBadge({ project }: { project: Project }) {
  const git = useAtomValue(gitStatusAtom(project.id));
  if (!git?.isRepo || !git.branch) return null;
  return (
    <Badge variant={git.operation ? "warning" : "neutral"}>
      <GitBranch className="h-3 w-3" />
      {git.operation ? `${git.branch} · ${git.operation}` : git.branch}
    </Badge>
  );
}

/** Auto-deploy is pinned to one branch (see core/git.ts's
 * `shouldHoldAutoDeploy`) — set via the project context menu's "Lock to
 * Branch…". Shown here too so the lock is visible without right-clicking. */
function LockBadge({ project }: { project: Project }) {
  if (!project.lockedBranch) return null;
  return (
    <Badge title={`Auto-deploy only runs on ${project.lockedBranch}`}>
      <Lock className="h-3 w-3" />
      {project.lockedBranch}
    </Badge>
  );
}

const HOLD_LABELS: Record<HoldReason, string> = {
  offline: "Held — offline",
  "account-switch": "Held — account switch",
  "git-operation": "Held — git operation",
};

/** Why this project's changes haven't deployed yet — the global offline pill
 * in the header doesn't say *which* projects it applies to. */
function HeldBadge({ project }: { project: Project }) {
  const reasons = useAtomValue(heldReasonsAtom(project.id));
  if (!reasons || reasons.length === 0) return null;
  return (
    <Badge
      variant="warning"
      title="Deploys when the hold clears — nothing is lost."
    >
      <WifiOff className="h-3 w-3" />
      {HOLD_LABELS[reasons[0]]}
    </Badge>
  );
}

// ---- card view -------------------------------------------------------------

function ProjectCard({
  project,
  onContextMenu,
}: {
  project: Project;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const latest = useAtomValue(latestDeploymentAtom(project.id));
  const url = publicUrlOf(latest);
  const [logsOpen, setLogsOpen] = useState(false);

  return (
    <div
      className="group rounded-xl border border-border bg-surface p-4 transition-colors duration-300 ease-out hover:border-border-hover hover:bg-surface-hover motion-safe:transition-all motion-safe:hover:-translate-y-1 motion-safe:hover:shadow-card-hover"
      onContextMenu={onContextMenu}
    >
      <SitePreview
        projectId={project.id}
        framework={project.framework as Framework}
        hasDeployment={Boolean(latest?.url)}
        className="mb-3"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium" title={project.name}>
              {project.name}
            </h3>
            <Badge>{FRAMEWORK_LABELS[project.framework as Framework] ?? project.framework}</Badge>
            <GitBadge project={project} />
            <LockBadge project={project} />
            <HeldBadge project={project} />
            {project.remoteRepo && (
              <Badge variant="success" title={`Pushes to ${project.remoteRepo} deploy this project`}>
                git-connected
              </Badge>
            )}
          </div>
          {url ? (
            <UrlLine url={url} className="mt-1" />
          ) : (
            <p className="mt-1 text-xs text-faint">Not deployed yet</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div
            className="flex items-center gap-2"
            title={project.autoDeploy ? "Auto deploy on" : "Auto deploy paused"}
          >
            <span className="text-[11px] text-faint">Auto</span>
            <AutoSwitch project={project} />
          </div>
          <MenuButton onOpen={onContextMenu} />
        </div>
      </div>

      {latest?.state === "failed" && latest.error && (
        <div className="banner-in mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
          <p>{latest.error}</p>
          <button
            className="mt-1 font-medium underline decoration-danger/40 underline-offset-2 hover:decoration-danger"
            onClick={(e) => {
              e.stopPropagation();
              setLogsOpen(true);
            }}
          >
            View build log
          </button>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <StatusLabel deployment={latest} />
        <span className="text-[11px] text-faint">
          {latest ? `${formatDuration(latest.durationMs)} · ${timeAgo(latest.startedAt)}` : ""}
        </span>
      </div>
      {logsOpen && latest && (
        <LogViewerDialog
          deploymentId={latest.id}
          projectName={project.name}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </div>
  );
}

// ---- table view ------------------------------------------------------------

function ProjectTable({
  projects,
  onRowMenu,
}: {
  projects: Project[];
  onRowMenu: (p: Project) => (e: React.MouseEvent) => void;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-border bg-surface text-[10px] uppercase tracking-wider text-faint">
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="hidden px-3 py-2 font-medium md:table-cell">URL</th>
            <th className="hidden px-3 py-2 font-medium lg:table-cell">Updated</th>
            <th className="px-3 py-2 text-right font-medium">Auto</th>
            <th className="px-3 py-2" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <TableRow key={p.id} project={p} onContextMenu={onRowMenu(p)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableRow({
  project,
  onContextMenu,
}: {
  project: Project;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const latest = useAtomValue(latestDeploymentAtom(project.id));
  const snapshot = useAtomValue(projectSnapshotAtom(project.id));
  const url = publicUrlOf(latest);
  const failed = latest?.state === "failed" && latest.error;
  const [logsOpen, setLogsOpen] = useState(false);

  return (
    <>
      <tr
        className="group border-b border-border/60 transition-colors last:border-0 hover:bg-surface-hover"
        onContextMenu={onContextMenu}
      >
        <td className="px-3 py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="h-8 w-12 shrink-0 overflow-hidden rounded-[4px] border border-border bg-surface">
              {snapshot && (
                <img
                  src={snapshot}
                  alt=""
                  draggable={false}
                  className="h-full w-full object-cover object-top"
                />
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium" title={project.name}>
                {project.name}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="text-[11px] text-faint">
                  {FRAMEWORK_LABELS[project.framework as Framework] ?? project.framework}
                </span>
                <GitBadge project={project} />
                <LockBadge project={project} />
                <HeldBadge project={project} />
              </div>
            </div>
          </div>
        </td>
        <td className="px-3 py-2">
          <StatusLabel deployment={latest} />
        </td>
        <td className="hidden max-w-[280px] px-3 py-2 md:table-cell">
          {url ? <UrlLine url={url} /> : <span className="text-xs text-faint">—</span>}
        </td>
        <td className="hidden px-3 py-2 text-[11px] text-faint lg:table-cell">
          {latest ? `${formatDuration(latest.durationMs)} · ${timeAgo(latest.startedAt)}` : "—"}
        </td>
        <td className="px-3 py-2 text-right">
          <AutoSwitch project={project} />
        </td>
        <td className="px-3 py-2 text-right">
          <MenuButton onOpen={onContextMenu} />
        </td>
      </tr>
      {failed && (
        <tr className="border-b border-border/60 last:border-0">
          <td colSpan={6} className="px-3 pb-2 pt-0">
            <div className="banner-in rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-danger">
              <p>{latest.error}</p>
              <button
                className="mt-0.5 font-medium underline decoration-danger/40 underline-offset-2 hover:decoration-danger"
                onClick={() => setLogsOpen(true)}
              >
                View build log
              </button>
            </div>
          </td>
        </tr>
      )}
      {logsOpen && latest && (
        <LogViewerDialog
          deploymentId={latest.id}
          projectName={project.name}
          onClose={() => setLogsOpen(false)}
        />
      )}
    </>
  );
}

function EmptyState() {
  const rootFolder = useAtomState(rootFolderAtom, "");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <TriangleField className="h-56 w-full max-w-md" />
      <div>
        <h2 className="font-semibold">Your Vercel folder is empty</h2>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">
          Drop a project here — or into{" "}
          <code className="rounded bg-surface px-1 py-0.5 text-foreground">{rootFolder}</code>.
          Live in seconds.
        </p>
      </div>
      <Button onClick={() => void ipc.fs.openRootFolder()}>
        <FolderOpen className="h-3.5 w-3.5" /> Open the Folder
      </Button>
      <button
        className="text-[11px] text-faint hover:text-muted"
        onClick={() => void reconcile(true)}
      >
        Rescan folder
      </button>
    </div>
  );
}
