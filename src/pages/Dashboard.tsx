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
import { BuildLogTerminal } from "../components/BuildLogTerminal";
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

/** A label above a value, for the card's stats row. */
function Metric({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-[10px] uppercase tracking-wider text-white/50">{label}</p>
      <div className="mt-0.5 text-[11px] tabular-nums text-white/90">{children}</div>
    </div>
  );
}

function UrlLine({
  url,
  className,
  tone = "default",
}: {
  url: string;
  className?: string;
  /** `onGlass` sits over the card's dark glass panel, where the muted/faint
   * tokens are near-invisible and the ink has to be white. */
  tone?: "default" | "onGlass";
}) {
  const [copied, setCopied] = useState(false);
  const glass = tone === "onGlass";
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <button
        className={cn(
          "flex min-w-0 items-center gap-1 text-xs",
          glass ? "text-white/70 hover:text-white" : "text-muted hover:text-foreground",
        )}
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
        className={cn(
          "shrink-0",
          glass ? "text-white/70 hover:text-white" : "text-muted hover:text-foreground",
        )}
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
        // Sits over the card's screenshot, so it carries its own translucent
        // plate rather than relying on the app surface behind it.
        "rounded-full bg-black/35 p-1.5 text-white/90 opacity-0 backdrop-blur-md transition-opacity hover:bg-black/55 hover:text-white group-hover:opacity-100 focus-visible:opacity-100",
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
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-sm ring-1 ring-white/20"
    >
      <FrameworkLogo framework={framework} className="h-[15px] w-[15px] object-contain" />
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
      // Solid white, not a tinted outline: this sits over an arbitrary
      // screenshot, where a translucent pill can land on anything.
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-white px-2 py-1 text-[11px] font-medium text-[oklch(0.28_0_0)] shadow-sm",
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

/**
 * A deploying card, as an actual terminal window: title bar with traffic
 * lights, the live build log filling the frame, a blinking caret.
 *
 * A separate branch rather than a mode of the normal card, because almost
 * nothing carries over — the glass, the scrim, the screenshot and the metrics
 * row all exist to frame an image, and layering a readable log on top of them
 * meant fighting every one of them.
 */
function DeployingCard({
  project,
  deployment,
  onContextMenu,
}: {
  project: Project;
  deployment: Deployment;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="group relative flex aspect-[4/5] flex-col overflow-hidden rounded-[14px] bg-[oklch(0.145_0.008_265)] shadow-[0_6px_24px_-10px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-white/10"
      onContextMenu={onContextMenu}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.05] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <span aria-hidden className="flex shrink-0 gap-[5px]">
          <i className="h-[9px] w-[9px] rounded-full bg-[#ff5f57]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#febc2e]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#28c840]" />
        </span>
        <span
          className="truncate font-mono text-[10px] text-white/55"
          title={`${project.name} — ${STATUS_PILL_LABELS[deployment.state] ?? deployment.state}`}
        >
          {project.name} — {(STATUS_PILL_LABELS[deployment.state] ?? "").toLowerCase()}
        </span>
        {/* Elapsed lives up here because the terminal has no footer to put it
            in, and "how long has this been going" is the question a watched
            build actually raises. */}
        <DeploymentTiming deployment={deployment} className="ml-auto shrink-0 text-white/45" />
        <MenuButton onOpen={onContextMenu} className="-mr-0.5 shrink-0" />
      </div>
      <BuildLogTerminal deploymentId={deployment.id} live className="min-h-0 flex-1" />
    </div>
  );
}

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
  if (latest && isDeploying(latest.state)) {
    return (
      <DeployingCard project={project} deployment={latest} onContextMenu={onContextMenu} />
    );
  }

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
      // rounded-[14px] rather than rounded-xl: the brand radius tops out at
      // 8px, which reads as a panel rather than as glass. Applied here only,
      // so the token — and every other surface — is left alone.
      className="group relative aspect-[4/5] overflow-hidden rounded-[14px] shadow-[0_6px_24px_-10px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-white/15 [background:linear-gradient(150deg,color-mix(in_oklab,var(--fw)_22%,var(--color-surface)),var(--card-bg))]"
      onContextMenu={onContextMenu}
    >
      {/*
        The snapshot is the card. It fills the frame at full strength rather
        than sitting behind a tint — everything legible is carried by the glass
        panel below, so the image never has to be dimmed to make room for text.
        Empty alt + aria-hidden: the name and status beside it already say
        everything this conveys.
      */}
      {snapshot ? (
        <img
          src={snapshot}
          alt=""
          aria-hidden
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover object-top"
        />
      ) : (
        // No snapshot yet: the framework's own mark on its gradient, so the
        // card still reads as *this* project rather than as an empty slot.
        <div aria-hidden className="absolute inset-0 flex items-center justify-center">
          <FrameworkLogo
            framework={project.framework as Framework}
            className="h-12 w-12 opacity-25 [filter:brightness(0)_invert(1)]"
          />
        </div>
      )}

      {/*
        The card IS the glass — one pane over the whole screenshot, not a photo
        with a frosted strip laid across the bottom. Four things make it read
        as glass rather than as a blur:
          - vibrancy: blur plus a saturation boost, so the site's own colour
            survives instead of greying out;
          - a faint fill, giving the pane substance;
          - a specular highlight along the top lip, where light catches the
            edge of real glass;
          - the ring and drop shadow on the card itself, for thickness.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-[14px] backdrop-saturate-[180%]"
      />

      {/*
        Gradient scrim over the glass. This is what makes the white text safe,
        which is what lets the glass panel below stay light — carrying the
        contrast on the frost alone meant a heavy opaque slab, and dropping the
        frost without this left the title sitting on whatever the screenshot
        happened to contain.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.45) 22%, rgba(0,0,0,0.08) 45%, transparent 62%)",
        }}
      />

      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3">
        <FrameworkChip framework={project.framework as Framework} />
        {/*
          Pill and kebab share one slot and cross-fade, in a box with the
          chip's height. Side by side the hover-hidden kebab reserved its
          width and pushed the pill off the card's padding; and with the pill
          deploy-only, an unsized box collapsed and left the kebab with
          nothing to centre against.
        */}
        <div className="relative flex h-7 shrink-0 items-center justify-end">
          <StatusPill
            deployment={latest}
            className="transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
          />
          <MenuButton onOpen={onContextMenu} className="absolute right-0 top-1/2 -translate-y-1/2" />
        </div>
      </div>

      {/*
        The glass panel. `backdrop-blur` frosts whatever part of the screenshot
        sits behind it and the dark layer on top guarantees the contrast: white
        text over an arbitrary screenshot is otherwise a coin toss, unreadable
        the moment someone deploys a light-coloured site. Dark in both themes
        for the same reason — the text colour cannot depend on the image.
      */}
      {/* Content sits directly on the pane — no second sheet of glass. */}
      <div className="absolute inset-x-0 bottom-0 px-3.5 pb-3 pt-3">
        <h3 className="truncate text-[15px] font-semibold tracking-tight text-white" title={project.name}>
          {project.name}
        </h3>
        {/*
          The failure replaces the URL rather than being a banner of its own.
          As an absolutely-positioned strip across the top it covered the
          framework chip and the kebab, and a card cannot afford to hide its
          own controls to show an error.
        */}
        {latest?.state === "failed" && latest.error ? (
          <button
            className="mt-0.5 block w-full text-left"
            onClick={(e) => {
              e.stopPropagation();
              setLogsOpen(true);
            }}
          >
            <span className="line-clamp-2 text-[11px] leading-snug text-[oklch(0.85_0.14_23)]">
              {latest.error}
            </span>
            <span className="mt-0.5 block text-[11px] font-medium text-white/80 underline underline-offset-2">
              View build log
            </span>
          </button>
        ) : url ? (
          <UrlLine url={url} className="mt-0.5" tone="onGlass" />
        ) : (
          <p className="mt-0.5 text-xs text-white/60">Not deployed yet</p>
        )}

        {(project.remoteRepo || project.lockedBranch) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <GitBadge project={project} />
            <LockBadge project={project} />
            <HeldBadge project={project} />
          </div>
        )}

        <div className="mt-2.5 grid grid-cols-3 divide-x divide-white/15 border-t border-white/15 pt-2.5">
          <Metric label="Deployed">
            {latest ? (
              <DeploymentTiming deployment={latest} className="text-white/90" />
            ) : (
              <span className="text-white/50">—</span>
            )}
          </Metric>
          <Metric label="Build" className="px-2">
            {latest ? (
              <DeploymentDuration deployment={latest} className="text-white/90" />
            ) : (
              <span className="text-white/50">—</span>
            )}
          </Metric>
          <Metric label="Auto" className="pl-2">
            <span
              className="flex items-center"
              title={project.autoDeploy ? "Auto deploy on" : "Auto deploy paused"}
            >
              <AutoSwitch project={project} />
            </span>
          </Metric>
        </div>
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
