// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deployment, Project } from "../core/types";

/**
 * The palette's *rendering and keyboard* contract. What it offers and how it
 * ranks lives in `core/commands` and is tested there without a DOM; this
 * covers the part that only exists once it's mounted — that it renders at all,
 * that arrow keys move a real selection, and that Enter runs the command the
 * highlight is actually on.
 *
 * Everything below the component is faked at the module boundary: the atoms
 * module would otherwise drag in the whole Effect layer graph (and, through
 * it, Tauri's `invoke`), which has nothing to do with what's under test.
 */

const deployProject = vi.fn();
const reconcile = vi.fn();
const setRoute = vi.fn();
const openUrl = vi.fn();
const writeText = vi.fn();
const openRootFolder = vi.fn();

const project = (name: string): Project => ({
  id: `p-${name}`,
  name,
  path: `/Users/d/Vercel/${name}`,
  framework: "static",
  vercelProjectId: null,
  autoDeploy: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lockedBranch: null,
  remoteRepo: null,
  teamId: null,
  ownerUid: null,
});

const deployment = (projectId: string, over: Partial<Deployment> = {}): Deployment => ({
  id: `d-${projectId}`,
  projectId,
  state: "ready",
  target: "production",
  url: `https://${projectId}.vercel.app`,
  error: null,
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00Z",
  finishedAt: "2026-01-01T00:01:00Z",
  durationMs: 60_000,
  publicUrl: null,
  branch: null,
  commitSha: null,
  vercelDeploymentId: null,
  inspectorUrl: null,
  ...over,
});

const PROJECTS = [project("landing-page"), project("marketing-site")];
const LATEST: Record<string, Deployment> = {
  "p-landing-page": deployment("p-landing-page"),
  "p-marketing-site": deployment("p-marketing-site"),
};

vi.mock("../core/atoms", () => ({
  projectsAtom: "projects",
  presentOnDiskAtom: "present",
  latestByProjectAtom: "latest",
  deployProject: (...a: unknown[]) => deployProject(...a),
  reconcile: (...a: unknown[]) => reconcile(...a),
  setRoute: (...a: unknown[]) => setRoute(...a),
  useAtomState: (atom: string) =>
    atom === "projects" ? PROJECTS : new Set(PROJECTS.map((p) => p.name)),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => LATEST }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrl(...a) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...a: unknown[]) => writeText(...a),
}));
vi.mock("../lib/ipc", () => ({
  fs: { openRootFolder: (...a: unknown[]) => openRootFolder(...a) },
}));

import { CommandPalette } from "./CommandPalette";

const onClose = vi.fn();
const onViewLogs = vi.fn();

const open = () =>
  render(<CommandPalette open onClose={onClose} onViewLogs={onViewLogs} />);

const options = () => screen.getAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");
const type = (value: string) => fireEvent.change(screen.getByLabelText("Search projects and actions"), { target: { value } });
const press = (key: string) =>
  fireEvent.keyDown(screen.getByLabelText("Search projects and actions"), { key });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} onClose={onClose} onViewLogs={onViewLogs} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mounts with the most recent project's actions and the app-level ones", () => {
    open();
    expect(screen.getByRole("dialog")).toBeTruthy();
    const labels = options().map((o) => o.textContent ?? "");
    // Only the most recently deployed project is listed up front; the rest are
    // a keystroke away (see DEFAULT_PROJECTS in core/commands.ts).
    expect(labels.some((l) => l.includes("Redeploy") && l.includes("landing-page"))).toBe(true);
    expect(labels.some((l) => l.includes("marketing-site"))).toBe(false);
    expect(labels.some((l) => l.includes("Open the Vercel Folder"))).toBe(true);
  });

  it("reaches a project that is not in the default view by typing", () => {
    open();
    type("marketing");
    const labels = options().map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("marketing-site"))).toBe(true);
  });

  it("highlights the first result, and arrow keys move the highlight", () => {
    open();
    const first = options()[0]!;
    expect(selected()).toBe(first);

    press("ArrowDown");
    expect(selected()).toBe(options()[1]!);

    press("ArrowUp");
    expect(selected()).toBe(options()[0]!);
  });

  it("wraps around at both ends rather than dead-ending", () => {
    open();
    press("ArrowUp");
    expect(selected()).toBe(options().at(-1));
    press("ArrowDown");
    expect(selected()).toBe(options()[0]!);
  });

  it("narrows the list as the user types, and resets the highlight", () => {
    open();
    const total = options().length;
    press("ArrowDown");

    type("landing");
    expect(options().length).toBeLessThan(total);
    expect(options().every((o) => (o.textContent ?? "").includes("landing-page"))).toBe(true);
    // Re-ranked list ⇒ highlight belongs back at the top, not wherever it was.
    expect(selected()).toBe(options()[0]!);
  });

  it("runs the highlighted command on Enter and closes first", () => {
    open();
    type("redeploy landing");
    expect(within(selected()!).getByText("landing-page")).toBeTruthy();

    press("Enter");
    expect(onClose).toHaveBeenCalled();
    expect(deployProject).toHaveBeenCalledWith("p-landing-page", "production");
  });

  it("routes each command kind to the right side effect", () => {
    open();
    type("copy url landing");
    press("Enter");
    expect(writeText).toHaveBeenCalledWith("https://p-landing-page.vercel.app");

    cleanup();
    vi.clearAllMocks();
    open();
    type("rescan");
    press("Enter");
    expect(reconcile).toHaveBeenCalledWith(true);

    cleanup();
    vi.clearAllMocks();
    open();
    type("settings");
    press("Enter");
    expect(setRoute).toHaveBeenCalledWith({ name: "settings" });
  });

  it("closes on Escape without running anything", () => {
    open();
    press("Escape");
    expect(onClose).toHaveBeenCalled();
    expect(deployProject).not.toHaveBeenCalled();
  });

  it("says so plainly when nothing matches", () => {
    open();
    type("zzzqqq");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No matches for "zzzqqq"/)).toBeTruthy();
    // Enter on an empty list must be a no-op, not a crash.
    press("Enter");
    expect(deployProject).not.toHaveBeenCalled();
  });
});
