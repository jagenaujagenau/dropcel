/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropZone } from "./DropZone";

/**
 * A refused drop used to be a 12px note in the corner of a window the user was
 * mid-drag over — the easiest thing in the app to miss, and the one message
 * that is always actionable. These pin that a refusal is surfaced loudly and a
 * success is not.
 */

const mocks = vi.hoisted(() => ({
  importDroppedPath: vi.fn(),
  takePendingDrops: vi.fn(),
  /** The window drag-drop callback registered by DropZone. */
  onDrop: null as null | ((payload: unknown) => void),
}));

vi.mock("../lib/ipc", () => ({
  fs: {
    importDroppedPath: mocks.importDroppedPath,
    takePendingDrops: mocks.takePendingDrops,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (cb: (e: { payload: unknown }) => void) => {
      mocks.onDrop = (payload) => cb({ payload });
      return Promise.resolve(() => {});
    },
  }),
}));

// Canvas-backed and irrelevant here; stubbed so the test can see the state it
// is handed.
vi.mock("./TriangleGlow", () => ({
  TriangleGlow: ({
    errorAt,
    raining,
    paused,
  }: {
    errorAt?: number | null;
    raining?: boolean;
    paused?: boolean;
  }) => (
    <div
      data-testid="triangle-glow"
      data-error-at={errorAt ?? ""}
      data-raining={raining ? "yes" : "no"}
      data-paused={paused ? "yes" : "no"}
    />
  ),
}));

const drop = (paths: string[]) => {
  fireEvent(window, new Event("noop")); // flush any pending microtasks
  mocks.onDrop?.({ type: "drop", paths });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onDrop = null;
  mocks.takePendingDrops.mockResolvedValue([]);
});

afterEach(cleanup);

describe("DropZone drag state", () => {
  it("rains while a drag is over the window, and stops once it leaves", async () => {
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    mocks.onDrop?.({ type: "enter", position: { x: 10, y: 10 } });
    const glow = await screen.findByTestId("triangle-glow");
    expect(glow.getAttribute("data-raining")).toBe("yes");
    // The rain is the drag state, not the failure state — nothing has failed.
    expect(glow.getAttribute("data-error-at")).toBe("");

    mocks.onDrop?.({ type: "leave" });
    await waitFor(() =>
      expect(screen.getByTestId("triangle-glow").getAttribute("data-raining")).toBe("no"),
    );
    // Stops rendering rather than staying live behind an invisible overlay.
    expect(screen.getByTestId("triangle-glow").getAttribute("data-paused")).toBe("yes");
  });

  /**
   * The rain was originally bound to the hover only, so releasing the file
   * ended it. Dragging in from Finder and dropping immediately showed it for a
   * few frames, and the drop — the event actually being acknowledged — had no
   * state of its own.
   */
  it("keeps raining after the file lands, not just while hovering", async () => {
    let release: (v: string) => void = () => {};
    mocks.importDroppedPath.mockReturnValue(new Promise<string>((r) => (release = r)));
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    mocks.onDrop?.({ type: "enter", position: { x: 5, y: 5 } });
    await screen.findByTestId("triangle-glow");

    // Release the drag: hovering is over, but the import is now in flight.
    mocks.onDrop?.({ type: "drop", paths: ["/Users/d/Desktop/site"] });
    await waitFor(() =>
      expect(screen.getByTestId("triangle-glow").getAttribute("data-raining")).toBe("yes"),
    );
    expect(screen.getByTestId("triangle-glow").getAttribute("data-paused")).toBe("no");

    release("site");
    await screen.findByText(/Deploying site…/);
    // Still raining through the dwell, so a fast import is still acknowledged.
    expect(screen.getByTestId("triangle-glow").getAttribute("data-raining")).toBe("yes");
  });

  /**
   * The overlay used to be `{dragging && <TriangleGlow/>}`, so every drag-enter
   * built a new WebGL2 context. Browsers cap live contexts (~16) and return
   * null past that, which drops the component to its star-field fallback for
   * the rest of the session — and it rebuilt the 512px glyph atlas each time.
   */
  it("keeps one canvas across repeated drags instead of remounting it", async () => {
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    mocks.onDrop?.({ type: "enter", position: { x: 1, y: 1 } });
    const first = await screen.findByTestId("triangle-glow");

    // Each transition has to be flushed separately. Firing leave and enter in
    // one synchronous block lets React batch them into no state change at all,
    // so the subtree survives even when the code DOES unmount it — the test
    // would pass against the very bug it exists to catch.
    const raining = (want: "yes" | "no") =>
      waitFor(
        () => expect(screen.getByTestId("triangle-glow").getAttribute("data-raining")).toBe(want),
        { timeout: 300 },
      );

    for (let i = 0; i < 5; i++) {
      mocks.onDrop?.({ type: "leave" });
      await raining("no"); // throws if the node was removed instead of paused
      mocks.onDrop?.({ type: "enter", position: { x: i, y: i } });
      await raining("yes");
    }

    // Same DOM node → React never unmounted the subtree, so the GL context and
    // the glyph atlas survived all six drags.
    expect(screen.getByTestId("triangle-glow")).toBe(first);
  });
});

describe("DropZone failure surface", () => {
  it("shows the refusal, with the reason, when an import is rejected", async () => {
    mocks.importDroppedPath.mockRejectedValue({
      message: "photo.png can't be a site on its own. Put it in a folder with an index.html.",
    });
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    drop(["/Users/d/Desktop/photo.png"]);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/can't be a site on its own/);
    expect(alert.textContent).toMatch(/index\.html/);
    // ...and the triangle is handed a fresh failure timestamp to animate from.
    const glow = screen.getByTestId("triangle-glow");
    expect(Number(glow.getAttribute("data-error-at"))).toBeGreaterThan(0);
  });

  it("does not raise the refusal for a drop that succeeded", async () => {
    mocks.importDroppedPath.mockResolvedValue("blog");
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    drop(["/Users/d/Desktop/blog"]);

    await screen.findByText(/Deploying blog…/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dismisses on Escape — the overlay is click-to-dismiss, which a keyboard cannot do", async () => {
    mocks.importDroppedPath.mockRejectedValue({ message: "nope" });
    render(<DropZone />);
    await waitFor(() => expect(mocks.onDrop).not.toBeNull());

    drop(["/x"]);
    await screen.findByRole("alert");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
