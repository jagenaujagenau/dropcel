import * as ipc from "../lib/ipc";
import { describeError, log } from "../lib/log";
import { useAppStore } from "../store/app";
import { createRealAccountSession, type AccountSession } from "./account-session";
import { createApiDeployer } from "./api-deployer";
import { checkGitConnection } from "./deployment-actions";
import {
  createTauriEffects,
  type ClipboardPort,
  type ConnectivityBridge,
  type NotifierBridge,
  type TrayPort,
} from "./effects";
import { shouldHoldAutoDeploy } from "./git";
import { HeldChanges } from "./held-changes";
import { choosePublicUrl } from "./public-url";
import { DeploymentQueue, type TransitionInfo } from "./queue";
import { Reconciler } from "./reconciler";
import type { Deployment, DeploymentState, DeployTarget } from "./types";
import * as api from "./vercel-api";
import { createWatchStreamBridge, type WatchStreamPort } from "./watch-stream";

/**
 * The orchestrator is the application's spine — and its composition root:
 * it constructs the deep modules (queue, reconciler, account session, held
 * changes, effect adapters), wires native events to them, and projects
 * results into the store, SQLite, tray and notifications. Created once at
 * startup; the modules own the logic, the orchestrator owns the wiring.
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

export class Orchestrator {
  readonly queue: DeploymentQueue;
  private readonly notifier: NotifierBridge;
  private readonly clipboard: ClipboardPort;
  private readonly tray: TrayPort;
  private readonly connectivity: ConnectivityBridge;
  private readonly held: HeldChanges;
  private readonly session: AccountSession;
  private readonly reconciler: Reconciler;
  private readonly watchStream: WatchStreamPort;

  constructor() {
    const effects = createTauriEffects();
    this.notifier = effects.notifier;
    this.clipboard = effects.clipboard;
    this.tray = effects.tray;
    this.connectivity = effects.connectivity;

    // Held-while-offline changes survive an app restart.
    this.held = new HeldChanges({
      persistOffline: (projectIds) => {
        void ipc.db
          .setSetting("dirty_projects", JSON.stringify(projectIds))
          .catch(() => {});
      },
    });

    this.session = createRealAccountSession({
      setAuthedAs: (username, avatarUrl) =>
        useAppStore.getState().setAuthedAs(username, avatarUrl),
      notify: (title, body) => this.notify(title, body),
      onSwitchDetected: (sw) => useAppStore.getState().setAccountSwitch(sw),
      getAccountSwitch: () => useAppStore.getState().accountSwitch,
      clearAccountSwitch: () => useAppStore.getState().setAccountSwitch(null),
      getProjects: () =>
        useAppStore.getState().projects.map((p) => ({ id: p.id, name: p.name })),
      onFreshStart: () => this.integrationChecked.clear(),
      reloadProjects: async () =>
        useAppStore.getState().setProjects(await ipc.db.listProjects()),
      // Deploy the changes that piled up while the banner was open.
      onSwitchResolved: () => {
        for (const id of this.held.release("account-switch")) {
          void this.notifyChangeGitGated(id);
        }
      },
    });

    this.queue = new DeploymentQueue({
      deployer: createApiDeployer({
        getToken: () => this.session.getToken(),
        getProjectMeta: async (projectName) => {
          const p = useAppStore.getState().projects.find((x) => x.name === projectName);
          return p
            ? {
                framework: p.framework,
                teamId: p.teamId,
                vercelProjectId: p.vercelProjectId,
              }
            : null;
        },
        collectFiles: ipc.files.collectDeployFiles,
        readFile: async (project, path) =>
          base64ToBytes(await ipc.files.readFileB64(project, path)),
        onLog: (deploymentId, stream, line) => {
          // Persisted for debugging; the UI shows the explained error only.
          void ipc.db.appendLog(deploymentId, stream, line).catch(() => {});
        },
        onCreated: (ourDeploymentId, info) => {
          void this.recordVercelIds(ourDeploymentId, info);
        },
      }),
      debounceMs: 2_000,
      createDeployment: async (projectId, target) => {
        const git = await this.refreshGit(projectId);
        const dep = await ipc.db.insertDeployment(
          projectId,
          target,
          git?.branch ?? null,
          git?.sha ?? null,
        );
        useAppStore.getState().upsertDeployment(dep);
        return dep.id;
      },
      onTransition: (projectId, deploymentId, state, info) => {
        void this.persistTransition(projectId, deploymentId, state, info);
      },
      getProject: (projectId) => {
        const p = useAppStore.getState().projects.find((x) => x.id === projectId);
        return p
          ? { id: p.id, name: p.name, path: p.path, autoDeploy: p.autoDeploy }
          : undefined;
      },
      // Content-digest guard: skip an auto-deploy when the project's files
      // are byte-identical to what the last successful deploy shipped.
      shouldSkipAuto: async (projectId) => {
        const project = useAppStore.getState().projects.find((p) => p.id === projectId);
        if (!project) return false;
        // Never skip while the latest deployment is failed/canceled —
        // deploying is how the project recovers to green, even if content
        // matches the last SUCCESSFUL deploy from before the failure.
        const latest = useAppStore.getState().latestByProject[projectId];
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
      held: this.held,
    });

    this.reconciler = new Reconciler({
      adoptLooseFiles: ipc.fs.adoptLooseFiles,
      scanProjects: ipc.fs.scanProjects,
      listProjects: ipc.db.listProjects,
      readProjectFile: ipc.fs.readProjectFile,
      listProjectEntries: ipc.fs.listProjectEntries,
      upsertProject: ipc.db.upsertProject,
      renameProject: ipc.db.renameProject,
      setProjectLink: ipc.db.setProjectLink,
      setProjectFramework: ipc.db.setProjectFramework,
      setProjects: (projects) => useAppStore.getState().setProjects(projects),
      setPresentOnDisk: (names) => useAppStore.getState().setPresentOnDisk(names),
      getProjects: () => useAppStore.getState().projects,
      isWatchPaused: () => useAppStore.getState().watchPaused,
      onProjectNeedsDeploy: (projectId) => void this.notifyChangeGitGated(projectId),
      onProjectPresent: (projectId) => {
        void this.refreshGit(projectId);
        void this.checkRemoteIntegration(projectId);
      },
      onProjectGone: (projectId) => this.queue.remove(projectId),
      onReconciled: () => this.refreshTray(),
    });

    this.watchStream = createWatchStreamBridge((changes) =>
      this.reconciler.handleFsChanges(changes),
    );
  }

  private async persistTransition(
    projectId: string,
    deploymentId: string,
    state: DeploymentState,
    info?: TransitionInfo,
  ) {
    try {
      const dep = await ipc.db.updateDeployment(
        deploymentId,
        state,
        info?.url ?? null,
        info?.error ?? null,
        info?.exitCode ?? null,
      );
      useAppStore.getState().upsertDeployment(dep);
      await this.refreshTray();
      const project = useAppStore
        .getState()
        .projects.find((p) => p.id === projectId);
      log.info(
        "deploy",
        `${project?.name ?? projectId} → ${state}${info?.error ? ` (${info.error})` : ""}`,
      );
      if (state === "ready") {
        if (info?.contentDigest) {
          void ipc.db
            .setSetting(`content_digest:${projectId}`, info.contentDigest)
            .catch(() => {});
        }
        void this.handleReady(projectId, dep, project?.name);
      } else if (state === "failed") {
        this.notify(
          "Deployment Failed",
          `${project?.name ?? "Project"} — ${info?.error ?? "open the app for details."}`,
        );
      }
    } catch (err) {
      log.error("orchestrator", `failed to persist transition: ${describeError(err)}`);
    }
  }

  /**
   * A deployment is live. Resolve its public URL once (the per-deployment
   * URL is guarded by Deployment Protection), then fan it out: persist it on
   * the deployment row so every UI surface links to the public site, copy it
   * to the clipboard, notify, and capture the dashboard snapshot from it.
   */
  private async handleReady(
    projectId: string,
    deployment: Deployment,
    projectName: string | undefined,
  ) {
    let url = deployment.url;
    if (deployment.url) {
      url = await this.resolvePublicUrl(projectId, deployment);
      if (url !== deployment.url) {
        try {
          await ipc.db.setDeploymentPublicUrl(deployment.id, url);
          const store = useAppStore.getState();
          const dep = store.latestByProject[projectId];
          if (dep?.id === deployment.id)
            store.upsertDeployment({ ...dep, publicUrl: url });
        } catch (err) {
          log.warn("orchestrator", `could not persist public url: ${describeError(err)}`);
        }
      }
      void this.captureSnapshot(projectId, url);
    }
    const copied = url ? await this.copyUrlToClipboard(url) : false;
    this.notify(
      "Deployment Ready",
      `${projectName ?? "Project"}\n${url ?? ""}${copied ? "\nURL copied to clipboard" : ""}`.trim(),
    );
  }

  /**
   * The API assigned real identifiers to a deployment: persist them, and on
   * a project's first deploy record the Vercel project link + owning team
   * and write .vercel/project.json (the rename guard's identity marker).
   */
  private async recordVercelIds(
    ourDeploymentId: string,
    info: {
      vercelDeploymentId: string;
      inspectorUrl: string | null;
      vercelProjectId: string | null;
      ownerId: string | null;
    },
  ) {
    try {
      await ipc.db.setDeploymentVercelIds(
        ourDeploymentId,
        info.vercelDeploymentId,
        info.inspectorUrl,
      );
      const store = useAppStore.getState();
      const dep = Object.values(store.latestByProject).find((d) => d?.id === ourDeploymentId);
      if (dep) {
        store.upsertDeployment({
          ...dep,
          vercelDeploymentId: info.vercelDeploymentId,
          inspectorUrl: info.inspectorUrl,
        });
        const project = store.projects.find((p) => p.id === dep.projectId);
        if (project && info.vercelProjectId) {
          const teamId = info.ownerId?.startsWith("team_") ? info.ownerId : null;
          if (!project.vercelProjectId) {
            await ipc.db.setProjectLink(project.id, info.vercelProjectId);
            await ipc.files
              .writeProjectLink(
                project.name,
                info.vercelProjectId,
                info.ownerId ?? "",
                project.name,
              )
              .catch(() => {});
          }
          if (project.teamId !== teamId) {
            await ipc.db.setProjectTeam(project.id, teamId);
          }
          store.setProjects(await ipc.db.listProjects());
          void this.checkRemoteIntegration(project.id);
        }
      }
    } catch (err) {
      log.warn("orchestrator", `could not record vercel ids: ${describeError(err)}`);
    }
  }

  /** Projects whose git-integration status was already checked this session. */
  private integrationChecked = new Set<string>();

  /**
   * A git-connected Vercel project deploys on push — folder auto-deploys on
   * top would double-deploy and ship uncommitted WIP. On first detecting a
   * connection, step aside: turn auto-deploy off (once) and tell the user.
   * They can re-enable it deliberately; we never flip it again.
   */
  private async checkRemoteIntegration(projectId: string) {
    const project = useAppStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    // Only linked projects can be git-connected; check once per session.
    if (!project.vercelProjectId || project.remoteRepo || !useAppStore.getState().online)
      return;
    if (this.integrationChecked.has(projectId)) return;
    this.integrationChecked.add(projectId);

    try {
      const repo = await checkGitConnection(project);
      await ipc.db.setRemoteRepo(projectId, repo ?? "");
      if (repo && project.autoDeploy) {
        await ipc.db.setAutoDeploy(projectId, false);
        this.notify(
          "Auto Deploy Turned Off",
          `${project.name} deploys via ${repo}. Auto deploy turned off — re-enable it anytime.`,
        );
      }
      useAppStore.getState().setProjects(await ipc.db.listProjects());
    } catch {
      // Offline or CLI hiccup: retry next session/reconcile.
      this.integrationChecked.delete(projectId);
    }
  }

  /** Best-effort snapshot; without a Chromium-family browser this no-ops. */
  private async captureSnapshot(projectId: string, url: string) {
    try {
      const snap = await ipc.snapshots.capture(projectId, url);
      useAppStore.getState().setSnapshot(projectId, snap.dataUrl);
    } catch (err) {
      log.warn("snapshot", `capture skipped: ${describeError(err)}`);
    }
  }

  /**
   * The unique deployment URL is guarded by Deployment Protection; the
   * stable aliases are the public face of the project. Prefer a verified
   * custom domain, then the project's *.vercel.app alias.
   */
  private async resolvePublicUrl(projectId: string, deployment: Deployment): Promise<string> {
    const deploymentUrl = deployment.url ?? "";
    try {
      const project = useAppStore.getState().projects.find((p) => p.id === projectId);
      const [domains, token] = await Promise.all([
        ipc.db.listDomains(projectId),
        this.session.getToken(),
      ]);
      let aliases: string[] = [];
      const dplId =
        deployment.vercelDeploymentId ??
        useAppStore.getState().latestByProject[projectId]?.vercelDeploymentId;
      if (token && dplId) {
        const fresh = await api.run(
          api.getDeployment({ token, teamId: project?.teamId }, dplId),
        );
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
  private async copyUrlToClipboard(url: string): Promise<boolean> {
    try {
      const setting = await ipc.db.getSetting("copy_url_on_ready");
      if (setting === "0") return false;
      await this.clipboard.write(url);
      return true;
    } catch (err) {
      console.error("clipboard copy failed", err);
      return false;
    }
  }

  private notify(title: string, body: string) {
    this.notifier.notify(title, body);
  }

  private async refreshTray() {
    const { projects, latestByProject, presentOnDisk } = useAppStore.getState();
    await this.tray.update(
      projects
        .filter((p) => presentOnDisk.has(p.name))
        .map((p) => ({
          name: p.name,
          status: trayStatus(latestByProject[p.id]?.state),
          framework: p.framework,
        })),
    );
  }

  /** Reconcile the database with what's actually inside the folder. */
  reconcile(deployNew = false): Promise<void> {
    return this.reconciler.reconcile(deployNew);
  }

  deployProject(projectId: string, target: DeployTarget) {
    this.queue.enqueue(projectId, target);
  }

  /** Timers re-checking projects held by an in-flight git operation. */
  private gitHoldTimers = new Map<string, ReturnType<typeof setInterval>>();

  private async refreshGit(projectId: string) {
    const project = useAppStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return null;
    const git = await ipc.git.info(project.name).catch(() => null);
    useAppStore.getState().setGitInfo(projectId, git);
    return git;
  }

  /**
   * Auto-deploy gate: hold while a merge/rebase is in flight (re-checking
   * until it clears, since the concluding writes happen inside the ignored
   * .git dir) or while the opt-in branch lock doesn't match. A checkout back
   * to the locked branch rewrites tracked files, which re-enters this path
   * naturally. Manual deploys bypass the gate entirely.
   */
  private async notifyChangeGitGated(projectId: string) {
    const project = useAppStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    // Unresolved account switch: linked projects would deploy against the
    // previous account and fail — hold everything until the user chooses.
    if (useAppStore.getState().accountSwitch) {
      this.held.mark(projectId, "account-switch");
      return;
    }
    const git = await this.refreshGit(projectId);
    const verdict = shouldHoldAutoDeploy(git, project.lockedBranch);
    if (!verdict.hold) {
      this.clearGitHold(projectId);
      this.queue.notifyChange(projectId);
      return;
    }
    if (git?.operation) {
      this.held.mark(projectId, "git-operation");
      if (!this.gitHoldTimers.has(projectId)) {
        const timer = setInterval(() => {
          void (async () => {
            const fresh = await this.refreshGit(projectId);
            const p = useAppStore.getState().projects.find((x) => x.id === projectId);
            if (!p || !fresh?.operation) {
              this.stopGitHoldTimer(projectId);
              const freed = this.held.releaseOne(projectId, "git-operation");
              if (p && freed && !shouldHoldAutoDeploy(fresh, p.lockedBranch).hold) {
                this.queue.notifyChange(projectId);
              }
            }
          })();
        }, 15_000);
        this.gitHoldTimers.set(projectId, timer);
      }
    }
  }

  private clearGitHold(projectId: string) {
    this.stopGitHoldTimer(projectId);
    this.held.releaseOne(projectId, "git-operation");
  }

  private stopGitHoldTimer(projectId: string) {
    const timer = this.gitHoldTimers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.gitHoldTimers.delete(projectId);
    }
  }

  /**
   * Forget a project locally: history, logs, domains (SQL cascade), its
   * snapshot and any queue state. The remote Vercel project is untouched.
   */
  async purgeProject(projectId: string): Promise<void> {
    this.queue.remove(projectId);
    await ipc.snapshots.delete(projectId).catch(() => {});
    await ipc.db.deleteProject(projectId);
    useAppStore.getState().setProjects(await ipc.db.listProjects());
    await this.refreshTray();
  }

  async start(): Promise<void> {
    const store = useAppStore.getState();

    // Notification permission (macOS prompts once).
    await this.notifier.init();

    const [root, paused, onboarded] = await Promise.all([
      ipc.fs.getRootFolder(),
      ipc.fs.getWatchPaused(),
      ipc.db.getSetting("onboarded"),
    ]);
    store.setRootFolder(root);
    store.setWatchPaused(paused);
    store.setOnboarded(onboarded === "1");
    this.queue.setPaused(paused);

    // Who is signed in? (keychain token against the REST API.)
    void this.refreshAuth();

    // deployNew: projects that appeared while the app was closed should go
    // live on launch — folder = truth. The digest guard skips anything whose
    // content already matches its last successful deploy.
    await this.reconcile(true);

    // Hydrate latest deployment + stored snapshot per project.
    const latest = await ipc.db.latestDeployments();
    for (const d of latest) useAppStore.getState().upsertDeployment(d);
    for (const p of useAppStore.getState().projects) {
      void ipc.snapshots
        .get(p.id)
        .then((s) => s && useAppStore.getState().setSnapshot(p.id, s.dataUrl))
        .catch(() => {});
    }
    await this.refreshTray();

    // Wire native events.
    await this.watchStream.start();
    await ipc.events.onWatcherPaused((p) => {
      useAppStore.getState().setWatchPaused(p);
      this.queue.setPaused(p);
    });
    await ipc.events.onTrayOpenProject(() => {
      useAppStore.getState().navigate({ name: "dashboard" });
    });
    await ipc.events.onWatcherError((msg) => log.error("watcher", msg));

    // Establish connectivity BEFORE draining held changes — draining while
    // actually offline would just re-hold them (harmless), but draining
    // after the state is known avoids doomed deploys on flaky startups.
    this.connectivity.onChange((online) => {
      useAppStore.getState().setOnline(online);
      this.queue.setOffline(!online);
      if (online) void this.refreshAuth();
    });
    await this.connectivity.start();
    await this.drainPersistedDirty();
  }

  /**
   * Changes held during a previous offline session: deploy them now (or
   * re-hold if still offline — the queue re-persists in that case).
   */
  private async drainPersistedDirty(): Promise<void> {
    try {
      const raw = await ipc.db.getSetting("dirty_projects");
      const ids: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(ids) || ids.length === 0) return;
      await ipc.db.setSetting("dirty_projects", "[]");
      const projects = useAppStore.getState().projects;
      for (const id of ids) {
        if (typeof id === "string" && projects.some((p) => p.id === id)) {
          this.queue.notifyChange(id);
        }
      }
    } catch (err) {
      log.warn("orchestrator", `could not drain held changes: ${describeError(err)}`);
    }
  }

  refreshAuth(): Promise<void> {
    return this.session.refreshIdentity();
  }

  /** User chose how to handle an account switch (Keep Links / Start Fresh). */
  resolveAccountSwitch(keepLinks: boolean): Promise<void> {
    return this.session.resolveSwitch(keepLinks ? "keep" : "fresh");
  }
}

export const orchestrator = new Orchestrator();
