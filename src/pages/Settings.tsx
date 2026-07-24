import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileText, Loader2, LogOut, Triangle } from "lucide-react";
import { UserAvatar } from "../components/UserAvatar";
import { useDeviceSignIn } from "../components/useDeviceSignIn";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { signOut } from "../core/auth";
import { getLogPath } from "../lib/log";
import {
  accountStateAtom,
  latestByProjectAtom,
  presentOnDiskAtom,
  projectsAtom,
  purgeProject,
  reconcile,
  refreshAuth,
  rootFolderAtom,
  setRootFolderLocal,
  setWatchPausedLocal,
  useAtomState,
  watchPausedAtom,
} from "../core/atoms";
import { FRAMEWORK_LABELS, type Framework } from "../core/types";
import * as ipc from "../lib/ipc";
import { timeAgo } from "../lib/utils";

/**
 * Projects whose folder left ~/Vercel. Their history is kept (put the folder
 * back with the same name and it reattaches) until explicitly cleared here.
 * Clearing is local-only — the remote Vercel project is never touched.
 */
function RemovedProjects() {
  const projects = useAtomState(projectsAtom, []);
  const presentOnDisk = useAtomState(presentOnDiskAtom, new Set<string>());
  const latestByProject = useAtomState(latestByProjectAtom, {});
  const ghosts = projects.filter((p) => !presentOnDisk.has(p.name));

  if (ghosts.length === 0) return null;

  return (
    <Section
      title="Removed Projects"
      description="No longer in the folder. History kept until cleared; nothing on Vercel is touched."
    >
      <div className="space-y-2">
        {ghosts.map((p) => {
          const latest = latestByProject[p.id];
          return (
            <div key={p.id} className="flex items-center gap-3 text-xs">
              <div className="min-w-0 flex-1">
                <p className="truncate">{p.name}</p>
                <p className="text-[11px] text-faint">
                  {FRAMEWORK_LABELS[p.framework as Framework] ?? p.framework}
                  {latest ? ` · last deployed ${timeAgo(latest.startedAt)}` : " · never deployed"}
                </p>
              </div>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void purgeProject(p.id)}
              >
                Clear History
              </Button>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** Signed in: identity + sign out. No token input — it's already done. */
function SignedIn() {
  const authedAs = useAtomState(accountStateAtom, { username: null, avatarUrl: null, pendingSwitch: null }).username;
  return (
    <div className="flex items-center gap-3">
      <UserAvatar size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{authedAs}</p>
        <p className="text-[11px] text-faint">Connected to Vercel</p>
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          await signOut();
          await refreshAuth();
        }}
      >
        <LogOut className="h-3.5 w-3.5" /> Sign Out
      </Button>
    </div>
  );
}

function SignedOut() {
  const { signIn, busy, failed, begin, cancel, reopenBrowser } = useDeviceSignIn();
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const saveToken = async () => {
    setSaving(true);
    try {
      await ipc.credentials.setToken(token);
      setToken("");
      await refreshAuth();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {signIn ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />
          <div className="min-w-0 flex-1 text-xs">
            <p>Approve the sign-in in your browser</p>
            <p className="text-[11px] text-faint">
              Code:{" "}
              <span className="font-mono tracking-widest text-foreground">{signIn.userCode}</span>
              {" · "}
              <button className="hover:text-muted" onClick={reopenBrowser}>
                reopen page
              </button>
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button className="w-full" disabled={busy} onClick={() => void begin()}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <Triangle className="h-3 w-3 fill-current" /> Sign in with Vercel
        </Button>
      )}
      {failed && (
        <p className="text-[11px] text-danger">
          Sign-in didn't complete — try again, or paste a token below.
        </p>
      )}
      {showPaste ? (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder="Vercel access token (vercel.com → Account → Tokens)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && token && void saveToken()}
          />
          <Button size="sm" variant="secondary" disabled={!token || saving} onClick={() => void saveToken()}>
            Save
          </Button>
        </div>
      ) : (
        <button
          className="w-full text-center text-[11px] text-faint hover:text-muted"
          onClick={() => setShowPaste(true)}
        >
          Paste an access token instead
        </button>
      )}
    </div>
  );
}

function LogsRow() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    void getLogPath().then(setPath).catch(() => {});
  }, []);
  return (
    <div className="flex items-center gap-2">
      <Input value={path ?? ""} readOnly className="font-mono text-xs" />
      <Button
        variant="secondary"
        size="sm"
        disabled={!path}
        onClick={() => path && void revealItemInDir(path).catch(() => {})}
      >
        <FileText className="h-3.5 w-3.5" /> Reveal
      </Button>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Settings() {
  const rootFolder = useAtomState(rootFolderAtom, "");
  const watchPaused = useAtomState(watchPausedAtom, false);
  const authedAs = useAtomState(accountStateAtom, { username: null, avatarUrl: null, pendingSwitch: null }).username;
  const setRootFolder = setRootFolderLocal;
  const setWatchPaused = setWatchPausedLocal;

  const [autostart, setAutostart] = useState(false);
  const [copyOnReady, setCopyOnReady] = useState(true);

  useEffect(() => {
    void isEnabled().then(setAutostart).catch(() => {});
    void ipc.db
      .getSetting("copy_url_on_ready")
      .then((v) => setCopyOnReady(v !== "0"))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </div>

      <Section
        title="Sync Folder"
        description="Everything in this folder deploys automatically."
      >
        <div className="flex items-center gap-2">
          <Input value={rootFolder} readOnly className="font-mono text-xs" />
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              const dir = await openDialog({ directory: true, defaultPath: rootFolder });
              if (typeof dir === "string") {
                await ipc.fs.setRootFolder(dir);
                setRootFolder(dir);
                await reconcile(false);
              }
            }}
          >
            Change…
          </Button>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div>
            <p className="text-xs">Pause watching</p>
            <p className="text-[11px] text-faint">Stops auto deploys.</p>
          </div>
          <Switch
            checked={watchPaused}
            aria-label="Pause watching"
            onCheckedChange={async (v) => {
              await ipc.fs.setWatchPaused(v);
              setWatchPaused(v);
            }}
          />
        </div>
      </Section>

      <Section
        title="Vercel Account"
        description="Stored in your system keychain."
      >
        {authedAs ? <SignedIn /> : <SignedOut />}
      </Section>

      <Section
        title="Logs"
        description="Deploys, holds, and errors. Attach when reporting a problem."
      >
        <LogsRow />
      </Section>

      <RemovedProjects />

      <Section title="System">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs">Copy URL when a deployment is ready</p>
            <p className="text-[11px] text-faint">Ready to paste anywhere.</p>
          </div>
          <Switch
            checked={copyOnReady}
            aria-label="Copy URL when ready"
            onCheckedChange={async (v) => {
              setCopyOnReady(v);
              await ipc.db.setSetting("copy_url_on_ready", v ? "1" : "0");
            }}
          />
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
          <div>
            <p className="text-xs">Launch at login</p>
            <p className="text-[11px] text-faint">Deploys keep running in the background.</p>
          </div>
          <Switch
            checked={autostart}
            aria-label="Launch at login"
            onCheckedChange={async (v) => {
              try {
                if (v) await enable();
                else await disable();
                setAutostart(await isEnabled());
              } catch {
                /* unsupported in dev builds on some platforms */
              }
            }}
          />
        </div>
      </Section>
    </div>
  );
}
