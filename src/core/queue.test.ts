import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AppState, make as appStateMake } from "./app-state";
import type { DeployOutcome, DeployProgress, DeployRequest, Deployer } from "./deployer";
import { make as heldChangesMake, HeldChangesService } from "./held-changes";
import { layerFrom, type RawIpc } from "./ipc";
import { DeployQueue, layer as deployQueueLayer, type QueueDeps } from "./queue";
import type { DeploymentState, Project } from "./types";

/**
 * Integration tests for the deployment queue running against a scriptable
 * mock deployer — no Tauri, no CLI, no real filesystem. `DeployQueue` now
 * requires `HeldChangesService`, `AppState` and `Ipc` from `Context` (see
 * `queue.ts`'s retyped `QueueDeps`), so every test builds the queue's real
 * `Layer` and provides fakes for those three, rather than calling `make()`
 * with a plain-object `held`/`getProject`/`shouldSkipAuto` closure. Every
 * assertion's intent is unchanged from the pre-Task-3 suite.
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

function makeProject(id: string, autoDeploy: boolean): Project {
  return {
    id,
    name: "blog",
    path: "/x/blog",
    framework: "static",
    vercelProjectId: null,
    autoDeploy,
    createdAt: "",
    updatedAt: "",
    lockedBranch: null,
    remoteRepo: null,
    teamId: null,
  };
}

interface DigestState {
  /** `false`: never matches (never skip). `true`: always matches (always
   * skip). `"throw"`: the digest lookup itself fails — must never block a
   * deploy (see `queue.ts`'s `shouldSkipAuto`, which catches to `false`). */
  mode: boolean | "throw";
}

interface Harness {
  layer: Layer.Layer<DeployQueue>;
  transitions: { projectId: string; state: DeploymentState; info?: unknown }[];
  calls: DeployRequest[];
  cancels: string[];
  digest: DigestState;
}

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

const makeHarness = (
  script: Script,
  deps: Partial<Pick<QueueDeps, "debounceMs" | "pipeline">> = {},
  options: {
    autoDeploy?: boolean;
    projectIds?: string[];
    heldLayer?: Layer.Layer<HeldChangesService>;
  } = {},
): Harness => {
  const { deployer, calls, cancels } = makeMockDeployer(script);
  const transitions: Harness["transitions"] = [];
  const digest: DigestState = { mode: false };
  const projectIds = options.projectIds ?? ["p1", "p2"];
  const autoDeploy = options.autoDeploy ?? true;

  let seq = 0;
  const fakeRaw = {
    db: {
      insertDeployment: (projectId: string) =>
        Promise.resolve({
          id: `dep-${++seq}`,
          projectId,
          state: "queued",
          target: "production",
          url: null,
          error: null,
          exitCode: null,
          startedAt: "",
          finishedAt: null,
          durationMs: null,
          publicUrl: null,
          branch: null,
          commitSha: null,
          vercelDeploymentId: null,
          inspectorUrl: null,
        }),
      getSetting: (_key: string) => {
        if (digest.mode === "throw") return Promise.reject(new Error("digest unavailable"));
        return Promise.resolve(digest.mode ? "cur" : null);
      },
    },
    fs: {},
    files: {
      contentDigest: (_project: string) => {
        if (digest.mode === "throw") return Promise.reject(new Error("digest unavailable"));
        return Promise.resolve("cur");
      },
    },
    git: { info: (_project: string) => Promise.resolve(null) },
    network: {},
    snapshots: {},
    credentials: {},
    tray: {},
  } as unknown as RawIpc;

  const appState = Effect.runSync(appStateMake);
  Effect.runSync(
    SubscriptionRef.set(
      appState.projects,
      projectIds.map((id) => makeProject(id, autoDeploy)),
    ),
  );

  const heldLayer = options.heldLayer ?? Layer.effect(HeldChangesService, heldChangesMake({}));

  const queueDeps: QueueDeps = {
    deployer,
    // Mirrors what `ReadyEffects.onTransition` really does in production
    // (persist the transition onto `AppState.latestByProject`) — the
    // content-digest guard reads `latestByProject` to decide whether a
    // deploy is still in flight, so a fake that only recorded `transitions`
    // without updating `AppState` would silently change the guard's
    // behavior versus the real app.
    onTransition: (projectId, deploymentId, state, info) =>
      Effect.gen(function* () {
        transitions.push({ projectId, state, info });
        yield* SubscriptionRef.update(appState.latestByProject, (m) => {
          const cur = m[projectId];
          if (!cur || cur.id !== deploymentId) return m;
          return { ...m, [projectId]: { ...cur, state, url: info?.url ?? cur.url } };
        });
      }),
    ...deps,
  };

  const layer = deployQueueLayer(queueDeps).pipe(
    Layer.provide(layerFrom(fakeRaw)),
    Layer.provide(Layer.succeed(AppState, appState)),
    Layer.provide(heldLayer),
  );

  return { layer, transitions, calls, cancels, digest };
};

describe("DeployQueue", () => {
  describe("debouncing", () => {
    it.effect("collapses a burst of changes into one deployment", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("500 millis");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("does nothing while auto deploy is off", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 }, { autoDeploy: false });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("does nothing while paused", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.setPaused(true);
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  });

  describe("offline handling", () => {
    it.effect("holds auto-deploys while offline and catches up on reconnect", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.setOffline(true);
        yield* queue.notifyChange("p1");
        yield* queue.notifyChange("p1");
        yield* queue.notifyChange("p2");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);

        yield* queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        // One catch-up deploy per dirty project, not per change.
        expect(h.calls.length).toBe(2);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("holds a change whose debounce window straddles going offline", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("50 millis");
        yield* queue.setOffline(true);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
        yield* queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("reports dirty-set changes for persistence, including the drain", () => {
      const snapshots: string[][] = [];
      const heldLayer = Layer.effect(
        HeldChangesService,
        heldChangesMake({ persistOffline: (ids) => Effect.sync(() => snapshots.push(ids)) }),
      );
      const h = makeHarness(async () => ok(), { debounceMs: 100 }, { heldLayer });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.setOffline(true);
        yield* queue.notifyChange("p1");
        yield* queue.notifyChange("p1"); // duplicate — no extra emission
        yield* queue.notifyChange("p2");
        yield* queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(snapshots).toEqual([["p1"], ["p1", "p2"], []]);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("reconnect with nothing dirty deploys nothing", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.setOffline(true);
        yield* queue.setOffline(false);
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);
      }).pipe(Effect.provide(h.layer));
    });
  });

  describe("content-digest guard", () => {
    it.effect("skips auto-deploys the guard rejects, manual deploys bypass it", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      h.digest.mode = true;
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(0);

        // Manual deploys never consult the guard.
        yield* queue.enqueue("p1", "preview");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("applies the guard to coalesced preview follow-ups", () => {
      let release: (() => void) | null = null;
      const h = makeHarness(async () => {
        if (release === null) await new Promise<void>((r) => (release = r));
        return ok();
      });
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.enqueue("p1", "preview");
        yield* settle;
        // Change lands mid-deploy — but by completion it's already shipped.
        yield* queue.enqueue("p1", "preview");
        h.digest.mode = true;
        release!();
        yield* settle;
        expect(h.calls.length).toBe(1);
      }).pipe(Effect.provide(h.layer));
    });

    it.effect("a guard that throws never blocks deploys", () => {
      const h = makeHarness(async () => ok(), { debounceMs: 100 });
      h.digest.mode = "throw";
      return Effect.gen(function* () {
        const queue = yield* DeployQueue;
        yield* queue.notifyChange("p1");
        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(h.calls.length).toBe(1);
      }).pipe(Effect.provide(h.layer));
    });
  });

  it.effect("walks the full happy-path state machine", () => {
    const h = makeHarness(async (_req, onProgress) => {
      onProgress({ phase: "uploading" });
      onProgress({ phase: "building" });
      return ok();
    });
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      const states = h.transitions.map((t) => t.state);
      expect(states).toEqual(["queued", "preparing", "uploading", "building", "ready"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("ignores out-of-order phase reports", () => {
    const h = makeHarness(async (_req, onProgress) => {
      onProgress({ phase: "building" });
      onProgress({ phase: "uploading" }); // stale — must not go backwards
      return ok();
    });
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      const states = h.transitions.map((t) => t.state);
      // preparing → building is a legal direct jump; the stale "uploading"
      // report afterwards must not move the machine backwards.
      expect(states).toEqual(["queued", "preparing", "building", "ready"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reports failures with the actionable error", () => {
    const h = makeHarness(async () => fail(false, "Build failed because package.json is missing."));
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      const last = h.transitions.at(-1)!;
      expect(last.state).toBe("failed");
      expect(last.info).toMatchObject({
        error: "Build failed because package.json is missing.",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("retries transient failures and succeeds", () => {
    let attempts = 0;
    const h = makeHarness(
      async () => {
        attempts += 1;
        return attempts < 3 ? fail(true, "network") : ok();
      },
      { pipeline: { maxRetries: 2, baseDelayMs: 1 } },
    );
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* pump;
      expect(attempts).toBe(3);
      expect(h.transitions.at(-1)!.state).toBe("ready");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does not retry permanent failures", () => {
    let attempts = 0;
    const h = makeHarness(
      async () => {
        attempts += 1;
        return fail(false);
      },
      { pipeline: { maxRetries: 2, baseDelayMs: 1 } },
    );
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* pump;
      expect(attempts).toBe(1);
      expect(h.transitions.at(-1)!.state).toBe("failed");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("runs one deployment at a time per project and coalesces followups", () => {
    let release: (() => void) | null = null;
    let started = 0;
    const h = makeHarness(async () => {
      started += 1;
      if (started === 1) {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      // Three changes while the first deployment is still running…
      yield* queue.enqueue("p1", "preview");
      yield* queue.enqueue("p1", "preview");
      yield* queue.enqueue("p1", "preview");
      expect(started).toBe(1);
      release!();
      yield* settle;
      // …result in exactly one follow-up.
      expect(started).toBe(2);
      expect(h.transitions.filter((t) => t.state === "ready").length).toBe(2);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("production wins when coalescing mixed targets", () => {
    let release: (() => void) | null = null;
    const h = makeHarness(async (req) => {
      if (req.target === "preview" && release === null) {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      yield* queue.enqueue("p1", "production");
      yield* queue.enqueue("p1", "preview");
      release!();
      yield* settle;
      expect(h.calls.map((c) => c.target)).toEqual(["preview", "production"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("cancels an in-flight deployment", () => {
    const h = makeHarness(async () => new Promise<DeployOutcome>(() => {}));
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      expect(yield* queue.isActive("p1")).toBe(true);
      yield* queue.cancel("p1");
      yield* settle;
      expect(h.cancels.length).toBe(1);
      expect(h.transitions.at(-1)!.state).toBe("canceled");
      expect(yield* queue.isActive("p1")).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("treats a deployer-reported cancellation as canceled, not failed", () => {
    const h = makeHarness(async () => ({
      ok: false,
      url: null,
      exitCode: null,
      canceled: true,
      error: null,
      retryable: false,
    }));
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      expect(h.transitions.at(-1)!.state).toBe("canceled");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("removing a project cancels and forgets it", () => {
    const h = makeHarness(async () => new Promise<DeployOutcome>(() => {}));
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      yield* queue.remove("p1");
      yield* settle;
      expect(yield* queue.isActive("p1")).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("keeps projects independent", () => {
    let release: (() => void) | null = null;
    const h = makeHarness(async (req) => {
      if (req.projectName === "blog" && req.deploymentId === "dep-1") {
        await new Promise<void>((r) => (release = r));
      }
      return ok();
    });
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      yield* queue.enqueue("p2", "preview");
      yield* settle;
      // p2 completed even though p1 is still running.
      expect(h.transitions.some((t) => t.projectId === "p2" && t.state === "ready")).toBe(true);
      release!();
      yield* settle;
      expect(h.transitions.some((t) => t.projectId === "p1" && t.state === "ready")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("interruption reaches the deployer's handle.cancel", () => {
    const h = makeHarness(async () => new Promise<DeployOutcome>(() => {}));
    return Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "production");
      yield* settle;
      expect(h.cancels.length).toBe(0);
      yield* queue.cancel("p1");
      yield* settle;
      expect(h.cancels).toEqual(["dep-1"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("slot teardown leaks no fibers when the owning scope closes", () => {
    const h = makeHarness(async () => new Promise<DeployOutcome>(() => {}));
    const inner = Effect.gen(function* () {
      const queue = yield* DeployQueue;
      yield* queue.enqueue("p1", "preview");
      yield* settle;
      expect(h.calls.length).toBe(1);
      expect(h.cancels.length).toBe(0);
    }).pipe(Effect.provide(h.layer));

    return Effect.gen(function* () {
      // The layer's own scope closes when `inner` finishes — every fiber it
      // forked (the active deploy included) must have been interrupted,
      // reaching `handle.cancel` exactly as an explicit `cancel()` would.
      yield* inner;
      yield* settle;
      expect(h.cancels.length).toBe(1);
    });
  });
});
