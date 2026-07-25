import { describe, expect, it } from "@effect/vitest";
import { availablePaletteActions, projectActions, type ProjectAction } from "./project-actions";
import type { Deployment, Project } from "./types";

/**
 * The availability rules the ⌘K palette and the right-click menu now share.
 * Before this module they each answered these questions separately, and
 * disagreed on every one of them.
 */

const project = (overrides: Partial<Project> = {}): Project => ({
  id: "p1",
  name: "blog",
  path: "/root/blog",
  framework: "static",
  vercelProjectId: null,
  autoDeploy: true,
  createdAt: "",
  updatedAt: "",
  lockedBranch: null,
  remoteRepo: null,
  teamId: null,
  ownerUid: null,
  ...overrides,
});

const deployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  id: "d1",
  projectId: "p1",
  state: "ready",
  target: "production",
  url: "https://blog-abc.vercel.app",
  error: null,
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: null,
  durationMs: null,
  publicUrl: "https://blog.example",
  branch: null,
  commitSha: null,
  vercelDeploymentId: null,
  inspectorUrl: null,
  ...overrides,
});

const by = (actions: ProjectAction[], kind: ProjectAction["kind"]) =>
  actions.find((a) => a.kind === kind)!;

describe("projectActions", () => {
  it("offers the URL actions once a project has deployed", () => {
    const actions = projectActions({
      project: project(),
      latest: deployment(),
      dashboardUrl: "https://vercel.com/d/blog",
    });
    expect(by(actions, "visit").unavailable).toBeNull();
    expect(by(actions, "visit").url).toBe("https://blog.example");
    expect(by(actions, "copy-url").unavailable).toBeNull();
    expect(by(actions, "open-in-vercel").unavailable).toBeNull();
    expect(by(actions, "view-build-log").unavailable).toBeNull();
  });

  /** Every one of these was a *different* answer in a different file. */
  it("explains, rather than merely refuses, on a project that has never deployed", () => {
    const actions = projectActions({
      project: project(),
      latest: undefined,
      dashboardUrl: null,
    });
    for (const kind of ["visit", "copy-url", "open-in-vercel", "view-build-log"] as const) {
      expect(by(actions, kind).unavailable).toBeTruthy();
    }
    // …and the things that don't need a deployment still work.
    expect(by(actions, "view-source").unavailable).toBeNull();
    expect(by(actions, "redeploy").unavailable).toBeNull();
  });

  /**
   * Manual deploys bypass every Guard and Gate by design — a held project is
   * exactly when you might reach for one.
   */
  it("always offers a manual deploy", () => {
    const actions = projectActions({ project: project(), latest: undefined, dashboardUrl: null });
    expect(by(actions, "redeploy").unavailable).toBeNull();
    expect(by(actions, "deploy-preview").unavailable).toBeNull();
  });

  it("withholds the only remote action until the project exists on Vercel", () => {
    const unlinked = projectActions({
      project: project(),
      latest: deployment(),
      dashboardUrl: null,
    });
    expect(by(unlinked, "delete-on-vercel").unavailable).toBeTruthy();

    const linked = projectActions({
      project: project({ vercelProjectId: "prj_1" }),
      latest: deployment(),
      dashboardUrl: null,
    });
    expect(by(linked, "delete-on-vercel").unavailable).toBeNull();
  });

  it("names the branch lock by its current state", () => {
    const off = projectActions({ project: project(), latest: undefined, dashboardUrl: null });
    expect(by(off, "lock-branch").label).toBe("Lock to Branch…");

    const on = projectActions({
      project: project({ lockedBranch: "main" }),
      latest: undefined,
      dashboardUrl: null,
    });
    expect(by(on, "lock-branch").label).toBe("Locked to main…");
  });

  it("falls back to the deployment URL when there is no public alias", () => {
    const actions = projectActions({
      project: project(),
      latest: deployment({ publicUrl: null }),
      dashboardUrl: null,
    });
    expect(by(actions, "visit").url).toBe("https://blog-abc.vercel.app");
  });
});

describe("availablePaletteActions", () => {
  /** The palette's policy on the shared verdict: drop what can't run. The
   * menu's opposite policy (grey it out, say why) is why `unavailable` is a
   * sentence and not a boolean. */
  it("keeps only runnable palette actions", () => {
    const actions = projectActions({
      project: project(),
      latest: undefined,
      dashboardUrl: null,
    });
    const kinds = availablePaletteActions(actions).map((a) => a.kind);
    expect(kinds).toEqual(["view-source", "redeploy", "deploy-preview"]);
  });

  it("never offers menu-only actions", () => {
    const actions = projectActions({
      project: project({ vercelProjectId: "prj_1" }),
      latest: deployment(),
      dashboardUrl: "https://vercel.com/d/blog",
    });
    const kinds = availablePaletteActions(actions).map((a) => a.kind);
    expect(kinds).not.toContain("move-to-trash");
    expect(kinds).not.toContain("delete-on-vercel");
    expect(kinds).not.toContain("view-build-log");
  });
});
