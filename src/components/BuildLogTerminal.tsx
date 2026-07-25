import { useEffect, useRef, useState } from "react";
import type { LogLine } from "../core/types";
import * as ipc from "../lib/ipc";
import { cn } from "../lib/utils";

/**
 * The tail of a build log, rendered as a terminal — what a project card shows
 * in place of its screenshot while a deploy is in flight. The old screenshot
 * is the *previous* version of the site, which is the least interesting thing
 * to look at during the one stretch where something is actually happening.
 *
 * Polled rather than streamed: the deployer writes each line to SQLite
 * (core/deployer.ts, core/api-deployer.ts) and there is no push channel for
 * them to the webview. A local SQLite read on a ~1s beat is cheap, and the
 * poll stops the moment `live` goes false, so a grid of idle cards costs
 * nothing.
 */

/** Slow enough not to hammer SQLite, fast enough to feel live. */
const POLL_MS = 900;

export function BuildLogTerminal({
  deploymentId,
  live,
  className,
}: {
  deploymentId: string;
  live: boolean;
  className?: string;
}) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const rows = await ipc.db.getLogs(deploymentId);
        if (cancelled) return;
        setLines(rows);
      } catch {
        // A log read failing is not worth surfacing on a card — the deploy
        // itself reports its own outcome, and the dialog gives the full story.
      }
      // Chained rather than setInterval: a slow read can't stack up requests
      // behind itself, and the poll stops cleanly on unmount.
      if (!cancelled && live) timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deploymentId, live]);

  // Pin to the newest line; the interesting output is always at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        "overflow-hidden bg-[oklch(0.16_0.01_265)]/90 px-2.5 py-2 font-mono text-[9px] leading-[1.45]",
        className,
      )}
    >
      {lines.length === 0 ? (
        <p className="text-white/40">
          <span className="text-[oklch(0.78_0.15_150)]">$</span> waiting for output…
        </p>
      ) : (
        lines.map((l) => (
          <p
            key={l.id}
            className={cn(
              "whitespace-pre-wrap break-all",
              l.stream === "stderr" ? "text-[oklch(0.75_0.14_30)]" : "text-white/75",
            )}
          >
            {l.line}
          </p>
        ))
      )}
      {/* The cursor is the tell that this is live rather than a transcript. */}
      {live && <span className="cursor-blink inline-block text-[oklch(0.78_0.15_150)]">▊</span>}
    </div>
  );
}
