/**
 * What happens when the app launches, and in what order.
 *
 * Split out of `composition.ts` because it is the one piece of that file that
 * is neither wiring nor a one-line adapter: it encodes several real ordering
 * constraints, and every one of them was previously unverifiable. Importing
 * `composition.ts` builds a `ManagedRuntime`, constructs a live deployer bound
 * to Tauri and installs a process-wide session — so there was no way to ask
 * "does a failing reconcile still leave the watcher running?" short of
 * launching the app.
 *
 * Here the sequence takes its side effects as parameters, so a test can hand
 * it recorders and answer exactly that.
 *
 * No Effect, no React, no Tauri: every hook is a plain thunk, because that is
 * what the composition root has on hand at this point — several of these are
 * `runPromise` calls and several are raw IPC.
 */

import type { Theme } from "../lib/theme";

export interface StartupSettings {
  readonly rootFolder: string;
  readonly watchPaused: boolean;
  readonly onboarded: boolean;
  readonly theme: Theme;
}

export interface StartupHooks {
  /**
   * The four persisted settings first paint depends on.
   *
   * Must resolve rather than reject — `App.tsx` renders nothing at all until
   * `onboarded` settles, so a rejection here leaves a permanently blank
   * window: the one failure mode with no visible explanation and no way out.
   * Falling back to defaults shows onboarding, which is both honest about the
   * state and somewhere the user can act.
   */
  readonly loadSettings: () => Promise<StartupSettings>;
  /** Publish them to the projection and apply the theme to the DOM. */
  readonly publishSettings: (settings: StartupSettings) => void;
  /**
   * Mounting the notifier is what triggers macOS's one-time permission
   * prompt. Fire-and-forget, and deliberately *after* settings: as the first
   * line of startup it blocked the `onboarded` write behind a system dialog,
   * so first launch showed an empty window until the user answered it.
   * Nothing in startup needs the result.
   */
  readonly requestNotificationPermission: () => void;
  readonly setQueuePaused: (paused: boolean) => Promise<void>;
  /** Who is signed in. Not awaited — nothing below blocks on identity, and
   * the network call would otherwise sit in front of the first reconcile. */
  readonly refreshAuth: () => void;
  /** Projects that appeared while the app was closed go live on launch —
   * folder = truth. The content-digest guard skips anything unchanged. */
  readonly reconcile: () => Promise<void>;
  readonly hydrateDeployments: () => Promise<void>;
  readonly hydrateSnapshots: () => Promise<void>;
  readonly refreshTray: () => Promise<void>;
  readonly startWatchStream: () => Promise<void>;
  readonly registerEventListeners: () => Promise<void>;
  readonly startConnectivity: () => Promise<void>;
  readonly drainHeldChanges: () => Promise<void>;
  /** Forked with a delay — an update check must never be on the critical
   * path, and nothing at launch waits on it. */
  readonly scheduleUpdateCheck: () => void;
  readonly onStepError: (step: string, error: unknown) => void;
}

/**
 * Run one step, converting failure into a reported error.
 *
 * Startup is a sequence of largely independent steps, and it used to be one
 * unbroken `await` chain — so a single rejection meant every step *after* it
 * silently never ran. `reconcile` alone fails for mundane reasons (an
 * unmounted external drive making the scan fail, a macOS TCC denial on the
 * folder), and the step that pays for it is `startWatchStream` at the end.
 *
 * Losing one step is survivable. Losing the watcher is losing the app.
 */
async function step(hooks: StartupHooks, name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    hooks.onStepError(name, error);
  }
}

/** The names, in order — the sequence's contract, and what its test asserts
 * against so a reordering has to be deliberate. */
export const STARTUP_STEPS = [
  "settings",
  "queue pause state",
  "initial reconcile",
  "hydrate deployments",
  "hydrate snapshots",
  "tray refresh",
  "watch stream",
  "event listeners",
  "connectivity",
  "drain held changes",
] as const;

export async function runStartup(hooks: StartupHooks): Promise<void> {
  let settings: StartupSettings | null = null;
  await step(hooks, "settings", async () => {
    settings = await hooks.loadSettings();
    hooks.publishSettings(settings);
  });

  hooks.requestNotificationPermission();

  await step(hooks, "queue pause state", () =>
    hooks.setQueuePaused(settings?.watchPaused ?? false),
  );

  hooks.refreshAuth();

  await step(hooks, "initial reconcile", () => hooks.reconcile());
  await step(hooks, "hydrate deployments", () => hooks.hydrateDeployments());
  await step(hooks, "hydrate snapshots", () => hooks.hydrateSnapshots());
  await step(hooks, "tray refresh", () => hooks.refreshTray());

  // Wire native events. The watcher is the single most important thing to get
  // running — every step above is guarded precisely so a failure there cannot
  // stop execution from reaching this line.
  await step(hooks, "watch stream", () => hooks.startWatchStream());
  await step(hooks, "event listeners", () => hooks.registerEventListeners());

  // Connectivity BEFORE draining held changes: draining while actually
  // offline would just re-hold them (harmless), but draining after the state
  // is known avoids doomed deploys on flaky startups.
  await step(hooks, "connectivity", () => hooks.startConnectivity());
  await step(hooks, "drain held changes", () => hooks.drainHeldChanges());

  hooks.scheduleUpdateCheck();
}
