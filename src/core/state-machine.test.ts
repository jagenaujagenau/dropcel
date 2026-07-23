import { describe, expect, it } from "vitest";
import { advance, canTransition, isTerminal, transition } from "./state-machine";

describe("deployment state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("detected", "queued")).toBe(true);
    expect(canTransition("queued", "preparing")).toBe(true);
    expect(canTransition("preparing", "uploading")).toBe(true);
    expect(canTransition("uploading", "building")).toBe(true);
    expect(canTransition("building", "ready")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("ready", "building")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(canTransition("queued", "ready")).toBe(false);
    const r = transition("ready", "queued");
    expect(r.ok).toBe(false);
  });

  it("allows cancellation from every non-terminal state", () => {
    for (const s of ["queued", "preparing", "uploading", "building"] as const) {
      expect(canTransition(s, "canceled")).toBe(true);
      expect(canTransition(s, "failed")).toBe(true);
    }
  });

  it("terminal states are terminal", () => {
    expect(isTerminal("ready")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("canceled")).toBe(true);
    expect(isTerminal("building")).toBe(false);
  });

  describe("advance (log-driven, monotonic)", () => {
    it("moves forward", () => {
      expect(advance("preparing", "uploading")).toBe("uploading");
      expect(advance("uploading", "building")).toBe("building");
    });

    it("never moves backwards on repeated/out-of-order logs", () => {
      expect(advance("building", "uploading")).toBe("building");
      expect(advance("building", "preparing")).toBe("building");
      expect(advance("uploading", "uploading")).toBe("uploading");
    });

    it("bridges skipped phases legally", () => {
      // CLI jumped straight to building output.
      expect(advance("queued", "building")).toBe("building");
    });

    it("does not resurrect terminal deployments", () => {
      expect(advance("ready", "building")).toBe("ready");
    });
  });
});
