import { publicUrlOf, type Deployment, type Project } from "./types";

/**
 * What you can do to a project, and whether you can do it right now.
 *
 * There are three surfaces offering the same verbs — the ⌘K palette
 * (`core/commands.ts`), the right-click menu (`ProjectContextMenu`), and the
 * card itself — and each used to decide availability for itself. They
 * disagreed: for a project that had never deployed, the palette *omitted* Copy
 * URL, the menu showed it *disabled*, and the card replaced the whole line
 * with "Not deployed yet". Three answers to one question.
 *
 * The fix is not to make all three look the same — omitting a dead row is
 * right for a search list, and a fixed-shape menu is more legible when it
 * shows the same items every time. It is to decide *once* whether the action
 * can run, and let each surface apply its own presentation policy to that one
 * verdict.
 */

export type ProjectActionKind =
  | "open-in-vercel"
  | "visit"
  | "copy-url"
  | "view-source"
  | "view-build-log"
  | "redeploy"
  | "deploy-preview"
  | "lock-branch"
  | "deploy-under"
  | "move-to-trash"
  | "delete-on-vercel";

export interface ProjectAction {
  readonly kind: ProjectActionKind;
  readonly label: string;
  /**
   * Why this can't run right now, phrased for a human — `null` when it can.
   *
   * A reason rather than a boolean, because both surfaces need to *say*
   * something: the menu as a tooltip on the greyed row, the palette (which
   * drops the row entirely) as the toast it shows if the action is reached
   * another way.
   */
  readonly unavailable: string | null;
  /** The address the action acts on, for the ones that have one. */
  readonly url?: string;
  /** Offered by the command palette. The menu offers everything. */
  readonly inPalette: boolean;
}

const NEVER_DEPLOYED = "Deploy once first — this needs a live deployment.";

/**
 * Every action for one project, in menu order.
 *
 * Ordering is part of the decision, not the chrome: URL-dependent actions come
 * first because they are what a project is *for*, and the two destructive ones
 * come last, separated from everything else.
 */
export function projectActions(input: {
  project: Project;
  latest: Deployment | undefined;
  /** The project's Vercel dashboard page, derived from the latest
   * deployment's inspector URL; null when it has never deployed. */
  dashboardUrl: string | null;
}): ProjectAction[] {
  const { project, latest, dashboardUrl } = input;
  const url = publicUrlOf(latest);

  return [
    {
      kind: "open-in-vercel",
      label: "Open in Vercel",
      unavailable: dashboardUrl ? null : "Deploy once first — then this opens the Vercel page.",
      url: dashboardUrl ?? undefined,
      inPalette: true,
    },
    {
      kind: "visit",
      label: "Visit",
      unavailable: url ? null : NEVER_DEPLOYED,
      url: url ?? undefined,
      inPalette: true,
    },
    {
      kind: "copy-url",
      label: "Copy URL",
      unavailable: url ? null : NEVER_DEPLOYED,
      url: url ?? undefined,
      inPalette: true,
    },
    // Always available: the folder exists whether or not anything ever
    // deployed — it is the one thing that is always true of a project.
    { kind: "view-source", label: "View Source", unavailable: null, inPalette: true },
    {
      kind: "view-build-log",
      label: "View Build Log",
      unavailable: latest ? null : "No build has run yet.",
      inPalette: false,
    },
    // Manual deploys bypass every Guard and Gate by design, so they are
    // offered even while the project is held — that is the whole point of
    // having them.
    { kind: "redeploy", label: "Redeploy", unavailable: null, inPalette: true },
    { kind: "deploy-preview", label: "Deploy Preview", unavailable: null, inPalette: true },
    {
      kind: "lock-branch",
      label: project.lockedBranch ? `Locked to ${project.lockedBranch}…` : "Lock to Branch…",
      unavailable: null,
      inPalette: false,
    },
    { kind: "deploy-under", label: "Deploy Under…", unavailable: null, inPalette: false },
    { kind: "move-to-trash", label: "Move to Trash…", unavailable: null, inPalette: false },
    {
      kind: "delete-on-vercel",
      label: "Delete on Vercel…",
      // The only action that touches the remote. Nothing to delete before the
      // first deploy has created the project up there.
      unavailable: project.vercelProjectId ? null : "This project doesn't exist on Vercel yet.",
      inPalette: false,
    },
  ];
}

/** The subset a search list should offer: in the palette, and runnable.
 * A row that does nothing when you press Enter is worse than no row. */
export function availablePaletteActions(actions: readonly ProjectAction[]): ProjectAction[] {
  return actions.filter((a) => a.inPalette && a.unavailable === null);
}
