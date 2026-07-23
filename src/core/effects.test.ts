import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectivityMonitor, type ConnectivityDeps } from "./effects";

/**
 * Tests for the connectivity monitor's policy: instant offline signal,
 * probe as source of truth, 60s online / 10s offline cadence.
 */

function makeHarness(overrides: Partial<ConnectivityDeps> = {}) {
  let probeResult = true;
  let instant = true;
  let handlers = { onOffline: () => {}, onOnline: () => {} };
  const changes: boolean[] = [];
  const h = {
    probes: 0,
    changes,
    setProbeResult: (v: boolean) => (probeResult = v),
    setInstant: (v: boolean) => (instant = v),
    fireOffline: () => handlers.onOffline(),
    fireOnline: () => handlers.onOnline(),
    monitor: undefined as unknown as ConnectivityMonitor,
  };
  h.monitor = new ConnectivityMonitor({
    probe: async () => {
      h.probes += 1;
      return probeResult;
    },
    instantOnline: () => instant,
    subscribe: (hs) => (handlers = hs),
    ...overrides,
  });
  h.monitor.onChange((online) => changes.push(online));
  return h;
}

describe("ConnectivityMonitor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts optimistic and emits nothing while the probe agrees", async () => {
    const h = makeHarness();
    await h.monitor.start();
    expect(h.probes).toBe(1);
    expect(h.changes).toEqual([]);
    expect(h.monitor.isOnline()).toBe(true);
  });

  it("re-probes every 60s while online", async () => {
    const h = makeHarness();
    await h.monitor.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.probes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.probes).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.probes).toBe(3);
  });

  it("tightens the cadence to 10s while offline and recovers", async () => {
    const h = makeHarness();
    h.setProbeResult(false);
    await h.monitor.start();
    expect(h.changes).toEqual([false]);
    // Offline: 10s probes, not 60s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.probes).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.probes).toBe(3);
    // Connection returns → next probe flips us online, cadence relaxes.
    h.setProbeResult(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.changes).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.probes).toBe(4); // no 10s probe anymore
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.probes).toBe(5);
  });

  it("the instant offline event flips state without waiting for a probe", async () => {
    const h = makeHarness();
    await h.monitor.start();
    h.fireOffline();
    expect(h.changes).toEqual([false]);
    expect(h.monitor.isOnline()).toBe(false);
  });

  it("the instant online event triggers a probe as source of truth", async () => {
    const h = makeHarness();
    await h.monitor.start();
    h.fireOffline();
    // navigator says online again — but only the probe decides.
    h.setProbeResult(false);
    h.fireOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toEqual([false]); // still offline
    h.setProbeResult(true);
    h.fireOnline();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.changes).toEqual([false, true]);
  });

  it("skips the probe entirely while navigator reports offline", async () => {
    const h = makeHarness();
    h.setInstant(false);
    await h.monitor.start();
    expect(h.probes).toBe(0);
    expect(h.changes).toEqual([false]);
    // Still offline cadence — re-checks navigator every 10s.
    h.setInstant(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.probes).toBe(1);
    expect(h.changes).toEqual([false, true]);
  });

  it("emits only on change, never on repeats", async () => {
    const h = makeHarness();
    h.setProbeResult(false);
    await h.monitor.start();
    h.fireOffline();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.changes).toEqual([false]);
  });

  it("stop() halts the probe loop", async () => {
    const h = makeHarness();
    await h.monitor.start();
    h.monitor.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.probes).toBe(1);
  });
});
