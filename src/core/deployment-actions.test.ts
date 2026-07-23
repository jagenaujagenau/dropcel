import { describe, expect, it } from "vitest";
import { linkToSlug, projectDashboardUrlFrom } from "./deployment-actions";

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
