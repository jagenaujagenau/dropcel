/**
 * Turn raw build output (Vercel build events / error messages) into a human
 * explanation the user can act on. The rule: never show "Something went
 * wrong" — always say what happened and, when possible, what to do next.
 */

interface ErrorRule {
  match: RegExp;
  explain: (m: RegExpMatchArray) => string;
  /** Transient errors are worth retrying automatically. */
  retryable: boolean;
}

const RULES: ErrorRule[] = [
  {
    match: /ENOENT.*package\.json|Could not read package\.json/i,
    explain: () =>
      "Build failed because package.json is missing or unreadable. Add a package.json to the project root, or remove it entirely to deploy as a static site.",
    retryable: false,
  },
  {
    match: /The specified token is not valid|Not authorized|invalid.*token/i,
    explain: () =>
      "Your Vercel token is invalid or expired. Open Settings and sign in again.",
    retryable: false,
  },
  {
    match: /credentials.*(no longer valid|expired)|please.*(log ?in|authenticate)/i,
    explain: () =>
      "You are not signed in to Vercel. Open Settings and connect your account.",
    retryable: false,
  },
  {
    match: /Command "([^"]+)" exited with (\d+)/i,
    explain: (m) =>
      `The build command \`${m[1]}\` failed (exit code ${m[2]}). Open the logs to see the compiler output.`,
    retryable: false,
  },
  {
    match: /npm ERR!|pnpm ERR|yarn error|ERESOLVE/i,
    explain: () =>
      "Installing dependencies failed. Check that package.json lists valid, compatible versions — the full npm output is in the logs.",
    retryable: false,
  },
  {
    match: /Cannot find module ['"]([^'"]+)['"]/i,
    explain: (m) =>
      `The build could not find the module "${m[1]}". It is probably missing from package.json dependencies.`,
    retryable: false,
  },
  {
    match: /Module not found/i,
    explain: () =>
      "The build could not resolve an import. A dependency is probably missing from package.json.",
    retryable: false,
  },
  {
    match: /rate limit|too many requests|429/i,
    explain: () =>
      "Vercel rate-limited this deployment. It will be retried automatically in a moment.",
    retryable: true,
  },
  {
    match: /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|socket hang up|fetch failed/i,
    explain: () =>
      "A network problem interrupted the deployment. Check your connection — it will be retried automatically.",
    retryable: true,
  },
  {
    match: /exceeds the maximum|too large|payload.*limit/i,
    explain: () =>
      "The project is too large to upload. Make sure build output and node_modules are not inside the project folder.",
    retryable: false,
  },
];

export interface FailureExplanation {
  message: string;
  retryable: boolean;
}

export function explainFailure(cliOutput: string): FailureExplanation {
  for (const rule of RULES) {
    const m = cliOutput.match(rule.match);
    if (m) return { message: rule.explain(m), retryable: rule.retryable };
  }
  // Fall back to the CLI's own error line — still more useful than a shrug.
  const errLine = cliOutput
    .split("\n")
    .reverse()
    .find((l) => /error/i.test(l) && l.trim().length > 0);
  return {
    message: errLine
      ? `Deployment failed: ${errLine.replace(/^\s*(Error!?|error)[:\s]*/i, "").trim()}`
      : "Deployment failed before producing any output. Open the logs for details.",
    retryable: false,
  };
}
