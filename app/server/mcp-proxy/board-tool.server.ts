import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import { READ_PAGE_BYTES } from "~/server/runtimes/read-page-budget.server";

/**
 * Ruling 589: the board server Viberr's MCP gateway answers itself for a Codex
 * specialist, with the two readers a Claude specialist's toolkit holds beside
 * its collaboration tools.
 *
 * A Claude run that holds any collaboration grant reads the project's board
 * (`read_board`, ruling 281, with each task's outcome and verdict reports,
 * ruling 569) and any entry of its own task's timeline in full
 * (`read_timeline_entry`, ruling 563). A Codex run mounted neither (ruling
 * 422). Live on AWSC-24 the Workflow Researcher, on GPT-6 Luna, was asked to
 * compare the Estimate Judge's round-3 verdicts on AWSC-20 to AWSC-23. It
 * looked for them in those tasks' attachment folders, found no verdict file
 * for two of them, and wrote that it used the operator's summaries in its
 * directive instead: the verdicts are on the tasks' timelines, which
 * `read_board` returns and nothing on Codex could read. The gateway already
 * answers a Codex run's knowledge server (ruling 585), so it answers these two
 * as well, from this process, with the same readers.
 */
export const BOARD_MCP_NAME = "viberr_board";

/** What a run's board mount carries to the gateway: the store the task files
 *  are in. The project and task are the run's own, which the gateway holds. */
export const boardMountSchema = z.object({ dataRoot: z.string().optional() });
export type BoardMount = z.infer<typeof boardMountSchema>;

/** Ruling 281: what `read_board` says it does, on either backend. */
export const READ_BOARD_DESCRIPTION =
  "Read this project's board. With `taskKey`, that one task: its title, stage, readiness, what it waits on, whether it is archived, its goal (a long one clipped to its opening, with every decision recorded on it kept whole), and, once it has one, its `outcome` (the completion summary and each verdict's report on what it delivered), the names of its files (`files`), which `read_task_attachment` opens, the deliveries it kept (`deliveries`: each stamp, newest first, with the files as that delivery held them), and its timeline as an index (`timeline`: each entry's stamp, type, author and title, newest first), whose entries `read_timeline_entry` opens. Without, every task in the project as a list. THIS project only, and read-only: it changes nothing. Use it before you act on a task key you were told about rather than read yourself: a task named in a document, a directive or another agent's report is a claim about the board, and this is how you check it. It is also how you find out whether work you are about to ask for already has an owner.";

export const READ_BOARD_TASK_KEY_DESCRIPTION = "One task's key, e.g. SHOP-39. Omit to list the whole board.";

/** Ruling 563: what `read_timeline_entry` says it does, on either backend. */
export const READ_TIMELINE_ENTRY_DESCRIPTION =
  "Read ONE timeline entry in full, by its `occurredAt` stamp: this task's by default, or another task's in this project with `taskKey`. The recent timeline in your prompt clips each entry at 220 characters and ends a clipped one with its stamp; an older entry is not in your prompt at all, and `read_board` with the task's key lists every entry's stamp in its `timeline` (ruling 596). Call this before you act on, summarise or question an entry you only have part of, above all a person's answer to you, and before you restate an earlier verdict. Read-only.";

export const READ_TIMELINE_ENTRY_AT_DESCRIPTION =
  "The entry's stamp, exactly as your prompt or `read_board`'s `timeline` prints it (ISO, to the millisecond).";

/** Ruling 596: the other task whose entry to read. */
export const READ_TIMELINE_ENTRY_TASK_KEY_DESCRIPTION =
  "The task the entry is on, e.g. AWSC-24. Omit for this task.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const BOARD_READ_TOOL: Tool = {
  name: "read_board",
  title: "Read the project's board",
  description: READ_BOARD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: { taskKey: { type: "string", description: READ_BOARD_TASK_KEY_DESCRIPTION } },
  },
  annotations: { title: "Read the project's board", ...READ_ONLY },
};

export const TIMELINE_ENTRY_TOOL: Tool = {
  name: "read_timeline_entry",
  title: "Read one timeline entry in full",
  description: READ_TIMELINE_ENTRY_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      occurredAt: { type: "string", description: READ_TIMELINE_ENTRY_AT_DESCRIPTION },
      taskKey: { type: "string", description: READ_TIMELINE_ENTRY_TASK_KEY_DESCRIPTION },
    },
    required: ["occurredAt"],
  },
  annotations: { title: "Read one timeline entry in full", ...READ_ONLY },
};

/** Ruling 594: what `read_task_attachment` says it does, on either backend. */
export const READ_TASK_ATTACHMENT_DESCRIPTION =
  `Read ONE attachment of a task in this project: this task's by default, or another task's with \`taskKey\`, such as a report or a register a directive tells you to read where it is. \`read_board\` with a task's key lists its \`files\`. A spreadsheet (.xlsx) comes back as its sheets in CSV, an image as the picture itself, and any other file whose bytes are text as text; a binary file (a .pdf, a .docx, a zip) is named and refused. A read returns one page of up to ${READ_PAGE_BYTES.toLocaleString("en-US")} bytes, sized to reach you whole (ruling 624): read and print one page per call, because a Codex run's tool output is cut from the middle above about 40,000 bytes. When it says \`truncated\`, call again with \`offset\` set to its \`nextOffset\`. With \`delivery\`, one of the stamps \`read_board\` lists under a task's \`deliveries\`, it reads the file as that delivery held it: a rework saves the same names again, and a verdict scored the delivery it was given. Read-only: nothing is copied onto your task.`;

export const READ_TASK_ATTACHMENT_FIELDS = {
  name: "The attachment's file name, exactly as `read_board` or the timeline lists it.",
  taskKey: "The task the file is on, e.g. AWSC-24. Omit for this task.",
  offset: "Where to start reading, in characters: the `nextOffset` a truncated read returned. Omit for the start.",
  delivery:
    "A delivery's stamp, as the task's `deliveries` in `read_board` lists it, to read the file as that delivery held it. Omit for the file as it is now.",
} as const;

export const TASK_ATTACHMENT_TOOL: Tool = {
  name: "read_task_attachment",
  title: "Read one attachment of a task",
  description: READ_TASK_ATTACHMENT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: READ_TASK_ATTACHMENT_FIELDS.name },
      taskKey: { type: "string", description: READ_TASK_ATTACHMENT_FIELDS.taskKey },
      offset: { type: "integer", minimum: 0, description: READ_TASK_ATTACHMENT_FIELDS.offset },
      delivery: { type: "string", description: READ_TASK_ATTACHMENT_FIELDS.delivery },
    },
    required: ["name"],
  },
  annotations: { title: "Read one attachment of a task", ...READ_ONLY },
};

/** The three tools, in the order the gateway lists them. */
export const BOARD_TOOLS: Tool[] = [BOARD_READ_TOOL, TIMELINE_ENTRY_TOOL, TASK_ATTACHMENT_TOOL];

/** `read_board`'s arguments, parsed where the gateway receives the call. */
export const boardReadArgsSchema = z.object({ taskKey: z.string().optional() });
export type BoardReadArgs = z.infer<typeof boardReadArgsSchema>;

/** `read_task_attachment`'s arguments, parsed where the gateway receives the call. */
export const taskAttachmentArgsSchema = z.object({
  name: z.string(),
  taskKey: z.string().optional(),
  offset: z.number().int().min(0).optional(),
  delivery: z.string().optional(),
});
export type TaskAttachmentArgs = z.infer<typeof taskAttachmentArgsSchema>;

/** `read_timeline_entry`'s arguments, parsed where the gateway receives the call. */
export const timelineEntryArgsSchema = z.object({ occurredAt: z.string(), taskKey: z.string().optional() });
export type TimelineEntryArgs = z.infer<typeof timelineEntryArgsSchema>;

/** The run a board call reads for: its database, project and task. */
interface BoardCallContext {
  db: DatabaseSync;
  projectSlug: string;
  taskKey: string;
  mount: BoardMount;
}

function textResult(text: string, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/** The reader's context, with the store the mount names. */
function readContext(input: BoardCallContext) {
  return {
    db: input.db,
    ctx: input.mount.dataRoot ? { dataRoot: input.mount.dataRoot } : {},
    projectSlug: input.projectSlug,
  };
}

/** `read_board`: the same answer a Claude run's gets. */
export async function boardReadResult(input: BoardCallContext, args: BoardReadArgs): Promise<CallToolResult> {
  try {
    // Loaded on the call: the reader reaches the task layer, which reaches the
    // run service that binds this gateway.
    const { readBoardList, readBoardTask } = await import("~/server/tasks/board-read.server");
    const wanted = args.taskKey?.trim();
    const deps = readContext(input);
    return textResult(wanted ? readBoardTask(deps, wanted) : readBoardList(deps));
  } catch (error) {
    logger.warn("gateway read_board failed", { taskKey: input.taskKey, err: toError(error) });
    return textResult("[error] The board could not be read.", true);
  }
}

/** `read_timeline_entry`: one entry, whole, of the run's own task or, with
 *  `taskKey`, of another task in the project (ruling 596). */
export async function timelineEntryResult(
  input: BoardCallContext,
  args: TimelineEntryArgs,
): Promise<CallToolResult> {
  try {
    const { readTimelineEntry } = await import("~/server/tasks/board-read.server");
    const taskKey = args.taskKey?.trim() || input.taskKey;
    return textResult(readTimelineEntry(readContext(input), taskKey, args.occurredAt));
  } catch (error) {
    logger.warn("gateway read_timeline_entry failed", { taskKey: input.taskKey, err: toError(error) });
    return textResult("[error] The timeline could not be read.", true);
  }
}

/** `read_task_attachment`: the same reader a Claude run's calls. */
export async function taskAttachmentResult(
  input: BoardCallContext,
  args: TaskAttachmentArgs,
): Promise<CallToolResult> {
  try {
    const { readAgentTaskAttachment } = await import("~/server/tasks/board-read.server");
    const read = readAgentTaskAttachment(
      readContext(input),
      args.taskKey?.trim() || input.taskKey,
      args.name,
      args.offset ?? 0,
      args.delivery?.trim() || undefined,
    );
    if ("text" in read) return textResult(read.text);
    return {
      content: [
        { type: "text", text: read.header },
        { type: "image", data: read.image.data, mimeType: read.image.mimeType },
      ],
    };
  } catch (error) {
    logger.warn("gateway read_task_attachment failed", { taskKey: input.taskKey, err: toError(error) });
    return textResult("[error] The attachment could not be read.", true);
  }
}

/** The answer to arguments that are not the tool's. */
export function boardArgsRefusal(tool: Tool): CallToolResult {
  const fields = Object.keys(tool.inputSchema.properties ?? {});
  return textResult(`${tool.name} takes ${fields.map((name) => `\`${name}\``).join(", ")} as text. Nothing was read.`, true);
}
