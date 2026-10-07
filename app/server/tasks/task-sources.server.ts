import { unlinkSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { isAppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { readAttachmentBytes, resolveTaskAttachment } from "~/server/files/task-attachments.server";
import {
  SOURCE_FROM_MAX,
  SOURCE_MAX_BYTES,
  SOURCE_STAGING_PREFIX,
  SOURCE_TITLE_MAX,
  readTaskSources,
  sourceFromShown,
  stagedSourceName,
  writeTaskSource,
  type SourceKeeper,
  type TaskSource,
} from "~/server/files/task-sources.server";
import { appendTimelineEvent, readTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { readsAsCredential } from "~/server/secrets/git-output-redact.server";
import { toError } from "~/shared/errors";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 690: keeping a source, the action behind `keep_source`.
 *
 * The run saves the bytes itself, with its own tools, as a file in the task's
 * attachments folder: the one task folder a run writes, and the one the
 * server reads without following a link (ruling 552). It saves them under a
 * name that starts with `.source-` and then names that file here. The server
 * takes its own copy into the task's sources (`files/task-sources.server.ts`),
 * where no run can change it, and removes the staged file. The server fetches
 * nothing and runs nothing: it keeps what it was handed, and the record says
 * where the agent stated it came from.
 *
 * The staged name is what keeps a source out of the task's files. That folder
 * also holds what people attached and what runs posted and delivered, and a
 * completing run takes every file saved in its window as its own (rulings 593
 * and 627), a deliverer as its delivery (ruling 610). A page a researcher had
 * saved under an ordinary name and not yet kept was a deliverer's file the
 * moment the deliverer finished beside it: delivered, copied into the kept
 * delivery, and then refused as a source for being somebody's file. No lister
 * of the folder returns a dot-name, so a staged file is nobody's file at any
 * instant, and the keep takes nothing else: a file under any other name
 * belongs to the task (a person's upload, a relay, a delivery, a gate's log,
 * a name a writer holds in flight under ruling 558) and stays there.
 */

/** A source's bytes are read for a credential only this far in. */
const CREDENTIAL_SCAN_BYTES = 4 * 1024 * 1024;
/** How much of a file's head decides whether it is text: git's own window. */
const TEXT_SNIFF_BYTES = 8_000;

export interface KeepSourceInput {
  projectSlug: string;
  taskKey: string;
  /** The staged file's name in the task's attachments folder. */
  file: string;
  /** Where the bytes came from, as the agent states it. */
  from: string;
  title: string;
  actorRef: FileActorRef;
  /** The run that called, when the caller knows it. */
  runId: string | null;
}

/** What breaks a line or hides in one: a control character (a line feed, a
 *  tab, an escape) and Unicode's own line and paragraph separators. A title,
 *  an origin and a name are printed into the list every reader of the task's
 *  sources is answered, one field a line. */
const NOT_ONE_LINE_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** One line of at most `max` characters, or null. */
function oneLine(value: string, max: number): string | null {
  const text = value.trim();
  return text.length === 0 || text.length > max || NOT_ONE_LINE_RE.test(text) ? null : text;
}

const refused = (sentence: string): string => `[refused] ${sentence}`;

/** Take a staged file out of the attachments folder; false when it stays. */
function removeStaged(abs: string, what: string, at: { projectSlug: string; taskKey: string; file: string }): boolean {
  try {
    unlinkSync(abs);
    return true;
  } catch (error) {
    logger.warn(what, { ...at, err: toError(error) });
    return false;
  }
}

/**
 * Keep the staged file `file` of the task's attachments folder as a source,
 * and answer the sentence the agent reads: `[kept]` with the new id, `[noop]`
 * when the task already keeps those bytes, or `[refused]` with what to do
 * instead. A refusal writes nothing and leaves the staged file where it is,
 * with one exception: a file that reads as holding a credential is removed.
 *
 * Synchronous from the first check to the move. An unexpected failure throws,
 * and the tool that called answers it.
 */
export function keepTaskSource(db: DatabaseSync, ctx: TaskMutationContext, input: KeepSourceInput): string {
  const { projectSlug, taskKey, actorRef } = input;
  const task = readTaskFile(taskRef(ctx, projectSlug, taskKey));
  if (!task) return refused(`There is no task ${taskKey} in this project to keep a source on.`);
  if (task.parsed.frontmatter.archived) {
    return refused(`${taskKey} is archived, so nothing more is kept on it.`);
  }
  if (actorRef.kind !== "agent") return refused("A source is kept by an agent's run.");

  const title = oneLine(input.title, SOURCE_TITLE_MAX);
  if (title === null) {
    return refused(
      `Give \`title\` as one line of at most ${SOURCE_TITLE_MAX.toLocaleString("en-US")} characters, with no line break or control character in it.`,
    );
  }
  const from = oneLine(input.from, SOURCE_FROM_MAX);
  if (from === null) {
    return refused(
      `Give \`from\` as one line of at most ${SOURCE_FROM_MAX.toLocaleString("en-US")} characters, with no line break or control character in it.`,
    );
  }
  if (readsAsCredential(from)) {
    return refused("`from` holds what reads as a token or a password. Give the URL or the command without it.");
  }
  if (readsAsCredential(title)) {
    return refused("`title` holds what reads as a token or a password. Give the title without it.");
  }

  const wanted = input.file.trim();
  // What the reply echoes of the name: never the characters that would break its line.
  const shown = wanted.replace(new RegExp(NOT_ONE_LINE_RE.source, "gu"), "");
  if (!wanted || /[\\/\0]/.test(wanted)) {
    return refused(
      `\`${shown}\` is not one file name in the task's attachments folder. Give the file's name alone, with no folder.`,
    );
  }
  if (NOT_ONE_LINE_RE.test(wanted)) {
    return refused(
      `\`${shown}\` holds a line break or a control character. Save the file under a plain name on one line and keep that.`,
    );
  }
  if (stagedSourceName(wanted) === null) {
    return refused(
      `\`${wanted}\` is not a staged source. keep_source takes only a file saved in the task's attachments folder under a name that starts with ` +
        `\`${SOURCE_STAGING_PREFIX}\`, which nothing lists, posts or delivers; a file under any other name belongs to the task and stays there. ` +
        `Save the page or the output there as \`${SOURCE_STAGING_PREFIX}<name>\` (copy a browser snapshot to such a name), then call keep_source with that name.`,
    );
  }
  let abs: string;
  try {
    abs = resolveTaskAttachment(projectSlug, taskKey, wanted, ctx.dataRoot);
  } catch {
    return refused(
      `\`${wanted}\` is not one file name in the task's attachments folder. Give the file's name alone, with no folder.`,
    );
  }
  // Ruling 675: the folder's own entry, whichever Unicode form was typed.
  const stored = path.basename(abs);
  const name = stagedSourceName(stored) ?? stored;
  const staged = { projectSlug, taskKey, file: stored };

  // Ruling 552: never through a link.
  const read = readAttachmentBytes(abs, SOURCE_MAX_BYTES);
  if (!read) {
    return refused(
      `The task's attachments folder holds no \`${wanted}\`. Save the page or the output there under that name first, then call keep_source again.`,
    );
  }
  if ("tooLarge" in read) {
    return refused(
      `\`${stored}\` is ${(read.tooLarge / 1024 / 1024).toFixed(1)} MB; a source may be up to ${SOURCE_MAX_BYTES / 1024 / 1024} MB. ` +
        `Save the page or the part of the output your claim rests on as its own file and keep that.`,
    );
  }
  const data = read.bytes;
  if (data.length === 0) {
    return refused(
      `\`${stored}\` is empty, so nothing came back. Fetch it again and keep what you get, or say in your result that the source could not be opened.`,
    );
  }
  // A command's output can print this instance's own credentials; a public
  // page cannot. The file is the run's own and the server has just judged it
  // unsafe to show, so it does not stay in a folder every agent on the task
  // reads either.
  if (
    !/^https?:\/\//i.test(from) &&
    !data.subarray(0, TEXT_SNIFF_BYTES).includes(0) &&
    readsAsCredential(data.subarray(0, CREDENTIAL_SCAN_BYTES).toString("utf8"))
  ) {
    const gone = removeStaged(abs, "a staged source that reads as holding a credential could not be removed", staged);
    return refused(
      `\`${stored}\` holds what reads as an access token, so it is not kept` +
        (gone
          ? " and it was removed from the attachments folder. "
          : ". It could not be removed from the attachments folder: delete it there yourself. ") +
        `A source is kept as it is and every project member can open it: run the command again without printing the credential, ` +
        `save that output and keep it. If this is a page you fetched and not a command's output, fetch it again and give its URL as \`from\`.`,
    );
  }

  let written: ReturnType<typeof writeTaskSource>;
  try {
    written = writeTaskSource(
      projectSlug,
      taskKey,
      {
        name,
        data,
        title,
        from,
        by: { backend: actorRef.backend, profileId: actorRef.profileId, roleHint: actorRef.roleHint },
        runId: input.runId,
      },
      ctx.dataRoot,
    );
  } catch (error) {
    // The task keeps as much as it may: the store's own sentence.
    if (isAppError(error) && error.code === ERROR_CODES.VALIDATION_FAILED) return refused(error.userMessage);
    throw error;
  }
  if ("removed" in written) {
    const source = written.removed;
    return refused(
      `These bytes were kept as ${source.id} and that source has since been removed from the store, so they are not kept again. ` +
        `Say in your result that the source for this claim was removed.`,
    );
  }

  // The staged file has done its work. One that will not go stays hidden
  // where it is, posted nowhere, and the answer says so.
  const gone = removeStaged(abs, "a kept source's staged file could not be removed from the attachments folder", staged);
  const stuck = `The staged file \`${stored}\` could not be removed from the attachments folder; nothing posts it, and you may delete it.`;

  if ("already" in written) {
    const source = written.already;
    return (
      `[noop] These bytes are already kept as ${source.id} ("${source.title}"): cite ${source.id}. ` +
      (gone ? "The staged file was removed from the attachments folder." : stuck)
    );
  }
  const source = written.kept;
  recordAudit(db, {
    action: "task.source.kept",
    actor: { userId: null, label: encodeActorRef(actorRef) },
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: {
      actorRef: encodeActorRef(actorRef),
      id: source.id,
      name: source.name,
      bytes: source.bytes,
      sha256: source.sha256,
      from: source.from.slice(0, 300),
      runId: source.runId,
    },
  });
  return (
    `[kept] ${source.id}: ${source.name}, ${source.bytes.toLocaleString("en-US")} bytes, sha256 ${source.sha256.slice(0, 12)}. ` +
    (gone
      ? "The staged file left the attachments folder: it is a source now, not a file of the result. "
      : `It is a source now, not a file of the result. ${stuck} `) +
    `Cite ${source.id} beside the claim it supports.`
  );
}

/** The title of the one entry a run's kept sources leave on the timeline. */
export const SOURCES_KEPT_TITLE = "Sources kept";

export interface RunSourcesNote {
  projectSlug: string;
  taskKey: string;
  runId: string;
  actorRef: FileActorRef;
  /** When the run started, for a record written before its row had an id to
   *  give; null when the run's start was never recorded. */
  startedAt: string | null;
}

/** The sources a run kept: by its id, or, for a record that carries none, by
 *  its agent and its start. */
function keptByRun(sources: readonly TaskSource[], note: RunSourcesNote): TaskSource[] {
  const { actorRef, startedAt } = note;
  return sources.filter(
    (s) =>
      s.runId === note.runId ||
      (s.runId === null &&
        actorRef.kind === "agent" &&
        s.by.profileId === actorRef.profileId &&
        startedAt !== null &&
        s.keptAt >= startedAt),
  );
}

/**
 * Ruling 690: one entry on the timeline for a run that kept sources, written
 * when the run settles, whatever its end. A keep writes no entry of its own:
 * a run that keeps seventy pages would bury the thread. The entry is the
 * agent's, names the ids and points at the Sources panel.
 *
 * Boot recovery replays a run's lost effects, so an entry already there (the
 * same title, agent and text) is not written twice.
 */
export async function noteSourcesKeptByRun(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  note: RunSourcesNote,
): Promise<void> {
  const { projectSlug, taskKey, actorRef } = note;
  const kept = keptByRun(readTaskSources(projectSlug, taskKey, ctx.dataRoot).sources, note);
  if (kept.length === 0) return;
  const ids = kept.map((s) => s.id).join(", ");
  const text =
    kept.length === 1
      ? `Kept 1 source on this task: ${ids}. It is listed under Sources.`
      : `Kept ${kept.length} sources on this task: ${ids}. They are listed under Sources.`;
  const ref = taskRef(ctx, projectSlug, taskKey);
  const author = encodeActorRef(actorRef);
  const noted = readTaskFile(ref)?.parsed.timeline.some(
    (e) => e.type === "note" && e.title === SOURCES_KEPT_TITLE && e.text === text && encodeActorRef(e.actor) === author,
  );
  if (noted) return;
  await appendTimelineEvent(ref, {
    occurredAt: new Date().toISOString(),
    type: "note",
    actor: actorRef,
    title: SOURCES_KEPT_TITLE,
    text,
    toAgent: false,
    evidence: null,
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
}

/** A kept source as the task page's Sources panel lists it. */
export interface TaskSourceRow {
  id: string;
  /** The name it was saved under, which decides how the reader card opens it. */
  name: string;
  title: string;
  /** Where it came from, cut at 200 characters. */
  from: string;
  keptAt: string;
  /** The agent that kept it, by the name the page knows it under. */
  by: string;
  bytes: number;
}

/** How many sources the panel lists: the newest. The page says so when the
 *  task keeps more, as the attachments panel does. */
const SOURCES_LISTED = 100;

/**
 * Ruling 690: a task's sources for its page, newest first and at most
 * `SOURCES_LISTED` of them. `nameOf` names the agent that kept one, as the
 * rest of the page names it.
 */
export function taskSourceRows(
  sources: readonly TaskSource[],
  nameOf: (by: SourceKeeper) => string,
): TaskSourceRow[] {
  return sources
    .slice(-SOURCES_LISTED)
    .reverse()
    .map((s) => ({
      id: s.id,
      name: s.name,
      title: s.title,
      from: sourceFromShown(s.from),
      keptAt: s.keptAt,
      by: nameOf(s.by),
      bytes: s.bytes,
    }));
}
