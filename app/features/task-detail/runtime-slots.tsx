import { AgentLogsPanel, LiveRunPanel } from "~/features/runtime/runs-panels";
import type { RunView } from "~/features/runtime/runtime-types";
import type { StreamedLine } from "~/features/runtime/use-run-log-stream";

/**
 * ═══════════════════ PHASE 8 MOUNT POINTS (runs.jsx port) ═══════════════════
 *
 * The task-detail layout order is a load-bearing contract (task-detail spec
 * §2): hero → LIVE RUN STRIP → decision packet → execution profile →
 * AGENT LOGS → timeline. These two slots hold the runtime positions.
 *
 * The dedicated run-log SSE consumer + the interrupt fetcher live in the
 * parent (TaskDetailPage); these slots are thin adapters passing the shared
 * `runtime` + live `linesByThread` into the ported panels. `logSel` is the
 * parent-held agent-logs thread selection (spec §4.10 wiring); the strip's
 * "View logs" calls `onLogSel`.
 */

export function LiveRunSlot({
  runtime,
  onViewLogs,
  onInterrupt,
  canInterrupt,
  interrupting,
}: {
  runtime: RunView[];
  onViewLogs: (id: string) => void;
  onInterrupt: (runId: string) => void;
  canInterrupt: boolean;
  interrupting: boolean;
}) {
  if (runtime.length === 0) return null;
  return (
    <LiveRunPanel
      runtime={runtime}
      onViewLogs={onViewLogs}
      onInterrupt={onInterrupt}
      canInterrupt={canInterrupt}
      interrupting={interrupting}
    />
  );
}

export function AgentLogsSlot({
  runtime,
  logSel,
  onLogSel,
  linesByThread,
  onRetryBackend,
  retrying,
}: {
  runtime: RunView[];
  /** Parent-held agent-logs thread selection (spec §4.10 wiring). */
  logSel: string | null;
  onLogSel: (id: string | null) => void;
  linesByThread: Record<string, StreamedLine[]>;
  /** Retry the failed run's agent (primary or reviewer) on the other backend (D4). */
  onRetryBackend?: (backend: "claude" | "codex", run: RunView) => void;
  retrying?: boolean;
}) {
  // Suppress the panel entirely (incl. the mock's empty state) only when the
  // task has never had any runtime thread — matches the mock: VIB-166/168.
  if (runtime.length === 0) return null;
  return (
    <AgentLogsPanel
      runtime={runtime}
      sel={logSel}
      onSel={onLogSel}
      linesByThread={linesByThread}
      {...(onRetryBackend ? { onRetryBackend } : {})}
      retrying={retrying ?? false}
    />
  );
}
