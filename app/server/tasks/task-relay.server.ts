import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef, TaskFileEvent } from "~/schemas/task-file.schema";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { appendTimelineEvent, readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import {
  checkAttachmentUpload,
  listTaskAttachmentNames,
  resolveTaskAttachment,
  withAttachmentClaims,
  readAttachmentBytes,
} from "~/server/files/task-attachments.server";
import { isAppError } from "~/server/errors/app-error.server";
import { MAX_UPLOAD_BYTES } from "~/shared/attachment-kinds";
import { joinDependencyEntries } from "~/shared/dependencies";
import { countLabel } from "~/shared/text/plural";
import { logger } from "~/server/logging/logger.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import { toError } from "~/shared/errors";
import {
  notifyMentionedUsers,
  stampNotifiedRecipients,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import { closureRefusal, taskClosure } from "./task-closure.server";
import { appendPolicyNote, loadProjectContext, reprojectTask, taskRef } from "./task-mutation.server";
// Type-only: the wake goes through `autoInvokeOperator`, imported at call time
// because task-action-core reaches this module at load time (through
// task-mutation and the rebuilder).
import type { TaskActionContext } from "./task-action-core.server";

/**
 * Ruling 488 (F40-67): work on one task reaches another task in the same
 * project, on the record.
 *
 * Live on WEB-9 the goal the controller wrote told the task to post its
 * deployed CPU numbers on WEB-8, whose cron design depended on them. Nothing
 * that works a task could write on another one: the specialist's
 * `post_comment` and the operator's comment tools reach only the task the run
 * is on, and only the controller comments anywhere. So the Platform Engineer
 * wrote two attachments "for WEB-8", the operator's acceptance packet asked
 * the owner to confirm they had been pasted there, and the owner's driver
 * pasted 5,117 characters onto WEB-8 by hand.
 *
 * This is the one door. The operator's `relay_to_task` and a specialist's
 * `relay` entries on its reported outcome both come through it, so a relay
 * reads, refuses, audits and wakes the same way whoever sent it.
 */

/** How many relay entries one specialist outcome may carry. */
export const RELAY_MAX_ENTRIES = 2;

/** Ruling 538: how many files one relay may carry. */
export const RELAY_MAX_FILES = 10;

/** One relay a specialist asks for in its outcome. */
export interface RelayEntry {
  taskKey: string;
  text: string;
  /** Ruling 538: the names of this task's attachments to put on that task. */
  files?: string[];
}

/** Who a relay is from, as each surface it lands on needs it. */
export interface RelayAuthor {
  /** The timeline actor, on the target's comment and the source's line. */
  actorRef: FileActorRef;
  /** The name in the comment's header: "operator", or the agent's name. */
  name: string;
  auditActor: AuditActor;
  /** The `from` chip on a notification the relayed text's @mentions send. */
  notifyFrom: ActorRender;
}

export interface RelayRequest {
  projectSlug: string;
  /** The task the relay is sent from: the one the run works. */
  fromTaskKey: string;
  toTaskKey: string;
  text: string;
  /** Ruling 538: names of the source task's attachments to copy onto the
   *  target, where its agents read them as that task's own files. */
  files?: readonly string[];
  author: RelayAuthor;
}

/** The operator-action outcome split (`denied` is authority, `noop` state). */
export interface RelayOutcome {
  outcome: "done" | "denied" | "noop";
  message: string;
}

/** What the target's operator is woken with (the `relayed` trigger). */
export interface RelayPayload {
  fromTaskKey: string;
  /** The author's name as the comment's header gives it. */
  by: string;
  text: string;
  /** The relayed comment's `occurredAt` on the target's timeline. */
  occurredAt: string;
}

/** The comment's header: the source task and the author, before the text. */
export function relayHeader(fromTaskKey: string, by: string): string {
  return `**From ${fromTaskKey} (${by}):**`;
}

/** Ruling 538: a relay's own comment, told by the header only
 *  {@link relayToTask} writes. Its files were carried, never a run's work.
 *  The author's name may itself hold parentheses ("Reviewer (Opus)"), so the
 *  header is the whole first line, closed by `):**`. */
export function isRelayComment(event: Pick<TaskFileEvent, "type" | "toAgent" | "text">): boolean {
  if (event.type !== "comment" || !event.toAgent) return false;
  const firstLine = event.text.split("\n", 1)[0] ?? "";
  return /^\*\*From \S+ \(.+\):\*\*$/.test(firstLine.trimEnd());
}

/** How much of the first line the source task's record quotes. */
const SOURCE_LINE_QUOTE_MAX = 120;

/**
 * The source task's one line: "Relayed to WEB-8: <first line>…". The first
 * line that says anything, without a heading's marks, and an ellipsis when
 * the text runs past what is quoted.
 */
export function relaySourceLine(toTaskKey: string, text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const first = (lines[0] ?? "").replace(/^#+\s*/, "");
  const quoted =
    first.length > SOURCE_LINE_QUOTE_MAX ? first.slice(0, SOURCE_LINE_QUOTE_MAX).trimEnd() : first;
  const more = quoted.length < first.length || lines.length > 1;
  return `Relayed to ${toTaskKey}: ${quoted}${more ? "…" : ""}`;
}

/** Another project's task under this key, when there is one. */
function projectHoldingKey(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string | null {
  // SAFETY: `project_slug` is `TEXT NOT NULL` on `task_projections`
  // (0001_baseline), so a returned row carries it as a string.
  const row = db
    .prepare(
      `SELECT project_slug FROM task_projections
        WHERE task_key = ? AND project_slug != ? LIMIT 1`,
    )
    .get(taskKey, projectSlug) as { project_slug: string } | undefined;
  return row?.project_slug ?? null;
}

/**
 * Post `text` on another task of the same project as `author`'s comment,
 * write one line on the source task, audit it and wake the target's operator.
 *
 * Refused, with the sentence the relayer reads: an empty text, the source
 * task itself, a task that does not exist, a task in another project, a
 * closed target (Done or archived: its operator refuses every trigger, ruling
 * 177, so a relay there would wake nobody and read as delivered to finished
 * work), and an archived project. The text takes a comment's limits: none on
 * length (the record keeps a comment whole and the timeline clamps it, owner
 * ruling 2026-08-31), and none of the operator's guardrails, which would drop
 * a short relay as chatter or cut the numbers a relay exists to carry.
 */
export async function relayToTask(
  db: DatabaseSync,
  ctx: TaskActionContext,
  req: RelayRequest,
): Promise<RelayOutcome> {
  const from = req.fromTaskKey.trim();
  const to = req.toTaskKey.trim();
  const text = req.text.trim();
  if (!to) {
    return { outcome: "noop", message: "Name the task to relay to, e.g. WEB-8." };
  }
  if (!text) {
    return { outcome: "noop", message: `Nothing was relayed to ${to}: the text is empty.` };
  }
  if (to === from) {
    return {
      outcome: "noop",
      message: `${to} is the task you are on. A relay reaches ANOTHER task in this project; write on this one as usual.`,
    };
  }
  const project = loadProjectContext(ctx, req.projectSlug);
  if (project.archived) {
    return {
      outcome: "noop",
      message: `This project is archived (read-only), so nothing can be relayed to ${to}.`,
    };
  }
  const target = readTaskFile(taskRef(ctx, req.projectSlug, to));
  if (!target) {
    const elsewhere = projectHoldingKey(db, req.projectSlug, to);
    if (elsewhere) {
      return {
        outcome: "denied",
        message: `${to} is a task in project ${elsewhere}, not in ${req.projectSlug}. A relay reaches only tasks in the same project.`,
      };
    }
    return {
      outcome: "noop",
      message: `${to} is not a task in this project, so nothing was relayed. \`read_board\` lists the project's tasks.`,
    };
  }
  const closure = taskClosure(target.parsed.frontmatter, project.stages);
  if (closure.closed) {
    return {
      outcome: "noop",
      message:
        `${closureRefusal(to, closure, project.stages, "relaying to it")} ` +
        `Nothing was relayed: a closed task's operator starts no run, so the text would reach nobody.`,
    };
  }
  // Ruling 538: every file is checked before anything is written, so a relay
  // lands whole or not at all.
  const staged = stageRelayFiles(req.projectSlug, from, to, req.files ?? [], ctx.dataRoot);
  if ("refused" in staged) {
    return { outcome: "noop", message: `Nothing was relayed to ${to}: ${staged.refused}` };
  }
  // The target's comment. A machine author's ambiguous @handle notifies
  // nobody, so the disclosure rides the comment as it does on every agent
  // and operator comment (S5-G3).
  const body = withAmbiguityDisclosure(
    db,
    `${relayHeader(from, req.author.name)}\n\n${text}` + relayFilesSentence(staged.files),
    req.projectSlug,
  );
  const carried = staged.files.map((f) => f.as);
  const occurredAt = new Date().toISOString();
  const comment: TaskFileEvent = {
    occurredAt,
    type: "comment",
    actor: req.author.actorRef,
    title: null,
    text: body,
    // It is addressed to the target's operator, which is woken with it, and
    // `toAgent` is what keeps a hand-off out of timeline compaction.
    toAgent: true,
    evidence: null,
  };
  // Ruling 538: the comment claims what it carried, so the files render on it
  // and no run in flight on the target is ever credited with them. Ruling 558:
  // the names are held from before the files land until the comment is down,
  // and a comment that cannot be written takes the files back up.
  if (carried.length > 0) comment.attachments = carried;
  await landCarriedFiles(ctx, req.projectSlug, to, staged.files, comment);
  reprojectTask(db, ctx, req.projectSlug, to);
  recordAudit(db, {
    action: "task.relayed",
    actor: req.author.auditActor,
    subjectKind: "task",
    subjectId: to,
    projectSlug: req.projectSlug,
    taskKey: to,
    details: carried.length > 0 ? { from, to, files: carried } : { from, to },
  });

  // The source task's record of what went out, which is also how its own
  // operator sees the relay in its snapshot.
  const recorded = await noteOnSource(
    db,
    ctx,
    req,
    from,
    relaySourceLine(to, text) + (carried.length > 0 ? ` With ${countLabel(carried.length, "file")}.` : ""),
  );

  // A person the relayed text tags is notified, as by any comment.
  await stampNotifiedRecipients(
    db,
    taskRef(ctx, req.projectSlug, to),
    comment,
    notifyMentionedUsers(db, {
      text,
      projectSlug: req.projectSlug,
      taskKey: to,
      occurredAt,
      from: req.author.notifyFrom,
    }),
  );

  // The wake, the way an @operator comment wakes it: fire-and-forget, so the
  // relayer is never held behind the target's checkout.
  const wakeCtx: TaskActionContext = {};
  if (ctx.dataRoot) wakeCtx.dataRoot = ctx.dataRoot;
  if (ctx.deps) wakeCtx.deps = ctx.deps;
  const relay: RelayPayload = { fromTaskKey: from, by: req.author.name, text, occurredAt };
  void import("./task-action-core.server")
    .then(({ autoInvokeOperator }) =>
      autoInvokeOperator(db, wakeCtx, req.projectSlug, to, "relayed", { relay }),
    )
    .catch((error) => {
      logger.error("relay wake could not start", { taskKey: to, err: toError(error) });
    });
  // Called at run time for the same reason: operator-authority reaches here
  // (agents-query → board-query → the task mapping → agent-outcome).
  const { resolveOperatorAuthority } = await import("./operator-authority.server");
  const woken = resolveOperatorAuthority(ctx, req.projectSlug).deployed
    ? `${to}'s operator is woken with it`
    : `no operator is deployed in this project to pick it up`;

  return {
    outcome: "done",
    message:
      `Relayed to ${to}: it is on ${to}'s timeline as your comment, headed "From ${from} (${req.author.name})", ` +
      `and ${woken}. ${sourceRecord(from, "relay", recorded)} Nobody needs to copy it anywhere.` +
      relayFilesSentence(staged.files).replace(/^\n\n/, " "),
  };
}

/** Ruling 557: a take, asked for by the task that needs the files. */
export interface TakeRequest {
  projectSlug: string;
  /** The task the files are taken onto: the one the operator works. */
  taskKey: string;
  /** The task that holds them, open or closed. */
  fromTaskKey: string;
  files: readonly string[];
  /** Why they are taken, on the claiming comment; optional. */
  text?: string;
  author: RelayAuthor;
}

/**
 * Ruling 557: the other direction. A task that waits on another works from
 * what that one made, and only the maker's side could hand it over:
 * `relay_to_task` pushes, from a task whose operator is running. Live when
 * AWSC-3 (the benchmark design) was accepted, its operator had relayed
 * nothing, a closed task's operator starts no run, and AWSC-4 to AWSC-7 each
 * opened a packet asking the owner to attach its input by hand, the one thing
 * the operator's own doctrine says never to ask.
 *
 * So the task that needs the files takes them. Named attachments of another
 * task in this project are copied onto this one under a relay's own header
 * ("From AWSC-3 (operator):"), so the files render on that comment and no run
 * on this task is credited with them (ruling 538), and the source task records
 * what was taken. The source may be closed: its work is done, and its files are
 * what it made. Every file passes the relay's checks (named, present, no link,
 * an upload's kinds and size, at most ten, never an overwrite), all or none.
 */
export async function takeFromTask(
  db: DatabaseSync,
  ctx: TaskActionContext,
  req: TakeRequest,
): Promise<RelayOutcome> {
  const from = req.fromTaskKey.trim();
  const to = req.taskKey.trim();
  const names = req.files.map((n) => n.trim()).filter((n) => n.length > 0);
  if (!from) {
    return { outcome: "noop", message: "Name the task to take files from, e.g. AWSC-3." };
  }
  if (from === to) {
    return { outcome: "noop", message: `${to} is the task you are on: its attachments are already here.` };
  }
  if (names.length === 0) {
    return {
      outcome: "noop",
      message: `Nothing was taken from ${from}: name the files, exactly as ${from} lists them.`,
    };
  }
  const project = loadProjectContext(ctx, req.projectSlug);
  if (project.archived) {
    return { outcome: "noop", message: "This project is archived (read-only), so nothing can be taken onto its tasks." };
  }
  const source = readTaskFile(taskRef(ctx, req.projectSlug, from));
  if (!source) {
    const elsewhere = projectHoldingKey(db, req.projectSlug, from);
    if (elsewhere) {
      return {
        outcome: "denied",
        message: `${from} is a task in project ${elsewhere}, not in ${req.projectSlug}. Files are taken only from tasks in the same project.`,
      };
    }
    return {
      outcome: "noop",
      message: `${from} is not a task in this project, so nothing was taken. \`read_board\` lists the project's tasks.`,
    };
  }
  // A Done task's files are what it made; an archived one's work was
  // withdrawn, and its file takes no writes, the "Taken by" line included.
  const sourceClosure = taskClosure(source.parsed.frontmatter, project.stages);
  if (sourceClosure.closed && sourceClosure.why === "archived") {
    return {
      outcome: "noop",
      message: `${closureRefusal(from, sourceClosure, project.stages, "taking files from it")} Nothing was taken.`,
    };
  }
  const target = readTaskFile(taskRef(ctx, req.projectSlug, to));
  if (!target) throw new Error(`Task ${to} not found.`);
  const closure = taskClosure(target.parsed.frontmatter, project.stages);
  if (closure.closed) {
    return {
      outcome: "noop",
      message: `${closureRefusal(to, closure, project.stages, "taking files onto it")} Nothing was taken.`,
    };
  }
  const staged = stageRelayFiles(req.projectSlug, from, to, names, ctx.dataRoot);
  if ("refused" in staged) {
    return { outcome: "noop", message: `Nothing was taken from ${from}: ${staged.refused}` };
  }
  const carried = staged.files.map((f) => f.as);
  const why = req.text?.trim();
  const comment: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "comment",
    actor: req.author.actorRef,
    title: null,
    // A relay's header, so the claim reads as carried, never as a run's work;
    // and the relay's disclosure, so an @handle that notifies nobody says so.
    text: withAmbiguityDisclosure(
      db,
      `${relayHeader(from, req.author.name)}\n\n${why || `Taken from ${from} to work from.`}` +
        relayFilesSentence(staged.files),
      req.projectSlug,
    ),
    // Kept out of timeline compaction, as a relay is.
    toAgent: true,
    evidence: null,
    attachments: carried,
  };
  // Ruling 558: the names are held from before the files land until the
  // claiming comment is down, and a comment that cannot be written takes the
  // files back up.
  await landCarriedFiles(ctx, req.projectSlug, to, staged.files, comment);
  reprojectTask(db, ctx, req.projectSlug, to);
  recordAudit(db, {
    action: "task.files.taken",
    actor: req.author.auditActor,
    subjectKind: "task",
    subjectId: to,
    projectSlug: req.projectSlug,
    taskKey: to,
    details: { from, to, files: carried },
  });
  // A person the line tags is notified, as by any comment (NEW-4).
  if (why) {
    await stampNotifiedRecipients(
      db,
      taskRef(ctx, req.projectSlug, to),
      comment,
      notifyMentionedUsers(db, {
        text: why,
        projectSlug: req.projectSlug,
        taskKey: to,
        occurredAt: comment.occurredAt,
        from: req.author.notifyFrom,
      }),
    );
  }
  const recorded = await noteOnSource(
    db,
    ctx,
    req,
    from,
    `Taken by ${to}: ${joinDependencyEntries(staged.files.map((f) => `\`${f.name}\``))}.`,
  );
  return {
    outcome: "done",
    message:
      `Took ${countLabel(carried.length, "file")} from ${from}: they are on ${to}'s attachments, where its agents read them, ` +
      `claimed by your comment headed "From ${from} (${req.author.name})". ${sourceRecord(from, "take", recorded)}` +
      relayFilesSentence(staged.files).replace(/^\n\n/, " "),
  };
}

/**
 * Ruling 558: put a relay's or a take's files on the target and write the
 * comment that claims them, as one step. The names are held until the comment
 * is down; if it cannot be written, the files that landed are taken back up,
 * so none is left on the target unclaimed for a completion to credit.
 */
async function landCarriedFiles(
  ctx: TaskActionContext,
  projectSlug: string,
  to: string,
  files: readonly StagedRelayFile[],
  comment: TaskFileEvent,
): Promise<void> {
  const names = files.map((f) => f.as);
  await withAttachmentClaims(
    projectSlug,
    to,
    names,
    async (put) => {
      for (const f of files) if (!f.reused) put(f.as, f.data);
      await appendTimelineEvent(taskRef(ctx, projectSlug, to), comment);
    },
    ctx.dataRoot,
  );
}

/**
 * The source task's line about a relay or a take. Written last and never
 * fatal: the files and their claim are down and audited, and a source whose
 * file cannot be written must not turn what landed into an error its sender
 * retries. Resolves whether the line was written, so the reply says so.
 */
async function noteOnSource(
  db: DatabaseSync,
  ctx: TaskActionContext,
  req: { projectSlug: string; author: RelayAuthor },
  from: string,
  text: string,
): Promise<boolean> {
  try {
    await updateTaskFile(taskRef(ctx, req.projectSlug, from), (parsed) => {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        type: "note",
        actor: req.author.actorRef,
        title: null,
        text,
        toAgent: false,
        evidence: null,
      });
    });
    reprojectTask(db, ctx, req.projectSlug, from);
    return true;
  } catch (error) {
    logger.warn("the source task's line about a relay or take could not be written", {
      taskKey: from,
      err: toError(error),
    });
    return false;
  }
}

/** The reply's word on the source task's line, true either way. */
function sourceRecord(from: string, what: "relay" | "take", recorded: boolean): string {
  return recorded
    ? `${from}'s timeline records the ${what}.`
    : `${from}'s timeline could not take its line about the ${what} (its file cannot be written), so the audit log is the record there.`;
}

/** One file a relay carries: its bytes, the name it lands under on the
 *  target, and whether the target already holds exactly these bytes. */
interface StagedRelayFile {
  name: string;
  as: string;
  data: Uint8Array;
  reused: boolean;
}

/**
 * Ruling 538: read and check every file a relay names, writing nothing. A
 * name the source task does not hold, a kind the target could neither show
 * nor read back (the upload's own rules), and more than
 * {@link RELAY_MAX_FILES} are refused by name. A target that already holds
 * the same bytes under the name keeps its file; one that holds other bytes
 * gets the relayed file under the next free name, never an overwrite.
 */
function stageRelayFiles(
  projectSlug: string,
  from: string,
  to: string,
  names: readonly string[],
  dataRoot: string | undefined,
): { files: StagedRelayFile[] } | { refused: string } {
  const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (wanted.length > RELAY_MAX_FILES) {
    return { refused: `a relay carries at most ${RELAY_MAX_FILES} files, and this one names ${wanted.length}.` };
  }
  const taken = new Set(listTaskAttachmentNames(projectSlug, to, dataRoot).map((n) => n.toLowerCase()));
  const files: StagedRelayFile[] = [];
  for (const name of wanted) {
    let abs: string;
    try {
      abs = resolveTaskAttachment(projectSlug, from, name, dataRoot);
    } catch {
      return { refused: `\`${name}\` is not a file name ${from} can hold.` };
    }
    // Ruling 552: through no link, and no bigger than an upload, checked
    // before a byte is read. A link an agent planted here would otherwise copy
    // a file only the server may read onto another task, as an ordinary file.
    const read = readAttachmentBytes(abs, MAX_UPLOAD_BYTES);
    if (!read) {
      const have = listTaskAttachmentNames(projectSlug, from, dataRoot);
      return {
        refused:
          `${from} has no attachment \`${name}\`. ` +
          (have.length > 0 ? `It holds: ${have.join(", ")}.` : "It has no attachments."),
      };
    }
    try {
      checkAttachmentUpload(name, "tooLarge" in read ? read.tooLarge : read.bytes.byteLength);
    } catch (error) {
      return { refused: isAppError(error) ? error.userMessage : `\`${name}\` cannot be relayed.` };
    }
    if ("tooLarge" in read) return { refused: `\`${name}\` cannot be relayed.` };
    const data = read.bytes;
    let as = name;
    let reused = false;
    if (taken.has(name.toLowerCase())) {
      const there = readAttachmentBytes(resolveTaskAttachment(projectSlug, to, name, dataRoot), MAX_UPLOAD_BYTES);
      if (there && "bytes" in there && there.bytes.equals(data)) {
        reused = true;
      } else {
        as = nextFreeName(name, taken);
      }
    }
    taken.add(as.toLowerCase());
    files.push({ name, as, data, reused });
  }
  return { files };
}

/** `name`, then `stem-2.ext`, `stem-3.ext`: the first `taken` does not hold. */
function nextFreeName(name: string, taken: ReadonlySet<string>): string {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** What the relay comment says it carried, and under which names. */
function relayFilesSentence(files: readonly StagedRelayFile[]): string {
  if (files.length === 0) return "";
  const named = files.map((f) => (f.as === f.name ? `\`${f.as}\`` : `\`${f.name}\` (here as \`${f.as}\`, a file of that name was already on this task)`));
  return `\n\nWith ${files.length === 1 ? "the file" : "the files"} ${joinDependencyEntries(named)}, now on this task's attachments.`;
}

/**
 * Ruling 488: a specialist's `relay` entries, posted when its run completes.
 *
 * The specialist gets no post tool of its own: its reported outcome carries
 * the entries and this posts each through {@link relayToTask}, the operator's
 * door, with the agent as the author. The first {@link RELAY_MAX_ENTRIES} are
 * posted; any past the cap, any the door refuses, and all of them when the
 * agent is no longer deployed (`author` null, the completion pipeline's
 * conservative posture for a vanished profile, R15-7) are named in ONE note on
 * the source task, so the operator reads what did not go out instead of
 * assuming it did.
 */
export async function postOutcomeRelays(
  db: DatabaseSync,
  ctx: TaskActionContext,
  input: {
    projectSlug: string;
    taskKey: string;
    author: RelayAuthor | null;
    entries: readonly RelayEntry[];
  },
): Promise<void> {
  if (input.entries.length === 0) return;
  const unsent: string[] = [];
  for (const [index, entry] of input.entries.entries()) {
    const to = entry.taskKey.trim() || "(no task named)";
    if (!input.author) {
      unsent.push(`${to}: this agent is no longer deployed in the project.`);
      continue;
    }
    if (index >= RELAY_MAX_ENTRIES) {
      unsent.push(`${to}: past the limit of ${RELAY_MAX_ENTRIES} relays in one report.`);
      continue;
    }
    try {
      const request: RelayRequest = {
        projectSlug: input.projectSlug,
        fromTaskKey: input.taskKey,
        toTaskKey: entry.taskKey,
        text: entry.text,
        author: input.author,
      };
      if (entry.files) request.files = entry.files;
      const result = await relayToTask(db, ctx, request);
      if (result.outcome !== "done") unsent.push(`${to}: ${result.message}`);
    } catch (error) {
      logger.warn("an agent's relay could not be posted", {
        taskKey: input.taskKey,
        to,
        err: toError(error),
      });
      unsent.push(`${to}: it could not be posted.`);
    }
  }
  if (unsent.length === 0) return;
  const who = input.author?.name ?? "The agent";
  await appendPolicyNote(db, ctx, input.projectSlug, input.taskKey, {
    title: "Not relayed",
    text:
      `${who}'s report asked for ${unsent.length === 1 ? "a relay" : "relays"} that did not go out:\n` +
      unsent.map((u) => `- ${u}`).join("\n") +
      "\n\nThe text is in the report. The operator can post it with `relay_to_task` where that is allowed; nobody is to copy it by hand.",
  });
}
