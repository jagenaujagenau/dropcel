import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { DeployOutcome, DeployProgress, DeployRequest, Deployer } from "./deployer";
import { HeldChanges } from "./held-changes";
import { make, type DeployQueueShape, type QueueDeps } from "./queue";
import type { DeploymentState } from "./types";

/**
 * Integration tests for the deployment queue running against a scriptable
 * mock deployer — no Tauri, no CLI, no real filesystem. Ported to
 * `@effect/vitest` + `TestClock`: every assertion here preserves the intent
 * of the pre-rewrite fake-timer suite (see git history for the original).
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
  queue: DeployQueueShape;
  transitions: { projectId: string; state: DeploymentState; info?: unknown }[];
  calls: DeployRequest[];
  cancels: string[];
}

const makeHarness = (
  script: Script,
  overrides: Partial<QueueDeps> = {},
  autoDeploy = true,
): Effect.Effect<Harness, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const { deployer, calls, cancels } = makeMockDeployer(script);
    let seq = 0;
    const transitions: Harness["transitions"] = [];
    const queue = yield* make({
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
  });

/** Let forked fibers react to promise/microtask hand-offs before asserting. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

/** Advances virtual time in small increments, settling real microtasks
 * between each — reliable for cascading retries (each backoff step only
 * gets scheduled after the previous attempt's Promise resolves). */
const pump = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) {
    yield* TestClock.adjust("50 millis");
    yield* settle;
  }
});

describe("DeployQueue", () => {
  describe("debouncing", () => {
    it.effect("collapses a burst of changes into one deployment", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok());
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("500 millis");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }),
    );

    it.effect("does nothing while auto deploy is off", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok(), {}, false);
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }),
    );

    it.effect("does nothing while paused", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok());
        yield* h.queue.setPaused(true);
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }),
    );
  });

  describe("offline handling", () => {
    it.effect("holds auto-deploys while offline and catches up on reconnect", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok());
        yield* h.queue.setOffline(true);
        yield* h.queue.notifyChange("p1");
        yield* h.queue.notifyChange("p1");
        yield* h.queue.notifyChange("p2");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);

        yield* h.queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        // One catch-up deploy per dirty project, not per change.
        expect(h.calls.length).toBe(2);
      }),
    );

    it.effect("holds a change whose debounce window straddles going offline", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok());
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* h.queue.setOffline(true);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
        yield* h.queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }),
    );

    it.effect("reports dirty-set changes for persistence, including the drain", () =>
      Effect.gen(function* () {
        const snapshots: string[][] = [];
        const h = yield* makeHarness(async () => ok(), {
          held: new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) }),
        });
        yield* h.queue.setOffline(true);
        yield* h.queue.notifyChange("p1");
        yield* h.queue.notifyChange("p1"); // duplicate — no extra emission
        yield* h.queue.notifyChange("p2");
        yield* h.queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(snapshots).toEqual([["p1"], ["p1", "p2"], []]);
      }),
    );

    it.effect("reconnect with nothing dirty deploys nothing", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok());
        yield* h.queue.setOffline(true);
        yield* h.queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }),
    );
  });

  describe("content-digest guard", () => {
    it.effect("skips auto-deploys the guard rejects, manual deploys bypass it", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok(), {
          shouldSkipAuto: async () => true,
        });
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);

        // Manual deploys never consult the guard.
        yield* h.queue.enqueue("p1", "preview");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }),
    );

    it.effect("applies the guard to coalesced preview follow-ups", () =>
      Effect.gen(function* () {
        let skip = false;
        let release: (() => void) | null = null;
        const h = yield* makeHarness(
          async () => {
            if (release === null) await new Promise<void>((r) => (release = r));
            return ok();
          },
          { shouldSkipAuto: async () => skip },
        );
        yield* h.queue.enqueue("p1", "preview");
        yield* settle;
        // Change lands mid-deploy — but by completion it's already shipped.
        yield* h.queue.enqueue("p1", "preview");
        skip = true;
        release!();
        yield* settle;
        expect(h.calls.length).toBe(1);
      }),
    );

    it.effect("a guard that throws never blocks deploys", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(async () => ok(), {
          shouldSkipAuto: async () => {
            throw new Error("digest unavailable");
          },
        });
        yield* h.queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }),
    );
  });

  it.effect("walks the full happy-path state machine", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async (_req, onProgress) => {
        onProgress({ phase: "uploading" });
        onProgress({ phase: "building" });
        return ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      const states = h.transitions.map((t) => t.state);
      expect(states).toEqual(["queued", "preparing", "uploading", "building", "ready"]);
    }),
  );

  it.effect("ignores out-of-order phase reports", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async (_req, onProgress) => {
        onProgress({ phase: "building" });
        onProgress({ phase: "uploading" }); // stale — must not go backwards
        return ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      const states = h.transitions.map((t) => t.state);
      // preparing → building is a legal direct jump; the stale "uploading"
      // report afterwards must not move the machine backwards.
      expect(states).toEqual(["queued", "preparing", "building", "ready"]);
    }),
  );

  it.effect("reports failures with the actionable error", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async () =>
        fail(false, "Build failed because package.json is missing."),
      );
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      const last = h.transitions.at(-1)!;
      expect(last.state).toBe("failed");
      expect(last.info).toMatchObject({
        error: "Build failed because package.json is missing.",
      });
    }),
  );

  it.effect("retries transient failures and succeeds", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = yield* makeHarness(async () => {
        attempts += 1;
        return attempts < 3 ? fail(true, "network") : ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* pump;
      expect(attempts).toBe(3);
      expect(h.transitions.at(-1)!.state).toBe("ready");
    }),
  );

  it.effect("does not retry permanent failures", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const h = yield* makeHarness(async () => {
        attempts += 1;
        return fail(false);
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* pump;
      expect(attempts).toBe(1);
      expect(h.transitions.at(-1)!.state).toBe("failed");
    }),
  );

  it.effect("runs one deployment at a time per project and coalesces followups", () =>
    Effect.gen(function* () {
      let release: (() => void) | null = null;
      let started = 0;
      const h = yield* makeHarness(async () => {
        started += 1;
        if (started === 1) {
          await new Promise<void>((r) => (release = r));
        }
        return ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      // Three changes while the first deployment is still running…
      yield* h.queue.enqueue("p1", "preview");
      yield* h.queue.enqueue("p1", "preview");
      yield* h.queue.enqueue("p1", "preview");
      expect(started).toBe(1);
      release!();
      yield* settle;
      // …result in exactly one follow-up.
      expect(started).toBe(2);
      expect(h.transitions.filter((t) => t.state === "ready").length).toBe(2);
    }),
  );

  it.effect("production wins when coalescing mixed targets", () =>
    Effect.gen(function* () {
      let release: (() => void) | null = null;
      const h = yield* makeHarness(async (req) => {
        if (req.target === "preview" && release === null) {
          await new Promise<void>((r) => (release = r));
        }
        return ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      yield* h.queue.enqueue("p1", "production");
      yield* h.queue.enqueue("p1", "preview");
      release!();
      yield* settle;
      expect(h.calls.map((c) => c.target)).toEqual(["preview", "production"]);
    }),
  );

  it.effect("cancels an in-flight deployment", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(
        async () => new Promise<DeployOutcome>(() => {}), // never resolves
      );
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      expect(yield* h.queue.isActive("p1")).toBe(true);
      yield* h.queue.cancel("p1");
      yield* settle;
      expect(h.cancels.length).toBe(1);
      expect(h.transitions.at(-1)!.state).toBe("canceled");
      expect(yield* h.queue.isActive("p1")).toBe(false);
    }),
  );

  it.effect("treats a deployer-reported cancellation as canceled, not failed", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async () => ({
        ok: false,
        url: null,
        exitCode: null,
        canceled: true,
        error: null,
        retryable: false,
      }));
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      expect(h.transitions.at(-1)!.state).toBe("canceled");
    }),
  );

  it.effect("removing a project cancels and forgets it", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async () => new Promise<DeployOutcome>(() => {}));
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      yield* h.queue.remove("p1");
      yield* settle;
      expect(yield* h.queue.isActive("p1")).toBe(false);
    }),
  );

  it.effect("keeps projects independent", () =>
    Effect.gen(function* () {
      let release: (() => void) | null = null;
      const h = yield* makeHarness(async (req) => {
        if (req.projectName === "blog" && req.deploymentId === "dep-1") {
          await new Promise<void>((r) => (release = r));
        }
        return ok();
      });
      yield* h.queue.enqueue("p1", "preview");
      yield* settle;
      yield* h.queue.enqueue("p2", "preview");
      yield* settle;
      // p2 completed even though p1 is still running.
      expect(h.transitions.some((t) => t.projectId === "p2" && t.state === "ready")).toBe(true);
      release!();
      yield* settle;
      expect(h.transitions.some((t) => t.projectId === "p1" && t.state === "ready")).toBe(true);
    }),
  );

  it.effect("interruption reaches the deployer's handle.cancel", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(async () => new Promise<DeployOutcome>(() => {}));
      yield* h.queue.enqueue("p1", "production");
      yield* settle;
      expect(h.cancels.length).toBe(0);
      yield* h.queue.cancel("p1");
      yield* settle;
      expect(h.cancels).toEqual(["dep-1"]);
    }),
  );

  it.effect("slot teardown leaks no fibers when the owning scope closes", () =>
    Effect.gen(function* () {
      const { deployer, calls, cancels } = makeMockDeployer(
        async () => new Promise<DeployOutcome>(() => {}),
      );
      let seq = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* make({
            deployer,
            debounceMs: 100,
            pipeline: { maxRetries: 2, baseDelayMs: 1 },
            createDeployment: async () => `dep-${++seq}`,
            onTransition: () => {},
            getProject: (id) => ({ id, name: "blog", path: "/x/blog", autoDeploy: true }),
          });
          yield* queue.enqueue("p1", "preview");
          yield* settle;
          expect(calls.length).toBe(1);
          expect(cancels.length).toBe(0);
        }),
      );
      // The service's own scope just closed — every fiber it forked (the
      // active deploy included) must have been interrupted, reaching
      // handle.cancel exactly as an explicit cancel() would.
      yield* settle;
      expect(cancels.length).toBe(1);
    }),
  );
});
