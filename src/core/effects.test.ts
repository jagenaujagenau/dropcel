import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { makeConnectivity, type ConnectivityShape } from "./effects";

/**
 * Tests for the connectivity monitor's policy: instant offline signal,
 * probe as source of truth, 60s online / 10s offline cadence — now driven
 * through the Effect service with the TestClock instead of fake timers.
 */

interface Harness {
  monitor: ConnectivityShape;
  probes: () => number;
  changes: boolean[];
  setProbeResult: (v: boolean) => void;
  setInstant: (v: boolean) => void;
  fireOffline: () => void;
  fireOnline: () => void;
}

const makeHarness = (
  overrides: { onlineIntervalMs?: number; offlineIntervalMs?: number } = {},
) =>
  Effect.gen(function* () {
    const state = { probeResult: true, instant: true, probes: 0 };
    let handlers = { onOffline: () => {}, onOnline: () => {} };
    const changes: boolean[] = [];
    const monitor = yield* makeConnectivity({
      probe: Effect.sync(() => {
        state.probes += 1;
        return state.probeResult;
      }),
      instantOnline: () => state.instant,
      subscribe: (hs) => (handlers = hs),
      onChange: (online) => changes.push(online),
      ...overrides,
    });
    const h: Harness = {
      monitor,
      probes: () => state.probes,
      changes,
      setProbeResult: (v) => (state.probeResult = v),
      setInstant: (v) => (state.instant = v),
      fireOffline: () => handlers.onOffline(),
      fireOnline: () => handlers.onOnline(),
    };
    return h;
  });

/** Let the run fiber react to signals/wakeups before asserting. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

const isOnline = (h: Harness) => SubscriptionRef.get(h.monitor.online);

describe("Connectivity", () => {
  it.effect("starts optimistic and emits nothing while the probe agrees", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.monitor.start;
      expect(h.probes()).toBe(1);
      expect(h.changes).toEqual([]);
      expect(yield* isOnline(h)).toBe(true);
    }),
  );

  it.effect("re-probes every 60s while online", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.monitor.start;
      yield* TestClock.adjust("59999 millis");
      yield* settle;
      expect(h.probes()).toBe(1);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      expect(h.probes()).toBe(2);
      yield* TestClock.adjust("60 seconds");
      yield* settle;
      expect(h.probes()).toBe(3);
    }),
  );

  it.effect("tightens the cadence to 10s while offline and recovers", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.setProbeResult(false);
      yield* h.monitor.start;
      expect(h.changes).toEqual([false]);
      // Offline: 10s probes, not 60s.
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.probes()).toBe(2);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.probes()).toBe(3);
      // Connection returns → next probe flips us online, cadence relaxes.
      h.setProbeResult(true);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.changes).toEqual([false, true]);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.probes()).toBe(4); // no 10s probe anymore
      yield* TestClock.adjust("50 seconds");
      yield* settle;
      expect(h.probes()).toBe(5);
    }),
  );

  it.effect("the instant offline event flips state without waiting for a probe", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.monitor.start;
      h.fireOffline();
      yield* settle;
      expect(h.changes).toEqual([false]);
      expect(yield* isOnline(h)).toBe(false);
    }),
  );

  it.effect("the instant online event triggers a probe as source of truth", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.monitor.start;
      h.fireOffline();
      yield* settle;
      // navigator says online again — but only the probe decides.
      h.setProbeResult(false);
      h.fireOnline();
      yield* settle;
      expect(h.changes).toEqual([false]); // still offline
      h.setProbeResult(true);
      h.fireOnline();
      yield* settle;
      expect(h.changes).toEqual([false, true]);
    }),
  );

  it.effect("skips the probe entirely while navigator reports offline", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.setInstant(false);
      yield* h.monitor.start;
      expect(h.probes()).toBe(0);
      expect(h.changes).toEqual([false]);
      // Still offline cadence — re-checks navigator every 10s.
      h.setInstant(true);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.probes()).toBe(1);
      expect(h.changes).toEqual([false, true]);
    }),
  );

  it.effect("emits only on change, never on repeats", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.setProbeResult(false);
      yield* h.monitor.start;
      h.fireOffline();
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      expect(h.changes).toEqual([false]);
    }),
  );

  it.effect("stop() halts the probe loop", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.monitor.start;
      yield* h.monitor.stop;
      yield* TestClock.adjust("300 seconds");
      yield* settle;
      expect(h.probes()).toBe(1);
    }),
  );
});
