import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { RefreshOutcome } from "./auth";
import {
  make,
  NetworkDown,
  NoSession,
  TokenExpired,
  TokenRevoked,
  type AccountSessionDeps,
  type AccountSessionShape,
} from "./account-session";

/**
 * Tests for the account session: single-flight token renewal, the
 * refresh-margin policy, the CLI re-import fallback chain, the typed failure
 * distinctions, account-switch detection and the Keep Links / Start Fresh
 * resolutions — all against plain fakes behind Effect deps.
 */

const NOW = 1_753_200_000_000;
const MIN = 60_000;

const noRefreshToken: RefreshOutcome = { ok: false, reason: "no-refresh-token" };

interface Harness {
  session: AccountSessionShape;
  settings: Record<string, string>;
  refreshCalls: () => number;
  importCalls: () => number;
  authedAs: (string | null)[];
  notifications: string[];
  switches: { from: string; to: string }[];
  cleared: { link: string[]; team: string[]; repo: string[]; file: string[] };
  freshStarts: () => number;
  reloads: () => number;
  resolved: () => number;
  accountSwitch: { from: string; to: string } | null;
}

const makeHarness = (overrides: Partial<AccountSessionDeps> = {}) =>
  Effect.gen(function* () {
    const counters = { refresh: 0, import: 0, fresh: 0, reloads: 0, resolved: 0 };
    const h = {
      session: undefined as unknown as AccountSessionShape,
      settings: {} as Record<string, string>,
      refreshCalls: () => counters.refresh,
      importCalls: () => counters.import,
      authedAs: [] as (string | null)[],
      notifications: [] as string[],
      switches: [] as { from: string; to: string }[],
      cleared: { link: [], team: [], repo: [], file: [] } as Harness["cleared"],
      freshStarts: () => counters.fresh,
      reloads: () => counters.reloads,
      resolved: () => counters.resolved,
      accountSwitch: null as { from: string; to: string } | null,
    };
    h.session = yield* make({
      getStoredToken: Effect.sync(() => "stored-token"),
      getExpiresAt: Effect.sync(() => null),
      now: () => NOW,
      refreshViaOAuth: Effect.sync(() => {
        counters.refresh += 1;
        return noRefreshToken;
      }),
      importCliSession: Effect.sync(() => {
        counters.import += 1;
        return null;
      }),
      fetchUser: () =>
        Effect.sync(() => ({ uid: "u1", username: "diego", avatarUrl: null })),
      getSetting: (key) => Effect.sync(() => h.settings[key] ?? null),
      setSetting: (key, value) => Effect.sync(() => void (h.settings[key] = value)),
      setAuthedAs: (username) => h.authedAs.push(username),
      notify: (title) => h.notifications.push(title),
      onSwitchDetected: (sw) => {
        h.switches.push(sw);
        h.accountSwitch = sw;
      },
      getAccountSwitch: () => h.accountSwitch,
      clearAccountSwitch: () => {
        h.accountSwitch = null;
      },
      getProjects: () => [
        { id: "p1", name: "blog" },
        { id: "p2", name: "shop" },
      ],
      clearProjectLink: (id) => Effect.sync(() => void h.cleared.link.push(id)),
      clearProjectTeam: (id) => Effect.sync(() => void h.cleared.team.push(id)),
      clearRemoteRepo: (id) => Effect.sync(() => void h.cleared.repo.push(id)),
      removeLinkFile: (name) => Effect.sync(() => void h.cleared.file.push(name)),
      onFreshStart: () => void (counters.fresh += 1),
      reloadProjects: Effect.sync(() => void (counters.reloads += 1)),
      onSwitchResolved: () => void (counters.resolved += 1),
      ...overrides,
    });
    return h as Harness;
  });

describe("AccountSession.getToken", () => {
  it.effect("uses the stored token while comfortably valid — no refresh", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getExpiresAt: Effect.sync(() => NOW + 60 * MIN) });
      expect(yield* h.session.getToken).toBe("stored-token");
      expect(h.refreshCalls()).toBe(0);
      expect(h.importCalls()).toBe(0);
    }),
  );

  it.effect("never refreshes tokens without a recorded expiry (manual PATs)", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getExpiresAt: Effect.sync(() => null) });
      expect(yield* h.session.getToken).toBe("stored-token");
      expect(h.refreshCalls()).toBe(0);
    }),
  );

  it.effect("refreshes within the 15-minute margin", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW + 10 * MIN),
        refreshViaOAuth: Effect.sync<RefreshOutcome>(() => ({
          ok: true,
          token: "refreshed-token",
        })),
      });
      expect(yield* h.session.getToken).toBe("refreshed-token");
    }),
  );

  it.effect("single-flight: two concurrent callers share one renewal", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let refreshCalls = 0;
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW - 1), // expired → renewal path
        refreshViaOAuth: Effect.gen(function* () {
          refreshCalls += 1;
          yield* Deferred.await(gate);
          return { ok: true, token: "refreshed-token" } as RefreshOutcome;
        }),
      });
      const a = yield* Effect.forkChild(h.session.getToken);
      const b = yield* Effect.forkChild(h.session.getToken);
      // Let both callers reach the renewal before releasing it.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      expect(yield* Fiber.join(a)).toBe("refreshed-token");
      expect(yield* Fiber.join(b)).toBe("refreshed-token");
      expect(refreshCalls).toBe(1);
    }),
  );

  it.effect("falls back to a CLI re-import when the refresh fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW - 1),
        importCliSession: Effect.sync(() => ({ token: "cli-token", username: "diego" })),
      });
      expect(yield* h.session.getToken).toBe("cli-token");
      expect(h.refreshCalls()).toBe(1);
    }),
  );

  it.effect("gives up gracefully: returns the stale token so a 401 can surface", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getExpiresAt: Effect.sync(() => NOW - 1) });
      expect(yield* h.session.getToken).toBe("stored-token");
      expect(h.refreshCalls()).toBe(1);
      expect(h.importCalls()).toBe(1);
    }),
  );

  it.effect("returns null when nothing is stored and every fallback fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getStoredToken: Effect.sync(() => null) });
      expect(yield* h.session.getToken).toBeNull();
    }),
  );
});

describe("AccountSession.acquireToken (typed failures)", () => {
  it.effect("expired + no refresh token + no CLI session → TokenExpired with the stale token", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getExpiresAt: Effect.sync(() => NOW - 1) });
      const err = yield* Effect.flip(h.session.acquireToken);
      expect(err).toBeInstanceOf(TokenExpired);
      expect((err as TokenExpired).staleToken).toBe("stored-token");
    }),
  );

  it.effect("a refused refresh grant → TokenRevoked", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW - 1),
        refreshViaOAuth: Effect.sync<RefreshOutcome>(() => ({
          ok: false,
          reason: "rejected",
        })),
      });
      const err = yield* Effect.flip(h.session.acquireToken);
      expect(err).toBeInstanceOf(TokenRevoked);
      expect((err as TokenRevoked).staleToken).toBe("stored-token");
    }),
  );

  it.effect("an unreachable token endpoint → NetworkDown", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW - 1),
        refreshViaOAuth: Effect.sync<RefreshOutcome>(() => ({
          ok: false,
          reason: "network",
        })),
      });
      const err = yield* Effect.flip(h.session.acquireToken);
      expect(err).toBeInstanceOf(NetworkDown);
    }),
  );

  it.effect("nothing stored, nothing refreshable, no CLI session → NoSession", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getStoredToken: Effect.sync(() => null) });
      const err = yield* Effect.flip(h.session.acquireToken);
      expect(err).toBeInstanceOf(NoSession);
    }),
  );

  it.effect("a CLI re-import rescues the chain before it fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getExpiresAt: Effect.sync(() => NOW - 1),
        importCliSession: Effect.sync(() => ({ token: "cli-token", username: "diego" })),
      });
      expect(yield* h.session.acquireToken).toBe("cli-token");
    }),
  );
});

describe("AccountSession.refreshIdentity", () => {
  it.effect("records identity on first sign-in without raising a switch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.session.refreshIdentity;
      expect(h.authedAs).toEqual(["diego"]);
      expect(h.switches).toEqual([]);
      expect(h.settings).toMatchObject({ auth_user_id: "u1", auth_username: "diego" });
    }),
  );

  it.effect("uid change → switch detected, holds engaged, settings untouched", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.settings = { auth_user_id: "u0", auth_username: "olduser" };
      yield* h.session.refreshIdentity;
      expect(h.switches).toEqual([{ from: "olduser", to: "diego" }]);
      // Settings update is deferred until the user chooses.
      expect(h.settings.auth_user_id).toBe("u0");
      // The observable identity state carries the pending switch too.
      const state = yield* SubscriptionRef.get(h.session.state);
      expect(state.pendingSwitch).toEqual({ from: "olduser", to: "diego" });
    }),
  );

  it.effect("no token and no CLI session → signed out", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ getStoredToken: Effect.sync(() => null) });
      yield* h.session.refreshIdentity;
      expect(h.authedAs).toEqual([null]);
    }),
  );

  it.effect("no token but a fresh CLI login → import + notify", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        getStoredToken: Effect.sync(() => null),
        importCliSession: Effect.sync(() => ({ token: "cli-token", username: "diego" })),
      });
      yield* h.session.refreshIdentity;
      // getToken's import already succeeds, so identity resolves via the API.
      expect(h.authedAs).toEqual(["diego"]);
      expect(h.notifications).toContain("Signed in via Vercel CLI");
    }),
  );
});

describe("AccountSession.resolveSwitch", () => {
  it.effect("'fresh' clears every per-project link, team, repo and link file", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.accountSwitch = { from: "olduser", to: "diego" };
      yield* h.session.resolveSwitch("fresh");
      expect(h.cleared.link).toEqual(["p1", "p2"]);
      expect(h.cleared.team).toEqual(["p1", "p2"]);
      expect(h.cleared.repo).toEqual(["p1", "p2"]);
      expect(h.cleared.file).toEqual(["blog", "shop"]);
      expect(h.freshStarts()).toBe(1);
      expect(h.accountSwitch).toBeNull();
      expect(h.settings).toMatchObject({ auth_user_id: "u1", auth_username: "diego" });
      expect(h.reloads()).toBe(1);
      expect(h.resolved()).toBe(1);
    }),
  );

  it.effect("'keep' just clears the hold — links stay", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.accountSwitch = { from: "olduser", to: "diego" };
      yield* h.session.resolveSwitch("keep");
      expect(h.cleared.link).toEqual([]);
      expect(h.freshStarts()).toBe(0);
      expect(h.accountSwitch).toBeNull();
      expect(h.settings).toMatchObject({ auth_user_id: "u1" });
      expect(h.resolved()).toBe(1);
    }),
  );

  it.effect("is a no-op without a pending switch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.session.resolveSwitch("fresh");
      expect(h.cleared.link).toEqual([]);
      expect(h.resolved()).toBe(0);
    }),
  );
});
