import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import {
  normalizeEvidenceRows,
  type FileActorRef,
} from "~/schemas/task-file.schema";
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
import {
  notifyMentionedUsers,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import { createActorResolver } from "~/shared/mapping/actor.server";
import { agentNamesByProfile } from "~/server/runtimes/run-store.server";
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
 *                    recorded ATOMICALLY with the reply at completion); its
 *                    optional `evidence` field is separately gated on
 *                    attach-evidence-references (P13-D-26)
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
  // S5-G3: an @handle that matches several people notifies nobody. A mid-run
  // agent comment is machine-authored — nothing else would ever say the tag
  // reached no one — so the disclosure rides the comment itself.
  const text = withAmbiguityDisclosure(db, input.text);
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift({
      occurredAt: new Date().toISOString(),
      type: "comment",
      actor: input.actorRef,
      title: null,
      text,
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
  // any other comment — the tag is a real ping, not decoration. NEW-5: the
  // `from` chip is the agent's own name, not its runtime label.
  notifyMentionedUsers(db, {
    text,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    from: createActorResolver(db, {
      agentNames: agentNamesByProfile(db, input.projectSlug),
    })(input.actorRef),
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
        "Ask the humans on this task a question you are blocked on — it opens a decision card they resolve from the task page. Use it ONLY for a genuine decision you cannot make (ambiguous requirement, conflicting instructions, a choice only a human may make). Give 2-4 concrete answer options when they exist. The answer does not arrive during THIS run: end this run with a report of what you did and what is pending. You WILL be resumed with the decision, in this same session, so you can carry on from where you stopped — do not restart your work or re-ask.",
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
                ? "[done] Question raised — a human will decide from the task page. Continue whatever does NOT depend on the answer, then finish with a report of what is pending. You will be resumed in this same session once the decision is made."
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
          // P13-D-26: the reviewer profile advertises "Attach evidence
          // references" (agent-catalog.server.ts) and its persona says it keeps
          // raw validation output OUT of the timeline — but there was no channel
          // to attach anything, so the `evidence:` block had 42 `null` writers
          // and zero real ones. Gated exactly like its siblings: the field is
          // only DECLARED when the profile holds the grant, so an agent without
          // it cannot see or use it.
          ...(collab.evidence
            ? {
                evidence: z
                  .array(
                    z.object({
                      label: z
                        .string()
                        .describe(
                          "What this cites: a suite, a file, a check — e.g. 'unit/policy_gate_test' or 'app/server/tasks/task-actions.server.ts'.",
                        ),
                      add: z
                        .string()
                        .optional()
                        .describe("Short signed count, e.g. '+14' or '3 passed'."),
                      del: z
                        .string()
                        .optional()
                        .describe("Short signed count, e.g. '−4' or '0 failed'."),
                    }),
                  )
                  .optional()
                  .describe(
                    "Up to 8 evidence REFERENCES for what you checked or produced — short citations, never raw output (that stays in the run logs). They render as rows on your outcome event and carry into the review PR body.",
                  ),
              }
            : {}),
        },
        async (args) => {
          const evidence = collab.evidence
            ? normalizeEvidenceRows(
                (args as { evidence?: { label?: string; add?: string; del?: string }[] })
                  .evidence,
              )
            : null;
          stageOutcome(db, outcomeKey, {
            verdict: args.verdict,
            ...(args.summary ? { summary: prose(args.summary) } : {}),
            ...(evidence ? { evidence } : {}),
          });
          return textResult(
            `[staged] Verdict '${args.verdict}'${
              evidence ? ` with ${evidence.length} evidence reference(s)` : ""
            } will be recorded with your final report. Finish with your full findings.`,
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
