import * as ipc from "../lib/ipc";
import { activeSessionToken } from "./account-session";
import * as api from "./vercel-api";

/**
 * Pure auth helpers and session import/sign-in flows. The token lifecycle
 * itself (single-flight renewal, refresh-margin policy, CLI re-import) lives
 * in core/account-session.ts; `getAuthToken()` here stays the process-wide
 * entry point and delegates to the active session.
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

/** Why a refresh_token grant produced no token. */
export type RefreshFailureReason = "no-refresh-token" | "rejected" | "network";

export type RefreshOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: RefreshFailureReason };

/** A 4xx from the token endpoint means the grant itself was refused (the
 * refresh token is revoked/expired); everything else is infrastructure. */
function classifyRefreshError(err: unknown): RefreshFailureReason {
  if (err instanceof api.VercelApiError) {
    const status = Number(/token refresh rejected \((\d+)\)/.exec(err.message)?.[1]);
    if (status >= 400 && status < 500 && status !== 429) return "rejected";
  }
  return "network";
}

/** OAuth refresh_token grant with a classified outcome; persists rotated
 * tokens on success. The account session uses the classification to raise
 * typed TokenRevoked / NetworkDown failures. */
export async function oauthRefreshOutcome(): Promise<RefreshOutcome> {
  const refreshToken = await ipc.credentials.getRefreshToken().catch(() => null);
  if (!refreshToken) return { ok: false, reason: "no-refresh-token" };
  try {
    const tokens = await api.run(api.oauthRefresh(refreshToken));
    await persistSession(tokens.accessToken, tokens.refreshToken, tokens.expiresAtMs);
    return { ok: true, token: tokens.accessToken };
  } catch (err) {
    return { ok: false, reason: classifyRefreshError(err) };
  }
}

/** OAuth refresh_token grant; persists rotated tokens. Null on any miss. */
export async function tryOAuthRefresh(): Promise<string | null> {
  const outcome = await oauthRefreshOutcome();
  return outcome.ok ? outcome.token : null;
}

/** Recorded expiry of the stored token, or null (manual PAT / unknown). */
export async function readExpiry(): Promise<number | null> {
  const raw = await ipc.db.getSetting(EXPIRES_AT_SETTING).catch(() => null);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Obtain a Vercel access token — delegates to the active AccountSession,
 * which owns the single-flight renewal (see core/account-session.ts). */
export function getAuthToken(): Promise<string | null> {
  return activeSessionToken();
}
