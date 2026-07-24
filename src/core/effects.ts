import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { TrayProject } from "../lib/ipc";
import { describeError, log } from "../lib/log";
import { Ipc, layer as ipcLayer } from "./ipc";

/**
 * Effect seams between the orchestrator and the outside world: system
 * notifications, clipboard, tray and connectivity. Each is a Context.Service
 * with a Tauri-backed live layer, so the modules above (orchestrator,
 * reconciler, account session) stay testable with plain fakes. The plain-TS
 * bridges at the bottom keep the (still un-ported) orchestrator's
 * Promise/callback call sites working until phase 7 inverts the root.
 */

// ---- notifications ---------------------------------------------------------

export interface NotifierShape {
  readonly notify: (title: string, body: string) => Effect.Effect<void>;
}

export class Notifier extends Context.Service<Notifier, NotifierShape>()(
  "dropcel/core/Notifier",
) {}

/** Real notifier; owns the permission gate (macOS prompts once). */
export const makeTauriNotifier = Effect.gen(function* () {
  const permission = yield* Effect.tryPromise(async () => {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    return granted;
  }).pipe(Effect.catch(() => Effect.succeed(false)));

  return Notifier.of({
    notify: Effect.fn("Notifier.notify")(function* (title, body) {
      if (!permission) return;
      yield* Effect.sync(() => {
        try {
          sendNotification({ title, body });
        } catch (err) {
          log.warn("notification", `send failed: ${describeError(err)}`);
        }
      });
    }),
  });
});

export const layerNotifier: Layer.Layer<Notifier> = Layer.effect(
  Notifier,
  makeTauriNotifier,
);

// ---- clipboard -------------------------------------------------------------

/** Local-only failure (never crosses a boundary) — Data, not Schema. */
export class ClipboardWriteError extends Data.TaggedError("ClipboardWriteError")<{
  cause: unknown;
}> {}

export interface ClipboardShape {
  readonly write: (text: string) => Effect.Effect<void, ClipboardWriteError>;
}

export class Clipboard extends Context.Service<Clipboard, ClipboardShape>()(
  "dropcel/core/Clipboard",
) {}

export const layerClipboard: Layer.Layer<Clipboard> = Layer.succeed(
  Clipboard,
  Clipboard.of({
    write: (text) =>
      Effect.tryPromise({
        try: () => writeText(text),
        catch: (cause) => new ClipboardWriteError({ cause }),
      }),
  }),
);

// ---- tray ------------------------------------------------------------------

export interface TrayShape {
  /** Tray failures must never break app flow — errors are swallowed here. */
  readonly update: (projects: TrayProject[]) => Effect.Effect<void>;
}

export class Tray extends Context.Service<Tray, TrayShape>()("dropcel/core/Tray") {}

export const layerTray: Layer.Layer<Tray, never, Ipc> = Layer.effect(
  Tray,
  Effect.gen(function* () {
    const ipc = yield* Ipc;
    return Tray.of({
      update: (projects) => ipc.tray.update(projects).pipe(Effect.ignore),
    });
  }),
);

// ---- connectivity ----------------------------------------------------------

const ONLINE_INTERVAL_MS = 60_000;
const OFFLINE_INTERVAL_MS = 10_000;

type ConnectivitySignal = "went-offline" | "probe-now";

export interface ConnectivityOptions {
  /** Source of truth: can we actually reach api.vercel.com? */
  readonly probe: Effect.Effect<boolean, unknown>;
  /** Instant (but optimistic) signal — `navigator.onLine`. */
  readonly instantOnline: () => boolean;
  /** Wire the instant online/offline events (window listeners). */
  readonly subscribe: (handlers: {
    onOffline: () => void;
    onOnline: () => void;
  }) => void;
  /** Emit-on-change sink; startup default is optimistic `true`. */
  readonly onChange?: (online: boolean) => void;
  readonly onlineIntervalMs?: number;
  readonly offlineIntervalMs?: number;
}

export interface ConnectivityShape {
  /** Matches the store's optimistic default so startup emits only real changes. */
  readonly online: SubscriptionRef.SubscriptionRef<boolean>;
  /** Wire instant events, run the first probe (resolves after it), keep probing. */
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

export class Connectivity extends Context.Service<Connectivity, ConnectivityShape>()(
  "dropcel/core/Connectivity",
) {}

/**
 * Dual-source connectivity monitor: the instant signal flips us offline
 * immediately, while the probe is the source of truth (onLine reports true
 * on internet-less LANs). While offline, probes re-run every 10s so
 * reconnection is caught fast; while online, every 60s. One run() fiber owns
 * the cadence — instant events arrive as signals on a queue, and stopping is
 * fiber interruption (the fiber lives in the construction scope, so closing
 * that scope tears the loop down too).
 */
export const makeConnectivity = Effect.fn("Connectivity.make")(function* (
  options: ConnectivityOptions,
) {
  const onlineMs = options.onlineIntervalMs ?? ONLINE_INTERVAL_MS;
  const offlineMs = options.offlineIntervalMs ?? OFFLINE_INTERVAL_MS;
  const online = yield* SubscriptionRef.make(true);
  const signals = yield* Queue.unbounded<ConnectivitySignal>();
  const firstProbe = yield* Deferred.make<void>();
  const running = yield* Ref.make<Fiber.Fiber<never> | null>(null);
  const scope = yield* Effect.scope;

  const apply = (value: boolean) =>
    Effect.gen(function* () {
      if ((yield* SubscriptionRef.get(online)) === value) return;
      yield* SubscriptionRef.set(online, value);
      options.onChange?.(value);
    });

  /** Skips the probe entirely while navigator reports offline. */
  const probeOnce = Effect.gen(function* () {
    const result = options.instantOnline()
      ? yield* options.probe.pipe(Effect.catch(() => Effect.succeed(false)))
      : false;
    yield* apply(result);
    yield* Deferred.succeed(firstProbe, undefined);
  });

  const run = Effect.gen(function* () {
    while (true) {
      yield* probeOnce;
      // Wait for the cadence to elapse or an instant event. An offline event
      // flips state without probing (the probe would race the dead network);
      // an online event probes immediately — navigator is only a hint, the
      // probe decides.
      let waiting = true;
      while (waiting) {
        const interval = (yield* SubscriptionRef.get(online)) ? onlineMs : offlineMs;
        const signal = yield* Effect.raceFirst(
          Effect.as(Effect.sleep(interval), "probe-now" as ConnectivitySignal),
          Queue.take(signals),
        );
        if (signal === "probe-now") waiting = false;
        else yield* apply(false);
      }
    }
  }) as Effect.Effect<never>;

  const start = Effect.gen(function* () {
    if ((yield* Ref.get(running)) === null) {
      options.subscribe({
        onOffline: () => void Queue.offerUnsafe(signals, "went-offline"),
        onOnline: () => void Queue.offerUnsafe(signals, "probe-now"),
      });
      const fiber = yield* Effect.forkIn(run, scope);
      yield* Ref.set(running, fiber);
    }
    yield* Deferred.await(firstProbe);
  });

  const stop = Effect.gen(function* () {
    const fiber = yield* Ref.getAndSet(running, null);
    if (fiber) yield* Fiber.interrupt(fiber);
  });

  return Connectivity.of({ online, start, stop });
});

export const layerConnectivity = (
  options?: Partial<ConnectivityOptions>,
): Layer.Layer<Connectivity, never, Ipc> =>
  Layer.effect(
    Connectivity,
    Effect.gen(function* () {
      const ipc = yield* Ipc;
      return yield* makeConnectivity({
        probe: ipc.network.checkOnline(),
        instantOnline: () => navigator.onLine,
        subscribe: ({ onOffline, onOnline }) => {
          window.addEventListener("offline", onOffline);
          window.addEventListener("online", onOnline);
        },
        ...options,
      });
    }),
  );

// ---- plain-TS bridges (until phase 7 inverts the composition root) ---------

export interface NotifierBridge {
  /** Triggers the permission gate (macOS prompts once). */
  init(): Promise<void>;
  notify(title: string, body: string): void;
}

export interface ClipboardPort {
  write(text: string): Promise<void>;
}

export interface TrayPort {
  update(projects: TrayProject[]): Promise<void>;
}

export interface ConnectivityBridge {
  onChange(cb: (online: boolean) => void): void;
  isOnline(): boolean;
  /** Runs the first probe immediately, then the fiber keeps probing forever. */
  start(): Promise<void>;
  stop(): void;
}

export interface EffectsBridges {
  notifier: NotifierBridge;
  clipboard: ClipboardPort;
  tray: TrayPort;
  connectivity: ConnectivityBridge;
}

/**
 * Build the Tauri-backed services once and expose them behind the exact
 * Promise/callback surfaces the plain orchestrator already speaks. The
 * connectivity listeners are wired synchronously through the service's
 * onChange sink, so a first probe that lands offline is never missed.
 */
export function createTauriEffects(): EffectsBridges {
  const listeners: ((online: boolean) => void)[] = [];
  let online = true;

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      layerNotifier,
      layerClipboard,
      layerTray,
      layerConnectivity({
        onChange: (value) => {
          online = value;
          for (const cb of listeners) cb(value);
        },
      }),
    ).pipe(Layer.provideMerge(ipcLayer)),
  );

  return {
    notifier: {
      init: () =>
        runtime.runPromise(
          Effect.gen(function* () {
            yield* Notifier;
          }),
        ),
      notify: (title, body) => {
        void runtime
          .runPromise(
            Effect.gen(function* () {
              const notifier = yield* Notifier;
              yield* notifier.notify(title, body);
            }),
          )
          .catch(() => {});
      },
    },
    clipboard: {
      write: (text) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const clipboard = yield* Clipboard;
            yield* clipboard.write(text);
          }),
        ),
    },
    tray: {
      update: (projects) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const tray = yield* Tray;
            yield* tray.update(projects);
          }),
        ),
    },
    connectivity: {
      onChange: (cb) => listeners.push(cb),
      isOnline: () => online,
      start: () =>
        runtime.runPromise(
          Effect.gen(function* () {
            const connectivity = yield* Connectivity;
            yield* connectivity.start;
          }),
        ),
      stop: () => {
        void runtime
          .runPromise(
            Effect.gen(function* () {
              const connectivity = yield* Connectivity;
              yield* connectivity.stop;
            }),
          )
          .catch(() => {});
      },
    },
  };
}
