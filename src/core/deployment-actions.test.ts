import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as VercelApi from "./vercel-api";

const mocks = vi.hoisted(() => ({
  getAuthToken: vi.fn<() => Promise<string | null>>(async () => "tok"),
  /** projectId -> what asking Vercel for it does. */
  projects: new Map<string, "ok" | "gone" | "unreachable">(),
  asked: new Array<{ projectId: string; teamId: string | null }>(),
}));

vi.mock("./auth", () => ({ getAuthToken: mocks.getAuthToken }));

vi.mock("./vercel-api", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelApi>();
  return {
    ...actual,
    // `getProject` records the call and returns a marker; `run` turns the
    // marker into the outcome the test asked for, so the fake lives in one
    // place instead of being threaded through an Effect.
    getProject: (auth: { teamId: string | null }, projectId: string) => {
      mocks.asked.push({ projectId, teamId: auth.teamId });
      return { projectId };
    },
    run: async (marker: { projectId: string }) => {
      const outcome = mocks.projects.get(marker.projectId) ?? "ok";
      if (outcome === "gone") {
        throw new actual.VercelApiError({
          status: 404,
          code: "not_found",
          message: "Project not found",
          detail: null,
          retryAfterMs: null,
        });
      }
      if (outcome === "unreachable") throw new TypeError("Load failed");
      return { id: marker.projectId, name: "x", accountId: "acc", link: null };
    },
  };
});

import { findDeletedRemotes, linkToSlug, projectDashboardUrlFrom } from "./deployment-actions";
import type { Project } from "./types";

describe("linkToSlug", () => {
  it("maps provider links to repo slugs", () => {
    expect(linkToSlug({ type: "github", org: "diego", repo: "helloworld" })).toBe(
      "github.com/diego/helloworld",
    );
    expect(linkToSlug({ type: "gitlab", org: "team", repo: "app" })).toBe("gitlab.com/team/app");
    expect(linkToSlug({ type: "bitbucket", org: "x", repo: "y" })).toBe("bitbucket.org/x/y");
  });

  it("returns null for unconnected projects", () => {
    expect(linkToSlug(null)).toBeNull();
    expect(linkToSlug({ type: "github" })).toBeNull();
  });
});

describe("projectDashboardUrlFrom", () => {
  it("derives the project page from an inspector URL", () => {
    expect(
      projectDashboardUrlFrom(
        "https://vercel.com/diego-peraltas-projects-f93caac0/helloworld/4Nf2Qx1",
      ),
    ).toBe("https://vercel.com/diego-peraltas-projects-f93caac0/helloworld");
  });

  it("is null-safe", () => {
    expect(projectDashboardUrlFrom(null)).toBeNull();
    expect(projectDashboardUrlFrom("not a url")).toBeNull();
  });
});

const project = (name: string, vercelProjectId: string | null, teamId: string | null = null): Project => ({
  id: `p-${name}`,
  name,
  path: `/Users/x/Vercel/${name}`,
  framework: "astro",
  vercelProjectId,
  autoDeploy: true,
  createdAt: "",
  updatedAt: "",
  lockedBranch: null,
  remoteRepo: null,
  teamId,
  ownerUid: null,
});

describe("findDeletedRemotes", () => {
  beforeEach(() => {
    mocks.projects.clear();
    mocks.asked.length = 0;
    mocks.getAuthToken.mockResolvedValue("tok");
  });

  it("reports the projects Vercel answers 404 for, and only those", async () => {
    mocks.projects.set("prj_gone", "gone");
    const gone = await findDeletedRemotes([
      project("alive", "prj_alive"),
      project("gone", "prj_gone"),
      project("local-only", null),
    ]);
    expect(gone.map((p) => p.name)).toEqual(["gone"]);
    // An unlinked project has no remote to have lost, so it is never asked about.
    expect(mocks.asked.map((a) => a.projectId)).toEqual(["prj_alive", "prj_gone"]);
  });

  it("treats an unreachable API as no answer, not as deletion", async () => {
    mocks.projects.set("prj_a", "unreachable");
    mocks.projects.set("prj_b", "unreachable");
    expect(await findDeletedRemotes([project("a", "prj_a"), project("b", "prj_b")])).toEqual([]);
  });

  it("asks in the project's own team scope", async () => {
    await findDeletedRemotes([project("team-project", "prj_t", "team_1")]);
    expect(mocks.asked).toEqual([{ projectId: "prj_t", teamId: "team_1" }]);
  });

  it("does nothing while signed out — no token, no verdict", async () => {
    mocks.getAuthToken.mockResolvedValue(null);
    expect(await findDeletedRemotes([project("alive", "prj_alive")])).toEqual([]);
    expect(mocks.asked).toEqual([]);
  });
});
