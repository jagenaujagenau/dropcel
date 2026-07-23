import { create } from "zustand";
import type { GitStatus } from "../core/git";
import type { Deployment, Project } from "../core/types";

/**
 * UI-facing state. The orchestrator is the only writer; components subscribe
 * and render. SQLite remains the source of truth — this is a projection.
 */

export type Route = { name: "dashboard" } | { name: "settings" };

interface AppState {
  route: Route;
  projects: Project[];
  /** Names of directories currently present inside the root folder. */
  presentOnDisk: Set<string>;
  latestByProject: Record<string, Deployment | undefined>;
  deploymentsByProject: Record<string, Deployment[]>;
  /** Latest site snapshot (PNG data URL) per project. */
  snapshotByProject: Record<string, string | undefined>;
  /** Git state per project (null when not a repo / unknown). */
  gitByProject: Record<string, GitStatus | null>;
  rootFolder: string;
  watchPaused: boolean;
  online: boolean;
  authedAs: string | null;
  authedAvatarUrl: string | null;
  /** Set when the signed-in Vercel account changed since last session —
   * the user must choose how to handle existing project links. */
  accountSwitch: { from: string; to: string } | null;
  /** null while loading, then whether first-run onboarding is complete. */
  onboarded: boolean | null;

  navigate: (route: Route) => void;
  setProjects: (projects: Project[]) => void;
  setPresentOnDisk: (names: string[]) => void;
  upsertDeployment: (d: Deployment) => void;
  setDeployments: (projectId: string, list: Deployment[]) => void;
  setSnapshot: (projectId: string, dataUrl: string) => void;
  setGitInfo: (projectId: string, git: GitStatus | null) => void;
  setRootFolder: (path: string) => void;
  setWatchPaused: (paused: boolean) => void;
  setOnline: (online: boolean) => void;
  setAuthedAs: (user: string | null, avatarUrl?: string | null) => void;
  setAccountSwitch: (s: { from: string; to: string } | null) => void;
  setOnboarded: (onboarded: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  route: { name: "dashboard" },
  projects: [],
  presentOnDisk: new Set(),
  latestByProject: {},
  deploymentsByProject: {},
  snapshotByProject: {},
  gitByProject: {},
  rootFolder: "",
  watchPaused: false,
  online: true,
  authedAs: null,
  authedAvatarUrl: null,
  accountSwitch: null,
  onboarded: null,

  navigate: (route) => set({ route }),
  setProjects: (projects) => set({ projects }),
  setPresentOnDisk: (names) => set({ presentOnDisk: new Set(names) }),
  upsertDeployment: (d) =>
    set((s) => {
      const list = s.deploymentsByProject[d.projectId] ?? [];
      const idx = list.findIndex((x) => x.id === d.id);
      const next = idx >= 0 ? [...list.slice(0, idx), d, ...list.slice(idx + 1)] : [d, ...list];
      return {
        latestByProject: { ...s.latestByProject, [d.projectId]: d },
        deploymentsByProject: { ...s.deploymentsByProject, [d.projectId]: next },
      };
    }),
  setDeployments: (projectId, list) =>
    set((s) => ({
      deploymentsByProject: { ...s.deploymentsByProject, [projectId]: list },
      latestByProject: { ...s.latestByProject, [projectId]: list[0] },
    })),
  setSnapshot: (projectId, dataUrl) =>
    set((s) => ({
      snapshotByProject: { ...s.snapshotByProject, [projectId]: dataUrl },
    })),
  setGitInfo: (projectId, git) =>
    set((s) => ({ gitByProject: { ...s.gitByProject, [projectId]: git } })),
  setRootFolder: (rootFolder) => set({ rootFolder }),
  setWatchPaused: (watchPaused) => set({ watchPaused }),
  setOnline: (online) => set({ online }),
  setAuthedAs: (authedAs, avatarUrl) =>
    set({ authedAs, authedAvatarUrl: avatarUrl ?? null }),
  setAccountSwitch: (accountSwitch) => set({ accountSwitch }),
  setOnboarded: (onboarded) => set({ onboarded }),
}));
