import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { defaultEpicColor, type EpicStatus, type EpicTimelineEntry } from "~/schemas/epic-file.schema";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { resolveProjectAuthority } from "~/server/auth/project-authority.server";
import {
  createEpicFile,
  listEpicIds,
  nextEpicId,
  parseDescriptionAndTimeline,
  readEpicFile,
  updateEpicFile,
  withEpicsLock,
} from "~/server/files/epic-writer.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import {
  epicFilePath,
  projectFilePath,
  projectsDir,
  retiredGoalsDir,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import {
  serializeFrontmatterFile,
  splitFrontmatterMapping,
  yamlMappingSchema,
  type YamlMapping,
} from "~/server/files/frontmatter.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { writeAndRemember } from "~/server/files/write-cache.server";
import { logger } from "~/server/logging/logger.server";
import { epicTaskKeys } from "~/server/projections/epic-query.server";
import { epicLink } from "~/server/projections/notifications.server";
import { rebuildEpicFile } from "~/server/projections/rebuilder.server";
import { canonicalDependencyRef, joinDependencyEntries } from "~/shared/dependencies";
import { toError } from "~/shared/errors";
import { rolesForAction } from "~/shared/rbac";
import { isTerminalStage } from "~/shared/workflow/stage-roles";
import { countLabel } from "~/shared/text/plural";
import { announceRelease, clearDependencies } from "./dependencies.server";
import { createTask } from "./task-actions.server";
import {
  loadProjectContext,
  reprojectTask,
  taskRef,
  type ProjectContext,
  type TaskMutationContext,
} from "./task-mutation.server";
import { userDisplayName } from "./user-display-name.server";

/**
 * Ruling 503: the chained goals of ruling 99 become epics, once, at boot.
 *
 * A goal was a chain the server advanced: its links became tasks one by one
 * as the work they waited on landed. An epic holds tasks and advances nothing,
 * so every goal becomes the epic with the same number, and nothing it knew is
 * lost on the way:
 *
 * - The goal's title, description, creator, planning conversation and history
 *   carry over. Its status maps onto the epic's (active: in progress, or
 *   planned while no link had started; paused and attention: paused;
 *   completed: done; cancelled: cancelled).
 * - Every task that carried a link, and every task whose `goalRef` named the
 *   goal, joins the epic; the retired `goalRef` key leaves the task file.
 * - A link that had not started yet, in a chain that was still running,
 *   becomes a task now, in the epic, waiting on what the link waited on, so
 *   the release engine starts it when that work lands exactly as the chain
 *   would have. It is made on the goal creator's authority, re-proven here as
 *   the chain re-proved it, and signed by the conversion (ruling 477(b)). A
 *   link that cannot be made that way (the chain was paused or closed, its
 *   creator lost task creation, it waited on something that can never
 *   happen) is listed in the epic's description instead, with its text, so a
 *   person can make it a task.
 * - What a task waits on is spelled by task from now on. Every `goal-2 link 3`
 *   entry, in a task's `blockedBy` and in an open decision's options, becomes
 *   the key of the task that carried the link. An entry naming a skipped link
 *   is dropped (the chain counted it as settled), and one naming a link that
 *   will never have a task is dropped with a note. A task left waiting on
 *   nothing is released when everything it waited on was settled, and put in
 *   front of a person when something it waited on can never happen.
 * - Notices that opened a goal on the Controller page open its epic.
 *
 * The goal file is then filed under `goals/converted/`, which is what makes
 * the conversion run once. Every step is idempotent, so a conversion the
 * process died in the middle of finishes on the next boot: an epic it made is
 * found by its `convertedFrom`, a link it made a task for is recorded in the
 * goal file the moment the task exists, and a task already moved is left
 * alone.
 */

const CONVERSION_SYSTEM_ID = "epic-conversion";
const CONVERSION_AUDIT_ACTOR: AuditActor = { userId: null, label: CONVERSION_SYSTEM_ID };

export interface GoalEpicConversion {
  /** One entry per goal converted on this run. */
  converted: {
    projectSlug: string;
    goalId: string;
    epicId: string;
    /** Tasks in the epic once the conversion was done. */
    tasks: number;
    /** Tasks made now for links that had not started. */
    started: string[];
    /** Unstarted links listed in the epic's description instead. */
    listed: number;
  }[];
  /** Tasks whose waits were respelled by task key. */
  rewrittenWaits: string[];
  /** Goal files that could not be read or converted, left where they are. */
  failed: { projectSlug: string; goalId: string; reason: string }[];
}

// ------------------------------------------------------------ legacy reads

const LEGACY_LINK_STATUS_VALUES = ["pending", "active", "done", "failed", "skipped"] as const;
const LEGACY_GOAL_STATUS_VALUES = ["active", "paused", "attention", "completed", "cancelled"] as const;

/** A link as ruling 99 stored it, read tolerantly: a goal file is read once
 *  more, by this conversion, and never written as a goal again. */
const legacyLinkSchema = z.object({
  index: z.number().int().min(1),
  title: z.string().catch(""),
  goal: z.string().catch(""),
  taskKey: z.string().min(1).nullable().catch(null),
  status: z.enum(LEGACY_LINK_STATUS_VALUES).catch("pending"),
  blockedBy: z.array(z.string()).catch([]),
});
type LegacyLink = z.infer<typeof legacyLinkSchema>;

const legacyGoalFrontmatterSchema = z.object({
  title: z.string().catch(""),
  status: z.enum(LEGACY_GOAL_STATUS_VALUES).catch("active"),
  createdBy: z.string().catch(""),
  createdByLabel: z.string().catch(""),
  conversationId: z.string().min(1).nullable().catch(null),
  // One unreadable link drops itself, never its siblings.
  links: z.array(legacyLinkSchema.nullable().catch(null)).catch([]),
  createdAt: z.string().nullable().catch(null),
});
type LegacyGoalStatus = (typeof LEGACY_GOAL_STATUS_VALUES)[number];

interface LegacyGoal {
  /** The file's name, which is what tasks and waits called it. */
  id: string;
  number: number;
  title: string;
  status: LegacyGoalStatus;
  createdBy: string;
  createdByLabel: string;
  conversationId: string | null;
  links: LegacyLink[];
  createdAt: string | null;
  description: string;
  timeline: EpicTimelineEntry[];
  path: string;
}

const GOAL_ID_RE = /^goal-(\d+)$/;

function goalFileIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) return [];
      const id = entry.name.slice(0, -3);
      return GOAL_ID_RE.test(id) ? [id] : [];
    })
    .sort((a, b) => goalNumber(a) - goalNumber(b));
}

function goalNumber(id: string): number {
  return Number(GOAL_ID_RE.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
}

function readLegacyGoal(dir: string, goalId: string): LegacyGoal | null {
  const file = path.join(dir, `${goalId}.md`);
  const { data, body, diagnostics } = splitFrontmatterMapping(readFileSync(file, "utf8"));
  if (diagnostics.some((d) => d.hardStop === true)) return null;
  const fm = legacyGoalFrontmatterSchema.parse(data);
  const { description, timeline } = parseDescriptionAndTimeline(body);
  return {
    id: goalId,
    number: goalNumber(goalId),
    title: fm.title.replace(/\s+/g, " ").trim() || goalId,
    status: fm.status,
    createdBy: fm.createdBy.trim(),
    createdByLabel: fm.createdByLabel,
    conversationId: fm.conversationId,
    links: fm.links
      .filter((link): link is LegacyLink => link !== null)
      .sort((a, b) => a.index - b.index),
    createdAt: fm.createdAt,
    description,
    timeline,
    path: file,
  };
}

/** `goal-2 link 3`, the second spelling ruling 131(c) gave `blockedBy`. */
const LEGACY_LINK_REF_RE = /^goal-(\d+)\s+link\s+(\d+)$/i;

function parseLegacyLinkRef(text: string): { goalId: string; index: number } | null {
  const m = LEGACY_LINK_REF_RE.exec(text.trim().replace(/\s+/g, " "));
  return m ? { goalId: `goal-${Number(m[1])}`, index: Number(m[2]) } : null;
}

function linkId(goalId: string, index: number): string {
  return `${goalId} link ${index}`;
}

function linkTitle(link: LegacyLink): string {
  return link.title.replace(/\s+/g, " ").trim() || `Link ${link.index}`;
}

// ---------------------------------------------------------------- tasks

/** One task as the conversion first finds it, from the file as written:
 *  the task parser drops a `goal-2 link 3` entry it no longer reads, so the
 *  raw frontmatter is the only place those entries still are. */
interface TaskScan {
  key: string;
  /** The goal its retired `goalRef` named, if any. */
  goalId: string | null;
  /** `blockedBy` exactly as stored. */
  waits: string[];
  /** The goals whose links a wait entry, or a line of its open decision,
   *  names. Empty when nothing it holds is spelled the old way. */
  legacyGoals: Set<string>;
}

const legacyGoalRefSchema = z.object({ goalId: z.string() }).nullable().catch(null);
const rawWaitsSchema = z.array(z.string()).catch([]);

function projectTaskKeys(projectSlug: string, dataRoot: string | undefined): string[] {
  const dir = path.join(projectsDir(dataRoot), projectSlug, "tasks");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && !entry.name.startsWith(".") ? [entry.name] : [],
  );
}

function scanTask(projectSlug: string, key: string, dataRoot: string | undefined): TaskScan | null {
  const file = taskFilePath(projectSlug, key, dataRoot);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf8");
  const { data } = splitFrontmatterMapping(content);
  const waits = rawWaitsSchema.parse(data.blockedBy ?? []);
  const lines = content.split("\n");
  const named = [
    ...waits,
    ...packetLegacyLines(content).map((i) => PACKET_LINK_ITEM_RE.exec(lines[i]!)?.[3] ?? ""),
  ];
  return {
    key,
    goalId: legacyGoalRefSchema.parse(data.goalRef ?? null)?.goalId ?? null,
    waits,
    legacyGoals: new Set(named.flatMap((entry) => parseLegacyLinkRef(entry)?.goalId ?? [])),
  };
}

/** A list item naming a goal link, the way the YAML writer puts one in a
 *  decision's option (`blockedBy`, `newTask.blockedBy`, `newTask.blocks`). */
const PACKET_LINK_ITEM_RE = /^(\s*-\s+)(["']?)(goal-\d+\s+link\s+\d+)\2\s*$/i;

/** A YAML list item, and a decision's list key that holds waits. */
const LIST_ITEM_RE = /^\s*-\s/;
const PACKET_LIST_KEY_RE = /^\s*(?:blockedBy|blocks):\s*$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The line numbers, inside the task's `## Packet` section, of list items
 *  naming a goal link. */
function packetLegacyLines(content: string): number[] {
  const lines = content.split("\n");
  const out: number[] = [];
  let inPacket = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith("## ")) {
      inPacket = line.trim() === "## Packet";
      continue;
    }
    if (inPacket && PACKET_LINK_ITEM_RE.test(line)) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------- translation

/** Nothing will ever carry the link a wait names. */
interface GoneWait {
  kind: "gone";
  from: string;
  /** What became of it, as the rest of a sentence naming it ("goal-2 link 4
   *  never became a task"). */
  why: string;
}

type WaitTranslation =
  /** The task that carries (or now carries) the link. */
  | { kind: "task"; key: string; from: string | null }
  /** A skipped link: the chain counted it as settled. */
  | { kind: "settled"; from: string }
  /** A link this conversion is still to make a task for. */
  | { kind: "later"; from: string }
  | GoneWait
  /** Not a spelling anything reads: the task parser already ignores it. */
  | { kind: "unreadable" };

function isGone(wait: WaitTranslation): wait is GoneWait {
  return wait.kind === "gone";
}

interface ProjectConversion {
  projectSlug: string;
  ctx: TaskMutationContext;
  /** The goals this run converts. */
  goals: Map<string, LegacyGoal>;
  /** Goals an earlier run filed under `converted/`: read only to translate a
   *  wait that still names one of their links. */
  filed: Map<string, LegacyGoal>;
  /** goal id → the epic made from it. */
  epics: Map<string, { epicId: string; title: string }>;
  /** Links a task is being made for on this run, by `linkId`. */
  creatable: Set<string>;
  /** Links a task was made for on this run: `linkId` → key. */
  created: Map<string, string>;
}

function translateWait(state: ProjectConversion, entry: string): WaitTranslation {
  const ref = parseLegacyLinkRef(entry);
  if (!ref) {
    const key = canonicalDependencyRef(entry);
    return key ? { kind: "task", key, from: null } : { kind: "unreadable" };
  }
  const from = linkId(ref.goalId, ref.index);
  const goal = state.goals.get(ref.goalId) ?? state.filed.get(ref.goalId);
  const link = goal?.links.find((l) => l.index === ref.index);
  if (!goal || !link) return { kind: "gone", from, why: "does not exist" };
  const made = state.created.get(from);
  if (made) return { kind: "task", key: made, from };
  if (link.taskKey) return { kind: "task", key: link.taskKey, from };
  if (link.status === "skipped") return { kind: "settled", from };
  if (state.creatable.has(from)) return { kind: "later", from };
  const epic = state.epics.get(ref.goalId);
  return {
    kind: "gone",
    from,
    why: epic ? `never became a task (it is listed on ${epic.epicId})` : "never became a task",
  };
}

// ---------------------------------------------------------------- epics

function epicStatusOf(goal: LegacyGoal): EpicStatus {
  switch (goal.status) {
    case "active":
      return goal.links.some((l) => l.taskKey !== null) ? "in_progress" : "planned";
    case "paused":
    case "attention":
      return "paused";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
  }
}

/** The epics earlier runs already made, by the goal each came from. */
function epicsByGoal(projectSlug: string, dataRoot: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const epicId of listEpicIds(projectSlug, dataRoot)) {
    const from = readEpicFile({ projectSlug, epicId, dataRoot })?.parsed.frontmatter.convertedFrom;
    if (from) out.set(from, epicId);
  }
  return out;
}

/** The epic for a goal: the one an interrupted run already made, else a new
 *  one numbered like the goal when that number is free. */
async function ensureEpic(state: ProjectConversion, goal: LegacyGoal): Promise<string> {
  const { projectSlug, ctx } = state;
  return withEpicsLock(projectSlug, ctx.dataRoot, async () => {
    const existing = epicsByGoal(projectSlug, ctx.dataRoot).get(goal.id);
    if (existing) return existing;
    const preferred = `epic-${goal.number}`;
    const epicId = existsSync(epicFilePath(projectSlug, preferred, ctx.dataRoot))
      ? nextEpicId(projectSlug, ctx.dataRoot)
      : preferred;
    const now = new Date().toISOString();
    await createEpicFile(
      { projectSlug, epicId, dataRoot: ctx.dataRoot },
      {
        frontmatter: {
          id: epicId,
          title: goal.title,
          status: epicStatusOf(goal),
          color: defaultEpicColor(epicId),
          leadUserId: null,
          startDate: null,
          targetDate: null,
          // A goal with no recorded creator (a hand-written file) was the
          // conversion's to bring over, so the conversion is named.
          createdBy: goal.createdBy || CONVERSION_SYSTEM_ID,
          createdByLabel: goal.createdBy ? goal.createdByLabel : "",
          conversationId: goal.conversationId,
          convertedFrom: goal.id,
          createdAt: goal.createdAt ?? now,
          updatedAt: now,
        },
        description: goal.description,
        // The goal's own history, as it stood; the conversion's line goes on
        // top when the conversion is done and can say what it did.
        timeline: goal.timeline,
      },
    );
    return epicId;
  });
}

// ----------------------------------------------------------- membership

function epicNoteEvent(text: string, at: string): TaskFileEvent {
  return {
    occurredAt: at,
    type: "note",
    actor: { kind: "system", systemId: CONVERSION_SYSTEM_ID },
    title: "Epic",
    text,
    toAgent: false,
    evidence: null,
  };
}

/** Put one existing task in its goal's epic and drop the retired `goalRef`.
 *  A task already in an epic keeps it. Returns whether the task joined. */
async function joinEpic(
  db: DatabaseSync,
  state: ProjectConversion,
  key: string,
  goal: LegacyGoal,
  epicId: string,
): Promise<boolean> {
  const { projectSlug, ctx } = state;
  const current = readTaskFile(taskRef(ctx, projectSlug, key))?.parsed;
  if (!current) return false;
  // Already in an epic with the retired key gone (an interrupted run moved
  // it): a write would only restamp the file behind its projection.
  if (current.frontmatter.epic !== null && !("goalRef" in current.unknownFrontmatter)) return false;
  let joined = false;
  let touched = false;
  await updateTaskFile(taskRef(ctx, projectSlug, key), (parsed) => {
    if ("goalRef" in parsed.unknownFrontmatter) {
      delete parsed.unknownFrontmatter.goalRef;
      touched = true;
    }
    if (parsed.frontmatter.epic !== null) return;
    parsed.frontmatter.epic = epicId;
    parsed.timeline.unshift(
      epicNoteEvent(
        `Added to **${epicId}** (${goal.title}): goal chains became epics, and ${goal.id}, the chain this task was part of, became ${epicId}.`,
        new Date().toISOString(),
      ),
    );
    joined = true;
    touched = true;
  });
  if (touched) reprojectTask(db, ctx, projectSlug, key);
  return joined;
}

// ------------------------------------------------------ unstarted links

interface Candidate {
  goal: LegacyGoal;
  link: LegacyLink;
  id: string;
}

/** Why a link was listed rather than made, as the epic's description says it. */
interface ListedLink {
  goal: LegacyGoal;
  link: LegacyLink;
  why: string;
}

function creatorMayCreateTasks(db: DatabaseSync, project: ProjectContext, goal: LegacyGoal): boolean {
  if (!goal.createdBy) return false;
  return resolveProjectAuthority(
    db,
    project,
    { userId: goal.createdBy, label: goal.createdByLabel || goal.createdBy },
    rolesForAction("create-task"),
    { action: "create-task", what: "carry a goal link into its epic", silentDeny: true },
  ).allowed;
}

/**
 * Write the key of the task just made for a link into the goal file, the way
 * the chain recorded a started link, so a conversion interrupted after this
 * point finds the link carried and never makes it twice. The goal file is
 * filed away at the end, and keeps saying which task carried each link.
 */
async function recordLinkTask(goal: LegacyGoal, index: number, key: string): Promise<void> {
  await withFileLock(goal.path, () => {
    const { data, body } = splitFrontmatterMapping(readFileSync(goal.path, "utf8"));
    const links = z.array(z.unknown()).catch([]).parse(data.links ?? []);
    data.links = links.map((raw) => {
      const link = yamlMappingSchema.safeParse(raw);
      if (!link.success || link.data.index !== index) return raw;
      const next: YamlMapping = { ...link.data, taskKey: key, status: "active" };
      return next;
    });
    const serialized = serializeFrontmatterFile(data, {}, body);
    writeAndRemember(goal.path, serialized);
  });
}

async function startLinkTask(
  db: DatabaseSync,
  state: ProjectConversion,
  candidate: Candidate,
  waits: string[],
): Promise<string> {
  const { projectSlug, ctx } = state;
  const { goal, link } = candidate;
  const epic = state.epics.get(goal.id);
  const authority = userDisplayName(db, goal.createdBy);
  const created = await createTask(
    db,
    {
      projectSlug,
      title: linkTitle(link),
      goal: link.goal.trim() || linkTitle(link),
      epic: epic?.epicId ?? null,
      blockedBy: waits,
      signedBy: {
        systemId: CONVERSION_SYSTEM_ID,
        assignText:
          `Made for link ${link.index} of ${goal.id} (${goal.title}) when goal chains became epics, ` +
          `on ${authority}'s authority, with ${authority} as owner. Agent runs on this task use the ` +
          `owner's own Claude and Codex accounts, and the owner is its human reviewer and acceptance ` +
          `authority.`,
      },
    },
    { userId: goal.createdBy, label: `${goal.createdByLabel || goal.createdBy} · epic conversion` },
    ctx,
  );
  await recordLinkTask(goal, link.index, created.key);
  link.taskKey = created.key;
  link.status = "active";
  return created.key;
}

/**
 * Make a task for every unstarted link of a chain that was still running.
 * Links wait on each other across the project's chains, so they are made in
 * the order their waits allow: a pass makes every link whose waits all name
 * existing work, and repeats while one did. A link left over waits on a link
 * that is never made, or on itself round a loop, and is listed instead.
 */
async function startUnstartedLinks(
  db: DatabaseSync,
  state: ProjectConversion,
  listed: ListedLink[],
): Promise<void> {
  const project = loadProjectContext(state.ctx, state.projectSlug);
  const candidates: Candidate[] = [];
  for (const goal of state.goals.values()) {
    const unstarted = goal.links.filter((l) => l.taskKey === null && l.status === "pending");
    if (unstarted.length === 0) continue;
    if (goal.status !== "active") {
      const why =
        goal.status === "cancelled"
          ? `${goal.id} was cancelled`
          : goal.status === "completed"
            ? `${goal.id} was complete`
            : goal.status === "attention"
              ? `${goal.id} was stopped for a decision`
              : `${goal.id} was paused`;
      for (const link of unstarted) listed.push({ goal, link, why });
      continue;
    }
    if (!creatorMayCreateTasks(db, project, goal)) {
      const who = goal.createdByLabel || goal.createdBy || "its creator";
      for (const link of unstarted) {
        listed.push({ goal, link, why: `${who} no longer holds task creation in this project` });
      }
      continue;
    }
    for (const link of unstarted) {
      const id = linkId(goal.id, link.index);
      candidates.push({ goal, link, id });
      state.creatable.add(id);
    }
  }

  let remaining = candidates;
  let progressed = true;
  while (progressed && remaining.length > 0) {
    progressed = false;
    const next: Candidate[] = [];
    for (const candidate of remaining) {
      const waits = candidate.link.blockedBy.map((entry) => translateWait(state, entry));
      if (waits.some((w) => w.kind === "later")) {
        next.push(candidate);
        continue;
      }
      progressed = true;
      state.creatable.delete(candidate.id);
      const gone = waits.find(isGone);
      if (gone) {
        listed.push({
          goal: candidate.goal,
          link: candidate.link,
          why: `it waited on ${gone.from}, which ${gone.why}`,
        });
        continue;
      }
      const keys = [...new Set(waits.flatMap((w) => (w.kind === "task" ? [w.key] : [])))];
      try {
        const key = await startLinkTask(db, state, candidate, keys);
        state.created.set(candidate.id, key);
      } catch (error) {
        logger.warn("an unstarted goal link could not become a task; it is listed on its epic", {
          projectSlug: state.projectSlug,
          link: candidate.id,
          err: toError(error),
        });
        listed.push({
          goal: candidate.goal,
          link: candidate.link,
          // The description adds the full stop.
          why: `making its task was refused: ${toError(error).message.replace(/\.+$/, "")}`,
        });
      }
    }
    remaining = next;
  }
  for (const candidate of remaining) {
    state.creatable.delete(candidate.id);
    listed.push({
      goal: candidate.goal,
      link: candidate.link,
      why: "it waited on another unstarted link round a loop",
    });
  }
}

// ----------------------------------------------------------------- waits

/** Respell one task's waits by task key: its `blockedBy`, and any goal link an
 *  option of its open decision names. */
async function rewriteWaits(db: DatabaseSync, state: ProjectConversion, scan: TaskScan): Promise<boolean> {
  const { projectSlug, ctx } = state;
  const ref = taskRef(ctx, projectSlug, scan.key);

  // The decision first, as text: the task parser drops an option whose wait
  // it cannot read, so the entry has to be respelled before anything parses
  // the file again. A link with no task left is taken off the option's list.
  const packetChanged = await withFileLock(taskFilePath(projectSlug, scan.key, ctx.dataRoot), () => {
    const file = taskFilePath(projectSlug, scan.key, ctx.dataRoot);
    const content = readFileSync(file, "utf8");
    const at = new Set(packetLegacyLines(content));
    if (at.size === 0) return false;
    const lines: string[] = [];
    // The list keys an item was taken from: one left with no item under it
    // would read as null, and the task parser drops the whole option then.
    const emptied = new Set<number>();
    content.split("\n").forEach((line, i) => {
      const m = at.has(i) ? PACKET_LINK_ITEM_RE.exec(line) : null;
      if (!m) {
        lines.push(line);
        return;
      }
      const wait = translateWait(state, m[3]!);
      if (wait.kind === "task") {
        lines.push(`${m[1]}${wait.key}`);
        return;
      }
      let owner = lines.length - 1;
      while (owner >= 0 && LIST_ITEM_RE.test(lines[owner]!)) owner -= 1;
      if (owner >= 0 && PACKET_LIST_KEY_RE.test(lines[owner]!)) emptied.add(owner);
    });
    for (const k of emptied) {
      const next = lines[k + 1];
      const hasItem = next !== undefined && LIST_ITEM_RE.test(next) && indentOf(next) >= indentOf(lines[k]!);
      if (!hasItem) lines[k] = `${lines[k]} []`;
    }
    const serialized = lines.join("\n");
    writeAndRemember(file, serialized);
    return true;
  });

  if (!scan.waits.some((entry) => parseLegacyLinkRef(entry) !== null)) {
    if (packetChanged) reprojectTask(db, ctx, projectSlug, scan.key);
    return packetChanged;
  }

  const clauses: string[] = [];
  const next: string[] = [];
  const legacyEntries: string[] = [];
  let dead = false;
  for (const entry of scan.waits) {
    const wait = translateWait(state, entry);
    if (wait.kind === "task") {
      if (!next.includes(wait.key)) next.push(wait.key);
      if (wait.from) {
        clauses.push(`${wait.from} is ${wait.key}`);
        legacyEntries.push(wait.from);
      }
    } else if (wait.kind === "settled") {
      clauses.push(`${wait.from} was skipped, so it is off the list`);
      legacyEntries.push(wait.from);
    } else if (isGone(wait)) {
      dead = true;
      clauses.push(`${wait.from} ${wait.why}, so it is off the list`);
      legacyEntries.push(wait.from);
    } else if (wait.kind === "later") {
      // Cannot outlive the pass that makes the links; read as never started.
      dead = true;
      clauses.push(`${wait.from} never became a task, so it is off the list`);
      legacyEntries.push(wait.from);
    }
  }
  const stages = loadProjectContext(ctx, projectSlug).stages;
  const at = new Date().toISOString();
  let released = false;
  await updateTaskFile(ref, (parsed) => {
    const fm = parsed.frontmatter;
    const lead = `Goal chains became epics, so what this task waits on is named by task now: ${clauses.join("; ")}.`;
    let tail: string;
    if (next.length > 0) {
      fm.blockedBy = next;
      tail = dead
        ? ` It waits on ${next.join(", ")}, and Viberr releases it when every entry is done, without ` +
          "the work that is off the list: edit what it waits on if it needs that work."
        : ` It waits on ${next.join(", ")}; Viberr releases it when every entry is done.`;
    } else if (dead) {
      // A wait that can never complete is a person's to settle (ruling
      // 131(e)), and so is this one: nothing is left to hold the task, and
      // nothing it waited on will ever happen.
      clearDependencies(parsed);
      if (fm.waiting === "none" && !fm.archived) fm.waiting = "human";
      tail =
        " Nothing it waited on can happen now, so it waits for you: give it other work to wait on, " +
        "or move it on.";
    } else {
      clearDependencies(parsed);
      // The engine's own rule: a task already done or archived is cleared
      // quietly, since nothing is left for it to move on to.
      released = !fm.archived && !isTerminalStage(fm.stage, stages);
      tail = "";
    }
    parsed.timeline.unshift({
      occurredAt: at,
      type: "note",
      actor: { kind: "system", systemId: CONVERSION_SYSTEM_ID },
      title: "Waits on other work",
      text: lead + tail,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, projectSlug, scan.key);
  if (released) {
    // Everything it waited on was settled, as the chain counted it: the same
    // release the engine gives a satisfied wait. Not awaited: the operator
    // turn it hands the task to runs off the boot path.
    void announceRelease(db, ctx, projectSlug, scan.key, { entries: legacyEntries }).catch((error) => {
      logger.warn("a task freed by the goal-to-epic conversion could not be released", {
        projectSlug,
        taskKey: scan.key,
        err: toError(error),
      });
    });
  }
  return true;
}

// -------------------------------------------------------------- finishing

/** The epic's description: the goal's, then the links that never became a
 *  task, with their text, so a person can make them one. */
function describeEpic(goal: LegacyGoal, listed: readonly ListedLink[], state: ProjectConversion): string {
  const own = listed.filter((l) => l.goal.id === goal.id);
  if (own.length === 0) return goal.description;
  const items = own.map(({ link, why }) => {
    const text = link.goal.trim();
    const waits = link.blockedBy.map((entry) => {
      const wait = translateWait(state, entry);
      return wait.kind === "task" ? wait.key : entry;
    });
    const lines = [`- **Link ${link.index}: ${linkTitle(link)}.** Not made a task because ${why}.`];
    if (waits.length > 0) lines.push(`  It waited on ${waits.join(", ")}.`);
    if (text && text !== linkTitle(link)) {
      lines.push("", ...text.split("\n").map((line) => (line.trim() ? `  ${line}` : "")));
    }
    return lines.join("\n");
  });
  const head = `**Not started when ${goal.id} became this epic.** Make any of these a task in this epic when the work is wanted.`;
  return [goal.description, head, ...items].filter((part) => part.trim() !== "").join("\n\n");
}

function conversionLine(goal: LegacyGoal, epicTasks: number, started: readonly string[], listed: number): string {
  const parts = [
    `Converted from ${goal.id} (${goal.title}) when goal chains became epics, holding ${countLabel(epicTasks, "task")}.`,
  ];
  if (goal.status === "attention") {
    parts.push("The chain was stopped for a decision, so the epic starts paused.");
  } else if (goal.status === "paused") {
    parts.push("The chain was paused, so the epic starts paused.");
  }
  if (started.length > 0) {
    parts.push(
      `${joinDependencyEntries(started)} ${started.length === 1 ? "was" : "were"} made for links that had not started, ` +
        "each waiting on what its link waited on.",
    );
  }
  if (listed > 0) {
    parts.push(
      `${countLabel(listed, "unstarted link")} ${listed === 1 ? "is" : "are"} listed in the description.`,
    );
  }
  return parts.join(" ");
}

const convertedAuditRow = z.object({ n: z.number() });

async function finishGoal(
  db: DatabaseSync,
  state: ProjectConversion,
  goal: LegacyGoal,
  listed: readonly ListedLink[],
  started: readonly string[],
  out: GoalEpicConversion,
): Promise<void> {
  const { projectSlug, ctx } = state;
  const epic = state.epics.get(goal.id);
  if (!epic) return;
  const { epicId } = epic;
  const members = epicTaskKeys(db, projectSlug, epicId);
  const listedHere = listed.filter((l) => l.goal.id === goal.id).length;
  const line = conversionLine(goal, members.length, started, listedHere);
  const marker = `Converted from ${goal.id} `;
  await updateEpicFile({ projectSlug, epicId, dataRoot: ctx.dataRoot }, (file) => {
    file.description = describeEpic(goal, listed, state);
    if (file.timeline.some((entry) => entry.text.startsWith(marker))) return;
    return line;
  });
  rebuildEpicFile(db, projectSlug, epicId, { dataRoot: ctx.dataRoot });

  const already = convertedAuditRow.parse(
    db
      .prepare(
        `SELECT count(*) AS n FROM audit_events
          WHERE action = 'epic.converted' AND project_slug = ? AND subject_id = ?`,
      )
      .get(projectSlug, epicId),
  ).n;
  if (already === 0) {
    recordAudit(db, {
      action: "epic.converted",
      actor: CONVERSION_AUDIT_ACTOR,
      subjectKind: "epic",
      subjectId: epicId,
      projectSlug,
      details: { title: goal.title, from: goal.id, total: members.length },
    });
  }

  // A notice that opened the goal on the Controller page opens its epic.
  const oldAnchor = `/projects/${projectSlug}/controller#${goal.id}`;
  db.prepare(
    `UPDATE notifications SET href = ?
      WHERE project_slug = ? AND (href = ? OR href LIKE ?)`,
  ).run(epicLink(projectSlug, epicId), projectSlug, oldAnchor, `${oldAnchor}-link-%`);

  // Filed, not deleted: the goal file is the record of the chain, and filing
  // it is what marks the conversion done.
  const convertedDir = path.join(path.dirname(goal.path), "converted");
  mkdirSync(convertedDir, { recursive: true });
  const target = path.join(convertedDir, `${goal.id}.md`);
  renameSync(
    goal.path,
    existsSync(target) ? path.join(convertedDir, `${goal.id}-${Date.now()}.md`) : target,
  );

  out.converted.push({
    projectSlug,
    goalId: goal.id,
    epicId,
    tasks: members.length,
    started: [...started],
    listed: listedHere,
  });
}

// ------------------------------------------------------------------ run

async function convertProject(
  db: DatabaseSync,
  projectSlug: string,
  ctx: TaskMutationContext,
  out: GoalEpicConversion,
): Promise<void> {
  const dir = retiredGoalsDir(projectSlug, ctx.dataRoot);
  const ids = goalFileIds(dir);
  if (ids.length === 0) return;
  const state: ProjectConversion = {
    projectSlug,
    ctx,
    goals: new Map(),
    filed: new Map(),
    epics: new Map(),
    creatable: new Set(),
    created: new Map(),
  };
  // A goal that cannot be read is left for a person to fix, and so is
  // everything naming it: its tasks keep their `goalRef`, and a wait on one of
  // its links keeps its spelling until the next boot can read the goal.
  const unreadable = new Set<string>();
  for (const goalId of ids) {
    const goal = readLegacyGoal(dir, goalId);
    if (goal) state.goals.set(goalId, goal);
    else {
      unreadable.add(goalId);
      out.failed.push({ projectSlug, goalId, reason: "its frontmatter could not be read" });
    }
  }
  if (state.goals.size === 0) return;
  const filedDir = path.join(dir, "converted");
  for (const goalId of goalFileIds(filedDir)) {
    const goal = readLegacyGoal(filedDir, goalId);
    if (goal && !state.goals.has(goalId)) state.filed.set(goalId, goal);
  }

  const scans = projectTaskKeys(projectSlug, ctx.dataRoot).flatMap((key) => {
    const scan = scanTask(projectSlug, key, ctx.dataRoot);
    return scan ? [scan] : [];
  });

  // 1. An epic for every goal.
  for (const goal of state.goals.values()) {
    const epicId = await ensureEpic(state, goal);
    state.epics.set(goal.id, { epicId, title: goal.title });
    rebuildEpicFile(db, projectSlug, epicId, { dataRoot: ctx.dataRoot });
  }

  // 2. The links that had not started.
  const listed: ListedLink[] = [];
  await startUnstartedLinks(db, state, listed);

  // 3. Waits, by task key. Before any task is joined: the task parser drops
  // a wait it cannot read, and the option holding one, so the first parse
  // and write of a task file must come after its old spellings are gone.
  for (const scan of scans) {
    if (scan.legacyGoals.size === 0) continue;
    if ([...scan.legacyGoals].some((goalId) => unreadable.has(goalId))) continue;
    try {
      if (await rewriteWaits(db, state, scan)) out.rewrittenWaits.push(`${projectSlug}/${scan.key}`);
    } catch (error) {
      logger.warn("a task's goal-link waits could not be respelled", {
        projectSlug,
        taskKey: scan.key,
        err: toError(error),
      });
    }
  }

  // 4. The tasks the chains already made, and every task naming a goal.
  for (const goal of state.goals.values()) {
    const epicId = state.epics.get(goal.id)!.epicId;
    const keys = new Set<string>();
    for (const link of goal.links) if (link.taskKey) keys.add(link.taskKey);
    for (const scan of scans) if (scan.goalId === goal.id) keys.add(scan.key);
    for (const key of keys) {
      try {
        await joinEpic(db, state, key, goal, epicId);
      } catch (error) {
        // A file the writer will not trust is the store doctor's to name;
        // the rest of the epic still converts.
        logger.warn("a task could not join the epic its goal became", {
          projectSlug,
          taskKey: key,
          epicId,
          err: toError(error),
        });
      }
    }
  }
  // A `goalRef` naming a goal this project no longer has joins nothing, and
  // still leaves the file.
  for (const scan of scans) {
    if (!scan.goalId || state.goals.has(scan.goalId) || unreadable.has(scan.goalId)) continue;
    try {
      await updateTaskFile(taskRef(ctx, projectSlug, scan.key), (parsed) => {
        delete parsed.unknownFrontmatter.goalRef;
      });
      reprojectTask(db, ctx, projectSlug, scan.key);
    } catch (error) {
      logger.warn("a task's retired goalRef could not be removed", {
        projectSlug,
        taskKey: scan.key,
        err: toError(error),
      });
    }
  }

  // 5. Each epic says what it became, and the goal file is filed away.
  for (const goal of state.goals.values()) {
    const started = [...state.created]
      .filter(([id]) => id.startsWith(`${goal.id} link `))
      .map(([, key]) => key);
    try {
      await finishGoal(db, state, goal, listed, started, out);
    } catch (error) {
      out.failed.push({ projectSlug, goalId: goal.id, reason: toError(error).message });
    }
  }
}

/**
 * Boot: convert every goal file still in a project's `goals/` directory.
 * After the rescan (task rows exist to validate waits against) and before
 * the watcher. A project that fails is logged and left for the next boot;
 * the others convert.
 */
export async function convertGoalsToEpics(
  db: DatabaseSync,
  options: { dataRoot?: string } = {},
): Promise<GoalEpicConversion> {
  const out: GoalEpicConversion = { converted: [], rewrittenWaits: [], failed: [] };
  const root = projectsDir(options.dataRoot);
  if (!existsSync(root)) return out;
  const slugs = readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && !entry.name.startsWith(".") ? [entry.name] : [],
  );
  for (const projectSlug of slugs) {
    if (!existsSync(projectFilePath(projectSlug, options.dataRoot))) continue;
    try {
      await convertProject(db, projectSlug, { dataRoot: options.dataRoot }, out);
    } catch (error) {
      logger.error("goal-to-epic conversion failed for a project; it is retried on the next boot", {
        projectSlug,
        err: toError(error),
      });
    }
  }
  if (out.converted.length > 0) {
    logger.info("converted goal chains into epics", {
      epics: out.converted.map(
        (c) =>
          `${c.projectSlug}/${c.goalId} -> ${c.epicId} (${countLabel(c.tasks, "task")}` +
          `${c.started.length ? `, made ${c.started.join(", ")}` : ""}` +
          `${c.listed ? `, ${c.listed} listed` : ""})`,
      ),
      rewrittenWaits: out.rewrittenWaits,
    });
  }
  if (out.failed.length > 0) {
    logger.warn("some goal files were not converted; they stay in goals/ for the next boot", {
      goals: out.failed.map((f) => `${f.projectSlug}/${f.goalId}: ${f.reason}`),
    });
  }
  return out;
}
