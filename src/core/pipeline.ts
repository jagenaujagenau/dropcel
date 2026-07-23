import { Duration, Effect, Schedule } from "effect";
import type { DeployHandle, DeployOutcome, DeployProgress, Deployer, DeployRequest } from "./deployer";

/**
 * A single deployment execution wrapped in Effect: transient failures
 * (network blips, rate limits) retry with exponential backoff; interruption
 * kills the underlying CLI process.
 */

export class DeployFailure {
  readonly _tag = "DeployFailure";
  constructor(readonly outcome: DeployOutcome) {}
}

export interface PipelineOptions {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxRetries: 2,
  baseDelayMs: 3_000,
};

/**
 * Build the Effect for one deployment attempt. Fails with DeployFailure so
 * the retry policy can inspect `retryable`; succeeds with the outcome
 * (including cancellation, which must never be retried).
 */
function attempt(
  deployer: Deployer,
  req: DeployRequest,
  onProgress: (p: DeployProgress) => void,
): Effect.Effect<DeployOutcome, DeployFailure> {
  return Effect.async<DeployOutcome, DeployFailure>((resume) => {
    let handle: DeployHandle | null = null;
    handle = deployer.deploy(req, onProgress);
    void handle.done.then((outcome) => {
      if (outcome.ok || outcome.canceled) resume(Effect.succeed(outcome));
      else resume(Effect.fail(new DeployFailure(outcome)));
    });
    // Interruption (user cancel / app shutdown) kills the CLI process.
    return Effect.sync(() => handle?.cancel());
  });
}

/**
 * Execute a deployment with automatic retries for transient failures.
 * Resolves with the final outcome — retries exhausted means the last failure.
 */
export function executeDeployment(
  deployer: Deployer,
  req: DeployRequest,
  onProgress: (p: DeployProgress) => void,
  onRetry: (attemptNumber: number) => void,
  options: PipelineOptions = DEFAULT_PIPELINE_OPTIONS,
): Effect.Effect<DeployOutcome, never> {
  let attemptNumber = req.attempt;

  const policy = Schedule.exponential(Duration.millis(options.baseDelayMs)).pipe(
    Schedule.intersect(Schedule.recurs(options.maxRetries)),
    Schedule.whileInput((f: DeployFailure) => f.outcome.retryable),
  );

  // suspend: each retry re-evaluates with the current attempt number.
  return Effect.suspend(() =>
    attempt(deployer, { ...req, attempt: attemptNumber }, onProgress),
  ).pipe(
    Effect.tapError((f) =>
      Effect.sync(() => {
        // Only announce a retry when the policy will actually run one.
        if (f.outcome.retryable && attemptNumber - req.attempt < options.maxRetries) {
          attemptNumber += 1;
          onRetry(attemptNumber);
        }
      }),
    ),
    Effect.retry(policy),
    Effect.catchAll((f: DeployFailure) => Effect.succeed(f.outcome)),
  );
}
