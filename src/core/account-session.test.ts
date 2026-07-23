import { describe, expect, it } from "vitest";
import { AccountSession, type AccountSessionDeps } from "./account-session";

/**
 * Tests for the account session: single-flight token renewal, the
 * refresh-margin policy, the CLI re-import fallback chain, account-switch
 * detection and the Keep Links / Start Fresh resolutions — all against
 * plain fakes.
 */

const NOW = 1_753_200_000_000;
const MIN = 60_000;

interface Harness {
  session: AccountSession;
  settings: Record<string, string>;
  refreshCalls: number;
  importCalls: number;
  authedAs: (string | null)[];
  notifications: string[];
  switches: { from: string; to: string }[];
  cleared: { link: string[]; team: string[]; repo: string[]; file: string[] };
  freshStarts: number;
  reloads: number;
  resolved: number;
  accountSwitch: { from: string; to: string } | null;
}

function makeHarness(overrides: Partial<AccountSessionDeps> = {}): Harness {
  const h: Harness = {
    session: undefined as unknown as AccountSession,
    settings: {},
    refreshCalls: 0,
    importCalls: 0,
    authedAs: [],
    notifications: [],
    switches: [],
    cleared: { link: [], team: [], repo: [], file: [] },
    freshStarts: 0,
    reloads: 0,
    resolved: 0,
    accountSwitch: null,
  };
  h.session = new AccountSession({
    getStoredToken: async () => "stored-token",
    getExpiresAt: async () => null,
    now: () => NOW,
    refreshViaOAuth: async () => {
      h.refreshCalls += 1;
      return null;
    },
    importCliSession: async () => {
      h.importCalls += 1;
      return null;
    },
    fetchUser: async () => ({ uid: "u1", username: "diego", avatarUrl: null }),
    getSetting: async (key) => h.settings[key] ?? null,
    setSetting: async (key, value) => {
      h.settings[key] = value;
    },
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
    clearProjectLink: async (id) => void h.cleared.link.push(id),
    clearProjectTeam: async (id) => void h.cleared.team.push(id),
    clearRemoteRepo: async (id) => void h.cleared.repo.push(id),
    removeLinkFile: async (name) => void h.cleared.file.push(name),
    onFreshStart: () => void (h.freshStarts += 1),
    reloadProjects: async () => void (h.reloads += 1),
    onSwitchResolved: () => void (h.resolved += 1),
    ...overrides,
  });
  return h;
}

describe("AccountSession.getToken", () => {
  it("uses the stored token while comfortably valid — no refresh", async () => {
    const h = makeHarness({ getExpiresAt: async () => NOW + 60 * MIN });
    expect(await h.session.getToken()).toBe("stored-token");
    expect(h.refreshCalls).toBe(0);
    expect(h.importCalls).toBe(0);
  });

  it("never refreshes tokens without a recorded expiry (manual PATs)", async () => {
    const h = makeHarness({ getExpiresAt: async () => null });
    expect(await h.session.getToken()).toBe("stored-token");
    expect(h.refreshCalls).toBe(0);
  });

  it("refreshes within the 15-minute margin", async () => {
    const h = makeHarness({
      getExpiresAt: async () => NOW + 10 * MIN,
      refreshViaOAuth: async () => "refreshed-token",
    });
    expect(await h.session.getToken()).toBe("refreshed-token");
  });

  it("single-flight: two concurrent callers share one renewal", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const h = makeHarness({
      getExpiresAt: async () => NOW - 1, // expired → renewal path
      refreshViaOAuth: async () => {
        h.refreshCalls += 1;
        await new Promise<void>((r) => (gate.release = r));
        return "refreshed-token";
      },
    });
    const [a, b] = [h.session.getToken(), h.session.getToken()];
    while (gate.release === null) await new Promise((r) => setTimeout(r, 0));
    gate.release();
    expect(await a).toBe("refreshed-token");
    expect(await b).toBe("refreshed-token");
    expect(h.refreshCalls).toBe(1);
  });

  it("falls back to a CLI re-import when the refresh fails", async () => {
    const h = makeHarness({
      getExpiresAt: async () => NOW - 1,
      importCliSession: async () => ({ token: "cli-token", username: "diego" }),
    });
    expect(await h.session.getToken()).toBe("cli-token");
    expect(h.refreshCalls).toBe(1);
  });

  it("gives up gracefully: returns the stale token so a 401 can surface", async () => {
    const h = makeHarness({ getExpiresAt: async () => NOW - 1 });
    expect(await h.session.getToken()).toBe("stored-token");
    expect(h.refreshCalls).toBe(1);
    expect(h.importCalls).toBe(1);
  });

  it("returns null when nothing is stored and every fallback fails", async () => {
    const h = makeHarness({ getStoredToken: async () => null });
    expect(await h.session.getToken()).toBeNull();
  });
});

describe("AccountSession.refreshIdentity", () => {
  it("records identity on first sign-in without raising a switch", async () => {
    const h = makeHarness();
    await h.session.refreshIdentity();
    expect(h.authedAs).toEqual(["diego"]);
    expect(h.switches).toEqual([]);
    expect(h.settings).toMatchObject({ auth_user_id: "u1", auth_username: "diego" });
  });

  it("uid change → switch detected, holds engaged, settings untouched", async () => {
    const h = makeHarness();
    h.settings = { auth_user_id: "u0", auth_username: "olduser" };
    await h.session.refreshIdentity();
    expect(h.switches).toEqual([{ from: "olduser", to: "diego" }]);
    // Settings update is deferred until the user chooses.
    expect(h.settings.auth_user_id).toBe("u0");
  });

  it("no token and no CLI session → signed out", async () => {
    const h = makeHarness({ getStoredToken: async () => null });
    await h.session.refreshIdentity();
    expect(h.authedAs).toEqual([null]);
  });

  it("no token but a fresh CLI login → import + notify", async () => {
    const h = makeHarness({
      getStoredToken: async () => null,
      importCliSession: async () => ({ token: "cli-token", username: "diego" }),
    });
    await h.session.refreshIdentity();
    // getToken's import already succeeds, so identity resolves via the API.
    expect(h.authedAs).toEqual(["diego"]);
    expect(h.notifications).toContain("Signed in via Vercel CLI");
  });
});

describe("AccountSession.resolveSwitch", () => {
  it("'fresh' clears every per-project link, team, repo and link file", async () => {
    const h = makeHarness();
    h.accountSwitch = { from: "olduser", to: "diego" };
    await h.session.resolveSwitch("fresh");
    expect(h.cleared.link).toEqual(["p1", "p2"]);
    expect(h.cleared.team).toEqual(["p1", "p2"]);
    expect(h.cleared.repo).toEqual(["p1", "p2"]);
    expect(h.cleared.file).toEqual(["blog", "shop"]);
    expect(h.freshStarts).toBe(1);
    expect(h.accountSwitch).toBeNull();
    expect(h.settings).toMatchObject({ auth_user_id: "u1", auth_username: "diego" });
    expect(h.reloads).toBe(1);
    expect(h.resolved).toBe(1);
  });

  it("'keep' just clears the hold — links stay", async () => {
    const h = makeHarness();
    h.accountSwitch = { from: "olduser", to: "diego" };
    await h.session.resolveSwitch("keep");
    expect(h.cleared.link).toEqual([]);
    expect(h.freshStarts).toBe(0);
    expect(h.accountSwitch).toBeNull();
    expect(h.settings).toMatchObject({ auth_user_id: "u1" });
    expect(h.resolved).toBe(1);
  });

  it("is a no-op without a pending switch", async () => {
    const h = makeHarness();
    await h.session.resolveSwitch("fresh");
    expect(h.cleared.link).toEqual([]);
    expect(h.resolved).toBe(0);
  });
});
