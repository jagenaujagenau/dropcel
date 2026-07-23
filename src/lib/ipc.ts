import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Deployment, LogLine, Project, ProjectDomain } from "../core/types";

/**
 * The only file that talks to Tauri. Everything above it depends on these
 * typed functions, so tests can swap the whole native layer for fakes.
 */

export interface ScannedProject {
  name: string;
  path: string;
}

export interface FsChange {
  project: string;
  kind: "modified" | "project-added" | "project-removed";
}

// ---- database -------------------------------------------------------------

export const db = {
  listProjects: () => invoke<Project[]>("db_list_projects"),
  upsertProject: (name: string, path: string, framework: string) =>
    invoke<Project>("db_upsert_project", { name, path, framework }),
  renameProject: (id: string, newName: string, newPath: string) =>
    invoke<void>("db_rename_project", { id, newName, newPath }),
  setProjectLink: (id: string, vercelProjectId: string | null) =>
    invoke<void>("db_set_project_link", { id, vercelProjectId }),
  setAutoDeploy: (id: string, enabled: boolean) =>
    invoke<void>("db_set_auto_deploy", { id, enabled }),
  setProjectFramework: (id: string, framework: string) =>
    invoke<void>("db_set_project_framework", { id, framework }),
  deleteProject: (id: string) => invoke<void>("db_delete_project", { id }),
  insertDeployment: (
    projectId: string,
    target: string,
    branch?: string | null,
    commitSha?: string | null,
  ) =>
    invoke<Deployment>("db_insert_deployment", {
      projectId,
      target,
      branch: branch ?? null,
      commitSha: commitSha ?? null,
    }),
  setLockedBranch: (id: string, branch: string | null) =>
    invoke<void>("db_set_locked_branch", { id, branch }),
  setRemoteRepo: (id: string, repo: string) =>
    invoke<void>("db_set_remote_repo", { id, repo }),
  updateDeployment: (
    id: string,
    state: string,
    url?: string | null,
    error?: string | null,
    exitCode?: number | null,
  ) => invoke<Deployment>("db_update_deployment", { id, state, url, error, exitCode }),
  listDeployments: (projectId: string, limit?: number) =>
    invoke<Deployment[]>("db_list_deployments", { projectId, limit }),
  latestDeployments: () => invoke<Deployment[]>("db_latest_deployments"),
  getLogs: (deploymentId: string) => invoke<LogLine[]>("db_get_logs", { deploymentId }),
  setDeploymentPublicUrl: (id: string, publicUrl: string) =>
    invoke<void>("db_set_deployment_public_url", { id, publicUrl }),
  setDeploymentVercelIds: (
    id: string,
    vercelDeploymentId: string,
    inspectorUrl: string | null,
  ) =>
    invoke<void>("db_set_deployment_vercel_ids", { id, vercelDeploymentId, inspectorUrl }),
  setProjectTeam: (id: string, teamId: string | null) =>
    invoke<void>("db_set_project_team", { id, teamId }),
  appendLog: (deploymentId: string, stream: string, line: string) =>
    invoke<void>("db_append_log", { deploymentId, stream, line }),
  addDomain: (projectId: string, domain: string, verified: boolean) =>
    invoke<void>("db_add_domain", { projectId, domain, verified }),
  setDomainVerified: (domain: string, verified: boolean) =>
    invoke<void>("db_set_domain_verified", { domain, verified }),
  removeDomain: (domain: string) => invoke<void>("db_remove_domain", { domain }),
  listDomains: (projectId: string) =>
    invoke<ProjectDomain[]>("db_list_domains", { projectId }),
  getSetting: (key: string) => invoke<string | null>("db_get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("db_set_setting", { key, value }),
};

// ---- filesystem -----------------------------------------------------------

export const fs = {
  getRootFolder: () => invoke<string>("get_root_folder"),
  setRootFolder: (path: string) => invoke<void>("set_root_folder", { path }),
  scanProjects: () => invoke<ScannedProject[]>("scan_projects"),
  readProjectFile: (project: string, file: string) =>
    invoke<string | null>("read_project_file", { project, file }),
  listProjectEntries: (project: string) =>
    invoke<string[]>("list_project_entries", { project }),
  openRootFolder: (project?: string) =>
    invoke<void>("open_root_folder", { project: project ?? null }),
  trashProject: (project: string) => invoke<void>("trash_project", { project }),
  importDroppedPath: (path: string) =>
    invoke<string>("import_dropped_path", { path }),
  takePendingDrops: () => invoke<string[]>("take_pending_drops"),
  createExampleProject: () => invoke<string>("create_example_project"),
  adoptLooseFiles: () => invoke<string[]>("adopt_loose_files"),
  setWatchPaused: (paused: boolean) => invoke<void>("set_watch_paused", { paused }),
  getWatchPaused: () => invoke<boolean>("get_watch_paused"),
};

export const network = {
  checkOnline: () => invoke<boolean>("check_online"),
};

export interface GitInfoPayload {
  isRepo: boolean;
  branch: string | null;
  sha: string | null;
  operation: string | null;
}

export const git = {
  info: (project: string) => invoke<GitInfoPayload>("git_info", { project }),
};

// ---- deploy files ----------------------------------------------------------

export interface DeployFileEntry {
  path: string;
  sha: string;
  size: number;
}

export interface DeployManifest {
  files: DeployFileEntry[];
  digest: string;
}

export const files = {
  collectDeployFiles: (project: string) =>
    invoke<DeployManifest>("collect_deploy_files", { project }),
  contentDigest: (project: string) =>
    invoke<string>("project_content_digest", { project }),
  readFileB64: (project: string, path: string) =>
    invoke<string>("read_file_b64", { project, path }),
  writeProjectLink: (
    project: string,
    projectId: string,
    orgId: string,
    projectName: string,
  ) => invoke<void>("write_project_link", { project, projectId, orgId, projectName }),
  removeProjectLink: (project: string) =>
    invoke<void>("remove_project_link", { project }),
};

// ---- snapshots ------------------------------------------------------------

export interface Snapshot {
  dataUrl: string;
  capturedAtMs: number;
}

export const snapshots = {
  support: () => invoke<{ supported: boolean; browser: string | null }>("snapshot_support"),
  capture: (projectId: string, url: string) =>
    invoke<Snapshot>("capture_snapshot", { projectId, url }),
  get: (projectId: string) => invoke<Snapshot | null>("get_snapshot", { projectId }),
  delete: (projectId: string) => invoke<void>("delete_snapshot", { projectId }),
};

// ---- credentials ----------------------------------------------------------

export const credentials = {
  getToken: () => invoke<string | null>("get_vercel_token"),
  setToken: (token: string) => invoke<void>("set_vercel_token", { token }),
  deleteToken: () => invoke<void>("delete_vercel_token"),
  getRefreshToken: () => invoke<string | null>("get_vercel_refresh_token"),
  setRefreshToken: (token: string) => invoke<void>("set_vercel_refresh_token", { token }),
  deleteRefreshToken: () => invoke<void>("delete_vercel_refresh_token"),
  /** A logged-in Vercel CLI session on this machine, if any. */
  detectCliToken: () =>
    invoke<{
      token: string;
      refreshToken: string | null;
      expiresAtMs: number | null;
      path: string;
    } | null>("detect_cli_token"),
};

// ---- tray -----------------------------------------------------------------

export interface TrayProject {
  name: string;
  status: "ready" | "deploying" | "failed" | "idle";
  framework: string;
}

export const tray = {
  update: (projects: TrayProject[]) => invoke<void>("update_tray", { projects }),
};

// ---- events ---------------------------------------------------------------

export const events = {
  onFsChanged: (cb: (changes: FsChange[]) => void): Promise<UnlistenFn> =>
    listen<FsChange[]>("fs:changed", (e) => cb(e.payload)),
  onWatcherPaused: (cb: (paused: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>("watcher:paused", (e) => cb(e.payload)),
  onWatcherError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
    listen<string>("watcher:error", (e) => cb(e.payload)),
  onTrayOpenProject: (cb: (name: string) => void): Promise<UnlistenFn> =>
    listen<string>("tray:open-project", (e) => cb(e.payload)),
};
