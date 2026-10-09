import { useSyncExternalStore } from "react";

/**
 * Ruling 11 (RF-9): one wall clock per cadence, shared by every component
 * that reads it. Each relative stamp ("2m ago") and each elapsed counter used
 * to run its own `setInterval`: a KB browser with forty files ran forty
 * thirty-second intervals, each re-rendering one row in its own commit. Here
 * a cadence runs ONE interval while anything subscribes to it (none once the
 * last reader unmounts), and every reader moves on the same tick, in one
 * commit.
 *
 * The value is the instant of the cadence's last tick, in epoch ms; null on
 * the server and during hydration, so both render the same placeholder and
 * the client's clock arrives in the re-render React makes right after
 * hydration. A reader that mounts later reads the shared instant at once.
 *
 * `active: false` reads the clock once (the instant it renders) without
 * subscribing to its ticks.
 */

interface Ticker {
  /** The last tick, or the last read while nothing was subscribed. */
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}

const tickers = new Map<number, Ticker>();

function tickerFor(cadenceMs: number): Ticker {
  let ticker = tickers.get(cadenceMs);
  if (!ticker) {
    ticker = { now: Date.now(), listeners: new Set(), timer: null };
    tickers.set(cadenceMs, ticker);
  }
  return ticker;
}

/** The shared instant. While no interval runs the stored one can be stale, so
 *  a read then refreshes it once it is a cadence old; while one runs, every
 *  reader gets the same tick. */
function read(cadenceMs: number): number {
  const ticker = tickerFor(cadenceMs);
  // (Either way: a clock set back, as a test's fake one can be, refreshes too.)
  if (ticker.timer === null && Math.abs(Date.now() - ticker.now) >= cadenceMs) {
    ticker.now = Date.now();
  }
  return ticker.now;
}

function subscribe(cadenceMs: number, listener: () => void): () => void {
  const ticker = tickerFor(cadenceMs);
  ticker.listeners.add(listener);
  if (ticker.timer === null) {
    // The first reader rendered an instant up to a cadence old; this one is
    // exact, and React re-renders a reader whose snapshot moved while it
    // subscribed. Later readers join the running tick.
    ticker.now = Date.now();
    ticker.timer = setInterval(() => {
      ticker.now = Date.now();
      for (const notify of ticker.listeners) notify();
    }, cadenceMs);
  }
  return () => {
    ticker.listeners.delete(listener);
    if (ticker.listeners.size === 0 && ticker.timer !== null) {
      clearInterval(ticker.timer);
      ticker.timer = null;
    }
  };
}

const subscribeByCadence = new Map<number, (listener: () => void) => () => void>();
const readByCadence = new Map<number, () => number>();

/** Stable per-cadence functions, so React never resubscribes on a render. */
function storeFor(cadenceMs: number) {
  let sub = subscribeByCadence.get(cadenceMs);
  let snap = readByCadence.get(cadenceMs);
  if (!sub || !snap) {
    sub = (listener) => subscribe(cadenceMs, listener);
    snap = () => read(cadenceMs);
    subscribeByCadence.set(cadenceMs, sub);
    readByCadence.set(cadenceMs, snap);
  }
  return { sub, snap };
}

function subscribeToNothing(): () => void {
  return () => {};
}
function serverSnapshot(): null {
  return null;
}

export function useClock(cadenceMs: number, active = true): number | null {
  const { sub, snap } = storeFor(cadenceMs);
  return useSyncExternalStore(active ? sub : subscribeToNothing, snap, serverSnapshot);
}
