import type { GitStatus } from "./git";
import type { HoldReason } from "./held-changes";
import { publicUrlOf, type Deployment, type Project } from "./types";

/**
 * What the dashboard shows, and in what order — the decisions, with none of
 * the chrome.
 *
 * The same split `core/commands.ts` makes for the ⌘K palette: *what* is on
 * screen lives here and is tested directly; *how it looks* stays in
 * `pages/Dashboard.tsx`. It exists because the dashboard has two views of the
 * same data, and while every rule was written inline in JSX the two of them
 * drifted — the card gated its badge row behind `remoteRepo || lockedBranch`
 * and the table did not, so a project held mid-rebase said so in the table and
 * said nothing at all on its card. Deriving one row and rendering it twice is
 * what makes that class of divergence unrepresentable rather than merely
 * fixed.
 */

/** Above this count, scanning the grid or table by eye stops being enough. */
export const SEARCH_THRESHOLD = 7;

// ---- ordering ---------------------------------------------------------------

/**
 * Rank lookup from `projectOrderAtom`'s delimited string (most recently
 * deployed first). A string rather than an array on purpose — see the atom.
 */
export function rankFromOrder(order: string | null | undefined): Map<string, number> {
  if (!order) return new Map();
  return new Map(order.split(",").map((id, i) => [id, i] as const));
}

/**
 * Rank straight from the deployments map, for callers that hold it (the ⌘K
 * palette) rather than the atom's precomputed string (the dashboard).
 *
 * Same rule, one implementation. Projects with no deployment are absent —
 * `orderProjects` puts them last.
 */
export function rankByRecency(
  latestByProject: Readonly<Record<string, Deployment | undefined>>,
): Map<string, number> {
  const deployed = Object.entries(latestByProject).filter(
    (entry): entry is [string, Deployment] => entry[1] !== undefined,
  );
  deployed.sort(([, a], [, b]) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return new Map(deployed.map(([id], i) => [id, i] as const));
}

/**
 * Most recently deployed first; never-deployed projects settle alphabetically
 * after them rather than in whatever order SQLite returned.
 *
 * The one implementation of "project order". There were three — this one, the
 * atom that produces the rank string, and the command palette's — each with
 * its own sentinel and tiebreak, all claiming to be the same product rule.
 */
export function orderProjects<T extends { id: string; name: string }>(
  projects: readonly T[],
  rank: ReadonlyMap<string, number>,
): T[] {
  return [...projects].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
  );
}

// ---- what is on screen ------------------------------------------------------

/**
 * Projects whose folder is actually in the root folder right now.
 *
 * Folder = truth: a row whose directory is gone is a "ghost" and belongs in
 * Settings' removed-projects list, not on the dashboard. Settings applies the
 * exact inverse of this predicate.
 */
export function presentProjects(
  projects: readonly Project[],
  presentOnDisk: ReadonlySet<string>,
): Project[] {
  return projects.filter((p) => presentOnDisk.has(p.name));
}

/** Substring, case-insensitive, name only — a filter over a list you can
 * already see, not a search. (⌘K is the fuzzy one, because there you are
 * recalling a name rather than narrowing a visible set.) */
export function filterByName(projects: readonly Project[], search: string): Project[] {
  const query = search.trim().toLowerCase();
  if (!query) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(query));
}

/**
 * Is whose-project-is-this worth drawing?
 *
 * Counted over the projects on screen rather than over the accounts table:
 * having signed into a second account once, years ago, is not a reason to put
 * an avatar on every card forever. Unowned projects don't count — they are
 * "not yet claimed", not "a different person".
 */
export function ownersWorthShowing(projects: readonly Project[]): boolean {
  const owners = new Set<string>();
  for (const p of projects) if (p.ownerUid) owners.add(p.ownerUid);
  return owners.size > 1;
}

/** "3 of 12 projects" while filtering, "12 projects" otherwise. */
export function countLabel(matching: number, total: number, searching: boolean): string {
  if (searching) return `${matching} of ${total} projects`;
  return `${total} ${total === 1 ? "project" : "projects"}`;
}

// ---- per-project display state ---------------------------------------------

export const DEPLOYING_STATES = ["queued", "preparing", "uploading", "building"] as const;

export function isDeploying(state: string | undefined): boolean {
  return (DEPLOYING_STATES as readonly string[]).includes(state ?? "");
}

/**
 * One label per deployment state, for every surface.
 *
 * There were two of these and they disagreed: the card's pill said "Live" for
 * `ready` and the table's status column said "Ready", for the same row of the
 * same database. `ready` is the state machine's word; "Live" is the product's,
 * and the product's is the one the user is asking about.
 */
export const STATUS_LABELS: Record<string, string> = {
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

export function statusLabel(state: string | undefined): string {
  if (!state) return "No deployments";
  return STATUS_LABELS[state] ?? state;
}

const HOLD_LABELS: Record<HoldReason, string> = {
  offline: "Held — offline",
  "account-switch": "Held — account switch",
  "git-operation": "Held — git operation",
  "signed-out": "Held — signed out",
};

export type ProjectBadge =
  | { kind: "git"; label: string; midOperation: boolean }
  | { kind: "lock"; label: string; branch: string }
  | { kind: "held"; label: string };

/**
 * What the card and the table each need to know about one project, decided
 * once.
 *
 * `body` is the three-way triage both views make below the project name, named
 * rather than re-derived: a failure with a message replaces the URL (as a
 * banner it covered the card's own controls), otherwise the URL, otherwise a
 * project that has never gone out.
 */
export interface ProjectRow {
  readonly project: Project;
  readonly latest: Deployment | undefined;
  readonly deploying: boolean;
  readonly url: string | null;
  readonly body:
    | { kind: "log" }
    | { kind: "failure"; message: string }
    | { kind: "url"; url: string }
    | { kind: "none" };
  readonly badges: readonly ProjectBadge[];
}

export function projectRow(input: {
  project: Project;
  latest: Deployment | undefined;
  git: GitStatus | null;
  heldReasons: readonly HoldReason[] | null;
}): ProjectRow {
  const { project, latest, git, heldReasons } = input;
  const deploying = isDeploying(latest?.state);
  const url = publicUrlOf(latest);

  const badges: ProjectBadge[] = [];
  if (git?.isRepo && git.branch) {
    badges.push({
      kind: "git",
      label: git.operation ? `${git.branch} · ${git.operation}` : git.branch,
      midOperation: git.operation !== null,
    });
  }
  if (project.lockedBranch) {
    badges.push({ kind: "lock", label: project.lockedBranch, branch: project.lockedBranch });
  }
  // Only the first reason. Holds accumulate, but "why isn't this deploying"
  // has one useful answer at a time, and the rest surface as the first one
  // clears.
  if (heldReasons && heldReasons.length > 0) {
    badges.push({ kind: "held", label: HOLD_LABELS[heldReasons[0]!] });
  }

  return {
    project,
    latest,
    deploying,
    url,
    body: deploying
      ? { kind: "log" }
      : latest?.state === "failed" && latest.error
        ? { kind: "failure", message: latest.error }
        : url
          ? { kind: "url", url }
          : { kind: "none" },
    badges,
  };
}
