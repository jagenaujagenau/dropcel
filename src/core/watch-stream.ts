import { listen } from "@tauri-apps/api/event";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { FsChange } from "../lib/ipc";

/**
 * `fs:changed` → `Stream<FsChange[]>` → the reconciler, one Tauri batch at a
 * time.
 *
 * Rust already batches filesystem activity into one event per 600ms window,
 * and a single batch can carry structural changes (project-added/-removed)
 * for *several* projects at once — the rename heuristic in reconciler.ts
 * depends on seeing a vanished dir and an appeared dir together in the same
 * `handleFsChanges` call to tell a rename from an unrelated delete+add.
 * Splitting a batch across independent per-project deliveries would let two
 * halves of one rename trigger two concurrent, unserialized `reconcile()`
 * scans racing on the same stale "missing/unknown" snapshot. So batches stay
 * whole and are delivered strictly one at a time (`Stream.runForEach`'s
 * default concurrency): this module only turns the Tauri callback into a
 * Stream for proper scope-based teardown, it adds no new debounce stage and
 * no per-project fan-out. Per-project independence is provided further
 * downstream, by the deploy queue's own per-project debounce (phase 5).
 */

/** One Stream item per Tauri event — the whole batch, undivided, in order. */
export const fsChangeStream: Stream.Stream<FsChange[]> = Stream.callback<FsChange[]>((queue) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      listen<FsChange[]>("fs:changed", (event) => {
        Queue.offerUnsafe(queue, event.payload);
      }),
    ),
    (unlisten) => Effect.sync(unlisten),
  ),
);

export interface WatchStreamOptions {
  /** Called once per Tauri batch, in order — the reconciler's own entry
   * point, which needs the whole batch to make structural decisions. */
  readonly onChanges: (changes: FsChange[]) => Effect.Effect<void>;
  /** Overridable in tests — defaults to the real Tauri-backed stream. */
  readonly source?: Stream.Stream<FsChange[]>;
}

export interface WatchStreamShape {
  /** Idempotent: a second call while already running is a no-op. */
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

export class WatchStream extends Context.Service<WatchStream, WatchStreamShape>()(
  "dropcel/core/WatchStream",
) {}

/**
 * Delivers each Tauri batch to the reconciler in arrival order, one at a
 * time — `Stream.runForEach` waits for `onChanges` to complete before
 * pulling the next batch, so overlapping `reconcile()` calls can't race even
 * under a burst of fs events. The fiber lives in the layer's construction
 * scope, so scope close both interrupts the pump and (via the
 * `fsChangeStream` finalizer) unregisters the Tauri listener.
 */
export const makeWatchStream = Effect.fn("WatchStream.make")(function* (
  options: WatchStreamOptions,
) {
  const source = options.source ?? fsChangeStream;
  const running = yield* Ref.make<Fiber.Fiber<void> | null>(null);
  const scope = yield* Effect.scope;

  const pump = source.pipe(
    Stream.runForEach((changes) => options.onChanges(changes)),
  );

  const start = Effect.gen(function* () {
    if ((yield* Ref.get(running)) !== null) return;
    const fiber = yield* Effect.forkIn(pump, scope);
    yield* Ref.set(running, fiber);
  });

  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(running, null);
    if (fiber) yield* Fiber.interrupt(fiber);
  });

  return WatchStream.of({ start, stop });
});

export const layer = (options: WatchStreamOptions): Layer.Layer<WatchStream> =>
  Layer.effect(WatchStream, makeWatchStream(options));

// ---- plain-TS bridge (until phase 7 inverts the composition root) ---------

export interface WatchStreamPort {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Wraps the real Tauri-backed stream behind the Promise/callback surface the
 * still-plain orchestrator speaks, mirroring `effects.ts`'s bridges. `start`
 * resolves once the listener is registered and the fiber is running; it does
 * not wait for the stream to end (it never does, until `stop`).
 */
export function createWatchStreamBridge(
  handleFsChanges: (changes: FsChange[]) => Promise<void>,
): WatchStreamPort {
  const runtime = ManagedRuntime.make(
    layer({ onChanges: (changes) => Effect.promise(() => handleFsChanges(changes)) }),
  );
  return {
    start: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const watchStream = yield* WatchStream;
          yield* watchStream.start;
        }),
      ),
    stop: () => {
      void runtime
        .runPromise(
          Effect.gen(function* () {
            const watchStream = yield* WatchStream;
            yield* watchStream.stop;
          }),
        )
        .catch(() => {});
    },
  };
}
