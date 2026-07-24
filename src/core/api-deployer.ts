import { Data, Effect } from "effect";
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
  ) => Promise<{ files: api.DeployFileMeta[]; digest: string }>;
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
}

const POLL_MS_DEFAULT = 2_500;

/** Local-only failure (never crosses a boundary) — Data, not Schema. */
class DeployError extends Data.TaggedError("DeployError")<{
  message: string;
  retryable: boolean;
}> {}

const fromApi = (e: VercelApiError) => new DeployError({ message: e.message, retryable: e.retryable });

const tryOp = <A>(f: () => Promise<A>, describe: string) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => new DeployError({ message: `${describe}: ${describeError(e)}`, retryable: false }),
  });

export function createApiDeployer(deps: ApiDeployerDeps): Deployer {
  const pollMs = deps.pollMs ?? POLL_MS_DEFAULT;

  const program = (
    req: DeployRequest,
    onProgress: (p: DeployProgress) => void,
    notifyCreated: (vercelDeploymentId: string) => void,
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

      notifyCreated(deployment.id);
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
      while (true) {
        const [current, events] = yield* Effect.all(
          [
            api.getDeployment(auth, deployment.id).pipe(Effect.mapError(fromApi)),
            api
              .getDeploymentEvents(auth, deployment.id, lastEventTs || undefined)
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
        yield* Effect.sleep(pollMs);
      }
    });

  const failedOutcome = (e: DeployError): DeployOutcome => ({
    ok: false,
    url: null,
    exitCode: null,
    canceled: false,
    error: e.message,
    retryable: e.retryable,
  });

  return {
    deploy(req, onProgress) {
      const abort = new AbortController();
      let createdVercelId: string | null = null;

      const effect = program(req, onProgress, (id) => {
        createdVercelId = id;
      }).pipe(
        // Failures become outcomes; the promise only rejects on interruption.
        Effect.catch((e) =>
          Effect.succeed(
            failedOutcome(e instanceof DeployError ? e : new DeployError({ message: String(e), retryable: false })),
          ),
        ),
      );

      const done: Promise<DeployOutcome> = api.run(effect, abort.signal).catch(
        (): DeployOutcome => ({
          ok: false,
          url: null,
          exitCode: null,
          canceled: true,
          error: null,
          retryable: false,
        }),
      );

      return {
        done,
        cancel: () => {
          abort.abort();
          // Also tell Vercel to stop the remote build, best effort.
          if (createdVercelId) {
            const id = createdVercelId;
            void deps.getToken().then((token) =>
              token ? api.run(api.cancelDeployment({ token }, id)).catch(() => {}) : undefined,
            );
          }
        },
      };
    },
  };
}
