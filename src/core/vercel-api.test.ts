import { describe, expect, it } from "vitest";
import { frameworkSlug, missingShas, parseRetryAfter, VercelApiError } from "./vercel-api";

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
      retryAfterMs: null,
      code: "missing_files",
      message: "Missing files",
      detail: { missing: ["abc", "def"] },
    });
    expect(missingShas(e)).toEqual(["abc", "def"]);
  });

  it("returns null for unrelated errors", () => {
    const e = new VercelApiError({ status: 403, code: "forbidden", message: "no", detail: null, retryAfterMs: null });
    expect(missingShas(e)).toBeNull();
  });
});

describe("VercelApiError.retryable", () => {
  it("marks rate limits, server errors and network failures retryable", () => {
    const mk = (status: number) =>
      new VercelApiError({ status, code: null, message: "", detail: null, retryAfterMs: null });
    expect(mk(429).retryable).toBe(true);
    expect(mk(500).retryable).toBe(true);
    expect(mk(0).retryable).toBe(true);
    expect(mk(400).retryable).toBe(false);
    expect(mk(403).retryable).toBe(false);
  });
});


describe("parseRetryAfter", () => {
  const now = Date.parse("2026-07-25T00:00:00Z");

  it("reads a delay in seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("  30  ", now)).toBe(30_000);
  });

  it("reads an HTTP-date as a delay from now", () => {
    expect(parseRetryAfter("Sat, 25 Jul 2026 00:02:00 GMT", now)).toBe(120_000);
  });

  it("never returns a negative delay for a date already past", () => {
    expect(parseRetryAfter("Sat, 25 Jul 2026 00:00:00 GMT", now + 5_000)).toBe(0);
  });

  it("clamps absurd values so a bogus header can't park a deploy for hours", () => {
    expect(parseRetryAfter("999999", now)).toBe(3_600_000);
  });

  it("returns null for a missing or unparseable header", () => {
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
  });
});
