import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ipc from "../lib/ipc";
import { describeError, log } from "../lib/log";
import {
  make as accountSessionMake,
  realDeps as accountSessionRealDeps,
  setActiveSession,
  AccountSessionService,
  type AccountSession,
  type AccountSessionHooks,
  type AccountSwitch,
} from "./account-session";
import { createApiDeployer } from "./api-deployer";
import { AppState, appStateShape } from "./app-state";
import { AutoDeployGate, layer as autoDeployGateLayer } from "./auto-deploy-gate";
import {
  layerConnectivity,
  layerNotifier,
  Clipboard,
  ClipboardWriteError,
  Connectivity,
  Notifier,
  Tray,
  type ClipboardShape,
  type TrayShape,
} from "./effects";
import { refreshGitInfo, type GitStatus } from "./git";
import { make as heldChangesMake, HeldChangesService } from "./held-changes";
import { make as ipcMake, Ipc } from "./ipc";
import { DeployQueue, layer as deployQueueLayer, type QueueDeps } from "./queue";
import { layer as readyEffectsLayer, ReadyEffects, type RecordVercelIdsInfo } from "./ready-effects";
import { make as reconcilerMake, ReconcilerService, type ReconcilerHooks } from "./reconciler";
import type { DeployTarget } from "./types";
import { layer as watchStreamLayer, WatchStream } from "./watch-stream";

/**
 * The composition root: builds every service into one Layer graph
 * (`AppLive`) driven by one `ManagedRuntime`, and wires the callbacks between
 * them. There is no class and no mutable "spine" object; state lives in each
 * service's own `SubscriptionRef` (plus `AppState` for the UI projections
 * none of them owns individually), and the wiring below is plain functions
 * closing over the constructed shapes.
 *
 * Most services here have zero async/scoped construction (they only build
 * `Ref`/`SubscriptionRef`/`Semaphore` state) and so are built synchronously,
 * once. The services that genuinely own a long-lived fiber or need another
 * service from `Context` (`Connectivity`, `DeployQueue`, `WatchStream`,
 * `ReadyEffects`, `AutoDeployGate`) stay real `Layer.effect` members of
 * `AppLive`, resolved against each other explicitly below rather than
 * relying on `Layer.mergeAll` to auto-wire siblings (it doesn't — each
 * dependent layer is `Layer.provide`d exactly the base layer it needs, the
 * same way the original `Ipc` requirement was satisfied).
 */

// ---- synchronous singletons (no async/scoped construction) -----------------

const ipcShape = ipcMake(ipc);

const heldChangesShape = Effect.runSync(
  heldChangesMake({
    persistOffline: (projectIds) =>
      Effect.sync(() => {
        void ipc.db.setSetting("dirty_projects", JSON.stringify(projectIds)).catch(() => {});
      }),
  }),
);

// -- account switch bookkeeping (mirrors AccountSessionService.state.pendingSwitch
// for account-session.ts's own resolveSwitch/detectSwitch, which need a
// synchronous get/clear at hook-construction time — unrelated to the git
// gate below, which reads `AccountSessionService.state` directly) --
let pendingSwitchMirror: AccountSwitch | null = null;

const accountSessionHooks: AccountSessionHooks = {
  setAuthedAs: () => {}, // AccountSessionService.state is the single source of truth now
  notify: (title, body) => notify(title, body),
  onSwitchDetected: (sw) => {
    pendingSwitchMirror = sw;
  },
  getAccountSwitch: () => pendingSwitchMirror,
  clearAccountSwitch: () => {
    pendingSwitchMirror = null;
  },
  getProjects: () =>
    Effect.runSync(SubscriptionRef.get(appStateShape.projects)).map((p) => ({
      id: p.id,
      name: p.name,
    })),
  onFreshStart: () => {
    managedRuntime.runFork(Effect.andThen(ReadyEffects, (r) => r.resetIntegrationChecks()));
  },
  reloadProjects: async () => {
    const projects = await ipc.db.listProjects();
    Effect.runSync(SubscriptionRef.set(appStateShape.projects, projects));
  },
  onSwitchResolved: () => {
    managedRuntime.runFork(
      Effect.gen(function* () {
        const held = yield* HeldChangesService;
        const gate = yield* AutoDeployGate;
        const freed = yield* held.release("account-switch");
        for (const id of freed) yield* gate.notifyChangeGitGated(id);
      }),
    );
  },
};

const accountSessionShape = Effect.runSync(
  accountSessionMake(accountSessionRealDeps(ipcShape, accountSessionHooks)),
);

const accountSessionBridge: AccountSession = {
  getToken: () => Effect.runPromise(accountSessionShape.getToken),
  refreshIdentity: () => Effect.runPromise(accountSessionShape.refreshIdentity),
  resolveSwitch: (mode) => Effect.runPromise(accountSessionShape.resolveSwitch(mode)),
};
setActiveSession(accountSessionBridge);

const clipboardShape: ClipboardShape = {
  write: (text) =>
    Effect.tryPromise({
      try: () => writeText(text),
      catch: (cause) => new ClipboardWriteError({ cause }),
    }),
};

const trayShape: TrayShape = {
  update: (projects) => ipcShape.tray.update(projects).pipe(Effect.ignore),
};

const reconcilerHooks: ReconcilerHooks = {
  setProjects: (projects) => Effect.runSync(SubscriptionRef.set(appStateShape.projects, projects)),
  setPresentOnDisk: (names) =>
    Effect.runSync(SubscriptionRef.set(appStateShape.presentOnDisk, new Set(names))),
  getProjects: () => Effect.runSync(SubscriptionRef.get(appStateShape.projects)),
  isWatchPaused: () => Effect.runSync(SubscriptionRef.get(appStateShape.watchPaused)),
  onProjectNeedsDeploy: (projectId) => notifyChangeGitGated(projectId),
  onProjectPresent: (projectId) => {
    void refreshGit(projectId);
    managedRuntime.runFork(Effect.andThen(ReadyEffects, (r) => r.checkRemoteIntegration(projectId)));
  },
  onProjectGone: (projectId) => managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.remove(projectId))),
  onReconciled: () => refreshTray(),
};

const reconcilerShape = Effect.runSync(
  Effect.provideService(reconcilerMake(reconcilerHooks), Ipc, ipcShape),
);

// ---- queue deps -------------------------------------------------------

const queueDeps: QueueDeps = {
  deployer: createApiDeployer({
    getToken: () => Effect.runPromise(accountSessionShape.getToken),
    getProjectMeta: async (projectName: string) => {
      const p = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
        (x) => x.name === projectName,
      );
      return p
        ? { framework: p.framework, teamId: p.teamId, vercelProjectId: p.vercelProjectId }
        : null;
    },
    collectFiles: ipc.files.collectDeployFiles,
    readFile: async (project: string, path: string) =>
      base64ToBytes(await ipc.files.readFileB64(project, path)),
    onLog: (deploymentId: string, stream: "stdout" | "stderr", line: string) => {
      void ipc.db.appendLog(deploymentId, stream, line).catch(() => {});
    },
    onCreated: (ourDeploymentId: string, info: RecordVercelIdsInfo) => {
      managedRuntime.runFork(Effect.andThen(ReadyEffects, (r) => r.recordVercelIds(ourDeploymentId, info)));
    },
  }),
  debounceMs: 2_000,
  // `ReadyEffects` lives behind `Context` (it needs `Notifier`/`Connectivity`,
  // which only resolve through `managedRuntime`'s async construction), so
  // this stays an injected Effect-returning closure rather than a Context
  // requirement of the queue itself (see `queue.ts`'s `QueueDeps.onTransition`
  // doc comment).
  onTransition: (projectId, deploymentId, state, info) =>
    Effect.sync(() => {
      managedRuntime.runFork(Effect.andThen(ReadyEffects, (r) => r.onTransition(projectId, deploymentId, state, info)));
    }),
};

// ---- the Layer graph ---------------------------------------------------

const ipcLayerSucceed = Layer.succeed(Ipc, ipcShape);

/** Every service with zero cross-service `Context` requirements once `Ipc`
 * is supplied — the same shape `AppLive` was before this pass, minus the
 * three services below that now genuinely depend on siblings here. */
const baseServicesLayer: Layer.Layer<
  Ipc | AppState | Clipboard | Tray | Notifier | Connectivity | HeldChangesService | AccountSessionService | ReconcilerService
> = Layer.mergeAll(
  Layer.succeed(AppState, appStateShape),
  Layer.succeed(Clipboard, clipboardShape),
  Layer.succeed(Tray, trayShape),
  Layer.succeed(HeldChangesService, heldChangesShape),
  Layer.succeed(AccountSessionService, accountSessionShape),
  Layer.succeed(ReconcilerService, reconcilerShape),
  layerNotifier,
  layerConnectivity({
    onChange: (online) => {
      managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.setOffline(!online)));
      if (online) void refreshAuth();
    },
  }),
).pipe(Layer.provideMerge(ipcLayerSucceed));

/** Needs `HeldChangesService | AppState | Ipc` — all in `baseServicesLayer`. */
const deployQueueLayerResolved: Layer.Layer<DeployQueue> = deployQueueLayer(queueDeps).pipe(
  Layer.provide(baseServicesLayer),
);

/** Needs `Ipc | AppState | Tray | Notifier | Clipboard | Connectivity |
 * AccountSessionService` — all in `baseServicesLayer`. */
const readyEffectsLayerResolved: Layer.Layer<ReadyEffects> = readyEffectsLayer.pipe(
  Layer.provide(baseServicesLayer),
);

/** Needs everything `baseServicesLayer` has, plus `DeployQueue`. */
const autoDeployGateLayerResolved: Layer.Layer<AutoDeployGate> = autoDeployGateLayer.pipe(
  Layer.provide(Layer.mergeAll(baseServicesLayer, deployQueueLayerResolved)),
);

export const AppLive: Layer.Layer<
  | Ipc
  | AppState
  | Clipboard
  | Tray
  | Notifier
  | Connectivity
  | HeldChangesService
  | AccountSessionService
  | ReconcilerService
  | DeployQueue
  | ReadyEffects
  | AutoDeployGate
  | WatchStream
> = Layer.mergeAll(
  baseServicesLayer,
  deployQueueLayerResolved,
  readyEffectsLayerResolved,
  autoDeployGateLayerResolved,
  watchStreamLayer({
    // The reconciler's own `Reconciler` class instance is already
    // constructed (`reconcilerShape` closes over it); errors are swallowed
    // exactly as the old Promise bridge did (a rejected promise there
    // would have defected the fiber, never surfaced as a typed failure).
    onChanges: (changes) => Effect.orDie(reconcilerShape.handleFsChanges(changes)),
  }),
);

/** One `ManagedRuntime` for the whole app: `main`, native event bridges, and
 * every hook closure above that needs `Connectivity` / `DeployQueue` /
 * `WatchStream` / `Notifier` / `ReadyEffects` / `AutoDeployGate` from context
 * runs through this. Shares its `memoMap` with the atom runtime (see
 * `atoms.ts`) so the graph is built exactly once regardless of which "front
 * door" (React or a Tauri event listener) touches it first. */
export const managedRuntime = ManagedRuntime.make(AppLive);

// ---- business logic -----------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function notify(title: string, body: string): void {
  managedRuntime.runFork(Effect.andThen(Notifier, (n) => n.notify(title, body)));
}

function refreshTray(): Promise<void> {
  return managedRuntime.runPromise(Effect.andThen(ReadyEffects, (r) => r.refreshTray()));
}

/** Auto-deploy gate entry point — see `AutoDeployGate` (CONTEXT.md's
 * "Gate (git)"). Fire-and-forget, matching every call site's prior
 * `void notifyChangeGitGated(...)` usage. */
function notifyChangeGitGated(projectId: string): void {
  managedRuntime.runFork(Effect.andThen(AutoDeployGate, (g) => g.notifyChangeGitGated(projectId)));
}

async function refreshGit(projectId: string): Promise<GitStatus | null> {
  const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
    (p) => p.id === projectId,
  );
  if (!project) return null;
  return managedRuntime.runPromise(refreshGitInfo(ipcShape, appStateShape, projectId, project.name));
}

/** Reconcile the database with what's actually inside the folder. */
export function reconcile(deployNew = false): Promise<void> {
  return managedRuntime.runPromise(reconcilerShape.reconcile(deployNew));
}

export function deployProject(projectId: string, target: DeployTarget): void {
  managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.enqueue(projectId, target)));
}

/**
 * Forget a project locally: history, logs, domains (SQL cascade), its
 * snapshot and any queue state. The remote Vercel project is untouched.
 */
export async function purgeProject(projectId: string): Promise<void> {
  managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.remove(projectId)));
  await ipc.snapshots.delete(projectId).catch(() => {});
  await ipc.db.deleteProject(projectId);
  Effect.runSync(SubscriptionRef.set(appStateShape.projects, await ipc.db.listProjects()));
  await refreshTray();
}

export function refreshAuth(): Promise<void> {
  return Effect.runPromise(accountSessionShape.refreshIdentity);
}

/** User chose how to handle an account switch (Keep Links / Start Fresh). */
export function resolveAccountSwitch(keepLinks: boolean): Promise<void> {
  return Effect.runPromise(accountSessionShape.resolveSwitch(keepLinks ? "keep" : "fresh"));
}

/**
 * Changes held during a previous offline session: deploy them now (or
 * re-hold if still offline — the queue re-persists in that case).
 */
async function drainPersistedDirty(): Promise<void> {
  try {
    const raw = await ipc.db.getSetting("dirty_projects");
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids) || ids.length === 0) return;
    await ipc.db.setSetting("dirty_projects", "[]");
    const projects = Effect.runSync(SubscriptionRef.get(appStateShape.projects));
    for (const id of ids) {
      if (typeof id === "string" && projects.some((p) => p.id === id)) {
        managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.notifyChange(id)));
      }
    }
  } catch (err) {
    log.warn("composition", `could not drain held changes: ${describeError(err)}`);
  }
}

/**
 * Startup sequencing — forked once by `App.tsx`. Auth check, watcher start,
 * initial reconcile, tray refresh: the same order `orchestrator.start()`
 * used, so launch behavior is unchanged.
 */
async function main(): Promise<void> {
  // Notification permission (macOS prompts once) — mounting Notifier runs it.
  await managedRuntime.runPromise(Notifier);

  const [root, paused, onboarded] = await Promise.all([
    ipc.fs.getRootFolder(),
    ipc.fs.getWatchPaused(),
    ipc.db.getSetting("onboarded"),
  ]);
  Effect.runSync(SubscriptionRef.set(appStateShape.rootFolder, root));
  Effect.runSync(SubscriptionRef.set(appStateShape.watchPaused, paused));
  Effect.runSync(SubscriptionRef.set(appStateShape.onboarded, onboarded === "1"));
  await managedRuntime.runPromise(Effect.andThen(DeployQueue, (q) => q.setPaused(paused)));

  // Who is signed in? (keychain token against the REST API.)
  void refreshAuth();

  // deployNew: projects that appeared while the app was closed should go
  // live on launch — folder = truth. The digest guard skips anything whose
  // content already matches its last successful deploy.
  await reconcile(true);

  // Hydrate latest deployment + stored snapshot per project.
  const latest = await ipc.db.latestDeployments();
  for (const d of latest) Effect.runSync(appStateShape.upsertDeployment(d));
  for (const p of Effect.runSync(SubscriptionRef.get(appStateShape.projects))) {
    void ipc.snapshots
      .get(p.id)
      .then(
        (s) =>
          s &&
          Effect.runSync(
            SubscriptionRef.update(appStateShape.snapshotByProject, (m) => ({ ...m, [p.id]: s.dataUrl })),
          ),
      )
      .catch(() => {});
  }
  await refreshTray();

  // Wire native events.
  await managedRuntime.runPromise(Effect.andThen(WatchStream, (w) => w.start));
  await ipc.events.onWatcherPaused((p) => {
    Effect.runSync(SubscriptionRef.set(appStateShape.watchPaused, p));
    managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.setPaused(p)));
  });
  await ipc.events.onTrayOpenProject(() => {
    Effect.runSync(SubscriptionRef.set(appStateShape.route, { name: "dashboard" } as const));
  });
  await ipc.events.onWatcherError((msg) => log.error("watcher", msg));

  // Establish connectivity BEFORE draining held changes — draining while
  // actually offline would just re-hold them (harmless), but draining after
  // the state is known avoids doomed deploys on flaky startups.
  await managedRuntime.runPromise(Effect.andThen(Connectivity, (c) => c.start));
  await drainPersistedDirty();
}

let started = false;

/** Called once from `App.tsx`'s mount effect. */
export function start(): void {
  if (started) return;
  started = true;
  void main();
}
