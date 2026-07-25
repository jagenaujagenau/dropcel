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

  /** Index of the keyboard-highlighted item; -1 until the user arrows in, so
   * opening by mouse doesn't pre-select anything. */
  const [active, setActive] = useState(-1);
  /** Indices that can actually be chosen — arrow keys skip disabled rows
   * rather than landing on a dead one. */
  const enabled = items.flatMap((item, i) => (item.disabled ? [] : [i]));

  /**
   * Focus moves into the menu on open and back to whatever opened it on
   * close. Without the restore, dismissing a menu dropped focus onto
   * `<body>` — a keyboard user lost their place in the grid entirely and had
   * to tab from the top of the page.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const step = (delta: number) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    const next = at === -1 ? (delta > 0 ? 0 : enabled.length - 1) : (at + delta + enabled.length) % enabled.length;
    setActive(enabled[next]!);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(enabled[0] ?? -1);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(enabled.at(-1) ?? -1);
    } else if (e.key === "Enter" || e.key === " ") {
      const item = items[active];
      if (!item || item.disabled) return;
      e.preventDefault();
      item.onSelect?.();
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()}>
      <div
        ref={ref}
        role="menu"
        aria-label="Project actions"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{ left: pos.x, top: pos.y }}
        className="menu-in fixed min-w-[220px] rounded-xl border border-border bg-surface p-1.5 shadow-2xl focus:outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <div key={item.label}>
            {item.separatorBefore && <div className="mx-1 my-1.5 h-px bg-border" />}
            <button
              role="menuitem"
              disabled={item.disabled}
              // Pointer and keyboard drive one highlight, so moving the mouse
              // never leaves two rows looking active.
              onMouseMove={() => !item.disabled && setActive(i)}
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
                i === active && !item.disabled && "bg-surface-hover",
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
