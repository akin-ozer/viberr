import { z } from "zod";
import type { PillKind } from "~/ui/pill";
import { useClock } from "~/ui/use-clock";
import { toolIdentity, type ToolIdentity } from "~/shared/mcp-tools";
// Ruling 457: count plurals are spelled inline here, not through `countLabel`
// (why: shared/text/plural.ts).
import {
  ARGUMENT_CLIP,
  waitClock,
  type JsonValue,
  type LogLine,
  type RunInputs,
  type RunView,
  type RunKind,
} from "./runtime-types";

/**
 * Client helpers ported from runs.jsx (the file-local functions): RUN_STATE,
 * runLabel, roleShort, fmtClock, fmtTok, useElapsed. Elapsed
 * derives from startedAt (client clock) — NO fabricated token growth (the
 * mock's `tick*42` is banned; tokens come from real usage on the RunView).
 */

/** How one run is painted in the logs strip: the pill's colour and its word. */
export interface RunStateBadge {
  kind: PillKind;
  label: string;
}

/** state → the badge for pills/states (runs.md §2). */
export const RUN_STATE = {
  running: { kind: "agent", label: "running" },
  idle: { kind: "neutral", label: "idle" },
  done: { kind: "done", label: "finished" },
  error: { kind: "blocked", label: "continuity error" },
} satisfies Record<RunView["state"], RunStateBadge>;

/**
 * The logs pill for a run: uses RUN_STATE, but a run interrupted by a human
 * shows a neutral "interrupted · by <actor>" footer/pill (ruling 11) — the
 * render state of an interrupted run is idle-shaped. Pass 35 U35-7: a run boot
 * recovery interrupted names its REASON ("by a restart") the same way; it is
 * not a continuity error and no person did it.
 */
export function runStatePill(run: RunView): RunStateBadge {
  if (run.lifecycle === "interrupted") {
    return { kind: "neutral", label: `interrupted${interruptedByClause(run)}` };
  }
  if (run.lifecycle === "queued") return { kind: "neutral", label: "queued" };
  // Ruling 130(a): the pill is a reader of the failure too. A classified
  // refusal names its class; "continuity error" is only an unclassified one.
  if (run.state === "error" && run.failureKind === "quota") {
    return { kind: "blocked", label: "refused · quota" };
  }
  if (run.state === "error" && run.failureKind === "auth") {
    return { kind: "blocked", label: "refused · account" };
  }
  if (run.state === "error" && run.failureKind === "unavailable") {
    return { kind: "blocked", label: "backend unavailable" };
  }
  if (run.state === "error" && run.failureKind === "max_budget") {
    // Ruling 175: the instance's spending cap stopped it, not the task.
    return { kind: "blocked", label: "cut off · spending cap" };
  }
  if (run.state === "error" && run.failureKind === "overloaded") {
    // U35-11: a connection that failed in this deployment's own environment
    // is named as such; the provider is blamed only when it answered.
    return run.failureOrigin === "local"
      ? { kind: "blocked", label: "provider unreachable" }
      : { kind: "blocked", label: "provider overloaded" };
  }
  return RUN_STATE[run.state] ?? RUN_STATE.idle;
}

/**
 * Who or what stopped an interrupted run, as the pill's " · by X" suffix: the
 * person's first name, "a restart" for boot recovery, nothing when the run
 * carries neither (a stored row from before either was recorded).
 */
function interruptedByClause(run: RunView): string {
  if (run.interruptedBy) return ` · by ${run.interruptedBy.label.split(" ")[0]}`;
  if (run.interruptedReason === "restart") return " · by a restart";
  return "";
}

export function runLabel(run: RunView): string {
  return run.who.name + (run.who.role ? " · " + run.who.role : "");
}

export function roleShort(run: RunView): string | null {
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
  //
  // Ruling 419(d): a controller turn has no engagement at all, so it has no
  // role to print. It fell through to "supporting" and the controller page's
  // console read "Controller · supporting", an engagement role on a surface
  // that has no task.
  if (run.kind === "controller") return null;
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
  // An honest count (the whole prompt of every call) crosses a million on a
  // long run; "4526k" is not a number a person reads.
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  return n >= 100000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
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
export function runInputRows(
  inputs: RunInputs,
  backend?: "claude" | "codex",
  /**
   * Ruling 346: WHICH kind of run this is, because two of these rows describe
   * an absence, and the same absence means different things.
   *
   * Ruling 344 gave the operator and the controller this disclosure, and both
   * legitimately record `cwd: null` and `anchor: null` — neither has a checkout
   * and neither is handed a canonical task block. The two stand-in sentences
   * here were written when every caller was a specialist, so they then said
   * "no repository attached to this project" about repo-backed projects and
   * "It saw the goal and its directive only" about a drive that reads the task
   * with `get_task`. Absent (an older stored line) keeps the specialist
   * reading, which is what those lines were.
   */
  kind?: RunKind,
): RunInputRow[] {
  const rows: RunInputRow[] = [];
  const coordinates = kind === "operator" || kind === "controller";

  rows.push({
    tag: "workspace",
    text: coordinates
      ? kind === "controller"
        ? "No workspace: a controller turn reads and writes through Viberr's own tools, never a checkout."
        : "No workspace of its own: the operator coordinates, and reads the deliverer's checkout without owning one."
      : (inputs.cwd ?? "no working directory") +
        (inputs.repo
          ? inputs.cloned
            ? ` · checkout of ${inputs.repo}`
            : ` · ${inputs.repo} was NOT checked out; the agent ran against an empty workspace`
          : " · no repository attached to this project"),
  });

  const anchor: RunInputRow = {
    tag: "anchor",
    text:
      inputs.anchor ??
      (kind === "operator"
        ? "No canonical block in the prompt: this drive reads the live task with `get_task`, and the turn prompt above is what it was told about the trigger."
        : kind === "controller"
          ? "No canonical task state: a controller turn is not bound to one task, and the context read it opens with is part of the prompt."
          : "No canonical task state was sent to this run. It saw the goal and its directive only."),
  };
  // Only the canonical text is verbatim; the stand-in sentence is prose and
  // must reflow like every other row.
  if (inputs.anchor) anchor.pre = true;
  rows.push(anchor);

  rows.push({
    tag: "persona",
    text: inputs.personaChars
      ? `${inputs.personaChars} chars of agent definition, attached skills and knowledge bases (the persona itself is on the Agents page)`
      : "no persona was sent: this run had no resolvable agent definition",
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
        ? `granted but NOT mounted: ${inputs.mcp.unresolved.join(", ")}`
        : null,
      inputs.mcp.unhealthy.length
        ? `mounted but its last connection check failed: ${inputs.mcp.unhealthy.join(", ")}`
        : null,
      // Ruling 176: the admin-marked write tools this run withheld.
      inputs.mcp.writeToolsDenied?.length
        ? "write tools withheld (repo write is withheld): " +
          inputs.mcp.writeToolsDenied
            .map((denial) => `${denial.server} (${denial.tools.join(", ")})`)
            .join("; ")
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  if (inputs.unresolvedResources.length) {
    rows.push({
      tag: "missing",
      text:
        "granted, but their content never reached this run: " +
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
        ? // F-P10 (pass 25): the deny list binds on Claude (SDK denylist);
          // codex-runtime never consults `disallowedTools` directly. Ruling 185
          // removed the Codex OS sandbox, so one family still binds there
          // through a derived flag: withheld web egress turns the CLI's own
          // web search off (`webSearchMode: "disabled"`). The repo-write tools
          // and the command-level entries (git push, gh pr ...) are advisory;
          // the server-owned delivery gate is the boundary. This console is
          // the per-run audit surface, so it says exactly that rather than a
          // flat "denied" or a flat "advisory".
          backend === "codex"
          ? `capability grants deny (on this Codex run only a withheld web search binds, through the CLI's search toggle; the repo-write and command-level entries are advisory, and the server-owned delivery gate is the boundary): ${inputs.tools.denied.join(", ")}`
          : `denied by its capability grants: ${inputs.tools.denied.join(", ")}`
        : "no built-in tools denied",
    ].join(" · "),
  });

  // Ruling 175: what the run may spend, stated even when nothing caps it, and
  // honest that the cap is Claude's alone.
  if (inputs.spendCapUsd !== undefined) {
    const cap = inputs.spendCapUsd;
    rows.push({
      tag: "spend",
      text:
        cap === null
          ? "no spending cap (Instance settings → Max spend per Claude run)"
          : backend === "codex"
            ? `the instance caps a Claude run at $${cap.toFixed(2)}, but Codex has no budget option: this run is bounded by its idle timer only`
            : `capped at $${cap.toFixed(2)}: the run stops when it has spent that much`,
    });
  }

  rows.push({
    tag: "directive",
    text: inputs.directive
      ? `${inputs.directive.chars} chars` +
        (inputs.directive.from ? ` from ${inputs.directive.from}` : " (no named author)")
      : "none (this turn worked from the goal and the canonical task state)",
  });

  rows.push({
    tag: "prompt",
    text: `${inputs.promptChars} chars sent as this turn's prompt`,
  });

  return rows;
}

/* ---------------------------------------------------------------- console
 *
 * P19-RC1 — the console renders one flat row per line, for every `ev` kind.
 * The projection already distinguishes reasoning (`think`), tool calls
 * (`tool`, with `name`/`input`), file changes (`changes`) and multi-line
 * output (`out`, `diff`) — and then paints all of them as the same grid row,
 * so a reader scanning for "what did it DO" wades through the model narrating
 * itself, and a 200-line command dump pushes the next real event off screen.
 *
 * These helpers fold that structure back out. They are pure, so what a reader
 * is shown about a run is unit-testable against the stored lines rather than
 * only reachable by rendering a panel — the same contract `runInputRows`
 * already holds. The folds themselves (telemetry runs, thought runs, a call's
 * heartbeats) are `createConsoleFolder`'s (console-fold.ts).
 *
 * ONE RULE ABOVE ALL: every one of them is a NO-OP under `raw`. The
 * `{ } raw` toggle's whole contract is "what the provider sent", so grouping,
 * chips and blocks must never reshape it.
 */

/** True when a line is the model narrating its own reasoning. */
export function isThoughtLine(line: LogLine): boolean {
  return line.ev === "think";
}

/**
 * The wait row's words, from the provider's LAST elapsed report and in the
 * tense the row's liveness sets. Live = the run is still going and nothing has
 * landed after the last heartbeat, so the call is open now. Ended = something
 * did land, so all the record supports is that the call was still running AT
 * that figure — "ran past 2m 30s", never a total the heartbeats cannot give.
 */
export function waitText(lines: readonly { display: LogLine }[], live: boolean): string {
  const elapsed = lines[lines.length - 1]!.display.progress?.elapsed ?? null;
  const at = elapsed === null ? null : waitClock(elapsed);
  if (live) return at === null ? "still running" : `still running · ${at}`;
  return at === null ? "was still running" : `ran past ${at}`;
}

/**
 * Ruling 366(d): what the fold stands for, said on the row itself — a reader
 * has to know the hidden events were keepalives and nothing more, or a fold
 * reads as a hole in the record. The disclosure under it lists every one.
 */
export const HEARTBEAT_NOTE =
  "A heartbeat is the runtime saying the call is still open: about one every 30 s, " +
  "carrying no output. Nothing here changed the run.";

/** One folded heartbeat, as its own disclosed row: which one, and the
 *  provider's figure at that moment. */
export function heartbeatLabel(line: LogLine, n: number): string {
  const elapsed = line.progress?.elapsed ?? null;
  return `heartbeat ${n}` + (elapsed === null ? "" : ` · ${waitClock(elapsed)} in`);
}

/** The live count's tooltip: where its figure comes from, honestly — it runs
 *  on from the provider's last report, and the next report resets it. */
export function waitCountTitle(lines: readonly { display: LogLine }[], clock: string): string {
  const elapsed = lines[lines.length - 1]!.display.progress?.elapsed ?? 0;
  return (
    `Counting on from the runtime's last heartbeat: ${waitClock(elapsed)} at ${clock}. ` +
    "A heartbeat lands about every 30 s and resets the count."
  );
}

/** A value flattened the way the arguments line prints it. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Ruling 366(d): what a tool row's one-line summary CUT — the arguments a
 * reader cannot see on the row — by key, with the label the link prints.
 *
 * Three cuts count: a string the arguments line clipped at `ARGUMENT_CLIP`
 * (`+ full prompt`), a collection the line shows by its size (`+ evidence (3
 * items)`), and a string a bespoke summary omitted altogether when it is
 * longer than a line or has one (an Edit's old and new text: `+ old_string,
 * new_string`). An omitted number, boolean, null, empty collection or short
 * string is trivia the raw view keeps — the first version offered a link on
 * every Bash row for its `timeout`, and the owner's verdict on that was "this
 * looks odd". Bash's `description` is not hidden either: `commandNote` prints
 * it beside the command. The label names what is behind the link, never the
 * bare word "arguments".
 */
export interface HiddenArguments {
  keys: string[];
  label: string;
}

/** An omitted string shorter than this, on one line, is trivia. */
const SUBSTANTIVE_CHARS = 40;

const stringValue = z.string();
const recordValue = z.record(z.string(), z.unknown());

export function hiddenArguments(
  line: LogLine,
  /** Ruling 499: arguments the row already draws in full (an edit's diff, a
   *  to-do list), which it therefore does not cut. */
  drawn: readonly string[] = [],
): HiddenArguments | null {
  if (line.ev !== "tool" || !line.input) return null;
  const text = flat(line.text);
  const hidden: { key: string; label: string }[] = [];
  for (const [key, value] of Object.entries(line.input)) {
    if (drawn.includes(key)) continue;
    const str = stringValue.safeParse(value);
    if (str.success) {
      const v = flat(str.data);
      if (!v || text.includes(v)) continue;
      if (line.name === "Bash" && key === "description") continue;
      if (v.length > ARGUMENT_CLIP && text.includes(v.slice(0, ARGUMENT_CLIP - 1))) {
        hidden.push({ key, label: `full ${key}` });
      } else if (v.length > SUBSTANTIVE_CHARS || str.data.includes("\n")) {
        hidden.push({ key, label: key });
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length) {
        hidden.push({ key, label: `${key} (${value.length} item${value.length === 1 ? "" : "s"})` });
      }
      continue;
    }
    const rec = recordValue.safeParse(value);
    if (rec.success) {
      const n = Object.keys(rec.data).length;
      if (n) hidden.push({ key, label: `${key} (${n} field${n === 1 ? "" : "s"})` });
    }
  }
  if (!hidden.length) return null;
  const label =
    hidden.length > 3
      ? `+ ${hidden.length} arguments`
      : `+ ${hidden.map((h) => h.label).join(", ")}`;
  return { keys: hidden.map((h) => h.key), label };
}

/**
 * Bash's `description` — Claude's own line on what the command is for —
 * printed beside the command the way a shell comment sits beside one, so it
 * never needs a click. Null for any other tool, and when there is none.
 */
export function commandNote(line: LogLine): string | null {
  if (line.ev !== "tool" || line.name !== "Bash" || !line.input) return null;
  const note = stringValue.safeParse(line.input.description);
  return note.success && note.data.trim() ? note.data.trim() : null;
}

/**
 * Ruling 499: the file a tool row names as its whole summary (Claude's Read,
 * Edit, Write, …), so the row can print it repo-relative. Null for any other
 * row, a Bash command's included: a path inside a command is the command's
 * own words, and rewriting it would change what the command says.
 */
export function filePathOf(line: LogLine): string | null {
  if (line.ev !== "tool" || !line.input) return null;
  const path = stringValue.safeParse(line.input.file_path);
  return path.success && path.data === line.text ? path.data : null;
}

/** One argument, in full: a string as itself, anything else as its JSON. */
export interface ArgumentRow {
  key: string;
  text: string;
}

/** The disclosed arguments, in the order the link named them. */
export function argumentRows(input: Record<string, JsonValue>, keys: readonly string[]): ArgumentRow[] {
  return keys.flatMap((key) => {
    if (!Object.hasOwn(input, key)) return [];
    const text = stringValue.safeParse(input[key]);
    return [{ key, text: text.success ? text.data : JSON.stringify(input[key], null, 2) }];
  });
}

/** `HH:MM:SS` → seconds, or null when the clock is not readable. */
function clockSeconds(t: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * The folded block's own copy — how long the agent reasoned and in how many
 * steps.
 *
 * The duration is MEASURED between the first and last line's stored clock, and
 * is simply omitted when that span is zero or unreadable. A thinking block that
 * invents "4s" because it looks better than "3 steps" is the fabricated-signal
 * failure this codebase keeps ruling against — and the reader can always open
 * the block and read the timestamps that produced it.
 */
export function thoughtLabel(lines: readonly { display: LogLine }[]): string {
  const steps = `${lines.length} step${lines.length === 1 ? "" : "s"}`;
  const first = clockSeconds(lines[0]!.display.t);
  const last = clockSeconds(lines[lines.length - 1]!.display.t);
  if (first === null || last === null) return `Thought · ${steps}`;
  // A block that crosses midnight would read negative; treat it as unmeasured
  // rather than printing a wrong number.
  const span = last - first;
  if (span <= 0) return `Thought · ${steps}`;
  return `Thought for ${span}s · ${steps}`;
}

/** A tool call reduced to what a scanning reader needs: the verb and its target. */
export interface ToolChip {
  /** Whose tool, and the label the chip prints for it (ruling 366). */
  who: ToolIdentity;
  /** What it was pointed at; empty when the line carried only a name. */
  detail: string;
}

/**
 * `tool` lines → a chip. Returns null for anything else, so the caller keeps
 * one branch and the row rendering stays the default.
 *
 * `name` is the projection's own field (Claude's tool name, codex's `exec`);
 * when a provider sent none there is nothing to promote and the line stays a
 * plain row rather than getting a chip labelled with a guess.
 */
export function toolChip(line: LogLine): ToolChip | null {
  if (line.ev !== "tool" || !line.name) return null;
  return { who: toolIdentity(line.name), detail: line.text };
}

/** One file a run touched, as the `file_change` envelope recorded it. */
export interface FileChangeChip {
  path: string;
  kind: "add" | "update" | "delete";
}

/**
 * `changes` → per-file chips.
 *
 * Deliberately NO line counts: the envelope records a path and a kind, and
 * nothing else. A "+74 −41" next to a file the record cannot support would be
 * invented, so the chip shows the kind the provider actually reported.
 */
export function fileChangeChips(line: LogLine): FileChangeChip[] | null {
  if (!line.changes || line.changes.length === 0) return null;
  return line.changes.map((c) => ({ path: c.path, kind: c.kind }));
}

/** Multi-line output lifted out of the row and into its own bounded block. */
export interface ConsoleCodeBlock {
  code: string;
  /** Diffs get per-line +/- colouring; other output is plain. */
  diff: boolean;
}

/**
 * Multi-line `out` / `diff` text → a code block.
 *
 * Single-line output stays inline: a one-line `✓ built in 1.2s` in a framed,
 * scrollable box is more furniture than information. Nothing is truncated —
 * the block is bounded by CSS and scrolls — because a console that quietly
 * drops the tail of a command's output is the failure mode the raw toggle
 * exists to make impossible.
 *
 * No language label. The projection carries no language, and guessing one from
 * a path would put a confident wrong word ("TypeScript") on a shell transcript.
 */
export function consoleCodeBlock(line: LogLine): ConsoleCodeBlock | null {
  if (line.ev !== "out" && line.ev !== "diff") return null;
  if (!line.text.includes("\n")) return null;
  return { code: line.text, diff: line.ev === "diff" };
}

/** Per-line class for a diff block — `+` adds, `-` removes, everything else plain. */
export function diffLineKind(line: string): "add" | "del" | null {
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return null;
}

/* The outcome envelope as the CONSOLE needs to read it — decoded once, at the
 * boundary where the provider's raw JSON arrives.
 *
 * Deliberately per-field tolerant: an agent that fills one field with junk must
 * not cost the reader the fields that are fine, so every field catches to
 * `null` instead of failing the whole record. `.min(1)` on the prose fields is
 * the old truthiness guard — a stored `""` is nothing to show, not a blank
 * line. `verdict`/`evidence` are read for PRESENCE only (they are the sibling
 * keys that mark a payload as an envelope at all), so they accept any JSON
 * value, which is exactly what a key check accepted before.
 */

/** Text worth rendering: trimmed, and not empty once trimmed. */
const prose = z.string().trim().min(1);

const outcomeQuestionSchema = z.object({
  title: prose.nullable().catch(null).optional(),
  body: prose.nullable().catch(null).optional(),
  options: z
    .array(
      z
        .object({ title: z.string() })
        .transform((option) => option.title.trim())
        .catch(""),
    )
    // A junk CHOICE drops out of the list; it never costs the reader the others.
    .transform((titles) => titles.filter(Boolean))
    .nullable()
    .catch(null)
    .optional(),
});

const outcomeEnvelopeSchema = z.object({
  summary: prose.nullable().catch(null).optional(),
  question: outcomeQuestionSchema.nullable().catch(null).optional(),
  verdict: z.json().optional(),
  evidence: z.json().optional(),
});

/**
 * N20-18 — a Codex run's FINAL message is the structured outcome envelope
 * (`AGENT_OUTCOME_JSON_SCHEMA`), so its `agent_message` line carries raw JSON —
 * `{"evidence":null,"summary":"…","verdict":null,"question":null}` — with the
 * one line a reader wants (`summary`) buried between null fields. Claude's
 * `assistant` event is plain prose for the same act, so the two backends read
 * differently in the console. This folds the envelope back to the prose it
 * wraps (P19-RC1 parity across backends): the `summary`, plus the `question` if
 * one was raised.
 *
 * Touches ONLY a Codex `agent_message` whose text parses as an envelope object;
 * a plain-prose `agent_message` (a developer with no structured channel) and
 * every other line return null and render unchanged. Like every P19-RC1
 * folding it must be a NO-OP under `raw` — the caller only invokes it when the
 * `{ } raw` toggle is off, so that view stays the verbatim JSON.
 */
export function agentMessageProse(line: LogLine): string | null {
  if (line.ev !== "text" || line.tag !== "agent_message") return null;
  const text = line.text.trim();
  // Cheap gate before JSON.parse: the envelope is always a brace object, and a
  // prose report almost never starts with `{`.
  if (!text.startsWith("{")) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = outcomeEnvelopeSchema.safeParse(json);
  // Only a JSON OBJECT can fail: every field carries its own `.catch`.
  if (!parsed.success) return null;
  const envelope = parsed.data;
  // Envelope shape: the schema declares exactly summary/verdict/question/
  // evidence. Require `summary` present AND a sibling envelope key, so an agent
  // that legitimately reports a bare JSON object of its own is left alone. JSON
  // carries no `undefined`, so an absent key is the only way a parsed field can
  // be one.
  const isEnvelope =
    envelope.summary !== undefined &&
    (envelope.verdict !== undefined ||
      envelope.question !== undefined ||
      envelope.evidence !== undefined);
  if (!isEnvelope) return null;

  const out: string[] = [];
  if (envelope.summary) out.push(envelope.summary);
  const question = envelope.question;
  if (question) {
    const parts: string[] = [];
    if (question.title) parts.push(question.title);
    if (question.body) parts.push(question.body);
    if (question.options?.length) {
      parts.push(`Options: ${question.options.join(" · ")}`);
    }
    if (parts.length) out.push(`Question: ${parts.join(" · ")}`);
  }
  // An envelope with nothing human-readable (every field null) is degenerate;
  // returning null lets the raw JSON stand rather than blanking the row.
  return out.length ? out.join("\n\n") : null;
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
 *
 * Ruling 457 (RF-9): the ticking is the shared one-second clock
 * (`~/ui/use-clock`), one interval for every counter on the page instead of
 * one per counter, and a counter mounted after hydration reads the client
 * clock on its first render.
 */
export function useElapsed(startedAt: string | null, active: boolean): number {
  const now = useClock(1000, active);
  if (!startedAt) return 0;
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return 0;
  // On the server and during hydration `now` is null → elapsed 0 on both; the
  // re-render right after hydration supplies the real clock.
  if (now === null) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}
