import { Effect } from "effect";
import { log } from "../lib/log";
import type { Deployer, DeployProgress } from "./deployer";
import { HeldChanges } from "./held-changes";
import { advance, isTerminal } from "./state-machine";
import type { DeploymentState, DeployTarget } from "./types";
import { DEFAULT_PIPELINE_OPTIONS, executeDeployment, type PipelineOptions } from "./pipeline";

/**
 * The deployment queue: one active deployment per project, changes debounced,
 * bursts coalesced. If files change while a deployment is running, exactly one
 * follow-up deployment runs afterwards — never a pile-up.
 *
 * Every dependency is injected so the whole thing runs under fake timers and
 * a mock deployer in tests.
 */

export interface QueueProject {
  id: string;
  name: string;
  path: string;
  autoDeploy: boolean;
}

export interface TransitionInfo {
  url?: string | null;
  error?: string | null;
  exitCode?: number | null;
  /** On ready: digest of the content that was deployed. */
  contentDigest?: string | null;
}

export interface QueueDeps {
  deployer: Deployer;
  /** Persist a new deployment row; returns its id. */
  createDeployment: (projectId: string, target: DeployTarget) => Promise<string>;
  /** Persist + broadcast every state change. */
  onTransition: (
    projectId: string,
    deploymentId: string,
    state: DeploymentState,
    info?: TransitionInfo,
  ) => void;
  getProject: (projectId: string) => QueueProject | undefined;
  /**
   * Asked right before an automatic deploy actually starts. Return true to
   * skip it (e.g. project content is identical to the last successful
   * deploy). Manual deploys never consult this.
   */
  shouldSkipAuto?: (projectId: string) => Promise<boolean>;
  /** Shared hold tracker — the queue owns only its 'offline' reason; other
   * holds (account switch, git operations) belong to the orchestrator. */
  held?: HeldChanges;
  debounceMs?: number;
  pipeline?: PipelineOptions;
}

interface ProjectSlot {
  debounceTimer: ReturnType<typeof setTimeout> | null;
  active: { deploymentId: string; abort: AbortController } | null;
  /** A change arrived mid-deployment → run once more when done. */
  pendingTarget: DeployTarget | null;
}

export class DeploymentQueue {
  private slots = new Map<string, ProjectSlot>();
  private paused = false;
  private offline = false;
  /** Tracks projects that changed while offline — drained on reconnect. */
  private held: HeldChanges;

  constructor(private deps: QueueDeps) {
    this.held = deps.held ?? new HeldChanges();
  }

  private slot(projectId: string): ProjectSlot {
    let s = this.slots.get(projectId);
    if (!s) {
      s = { debounceTimer: null, active: null, pendingTarget: null };
      this.slots.set(projectId, s);
    }
    return s;
  }

  setPaused(paused: boolean) {
    this.paused = paused;
  }

  /**
   * Offline: hold auto-deploys instead of producing doomed CLI runs. Edits
   * accumulate as a dirty set; reconnecting deploys each dirty project once
   * — Dropbox semantics ("sync when back online").
   */
  setOffline(offline: boolean): void {
    this.offline = offline;
    if (!offline) {
      // Only projects with no remaining hold reason drain; the rest deploy
      // when their other holds (account switch, git operation) clear.
      for (const projectId of this.held.release("offline")) {
        this.notifyChange(projectId);
      }
    }
  }

  private holdDirty(projectId: string): void {
    this.held.mark(projectId, "offline");
  }

  isOffline(): boolean {
    return this.offline;
  }

  /** Filesystem change: debounce, then deploy to production. */
  notifyChange(projectId: string): void {
    if (this.paused) return;
    const project = this.deps.getProject(projectId);
    if (!project || !project.autoDeploy) return;
    if (this.offline) {
      this.holdDirty(projectId);
      return;
    }
    const slot = this.slot(projectId);
    if (slot.debounceTimer) clearTimeout(slot.debounceTimer);
    slot.debounceTimer = setTimeout(() => {
      slot.debounceTimer = null;
      // Went offline during the debounce window: hold, don't deploy.
      if (this.offline) {
        this.holdDirty(projectId);
        return;
      }
      void this.enqueueAutoUnlessSkipped(projectId);
    }, this.deps.debounceMs ?? 2_000);
  }

  /** Auto path: consult the skip guard (content unchanged → no deploy). */
  private async enqueueAutoUnlessSkipped(projectId: string): Promise<void> {
    try {
      if (this.deps.shouldSkipAuto && (await this.deps.shouldSkipAuto(projectId))) return;
    } catch {
      /* guard failure must never block deploys */
    }
    // Folder = truth: what's in the folder IS production.
    this.enqueue(projectId, "production");
  }

  /** Explicit deploy (UI button or post-debounce). */
  enqueue(projectId: string, target: DeployTarget): void {
    const project = this.deps.getProject(projectId);
    if (!project) {
      log.warn("queue", `cannot deploy unknown project ${projectId}`);
      return;
    }
    const slot = this.slot(projectId);
    if (slot.active) {
      // Coalesce: production wins over preview if both are requested.
      slot.pendingTarget =
        slot.pendingTarget === "production" ? "production" : target;
      return;
    }
    void this.start(projectId, target);
  }

  cancel(projectId: string): void {
    const slot = this.slots.get(projectId);
    if (slot?.debounceTimer) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    if (slot) slot.pendingTarget = null;
    slot?.active?.abort.abort();
  }

  /** Forget a project (folder was deleted). Cancels any in-flight work. */
  remove(projectId: string): void {
    this.cancel(projectId);
    this.slots.delete(projectId);
  }

  isActive(projectId: string): boolean {
    return this.slots.get(projectId)?.active != null;
  }

  private async start(projectId: string, target: DeployTarget): Promise<void> {
    const project = this.deps.getProject(projectId);
    if (!project) return;
    const slot = this.slot(projectId);

    const deploymentId = await this.deps.createDeployment(projectId, target);
    const abort = new AbortController();
    slot.active = { deploymentId, abort };

    let state: DeploymentState = "queued";
    this.deps.onTransition(projectId, deploymentId, state);

    const setState = (next: DeploymentState, info?: TransitionInfo) => {
      if (isTerminal(state)) return;
      state = next;
      this.deps.onTransition(projectId, deploymentId, state, info);
    };

    const onProgress = (p: DeployProgress) => {
      const next = advance(state, p.phase);
      if (next !== state) setState(next, p.url ? { url: p.url } : undefined);
      else if (p.url) this.deps.onTransition(projectId, deploymentId, state, { url: p.url });
    };

    // Entering the pipeline: mark preparing before the CLI produces output.
    setState("preparing");

    try {
      const outcome = await Effect.runPromise(
        executeDeployment(
          this.deps.deployer,
          {
            deploymentId,
            projectName: project.name,
            projectPath: project.path,
            target,
            attempt: 1,
          },
          onProgress,
          () => {
            // On retry the pipeline restarts; reflect it in the UI.
            state = "preparing";
            this.deps.onTransition(projectId, deploymentId, state);
          },
          this.deps.pipeline ?? DEFAULT_PIPELINE_OPTIONS,
        ),
        { signal: abort.signal },
      );

      if (outcome.canceled) {
        setState("canceled", { exitCode: outcome.exitCode });
      } else if (outcome.ok) {
        setState("ready", {
          url: outcome.url,
          exitCode: outcome.exitCode,
          contentDigest: outcome.contentDigest ?? null,
        });
      } else {
        setState("failed", {
          url: outcome.url,
          error: outcome.error,
          exitCode: outcome.exitCode,
        });
      }
    } catch {
      // runPromise rejects on interruption (user cancel / shutdown).
      setState("canceled");
    } finally {
      slot.active = null;
      const pending = slot.pendingTarget;
      slot.pendingTarget = null;
      if (pending === "production") {
        void this.start(projectId, pending);
      } else if (pending) {
        // A change that arrived mid-deploy may already be included in what
        // just shipped — the guard prevents an identical follow-up.
        void this.enqueueAutoUnlessSkipped(projectId);
      }
    }
  }
}
