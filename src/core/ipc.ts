import { Context, Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import * as raw from "../lib/ipc";

/**
 * The Effect-native IPC boundary. Rust's `{ kind, message }` errors become
 * schema-backed tagged errors here, so everything built on this service gets
 * a typed failure channel instead of a stringly-typed catch. The surface is
 * derived from lib/ipc's Promise groups — command names and argument shapes
 * have exactly one home, and a test layer is just a bag of Promise fakes.
 */

// ---- errors ----------------------------------------------------------------

export class DbError extends Schema.TaggedErrorClass<DbError>()("DbError", {
  message: Schema.String,
}) {}

export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
  message: Schema.String,
}) {}

export class WatchError extends Schema.TaggedErrorClass<WatchError>()("WatchError", {
  message: Schema.String,
}) {}

export class KeychainError extends Schema.TaggedErrorClass<KeychainError>()("KeychainError", {
  message: Schema.String,
}) {}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {}

/** Rust's residual `message` kind, plus anything that isn't an AppError. */
export class IpcDefect extends Schema.TaggedErrorClass<IpcDefect>()("IpcDefect", {
  message: Schema.String,
}) {}

export type IpcError =
  | DbError
  | IoError
  | WatchError
  | KeychainError
  | ValidationError
  | NotFoundError
  | IpcDefect;

const ERROR_BY_KIND = {
  db: DbError,
  io: IoError,
  watch: WatchError,
  keychain: KeychainError,
  validation: ValidationError,
  "not-found": NotFoundError,
} as const;

/** Pure: interpret whatever an invoke rejection carries. */
export function decodeIpcError(u: unknown): IpcError {
  if (typeof u === "object" && u !== null && "kind" in u && "message" in u) {
    // SAFETY: both properties are proven present by the `in` checks above.
    // Their values stay `unknown` — String() accepts anything, so a Rust
    // side that changed the payload's value types would yield a useless
    // string rather than an unsound read.
    const { kind, message } = u as { kind: unknown; message: unknown };
    // SAFETY: `kind` is an arbitrary string, so this index may well miss —
    // which is the point. The lookup is allowed to return undefined and the
    // check below falls back to a defect, so the assertion only satisfies
    // the index signature, it does not claim the key exists.
    const Ctor = ERROR_BY_KIND[String(kind) as keyof typeof ERROR_BY_KIND];
    if (Ctor) return new Ctor({ message: String(message) });
    return new IpcDefect({ message: String(message) });
  }
  if (u instanceof Error) return new IpcDefect({ message: u.message });
  return new IpcDefect({ message: String(u) });
}

// ---- surface derivation ----------------------------------------------------

type AnyPromiseFn = (...args: never[]) => Promise<unknown>;

type Effectified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Effect.Effect<R, IpcError>
    : never;
};

const wrap =
  <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
  (...args: A): Effect.Effect<R, IpcError> =>
    Effect.tryPromise({ try: () => fn(...args), catch: decodeIpcError });

function effectify<T extends Record<string, AnyPromiseFn>>(group: T): Effectified<T> {
  const out: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(group)) {
    // SAFETY: `T extends Record<string, AnyPromiseFn>` guarantees every
    // value is a promise-returning function; Object.entries erases that to
    // the union of T's value types, which cannot be applied generically.
    // `wrap` only ever calls it with the arguments the caller passed on.
    out[k] = wrap(fn as (...args: unknown[]) => Promise<unknown>);
  }
  // SAFETY: `out` was populated with exactly one wrapped entry per key of
  // `group` in the loop above, which is precisely what Effectified<T>
  // describes — a mapped type TypeScript cannot infer from index writes.
  return out as Effectified<T>;
}

/** The Promise groups the service is built from (tests pass fakes). */
export interface RawIpc {
  db: typeof raw.db;
  fs: typeof raw.fs;
  files: typeof raw.files;
  git: typeof raw.git;
  network: typeof raw.network;
  snapshots: typeof raw.snapshots;
  credentials: typeof raw.credentials;
  tray: typeof raw.tray;
}

export interface IpcShape {
  db: Effectified<RawIpc["db"]>;
  fs: Effectified<RawIpc["fs"]>;
  files: Effectified<RawIpc["files"]>;
  git: Effectified<RawIpc["git"]>;
  network: Effectified<RawIpc["network"]>;
  snapshots: Effectified<RawIpc["snapshots"]>;
  credentials: Effectified<RawIpc["credentials"]>;
  tray: Effectified<RawIpc["tray"]>;
}

// Tauri events stay Promise/callback-based in lib/ipc and are used directly
// from there (composition.ts) — not part of this service. `fs:changed` is
// the one exception: watch-stream.ts wraps it in a Stream of its own.

export class Ipc extends Context.Service<Ipc, IpcShape>()("dropcel/core/Ipc") {}

export const make = (groups: RawIpc): IpcShape =>
  Ipc.of({
    db: effectify(groups.db),
    fs: effectify(groups.fs),
    files: effectify(groups.files),
    git: effectify(groups.git),
    network: effectify(groups.network),
    snapshots: effectify(groups.snapshots),
    credentials: effectify(groups.credentials),
    tray: effectify(groups.tray),
  });

export const layerFrom = (groups: RawIpc): Layer.Layer<Ipc> =>
  Layer.succeed(Ipc, make(groups));

export const layer: Layer.Layer<Ipc> = Layer.sync(Ipc, () => make(raw));
