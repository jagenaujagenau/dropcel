import { Data, Duration, Effect } from "effect";
import { describeError } from "../lib/log";
import type { DeployOutcome, DeployProgress, Deployer, DeployRequest } from "./deployer";
import { explainFailure } from "./errors";
import * as api from "./vercel-api";
import { missingShas, type VercelApiError } from "./vercel-api";

/**
 * REST-API implementation of the Deployer interface:
 *
 *   preparing  — collect the file manifest (Rust walks + SHA-1s)
 *   uploading  — POST /v13/deployments; upload the shas Vercel lacks; retry
 *   building   — poll deployment state + build events until terminal
 *   ready/failed/canceled — mapped from READY/ERROR/CANCELED
 *
 * Filesystem, token and log access are injected via ApiDeployerDeps; the
 * HTTP surface comes from vercel-api, which api-deployer.test.ts stubs
 * wholesale — so the whole pipeline runs under test with zero network or
 * IPC.
 */

export interface ApiDeployerDeps {
  getToken: () => Promise<string | null>;
  /** Project metadata looked up by our internal project id. */
  getProjectMeta: (projectId: string) => Promise<{
    framework: string;
    teamId: string | null;
    vercelProjectId: string | null;
  } | null>;
  collectFiles: (
    projectName: string,
  ) => Promise<{
    files: api.DeployFileMeta[];
    digest: string;
    /** Credential-looking files deliberately excluded from the upload. */
    skippedSensitive?: string[];
  }>;
  readFile: (projectName: string, path: string) => Promise<Uint8Array>;
  /** Structured log sink (persisted + shown live). */
  onLog: (deploymentId: string, stream: "stdout" | "stderr", line: string) => void;
  /** Called once the API assigns real identifiers. */
  onCreated: (
    ourDeploymentId: string,
    info: {
      vercelDeploymentId: string;
      inspectorUrl: string | null;
      vercelProjectId: string | null;
      ownerId: string | null;
    },
  ) => void;
  pollMs?: number;
  /** Overridable in tests — see `BUILD_TIMEOUT_MS_DEFAULT`. */
  buildTimeoutMs?: number;
}

const POLL_MS_DEFAULT = 2_500;

/**
 * How long to wait for a build to reach a terminal state before giving up.
 *
 * The poll loop below has no natural exit for a deployment that never
 * finishes, and it runs while holding one of the queue's four global deploy
 * permits (`MAX_CONCURRENT_DEPLOYS`). So four builds wedged in QUEUED —
 * a Vercel-side incident, a build hung waiting on input — used to mean *no
 * project in the app could deploy again for the rest of the session*, with
 * every other project sitting in "queued" and no way out but quitting.
 *
 * 45 minutes is deliberately above Vercel's own maximum build duration, so
 * this only ever fires for genuinely stuck builds, never for a slow-but-alive
 * one. Marked retryable: the usual cause is transient.
 */
const BUILD_TIMEOUT_MS_DEFAULT = 45 * 60 * 1_000;

/**
 * Poll ceiling for a deployment still sitting in QUEUED.
 *
 * Vercel queues server-side when a plan's concurrent-build limit is reached —
 * one on Hobby. A folder-watcher hits that constantly: touch four projects and
 * four deployments exist, but three are parked behind the first, and polling
 * each of them every `pollMs` spends the account's rate limit learning nothing.
 * A deployment that hasn't started building doesn't need 2.5s granularity, so
 * the interval backs off while QUEUED and snaps back the moment it starts.
 */
const QUEUED_POLL_CEILING_MS = 20_000;

/** Local-only failure (never crosses a boundary) — Data, not Schema. */
class DeployError extends Data.TaggedError("DeployError")<{
  message: string;
  retryable: boolean;
  /** Propagated from a 429's `Retry-After` so the queue can honour it. */
  retryAfterMs?: number | null;
}> {}

const fromApi = (e: VercelApiError) =>
  new DeployError({ message: e.message, retryable: e.retryable, retryAfterMs: e.retryAfterMs });

const tryOp = <A>(f: () => Promise<A>, describe: string) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new DeployError({ message: `${describe}: ${describeError(e)}`, retryable: false }),
  });

export function createApiDeployer(deps: ApiDeployerDeps): Deployer {
  const pollMs = deps.pollMs ?? POLL_MS_DEFAULT;
  const buildTimeoutMs = deps.buildTimeoutMs ?? BUILD_TIMEOUT_MS_DEFAULT;

  const program = (
    req: DeployRequest,
    onProgress: (p: DeployProgress) => void,
    notifyCreated: (vercelDeploymentId: string, auth: api.VercelAuth) => void,
  ) =>
    Effect.gen(function* () {
      const log = (line: string, stream: "stdout" | "stderr" = "stdout") =>
        deps.onLog(req.deploymentId, stream, line);

      // -- preparing --------------------------------------------------------
      const token = yield* tryOp(deps.getToken, "keychain");
      if (!token) {
        return yield* Effect.fail(
          new DeployError({
            message: "No Vercel access token. Open Settings and paste a token (vercel.com → Account → Tokens).",
            retryable: false,
          }),
        );
      }
      const meta = yield* tryOp(() => deps.getProjectMeta(req.projectName), "project lookup");
      const auth: api.VercelAuth = { token, teamId: meta?.teamId ?? null };

      log(`Collecting files for ${req.projectName}…`);
      const manifest = yield* tryOp(() => deps.collectFiles(req.projectName), "collect files");
      const files = manifest.files;
      if (files.length === 0) {
        return yield* Effect.fail(
          new DeployError({ message: "The project folder is empty — nothing to deploy.", retryable: false }),
        );
      }
      log(`${files.length} files, ${files.reduce((n, f) => n + f.size, 0)} bytes`);
      // Loud, in the log the user can actually open. This app publishes to a
      // public URL with no staging step, so "we quietly withheld your private
      // key" is information they need either way — whether the file was a
      // mistake, or something they expected to ship.
      const skipped = manifest.skippedSensitive ?? [];
      if (skipped.length > 0) {
        log(
          `Skipped ${skipped.length} credential file(s) — never uploaded: ${skipped.join(", ")}`,
          "stderr",
        );
      }

      const input: api.CreateDeploymentInput = {
        name: req.projectName,
        target: req.target,
        files,
        framework: meta?.framework ?? "unknown",
        projectId: meta?.vercelProjectId ?? undefined,
      };

      // -- create + upload loop --------------------------------------------
      onProgress({ phase: "uploading" });
      let deployment: api.ApiDeployment | null = null;
      // First attempt cheaply references shas; on missing_files upload only
      // what Vercel lacks, then retry. Two rounds always suffice.
      for (let round = 0; round < 3 && !deployment; round++) {
        const created = yield* api.createDeployment(auth, input).pipe(
          Effect.map((d) => ({ ok: true as const, d })),
          Effect.catch((e: VercelApiError) => {
            const missing = missingShas(e);
            if (missing && round < 2) return Effect.succeed({ ok: false as const, missing });
            return Effect.fail(fromApi(e));
          }),
        );
        if (created.ok) {
          deployment = created.d;
          break;
        }
        const bySha = new Map(files.map((f) => [f.sha, f]));
        const toUpload = created.missing.map((sha) => bySha.get(sha)).filter((f) => f != null);
        log(`Uploading ${toUpload.length} files…`);
        yield* Effect.forEach(
          toUpload,
          (file) =>
            tryOp(() => deps.readFile(req.projectName, file.path), `read ${file.path}`).pipe(
              Effect.flatMap((bytes) =>
                api.uploadFile(auth, file.sha, bytes).pipe(Effect.mapError(fromApi)),
              ),
            ),
          { concurrency: 6 },
        );
        log("Upload complete.");
      }
      if (!deployment) {
        return yield* Effect.fail(
          new DeployError({ message: "Vercel kept reporting missing files.", retryable: false }),
        );
      }

      // `auth`, not just the id: cancelling needs the same team scope the
      // deployment was created under (see `cancel` below).
      notifyCreated(deployment.id, auth);
      deps.onCreated(req.deploymentId, {
        vercelDeploymentId: deployment.id,
        inspectorUrl: deployment.inspectorUrl,
        vercelProjectId: deployment.projectId,
        ownerId: deployment.ownerId,
      });
      if (deployment.inspectorUrl) log(`Inspect: ${deployment.inspectorUrl}`);
      if (deployment.url) log(`Deployment: ${deployment.url}`);

      // -- build poll -------------------------------------------------------
      onProgress({ phase: "building", url: deployment.url ?? undefined });
      let lastEventTs = 0;
      const buildLog: string[] = [];
      const vercelDeployment = deployment;
      // Grows while the deployment is parked, resets when it starts building.
      let queuedPollMs = pollMs;
      const pollUntilTerminal = Effect.gen(function* () {
        while (true) {
          const [current, events] = yield* Effect.all(
            [
              api.getDeployment(auth, vercelDeployment.id).pipe(Effect.mapError(fromApi)),
              api
                // `+ 1` because Vercel's `since` is *inclusive*: passing
                // `lastEventTs` re-returns the newest event we already have, and
                // the loop below has no id to dedupe on (`BuildEvent` is just
                // created/text/type). That re-appended the boundary line to
                // `deployment_logs` once per 2.5s poll — visibly repeated lines
                // in the log viewer, and unbounded row growth on a long build.
                // Asking for strictly-newer events fixes it at the source, while
                // still keeping distinct events that share a millisecond (which
                // filtering client-side on `created` would have dropped).
                .getDeploymentEvents(auth, vercelDeployment.id, lastEventTs ? lastEventTs + 1 : undefined)
                .pipe(Effect.catch(() => Effect.succeed([] as api.BuildEvent[]))),
            ],
            { concurrency: 2 },
          );
          for (const ev of events) {
            if (ev.created > lastEventTs) lastEventTs = ev.created;
            buildLog.push(ev.text);
            for (const line of ev.text.split("\n")) {
              log(line, ev.type === "stderr" ? "stderr" : "stdout");
            }
          }
          const state = current.readyState;
          if (state === "READY") {
            return {
              ok: true,
              url: current.aliases[0] ?? current.url,
              exitCode: 0,
              canceled: false,
              error: null,
              retryable: false,
              contentDigest: manifest.digest,
            } satisfies DeployOutcome;
          }
          if (state === "CANCELED") {
            return {
              ok: false,
              url: current.url,
              exitCode: null,
              canceled: true,
              error: null,
              retryable: false,
            } satisfies DeployOutcome;
          }
          if (state === "ERROR") {
            const explained = explainFailure(
              [current.errorMessage ?? "", ...buildLog].join("\n"),
            );
            return {
              ok: false,
              url: current.url,
              exitCode: 1,
              canceled: false,
              error: current.errorMessage
                ? `Build failed: ${current.errorMessage}`
                : explained.message,
              retryable: explained.retryable,
            } satisfies DeployOutcome;
          }
          // Still non-terminal. QUEUED means Vercel hasn't started it —
          // usually because another build holds the plan's only slot — so
          // there is nothing to learn by asking again soon.
          if (state === "QUEUED") {
            yield* Effect.sleep(queuedPollMs);
            queuedPollMs = Math.min(queuedPollMs * 2, QUEUED_POLL_CEILING_MS);
          } else {
            queuedPollMs = pollMs;
            yield* Effect.sleep(pollMs);
          }
        }
      });

      return yield* pollUntilTerminal.pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(buildTimeoutMs),
          orElse: () =>
            Effect.fail(
              new DeployError({
                message:
                  "Vercel never reported this build as finished. It may still be running — check the deployment on Vercel.",
                retryable: true,
              }),
            ),
        }),
      );
    });

  const failedOutcome = (e: DeployError): DeployOutcome => ({
    ok: false,
    url: null,
    exitCode: null,
    canceled: false,
    error: e.message,
    retryable: e.retryable,
    retryAfterMs: e.retryAfterMs ?? null,
  });

  return {
    deploy(req, onProgress) {
      const abort = new AbortController();
      let createdVercelId: string | null = null;
      let createdAuth: api.VercelAuth | null = null;

      const effect = program(req, onProgress, (id, auth) => {
        createdVercelId = id;
        createdAuth = auth;
      }).pipe(
        // Failures become outcomes; the promise only rejects on interruption.
        Effect.catch((e) =>
          Effect.succeed(
            failedOutcome(e instanceof DeployError ? e : new DeployError({ message: String(e), retryable: false })),
          ),
        ),
      );

      /**
       * `effect` already turns every *typed* `DeployError` into an outcome, so
       * a rejection here is one of exactly two things: real interruption, or a
       * defect — something threw where nothing was declared to fail (the bare
       * `JSON.parse` in `vercel-api`'s response handling is the likely one: a
       * proxy's 502 HTML page, a Cloudflare interstitial, a truncated body).
       *
       * Reporting both as `canceled` meant a transient network hiccup showed
       * up as a deployment the user appeared to have cancelled themselves —
       * no error text, and no retry, since `canceled` short-circuits both the
       * retry policy and the error explainer. For an app whose pitch is that
       * failures read like "package.json is missing" rather than "something
       * went wrong", that was the worst possible reporting.
       *
       * The abort signal is what actually distinguishes them.
       */
      const done: Promise<DeployOutcome> = api.run(effect, abort.signal).catch(
        (cause: unknown): DeployOutcome =>
          abort.signal.aborted
            ? {
                ok: false,
                url: null,
                exitCode: null,
                canceled: true,
                error: null,
                retryable: false,
              }
            : {
                ok: false,
                url: null,
                exitCode: null,
                canceled: false,
                error: `Deployment failed unexpectedly: ${describeError(cause)}`,
                // Defects here are overwhelmingly transient transport
                // problems, so let the queue's retry policy have a go.
                retryable: true,
              },
      );

      return {
        done,
        cancel: () => {
          abort.abort();
          // Also tell Vercel to stop the remote build, best effort.
          //
          // Reuses the exact `auth` the deployment was created under. Building
          // a fresh `{ token }` here dropped `teamId`, so for any project in a
          // team scope the PATCH was unauthorized — and since the failure is
          // swallowed below, the app showed "canceled" while Vercel happily
          // kept building (and billing) it.
          const id = createdVercelId;
          const auth = createdAuth as api.VercelAuth | null;
          if (id && auth) {
            void api.run(api.cancelDeployment(auth, id)).catch(() => {});
          }
        },
      };
    },
  };
}
