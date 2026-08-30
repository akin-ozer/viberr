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

export const GOAL_STATUS_VALUES = [
  "active",
  "paused",
  "attention",
  "completed",
  "cancelled",
] as const;
export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];

export const GOAL_LINK_STATUS_VALUES = [
  "pending",
  "active",
  "done",
  "failed",
  "skipped",
] as const;
export type GoalLinkStatus = (typeof GOAL_LINK_STATUS_VALUES)[number];

export const GOAL_ON_FAILURE_VALUES = ["pause", "continue"] as const;
export type GoalOnFailure = (typeof GOAL_ON_FAILURE_VALUES)[number];

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
}

/** A goal is COMPLETE when every link is settled and none failed-and-blocked;
 *  helper for both the writer and the projection. */
export function allLinksSettled(links: readonly GoalLink[]): boolean {
  return (
    links.length > 0 &&
    links.every((l) => l.status === "done" || l.status === "skipped")
  );
}

/** The 1-based index of the link the chain is currently ON — the first link
 *  that is not settled — or null when every link is settled. */
export function currentLinkIndex(links: readonly GoalLink[]): number | null {
  const open = links.find(
    (l) => l.status !== "done" && l.status !== "skipped",
  );
  return open ? open.index : null;
}
