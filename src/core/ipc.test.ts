import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DbError,
  IpcDefect,
  Ipc,
  KeychainError,
  NotFoundError,
  ValidationError,
  decodeIpcError,
  layerFrom,
  make,
  type RawIpc,
} from "./ipc";

/**
 * The typed IPC boundary: Rust `{ kind, message }` rejections must surface
 * as the right tagged error, successes must pass through untouched, and the
 * service must be constructible from plain Promise fakes.
 */

describe("decodeIpcError", () => {
  it("maps each Rust kind to its tagged error", () => {
    expect(decodeIpcError({ kind: "db", message: "locked" })).toBeInstanceOf(DbError);
    expect(decodeIpcError({ kind: "validation", message: "bad name" })).toBeInstanceOf(
      ValidationError,
    );
    expect(decodeIpcError({ kind: "not-found", message: "no such project" })).toBeInstanceOf(
      NotFoundError,
    );
    expect(decodeIpcError({ kind: "keychain", message: "denied" })).toBeInstanceOf(KeychainError);
  });

  it("keeps the message text", () => {
    const e = decodeIpcError({ kind: "validation", message: "invalid project name" });
    expect(e.message).toBe("invalid project name");
  });

  it("treats the residual message kind as a defect", () => {
    expect(decodeIpcError({ kind: "message", message: "boom" })).toBeInstanceOf(IpcDefect);
  });

  it("copes with non-AppError rejections", () => {
    expect(decodeIpcError(new Error("plain"))).toMatchObject({ message: "plain" });
    expect(decodeIpcError("string reason")).toBeInstanceOf(IpcDefect);
    expect(decodeIpcError(undefined)).toBeInstanceOf(IpcDefect);
  });
});

const fakeRaw = (overrides: Partial<Record<string, unknown>> = {}): RawIpc =>
  ({
    db: {
      listProjects: () => Promise.resolve([{ id: "p1" }]),
      getSetting: (key: string) => Promise.resolve(`value:${key}`),
      setSetting: () => Promise.reject({ kind: "db", message: "readonly" }),
      ...(overrides.db as object),
    },
    fs: {
      trashProject: () => Promise.reject({ kind: "not-found", message: "gone" }),
    },
    files: {},
    git: {},
    network: { checkOnline: () => Promise.resolve(true) },
    snapshots: {},
    credentials: {},
    tray: { update: () => Promise.resolve() },
  }) as unknown as RawIpc;

describe("Ipc service", () => {
  it("passes successes through with arguments intact", async () => {
    const ipc = make(fakeRaw());
    await expect(Effect.runPromise(ipc.db.getSetting("root_folder"))).resolves.toBe(
      "value:root_folder",
    );
  });

  it("surfaces Rust rejections as typed failures", async () => {
    const ipc = make(fakeRaw());
    const err = await Effect.runPromise(Effect.flip(ipc.db.setSetting("k", "v")));
    expect(err).toBeInstanceOf(DbError);
    expect(err.message).toBe("readonly");
  });

  it("lets callers branch by tag", async () => {
    const ipc = make(fakeRaw());
    const result = await Effect.runPromise(
      ipc.fs.trashProject("ghost").pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed("already-gone")),
      ),
    );
    expect(result).toBe("already-gone");
  });

  it("is provided through a layer built from fakes", async () => {
    const program = Effect.gen(function* () {
      const ipc = yield* Ipc;
      return yield* ipc.network.checkOnline();
    });
    await expect(
      Effect.runPromise(program.pipe(Effect.provide(layerFrom(fakeRaw())))),
    ).resolves.toBe(true);
  });
});
