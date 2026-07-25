import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { GitStatus } from "./git";
import type { HoldReason } from "./held-changes";
import type { Theme } from "../lib/theme";
import type { Account, Deployment, Project } from "./types";

/**
 * UI-facing projection state, Effect-native: every field is a
 * `SubscriptionRef`, written by the reconciler/queue hooks and read by the
 * render layer through `Atom.runtime.subscriptionRef`. SQLite remains the
 * source of truth — this is a cache of it.
 *
 * Identity (`authedAs`, `accountSwitch`) and connectivity (`online`) are
 * *not* here — they already live in `AccountSessionService.state` and
 * `Connectivity.online`, and the render layer reads those directly rather
 * than duplicating them.
 */

export type Route = { name: "dashboard" } | { name: "settings" };

export interface AppStateShape {
  readonly route: SubscriptionRef.SubscriptionRef<Route>;
  readonly projects: SubscriptionRef.SubscriptionRef<Project[]>;
  /** Names of directories currently present inside the root folder. */
  readonly presentOnDisk: SubscriptionRef.SubscriptionRef<Set<string>>;
  readonly latestByProject: SubscriptionRef.SubscriptionRef<Record<string, Deployment | undefined>>;
  readonly deploymentsByProject: SubscriptionRef.SubscriptionRef<Record<string, Deployment[]>>;
  /** Latest site snapshot (PNG data URL) per project. */
  readonly snapshotByProject: SubscriptionRef.SubscriptionRef<Record<string, string | undefined>>;
  /** Vercel accounts this install has seen, by uid — the source for showing
   * whose a project is when more than one account has used this folder. */
  readonly accounts: SubscriptionRef.SubscriptionRef<Record<string, Account>>;
  /** Git state per project (null when not a repo / unknown). */
  readonly gitByProject: SubscriptionRef.SubscriptionRef<Record<string, GitStatus | null>>;
  /** Mirror of HeldChangesService's internal map, broadcast on every change
   * (see held-changes.ts's `onChange` hook) so the render layer can show
   * *why* a project hasn't deployed instead of just the global offline pill. */
  readonly heldByProject: SubscriptionRef.SubscriptionRef<Record<string, HoldReason[]>>;
  readonly rootFolder: SubscriptionRef.SubscriptionRef<string>;
  readonly watchPaused: SubscriptionRef.SubscriptionRef<boolean>;
  /** null while loading, then whether first-run onboarding is complete. */
  readonly onboarded: SubscriptionRef.SubscriptionRef<boolean | null>;
  /** "system" (default) follows the OS; the DOM side effect lives in
   * lib/theme.ts, applied by whoever writes this ref (composition.ts's
   * startup hydration, atoms.ts's setThemeLocal). */
  readonly theme: SubscriptionRef.SubscriptionRef<Theme>;

  /**
   * The two writes below are the only ones that encode real invariants
   * (keeping `deploymentsByProject` and `latestByProject` in sync) — every
   * other field is a bare `SubscriptionRef`; write it directly with
   * `SubscriptionRef.set`/`update` rather than through a 1:1 wrapper (a
   * prior generation of one-line setters here protected nothing — deleting
   * them and inlining the `SubscriptionRef` call at each call site was a
   * no-op refactor, which is exactly the sign they didn't belong).
   */
  readonly upsertDeployment: (d: Deployment) => Effect.Effect<void>;
  readonly setDeployments: (projectId: string, list: Deployment[]) => Effect.Effect<void>;
  /**
   * Replace the projects list, but only if it actually differs.
   *
   * Every writer here re-reads the whole list from SQLite, so each one hands
   * over a freshly-allocated array of freshly-allocated objects — never
   * reference-equal to the last, even when nothing changed. `Dashboard` reads
   * this list and renders a card per entry, so each write re-rendered every
   * card in the app. That's frequent: `checkRemoteIntegration` and
   * `refreshFramework` each do a `listProjects()` + set *per project* during a
   * reconcile, so reconciling N projects produced N full-dashboard re-renders,
   * almost all of them returning identical rows.
   *
   * The comparison is field-wise and shallow because `Project` is entirely
   * primitives and nulls. Note this is the mirror image of the trick the
   * per-project atoms in `atoms.ts` rely on: they preserve references on the
   * *read* side, and this preserves them on the *write* side.
   */
  readonly setProjects: (list: Project[]) => Effect.Effect<void>;
}

/** Shallow field-wise equality — `Project` has no nested values. */
function sameProject(a: Project, b: Project): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.path === b.path &&
    a.framework === b.framework &&
    a.vercelProjectId === b.vercelProjectId &&
    a.autoDeploy === b.autoDeploy &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.lockedBranch === b.lockedBranch &&
    a.remoteRepo === b.remoteRepo &&
    a.teamId === b.teamId
  );
}

export class AppState extends Context.Service<AppState, AppStateShape>()(
  "dropcel/core/AppState",
) {}

export const make: Effect.Effect<AppStateShape> = Effect.gen(function* () {
  const route = yield* SubscriptionRef.make<Route>({ name: "dashboard" });
  const projects = yield* SubscriptionRef.make<Project[]>([]);
  const presentOnDisk = yield* SubscriptionRef.make<Set<string>>(new Set());
  const latestByProject = yield* SubscriptionRef.make<Record<string, Deployment | undefined>>({});
  const deploymentsByProject = yield* SubscriptionRef.make<Record<string, Deployment[]>>({});
  const snapshotByProject = yield* SubscriptionRef.make<Record<string, string | undefined>>({});
  const accounts = yield* SubscriptionRef.make<Record<string, Account>>({});
  const gitByProject = yield* SubscriptionRef.make<Record<string, GitStatus | null>>({});
  const heldByProject = yield* SubscriptionRef.make<Record<string, HoldReason[]>>({});
  const rootFolder = yield* SubscriptionRef.make("");
  const watchPaused = yield* SubscriptionRef.make(false);
  const onboarded = yield* SubscriptionRef.make<boolean | null>(null);
  const theme = yield* SubscriptionRef.make<Theme>("system");

  const upsertDeployment = (d: Deployment) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.update(deploymentsByProject, (m) => {
        const list = m[d.projectId] ?? [];
        const idx = list.findIndex((x) => x.id === d.id);
        const next = idx >= 0 ? [...list.slice(0, idx), d, ...list.slice(idx + 1)] : [d, ...list];
        return { ...m, [d.projectId]: next };
      });
      yield* SubscriptionRef.update(latestByProject, (m) => {
        const current = m[d.projectId];
        // "Latest" has to mean newest-started, not last-written. Transitions
        // arrive on independent, unordered fibers, so a straggling `canceled`
        // for a superseded deployment could otherwise replace the in-flight
        // one the user is actually watching — the card and tray would jump
        // backwards to a finished older run. Comparing `startedAt` (RFC 3339
        // UTC, so lexicographic order is chronological) keeps the newer one.
        if (current && current.id !== d.id && current.startedAt > d.startedAt) return m;
        return { ...m, [d.projectId]: d };
      });
    });

  const setDeployments = (projectId: string, list: Deployment[]) =>
    Effect.gen(function* () {
      yield* SubscriptionRef.update(deploymentsByProject, (m) => ({ ...m, [projectId]: list }));
      yield* SubscriptionRef.update(latestByProject, (m) => ({ ...m, [projectId]: list[0] }));
    });

  const setProjects = (list: Project[]) =>
    SubscriptionRef.update(projects, (current) =>
      current.length === list.length && current.every((p, i) => sameProject(p, list[i]!))
        ? current
        : list,
    );

  return AppState.of({
    route,
    projects,
    setProjects,
    presentOnDisk,
    latestByProject,
    deploymentsByProject,
    snapshotByProject,
    accounts,
    gitByProject,
    heldByProject,
    rootFolder,
    watchPaused,
    onboarded,
    theme,

    upsertDeployment,
    setDeployments,
  });
});

/**
 * Built once, synchronously (every field is a bare `SubscriptionRef` — no
 * external dependency), so the composition root can close over the concrete
 * shape directly wherever a hook needs a synchronous read/write instead of
 * going through `Context`.
 */
export const appStateShape: AppStateShape = Effect.runSync(make);

export const layer: Layer.Layer<AppState> = Layer.succeed(AppState, appStateShape);
