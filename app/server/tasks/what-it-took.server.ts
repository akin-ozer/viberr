import type { DatabaseSync } from "node:sqlite";
import type { ParsedTaskFile, TaskFileEvent } from "~/schemas/task-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import {
  listRunsForTaskRows,
  reviewSubjectAtDispatch,
  type TookRunRow,
} from "~/server/runtimes/run-store.server";
import { formatCost, formatDuration } from "~/shared/text/figures";
import { countLabel } from "~/shared/text/plural";
import {
  DECISION_LEAD,
  QUESTION_LEAD,
  RECOMMENDATION_DECLINED_TITLE,
  stageMoveLead,
} from "~/shared/timeline-leads";
import { VERDICT_NOTE_TITLE } from "~/shared/verdict-note";
import { resolveStageRoles } from "~/shared/workflow/stage-roles";
import { isRelayComment } from "./task-relay.server";

/**
 * Ruling 693: what a task took.
 *
 * The agent runs that started and their time, their cost where a backend
 * reported one, how many rounds a person was asked, how many times the work
 * was sent back, and the wall time from filing to the first delivery and to
 * acceptance, with the share agents ran and the share it waited on a person.
 * The completion and Result card prints it (`facts`, `notes`), and the
 * operator's and the controller's read of the task carry the whole figure.
 *
 * Nothing is stored. The figure is derived when it is read, from two records:
 * the task's `agent_runs` rows, and the task file (its frontmatter, its open
 * packet and its timeline). Audit rows are not read: they expire at 90 days.
 * Every timeline entry it reads is typed or written by a person, and
 * compaction folds only routine machine comments, so that half is durable.
 * The run rows live in the projection database alone, so a rebuilt or
 * restored database loses them, and the figure says so (`recordKept`).
 *
 * It says in words what it cannot know (`notes`) and never estimates: a cost
 * no run reported is null, never zero. No clock is read, so the figure does
 * not move with the time of day.
 *
 * The rework counts the file already keeps (`verdicts[].rounds`, the
 * snapshot's `consecutiveRequestChanges`) are one reviewer's current streak:
 * last write wins per reviewer and subject, and an approval ends the streak.
 * A total needs every objection, so it is read from the `quality` notes: the
 * ones titled "Changes requested" and nothing after it, which is how
 * `recordAgentCompletion` titles an objection that bound to a delivery and
 * fought a round.
 */

/** One span of wall time, measured from the task's filing. */
export interface TookSpan {
  /** When the span ends: the first delivery, or the acceptance. */
  at: string;
  minutes: number;
  /** The part of it some agent's ended run covered. */
  agentMinutes: number;
  /** The part of it that passed, with no agent running, before a person next
   *  acted. The stretch a run cut by a restart or still going may have been
   *  running is in neither part. */
  waitedOnPersonMinutes: number;
}

/** The runs that started, and what is not in their time. */
export interface TookRuns {
  /** Runs the store stamped as started. A run refused before its agent was
   *  launched (no credential, a launch that could not be prepared) is one:
   *  the store records it as a run that started and ended in error, and the
   *  run console lists it. */
  total: number;
  operator: number;
  agentMinutes: number;
  /** Started runs whose time is not in `agentMinutes`: still going, or cut
   *  by a restart (boot recovery stamps those with the boot instant). */
  unmeasured: TookUnmeasured;
  /** Runs waiting behind the run cap: about to start, and in no other count. */
  queued: number;
  /** Runs that ended without starting: dropped while they were queued. */
  neverStarted: number;
  /** False when agents that ran on this task wrote on its timeline and no run
   *  row is left. An entry relayed from another task is no run of this one. */
  recordKept: boolean;
}

export interface TookUnmeasured {
  live: number;
  cutByRestart: number;
}

/** Dollars, where a run reported them. */
export interface TookCost {
  /** Null when no run reported a cost: unknown, never zero. */
  usd: number | null;
  /** Ended runs that reported none, by backend. */
  unreported: TookUnreported;
}

export interface TookUnreported {
  claude: number;
  codex: number;
}

export interface TookAsked {
  /** Decisions put to a person: each one answered, plus the one open now.
   *  An open decision that offers acceptance is not one until it is answered
   *  another way, so answering never lowers the count. */
  rounds: number;
  /** Of the questions, the ones an agent raised itself. */
  byAgents: number;
  /** A decision that counts as a round is waiting for its answer. */
  open: boolean;
}

export interface TookSentBack {
  /** Reviewers' requests for changes that bound to a delivery and fought a
   *  round. One that bound to nothing, or repeated an objection to work
   *  nobody had reworked, sent nothing back. */
  byReviewers: number;
  /** A person's moves of the task back to an earlier stage. */
  byPeople: number;
}

export interface TookWall {
  filedAt: string | null;
  /** Null when nothing was delivered, or the task had nothing to deliver. */
  firstDelivery: TookSpan | null;
  /** Null until the task is accepted. */
  acceptance: TookSpan | null;
}

export interface WhatItTook {
  runs: TookRuns;
  cost: TookCost;
  asked: TookAsked;
  sentBack: TookSentBack;
  wall: TookWall;
  /** The card's line, one phrase each. A zero is left out. */
  facts: string[];
  /** What the figure misses on this task. */
  notes: string[];
}

/** What the card prints of the figure: the part the task page is sent. */
export type TookCard = Pick<WhatItTook, "facts" | "notes">;

/** The task loader's key for it, present only on a payload that carries one. */
export interface TookShipped {
  whatItTook?: TookCard;
}

/** One agent's share of the runs. */
export interface TookByAgent {
  agent: string;
  profileId: string;
  role: "operator" | "delivering" | "supporting";
  runs: number;
  agentMinutes: number;
  costUsd: number | null;
}

/** Who spent it: the first `BY_AGENT_MAX` by agent time, and how many more. */
export interface TookAgents {
  byAgent: TookByAgent[];
  moreAgents: number;
}

/** The whole figure, as the operator's and the controller's task reads carry it. */
export type TaskTook = WhatItTook & TookAgents;

/** The run part alone: one agent's share, or a task's line on a board listing. */
interface TookRunTotals {
  runs: number;
  agentMinutes: number;
  costUsd: number | null;
}

export interface WhatItTookInput {
  taskKey: string;
  rows: readonly TookRunRow[];
  file: Pick<ParsedTaskFile, "frontmatter" | "timeline" | "packet">;
  /** The project's stages in board order, as they are named now. */
  stages: readonly TookStage[];
  terminalStageId: string | null;
}

export interface TookStage {
  id: string;
  name: string;
}

/** Where a task lives, for {@link whatItTookFor}. */
export interface TookTaskRef {
  projectSlug: string;
  taskKey: string;
  dataRoot?: string;
}

const BY_AGENT_MAX = 8;
const MINUTE_MS = 60_000;
const FILES_SUBJECT = "files:";

/** A stamp as milliseconds, or null for one that does not parse. */
function stampMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Minutes to one decimal. */
function minutesOf(ms: number): number {
  return Math.round((ms / MINUTE_MS) * 10) / 10;
}

/** A person's own entry: theirs, or the controller's writing for them. */
function byPerson(entry: TaskFileEvent): boolean {
  return entry.actor.kind === "human" || entry.actor.kind === "controller";
}

type Interval = readonly [number, number];

/** A started run that has not ended. */
function isLive(row: TookRunRow): boolean {
  return row.state === "running" || row.state === "queued";
}

/** A run boot recovery ended: its `finished_at` is the boot instant, so the
 *  time between the two stamps is the outage, not the work. */
function cutByRestart(row: TookRunRow): boolean {
  return row.interrupted_reason === "restart";
}

/** The run's own interval, or null when its time is not measured: it never
 *  started, is still going, was cut by a restart, or a stamp does not parse. */
function measuredInterval(row: TookRunRow): Interval | null {
  if (isLive(row) || cutByRestart(row)) return null;
  const start = stampMs(row.started_at);
  const end = stampMs(row.finished_at);
  if (start === null || end === null) return null;
  return [start, Math.max(start, end)];
}

interface RunMeasure {
  started: number;
  operator: number;
  agentMs: number;
  live: number;
  cutByRestart: number;
  queued: number;
  neverStarted: number;
  costUsd: number | null;
  unreported: TookUnreported;
}

/**
 * The one count of a set of run rows. A controller turn is not task work
 * (its row carries no project, so no task read returns one) and is skipped.
 */
function measureRuns(rows: readonly TookRunRow[]): RunMeasure {
  const out: RunMeasure = {
    started: 0,
    operator: 0,
    agentMs: 0,
    live: 0,
    cutByRestart: 0,
    queued: 0,
    neverStarted: 0,
    costUsd: null,
    unreported: { claude: 0, codex: 0 },
  };
  for (const row of rows) {
    if (row.kind === "controller") continue;
    if (!row.started_at) {
      // Parked behind the run cap, or dropped from there before it started.
      if (row.state === "queued") out.queued += 1;
      else out.neverStarted += 1;
      continue;
    }
    out.started += 1;
    if (row.kind === "operator") out.operator += 1;
    if (row.total_cost_usd !== null) out.costUsd = (out.costUsd ?? 0) + row.total_cost_usd;
    if (isLive(row)) {
      out.live += 1;
      continue;
    }
    if (row.total_cost_usd === null) out.unreported[row.backend] += 1;
    if (cutByRestart(row)) out.cutByRestart += 1;
    const interval = measuredInterval(row);
    if (interval) out.agentMs += interval[1] - interval[0];
  }
  return out;
}

/** Runs that started, their agent minutes and the dollars they reported. */
function runTotals(rows: readonly TookRunRow[]): TookRunTotals {
  const measure = measureRuns(rows);
  return {
    runs: measure.started,
    agentMinutes: minutesOf(measure.agentMs),
    costUsd: measure.costUsd,
  };
}

const ROLE_OF_KIND = {
  operator: "operator",
  primary: "delivering",
  reviewer: "supporting",
} as const;

/** The same totals per agent and the part it played, most agent time first. */
function tookByAgent(rows: readonly TookRunRow[]): TookAgents {
  const groups = new Map<string, { name: string | null; role: TookByAgent["role"]; rows: TookRunRow[] }>();
  for (const row of rows) {
    if (row.kind === "controller") continue;
    const role = ROLE_OF_KIND[row.kind];
    const key = `${row.agent_profile_id}\n${role}`;
    const group = groups.get(key) ?? { name: null, role, rows: [] };
    // Rows arrive oldest first, so the newest name an agent ran under wins.
    if (row.agent_name) group.name = row.agent_name;
    group.rows.push(row);
    groups.set(key, group);
  }
  const all: TookByAgent[] = [];
  for (const group of groups.values()) {
    const totals = runTotals(group.rows);
    if (totals.runs === 0) continue;
    const profileId = group.rows[0]!.agent_profile_id;
    all.push({
      agent: group.name ?? profileId,
      profileId,
      role: group.role,
      runs: totals.runs,
      agentMinutes: totals.agentMinutes,
      costUsd: totals.costUsd,
    });
  }
  all.sort(
    (a, b) => b.agentMinutes - a.agentMinutes || b.runs - a.runs || a.agent.localeCompare(b.agent),
  );
  return { byAgent: all.slice(0, BY_AGENT_MAX), moreAgents: Math.max(0, all.length - BY_AGENT_MAX) };
}

/** Intervals as one sorted set with no overlap, so two agents running at
 *  once count the wall time once. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const merged: [number, number][] = [];
  for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** When some measured run was running. */
function busyIntervals(rows: readonly TookRunRow[]): Interval[] {
  return mergeIntervals(
    rows.flatMap((row) => {
      if (row.kind === "controller") return [];
      const interval = measuredInterval(row);
      return interval ? [interval] : [];
    }),
  );
}

/**
 * When a started run whose time is not measured may have been running: one
 * still going from its start on, one cut by a restart from its start to the
 * boot that ended it. Nobody was waited on in that stretch and how long the
 * agent worked in it is not known, so a span counts it as neither.
 */
function unmeasuredIntervals(rows: readonly TookRunRow[]): Interval[] {
  return rows.flatMap((row): Interval[] => {
    if (row.kind === "controller") return [];
    const start = stampMs(row.started_at);
    if (start === null) return [];
    if (isLive(row)) return [[start, Number.POSITIVE_INFINITY]];
    if (!cutByRestart(row)) return [];
    const end = stampMs(row.finished_at);
    return end === null ? [] : [[start, Math.max(start, end)]];
  });
}

/** How much of `[from, to]` the intervals cover. */
function coveredMs(intervals: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const [start, end] of intervals) {
    total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  }
  return total;
}

interface FirstDelivery {
  at: string;
  /** Timed by a run dispatched on the delivery, not by the delivery itself. */
  byReview: boolean;
}

/**
 * When the task first delivered: the earliest of everything that names a
 * delivery. The file keeps only the newest revision's time, so for a revision
 * that was reworked the earliest trace left is the first run dispatched on
 * the one before it, which is later than that delivery by however long the
 * run waited to start.
 */
function firstDeliveryOf(input: WhatItTookInput): FirstDelivery | null {
  const fm = input.file.frontmatter;
  if (fm.noChanges) return null;
  const found: (FirstDelivery & { ms: number })[] = [];
  const add = (at: string | null | undefined, byReview: boolean) => {
    const ms = stampMs(at);
    if (at && ms !== null) found.push({ at, ms, byReview });
  };
  add(fm.deliveredAt, false);
  const revision = fm.workRevision;
  // A verification or an outside push is a subject to review, not a delivery.
  const delivered =
    !!revision &&
    (revision.kind === undefined || revision.kind === "delivered" || revision.kind === "discarded");
  if (revision && delivered) add(revision.createdAt, false);
  for (const verdict of fm.verdicts) {
    if (verdict.revisionId.startsWith(FILES_SUBJECT)) {
      add(verdict.revisionId.slice(FILES_SUBJECT.length), false);
    }
  }
  for (const row of input.rows) {
    const subject = reviewSubjectAtDispatch(row);
    if (!subject) continue;
    if (subject.startsWith(FILES_SUBJECT)) add(subject.slice(FILES_SUBJECT.length), false);
    else if (delivered || subject !== revision?.id) add(row.created_at, true);
  }
  // An exact stamp wins a tie with the run that was dispatched on it.
  found.sort((a, b) => a.ms - b.ms || Number(a.byReview) - Number(b.byReview));
  const first = found[0];
  return first ? { at: first.at, byReview: first.byReview } : null;
}

/** When the task was accepted: its newest completion record, once it stands
 *  at the board's last stage. Every door to that stage writes one. */
function acceptedAtOf(input: WhatItTookInput): string | null {
  if (input.terminalStageId === null) return null;
  if (input.file.frontmatter.stage !== input.terminalStageId) return null;
  let newest: { at: string; ms: number } | null = null;
  for (const entry of input.file.timeline) {
    if (entry.type !== "completion") continue;
    const ms = stampMs(entry.occurredAt);
    if (ms !== null && (!newest || ms > newest.ms)) newest = { at: entry.occurredAt, ms };
  }
  return newest?.at ?? null;
}

/**
 * The span from filing to `at`. Waiting on a person is a proxy the record can
 * answer: for each entry a person wrote inside the span, the time since the
 * entry before it (whoever wrote that), less the time an agent was running in
 * between (`occupied`: the measured runs and the unmeasured ones alike). A
 * wait still open is not counted until the person acts.
 */
function spanTo(
  at: string,
  filedMs: number,
  busy: readonly Interval[],
  occupied: readonly Interval[],
  entries: readonly { ms: number; byPerson: boolean }[],
): TookSpan | null {
  const atMs = stampMs(at);
  if (atMs === null) return null;
  const endMs = Math.max(filedMs, atMs);
  let waitedMs = 0;
  let previousMs = filedMs;
  for (const entry of entries) {
    if (entry.ms > endMs) break;
    const from = Math.max(previousMs, filedMs);
    if (entry.byPerson && entry.ms > from) {
      waitedMs += entry.ms - from - coveredMs(occupied, from, entry.ms);
    }
    previousMs = entry.ms;
  }
  return {
    at,
    minutes: minutesOf(endMs - filedMs),
    agentMinutes: minutesOf(coveredMs(busy, filedMs, endMs)),
    waitedOnPersonMinutes: minutesOf(waitedMs),
  };
}

function minutesText(minutes: number): string {
  return formatDuration(minutes * MINUTE_MS);
}

/** The card's line. A zero says nothing, so it is left out. */
function factsOf(took: Omit<WhatItTook, "facts" | "notes">, agentMs: number): string[] {
  const facts: string[] = [];
  const { runs, cost, asked, sentBack, wall } = took;
  if (runs.total > 0) {
    const ran = countLabel(runs.total, "run");
    facts.push(agentMs > 0 ? `${ran}, ${formatDuration(agentMs)} of agent time` : ran);
    const unreported = cost.unreported.claude + cost.unreported.codex;
    if (cost.usd !== null) {
      facts.push(
        unreported > 0
          ? `${formatCost(cost.usd)}, ${countLabel(unreported, "run")} reported no cost`
          : formatCost(cost.usd),
      );
    } else if (unreported > 0) {
      facts.push("cost not reported");
    }
  }
  if (asked.rounds > 0) {
    const waiting = !asked.open ? "" : asked.rounds === 1 ? ", not answered yet" : ", 1 not answered yet";
    facts.push(`asked a person ${countLabel(asked.rounds, "time")}${waiting}`);
  }
  const sent = sentBack.byReviewers + sentBack.byPeople;
  if (sent > 0) {
    const by =
      sentBack.byPeople === 0
        ? "by reviewers"
        : sentBack.byReviewers === 0
          ? "by a person"
          : `(${sentBack.byReviewers} by reviewers, ${sentBack.byPeople} by a person)`;
    facts.push(`sent back ${countLabel(sent, "time")} ${by}`);
  }
  if (wall.firstDelivery) {
    facts.push(`first delivery ${minutesText(wall.firstDelivery.minutes)} after filing`);
  }
  if (wall.acceptance) {
    const waited = wall.acceptance.waitedOnPersonMinutes;
    facts.push(
      `accepted ${minutesText(wall.acceptance.minutes)} after filing` +
        (waited > 0 ? `, ${minutesText(waited)} of it waiting on a person` : ""),
    );
  }
  return facts;
}

/** What the figure misses on this task, one fixed sentence per cause. */
function notesOf(
  took: Omit<WhatItTook, "facts" | "notes">,
  firstDeliveryByReview: boolean,
): string[] {
  const notes: string[] = [];
  const { runs, cost } = took;
  if (!runs.recordKept) {
    notes.push("No run record is kept for this task, so its runs, agent time and cost are not known.");
  }
  const cut = runs.unmeasured.cutByRestart;
  if (cut > 0) {
    notes.push(
      cut === 1
        ? "1 run was cut by a restart; its time is not counted."
        : `${cut} runs were cut by a restart; their time is not counted.`,
    );
  }
  const live = runs.unmeasured.live;
  if (live > 0) {
    notes.push(
      live === 1
        ? "1 run is still going; its time and cost are not counted yet."
        : `${live} runs are still going; their time and cost are not counted yet.`,
    );
  }
  const codex = cost.unreported.codex;
  if (codex > 0) {
    notes.push(
      codex === 1
        ? "Codex reports no cost, so 1 Codex run is not in the dollar figure."
        : `Codex reports no cost, so ${codex} Codex runs are not in the dollar figure.`,
    );
  }
  // A Claude run reports its cost with its result, so one refused before
  // its agent launched, stopped or failed has none. The sentence says what
  // the row shows and no more: the run ended, and no cost came with it.
  const claude = cost.unreported.claude;
  if (claude > 0) {
    notes.push(
      claude === 1
        ? "1 Claude run ended without reporting a cost, so it is not in the dollar figure."
        : `${claude} Claude runs ended without reporting a cost, so they are not in the dollar figure.`,
    );
  }
  if (firstDeliveryByReview) {
    notes.push("The first delivery is timed by the first review dispatched on it.");
  }
  return notes;
}

/** What a task took, from its run rows and its own record. Pure. */
export function whatItTook(input: WhatItTookInput): WhatItTook {
  const { rows, file, stages, taskKey } = input;
  const measure = measureRuns(rows);

  // A person's move back is the stage-move sentence naming a later stage and
  // then an earlier one, by the board's order today: a move recorded under a
  // name since changed is not found.
  const movesBack: string[] = [];
  for (const [i, from] of stages.entries()) {
    for (const to of stages.slice(0, i)) {
      movesBack.push(stageMoveLead(taskKey, from.name, to.name, false));
    }
  }

  let answered = 0;
  let agentQuestions = 0;
  let byReviewers = 0;
  let byPeople = 0;
  let agentWrote = false;
  for (const entry of file.timeline) {
    const person = byPerson(entry);
    // An agent's entry is the trace a run of this task leaves, except the
    // comment another task's agent relayed here (ruling 488): that agent ran
    // there, and this task may not have been run at all.
    if (entry.actor.kind === "agent" && !isRelayComment(entry)) agentWrote = true;
    // One packet leaves one decision entry, whoever raised it and however
    // many options it carried. A declined recommendation speaks the same
    // lead and is no round: nobody was asked a question. Nor is a comment
    // that happens to open with the words: a comment is free prose, and no
    // answer to a packet is written as one.
    if (
      person &&
      entry.type !== "comment" &&
      entry.text.startsWith(DECISION_LEAD) &&
      entry.title !== RECOMMENDATION_DECLINED_TITLE
    ) {
      answered += 1;
    }
    if (entry.type === "blocked" && entry.actor.kind === "agent" && entry.text.startsWith(QUESTION_LEAD)) {
      agentQuestions += 1;
    }
    // The bare title alone: an objection that bound to nothing, or repeated
    // one on work nobody had reworked, carries a longer one and sent nothing
    // back.
    if (entry.type === "quality" && entry.title === VERDICT_NOTE_TITLE.changesRequested) {
      byReviewers += 1;
    }
    if (
      person &&
      entry.type === "transition" &&
      movesBack.some((lead) => entry.text.startsWith(lead))
    ) {
      byPeople += 1;
    }
  }
  // A packet decided and kept open for its goal edit has its entry already.
  // One that offers acceptance is no round while it waits: accepting it
  // leaves no decision entry (that answer is the acceptance), and any other
  // answer leaves one, so the count never falls when the person answers.
  const open =
    file.packet !== null &&
    !file.packet.awaiting &&
    !file.packet.options.some((option) => option.kind === "accept_completion");

  const filedAt = file.frontmatter.createdAt;
  const filedMs = stampMs(filedAt);
  const delivery = firstDeliveryOf(input);
  const acceptedAt = acceptedAtOf(input);
  let firstDelivery: TookSpan | null = null;
  let acceptance: TookSpan | null = null;
  if (filedMs !== null && (delivery || acceptedAt)) {
    const busy = busyIntervals(rows);
    const occupied = mergeIntervals([...busy, ...unmeasuredIntervals(rows)]);
    const entries = file.timeline
      .flatMap((entry) => {
        const ms = stampMs(entry.occurredAt);
        return ms === null ? [] : [{ ms, byPerson: byPerson(entry) }];
      })
      .sort((a, b) => a.ms - b.ms);
    if (delivery) firstDelivery = spanTo(delivery.at, filedMs, busy, occupied, entries);
    if (acceptedAt) acceptance = spanTo(acceptedAt, filedMs, busy, occupied, entries);
  }

  const took: Omit<WhatItTook, "facts" | "notes"> = {
    runs: {
      total: measure.started,
      operator: measure.operator,
      agentMinutes: minutesOf(measure.agentMs),
      unmeasured: { live: measure.live, cutByRestart: measure.cutByRestart },
      queued: measure.queued,
      neverStarted: measure.neverStarted,
      recordKept: measure.started + measure.queued + measure.neverStarted > 0 || !agentWrote,
    },
    cost: { usd: measure.costUsd, unreported: measure.unreported },
    asked: { rounds: answered + (open ? 1 : 0), byAgents: agentQuestions, open },
    sentBack: { byReviewers, byPeople },
    wall: { filedAt, firstDelivery, acceptance },
  };
  return {
    ...took,
    facts: factsOf(took, measure.agentMs),
    notes: notesOf(took, firstDelivery !== null && delivery?.byReview === true),
  };
}

/**
 * The run part of the figure on one line, as a board listing carries it for a
 * task (the controller's `list_tasks`): the runs that started, their agent
 * minutes and the dollars they reported. Null for a task no run started on,
 * so a listing spends nothing on it. A board is listed whole in one reply,
 * and that reply has a size a turn can carry (ruling 677): three numbers as
 * an object cost a row five lines there, a line costs it one.
 */
export function runTotalsLine(rows: readonly TookRunRow[]): string | null {
  const { runs, agentMinutes, costUsd } = runTotals(rows);
  if (runs === 0) return null;
  const cost = costUsd === null ? "cost not reported" : formatCost(costUsd);
  return `${countLabel(runs, "run")}, ${agentMinutes} min, ${cost}`;
}

/** The figure with who spent it: what a task read hands an operator or the
 *  controller. */
export function taskTook(input: WhatItTookInput): TaskTook {
  return { ...whatItTook(input), ...tookByAgent(input.rows) };
}

/**
 * The whole figure for one task, read from the store: what the controller's
 * `get_task` carries. Null when the task or its project is gone.
 */
export function whatItTookFor(db: DatabaseSync, ref: TookTaskRef): TaskTook | null {
  const file = readTaskFile(ref);
  const project = readProjectFile({ projectSlug: ref.projectSlug, dataRoot: ref.dataRoot });
  if (!file || !project) return null;
  const { stages, workflow } = project.parsed.frontmatter;
  return taskTook({
    taskKey: ref.taskKey,
    rows: listRunsForTaskRows(db, ref.projectSlug, ref.taskKey),
    file: file.parsed,
    stages,
    terminalStageId: resolveStageRoles(stages, workflow).terminalId,
  });
}
