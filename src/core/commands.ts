import { fuzzyMatch } from "../lib/fuzzy";
import { publicUrlOf, type Deployment, type Project } from "./types";

/**
 * The command palette's catalog and ranking — what ⌘K can do, and in what
 * order it offers it.
 *
 * Deliberately free of React and Tauri: the component supplies icons and the
 * side-effecting handlers, this decides *which* commands exist for the current
 * state and how a query orders them. That split is what makes the rules here
 * — a project with no deployment offers no "Copy URL", the last failed build
 * is reachable from anywhere — testable without a DOM.
 */

export type CommandGroup = "Project" | "Dropcel";

/** Stable identifiers, so the component can attach icons and handlers without
 * matching on user-facing labels. */
export type CommandKind =
  | "visit"
  | "copy-url"
  | "redeploy"
  | "deploy-preview"
  | "view-source"
  | "open-in-vercel"
  | "open-folder"
  | "settings"
  | "rescan"
  | "last-failed-log";

export interface CommandSpec {
  id: string;
  kind: CommandKind;
  label: string;
  /** Disambiguates same-named actions across projects; also matched on. */
  context?: string;
  group: CommandGroup;
  /** Right-aligned affordance — a URL, a shortcut hint. */
  hint?: string;
  /** Present on project commands; absent on app-level ones. */
  projectId?: string;
  /** Resolved public URL, for the commands that need one. */
  url?: string;
  /**
   * False on project commands that are hidden until the user types. See
   * DEFAULT_PROJECTS — app commands leave this undefined and always show.
   */
  inDefaultView?: boolean;
}

export interface CatalogInput {
  /** Already filtered to projects present on disk. */
  projects: Project[];
  latestByProject: Record<string, Deployment | undefined>;
  /** Dashboard URL for a project, derived from its inspector URL; null when
   * the project has never deployed. */
  dashboardUrlFor: (deployment: Deployment | undefined) => string | null;
}

function commandsForProject(
  project: Project,
  latest: Deployment | undefined,
  dashboardUrl: string | null,
): CommandSpec[] {
  const url = publicUrlOf(latest);
  const base = { context: project.name, group: "Project" as const, projectId: project.id };
  const cmds: CommandSpec[] = [];

  // URL-dependent commands come first — they're what a project is *for*, and
  // they're the ones a user reaches for most. Omitted entirely rather than
  // shown disabled: a palette that lists an action and then does nothing when
  // you press Enter is worse than one that doesn't offer it.
  if (url) {
    cmds.push(
      { ...base, id: `${project.id}:visit`, kind: "visit", label: "Visit", hint: url.replace("https://", ""), url },
      { ...base, id: `${project.id}:copy`, kind: "copy-url", label: "Copy URL", url },
    );
  }
  cmds.push(
    { ...base, id: `${project.id}:redeploy`, kind: "redeploy", label: "Redeploy" },
    { ...base, id: `${project.id}:preview`, kind: "deploy-preview", label: "Deploy Preview" },
    { ...base, id: `${project.id}:source`, kind: "view-source", label: "View Source" },
  );
  if (dashboardUrl) {
    cmds.push({
      ...base,
      id: `${project.id}:vercel`,
      kind: "open-in-vercel",
      label: "Open in Vercel",
      url: dashboardUrl,
    });
  }
  return cmds;
}

/**
 * The most recently *started* failed deployment across all projects, or
 * undefined when nothing has failed.
 *
 * Worth a top-level command because a failed build is the one thing a user
 * needs to act on immediately, and otherwise it's only reachable by finding
 * the right card and clicking through to its log.
 */
export function lastFailure(
  input: CatalogInput,
): { project: Project; deployment: Deployment } | undefined {
  return input.projects
    .map((project) => ({ project, deployment: input.latestByProject[project.id] }))
    .filter(
      (x): x is { project: Project; deployment: Deployment } =>
        x.deployment?.state === "failed",
    )
    .sort((a, b) => b.deployment.startedAt.localeCompare(a.deployment.startedAt))[0];
}

/**
 * How many projects contribute commands to the palette before the user types.
 *
 * Every project used to be listed, so opening the palette with a folder of a
 * dozen sites buried the app actions under ~60 rows and made the default view
 * something to scroll rather than read. The most recent project is almost
 * always the one being worked on; everything else is one keystroke away.
 */
const DEFAULT_PROJECTS = 1;

export function buildCatalog(input: CatalogInput): CommandSpec[] {
  // Most recently deployed first, so "recent" means recent rather than
  // whatever order the projects happened to arrive in. Never-deployed projects
  // sort last, alphabetically.
  const byRecency = [...input.projects].sort((a, b) => {
    const da = input.latestByProject[a.id]?.startedAt;
    const db = input.latestByProject[b.id]?.startedAt;
    if (da && db) return db.localeCompare(da);
    if (da) return -1;
    if (db) return 1;
    return a.name.localeCompare(b.name);
  });

  const projectCmds = byRecency.flatMap((p, i) => {
    const latest = input.latestByProject[p.id];
    const cmds = commandsForProject(p, latest, input.dashboardUrlFor(latest));
    // Assigned in place, not spread: these objects were just built by
    // commandsForProject and are owned by this call.
    for (const c of cmds) c.inDefaultView = i < DEFAULT_PROJECTS;
    return cmds;
  });

  const appCmds: CommandSpec[] = [
    { id: "app:open-folder", kind: "open-folder", label: "Open the Vercel Folder", group: "Dropcel" },
    { id: "app:settings", kind: "settings", label: "Settings", group: "Dropcel", hint: "⌘," },
    { id: "app:rescan", kind: "rescan", label: "Rescan Folder", group: "Dropcel" },
  ];

  const failure = lastFailure(input);
  if (failure) {
    appCmds.push({
      id: "app:last-failure",
      kind: "last-failed-log",
      label: "View Last Failed Build Log",
      context: failure.project.name,
      group: "Dropcel",
      projectId: failure.project.id,
    });
  }

  return [...projectCmds, ...appCmds];
}

/** Label + context as one searchable string, matching how the row renders. */
export function searchText(c: CommandSpec): string {
  return c.context ? `${c.label} ${c.context}` : c.label;
}

/**
 * Filters and orders the catalog for a query.
 *
 * An empty query shows the default view — the most recent project's commands
 * plus the app actions — in the catalog's own order. Typing searches the whole
 * catalog, so nothing is unreachable, it is just not all shown at once.
 */
export function rankCommands(commands: CommandSpec[], query: string): CommandSpec[] {
  const q = query.trim();
  if (!q) return commands.filter((c) => c.inDefaultView !== false);
  return commands
    .map((c) => ({ c, m: fuzzyMatch(q, searchText(c)) }))
    .filter((r) => r.m !== null)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((r) => r.c);
}
