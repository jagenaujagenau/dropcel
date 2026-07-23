import type { Framework } from "./types";

/**
 * Framework detection is a pure function over cheap signals: the project's
 * top-level file names and its parsed package.json. No filesystem access
 * happens here — the native layer feeds us the data — which keeps detection
 * trivially unit-testable.
 */

export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DetectionInput {
  /** Top-level file and directory names of the project. */
  entries: string[];
  /** Parsed package.json, or null when absent/invalid. */
  packageJson: PackageJsonLike | null;
}

const configOf = (entries: string[], base: string) =>
  entries.some((e) => e === base || e.startsWith(`${base}.`));

/**
 * Ordered rules: meta-frameworks first (they embed react/vue/vite), then
 * backend frameworks, then build tools, then plain static HTML.
 */
export function detectFramework(input: DetectionInput): Framework {
  const { entries, packageJson } = input;
  const deps: Record<string, string> = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  const has = (name: string) => name in deps;
  const hasPrefix = (prefix: string) =>
    Object.keys(deps).some((d) => d.startsWith(prefix));

  if (has("next") || configOf(entries, "next.config")) return "nextjs";
  if (has("nuxt") || configOf(entries, "nuxt.config")) return "nuxt";
  if (has("astro") || configOf(entries, "astro.config")) return "astro";
  if (hasPrefix("@remix-run/") || configOf(entries, "remix.config")) return "remix";
  if (has("@sveltejs/kit") || has("svelte") || configOf(entries, "svelte.config"))
    return "svelte";
  if (has("hono")) return "hono";
  if (has("express")) return "express";
  if (has("vue")) return "vue";
  if (has("vite") || configOf(entries, "vite.config"))
    return has("react") ? "vite" : "vite";
  if (has("react")) return "react";
  if (!packageJson && entries.includes("index.html")) return "static";
  if (entries.includes("index.html")) return "static";
  return "unknown";
}

/** A directory qualifies as deployable once it looks like a web project. */
export function isDeployable(input: DetectionInput): boolean {
  return input.packageJson !== null || input.entries.includes("index.html");
}
