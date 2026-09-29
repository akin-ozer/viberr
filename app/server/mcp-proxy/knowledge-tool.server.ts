import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { agentRoleDisplay, encodeActorRef } from "~/server/files/actor-ref.server";
import {
  KB_DOC_KB_DESCRIPTION,
  KB_DOC_OFFSET_DESCRIPTION,
  KB_DOC_PATH_DESCRIPTION,
  KB_DOC_TOOL_DESCRIPTION,
  readKbDocForRun,
} from "~/server/files/kb-injection.server";
import { logger } from "~/server/logging/logger.server";
import { normalizeEscapedNewlines } from "~/server/tasks/model-prose.server";
import { toError } from "~/shared/errors";

/**
 * Ruling 585: the knowledge server Viberr's MCP gateway answers itself for a
 * Codex specialist, with the two knowledge tools a Claude specialist has.
 *
 * A Claude run's toolkit holds `read_knowledge_doc` and `correct_knowledge_doc`
 * for the knowledge bases it was given. A Codex run mounts no in-process tools
 * (ruling 422), so it read an open knowledge base from its shell, reported a
 * correction in its final reply for the operator to write, and could not use
 * a private knowledge base at all (ruling 578). Live on the AWS calculator
 * board the Estimate Judge could not move to GPT-6 Luna: the golden set it
 * scores against and writes is private. The gateway already serves a Codex
 * run over a run-scoped token (ruling 461), so it serves these two tools too,
 * from this process, over exactly the knowledge bases the run was given. The
 * same reader and writer answer them, so both backends read the same pages,
 * write the same corrections and get the same refusals.
 */
export const KNOWLEDGE_MCP_NAME = "viberr_knowledge";

/** What a run's knowledge mount carries to the gateway: the knowledge bases
 *  the run was given, the store they are in and the agent a correction is
 *  written as. The run is handed the mount without it. */
export const knowledgeMountSchema = z.object({
  kb: z.array(z.string()),
  dataRoot: z.string().optional(),
  agent: z.object({ profileId: z.string(), roleHint: z.string().nullable() }),
});
export type KnowledgeMount = z.infer<typeof knowledgeMountSchema>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const KNOWLEDGE_READ_TOOL: Tool = {
  name: "read_knowledge_doc",
  title: "Read a knowledge-base document",
  description: KB_DOC_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      kb: { type: "string", description: KB_DOC_KB_DESCRIPTION },
      path: { type: "string", description: KB_DOC_PATH_DESCRIPTION },
      offset: { type: "integer", minimum: 0, description: KB_DOC_OFFSET_DESCRIPTION },
    },
    required: ["kb", "path"],
  },
  annotations: { title: "Read a knowledge-base document", ...READ_ONLY },
};

/** Rulings 483 and 498: what a specialist's `correct_knowledge_doc` says it
 *  does, on either backend. */
export const KB_CORRECTION_SPECIALIST_DESCRIPTION =
  "Correct a passage of one of YOUR knowledge bases that your work has PROVEN wrong: a version you measured, a path or command that is not what the document says, a step that no longer works. Send `replaces` EXACTLY as the document has it (read_knowledge_doc returns it; list marker and emphasis included) and `text` as it should read instead, in the document's own form, with your evidence; an empty `text` deletes the passage. Send only the passage that changes: the record keeps what it needs around it for an undo. It is written into the document at once, so every later run reads the corrected passage; a person undoes it if they disagree, and a correction a person undid is refused if written again. Use it instead of only reporting a discrepancy: a comment is read once, the document is read by every later run. The task's entry quotes the passage only when every agent on the project is given that knowledge base, so correcting one given to few agents keeps its text off the task.";

/** The correction's fields, described once for both backends. The document is
 *  `path`, as `read_knowledge_doc` names it (ruling 588). */
export const KB_CORRECTION_FIELDS = {
  kb: "The knowledge base the passage is in, by the name its index heading gives it.",
  path: KB_DOC_PATH_DESCRIPTION,
  replaces:
    "The passage the correction replaces, copied EXACTLY as the document has it; it must stand once in the document. Omit only when the correction adds something the document does not say: `text` then goes at the end of the document.",
  text: "What the document should say in place of `replaces`, in its own form: the corrected fact, not the evidence. Empty to delete the passage.",
  evidence: "What proves it: the command you ran and its output, the file and line you read, the check that failed.",
} as const;

export const KNOWLEDGE_CORRECT_TOOL: Tool = {
  name: "correct_knowledge_doc",
  title: "Correct a knowledge-base document",
  description: KB_CORRECTION_SPECIALIST_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      kb: { type: "string", description: KB_CORRECTION_FIELDS.kb },
      path: { type: "string", description: KB_CORRECTION_FIELDS.path },
      replaces: { type: "string", description: KB_CORRECTION_FIELDS.replaces },
      text: { type: "string", description: KB_CORRECTION_FIELDS.text },
      evidence: { type: "string", description: KB_CORRECTION_FIELDS.evidence },
    },
    required: ["kb", "path", "text", "evidence"],
  },
  annotations: {
    title: "Correct a knowledge-base document",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** Both tools, in the order the gateway lists them. */
export const KNOWLEDGE_TOOLS: Tool[] = [KNOWLEDGE_READ_TOOL, KNOWLEDGE_CORRECT_TOOL];

/** `read_knowledge_doc`'s arguments, parsed where the gateway receives the call. */
export const knowledgeReadArgsSchema = z.object({
  kb: z.string(),
  path: z.string(),
  offset: z.number().int().min(0).optional(),
});
export type KnowledgeReadArgs = z.infer<typeof knowledgeReadArgsSchema>;

/** `correct_knowledge_doc`'s arguments, parsed where the gateway receives the call. */
export const knowledgeCorrectArgsSchema = z.object({
  kb: z.string(),
  path: z.string(),
  replaces: z.string().optional(),
  text: z.string(),
  evidence: z.string(),
});
export type KnowledgeCorrectArgs = z.infer<typeof knowledgeCorrectArgsSchema>;

function textResult(text: string, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** The answer to arguments that are not the tool's. */
export function knowledgeArgsRefusal(tool: Tool): CallToolResult {
  const required = tool.inputSchema.required ?? [];
  return textResult(
    `${tool.name} takes ${required.map((name) => `\`${name}\``).join(", ")} as text fields. Nothing was read or written.`,
    true,
  );
}

/** `read_knowledge_doc`: the same text a Claude run's gets. */
export function knowledgeReadResult(mount: KnowledgeMount, args: KnowledgeReadArgs): CallToolResult {
  try {
    return textResult(readKbDocForRun(mount.kb, args.kb, args.path, mount.dataRoot, args.offset ?? 0));
  } catch (error) {
    logger.warn("gateway read_knowledge_doc failed", { kb: args.kb, err: toError(error) });
    return textResult("[error] That knowledge-base document could not be read.", true);
  }
}

/** `correct_knowledge_doc`: the same writer a Claude run's calls, as the run's
 *  agent, on the run's task. */
export async function knowledgeCorrectResult(input: {
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  mount: KnowledgeMount;
  args: KnowledgeCorrectArgs;
}): Promise<CallToolResult> {
  const { mount, args } = input;
  const actorRef: FileActorRef = {
    kind: "agent",
    backend: "codex",
    profileId: mount.agent.profileId,
    roleHint: mount.agent.roleHint,
  };
  const prose = normalizeEscapedNewlines;
  try {
    // Loaded on the call: the writer reaches the task layer, which reaches the
    // run service that binds this gateway.
    const { correctKnowledgeDoc } = await import("~/server/tasks/kb-correction-actions.server");
    const result = await correctKnowledgeDoc(input.db, mount.dataRoot ? { dataRoot: mount.dataRoot } : {}, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kb: prose(args.kb),
      doc: prose(args.path),
      replaces: args.replaces ? prose(args.replaces) : null,
      text: prose(args.text),
      evidence: prose(args.evidence),
      actorRef,
      filedBy: agentRoleDisplay(mount.agent),
      auditActor: { userId: null, label: encodeActorRef(actorRef) },
      allowedKbs: mount.kb,
    });
    return textResult(`[${result.outcome}] ${result.message}`);
  } catch (error) {
    logger.warn("gateway correct_knowledge_doc failed", { taskKey: input.taskKey, kb: args.kb, err: toError(error) });
    return textResult("[error] The correction could not be written.", true);
  }
}
