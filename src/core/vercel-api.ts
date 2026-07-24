import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { Data, Effect, Layer, ManagedRuntime } from "effect";

/**
 * The Vercel REST API client, built on effect/unstable/http's HttpClient. The
 * fetch implementation is Tauri's (Rust-side HTTP), so requests are immune
 * to webview CORS restrictions. Every method is an Effect; `run` converts to
 * a Promise at the promise-based application boundary.
 */

const BASE = "https://api.vercel.com";

export interface VercelAuth {
  token: string;
  /** team_… id for team-scoped resources; null/undefined = personal scope. */
  teamId?: string | null;
}

export class VercelApiError extends Data.TaggedError("VercelApiError")<{
  status: number;
  code: string | null;
  message: string;
  /** Extra payload, e.g. `missing` sha list on missing_files. */
  detail: unknown;
}> {
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

// Tauri's fetch is fetch-compatible; hand it to the Effect platform layer.
const HttpLive = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch, tauriFetch as unknown as typeof globalThis.fetch),
  ),
);

const runtime = ManagedRuntime.make(HttpLive);

/** Run an API effect at the promise boundary. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  signal?: AbortSignal,
): Promise<A> => runtime.runPromise(effect, signal ? { signal } : undefined);

const withQuery = (path: string, auth: VercelAuth, extra?: Record<string, string>) => {
  const params = new URLSearchParams(extra);
  if (auth.teamId) params.set("teamId", auth.teamId);
  const qs = params.toString();
  return `${BASE}${path}${qs ? `?${qs}` : ""}`;
};

interface VercelErrorBody {
  error?: { code?: string; message?: string; [k: string]: unknown };
}

function request(
  auth: VercelAuth,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; query?: Record<string, string>; raw?: Uint8Array; headers?: Record<string, string> } = {},
): Effect.Effect<unknown, VercelApiError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let req = HttpClientRequest.make(method)(withQuery(path, auth, options.query)).pipe(
      HttpClientRequest.setHeader("Authorization", `Bearer ${auth.token}`),
      HttpClientRequest.setHeaders(options.headers ?? {}),
    );
    if (options.raw) {
      req = HttpClientRequest.bodyUint8Array(req, options.raw, "application/octet-stream");
    } else if (options.body !== undefined) {
      req = yield* HttpClientRequest.bodyJson(req, options.body).pipe(
        Effect.mapError(
          (e) => new VercelApiError({ status: 0, code: "body", message: String(e), detail: null }),
        ),
      );
    }

    const res = yield* client.execute(req).pipe(
      Effect.mapError(
        (e) =>
          new VercelApiError({
            status: 0,
            code: "network",
            message: `Could not reach the Vercel API: ${e.message}`,
            detail: null,
          }),
      ),
    );
    const text = yield* res.text.pipe(
      Effect.mapError(
        (e) => new VercelApiError({ status: res.status, code: "read", message: String(e), detail: null }),
      ),
    );
    const json: unknown = text ? JSON.parse(text) : null;
    if (res.status >= 400) {
      const err = (json as VercelErrorBody)?.error;
      return yield* new VercelApiError({
        status: res.status,
        code: err?.code ?? null,
        message: err?.message ?? `Vercel API request failed (${res.status})`,
        detail: err ?? json,
      });
    }
    return json;
  }).pipe(Effect.scoped);
}

// ---- OAuth (refresh for imported CLI sessions) -----------------------------

/** The Vercel CLI's public OAuth client id (from the open-source CLI). */
export const VERCEL_CLI_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";
const OPENID_CONFIG_URL = "https://vercel.com/.well-known/openid-configuration";

export interface OAuthTokens {
  accessToken: string;
  /** Rotated refresh token (RFC 6749 servers may issue a new one). */
  refreshToken: string | null;
  expiresAtMs: number | null;
}

/** Pure: interpret a token-endpoint response. */
export function parseTokenResponse(json: unknown, nowMs: number): OAuthTokens | null {
  if (typeof json !== "object" || json === null) return null;
  const t = json as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token) return null;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAtMs: typeof t.expires_in === "number" ? nowMs + t.expires_in * 1000 : null,
  };
}

const oauthError = (message: string) =>
  new VercelApiError({ status: 0, code: "oauth", message, detail: null });

interface OpenIdConfig {
  token_endpoint?: string;
  device_authorization_endpoint?: string;
}

let openIdCache: OpenIdConfig | null = null;

const discoverOpenId = Effect.gen(function* () {
  if (openIdCache) return openIdCache;
  const client = yield* HttpClient.HttpClient;
  const res = yield* client
    .execute(HttpClientRequest.get(OPENID_CONFIG_URL))
    .pipe(Effect.mapError((e) => oauthError(`OpenID discovery failed: ${e.message}`)));
  const text = yield* res.text.pipe(Effect.mapError((e) => oauthError(String(e))));
  openIdCache = JSON.parse(text) as OpenIdConfig;
  return openIdCache;
}).pipe(Effect.scoped);

const formPost = (endpoint: string, params: Record<string, string>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client
      .execute(
        HttpClientRequest.post(endpoint).pipe(
          HttpClientRequest.bodyText(
            new URLSearchParams(params).toString(),
            "application/x-www-form-urlencoded",
          ),
        ),
      )
      .pipe(Effect.mapError((e) => oauthError(`request failed: ${e.message}`)));
    const text = yield* res.text.pipe(Effect.mapError((e) => oauthError(String(e))));
    return { status: res.status, json: (text ? JSON.parse(text) : null) as unknown };
  }).pipe(Effect.scoped);

// ---- OAuth device flow ("Sign in with Vercel") -----------------------------

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  /** URL to open in the browser (pre-filled with the code when available). */
  verificationUri: string;
  expiresInMs: number;
  intervalMs: number;
}

/** Pure: interpret a device-authorization response (RFC 8628 §3.2). */
export function parseDeviceAuthorization(json: unknown): DeviceAuthorization | null {
  if (typeof json !== "object" || json === null) return null;
  const d = json as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!d.device_code || !d.user_code) return null;
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri_complete ?? d.verification_uri ?? "https://vercel.com",
    expiresInMs: (d.expires_in ?? 600) * 1000,
    intervalMs: (d.interval ?? 5) * 1000,
  };
}

export type DevicePollResult =
  | { status: "ok"; tokens: OAuthTokens }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied"; reason: string };

/** Pure: interpret a device-flow token poll response (RFC 8628 §3.5). */
export function parseDevicePoll(json: unknown, nowMs: number): DevicePollResult {
  const tokens = parseTokenResponse(json, nowMs);
  if (tokens) return { status: "ok", tokens };
  const err = (json as { error?: string } | null)?.error;
  if (err === "authorization_pending") return { status: "pending" };
  if (err === "slow_down") return { status: "slow_down" };
  return { status: "denied", reason: err ?? "no response" };
}

export const oauthDeviceAuthorize = () =>
  Effect.gen(function* () {
    const config = yield* discoverOpenId;
    if (!config.device_authorization_endpoint) {
      return yield* oauthError("no device_authorization_endpoint in OpenID configuration");
    }
    const { json } = yield* formPost(config.device_authorization_endpoint, {
      client_id: VERCEL_CLI_CLIENT_ID,
    });
    const parsed = parseDeviceAuthorization(json);
    if (!parsed) return yield* oauthError("malformed device authorization response");
    return parsed;
  });

export const oauthDevicePoll = (deviceCode: string) =>
  Effect.gen(function* () {
    const config = yield* discoverOpenId;
    if (!config.token_endpoint) {
      return yield* oauthError("no token_endpoint in OpenID configuration");
    }
    const { json } = yield* formPost(config.token_endpoint, {
      client_id: VERCEL_CLI_CLIENT_ID,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    });
    return parseDevicePoll(json, Date.now());
  });

/** Exchange a refresh token for a fresh access token (endpoint discovered
 * via OpenID configuration, standard refresh_token grant). */
export const oauthRefresh = (refreshToken: string) =>
  Effect.gen(function* () {
    const config = yield* discoverOpenId;
    if (!config.token_endpoint) {
      return yield* oauthError("no token_endpoint in OpenID configuration");
    }
    const { status, json } = yield* formPost(config.token_endpoint, {
      client_id: VERCEL_CLI_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (status >= 400) return yield* oauthError(`token refresh rejected (${status})`);
    const tokens = parseTokenResponse(json, Date.now());
    if (!tokens) return yield* oauthError("token response had no access_token");
    return tokens;
  });

// ---- typed surface ---------------------------------------------------------

export interface ApiUser {
  uid: string;
  username: string;
  defaultTeamId: string | null;
  /** Profile picture served by vercel.com, or null when unset. */
  avatarUrl: string | null;
}

export const getUser = (auth: VercelAuth) =>
  request(auth, "GET", "/v2/user").pipe(
    Effect.map((j) => {
      const u = (
        j as {
          user: {
            id?: string;
            uid?: string;
            username: string;
            defaultTeamId?: string | null;
            avatar?: string | null;
          };
        }
      ).user;
      return {
        // /v2/user returns `id`; some older payloads used `uid`.
        uid: u.id ?? u.uid ?? "",
        username: u.username,
        defaultTeamId: u.defaultTeamId ?? null,
        avatarUrl: u.avatar
          ? `https://vercel.com/api/www/avatar/${u.avatar}?s=64`
          : null,
      } satisfies ApiUser;
    }),
  );

export interface ApiTeam {
  id: string;
  slug: string;
}

export const listTeams = (auth: VercelAuth) =>
  request(auth, "GET", "/v2/teams").pipe(
    Effect.map((j) => ((j as { teams?: ApiTeam[] }).teams ?? []).map((t) => ({ id: t.id, slug: t.slug }))),
  );

export interface ApiProject {
  id: string;
  name: string;
  accountId: string;
  link: { type: string; org?: string; repo?: string } | null;
}

export const getProject = (auth: VercelAuth, idOrName: string) =>
  request(auth, "GET", `/v9/projects/${encodeURIComponent(idOrName)}`).pipe(
    Effect.map((j) => {
      const p = j as { id: string; name: string; accountId: string; link?: ApiProject["link"] };
      return { id: p.id, name: p.name, accountId: p.accountId, link: p.link ?? null } satisfies ApiProject;
    }),
  );

export interface DeployFileMeta {
  path: string;
  sha: string;
  size: number;
}

export interface ApiDeployment {
  id: string;
  url: string | null;
  readyState: string;
  inspectorUrl: string | null;
  aliases: string[];
  ownerId: string | null;
  projectId: string | null;
  errorMessage: string | null;
}

function toDeployment(j: unknown): ApiDeployment {
  const d = j as {
    id: string;
    url?: string;
    readyState?: string;
    status?: string;
    inspectorUrl?: string;
    alias?: string[];
    ownerId?: string;
    projectId?: string;
    project?: { id?: string };
    errorMessage?: string;
  };
  return {
    id: d.id,
    url: d.url ? `https://${d.url.replace(/^https:\/\//, "")}` : null,
    readyState: (d.readyState ?? d.status ?? "QUEUED").toUpperCase(),
    inspectorUrl: d.inspectorUrl ?? null,
    aliases: (d.alias ?? []).map((a) => `https://${a.replace(/^https:\/\//, "")}`),
    ownerId: d.ownerId ?? null,
    projectId: d.projectId ?? d.project?.id ?? null,
    errorMessage: d.errorMessage ?? null,
  };
}

/** Vercel framework slugs for project settings; null = auto/other. */
export function frameworkSlug(framework: string): string | null {
  const map: Record<string, string> = {
    nextjs: "nextjs",
    nuxt: "nuxtjs",
    astro: "astro",
    remix: "remix",
    svelte: "sveltekit",
    vue: "vue",
    vite: "vite",
    react: "create-react-app",
  };
  return map[framework] ?? null;
}

export interface CreateDeploymentInput {
  name: string;
  target: "production" | "preview";
  files: DeployFileMeta[];
  framework: string;
  /** Existing Vercel project id when known. */
  projectId?: string | null;
}

/**
 * Create a deployment from a file manifest. Fails with code "missing_files"
 * (detail.missing: sha[]) when content must be uploaded first.
 */
export const createDeployment = (auth: VercelAuth, input: CreateDeploymentInput) =>
  request(auth, "POST", "/v13/deployments", {
    query: { skipAutoDetectionConfirmation: "1", forceNew: "1" },
    body: {
      name: input.name,
      project: input.projectId ?? undefined,
      target: input.target === "production" ? "production" : undefined,
      files: input.files.map((f) => ({ file: f.path, sha: f.sha, size: f.size })),
      projectSettings: { framework: frameworkSlug(input.framework) },
    },
  }).pipe(Effect.map(toDeployment));

/** Shas Vercel reported missing on a failed create, or null if other error. */
export function missingShas(e: VercelApiError): string[] | null {
  if (e.code !== "missing_files") return null;
  const detail = e.detail as { missing?: string[] } | null;
  return detail?.missing ?? [];
}

export const uploadFile = (auth: VercelAuth, sha: string, content: Uint8Array) =>
  request(auth, "POST", "/v2/files", {
    raw: content,
    headers: { "x-vercel-digest": sha },
  }).pipe(Effect.asVoid);

export const getDeployment = (auth: VercelAuth, deploymentId: string) =>
  request(auth, "GET", `/v13/deployments/${deploymentId}`).pipe(Effect.map(toDeployment));

export interface BuildEvent {
  created: number;
  text: string;
  type: string;
}

export const getDeploymentEvents = (auth: VercelAuth, deploymentId: string, since?: number) =>
  request(auth, "GET", `/v3/deployments/${deploymentId}/events`, {
    query: {
      builds: "1",
      limit: "200",
      ...(since ? { since: String(since) } : {}),
    },
  }).pipe(
    Effect.map((j) => {
      const events = Array.isArray(j) ? j : [];
      return events
        .map((e) => {
          const ev = e as { created?: number; type?: string; payload?: { text?: string }; text?: string };
          return {
            created: ev.created ?? 0,
            type: ev.type ?? "stdout",
            text: ev.payload?.text ?? ev.text ?? "",
          } satisfies BuildEvent;
        })
        .filter((e) => e.text.length > 0);
    }),
  );

export const cancelDeployment = (auth: VercelAuth, deploymentId: string) =>
  request(auth, "PATCH", `/v12/deployments/${deploymentId}/cancel`).pipe(Effect.asVoid);

// ---- domains ---------------------------------------------------------------

export interface ApiProjectDomain {
  name: string;
  verified: boolean;
  verification: { type: string; domain: string; value: string }[];
}

const toProjectDomain = (j: unknown): ApiProjectDomain => {
  const d = j as {
    name: string;
    verified?: boolean;
    verification?: { type: string; domain: string; value: string }[];
  };
  return { name: d.name, verified: d.verified ?? false, verification: d.verification ?? [] };
};

export const addProjectDomain = (auth: VercelAuth, projectId: string, domain: string) =>
  request(auth, "POST", `/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    body: { name: domain },
  }).pipe(Effect.map(toProjectDomain));

export const getProjectDomain = (auth: VercelAuth, projectId: string, domain: string) =>
  request(auth, "GET", `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`).pipe(
    Effect.map(toProjectDomain),
  );

export const removeProjectDomain = (auth: VercelAuth, projectId: string, domain: string) =>
  request(auth, "DELETE", `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`).pipe(
    Effect.asVoid,
  );

/** misconfigured = DNS not yet pointing at Vercel. */
export const getDomainConfig = (auth: VercelAuth, domain: string) =>
  request(auth, "GET", `/v6/domains/${encodeURIComponent(domain)}/config`).pipe(
    Effect.map((j) => ({ misconfigured: (j as { misconfigured?: boolean }).misconfigured ?? true })),
  );

// ---- project ops -----------------------------------------------------------

export const deleteProject = (auth: VercelAuth, projectId: string) =>
  request(auth, "DELETE", `/v9/projects/${encodeURIComponent(projectId)}`).pipe(Effect.asVoid);

export const promoteDeployment = (auth: VercelAuth, projectId: string, deploymentId: string) =>
  request(auth, "POST", `/v10/projects/${encodeURIComponent(projectId)}/promote/${deploymentId}`).pipe(
    Effect.asVoid,
  );

export const rollbackDeployment = (auth: VercelAuth, projectId: string, deploymentId: string) =>
  request(auth, "POST", `/v9/projects/${encodeURIComponent(projectId)}/rollback/${deploymentId}`).pipe(
    Effect.asVoid,
  );
