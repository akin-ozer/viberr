import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import type { RunSpec } from "./adapter.server";
import type { EnvelopeFacts } from "./wire-format.server";

/**
 * Ruling 369: a context compaction is a governed fact about a run — the
 * provider replaced the conversation with a summary, and what the agent knows
 * from here on is the system prompt, the summary and the anchor it was handed
 * back — so it leaves an audit row. The run's console carries it too (its
 * `compact_boundary` / `run·compacted·completion` line and the facts row's
 * compaction count).
 *
 * Ruling 490: it no longer writes a "Context compacted" note on the task's
 * timeline. The owner read it as noise on the thread: housekeeping about the
 * agent's memory, sitting between the messages a person reads the task by.
 */
const RUN_COMPACTION_AUDIT_ACTION = "task.agent.compaction";

export function recordRunCompaction(
  db: DatabaseSync,
  spec: RunSpec,
  compaction: NonNullable<EnvelopeFacts["compaction"]>,
): void {
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
}
