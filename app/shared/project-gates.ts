import {
  activeWorkRevision,
  type GateResult,
  type GateRun,
  type WorkRevision,
} from "~/schemas/task-file.schema";
import type { ProjectGate } from "~/schemas/project-file.schema";
import { slugify } from "~/shared/ids/slugify";

/**
 * Ruling 482 (pass 40, F40-52): what the project's gates say about the
 * revision under review, in ONE place.
 *
 * The acceptance gate (`acceptanceRefusalReasons`), the projection's
 * `acceptanceBlockReason`, the PR card, the accept dialog, the operator's
 * snapshot and every agent's canonical anchor all read the same view, so the
 * sentence a person accepts on is the sentence the refusal prints. Pure: the
 * runner (`project-gates.server.ts`) writes the record, this only reads it.
 */

/** Where the gate run stands on the revision under review. */
export type GatesState =
  /** Gates are declared and nothing has run on this revision. */
  | "not_run"
  /** A run finished on this revision under a different gate list. */
  | "stale"
  | "queued"
  | "running"
  /** Every declared gate exited 0. */
  | "passed"
  /** At least one declared gate exited non-zero, timed out or never ran. */
  | "failed"
  /** The run could not execute (no checkout, revision missing, launch refused). */
  | "error";

export interface GatesView {
  /** The full sha of the revision under review, the one the gates bind to. */
  sha: string;
  state: GatesState;
  /** Declared gates whose recorded result exited 0. */
  passed: number;
  /** Declared gates. */
  total: number;
  /** "Gates on a95c337: 4/4 exit 0 (run by Viberr)" — the one line every
   *  surface prints. */
  line: string;
  /** The results as recorded, in run order (empty before a run). */
  results: GateResult[];
  /** The same results in words, for a surface that renders them without
   *  importing this module (the PR card, the accept dialog). */
  rows: GateRowView[];
  /** Why the run could not execute (`error`), else null. */
  error: string | null;
  finishedAt: string | null;
}

/** One gate's result as a surface prints it. */
export interface GateRowView {
  name: string;
  command: string;
  /** "exit 0", "exit 1", "timed out", "did not start". */
  outcome: string;
  /** "12 s", "1 min 04 s". */
  wall: string;
  ok: boolean;
  /** The log's attachment name, or null. */
  log: string | null;
}

/** The revision a gate run binds to: the active delivered (or external) one.
 *  A `verified` revision is the default branch as it stands, a no-change
 *  completion with no delivered checkout: gates never run on it. */
export function gateSubject(fm: {
  workRevision: WorkRevision | null;
}): WorkRevision | null {
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev || rev.kind === "verified") return null;
  return rev;
}

const short = (sha: string): string => sha.slice(0, 7);

/** The declared list as the run compares it: name and command, in order. */
function gateListKey(gates: readonly { name: string; command: string }[]): string {
  return JSON.stringify(gates.map((g) => [g.name, g.command]));
}

/** Did this run execute exactly the declared list? */
export function gateRunMatchesDeclared(
  run: Pick<GateRun, "results" | "status">,
  declared: readonly ProjectGate[],
): boolean {
  // A run records each result as it finishes, so only a finished run can be
  // compared whole; a queued or running one is judged by its own record.
  if (run.status !== "finished") return true;
  return gateListKey(run.results) === gateListKey(declared);
}

/** `gate-a95c337-02-build-20260925T101500Z.log`: the sha, the gate's place in
 *  the list, its name, and when it started. */
const GATE_LOG_RE = /^gate-[0-9a-f]{7}-\d{2}-[a-z0-9-]*-\d{8}T\d{6}Z\.log$/;

/** The attachment name one gate's log is saved under. */
export function gateLogName(sha: string, index: number, name: string, startedAt: string): string {
  const slug = slugify(name).slice(0, 30).replace(/-+$/, "");
  const stamp = startedAt.replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `gate-${sha.slice(0, 7).toLowerCase()}-${String(index).padStart(2, "0")}-${slug}-${stamp}.log`;
}

/** True for a gate log Viberr saved: it is the gates' evidence, never a file
 *  a run that happened to be in flight produced. */
export function isGateLogName(name: string): boolean {
  return GATE_LOG_RE.test(name);
}

/** "12 s", "1 min 04 s", "850 ms". */
export function gateWallTime(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
}

/** One result in words: "exit 0", "exit 1", "timed out", "did not start". */
export function gateOutcomeText(result: Pick<GateResult, "exitCode" | "timedOut">): string {
  if (result.timedOut) return "timed out";
  if (result.exitCode === null) return "did not start";
  return `exit ${result.exitCode}`;
}

/** Ruling 482(d): the system actor that writes a gate run's note. */
export const GATES_SYSTEM_ID = "project-gates";

/** The title a gate run's note carries, one per ending. The timeline reads
 *  the ending back from it (`gateNoteView`), so writer and reader share it. */
export const GATE_NOTE_TITLE = {
  passed: "Project gates passed",
  failed: "Project gates failed",
  error: "Project gates could not run",
} as const;

/** How a gate run ended, as its note records it. */
export type GateNoteState = keyof typeof GATE_NOTE_TITLE;

/** One gate's evidence row on its run's note:
 *  "build: exit 0 in 4 s · gate-a95c337-03-build-20260925T101500Z.log". */
export function gateEvidenceLabel(
  result: Pick<GateResult, "name" | "exitCode" | "timedOut" | "wallMs" | "log">,
): string {
  return (
    `${result.name}: ${gateOutcomeText(result)} in ${gateWallTime(result.wallMs)}` +
    (result.log ? ` · ${result.log}` : "")
  );
}

/** `gateEvidenceLabel`'s shape: the name, the outcome, the time, the log. */
const GATE_EVIDENCE_RE =
  /^(.+): (exit \d+|timed out|did not start) in (\d+ ms|\d+ s|\d+ min \d{2} s)(?: · (\S+))?$/;
/** The note's line names the revision: "Gates on a95c337: …". */
const GATE_NOTE_SHA_RE = /\bGates on ([0-9a-f]{7})\b/;
/** The note's text opens with that line in bold. */
const GATE_NOTE_LEAD_RE = /^\*\*Gates on [^*]*\*\*\s*/;

/** One gate as its run's note recorded it: the note never carried the
 *  command. */
export type GateNoteRow = Omit<GateRowView, "command">;

/** A gate run's timeline note, read back into what it recorded. */
export interface GateNoteView {
  state: GateNoteState;
  /** The revision's short sha, when the note names it. */
  sha: string | null;
  rows: GateNoteRow[];
  /** Why a run could not execute, in the note's own words less the line the
   *  view already prints; null for a run that finished. */
  detail: string | null;
}

/**
 * Ruling 493: a gate run's note read back into its ending, its revision and a
 * row per gate, so the timeline draws the run as the gate table instead of a
 * sentence, a monospaced block and the same logs again as files. The note's
 * words stay the record (agents and task.md read them); this reads only the
 * rows its writer printed with `gateEvidenceLabel` under a `GATE_NOTE_TITLE`.
 * Any other title, or a row in another shape, is null, and the note renders as
 * the note it is.
 */
export function gateNoteView(note: {
  title: string | null;
  text: string;
  evidence: readonly { label: string }[] | null;
  attachments: readonly string[] | null;
}): GateNoteView | null {
  const state: GateNoteState | null =
    note.title === GATE_NOTE_TITLE.passed
      ? "passed"
      : note.title === GATE_NOTE_TITLE.failed
        ? "failed"
        : note.title === GATE_NOTE_TITLE.error
          ? "error"
          : null;
  if (!state) return null;
  const claimed = new Set(note.attachments ?? []);
  const rows: GateNoteRow[] = [];
  for (const { label } of note.evidence ?? []) {
    const match = GATE_EVIDENCE_RE.exec(label);
    if (!match) return null;
    const [, name = "", outcome = "", wall = "", log] = match;
    rows.push({ name, outcome, wall, ok: outcome === "exit 0", log: log && claimed.has(log) ? log : null });
  }
  // A finished run prints a row per gate; a note with none is not its note.
  if (state !== "error" && rows.length === 0) return null;
  return {
    state,
    sha: GATE_NOTE_SHA_RE.exec(note.text)?.[1] ?? null,
    rows,
    detail: state === "error" ? note.text.replace(GATE_NOTE_LEAD_RE, "").trim() || null : null,
  };
}

/**
 * The view of the project's gates on this task's revision under review, or
 * null when there is nothing to show: no gates declared, or no delivered
 * revision for them to run on.
 */
export function projectGatesView(
  declared: readonly ProjectGate[] | undefined,
  fm: { workRevision: WorkRevision | null; gateRun?: GateRun | undefined },
): GatesView | null {
  const view = gatesViewOf(declared, fm);
  if (!view) return null;
  return {
    ...view,
    rows: view.results.map((r) => ({
      name: r.name,
      command: r.command,
      outcome: gateOutcomeText(r),
      wall: gateWallTime(r.wallMs),
      ok: r.exitCode === 0,
      log: r.log,
    })),
  };
}

function gatesViewOf(
  declared: readonly ProjectGate[] | undefined,
  fm: { workRevision: WorkRevision | null; gateRun?: GateRun | undefined },
): Omit<GatesView, "rows"> | null {
  const gates = declared ?? [];
  if (gates.length === 0) return null;
  const subject = gateSubject(fm);
  if (!subject) return null;
  const run = fm.gateRun;
  const sha = subject.headSha;
  const total = gates.length;
  const onSubject = run && run.revisionId === subject.id && run.headSha === sha ? run : null;
  const base = { sha, total, finishedAt: onSubject?.finishedAt ?? null };
  if (!onSubject) {
    return {
      ...base,
      state: "not_run",
      passed: 0,
      line: `Gates on ${short(sha)}: not run yet`,
      results: [],
      error: null,
    };
  }
  const results = onSubject.results;
  const passedNames = new Set(results.filter((r) => r.exitCode === 0).map((r) => r.name));
  const passed = gates.filter((g) => passedNames.has(g.name)).length;
  const counted = `${passed}/${total} exit 0 (run by Viberr)`;
  if (onSubject.status === "queued" || onSubject.status === "running") {
    const done = results.length;
    return {
      ...base,
      state: onSubject.status,
      passed,
      line:
        onSubject.status === "queued"
          ? `Gates on ${short(sha)}: queued (run by Viberr)`
          : `Gates on ${short(sha)}: running, ${done} of ${total} done (run by Viberr)`,
      results,
      error: null,
    };
  }
  if (onSubject.status === "error") {
    return {
      ...base,
      state: "error",
      passed,
      line: `Gates on ${short(sha)}: could not run (run by Viberr)`,
      results,
      error: onSubject.error ?? "the run could not execute",
    };
  }
  if (!gateRunMatchesDeclared(onSubject, gates)) {
    return {
      ...base,
      state: "stale",
      passed,
      line: `Gates on ${short(sha)}: ${passed}/${total} exit 0 (run by Viberr) under an earlier gate list`,
      results,
      error: null,
    };
  }
  return {
    ...base,
    state: passed === total ? "passed" : "failed",
    passed,
    line: `Gates on ${short(sha)}: ${counted}`,
    results,
    error: null,
  };
}

/** The failed results of a view, in run order. */
export function failedGateResults(view: GatesView): GateResult[] {
  return view.results.filter((r) => r.exitCode !== 0);
}

/**
 * The acceptance refusal the gates impose, or null. Ruling 482: a failing
 * gate BLOCKS a plain acceptance, and so does evidence that is missing, stale
 * or still being made — the person who merges is shown a fact about the sha,
 * never the absence of one. Force accept bypasses it like every other process
 * gate, and its record names it.
 */
export function projectGatesRefusal(
  declared: readonly ProjectGate[] | undefined,
  fm: { workRevision: WorkRevision | null; gateRun?: GateRun | undefined },
  taskKey: string,
): string | null {
  const view = projectGatesView(declared, fm);
  if (!view) return null;
  const at = `\`${short(view.sha)}\``;
  const again =
    "Viberr runs them again on the next delivery, or a maintainer or the task owner can run them from the task's GitHub card.";
  switch (view.state) {
    case "passed":
      return null;
    case "not_run":
      return `The project's gates have not run on ${taskKey}'s revision ${at}. ${again}`;
    case "stale":
      return `The project's gates changed after they ran on ${taskKey}'s revision ${at}. ${again}`;
    case "queued":
    case "running":
      return `The project's gates are still running on ${taskKey}'s revision ${at} (${view.results.length} of ${view.total} done). Accept once they finish.`;
    case "error":
      return `The project's gates could not run on ${taskKey}'s revision ${at}: ${view.error}. ${again}`;
    case "failed": {
      const failed = failedGateResults(view)
        .map((r) => `\`${r.name}\` ${gateOutcomeText(r)}`)
        .join(", ");
      return (
        `The project's gates failed on ${taskKey}'s revision ${at}: ${view.passed}/${view.total} exit 0` +
        (failed ? ` (${failed})` : "") +
        `. Rework the branch; the next delivered revision is gated again. An admin can force-accept, and the bypass is recorded.`
      );
    }
  }
}
