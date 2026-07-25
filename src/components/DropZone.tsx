import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";
import { TriangleGlow } from "./TriangleGlow";
import { Toast } from "./ui/toast";

/** How long the refusal stays on screen before it clears itself. Slightly
 * longer than the shader's failure envelope, so the triangle settles back to
 * rest while still visible instead of being cut mid-animation. */
const FAILURE_MS = 2600;

/**
 * Minimum time the rain stays up after the file lands. Without it the rain is
 * a hover-only effect: it disappears on mouse-release, so dragging in from
 * Finder and dropping straight away shows it for a few frames and the drop
 * itself — the thing being acknowledged — has no state of its own.
 */
const DROP_DWELL_MS = 1500;

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
  /**
   * A refused drop gets the triangle, not a corner toast. The refusal is
   * always actionable ("put it in a folder with an index.html") and a 12px
   * note in the corner of a window the user is dragging onto is the easiest
   * thing in the app to miss.
   */
  const [failure, setFailure] = useState<{ at: number; message: string } | null>(null);
  /** Latches on the first drag: the overlay's WebGL canvas is expensive to
   * create, so once built it stays. Nothing renders before the first drag. */
  const [overlayMounted, setOverlayMounted] = useState(false);
  /** The file has landed and the import is in flight — the rain holds. */
  const [landing, setLanding] = useState(false);
  /** One canvas serves every state, so it is on screen for any of them. */
  const raining = dragging || landing;
  const visible = raining || failure != null;

  useEffect(() => {
    let dwellTimer: ReturnType<typeof setTimeout> | undefined;

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
      if (results.length > 0) {
        setNote(`Deploying ${results.join(", ")}…`);
        setTimeout(() => setNote(null), 6000);
      }
      if (errors.length > 0) {
        setOverlayMounted(true);
        setFailure({ at: Date.now(), message: errors.join("\n") });
      }
    };

    /**
     * The drop itself: hold the rain while the import runs, and for a beat
     * afterwards even if it returns instantly, so the acknowledgement is
     * always seen. A refusal takes over from here and runs its own envelope.
     */
    const importDropped = async (paths: string[]) => {
      setOverlayMounted(true);
      setLanding(true);
      const started = Date.now();
      try {
        await importPaths(paths);
      } finally {
        const remaining = DROP_DWELL_MS - (Date.now() - started);
        if (remaining > 0) {
          dwellTimer = setTimeout(() => setLanding(false), remaining);
        } else {
          setLanding(false);
        }
      }
    };

    const unlistenWindow = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "over" || payload.type === "enter") {
        setDragging(true);
        setOverlayMounted(true);
        // Physical → client coords so the star field glows under the file.
        const dpr = window.devicePixelRatio || 1;
        setDragPos({ x: payload.position.x / dpr, y: payload.position.y / dpr });
      } else if (payload.type === "leave") {
        setDragging(false);
        setDragPos(null);
      } else if (payload.type === "drop") {
        setDragging(false);
        setDragPos(null);
        void importDropped(payload.paths);
      }
    });
    // Every drop route gets the same acknowledgement — a menu-bar drop is no
    // less a drop than one onto the window.
    const unlistenTray = listen<string[]>("tray:drop", (e) => {
      void importDropped(e.payload);
    });
    // Dock-icon drops / "Open With": paths are stashed natively (they can
    // arrive before we're listening, e.g. app launched by the drop itself)
    // and drained here.
    const drainPending = async () => {
      const paths = await ipc.fs.takePendingDrops().catch(() => [] as string[]);
      if (paths.length > 0) await importDropped(paths);
    };
    const unlistenDock = listen("drops:available", () => void drainPending());
    void drainPending();
    return () => {
      clearTimeout(dwellTimer);
      void unlistenWindow.then((unlisten) => unlisten());
      void unlistenTray.then((unlisten) => unlisten());
      void unlistenDock.then((unlisten) => unlisten());
    };
  }, []);

  // Clears itself, and re-arms from scratch if a second drop fails while the
  // first refusal is still up. Escape dismisses it — the overlay is dismissed
  // by clicking, which the keyboard can't do.
  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), FAILURE_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFailure(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [failure]);

  return (
    <>
      {/*
        Mounted from the first drag onward and never torn down. Unmounting it
        between drags meant a brand-new WebGL2 context every drag-enter —
        browsers cap live contexts (~16) and hand back null past that, so
        enough drags in one session would silently drop this to the star-field
        fallback for the rest of the session. It also rebuilt the glyph atlas
        each time. Hidden via opacity, and `paused` stops the render loop so an
        invisible canvas costs nothing.
      */}
      {overlayMounted && (
        <div
          aria-hidden={!visible}
          role={failure ? "alert" : undefined}
          className={cn(
            "drop-overlay fixed inset-0 z-[70] bg-background/90 backdrop-blur-md transition-opacity duration-150",
            visible ? "opacity-100" : "pointer-events-none opacity-0",
            // Only the refusal is interactive; a drag must not be intercepted.
            failure ? "cursor-pointer" : "pointer-events-none",
          )}
          // Dismissible: the auto-clear is a floor, not a sentence.
          onClick={() => setFailure(null)}
        >
          <TriangleGlow
            raining={raining}
            errorAt={failure?.at ?? null}
            paused={!visible}
            glow={dragPos}
            className="absolute inset-0 h-full w-full"
          />
          <div className="absolute inset-x-0 bottom-[12%] px-6 text-center">
            {failure ? (
              <>
                <p className="mx-auto max-w-md text-pretty text-sm leading-relaxed text-danger">
                  {failure.message}
                </p>
                <p className="mt-3 text-[11px] text-faint">Click anywhere to dismiss</p>
              </>
            ) : (
              <>
                <p className="text-2xl font-semibold tracking-tight">Drop to deploy</p>
                <p className="mt-1.5 text-sm text-muted">
                  Live in seconds. URL in your clipboard.
                </p>
              </>
            )}
          </div>
        </div>
      )}
      <Toast message={note} style={{ zIndex: 70 }} />
    </>
  );
}
