import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2, Rocket, Triangle } from "lucide-react";
import { TriangleField } from "../components/TriangleField";
import { useDeviceSignIn } from "../components/useDeviceSignIn";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { orchestrator } from "../core/orchestrator";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";
import { useAppStore } from "../store/app";

/**
 * First-run experience, built around two guarantees:
 *  1. the user leaves authenticated — silently (CLI-session import), with
 *     one browser click ("Sign in with Vercel", OAuth device flow), or by
 *     pasting a token as the fallback;
 *  2. the user can end with a real deployed URL ("Deploy an example site"),
 *     so the product's promise is experienced inside onboarding.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const authedAs = useAppStore((s) => s.authedAs);
  const [step, setStep] = useState(0);

  // Auth resolved itself (CLI import at startup, or sign-in finished
  // while on the connect step): never show or keep showing Connect.
  useEffect(() => {
    if (step === 1 && authedAs) setStep(2);
  }, [step, authedAs]);

  const steps = authedAs ? [0, 2] : [0, 1, 2];

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div className="w-full max-w-md">
        {step === 0 && <Welcome next={() => setStep(authedAs ? 2 : 1)} />}
        {step === 1 && <Connect />}
        {step === 2 && <Ready done={onDone} />}
      </div>
      <div className="mt-8 flex gap-1.5">
        {steps.map((s) => (
          <span
            key={s}
            className={cn(
              "h-1 w-6 rounded-full transition-colors",
              s <= step ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
    </div>
  );
}

function Welcome({ next }: { next: () => void }) {
  const authedAs = useAppStore((s) => s.authedAs);
  return (
    <div className="space-y-4 text-center">
      <TriangleField className="mx-auto h-52 w-full" />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Welcome to Dropcel</h1>
        <p className="text-sm leading-relaxed text-muted">
          Drop a project into a folder.
          <br />
          Seconds later, it's live.
        </p>
        {authedAs && (
          <p className="inline-flex items-center gap-1.5 text-xs text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Signed in as {authedAs}
          </p>
        )}
      </div>
      <Button className="w-full" onClick={next}>
        Get Started
      </Button>
    </div>
  );
}

function Connect() {
  const { signIn, busy, failed, begin, cancel, reopenBrowser } = useDeviceSignIn();
  const [showPaste, setShowPaste] = useState(false);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const saveToken = async () => {
    setSaving(true);
    try {
      await ipc.credentials.setToken(token);
      setToken("");
      await orchestrator.refreshAuth();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold tracking-tight">Connect Vercel</h2>
        <p className="text-xs text-muted">Approve in your browser. That's it.</p>
      </div>

      {signIn ? (
        <div className="space-y-3 rounded-xl border border-border bg-surface p-4 text-center">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted" />
          <p className="text-sm">Approve the sign-in in your browser</p>
          <p className="text-xs text-muted">
            Confirm this code matches:{" "}
            <span className="font-mono text-base tracking-widest text-foreground">
              {signIn.userCode}
            </span>
          </p>
          <div className="flex justify-center gap-3 text-[11px]">
            <button className="text-faint hover:text-muted" onClick={reopenBrowser}>
              Reopen browser page
            </button>
            <button className="text-faint hover:text-danger" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <Button className="w-full" disabled={busy} onClick={() => void begin()}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <Triangle className="h-3 w-3 fill-current" /> Sign in with Vercel
        </Button>
      )}

      {failed && (
        <p className="text-center text-[11px] text-danger">
          Sign-in didn't complete. Try again or paste a token.
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

function Ready({ done }: { done: () => void }) {
  const rootFolder = useAppStore((s) => s.rootFolder);
  const [deploying, setDeploying] = useState(false);

  const deployExample = async () => {
    setDeploying(true);
    try {
      await ipc.fs.createExampleProject();
      // Land on the dashboard and watch the example go live for real:
      // detection → deploy → notification → URL in the clipboard.
      done();
    } catch {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-success/30 bg-success/10">
        <FolderOpen className="h-7 w-7 text-success" />
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">Your folder is live</h2>
        <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted">
          Anything you drop into{" "}
          <code className="rounded bg-surface px-1 py-0.5 text-foreground">{rootFolder}</code>{" "}
          deploys automatically.
        </p>
      </div>
      <div className="space-y-2">
        <Button className="w-full" disabled={deploying} onClick={() => void deployExample()}>
          {deploying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
          Deploy an Example Site
        </Button>
        <Button
          variant="secondary"
          className="w-full"
          onClick={() => {
            void ipc.fs.openRootFolder();
            done();
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" /> I have a project — open the folder
        </Button>
        <button className="w-full text-center text-[11px] text-faint hover:text-muted" onClick={done}>
          Go to the dashboard
        </button>
      </div>
    </div>
  );
}
