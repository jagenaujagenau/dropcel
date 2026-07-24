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
import { checkGitConnection } from "./deployment-actions";
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
import { shouldHoldAutoDeploy } from "./git";
import { make as heldChangesMake, HeldChangesService, type HeldChangesSync } from "./held-changes";
import { make as ipcMake, Ipc } from "./ipc";
import { choosePublicUrl } from "./public-url";
import { DeployQueue, layer as deployQueueLayer, type QueueDeps, type TransitionInfo } from "./queue";
import { make as reconcilerMake, ReconcilerService, type ReconcilerHooks } from "./reconciler";
import type { Deployment, DeploymentState, DeployTarget } from "./types";
import * as api from "./vercel-api";
import { layer as watchStreamLayer, WatchStream } from "./watch-stream";

/**
 * The composition root: builds every phase 1-6 service into one Layer graph
 * (`AppLive`) driven by one `ManagedRuntime`, and wires the callbacks between
 * them. This replaces `orchestrator.ts` — there is no class and no mutable
 * "spine" object; state lives in each service's own `SubscriptionRef` (plus
 * `AppState` for the UI projections none of them owns individually), and the
 * wiring below is plain functions closing over the constructed shapes.
 *
 * Most services here have zero async/scoped construction (they only build
 * `Ref`/`SubscriptionRef`/`Semaphore` state) and so are built synchronously,
 * once, exactly like the pre-phase-7 orchestrator's constructor did — this
 * keeps the diff against phases 1-6 mechanical. The three services that
 * genuinely own a long-lived fiber (`Connectivity`, `DeployQueue`,
 * `WatchStream`) stay real `Layer.effect` members of `AppLive`, built inside
 * `ManagedRuntime`'s own scope so their fibers live for the app's lifetime.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function trayStatus(state: string | undefined): ipc.TrayProject["status"] {
  switch (state) {
    case "ready":
      return "ready";
    case "failed":
      return "failed";
    case "queued":
    case "preparing":
    case "uploading":
    case "building":
      return "deploying";
    default:
      return "idle";
  }
}

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

/** Sync bridge `DeployQueue` needs — every `HeldChangesShape` op is Ref-only. */
const heldSync: HeldChangesSync = {
  mark: (id, r) => Effect.runSync(heldChangesShape.mark(id, r)),
  release: (r) => Effect.runSync(heldChangesShape.release(r)),
  releaseOne: (id, r) => Effect.runSync(heldChangesShape.releaseOne(id, r)),
  isHeld: (id) => Effect.runSync(heldChangesShape.isHeld(id)),
  heldBy: (r) => Effect.runSync(heldChangesShape.heldBy(r)),
};

// -- account switch bookkeeping (mirrors AccountSessionService.state.pendingSwitch
// for the two callers, account-session.ts's own resolveSwitch, that need a
// synchronous get/clear at hook-construction time) --
let pendingSwitchMirror: AccountSwitch | null = null;
/** Projects whose git-integration status was already checked this session. */
const integrationChecked = new Set<string>();
/** Timers re-checking projects held by an in-flight git operation. */
const gitHoldTimers = new Map<string, ReturnType<typeof setInterval>>();

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
  onFreshStart: () => integrationChecked.clear(),
  reloadProjects: async () => {
    const projects = await ipc.db.listProjects();
    Effect.runSync(appStateShape.setProjects(projects));
  },
  onSwitchResolved: () => {
    for (const id of heldSync.release("account-switch")) void notifyChangeGitGated(id);
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
  setProjects: (projects) => Effect.runSync(appStateShape.setProjects(projects)),
  setPresentOnDisk: (names) => Effect.runSync(appStateShape.setPresentOnDisk(names)),
  getProjects: () => Effect.runSync(SubscriptionRef.get(appStateShape.projects)),
  isWatchPaused: () => Effect.runSync(SubscriptionRef.get(appStateShape.watchPaused)),
  onProjectNeedsDeploy: (projectId) => void notifyChangeGitGated(projectId),
  onProjectPresent: (projectId) => {
    void refreshGit(projectId);
    void checkRemoteIntegration(projectId);
  },
  onProjectGone: (projectId) => managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.remove(projectId))),
  onReconciled: () => refreshTray(),
};

const reconcilerShape = Effect.runSync(
  Effect.provideService(reconcilerMake(reconcilerHooks), Ipc, ipcShape),
);

// ---- queue deps (needs the account session + tray/notify business logic) ---

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
    onCreated: (ourDeploymentId: string, info: Parameters<typeof recordVercelIds>[1]) => {
      void recordVercelIds(ourDeploymentId, info);
    },
  }),
  debounceMs: 2_000,
  createDeployment: async (projectId: string, target: DeployTarget) => {
    const git = await refreshGit(projectId);
    const dep = await ipc.db.insertDeployment(
      projectId,
      target,
      git?.branch ?? null,
      git?.sha ?? null,
    );
    Effect.runSync(appStateShape.upsertDeployment(dep));
    return dep.id;
  },
  onTransition: (
    projectId: string,
    deploymentId: string,
    state: DeploymentState,
    info?: TransitionInfo,
  ) => {
    void persistTransition(projectId, deploymentId, state, info);
  },
  getProject: (projectId: string) => {
    const p = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
      (x) => x.id === projectId,
    );
    return p ? { id: p.id, name: p.name, path: p.path, autoDeploy: p.autoDeploy } : undefined;
  },
  // Content-digest guard: skip an auto-deploy when the project's files are
  // byte-identical to what the last successful deploy shipped.
  shouldSkipAuto: async (projectId: string) => {
    const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
      (p) => p.id === projectId,
    );
    if (!project) return false;
    const latest = Effect.runSync(SubscriptionRef.get(appStateShape.latestByProject))[projectId];
    if (latest && latest.state !== "ready") return false;
    const [current, deployed] = await Promise.all([
      ipc.files.contentDigest(project.name),
      ipc.db.getSetting(`content_digest:${projectId}`),
    ]);
    const identical = Boolean(deployed) && current === deployed;
    if (identical) {
      log.info("queue", `skipping auto-deploy of ${project.name}: content unchanged`);
    }
    return identical;
  },
  held: heldSync,
};

// ---- the Layer graph ---------------------------------------------------

const ipcLayerSucceed = Layer.succeed(Ipc, ipcShape);

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
  | WatchStream
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
  deployQueueLayer(queueDeps),
  watchStreamLayer({
    // The reconciler's own `Reconciler` class instance is already
    // constructed (`reconcilerShape` closes over it); errors are swallowed
    // exactly as the old Promise bridge did (a rejected promise there
    // would have defected the fiber, never surfaced as a typed failure).
    onChanges: (changes) => Effect.orDie(reconcilerShape.handleFsChanges(changes)),
  }),
).pipe(Layer.provideMerge(ipcLayerSucceed));

/** One `ManagedRuntime` for the whole app: `main`, native event bridges, and
 * every hook closure above that needs `Connectivity` / `DeployQueue` /
 * `WatchStream` / `Notifier` from context runs through this. Shares its
 * `memoMap` with the atom runtime (see `atoms.ts`) so the graph is built
 * exactly once regardless of which "front door" (React or a Tauri event
 * listener) touches it first. */
export const managedRuntime = ManagedRuntime.make(AppLive);

// ---- business logic (verbatim port of orchestrator.ts's private methods) --

function notify(title: string, body: string): void {
  managedRuntime.runFork(Effect.andThen(Notifier, (n) => n.notify(title, body)));
}

async function persistTransition(
  projectId: string,
  deploymentId: string,
  state: DeploymentState,
  info?: TransitionInfo,
): Promise<void> {
  try {
    const dep = await ipc.db.updateDeployment(
      deploymentId,
      state,
      info?.url ?? null,
      info?.error ?? null,
      info?.exitCode ?? null,
    );
    Effect.runSync(appStateShape.upsertDeployment(dep));
    await refreshTray();
    const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
      (p) => p.id === projectId,
    );
    log.info(
      "deploy",
      `${project?.name ?? projectId} → ${state}${info?.error ? ` (${info.error})` : ""}`,
    );
    if (state === "ready") {
      if (info?.contentDigest) {
        void ipc.db.setSetting(`content_digest:${projectId}`, info.contentDigest).catch(() => {});
      }
      void handleReady(projectId, dep, project?.name);
    } else if (state === "failed") {
      notify(
        "Deployment Failed",
        `${project?.name ?? "Project"} — ${info?.error ?? "open the app for details."}`,
      );
    }
  } catch (err) {
    log.error("composition", `failed to persist transition: ${describeError(err)}`);
  }
}

/**
 * A deployment is live. Resolve its public URL once (the per-deployment URL
 * is guarded by Deployment Protection), then fan it out: persist it on the
 * deployment row so every UI surface links to the public site, copy it to
 * the clipboard, notify, and capture the dashboard snapshot from it.
 */
async function handleReady(
  projectId: string,
  deployment: Deployment,
  projectName: string | undefined,
): Promise<void> {
  let url = deployment.url;
  if (deployment.url) {
    url = await resolvePublicUrl(projectId, deployment);
    if (url !== deployment.url) {
      try {
        await ipc.db.setDeploymentPublicUrl(deployment.id, url);
        const dep = Effect.runSync(SubscriptionRef.get(appStateShape.latestByProject))[projectId];
        if (dep?.id === deployment.id) {
          Effect.runSync(appStateShape.upsertDeployment({ ...dep, publicUrl: url }));
        }
      } catch (err) {
        log.warn("composition", `could not persist public url: ${describeError(err)}`);
      }
    }
    void captureSnapshot(projectId, url);
  }
  const copied = url ? await copyUrlToClipboard(url) : false;
  notify(
    "Deployment Ready",
    `${projectName ?? "Project"}\n${url ?? ""}${copied ? "\nURL copied to clipboard" : ""}`.trim(),
  );
}

/**
 * The API assigned real identifiers to a deployment: persist them, and on a
 * project's first deploy record the Vercel project link + owning team and
 * write .vercel/project.json (the rename guard's identity marker).
 */
async function recordVercelIds(
  ourDeploymentId: string,
  info: {
    vercelDeploymentId: string;
    inspectorUrl: string | null;
    vercelProjectId: string | null;
    ownerId: string | null;
  },
): Promise<void> {
  try {
    await ipc.db.setDeploymentVercelIds(ourDeploymentId, info.vercelDeploymentId, info.inspectorUrl);
    const latest = Effect.runSync(SubscriptionRef.get(appStateShape.latestByProject));
    const dep = Object.values(latest).find((d) => d?.id === ourDeploymentId);
    if (dep) {
      Effect.runSync(
        appStateShape.upsertDeployment({
          ...dep,
          vercelDeploymentId: info.vercelDeploymentId,
          inspectorUrl: info.inspectorUrl,
        }),
      );
      const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
        (p) => p.id === dep.projectId,
      );
      if (project && info.vercelProjectId) {
        const teamId = info.ownerId?.startsWith("team_") ? info.ownerId : null;
        if (!project.vercelProjectId) {
          await ipc.db.setProjectLink(project.id, info.vercelProjectId);
          await ipc.files
            .writeProjectLink(project.name, info.vercelProjectId, info.ownerId ?? "", project.name)
            .catch(() => {});
        }
        if (project.teamId !== teamId) {
          await ipc.db.setProjectTeam(project.id, teamId);
        }
        Effect.runSync(appStateShape.setProjects(await ipc.db.listProjects()));
        void checkRemoteIntegration(project.id);
      }
    }
  } catch (err) {
    log.warn("composition", `could not record vercel ids: ${describeError(err)}`);
  }
}

/**
 * A git-connected Vercel project deploys on push — folder auto-deploys on
 * top would double-deploy and ship uncommitted WIP. On first detecting a
 * connection, step aside: turn auto-deploy off (once) and tell the user.
 * They can re-enable it deliberately; we never flip it again.
 */
async function checkRemoteIntegration(projectId: string): Promise<void> {
  const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
    (p) => p.id === projectId,
  );
  if (!project) return;
  const online = await managedRuntime.runPromise(
    Effect.andThen(Connectivity, (c) => SubscriptionRef.get(c.online)),
  );
  if (!project.vercelProjectId || project.remoteRepo || !online) return;
  if (integrationChecked.has(projectId)) return;
  integrationChecked.add(projectId);

  try {
    const repo = await checkGitConnection(project);
    await ipc.db.setRemoteRepo(projectId, repo ?? "");
    if (repo && project.autoDeploy) {
      await ipc.db.setAutoDeploy(projectId, false);
      notify(
        "Auto Deploy Turned Off",
        `${project.name} deploys via ${repo}. Auto deploy turned off — re-enable it anytime.`,
      );
    }
    Effect.runSync(appStateShape.setProjects(await ipc.db.listProjects()));
  } catch {
    integrationChecked.delete(projectId);
  }
}

/** Best-effort snapshot; without a Chromium-family browser this no-ops. */
async function captureSnapshot(projectId: string, url: string): Promise<void> {
  try {
    const snap = await ipc.snapshots.capture(projectId, url);
    Effect.runSync(appStateShape.setSnapshot(projectId, snap.dataUrl));
  } catch (err) {
    log.warn("snapshot", `capture skipped: ${describeError(err)}`);
  }
}

/**
 * The unique deployment URL is guarded by Deployment Protection; the stable
 * aliases are the public face of the project. Prefer a verified custom
 * domain, then the project's *.vercel.app alias.
 */
async function resolvePublicUrl(projectId: string, deployment: Deployment): Promise<string> {
  const deploymentUrl = deployment.url ?? "";
  try {
    const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
      (p) => p.id === projectId,
    );
    const [domains, token] = await Promise.all([
      ipc.db.listDomains(projectId),
      Effect.runPromise(accountSessionShape.getToken),
    ]);
    let aliases: string[] = [];
    const dplId =
      deployment.vercelDeploymentId ??
      Effect.runSync(SubscriptionRef.get(appStateShape.latestByProject))[projectId]
        ?.vercelDeploymentId;
    if (token && dplId) {
      const fresh = await api.run(api.getDeployment({ token, teamId: project?.teamId }, dplId));
      aliases = fresh.aliases;
    }
    return choosePublicUrl({
      deploymentUrl,
      aliases,
      verifiedDomains: domains.filter((d) => d.verified).map((d) => d.domain),
    });
  } catch {
    return deploymentUrl;
  }
}

/** Put the fresh deployment URL in the clipboard, ready to paste/share. */
async function copyUrlToClipboard(url: string): Promise<boolean> {
  try {
    const setting = await ipc.db.getSetting("copy_url_on_ready");
    if (setting === "0") return false;
    await managedRuntime.runPromise(Effect.andThen(Clipboard, (c) => c.write(url)));
    return true;
  } catch (err) {
    console.error("clipboard copy failed", err);
    return false;
  }
}

async function refreshTray(): Promise<void> {
  const projects = Effect.runSync(SubscriptionRef.get(appStateShape.projects));
  const latestByProject = Effect.runSync(SubscriptionRef.get(appStateShape.latestByProject));
  const presentOnDisk = Effect.runSync(SubscriptionRef.get(appStateShape.presentOnDisk));
  await managedRuntime.runPromise(
    Effect.andThen(Tray, (t) =>
      t.update(
        projects
          .filter((p) => presentOnDisk.has(p.name))
          .map((p) => ({
            name: p.name,
            status: trayStatus(latestByProject[p.id]?.state),
            framework: p.framework,
          })),
      ),
    ),
  );
}

/** Reconcile the database with what's actually inside the folder. */
export function reconcile(deployNew = false): Promise<void> {
  return managedRuntime.runPromise(reconcilerShape.reconcile(deployNew));
}

export function deployProject(projectId: string, target: DeployTarget): void {
  managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.enqueue(projectId, target)));
}

async function refreshGit(projectId: string) {
  const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
    (p) => p.id === projectId,
  );
  if (!project) return null;
  const git = await ipc.git.info(project.name).catch(() => null);
  Effect.runSync(appStateShape.setGitInfo(projectId, git));
  return git;
}

/**
 * Auto-deploy gate: hold while a merge/rebase is in flight (re-checking
 * until it clears, since the concluding writes happen inside the ignored
 * .git dir) or while the opt-in branch lock doesn't match. A checkout back
 * to the locked branch rewrites tracked files, which re-enters this path
 * naturally. Manual deploys bypass the gate entirely.
 */
async function notifyChangeGitGated(projectId: string): Promise<void> {
  const project = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
    (p) => p.id === projectId,
  );
  if (!project) return;
  // Unresolved account switch: linked projects would deploy against the
  // previous account and fail — hold everything until the user chooses.
  if (pendingSwitchMirror) {
    heldSync.mark(projectId, "account-switch");
    return;
  }
  const git = await refreshGit(projectId);
  const verdict = shouldHoldAutoDeploy(git, project.lockedBranch);
  if (!verdict.hold) {
    clearGitHold(projectId);
    managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.notifyChange(projectId)));
    return;
  }
  if (git?.operation) {
    heldSync.mark(projectId, "git-operation");
    if (!gitHoldTimers.has(projectId)) {
      const timer = setInterval(() => {
        void (async () => {
          const fresh = await refreshGit(projectId);
          const p = Effect.runSync(SubscriptionRef.get(appStateShape.projects)).find(
            (x) => x.id === projectId,
          );
          if (!p || !fresh?.operation) {
            stopGitHoldTimer(projectId);
            const freed = heldSync.releaseOne(projectId, "git-operation");
            if (p && freed && !shouldHoldAutoDeploy(fresh, p.lockedBranch).hold) {
              managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.notifyChange(projectId)));
            }
          }
        })();
      }, 15_000);
      gitHoldTimers.set(projectId, timer);
    }
  }
}

function clearGitHold(projectId: string) {
  stopGitHoldTimer(projectId);
  heldSync.releaseOne(projectId, "git-operation");
}

function stopGitHoldTimer(projectId: string) {
  const timer = gitHoldTimers.get(projectId);
  if (timer) {
    clearInterval(timer);
    gitHoldTimers.delete(projectId);
  }
}

/**
 * Forget a project locally: history, logs, domains (SQL cascade), its
 * snapshot and any queue state. The remote Vercel project is untouched.
 */
export async function purgeProject(projectId: string): Promise<void> {
  managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.remove(projectId)));
  await ipc.snapshots.delete(projectId).catch(() => {});
  await ipc.db.deleteProject(projectId);
  Effect.runSync(appStateShape.setProjects(await ipc.db.listProjects()));
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
  Effect.runSync(appStateShape.setRootFolder(root));
  Effect.runSync(appStateShape.setWatchPaused(paused));
  Effect.runSync(appStateShape.setOnboarded(onboarded === "1"));
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
      .then((s) => s && Effect.runSync(appStateShape.setSnapshot(p.id, s.dataUrl)))
      .catch(() => {});
  }
  await refreshTray();

  // Wire native events.
  await managedRuntime.runPromise(Effect.andThen(WatchStream, (w) => w.start));
  await ipc.events.onWatcherPaused((p) => {
    Effect.runSync(appStateShape.setWatchPaused(p));
    managedRuntime.runFork(Effect.andThen(DeployQueue, (q) => q.setPaused(p)));
  });
  await ipc.events.onTrayOpenProject(() => {
    Effect.runSync(appStateShape.navigate({ name: "dashboard" }));
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
