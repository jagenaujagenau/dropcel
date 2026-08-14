export type Framework =
  | "nextjs"
  | "nuxt"
  | "astro"
  | "remix"
  | "svelte"
  | "vue"
  | "vite"
  | "react"
  | "hono"
  | "express"
  | "static"
  | "unknown";

export type DeploymentState =
  | "detected"
  | "queued"
  | "preparing"
  | "uploading"
  | "building"
  | "ready"
  | "failed"
  | "canceled";

export type DeployTarget = "preview" | "production";

export interface Project {
  id: string;
  name: string;
  path: string;
  framework: Framework;
  vercelProjectId: string | null;
  autoDeploy: boolean;
  createdAt: string;
  updatedAt: string;
  /** When set, auto-deploys only run while the repo is on this branch. */
  lockedBranch: string | null;
  /** Vercel Git integration: null = unchecked, "" = none, else repo slug. */
  remoteRepo: string | null;
  /** Owning team id (team_…) for API scoping; null = personal scope. */
  teamId: string | null;
  /** The Vercel account this project deploys under. Null on projects that
   * predate ownership tracking, until the signed-in user claims them. */
  ownerUid: string | null;
}

/** A Vercel account this install has seen, cached so a project owned by
 * someone who is not signed in right now can still show whose it is. */
export interface Account {
  uid: string;
  username: string;
  avatarUrl: string | null;
}

export interface Deployment {
  id: string;
  projectId: string;
  state: DeploymentState | string;
  target: DeployTarget | string;
  url: string | null;
  error: string | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** Resolved public alias (custom domain / project domain); null when the
   * deployment URL is the only known address. */
  publicUrl: string | null;
  /** Git state at deploy time, when the project is a repo. */
  branch: string | null;
  commitSha: string | null;
  /** Vercel's own deployment id (dpl_…) and dashboard page. */
  vercelDeploymentId: string | null;
  inspectorUrl: string | null;
}

/** The address to show, open and copy by default. */
export function publicUrlOf(d: Deployment | undefined): string | null {
  return d?.publicUrl ?? d?.url ?? null;
}

export interface ProjectDomain {
  id: number;
  projectId: string;
  domain: string;
  verified: boolean;
  createdAt: string;
}

export interface LogLine {
  id: number;
  deploymentId: string;
  ts: string;
  stream: "stdout" | "stderr" | string;
  line: string;
}

export const FRAMEWORK_LABELS = {
  nextjs: "Next.js",
  nuxt: "Nuxt",
  astro: "Astro",
  remix: "Remix",
  svelte: "Svelte",
  vue: "Vue",
  vite: "Vite",
  react: "React",
  hono: "Hono",
  express: "Express",
  static: "Static HTML",
  unknown: "Unknown",
} satisfies Record<Framework, string>;

/**
 * Narrow a framework slug that came back from SQLite. Rows written by an
 * older build can hold a slug this version no longer knows, so an
 * unrecognised value becomes "unknown" instead of being taken at its word.
 */
export function toFramework(value: string): Framework {
  // SAFETY: FRAMEWORK_LABELS is keyed by exactly the Framework union — the
  // `satisfies` above is what enforces that — so membership in it is a
  // runtime proof that `value` is one of the union's members.
  return value in FRAMEWORK_LABELS ? (value as Framework) : "unknown";
}

/** The display label for a slug, falling back to the slug itself. */
export function frameworkLabel(value: string): string {
  return value in FRAMEWORK_LABELS ? FRAMEWORK_LABELS[toFramework(value)] : value;
}
