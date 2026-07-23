import { getAuthToken } from "./auth";
import type { Deployment, Project } from "./types";
import * as api from "./vercel-api";
import { VercelApiError } from "./vercel-api";

/**
 * One-shot deployment operations via the REST API. Redeploys deliberately do
 * NOT live here — they go through the deployment queue so they get the full
 * state machine, logs and notifications.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

async function authFor(project: Project): Promise<api.VercelAuth> {
  const token = await getAuthToken();
  if (!token) throw new Error("No Vercel access token — open Settings and sign in.");
  return { token, teamId: project.teamId };
}

async function runAction(
  f: () => Promise<void>,
  describe: string,
): Promise<ActionResult> {
  try {
    await f();
    return { ok: true, message: "" };
  } catch (e) {
    const message =
      e instanceof VercelApiError ? e.message : e instanceof Error ? e.message : String(e);
    return { ok: false, message: `${describe} failed: ${message}` };
  }
}

/**
 * Permanently delete the project on Vercel (deployments, aliases, domains).
 * Callers MUST gate this behind a typed confirmation.
 */
export function deleteRemoteProject(project: Project) {
  return runAction(async () => {
    if (!project.vercelProjectId) throw new Error("project is not linked to Vercel");
    const auth = await authFor(project);
    await api.run(api.deleteProject(auth, project.vercelProjectId));
  }, "Delete");
}

/** Map a project's Git integration link to a repo slug for display. */
export function linkToSlug(link: { type: string; org?: string; repo?: string } | null): string | null {
  if (!link || !link.org || !link.repo) return null;
  const host =
    link.type === "github"
      ? "github.com"
      : link.type === "gitlab"
        ? "gitlab.com"
        : link.type === "bitbucket"
          ? "bitbucket.org"
          : link.type;
  return `${host}/${link.org}/${link.repo}`;
}

/** Whether the Vercel project deploys via a Git integration (repo slug). */
export async function checkGitConnection(project: Project): Promise<string | null> {
  if (!project.vercelProjectId) return null;
  const auth = await authFor(project);
  const p = await api.run(api.getProject(auth, project.vercelProjectId));
  return linkToSlug(p.link);
}

/** The deployment's page in the Vercel dashboard. */
export function inspectorUrlOf(deployment: Deployment): string | null {
  return deployment.inspectorUrl;
}

/**
 * The project's page on vercel.com, derived from any stored inspector URL
 * (https://vercel.com/<scope>/<project>/<id> → first two segments).
 */
export function projectDashboardUrlFrom(inspectorUrl: string | null): string | null {
  if (!inspectorUrl) return null;
  try {
    const u = new URL(inspectorUrl);
    const [scope, project] = u.pathname.split("/").filter(Boolean);
    if (scope && project) return `https://vercel.com/${scope}/${project}`;
  } catch {
    /* fall through */
  }
  return null;
}
