import { describe, expect, it } from "vitest";
import { choosePublicUrl } from "./public-url";

describe("choosePublicUrl", () => {
  const deploymentUrl = "https://blog-8fj2k1xq3-diego.vercel.app";

  it("prefers a verified custom domain above all", () => {
    expect(
      choosePublicUrl({
        deploymentUrl,
        aliases: ["https://blog.vercel.app"],
        verifiedDomains: ["myblog.com"],
      }),
    ).toBe("https://myblog.com");
  });

  it("prefers the stable project alias over git-branch aliases", () => {
    expect(
      choosePublicUrl({
        deploymentUrl,
        aliases: [
          "https://blog-git-main-diego.vercel.app",
          "https://blog.vercel.app",
        ],
        verifiedDomains: [],
      }),
    ).toBe("https://blog.vercel.app");
  });

  it("never picks a unique per-deployment host when a stable one exists", () => {
    expect(
      choosePublicUrl({
        deploymentUrl,
        aliases: [
          "https://blog-abc123def-diego.vercel.app",
          "https://blog.vercel.app",
        ],
        verifiedDomains: [],
      }),
    ).toBe("https://blog.vercel.app");
  });

  it("falls back to any alias, then the deployment url", () => {
    expect(
      choosePublicUrl({
        deploymentUrl,
        aliases: ["https://blog-git-main-diego.vercel.app"],
        verifiedDomains: [],
      }),
    ).toBe("https://blog-git-main-diego.vercel.app");
    expect(
      choosePublicUrl({ deploymentUrl, aliases: [], verifiedDomains: [] }),
    ).toBe(deploymentUrl);
  });
});
