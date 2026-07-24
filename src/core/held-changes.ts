import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { Ipc } from "./ipc";

/**
 * The one owner of "changes waiting to deploy". A project can be held for
 * several overlapping reasons — offline, an unresolved account switch, an
 * in-flight git operation — and it drains exactly once: when its LAST
 * reason is released. The offline component is persisted (dirty_projects
 * setting) so held changes survive an app restart. The state lives in a Ref
 * and every operation is a synchronous Effect, which is what lets the plain
 * bridge below stay a sync surface for the (not yet ported) queue.
 */

export type HoldReason = "offline" | "account-switch" | "git-operation";

export interface HeldChangesOptions {
  /** Persist the offline component; sequenced on every change to it. */
  readonly persistOffline?: (projectIds: string[]) => Effect.Effect<void>;
  /** Broadcast the full per-project reason map on every change — the render
   * layer's one way to show *why* a project is held (see AppState.heldByProject). */
  readonly onChange?: (heldByProject: Record<string, HoldReason[]>) => Effect.Effect<void>;
}

export interface HeldChangesShape {
  readonly mark: (projectId: string, reason: HoldReason) => Effect.Effect<void>;
  /**
   * Release `reason` for every project holding it. Returns the projects now
   * completely free — the ones the caller must drain. Projects still held
   * by another reason stay put (and drain when that reason clears).
   */
  readonly release: (reason: HoldReason) => Effect.Effect<string[]>;
  /** Release `reason` for one project; true when it is now free to drain. */
  readonly releaseOne: (projectId: string, reason: HoldReason) => Effect.Effect<boolean>;
  readonly isHeld: (projectId: string) => Effect.Effect<boolean>;
  readonly heldBy: (reason: HoldReason) => Effect.Effect<string[]>;
}

export class HeldChangesService extends Context.Service<
  HeldChangesService,
  HeldChangesShape
>()("dropcel/core/HeldChanges") {}

export const make = (options: HeldChangesOptions = {}) =>
  Effect.gen(function* () {
    /** projectId → the reasons currently holding it. */
    const holds = yield* Ref.make(new Map<string, Set<HoldReason>>());

    const heldBy = (reason: HoldReason) =>
      Ref.get(holds).pipe(
        Effect.map((map) =>
          [...map.entries()]
            .filter(([, reasons]) => reasons.has(reason))
            .map(([projectId]) => projectId),
        ),
      );

    const persist = Effect.gen(function* () {
      if (!options.persistOffline) return;
      yield* options.persistOffline(yield* heldBy("offline"));
    });

    const broadcast = Effect.gen(function* () {
      if (!options.onChange) return;
      const map = yield* Ref.get(holds);
      const record: Record<string, HoldReason[]> = {};
      for (const [projectId, reasons] of map) record[projectId] = [...reasons];
      yield* options.onChange(record);
    });

    const mark = Effect.fn("HeldChanges.mark")(function* (
      projectId: string,
      reason: HoldReason,
    ) {
      const added = yield* Ref.modify(holds, (map) => {
        let reasons = map.get(projectId);
        if (!reasons) {
          reasons = new Set();
          map.set(projectId, reasons);
        }
        if (reasons.has(reason)) return [false, map] as const;
        reasons.add(reason);
        return [true, map] as const;
      });
      if (added) {
        if (reason === "offline") yield* persist;
        yield* broadcast;
      }
    });

    const release = Effect.fn("HeldChanges.release")(function* (reason: HoldReason) {
      const { freed, touchedOffline, changed } = yield* Ref.modify(holds, (map) => {
        const freed: string[] = [];
        let touchedOffline = false;
        let changed = false;
        for (const [projectId, reasons] of map) {
          if (!reasons.delete(reason)) continue;
          changed = true;
          if (reason === "offline") touchedOffline = true;
          if (reasons.size === 0) {
            map.delete(projectId);
            freed.push(projectId);
          }
        }
        return [{ freed, touchedOffline, changed }, map] as const;
      });
      if (touchedOffline) yield* persist;
      if (changed) yield* broadcast;
      return freed;
    });

    const releaseOne = Effect.fn("HeldChanges.releaseOne")(function* (
      projectId: string,
      reason: HoldReason,
    ) {
      const { removed, freed } = yield* Ref.modify(holds, (map) => {
        const result = { removed: false, freed: false };
        const reasons = map.get(projectId);
        if (reasons?.delete(reason)) {
          result.removed = true;
          if (reasons.size === 0) {
            map.delete(projectId);
            result.freed = true;
          }
        }
        return [result, map] as const;
      });
      if (removed) {
        if (reason === "offline") yield* persist;
        yield* broadcast;
      }
      return freed;
    });

    const isHeld = (projectId: string) =>
      Ref.get(holds).pipe(Effect.map((map) => map.has(projectId)));

    return HeldChangesService.of({ mark, release, releaseOne, isHeld, heldBy });
  });

/** Test/composition seam: a `Layer` built straight from `HeldChangesOptions`
 * fakes, mirroring `ipc.ts`'s `layerFrom` — lets tests provide the service
 * through its real `Layer.effect` wiring instead of hand-calling `make`. */
export const layerFrom = (
  options: HeldChangesOptions = {},
): Layer.Layer<HeldChangesService> => Layer.effect(HeldChangesService, make(options));

/**
 * Real layer: the offline component is persisted through the dirty_projects
 * setting, fire-and-forget (persistence failures must never block a drain).
 */
export const layer: Layer.Layer<HeldChangesService, never, Ipc> = Layer.effect(
  HeldChangesService,
  Effect.gen(function* () {
    const ipc = yield* Ipc;
    return yield* make({
      persistOffline: (projectIds) =>
        ipc.db
          .setSetting("dirty_projects", JSON.stringify(projectIds))
          .pipe(Effect.ignore, Effect.forkDetach, Effect.asVoid),
    });
  }),
);

// ---- sync facade (queue + composition root need synchronous calls) --------

/** The synchronous surface `DeployQueue` needs — satisfied by `HeldChanges`
 * below, or by any `Effect.runSync` bridge over a real `HeldChangesService`
 * built inside the Layer graph. */
export interface HeldChangesSync {
  mark(projectId: string, reason: HoldReason): void;
  release(reason: HoldReason): string[];
  releaseOne(projectId: string, reason: HoldReason): boolean;
  isHeld(projectId: string): boolean;
  heldBy(reason: HoldReason): string[];
}

export interface HeldChangesDeps {
  /** Persist the offline component; called on every change to it. */
  persistOffline?: (projectIds: string[]) => void;
}

/**
 * Synchronous facade over the Effect service — every operation is Ref-only,
 * so `runSync` is safe. Keeps the exact pre-Effect surface the queue and
 * composition root already use.
 */
export class HeldChanges implements HeldChangesSync {
  private readonly shape: HeldChangesShape;

  constructor(deps: HeldChangesDeps = {}) {
    const persistOffline = deps.persistOffline;
    this.shape = Effect.runSync(
      make(
        persistOffline
          ? { persistOffline: (ids) => Effect.sync(() => persistOffline(ids)) }
          : {},
      ),
    );
  }

  mark(projectId: string, reason: HoldReason): void {
    Effect.runSync(this.shape.mark(projectId, reason));
  }

  release(reason: HoldReason): string[] {
    return Effect.runSync(this.shape.release(reason));
  }

  releaseOne(projectId: string, reason: HoldReason): boolean {
    return Effect.runSync(this.shape.releaseOne(projectId, reason));
  }

  isHeld(projectId: string): boolean {
    return Effect.runSync(this.shape.isHeld(projectId));
  }

  heldBy(reason: HoldReason): string[] {
    return Effect.runSync(this.shape.heldBy(reason));
  }
}
