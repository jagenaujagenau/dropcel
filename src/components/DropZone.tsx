import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ipc from "../lib/ipc";
import { DropField } from "./DropField";

/**
 * Drop targets: the whole app window (Tauri drag-drop events) and — on
 * macOS — the menu-bar icon itself (`tray:drop`, emitted by the AppKit
 * integration in src-tauri/tray_drop.rs). Both feed the same import: copy
 * into ~/Vercel, let the watcher deploy.
 */
export function DropZone() {
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const importPaths = async (paths: string[]) => {
      const results: string[] = [];
      const errors: string[] = [];
      for (const path of paths) {
        try {
          results.push(await ipc.fs.importDroppedPath(path));
        } catch (e) {
          errors.push(String((e as { message?: string })?.message ?? e));
        }
      }
      const parts: string[] = [];
      if (results.length > 0) {
        parts.push(`Deploying ${results.join(", ")}…`);
      }
      parts.push(...errors);
      if (parts.length > 0) {
        setNote(parts.join("\n"));
        setTimeout(() => setNote(null), 6000);
      }
    };

    const unlistenWindow = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        setDragging(true);
        // Physical → client coords so the star field glows under the file.
        const dpr = window.devicePixelRatio || 1;
        setDragPos({ x: payload.position.x / dpr, y: payload.position.y / dpr });
      } else if (payload.type === "leave") {
        setDragging(false);
        setDragPos(null);
      } else if (payload.type === "drop") {
        setDragging(false);
        setDragPos(null);
        void importPaths(payload.paths);
      }
    });
    const unlistenTray = listen<string[]>("tray:drop", (e) => {
      void importPaths(e.payload);
    });
    // Dock-icon drops / "Open With": paths are stashed natively (they can
    // arrive before we're listening, e.g. app launched by the drop itself)
    // and drained here.
    const drainPending = async () => {
      const paths = await ipc.fs.takePendingDrops().catch(() => [] as string[]);
      if (paths.length > 0) await importPaths(paths);
    };
    const unlistenDock = listen("drops:available", () => void drainPending());
    void drainPending();
    return () => {
      void unlistenWindow.then((unlisten) => unlisten());
      void unlistenTray.then((unlisten) => unlisten());
      void unlistenDock.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <>
      {dragging && (
        <div className="drop-overlay pointer-events-none fixed inset-0 z-[70] bg-background/90 backdrop-blur-md">
          <DropField glow={dragPos} className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-x-0 bottom-[12%] text-center">
            <p className="text-2xl font-semibold tracking-tight">Drop to deploy</p>
            <p className="mt-1.5 text-sm text-muted">Live in seconds. URL in your clipboard.</p>
          </div>
        </div>
      )}
      {note && (
        <div className="fixed bottom-4 right-4 z-[70] max-w-sm whitespace-pre-line rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed shadow-2xl">
          {note}
        </div>
      )}
    </>
  );
}
