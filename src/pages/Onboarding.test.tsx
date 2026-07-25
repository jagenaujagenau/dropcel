/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Onboarding's token paste is the *fallback* path — the user only reaches it
 * because "Sign in with Vercel" already didn't work for them. A failure here
 * that produces no visible change is the worst dead end in the app: they walk
 * away believing they're connected, and every later deploy fails pointing
 * somewhere unrelated.
 */

const mocks = vi.hoisted(() => ({
  setToken: vi.fn(),
  refreshAuth: vi.fn(),
  begin: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  credentials: { setToken: mocks.setToken },
  fs: { createExampleProject: vi.fn(), openRootFolder: vi.fn() },
}));

vi.mock("../core/atoms", () => ({
  accountStateAtom: {},
  authErrorAtom: {},
  rootFolderAtom: {},
  refreshAuth: mocks.refreshAuth,
  useAtomState: (_atom: unknown, initial: unknown) => initial,
}));

vi.mock("../core/account-session", () => ({ describeAuthError: () => null }));

vi.mock("../components/useDeviceSignIn", () => ({
  useDeviceSignIn: () => ({
    signIn: null,
    busy: false,
    failed: false,
    begin: mocks.begin,
    cancel: vi.fn(),
    reopenBrowser: vi.fn(),
  }),
}));


import { Onboarding } from "./Onboarding";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Walk from Welcome to the Connect step and reveal the paste field. */
function openTokenField() {
  render(<Onboarding onDone={vi.fn()} />);
  fireEvent.click(screen.getByText("Get Started"));
  fireEvent.click(screen.getByText("Paste an access token instead"));
  return screen.getByPlaceholderText(/Vercel access token/);
}

describe("Onboarding — token fallback", () => {
  it("tells the user when the token could not be saved", async () => {
    mocks.setToken.mockRejectedValueOnce(new Error("keychain is locked"));
    const input = openTokenField();
    fireEvent.change(input, { target: { value: "tok_123" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText(/Could not save the token/)).toBeTruthy();
    });
    expect(screen.getByText(/keychain is locked/)).toBeTruthy();
    // The token stays in the field so the attempt isn't lost.
    expect((input as HTMLInputElement).value).toBe("tok_123");
  });

  it("clears the field and raises no error when the save succeeds", async () => {
    mocks.setToken.mockResolvedValueOnce(undefined);
    const input = openTokenField();
    fireEvent.change(input, { target: { value: "tok_123" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalled());
    expect(screen.queryByText(/Could not save the token/)).toBeNull();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not leave a stale error visible on a later successful save", async () => {
    mocks.setToken
      .mockRejectedValueOnce(new Error("keychain is locked"))
      .mockResolvedValueOnce(undefined);
    const input = openTokenField();

    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Could not save the token/)).toBeTruthy());

    fireEvent.change(input, { target: { value: "good" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.queryByText(/Could not save the token/)).toBeNull());
  });
});
