import { describe, expect, it } from "vitest";
import { buildCatalog, lastFailure, rankCommands, type CatalogInput } from "./commands";
import type { Deployment, Project } from "./types";

const project = (name: string, over: Partial<Project> = {}): Project => ({
  id: `p-${name}`,
  name,
  path: `/Users/d/Vercel/${name}`,
  framework: "static",
  vercelProjectId: null,
  autoDeploy: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lockedBranch: null,
  remoteRepo: null,
  teamId: null,
  ...over,
});

const deployment = (projectId: string, over: Partial<Deployment> = {}): Deployment => ({
  id: `d-${projectId}`,
  projectId,
  state: "ready",
  target: "production",
  url: `https://${projectId}.vercel.app`,
  error: null,
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
  durationMs: 60_000,
  publicUrl: null,
  branch: null,
  commitSha: null,
  vercelDeploymentId: null,
  inspectorUrl: null,
  ...over,
});

const input = (over: Partial<CatalogInput> = {}): CatalogInput => ({
  projects: [],
  latestByProject: {},
  dashboardUrlFor: () => null,
  ...over,
});

const kindsFor = (specs: ReturnType<typeof buildCatalog>, projectId: string) =>
  specs.filter((c) => c.projectId === projectId).map((c) => c.kind);

describe("buildCatalog", () => {
  it("offers URL actions only once a project has actually deployed", () => {
    const deployed = project("blog");
    const fresh = project("draft");
    const catalog = buildCatalog(
      input({
        projects: [deployed, fresh],
        latestByProject: { [deployed.id]: deployment(deployed.id) },
      }),
    );

    expect(kindsFor(catalog, deployed.id)).toContain("visit");
    expect(kindsFor(catalog, deployed.id)).toContain("copy-url");
    // A never-deployed project has no URL — offering "Copy URL" would give the
    // user an action that silently does nothing.
    expect(kindsFor(catalog, fresh.id)).not.toContain("visit");
    expect(kindsFor(catalog, fresh.id)).not.toContain("copy-url");
    // …but it can still be deployed and opened.
    expect(kindsFor(catalog, fresh.id)).toEqual(["redeploy", "deploy-preview", "view-source"]);
  });

  it("offers Open in Vercel only when a dashboard URL can be derived", () => {
    const p = project("blog");
    const withDash = buildCatalog(
      input({
        projects: [p],
        latestByProject: { [p.id]: deployment(p.id) },
        dashboardUrlFor: () => "https://vercel.com/d/blog",
      }),
    );
    expect(kindsFor(withDash, p.id)).toContain("open-in-vercel");

    const withoutDash = buildCatalog(
      input({ projects: [p], latestByProject: { [p.id]: deployment(p.id) } }),
    );
    expect(kindsFor(withoutDash, p.id)).not.toContain("open-in-vercel");
  });

  it("prefers the resolved public URL over the per-deployment one", () => {
    const p = project("blog");
    const catalog = buildCatalog(
      input({
        projects: [p],
        latestByProject: {
          [p.id]: deployment(p.id, {
            url: "https://blog-8fj2k1.vercel.app",
            publicUrl: "https://myblog.com",
          }),
        },
      }),
    );
    expect(catalog.find((c) => c.kind === "visit")?.url).toBe("https://myblog.com");
  });

  it("always includes the app-level actions", () => {
    const kinds = buildCatalog(input()).map((c) => c.kind);
    expect(kinds).toEqual(["open-folder", "settings", "rescan"]);
  });

  it("surfaces the most recent failure, and only when something failed", () => {
    const older = project("old");
    const newer = project("new");
    const healthy = project("fine");
    const catalog = buildCatalog(
      input({
        projects: [older, newer, healthy],
        latestByProject: {
          [older.id]: deployment(older.id, {
            state: "failed",
            startedAt: "2026-01-01T00:00:00Z",
          }),
          [newer.id]: deployment(newer.id, {
            state: "failed",
            startedAt: "2026-06-01T00:00:00Z",
          }),
          [healthy.id]: deployment(healthy.id),
        },
      }),
    );
    const failure = catalog.find((c) => c.kind === "last-failed-log");
    expect(failure?.context).toBe("new");

    expect(buildCatalog(input()).some((c) => c.kind === "last-failed-log")).toBe(false);
  });
});

describe("lastFailure", () => {
  it("ignores projects whose latest deployment succeeded", () => {
    const p = project("blog");
    expect(
      lastFailure(input({ projects: [p], latestByProject: { [p.id]: deployment(p.id) } })),
    ).toBeUndefined();
  });
});

describe("rankCommands", () => {
  const catalog = buildCatalog(
    input({
      projects: [project("landing-page"), project("marketing-site")],
      latestByProject: {
        "p-landing-page": deployment("p-landing-page"),
        "p-marketing-site": deployment("p-marketing-site"),
      },
    }),
  );

  it("keeps catalog order when there is no query", () => {
    const shown = rankCommands(catalog, "  ");
    expect(shown).toEqual(catalog.filter((c) => c.inDefaultView !== false));
  });

  /**
   * Opening the palette over a folder of a dozen sites used to list every
   * project's five-or-six actions, burying the app commands under rows nobody
   * scrolled. Only the most recent project shows until the user types.
   */
  it("shows only the most recent project before the user types", () => {
    const older = project("older-site");
    const newer = project("newer-site");
    const catalog = buildCatalog(
      input({
        // Deliberately passed oldest-first, so passing this requires the sort
        // rather than the incoming array order.
        projects: [older, newer],
        latestByProject: {
          [older.id]: deployment(older.id, { startedAt: "2026-01-01T00:00:00Z" }),
          [newer.id]: deployment(newer.id, { startedAt: "2026-06-01T00:00:00Z" }),
        },
      }),
    );

    const shown = rankCommands(catalog, "");
    const projects = new Set(shown.filter((c) => c.projectId).map((c) => c.context));
    expect(projects).toEqual(new Set(["newer-site"]));
    // App-level actions are never hidden — they have no project to be recent.
    expect(shown.some((c) => c.kind === "settings")).toBe(true);

    // ...and the hidden project is still one keystroke away.
    const searched = rankCommands(catalog, "older");
    expect(searched.some((c) => c.context === "older-site")).toBe(true);
  });

  it("narrows to one project when the user types its name", () => {
    const results = rankCommands(catalog, "landing");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((c) => c.context === "landing-page")).toBe(true);
  });

  it("finds an action across projects when the user types the verb", () => {
    const results = rankCommands(catalog, "redeploy");
    expect(results.slice(0, 2).every((c) => c.kind === "redeploy")).toBe(true);
  });

  it("ranks the exact action-plus-project a user is aiming for first", () => {
    const top = rankCommands(catalog, "redeploy landing")[0];
    expect(top?.kind).toBe("redeploy");
    expect(top?.context).toBe("landing-page");
  });

  it("returns nothing for a query that matches no command", () => {
    expect(rankCommands(catalog, "zzzqqq")).toEqual([]);
  });
});
