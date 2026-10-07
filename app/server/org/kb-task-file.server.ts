import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { isAppError } from "~/server/errors/app-error.server";
import { isInjectableKbDoc, isPrivateKbFolder } from "~/server/files/kb-injection.server";
import { resolveStoredSegment } from "~/server/files/file-store-root.server";
import { keptDeliveryMiss, resolveKeptDeliveryFile } from "~/server/files/kept-deliveries.server";
import {
  checkAttachmentUpload,
  listTaskAttachmentNames,
  readAttachmentBytes,
  resolveTaskAttachment,
} from "~/server/files/task-attachments.server";
import { MAX_UPLOAD_BYTES } from "~/shared/attachment-kinds";
import { publishResourceUpdated } from "./resource-events.server";
import { resolveStoreTarget } from "./resources.server";
import { writeStoreFiles } from "./store-files.server";

/** The longest file name a store folder keeps (`cleanSegment`). */
const STORE_NAME_MAX_CHARS = 200;

/** The most bytes of UTF-8 one name on the disk holds. */
const DISK_NAME_MAX_BYTES = 255;

/** A character that would end, or hide in, the one line a knowledge base's
 *  index prints a name on: a control character, a line or paragraph
 *  separator, or the backtick that closes the name's own code span. */
function breaksAnIndexLine(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 || ch === "`";
}

/**
 * Ruling 678: what stops `name` from standing in a knowledge base's folder, as
 * the sentence that refuses it, or null. The store keeps a name's first 200
 * characters and a disk 255 bytes of one, so a longer name would land under a
 * name the reply never said, or fail the write. And the name is printed in
 * the knowledge base's index, in every prompt given it, so it holds nothing
 * that could end the line it stands on.
 */
function unfitName(name: string): string | null {
  const bytes = Buffer.byteLength(name, "utf8");
  if (name.length > STORE_NAME_MAX_CHARS || bytes > DISK_NAME_MAX_BYTES) {
    return (
      `\`${name.slice(0, 40)}…\` is ${name.length} characters (${bytes} bytes) long, and a file in a knowledge base is ` +
      `named in at most ${STORE_NAME_MAX_CHARS} characters and ${DISK_NAME_MAX_BYTES} bytes. Give it a shorter name with \`as\`.`
    );
  }
  if ([...name].some(breaksAnIndexLine)) {
    return (
      "A knowledge base's index names this file to every run given it, so its name cannot hold a line break, " +
      "a control character or a backtick. Give it a plain name with `as`."
    );
  }
  return null;
}

export interface CopyTaskFileToKbInput {
  /** The knowledge base's id. */
  kbId: string;
  projectSlug: string;
  taskKey: string;
  /** The attachment's name on the task. */
  name: string;
  /** A `deliveredAt` stamp, to copy the file as that delivery kept it. */
  delivery?: string;
  /** The name it takes in the knowledge base; the file's own when absent. */
  as?: string;
  /** Replace a file of that name the knowledge base already holds. */
  replace?: boolean;
  actor: AuditActor;
}

export type CopyTaskFileToKbResult =
  | {
      ok: true;
      kbName: string;
      /** The folder a run's shell opens the file in. */
      folder: string;
      /** Its name there. */
      path: string;
      bytes: number;
      replaced: boolean;
      /** It is a document: indexed with its sections, read with the knowledge tool. */
      document: boolean;
    }
  | { ok: false; message: string };

/**
 * Ruling 678: a file a task holds, copied into a knowledge base's folder.
 *
 * Asked live, on the AWS calculator board, to make the report AWSC-117
 * delivered the template for every later estimate, the controller had nowhere
 * to put it. A knowledge-base write takes text the model types, and the
 * template is a 606 KB page with its images inside and the PDF printed from
 * it. So it left both on AWSC-117 and wrote a rule telling each task's
 * operator to copy them over first, and said itself what that costs: archive
 * AWSC-117 and the copy is refused, and a rework there changes the template
 * for every board task after it. The copy is made here, bytes and all, into
 * the folder every run given the knowledge base reads; the task's own file is
 * not touched, and nothing depends on it afterwards.
 *
 * Refuses, writing nothing: a knowledge base or a file that is not there; a
 * file over an upload's size or through a link (the relay's own read); a name
 * the folder already holds, unless `replace`; a document already there, whose
 * own doors check what they replace; and a file that is not a document for a
 * private knowledge base, where no run could open it.
 */
export function copyTaskFileToKnowledgeBase(
  db: DatabaseSync,
  input: CopyTaskFileToKbInput,
  ctx: { dataRoot?: string } = {},
): CopyTaskFileToKbResult {
  const refuse = (message: string): CopyTaskFileToKbResult => ({ ok: false, message: `${message} Nothing was copied.` });
  const target = resolveStoreTarget(db, "kb", input.kbId, { dataRoot: ctx.dataRoot });
  if (!target) return refuse(`No knowledge base with id ${input.kbId}; list_knowledge_bases names them.`);

  const wanted = input.name.trim();
  const delivery = input.delivery?.trim() || undefined;
  let source: string | null;
  try {
    source = delivery
      ? resolveKeptDeliveryFile(input.projectSlug, input.taskKey, delivery, wanted, ctx.dataRoot)
      : resolveTaskAttachment(input.projectSlug, input.taskKey, wanted, ctx.dataRoot);
  } catch {
    source = null;
  }
  const read = source ? readAttachmentBytes(source, MAX_UPLOAD_BYTES) : null;
  if (!read || !source) {
    if (delivery) {
      return refuse(keptDeliveryMiss(input.projectSlug, input.taskKey, delivery, wanted, ctx.dataRoot).replace(/^\[noop\] /, ""));
    }
    const have = listTaskAttachmentNames(input.projectSlug, input.taskKey, ctx.dataRoot);
    return refuse(
      `${input.taskKey} has no attachment \`${wanted}\`. ` +
        (have.length > 0 ? `It holds: ${have.join(", ")}.` : "It has no attachments."),
    );
  }
  const size = "tooLarge" in read ? read.tooLarge : read.bytes.byteLength;
  let name: string;
  try {
    // The upload's own rules for a name and a size, and its stored form.
    name = checkAttachmentUpload(input.as?.trim() || path.basename(source), size);
  } catch (error) {
    return refuse(isAppError(error) ? error.userMessage : `\`${wanted}\` cannot be copied.`);
  }
  if ("tooLarge" in read) return refuse(`\`${wanted}\` cannot be copied.`);
  // Ruling 675: a file the folder holds under the same name in the other
  // Unicode form is the one this would replace, so that file's spelling is
  // the name written, and the one the checks below are about.
  const into = resolveStoredSegment(target.rootAbs, name);
  const stored = path.basename(into);
  const unfit = unfitName(stored);
  if (unfit) return refuse(unfit);
  const document = isInjectableKbDoc(stored);
  if (!document && isPrivateKbFolder(target.rootAbs)) {
    return refuse(
      `${target.name} is private: its folder is closed to every agent's shell, and a run given it reads documents only, ` +
        `so no run could open \`${stored}\` there. Copy it into an open knowledge base.`,
    );
  }
  const there = existsSync(into) ? statSync(into) : null;
  if (there?.isFile() && document) {
    return refuse(
      `${target.name} already holds the document \`${stored}\`. Change a document with edit_knowledge_base_doc or ` +
        "save_knowledge_base, which check what they replace, or copy this file under another name with `as`.",
    );
  }
  if (there?.isFile() && !input.replace) {
    return refuse(
      `${target.name} already holds a file named \`${stored}\` (${there.size.toLocaleString("en-US")} bytes). ` +
        "Pass `replace: true` to put this one in its place, or another name in `as`.",
    );
  }
  let added: number;
  try {
    added = writeStoreFiles(db, target, [], [{ relPath: stored, data: read.bytes }], input.actor, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      name: path.basename(source),
      as: stored,
      replaced: there?.isFile() === true,
    }).added;
  } catch (error) {
    if (isAppError(error)) return refuse(error.userMessage);
    throw error;
  }
  // The store skips a path it will not keep (a name with two dots in a row)
  // and says so only in its count, so the count is what this answers by.
  if (added !== 1) {
    return refuse(
      `The store keeps no file named \`${stored}\`: it skips a name with two dots in a row. Give it another name with \`as\`.`,
    );
  }
  publishResourceUpdated("kb", target.id);
  return {
    ok: true,
    kbName: target.name,
    folder: target.rootAbs,
    path: stored,
    bytes: read.bytes.byteLength,
    replaced: there?.isFile() === true,
    document,
  };
}
