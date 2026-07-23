import { describe, expect, it } from "vitest";
import { detectFramework, isDeployable } from "./detection";

const pkg = (deps: Record<string, string>, devDeps: Record<string, string> = {}) => ({
  dependencies: deps,
  devDependencies: devDeps,
});

describe("detectFramework", () => {
  it("detects Next.js from dependency", () => {
    expect(
      detectFramework({ entries: ["package.json"], packageJson: pkg({ next: "15" }) }),
    ).toBe("nextjs");
  });

  it("detects Next.js from config file even without deps", () => {
    expect(
      detectFramework({ entries: ["next.config.ts"], packageJson: pkg({}) }),
    ).toBe("nextjs");
  });

  it("prefers meta-framework over embedded libs", () => {
    expect(
      detectFramework({
        entries: [],
        packageJson: pkg({ next: "15", react: "19", "react-dom": "19" }),
      }),
    ).toBe("nextjs");
    expect(
      detectFramework({ entries: [], packageJson: pkg({ nuxt: "3", vue: "3" }) }),
    ).toBe("nuxt");
    expect(
      detectFramework({
        entries: [],
        packageJson: pkg({ "@sveltejs/kit": "2", svelte: "5" }, { vite: "6" }),
      }),
    ).toBe("svelte");
  });

  it("detects astro, remix, vue, hono, express", () => {
    expect(detectFramework({ entries: [], packageJson: pkg({ astro: "5" }) })).toBe("astro");
    expect(
      detectFramework({ entries: [], packageJson: pkg({ "@remix-run/node": "2" }) }),
    ).toBe("remix");
    expect(detectFramework({ entries: [], packageJson: pkg({ vue: "3" }, { vite: "6" }) })).toBe("vue");
    expect(detectFramework({ entries: [], packageJson: pkg({ hono: "4" }) })).toBe("hono");
    expect(detectFramework({ entries: [], packageJson: pkg({ express: "4" }) })).toBe("express");
  });

  it("detects vite for react+vite, react for CRA-style", () => {
    expect(
      detectFramework({
        entries: ["vite.config.ts"],
        packageJson: pkg({ react: "19" }, { vite: "6" }),
      }),
    ).toBe("vite");
    expect(
      detectFramework({ entries: [], packageJson: pkg({ react: "19", "react-scripts": "5" }) }),
    ).toBe("react");
  });

  it("detects static html without package.json", () => {
    expect(detectFramework({ entries: ["index.html", "style.css"], packageJson: null })).toBe(
      "static",
    );
  });

  it("returns unknown for empty directories", () => {
    expect(detectFramework({ entries: [], packageJson: null })).toBe("unknown");
  });
});

describe("isDeployable", () => {
  it("requires a package.json or an index.html", () => {
    expect(isDeployable({ entries: ["notes.txt"], packageJson: null })).toBe(false);
    expect(isDeployable({ entries: ["index.html"], packageJson: null })).toBe(true);
    expect(isDeployable({ entries: [], packageJson: {} })).toBe(true);
  });
});
