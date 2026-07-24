import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { make, type HeldChangesShape } from "./held-changes";

/**
 * Tests for the unified hold tracker: overlapping reasons, exactly-once
 * draining, and persistence of the offline component — now against the
 * Effect service (the sync bridge is a thin runSync facade over it).
 */

const makeHarness = Effect.gen(function* () {
  const snapshots: string[][] = [];
  const held: HeldChangesShape = yield* make({
    persistOffline: (ids) => Effect.sync(() => void snapshots.push(ids)),
  });
  return { held, snapshots };
});

describe("HeldChanges", () => {
  it.effect("a project with one reason drains when that reason releases", () =>
    Effect.gen(function* () {
      const { held } = yield* makeHarness;
      yield* held.mark("p1", "offline");
      expect(yield* held.isHeld("p1")).toBe(true);
      expect(yield* held.release("offline")).toEqual(["p1"]);
      expect(yield* held.isHeld("p1")).toBe(false);
    }),
  );

  it.effect(
    "overlapping reasons: releasing one does NOT drain, releasing both drains once",
    () =>
      Effect.gen(function* () {
        const { held } = yield* makeHarness;
        yield* held.mark("p1", "offline");
        yield* held.mark("p1", "account-switch");

        expect(yield* held.release("offline")).toEqual([]); // still held by the switch
        expect(yield* held.isHeld("p1")).toBe(true);
        expect(yield* held.release("account-switch")).toEqual(["p1"]); // drains exactly once
        expect(yield* held.isHeld("p1")).toBe(false);
        // Further releases find nothing.
        expect(yield* held.release("account-switch")).toEqual([]);
        expect(yield* held.release("offline")).toEqual([]);
      }),
  );

  it.effect("release only frees projects holding that reason", () =>
    Effect.gen(function* () {
      const { held } = yield* makeHarness;
      yield* held.mark("p1", "offline");
      yield* held.mark("p2", "git-operation");
      expect(yield* held.release("offline")).toEqual(["p1"]);
      expect(yield* held.isHeld("p2")).toBe(true);
    }),
  );

  it.effect("releaseOne frees a single project, respecting remaining reasons", () =>
    Effect.gen(function* () {
      const { held } = yield* makeHarness;
      yield* held.mark("p1", "git-operation");
      yield* held.mark("p2", "git-operation");
      yield* held.mark("p2", "offline");

      expect(yield* held.releaseOne("p1", "git-operation")).toBe(true);
      expect(yield* held.releaseOne("p2", "git-operation")).toBe(false); // still offline
      expect(yield* held.releaseOne("p2", "offline")).toBe(true);
      expect(yield* held.releaseOne("p2", "offline")).toBe(false); // already free
    }),
  );

  it.effect("persists the offline component on every change, duplicates excluded", () =>
    Effect.gen(function* () {
      const { held, snapshots } = yield* makeHarness;
      yield* held.mark("p1", "offline");
      yield* held.mark("p1", "offline"); // duplicate — no extra emission
      yield* held.mark("p2", "offline");
      yield* held.mark("p2", "account-switch"); // not the offline component
      yield* held.release("offline");
      expect(snapshots).toEqual([["p1"], ["p1", "p2"], []]);
    }),
  );

  it.effect("persists only projects whose reasons include offline", () =>
    Effect.gen(function* () {
      const { held, snapshots } = yield* makeHarness;
      yield* held.mark("p1", "account-switch");
      yield* held.mark("p2", "offline");
      expect(snapshots).toEqual([["p2"]]);
      // Releasing a non-offline reason never touches persistence.
      yield* held.release("account-switch");
      expect(snapshots).toEqual([["p2"]]);
    }),
  );

  it.effect("round-trip: the persisted set can be re-marked after a restart", () =>
    Effect.gen(function* () {
      const a = yield* makeHarness;
      yield* a.held.mark("p1", "offline");
      yield* a.held.mark("p2", "offline");
      const persisted = a.snapshots.at(-1)!;

      // "Restart": a fresh instance re-marks what was persisted.
      const b = yield* makeHarness;
      for (const id of persisted) yield* b.held.mark(id, "offline");
      expect((yield* b.held.release("offline")).sort()).toEqual(["p1", "p2"]);
      expect(b.snapshots.at(-1)).toEqual([]);
    }),
  );

  it.effect("heldBy reports projects per reason", () =>
    Effect.gen(function* () {
      const { held } = yield* makeHarness;
      yield* held.mark("p1", "offline");
      yield* held.mark("p2", "account-switch");
      yield* held.mark("p2", "offline");
      expect(yield* held.heldBy("offline")).toEqual(["p1", "p2"]);
      expect(yield* held.heldBy("account-switch")).toEqual(["p2"]);
      expect(yield* held.heldBy("git-operation")).toEqual([]);
    }),
  );
});
