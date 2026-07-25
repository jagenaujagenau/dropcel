import { describe, expect, it } from "@effect/vitest";
import {
  countLabel,
  filterByName,
  isDeploying,
  orderProjects,
  ownersWorthShowing,
  presentProjects,
  projectRow,
  rankFromOrder,
  statusLabel,
} from "./project-list";
import type { GitStatus } from "./git";
import type { Deployment, Project } from "./types";

/**
 * The dashboard's rules, tested without a DOM — the same treatment
 * `core/commands.ts` gets for the ⌘K palette. Every case here was previously
 * reachable only by mounting `Dashboard` with the whole atom graph faked.
 */

const project = (overrides: Partial<Project> & { id: string; name: string }): Project => ({
  path: `/root/${overrides.name}`,
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

const deployment = (overrides: Partial<Deployment> & { id: string }): Deployment => ({
  projectId: "p1",
  state: "ready",
  target: "production",
  url: null,
  error: null,
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: null,
  durationMs: null,
  publicUrl: null,
  branch: null,
  commitSha: null,
  vercelDeploymentId: null,
  inspectorUrl: null,
  ...overrides,
});

const git = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  isRepo: true,
  branch: "main",
  sha: "abc123",
  operation: null,
  ...overrides,
});

describe("ordering", () => {
  it("puts recently deployed first and never-deployed last, alphabetically", () => {
    const rank = rankFromOrder("p3,p1");
    const ordered = orderProjects(
      [
        project({ id: "p2", name: "zebra" }),
        project({ id: "p1", name: "blog" }),
        project({ id: "p4", name: "apple" }),
        project({ id: "p3", name: "shop" }),
      ],
      rank,
    );
    expect(ordered.map((p) => p.name)).toEqual(["shop", "blog", "apple", "zebra"]);
  });

  it("is a total order with no deployments at all", () => {
    const ordered = orderProjects(
      [project({ id: "b", name: "beta" }), project({ id: "a", name: "alpha" })],
      rankFromOrder(null),
    );
    expect(ordered.map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  it("does not mutate its input", () => {
    const input = [project({ id: "b", name: "beta" }), project({ id: "a", name: "alpha" })];
    orderProjects(input, rankFromOrder(""));
    expect(input.map((p) => p.name)).toEqual(["beta", "alpha"]);
  });
});

describe("what is on screen", () => {
  it("hides projects whose folder is gone", () => {
    const rows = presentProjects(
      [project({ id: "p1", name: "blog" }), project({ id: "p2", name: "ghost" })],
      new Set(["blog"]),
    );
    expect(rows.map((p) => p.name)).toEqual(["blog"]);
  });

  it("filters by name, case-insensitively, on a substring", () => {
    const all = [project({ id: "p1", name: "My Blog" }), project({ id: "p2", name: "shop" })];
    // Matches mid-word and ignores case on both sides, and the query is
    // trimmed — a trailing space from typing must not empty the list.
    expect(filterByName(all, "  BLO ").map((p) => p.name)).toEqual(["My Blog"]);
    expect(filterByName(all, " blo ").map((p) => p.name)).toEqual(["My Blog"]);
    expect(filterByName(all, "nope").map((p) => p.name)).toEqual([]);
    expect(filterByName(all, "   ").map((p) => p.name)).toEqual(["My Blog", "shop"]);
    expect(filterByName(all, "").map((p) => p.name)).toEqual(["My Blog", "shop"]);
  });

  /** Two accounts on screen is the trigger, not two accounts in history. */
  it("shows owners only when more than one account owns a visible project", () => {
    expect(ownersWorthShowing([project({ id: "p1", name: "a", ownerUid: "u1" })])).toBe(false);
    expect(
      ownersWorthShowing([
        project({ id: "p1", name: "a", ownerUid: "u1" }),
        project({ id: "p2", name: "b", ownerUid: "u1" }),
      ]),
    ).toBe(false);
    expect(
      ownersWorthShowing([
        project({ id: "p1", name: "a", ownerUid: "u1" }),
        project({ id: "p2", name: "b", ownerUid: "u2" }),
      ]),
    ).toBe(true);
  });

  /** An unclaimed project is "not yet known", not "somebody else". */
  it("does not count unowned projects as a second account", () => {
    expect(
      ownersWorthShowing([
        project({ id: "p1", name: "a", ownerUid: "u1" }),
        project({ id: "p2", name: "b", ownerUid: null }),
      ]),
    ).toBe(false);
  });

  it("counts projects, and says so differently while filtering", () => {
    expect(countLabel(12, 12, false)).toBe("12 projects");
    expect(countLabel(1, 1, false)).toBe("1 project");
    expect(countLabel(3, 12, true)).toBe("3 of 12 projects");
  });
});

describe("status", () => {
  it("treats every pre-terminal state as deploying", () => {
    for (const s of ["queued", "preparing", "uploading", "building"]) {
      expect(isDeploying(s)).toBe(true);
    }
    for (const s of ["ready", "failed", "canceled", "detected", undefined]) {
      expect(isDeploying(s)).toBe(false);
    }
  });

  /** One vocabulary. The card used to say "Live" where the table said
   * "Ready" — the same row of the same database, two words. */
  it("gives ready one name everywhere", () => {
    expect(statusLabel("ready")).toBe("Live");
    expect(statusLabel(undefined)).toBe("No deployments");
    expect(statusLabel("some-future-state")).toBe("some-future-state");
  });
});

describe("projectRow", () => {
  it("shows the URL when there is one", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: deployment({ id: "d1", publicUrl: "https://blog.example" }),
      git: null,
      heldReasons: null,
    });
    expect(row.body).toEqual({ kind: "url", url: "https://blog.example" });
    expect(row.deploying).toBe(false);
  });

  it("replaces the URL with the failure when the last deploy failed", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: deployment({
        id: "d1",
        state: "failed",
        error: "Module not found",
        publicUrl: "https://blog.example",
      }),
      git: null,
      heldReasons: null,
    });
    expect(row.body).toEqual({ kind: "failure", message: "Module not found" });
    // …but the address is still known, for Copy URL and Open.
    expect(row.url).toBe("https://blog.example");
  });

  /** A failure with no message is not something to render — the state is
   * already visible and an empty error box says nothing. */
  it("falls back to the URL when a failure carries no message", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: deployment({ id: "d1", state: "failed", error: null, url: "https://x.example" }),
      git: null,
      heldReasons: null,
    });
    expect(row.body).toEqual({ kind: "url", url: "https://x.example" });
  });

  it("says nothing has gone out yet when there is no deployment", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: undefined,
      git: null,
      heldReasons: null,
    });
    expect(row.body).toEqual({ kind: "none" });
  });

  it("hands the whole card over to the build log while deploying", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: deployment({ id: "d1", state: "building", publicUrl: "https://old.example" }),
      git: null,
      heldReasons: null,
    });
    expect(row.deploying).toBe(true);
    expect(row.body).toEqual({ kind: "log" });
  });

  /**
   * The bug this module exists for. The card only rendered its badge row when
   * `remoteRepo || lockedBranch` was set, so a project held mid-rebase — no
   * lock, no remote — showed its hold in the table and nothing at all on its
   * card. One row, both views.
   */
  it("reports a hold on a plain repo with no lock and no remote", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: undefined,
      git: git({ operation: "rebase" }),
      heldReasons: ["git-operation"],
    });
    expect(row.badges).toEqual([
      { kind: "git", label: "main · rebase", midOperation: true },
      { kind: "held", label: "Held — git operation" },
    ]);
  });

  it("shows the branch alone when no operation is in flight", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog", lockedBranch: "main" }),
      latest: undefined,
      git: git(),
      heldReasons: null,
    });
    expect(row.badges).toEqual([
      { kind: "git", label: "main", midOperation: false },
      { kind: "lock", label: "main", branch: "main" },
    ]);
  });

  it("has no badges for a non-repo project that is free to deploy", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: undefined,
      git: { isRepo: false, branch: null, sha: null, operation: null },
      heldReasons: [],
    });
    expect(row.badges).toEqual([]);
  });

  /** Holds overlap; the badge answers "why is this waiting" once. */
  it("names only the first hold reason", () => {
    const row = projectRow({
      project: project({ id: "p1", name: "blog" }),
      latest: undefined,
      git: null,
      heldReasons: ["offline", "account-switch"],
    });
    expect(row.badges).toEqual([{ kind: "held", label: "Held — offline" }]);
  });
});
