import { describe, expect, it } from "vitest";
import { HeldChanges } from "./held-changes";

/**
 * Tests for the unified hold tracker: overlapping reasons, exactly-once
 * draining, and persistence of the offline component.
 */

describe("HeldChanges", () => {
  it("a project with one reason drains when that reason releases", () => {
    const held = new HeldChanges();
    held.mark("p1", "offline");
    expect(held.isHeld("p1")).toBe(true);
    expect(held.release("offline")).toEqual(["p1"]);
    expect(held.isHeld("p1")).toBe(false);
  });

  it("overlapping reasons: releasing one does NOT drain, releasing both drains once", () => {
    const held = new HeldChanges();
    held.mark("p1", "offline");
    held.mark("p1", "account-switch");

    expect(held.release("offline")).toEqual([]); // still held by the switch
    expect(held.isHeld("p1")).toBe(true);
    expect(held.release("account-switch")).toEqual(["p1"]); // drains exactly once
    expect(held.isHeld("p1")).toBe(false);
    // Further releases find nothing.
    expect(held.release("account-switch")).toEqual([]);
    expect(held.release("offline")).toEqual([]);
  });

  it("release only frees projects holding that reason", () => {
    const held = new HeldChanges();
    held.mark("p1", "offline");
    held.mark("p2", "git-operation");
    expect(held.release("offline")).toEqual(["p1"]);
    expect(held.isHeld("p2")).toBe(true);
  });

  it("releaseOne frees a single project, respecting remaining reasons", () => {
    const held = new HeldChanges();
    held.mark("p1", "git-operation");
    held.mark("p2", "git-operation");
    held.mark("p2", "offline");

    expect(held.releaseOne("p1", "git-operation")).toBe(true);
    expect(held.releaseOne("p2", "git-operation")).toBe(false); // still offline
    expect(held.releaseOne("p2", "offline")).toBe(true);
    expect(held.releaseOne("p2", "offline")).toBe(false); // already free
  });

  it("persists the offline component on every change, duplicates excluded", () => {
    const snapshots: string[][] = [];
    const held = new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) });
    held.mark("p1", "offline");
    held.mark("p1", "offline"); // duplicate — no extra emission
    held.mark("p2", "offline");
    held.mark("p2", "account-switch"); // not the offline component
    held.release("offline");
    expect(snapshots).toEqual([["p1"], ["p1", "p2"], []]);
  });

  it("persists only projects whose reasons include offline", () => {
    const snapshots: string[][] = [];
    const held = new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) });
    held.mark("p1", "account-switch");
    held.mark("p2", "offline");
    expect(snapshots).toEqual([["p2"]]);
    // Releasing a non-offline reason never touches persistence.
    held.release("account-switch");
    expect(snapshots).toEqual([["p2"]]);
  });

  it("round-trip: the persisted set can be re-marked after a restart", () => {
    const snapshots: string[][] = [];
    const a = new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) });
    a.mark("p1", "offline");
    a.mark("p2", "offline");
    const persisted = snapshots.at(-1)!;

    // "Restart": a fresh instance re-marks what was persisted.
    const b = new HeldChanges({ persistOffline: (ids) => snapshots.push(ids) });
    for (const id of persisted) b.mark(id, "offline");
    expect(b.release("offline").sort()).toEqual(["p1", "p2"]);
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("heldBy reports projects per reason", () => {
    const held = new HeldChanges();
    held.mark("p1", "offline");
    held.mark("p2", "account-switch");
    held.mark("p2", "offline");
    expect(held.heldBy("offline")).toEqual(["p1", "p2"]);
    expect(held.heldBy("account-switch")).toEqual(["p2"]);
    expect(held.heldBy("git-operation")).toEqual([]);
  });
});
