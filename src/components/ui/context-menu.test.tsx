/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./context-menu";

/**
 * The context menu is the app's primary action surface — Redeploy, Deploy
 * Preview, View Build Log, Delete. It was reachable by right-click alone,
 * which is both undiscoverable and unusable without a mouse. These cover the
 * parts that only exist once it's mounted.
 */

afterEach(cleanup);

const items = [
  { label: "Visit", onSelect: vi.fn() },
  { label: "Copy URL", disabled: true, onSelect: vi.fn() },
  { label: "Redeploy", onSelect: vi.fn() },
];

function open(onClose = vi.fn()) {
  const fresh = items.map((i) => ({ ...i, onSelect: vi.fn() }));
  render(<ContextMenu position={{ x: 10, y: 10 }} items={fresh} onClose={onClose} />);
  return { items: fresh, onClose, menu: screen.getByRole("menu") };
}

describe("ContextMenu", () => {
  it("exposes itself as a menu of menuitems", () => {
    open();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("takes focus on open so the keyboard can drive it", () => {
    const { menu } = open();
    expect(document.activeElement).toBe(menu);
  });

  it("arrows through items, skipping disabled ones", () => {
    const { items: fresh, menu } = open();
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // → Visit
    fireEvent.keyDown(menu, { key: "ArrowDown" }); // skips Copy URL → Redeploy
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(fresh[2]!.onSelect).toHaveBeenCalled();
    expect(fresh[1]!.onSelect).not.toHaveBeenCalled();
  });

  it("wraps around rather than dead-ending", () => {
    const { items: fresh, menu } = open();
    // Up from nothing selects the last enabled item.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(fresh[2]!.onSelect).toHaveBeenCalled();
  });

  it("never activates a disabled item", () => {
    const { items: fresh, menu } = open();
    fireEvent.keyDown(menu, { key: "Home" });
    fireEvent.keyDown(menu, { key: "End" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(fresh[1]!.onSelect).not.toHaveBeenCalled();
  });

  it("closes on Escape without selecting anything", () => {
    const onClose = vi.fn();
    const { items: fresh } = open(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(fresh.every((i) => !i.onSelect.mock.calls.length)).toBe(true);
  });

  it("returns focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(
      <ContextMenu position={{ x: 0, y: 0 }} items={items} onClose={vi.fn()} />,
    );
    expect(document.activeElement).not.toBe(opener);

    // Dismissing must not strand focus on <body> — a keyboard user would
    // otherwise lose their place in the grid entirely.
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
