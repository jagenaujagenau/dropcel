import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Connectivity, makeConnectivity } from "./effects";

/**
 * Tests for the connectivity monitor's policy: instant offline signal,
 * probe as source of truth, 60s online / 10s offline cadence — driven
 * through the Effect service via its real `Layer` (fakes go in through
 * `Layer.effect`, the service comes out through `Connectivity` context) with
 * the TestClock instead of fake timers.
 */

interface Harness {
  layer: Layer.Layer<Connectivity>;
  probes: () => number;
  changes: boolean[];
  setProbeResult: (v: boolean) => void;
  setInstant: (v: boolean) => void;
  fireOffline: () => void;
  fireOnline: () => void;
}

const makeHarness = (
  overrides: { onlineIntervalMs?: number; offlineIntervalMs?: number } = {},
): Harness => {
  const state = { probeResult: true, instant: true, probes: 0 };
  let handlers = { onOffline: () => {}, onOnline: () => {} };
  const changes: boolean[] = [];
  const layer = Layer.effect(
    Connectivity,
    makeConnectivity({
      probe: Effect.sync(() => {
        state.probes += 1;
        return state.probeResult;
      }),
      instantOnline: () => state.instant,
      subscribe: (hs) => (handlers = hs),
      onChange: (online) => changes.push(online),
      ...overrides,
    }),
  );
  return {
    layer,
    probes: () => state.probes,
    changes,
    setProbeResult: (v) => (state.probeResult = v),
    setInstant: (v) => (state.instant = v),
    fireOffline: () => handlers.onOffline(),
    fireOnline: () => handlers.onOnline(),
  };
};

/** Let the run fiber react to signals/wakeups before asserting. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

describe("Connectivity", () => {
  it.effect("starts optimistic and emits nothing while the probe agrees", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      yield* monitor.start;
      expect(h.probes()).toBe(1);
      expect(h.changes).toEqual([]);
      expect(yield* SubscriptionRef.get(monitor.online)).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("re-probes every 60s while online", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      yield* monitor.start;
      yield* TestClock.adjust("59999 millis");
      yield* settle;
      expect(h.probes()).toBe(1);
      yield* TestClock.adjust("1 millis");
      yield* settle;
      expect(h.probes()).toBe(2);
      yield* TestClock.adjust("60 seconds");
      yield* settle;
      expect(h.probes()).toBe(3);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("tightens the cadence to 10s while offline and recovers", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      h.setProbeResult(false);
      yield* monitor.start;
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
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the instant offline event flips state without waiting for a probe", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      yield* monitor.start;
      h.fireOffline();
      yield* settle;
      expect(h.changes).toEqual([false]);
      expect(yield* SubscriptionRef.get(monitor.online)).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("the instant online event triggers a probe as source of truth", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      yield* monitor.start;
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
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("skips the probe entirely while navigator reports offline", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      h.setInstant(false);
      yield* monitor.start;
      expect(h.probes()).toBe(0);
      expect(h.changes).toEqual([false]);
      // Still offline cadence — re-checks navigator every 10s.
      h.setInstant(true);
      yield* TestClock.adjust("10 seconds");
      yield* settle;
      expect(h.probes()).toBe(1);
      expect(h.changes).toEqual([false, true]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("emits only on change, never on repeats", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      h.setProbeResult(false);
      yield* monitor.start;
      h.fireOffline();
      yield* settle;
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      expect(h.changes).toEqual([false]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("stop() halts the probe loop", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const monitor = yield* Connectivity;
      yield* monitor.start;
      yield* monitor.stop;
      yield* TestClock.adjust("300 seconds");
      yield* settle;
      expect(h.probes()).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });
});
