import { describe, expect, it } from "vitest";
import { frameworkSlug, missingShas, VercelApiError } from "./vercel-api";

describe("frameworkSlug", () => {
  it("maps detected frameworks to Vercel project settings slugs", () => {
    expect(frameworkSlug("nextjs")).toBe("nextjs");
    expect(frameworkSlug("nuxt")).toBe("nuxtjs");
    expect(frameworkSlug("svelte")).toBe("sveltekit");
    expect(frameworkSlug("react")).toBe("create-react-app");
  });

  it("returns null (auto-detect) for backend/static/unknown", () => {
    expect(frameworkSlug("hono")).toBeNull();
    expect(frameworkSlug("express")).toBeNull();
    expect(frameworkSlug("static")).toBeNull();
    expect(frameworkSlug("unknown")).toBeNull();
  });
});

describe("missingShas", () => {
  it("extracts the missing sha list from a missing_files error", () => {
    const e = new VercelApiError({
      status: 400,
      code: "missing_files",
      message: "Missing files",
      detail: { missing: ["abc", "def"] },
    });
    expect(missingShas(e)).toEqual(["abc", "def"]);
  });

  it("returns null for unrelated errors", () => {
    const e = new VercelApiError({ status: 403, code: "forbidden", message: "no", detail: null });
    expect(missingShas(e)).toBeNull();
  });
});

describe("VercelApiError.retryable", () => {
  it("marks rate limits, server errors and network failures retryable", () => {
    const mk = (status: number) =>
      new VercelApiError({ status, code: null, message: "", detail: null });
    expect(mk(429).retryable).toBe(true);
    expect(mk(500).retryable).toBe(true);
    expect(mk(0).retryable).toBe(true);
    expect(mk(400).retryable).toBe(false);
    expect(mk(403).retryable).toBe(false);
  });
});
