import type { DeploymentState, DeployTarget } from "./types";

/**
 * The Deployer boundary. The queue, pipeline and UI only know this
 * interface. The production implementation is the REST-API deployer
 * (api-deployer.ts); tests use scriptable fakes.
 */

export interface DeployRequest {
  deploymentId: string;
  projectName: string;
  projectPath: string;
  target: DeployTarget;
  attempt: number;
}

export interface DeployProgress {
  phase: Extract<DeploymentState, "preparing" | "uploading" | "building">;
  url?: string;
}

export interface DeployOutcome {
  ok: boolean;
  url: string | null;
  exitCode: number | null;
  canceled: boolean;
  /** Actionable, human-readable failure explanation. */
  error: string | null;
  retryable: boolean;
  /** Manifest digest of the content that was deployed (success only) —
   * feeds the skip-identical-auto-deploys guard. */
  contentDigest?: string | null;
}

export interface DeployHandle {
  done: Promise<DeployOutcome>;
  cancel: () => void;
}

export interface Deployer {
  deploy(req: DeployRequest, onProgress: (p: DeployProgress) => void): DeployHandle;
}
