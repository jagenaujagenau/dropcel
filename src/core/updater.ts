import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describeError, log } from "../lib/log";

/**
 * App self-update via Tauri's updater plugin, backed by the `latest.json`
 * manifest the release workflow publishes alongside each GitHub Release
 * (see release.yml's `createUpdaterArtifacts`). Deliberately simple: one
 * channel, no background poller — a check on startup and a manual "Check
 * for Updates" button (Settings) are enough for an app this size. The user
 * always confirms before anything downloads or installs; nothing happens
 * silently.
 */

export type UpdateStatus =
  | { readonly _tag: "idle" }
  | { readonly _tag: "checking" }
  | { readonly _tag: "upToDate" }
  | { readonly _tag: "available"; readonly version: string; readonly notes: string | null }
  | { readonly _tag: "installing" }
  | { readonly _tag: "error"; readonly message: string };

export interface UpdaterShape {
  readonly status: SubscriptionRef.SubscriptionRef<UpdateStatus>;
  readonly check: Effect.Effect<void>;
  /** Downloads, installs, and relaunches the app. Only valid from "available". */
  readonly installAndRelaunch: Effect.Effect<void>;
}

export class Updater extends Context.Service<Updater, UpdaterShape>()(
  "dropcel/core/Updater",
) {}

export const make = Effect.gen(function* () {
  const status = yield* SubscriptionRef.make<UpdateStatus>({ _tag: "idle" });
  const pending = yield* Ref.make<Update | null>(null);

  const checkForUpdate: UpdaterShape["check"] = Effect.gen(function* () {
    yield* SubscriptionRef.set(status, { _tag: "checking" });
    const result = yield* Effect.tryPromise(() => check()).pipe(Effect.result);
    if (Result.isFailure(result)) {
      log.warn("updater", `check failed: ${describeError(result.failure)}`);
      yield* SubscriptionRef.set(status, {
        _tag: "error",
        message: "Couldn't check for updates.",
      });
      return;
    }
    const update = result.success;
    if (!update) {
      yield* Ref.set(pending, null);
      yield* SubscriptionRef.set(status, { _tag: "upToDate" });
      return;
    }
    yield* Ref.set(pending, update);
    yield* SubscriptionRef.set(status, {
      _tag: "available",
      version: update.version,
      notes: update.body ?? null,
    });
  });

  const installAndRelaunch: UpdaterShape["installAndRelaunch"] = Effect.gen(function* () {
    const update = yield* Ref.get(pending);
    if (!update) return;
    yield* SubscriptionRef.set(status, { _tag: "installing" });
    const result = yield* Effect.tryPromise(() => update.downloadAndInstall()).pipe(
      Effect.result,
    );
    if (Result.isFailure(result)) {
      log.error("updater", `install failed: ${describeError(result.failure)}`);
      yield* SubscriptionRef.set(status, {
        _tag: "error",
        message: "Update failed to download or install.",
      });
      return;
    }
    yield* Effect.tryPromise(() => relaunch()).pipe(Effect.ignore);
  });

  return Updater.of({ status, check: checkForUpdate, installAndRelaunch });
});

export const layer: Layer.Layer<Updater> = Layer.effect(Updater, make);
