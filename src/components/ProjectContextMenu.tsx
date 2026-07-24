import { useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Trash2, Triangle } from "lucide-react";
import { deleteRemoteProject, projectDashboardUrlFrom } from "../core/deployment-actions";
import { deployProject, latestByProjectAtom, reconcile, useAtomState } from "../core/atoms";
import { publicUrlOf, type Project } from "../core/types";
import * as ipc from "../lib/ipc";
import { Button } from "./ui/button";
import { ContextMenu, type ContextMenuState } from "./ui/context-menu";
import { Dialog } from "./ui/dialog";
import { Input } from "./ui/input";

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
  const latestByProject = useAtomState(latestByProjectAtom, {});
  const [note, setNote] = useState<string | null>(null);
  const [menuVisible, setMenuVisible] = useState(true);
  const [remoteDeleteOpen, setRemoteDeleteOpen] = useState(false);
  // True while an async action may still need to show a toast; keeps this
  // component mounted after the menu itself has closed.
  const pendingRef = useRef(false);

  const closeMenu = () => {
    setMenuVisible(false);
    if (!pendingRef.current) onClose();
  };

  const latest = latestByProject[menu.project.id];
  const publicUrl = publicUrlOf(latest);

  const openInVercel = async () => {
    pendingRef.current = true;
    const url = projectDashboardUrlFrom(latest?.inspectorUrl ?? null);
    if (url) {
      void openUrl(url);
      pendingRef.current = false;
      onClose();
    } else {
      setNote("Deploy once first — then this opens the Vercel page.");
      setTimeout(() => {
        setNote(null);
        pendingRef.current = false;
        onClose();
      }, 6000);
    }
  };

  return (
    <>
      {menuVisible && (
      <ContextMenu
        position={menu}
        onClose={closeMenu}
        items={[
          {
            label: "Open in Vercel",
            icon: <Triangle className="h-3.5 w-3.5 fill-current" />,
            onSelect: () => void openInVercel(),
          },
          {
            label: "Visit",
            icon: <ExternalLink className="h-4 w-4" />,
            disabled: !publicUrl,
            onSelect: () => void openUrl(publicUrl!),
          },
          {
            label: "Copy URL",
            disabled: !publicUrl,
            onSelect: () => void writeText(publicUrl!),
          },
          {
            label: "View Source",
            separatorBefore: true,
            onSelect: () => void ipc.fs.openRootFolder(menu.project.name),
          },
          {
            label: "Redeploy",
            onSelect: () => deployProject(menu.project.id, "production"),
          },
          {
            label: "Deploy Preview",
            onSelect: () => deployProject(menu.project.id, "preview"),
          },
          {
            label: "Move to Trash…",
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
            label: "Delete on Vercel…",
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
      {note && (
        <div className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed shadow-2xl">
          {note}
        </div>
      )}
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
