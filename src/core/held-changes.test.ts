import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HeldChangesService, layerFrom } from "./held-changes";

/**
 * Tests for the unified hold tracker: overlapping reasons, exactly-once
 * draining, and persistence of the offline component — against the Effect
 * service, provided through its real `Layer` (`layerFrom` fakes) the same
 * way ipc.test.ts provides `Ipc` (the sync bridge is a thin runSync facade
 * over it).
 */

interface Harness {
  layer: Layer.Layer<HeldChangesService>;
  snapshots: string[][];
}

const makeHarness = (): Harness => {
  const snapshots: string[][] = [];
  const layer = layerFrom({
    persistOffline: (ids) => Effect.sync(() => void snapshots.push(ids)),
  });
  return { layer, snapshots };
};

describe("HeldChanges", () => {
  it.effect("a project with one reason drains when that reason releases", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "offline");
      expect(yield* held.isHeld("p1")).toBe(true);
      expect(yield* held.release("offline")).toEqual(["p1"]);
      expect(yield* held.isHeld("p1")).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "overlapping reasons: releasing one does NOT drain, releasing both drains once",
    () => {
      const h = makeHarness();
      return Effect.gen(function* () {
        const held = yield* HeldChangesService;
        yield* held.mark("p1", "offline");
        yield* held.mark("p1", "account-switch");

        expect(yield* held.release("offline")).toEqual([]); // still held by the switch
        expect(yield* held.isHeld("p1")).toBe(true);
        expect(yield* held.release("account-switch")).toEqual(["p1"]); // drains exactly once
        expect(yield* held.isHeld("p1")).toBe(false);
        // Further releases find nothing.
        expect(yield* held.release("account-switch")).toEqual([]);
        expect(yield* held.release("offline")).toEqual([]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("release only frees projects holding that reason", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "offline");
      yield* held.mark("p2", "git-operation");
      expect(yield* held.release("offline")).toEqual(["p1"]);
      expect(yield* held.isHeld("p2")).toBe(true);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("releaseOne frees a single project, respecting remaining reasons", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "git-operation");
      yield* held.mark("p2", "git-operation");
      yield* held.mark("p2", "offline");

      expect(yield* held.releaseOne("p1", "git-operation")).toBe(true);
      expect(yield* held.releaseOne("p2", "git-operation")).toBe(false); // still offline
      expect(yield* held.releaseOne("p2", "offline")).toBe(true);
      expect(yield* held.releaseOne("p2", "offline")).toBe(false); // already free
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("persists the offline component on every change, duplicates excluded", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "offline");
      yield* held.mark("p1", "offline"); // duplicate — no extra emission
      yield* held.mark("p2", "offline");
      yield* held.mark("p2", "account-switch"); // not the offline component
      yield* held.release("offline");
      expect(h.snapshots).toEqual([["p1"], ["p1", "p2"], []]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("persists only projects whose reasons include offline", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "account-switch");
      yield* held.mark("p2", "offline");
      expect(h.snapshots).toEqual([["p2"]]);
      // Releasing a non-offline reason never touches persistence.
      yield* held.release("account-switch");
      expect(h.snapshots).toEqual([["p2"]]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("round-trip: the persisted set can be re-marked after a restart", () => {
    const a = makeHarness();
    const b = makeHarness();
    const programA = Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "offline");
      yield* held.mark("p2", "offline");
      return a.snapshots.at(-1)!;
    }).pipe(Effect.provide(a.layer));

    return Effect.gen(function* () {
      const persisted = yield* programA;

      // "Restart": a fresh instance (fresh layer) re-marks what was persisted.
      yield* Effect.gen(function* () {
        const held = yield* HeldChangesService;
        for (const id of persisted) yield* held.mark(id, "offline");
        expect((yield* held.release("offline")).sort()).toEqual(["p1", "p2"]);
        expect(b.snapshots.at(-1)).toEqual([]);
      }).pipe(Effect.provide(b.layer));
    });
  });

  it.effect("heldBy reports projects per reason", () => {
    const h = makeHarness();
    return Effect.gen(function* () {
      const held = yield* HeldChangesService;
      yield* held.mark("p1", "offline");
      yield* held.mark("p2", "account-switch");
      yield* held.mark("p2", "offline");
      expect(yield* held.heldBy("offline")).toEqual(["p1", "p2"]);
      expect(yield* held.heldBy("account-switch")).toEqual(["p2"]);
      expect(yield* held.heldBy("git-operation")).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });
});
