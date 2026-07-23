import { describe, expect, it } from "vitest";
import { shouldHoldAutoDeploy, type GitStatus } from "./git";

const repo = (over: Partial<GitStatus> = {}): GitStatus => ({
  isRepo: true,
  branch: "main",
  sha: "abc123def456",
  operation: null,
  ...over,
});

describe("shouldHoldAutoDeploy", () => {
  it("never holds non-git projects", () => {
    expect(shouldHoldAutoDeploy(null, null).hold).toBe(false);
    expect(shouldHoldAutoDeploy({ isRepo: false, branch: null, sha: null, operation: null }, "main").hold).toBe(false);
  });

  it("holds during merge/rebase/cherry-pick/bisect", () => {
    for (const op of ["merge", "rebase", "cherry-pick", "bisect"]) {
      const v = shouldHoldAutoDeploy(repo({ operation: op }), null);
      expect(v.hold).toBe(true);
      expect(v.reason).toContain(op);
    }
  });

  it("deploys any branch when no lock is set", () => {
    expect(shouldHoldAutoDeploy(repo({ branch: "feature-x" }), null).hold).toBe(false);
  });

  it("enforces the branch lock", () => {
    expect(shouldHoldAutoDeploy(repo({ branch: "main" }), "main").hold).toBe(false);
    const v = shouldHoldAutoDeploy(repo({ branch: "feature-x" }), "main");
    expect(v.hold).toBe(true);
    expect(v.reason).toBe("locked to main — on feature-x");
  });

  it("holds detached HEAD when locked", () => {
    expect(shouldHoldAutoDeploy(repo({ branch: null }), "main").hold).toBe(true);
    // …but not when unlocked: detached previews are legitimate.
    expect(shouldHoldAutoDeploy(repo({ branch: null }), null).hold).toBe(false);
  });

  it("operation hold wins over branch match", () => {
    const v = shouldHoldAutoDeploy(repo({ branch: "main", operation: "rebase" }), "main");
    expect(v.hold).toBe(true);
  });
});
