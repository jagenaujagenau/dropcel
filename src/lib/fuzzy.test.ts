import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "./fuzzy";

/** Ranks candidates the way the palette does, best first. */
function rank(query: string, candidates: string[]): string[] {
  return candidates
    .map((text) => ({ text, m: fuzzyMatch(query, text) }))
    .filter((r) => r.m !== null)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map((r) => r.text);
}

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports where it landed", () => {
    const m = fuzzyMatch("dp", "Deploy Preview");
    expect(m).not.toBeNull();
    // 'd' at 0, then 'p' at the start of "Preview" — not the 'p' inside "Deploy".
    expect(m!.indices).toEqual([0, 7]);
  });

  it("rejects text missing a query character", () => {
    expect(fuzzyMatch("xyz", "Deploy Preview")).toBeNull();
  });

  it("treats an empty query as matching everything", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("is case-insensitive", () => {
    expect(fuzzyMatch("DEPLOY", "deploy preview")).not.toBeNull();
    expect(fuzzyMatch("deploy", "DEPLOY PREVIEW")).not.toBeNull();
  });

  it("lets spaces in the query separate words without needing to match", () => {
    expect(fuzzyMatch("dep prev", "Deploy Preview")).not.toBeNull();
    expect(fuzzyMatch("redep land", "Redeploy · landing-page")).not.toBeNull();
  });

  describe("ranking", () => {
    it("puts a prefix match above a mid-word one", () => {
      expect(rank("dep", ["Open in Vercel · deps", "Deploy Preview"])[0]).toBe(
        "Deploy Preview",
      );
    });

    it("prefers word-boundary initials over letters plucked from the middle", () => {
      // "vs" as initials of "View Source" should beat the v…s inside "Vercel".
      expect(rank("vs", ["Open in Vercel · site", "View Source"])[0]).toBe("View Source");
    });

    it("rewards adjacent runs over scattered hits", () => {
      const run = fuzzyMatch("land", "landing-page")!;
      const scattered = fuzzyMatch("land", "l-a-n-d")!;
      expect(run.score).toBeGreaterThan(scattered.score);
    });

    it("breaks ties toward the shorter label", () => {
      expect(rank("set", ["Settings · Advanced", "Settings"])[0]).toBe("Settings");
    });

    it("ranks the project the user is typing toward first", () => {
      const projects = ["marketing-site", "landing-page", "blog", "landing-page-old"];
      expect(rank("land", projects)[0]).toBe("landing-page");
    });
  });
});
