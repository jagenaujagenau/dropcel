import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, FileText, Lock, Trash2, Triangle, Users } from "lucide-react";
import { deleteRemoteProject, projectDashboardUrlFrom } from "../core/deployment-actions";
import { deployProject, latestDeploymentAtom, reconcile } from "../core/atoms";
import { projectActions, type ProjectActionKind } from "../core/project-actions";
import type { Project } from "../core/types";
import * as ipc from "../lib/ipc";
import { Button } from "./ui/button";
import { ContextMenu, type ContextMenuState } from "./ui/context-menu";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Toast } from "./ui/toast";
import { LockBranchDialog } from "./LockBranchDialog";
import { LogViewerDialog } from "./LogViewerDialog";
import { TeamDialog } from "./TeamDialog";

export type ProjectMenuState = ContextMenuState & { project: Project };

/**
 * The right-click menu for a project, shared by the dashboard cards and the
 * sidebar list. "Open in Vercel" derives the dashboard page from the latest
 * deployment's logged inspector URL, falling back to the signed-in scope.
 */
export function ProjectContextMenu({
  menu,
  onClose,
}: {
  menu: ProjectMenuState;
  onClose: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [menuVisible, setMenuVisible] = useState(true);
  const [remoteDeleteOpen, setRemoteDeleteOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [lockBranchOpen, setLockBranchOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  // True while an async action may still need to show a toast; keeps this
  // component mounted after the menu itself has closed.
  const pendingRef = useRef(false);

  const closeMenu = () => {
    setMenuVisible(false);
    if (!pendingRef.current) onClose();
  };

  const latest = useAtomValue(latestDeploymentAtom(menu.project.id));

  /**
   * Availability comes from `core/project-actions.ts`, shared with ⌘K. The
   * two surfaces then apply different *policies* to the same verdict — the
   * palette drops what it can't run, a menu greys it out and says why, because
   * a menu whose items move around is a menu you have to re-read every time.
   */
  const actions = new Map(
    projectActions({
      project: menu.project,
      latest,
      dashboardUrl: projectDashboardUrlFrom(latest?.inspectorUrl ?? null),
    }).map((a) => [a.kind, a] as const),
  );
  const action = (kind: ProjectActionKind) => {
    const a = actions.get(kind)!;
    return { label: a.label, disabled: a.unavailable !== null, title: a.unavailable ?? undefined };
  };
  const publicUrl = actions.get("visit")?.url ?? null;

  return (
    <>
      {menuVisible && (
      <ContextMenu
        position={menu}
        onClose={closeMenu}
        items={[
          {
            ...action("open-in-vercel"),
            icon: <Triangle className="h-3.5 w-3.5 fill-current" />,
            onSelect: () => void openUrl(actions.get("open-in-vercel")!.url!),
          },
          {
            ...action("visit"),
            icon: <ExternalLink className="h-4 w-4" />,
            onSelect: () => void openUrl(publicUrl!),
          },
          {
            ...action("copy-url"),
            onSelect: () => {
              pendingRef.current = true;
              void writeText(publicUrl!).then(() => {
                setNote("Copied to clipboard.");
                setTimeout(() => {
                  setNote(null);
                  pendingRef.current = false;
                  onClose();
                }, 1500);
              });
            },
          },
          {
            ...action("view-source"),
            separatorBefore: true,
            onSelect: () => void ipc.fs.openRootFolder(menu.project.name),
          },
          {
            ...action("view-build-log"),
            icon: <FileText className="h-4 w-4" />,
            onSelect: () => {
              pendingRef.current = true;
              setLogsOpen(true);
            },
          },
          {
            ...action("redeploy"),
            onSelect: () => deployProject(menu.project.id, "production"),
          },
          {
            ...action("deploy-preview"),
            onSelect: () => deployProject(menu.project.id, "preview"),
          },
          {
            ...action("lock-branch"),
            icon: <Lock className="h-3.5 w-3.5" />,
            onSelect: () => {
              pendingRef.current = true;
              setLockBranchOpen(true);
            },
          },
          {
            ...action("deploy-under"),
            icon: <Users className="h-3.5 w-3.5" />,
            onSelect: () => {
              pendingRef.current = true;
              setTeamOpen(true);
            },
          },
          {
            ...action("move-to-trash"),
            icon: <Trash2 className="h-4 w-4" />,
            separatorBefore: true,
            onSelect: () => {
              pendingRef.current = true;
              void (async () => {
                const yes = await ask(
                  `Move "${menu.project.name}" to the Trash?\n\nStops deploying. Nothing on Vercel is touched.`,
                  { title: "Move to Trash", kind: "warning" },
                );
                if (yes) {
                  try {
                    await ipc.fs.trashProject(menu.project.name);
                    await reconcile(false);
                  } catch (e) {
                    setNote(String((e as { message?: string })?.message ?? e));
                    setTimeout(() => setNote(null), 6000);
                  }
                }
                pendingRef.current = false;
                onClose();
              })();
            },
          },
          {
            ...action("delete-on-vercel"),
            onSelect: () => {
              pendingRef.current = true;
              setRemoteDeleteOpen(true);
            },
          },
        ]}
      />
      )}
      {remoteDeleteOpen && (
        <RemoteDeleteDialog
          project={menu.project}
          onDone={() => {
            setRemoteDeleteOpen(false);
            pendingRef.current = false;
            onClose();
          }}
        />
      )}
      {logsOpen && latest && (
        <LogViewerDialog
          deploymentId={latest.id}
          projectName={menu.project.name}
          onClose={() => {
            setLogsOpen(false);
            pendingRef.current = false;
            onClose();
          }}
        />
      )}
      {lockBranchOpen && (
        <LockBranchDialog
          project={menu.project}
          onDone={() => {
            setLockBranchOpen(false);
            pendingRef.current = false;
            onClose();
          }}
        />
      )}
      {teamOpen && (
        <TeamDialog
          project={menu.project}
          onDone={() => {
            setTeamOpen(false);
            pendingRef.current = false;
            onClose();
          }}
        />
      )}
      <Toast message={note} style={{ zIndex: 60 }} />
    </>
  );
}

/**
 * The only destructive remote action in the app: deleting the Vercel project
 * (its deployments, aliases and domains). Requires typing the project name.
 */
function RemoteDeleteDialog({ project, onDone }: { project: Project; onDone: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = typed === project.name;

  const run = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    const r = await deleteRemoteProject(project);
    setBusy(false);
    if (r.ok) {
      await ipc.db.setProjectLink(project.id, null).catch(() => {});
      onDone();
    } else {
      setError(r.message);
    }
  };

  return (
    <Dialog
      open
      onClose={onDone}
      title="Delete on Vercel"
      description="Permanently deletes the project on Vercel. The local folder stays."
    >
      <div className="space-y-3">
        <p className="text-xs text-muted">
          Type <span className="font-mono text-danger">{project.name}</span> to confirm.
        </p>
        <Input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void run()}
          placeholder={project.name}
        />
        {error && <p className="text-[11px] leading-relaxed text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={!confirmed || busy} onClick={() => void run()}>
            {busy ? "Deleting…" : "Delete Project"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
