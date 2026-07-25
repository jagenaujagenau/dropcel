import { useCallback, useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowUpCircle,
  FolderOpen,
  Loader2,
  Pause,
  Search,
  Settings as SettingsIcon,
  Triangle,
  WifiOff,
} from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { DropZone } from "./components/DropZone";
import { LogViewerDialog } from "./components/LogViewerDialog";
import { UserAvatar } from "./components/UserAvatar";
import { Button } from "./components/ui/button";
import type { Deployment } from "./core/types";
import {
  accountStateAtom,
  installUpdateAndRelaunch,
  onboardedAtom,
  onlineAtom,
  resolveAccountSwitch,
  rootFolderAtom,
  routeAtom,
  setOnboardedLocal,
  setRoute,
  updateStatusAtom,
  useAtomState,
  watchPausedAtom,
} from "./core/atoms";
import { start as startApp } from "./core/composition";
import type { UpdateStatus } from "./core/updater";
import * as ipc from "./lib/ipc";
import { tildeAbbreviate } from "./lib/utils";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { Settings } from "./pages/Settings";

const IDLE_UPDATE_STATUS: UpdateStatus = { _tag: "idle" };

/** Header pill — shown once a check finds a newer release. Confirms before
 * installing since installAndRelaunch interrupts the current session. On
 * success the app relaunches and this never renders again; on failure the
 * status moves to "error" (pill disappears) — Settings' "Check for Updates"
 * is where a retry lives. */
function UpdatePill({ status }: { status: UpdateStatus }) {
  if (status._tag !== "available" && status._tag !== "installing") return null;
  const installing = status._tag === "installing";

  const install = async () => {
    if (status._tag !== "available") return;
    const yes = await ask(`Downloads and installs Dropcel ${status.version}, then restarts the app.`, {
      title: "Install Update",
      kind: "info",
    });
    if (yes) await installUpdateAndRelaunch();
  };

  return (
    <button
      className="flex items-center gap-1 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] text-success hover:bg-success/15 disabled:opacity-70"
      disabled={installing}
      onClick={() => void install()}
      title={status._tag === "available" ? (status.notes ?? undefined) : undefined}
    >
      {installing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
      {installing ? "Installing…" : `Update to ${status.version}`}
    </button>
  );
}

export default function App() {
  const route = useAtomState(routeAtom, { name: "dashboard" } as const);
  const watchPaused = useAtomState(watchPausedAtom, false);
  const online = useAtomState(onlineAtom, true);
  const updateStatus = useAtomState(updateStatusAtom, IDLE_UPDATE_STATUS);
  const accountState = useAtomState(accountStateAtom, {
    username: null,
    avatarUrl: null,
    pendingSwitch: null,
    lastAuthError: null,
  });
  const authedAs = accountState.username;
  const accountSwitch = accountState.pendingSwitch;
  const onboarded = useAtomState(onboardedAtom, null);
  const rootFolder = useAtomState(rootFolderAtom, "");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteLogs, setPaletteLogs] = useState<{ deployment: Deployment; name: string } | null>(
    null,
  );

  useEffect(() => {
    startApp();
  }, []);

  /**
   * The app's global shortcuts. Registered on `window` rather than a focused
   * element so they work wherever the user is — including with focus inside
   * the search field, which is the whole point of ⌘K. Both are modifier
   * combos, so they can't collide with typing.
   *
   * Held back until onboarding is done: neither target exists yet, and the
   * palette over the welcome flow would be a dead end.
   */
  useEffect(() => {
    if (!onboarded) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === ",") {
        e.preventDefault();
        setRoute({ name: "settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onboarded]);

  const onPaletteViewLogs = useCallback((deployment: Deployment, name: string) => {
    setPaletteLogs({ deployment, name });
  }, []);

  if (onboarded === null) {
    // Draggable while loading too — otherwise the window is pinned in place
    // for however long startup takes.
    return <div data-tauri-drag-region className="h-full" />;
  }
  if (!onboarded) {
    return (
      <div className="h-full">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-8" />
        <Onboarding
          onDone={() => {
            void ipc.db.setSetting("onboarded", "1");
            setOnboardedLocal(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      {/*
        `data-tauri-drag-region` is what makes the window movable — the titlebar
        is hidden (see tauri.conf.json), so this strip is the only thing left to
        grab. It has to be repeated on the logo and wordmark because Tauri
        matches the event target itself: a mousedown that lands on a child
        without the attribute is not a drag.
      */}
      <header
        data-tauri-drag-region
        className="flex items-center gap-3 border-b border-border px-4 pb-3 pt-9"
      >
        <Triangle data-tauri-drag-region className="h-3.5 w-3.5 fill-foreground" />
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-tight">
          Dropcel
        </span>
        {watchPaused && (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <Pause className="h-3 w-3" /> paused
          </span>
        )}
        {!online && (
          <span
            className="flex items-center gap-1 rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning"
            title="Held changes deploy when you're back online."
          >
            <WifiOff className="h-3 w-3" /> Offline — changes held
          </span>
        )}
        <UpdatePill status={updateStatus} />
        {/*
          Actions only. The account moved to the status bar and the folder
          button with it: the top-right was carrying four different control
          shapes in a row — a bordered kbd chip, a bare avatar and name, a
          labelled ghost button and an icon button — which is what made it read
          as a pile rather than a toolbar. What is left is the two things you
          press to go somewhere, at one size.
        */}
        <div className="ml-auto flex items-center gap-1">
          {/* The palette is keyboard-first, but a shortcut nobody knows about
              may as well not exist — this is its discovery surface. */}
          <button
            onClick={() => setPaletteOpen(true)}
            title="Search projects and actions"
            className="mr-1 flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-faint transition-colors hover:border-border-hover hover:text-muted"
          >
            <Search className="h-3 w-3" />
            <kbd className="font-sans">⌘K</kbd>
          </button>
          {route.name === "settings" ? (
            <Button variant="ghost" size="icon" onClick={() => setRoute({ name: "dashboard" })} title="Back">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => setRoute({ name: "settings" })} title="Settings">
              <SettingsIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="min-h-0 flex-1 overflow-auto">
        {accountSwitch && (
          <div className="banner-in mx-6 mt-4 rounded-xl border border-warning/30 bg-warning/10 p-4">
            <p className="text-sm font-medium">
              Vercel account changed: {accountSwitch.from} → {accountSwitch.to}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Same team? Keep the links. Different account? Start fresh — projects
              re-create under {accountSwitch.to} on next deploy. Nothing is deleted.
            </p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  void (async () => {
                    const yes = await ask(
                      `Every project will re-create as a new project under ${accountSwitch.to} on its next deploy.\n\nNothing on ${accountSwitch.from} is deleted, but the two accounts' projects will no longer be linked.`,
                      { title: `Start Fresh under ${accountSwitch.to}`, kind: "warning" },
                    );
                    if (yes) await resolveAccountSwitch(false);
                  })()
                }
              >
                Start Fresh under {accountSwitch.to}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void resolveAccountSwitch(true)}
              >
                Keep Links (same team)
              </Button>
            </div>
          </div>
        )}
        {route.name === "settings" ? <Settings /> : <Dashboard />}
      </main>

      {/*
        Status bar: who you are on the left, what folder you are looking at on
        the right. Neither is an action the way ⌘K and Settings are — the
        account is ambient state, and the folder is the app's subject rather
        than a place to navigate to — which is why they read as clutter up in
        the toolbar and read as context down here.

        The folder is shown by name, not as "Open Folder". A button labelled
        with its target says where it goes; a button labelled with its verb
        makes you remember.
      */}
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-1.5 text-[11px] text-faint">
        {authedAs ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <UserAvatar />
            <span className="truncate">{authedAs}</span>
          </span>
        ) : (
          // Not a dead slot: signed out is worth saying, and it is the reason
          // deploys are failing if they are.
          <button
            className="transition-colors hover:text-muted"
            onClick={() => setRoute({ name: "settings" })}
          >
            Not signed in
          </button>
        )}
        <button
          onClick={() => void ipc.fs.openRootFolder()}
          title={rootFolder || "Open the sync folder"}
          className="flex min-w-0 shrink-0 items-center gap-1.5 transition-colors hover:text-muted"
        >
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate font-mono">{tildeAbbreviate(rootFolder)}</span>
        </button>
      </footer>

      <DropZone />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onViewLogs={onPaletteViewLogs}
      />
      {paletteLogs && (
        <LogViewerDialog
          deploymentId={paletteLogs.deployment.id}
          projectName={paletteLogs.name}
          onClose={() => setPaletteLogs(null)}
        />
      )}
    </div>
  );
}
