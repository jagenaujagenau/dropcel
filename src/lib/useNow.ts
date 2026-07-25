import { useEffect, useState } from "react";

/**
 * A shared clock for relative/elapsed timestamps.
 *
 * Every `timeAgo`/elapsed string in the app is computed during render from
 * `Date.now()`, so without a tick they freeze at whatever the last unrelated
 * re-render happened to leave them at — a card reads "just now" ten minutes
 * later, and an in-flight deploy's elapsed time never moves. This is the one
 * thing driving them forward.
 *
 * One interval for the whole app, not one per component: N mounted cards
 * subscribe to the same module-level timer, so the cost is O(1) in timers and
 * every consumer flips in the same frame (staggered per-component intervals
 * would visibly desync two cards showing the same age).
 *
 * The timer only runs while the document is visible. A background window has
 * nobody reading these strings, and the browser would throttle the interval
 * to ~1/minute anyway — so instead of ticking unreliably we stop, and
 * resubscribe with a fresh `Date.now()` on the way back, which is exactly the
 * value a returning user needs to see.
 */

type Listener = (now: number) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
/** The clock only feeds second/minute-granularity strings; 1s is the
 * coarsest tick that still keeps an elapsed counter honest. */
const TICK_MS = 1000;

function broadcast(): void {
  const now = Date.now();
  for (const l of listeners) l(now);
}

function start(): void {
  if (timer !== undefined) return;
  timer = setInterval(broadcast, TICK_MS);
}

function stop(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

/** Follows the tab's visibility for the lifetime of the module — registered
 * once, and only while at least one consumer is mounted (see `subscribe`). */
function onVisibilityChange(): void {
  if (document.visibilityState === "visible") {
    // Catch up immediately; the user is looking at a stale value right now.
    broadcast();
    start();
  } else {
    stop();
  }
}

function subscribe(listener: Listener): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (document.visibilityState === "visible") start();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    }
  };
}

/**
 * The current time in ms, re-rendering the caller once a second while the
 * window is visible. Use for anything derived from "how long ago / how long
 * so far"; don't use it as a general re-render pump.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}
