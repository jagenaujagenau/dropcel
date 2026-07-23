import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import * as ipc from "../lib/ipc";

/**
 * Effect seams between the orchestrator and the outside world: system
 * notifications, clipboard, tray and connectivity. Each is a small interface
 * with a real Tauri-backed adapter, so the modules above (orchestrator,
 * reconciler, account session) stay testable with plain fakes.
 */

// ---- notifications ---------------------------------------------------------

export interface Notifier {
  notify(title: string, body: string): void;
}

/** Real notifier; owns the permission gate (macOS prompts once). */
export class TauriNotifier implements Notifier {
  private permission = false;

  async init(): Promise<void> {
    try {
      this.permission = await isPermissionGranted();
      if (!this.permission) {
        this.permission = (await requestPermission()) === "granted";
      }
    } catch {
      this.permission = false;
    }
  }

  notify(title: string, body: string): void {
    if (!this.permission) return;
    try {
      sendNotification({ title, body });
    } catch (err) {
      console.error("notification failed", err);
    }
  }
}

// ---- clipboard -------------------------------------------------------------

export interface ClipboardPort {
  write(text: string): Promise<void>;
}

export const tauriClipboard: ClipboardPort = {
  write: (text) => writeText(text),
};

// ---- tray ------------------------------------------------------------------

export interface TrayPort {
  update(projects: ipc.TrayProject[]): Promise<void>;
}

export const tauriTray: TrayPort = {
  // Tray failures must never break app flow.
  update: (projects) => ipc.tray.update(projects).catch(() => {}),
};

// ---- connectivity ----------------------------------------------------------

export interface ConnectivityDeps {
  /** Source of truth: can we actually reach api.vercel.com? */
  probe: () => Promise<boolean>;
  /** Instant (but optimistic) signal — `navigator.onLine`. */
  instantOnline: () => boolean;
  /** Wire the instant online/offline events (window listeners). */
  subscribe: (handlers: { onOffline: () => void; onOnline: () => void }) => void;
  onlineIntervalMs?: number;
  offlineIntervalMs?: number;
}

const ONLINE_INTERVAL_MS = 60_000;
const OFFLINE_INTERVAL_MS = 10_000;

/**
 * Dual-source connectivity monitor: the instant signal flips us offline
 * immediately, while the probe is the source of truth (onLine reports true
 * on internet-less LANs). While offline, probes re-run frequently so
 * reconnection is caught fast.
 */
export class ConnectivityMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners: ((online: boolean) => void)[] = [];
  /** Matches the store's optimistic default so startup emits only real changes. */
  private online = true;

  constructor(private deps: ConnectivityDeps) {}

  onChange(cb: (online: boolean) => void): void {
    this.listeners.push(cb);
  }

  isOnline(): boolean {
    return this.online;
  }

  /** Runs the first probe immediately, then self-schedules forever. */
  start(): Promise<void> {
    this.deps.subscribe({
      onOffline: () => this.apply(false),
      onOnline: () => void this.probe(),
    });
    return this.probe();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private apply(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    for (const cb of this.listeners) cb(online);
  }

  private async probe(): Promise<void> {
    const online = this.deps.instantOnline()
      ? await this.deps.probe().catch(() => false)
      : false;
    this.apply(online);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.probe(),
      online
        ? (this.deps.onlineIntervalMs ?? ONLINE_INTERVAL_MS)
        : (this.deps.offlineIntervalMs ?? OFFLINE_INTERVAL_MS),
    );
  }
}

export function createTauriConnectivity(): ConnectivityMonitor {
  return new ConnectivityMonitor({
    probe: () => ipc.network.checkOnline(),
    instantOnline: () => navigator.onLine,
    subscribe: ({ onOffline, onOnline }) => {
      window.addEventListener("offline", onOffline);
      window.addEventListener("online", onOnline);
    },
  });
}
