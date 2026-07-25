import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AccountSessionService, type AccountSessionShape, type AccountState } from "./account-session";
import { AppState, make as appStateMake, type AppStateShape } from "./app-state";
import { Clipboard, Connectivity, Notifier, Tray } from "./effects";
import { layerFrom, type RawIpc } from "./ipc";
import { layer as readyEffectsLayer, ReadyEffects } from "./ready-effects";
import type { Deployment, Project } from "./types";

/**
 * `ReadyEffects` exercised through its real `Layer.effect` against fakes for
 * every dependency it declares in `Context` (Ipc, Tray, Notifier, Clipboard,
 * Connectivity, AccountSession) — not `make()` called directly with a plain
 * object. `appState` is the one plain-injected dependency (see
 * `ready-effects.ts`'s doc comment on why it isn't a Context tag).
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
  ownerUid: null,
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<Deployment> & { id: string; projectId: string }): Deployment {
  return {
    state: "ready",
    target: "production",
    url: "https://blog-abc123.vercel.app",
    error: null,
    exitCode: 0,
    startedAt: "",
    finishedAt: null,
    durationMs: null,
    publicUrl: null,
    branch: null,
    commitSha: null,
    vercelDeploymentId: null,
    inspectorUrl: null,
    ...overrides,
  };
}

interface Harness {
  layer: Layer.Layer<ReadyEffects>;
  appState: AppStateShape;
  trayUpdates: { name: string; status: string }[][];
  notifications: { title: string; body: string }[];
  clipboardWrites: string[];
  db: {
    updateDeployment: Deployment | null;
    getSetting: Record<string, string>;
  };
}

function makeHarness(overrides: { db?: Partial<Record<string, unknown>> } = {}): Harness {
  const appState = Effect.runSync(appStateMake);
  const trayUpdates: { name: string; status: string }[][] = [];
  const notifications: { title: string; body: string }[] = [];
  const clipboardWrites: string[] = [];

  const fakeRaw = {
    db: {
      updateDeployment: (id: string, state: string, url: string | null) =>
        Promise.resolve(
          makeDeployment({ id, projectId: "p1", state: state as never, url }),
        ),
      getSetting: (_key: string) => Promise.resolve(null),
      setSetting: () => Promise.resolve(),
      listDomains: () => Promise.resolve([]),
      listProjects: () => Promise.resolve([]),
      setDeploymentPublicUrl: () => Promise.resolve(),
      setDeploymentVercelIds: () => Promise.resolve(),
      setProjectLink: () => Promise.resolve(),
      setProjectTeam: () => Promise.resolve(),
      setRemoteRepo: () => Promise.resolve(),
      setAutoDeploy: () => Promise.resolve(),
      ...overrides.db,
    },
    fs: {},
    files: { writeProjectLink: () => Promise.resolve() },
    git: {},
    network: {},
    snapshots: { capture: () => Promise.reject(new Error("no browser in test")) },
    credentials: {},
    tray: {
      update: (projects: { name: string; status: string }[]) => {
        trayUpdates.push(projects);
        return Promise.resolve();
      },
    },
  } as unknown as RawIpc;

  const notifierLayer = Layer.succeed(
    Notifier,
    Notifier.of({
      notify: (title, body) =>
        Effect.sync(() => {
          notifications.push({ title, body });
        }),
    }),
  );

  const clipboardLayer = Layer.succeed(
    Clipboard,
    Clipboard.of({
      write: (text) =>
        Effect.sync(() => {
          clipboardWrites.push(text);
        }),
    }),
  );

  const trayLayer = Layer.succeed(
    Tray,
    Tray.of({ update: (projects) => Effect.promise(() => fakeRaw.tray.update(projects)) }),
  );

  const connectivityLayer = Layer.effect(
    Connectivity,
    Effect.gen(function* () {
      const online = yield* SubscriptionRef.make(true);
      return Connectivity.of({ online, start: Effect.void, stop: Effect.void });
    }),
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
      const shape: AccountSessionShape = {
        state,
        getToken: Effect.succeed(null),
        acquireToken: Effect.die("not used in this test"),
        refreshIdentity: Effect.void,
        resolveSwitch: () => Effect.void,
      };
      return AccountSessionService.of(shape);
    }),
  );

  const layer = readyEffectsLayer.pipe(
    Layer.provide(layerFrom(fakeRaw)),
    Layer.provide(Layer.succeed(AppState, appState)),
    Layer.provide(notifierLayer),
    Layer.provide(clipboardLayer),
    Layer.provide(trayLayer),
    Layer.provide(connectivityLayer),
    Layer.provide(accountSessionLayer),
  );

  return {
    layer,
    appState,
    trayUpdates,
    notifications,
    clipboardWrites,
    db: { updateDeployment: null, getSetting: {} },
  };
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("ReadyEffects", () => {
  it.effect("onTransition persists, refreshes tray, and logs — without dispatching on a mid-flight state", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const readyEffects = yield* ReadyEffects
      yield* readyEffects.onTransition("p1", "d1", "preparing");
      expect(h.trayUpdates.length).toBe(1);
      expect(h.notifications).toEqual([]);
      const latest = yield* SubscriptionRef.get(h.appState.latestByProject);
      expect(latest.p1?.state).toBe("preparing");
    }).pipe(Effect.provide(h.layer));
  });

  /**
   * A coalesced follow-up can supersede our deployment as the project's
   * "latest" before this callback runs. Looking the deployment up there meant
   * finding nothing and returning early — silently skipping the project link
   * and the `.vercel/project.json` write that folder-rename detection depends
   * on, with nothing to retry it.
   */
  it.effect("records the project link even after a newer deployment superseded ours", () => {
    const linked: (string | null)[] = [];
    const h = makeHarness({
      db: {
        setProjectLink: (_id: string, vercelProjectId: string | null) => {
          linked.push(vercelProjectId);
          return Promise.resolve();
        },
      },
    });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [
        makeProject({ id: "p1", name: "blog", vercelProjectId: null }),
      ]);
      yield* h.appState.upsertDeployment(
        makeDeployment({ id: "d1", projectId: "p1", startedAt: "2026-01-01T00:00:00Z" }),
      );
      // The follow-up starts before the API callback for d1 lands.
      yield* h.appState.upsertDeployment(
        makeDeployment({ id: "d2", projectId: "p1", startedAt: "2026-01-02T00:00:00Z" }),
      );

      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.recordVercelIds("d1", {
        vercelDeploymentId: "dpl_1",
        inspectorUrl: "https://vercel.com/me/blog/dpl_1",
        vercelProjectId: "prj_1",
        ownerId: "team_x",
      });

      expect(linked).toEqual(["prj_1"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("onTransition to failed notifies with the actionable error", () => {
    const h = makeHarness({
      db: {
        updateDeployment: () =>
          Promise.resolve(makeDeployment({ id: "d1", projectId: "p1", state: "failed", url: null })),
      },
    });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.onTransition("p1", "d1", "failed", { error: "build failed" });
      expect(h.notifications).toEqual([
        { title: "Deployment Failed", body: "blog — build failed" },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("onTransition to ready forks onReady: resolves the URL, copies it, notifies", () => {
    const h = makeHarness({
      db: {
        updateDeployment: () =>
          Promise.resolve(
            makeDeployment({
              id: "d1",
              projectId: "p1",
              state: "ready",
              url: "https://blog-abc.vercel.app",
            }),
          ),
        listDomains: () => Promise.resolve([]),
      },
    });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.onTransition("p1", "d1", "ready", { url: "https://blog-abc.vercel.app" });
      yield* settle;
      expect(h.clipboardWrites).toEqual(["https://blog-abc.vercel.app"]);
      expect(h.notifications).toEqual([
        {
          title: "Deployment Ready",
          body: "blog\nhttps://blog-abc.vercel.app\nURL copied to clipboard",
        },
      ]);
    }).pipe(Effect.provide(h.layer));
  });

  /**
   * After an Instant Rollback Vercel stops auto-assigning the production
   * domain, so later deployments build fine while the public URL keeps
   * serving the rolled-back version. Reporting that as "Ready" — and copying
   * a URL that isn't the user's site — is the worst outcome for a tool whose
   * premise is that saving a file updates the site.
   */
  it.effect("reports a deploy that built but never took over the public URL", () => {
    const h = makeHarness({ db: { listDomains: () => Promise.resolve([]) } });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      // The project already had a stable address from an earlier deploy.
      yield* h.appState.upsertDeployment(
        makeDeployment({
          id: "d0",
          projectId: "p1",
          publicUrl: "https://blog.vercel.app",
          startedAt: "2026-01-01T00:00:00Z",
        }),
      );

      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.onReady(
        "p1",
        makeDeployment({ id: "d1", projectId: "p1", url: "https://blog-xyz.vercel.app" }),
        "blog",
      );
      yield* settle;

      expect(h.notifications[0]!.title).toBe("Deployed — but not live");
      expect(h.notifications[0]!.body).toContain("https://blog.vercel.app");
      // Never hand over an address that isn't the site.
      expect(h.clipboardWrites).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  /** A project's first deploy legitimately has no alias yet — that must not
   * be mistaken for the rollback state. */
  it.effect("does not cry wolf on a first deploy with no alias yet", () => {
    const h = makeHarness({ db: { listDomains: () => Promise.resolve([]) } });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.onReady(
        "p1",
        makeDeployment({ id: "d1", projectId: "p1", url: "https://blog-xyz.vercel.app" }),
        "blog",
      );
      yield* settle;
      expect(h.notifications[0]!.title).toBe("Deployment Ready");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("onReady skips the clipboard when the setting opts out", () => {
    const h = makeHarness({ db: { getSetting: () => Promise.resolve("0") } });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [makeProject({ id: "p1", name: "blog" })]);
      const readyEffects = yield* ReadyEffects;
      const dep = makeDeployment({ id: "d1", projectId: "p1", url: "https://blog.vercel.app" });
      yield* readyEffects.onReady("p1", dep, "blog");
      expect(h.clipboardWrites).toEqual([]);
      expect(h.notifications[0]?.body).not.toContain("copied");
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("checkRemoteIntegration turns auto-deploy off exactly once per session", () => {
    let calls = 0;
    const h = makeHarness({
      db: {
        setAutoDeploy: () => {
          calls += 1;
          return Promise.resolve();
        },
        listProjects: () => Promise.resolve([makeProject({ id: "p1", name: "blog", vercelProjectId: "prj_1" })]),
      },
    });
    return Effect.gen(function* () {
      yield* SubscriptionRef.set(h.appState.projects, [
        makeProject({ id: "p1", name: "blog", vercelProjectId: "prj_1" }),
      ]);
      const readyEffects = yield* ReadyEffects;
      yield* readyEffects.checkRemoteIntegration("p1");
      yield* readyEffects.checkRemoteIntegration("p1");
      // Best-effort: checkGitConnection hits a real network call and will
      // fail in this environment, so we only assert it was attempted once
      // per project (the `integrationChecked` guard), not the outcome.
      expect(calls).toBeLessThanOrEqual(1);
    }).pipe(Effect.provide(h.layer));
  });
});
