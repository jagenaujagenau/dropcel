import * as ipc from "../lib/ipc";
import * as api from "./vercel-api";

/**
 * The single choke point for obtaining a Vercel access token. Everything
 * that talks to the API calls `getAuthToken()` instead of reading the
 * keychain directly, which is what makes imported CLI sessions self-renew:
 *
 *   1. keychain token, not near expiry → use it (manual PATs have no
 *      recorded expiry and always take this path)
 *   2. near/past expiry + refresh token → OAuth refresh_token grant,
 *      persist rotated tokens, use the new one
 *   3. refresh failed/absent → re-read the CLI's auth.json (the CLI may
 *      have refreshed its own session meanwhile), validate, re-import
 *   4. still nothing usable → whatever the keychain has (letting a 401
 *      surface as an actionable error), or null
 */

const EXPIRES_AT_SETTING = "token_expires_at";
/** Refresh when within this window of expiry. */
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

export function needsRefresh(expiresAtMs: number | null, nowMs: number): boolean {
  if (expiresAtMs == null) return false; // no expiry known (manual PAT)
  return nowMs >= expiresAtMs - REFRESH_MARGIN_MS;
}

async function persistSession(
  token: string,
  refreshToken: string | null,
  expiresAtMs: number | null,
): Promise<void> {
  await ipc.credentials.setToken(token);
  if (refreshToken) await ipc.credentials.setRefreshToken(refreshToken).catch(() => {});
  if (expiresAtMs != null) {
    await ipc.db.setSetting(EXPIRES_AT_SETTING, String(expiresAtMs)).catch(() => {});
  } else {
    await ipc.db.setSetting(EXPIRES_AT_SETTING, "").catch(() => {});
  }
}

/** Forget everything auth-related (Settings → Remove token). */
export async function signOut(): Promise<void> {
  await ipc.credentials.deleteToken().catch(() => {});
  await ipc.credentials.deleteRefreshToken().catch(() => {});
  await ipc.db.setSetting(EXPIRES_AT_SETTING, "").catch(() => {});
}

export interface ImportResult {
  token: string;
  username: string;
}

/**
 * Import a logged-in Vercel CLI session (validated against /v2/user first).
 * Returns null when absent or stale.
 */
export async function importFromCli(): Promise<ImportResult | null> {
  const cli = await ipc.credentials.detectCliToken().catch(() => null);
  if (!cli) return null;
  try {
    const user = await api.run(api.getUser({ token: cli.token }));
    await persistSession(cli.token, cli.refreshToken, cli.expiresAtMs);
    return { token: cli.token, username: user.username };
  } catch {
    return null;
  }
}

export interface DeviceSignIn {
  /** Short code the user confirms in the browser. */
  userCode: string;
  /** Approval page to open. */
  verificationUri: string;
  /** Resolves with the signed-in user, or null (denied/expired/canceled). */
  done: Promise<ImportResult | null>;
  cancel: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Sign in with Vercel": OAuth device flow (RFC 8628) with the CLI's public
 * client — the same mechanism as `vercel login`, no token pasting. The
 * caller opens `verificationUri`; we poll until approved and persist the
 * session (access + rotating refresh token) like any imported session.
 */
export async function startDeviceSignIn(): Promise<DeviceSignIn> {
  const authz = await api.run(api.oauthDeviceAuthorize());
  let canceled = false;

  const done = (async (): Promise<ImportResult | null> => {
    let interval = authz.intervalMs;
    const deadline = Date.now() + authz.expiresInMs;
    while (!canceled && Date.now() < deadline) {
      await sleep(interval);
      if (canceled) return null;
      let poll: api.DevicePollResult;
      try {
        poll = await api.run(api.oauthDevicePoll(authz.deviceCode));
      } catch {
        continue; // transient network problem — keep polling
      }
      if (poll.status === "pending") continue;
      if (poll.status === "slow_down") {
        interval += 5000;
        continue;
      }
      if (poll.status === "denied") return null;
      const { tokens } = poll;
      const user = await api.run(api.getUser({ token: tokens.accessToken }));
      await persistSession(tokens.accessToken, tokens.refreshToken, tokens.expiresAtMs);
      return { token: tokens.accessToken, username: user.username };
    }
    return null;
  })();

  return {
    userCode: authz.userCode,
    verificationUri: authz.verificationUri,
    done,
    cancel: () => {
      canceled = true;
    },
  };
}

async function tryOAuthRefresh(): Promise<string | null> {
  const refreshToken = await ipc.credentials.getRefreshToken().catch(() => null);
  if (!refreshToken) return null;
  try {
    const tokens = await api.run(api.oauthRefresh(refreshToken));
    await persistSession(tokens.accessToken, tokens.refreshToken, tokens.expiresAtMs);
    return tokens.accessToken;
  } catch {
    return null;
  }
}

async function readExpiry(): Promise<number | null> {
  const raw = await ipc.db.getSetting(EXPIRES_AT_SETTING).catch(() => null);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Concurrent callers share one renewal; rotated refresh tokens are
// single-use, so parallel refreshes would invalidate each other.
let inflight: Promise<string | null> | null = null;

export function getAuthToken(): Promise<string | null> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [token, expiresAt] = await Promise.all([
        ipc.credentials.getToken().catch(() => null),
        readExpiry(),
      ]);
      if (token && !needsRefresh(expiresAt, Date.now())) return token;

      const refreshed = await tryOAuthRefresh();
      if (refreshed) return refreshed;

      // The CLI may have renewed its own session since we imported it.
      const imported = await importFromCli();
      if (imported && imported.token !== token) return imported.token;

      return token;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
