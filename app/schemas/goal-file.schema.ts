import { z } from "zod";

/**
 * Chained-goal file schema (ruling 99): `projects/<slug>/goals/<id>.md`.
 *
 * A goal decomposes ONE outcome into an ordered chain of tasks the controller
 * creates lazily and the server advances as each link completes. The file is
 * canonical (files are business truth); `goal_projections` is its derived row.
 *
 * Body layout: `## Description` (the outcome, prose) then `## Timeline`
 * (append-only history bullets, newest first: `- <UTC ISO> · <text>`). The
 * timeline is deliberately the SIMPLE grammar, not the task event grammar: a
 * goal's history is single-writer app narration, and bullets stay readable,
 * diffable and unforgeable without the escaping machinery task.md needs for
 * multi-actor bodies.
 *
 * STATUS SEMANTICS
 * - `active`     the chain advances on its own as links complete.
 * - `paused`     a human parked it; nothing advances until resumed.
 * - `attention`  a link failed (or advancement lost its authority) and
 *                `onFailure: pause` — humans redirect it.
 * - `completed`  every link is done or skipped. Terminal but readable forever.
 * - `cancelled`  a human closed it early. Terminal; the record stays.
 * There is no delete: a goal file is never removed by the product.
 *
 * LINK STATUS is stored AND derived: the stored value is the claim the
 * advance machinery last wrote; the projection re-derives each linked task's
 * real state from task rows on rebuild (a hand-moved or archived task cannot
 * leave the chain lying).
 */

const GOAL_STATUS_VALUES = [
  "active",
  "paused",
  "attention",
  "completed",
  "cancelled",
] as const;

const GOAL_LINK_STATUS_VALUES = [
  "pending",
  "active",
  "done",
  "failed",
  "skipped",
] as const;

export const GOAL_ON_FAILURE_VALUES = ["pause", "continue"] as const;

export const goalLinkSchema = z.object({
  /** 1-based position in the chain. */
  index: z.number().int().min(1),
  title: z.string().min(1),
  /** The link's task text: a self-standing deliverable + done signal. Becomes
   *  the created task's `## Goal`. */
  goal: z.string().default(""),
  /** The task carrying this link; null until the chain reaches it. */
  taskKey: z.string().nullable().default(null),
  status: z.enum(GOAL_LINK_STATUS_VALUES).default("pending"),
  /** Failure reason / redirect note, shown on the chain card. */
  note: z.string().nullable().default(null),
  /** Ruling 192(b): this link's text was RE-DECLARED by `edit_link` after its
   *  task failed, so the next retry must build from the link rather than carry
   *  the failed task's copy forward. Ruling 192's first draft carried the task's
   *  text unconditionally, which silently discarded the one edit the product
   *  explicitly offers on a failed link — "edit a pending or failed link" is in
   *  `update_goal`'s own description. Cleared by the retry that consumes it. */
  redeclared: z.boolean().default(false),
  /** Ruling 131(c) (pass 34): what this link's task WAITS ON, in the canonical
   *  spellings of `app/shared/dependencies.ts` (`JC-6`, `goal-2 link 1`).
   *  Copied onto the task the chain creates for this link and validated then,
   *  so a link that waits on a sibling chain's link is born held instead of
   *  paying a triage turn that has to discover the wait. Spelling-checked at
   *  write time by the goal writer; the strict parser only requires strings.
   *
   *  Ruling 398: this is now the ONLY thing that holds a link back. A goal
   *  starts every link whose wait is already satisfied, so an empty list means
   *  the link starts immediately, whatever its position — position in the list
   *  is presentation, not order. The goal writer accepts `link 2` on input and
   *  stores the absolute spelling, because the goal has no id until it is
   *  written and a sequence has to be expressible in one call. */
  blockedBy: z.array(z.string()).default([]),
});
export type GoalLink = z.infer<typeof goalLinkSchema>;

export const goalFrontmatterSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(GOAL_STATUS_VALUES).default("active"),
  /** The goal creator — the authority chain advancement is re-proven against
   *  (their live `create-task` in this project) every time a link task is
   *  created with nobody present. */
  createdBy: z.string().min(1),
  createdByLabel: z.string().default(""),
  /** Ruling 476(h) (F40-61): the controller conversation the chain was
   *  planned in, so the project's Controller page can link back to the
   *  reasoning behind it. Null for a chain written before the key existed. */
  conversationId: z.string().nullable().default(null),
  onFailure: z.enum(GOAL_ON_FAILURE_VALUES).default("pause"),
  links: z.array(goalLinkSchema).default([]),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type GoalFrontmatter = z.infer<typeof goalFrontmatterSchema>;

/** Canonical write order for the goal frontmatter keys. */
export const GOAL_FRONTMATTER_KEYS: readonly (keyof GoalFrontmatter)[] = [
  "id",
  "title",
  "status",
  "createdBy",
  "createdByLabel",
  "conversationId",
  "onFailure",
  "links",
  "createdAt",
  "updatedAt",
];

/** One `- <UTC ISO> · <text>` history bullet. */
export interface GoalTimelineEntry {
  occurredAt: string;
  text: string;
}

export interface ParsedGoalFile {
  frontmatter: GoalFrontmatter;
  description: string;
  timeline: GoalTimelineEntry[];
  /** Frontmatter keys the goal schema does not know, preserved verbatim so a
   *  hand-added or future/foreign field round-trips through a write instead of
   *  being silently dropped (file-formats §2: writers ALWAYS preserve unknown
   *  frontmatter fields — the task and project writers already do). Absent on a
   *  freshly minted file. */
  unknownFrontmatter?: GoalUnknownFrontmatter;
}

/** Raw, still-undecoded frontmatter keys — the same shape the task/project
 *  schemas name `RawFrontmatter`; a schema-derived value type, not a bare
 *  dictionary, so unknown keys keep a defined contract as they round-trip. */
export type GoalUnknownFrontmatter = z.infer<
  typeof goalUnknownFrontmatterSchema
>;
const goalUnknownFrontmatterSchema = z.record(z.string(), z.unknown());

/** A goal is COMPLETE when every link is settled and none failed-and-blocked;
 *  helper for both the writer and the projection. */
export function allLinksSettled(links: readonly GoalLink[]): boolean {
  return (
    links.length > 0 &&
    links.every((l) => l.status === "done" || l.status === "skipped")
  );
}

/** The 1-based index of the FIRST unsettled link, or null when every link is
 *  settled.
 *
 *  Ruling 398: no longer the link that starts next — `reconcileGoal` starts
 *  every link whose declared wait allows it. This answers "which link does the
 *  goal ride on", for the chip and the active-task lookup, and several links
 *  can be live at once behind it. */
export function currentLinkIndex(links: readonly GoalLink[]): number | null {
  const open = links.find(
    (l) => l.status !== "done" && l.status !== "skipped",
  );
  return open ? open.index : null;
}
