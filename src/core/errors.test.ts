import { describe, expect, it } from "vitest";
import { explainFailure } from "./errors";

describe("explainFailure", () => {
  it("explains a missing package.json", () => {
    const r = explainFailure("Error! Could not read package.json in /x");
    expect(r.message).toMatch(/package\.json is missing/);
    expect(r.retryable).toBe(false);
  });

  it("explains auth problems and does not retry them", () => {
    const r = explainFailure('Error: The specified token is not valid.');
    expect(r.message).toMatch(/token is invalid or expired/);
    expect(r.retryable).toBe(false);
  });

  it("explains build command failures with the command and code", () => {
    const r = explainFailure('Error: Command "npm run build" exited with 1');
    expect(r.message).toContain("npm run build");
    expect(r.message).toContain("exit code 1");
  });

  it("explains missing modules by name", () => {
    const r = explainFailure("Module not found: Cannot find module 'left-pad'");
    expect(r.message).toContain("left-pad");
  });

  it("marks network failures as retryable", () => {
    const r = explainFailure("FetchError: request failed, reason: ETIMEDOUT");
    expect(r.retryable).toBe(true);
    expect(r.message).toMatch(/network/i);
  });

  it("marks rate limits as retryable", () => {
    expect(explainFailure("Error: too many requests (429)").retryable).toBe(true);
  });

  it("never produces a generic shrug", () => {
    const r = explainFailure("Error! Unexpected wombat in pipeline");
    expect(r.message).toContain("wombat");
    expect(r.message).not.toMatch(/something went wrong/i);
  });

  it("handles completely empty output", () => {
    const r = explainFailure("");
    expect(r.message).toMatch(/logs/i);
  });
});
