import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { FsChange } from "../lib/ipc";
import { WatchStream, layer } from "./watch-stream";

/**
 * Plumbing tests: a fake Tauri-shaped event queue drives the batch pump
 * without touching real Tauri. The service is provided through its real
 * `Layer` (`layer(options)`, same idiom as ipc.test.ts's `layerFrom`)
 * instead of hand-calling `makeWatchStream`. The reconciler's own decision
 * logic is covered in reconciler.test.ts — these only assert that every
 * Tauri batch reaches the handler whole, in arrival order, one at a time,
 * and that scope close actually tears the pump down. Batch atomicity
 * matters: the rename heuristic needs a vanished dir and an appeared dir in
 * the SAME `handleFsChanges` call, so splitting a batch across deliveries
 * would let two halves of one rename race two concurrent `reconcile()`
 * scans.
 */

const change = (project: string, kind: FsChange["kind"] = "modified"): FsChange => ({
  project,
  kind,
});

/** Let forked fibers react to already-offered queue items before asserting. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
});

describe("watch-stream", () => {
  it.effect("delivers a batch to the handler whole, undivided", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<FsChange[]>();
      const received = yield* Ref.make<FsChange[][]>([]);
      const got = yield* Deferred.make<void>();

      const program = Effect.gen(function* () {
        const watchStream = yield* WatchStream;
        yield* watchStream.start;
        // One Tauri event: a structural rename pair for two different
        // projects — this must land as one delivery, not two.
        yield* Queue.offer(source, [
          change("blog", "project-removed"),
          change("journal", "project-added"),
        ]);
        yield* Deferred.await(got);
      });

      yield* program.pipe(
        Effect.provide(
          layer({
            source: Stream.fromQueue(source),
            onChanges: (changes) =>
              Effect.gen(function* () {
                yield* Ref.update(received, (xs) => [...xs, changes]);
                yield* Deferred.succeed(got, undefined);
              }),
          }),
        ),
      );

      const batches = yield* Ref.get(received);
      expect(batches).toHaveLength(1);
      expect(batches[0].map((c) => c.project)).toEqual(["blog", "journal"]);
    }),
  );

  it.effect("delivers successive batches in arrival order, one at a time", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<FsChange[]>();
      const order = yield* Ref.make<string[]>([]);
      const gotTwo = yield* Deferred.make<void>();

      const program = Effect.gen(function* () {
        const watchStream = yield* WatchStream;
        yield* watchStream.start;
        yield* Queue.offer(source, [change("blog")]);
        yield* Queue.offer(source, [change("shop")]);
        yield* Deferred.await(gotTwo);
      });

      yield* program.pipe(
        Effect.provide(
          layer({
            source: Stream.fromQueue(source),
            onChanges: (changes) =>
              Effect.gen(function* () {
                const all = yield* Ref.updateAndGet(order, (xs) => [
                  ...xs,
                  changes[0].project,
                ]);
                if (all.length === 2) yield* Deferred.succeed(gotTwo, undefined);
              }),
          }),
        ),
      );

      expect(yield* Ref.get(order)).toEqual(["blog", "shop"]);
    }),
  );

  it.effect("a slow delivery is not overtaken by the next batch (serial, not concurrent)", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<FsChange[]>();
      const started = yield* Ref.make<string[]>([]);
      const finished = yield* Ref.make<string[]>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const gotBoth = yield* Deferred.make<void>();

      const program = Effect.gen(function* () {
        const watchStream = yield* WatchStream;
        yield* watchStream.start;
        yield* Queue.offer(source, [change("blog")]);
        yield* Deferred.await(firstStarted);
        yield* Queue.offer(source, [change("shop")]);
        // "shop" must not start while "blog"'s delivery is still pending.
        yield* settle;
        expect(yield* Ref.get(started)).toEqual(["blog"]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(gotBoth);
      });

      yield* program.pipe(
        Effect.provide(
          layer({
            source: Stream.fromQueue(source),
            onChanges: (changes) =>
              Effect.gen(function* () {
                const project = changes[0].project;
                yield* Ref.update(started, (xs) => [...xs, project]);
                if (project === "blog") {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                yield* Ref.update(finished, (xs) => [...xs, project]);
                if (project === "shop") yield* Deferred.succeed(gotBoth, undefined);
              }),
          }),
        ),
      );

      expect(yield* Ref.get(finished)).toEqual(["blog", "shop"]);
    }),
  );

  it.effect("stop interrupts delivery: nothing further reaches the handler", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<FsChange[]>();
      const count = yield* Ref.make(0);
      const gotOne = yield* Deferred.make<void>();

      const program = Effect.gen(function* () {
        const watchStream = yield* WatchStream;
        yield* watchStream.start;
        yield* Queue.offer(source, [change("blog")]);
        yield* Deferred.await(gotOne);

        yield* watchStream.stop;
        yield* Queue.offer(source, [change("blog")]);
        yield* Queue.offer(source, [change("blog")]);
        // Give any (unwanted) in-flight delivery a chance to land.
        yield* settle;
      });

      yield* program.pipe(
        Effect.provide(
          layer({
            source: Stream.fromQueue(source),
            onChanges: () =>
              Effect.gen(function* () {
                const n = yield* Ref.updateAndGet(count, (x) => x + 1);
                if (n === 1) yield* Deferred.succeed(gotOne, undefined);
              }),
          }),
        ),
      );

      expect(yield* Ref.get(count)).toBe(1);
    }),
  );

  it.effect("start is idempotent — a second call does not double-deliver", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<FsChange[]>();
      const received = yield* Ref.make<FsChange[][]>([]);
      const got = yield* Deferred.make<void>();

      const program = Effect.gen(function* () {
        const watchStream = yield* WatchStream;
        yield* watchStream.start;
        yield* watchStream.start;
        yield* Queue.offer(source, [change("blog")]);
        yield* Deferred.await(got);
        yield* settle;
      });

      yield* program.pipe(
        Effect.provide(
          layer({
            source: Stream.fromQueue(source),
            onChanges: (changes) =>
              Effect.gen(function* () {
                yield* Ref.update(received, (xs) => [...xs, changes]);
                yield* Deferred.succeed(got, undefined);
              }),
          }),
        ),
      );

      expect(yield* Ref.get(received)).toHaveLength(1);
    }),
  );
});
