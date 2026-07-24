import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { startDeviceSignIn, type DeviceSignIn } from "../core/auth";
import { refreshAuth } from "../core/atoms";

/**
 * Shared "Sign in with Vercel" (OAuth device flow) state machine, used by
 * onboarding and Settings. Opens the browser approval page, exposes the
 * user code to display, and refreshes auth on success.
 */
export function useDeviceSignIn() {
  const [signIn, setSignIn] = useState<DeviceSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ref = useRef<DeviceSignIn | null>(null);

  useEffect(() => () => ref.current?.cancel(), []);

  const begin = async () => {
    setFailed(false);
    setBusy(true);
    try {
      const s = await startDeviceSignIn();
      ref.current = s;
      setSignIn(s);
      void openUrl(s.verificationUri);
      const result = await s.done;
      setSignIn(null);
      ref.current = null;
      if (result) {
        void refreshAuth();
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
      setSignIn(null);
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    ref.current?.cancel();
    ref.current = null;
    setSignIn(null);
  };

  const reopenBrowser = () => {
    if (ref.current) void openUrl(ref.current.verificationUri);
  };

  return { signIn, busy, failed, begin, cancel, reopenBrowser };
}
