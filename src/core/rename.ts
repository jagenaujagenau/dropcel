/**
 * Guard for the rename heuristic. "One folder vanished + one appeared" is
 * treated as a rename ONLY when identity evidence doesn't contradict it —
 * otherwise deleting `blog` and dropping in `shop` within one reconcile
 * window would silently hand `shop` the old project's history and Vercel
 * link.
 *
 * The `.vercel/project.json` link file travels with a renamed folder, so its
 * projectId is the identity signal.
 */
export function isLegitRename(
  storedProjectId: string | null,
  appearedLinkProjectId: string | null,
): boolean {
  // Only a deployed (linked) project has identity worth preserving, and the
  // folder must carry the same link. A never-deployed ghost matching a new
  // drop must NOT swallow it as a "rename" — that would skip the new
  // project's first deploy for history that is worthless anyway.
  return storedProjectId != null && appearedLinkProjectId === storedProjectId;
}

/** Parse `.vercel/project.json`, returning its projectId (null on any miss). */
export function parseLinkFile(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.projectId === "string" ? parsed.projectId : null;
  } catch {
    return null;
  }
}
