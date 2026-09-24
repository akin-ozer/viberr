import type { DatabaseSync } from "node:sqlite";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
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
  return (
    `${goal.slice(0, BOARD_READ_GOAL_CHARS)}\n\n` +
    `[excerpt — this goal is ${goal.length.toLocaleString("en-US")} characters and this is ` +
    `its first ${BOARD_READ_GOAL_CHARS.toLocaleString("en-US")}. Do not treat what is above ` +
    `as the whole contract; the task's own page has all of it.]`
  );
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
      `report named it, that claim is wrong — say so rather than acting on it.`
    );
  }
  const file = readTaskFile({
    projectSlug: deps.projectSlug,
    taskKey: row.key,
    dataRoot: deps.ctx.dataRoot,
  });
  return JSON.stringify(
    {
      key: row.key,
      title: row.title,
      stage: row.stage,
      readiness: row.readiness,
      waiting: row.waiting,
      archived: row.archived,
      waitsOn: row.blockedBy.map((e) => `${e.label} (${e.state})`),
      goal: goalExcerpt(file?.parsed.goal ?? null),
    },
    null,
    1,
  );
}

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
 *  prints. */
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
      `match exactly, to the millisecond, as \`get_task\` prints it. The eight most ` +
      `recent:\n${recent.join("\n")}`
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
