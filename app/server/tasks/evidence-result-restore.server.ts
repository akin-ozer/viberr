import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  normalizeEvidenceRows,
  type EvidenceRow,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 639, once at boot: a result the old 40-character cap cut gets back
 * the words its run reported.
 *
 * Until ruling 639 the writer kept 39 characters of an evidence row's result
 * and an ellipsis, and the task file is the row's only copy, so a verdict read
 * "The proposed pay-as-you-go default list…" on every surface. The run's own
 * report still holds the sentence in its log: a Codex run's final envelope (an
 * `agent_message` whose text is the outcome JSON) and a Claude run's
 * `report_outcome` calls. A cut row takes the result of the run that wrote its
 * event: the same task, the same agent profile, finished at most ten minutes
 * before the event (the settle writes it) and two after (the clock the settle
 * stamps with), nearest first. That run must report one result for the row's
 * label, starting with the 39 characters the file kept; a run that reported
 * two different ones for it leaves the row as it is. The result is normalized
 * as a new row is (`normalizeEvidenceRows`), so it reads as one written today.
 *
 * After the rescan (the event rows exist) and before the watcher (no
 * concurrent writer). Each task file is written once, under its lock, and
 * keeps its `updatedAt`: the task did not change, its file regained words a
 * write had cut. A restored row is no longer cut, so a second boot reads only
 * what it could not restore. Returns how many rows it restored.
 */

/** What the old cap left of a longer result: 39 characters and the ellipsis. */
const OLD_RESULT_CAP = 40;
/** How long before its event a run may have finished and still have written it. */
const RUN_BEFORE_MS = 10 * 60_000;
/** How long after: the settle stamps the event with its own clock. */
const RUN_AFTER_MS = 2 * 60_000;

const taskRowSchema = z.object({ project_slug: z.string(), task_key: z.string() });
const runRowSchema = z.object({ id: z.string(), finished_at: z.string() });
const logRowSchema = z.object({ raw_json: z.string() });

/** A cell of a reported row as the log holds it, before the normalizer reads it. */
const reportedRowsSchema = z.array(
  z.object({ label: z.unknown(), result: z.unknown(), status: z.unknown() }).partial(),
);
/** A Codex run's final message, whose text is the outcome envelope. */
const codexMessageSchema = z.object({
  type: z.literal("item.completed"),
  item: z.object({ type: z.literal("agent_message"), text: z.string() }),
});
const envelopeSchema = z.object({ evidence: reportedRowsSchema });
/** A Claude run's assistant turn, whose `report_outcome` calls carry the rows. */
const claudeTurnSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});
const reportLineSchema = z.discriminatedUnion("type", [codexMessageSchema, claudeTurnSchema]);
const reportCallSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string().endsWith("report_outcome"),
  input: envelopeSchema,
});

function isCut(result: string): boolean {
  return result.length === OLD_RESULT_CAP && result.endsWith("…");
}

/** `text` read as one shape, or null when it is not JSON or another shape. */
function parsedAs<S extends z.ZodType>(schema: S, text: string): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every set of rows one run reported, normalized as a new row is. */
function reportedRows(db: DatabaseSync, runId: string): EvidenceRow[][] {
  const reports: EvidenceRow[][] = [];
  const keep = (rows: z.infer<typeof reportedRowsSchema>) => {
    const normalized = normalizeEvidenceRows(rows);
    if (normalized) reports.push(normalized);
  };
  const lines = db
    .prepare(`SELECT raw_json FROM run_log_lines WHERE run_id = ? AND raw_json LIKE '%evidence%' ORDER BY seq`)
    .all(runId);
  for (const row of lines) {
    const line = parsedAs(reportLineSchema, logRowSchema.parse(row).raw_json);
    if (!line) continue;
    if (line.type === "item.completed") {
      const envelope = parsedAs(envelopeSchema, line.item.text);
      if (envelope) keep(envelope.evidence);
      continue;
    }
    for (const block of line.message.content) {
      const call = reportCallSchema.safeParse(block);
      if (call.success) keep(call.data.input.evidence);
    }
  }
  return reports;
}

/** One cut row's restored words, keyed by where it stands in the file. */
interface Restoration {
  occurredAt: string;
  index: number;
  label: string;
  cut: string;
  whole: string;
}

/** The cut rows of one task's timeline that a run's report restores. */
function restorationsFor(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
  timeline: readonly TaskFileEvent[],
): Restoration[] {
  const runs = db
    .prepare(
      `SELECT id, finished_at FROM agent_runs
        WHERE project_slug = ? AND task_key = ? AND agent_profile_id = ? AND finished_at IS NOT NULL`,
    );
  const reportsByRun = new Map<string, EvidenceRow[][]>();
  const reportsOf = (runId: string) => {
    const known = reportsByRun.get(runId);
    if (known) return known;
    const read = reportedRows(db, runId);
    reportsByRun.set(runId, read);
    return read;
  };
  const out: Restoration[] = [];
  for (const event of timeline) {
    if (event.actor.kind !== "agent" || !event.evidence?.some((row) => isCut(row.result))) continue;
    const at = Date.parse(event.occurredAt);
    const nearest = runs
      .all(projectSlug, taskKey, event.actor.profileId)
      .map((row) => runRowSchema.parse(row))
      .filter((run) => {
        const finished = Date.parse(run.finished_at);
        return finished >= at - RUN_BEFORE_MS && finished <= at + RUN_AFTER_MS;
      })
      .sort((a, b) => Math.abs(Date.parse(a.finished_at) - at) - Math.abs(Date.parse(b.finished_at) - at));
    event.evidence.forEach((row, index) => {
      if (!isCut(row.result)) return;
      const stem = row.result.slice(0, -1);
      for (const run of nearest) {
        const wholes = new Set<string>();
        for (const report of reportsOf(run.id)) {
          for (const reported of report) {
            if (reported.label !== row.label) continue;
            if (reported.result.length > OLD_RESULT_CAP && reported.result.startsWith(stem)) {
              wholes.add(reported.result);
            }
          }
        }
        if (wholes.size === 0) continue;
        // Two different sentences for one label: neither is surely the one.
        if (wholes.size === 1) {
          out.push({ occurredAt: event.occurredAt, index, label: row.label, cut: row.result, whole: [...wholes][0]! });
        }
        return;
      }
    });
  }
  return out;
}

/** The count carried out of the locked mutator. */
interface RestoredSlot {
  rows: number;
}

export async function restoreCutEvidenceResults(
  db: DatabaseSync,
  ctx: TaskMutationContext = {},
): Promise<number> {
  // The projection's copy of each file finds the tasks; the file decides.
  const tasks = db
    .prepare(`SELECT DISTINCT project_slug, task_key FROM task_events WHERE evidence_json LIKE '%…%'`)
    .all()
    .map((row) => taskRowSchema.parse(row));
  let restored = 0;
  for (const { project_slug: projectSlug, task_key: taskKey } of tasks) {
    try {
      const ref = taskRef(ctx, projectSlug, taskKey);
      const file = readTaskFile(ref);
      if (!file) continue;
      const restorations = restorationsFor(db, projectSlug, taskKey, file.parsed.timeline);
      if (restorations.length === 0) continue;
      const slot: RestoredSlot = { rows: 0 };
      await updateTaskFile(
        ref,
        (parsed) => {
          for (const fix of restorations) {
            const event = parsed.timeline.find((e) => e.occurredAt === fix.occurredAt);
            const row = event?.evidence?.[fix.index];
            // Re-read under the lock: only the row as it was measured changes.
            if (!event?.evidence || !row || row.label !== fix.label || row.result !== fix.cut) continue;
            event.evidence[fix.index] = { ...row, result: fix.whole };
            slot.rows += 1;
          }
        },
        { stamp: false },
      );
      reprojectTask(db, ctx, projectSlug, taskKey);
      restored += slot.rows;
    } catch (error) {
      logger.error("restoring cut evidence results failed", {
        projectSlug,
        taskKey,
        err: toError(error),
      });
    }
  }
  if (restored > 0) {
    logger.info("evidence results restored from their runs' reports", { rows: restored });
  }
  return restored;
}
