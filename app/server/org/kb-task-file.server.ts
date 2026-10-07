import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { isAppError } from "~/server/errors/app-error.server";
import { isInjectableKbDoc, isPrivateKbFolder } from "~/server/files/kb-injection.server";
import { resolveStoredSegment } from "~/server/files/file-store-root.server";
import { keptDeliveryMiss, resolveKeptDeliveryFile } from "~/server/files/kept-deliveries.server";
import {
  attachmentWholeText,
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

/**
 * Ruling 683: what a file copied into a knowledge base is kept as.
 *
 * - `template`: later results are filled into it, so it holds none of any
 *   task's content, only `[[what goes here]]` placeholders where content goes.
 * - `sample`: a worked example with one task's content in it, kept because a
 *   person asked for it, under a name that says so.
 * - `asset`: a file that is no task's work: a logo, a letterhead, a price
 *   list, the notes that go with a template.
 */
export type KeptFileKind = "template" | "sample" | "asset";

/**
 * A placeholder as a template marks one: `[[what goes here]]`, on one line,
 * opening on a letter (blanks before it are fine), at most 160 characters
 * between the brackets, and not the text of a link. That keeps out what only
 * looks like one in a finished result: a numbered citation (`[[1]]`), a
 * bracketed link (`[[Gartner 2024]](https://…)`), an array of numbers, of
 * strings or of JSON's own words (`[[10,20,30]]`, `[["acme",13381.01]]`,
 * `[[true,false]]`), a shell test (`[[ -f x ]]`).
 */
const TEMPLATE_PLACEHOLDER =
  /\[\[[ \t]{0,8}(?!(?:null|true|false)[ \t]*[,\]])\p{L}[^[\]\r\n]{0,159}\]\](?!\()/gu;

/**
 * A `<script>` whose `type` names something a browser runs. One with any other
 * type is a data block (`application/json`, `text/template`): the page reads
 * its content from it, and a template marks that content like any other.
 */
const RUNS_AS_CODE = /script|module|importmap|speculationrules|babel|jsx/i;

/** The most of an opening tag read for its `type`. */
const TAG_READ_CHARS = 512;

/**
 * A page's text without the code it runs and the style it applies: a browser
 * shows none of either, and a script is where a finished report keeps
 * `[[a,b]]` (a chart library's arrays, a map's entries), which no result is
 * filled into. An element left open takes the rest of the page, as it does
 * in a browser. One pass, whatever the text.
 */
function shownText(text: string): string {
  const opening = /<(script|style)\b/gi;
  let shown = "";
  let at = 0;
  for (let open = opening.exec(text); open; open = opening.exec(text)) {
    const tagEnd = text.indexOf(">", opening.lastIndex);
    // No `>` from here on: this is not a tag, and nothing after it is one.
    if (tagEnd === -1) break;
    const script = open[1]!.toLowerCase() === "script";
    if (script) {
      const attributes = text.slice(opening.lastIndex, Math.min(tagEnd, opening.lastIndex + TAG_READ_CHARS));
      const type = /\stype\s*=\s*["']?([^"'\s>]*)/i.exec(attributes)?.[1];
      if (type && !RUNS_AS_CODE.test(type)) {
        opening.lastIndex = tagEnd + 1;
        continue;
      }
    }
    const closing = script ? /<\/script\s*>/gi : /<\/style\s*>/gi;
    closing.lastIndex = tagEnd + 1;
    shown += text.slice(at, open.index);
    if (!closing.exec(text)) return shown;
    at = closing.lastIndex;
    opening.lastIndex = at;
  }
  return shown + text.slice(at);
}

/**
 * Ruling 683: how many placeholders a template's text holds. A tripwire for
 * the one mistake it exists for, a finished result copied as it stands, and
 * no proof that a file is free of a task's content: a result with one
 * placeholder left unfilled passes it, and so does one whose own text writes
 * double brackets around a word.
 */
function countPlaceholders(text: string): number {
  return shownText(text).match(TEMPLATE_PLACEHOLDER)?.length ?? 0;
}

/** Ruling 683: the name a sample is kept under: it says what it is and whose. */
function sampleName(taskKey: string, name: string): string {
  const prefix = `sample-${taskKey.toLowerCase()}-`;
  return name.toLowerCase().startsWith(prefix) ? name : `${prefix}${name}`;
}

export interface CopyTaskFileToKbInput {
  /** The knowledge base's id. */
  kbId: string;
  /** What the copy is kept as (ruling 683). */
  kind: KeptFileKind;
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
      /** Ruling 683: a template's placeholders, counted in its text; null for
       *  any other kind, and for a template no reader takes as text. */
      placeholders: number | null;
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
 *
 * Ruling 683: the copy says what it is kept as. The first template the
 * controller made was the report itself, one customer's figures and sentences
 * in the folder every run reads, and the next customer's proposal came back
 * with one of them. So a `template` whose text holds no `[[placeholder]]` is
 * refused as the result it is, and a `sample` takes a name that says whose
 * example it is.
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
    const asked = input.as?.trim() || path.basename(source);
    name = checkAttachmentUpload(input.kind === "sample" ? sampleName(input.taskKey, asked) : asked, size);
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
  // Ruling 683: a template is read whole, as a reader takes it (a PDF's text
  // layer, a page with its embedded pictures left out). Text with nowhere for
  // content to go is a finished result.
  let placeholders: number | null = null;
  if (input.kind === "template") {
    // Read as the file it is on the task, whatever name the copy takes.
    const text = attachmentWholeText(path.basename(source), read.bytes);
    placeholders = text === null ? null : countPlaceholders(text);
    if (placeholders === 0) {
      return refuse(
        `\`${wanted}\` marks no place for a task's content. A template marks each one with a placeholder, ` +
          "`[[what goes here]]`: on one line, opening on a letter. The code a page runs and its style are not read for them. " +
          `So as it stands this is a finished result with ${input.taskKey}'s content in it, ` +
          "or a template that marks those places some other way. A finished result kept as the template puts that content " +
          "where every run reads it, and a result built from it can repeat it. " +
          "Have an agent make the template first: file a task for the agent that makes such results, asking for the same layout " +
          "with everything that belongs to that task replaced by a `[[what goes here]]` placeholder, and copy what it delivers " +
          "once that task is accepted (`continue_when_done` leaves you that step, in a turn a person asked for). " +
          'Only when the person asked to keep a worked example, copy this as `kind: "sample"`.',
      );
    }
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
      kind: input.kind,
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
    placeholders,
  };
}
