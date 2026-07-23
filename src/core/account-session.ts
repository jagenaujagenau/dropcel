import * as ipc from "../lib/ipc";
import { describeError, log } from "../lib/log";
import {
  importFromCli,
  needsRefresh,
  readExpiry,
  tryOAuthRefresh,
  type ImportResult,
} from "./auth";
import * as api from "./vercel-api";

/**
 * The account session owns the whole token + identity lifecycle: the
 * single-flight token renewal (rotated refresh tokens are single-use, so
 * parallel refreshes would invalidate each other), the signed-in identity,
 * account-switch detection (uid changed since last session) and its
 * resolution (Keep Links / Start Fresh). Every dependency is injected; the
 * orchestrator constructs the real instance via createRealAccountSession.
 */

const UID_SETTING = "auth_user_id";
const USERNAME_SETTING = "auth_username";

export interface SessionUser {
  uid: string;
  username: string;
  avatarUrl: string | null;
}

export type SwitchResolution = "keep" | "fresh";

export interface AccountSessionDeps {
  // -- token acquisition --
  getStoredToken: () => Promise<string | null>;
  getExpiresAt: () => Promise<number | null>;
  now: () => number;
  /** OAuth refresh_token grant; null when absent or rejected. */
  refreshViaOAuth: () => Promise<string | null>;
  /** Re-import the Vercel CLI's session; null when absent or stale. */
  importCliSession: () => Promise<ImportResult | null>;
  // -- identity --
  fetchUser: (token: string) => Promise<SessionUser>;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => Promise<void>;
  // -- sinks (store / notifications / orchestrator) --
  setAuthedAs: (username: string | null, avatarUrl?: string | null) => void;
  notify: (title: string, body: string) => void;
  /** An unresolved switch was detected — show the banner, engage holds. */
  onSwitchDetected: (sw: { from: string; to: string }) => void;
  getAccountSwitch: () => { from: string; to: string } | null;
  clearAccountSwitch: () => void;
  // -- "Start Fresh" link clearing --
  getProjects: () => { id: string; name: string }[];
  clearProjectLink: (projectId: string) => Promise<void>;
  clearProjectTeam: (projectId: string) => Promise<void>;
  clearRemoteRepo: (projectId: string) => Promise<void>;
  removeLinkFile: (projectName: string) => Promise<void>;
  /** Fresh start chosen — reset per-session integration bookkeeping. */
  onFreshStart: () => void;
  /** Reload projects from the db into the store after resolution. */
  reloadProjects: () => Promise<void>;
  /** The switch is resolved — deploy the changes that piled up. */
  onSwitchResolved: () => void;
}

export class AccountSession {
  // Concurrent callers share one renewal; rotated refresh tokens are
  // single-use, so parallel refreshes would invalidate each other.
  private inflight: Promise<string | null> | null = null;

  constructor(private deps: AccountSessionDeps) {}

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
  getToken(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const [token, expiresAt] = await Promise.all([
          this.deps.getStoredToken().catch(() => null),
          this.deps.getExpiresAt(),
        ]);
        if (token && !needsRefresh(expiresAt, this.deps.now())) return token;

        const refreshed = await this.deps.refreshViaOAuth();
        if (refreshed) return refreshed;

        // The CLI may have renewed its own session since we imported it.
        const imported = await this.deps.importCliSession();
        if (imported && imported.token !== token) return imported.token;

        return token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Who is signed in? Refreshes the store and detects account switches. */
  async refreshIdentity(): Promise<void> {
    try {
      const hadToken = Boolean(await this.deps.getStoredToken().catch(() => null));
      const token = await this.getToken();
      if (!token) {
        // Last resort: a fresh CLI login the user just completed.
        const imported = await this.deps.importCliSession();
        if (imported) {
          this.deps.notify(
            "Signed in via Vercel CLI",
            `Using your Vercel CLI session (${imported.username}).`,
          );
          this.deps.setAuthedAs(imported.username);
          return;
        }
        this.deps.setAuthedAs(null);
        return;
      }
      const user = await this.deps.fetchUser(token);
      this.deps.setAuthedAs(user.username, user.avatarUrl);
      if (!hadToken) {
        this.deps.notify(
          "Signed in via Vercel CLI",
          `Using your Vercel CLI session (${user.username}).`,
        );
      }
      await this.detectSwitch(user.uid, user.username);
    } catch {
      this.deps.setAuthedAs(null);
    }
  }

  /**
   * The token's owner changed since last session. This is ambiguous: same
   * team, new seat → existing project links still work; different account →
   * they don't. Only the user knows, so surface a banner and wait for an
   * explicit choice (resolveSwitch). Until then, deploys to linked projects
   * may fail with permission errors — annoying but honest.
   */
  private async detectSwitch(uid: string, username: string): Promise<void> {
    try {
      const storedUid = await this.deps.getSetting(UID_SETTING);
      const storedName = (await this.deps.getSetting(USERNAME_SETTING)) ?? "previous account";
      if (storedUid && storedUid !== uid) {
        this.deps.onSwitchDetected({ from: storedName, to: username });
        return; // settings update deferred until the user chooses
      }
      if (!storedUid) {
        await this.deps.setSetting(UID_SETTING, uid);
        await this.deps.setSetting(USERNAME_SETTING, username);
      }
    } catch (err) {
      log.warn("auth", `account-switch detection failed: ${describeError(err)}`);
    }
  }

  /**
   * User chose how to handle the switch. "keep" = same-team scenario:
   * project links remain valid for the new user. "fresh" unlinks every
   * project locally (clear vercel ids, teams, git-integration state and the
   * .vercel link files) so next deploys create fresh projects under the new
   * account. Local history and the old remote projects are untouched.
   */
  async resolveSwitch(mode: SwitchResolution): Promise<void> {
    if (!this.deps.getAccountSwitch()) return;
    if (mode === "fresh") {
      for (const p of this.deps.getProjects()) {
        await this.deps.clearProjectLink(p.id).catch(() => {});
        await this.deps.clearProjectTeam(p.id).catch(() => {});
        await this.deps.clearRemoteRepo(p.id).catch(() => {});
        await this.deps.removeLinkFile(p.name).catch(() => {});
      }
      this.deps.onFreshStart();
    }
    const token = await this.getToken();
    if (token) {
      const user = await this.deps.fetchUser(token).catch(() => null);
      if (user) {
        await this.deps.setSetting(UID_SETTING, user.uid).catch(() => {});
        await this.deps.setSetting(USERNAME_SETTING, user.username).catch(() => {});
      }
    }
    this.deps.clearAccountSwitch();
    await this.deps.reloadProjects();
    this.deps.onSwitchResolved();
  }
}

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
  | "reloadProjects"
  | "onSwitchResolved"
>;

let active: AccountSession | null = null;

/**
 * Build the real session (keychain + settings + REST API adapters) and make
 * it the process-wide token source behind auth.ts's getAuthToken().
 */
export function createRealAccountSession(hooks: AccountSessionHooks): AccountSession {
  const session = new AccountSession({
    getStoredToken: () => ipc.credentials.getToken(),
    getExpiresAt: readExpiry,
    now: () => Date.now(),
    refreshViaOAuth: tryOAuthRefresh,
    importCliSession: importFromCli,
    fetchUser: (token) => api.run(api.getUser({ token })),
    getSetting: (key) => ipc.db.getSetting(key),
    setSetting: (key, value) => ipc.db.setSetting(key, value),
    clearProjectLink: (id) => ipc.db.setProjectLink(id, null),
    clearProjectTeam: (id) => ipc.db.setProjectTeam(id, null),
    clearRemoteRepo: (id) => ipc.db.setRemoteRepo(id, ""),
    removeLinkFile: (name) => ipc.files.removeProjectLink(name),
    ...hooks,
  });
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
