import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { gitStatusAtom, setProjectsLocal } from "../core/atoms";
import type { Project } from "../core/types";
import * as ipc from "../lib/ipc";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

/**
 * Pin auto-deploy to one branch (see core/git.ts's `shouldHoldAutoDeploy`) —
 * useful mid-refactor, when WIP commits on a feature branch shouldn't
 * auto-ship. Off-branch changes are held, not dropped; they deploy the
 * moment the repo is back on the locked branch (or the lock is cleared).
 * Manual "Redeploy" always bypasses the lock.
 */
export function LockBranchDialog({
  project,
  onDone,
}: {
  project: Project;
  onDone: () => void;
}) {
  const git = useAtomValue(gitStatusAtom(project.id));
  const [branch, setBranch] = useState(project.lockedBranch ?? git?.branch ?? "");
  const [busy, setBusy] = useState(false);

  const save = async (value: string | null) => {
    setBusy(true);
    try {
      await ipc.db.setLockedBranch(project.id, value);
      setProjectsLocal(await ipc.db.listProjects());
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onDone}
      title="Lock Auto-Deploy to Branch"
      description={`Auto-deploys of "${project.name}" only run while the repo is on this branch. Manual Redeploy always works.`}
    >
      <div className="space-y-3">
        <Input
          autoFocus
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && branch && void save(branch)}
          placeholder={git?.branch ?? "branch name"}
        />
        <div className="flex justify-end gap-2">
          {project.lockedBranch && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void save(null)}
            >
              Clear Lock
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button size="sm" disabled={!branch || busy} onClick={() => void save(branch)}>
            {project.lockedBranch ? "Update Lock" : "Lock"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
