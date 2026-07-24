import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

/**
 * A dismissable bottom-right note (copy confirmation, drop-import result).
 * A CSS transition, not a keyframe, so a message that arrives while the
 * previous one is still closing retargets smoothly instead of restarting.
 * `message` is fully owned by the caller (set it, then clear it on a
 * timeout) — this component only owns the enter/exit choreography.
 */
export function Toast({
  message,
  style,
}: {
  message: string | null;
  style?: React.CSSProperties;
}) {
  const [rendered, setRendered] = useState(message);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (message) {
      setRendered(message);
      // Mount hidden, then flip visible next frame so the transition runs
      // (setting both in the same render would skip straight to the end state).
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
  }, [message]);

  if (!rendered) return null;

  return (
    <div
      style={style}
      onTransitionEnd={() => !visible && setRendered(null)}
      className={cn(
        "fixed bottom-4 right-4 max-w-sm whitespace-pre-line rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed shadow-2xl transition-opacity duration-200 ease-out motion-safe:transition-[opacity,transform]",
        visible
          ? "opacity-100 motion-safe:translate-y-0"
          : "pointer-events-none opacity-0 motion-safe:translate-y-2",
      )}
    >
      {rendered}
    </div>
  );
}
