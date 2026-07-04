/**
 * ═══════════════════ PHASE 8 MOUNT POINTS (runs.jsx port) ═══════════════════
 *
 * The task-detail layout order is a load-bearing contract (task-detail spec
 * §2): hero → LIVE RUN STRIP → decision packet → execution profile →
 * AGENT LOGS → timeline. These two slots hold the runtime positions so
 * Phase 8 mounts LiveRunPanel / AgentLogsPanel without touching the layout.
 *
 * Contract (spec §4.10):
 *   - LiveRunSlot → LiveRunPanel({ runtime, onViewLogs, push }): renders
 *     null unless some run has state === "running"; its "View logs" button
 *     calls onViewLogs(run.id) which must set the parent-held `logSel`.
 *   - AgentLogsSlot → AgentLogsPanel({ runtime, sel, onSel }): per-agent log
 *     console; the parent (TaskDetailPage) already holds the `logSel`
 *     selection state + setter these props wire into.
 *
 * Until the runtime registry exists there is NO runtime data source, so both
 * slots render nothing (per the Phase-5 brief — not even the mock's
 * "No agent runs yet" empty state; that copy ships with the real panel).
 * Phase 6's SSE revalidation and Phase 8's run streams feed these through
 * the task route loader (add a `runtime` field there).
 */

export function LiveRunSlot({ taskKey: _taskKey }: { taskKey: string }) {
  return null;
}

export function AgentLogsSlot({
  taskKey: _taskKey,
  logSel: _logSel,
  onLogSel: _onLogSel,
}: {
  taskKey: string;
  /** Parent-held agent-logs thread selection (spec §4.10 wiring). */
  logSel: string | null;
  onLogSel: (id: string | null) => void;
}) {
  return null;
}
