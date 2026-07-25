import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ipc from "../lib/ipc";
import { describeError, log } from "../lib/log";
import { applyTheme, cacheTheme } from "../lib/theme";
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
import { make as heldChangesMake, HeldChangesService, type HoldReason } from "./held-changes";
import { make as ipcMake, Ipc } from "./ipc";
import { DeployQueue, layer as deployQueueLayer, type QueueDeps } from "./queue";
import { layer as readyEffectsLayer, ReadyEffects, type RecordVercelIdsInfo } from "./ready-effects";
import { make as reconcilerMake, ReconcilerService, type ReconcilerHooks } from "./reconciler";
import { runStartup, type StartupHooks } from "./startup";
import type { Account, DeployTarget } from "./types";
import { layer as updaterLayer, Updater } from "./updater";
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
    onChange: (heldByProject) => SubscriptionRef.set(appStateShape.heldByProject, heldByProject),
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
  reloadProjects,
  onSwitchResolved: () => {
    releaseHold("account-switch");
  },
};

/** Fire-and-forget `AutoDeployGate.releaseHold` — the one way a cleared cause
 * turns back into deploys. Every caller here is an event handler with nothing
 * to await. */
function releaseHold(reason: HoldReason): void {
  managedRuntime.runFork(Effect.andThen(AutoDeployGate, (g) => g.releaseHold(reason)));
}

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
  setProjects: (projects) => Effect.runSync(appStateShape.setProjects(projects)),
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

// ---- build-log buffering ---------------------------------------------
//
// The deployer emits one `onLog` call per line, and lines arrive in bursts:
// each build poll returns everything since the last one, which for a Next.js
// build is dozens of lines at a time and several hundred overall. Writing each
// one straight through cost an IPC round trip and a separate transaction per
// line, all landing while the user is watching the deployment card.
//
// The burst is delivered synchronously (api-deployer loops over the poll's
// events), so a microtask is enough to coalesce a whole poll's worth into one
// batched insert — no timer, and no added latency worth measuring: the buffer
// is drained before anything can observe it, including the log viewer.

const logBuffer = new Map<string, [string, string][]>();
let logFlushScheduled = false;

function flushLogBuffer(): void {
  logFlushScheduled = false;
  const batches = [...logBuffer];
  logBuffer.clear();
  for (const [deploymentId, lines] of batches) {
    void ipc.db.appendLogs(deploymentId, lines).catch(() => {});
  }
}

function bufferLogLine(deploymentId: string, stream: "stdout" | "stderr", line: string): void {
  const existing = logBuffer.get(deploymentId);
  if (existing) existing.push([stream, line]);
  else logBuffer.set(deploymentId, [[stream, line]]);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    queueMicrotask(flushLogBuffer);
  }
}

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
    onLog: bufferLogLine,
    onCreated: (ourDeploymentId: string, info: RecordVercelIdsInfo) => {
      managedRuntime.runFork(Effect.andThen(ReadyEffects, (r) => r.recordVercelIds(ourDeploymentId, info)));
    },
  }),
  accountSwitchPending: SubscriptionRef.get(accountSessionShape.state).pipe(
    Effect.map((s) => s.pendingSwitch !== null),
  ),
  debounceMs: 2_000,
  // Reconnecting re-enters the gate rather than the queue's own
  // `notifyChange`: a change can sit out an outage for hours, and the repo it
  // belongs to may have started a rebase in the meantime. Same reason the
  // account-switch check above is not left to callers.
  drainHeld: (projectId) =>
    Effect.sync(() => {
      notifyChangeGitGated(projectId);
    }),
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
  Ipc | AppState | Clipboard | Tray | Notifier | Connectivity | HeldChangesService | AccountSessionService | ReconcilerService | Updater
> = Layer.mergeAll(
  Layer.succeed(AppState, appStateShape),
  Layer.succeed(Clipboard, clipboardShape),
  Layer.succeed(Tray, trayShape),
  Layer.succeed(HeldChangesService, heldChangesShape),
  Layer.succeed(AccountSessionService, accountSessionShape),
  Layer.succeed(ReconcilerService, reconcilerShape),
  updaterLayer,
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
  | Updater
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
    /**
     * One bad batch must not end the watcher.
     *
     * This was `Effect.orDie`, on the reasoning that it matched the old
     * Promise bridge's behaviour — but `orDie` doesn't swallow anything, it
     * promotes a typed failure into a defect, and the defect killed the
     * `Stream.runForEach` fiber that *is* the fs-event pump. `handleFsChanges`
     * fails with a typed `IpcError` on any transient DB or fs hiccup, so a
     * single one of those permanently stopped the app from watching the
     * folder: `WatchStream`'s `running` ref still held the now-dead fiber, so
     * `start` was a no-op, and the closing stream scope unregistered the Tauri
     * listener on the way out. Nothing surfaced in the UI — files just quietly
     * stopped deploying until the next relaunch.
     *
     * `catchCause` (not `catchAll`) so an unexpected throw inside the
     * reconciler is contained on the same terms as a typed failure. Dropping
     * one batch costs at most a delayed deploy, and the next fs event — or any
     * manual rescan — reconciles the folder from scratch anyway, since
     * reconcile compares against the *current* directory listing rather than
     * replaying history.
     */
    onChanges: (changes) =>
      reconcilerShape.handleFsChanges(changes).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error("reconciler", `dropped one fs batch: ${Cause.pretty(cause)}`);
          }),
        ),
      ),
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
 * Re-read the project rows from SQLite and publish them to the projection.
 *
 * The one door for "SQLite changed, refresh the list". It exists because the
 * two-liner it replaces was open-coded at every call site — including three
 * React components, which meant a dialog reached past the composition root and
 * wrote the projection directly. SQLite is still the source of truth; this is
 * the only place outside the graph's own wiring that re-reads it for `projects`.
 *
 * `setProjects` (not a bare `SubscriptionRef.set`) so the field-wise comparison
 * still suppresses the no-op writes this is called with most of the time.
 */
export async function reloadProjects(): Promise<void> {
  Effect.runSync(appStateShape.setProjects(await ipc.db.listProjects()));
}

/**
 * Forget a project locally: history, logs, domains (SQL cascade), its
 * snapshot and any queue state. The remote Vercel project is untouched.
 */
export async function purgeProject(projectId: string): Promise<void> {
  managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.remove(projectId)));
  // Row and snapshot together — the two used to be separate awaits with the
  // snapshot's failure swallowed, so a crash between them left a PNG behind
  // under an id nothing referenced.
  await ipc.db.forgetProject(projectId);
  await reloadProjects();
  await refreshTray();
}

/** Pull the account cache out of SQLite into the store. Signing in is the
 * only thing that changes it, so it is refreshed there rather than polled. */
export async function refreshAccounts(): Promise<void> {
  const rows = await ipc.db.listAccounts().catch(() => []);
  const byUid: Record<string, Account> = {};
  for (const a of rows) byUid[a.uid] = a;
  Effect.runSync(SubscriptionRef.set(appStateShape.accounts, byUid));
}

export function refreshAuth(): Promise<void> {
  // The account cache is refreshed on the way out, not by refreshIdentity
  // itself: identity writes the accounts row, and the render layer reads it
  // back through its own atom, so the read has to happen after the write.
  return Effect.runPromise(accountSessionShape.refreshIdentity)
    .then(() => refreshAccounts().catch(() => {}))
    .then(() => releaseSignedOutHolds());
}

/**
 * A token came back — drain whatever piled up while there wasn't one.
 *
 * Runs after every identity refresh rather than only after a sign-in: a
 * refresh is also what discovers an expired token has been renewed, and the
 * hold has to lift on that path too. Releasing a reason nobody is holding is
 * a no-op, so the common case costs nothing.
 */
async function releaseSignedOutHolds(): Promise<void> {
  const signedIn = Effect.runSync(
    SubscriptionRef.get(accountSessionShape.state),
  ).username;
  if (!signedIn) return;
  releaseHold("signed-out");
}

/** User chose how to handle an account switch (Keep Links / Start Fresh). */
export function resolveAccountSwitch(keepLinks: boolean): Promise<void> {
  return Effect.runPromise(accountSessionShape.resolveSwitch(keepLinks ? "keep" : "fresh"));
}

/** Manual check (Settings' "Check for Updates" button) or the startup check. */
export function checkForUpdates(): Promise<void> {
  return managedRuntime.runPromise(Effect.andThen(Updater, (u) => u.check));
}

/** User confirmed installing an already-found update — downloads, installs,
 * relaunches. Never called without a prior "available" status. */
export function installUpdateAndRelaunch(): Promise<void> {
  return managedRuntime.runPromise(Effect.andThen(Updater, (u) => u.installAndRelaunch));
}

/**
 * Changes held during a previous offline session: deploy them now (or
 * re-hold if still offline).
 *
 * The persisted `dirty_projects` set *is* the `offline` component of **Held
 * changes** — so this rehydrates it into the ledger and then releases it,
 * rather than reaching past the ledger into the queue. That matters for more
 * than tidiness: the old shortcut enqueued each id directly, which meant a
 * restart drained changes without re-checking the **Gate**, and did it while
 * `refreshAuth()` was still in flight. Going through `releaseHold` puts the
 * restart path on exactly the same footing as reconnecting mid-session.
 *
 * Marking then releasing is not a no-op round trip: `release` returns only the
 * projects with no *other* reason left, and `notifyChangeGitGated` re-holds
 * anything that still shouldn't go. Persistence takes care of itself — `mark`
 * rewrites the setting from the live set and `release` empties it.
 */
async function drainPersistedDirty(): Promise<void> {
  try {
    const raw = await ipc.db.getSetting("dirty_projects");
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids) || ids.length === 0) return;
    const projects = Effect.runSync(SubscriptionRef.get(appStateShape.projects));
    const live = ids.filter(
      (id): id is string => typeof id === "string" && projects.some((p) => p.id === id),
    );
    await managedRuntime.runPromise(
      Effect.gen(function* () {
        const held = yield* HeldChangesService;
        const gate = yield* AutoDeployGate;
        for (const id of live) yield* held.mark(id, "offline");
        yield* gate.releaseHold("offline");
      }),
    );
    // Ids that no longer name a live project would otherwise sit in the
    // setting forever; `mark`/`release` only ever rewrite it from the ids
    // that made it into the ledger.
    if (live.length !== ids.length) await ipc.db.setSetting("dirty_projects", "[]");
  } catch (err) {
    log.warn("composition", `could not drain held changes: ${describeError(err)}`);
  }
}

/**
 * The startup sequence's side effects.
 *
 * The *order* and the error isolation live in `core/startup.ts`, where they
 * can be tested; what is left here is the binding of each named step to the
 * concrete thing it does. Forked once by `App.tsx`.
 */
const startupHooks: StartupHooks = {
  loadSettings: async () => {
    const [root, paused, onboarded, storedTheme] = await Promise.all([
      ipc.fs.getRootFolder().catch(() => ""),
      ipc.fs.getWatchPaused().catch(() => false),
      ipc.db.getSetting("onboarded").catch(() => null),
      ipc.db.getSetting("theme").catch(() => null),
    ]);
    return {
      rootFolder: root,
      watchPaused: paused,
      onboarded: onboarded === "1",
      theme: storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system",
    };
  },
  publishSettings: (settings) => {
    Effect.runSync(SubscriptionRef.set(appStateShape.rootFolder, settings.rootFolder));
    Effect.runSync(SubscriptionRef.set(appStateShape.watchPaused, settings.watchPaused));
    Effect.runSync(SubscriptionRef.set(appStateShape.onboarded, settings.onboarded));
    Effect.runSync(SubscriptionRef.set(appStateShape.theme, settings.theme));
    // Reconciles the synchronous localStorage cache (applied before first
    // paint — see main.tsx) with the database's value, in case they differ.
    applyTheme(settings.theme);
    cacheTheme(settings.theme);
  },
  requestNotificationPermission: () => {
    managedRuntime.runFork(Notifier);
  },
  setQueuePaused: (paused) =>
    managedRuntime.runPromise(Effect.andThen(DeployQueue, (q) => q.setPaused(paused))),
  refreshAuth: () => {
    void refreshAuth();
  },
  reconcile: () => reconcile(true),
  hydrateDeployments: async () => {
    const latest = await ipc.db.latestDeployments();
    for (const d of latest) Effect.runSync(appStateShape.upsertDeployment(d));
  },
  hydrateSnapshots: async () => {
    // One IPC round trip regardless of project count — see screenshot.rs's
    // get_snapshots_batch.
    const projectIds = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).map((p) => p.id);
    if (projectIds.length === 0) return;
    const snaps = await ipc.snapshots.getBatch(projectIds);
    Effect.runSync(
      SubscriptionRef.update(appStateShape.snapshotByProject, (m) => {
        const next = { ...m };
        for (const [id, s] of Object.entries(snaps)) next[id] = s.dataUrl;
        return next;
      }),
    );
  },
  refreshTray: () => refreshTray(),
  startWatchStream: () =>
    managedRuntime.runPromise(Effect.andThen(WatchStream, (w) => w.start)),
  registerEventListeners: async () => {
    await ipc.events.onWatcherPaused((p) => {
      Effect.runSync(SubscriptionRef.set(appStateShape.watchPaused, p));
      managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.setPaused(p)));
    });
    await ipc.events.onTrayOpenProject(() => {
      Effect.runSync(SubscriptionRef.set(appStateShape.route, { name: "dashboard" } as const));
    });
    await ipc.events.onWatcherError((msg) => log.error("watcher", msg));
  },
  startConnectivity: () =>
    managedRuntime.runPromise(Effect.andThen(Connectivity, (c) => c.start)),
  drainHeldChanges: () => drainPersistedDirty(),
  scheduleUpdateCheck: () => {
    managedRuntime.runFork(
      Effect.andThen(Updater, (u) => u.check).pipe(Effect.delay("4 seconds")),
    );
  },
  onStepError: (name, error) => {
    log.error("composition", `startup step "${name}" failed: ${describeError(error)}`);
  },
};

let started = false;

/** Called once from `App.tsx`'s mount effect. */
export function start(): void {
  if (started) return;
  started = true;
  // Every step inside `runStartup` is individually guarded, so this should be
  // unreachable — but `started` is latched above and an unhandled rejection
  // here would be a silent dead app, so it gets a last-resort log rather than
  // vanishing into the console.
  void runStartup(startupHooks).catch((err) => {
    log.error("composition", `startup aborted: ${describeError(err)}`);
  });
}
