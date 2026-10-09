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
import { FIND_MAX_CHARS, FIND_MAX_WORDS, findWords, type TextHit } from "~/server/files/find-in-text.server";
import { keptDeliveryMiss, listKeptDeliveries, type KeptDelivery } from "~/server/files/kept-deliveries.server";
import {
  findInTaskSource,
  readTaskSource,
  readTaskSources,
  sourcesListing,
  type TaskSourcesRead,
} from "~/server/files/task-sources.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { pageEnd, READ_PAGE_BYTES } from "~/server/runtimes/read-page-budget.server";
import { completionPacketText, currentCompletionPacket } from "./completion-packet.server";
import { readCorrectionOfEntry, type CorrectionReading } from "./kb-correction-actions.server";
import { keptPictureLook, recordRunLooks } from "./page-looks.server";
import type { TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 213(a) (pass 37, F37-114) and ruling 117 (F37-115): the board read an
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

/** Ruling 213(a): where the decisions written into a goal begin. `resolvePacket`
 *  appends each after a rule; ruling 292 made its dash a colon, and a goal
 *  written before that keeps the dash. */
const GOAL_DECISIONS_RE = /\n---\n\n\*\*Decision(?: —|:) \d{4}-\d{2}-\d{2}, /;

/** Ruling 213(a): how much of a task's completion summary, and of each verdict's
 *  report, a single-task read hands back. The outcome is what a task that
 *  waited on this one needs, so it is read far past the goal's cap. */
const BOARD_READ_OUTCOME_CHARS = 8_000;

export interface BoardReadContext {
  db: DatabaseSync;
  ctx: TaskMutationContext;
  projectSlug: string;
  /** Ruling 211: the knowledge bases the reader is given, "all" for a
   *  person's controller; a correction to one of them reads whole. */
  readerKbs?: readonly string[] | "all";
  /** Ruling 329: the run that reads, when one does. A picture it is handed is
   *  written down as a look of that run's. */
  runId?: string | null;
}

/**
 * The goal, or its opening with a line SAYING it is an opening.
 *
 * The cap is deliberate (see {@link BOARD_READ_GOAL_CHARS}) and the silence was
 * not: this returned a bare `.slice`, so a 6,000-character contract came back
 * ending mid-word and read as the whole of it. That is the shape this pass
 * spent the day closing everywhere else — a knowledge base (ruling 205), an
 * agent report (ruling 117), a goal draft (ruling 131) — and it was in the
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
  // Ruling 213(a): the cap is for the goal's own text. The decisions people wrote
  // into it (ruling 64) bind the task and are appended at its end, the part
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

/** Ruling 213(a): one side of an outcome, or its opening with a line saying so. */
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
 * Ruling 213(a), amended: the verdict's whole report. A verdict stores the first
 * 2,000 characters of its justification and a line saying the whole report is
 * on the task's timeline (ruling 88), which a reader on another task cannot
 * open; live on AWSC-8 the researcher read AWSC-7's verdict to character 2,000
 * of 5,382 and asked Arda to paste the rest. The report is the agent's "Review
 * verdict" comment (ruling 88), the newest at or before the verdict's stamp,
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
 * Ruling 213(a): what a task came to, for a reader on another task. Its completion
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
    completion: packet ? outcomeExcerpt(completionPacketText(packet), "summary") : null,
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
  // Ruling 214: what `read_task_attachment` can open on this task.
  const files = taskFileNames(deps, row.key);
  if (files.length > 0) read.files = files;
  // Ruling 86: the files deliveries, as each was delivered.
  const deliveries = listKeptDeliveries(deps.projectSlug, row.key, deps.ctx.dataRoot);
  if (deliveries.length > 0) read.deliveries = deliveries;
  // Ruling 82: a count and the way in, not the list: this read has to reach
  // a Codex run whole, and a task may keep two hundred sources.
  const kept = readTaskSources(deps.projectSlug, row.key, deps.ctx.dataRoot).sources.length;
  if (kept > 0) {
    read.sources = `${kept} kept; \`read_task_source\` with this task's key lists them and what each delivery rested on`;
  }
  // Ruling 213: what `read_timeline_entry` can open on this task.
  const timeline = file ? timelineIndex(file.parsed.timeline) : [];
  if (timeline.length > 0) read.timeline = timeline;
  return JSON.stringify(read, null, 1);
}

/** Ruling 213: how many entries the index lists, newest first. The longest
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
 * Ruling 213: a task's timeline as an index, one line per entry: its stamp,
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
  /** Ruling 213(a): absent until the task has one. */
  outcome?: TaskOutcome;
  /** Ruling 214: the task's files, without the browser's working files;
   *  absent when it has none. */
  files?: string[];
  /** Ruling 86: the deliveries kept as delivered, newest first; absent when none. */
  deliveries?: KeptDelivery[];
  /** Ruling 82: how many sources the task keeps and the tool that lists
   *  them; absent when it keeps none. */
  sources?: string;
  /** Ruling 213: the timeline's index, newest first; absent when it is empty. */
  timeline?: string[];
}

/** Ruling 214: a task's attachment names, less the browser's working files. */
function taskFileNames(deps: BoardReadContext, taskKey: string): string[] {
  return listTaskAttachments(deps.projectSlug, taskKey, deps.ctx.dataRoot)
    .map((a) => a.name)
    .filter((name) => !isBrowserWorkingArtifact(name));
}

/** What a reader answers for a name the task does not hold: the names it
 *  does. One sentence for every tool that takes a file of the task by name
 *  (`read_task_attachment`, and `capture_page`, ruling 194). */
export function noSuchAttachment(deps: BoardReadContext, taskKey: string, name: string): string {
  const have = taskFileNames(deps, taskKey);
  return (
    `[noop] ${taskKey} has no attachment \`${name.trim()}\`. ` +
    (have.length ? `It holds: ${have.join(", ")}.` : "It has no attachments.")
  );
}

/** Ruling 214: what an agent's attachment reader answers: text, or a line and
 *  the picture. */
export type AgentAttachmentRead =
  | { text: string }
  | { header: string; image: { data: string; mimeType: string } };

/**
 * Ruling 214: one attachment of a task in this project, for an agent. The
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
  /** Ruling 198: a kept delivery's stamp. */
  delivery?: string,
): AgentAttachmentRead {
  const key = taskKey.trim();
  if (!boardRows(deps).some((t) => t.key === key)) {
    return { text: `[noop] No task ${key} in this project; \`read_board\` lists the project's tasks.` };
  }
  const read = readTaskAttachment(deps.projectSlug, key, name, deps.ctx.dataRoot, offset, delivery);
  if (!read && delivery) return { text: keptDeliveryMiss(deps.projectSlug, key, delivery, name, deps.ctx.dataRoot) };
  if (!read) return { text: noSuchAttachment(deps, key, name) };
  if ("unreadable" in read) return { text: `[noop] ${read.unreadable}` };
  if (read.kind === "image") {
    // Ruling 329: one of the pictures Viberr kept of the task's delivery, as
    // the folder holds it now, is a look at that page.
    if (deps.runId && !delivery) {
      const look = keptPictureLook(deps.ctx, deps.projectSlug, key, read.name);
      if (look) recordRunLooks(deps.db, deps.runId, [look]);
    }
    return { header: attachmentImageHeader(key, read), image: { data: read.data, mimeType: read.mimeType } };
  }
  const { kind: _text, ...body } = read;
  return { text: JSON.stringify(body, null, 1) };
}

/** A task's list of sources as `read_task_source` answers it: a page of the
 *  listing. */
interface SourceListRead {
  task: string;
  kept: number;
  text: string;
  truncated: boolean;
  nextOffset?: number;
}

/**
 * Ruling 82: the sources a task in this project keeps, for an agent: the
 * list without `id`, one source's content with it. One reader behind every
 * `read_task_source` (a Claude specialist's toolkit, the gateway's board
 * server for a Codex one, the operator and the controller), so a reviewer and
 * the coordinator that reads its verdict are answered the same thing.
 *
 * The list is each source's record and what each kept delivery rested on,
 * paged like any text. A source's content is read as a task file's is
 * (`readTaskSource`): what a reviewer checks a claim against is the bytes the
 * run kept, not the page as it reads on the day of the review.
 *
 * Ruling 82: with `find`, the places in one source that hold those words
 * instead of a page of it (`taskSourceSearch`).
 */
export function readAgentTaskSource(
  deps: BoardReadContext,
  taskKey: string,
  id: string | undefined,
  offset = 0,
  find?: string,
): AgentAttachmentRead {
  const key = taskKey.trim();
  if (!boardRows(deps).some((t) => t.key === key)) {
    return { text: `[noop] No task ${key} in this project; \`read_board\` lists the project's tasks.` };
  }
  const kept = readTaskSources(deps.projectSlug, key, deps.ctx.dataRoot);
  const wanted = id?.trim();
  const words = findWords(find ?? "");
  if (words.length > 0) return { text: taskSourceSearch(deps, key, kept, wanted, words, offset) };
  if (!wanted) {
    // Every kept delivery is named, one stamped while the task kept nothing
    // included: it rested on no kept source, and the list says so.
    const delivered = listKeptDeliveries(deps.projectSlug, key, deps.ctx.dataRoot).map((d) => d.deliveredAt);
    const whole = kept.sources.length > 0 ? sourcesListing(kept, delivered) : `${key} keeps no sources.`;
    const end = pageEnd(whole, offset);
    const list: SourceListRead = {
      task: key,
      kept: kept.sources.length,
      text: whole.slice(offset, end),
      truncated: whole.length > end,
    };
    if (whole.length > end) list.nextOffset = end;
    return { text: JSON.stringify(list, null, 1) };
  }
  const read = readTaskSource(deps.projectSlug, key, wanted, deps.ctx.dataRoot, offset);
  if (!read) return { text: noSuchSource(key, kept, wanted) };
  const { source, content } = read;
  if ("unreadable" in content) return { text: `[noop] ${content.unreadable}` };
  if (content.kind === "image") {
    // Ruling 329: a kept source opened as a picture is a look at it.
    recordRunLooks(deps.db, deps.runId, [{ kind: "source", task: key, id: source.id }]);
    const kb = Math.max(1, Math.round(content.bytes / 1024));
    return {
      header:
        `${source.id}: \`${source.name}\` (${kb} KB, ${content.mimeType}), a source kept on ${key}, ` +
        `from ${source.from}. The image follows.`,
      image: { data: content.data, mimeType: content.mimeType },
    };
  }
  const { kind: _text, name, bytes, ...page } = content;
  return {
    text: JSON.stringify(
      {
        id: source.id,
        title: source.title,
        from: source.from,
        keptAt: source.keptAt,
        by: `agent:${source.by.profileId}`,
        name,
        bytes,
        sha256: source.sha256,
        ...page,
      },
      null,
      1,
    ),
  };
}

/** What a reader is told when the task keeps no source of that id. */
function noSuchSource(key: string, kept: TaskSourcesRead, wanted: string): string {
  const ids = kept.sources.map((s) => s.id);
  const have =
    ids.length === 0
      ? "It keeps no sources."
      : `It keeps ${ids.length === 1 ? ids[0] : `${ids[0]} to ${ids[ids.length - 1]}`}; ` +
        "call read_task_source without `id` to list them.";
  return `[noop] ${key} keeps no source \`${wanted}\`. ${have}`;
}

/**
 * Ruling 82: one source searched for `words`, as JSON: how many places in it
 * hold them (`found`), and the places from `offset` on (`hits`), each with
 * its line, the offset a read of it starts at and the words where they stand.
 * `nextOffset` is where the next search starts when the list was cut.
 *
 * A search answers for one source. Asked without an `id` it says so, since a
 * list of sources in answer to a search would read as "found in none of
 * them".
 */
function taskSourceSearch(
  deps: BoardReadContext,
  key: string,
  kept: TaskSourcesRead,
  id: string | undefined,
  words: readonly string[],
  offset: number,
): string {
  if (!id) {
    return (
      "[noop] `find` searches one source: pass that source's `id` with it. " +
      "read_task_source without `id` and without `find` lists the sources."
    );
  }
  const phrase = words.join(" ");
  if (words.length > FIND_MAX_WORDS || phrase.length > FIND_MAX_CHARS) {
    return (
      `[noop] \`find\` takes a word or a short phrase, up to ${FIND_MAX_WORDS} words and ${FIND_MAX_CHARS} characters; ` +
      `this one is ${words.length} words and ${phrase.length} characters. ` +
      "Search for a few words of the passage, then read it from the place found."
    );
  }
  const read = findInTaskSource(deps.projectSlug, key, id, words, deps.ctx.dataRoot, offset);
  if (!read) return noSuchSource(key, kept, id);
  const { source, find } = read;
  if ("unreadable" in find) return `[noop] ${find.unreadable}`;
  const notes: string[] = [];
  if (find.found === 0) {
    notes.push(
      `Nothing in ${source.id} reads this. Letters match in either case and a space matches any run of spaces and line breaks; ` +
        "nothing else is loosened, so a curly quote, a dash or an accented letter matches only itself. " +
        "Try fewer words, or one plain word the passage has to use.",
    );
  } else if (find.hits.length === 0) {
    notes.push(`No place at or after offset ${offset}: every one is before it. Search again without \`offset\`.`);
  }
  if (find.truncated) {
    notes.push(`${source.id}'s text was cut where its rendering stopped, and the search covers that much of it.`);
  }
  const answer: TaskSourceSearch = {
    id: source.id,
    title: source.title,
    from: source.from,
    find: phrase,
    found: find.found,
    hits: find.hits,
  };
  if (find.nextOffset !== undefined) answer.nextOffset = find.nextOffset;
  if (find.leftOut) answer.leftOut = find.leftOut;
  if (notes.length > 0) answer.note = notes.join(" ");
  return JSON.stringify(answer, null, 1);
}

/** What a search of one source answers. */
interface TaskSourceSearch {
  id: string;
  title: string;
  from: string;
  find: string;
  found: number;
  hits: TextHit[];
  nextOffset?: number;
  leftOut?: string;
  note?: string;
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
 * Ruling 117 (pass 37, F37-120): the coordinator can read a report it was
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
 * now somewhere to go, exactly as ruling 205 did for a knowledge base — index
 * in the prompt, document on demand.
 */

/**
 * Ruling 72: how a shared budget splits between entries. Each gets an equal
 * part of what is left, shortest first, so an entry under its part leaves the
 * rest to the longer ones.
 */
function shareBudget(lengths: readonly number[], total: number): number[] {
  const caps = lengths.map(() => 0);
  let left = total;
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  order.forEach(({ len, i }, k) => {
    caps[i] = Math.min(len, Math.floor(left / (order.length - k)));
    left -= caps[i]!;
  });
  return caps;
}

/** One entry as `read_timeline_entry` returns it. */
interface TimelineEntryReading {
  /** Ruling 72: which of the entries that share the stamp, counted from 1 in
   *  the order they were written; absent when the stamp names one entry. */
  entry?: number;
  type: string;
  actor: string;
  title: string | null;
  /** Ruling 213(d): where this page starts, when it is not the entry's start. */
  offset?: number;
  truncated: boolean;
  text: string;
  /** Ruling 213(d): the offset the next page starts at, on a truncated read. */
  nextOffset?: number;
  /** Ruling 213(d): the entry's whole length, on a read that is not all of it. */
  characters?: number;
  /** Ruling 211: a `kb_correction` entry's correction, whole from its record. */
  correction?: CorrectionReading;
}

/** Who wrote an entry, as a read names them. */
function entryActor(entry: TaskFileEvent): string {
  return entry.actor.kind === "human" ? (entry.actor.nameHint ?? "human") : entry.actor.kind;
}

/**
 * Ruling 213(d): one page of one entry's text, from `offset`, in at most `bytes`
 * of UTF-8 (`pageEnd`: no character is split, and a page always moves). A
 * page that is not the whole entry says where it starts, where the next one
 * does and how long the entry is.
 */
function entryPage(entry: TaskFileEvent, offset: number, bytes: number, numbered: number | null): TimelineEntryReading {
  const end = pageEnd(entry.text, offset, bytes);
  const more = end < entry.text.length;
  // What a reader pages by leads the entry's own text. A page of JSON prints
  // longer than a page of prose, and a Codex run's output is cut from the
  // middle past its limit (ruling 215), which keeps both ends of the answer.
  // An entry alone keeps its fields either way; among entries that share a
  // page, the ones after the first sit towards the middle, so the answer
  // also opens with what was cut (`cut`, below).
  const which: Pick<TimelineEntryReading, "entry"> = {};
  if (numbered !== null) which.entry = numbered;
  const from: Pick<TimelineEntryReading, "offset"> = {};
  if (offset > 0) from.offset = offset;
  const rest: Pick<TimelineEntryReading, "characters" | "nextOffset"> = {};
  if (offset > 0 || more) rest.characters = entry.text.length;
  if (more) rest.nextOffset = end;
  return {
    ...which,
    type: entry.type,
    actor: entryActor(entry),
    title: entry.title,
    ...from,
    // Reported, never hidden: a clipped entry that reads as complete is how a
    // model states a half-read report as fact, the very failure this tool
    // exists to end.
    truncated: more,
    ...rest,
    text: entry.text.slice(offset, end),
  };
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * Ruling 72: the one entry a read with `offset` or `entry` is of, as its
 * place among the entries that share the stamp, or the sentence that says why
 * none can be told. Null for a read of them all from the start.
 *
 * `entry` names it. Without it an `offset` reads on in the only entry there
 * is, or in the only one long enough to reach that offset: a verdict's report
 * beside its one-line quality marker is the usual pair, and a reader that
 * passes back the `nextOffset` it was given means the report.
 */
function entryToReadOn(
  entries: readonly TaskFileEvent[],
  taskKey: string,
  stamp: string,
  offset: number,
  entry: number | undefined,
): { index: number } | { refusal: string } | null {
  if (entry !== undefined) {
    if (entry >= 1 && entry <= entries.length) return { index: entry - 1 };
    return {
      refusal:
        entries.length === 1
          ? `[noop] One entry on ${taskKey} carries the stamp \`${stamp}\`: \`entry\` can only be 1, or left out.`
          : `[noop] ${entries.length} entries on ${taskKey} carry the stamp \`${stamp}\`: \`entry\` is 1 to ${entries.length}, in the order they were written.`,
    };
  }
  if (offset === 0) return null;
  if (entries.length === 1) return { index: 0 };
  const reach = entries.flatMap((e, i) => (e.text.length > offset ? [i] : []));
  if (reach.length === 1) return { index: reach[0]! };
  if (reach.length === 0) {
    const longest = Math.max(...entries.map((e) => e.text.length));
    return {
      refusal:
        `[noop] None of the ${entries.length} entries on ${taskKey} that carry the stamp \`${stamp}\` runs to offset ${count(offset)}: ` +
        `the longest reads as ${count(longest)} characters.`,
    };
  }
  return {
    refusal:
      `[noop] ${entries.length} entries on ${taskKey} carry the stamp \`${stamp}\` and ${reach.length} of them run past offset ${count(offset)} ` +
      `(entries ${reach.map((i) => i + 1).join(", ")}): say which to read on with \`entry\`.`,
  };
}

/** One timeline entry, addressed by the `occurredAt` stamp `get_task`
 *  prints or `read_board` lists (ruling 213). Ruling 72: every entry the stamp
 *  names. One write often stamps two entries with one instant (a verdict's
 *  report and its quality marker, a failed run's report and its failure, a
 *  task's opening notes), and the read returned the first in the file: on
 *  AWSC-96 the Estimate Judge asked for its own earlier verdict and got the
 *  quality marker, so it scored the rework against a split it rebuilt from
 *  memory.
 *
 *  Ruling 72: entries that share a stamp come back in the order they were
 *  written. The file holds them newest first, and "in the timeline's order"
 *  read as first written first: on AWSC-97 the Estimate Judge read an agent's
 *  question as sent before the report that saved its ledger, which was written
 *  first, and marked the run down for it. A knowledge-base correction's entry
 *  comes back with the correction whole ({@link readCorrectionOfEntry}).
 *
 *  Ruling 213(d): in pages. A read that stopped at a cap, said `truncated`
 *  and offered no way on would be a wall (ruling 117), and a read longer than
 *  the page every other read is sized to (ruling 215) would hand a Codex run a
 *  long entry with its middle cut out. A read carries at most one page
 *  (`READ_PAGE_BYTES`) of text: the entries a stamp names share the first one
 *  (`shareBudget`), an entry cut short gives `nextOffset`, and `offset` (with
 *  `entry`, where the stamp names several) reads on in one entry with a page
 *  to itself. */
export async function readTimelineEntry(
  deps: BoardReadContext,
  taskKey: string,
  occurredAt: string,
  offset = 0,
  entry?: number,
): Promise<string> {
  const file = readTaskFile({
    projectSlug: deps.projectSlug,
    taskKey,
    dataRoot: deps.ctx.dataRoot,
  });
  if (!file) {
    return `[noop] No task ${taskKey} in this project.`;
  }
  // Ruling 213(e): every door refuses these before they get here, and the
  // reader does not rest on that: a negative offset would read from an entry's
  // end, a fraction would come back as the next offset, and a fraction for
  // `entry` would throw.
  if (!Number.isInteger(offset) || offset < 0) {
    return "[noop] `offset` is a whole number from 0, in characters: the `nextOffset` a truncated read returned.";
  }
  if (entry !== undefined && !Number.isInteger(entry)) {
    return "[noop] `entry` is a whole number from 1: the number a first read gives an entry that shares its stamp.";
  }
  const wanted = occurredAt.trim();
  // Every writer puts its entry at the head of the file, so the reverse of
  // the file's order is the order they were written.
  const entries = file.parsed.timeline.filter((e) => e.occurredAt === wanted).reverse();
  if (entries.length === 0) {
    // Ruling 260's shape: say what this reader IS and how to address it, rather
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
  const correctionOf = (e: TaskFileEvent) =>
    e.type === "kb_correction"
      ? readCorrectionOfEntry(deps.db, deps.ctx, deps.projectSlug, e.text, deps.readerKbs)
      : Promise.resolve(null);

  const one = entryToReadOn(entries, taskKey, wanted, offset, entry);
  if (one !== null) {
    if ("refusal" in one) return one.refusal;
    const picked = entries[one.index]!;
    const numbered = entries.length > 1 ? one.index + 1 : null;
    if (offset > 0 && offset >= picked.text.length) {
      const which = numbered === null ? "The entry" : `Entry ${numbered} of ${entries.length}`;
      return `[noop] ${which} reads as ${count(picked.text.length)} characters; offset ${count(offset)} is past its end.`;
    }
    // Its correction rides with the entry's first page, where the reader
    // meets it, and not again on the pages after. It is read whole, beside
    // the page and not out of it: a correction is bounded by its own limits.
    const correction = offset === 0 ? await correctionOf(picked) : null;
    const reading = entryPage(picked, offset, READ_PAGE_BYTES, numbered);
    if (correction) reading.correction = correction;
    return JSON.stringify({ occurredAt: wanted, ...reading }, null, 1);
  }

  const corrections = await Promise.all(entries.map(correctionOf));
  const caps = shareBudget(
    entries.map((e) => Buffer.byteLength(e.text)),
    READ_PAGE_BYTES,
  );
  const readings = entries.map((e, i) => {
    const reading = entryPage(e, 0, caps[i]!, entries.length > 1 ? i + 1 : null);
    const correction = corrections[i];
    if (correction) reading.correction = correction;
    return reading;
  });
  if (readings.length === 1) {
    return JSON.stringify({ occurredAt: wanted, ...readings[0] }, null, 1);
  }
  // Ruling 213(d): the entries this page cut short, with where each reads on,
  // ahead of the entries themselves. Two long entries split a page evenly,
  // which puts the second one's own fields at the middle of the answer,
  // where an output over a Codex run's limit is cut.
  const cut = readings.flatMap((r) =>
    r.nextOffset === undefined ? [] : [{ entry: r.entry, characters: r.characters, nextOffset: r.nextOffset }],
  );
  const head = {
    occurredAt: wanted,
    shared: `${readings.length} entries were written with this stamp. They are listed in the order they were written: the first was written first.`,
  };
  return JSON.stringify(cut.length === 0 ? { ...head, entries: readings } : { ...head, cut, entries: readings }, null, 1);
}
