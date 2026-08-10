import { useEffect, useState } from "react";
import type { PillKind } from "~/ui/pill";
import {
  isRunBoundary,
  isRunInputsLine,
  type LogLine,
  type RunInputs,
  type RunView,
} from "./runtime-types";

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
 * P19-G11: put each run's `run·inputs` disclosure at the HEAD of its own block.
 *
 * The line is written the instant `startRun` returns, before the provider has
 * emitted anything — chronologically it IS first. But it is appended by a
 * different writer than the sink, so its sequence number is only first if the
 * provider's stream has not already produced a line by then (true for a real
 * subprocess, not guaranteed for an instant one). Restoring it to the head of
 * its block makes the console's answer to "what was this run given?" the same
 * every time, instead of depending on a start-up race.
 *
 * Blocks are the run boundaries the console already renders (UI-53 concatenates
 * every run of one agent group into one stream), so a resumed group keeps each
 * run's inputs with the run it belongs to. Nothing is dropped or merged: this
 * only ever moves a line earlier within the block it is already in.
 */
export function hoistRunInputs<T extends { display: LogLine }>(
  rows: readonly T[],
): T[] {
  if (!rows.some((r) => isRunInputsLine(r.display))) return [...rows];
  const out: T[] = [];
  let blockStart = 0;
  for (const row of rows) {
    if (isRunBoundary(row.display)) {
      out.push(row);
      blockStart = out.length;
      continue;
    }
    if (isRunInputsLine(row.display)) {
      out.splice(blockStart, 0, row);
      continue;
    }
    out.push(row);
  }
  return out;
}

/** One expanded row of the run-input disclosure: a console tag + its text. */
export interface RunInputRow {
  tag: string;
  text: string;
  /** Verbatim canonical text — rendered with its own line breaks intact. */
  pre?: boolean;
}

const NONE_GRANTED = "none granted";

/**
 * P19-G11: `RunInputs` → the console rows shown when the disclosure is
 * expanded. Pure, so what a human reads about a run's inputs is unit-testable
 * against the record rather than only reachable by rendering a panel.
 *
 * Every row is stated even when EMPTY ("none granted", "no canonical task
 * state"), because the whole point is to make an absence visible: a knowledge
 * base that quietly reached no run is exactly the thing this surface exists to
 * catch, and a row that disappears when it has nothing to say cannot report one.
 */
export function runInputRows(inputs: RunInputs): RunInputRow[] {
  const rows: RunInputRow[] = [];

  rows.push({
    tag: "workspace",
    text:
      (inputs.cwd ?? "no working directory") +
      (inputs.repo
        ? inputs.cloned
          ? ` — checkout of ${inputs.repo}`
          : ` — ${inputs.repo} was NOT checked out; the agent ran against an empty workspace`
        : " — no repository attached to this project"),
  });

  rows.push({
    tag: "anchor",
    text:
      inputs.anchor ??
      "No canonical task state was sent to this run — it saw the goal and its directive only.",
    ...(inputs.anchor ? { pre: true } : {}),
  });

  rows.push({
    tag: "persona",
    text: inputs.personaChars
      ? `${inputs.personaChars} chars of agent definition, attached skills and knowledge bases (the persona itself is on the Agents page)`
      : "no persona was sent — this run had no resolvable agent definition",
  });

  rows.push({
    tag: "skills",
    text: inputs.skills.granted.length
      ? [
          `granted: ${inputs.skills.granted.join(", ")}`,
          inputs.skills.native.length
            ? `mounted into the workspace: ${inputs.skills.native.join(", ")}`
            : "mounted into the workspace: none",
          inputs.skills.injected.length
            ? `carried as prompt text instead: ${inputs.skills.injected.join(", ")}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : NONE_GRANTED,
  });

  rows.push({
    tag: "knowledge",
    text: inputs.knowledge.length ? inputs.knowledge.join(", ") : NONE_GRANTED,
  });

  rows.push({
    tag: "mcp",
    text: [
      inputs.mcp.mounted.length
        ? `mounted: ${inputs.mcp.mounted.join(", ")}`
        : "mounted: none",
      inputs.mcp.unresolved.length
        ? `granted but NOT mounted (no such server): ${inputs.mcp.unresolved.join(", ")}`
        : null,
      inputs.mcp.unhealthy.length
        ? `mounted but its last connection check failed: ${inputs.mcp.unhealthy.join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  if (inputs.unresolvedResources.length) {
    rows.push({
      tag: "missing",
      text:
        "granted, but their content never reached this run — " +
        inputs.unresolvedResources.map((r) => `${r.name} (${r.reason})`).join("; "),
    });
  }

  rows.push({
    tag: "tools",
    text: [
      inputs.tools.toolkit.length
        ? `viberr tools: ${inputs.tools.toolkit.join(", ")}`
        : "viberr tools: none",
      inputs.tools.denied.length
        ? `denied by its capability grants: ${inputs.tools.denied.join(", ")}`
        : "no built-in tools denied",
    ].join(" · "),
  });

  rows.push({
    tag: "directive",
    text: inputs.directive
      ? `${inputs.directive.chars} chars` +
        (inputs.directive.from ? ` from ${inputs.directive.from}` : " (no named author)")
      : "none — this turn worked from the goal and the canonical task state",
  });

  rows.push({
    tag: "prompt",
    text: `${inputs.promptChars} chars sent as this turn's prompt`,
  });

  return rows;
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
