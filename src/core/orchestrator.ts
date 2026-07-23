import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import * as ipc from "../lib/ipc";
import { describeError, log } from "../lib/log";
import { useAppStore } from "../store/app";
import { createApiDeployer } from "./api-deployer";
import { getAuthToken, importFromCli } from "./auth";
import { checkGitConnection } from "./deployment-actions";
import { detectFramework, isDeployable } from "./detection";
import { shouldHoldAutoDeploy } from "./git";
import { choosePublicUrl } from "./public-url";
import { DeploymentQueue, type TransitionInfo } from "./queue";
import { isLegitRename, parseLinkFile } from "./rename";
import type { Deployment, DeploymentState, DeployTarget, Project } from "./types";
import * as api from "./vercel-api";

/**
 * The orchestrator is the application's spine: it connects native events
 * (filesystem changes) and the REST-API deployer to the pure core
 * (detection, state machine, queue) and projects results into the store,
 * SQLite, tray and notifications. Created once at startup.
 */

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function detectProjectFramework(name: string) {
  const entries = await ipc.fs.listProjectEntries(name);
  let packageJson = null;
  const raw = await ipc.fs.readProjectFile(name, "package.json");
  if (raw) {
    try {
      packageJson = JSON.parse(raw);
    } catch {
      packageJson = null;
    }
  }
  return { entries, packageJson, input: { entries, packageJson } };
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
  private notifyPermission = false;

  constructor() {
    this.queue = new DeploymentQueue({
      deployer: createApiDeployer({
        getToken: getAuthToken,
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
      // Held-while-offline changes survive an app restart.
      onDirtyChange: (projectIds) => {
        void ipc.db
          .setSetting("dirty_projects", JSON.stringify(projectIds))
          .catch(() => {});
      },
    });
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
        getAuthToken(),
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
      await writeText(url);
      return true;
    } catch (err) {
      console.error("clipboard copy failed", err);
      return false;
    }
  }

  private notify(title: string, body: string) {
    if (!this.notifyPermission) return;
    try {
      sendNotification({ title, body });
    } catch (err) {
      console.error("notification failed", err);
    }
  }

  private async refreshTray() {
    const { projects, latestByProject, presentOnDisk } = useAppStore.getState();
    await ipc.tray
      .update(
        projects
          .filter((p) => presentOnDisk.has(p.name))
          .map((p) => ({
            name: p.name,
            status: trayStatus(latestByProject[p.id]?.state),
            framework: p.framework,
          })),
      )
      .catch(() => {});
  }

  /**
   * Reconcile the database with what's actually inside the folder:
   *  - new directories become projects (and deploy),
   *  - a disappeared dir + an unknown dir of equal count is treated as a
   *    rename, preserving the Vercel link,
   *  - deleted dirs simply stop being watched; local history stays.
   */
  async reconcile(deployNew = false): Promise<void> {
    const store = useAppStore.getState();
    // Loose .html files copied straight into the root become projects first,
    // so this same pass registers and deploys them.
    const adopted = await ipc.fs.adoptLooseFiles().catch(() => [] as string[]);
    if (adopted.length > 0) {
      log.info("import", `adopted loose files as projects: ${adopted.join(", ")}`);
    }
    const [scanned, projects] = await Promise.all([
      ipc.fs.scanProjects(),
      ipc.db.listProjects(),
    ]);
    const known = new Map(projects.map((p) => [p.name, p]));
    const scannedNames = new Set(scanned.map((s) => s.name));

    const missing = projects.filter((p) => !scannedNames.has(p.name));
    const unknown = scanned.filter((s) => !known.has(s.name));

    // Rename heuristic: exactly one dir vanished and one appeared — but only
    // when the Vercel link file travelled with the folder (or neither side
    // has one). Otherwise it's a delete + an unrelated new project.
    let handledAsRename = false;
    if (missing.length === 1 && unknown.length === 1) {
      const [gone] = missing;
      const [appeared] = unknown;
      const appearedLinkId = parseLinkFile(
        await ipc.fs.readProjectFile(appeared.name, ".vercel/project.json").catch(() => null),
      );
      if (isLegitRename(gone.vercelProjectId, appearedLinkId)) {
        await ipc.db.renameProject(gone.id, appeared.name, appeared.path);
        handledAsRename = true;
      }
    }
    const toDeploy: string[] = [];
    if (!handledAsRename) {
      for (const s of unknown) {
        const { input } = await detectProjectFramework(s.name);
        if (!isDeployable(input)) continue;
        const project = await ipc.db.upsertProject(
          s.name,
          s.path,
          detectFramework(input),
        );
        if (deployNew) toDeploy.push(project.id);
      }
    }

    // Capture the CLI link (projectId) for present projects that lack one —
    // it's the identity signal the rename guard relies on.
    const linked = await ipc.db.listProjects();
    for (const p of linked) {
      if (p.vercelProjectId || !scannedNames.has(p.name)) continue;
      const linkId = parseLinkFile(
        await ipc.fs.readProjectFile(p.name, ".vercel/project.json").catch(() => null),
      );
      if (linkId) await ipc.db.setProjectLink(p.id, linkId).catch(() => {});
    }

    const fresh = await ipc.db.listProjects();
    store.setProjects(fresh);
    store.setPresentOnDisk(scanned.map((s) => s.name));
    for (const p of fresh) {
      if (scannedNames.has(p.name)) {
        void this.refreshGit(p.id);
        void this.checkRemoteIntegration(p.id);
      }
    }
    // Projects no longer on disk: stop watching + cancel in-flight work.
    for (const p of fresh) {
      if (!scannedNames.has(p.name)) this.queue.remove(p.id);
    }
    await this.refreshTray();

    // Deploy AFTER the store knows the new projects — the queue resolves
    // projects through the store, so enqueueing earlier is a silent no-op
    // (the first-drop-never-deployed bug). Route through the gated auto
    // path: git holds, offline holds and the content-digest guard apply.
    for (const id of toDeploy) void this.notifyChangeGitGated(id);
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
  /** Changes held while an account switch awaits resolution. */
  private heldByAccountSwitch = new Set<string>();

  private async notifyChangeGitGated(projectId: string) {
    const project = useAppStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    // Unresolved account switch: linked projects would deploy against the
    // previous account and fail — hold everything until the user chooses.
    if (useAppStore.getState().accountSwitch) {
      this.heldByAccountSwitch.add(projectId);
      return;
    }
    const git = await this.refreshGit(projectId);
    const verdict = shouldHoldAutoDeploy(git, project.lockedBranch);
    if (!verdict.hold) {
      this.clearGitHold(projectId);
      this.queue.notifyChange(projectId);
      return;
    }
    if (git?.operation && !this.gitHoldTimers.has(projectId)) {
      const timer = setInterval(() => {
        void (async () => {
          const fresh = await this.refreshGit(projectId);
          const p = useAppStore.getState().projects.find((x) => x.id === projectId);
          if (!p || !fresh?.operation) {
            this.clearGitHold(projectId);
            if (p && !shouldHoldAutoDeploy(fresh, p.lockedBranch).hold) {
              this.queue.notifyChange(projectId);
            }
          }
        })();
      }, 15_000);
      this.gitHoldTimers.set(projectId, timer);
    }
  }

  private clearGitHold(projectId: string) {
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

  private async handleFsChanges(changes: ipc.FsChange[]) {
    if (useAppStore.getState().watchPaused) return;
    let structural = false;
    for (const change of changes) {
      if (change.kind === "project-added" || change.kind === "project-removed") {
        structural = true;
        continue;
      }
      const project = useAppStore
        .getState()
        .projects.find((p) => p.name === change.project);
      if (project) {
        // Re-detect lazily: a modified package.json can change the framework.
        void this.refreshFramework(project);
        void this.notifyChangeGitGated(project.id);
      } else {
        // Files landed in a dir we don't know yet (e.g. a copy in progress).
        structural = true;
      }
    }
    if (structural) {
      await this.reconcile(true);
    }
  }

  private async refreshFramework(project: Project) {
    try {
      const { input } = await detectProjectFramework(project.name);
      const framework = detectFramework(input);
      if (framework !== project.framework && framework !== "unknown") {
        await ipc.db.setProjectFramework(project.id, framework);
        useAppStore
          .getState()
          .setProjects(await ipc.db.listProjects());
      }
    } catch {
      /* detection is best-effort */
    }
  }

  async start(): Promise<void> {
    const store = useAppStore.getState();

    // Notification permission (macOS prompts once).
    try {
      this.notifyPermission = await isPermissionGranted();
      if (!this.notifyPermission) {
        this.notifyPermission = (await requestPermission()) === "granted";
      }
    } catch {
      this.notifyPermission = false;
    }

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
    await ipc.events.onFsChanged((changes) => void this.handleFsChanges(changes));
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
    await this.startOnlineMonitor();
    await this.drainPersistedDirty();
  }

  /**
   * Changes held during a previous offline session: deploy them now (or
   * re-hold if still offline — notifyChange re-persists in that case).
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

  /**
   * Connectivity monitoring: `navigator.onLine` events give an instant
   * offline signal; a TCP probe to api.vercel.com (via Rust) is the source
   * of truth, since onLine reports true on internet-less LANs. While
   * offline, probes re-run frequently so reconnection is caught fast.
   */
  private startOnlineMonitor(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const applyOnline = (online: boolean) => {
      const was = useAppStore.getState().online;
      if (was !== online) {
        useAppStore.getState().setOnline(online);
        this.queue.setOffline(!online);
        if (online) void this.refreshAuth();
      }
    };

    const probe = async () => {
      const online = navigator.onLine
        ? await ipc.network.checkOnline().catch(() => false)
        : false;
      applyOnline(online);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void probe(), online ? 60_000 : 10_000);
    };

    window.addEventListener("offline", () => applyOnline(false));
    window.addEventListener("online", () => void probe());
    return probe();
  }

  async refreshAuth(): Promise<void> {
    try {
      // getAuthToken() refreshes near-expiry sessions and re-imports from
      // the CLI when the keychain is empty (see core/auth.ts).
      const hadToken = Boolean(await ipc.credentials.getToken().catch(() => null));
      const token = await getAuthToken();
      if (!token) {
        // Last resort: a fresh CLI login the user just completed.
        const imported = await importFromCli();
        if (imported) {
          this.notify(
            "Signed in via Vercel CLI",
            `Using your Vercel CLI session (${imported.username}).`,
          );
          useAppStore.getState().setAuthedAs(imported.username);
          return;
        }
        useAppStore.getState().setAuthedAs(null);
        return;
      }
      const user = await api.run(api.getUser({ token }));
      useAppStore.getState().setAuthedAs(user.username, user.avatarUrl);
      if (!hadToken) {
        this.notify(
          "Signed in via Vercel CLI",
          `Using your Vercel CLI session (${user.username}).`,
        );
      }
      await this.detectAccountSwitch(user.uid, user.username);
    } catch {
      useAppStore.getState().setAuthedAs(null);
    }
  }

  /**
   * The token's owner changed since last session. This is ambiguous: same
   * team, new seat → existing project links still work; different account →
   * they don't. Only the user knows, so surface a banner and wait for an
   * explicit choice (resolveAccountSwitch). Until then, deploys to linked
   * projects may fail with permission errors — annoying but honest.
   */
  private async detectAccountSwitch(uid: string, username: string) {
    try {
      const storedUid = await ipc.db.getSetting("auth_user_id");
      const storedName = (await ipc.db.getSetting("auth_username")) ?? "previous account";
      if (storedUid && storedUid !== uid) {
        useAppStore.getState().setAccountSwitch({ from: storedName, to: username });
        return; // settings update deferred until the user chooses
      }
      if (!storedUid) {
        await ipc.db.setSetting("auth_user_id", uid);
        await ipc.db.setSetting("auth_username", username);
      }
    } catch (err) {
      log.warn("auth", `account-switch detection failed: ${describeError(err)}`);
    }
  }

  /**
   * User chose how to handle the switch. keepLinks = same-team scenario:
   * project links remain valid for the new user. Otherwise unlink every
   * project locally (clear vercel ids, teams, git-integration state and the
   * .vercel link files) so next deploys create fresh projects under the new
   * account. Local history and the old remote projects are untouched.
   */
  async resolveAccountSwitch(keepLinks: boolean): Promise<void> {
    const { accountSwitch, projects } = useAppStore.getState();
    if (!accountSwitch) return;
    if (!keepLinks) {
      for (const p of projects) {
        await ipc.db.setProjectLink(p.id, null).catch(() => {});
        await ipc.db.setProjectTeam(p.id, null).catch(() => {});
        await ipc.db.setRemoteRepo(p.id, "").catch(() => {});
        await ipc.files.removeProjectLink(p.name).catch(() => {});
      }
      this.integrationChecked.clear();
    }
    const token = await getAuthToken();
    if (token) {
      const user = await api.run(api.getUser({ token })).catch(() => null);
      if (user) {
        await ipc.db.setSetting("auth_user_id", user.uid).catch(() => {});
        await ipc.db.setSetting("auth_username", user.username).catch(() => {});
      }
    }
    useAppStore.getState().setAccountSwitch(null);
    useAppStore.getState().setProjects(await ipc.db.listProjects());

    // Deploy the changes that piled up while the banner was open.
    const held = [...this.heldByAccountSwitch];
    this.heldByAccountSwitch.clear();
    for (const id of held) void this.notifyChangeGitGated(id);
  }
}

export const orchestrator = new Orchestrator();
