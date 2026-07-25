import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "@effect/atom-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ExternalLink,
  FileText,
  FolderOpen,
  Link as LinkIcon,
  RefreshCw,
  Rocket,
  Settings as SettingsIcon,
  Triangle,
} from "lucide-react";
import {
  deployProject,
  latestByProjectAtom,
  presentOnDiskAtom,
  projectsAtom,
  reconcile,
  setRoute,
  useAtomState,
} from "../core/atoms";
import {
  buildCatalog,
  lastFailure,
  rankCommands,
  type CommandKind,
  type CommandSpec,
} from "../core/commands";
import { projectDashboardUrlFrom } from "../core/deployment-actions";
import type { Deployment } from "../core/types";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";

/**
 * ⌘K — the keyboard route to everything the right-click menu offers, plus the
 * app-level actions that previously had no shortcut at all.
 *
 * The dashboard is otherwise entirely pointer-driven: every project action
 * lives behind a right-click, which is both undiscoverable and unreachable
 * without leaving the keyboard. This is the surface where "redeploy the
 * landing page" is a few keystrokes from anywhere in the app.
 *
 * *What* the palette offers and how a query orders it lives in
 * `core/commands` (pure, tested); this file owns presentation, keyboard
 * navigation, and the side effects each command kind performs.
 */

const ICONS: Record<CommandKind, React.ReactNode> = {
  visit: <ExternalLink className="h-3.5 w-3.5" />,
  "copy-url": <LinkIcon className="h-3.5 w-3.5" />,
  redeploy: <Rocket className="h-3.5 w-3.5" />,
  "deploy-preview": <Rocket className="h-3.5 w-3.5" />,
  "view-source": <FolderOpen className="h-3.5 w-3.5" />,
  "open-in-vercel": <Triangle className="h-3 w-3 fill-current" />,
  "open-folder": <FolderOpen className="h-3.5 w-3.5" />,
  settings: <SettingsIcon className="h-3.5 w-3.5" />,
  rescan: <RefreshCw className="h-3.5 w-3.5" />,
  "last-failed-log": <FileText className="h-3.5 w-3.5" />,
};

export function CommandPalette({
  open,
  onClose,
  onViewLogs,
}: {
  open: boolean;
  onClose: () => void;
  onViewLogs: (deployment: Deployment, projectName: string) => void;
}) {
  const projects = useAtomState(projectsAtom, []);
  const presentOnDisk = useAtomState(presentOnDiskAtom, new Set<string>());
  const latestByProject = useAtomValue(latestByProjectAtom);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const catalogInput = useMemo(
    () => ({
      projects: projects.filter((p) => presentOnDisk.has(p.name)),
      latestByProject,
      dashboardUrlFor: (d: Deployment | undefined) =>
        projectDashboardUrlFrom(d?.inspectorUrl ?? null),
    }),
    [projects, presentOnDisk, latestByProject],
  );

  // Only built while open — the catalog closes over current deployments, and
  // there's nothing to rank when nobody's looking.
  const commands = useMemo(
    () => (open ? buildCatalog(catalogInput) : []),
    [open, catalogInput],
  );
  const results = useMemo(() => rankCommands(commands, query), [commands, query]);

  // A new query re-ranks everything; keeping the old index would leave the
  // highlight on an unrelated row.
  useEffect(() => setActive(0), [query]);

  // Reset on close so the next ⌘K is a blank slate rather than resuming a
  // half-typed search from minutes ago.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Keep the highlighted row on screen during arrow-key traversal. Layout
  // effect so the scroll lands in the same frame the highlight moves.
  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  if (!open) return null;

  const perform = (c: CommandSpec) => {
    switch (c.kind) {
      case "visit":
      case "open-in-vercel":
        if (c.url) void openUrl(c.url);
        return;
      case "copy-url":
        if (c.url) void writeText(c.url);
        return;
      case "redeploy":
        if (c.projectId) deployProject(c.projectId, "production");
        return;
      case "deploy-preview":
        if (c.projectId) deployProject(c.projectId, "preview");
        return;
      case "view-source":
        if (c.context) void ipc.fs.openRootFolder(c.context);
        return;
      case "open-folder":
        void ipc.fs.openRootFolder();
        return;
      case "settings":
        setRoute({ name: "settings" });
        return;
      case "rescan":
        void reconcile(true);
        return;
      case "last-failed-log": {
        const failure = lastFailure(catalogInput);
        if (failure) onViewLogs(failure.deployment, failure.project.name);
        return;
      }
    }
  };

  const choose = (index: number) => {
    const cmd = results[index];
    if (!cmd) return;
    // Close first: some commands navigate or open a dialog, and the palette
    // shouldn't still be sitting on top when they do.
    onClose();
    perform(cmd);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: string | null = null;

  return createPortal(
    <div
      className="dialog-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="dialog-panel w-full max-w-xl overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search projects and actions…"
          aria-label="Search projects and actions"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          aria-controls="command-palette-results"
          className="w-full select-text border-b border-border bg-transparent px-4 py-3 text-[13px] text-foreground placeholder:text-faint focus:outline-none"
        />
        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          className="max-h-[52vh] overflow-y-auto p-1.5"
        >
          {results.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-xs text-faint">
              No matches for "{query.trim()}".
            </p>
          ) : (
            results.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {header && (
                    <p className="px-2.5 pb-1 pt-2 text-[10px] uppercase tracking-wider text-faint">
                      {header}
                    </p>
                  )}
                  <button
                    id={`cmd-${c.id}`}
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    // Pointer and keyboard drive the same highlight, so moving
                    // the mouse never leaves two rows looking selected.
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(i)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                      i === active ? "bg-surface-hover text-foreground" : "text-muted",
                    )}
                  >
                    <span className={cn("shrink-0", i === active ? "text-foreground" : "text-faint")}>
                      {ICONS[c.kind]}
                    </span>
                    <span className="truncate" title={c.label}>{c.label}</span>
                    {c.context && <span className="shrink-0 text-faint">·</span>}
                    {c.context && (
                      <span className="truncate font-medium text-foreground" title={c.context}>
                      {c.context}
                    </span>
                    )}
                    {c.hint && (
                      <span
                        className="ml-auto shrink-0 truncate pl-3 text-[11px] text-faint"
                        title={c.hint}
                      >
                        {c.hint}
                      </span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
