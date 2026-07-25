/**
 * Choosing the *public* URL of a deployment. The unique deployment URL
 * (myapp-abc123-user.vercel.app) is the one guarded by Deployment
 * Protection; the stable aliases (custom domain, myapp.vercel.app) are the
 * public face of the project. The alias list comes from the REST API's
 * deployment object.
 */

const hostOf = (url: string) => url.replace(/^https:\/\//i, "").replace(/\/.*$/, "");

/** True for per-deployment URLs like myapp-8fj2k1xq3-user.vercel.app or git-branch aliases. */
function looksEphemeral(url: string): boolean {
  const host = hostOf(url);
  if (/-git-/i.test(host)) return true;
  // Unique deploy hosts end in -<9 char hash>-<scope>.vercel.app
  return /-[a-z0-9]{9}-[a-z0-9-]+\.vercel\.app$/i.test(host);
}

export interface PublicUrlInputs {
  deploymentUrl: string;
  aliases: string[];
  /** Verified custom domains assigned in the app, in creation order. */
  verifiedDomains: string[];
}

/**
 * Preference order: verified custom domain → stable *.vercel.app alias
 * (shortest wins: the project domain is shorter than branch aliases) →
 * any alias → the deployment URL itself.
 */
/**
 * Whether this deployment actually holds a stable, shareable address — a
 * verified custom domain or a non-ephemeral alias.
 *
 * A production deploy normally receives the project's alias the moment it goes
 * READY. It does *not* after an Instant Rollback: Vercel disables
 * auto-assignment of production domains once you roll back, so subsequent
 * deployments build and succeed while the public URL keeps serving the older
 * version you rolled back to. For a tool whose whole premise is that saving a
 * file updates the site, "Ready" that isn't live is the worst state to report
 * — so the caller uses this to tell the difference.
 */
export function hasStableAddress(inputs: PublicUrlInputs): boolean {
  if (inputs.verifiedDomains.length > 0) return true;
  return inputs.aliases.some((a) => !looksEphemeral(a));
}

export function choosePublicUrl(inputs: PublicUrlInputs): string {
  const { deploymentUrl, aliases, verifiedDomains } = inputs;
  if (verifiedDomains.length > 0) return `https://${verifiedDomains[0]}`;
  const stable = aliases.filter((a) => !looksEphemeral(a));
  if (stable.length > 0) {
    return [...stable].sort((a, b) => hostOf(a).length - hostOf(b).length)[0];
  }
  if (aliases.length > 0) return aliases[0];
  return deploymentUrl;
}
