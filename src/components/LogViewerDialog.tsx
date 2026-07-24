import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy } from "lucide-react";
import type { LogLine } from "../core/types";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";
import { Dialog } from "./ui/dialog";

/**
 * The build log for one deployment — the app's own captured stdout/stderr
 * (see core/deployer.ts / core/api-deployer.ts), not a link out to Vercel.
 * Read-only; scrolls to the end since the failure is usually at the bottom.
 */
export function LogViewerDialog({
  deploymentId,
  projectName,
  onClose,
}: {
  deploymentId: string;
  projectName: string;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void ipc.db
      .getLogs(deploymentId)
      .then((rows) => {
        if (!cancelled) setLines(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String((e as { message?: string })?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [deploymentId]);

  useEffect(() => {
    if (lines && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const copyAll = () => {
    if (!lines) return;
    void writeText(lines.map((l) => l.line).join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Build log — ${projectName}`}
      className="max-w-2xl"
    >
      <div className="space-y-2">
        <div
          ref={scrollRef}
          className="max-h-[60vh] min-h-[120px] overflow-y-auto rounded-lg border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed"
        >
          {error ? (
            <p className="text-danger">{error}</p>
          ) : lines === null ? (
            <p className="text-faint">Loading…</p>
          ) : lines.length === 0 ? (
            <p className="text-faint">No log output was captured for this deployment.</p>
          ) : (
            lines.map((l) => (
              <div
                key={l.id}
                className={cn("whitespace-pre-wrap break-all", l.stream === "stderr" && "text-danger")}
              >
                {l.line}
              </div>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <button
            className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground disabled:opacity-40"
            disabled={!lines || lines.length === 0}
            onClick={copyAll}
          >
            {copied ? (
              <span key="copied" className="icon-in flex items-center gap-1.5">
                <Check className="h-3 w-3 text-success" /> Copied
              </span>
            ) : (
              <span key="copy" className="icon-in flex items-center gap-1.5">
                <Copy className="h-3 w-3" /> Copy log
              </span>
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
