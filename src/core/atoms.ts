import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { AccountSessionService } from "./account-session";
import { AppState, appStateShape } from "./app-state";
import {
  AppLive,
  checkForUpdates,
  deployProject,
  installUpdateAndRelaunch,
  managedRuntime,
  purgeProject,
  reconcile,
  refreshAuth,
  resolveAccountSwitch,
} from "./composition";
import { Connectivity } from "./effects";
import { Updater } from "./updater";
import { applyTheme, cacheTheme, type Theme } from "../lib/theme";
import type { Route } from "./app-state";
import type { Project } from "./types";

/**
 * The render layer's one `Atom.runtime`, sharing `managedRuntime`'s
 * `Layer.MemoMap` — reading an atom here and calling `managedRuntime.run*`
 * in `composition.ts` resolve to the exact same service instances (same
 * `SubscriptionRef`s, same fibers), never a second copy of the graph.
 */
export const runtime = Atom.context({ memoMap: managedRuntime.memoMap })(AppLive);

// ---- reads: SubscriptionRef-backed atoms -----------------------------------

export const routeAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.route));
export const projectsAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.projects));
/**
 * `presentOnDisk` stays a single whole-`Set` atom rather than a per-project
 * `Atom.family`: its only two readers (`Dashboard`'s `visible` list,
 * `RemovedProjects`'s `ghosts` list) both filter the *entire* projects array
 * against it, so they need the whole set on every render regardless — unlike
 * `latestByProject`/`gitByProject`/`snapshotByProject` below, nothing here
 * reads a single project's membership in isolation. A reconcile also always
 * replaces the whole `Set` (never patches one name in), so there's no
 * reference-preservation trick a family atom could exploit anyway.
 */
export const presentOnDiskAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.presentOnDisk),
);
export const deploymentsByProjectAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.deploymentsByProject),
);
export const rootFolderAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.rootFolder));
export const watchPausedAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.watchPaused));
export const onboardedAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.onboarded));
export const themeAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.theme));

/** Identity + pending account-switch — sourced straight from
 * `AccountSessionService.state`, not duplicated in `AppState`. */
export const accountStateAtom = runtime.subscriptionRef(
  Effect.map(AccountSessionService, (s) => s.state),
);

/** Connectivity — sourced straight from `Connectivity.online`. */
export const onlineAtom = runtime.subscriptionRef(Effect.map(Connectivity, (c) => c.online));

/** Self-update status — sourced straight from `Updater.status`. */
export const updateStatusAtom = runtime.subscriptionRef(Effect.map(Updater, (u) => u.status));

/** The typed failure from the last `acquireToken` cascade — see
 * `account-session.ts`'s `AccountState.lastAuthError` doc comment. Narrowed
 * from `accountStateAtom` rather than re-reading `AccountSessionService.state`
 * a second time, so there is exactly one subscription to that ref. */
export const authErrorAtom = Atom.map(accountStateAtom, (r) =>
  AsyncResult.map(r, (s) => s.lastAuthError),
);

// ---- per-project family atoms ----------------------------------------------
//
// The whole-map atoms `latestByProjectAtom`/`gitByProjectAtom`/
// `snapshotByProjectAtom` used to exist here, resolving `AppState` through an
// *effect* (`Effect.map(AppState, ...)`). That forces `Atom.subscriptionRef`'s
// async overload, which wraps every value in a freshly-allocated
// `AsyncResult.Success` on every emission — so even a component reading only
// its own project's slice re-rendered on every OTHER project's update, because
// the wrapper object was never reference-equal to the previous one.
//
// The family atoms below close over `appStateShape`'s already-constructed
// `SubscriptionRef`s directly instead (the same escape hatch the `set*Local`
// writes above already use) — that takes `Atom.subscriptionRef`'s *synchronous*
// overload, a plain `Writable<A>` with no `AsyncResult` wrapper, because the
// concrete ref is already in hand (see `app-state.ts`: "Built once,
// synchronously... so the composition root can close over the concrete shape
// directly"). A pure `Atom.map` on top reads down to one project's entry.
//
// This *does* achieve genuine per-project isolation, not just a differently
// shaped API — verified against the installed `effect@4.0.0-beta.101` source
// (`AtomRegistry.js`'s `Node.setValue`), not assumed:
//
//   setValue(value) {
//     ...
//     if (Object.is(this._value, value)) { return; }   // <- stops here
//     this._value = value;
//     this.invalidateChildren();                        // <- never reached
//     ...
//   }
//
// Every write to `latestByProject`/`gitByProject`/`snapshotByProject`
// (`app-state.ts`'s `upsertDeployment`/`setDeployments`, `git.ts`,
// `composition.ts`'s snapshot hydration) spread-merges — `{ ...m, [id]: v }` —
// so an *untouched* project's entry keeps the exact same object reference
// across updates. `Atom.map`'s read function (`m => m[projectId]`) then
// recomputes to that same reference, the registry node's `Object.is` check
// short-circuits, and invalidation never reaches the family member's
// subscribers — a `ProjectCard` for project A genuinely does not re-render
// when project B's deployment changes. (This only works because these family
// atoms return the *plain* per-key value, not an `AsyncResult`-wrapped one:
// `AsyncResult.map` — the tool you would reach for to keep the previous
// `useAtomState` shape — always allocates a fresh `Success` wrapper regardless
// of whether the inner value changed, which would silently defeat this exact
// check. `authErrorAtom` above uses `AsyncResult.map` deliberately, because it
// has only two low-traffic readers and needs the `Initial`/waiting semantics
// `useAtomState` expects — the tradeoff only matters at the isolation-critical
// call sites below.)

const latestByProjectRaw = Atom.subscriptionRef(appStateShape.latestByProject);
/**
 * Every project's latest deployment in one read. The per-project family below
 * is the right tool for a card that renders one project; this is for the
 * command palette, which builds URL/log/redeploy actions for *all* projects in
 * a single pass and would otherwise need a hook per project. Re-rendering on
 * any project's change is correct for that consumer — and it's only mounted
 * while the palette is open.
 */
export const latestByProjectAtom = latestByProjectRaw;
/**
 * Project ids ordered by most recent deployment, newest first, joined into one
 * delimited string.
 *
 * A string, not an array, and that is the whole point. The dashboard has to
 * subscribe to something derived from the *whole* map in order to sort by
 * recency, and `Atom.map`'s registry node compares with `Object.is` — a
 * freshly-allocated array would differ on every emission and re-render the
 * entire grid on every deployment tick, which is exactly the whole-map
 * re-render the family atoms above exist to avoid. A primitive compares by
 * value, so the grid re-renders only when the order genuinely changes.
 *
 * Projects with no deployment are absent; the caller ranks them last.
 */
export const projectOrderAtom = Atom.map(latestByProjectRaw, (m) =>
  Object.entries(m)
    .filter(([, d]) => d !== undefined)
    .sort(([, a], [, b]) => Date.parse(b!.startedAt) - Date.parse(a!.startedAt))
    .map(([id]) => id)
    .join(","),
);
/** One project's latest deployment. Read with `useAtomValue` — this is a
 * plain synchronous value, not `AsyncResult`-wrapped (see block comment
 * above), so `useAtomState`'s fallback machinery doesn't apply here. */
export const latestDeploymentAtom = Atom.family((projectId: string) =>
  Atom.map(latestByProjectRaw, (m) => m[projectId]),
);

const gitByProjectRaw = Atom.subscriptionRef(appStateShape.gitByProject);
export const gitStatusAtom = Atom.family((projectId: string) =>
  Atom.map(gitByProjectRaw, (m) => m[projectId] ?? null),
);

const snapshotByProjectRaw = Atom.subscriptionRef(appStateShape.snapshotByProject);
export const projectSnapshotAtom = Atom.family((projectId: string) =>
  Atom.map(snapshotByProjectRaw, (m) => m[projectId]),
);

const heldByProjectRaw = Atom.subscriptionRef(appStateShape.heldByProject);
/** Why a project hasn't deployed — null when it isn't held at all. */
export const heldReasonsAtom = Atom.family((projectId: string) =>
  Atom.map(heldByProjectRaw, (m) => m[projectId] ?? null),
);

/**
 * Read a `SubscriptionRef`-backed atom with a fallback for the brief
 * `Initial` window before the Layer graph finishes mounting (first paint).
 * Every field here settles synchronously in practice (the refs already hold
 * their startup value the moment the service is constructed) — this only
 * covers the render before the atom's first subscription tick.
 */
export function useAtomState<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  initial: A,
): A {
  return AsyncResult.getOrElse(useAtomValue(atom), () => initial);
}

// ---- writes: plain effect dispatch at the React-handler edge ---------------
// The queue already coalesces concurrent enqueue()s per project (its own
// invariant: "a save never produces two deployments"), so no additional
// atom-command concurrency policy is needed for the deploy button — a
// plain `runFork`/`runPromise` call is already spam-safe.

export function setRoute(route: Route): void {
  Effect.runSync(SubscriptionRef.set(appStateShape.route, route));
}

export function setWatchPausedLocal(paused: boolean): void {
  Effect.runSync(SubscriptionRef.set(appStateShape.watchPaused, paused));
}

export function setRootFolderLocal(path: string): void {
  Effect.runSync(SubscriptionRef.set(appStateShape.rootFolder, path));
}

export function setOnboardedLocal(onboarded: boolean): void {
  Effect.runSync(SubscriptionRef.set(appStateShape.onboarded, onboarded));
}

export function setThemeLocal(theme: Theme): void {
  applyTheme(theme);
  cacheTheme(theme);
  Effect.runSync(SubscriptionRef.set(appStateShape.theme, theme));
}

export function setProjectsLocal(projects: Project[]): void {
  Effect.runSync(appStateShape.setProjects(projects));
}

export {
  checkForUpdates,
  deployProject,
  installUpdateAndRelaunch,
  purgeProject,
  reconcile,
  refreshAuth,
  resolveAccountSwitch,
};
