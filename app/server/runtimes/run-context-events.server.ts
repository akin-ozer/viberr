import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import {
  resolveTaskFilePath,
  updateTaskFile,
  type TaskFileRef,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import type { RunSpec } from "./adapter.server";
import type { EnvelopeFacts } from "./wire-format.server";

/**
 * Ruling 369: a context compaction is a governed fact about a run — the
 * provider replaced the conversation with a summary, and what the agent knows
 * from here on is the system prompt, the summary and the anchor it was handed
 * back — so it leaves an audit row, and on a task run a timeline note a
 * supervisor scanning the record can see. A controller turn has no task file;
 * its audit row and the run's own console line are the record (ruling 99).
 *
 * Best-effort like the continuity notes in the run service: a task file that
 * cannot be written must never fail the line that reported the compaction.
 */
export const RUN_COMPACTION_AUDIT_ACTION = "task.agent.compaction";

function k(n: number): string {
  return `${(n / 1000).toFixed(0)}k`;
}

/** The sentence the timeline carries. */
export function compactionNoteText(
  agent: string,
  compaction: NonNullable<EnvelopeFacts["compaction"]>,
  anchored: boolean,
): string {
  const sizes =
    compaction.preTokens !== null
      ? ` from ${k(compaction.preTokens)} to ${compaction.postTokens !== null ? k(compaction.postTokens) : "a summary"} tokens`
      : "";
  return (
    `Context compacted: the provider summarized ${agent}'s conversation${sizes} (${compaction.trigger}). ` +
    "Its persona and knowledge-base indexes are unchanged; tool output and reasoning before this point " +
    "survive only as the summary" +
    (anchored
      ? ", and Viberr re-injected the task anchor (task.md, branch, PR, knowledge bases) so it re-reads the record before it continues."
      : ".")
  );
}

export function noteRunCompaction(
  db: DatabaseSync,
  spec: RunSpec,
  agentName: string | null,
  compaction: NonNullable<EnvelopeFacts["compaction"]>,
  occurredAt: string,
  dataRoot?: string,
): void {
  const agent = agentName ?? spec.role;
  recordAudit(db, {
    action: RUN_COMPACTION_AUDIT_ACTION,
    actor: SYSTEM_ACTOR,
    subjectKind: "run",
    subjectId: spec.runId,
    projectSlug: spec.projectSlug,
    taskKey: spec.taskKey,
    details: {
      kind: spec.kind,
      backend: spec.backend,
      trigger: compaction.trigger,
      preTokens: compaction.preTokens,
      postTokens: compaction.postTokens,
      anchored: Boolean(spec.compactAnchor),
    },
  });
  // Ruling 99: a controller turn has no task file to note on.
  if (spec.kind === "controller" || !spec.projectSlug) return;
  const ref: TaskFileRef = { projectSlug: spec.projectSlug, taskKey: spec.taskKey };
  if (dataRoot) ref.dataRoot = dataRoot;
  const text = compactionNoteText(agent, compaction, Boolean(spec.compactAnchor));
  void updateTaskFile(ref, (parsed) => {
    parsed.timeline.unshift({
      occurredAt,
      type: "note",
      actor: { kind: "system", systemId: "runtime-continuity" },
      title: "Context compacted",
      text,
      toAgent: false,
      evidence: null,
    });
  })
    .then(() => {
      rebuildPath(db, resolveTaskFilePath(ref), dataRoot ? { dataRoot } : {});
    })
    .catch((error) => {
      logger.error("compaction timeline note failed", {
        runId: spec.runId,
        taskKey: spec.taskKey,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    });
}
