import { useEffect, useState } from "react";
import type { PillKind } from "~/ui/pill";
import type { RunView } from "./runtime-types";

/**
 * Client helpers ported from runs.jsx (the file-local functions): RUN_STATE,
 * runLabel, roleShort, fmtClock, fmtTok, useElapsed. Elapsed
 * derives from startedAt (client clock) — NO fabricated token growth (the
 * mock's `tick*42` is banned; tokens come from real usage on the RunView).
 */

/** state → { kind, label } for pills/states (runs.md §2). */
export const RUN_STATE: Record<
  RunView["state"],
  { kind: PillKind; label: string }
> = {
  running: { kind: "agent", label: "running" },
  idle: { kind: "neutral", label: "idle" },
  done: { kind: "done", label: "finished" },
  error: { kind: "blocked", label: "continuity error" },
};

/**
 * The logs pill for a run: uses RUN_STATE, but a run interrupted by a human
 * shows a neutral "interrupted · by <actor>" footer/pill (ruling 11) — the
 * render state of an interrupted run is idle-shaped.
 */
export function runStatePill(run: RunView): { kind: PillKind; label: string } {
  if (run.lifecycle === "interrupted") {
    return {
      kind: "neutral",
      label: run.interruptedBy ? `interrupted · by ${run.interruptedBy.label.split(" ")[0]}` : "interrupted",
    };
  }
  if (run.lifecycle === "queued") return { kind: "neutral", label: "queued" };
  return RUN_STATE[run.state] ?? RUN_STATE.idle;
}

export function runLabel(run: RunView): string {
  return run.who.name + (run.who.role ? " · " + run.who.role : "");
}

export function roleShort(run: RunView): string {
  return run.op ? "operator" : run.role === "Primary specialist" ? "primary" : "reviewer";
}

export function fmtClock(s: number): string {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    x = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? h + ":" + p(m) + ":" + p(x) : p(m) + ":" + p(x);
}

export function fmtTok(n: number): string {
  return n >= 100000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

/**
 * Elapsed seconds since `startedAt` (UTC ISO), recomputed every second on the
 * client clock (runs.md §7 replacement for `elapsed + tick`). Returns 0 when
 * no start time. Never trusts a shipped seconds count.
 */
export function useElapsed(startedAt: string | null, active: boolean): number {
  // SSR and the client's first hydration render must agree exactly. Reading
  // Date.now() in the state initializer lets the clock cross a second between
  // those two renders and produces a hydration mismatch. Start from a stable
  // sentinel, then activate the client clock after hydration.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt || now === null) return 0;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}
