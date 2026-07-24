import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApiDeployer, type ApiDeployerDeps } from "./api-deployer";
import type { DeployProgress, DeployRequest } from "./deployer";
import type * as VercelApi from "./vercel-api";

/**
 * Tests for the REST-API deployer against a scripted vercel-api module —
 * zero network, zero IPC. The injected deps (files, token, logs) are plain
 * fakes; the HTTP surface (create/upload/poll/cancel) is stubbed wholesale.
 */

const mocks = vi.hoisted(() => ({
  createDeployment: vi.fn(),
  uploadFile: vi.fn(),
  getDeployment: vi.fn(),
  getDeploymentEvents: vi.fn(),
  cancelDeployment: vi.fn(),
}));

vi.mock("./vercel-api", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelApi>();
  return {
    ...actual,
    // Real promise boundary, fake HTTP: effects come from the mocks below.
    run: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      Effect.runPromise(effect, signal ? { signal } : undefined),
    createDeployment: (...args: unknown[]) => mocks.createDeployment(...args),
    uploadFile: (...args: unknown[]) => mocks.uploadFile(...args),
    getDeployment: (...args: unknown[]) => mocks.getDeployment(...args),
    getDeploymentEvents: (...args: unknown[]) => mocks.getDeploymentEvents(...args),
    cancelDeployment: (...args: unknown[]) => mocks.cancelDeployment(...args),
  };
});

// Imported AFTER the mock so we get the real error class + helpers.
import { VercelApiError, type ApiDeployment } from "./vercel-api";

const apiError = (over: Partial<ConstructorParameters<typeof VercelApiError>[0]> = {}) =>
  new VercelApiError({ status: 400, code: null, message: "bad request", detail: null, ...over });

const dpl = (over: Partial<ApiDeployment> = {}): ApiDeployment => ({
  id: "dpl_1",
  url: "https://blog-abc123.vercel.app",
  readyState: "QUEUED",
  inspectorUrl: "https://vercel.com/inspect/dpl_1",
  aliases: [],
  ownerId: "team_1",
  projectId: "prj_1",
  errorMessage: null,
  ...over,
});

const req = (over: Partial<DeployRequest> = {}): DeployRequest => ({
  deploymentId: "dep-1",
  projectName: "blog",
  projectPath: "/root/blog",
  target: "production",
  attempt: 1,
  ...over,
});

const FILES = [
  { path: "index.html", sha: "sha-index", size: 10 },
  { path: "app.js", sha: "sha-app", size: 20 },
];

interface Harness {
  deps: ApiDeployerDeps;
  logs: string[];
  created: unknown[];
  uploadedShas: () => string[];
  progress: DeployProgress[];
}

function makeHarness(overrides: Partial<ApiDeployerDeps> = {}): Harness {
  const logs: string[] = [];
  const created: unknown[] = [];
  const deps: ApiDeployerDeps = {
    getToken: async () => "tok",
    getProjectMeta: async () => ({
      framework: "static",
      teamId: null,
      vercelProjectId: "prj_1",
    }),
    collectFiles: async () => ({ files: FILES, digest: "digest-1" }),
    readFile: async (_project, path) => new TextEncoder().encode(path),
    onLog: (_id, _stream, line) => logs.push(line),
    onCreated: (_id, info) => created.push(info),
    pollMs: 1,
    ...overrides,
  };
  return {
    deps,
    logs,
    created,
    uploadedShas: () => mocks.uploadFile.mock.calls.map((c) => c[1] as string),
    progress: [],
  };
}

function deploy(h: Harness, r = req()) {
  const deployer = createApiDeployer(h.deps);
  return deployer.deploy(r, (p) => h.progress.push(p));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDeploymentEvents.mockReturnValue(Effect.succeed([]));
  mocks.cancelDeployment.mockReturnValue(Effect.void);
});

describe("api deployer", () => {
  it("happy path: uploading → building → ready, with the manifest digest", async () => {
    mocks.createDeployment.mockReturnValue(Effect.succeed(dpl({ readyState: "QUEUED" })));
    mocks.getDeployment.mockReturnValue(
      Effect.succeed(dpl({ readyState: "READY", aliases: ["https://blog.vercel.app"] })),
    );
    const h = makeHarness();
    const outcome = await deploy(h).done;

    // The queue emits "preparing" before handing over; the deployer reports
    // the phases it owns, in order.
    expect(h.progress.map((p) => p.phase)).toEqual(["uploading", "building"]);
    expect(outcome).toMatchObject({
      ok: true,
      canceled: false,
      url: "https://blog.vercel.app", // alias preferred over deployment url
      exitCode: 0,
      contentDigest: "digest-1",
    });
    expect(h.created).toEqual([
      {
        vercelDeploymentId: "dpl_1",
        inspectorUrl: "https://vercel.com/inspect/dpl_1",
        vercelProjectId: "prj_1",
        ownerId: "team_1",
      },
    ]);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("missing_files loop: uploads exactly the reported shas, then retries create", async () => {
    mocks.createDeployment
      .mockReturnValueOnce(
        Effect.fail(
          apiError({ code: "missing_files", detail: { missing: ["sha-app"] } }),
        ),
      )
      .mockReturnValueOnce(Effect.succeed(dpl()));
    mocks.uploadFile.mockReturnValue(Effect.void);
    mocks.getDeployment.mockReturnValue(Effect.succeed(dpl({ readyState: "READY" })));

    const h = makeHarness();
    const outcome = await deploy(h).done;

    expect(h.uploadedShas()).toEqual(["sha-app"]); // only what Vercel lacked
    expect(mocks.createDeployment).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(true);
  });

  it("build poll ERROR maps to failed with explainFailure applied", async () => {
    mocks.createDeployment.mockReturnValue(Effect.succeed(dpl()));
    mocks.getDeployment.mockReturnValue(Effect.succeed(dpl({ readyState: "ERROR" })));
    mocks.getDeploymentEvents.mockReturnValue(
      Effect.succeed([{ created: 1, type: "stderr", text: "npm ERR! peer dep hell" }]),
    );
    const h = makeHarness();
    const outcome = await deploy(h).done;

    expect(outcome.ok).toBe(false);
    expect(outcome.canceled).toBe(false);
    expect(outcome.exitCode).toBe(1);
    // The raw npm noise is translated into an actionable explanation.
    expect(outcome.error).toMatch(/Installing dependencies failed/);
    expect(outcome.retryable).toBe(false);
  });

  it("build poll CANCELED maps to a canceled outcome", async () => {
    mocks.createDeployment.mockReturnValue(Effect.succeed(dpl()));
    mocks.getDeployment.mockReturnValue(Effect.succeed(dpl({ readyState: "CANCELED" })));
    const h = makeHarness();
    const outcome = await deploy(h).done;
    expect(outcome).toMatchObject({ ok: false, canceled: true, error: null });
  });

  it("cancel mid-poll: issues the remote cancel and resolves canceled", async () => {
    mocks.createDeployment.mockReturnValue(Effect.succeed(dpl()));
    mocks.getDeployment.mockReturnValue(Effect.succeed(dpl({ readyState: "BUILDING" })));
    const h = makeHarness();
    const handle = deploy(h);
    // Let the poll loop spin at least once, then abort.
    await new Promise((r) => setTimeout(r, 20));
    handle.cancel();
    const outcome = await handle.done;

    expect(outcome).toMatchObject({ ok: false, canceled: true, error: null });
    await vi.waitFor(() => expect(mocks.cancelDeployment).toHaveBeenCalled());
    // Best-effort remote cancel targets the created deployment.
    expect(mocks.cancelDeployment.mock.calls[0][1]).toBe("dpl_1");
  });

  it("propagates retryable API errors so the pipeline can retry", async () => {
    mocks.createDeployment.mockReturnValue(
      Effect.fail(apiError({ status: 500, message: "internal error" })),
    );
    const h = makeHarness();
    const outcome = await deploy(h).done;
    expect(outcome).toMatchObject({ ok: false, canceled: false, retryable: true });
    expect(outcome.error).toBe("internal error");
  });

  it("fails fast without a token, pointing at Settings", async () => {
    const h = makeHarness({ getToken: async () => null });
    const outcome = await deploy(h).done;
    expect(outcome.ok).toBe(false);
    expect(outcome.retryable).toBe(false);
    expect(outcome.error).toMatch(/No Vercel access token/);
    expect(mocks.createDeployment).not.toHaveBeenCalled();
  });

  it("an empty project folder is a permanent, explained failure", async () => {
    const h = makeHarness({ collectFiles: async () => ({ files: [], digest: "d" }) });
    const outcome = await deploy(h).done;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/empty — nothing to deploy/);
  });
});
