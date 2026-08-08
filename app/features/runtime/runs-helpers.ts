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
  // Kind is data on the run row — never string-match the role label (run rows
  // now carry the engagement's live role snapshot, not a kind literal).
  //
  // UXV19-3: the kind LITERALS are internal machinery and stay
  // (`kind: delivers ? "primary" : "reviewer"`, specialist-run.server.ts) — the
  // returned string is rendered copy and speaks the one shipped engagement
  // vocabulary. "primary" gave the delivering agent a THIRD name on the very
  // page whose Execution profile already heads it "Delivering agent"; and
  // "reviewer" is written for EVERY non-delivering run, so it claimed verdict
  // authority for supporting engagements that hold none. Same mapping the
  // Agents roster applies under F10-20.
  return run.op ? "operator" : run.kind === "primary" ? "delivering" : "supporting";
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
 *
 * SSR-stable (F10-37): `now` seeds to `null`, so the server render and the first
 * client (hydration) render both compute elapsed from a stable placeholder —
 * identical markup, no hydration mismatch. Wall-clock ticking begins only after
 * mount, when the effect installs the real client `Date.now()`. Never call
 * `Date.now()` during render.
 */
export function useElapsed(startedAt: string | null, active: boolean): number {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!startedAt) return 0;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return 0;
  // Before hydration `now` is null → elapsed 0 on both SSR and first client
  // render; the post-mount effect supplies the real clock.
  if (now === null) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}
