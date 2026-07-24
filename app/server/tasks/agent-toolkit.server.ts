import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { encodeActorRef, agentRoleDisplay } from "~/server/files/actor-ref.server";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  buildAgentQuestionPacket,
  stageOutcome,
  type AgentCollab,
} from "./agent-outcome.server";
import { normalizeEscapedNewlines } from "./model-prose.server";
import { notifyMentionedUsers } from "./mention-notify.server";
import { createActorResolver } from "~/shared/mapping/actor.server";
import {
  notifyTaskWatchers,
  reprojectTask,
  taskRef,
  type TaskMutationContext,
} from "./task-actions.server";

/**
 * The generic agent's in-process collaboration TOOLS (generic-agents G3) — a
 * Claude Agent SDK MCP server ("viberr_agent") mirroring the operator-toolkit
 * pattern: handlers close over the DB + task context and write through scoped
 * functions with the AGENT'S OWN attribution. Never the `operatorAuthorized`
 * boolean (R7): each tool is its own narrow authority, gated by the profile's
 * capability grants at build time — an ungranted capability's tool is not even
 * built.
 *
 *   post_comment   → comment-on-task          (immediate agent-authored comment)
 *   ask_human      → ask-human                (opens a question decision packet)
 *   report_outcome → report-validation-verdict (stages the outcome envelope —
 *                    recorded ATOMICALLY with the reply at completion)
 *
 * Codex runs cannot mount these (the codex SDK ignores tool policy and its
 * MCP config leaks credentials into argv) — they get the same envelope through
 * `outputSchema` on the final reply instead (agent-outcome.server.ts).
 */

export interface AgentToolkit {
  /** `{ viberr_agent: <sdk mcp server> }` — merge into the run's mcpServers. */
  mcpServers: Record<string, unknown>;
}

interface AgentToolkitDeps {
  db: DatabaseSync;
  ctx: TaskMutationContext;
  projectSlug: string;
  taskKey: string;
  /** The agent's own actor ref — every write is attributed to it (D8). */
  actorRef: FileActorRef;
  /** Staging key for report_outcome (threaded to the completion input). */
  outcomeKey: string;
  collab: AgentCollab;
}

const prose = normalizeEscapedNewlines;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Post an agent-authored timeline comment NOW (mid-run progress/finding).
 * Scoped write: guardrail-light (the anti-noise guardrails govern the final
 * reply; a deliberate mid-run tool call is already intentional), audited as
 * task.agent.commented with the agent's identity. */
export async function postAgentComment(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    actorRef: FileActorRef;
    text: string;
  },
): Promise<void> {
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: input.actorRef,
      title: null,
      text: input.text,
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  // P11-23: attribute the audit row to the AGENT that commented, not the
  // operator. Auditing every mid-run agent comment under OPERATOR_AUDIT_ACTOR
  // made actor-filtered audit views misreport agent comments as the operator's;
  // the agent identity was only buried in `details.actorRef`.
  recordAudit(db, {
    action: "task.agent.commented",
    actor: { userId: null, label: encodeActorRef(input.actorRef) },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { actorRef: encodeActorRef(input.actorRef) },
  });
  // NEW-4: a mid-run agent comment that tags a person notifies them, same as
  // any other comment — the tag is a real ping, not decoration.
  notifyMentionedUsers(db, {
    text: input.text,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    from: createActorResolver(db)(input.actorRef),
  });
}

/** Open an agent-raised QUESTION decision packet (ask-human, G3): type
 * `input`, from = the agent's own ref, options rendered as `custom` choices a
 * human resolves. Open-only — resolution stays with humans/the operator.
 * Refuses (returns false) when a packet is already open: one decision at a
 * time per task, and an agent must never clobber a governance packet. */
export async function openAgentQuestionPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: {
    projectSlug: string;
    taskKey: string;
    actorRef: FileActorRef;
    title: string;
    body?: string;
    options?: { title: string; detail?: string }[];
  },
): Promise<boolean> {
  const existing = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!existing) return false;
  if (existing.parsed.packet) return false;

  const role = input.actorRef.kind === "agent"
    ? agentRoleDisplay(input.actorRef)
    : "Agent";
  const packet = buildAgentQuestionPacket(input.actorRef, {
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.options ? { options: input.options } : {}),
  });

  let opened = false;
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    // Re-check inside the locked write — the read above raced other writers.
    if (parsed.packet) return;
    parsed.packet = packet;
    // A question is a human hand-off: the board should say so.
    parsed.frontmatter.waiting = "human";
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "blocked",
      actor: input.actorRef,
      title: null,
      text: `**Question for a human:** ${packet.title}`,
      toAgent: false,
      evidence: null,
    });
    opened = true;
  });
  if (!opened) return false;
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.agent.packet_opened",
    // P11-23: the agent opened this question packet — attribute it to the agent.
    actor: { userId: null, label: encodeActorRef(input.actorRef) },
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { actorRef: encodeActorRef(input.actorRef), title: packet.title },
  });
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "approval",
      title: `${role} asks: ${packet.title}`,
      text: packet.body || "An engaged agent needs a human decision.",
    },
    ctx,
  );
  return true;
}

/** Build the agent's collaboration toolkit for one run. Returns null when the
 * profile's grants allow none of the tools (no server mounted at all). */
export function buildAgentToolkit(deps: AgentToolkitDeps): AgentToolkit | null {
  const { db, ctx, projectSlug, taskKey, actorRef, outcomeKey, collab } = deps;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: SdkMcpToolDefinition<any>[] = [];

  if (collab.comment) {
    tools.push(
      tool(
        "post_comment",
        "Post a progress note or finding to the task timeline as yourself, mid-run. Use it for material updates a human should see before your final report; keep it short. Your FINAL report is posted automatically when you finish — do not repeat it here.",
        { text: z.string().describe("The comment text (markdown allowed).") },
        async (args) => {
          try {
            await postAgentComment(db, ctx, {
              projectSlug,
              taskKey,
              actorRef,
              text: prose(args.text),
            });
            return textResult("[done] Comment posted to the task timeline.");
          } catch (error) {
            logger.warn("agent post_comment failed", {
              taskKey,
              err: error instanceof Error ? error : new Error(String(error)),
            });
            return textResult("[error] The comment could not be posted.");
          }
        },
      ),
    );
  }

  if (collab.ask) {
    tools.push(
      tool(
        "ask_human",
        "Ask the humans on this task a question you are blocked on — it opens a decision card they resolve from the task page. Use it ONLY for a genuine decision you cannot make (ambiguous requirement, missing credential, conflicting instructions). Give 2-4 concrete answer options when they exist. You will NOT receive the answer in this run — finish your report noting what is pending.",
        {
          title: z.string().describe("The question, one sentence."),
          body: z
            .string()
            .optional()
            .describe("Context a human needs to answer (no raw logs/secrets)."),
          options: z
            .array(
              z.object({
                title: z.string().describe("A concrete answer choice."),
                detail: z.string().optional().describe("Short clarification."),
              }),
            )
            .optional()
            .describe("2-4 answer choices (first is presented as suggested)."),
        },
        async (args) => {
          try {
            const opened = await openAgentQuestionPacket(db, ctx, {
              projectSlug,
              taskKey,
              actorRef,
              title: prose(args.title),
              ...(args.body ? { body: prose(args.body) } : {}),
              ...(args.options
                ? {
                    options: args.options.map((o) => ({
                      title: prose(o.title),
                      ...(o.detail ? { detail: prose(o.detail) } : {}),
                    })),
                  }
                : {}),
            });
            return textResult(
              opened
                ? "[done] Question raised — a human will decide from the task page. Continue what you can and note the open question in your final report."
                : "[refused] A decision is already open on this task — finish your report and mention your question there instead.",
            );
          } catch (error) {
            logger.warn("agent ask_human failed", {
              taskKey,
              err: error instanceof Error ? error : new Error(String(error)),
            });
            return textResult("[error] The question could not be raised.");
          }
        },
      ),
    );
  }

  if (collab.verdict) {
    tools.push(
      tool(
        "report_outcome",
        "Report your structured OUTCOME for this task: verdict ('approve' or 'request_changes') plus a one-paragraph justification. Call it exactly once, at the END of your review, right before your final report. It is recorded together with your final report when you finish.",
        {
          verdict: z
            .enum(["approve", "request_changes"])
            .describe("Your judgment of the work under review."),
          summary: z
            .string()
            .optional()
            .describe("One-paragraph justification (markdown allowed)."),
        },
        async (args) => {
          stageOutcome(db, outcomeKey, {
            verdict: args.verdict,
            ...(args.summary ? { summary: prose(args.summary) } : {}),
          });
          return textResult(
            `[staged] Verdict '${args.verdict}' will be recorded with your final report. Finish with your full findings.`,
          );
        },
      ),
    );
  }

  if (tools.length === 0) return null;

  const server = createSdkMcpServer({
    name: "viberr_agent",
    version: "1.0.0",
    instructions:
      "Viberr collaboration tools for this engaged agent. Post material progress, raise blocking questions, and report your structured outcome through these; your final message is still your full report.",
    tools,
  });
  return { mcpServers: { viberr_agent: server } };
}
