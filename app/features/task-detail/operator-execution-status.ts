import type { RunState } from "~/features/runtime/runtime-types";

/** Client-safe operator status shown by the task-detail execution profile. */
export type OperatorExecutionStatus =
  | "not_configured"
  | "configured"
  | "engaged"
  | "queued"
  | "running"
  | "finished"
  | "failed"
  | "interrupted";

export type OperatorDispatchExecutionState = Extract<
  OperatorExecutionStatus,
  "queued" | "running" | "finished" | "failed" | "interrupted"
>;

export interface OperatorExecutionStatusInput {
  runLifecycle: RunState | null;
  dispatchState: OperatorDispatchExecutionState | null;
  engaged: boolean;
  configured: boolean;
}

function runStatus(lifecycle: RunState): OperatorDispatchExecutionState {
  return lifecycle === "error" ? "failed" : lifecycle;
}

function isActive(
  status: OperatorDispatchExecutionState | null,
): status is "queued" | "running" {
  return status === "queued" || status === "running";
}

/**
 * Resolve the display status without hiding precedence in the route loader:
 * active run > active dispatch > last run > last dispatch > engagement >
 * configured deployment > no deployment.
 */
export function resolveOperatorExecutionStatus(
  input: OperatorExecutionStatusInput,
): OperatorExecutionStatus {
  const latestRun = input.runLifecycle
    ? runStatus(input.runLifecycle)
    : null;

  if (isActive(latestRun)) return latestRun;
  if (isActive(input.dispatchState)) return input.dispatchState;
  if (latestRun) return latestRun;
  if (input.dispatchState) return input.dispatchState;
  if (input.engaged) return "engaged";
  if (input.configured) return "configured";
  return "not_configured";
}
