import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describeError, log } from "../lib/log";
import {
  importFromCli,
  needsRefresh,
  oauthRefreshOutcome,
  readExpiry,
  type ImportResult,
  type RefreshOutcome,
} from "./auth";
import { Ipc, layer as ipcLayer, type IpcShape } from "./ipc";
import * as api from "./vercel-api";

/**
 * The account session owns the whole token + identity lifecycle: the
 * single-flight token renewal (rotated refresh tokens are single-use, so
 * parallel refreshes would invalidate each other), the signed-in identity,
 * account-switch detection (uid changed since last session) and its
 * resolution (Keep Links / Start Fresh). It is a Context.Service; the plain
 * orchestrator reaches it through the bridge at the bottom, and auth.ts's
 * getAuthToken() keeps delegating to the active bridge.
 */

const UID_SETTING = "auth_user_id";
const USERNAME_SETTING = "auth_username";

export interface SessionUser {
  uid: string;
  username: string;
  avatarUrl: string | null;
}

export type SwitchResolution = "keep" | "fresh";

export interface AccountSwitch {
  from: string;
  to: string;
}

// ---- typed token failures (they will cross to the UI eventually) -----------

/** The stored token is past its refresh margin and neither the OAuth grant
 * nor a CLI re-import could renew it. */
export class TokenExpired extends Schema.TaggedErrorClass<TokenExpired>()(
  "TokenExpired",
  { staleToken: Schema.String },
) {}

/** The token endpoint refused the refresh grant — the refresh token is
 * revoked or spent. */
export class TokenRevoked extends Schema.TaggedErrorClass<TokenRevoked>()(
  "TokenRevoked",
  { staleToken: Schema.NullOr(Schema.String) },
) {}

/** Renewal failed on infrastructure, not on the grant. */
export class NetworkDown extends Schema.TaggedErrorClass<NetworkDown>()(
  "NetworkDown",
  { staleToken: Schema.NullOr(Schema.String) },
) {}

/** Nothing stored, nothing refreshable, no CLI session to import. */
export class NoSession extends Schema.TaggedErrorClass<NoSession>()("NoSession", {}) {}

export type TokenError = TokenExpired | TokenRevoked | NetworkDown | NoSession;

// ---- dependencies ----------------------------------------------------------

export interface AccountSessionDeps {
  // -- token acquisition --
  getStoredToken: Effect.Effect<string | null, unknown>;
  getExpiresAt: Effect.Effect<number | null, unknown>;
  now: () => number;
  /** OAuth refresh_token grant, classified (see auth.oauthRefreshOutcome). */
  refreshViaOAuth: Effect.Effect<RefreshOutcome, unknown>;
  /** Re-import the Vercel CLI's session; null when absent or stale. */
  importCliSession: Effect.Effect<ImportResult | null, unknown>;
  // -- identity --
  fetchUser: (token: string) => Effect.Effect<SessionUser, unknown>;
  getSetting: (key: string) => Effect.Effect<string | null, unknown>;
  setSetting: (key: string, value: string) => Effect.Effect<void, unknown>;
  // -- sinks (store / notifications / orchestrator) --
  setAuthedAs: (username: string | null, avatarUrl?: string | null) => void;
  notify: (title: string, body: string) => void;
  /** An unresolved switch was detected — show the banner, engage holds. */
  onSwitchDetected: (sw: AccountSwitch) => void;
  getAccountSwitch: () => AccountSwitch | null;
  clearAccountSwitch: () => void;
  // -- "Start Fresh" link clearing --
  getProjects: () => { id: string; name: string }[];
  clearProjectLink: (projectId: string) => Effect.Effect<void, unknown>;
  clearProjectTeam: (projectId: string) => Effect.Effect<void, unknown>;
  clearRemoteRepo: (projectId: string) => Effect.Effect<void, unknown>;
  removeLinkFile: (projectName: string) => Effect.Effect<void, unknown>;
  /** Fresh start chosen — reset per-session integration bookkeeping. */
  onFreshStart: () => void;
  /** Reload projects from the db into the store after resolution. */
  reloadProjects: Effect.Effect<void, unknown>;
  /** The switch is resolved — deploy the changes that piled up. */
  onSwitchResolved: () => void;
}

// ---- service ---------------------------------------------------------------

/** Observable identity state (React reads this from phase 7 on). */
export interface AccountState {
  username: string | null;
  avatarUrl: string | null;
  pendingSwitch: AccountSwitch | null;
}

export interface AccountSessionShape {
  readonly state: SubscriptionRef.SubscriptionRef<AccountState>;
  /**
   * The single choke point for obtaining a Vercel access token:
   *   1. stored token, not near expiry → use it (manual PATs have no
   *      recorded expiry and always take this path)
   *   2. near/past expiry → OAuth refresh_token grant
   *   3. refresh failed/absent → re-read the CLI's auth.json (the CLI may
   *      have refreshed its own session meanwhile), validate, re-import
   *   4. still nothing usable → whatever is stored (letting a 401 surface
   *      as an actionable error), or null
   */
  readonly getToken: Effect.Effect<string | null>;
  /** The same chain with the give-up step as a typed failure instead. */
  readonly acquireToken: Effect.Effect<string, TokenError>;
  /** Who is signed in? Refreshes the store and detects account switches. */
  readonly refreshIdentity: Effect.Effect<void>;
  readonly resolveSwitch: (mode: SwitchResolution) => Effect.Effect<void>;
}

export class AccountSessionService extends Context.Service<
  AccountSessionService,
  AccountSessionShape
>()("dropcel/core/AccountSession") {}

export const make = (deps: AccountSessionDeps) =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make<AccountState>({
      username: null,
      avatarUrl: null,
      pendingSwitch: null,
    });

    const setAuthedAs = (username: string | null, avatarUrl: string | null = null) =>
      SubscriptionRef.update(state, (s) => ({ ...s, username, avatarUrl })).pipe(
        Effect.andThen(Effect.sync(() => deps.setAuthedAs(username, avatarUrl))),
      );

    /**
     * The refresh → CLI re-import → give-up chain, typed. The classification
     * of the failed refresh (revoked vs network vs merely absent) decides
     * which error the give-up step raises.
     */
    const acquireToken: Effect.Effect<string, TokenError> = Effect.fn(
      "AccountSession.acquireToken",
    )(function* () {
      const stored = yield* deps.getStoredToken.pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const expiresAt = yield* Effect.orDie(deps.getExpiresAt);
      if (stored && !needsRefresh(expiresAt, deps.now())) return stored;

      const outcome = yield* Effect.orDie(deps.refreshViaOAuth);
      if (outcome.ok) return outcome.token;

      // The CLI may have renewed its own session since we imported it.
      const imported = yield* Effect.orDie(deps.importCliSession);
      if (imported && imported.token !== stored) return imported.token;

      if (outcome.reason === "rejected")
        return yield* Effect.fail(new TokenRevoked({ staleToken: stored }));
      if (outcome.reason === "network")
        return yield* Effect.fail(new NetworkDown({ staleToken: stored }));
      if (stored) return yield* Effect.fail(new TokenExpired({ staleToken: stored }));
      return yield* Effect.fail(new NoSession());
    })();

    /** Give up gracefully: hand back the stale token (a 401 will surface as
     * an actionable error) or null when there is nothing at all. */
    const degraded: Effect.Effect<string | null> = acquireToken.pipe(
      Effect.catchTags({
        TokenExpired: (e) => Effect.succeed<string | null>(e.staleToken),
        TokenRevoked: (e) => Effect.succeed(e.staleToken),
        NetworkDown: (e) => Effect.succeed(e.staleToken),
        NoSession: () => Effect.succeed(null),
      }),
    );

    // Concurrent callers share one renewal; rotated refresh tokens are
    // single-use, so parallel refreshes would invalidate each other. The
    // first caller runs the chain and completes the Deferred everyone else
    // is awaiting.
    const inflight = yield* Ref.make<Deferred.Deferred<string | null> | null>(null);
    const gate = yield* Semaphore.make(1);

    const getToken: Effect.Effect<string | null> = Effect.fn(
      "AccountSession.getToken",
    )(function* () {
      const join = yield* gate.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(inflight);
          if (current) return { deferred: current, owner: false };
          const deferred = yield* Deferred.make<string | null>();
          yield* Ref.set(inflight, deferred);
          return { deferred, owner: true };
        }),
      );
      if (!join.owner) return yield* Deferred.await(join.deferred);
      const exit = yield* Effect.exit(degraded);
      yield* Ref.set(inflight, null);
      yield* Deferred.done(join.deferred, exit);
      return yield* exit;
    })();

    /**
     * The token's owner changed since last session. This is ambiguous: same
     * team, new seat → existing project links still work; different account →
     * they don't. Only the user knows, so surface a banner and wait for an
     * explicit choice (resolveSwitch). Until then, deploys to linked projects
     * may fail with permission errors — annoying but honest.
     */
    const detectSwitch = Effect.fn("AccountSession.detectSwitch")(function* (
      uid: string,
      username: string,
    ) {
      const storedUid = yield* deps.getSetting(UID_SETTING);
      const storedName =
        (yield* deps.getSetting(USERNAME_SETTING)) ?? "previous account";
      if (storedUid && storedUid !== uid) {
        const sw = { from: storedName, to: username };
        yield* SubscriptionRef.update(state, (s) => ({ ...s, pendingSwitch: sw }));
        deps.onSwitchDetected(sw);
        return; // settings update deferred until the user chooses
      }
      if (!storedUid) {
        yield* deps.setSetting(UID_SETTING, uid);
        yield* deps.setSetting(USERNAME_SETTING, username);
      }
    });

    const refreshIdentity: Effect.Effect<void> = Effect.fn(
      "AccountSession.refreshIdentity",
    )(function* () {
      const hadToken = Boolean(
        yield* deps.getStoredToken.pipe(Effect.catch(() => Effect.succeed(null))),
      );
      const token = yield* getToken;
      if (!token) {
        // Last resort: a fresh CLI login the user just completed.
        const imported = yield* deps.importCliSession;
        if (imported) {
          deps.notify(
            "Signed in via Vercel CLI",
            `Using your Vercel CLI session (${imported.username}).`,
          );
          yield* setAuthedAs(imported.username);
          return;
        }
        yield* setAuthedAs(null);
        return;
      }
      const user = yield* deps.fetchUser(token);
      yield* setAuthedAs(user.username, user.avatarUrl);
      if (!hadToken) {
        deps.notify(
          "Signed in via Vercel CLI",
          `Using your Vercel CLI session (${user.username}).`,
        );
      }
      yield* detectSwitch(user.uid, user.username).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.warn(
              "auth",
              `account-switch detection failed: ${describeError(cause)}`,
            ),
          ),
        ),
      );
    })().pipe(Effect.catchCause(() => setAuthedAs(null)));

    /**
     * User chose how to handle the switch. "keep" = same-team scenario:
     * project links remain valid for the new user. "fresh" unlinks every
     * project locally (clear vercel ids, teams, git-integration state and the
     * .vercel link files) so next deploys create fresh projects under the new
     * account. Local history and the old remote projects are untouched.
     */
    const resolveSwitch = Effect.fn("AccountSession.resolveSwitch")(function* (
      mode: SwitchResolution,
    ) {
      if (!deps.getAccountSwitch()) return;
      if (mode === "fresh") {
        for (const p of deps.getProjects()) {
          yield* deps.clearProjectLink(p.id).pipe(Effect.ignore);
          yield* deps.clearProjectTeam(p.id).pipe(Effect.ignore);
          yield* deps.clearRemoteRepo(p.id).pipe(Effect.ignore);
          yield* deps.removeLinkFile(p.name).pipe(Effect.ignore);
        }
        deps.onFreshStart();
      }
      const token = yield* getToken;
      if (token) {
        const user = yield* deps
          .fetchUser(token)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (user) {
          yield* deps.setSetting(UID_SETTING, user.uid).pipe(Effect.ignore);
          yield* deps.setSetting(USERNAME_SETTING, user.username).pipe(Effect.ignore);
        }
      }
      deps.clearAccountSwitch();
      yield* SubscriptionRef.update(state, (s) => ({ ...s, pendingSwitch: null }));
      yield* Effect.orDie(deps.reloadProjects);
      deps.onSwitchResolved();
    });

    return AccountSessionService.of({
      state,
      getToken,
      acquireToken,
      refreshIdentity,
      resolveSwitch: (mode) => resolveSwitch(mode) as Effect.Effect<void>,
    });
  });

// ---- real wiring -----------------------------------------------------------

/** The sinks only the composition root (orchestrator) can provide. */
export type AccountSessionHooks = Pick<
  AccountSessionDeps,
  | "setAuthedAs"
  | "notify"
  | "onSwitchDetected"
  | "getAccountSwitch"
  | "clearAccountSwitch"
  | "getProjects"
  | "onFreshStart"
  | "onSwitchResolved"
> & {
  reloadProjects: () => Promise<void>;
};

export const realDeps = (ipc: IpcShape, hooks: AccountSessionHooks): AccountSessionDeps => ({
  getStoredToken: ipc.credentials.getToken(),
  getExpiresAt: Effect.promise(() => readExpiry()),
  now: () => Date.now(),
  refreshViaOAuth: Effect.promise(() => oauthRefreshOutcome()),
  importCliSession: Effect.promise(() => importFromCli()),
  fetchUser: (token) =>
    Effect.tryPromise({ try: () => api.run(api.getUser({ token })), catch: (e) => e }),
  getSetting: (key) => ipc.db.getSetting(key),
  setSetting: (key, value) => ipc.db.setSetting(key, value),
  clearProjectLink: (id) => ipc.db.setProjectLink(id, null),
  clearProjectTeam: (id) => ipc.db.setProjectTeam(id, null),
  clearRemoteRepo: (id) => ipc.db.setRemoteRepo(id, ""),
  removeLinkFile: (name) => ipc.files.removeProjectLink(name),
  setAuthedAs: hooks.setAuthedAs,
  notify: hooks.notify,
  onSwitchDetected: hooks.onSwitchDetected,
  getAccountSwitch: hooks.getAccountSwitch,
  clearAccountSwitch: hooks.clearAccountSwitch,
  getProjects: hooks.getProjects,
  onFreshStart: hooks.onFreshStart,
  reloadProjects: Effect.promise(() => hooks.reloadProjects()),
  onSwitchResolved: hooks.onSwitchResolved,
});

export const layer = (
  hooks: AccountSessionHooks,
): Layer.Layer<AccountSessionService, never, Ipc> =>
  Layer.effect(
    AccountSessionService,
    Effect.gen(function* () {
      const ipc = yield* Ipc;
      return yield* make(realDeps(ipc, hooks));
    }),
  );

// ---- plain-TS bridge (orchestrator + auth.ts are still un-ported) ----------

export interface AccountSession {
  getToken(): Promise<string | null>;
  refreshIdentity(): Promise<void>;
  resolveSwitch(mode: SwitchResolution): Promise<void>;
}

let active: AccountSession | null = null;

/**
 * Point `auth.ts`'s `getAuthToken()` (and anything else outside the Layer
 * graph, e.g. `deployment-actions.ts`) at the one real session the
 * composition root builds — so there is exactly one token/identity state,
 * never a second instance racing the first.
 */
export function setActiveSession(session: AccountSession): void {
  active = session;
}

/**
 * Build the real session (keychain + settings + REST API adapters behind the
 * Ipc service) and make it the process-wide token source behind auth.ts's
 * getAuthToken().
 */
export function createRealAccountSession(hooks: AccountSessionHooks): AccountSession {
  const runtime = ManagedRuntime.make(layer(hooks).pipe(Layer.provide(ipcLayer)));
  const session: AccountSession = {
    getToken: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const s = yield* AccountSessionService;
          return yield* s.getToken;
        }),
      ),
    refreshIdentity: () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const s = yield* AccountSessionService;
          yield* s.refreshIdentity;
        }),
      ),
    resolveSwitch: (mode) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const s = yield* AccountSessionService;
          yield* s.resolveSwitch(mode);
        }),
      ),
  };
  active = session;
  return session;
}

const noopHooks: AccountSessionHooks = {
  setAuthedAs: () => {},
  notify: () => {},
  onSwitchDetected: () => {},
  getAccountSwitch: () => null,
  clearAccountSwitch: () => {},
  getProjects: () => [],
  onFreshStart: () => {},
  reloadProjects: async () => {},
  onSwitchResolved: () => {},
};

/**
 * Token access for callers outside the orchestrator (via auth.getAuthToken).
 * Falls back to a bare real session when the orchestrator hasn't composed
 * one yet — same token logic, no identity side effects.
 */
export function activeSessionToken(): Promise<string | null> {
  return (active ?? createRealAccountSession(noopHooks)).getToken();
}
