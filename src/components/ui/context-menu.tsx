import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
}

/**
 * Minimal right-click menu: fixed portal at the cursor, clamped to the
 * viewport, closes on selection, outside click, or Escape.
 */
export function ContextMenu({
  position,
  items,
  onClose,
}: {
  position: ContextMenuState;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(position.x, innerWidth - rect.width - 8),
      y: Math.min(position.y, innerHeight - rect.height - 8),
    });
  }, [position]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="menu-in fixed min-w-[220px] rounded-xl border border-border bg-surface p-1.5 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <div key={item.label}>
            {item.separatorBefore && <div className="mx-1 my-1.5 h-px bg-border" />}
            <button
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                // Select before close so handlers can flag async work that
                // must outlive the menu (e.g. a toast on failure).
                item.onSelect?.();
                onClose();
              }}
              className={cn(
                "flex w-full items-center justify-between gap-6 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                item.disabled
                  ? "cursor-default text-faint"
                  : "text-foreground hover:bg-surface-hover",
              )}
            >
              {item.label}
              {item.icon && <span className="text-muted">{item.icon}</span>}
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
