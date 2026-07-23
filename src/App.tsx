import { useEffect } from "react";
import { ArrowLeft, FolderOpen, Pause, Settings as SettingsIcon, Triangle, WifiOff } from "lucide-react";
import { DropZone } from "./components/DropZone";
import { UserAvatar } from "./components/UserAvatar";
import { Button } from "./components/ui/button";
import { orchestrator } from "./core/orchestrator";
import * as ipc from "./lib/ipc";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { Settings } from "./pages/Settings";
import { useAppStore } from "./store/app";

let started = false;

export default function App() {
  const route = useAppStore((s) => s.route);
  const navigate = useAppStore((s) => s.navigate);
  const watchPaused = useAppStore((s) => s.watchPaused);
  const online = useAppStore((s) => s.online);
  const accountSwitch = useAppStore((s) => s.accountSwitch);
  const authedAs = useAppStore((s) => s.authedAs);
  const onboarded = useAppStore((s) => s.onboarded);
  const setOnboarded = useAppStore((s) => s.setOnboarded);

  useEffect(() => {
    if (!started) {
      started = true;
      void orchestrator.start();
    }
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
            setOnboarded(true);
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
            <Button variant="ghost" size="icon" onClick={() => navigate({ name: "dashboard" })} title="Back">
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="ghost" size="icon" onClick={() => navigate({ name: "settings" })} title="Settings">
              <SettingsIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="min-h-0 flex-1 overflow-auto">
        {accountSwitch && (
          <div className="mx-6 mt-4 rounded-xl border border-warning/30 bg-warning/10 p-4">
            <p className="text-sm font-medium">
              Vercel account changed: {accountSwitch.from} → {accountSwitch.to}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Same team? Keep the links. Different account? Start fresh — projects
              re-create under {accountSwitch.to} on next deploy. Nothing is deleted.
            </p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void orchestrator.resolveAccountSwitch(false)}>
                Start Fresh under {accountSwitch.to}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void orchestrator.resolveAccountSwitch(true)}
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
