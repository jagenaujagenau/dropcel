import { useEffect } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowUpCircle,
  FolderOpen,
  Loader2,
  Pause,
  Settings as SettingsIcon,
  Triangle,
  WifiOff,
} from "lucide-react";
import { DropZone } from "./components/DropZone";
import { UserAvatar } from "./components/UserAvatar";
import { Button } from "./components/ui/button";
import {
  accountStateAtom,
  installUpdateAndRelaunch,
  onboardedAtom,
  onlineAtom,
  resolveAccountSwitch,
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

  useEffect(() => {
    startApp();
  }, []);

  if (onboarded === null) {
    return <div className="titlebar-drag h-full" />;
  }
  if (!onboarded) {
    return (
      <div className="h-full">
        <div className="titlebar-drag absolute inset-x-0 top-0 h-8" />
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
      <header className="titlebar-drag flex items-center gap-3 border-b border-border px-4 pb-3 pt-9">
        <Triangle className="h-3.5 w-3.5 fill-foreground" />
        <span className="text-[13px] font-semibold tracking-tight">Dropcel</span>
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
        <div className="ml-auto flex items-center gap-1">
          {authedAs && (
            <span className="mr-1 flex items-center gap-1.5 text-[11px] text-faint">
              <UserAvatar />
              {authedAs}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => void ipc.fs.openRootFolder()}>
            <FolderOpen className="h-3.5 w-3.5" /> Open Folder
          </Button>
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

      <DropZone />
    </div>
  );
}
