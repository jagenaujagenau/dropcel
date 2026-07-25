import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
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
        // `1fr` as the track maximum, not a 248px cap: with a fixed cap the
        // columns keep their width and whatever the container has left over
        // piles up as dead space on the right, which at some window widths was
        // most of a card. Letting the tracks stretch spends that space evenly
        // across every card instead. 208px is still the minimum, so the column
        // count changes at the same widths it always did — the cards just fill
        // the row they land in.
        //
        // The minimum track is a clamp, not a constant. A fixed 264px does the
        // wrong thing at the window's smallest size (800px wide): only two
        // tracks fit, so each one stretches to half the window and the cards
        // come out BIGGER the smaller the window gets, which is backwards.
        // 21vw keeps roughly four across at 800px — cards of about 173px —
        // and stops growing at 264px, so a wide window gets more cards rather
        // than ever-larger ones. The gap is what keeps them reading as
        // separate objects rather than one contact sheet.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(clamp(160px,21vw,264px),1fr))] gap-5">
          {matching.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onContextMenu={onRowMenu(p)}
              menuOpen={menu?.project.id === p.id}
            />
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
    // `title` so the label survives being hidden on a narrow card — a bare
    // "9s" with no heading is a number without a unit of meaning.
    <div className={cn("min-w-0 text-left", className)} title={label}>
      {/* Quieter than the value it heads, but not by much: a label is read
          once, to learn what the row is; the value is what you come back to.
          white/65 against the value's white/90 is enough of a step to set the
          order without the label having to be hard to read to prove it — at
          white/45 it was straining on pale screenshots.

          No text shadow. A dark one doubles every glyph (light-on-dark type
          has no lit surface to cast onto) and a bright one is an edge with
          nothing to be an edge of. Both were tried; the scrim carries this. */}
      <p className="hidden text-[10px] uppercase tracking-wider text-white/65 @min-[240px]:block">
        {label}
      </p>
      {/* A fixed 18px value line — the height of the Auto switch, the tallest
          thing any of these holds. Left to size themselves the two text cells
          came out shorter than the switch cell, so the three values sat on
          three different baselines. Each cell aligns its label and value on
          one left edge; the plate as a whole is what sits flush right. */}
      <div className="mt-0.5 flex h-[18px] items-center text-[11px] tabular-nums text-white/90">
        {children}
      </div>
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
  const glass = tone === "onGlass";
  // One action, not two. Copying is still a right-click away (the project
  // menu) and still happens on its own when a deploy goes live, so the button
  // was a third route to something the card already does for you — at the cost
  // of a second icon competing with the address itself.
  return (
    <button
      className={cn(
        // `w-full` and `overflow-hidden` are both load-bearing. A <button> is
        // shrink-to-fit and will not size its content box below min-content,
        // so on a narrow card it grew past its parent and took the span with
        // it — `min-w-0` on the span could never help, because the constraint
        // never reached it. Pinning the button to the parent's width is what
        // gives the span something to truncate against.
        "flex w-full min-w-0 items-center gap-1 overflow-hidden text-xs",
        // white/80 on glass, not white/70: the scrim under it is lighter than
        // it used to be, and the URL is the smallest text sitting on it.
        glass ? "text-white/80 hover:text-white" : "text-muted hover:text-foreground",
        className,
      )}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url);
      }}
      title="Open in browser"
    >
      {/* `min-w-0` is what makes `truncate` work at all here. A flex item's
          min-width is `auto`, so this span refused to shrink below the full
          address and the button overflowed its card instead of ellipsing —
          only visible once cards got narrow enough for it to matter. */}
      <span className="min-w-0 truncate" title={url}>
        {url.replace("https://", "")}
      </span>
      <ExternalLink className="h-3 w-3 shrink-0" />
    </button>
  );
}

function AutoSwitch({ project, className }: { project: Project; className?: string }) {
  return (
    <Switch
      checked={project.autoDeploy}
      className={className}
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
        // The blur is `group-hover:` for the same reason the opacity is: an
        // `opacity-0` element still costs a full backdrop-filter pass on every
        // frame, and a grid of cards was paying for a dozen invisible ones —
        // which is what made a window resize stutter.
        "rounded-full bg-black/35 p-1.5 text-white/90 opacity-0 transition-opacity hover:bg-black/55 hover:text-white group-hover:opacity-100 group-hover:backdrop-blur-md group-data-[menu-open=true]:opacity-100 group-data-[menu-open=true]:backdrop-blur-md focus-visible:opacity-100 focus-visible:backdrop-blur-md",
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
      // A physical token on the card: lit lip along the top, contact shadow
      // under it. The mark itself is NOT blended — at 15px over a saturated
      // gradient, any blend mode trades the one thing this chip exists to do
      // (say which framework, instantly) for an effect. It gets a soft cast
      // shadow instead, which sits it on the chip without touching its
      // legibility.
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full shadow-[inset_0_1px_0_oklch(1_0_0/0.35),0_1px_2px_oklch(0_0_0/0.35)] ring-1 ring-white/20"
    >
      <FrameworkLogo
        framework={framework}
        className="h-[15px] w-[15px] object-contain [filter:brightness(0)_invert(1)_drop-shadow(0_1px_1px_oklch(0_0_0/0.35))]"
      />
    </div>
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
 * lights and a centred title, the live build log filling the frame, a blinking
 * caret, and a status bar along the bottom — elapsed on the left, state on the
 * right, the way a terminal emulator lays its own chrome out.
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
  menuOpen = false,
}: {
  project: Project;
  deployment: Deployment;
  menuOpen?: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="terminal-in group relative flex aspect-[4/5] flex-col overflow-hidden rounded-[14px] bg-[oklch(0.145_0.008_265)] shadow-[0_6px_24px_-10px_rgba(0,0,0,0.5)] ring-1 ring-inset ring-white/10"
      data-menu-open={menuOpen ? "true" : undefined}
      onContextMenu={onContextMenu}
    >
      {/* `rounded-t-[13px]` — one less than the card's 14, for the ring it
          sits inside. Without it the title bar's lit top edge is a straight
          line across a square box, and the card's clip slices it off at both
          top corners: the same broken-corner effect the project card had. */}
      <div className="relative flex shrink-0 items-center gap-2 rounded-t-[13px] border-b border-white/10 bg-white/[0.05] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]">
        <span aria-hidden className="flex shrink-0 gap-[5px]">
          <i className="h-[9px] w-[9px] rounded-full bg-[#ff5f57]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#febc2e]" />
          <i className="h-[9px] w-[9px] rounded-full bg-[#28c840]" />
        </span>
        {/* Centred on the BAR, not in the flex flow: with traffic lights on one
            side and a kebab on the other, flow centring puts the title wherever
            the two side widths happen to leave it — and it would then shift as
            the kebab appears on hover. */}
        <span
          className="pointer-events-none absolute inset-x-0 top-1/2 mx-auto block w-max max-w-[58%] -translate-y-1/2 truncate text-center font-mono text-[10px] text-white/60"
          title={project.name}
        >
          {project.name}
        </span>
        <MenuButton onOpen={onContextMenu} className="-mr-0.5 ml-auto shrink-0" />
      </div>
      <BuildLogTerminal deploymentId={deployment.id} live className="min-h-0 flex-1" />
      {/* Status bar. Elapsed left, state right — "how long has this been going"
          is the question a watched build raises, and the two answers belong at
          opposite ends rather than crowded into the title. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-white/10 bg-white/[0.04] px-2.5 py-1.5">
        <DeploymentTiming
          deployment={deployment}
          className="shrink-0 font-mono text-[10px] text-white/45"
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] text-white/75">
          <StatusDot state={deployment.state} />
          {(STATUS_PILL_LABELS[deployment.state] ?? deployment.state).toLowerCase()}
        </span>
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  onContextMenu,
  menuOpen = false,
}: {
  project: Project;
  onContextMenu: (e: React.MouseEvent) => void;
  /** This card's context menu is open. The menu renders outside the card, so
   * the pointer leaves on the way to it and `focus-within` never applies —
   * without this the stats vanish the instant you go to act on them. */
  menuOpen?: boolean;
}) {
  const latest = useAtomValue(latestDeploymentAtom(project.id));
  const url = publicUrlOf(latest);
  const [logsOpen, setLogsOpen] = useState(false);

  const snapshot = useAtomValue(projectSnapshotAtom(project.id));
  const accent = frameworkAccent(project.framework);
  const deploying = isDeploying(latest?.state);

  /**
   * "This deploy just finished" — the one moment the live card animates in.
   *
   * Held in state with a timer rather than derived during render, because the
   * card re-renders several times in the second after a deploy lands (the
   * snapshot arrives, the URL resolves) and a derived flag would flip to false
   * mid-animation and cut it off. The timer outlasts the 220ms animation.
   */
  const [justDeployed, setJustDeployed] = useState(false);
  const wasDeploying = useRef(false);
  useEffect(() => {
    const finished = wasDeploying.current && !deploying;
    wasDeploying.current = deploying;
    if (!finished) return;
    setJustDeployed(true);
    const t = setTimeout(() => setJustDeployed(false), 400);
    return () => clearTimeout(t);
  }, [deploying]);

  /**
   * The screenshot being replaced, kept alive under its replacement until the
   * cross-fade is done. Null at rest and on a project's FIRST screenshot —
   * there is nothing to fade from there, and fading in over the framework mark
   * would animate the arrival of something the user never saw missing.
   */
  const [previousSnapshot, setPreviousSnapshot] = useState<string | null>(null);
  const lastSnapshot = useRef(snapshot);
  useEffect(() => {
    const outgoing = lastSnapshot.current;
    lastSnapshot.current = snapshot;
    if (!snapshot || !outgoing || snapshot === outgoing) return;
    setPreviousSnapshot(outgoing);
    const t = setTimeout(() => setPreviousSnapshot(null), 320);
    return () => clearTimeout(t);
  }, [snapshot]);

  if (latest && isDeploying(latest.state)) {
    return (
      <DeployingCard
        project={project}
        deployment={latest}
        onContextMenu={onContextMenu}
        menuOpen={menuOpen}
      />
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
      // No `ring-inset` here. A ring is a box-shadow on THIS element, so it
      // paints before the children — and the snapshot is an `inset-0` child
      // that covers it completely. The edge only survived where a child
      // happened to be translucent, which is why it looked patchy. It is now
      // an overlay at the end of this element, painted last. The outer 1px
      // contour stays on the shadow, where nothing can cover it: it is what
      // defines the card against a light page, since a white hairline over a
      // white screenshot defines nothing.
      // `contain: layout paint` — during a resize every card relayouts on
      // every frame, and without containment each one's reflow and repaint is
      // free to invalidate the whole grid. The card's size comes from its grid
      // track and its contents are absolutely positioned inside it, so nothing
      // here needs to influence anything outside it.
      // `@container` so the contents respond to the CARD's width, not the
      // window's. The two are unrelated here — a wide window can hold narrow
      // cards and does, since the grid adds columns rather than growing them.
      className={cn(
        "group @container relative aspect-[4/5] overflow-hidden rounded-[14px] shadow-[0_4px_16px_-8px_light-dark(oklch(0_0_0/0.16),oklch(0_0_0/0.5)),0_0_0_1px_light-dark(oklch(0_0_0/0.07),oklch(0_0_0/0.10))] [contain:layout_paint] [background:linear-gradient(150deg,color-mix(in_oklab,var(--fw)_22%,var(--color-surface)),var(--card-bg))]",
        justDeployed && "card-live-in",
      )}
      // Read by the stats plate and the kebab below. An attribute on the group
      // rather than a prop threaded into each: both are revealed by
      // `group-hover` already, so this is the same mechanism with a second
      // trigger, and the variant selector outranks the base `opacity-0`
      // exactly the way `group-hover` does.
      data-menu-open={menuOpen ? "true" : undefined}
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
        <>
          {/*
            The outgoing screenshot, held underneath for the length of the
            cross-fade. Without it the incoming image fades up from the card's
            gradient — a flash of empty card between two pictures of the same
            site, which is worse than the instant swap it replaces.
          */}
          {previousSnapshot && (
            <img
              src={previousSnapshot}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 h-full w-full object-cover object-top"
            />
          )}
          {/*
            `key` is what makes this animate at all: same element, changed src
            is not a mount, so the entrance would never re-run for the second
            screenshot a project ever gets.
          */}
          <img
            key={snapshot}
            src={snapshot}
            alt=""
            aria-hidden
            draggable={false}
            className={cn(
              "absolute inset-0 h-full w-full object-cover object-top",
              previousSnapshot && "snapshot-in",
            )}
          />
        </>
      ) : (
        // No snapshot yet: the framework's own mark on its gradient, so the
        // card still reads as *this* project rather than as an empty slot.
        //
        // `mix-blend-overlay` rather than a flat 25% white. Overlay lets the
        // mark take its brightness from whatever part of the gradient it lands
        // on — lighter at the top-left where the framework hue is strongest,
        // sinking into the surface at the bottom — so it reads as stamped into
        // the card rather than as a translucent decal laid over it. Which is
        // also why the opacity can go up: the blend is doing the receding that
        // 25% was faking.
        <div aria-hidden className="absolute inset-0 flex items-center justify-center">
          <FrameworkLogo
            framework={project.framework as Framework}
            className="h-12 w-12 opacity-70 mix-blend-overlay [filter:brightness(0)_invert(1)]"
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
            edge of real glass — now drawn by the edge overlay at the end of
            this card, because a lip on THIS element is a straight line across
            an unrounded box: at the two top corners it ran off the curve and
            was sliced by the card's clip, which is what made the corners look
            broken;
          - the contour and drop shadow on the card itself, for thickness.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-white/[0.06] backdrop-blur-[14px] backdrop-saturate-[180%]"
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
          // The top scrim is now almost nothing — 0.30, down from 0.68. It was
          // heavy to protect the project name; the name moved to the bottom
          // and the metrics that replaced it carry their own plate, so all
          // that is left up here is a mark on its own gradient and a solid
          // white pill, neither of which needs help. What remains is for
          // depth, not legibility, and the top of the snapshot — the site's
          // header, the part that makes it recognisable — is visible again.
          //
          // The bottom one carries the name and URL. Two things were making it
          // aggressive, and they pull in opposite directions:
          //
          //  - 0.75 black over a white screenshot is very nearly black, so a
          //    pale card came out white-on-top, black-on-bottom. 0.62 still
          //    holds the title at ~6:1 over pure white, the worst case.
          //  - shortening it (48% → 34%) cut the darkened area but STEEPENED
          //    the ramp, and a hard edge between white and near-black is its
          //    own kind of loud. 38% is the compromise: still well clear of
          //    half the card, with room for the fade to be a fade.
          background: [
            "linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.12) 16%, transparent 32%)",
            "linear-gradient(to top, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.50) 10%, rgba(0,0,0,0.26) 22%, rgba(0,0,0,0.07) 31%, transparent 38%)",
          ].join(","),
        }}
      />

      {/*
        The top holds the mark on one side and everything measurable on the
        other: three columns in a row, flush to the card's right padding edge.
      */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-3.5 pt-3">
        {/* The status pill that used to sit here is gone, along with its
            component. It could never render: this card returns `DeployingCard`
            whenever the deployment is in flight, and the pill returned null
            whenever it was not — the two conditions were exact opposites, so
            the branch was unreachable from the day the terminal card landed. */}
        <div className="flex h-7 min-w-0 items-center">
          <FrameworkChip framework={project.framework as Framework} />
        </div>

        {/*
          The metrics carry their own ground.

          A scrim could not do this job. It is strongest at the edge it starts
          from and fades inward, so the value that protects the metrics where
          they sit is far more than the card's own corner needs — covering
          them meant darkening a third of the image to protect a strip.

          `backdrop-brightness` rather than a flat black fill: it pulls down
          whatever is actually behind the plate, so a white screenshot gets the
          darkening it needs and one that is already dark is left alone,
          keeping its colour through the pane. Worst case — pure white behind —
          the labels land at ~5:1.

          Hidden until the card is hovered, so at rest the card is its snapshot
          and its name and nothing else. `group-focus-within` is not optional
          here: the Auto switch lives inside, and without it a keyboard user
          tabs to a control that is still at zero opacity. The pointer-events
          guard is for the same reason from the other side — an invisible
          toggle that still takes clicks is worse than a hidden one.
        */}
        {/* Changes shape with the card rather than wrapping.

            At the window's smallest size a card is ~173px wide, leaving the
            plate about 109px — the three labelled columns need 165. Letting it
            wrap produced a ragged two-line block; below 240px it becomes a
            plain right-aligned column of values instead, labels dropped, which
            fits easily and looks like a decision rather than an accident. The
            labels move to tooltips at that size. */}
        <div className="pointer-events-none flex min-w-0 flex-col items-end gap-1 rounded-xl bg-black/35 px-2.5 py-2 opacity-0 ring-1 ring-inset ring-white/10 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-hover:backdrop-blur-md group-hover:backdrop-brightness-[0.45] group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-focus-within:backdrop-blur-md group-focus-within:backdrop-brightness-[0.45] group-data-[menu-open=true]:pointer-events-auto group-data-[menu-open=true]:opacity-100 group-data-[menu-open=true]:backdrop-blur-md group-data-[menu-open=true]:backdrop-brightness-[0.45] @min-[240px]:flex-row @min-[240px]:items-start @min-[240px]:gap-x-3">
          <Metric label="Deployed">
            {latest ? (
              <DeploymentTiming deployment={latest} className="text-white/90" />
            ) : (
              <span className="text-white/50">—</span>
            )}
          </Metric>
          <Metric label="Build">
            {latest ? (
              <DeploymentDuration deployment={latest} className="text-white/90" />
            ) : (
              <span className="text-white/50">—</span>
            )}
          </Metric>
          <Metric label="Auto">
            <span
              className="flex items-center"
              title={project.autoDeploy ? "Auto deploy on" : "Auto deploy paused"}
            >
              {/* The off state is spelled out because the card's scrim is dark
                  in both themes while `border-strong` is not: in light theme
                  it is black at 44%, an off switch that vanishes into the
                  gradient behind it. */}
              <AutoSwitch project={project} className="aria-[checked=false]:bg-white/30" />
            </span>
          </Metric>
        </div>
      </div>

      {/*
        The glass panel. `backdrop-blur` frosts whatever part of the screenshot
        sits behind it and the dark layer on top guarantees the contrast: white
        text over an arbitrary screenshot is otherwise a coin toss, unreadable
        the moment someone deploys a light-coloured site. Dark in both themes
        for the same reason — the text colour cannot depend on the image.
      */}
      {/*
        Identity along the bottom, with the menu in the corner beside it.

        `items-end` so the kebab sits on the URL's baseline rather than
        floating against the tallest thing in the row — it is a control that
        belongs to the card, and the bottom corner is where it stops competing
        with the mark and the status pill for the top edge.
      */}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 px-3.5 pb-3">
        <div className="min-w-0 flex-1">
          <h3
            className="truncate text-[19px] font-semibold leading-tight tracking-tight text-white"
            title={project.name}
          >
            {project.name}
          </h3>
          {/*
            The failure replaces the URL rather than being a banner of its own.
            As an absolutely-positioned strip it covered the framework chip and
            the kebab, and a card cannot afford to hide its own controls to
            show an error.
          */}
          {latest?.state === "failed" && latest.error ? (
            <button
              className="mt-1 block w-full text-left"
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
            <UrlLine url={url} className="mt-1" tone="onGlass" />
          ) : (
            <p className="mt-1 text-xs text-white/60">Not deployed yet</p>
          )}

          {(project.remoteRepo || project.lockedBranch) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <GitBadge project={project} />
              <LockBadge project={project} />
              <HeldBadge project={project} />
            </div>
          )}
        </div>

        <MenuButton onOpen={onContextMenu} className="-mr-0.5 mb-0.5 shrink-0" />
      </div>

      {/*
        The card's entire edge, in one element painted last so nothing can
        cover it: an inner hairline for thickness and a brighter lip along the
        top, where light catches the edge of real glass. Both follow the card's
        own 14px radius, which is the whole point of it living here — the same
        two shadows on the unrounded overlays above are straight lines that run
        off the curve at the corners.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[14px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15),inset_0_1px_0_rgba(255,255,255,0.30)]"
      />

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
  const deploying = latest && isDeploying(latest.state);
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
        {deploying ? (
          /*
            Mid-deploy the row shows its build log, the same swap the card view
            makes. Only the middle four columns are given up for it: Status
            reads "Building" and says nothing the log does not, and URL, Build
            and Updated all describe the PREVIOUS deployment — stale numbers
            sitting beside a live one. The project, its Auto switch and its
            menu stay put, so the table is still a table and still scannable
            while one of its rows is busy.
          */
          <td colSpan={4} className="px-3 py-1.5">
            <BuildLogTerminal
              deploymentId={latest.id}
              live
              className="h-[52px] rounded-md ring-1 ring-inset ring-white/10"
            />
          </td>
        ) : (
          <>
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
          </>
        )}
        <td className="px-3 py-2 text-right">
          <AutoSwitch project={project} />
        </td>
        <td className="px-3 py-2 text-right">
          <MenuButton onOpen={onContextMenu} />
        </td>
      </tr>
      {failed && (
        <tr className="border-b border-border/60 last:border-0">
          <td colSpan={7} className="px-3 pb-2 pt-0">
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
    /*
      The one place in this app with a delight budget to spend. It is seen
      once, on a first run, by someone who has just installed the thing and
      has no projects yet — the opposite of the every-day surfaces, where
      motion is a tax. A 60ms stagger lets the three lines arrive in the order
      you read them.
    */
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="rise-in">
        <h2 className="font-semibold">Your Vercel folder is empty</h2>
        <p className="mt-1 max-w-sm text-pretty text-xs leading-relaxed text-muted">
          Drop a project here — or into{" "}
          <code className="rounded bg-surface px-1 py-0.5 text-foreground">{rootFolder}</code>.
          Live in seconds.
        </p>
      </div>
      <Button
        className="rise-in [animation-delay:60ms]"
        onClick={() => void ipc.fs.openRootFolder()}
      >
        <FolderOpen className="h-3.5 w-3.5" /> Open the Folder
      </Button>
      <button
        className="rise-in text-[11px] text-faint hover:text-muted [animation-delay:120ms]"
        onClick={() => void reconcile(true)}
      >
        Rescan folder
      </button>
    </div>
  );
}
