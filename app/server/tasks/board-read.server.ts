import type { DatabaseSync } from "node:sqlite";
import {
  reviewSubjectId,
  VERDICT_REPORT_TITLE,
  type FileActorRef,
  type ReviewVerdict,
  type TaskFileEvent,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  attachmentImageHeader,
  isBrowserWorkingArtifact,
  listTaskAttachments,
  readTaskAttachment,
} from "~/server/files/task-attachments.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { currentCompletionPacket } from "./completion-packet.server";
import type { TaskMutationContext } from "./task-actions.server";

/**
 * Ruling 281 (pass 37, F37-114) and ruling 282 (F37-115): the board read an
 * agent and an operator share.
 *
 * Neither could see a task other than the one it was working. An agent's whole
 * Viberr toolkit was `post_comment`, `ask_human` and `report_outcome`; the
 * operator's `get_task` takes no arguments at all and answers its OWN task.
 * So a task key either was TOLD about — in a document, a directive, another
 * agent's report — could not be checked, and the operator, which is the only
 * actor that authors a `create_task` option and the only one that writes
 * `blockedBy`, planned across a board it could not read.
 *
 * ONE implementation, because the two readers must not answer the same
 * question differently: "is SHOP-39 real" has one true answer.
 */

/** How much of ANOTHER task's goal a single-task read hands back. Enough to
 *  answer "is this the work I was told about", not enough to make a second
 *  task's whole contract compete with the reader's own prompt. */
const BOARD_READ_GOAL_CHARS = 2_000;

/** Ruling 579: where the decisions written into a goal begin. `resolvePacket`
 *  appends each after a rule; ruling 571 made its dash a colon, and a goal
 *  written before that keeps the dash. */
const GOAL_DECISIONS_RE = /\n---\n\n\*\*Decision(?: —|:) \d{4}-\d{2}-\d{2}, /;

/** Ruling 569: how much of a task's completion summary, and of each verdict's
 *  report, a single-task read hands back. The outcome is what a task that
 *  waited on this one needs, so it is read far past the goal's cap. */
const BOARD_READ_OUTCOME_CHARS = 8_000;

export interface BoardReadContext {
  db: DatabaseSync;
  ctx: TaskMutationContext;
  projectSlug: string;
}

/**
 * The goal, or its opening with a line SAYING it is an opening.
 *
 * The cap is deliberate (see {@link BOARD_READ_GOAL_CHARS}) and the silence was
 * not: this returned a bare `.slice`, so a 6,000-character contract came back
 * ending mid-word and read as the whole of it. That is the shape this pass
 * spent the day closing everywhere else — a knowledge base (ruling 283), an
 * agent report (ruling 285), a goal draft (ruling 288) — and it was in the
 * reader those rulings' own author wrote the same day.
 *
 * There is no "read the rest" tool to name here on purpose: this is the SHALLOW
 * read of the tasks beside your own, and a second task's whole contract
 * competing with your own prompt is what the cap prevents. So the marker says
 * where the full text is instead — the task page, which a person can open and
 * an agent can be pointed at.
 */
function goalExcerpt(goal: string | null): string | null {
  if (goal === null) return null;
  if (goal.length <= BOARD_READ_GOAL_CHARS) return goal;
  // Ruling 579: the cap is for the goal's own text. The decisions people wrote
  // into it (ruling 189) bind the task and are appended at its end, the part
  // the cap used to cut, so they ride whole after the excerpt.
  const at = goal.search(GOAL_DECISIONS_RE);
  const text = at === -1 ? goal : goal.slice(0, at);
  const decisions = at === -1 ? "" : goal.slice(at);
  if (text.length <= BOARD_READ_GOAL_CHARS) return goal;
  const size = goal.length.toLocaleString("en-US");
  const cap = BOARD_READ_GOAL_CHARS.toLocaleString("en-US");
  return (
    `${text.slice(0, BOARD_READ_GOAL_CHARS)}\n\n` +
    (decisions
      ? `[excerpt: this goal is ${size} characters. Above are the first ${cap} of its own text, and ` +
        `every decision recorded on it follows, whole. Do not treat what is above as the whole ` +
        `contract; the task's own page has all of it.]\n` +
        decisions
      : `[excerpt: this goal is ${size} characters and this is its first ${cap}. Do not treat ` +
        `what is above as the whole contract; the task's own page has all of it.]`)
  );
}

/** Ruling 569: one side of an outcome, or its opening with a line saying so. */
function outcomeExcerpt(text: string, what: string): string {
  if (text.length <= BOARD_READ_OUTCOME_CHARS) return text;
  return (
    `${text.slice(0, BOARD_READ_OUTCOME_CHARS)}\n\n` +
    `[excerpt: this ${what} is ${text.length.toLocaleString("en-US")} characters and this is ` +
    `its first ${BOARD_READ_OUTCOME_CHARS.toLocaleString("en-US")}. The task's own page has all of it.]`
  );
}

/** Whitespace-insensitive, for matching a stored reason to the report it
 *  was cut from (the report went through the reply's newline repair). */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Ruling 569, amended: the verdict's whole report. A verdict stores the first
 * 2,000 characters of its justification and a line saying the whole report is
 * on the task's timeline (ruling 292), which a reader on another task cannot
 * open; live on AWSC-8 the researcher read AWSC-7's verdict to character 2,000
 * of 5,382 and asked Arda to paste the rest. The report is the agent's "Review
 * verdict" comment (ruling 317), the newest at or before the verdict's stamp,
 * and it must open with what the verdict stored, so an earlier round's report
 * never stands in for this one. Without it the stored text is all there is.
 */
function verdictReport(timeline: readonly TaskFileEvent[], v: ReviewVerdict): string {
  const opening = flat(v.reason).slice(0, 120);
  const report = timeline.find(
    (e) =>
      e.type === "comment" &&
      e.title === VERDICT_REPORT_TITLE &&
      e.actor.kind === "agent" &&
      e.actor.profileId === v.profileId &&
      e.occurredAt <= v.at &&
      flat(e.text).startsWith(opening),
  );
  return report?.text ?? v.reason;
}

/**
 * Ruling 569: what a task came to, for a reader on another task. Its completion
 * summary when one describes what it delivered, and the verdicts on that
 * delivery with their reports; null while it has neither.
 *
 * A task that waits on others (`blockedBy`) is released when they finish, and
 * its work is usually to use what they found. Its readers could learn only
 * THAT they finished: this read stopped at the goal, and `take_from_task`
 * carries files. Live on AWSC-8, the research task that turns four benchmark
 * scores into workflow changes, three of the four scores had been relayed by
 * their operators and the fourth had not: the Estimate Judge's 90/100 for
 * sample-04 lived only in AWSC-7's verdict, and the AWSC-8 operator told its
 * researcher "neither you nor I can read that" and to ask Arda to paste it.
 * Verdicts bound to an earlier delivery are left out: they judged work the task
 * no longer stands on.
 */
interface TaskOutcome {
  completion: string | null;
  verdicts: { agent: string; result: string; report: string }[];
}

function taskOutcome(fm: TaskFrontmatter, timeline: readonly TaskFileEvent[]): TaskOutcome | null {
  const subject = reviewSubjectId(fm);
  const packet = currentCompletionPacket(fm);
  const verdicts = subject ? fm.verdicts.filter((v) => v.revisionId === subject) : [];
  if (!packet && verdicts.length === 0) return null;
  return {
    completion: packet ? outcomeExcerpt(packet.summary, "summary") : null,
    verdicts: verdicts.map((v) => ({
      agent: v.profileId,
      result: v.result,
      report: outcomeExcerpt(verdictReport(timeline, v), "report"),
    })),
  };
}

/**
 * One task as JSON, or the sentence for a key this project does not have.
 * Archived tasks are INCLUDED: "SHOP-8 was archived" is a real answer to "does
 * SHOP-8 exist", and a reader told about a retired key must be able to learn
 * that rather than read it as never having existed.
 */
export function readBoardTask(
  deps: BoardReadContext,
  taskKey: string,
): string {
  const row = boardRows(deps).find((t) => t.key === taskKey);
  if (!row) {
    return (
      `[noop] No task ${taskKey} in this project. If a document, a directive or a ` +
      `report named it, that claim is wrong; say so rather than acting on it.`
    );
  }
  const file = readTaskFile({
    projectSlug: deps.projectSlug,
    taskKey: row.key,
    dataRoot: deps.ctx.dataRoot,
  });
  const read: BoardTaskRead = {
    key: row.key,
    title: row.title,
    stage: row.stage,
    readiness: row.readiness,
    waiting: row.waiting,
    archived: row.archived,
    waitsOn: row.blockedBy.map((e) => `${e.label} (${e.state})`),
    goal: goalExcerpt(file?.parsed.goal ?? null),
  };
  const outcome = file ? taskOutcome(file.parsed.frontmatter, file.parsed.timeline) : null;
  if (outcome) read.outcome = outcome;
  // Ruling 594: what `read_task_attachment` can open on this task.
  const files = taskFileNames(deps, row.key);
  if (files.length > 0) read.files = files;
  // Ruling 596: what `read_timeline_entry` can open on this task.
  const timeline = file ? timelineIndex(file.parsed.timeline) : [];
  if (timeline.length > 0) read.timeline = timeline;
  return JSON.stringify(read, null, 1);
}

/** Ruling 596: how many entries the index lists, newest first. The longest
 *  task on the AWS calculator board ran to 184 entries and a round-4 one to
 *  84; the cap keeps a board-wide research read bounded. */
const BOARD_READ_TIMELINE_ENTRIES = 200;

/** Who wrote an entry, as one word the index can print. */
function timelineAuthor(actor: FileActorRef): string {
  switch (actor.kind) {
    case "agent":
      return `agent:${actor.profileId}`;
    case "human":
      return actor.nameHint ?? "human";
    case "system":
      return `system:${actor.systemId}`;
    default:
      return actor.kind;
  }
}

/**
 * Ruling 596: a task's timeline as an index, one line per entry: its stamp,
 * type, author and title. `read_timeline_entry` opens an entry by that stamp,
 * and an agent had no other way to learn it: its prompt carries only the
 * recent entries, and this read carried none. Live in round 4, two Estimate
 * Judges re-reviewing a rework (AWSC-36, AWSC-43) wrote that their own first
 * verdict, which holds the score of record, was out of their reach, and a
 * third (AWSC-38) wrote the rework's score in its place.
 */
function timelineIndex(timeline: readonly TaskFileEvent[]): string[] {
  const lines = timeline
    .slice(0, BOARD_READ_TIMELINE_ENTRIES)
    .map(
      (e) =>
        `${e.occurredAt} · ${e.type} · ${timelineAuthor(e.actor)}${e.title ? ` · ${e.title}` : ""}`,
    );
  const older = timeline.length - lines.length;
  if (older > 0) lines.push(`[${older.toLocaleString("en-US")} older entries not listed]`);
  return lines;
}

/** One task as `read_board` answers it. */
interface BoardTaskRead {
  key: string;
  title: string;
  stage: BoardRow["stage"];
  readiness: BoardRow["readiness"];
  waiting: BoardRow["waiting"];
  archived: boolean;
  waitsOn: string[];
  goal: string | null;
  /** Ruling 569: absent until the task has one. */
  outcome?: TaskOutcome;
  /** Ruling 594: the task's files, without the browser's working files;
   *  absent when it has none. */
  files?: string[];
  /** Ruling 596: the timeline's index, newest first; absent when it is empty. */
  timeline?: string[];
}

/** Ruling 594: a task's attachment names, less the browser's working files. */
function taskFileNames(deps: BoardReadContext, taskKey: string): string[] {
  return listTaskAttachments(deps.projectSlug, taskKey, deps.ctx.dataRoot)
    .map((a) => a.name)
    .filter((name) => !isBrowserWorkingArtifact(name));
}

/** Ruling 594: what an agent's attachment reader answers: text, or a line and
 *  the picture. */
export type AgentAttachmentRead =
  | { text: string }
  | { header: string; image: { data: string; mimeType: string } };

/**
 * Ruling 594: one attachment of a task in this project, for an agent. The
 * operator's `read_task_attachment` reads its own task's files, and a Claude
 * specialist read nothing but its prompt; live on AWSC-33 the Estimate Judge
 * was told to read two registers on AWSC-24 and AWSC-31 "where they are",
 * which its workspace contract puts off-limits, and asked a person for
 * access. The same reader as the operator's, over any task of the project.
 */
export function readAgentTaskAttachment(
  deps: BoardReadContext,
  taskKey: string,
  name: string,
  offset = 0,
): AgentAttachmentRead {
  const key = taskKey.trim();
  if (!boardRows(deps).some((t) => t.key === key)) {
    return { text: `[noop] No task ${key} in this project; \`read_board\` lists the project's tasks.` };
  }
  const read = readTaskAttachment(deps.projectSlug, key, name, deps.ctx.dataRoot, offset);
  if (!read) {
    const have = taskFileNames(deps, key);
    return {
      text:
        `[noop] ${key} has no attachment \`${name.trim()}\`. ` +
        (have.length ? `It holds: ${have.join(", ")}.` : "It has no attachments."),
    };
  }
  if ("unreadable" in read) return { text: `[noop] ${read.unreadable}` };
  if (read.kind === "image") {
    return { header: attachmentImageHeader(key, read), image: { data: read.data, mimeType: read.mimeType } };
  }
  const { kind: _text, ...body } = read;
  return { text: JSON.stringify(body, null, 1) };
}

type BoardRow = ReturnType<typeof boardRows>[number];

/** Every task in the project, as JSON. */
export function readBoardList(deps: BoardReadContext): string {
  return JSON.stringify(
    boardRows(deps).map((t) => ({
      key: t.key,
      title: t.title,
      stage: t.stage,
      readiness: t.readiness,
      waiting: t.waiting,
      archived: t.archived,
      waitsOn: t.blockedBy.map((e) => `${e.label} (${e.state})`),
    })),
    null,
    1,
  );
}

function boardRows(deps: BoardReadContext) {
  const listOpts: NonNullable<Parameters<typeof listProjectTasks>[2]> = {
    includeArchived: true,
  };
  if (deps.ctx.dataRoot !== undefined) listOpts.dataRoot = deps.ctx.dataRoot;
  return listProjectTasks(deps.db, deps.projectSlug, listOpts);
}

/**
 * Ruling 285 (pass 37, F37-120): the coordinator can read a report it was
 * handed half of.
 *
 * An agent's report reaches the operator's prompt clipped at 4,000 characters,
 * and `get_task`'s `recentTimeline` clips every entry at 1,500 — so a thorough
 * reviewer's report was readable in neither place, and no tool in the operator's
 * toolkit returned one whole. Live on SHOP-42 the operator said so itself, in
 * the packet it raised to a human: "The reviewer's report reached me truncated
 * at '### Item 3 —', so I have not read its cross-service audit conclusion; the
 * full text is on the timeline." It was right about all of it, including that
 * the text was somewhere it could not go. What it could not read named two
 * unowned defects the reviewer had gone looking for — `services/orders` red on
 * `main`, and a stale `.env.example` — and neither would have reached a person
 * if that reviewer had not also written them into its summary.
 *
 * The clip itself stays: a prompt carrying every 20,000-character report in
 * full is the problem the clip exists to prevent. What changes is that there is
 * now somewhere to go, exactly as ruling 283 did for a knowledge base — index
 * in the prompt, document on demand.
 */
const TIMELINE_ENTRY_READ_CHARS = 40_000;

/** One timeline entry, whole, addressed by the `occurredAt` stamp `get_task`
 *  prints or `read_board` lists (ruling 596). */
export function readTimelineEntry(
  deps: BoardReadContext,
  taskKey: string,
  occurredAt: string,
): string {
  const file = readTaskFile({
    projectSlug: deps.projectSlug,
    taskKey,
    dataRoot: deps.ctx.dataRoot,
  });
  if (!file) {
    return `[noop] No task ${taskKey} in this project.`;
  }
  const wanted = occurredAt.trim();
  const entry = file.parsed.timeline.find((e) => e.occurredAt === wanted);
  if (!entry) {
    // Ruling 246's shape: say what this reader IS and how to address it, rather
    // than implying the entry was deleted. The likeliest caller error is a
    // stamp retyped by hand or trimmed of its milliseconds.
    const recent = file.parsed.timeline
      .slice(0, 8)
      .map((e) => `${e.occurredAt} · ${e.type} · ${e.actor.kind}`);
    return (
      `[noop] ${taskKey} has no timeline entry stamped \`${wanted}\`. The stamp must ` +
      `match exactly, to the millisecond, as \`read_board\` lists it in the task's ` +
      `\`timeline\` (or \`get_task\` prints it). The eight most recent:\n${recent.join("\n")}`
    );
  }
  const text = entry.text;
  const clipped = text.length > TIMELINE_ENTRY_READ_CHARS;
  return JSON.stringify(
    {
      occurredAt: entry.occurredAt,
      type: entry.type,
      actor: entry.actor.kind === "human" ? (entry.actor.nameHint ?? "human") : entry.actor.kind,
      title: entry.title,
      // Reported, never hidden: a clipped entry that reads as complete is how a
      // model states a half-read report as fact — the very failure this tool
      // exists to end.
      truncated: clipped,
      text: clipped ? text.slice(0, TIMELINE_ENTRY_READ_CHARS) : text,
    },
    null,
    1,
  );
}
