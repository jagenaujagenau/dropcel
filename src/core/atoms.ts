import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { AccountSessionService } from "./account-session";
import { AppState, appStateShape } from "./app-state";
import { AppLive, deployProject, managedRuntime, purgeProject, reconcile, refreshAuth, resolveAccountSwitch } from "./composition";
import { Connectivity } from "./effects";
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
export const presentOnDiskAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.presentOnDisk),
);
export const latestByProjectAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.latestByProject),
);
export const deploymentsByProjectAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.deploymentsByProject),
);
export const snapshotByProjectAtom = runtime.subscriptionRef(
  Effect.map(AppState, (s) => s.snapshotByProject),
);
export const gitByProjectAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.gitByProject));
export const rootFolderAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.rootFolder));
export const watchPausedAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.watchPaused));
export const onboardedAtom = runtime.subscriptionRef(Effect.map(AppState, (s) => s.onboarded));

/** Identity + pending account-switch — sourced straight from
 * `AccountSessionService.state` (phase 3), not duplicated in `AppState`. */
export const accountStateAtom = runtime.subscriptionRef(
  Effect.map(AccountSessionService, (s) => s.state),
);

/** Connectivity — sourced straight from `Connectivity.online` (phase 2). */
export const onlineAtom = runtime.subscriptionRef(Effect.map(Connectivity, (c) => c.online));

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

export function setProjectsLocal(projects: Project[]): void {
  Effect.runSync(SubscriptionRef.set(appStateShape.projects, projects));
}

export { deployProject, purgeProject, reconcile, refreshAuth, resolveAccountSwitch };
