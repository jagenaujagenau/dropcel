import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AccountSessionService, type AccountSessionShape, type AccountState } from "./account-session";
import { AppState, make as appStateMake, type AppStateShape } from "./app-state";
import { AutoDeployGate, layer as autoDeployGateLayer } from "./auto-deploy-gate";
import { make as heldChangesMake, HeldChangesService } from "./held-changes";
import { layerFrom, type RawIpc } from "./ipc";
import { DeployQueue, type DeployQueueShape } from "./queue";
import type { Project } from "./types";

/**
 * `AutoDeployGate` (CONTEXT.md's "Gate (git)") exercised through its real
 * `Layer.effect` against fakes for every Context dependency it declares —
 * `HeldChangesService`, `DeployQueue`, `AccountSessionService`, `AppState`,
 * `Ipc` — with `TestClock` driving the 15s git-operation re-check instead of
 * a real timer.
 */

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/root/${overrides.name}`,
    framework: "static",
    vercelProjectId: null,
    autoDeploy: true,
    createdAt: "",
    updatedAt: "",
    lockedBranch: null,
    remoteRepo: null,
    teamId: null,
    ...overrides,
  };
}

interface Harness {
  layer: Layer.Layer<AutoDeployGate | HeldChangesService | DeployQueue | AccountSessionService | AppState | import("./ipc").Ipc>;
  appState: AppStateShape;
  notifyChangeCalls: string[];
  setGitOperation: (op: string | null) => void;
  setPendingSwitch: (sw: { from: string; to: string } | null) => void;
}

function makeHarness(): Harness {
  const appState = Effect.runSync(appStateMake);
  const notifyChangeCalls: string[] = [];
  let gitOperation: string | null = "rebase";

  const fakeRaw = {
    db: {},
    fs: {},
    files: {},
    git: {
      info: (_project: string) =>
        Promise.resolve({
          isRepo: true,
          branch: "main",
          sha: "abc123",
          operation: gitOperation,
        }),
    },
    network: {},
    snapshots: {},
    credentials: {},
    tray: {},
  } as unknown as RawIpc;

  const heldChangesLayer = Layer.effect(
    HeldChangesService,
    heldChangesMake({}),
  );

  const deployQueueLayer = Layer.succeed(
    DeployQueue,
    {
      setPaused: () => Effect.void,
      setOffline: () => Effect.void,
      isOffline: () => Effect.succeed(false),
      notifyChange: (projectId: string) =>
        Effect.sync(() => {
          notifyChangeCalls.push(projectId);
        }),
      enqueue: () => Effect.void,
      cancel: () => Effect.void,
      remove: () => Effect.void,
      isActive: () => Effect.succeed(false),
    } satisfies DeployQueueShape,
  );

  const accountSessionLayer = Layer.effect(
    AccountSessionService,
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<AccountState>({
        username: null,
        avatarUrl: null,
        pendingSwitch: null,
        lastAuthError: null,
      });
      // Poll `pendingSwitch` into the ref on every read via a getter-shaped
      // SubscriptionRef isn't possible directly, so the test drives it with
      // `setPendingSwitch` below, which writes straight into this ref.
      const shape: AccountSessionShape = {
        state,
        getToken: Effect.succeed(null),
        acquireToken: Effect.die("not used in this test"),
        refreshIdentity: Effect.void,
        resolveSwitch: () => Effect.void,
      };
      accountStateRef = state;
      return AccountSessionService.of(shape);
    }),
  );
  let accountStateRef: SubscriptionRef.SubscriptionRef<AccountState> | null = null;

  // Shared deps also exposed directly in the harness's output type (not just
  // provided to `AutoDeployGate`) so tests can `yield* HeldChangesService`
  // themselves to assert on hold state.
  const sharedLayer = Layer.mergeAll(heldChangesLayer, deployQueueLayer, accountSessionLayer).pipe(
    Layer.provideMerge(Layer.succeed(AppState, appState)),
    Layer.provideMerge(layerFrom(fakeRaw)),
  );

  const layer = Layer.mergeAll(sharedLayer, autoDeployGateLayer.pipe(Layer.provide(sharedLayer)));

  return {
    layer,
    appState,
    notifyChangeCalls,
    setGitOperation: (op) => {
      gitOperation = op;
    },
    setPendingSwitch: (sw) => {
      if (accountStateRef) Effect.runSync(SubscriptionRef.update(accountStateRef, (s) => ({ ...s, pendingSwitch: sw })));
    },
  };
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("AutoDeployGate", () => {
  it.effect("bypasses the gate and deploys when there is no git hold", () => {
    const h = makeHarness();
    h.setGitOperation(null);
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const gate = yield* AutoDeployGate;
      yield* gate.notifyChangeGitGated("p1");
      expect(h.notifyChangeCalls).toEqual(["p1"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("holds while a git operation is mid-flight and does not deploy", () => {
    const h = makeHarness();
    h.setGitOperation("rebase");
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const gate = yield* AutoDeployGate;
      const held = yield* HeldChangesService;
      yield* gate.notifyChangeGitGated("p1");
      expect(h.notifyChangeCalls).toEqual([]);
      expect(yield* held.isHeld("p1")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("re-checks every 15s and deploys once the operation clears", () => {
    const h = makeHarness();
    h.setGitOperation("rebase");
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const gate = yield* AutoDeployGate;
      yield* gate.notifyChangeGitGated("p1");
      expect(h.notifyChangeCalls).toEqual([]);

      yield* TestClock.adjust("15 seconds");
      yield* settle;
      // Still mid-operation — held, no deploy yet.
      expect(h.notifyChangeCalls).toEqual([]);

      h.setGitOperation(null);
      yield* TestClock.adjust("15 seconds");
      yield* settle;
      expect(h.notifyChangeCalls).toEqual(["p1"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an unresolved account switch holds every project unconditionally", () => {
    const h = makeHarness();
    h.setGitOperation(null);
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      h.setPendingSwitch({ from: "old", to: "new" });
      const gate = yield* AutoDeployGate;
      const held = yield* HeldChangesService;
      yield* gate.notifyChangeGitGated("p1");
      expect(h.notifyChangeCalls).toEqual([]);
      expect(yield* held.isHeld("p1")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("an unknown project is a no-op", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const gate = yield* AutoDeployGate;
      yield* gate.notifyChangeGitGated("ghost");
      expect(h.notifyChangeCalls).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});
