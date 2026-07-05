import type { RunState } from "~/features/runtime/runtime-types";
import { publishSseEvent } from "~/server/events/sse-broker.server";

/**
 * Direct-to-broker publishers for the high-frequency runtime stream
 * (phase-6 report §"High-frequency streams"). These do NOT go through the
 * projection emitter — that path implies "a projection changed" and would
 * tempt a rebuild per log line. Payloads are reference-only (runId + seq);
 * the dedicated logs consumer fetches content. Both are scoped to the task.
 */

export function publishRunLogAppended(input: {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  seq: number;
}): void {
  publishSseEvent(
    {
      type: "run.log-appended",
      entityId: `${input.projectSlug}/${input.taskKey}`,
      occurredAt: new Date().toISOString(),
      data: {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        runId: input.runId,
        threadId: input.threadId,
        seq: input.seq,
      },
    },
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
  );
}

export function publishRunStateChanged(input: {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  state: RunState;
}): void {
  publishSseEvent(
    {
      type: "run.state-changed",
      entityId: `${input.projectSlug}/${input.taskKey}`,
      occurredAt: new Date().toISOString(),
      data: {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        runId: input.runId,
        threadId: input.threadId,
        state: input.state,
      },
    },
    { projectSlug: input.projectSlug, taskKey: input.taskKey },
  );
}
