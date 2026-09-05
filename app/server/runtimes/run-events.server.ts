import type { RunState } from "~/features/runtime/runtime-types";
import {
  publishConversationUpdated,
  type ControllerRunRoute,
} from "~/server/controller/controller-conversations.server";
import { publishSseEvent } from "~/server/events/sse-broker.server";

/**
 * Direct-to-broker publishers for the high-frequency runtime stream
 * (phase-6 report §"High-frequency streams"). These do NOT go through the
 * projection emitter — that path implies "a projection changed" and would
 * tempt a rebuild per log line. Payloads are reference-only (runId + seq);
 * the dedicated logs consumer fetches content.
 *
 * Two routes. A task run's frames are scoped to its task. A CONTROLLER run
 * (ruling 99) has no task scope — `project_slug = ''`, the conversation id
 * standing in for a task key — so its frames route to the conversation
 * owner's `user` stream instead, as `controller.log-appended` (the console
 * tails it) and `controller.updated` (the page revalidates on it). The caller
 * resolves that route once per run (`controllerRunRoute`); a controller run
 * that arrives here WITHOUT one publishes nothing, because an empty slug is
 * not a harmless one: `routeMatchesConnection` matches every `projects`
 * firehose on any defined slug, and the wire schema refuses it anyway.
 */

export function publishRunLogAppended(input: {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  seq: number;
  /** Ruling 99: set for a controller run; its frames go to the owner. */
  controller?: ControllerRunRoute | null;
}): void {
  if (input.controller) {
    publishSseEvent(
      {
        type: "controller.log-appended",
        entityId: input.controller.conversationId,
        occurredAt: new Date().toISOString(),
        data: {
          conversationId: input.controller.conversationId,
          userId: input.controller.userId,
          runId: input.runId,
          threadId: input.threadId,
          seq: input.seq,
        },
      },
      { userId: input.controller.userId },
    );
    return;
  }
  if (input.projectSlug === "") return;
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
    // Ruling-free perf fix (owner, 2026-09-06): keep project- and task-scoped
    // delivery exactly as it is — a board showing this task is a legitimate
    // recipient and that is pinned — but keep this OFF the all-projects
    // firehose. It is one reference per console line, and Home subscribes
    // `projects`, so a single agent run was re-running Home's loaders once per
    // line of output. `run.state-changed` stays on the firehose: that one is a
    // real project fact and fires a handful of times per run.
    { projectSlug: input.projectSlug, taskKey: input.taskKey, skipFirehose: true },
  );
}

export function publishRunStateChanged(input: {
  projectSlug: string;
  taskKey: string;
  runId: string;
  threadId: string;
  state: RunState;
  /** Ruling 99: set for a controller run; the owner's page revalidates. */
  controller?: ControllerRunRoute | null;
}): void {
  if (input.controller) {
    // The lifecycle rides the loader, not the frame: the controller page
    // already revalidates on the conversation reference, and the run strip
    // reads the run row it gets back. One event name for the surface to
    // listen on, whatever changed.
    publishConversationUpdated(input.controller.conversationId, input.controller.userId);
    return;
  }
  if (input.projectSlug === "") return;
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
