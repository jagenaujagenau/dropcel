import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describeError, log } from "../lib/log";
import { AccountSessionService } from "./account-session";
import { AppState, type AppStateShape } from "./app-state";
import { checkGitConnection } from "./deployment-actions";
import { Clipboard, Connectivity, Notifier, Tray } from "./effects";
import { Ipc, type IpcShape } from "./ipc";
import { choosePublicUrl } from "./public-url";
import type { TransitionInfo } from "./queue";
import type { Deployment, DeploymentState } from "./types";
import * as api from "./vercel-api";

/**
 * "A Deployment that reaches ready resolves the Public URL and refreshes the
 * effects seams" (CONTEXT.md) — this module is that concept. It owns the
 * full post-transition sequence: persisting a state change, and — once a
 * deployment reaches `ready` — resolving the public URL, persisting it,
 * capturing a dashboard snapshot, copying it to the clipboard, and
 * notifying. It also owns the two smaller "a deployment told us something
 * new" side effects that don't belong anywhere else: recording the Vercel
 * ids a deployment was assigned, and the one-time git-integration check.
 *
 * Every internal ordering (persist → tray → log → dispatch; resolve URL →
 * persist if different → snapshot → clipboard → notify) is preserved
 * exactly from the pre-extraction `composition.ts` — only the seam moved.
 */

export interface RecordVercelIdsInfo {
  vercelDeploymentId: string;
  inspectorUrl: string | null;
  vercelProjectId: string | null;
  ownerId: string | null;
}

export interface ReadyEffectsShape {
  /** Persist + broadcast a deployment's state change, then dispatch the
   * ready/failed follow-up. Never fails — every internal error is logged
   * and swallowed, matching the original orchestrator's fire-and-forget
   * `void persistTransition(...)` call site. */
  readonly onTransition: (
    projectId: string,
    deploymentId: string,
    state: DeploymentState,
    info?: TransitionInfo,
  ) => Effect.Effect<void>;
  /** A deployment is live: resolve its public URL, persist it, snapshot,
   * copy to clipboard, notify. */
  readonly onReady: (
    projectId: string,
    deployment: Deployment,
    projectName: string | undefined,
  ) => Effect.Effect<void>;
  /** The API assigned real identifiers to a deployment. */
  readonly recordVercelIds: (
    ourDeploymentId: string,
    info: RecordVercelIdsInfo,
  ) => Effect.Effect<void>;
  /** One-time check: does this Vercel project already deploy on git push? */
  readonly checkRemoteIntegration: (projectId: string) => Effect.Effect<void>;
  readonly refreshTray: () => Effect.Effect<void>;
  /** "Start Fresh" account-switch resolution: every project's integration
   * check should run again under the new account. */
  readonly resetIntegrationChecks: () => Effect.Effect<void>;
}

export class ReadyEffects extends Context.Service<ReadyEffects, ReadyEffectsShape>()(
  "dropcel/core/ReadyEffects",
) {}

function trayStatus(state: string | undefined): "ready" | "failed" | "deploying" | "idle" {
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

export const make = (deps: {
  ipc: IpcShape;
  appState: AppStateShape;
}) =>
  Effect.gen(function* () {
    const tray = yield* Tray;
    const notifier = yield* Notifier;
    const clipboard = yield* Clipboard;
    const connectivity = yield* Connectivity;
    const accountSession = yield* AccountSessionService;
    const { ipc, appState } = deps;

    /** Tracks projects whose git-integration status was already checked this
     * session — never checked twice, cleared on a fresh-start account switch
     * resolution (see composition.ts's `onFreshStart` hook). */
    const integrationChecked = new Set<string>();

    const notify = (title: string, body: string): Effect.Effect<void> =>
      notifier.notify(title, body);

    const refreshTray: ReadyEffectsShape["refreshTray"] = () =>
      Effect.gen(function* () {
        const projects = yield* SubscriptionRef.get(appState.projects);
        const latestByProject = yield* SubscriptionRef.get(appState.latestByProject);
        const presentOnDisk = yield* SubscriptionRef.get(appState.presentOnDisk);
        yield* tray.update(
          projects
            .filter((p) => presentOnDisk.has(p.name))
            .map((p) => ({
              name: p.name,
              status: trayStatus(latestByProject[p.id]?.state),
              framework: p.framework,
            })),
        );
      });

    /**
     * The unique deployment URL is guarded by Deployment Protection; the
     * stable aliases are the public face of the project. Prefer a verified
     * custom domain, then the project's *.vercel.app alias.
     */
    const resolvePublicUrl = (
      projectId: string,
      deployment: Deployment,
    ): Effect.Effect<string> =>
      Effect.gen(function* () {
        const deploymentUrl = deployment.url ?? "";
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === projectId,
        );
        const domains = yield* ipc.db.listDomains(projectId).pipe(Effect.catch(() => Effect.succeed([])));
        const token = yield* accountSession.getToken;
        let aliases: string[] = [];
        const dplId =
          deployment.vercelDeploymentId ??
          (yield* SubscriptionRef.get(appState.latestByProject))[projectId]?.vercelDeploymentId;
        if (token && dplId) {
          const fresh = yield* Effect.tryPromise(() =>
            api.run(api.getDeployment({ token, teamId: project?.teamId }, dplId)),
          ).pipe(Effect.catch(() => Effect.succeed(null)));
          if (fresh) aliases = fresh.aliases;
        }
        return choosePublicUrl({
          deploymentUrl,
          aliases,
          verifiedDomains: domains.filter((d) => d.verified).map((d) => d.domain),
        });
      }).pipe(Effect.catch(() => Effect.succeed(deployment.url ?? "")));

    /** Put the fresh deployment URL in the clipboard, ready to paste/share. */
    const copyUrlToClipboard = (url: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const setting = yield* ipc.db.getSetting("copy_url_on_ready");
        if (setting === "0") return false;
        yield* clipboard.write(url);
        return true;
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            console.error("clipboard copy failed", err);
            return false;
          }),
        ),
      );

    /** Best-effort snapshot; without a Chromium-family browser this no-ops. */
    const captureSnapshot = (projectId: string, url: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const snap = yield* ipc.snapshots.capture(projectId, url);
        yield* SubscriptionRef.update(appState.snapshotByProject, (m) => ({
          ...m,
          [projectId]: snap.dataUrl,
        }));
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => log.warn("snapshot", `capture skipped: ${describeError(err)}`)),
        ),
      );

    const onReady: ReadyEffectsShape["onReady"] = (projectId, deployment, projectName) =>
      Effect.gen(function* () {
        let url: string | null = deployment.url;
        if (deployment.url) {
          const resolved = yield* resolvePublicUrl(projectId, deployment);
          url = resolved;
          if (resolved !== deployment.url) {
            yield* Effect.gen(function* () {
              yield* ipc.db.setDeploymentPublicUrl(deployment.id, resolved);
              const dep = (yield* SubscriptionRef.get(appState.latestByProject))[projectId];
              if (dep?.id === deployment.id) {
                yield* appState.upsertDeployment({ ...dep, publicUrl: resolved });
              }
            }).pipe(
              Effect.catch((err) =>
                Effect.sync(() =>
                  log.warn("composition", `could not persist public url: ${describeError(err)}`),
                ),
              ),
            );
          }
          yield* Effect.forkDetach(captureSnapshot(projectId, resolved));
        }
        const copied = url ? yield* copyUrlToClipboard(url) : false;
        yield* notify(
          "Deployment Ready",
          `${projectName ?? "Project"}\n${url ?? ""}${copied ? "\nURL copied to clipboard" : ""}`.trim(),
        );
      }).pipe(Effect.catchCause(() => Effect.void));

    const checkRemoteIntegration: ReadyEffectsShape["checkRemoteIntegration"] = (projectId) =>
      Effect.gen(function* () {
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === projectId,
        );
        if (!project) return;
        const online = yield* SubscriptionRef.get(connectivity.online);
        if (!project.vercelProjectId || project.remoteRepo || !online) return;
        if (integrationChecked.has(projectId)) return;
        integrationChecked.add(projectId);

        yield* Effect.gen(function* () {
          const repo = yield* Effect.tryPromise(() => checkGitConnection(project));
          yield* ipc.db.setRemoteRepo(projectId, repo ?? "");
          if (repo && project.autoDeploy) {
            yield* ipc.db.setAutoDeploy(projectId, false);
            yield* notify(
              "Auto Deploy Turned Off",
              `${project.name} deploys via ${repo}. Auto deploy turned off — re-enable it anytime.`,
            );
          }
          const fresh = yield* ipc.db.listProjects();
          yield* SubscriptionRef.set(appState.projects, fresh);
        }).pipe(Effect.catch(() => Effect.sync(() => integrationChecked.delete(projectId))));
      });

    const recordVercelIds: ReadyEffectsShape["recordVercelIds"] = (ourDeploymentId, info) =>
      Effect.gen(function* () {
        yield* ipc.db.setDeploymentVercelIds(ourDeploymentId, info.vercelDeploymentId, info.inspectorUrl);
        const latest = yield* SubscriptionRef.get(appState.latestByProject);
        const dep = Object.values(latest).find((d) => d?.id === ourDeploymentId);
        if (!dep) return;
        yield* appState.upsertDeployment({
          ...dep,
          vercelDeploymentId: info.vercelDeploymentId,
          inspectorUrl: info.inspectorUrl,
        });
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === dep.projectId,
        );
        if (!project || !info.vercelProjectId) return;
        const teamId = info.ownerId?.startsWith("team_") ? info.ownerId : null;
        if (!project.vercelProjectId) {
          yield* ipc.db.setProjectLink(project.id, info.vercelProjectId);
          yield* ipc.files
            .writeProjectLink(project.name, info.vercelProjectId, info.ownerId ?? "", project.name)
            .pipe(Effect.ignore);
        }
        if (project.teamId !== teamId) {
          yield* ipc.db.setProjectTeam(project.id, teamId);
        }
        const fresh = yield* ipc.db.listProjects();
        yield* SubscriptionRef.set(appState.projects, fresh);
        yield* Effect.forkDetach(checkRemoteIntegration(project.id));
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => log.warn("composition", `could not record vercel ids: ${describeError(err)}`)),
        ),
      );

    const onTransition: ReadyEffectsShape["onTransition"] = (projectId, deploymentId, state, info) =>
      Effect.gen(function* () {
        const dep = yield* ipc.db.updateDeployment(
          deploymentId,
          state,
          info?.url ?? null,
          info?.error ?? null,
          info?.exitCode ?? null,
        );
        yield* appState.upsertDeployment(dep);
        yield* refreshTray();
        const project = (yield* SubscriptionRef.get(appState.projects)).find(
          (p) => p.id === projectId,
        );
        log.info(
          "deploy",
          `${project?.name ?? projectId} → ${state}${info?.error ? ` (${info.error})` : ""}`,
        );
        if (state === "ready") {
          if (info?.contentDigest) {
            yield* ipc.db
              .setSetting(`content_digest:${projectId}`, info.contentDigest)
              .pipe(Effect.ignore);
          }
          // Fire-and-forget, matching the original `void handleReady(...)` —
          // the transition itself must not wait on URL resolution/clipboard.
          yield* Effect.forkDetach(onReady(projectId, dep, project?.name));
        } else if (state === "failed") {
          yield* notify(
            "Deployment Failed",
            `${project?.name ?? "Project"} — ${info?.error ?? "open the app for details."}`,
          );
        }
      }).pipe(
        Effect.catch((err) =>
          Effect.sync(() => log.error("composition", `failed to persist transition: ${describeError(err)}`)),
        ),
      );

    const resetIntegrationChecks: ReadyEffectsShape["resetIntegrationChecks"] = () =>
      Effect.sync(() => integrationChecked.clear());

    return ReadyEffects.of({
      onTransition,
      onReady,
      recordVercelIds,
      checkRemoteIntegration,
      refreshTray,
      resetIntegrationChecks,
    });
  });

export const layer: Layer.Layer<
  ReadyEffects,
  never,
  Ipc | AppState | Tray | Notifier | Clipboard | Connectivity | AccountSessionService
> = Layer.effect(
  ReadyEffects,
  Effect.gen(function* () {
    const ipc = yield* Ipc;
    const appState = yield* AppState;
    return yield* make({ ipc, appState });
  }),
);
