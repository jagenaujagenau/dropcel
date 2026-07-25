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
  projectOrderAtom,
  projectSnapshotAtom,
  projectsAtom,
  reconcile,
  rootFolderAtom,
  setProjectsLocal,
  useAtomState,
} from "../core/atoms";
import type { HoldReason } from "../core/held-changes";
import { LogViewerDialog } from "../components/LogViewerDialog";
import { FrameworkLogo } from "../components/FrameworkLogo";
import {
  DeploymentDuration,
  DeploymentTiming,
  isDeploying,
  StatusDot,
  StatusLabel,
} from "../components/StatusIndicator";
import { frameworkAccent, frameworkChip } from "../core/framework-theme";
import {
  FRAMEWORK_LABELS,
  publicUrlOf,
  type Deployment,
  type Framework,
  type Project,
} from "../core/types";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";
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
  const order = useAtomValue(projectOrderAtom);
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

  // Most recently deployed first. `projectOrderAtom` is a delimited string so
  // this subscription doesn't re-render the grid on every deployment tick —
  // see the note on the atom.
  const rank = new Map(
    (order ? order.split(",") : []).map((id, i) => [id, i] as const),
  );
  const visible = projects
    .filter((p) => presentOnDisk.has(p.name))
    .sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
        // Never-deployed projects have no recency to sort by, so they settle
        // alphabetically instead of in whatever order the DB returned them.
        a.name.localeCompare(b.name),
    );
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
        <p className="shrink-0 text-xs tabular-nums text-muted">
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(208px,248px))] gap-3">
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
        // `focus-visible:opacity-100` is not decoration: without it a keyboard
        // user could tab to this button and see nothing at all — the focus
        // ring rendered on an invisible element. Hover-reveal is fine for the
        // mouse; it must not be the *only* way to make the control appear.
        "rounded-md p-1 text-faint opacity-0 transition-opacity hover:bg-surface-hover hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
        className,
      )}
      aria-haspopup="menu"
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

/** The framework's logo in white on a gradient of its own brand hue. */
function FrameworkChip({ framework }: { framework: Framework }) {
  return (
    <div
      title={FRAMEWORK_LABELS[framework] ?? framework}
      style={{ background: frameworkChip(framework) }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg shadow-sm"
    >
      <FrameworkLogo framework={framework} className="h-[18px] w-[18px] object-contain" />
    </div>
  );
}

/**
 * The pill is transient: it appears only while a deploy is in flight and is
 * absent the rest of the time.
 *
 * A permanent "Live" badge on every card is noise — the URL underneath already
 * says the site is up, and a row of identical green pills makes the one card
 * that is *actually* doing something harder to spot, not easier. Failure is
 * still surfaced, and more loudly, by the error banner below.
 */
function StatusPill({
  deployment,
  className,
}: {
  deployment: Deployment | undefined;
  className?: string;
}) {
  const state = deployment?.state;
  if (!isDeploying(state)) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/12 px-2 py-0.5 text-[11px] font-medium text-warning",
        className,
      )}
    >
      <StatusDot state={state} />
      {STATUS_PILL_LABELS[state ?? "none"]}
    </span>
  );
}

const STATUS_PILL_LABELS: Record<string, string> = {
  none: "No deploys",
  detected: "Detected",
  queued: "Queued",
  preparing: "Preparing",
  uploading: "Uploading",
  building: "Building",
  ready: "Live",
  failed: "Failed",
  canceled: "Canceled",
};

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

  const snapshot = useAtomValue(projectSnapshotAtom(project.id));
  const accent = frameworkAccent(project.framework);

  return (
    <div
      // `--fw` is set once here and every tint below is derived from it with
      // color-mix, so a framework's colour is defined in exactly one place.
      style={
        {
          "--fw": accent,
          "--card-bg": "color-mix(in oklab, var(--fw) 5%, var(--color-surface))",
        } as React.CSSProperties
      }
      className="group relative flex aspect-square flex-col overflow-hidden rounded-xl border border-border p-3.5 transition-colors duration-300 ease-out hover:border-border-hover [background:var(--card-bg)]"
      onContextMenu={onContextMenu}
    >
      {/*
        The snapshot is card furniture, not content: it bleeds to the edges and
        dissolves into the tint before it reaches the title. Empty alt +
        aria-hidden because the name and status beside it already say
        everything this conveys.
      */}
      {snapshot && (
        <>
          <img
            src={snapshot}
            alt=""
            aria-hidden
            draggable={false}
            className="pointer-events-none absolute inset-x-0 top-0 h-full w-full object-cover object-top opacity-[0.45]"
          />
          {/*
            Frosted glass rather than a flat scrim: a blur that fades in down
            the card, so the snapshot stays sharp at the top and dissolves
            behind the text instead of simply being covered by an opaque
            gradient. `backdrop-filter` is what does the work — the translucent
            card colour on top only tints it.
          */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 backdrop-blur-lg backdrop-saturate-150 [background:color-mix(in_oklab,var(--card-bg)_74%,transparent)]"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0%, transparent 16%, #000 56%, #000 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, transparent 16%, #000 56%, #000 100%)",
            }}
          />
        </>
      )}
      {/* Accent wash, tying snapshot and tint together. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background:linear-gradient(160deg,color-mix(in_oklab,var(--fw)_5%,transparent),transparent_62%)]"
      />

      <div className="relative flex items-start justify-between gap-3">
        <FrameworkChip framework={project.framework as Framework} />
        {/*
          Pill and kebab share one slot and cross-fade. Side by side, the
          kebab reserved its width while invisible and pushed the pill off the
          card's right padding — and the same trick in the footer pushed the
          Auto switch off it too. Stacked, both stay flush and nothing moves
          on hover.
        */}
        {/*
          Fixed height, matching the chip beside it. The pill only renders
          while deploying, so without it this box collapsed to zero height on
          every idle card and the absolutely-positioned kebab had nothing to
          centre against — it hung above the chip instead of level with it.
        */}
        <div className="relative flex h-8 shrink-0 items-center justify-end">
          <StatusPill
            deployment={latest}
            className="transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
          />
          <MenuButton
            onOpen={onContextMenu}
            className="absolute right-0 top-1/2 -translate-y-1/2"
          />
        </div>
      </div>

      {/* Content sits at the bottom of the square; the snapshot gets the top. */}
      <div className="flex-1" />

      <div className="relative min-w-0">
        <h3
          className="truncate text-[15px] font-semibold tracking-tight [color:var(--fw)]"
          title={project.name}
        >
          {project.name}
        </h3>
        {url ? (
          <UrlLine url={url} className="mt-0.5" />
        ) : (
          <p className="mt-0.5 text-xs text-faint">Not deployed yet</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <GitBadge project={project} />
          <LockBadge project={project} />
          <HeldBadge project={project} />
          {project.remoteRepo && (
            <Badge variant="success" title={`Pushes to ${project.remoteRepo} deploy this project`}>
              git-connected
            </Badge>
          )}
        </div>
      </div>

      {latest?.state === "failed" && latest.error && (
        <div className="banner-in relative mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
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

      <div className="relative mt-3 flex items-center justify-between gap-2 border-t border-[color-mix(in_oklab,var(--fw)_10%,var(--color-border))] pt-3">
        <DeploymentTiming deployment={latest} />
        <span
          className="flex shrink-0 items-center gap-2"
          title={project.autoDeploy ? "Auto deploy on" : "Auto deploy paused"}
        >
          <span className="text-[11px] text-faint">Auto</span>
          <AutoSwitch project={project} />
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
            {/* Build time and age get a column each. Together in one cell they
                read as a range; the headings are what tell them apart. */}
            <th className="hidden px-3 py-2 text-right font-medium lg:table-cell">Build</th>
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
        <td className="hidden px-3 py-2 text-right lg:table-cell">
          {latest ? (
            <DeploymentDuration deployment={latest} />
          ) : (
            <span className="text-[11px] text-faint">—</span>
          )}
        </td>
        <td className="hidden px-3 py-2 lg:table-cell">
          {latest ? (
            <DeploymentTiming deployment={latest} />
          ) : (
            <span className="text-[11px] text-faint">—</span>
          )}
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
      <div>
        <h2 className="font-semibold">Your Vercel folder is empty</h2>
        <p className="mt-1 max-w-sm text-pretty text-xs leading-relaxed text-muted">
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
