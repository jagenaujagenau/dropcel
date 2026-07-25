import { describe, expect, it } from "vitest";
import { runStartup, STARTUP_STEPS, type StartupHooks, type StartupSettings } from "./startup";

/**
 * The boot sequence, finally testable.
 *
 * These are the ordering constraints `composition.ts` documented in prose and
 * could not check: importing that module builds a `ManagedRuntime`, a live
 * Tauri-bound deployer and a process-wide session, so "does a failing
 * reconcile still leave the watcher running?" could only be answered by
 * launching the app and hoping.
 */

const SETTINGS: StartupSettings = {
  rootFolder: "/Users/x/Vercel",
  watchPaused: false,
  onboarded: true,
  theme: "system",
};

interface Recorder {
  hooks: StartupHooks;
  calls: string[];
  errors: { step: string; error: unknown }[];
  published: StartupSettings[];
  pausedWith: boolean[];
}

function recorder(overrides: Partial<StartupHooks> = {}): Recorder {
  const calls: string[] = [];
  const errors: { step: string; error: unknown }[] = [];
  const published: StartupSettings[] = [];
  const pausedWith: boolean[] = [];
  const track = (name: string) => async () => {
    calls.push(name);
  };

  const hooks: StartupHooks = {
    loadSettings: async () => {
      calls.push("loadSettings");
      return SETTINGS;
    },
    publishSettings: (s) => {
      calls.push("publishSettings");
      published.push(s);
    },
    requestNotificationPermission: () => calls.push("requestNotificationPermission"),
    setQueuePaused: async (paused) => {
      calls.push("setQueuePaused");
      pausedWith.push(paused);
    },
    refreshAuth: () => calls.push("refreshAuth"),
    reconcile: track("reconcile"),
    hydrateDeployments: track("hydrateDeployments"),
    hydrateSnapshots: track("hydrateSnapshots"),
    refreshTray: track("refreshTray"),
    startWatchStream: track("startWatchStream"),
    registerEventListeners: track("registerEventListeners"),
    startConnectivity: track("startConnectivity"),
    drainHeldChanges: track("drainHeldChanges"),
    scheduleUpdateCheck: () => calls.push("scheduleUpdateCheck"),
    onStepError: (step, error) => errors.push({ step, error }),
    ...overrides,
  };

  return { hooks, calls, errors, published, pausedWith };
}

describe("runStartup", () => {
  it("runs every step, in order", async () => {
    const r = recorder();
    await runStartup(r.hooks);
    expect(r.calls).toEqual([
      "loadSettings",
      "publishSettings",
      "requestNotificationPermission",
      "setQueuePaused",
      "refreshAuth",
      "reconcile",
      "hydrateDeployments",
      "hydrateSnapshots",
      "refreshTray",
      "startWatchStream",
      "registerEventListeners",
      "startConnectivity",
      "drainHeldChanges",
      "scheduleUpdateCheck",
    ]);
    expect(r.errors).toEqual([]);
    expect(r.published).toEqual([SETTINGS]);
  });

  /**
   * The one that matters. `reconcile` fails for mundane reasons — an unmounted
   * external drive, a macOS TCC denial on the folder — and it used to be one
   * link in an unbroken `await` chain, so when it threw, the watcher never
   * started, connectivity was never established and held changes never
   * drained. The app sat there showing an empty dashboard, not watching the
   * folder, until it was relaunched.
   */
  it("keeps going — and still starts the watcher — when a step throws", async () => {
    const boom = new Error("scan_projects failed");
    const r = recorder({
      reconcile: () => Promise.reject(boom),
    });
    await runStartup(r.hooks);

    expect(r.errors).toEqual([{ step: "initial reconcile", error: boom }]);
    expect(r.calls).toContain("startWatchStream");
    expect(r.calls).toContain("startConnectivity");
    expect(r.calls).toContain("drainHeldChanges");
  });

  it("isolates every step, not just the fragile ones", async () => {
    const failing: Partial<StartupHooks> = {
      hydrateDeployments: () => Promise.reject(new Error("a")),
      hydrateSnapshots: () => Promise.reject(new Error("b")),
      refreshTray: () => Promise.reject(new Error("c")),
      startWatchStream: () => Promise.reject(new Error("d")),
      registerEventListeners: () => Promise.reject(new Error("e")),
      startConnectivity: () => Promise.reject(new Error("f")),
      drainHeldChanges: () => Promise.reject(new Error("g")),
    };
    const r = recorder(failing);
    await runStartup(r.hooks);

    expect(r.errors.map((e) => e.step)).toEqual([
      "hydrate deployments",
      "hydrate snapshots",
      "tray refresh",
      "watch stream",
      "event listeners",
      "connectivity",
      "drain held changes",
    ]);
    // Startup still completes rather than rejecting into `start()`'s
    // last-resort catch.
    expect(r.calls).toContain("scheduleUpdateCheck");
  });

  /**
   * `App.tsx` renders nothing until `onboarded` settles, so a settings load
   * that rejects must not abort startup — that is the one failure with no
   * visible explanation and no way out.
   */
  it("survives a settings load that rejects", async () => {
    const r = recorder({ loadSettings: () => Promise.reject(new Error("db locked")) });
    await runStartup(r.hooks);

    expect(r.errors.map((e) => e.step)).toEqual(["settings"]);
    expect(r.published).toEqual([]);
    // Defaults to not-paused rather than leaving the queue in an unknown
    // state, and everything downstream still runs.
    expect(r.pausedWith).toEqual([false]);
    expect(r.calls).toContain("startWatchStream");
  });

  it("carries the persisted pause state into the queue", async () => {
    const r = recorder({
      loadSettings: async () => ({ ...SETTINGS, watchPaused: true }),
    });
    await runStartup(r.hooks);
    expect(r.pausedWith).toEqual([true]);
  });

  /**
   * Draining is deliberately after connectivity: draining while offline just
   * re-holds (harmless), but knowing the state first avoids doomed deploys on
   * a flaky startup.
   */
  it("establishes connectivity before draining held changes", async () => {
    const r = recorder();
    await runStartup(r.hooks);
    expect(r.calls.indexOf("startConnectivity")).toBeLessThan(
      r.calls.indexOf("drainHeldChanges"),
    );
  });

  /**
   * The notification permission prompt is a system-modal dialog. As the first
   * line of startup it blocked the `onboarded` write behind it, so first
   * launch showed an empty window until the user answered.
   */
  it("publishes settings before asking for notification permission", async () => {
    const r = recorder();
    await runStartup(r.hooks);
    expect(r.calls.indexOf("publishSettings")).toBeLessThan(
      r.calls.indexOf("requestNotificationPermission"),
    );
  });

  it("names its steps consistently with the exported contract", async () => {
    const r = recorder(
      Object.fromEntries(
        (
          [
            "loadSettings",
            "setQueuePaused",
            "reconcile",
            "hydrateDeployments",
            "hydrateSnapshots",
            "refreshTray",
            "startWatchStream",
            "registerEventListeners",
            "startConnectivity",
            "drainHeldChanges",
          ] as const
        ).map((k) => [k, () => Promise.reject(new Error(k))]),
      ),
    );
    await runStartup(r.hooks);
    expect(r.errors.map((e) => e.step)).toEqual([...STARTUP_STEPS]);
  });
});
