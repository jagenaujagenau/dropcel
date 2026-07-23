import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Deployer,
  DeployOutcome,
  DeployProgress,
  DeployRequest,
} from "./deployer";
import { HeldChanges } from "./held-changes";
import { DeploymentQueue, type QueueDeps } from "./queue";
import type { DeploymentState } from "./types";

/**
 * Integration tests for the deployment queue running against a scriptable
 * mock deployer — no Tauri, no CLI, no real filesystem.
 */

const ok = (url = "https://x.vercel.app"): DeployOutcome => ({
  ok: true,
  url,
  exitCode: 0,
  canceled: false,
  error: null,
  retryable: false,
});

const fail = (retryable = false, error = "boom"): DeployOutcome => ({
  ok: false,
  url: null,
  exitCode: 1,
  canceled: false,
  error,
  retryable,
});

type Script = (
  req: DeployRequest,
  onProgress: (p: DeployProgress) => void,
) => Promise<DeployOutcome>;

function makeMockDeployer(script: Script) {
  const calls: DeployRequest[] = [];
  const cancels: string[] = [];
  const deployer: Deployer = {
    deploy(req, onProgress) {
      calls.push(req);
      return {
        done: script(req, onProgress),
        cancel: () => cancels.push(req.deploymentId),
      };
    },
  };
  return { deployer, calls, cancels };
}

interface Harness {
  queue: DeploymentQueue;
  transitions: { projectId: string; state: DeploymentState; info?: unknown }[];
  calls: DeployRequest[];
  cancels: string[];
}

function makeHarness(
  script: Script,
  overrides: Partial<QueueDeps> = {},
  autoDeploy = true,
): Harness {
  const { deployer, calls, cancels } = makeMockDeployer(script);
  let seq = 0;
  const transitions: Harness["transitions"] = [];
  const queue = new DeploymentQueue({
    deployer,
    debounceMs: 100,
    pipeline: { maxRetries: 2, baseDelayMs: 1 },
    createDeployment: async () => `dep-${++seq}`,
    onTransition: (projectId, _deploymentId, state, info) => {
      transitions.push({ projectId, state, info });
    },
    getProject: (id) => ({ id, name: "blog", path: "/x/blog", autoDeploy }),
    ...overrides,
  });
  return { queue, transitions, calls, cancels };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("DeploymentQueue", () => {
  describe("debouncing", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("collapses a burst of changes into one deployment", async () => {
      const h = makeHarness(async () => ok());
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(50);
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(50);
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(500);
      expect(h.calls.length).toBe(1);
    });

    it("does nothing while auto deploy is off", async () => {
      const h = makeHarness(async () => ok(), {}, false);
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);
    });

    it("does nothing while paused", async () => {
      const h = makeHarness(async () => ok());
      h.queue.setPaused(true);
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);
    });
  });

  describe("offline handling", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("holds auto-deploys while offline and catches up on reconnect", async () => {
      const h = makeHarness(async () => ok());
      h.queue.setOffline(true);
      h.queue.notifyChange("p1");
      h.queue.notifyChange("p1");
      h.queue.notifyChange("p2");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);

      h.queue.setOffline(false);
      await vi.advanceTimersByTimeAsync(1000);
      // One catch-up deploy per dirty project, not per change.
      expect(h.calls.length).toBe(2);
    });

    it("holds a change whose debounce window straddles going offline", async () => {
      const h = makeHarness(async () => ok());
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(50);
      h.queue.setOffline(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);
      h.queue.setOffline(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(1);
    });

    it("reports dirty-set changes for persistence, including the drain", async () => {
      const snapshots: string[][] = [];
      const h = makeHarness(async () => ok(), {
        held: new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) }),
      });
      h.queue.setOffline(true);
      h.queue.notifyChange("p1");
      h.queue.notifyChange("p1"); // duplicate — no extra emission
      h.queue.notifyChange("p2");
      h.queue.setOffline(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(snapshots).toEqual([["p1"], ["p1", "p2"], []]);
    });

    it("reconnect with nothing dirty deploys nothing", async () => {
      const h = makeHarness(async () => ok());
      h.queue.setOffline(true);
      h.queue.setOffline(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);
    });
  });

  describe("content-digest guard", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("skips auto-deploys the guard rejects, manual deploys bypass it", async () => {
      const h = makeHarness(async () => ok(), {
        shouldSkipAuto: async () => true,
      });
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(0);

      // Manual deploys never consult the guard.
      h.queue.enqueue("p1", "preview");
      await vi.advanceTimersByTimeAsync(100);
      expect(h.calls.length).toBe(1);
    });

    it("applies the guard to coalesced preview follow-ups", async () => {
      let skip = false;
      let release: (() => void) | null = null;
      const h = makeHarness(
        async () => {
          if (release === null) await new Promise<void>((r) => (release = r));
          return ok();
        },
        { shouldSkipAuto: async () => skip },
      );
      h.queue.enqueue("p1", "preview");
      await vi.advanceTimersByTimeAsync(50);
      // Change lands mid-deploy — but by completion it's already shipped.
      h.queue.enqueue("p1", "preview");
      skip = true;
      release!();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.calls.length).toBe(1);
    });

    it("a guard that throws never blocks deploys", async () => {
      const h = makeHarness(async () => ok(), {
        shouldSkipAuto: async () => {
          throw new Error("digest unavailable");
        },
      });
      h.queue.notifyChange("p1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.calls.length).toBe(1);
    });
  });

  it("walks the full happy-path state machine", async () => {
    const h = makeHarness(async (_req, onProgress) => {
      onProgress({ phase: "uploading" });
      onProgress({ phase: "building" });
      return ok();
    });
    h.queue.enqueue("p1", "preview");
    await flush();
    const states = h.transitions.map((t) => t.state);
    expect(states).toEqual(["queued", "preparing", "uploading", "building", "ready"]);
  });

  it("ignores out-of-order phase reports", async () => {
    const h = makeHarness(async (_req, onProgress) => {
      onProgress({ phase: "building" });
      onProgress({ phase: "uploading" }); // stale — must not go backwards
      return ok();
    });
    h.queue.enqueue("p1", "preview");
    await flush();
    const states = h.transitions.map((t) => t.state);
    // preparing → building is a legal direct jump; the stale "uploading"
    // report afterwards must not move the machine backwards.
    expect(states).toEqual(["queued", "preparing", "building", "ready"]);
  });

  it("reports failures with the actionable error", async () => {
    const h = makeHarness(async () => fail(false, "Build failed because package.json is missing."));
    h.queue.enqueue("p1", "preview");
    await flush();
    const last = h.transitions.at(-1)!;
    expect(last.state).toBe("failed");
    expect(last.info).toMatchObject({
      error: "Build failed because package.json is missing.",
    });
  });

  it("retries transient failures and succeeds", async () => {
    let attempts = 0;
    const h = makeHarness(async () => {
      attempts += 1;
      return attempts < 3 ? fail(true, "network") : ok();
    });
    h.queue.enqueue("p1", "preview");
    await new Promise((r) => setTimeout(r, 200));
    expect(attempts).toBe(3);
    expect(h.transitions.at(-1)!.state).toBe("ready");
  });

  it("does not retry permanent failures", async () => {
    let attempts = 0;
    const h = makeHarness(async () => {
      attempts += 1;
      return fail(false);
    });
    h.queue.enqueue("p1", "preview");
    await new Promise((r) => setTimeout(r, 100));
    expect(attempts).toBe(1);
    expect(h.transitions.at(-1)!.state).toBe("failed");
  });

  it("runs one deployment at a time per project and coalesces followups", async () => {
    let release: (() => void) | null = null;
    let started = 0;
    const h = makeHarness(async () => {
      started += 1;
      if (started === 1) {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    h.queue.enqueue("p1", "preview");
    await flush();
    // Three changes while the first deployment is still running…
    h.queue.enqueue("p1", "preview");
    h.queue.enqueue("p1", "preview");
    h.queue.enqueue("p1", "preview");
    expect(started).toBe(1);
    release!();
    await flush();
    // …result in exactly one follow-up.
    expect(started).toBe(2);
    expect(h.transitions.filter((t) => t.state === "ready").length).toBe(2);
  });

  it("production wins when coalescing mixed targets", async () => {
    let release: (() => void) | null = null;
    const h = makeHarness(async (req) => {
      if (req.target === "preview" && release === null) {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    h.queue.enqueue("p1", "preview");
    await flush();
    h.queue.enqueue("p1", "production");
    h.queue.enqueue("p1", "preview");
    release!();
    await flush();
    expect(h.calls.map((c) => c.target)).toEqual(["preview", "production"]);
  });

  it("cancels an in-flight deployment", async () => {
    const h = makeHarness(
      async () => new Promise<DeployOutcome>(() => {}), // never resolves
    );
    h.queue.enqueue("p1", "preview");
    await flush();
    expect(h.queue.isActive("p1")).toBe(true);
    h.queue.cancel("p1");
    await flush();
    expect(h.cancels.length).toBe(1);
    expect(h.transitions.at(-1)!.state).toBe("canceled");
    expect(h.queue.isActive("p1")).toBe(false);
  });

  it("treats a deployer-reported cancellation as canceled, not failed", async () => {
    const h = makeHarness(async () => ({
      ok: false,
      url: null,
      exitCode: null,
      canceled: true,
      error: null,
      retryable: false,
    }));
    h.queue.enqueue("p1", "preview");
    await flush();
    expect(h.transitions.at(-1)!.state).toBe("canceled");
  });

  it("removing a project cancels and forgets it", async () => {
    const h = makeHarness(async () => new Promise<DeployOutcome>(() => {}));
    h.queue.enqueue("p1", "preview");
    await flush();
    h.queue.remove("p1");
    await flush();
    expect(h.queue.isActive("p1")).toBe(false);
  });

  it("keeps projects independent", async () => {
    let release: (() => void) | null = null;
    const h = makeHarness(async (req) => {
      if (req.projectName === "blog" && req.deploymentId === "dep-1") {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    h.queue.enqueue("p1", "preview");
    await flush();
    h.queue.enqueue("p2", "preview");
    await flush();
    // p2 completed even though p1 is still running.
    expect(h.transitions.some((t) => t.projectId === "p2" && t.state === "ready")).toBe(true);
    release!();
    await flush();
    expect(h.transitions.some((t) => t.projectId === "p1" && t.state === "ready")).toBe(true);
  });
});
