import type { FsChange, ScannedProject } from "../lib/ipc";
import { log } from "../lib/log";
import { detectFramework, isDeployable } from "./detection";
import { isLegitRename, parseLinkFile } from "./rename";
import type { Project } from "./types";

/**
 * The reconciler keeps the database in sync with what's actually inside the
 * root folder: new directories become projects (and deploy), a disappeared
 * dir + an unknown dir carrying the same Vercel link is a rename, deleted
 * dirs simply stop being watched. Every dependency is injected so the whole
 * decision logic runs against fakes in reconciler.test.ts.
 */

export interface ReconcilerDeps {
  // -- filesystem / db (ipc) --
  adoptLooseFiles: () => Promise<string[]>;
  scanProjects: () => Promise<ScannedProject[]>;
  listProjects: () => Promise<Project[]>;
  readProjectFile: (project: string, file: string) => Promise<string | null>;
  listProjectEntries: (project: string) => Promise<string[]>;
  upsertProject: (name: string, path: string, framework: string) => Promise<Project>;
  renameProject: (id: string, newName: string, newPath: string) => Promise<void>;
  setProjectLink: (id: string, vercelProjectId: string | null) => Promise<void>;
  setProjectFramework: (id: string, framework: string) => Promise<void>;
  // -- store sinks --
  setProjects: (projects: Project[]) => void;
  setPresentOnDisk: (names: string[]) => void;
  getProjects: () => Project[];
  isWatchPaused: () => boolean;
  // -- orchestration callbacks --
  /** A project has (or may have) new content — deploy via the gated auto path. */
  onProjectNeedsDeploy: (projectId: string) => void;
  /** Project confirmed present on disk (refresh git info, integration checks). */
  onProjectPresent: (projectId: string) => void;
  /** Project's folder vanished — stop watching, cancel in-flight work. */
  onProjectGone: (projectId: string) => void;
  /** Post-reconcile side effects (tray refresh). */
  onReconciled: () => Promise<void>;
}

export class Reconciler {
  constructor(private deps: ReconcilerDeps) {}

  private async detectProjectFramework(name: string) {
    const entries = await this.deps.listProjectEntries(name);
    let packageJson = null;
    const raw = await this.deps.readProjectFile(name, "package.json");
    if (raw) {
      try {
        packageJson = JSON.parse(raw);
      } catch {
        packageJson = null;
      }
    }
    return { entries, packageJson };
  }

  /**
   * Reconcile the database with what's actually inside the folder:
   *  - new directories become projects (and deploy),
   *  - a disappeared dir + an unknown dir of equal count is treated as a
   *    rename, preserving the Vercel link,
   *  - deleted dirs simply stop being watched; local history stays.
   */
  async reconcile(deployNew = false): Promise<void> {
    // Loose .html files copied straight into the root become projects first,
    // so this same pass registers and deploys them.
    const adopted = await this.deps.adoptLooseFiles().catch(() => [] as string[]);
    if (adopted.length > 0) {
      log.info("import", `adopted loose files as projects: ${adopted.join(", ")}`);
    }
    const [scanned, projects] = await Promise.all([
      this.deps.scanProjects(),
      this.deps.listProjects(),
    ]);
    const known = new Map(projects.map((p) => [p.name, p]));
    const scannedNames = new Set(scanned.map((s) => s.name));

    const missing = projects.filter((p) => !scannedNames.has(p.name));
    const unknown = scanned.filter((s) => !known.has(s.name));

    // Rename heuristic: exactly one dir vanished and one appeared — but only
    // when the Vercel link file travelled with the folder (or neither side
    // has one). Otherwise it's a delete + an unrelated new project.
    let handledAsRename = false;
    if (missing.length === 1 && unknown.length === 1) {
      const [gone] = missing;
      const [appeared] = unknown;
      const appearedLinkId = parseLinkFile(
        await this.deps
          .readProjectFile(appeared.name, ".vercel/project.json")
          .catch(() => null),
      );
      if (isLegitRename(gone.vercelProjectId, appearedLinkId)) {
        await this.deps.renameProject(gone.id, appeared.name, appeared.path);
        handledAsRename = true;
      }
    }
    const toDeploy: string[] = [];
    if (!handledAsRename) {
      for (const s of unknown) {
        const input = await this.detectProjectFramework(s.name);
        if (!isDeployable(input)) continue;
        const project = await this.deps.upsertProject(
          s.name,
          s.path,
          detectFramework(input),
        );
        if (deployNew) toDeploy.push(project.id);
      }
    }

    // Capture the CLI link (projectId) for present projects that lack one —
    // it's the identity signal the rename guard relies on.
    const linked = await this.deps.listProjects();
    for (const p of linked) {
      if (p.vercelProjectId || !scannedNames.has(p.name)) continue;
      const linkId = parseLinkFile(
        await this.deps
          .readProjectFile(p.name, ".vercel/project.json")
          .catch(() => null),
      );
      if (linkId) await this.deps.setProjectLink(p.id, linkId).catch(() => {});
    }

    const fresh = await this.deps.listProjects();
    this.deps.setProjects(fresh);
    this.deps.setPresentOnDisk(scanned.map((s) => s.name));
    for (const p of fresh) {
      if (scannedNames.has(p.name)) this.deps.onProjectPresent(p.id);
    }
    // Projects no longer on disk: stop watching + cancel in-flight work.
    for (const p of fresh) {
      if (!scannedNames.has(p.name)) this.deps.onProjectGone(p.id);
    }
    await this.deps.onReconciled();

    // Deploy AFTER the store knows the new projects — the queue resolves
    // projects through the store, so enqueueing earlier is a silent no-op
    // (the first-drop-never-deployed bug). Route through the gated auto
    // path: git holds, offline holds and the content-digest guard apply.
    for (const id of toDeploy) this.deps.onProjectNeedsDeploy(id);
  }

  async handleFsChanges(changes: FsChange[]): Promise<void> {
    if (this.deps.isWatchPaused()) return;
    let structural = false;
    for (const change of changes) {
      if (change.kind === "project-added" || change.kind === "project-removed") {
        structural = true;
        continue;
      }
      const project = this.deps.getProjects().find((p) => p.name === change.project);
      if (project) {
        // Re-detect lazily: a modified package.json can change the framework.
        void this.refreshFramework(project);
        this.deps.onProjectNeedsDeploy(project.id);
      } else {
        // Files landed in a dir we don't know yet (e.g. a copy in progress).
        structural = true;
      }
    }
    if (structural) {
      await this.reconcile(true);
    }
  }

  private async refreshFramework(project: Project): Promise<void> {
    try {
      const input = await this.detectProjectFramework(project.name);
      const framework = detectFramework(input);
      if (framework !== project.framework && framework !== "unknown") {
        await this.deps.setProjectFramework(project.id, framework);
        this.deps.setProjects(await this.deps.listProjects());
      }
    } catch {
      /* detection is best-effort */
    }
  }
}
