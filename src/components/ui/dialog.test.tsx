/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./dialog";

/**
 * `aria-modal` tells assistive tech the rest of the page is inert; it does
 * nothing for Tab. These cover the focus behaviour that has to be implemented
 * by hand — and it matters here because the dialogs are the destructive ones
 * (Delete on Vercel, Move to Trash).
 */

afterEach(cleanup);

function Body() {
  return (
    <>
      <button>first</button>
      <button>last</button>
    </>
  );
}

describe("Dialog", () => {
  it("renders nothing when closed", () => {
    render(
      <Dialog open={false} onClose={vi.fn()} title="Delete">
        <Body />
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the dialog on open", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Delete">
        <Body />
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("keeps Tab inside the dialog rather than walking into the page behind", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Delete">
        <Body />
      </Dialog>,
    );
    const last = screen.getByText("last");
    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    // Wrapped forward to the first focusable — the close button.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });

  it("wraps backwards from the first focusable too", () => {
    render(
      <Dialog open onClose={vi.fn()} title="Delete">
        <Body />
      </Dialog>,
    );
    const close = screen.getByLabelText("Close");
    close.focus();
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Delete">
        <Body />
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to the opener on close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const { unmount } = render(
      <Dialog open onClose={vi.fn()} title="Delete">
        <Body />
      </Dialog>,
    );
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
