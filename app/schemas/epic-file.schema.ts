import { z } from "zod";
import { EPIC_ID_RE, EPIC_STATUS_VALUES, epicNumber } from "~/shared/task-refs";
import { STAGE_COLORS, type StageColor } from "~/shared/workflow/stage-colors";

/**
 * Epic file schema (ruling 17): `projects/<slug>/epics/<id>.md`.
 *
 * An epic is a named body of work inside ONE project, the way Jira draws an
 * epic and Linear a project. Tasks join and leave it one at a time, and the
 * membership lives on the TASK (`task.md` `epic`), the same project→task shape
 * as `stage`: this file owns what the epic IS (its name, its description, its
 * status, who leads it and when it is meant to land), each task says which
 * epic it belongs to. An epic never creates, starts, orders or holds a task:
 * what a task waits on is its own `blockedBy` (ruling 55), and the release
 * engine starts it when that work is done.
 *
 * Body layout: `## Description` (markdown prose) then `## Timeline`
 * (append-only history bullets, newest first: `- <UTC ISO> · <text>`), the
 * simple grammar the goal files it replaced used, for the same reason: an
 * epic's history is single-writer app narration.
 *
 * STATUS is a person's call, as it is in Jira and Linear, never derived: the
 * epic's progress is derived from its tasks at read time and shown beside it.
 * - `planned`      nothing has started yet.
 * - `in_progress`  work is under way.
 * - `paused`       parked on purpose; its tasks are not held by it.
 * - `done`         delivered. Terminal in wording only: a done epic can be
 *                  reopened, and tasks can still join or leave it.
 * - `cancelled`    abandoned. The record stays.
 * There is no delete: an epic file is never removed by the product.
 *
 * PARSING follows the goal files it replaced: an absent key takes its default,
 * and a value the schema rejects makes the file untrusted with a diagnostic
 * naming the field (`diagnoseEpicFileContent`). The file is app-written, so
 * only a hand edit can get there, and a silent correction would hide it.
 */

/** The epic's id and statuses live in `shared/task-refs.ts`, which the task
 *  schema (on every page) and the board and task page read without loading
 *  this file (ruling 11, FL-1). */
export {
  EPIC_ID_RE,
  EPIC_STATUS_LABEL,
  EPIC_STATUS_VALUES,
  epicNumber,
  isEpicId,
  isEpicOpen,
  type EpicStatus,
} from "~/shared/task-refs";

/**
 * An epic's colour is one of the twenty stage presets (ruling 279): the file
 * stores the NAME, the markup carries `data-stage-color`, and `app.css` is the
 * one place the name becomes paint in either theme.
 */
export const EPIC_COLORS = STAGE_COLORS;
export type EpicColor = StageColor;

/**
 * The colour a new epic gets when nobody picks one: hues far apart, so
 * neighbouring epics never rhyme in the Epics list. Indexed by the epic's
 * number, so the same epic always gets the same colour.
 */
const EPIC_COLOR_SEQUENCE: readonly EpicColor[] = [
  "violet",
  "blue",
  "teal",
  "amber",
  "rose",
  "indigo",
  "emerald",
  "orange",
  "pink",
  "sky",
  "lime",
  "purple",
  "cyan",
  "fuchsia",
  "red",
  "green",
];

export function defaultEpicColor(epicId: string): EpicColor {
  const n = epicNumber(epicId) ?? 1;
  return EPIC_COLOR_SEQUENCE[(n - 1) % EPIC_COLOR_SEQUENCE.length]!;
}

/** `YYYY-MM-DD`, the due-date grammar tasks use. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const epicFrontmatterSchema = z.object({
  id: z.string().regex(EPIC_ID_RE),
  title: z.string().min(1),
  status: z.enum(EPIC_STATUS_VALUES).default("planned"),
  color: z.enum(EPIC_COLORS).default("violet"),
  /** The person who leads the epic (Jira's assignee, Linear's lead): the one
   *  its notices reach. Null when nobody leads it; its creator hears then. */
  leadUserId: z.string().min(1).nullable().default(null),
  /** When the work is meant to start and to land (Linear's start and target
   *  dates). Planning facts only: nothing waits on them. */
  startDate: isoDate.nullable().default(null),
  targetDate: isoDate.nullable().default(null),
  createdBy: z.string().min(1),
  createdByLabel: z.string().default(""),
  /** The controller conversation the epic was planned in, when a controller
   *  turn created it, so the epic page can link back to the reasoning. */
  conversationId: z.string().nullable().default(null),
  /** The chained goal this epic was converted from (`goal-3`), written once by
   *  the boot conversion (`goal-epic-conversion`); null for an epic made as
   *  one. It is how a conversion interrupted part-way finds the epic it
   *  already made instead of making a second. */
  convertedFrom: z.string().regex(/^goal-\d+$/).nullable().default(null),
  createdAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type EpicFrontmatter = z.infer<typeof epicFrontmatterSchema>;

/** Canonical write order for the epic frontmatter keys. */
export const EPIC_FRONTMATTER_KEYS: readonly (keyof EpicFrontmatter)[] = [
  "id",
  "title",
  "status",
  "color",
  "leadUserId",
  "startDate",
  "targetDate",
  "createdBy",
  "createdByLabel",
  "conversationId",
  "convertedFrom",
  "createdAt",
  "updatedAt",
];

/** One `- <UTC ISO> · <text>` history bullet. */
export interface EpicTimelineEntry {
  occurredAt: string;
  text: string;
}

/** Raw, still-undecoded frontmatter keys the schema does not know, preserved
 *  so a hand-added or future field round-trips through a write. */
const epicUnknownFrontmatterSchema = z.record(z.string(), z.unknown());
export type EpicUnknownFrontmatter = z.infer<typeof epicUnknownFrontmatterSchema>;

export interface ParsedEpicFile {
  frontmatter: EpicFrontmatter;
  description: string;
  timeline: EpicTimelineEntry[];
  unknownFrontmatter?: EpicUnknownFrontmatter;
}

/** Longest epic title the writers accept: the task page's chip and the
 *  board's epic filter show the first words, and a title is a name, not a
 *  paragraph. */
export const EPIC_TITLE_MAX = 120;
