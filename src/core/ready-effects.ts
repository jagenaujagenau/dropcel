import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describeError, log } from "../lib/log";
import { AccountSessionService } from "./account-session";
import { AppState, type AppStateShape } from "./app-state";
import { checkGitConnection } from "./deployment-actions";
import { Clipboard, Connectivity, Notifier, Tray } from "./effects";
import { Ipc, type IpcShape } from "./ipc";
import { choosePublicUrl, hasStableAddress } from "./public-url";
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
   * and swallowed; callers fire this and move on. */
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

/** Each capture spawns a headless Chromium process (see screenshot.rs); an
 * unbounded fan-out when several deployments go Ready at once (e.g. the
 * first reconcile of a full folder) would spawn one browser per project. */
const MAX_CONCURRENT_SNAPSHOTS = 2;

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
    const snapshotSemaphore = yield* Semaphore.make(MAX_CONCURRENT_SNAPSHOTS);

    const notify = (title: string, body: string): Effect.Effect<void> =>
      notifier.notify(title, body);

    const refreshTray: ReadyEffectsShape["refreshTray"] = Effect.fn("ReadyEffects.refreshTray")(
      function* () {
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
    ): Effect.Effect<{ url: string; stable: boolean }> =>
      Effect.fn("ReadyEffects.resolvePublicUrl")(function* () {
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
        const inputs = {
          deploymentUrl,
          aliases,
          verifiedDomains: domains.filter((d) => d.verified).map((d) => d.domain),
        };
        return { url: choosePublicUrl(inputs), stable: hasStableAddress(inputs) };
      })().pipe(
        // On any failure we know nothing about aliases, so claim stability
        // rather than raise a false "not live" alarm.
        Effect.catch(() => Effect.succeed({ url: deployment.url ?? "", stable: true })),
      );

    /** Put the fresh deployment URL in the clipboard, ready to paste/share. */
    const copyUrlToClipboard = (url: string): Effect.Effect<boolean> =>
      Effect.fn("ReadyEffects.copyUrlToClipboard")(function* () {
        const setting = yield* ipc.db.getSetting("copy_url_on_ready");
        if (setting === "0") return false;
        yield* clipboard.write(url);
        return true;
      })().pipe(
        Effect.catch((err) =>
          Effect.sync(() => {
            log.warn("clipboard", `copy failed: ${describeError(err)}`);
            return false;
          }),
        ),
      );

    /** Best-effort snapshot; without a Chromium-family browser this no-ops.
     * Gated by snapshotSemaphore so simultaneous Ready deployments queue
     * their browser spawns instead of launching one each all at once. */
    const captureSnapshot = (projectId: string, url: string): Effect.Effect<void> =>
      snapshotSemaphore.withPermit(
        Effect.fn("ReadyEffects.captureSnapshot")(function* () {
          const snap = yield* ipc.snapshots.capture(projectId, url);
          yield* SubscriptionRef.update(appState.snapshotByProject, (m) => ({
            ...m,
            [projectId]: snap.dataUrl,
          }));
        })().pipe(
          Effect.catch((err) =>
            Effect.sync(() => log.warn("snapshot", `capture skipped: ${describeError(err)}`)),
          ),
        ),
      );

    const onReady: ReadyEffectsShape["onReady"] = (projectId, deployment, projectName) =>
      Effect.fn("ReadyEffects.onReady")(function* () {
        let url: string | null = deployment.url;
        /**
         * Set when this deployment went live *technically* but not
         * *publicly* — see `hasStableAddress`. Detected by comparing against
         * the address the project already had: a first-ever deploy can
         * legitimately have no alias yet for a moment, but a project that had
         * a stable URL and suddenly doesn't is the Instant-Rollback state,
         * where Vercel has stopped auto-assigning the production domain.
         * Requiring the prior URL is what keeps this from crying wolf.
         */
        let notLiveAt: string | null = null;
        if (deployment.url) {
          const previousPublicUrl = (yield* SubscriptionRef.get(appState.latestByProject))[
            projectId
          ]?.publicUrl;
          const { url: resolved, stable } = yield* resolvePublicUrl(projectId, deployment);
          url = resolved;
          if (!stable && previousPublicUrl && previousPublicUrl !== resolved) {
            notLiveAt = previousPublicUrl;
          }
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
        if (notLiveAt) {
          // Deliberately *not* copied to the clipboard: handing over the
          // per-deployment URL here would let the user share an address that
          // isn't their site, while their real one still serves the version
          // they rolled back to. Say what happened instead.
          yield* notify(
            "Deployed — but not live",
            `${projectName ?? "Project"} built successfully, but ${notLiveAt} still serves the rolled-back version.\nVercel stops auto-assigning the production domain after a rollback — promote this deployment in Vercel to go live again.`,
          );
          return;
        }
        const copied = url ? yield* copyUrlToClipboard(url) : false;
        yield* notify(
          "Deployment Ready",
          `${projectName ?? "Project"}\n${url ?? ""}${copied ? "\nURL copied to clipboard" : ""}`.trim(),
        );
      })().pipe(Effect.catchCause(() => Effect.void));

    const checkRemoteIntegration: ReadyEffectsShape["checkRemoteIntegration"] = (projectId) =>
      Effect.fn("ReadyEffects.checkRemoteIntegration")(function* () {
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
          yield* appState.setProjects(fresh);
        }).pipe(Effect.catch(() => Effect.sync(() => integrationChecked.delete(projectId))));
      })();

    const recordVercelIds: ReadyEffectsShape["recordVercelIds"] = (ourDeploymentId, info) =>
      Effect.fn("ReadyEffects.recordVercelIds")(function* () {
        yield* ipc.db.setDeploymentVercelIds(ourDeploymentId, info.vercelDeploymentId, info.inspectorUrl);
        /**
         * Looked up in `deploymentsByProject` (every deployment) rather than
         * `latestByProject` (only the newest per project).
         *
         * A coalesced follow-up can start before this callback runs, which
         * replaces our deployment as the project's "latest" — and the old
         * lookup then found nothing and returned early, silently skipping
         * everything below it: `setProjectLink`, `setProjectTeam`, and the
         * `.vercel/project.json` write. That file is the identity marker
         * `reconciler`'s `isLegitRename` depends on, so a project that hit
         * this would later lose its history and link on a folder rename —
         * from a race it had no way to report. Nothing retried, because the
         * DB write above had already succeeded.
         */
        const byProject = yield* SubscriptionRef.get(appState.deploymentsByProject);
        let dep: Deployment | undefined;
        for (const list of Object.values(byProject)) {
          dep = list.find((d) => d.id === ourDeploymentId);
          if (dep) break;
        }
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
        yield* appState.setProjects(fresh);
        yield* Effect.forkDetach(checkRemoteIntegration(project.id));
      })().pipe(
        Effect.catch((err) =>
          Effect.sync(() => log.warn("composition", `could not record vercel ids: ${describeError(err)}`)),
        ),
      );

    const onTransition: ReadyEffectsShape["onTransition"] = (projectId, deploymentId, state, info) =>
      Effect.fn("ReadyEffects.onTransition")(function* () {
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
      })().pipe(
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
