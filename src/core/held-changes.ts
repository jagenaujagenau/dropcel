/**
 * The one owner of "changes waiting to deploy". A project can be held for
 * several overlapping reasons — offline, an unresolved account switch, an
 * in-flight git operation — and it drains exactly once: when its LAST
 * reason is released. The offline component is persisted (dirty_projects
 * setting) so held changes survive an app restart.
 */

export type HoldReason = "offline" | "account-switch" | "git-operation";

export interface HeldChangesDeps {
  /** Persist the offline component; called on every change to it. */
  persistOffline?: (projectIds: string[]) => void;
}

export class HeldChanges {
  /** projectId → the reasons currently holding it. */
  private holds = new Map<string, Set<HoldReason>>();

  constructor(private deps: HeldChangesDeps = {}) {}

  mark(projectId: string, reason: HoldReason): void {
    let reasons = this.holds.get(projectId);
    if (!reasons) {
      reasons = new Set();
      this.holds.set(projectId, reasons);
    }
    if (reasons.has(reason)) return;
    reasons.add(reason);
    if (reason === "offline") this.persist();
  }

  /**
   * Release `reason` for every project holding it. Returns the projects now
   * completely free — the ones the caller must drain. Projects still held
   * by another reason stay put (and drain when that reason clears).
   */
  release(reason: HoldReason): string[] {
    const freed: string[] = [];
    let touchedOffline = false;
    for (const [projectId, reasons] of this.holds) {
      if (!reasons.delete(reason)) continue;
      if (reason === "offline") touchedOffline = true;
      if (reasons.size === 0) {
        this.holds.delete(projectId);
        freed.push(projectId);
      }
    }
    if (touchedOffline) this.persist();
    return freed;
  }

  /** Release `reason` for one project; true when it is now free to drain. */
  releaseOne(projectId: string, reason: HoldReason): boolean {
    const reasons = this.holds.get(projectId);
    if (!reasons?.delete(reason)) return false;
    if (reason === "offline") this.persist();
    if (reasons.size === 0) {
      this.holds.delete(projectId);
      return true;
    }
    return false;
  }

  isHeld(projectId: string): boolean {
    return this.holds.has(projectId);
  }

  heldBy(reason: HoldReason): string[] {
    return [...this.holds.entries()]
      .filter(([, reasons]) => reasons.has(reason))
      .map(([projectId]) => projectId);
  }

  private persist(): void {
    this.deps.persistOffline?.(this.heldBy("offline"));
  }
}
