import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ScannedProject } from "../lib/ipc";
import { layerFrom, type RawIpc } from "./ipc";
import { make, Reconciler, type ReconcilerDeps } from "./reconciler";
import type { Project } from "./types";

/**
 * Tests for the reconciler's decision logic against a fake filesystem and
 * database — real detection and rename-guard logic, zero Tauri.
 */

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/root/${overrides.name}`,
    framework: "static",
    vercelProjectId: null,
    autoDeploy: true,
    createdAt: "",
    updatedAt: "",
    lockedBranch: null,
    remoteRepo: null,
    teamId: null,
    ...overrides,
  };
}

const scanned = (name: string): ScannedProject => ({ name, path: `/root/${name}` });

interface Harness {
  reconciler: Reconciler;
  state: {
    scanned: ScannedProject[];
    db: Project[];
    /** project → file → content; keys double as the entry listing. */
    files: Record<string, Record<string, string>>;
  };
  storeProjects: Project[];
  presentOnDisk: string[][];
  needsDeploy: string[];
  present: string[];
  gone: string[];
  renames: { id: string; newName: string }[];
  adoptions: number;
}

function makeHarness(overrides: Partial<ReconcilerDeps> = {}): Harness {
  const state: Harness["state"] = { scanned: [], db: [], files: {} };
  const h: Harness = {
    reconciler: undefined as unknown as Reconciler,
    state,
    storeProjects: [],
    presentOnDisk: [],
    needsDeploy: [],
    present: [],
    gone: [],
    renames: [],
    adoptions: 0,
  };
  let seq = 0;
  h.reconciler = new Reconciler({
    adoptLooseFiles: async () => {
      h.adoptions += 1;
      return [];
    },
    scanProjects: async () => state.scanned,
    listProjects: async () => state.db.map((p) => ({ ...p })),
    readProjectFile: async (project, file) => state.files[project]?.[file] ?? null,
    listProjectEntries: async (project) => Object.keys(state.files[project] ?? {}),
    upsertProject: async (name, path, framework) => {
      const existing = state.db.find((p) => p.name === name);
      if (existing) {
        existing.framework = framework as Project["framework"];
        return { ...existing };
      }
      const project = makeProject({
        id: `id-${++seq}`,
        name,
        path,
        framework: framework as Project["framework"],
      });
      state.db.push(project);
      return { ...project };
    },
    renameProject: async (id, newName, newPath) => {
      h.renames.push({ id, newName });
      const p = state.db.find((x) => x.id === id);
      if (p) {
        p.name = newName;
        p.path = newPath;
      }
    },
    setProjectLink: async (id, vercelProjectId) => {
      const p = state.db.find((x) => x.id === id);
      if (p) p.vercelProjectId = vercelProjectId;
    },
    setProjectFramework: async (id, framework) => {
      const p = state.db.find((x) => x.id === id);
      if (p) p.framework = framework as Project["framework"];
    },
    setProjects: (projects) => {
      h.storeProjects = projects;
    },
    setPresentOnDisk: (names) => h.presentOnDisk.push(names),
    getProjects: () => h.storeProjects,
    isWatchPaused: () => false,
    onProjectNeedsDeploy: (id) => h.needsDeploy.push(id),
    onProjectPresent: (id) => h.present.push(id),
    onProjectGone: (id) => h.gone.push(id),
    onReconciled: async () => {},
    ...overrides,
  });
  return h;
}

describe("Reconciler", () => {
  it("a new deployable folder becomes a project and deploys", async () => {
    const h = makeHarness();
    h.state.scanned = [scanned("blog")];
    h.state.files.blog = { "package.json": "{}" };
    await h.reconciler.reconcile(true);

    expect(h.state.db.map((p) => p.name)).toEqual(["blog"]);
    expect(h.storeProjects.map((p) => p.name)).toEqual(["blog"]);
    expect(h.needsDeploy).toEqual([h.state.db[0].id]);
    expect(h.present).toEqual([h.state.db[0].id]);
  });

  it("does not deploy new projects unless asked (deployNew=false)", async () => {
    const h = makeHarness();
    h.state.scanned = [scanned("blog")];
    h.state.files.blog = { "index.html": "<html>" };
    await h.reconciler.reconcile(false);
    expect(h.state.db.map((p) => p.name)).toEqual(["blog"]);
    expect(h.needsDeploy).toEqual([]);
  });

  it("one missing + one appeared with the travelling link = rename, no deploy", async () => {
    const h = makeHarness();
    h.state.db = [makeProject({ id: "p1", name: "blog", vercelProjectId: "prj_1" })];
    h.state.scanned = [scanned("journal")];
    h.state.files.journal = {
      "index.html": "<html>",
      ".vercel/project.json": JSON.stringify({ projectId: "prj_1" }),
    };
    await h.reconciler.reconcile(true);

    expect(h.renames).toEqual([{ id: "p1", newName: "journal" }]);
    // The Vercel link is preserved and no "new" project deploys.
    expect(h.state.db).toHaveLength(1);
    expect(h.state.db[0].vercelProjectId).toBe("prj_1");
    expect(h.needsDeploy).toEqual([]);
    expect(h.gone).toEqual([]);
  });

  it("one missing + one appeared WITHOUT the link = delete + unrelated add", async () => {
    const h = makeHarness();
    // The blog/shop hazard: deleting `blog` and dropping in `shop` within
    // one reconcile window must NOT hand shop the old project's identity.
    h.state.db = [makeProject({ id: "p1", name: "blog", vercelProjectId: "prj_1" })];
    h.state.scanned = [scanned("shop")];
    h.state.files.shop = { "package.json": "{}" };
    await h.reconciler.reconcile(true);

    expect(h.renames).toEqual([]);
    const shop = h.state.db.find((p) => p.name === "shop")!;
    expect(shop.vercelProjectId).toBeNull();
    expect(h.needsDeploy).toEqual([shop.id]);
    expect(h.gone).toEqual(["p1"]);
  });

  it("a vanished folder takes the project-removed path", async () => {
    const h = makeHarness();
    h.state.db = [makeProject({ id: "p1", name: "blog" })];
    h.state.scanned = [];
    await h.reconciler.reconcile(true);

    expect(h.gone).toEqual(["p1"]);
    expect(h.present).toEqual([]);
    expect(h.presentOnDisk.at(-1)).toEqual([]);
    // Local history stays: the row is not deleted.
    expect(h.state.db).toHaveLength(1);
  });

  it("adopts loose root files before scanning", async () => {
    const h = makeHarness({
      adoptLooseFiles: async () => {
        // Adoption turns page.html into a page/ project dir mid-pass.
        h.state.scanned = [scanned("page")];
        h.state.files.page = { "index.html": "<html>" };
        return ["page"];
      },
    });
    await h.reconciler.reconcile(true);
    expect(h.state.db.map((p) => p.name)).toEqual(["page"]);
    expect(h.needsDeploy).toHaveLength(1);
  });

  it("captures a late CLI link for present unlinked projects", async () => {
    const h = makeHarness();
    h.state.db = [makeProject({ id: "p1", name: "blog" })];
    h.state.scanned = [scanned("blog")];
    h.state.files.blog = {
      "index.html": "<html>",
      ".vercel/project.json": JSON.stringify({ projectId: "prj_9" }),
    };
    await h.reconciler.reconcile(false);
    expect(h.state.db[0].vercelProjectId).toBe("prj_9");
  });

  it("copy-in-progress: not deployable on the first pass, adopted when package.json lands", async () => {
    const h = makeHarness();
    h.state.scanned = [scanned("app")];
    h.state.files.app = { "src.ts": "x" }; // no package.json / index.html yet
    await h.reconciler.reconcile(true);
    expect(h.state.db).toEqual([]);
    expect(h.needsDeploy).toEqual([]);

    // The copy finishes: package.json lands, the watcher reports an unknown
    // dir — handleFsChanges treats that as structural and re-reconciles.
    h.state.files.app["package.json"] = "{}";
    await h.reconciler.handleFsChanges([{ project: "app", kind: "modified" }]);
    expect(h.state.db.map((p) => p.name)).toEqual(["app"]);
    expect(h.needsDeploy).toEqual([h.state.db[0].id]);
  });

  it("routes changes to known projects through the deploy callback, no reconcile", async () => {
    const h = makeHarness();
    const p = makeProject({ id: "p1", name: "blog" });
    h.state.db = [p];
    h.storeProjects = [p];
    h.state.files.blog = { "index.html": "<html>" };
    await h.reconciler.handleFsChanges([{ project: "blog", kind: "modified" }]);
    expect(h.needsDeploy).toEqual(["p1"]);
    expect(h.adoptions).toBe(0); // no structural pass ran
  });

  it("ignores everything while the watcher is paused", async () => {
    const h = makeHarness({ isWatchPaused: () => true });
    await h.reconciler.handleFsChanges([{ project: "blog", kind: "project-added" }]);
    expect(h.adoptions).toBe(0);
    expect(h.needsDeploy).toEqual([]);
  });
});

// ---- Effect facade ---------------------------------------------------------

describe("ReconcilerService", () => {
  it("is constructible from the Ipc service and runs a reconcile", async () => {
    const db: Project[] = [];
    let seq = 0;
    const needsDeploy: string[] = [];
    const raw = {
      db: {
        listProjects: async () => db.map((p) => ({ ...p })),
        upsertProject: async (name: string, path: string, framework: string) => {
          const project = makeProject({
            id: `id-${++seq}`,
            name,
            path,
            framework: framework as Project["framework"],
          });
          db.push(project);
          return { ...project };
        },
        renameProject: async () => {},
        setProjectLink: async () => {},
        setProjectFramework: async () => {},
      },
      fs: {
        adoptLooseFiles: async () => [],
        scanProjects: async () => [scanned("blog")],
        readProjectFile: async () => null,
        listProjectEntries: async () => ["index.html"],
      },
      files: {},
      git: {},
      network: {},
      snapshots: {},
      credentials: {},
      tray: {},
    };

    let storeProjects: Project[] = [];
    const program = Effect.gen(function* () {
      const service = yield* make({
        setProjects: (projects) => (storeProjects = projects),
        setPresentOnDisk: () => {},
        getProjects: () => storeProjects,
        isWatchPaused: () => false,
        onProjectNeedsDeploy: (id) => needsDeploy.push(id),
        onProjectPresent: () => {},
        onProjectGone: () => {},
        onReconciled: async () => {},
      });
      yield* service.reconcile(true);
    });

    await Effect.runPromise(
      program.pipe(Effect.provide(layerFrom(raw as unknown as RawIpc))),
    );
    expect(storeProjects.map((p) => p.name)).toEqual(["blog"]);
    expect(needsDeploy).toEqual(["id-1"]);
  });
});
