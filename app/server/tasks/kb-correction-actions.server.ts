import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef, TaskFileEvent } from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { appendTimelineEvent } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  listKbCorrections,
  mergeKbCorrection,
  undoKbCorrection,
  type KbCorrection,
} from "~/server/org/kb-corrections.server";
import { toError } from "~/shared/errors";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 498: the task-side half of a knowledge-base correction, one
 * implementation for every agent that makes one — the operator (Claude tool
 * and Codex plan) and any specialist (its Claude tool) — and for the person who
 * undoes one. The store-side half, which writes the document and keeps the
 * record an undo reads, is `kb-corrections.server.ts`.
 *
 * Rulings 378 and 483 filed a PROPOSAL here, told every watcher with a
 * notification and a long timeline card, and waited for a person to promote
 * it. The owner, 2026-09-26: "proposal spam is exhausting … No human can
 * approve all of these while inspecting them thoroughly." A correction is now
 * written as it is made. The task records it in one short entry, what the
 * passage was, what it is now and what proves it (ruling 645), and nobody is
 * notified: nothing is owed. The project's Controller page lists the
 * corrections, with Undo.
 */

const RULINGS_CORRECTED_TITLE = "Rulings corrected";
const KB_CORRECTED_TITLE = "Knowledge base corrected";
const KB_CORRECTION_UNDONE_TITLE = "Knowledge-base correction undone";

/** What an agent corrects. */
export interface KbCorrectionRequest {
  /** The knowledge base, by the name its index heading gives it (its store
   *  directory); null for the project's rulings knowledge base. */
  kb: string | null;
  /** The document's path inside it, as the index lists it. */
  doc: string;
  /** The passage the correction replaces, exactly as the document has it;
   *  null adds `text` at the end of the document. */
  replaces: string | null;
  /** The text that takes its place: the corrected fact, in the document's own
   *  form; empty to delete the passage (ruling 581). */
  text: string;
  /** What proves it: the command and its output, a run, a verdict. */
  evidence: string;
}

export interface CorrectKnowledgeDocInput extends KbCorrectionRequest {
  projectSlug: string;
  taskKey: string;
  /** The timeline actor: the operator, or the agent that proved it. */
  actorRef: FileActorRef;
  /** Its name, for the record ("Operator", "Platform Engineer"). */
  filedBy: string;
  auditActor: AuditActor;
  /** The knowledge bases this filer's run was given; nothing else is its to
   *  correct. */
  allowedKbs: readonly string[];
}

export interface CorrectKnowledgeDocResult {
  outcome: "done" | "noop";
  message: string;
}

/**
 * The Codex plan names the target in one string field (`kbSource`): the
 * knowledge base and the document as `<kb>/<doc>`, or a bare document of the
 * project's rulings (ruling 378's form). The first segment is a knowledge base
 * only when the store has one by that name, so a nested rulings document
 * (`gates/ci.md`) is still read as the rulings'.
 */
export function splitKbSource(
  source: string,
  dataRoot?: string,
): Pick<KbCorrectionRequest, "kb" | "doc"> {
  const clean = source.trim().replace(/^\/+/, "");
  const at = clean.indexOf("/");
  if (at > 0) {
    const kb = clean.slice(0, at);
    try {
      if (existsSync(kbDirPath(kb, dataRoot))) return { kb, doc: clean.slice(at + 1) };
    } catch {
      // Not a name a store folder can have: the whole string is a document.
    }
  }
  return { kb: null, doc: clean };
}

/** One leading "Evidence:" label off the value: a model answering a field
 *  called `evidence` writes the label too (ruling 378's first live proposal
 *  filed "Evidence: Evidence: …"). */
function withoutEvidenceLabel(value: string): string {
  return value.trim().replace(/^evidence\s*:\s*/i, "").trim();
}

/** One side of a correction as the timeline shows it: one line, clipped. The
 *  document holds it whole, and the Controller page shows it whole. */
function clipLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Ruling 568: the specialists deployed on the project that do NOT hold the
 * knowledge base a correction wrote into, by name; empty when every one does,
 * and always empty for the project's rulings, which every run reads.
 *
 * A grant decides who reads a knowledge base, and a task's timeline is read by
 * every agent that can be engaged on it: the prompt's recent entries (ruling
 * 563), `read_timeline_entry`, the operator's snapshot. So a correction's entry
 * quotes the passage only when nobody the grant leaves out would read it there.
 * Live on AWSC-4 the Estimate Judge found an error in its own golden-set entry,
 * the knowledge base granted to it alone, and could not correct it: the entry
 * would have put the expected answers on a benchmark task, in front of the
 * agents under test. The operator asked Arda to edit the file by hand instead.
 */
async function agentsLeftOut(
  ctx: TaskMutationContext,
  projectSlug: string,
  c: Pick<KbCorrection, "kb" | "rulings">,
): Promise<string[]> {
  if (c.rulings) return [];
  const { listDeployedSpecialists } = await import("./specialist-roster.server");
  return listDeployedSpecialists(projectSlug, ctx)
    .filter((s) => !s.resources.kb.includes(c.kb))
    .map((s) => s.name);
}

/** Ruling 568: the sentence an entry carries instead of the passage. */
function notQuotedSentence(kb: string, leftOut: readonly string[]): string {
  const names =
    leftOut.length === 1
      ? leftOut[0]
      : `${leftOut.slice(0, -1).join(", ")} and ${leftOut[leftOut.length - 1]}`;
  return (
    `The passage is not quoted here: \`${kb}\` is not given to ${names}, who read this ` +
    "task. The project's Controller page shows the correction whole."
  );
}

/** The task's entry for a correction: where, its id, what the passage was,
 *  what it is now, and what proves it, each clipped to a line;
 *  `read_timeline_entry` reads them whole ({@link readCorrectionOfEntry}).
 *  Ruling 568: with agents the knowledge base is not given to, only where and
 *  the id. */
export function correctionEventText(c: KbCorrection, leftOut: readonly string[] = []): string {
  const where = `\`${c.kb}/${c.doc}\``;
  if (leftOut.length > 0) {
    return `${c.replaced === null ? "Added to" : "Corrected"} ${where} as \`${c.id}\`. ${notQuotedSentence(c.kb, leftOut)}`;
  }
  // Ruling 645: a correction without its proof on the task reads as a claim
  // nobody proved.
  const evidence = `- **Evidence:** ${clipLine(c.evidence, 280)}`;
  return c.replaced === null
    ? `Added to ${where} as \`${c.id}\`:\n\n- **Added:** ${clipLine(c.text, 280)}\n${evidence}`
    : `Corrected ${where} as \`${c.id}\`:\n\n` +
        `- **Was:** ~~${clipLine(c.replaced, 160)}~~\n` +
        `- **Now:** ${clipLine(c.text, 280)}\n` +
        evidence;
}

/** The correction an entry {@link correctionEventText} or an undo wrote names. */
const ENTRY_CORRECTION_ID_RE = /`(kc-[0-9a-f]{10})`/;

/** A correction as `read_timeline_entry` hands it to whoever reads its entry. */
export type CorrectionReading =
  | {
      id: string;
      where: string;
      filedBy: string;
      /** "stands", or who undid it, when, and why. */
      standing: string;
      /** The passage it replaced, whole; null when it added text at the end. */
      was: string | null;
      /** The text it wrote, whole. */
      now: string;
      evidence: string;
    }
  | { id: string; where: string; filedBy: string; standing: string; notQuoted: string }
  | { id: string; gone: string };

/**
 * Ruling 645: the correction a `kb_correction` entry names, whole, from its
 * record; null for an entry that names none.
 *
 * The entry clips each side to a line and, before this ruling, left the
 * evidence out, so no agent could read what proved a correction: the
 * Controller page, which shows it whole, is a person's. Live on AWSC-97 the
 * Estimate Judge, whose board requires a correction that narrows a VERIFIED
 * entry to cite its re-test, read both of the Cloud Solutions Architect's
 * corrections, found no citation, and asked a person to read them. Both
 * carried their evidence, the AWS guide that proved them, on the record.
 *
 * Ruling 568 holds here as on the entry: while a deployed agent is not given
 * the knowledge base, the reading names the document and the id and quotes
 * neither the passage nor the evidence that may restate it. Ruling 648: that
 * is for a reader the knowledge base is not given to. One given it, which
 * reads the document anyway, reads its corrections whole: live on AWSC-97 the
 * Calculator Builder corrected `aws-calculator-research`, which the Inventory
 * Analyst is not given, so the Estimate Judge, given it and charged with
 * checking that correction's re-test, read no evidence again. `readerKbs` is
 * what the reader is given, "all" for a person's controller; undefined reads
 * as given none.
 */
export async function readCorrectionOfEntry(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  projectSlug: string,
  entryText: string,
  readerKbs?: readonly string[] | "all",
): Promise<CorrectionReading | null> {
  const id = ENTRY_CORRECTION_ID_RE.exec(entryText)?.[1];
  if (!id) return null;
  const c = listKbCorrections(db, { id, projectSlug })[0];
  if (!c) {
    return {
      id,
      gone: "Its record is no longer kept (audit retention), so the entry's clipped lines are all there is.",
    };
  }
  const head = {
    id,
    where: `${c.kb}/${c.doc}`,
    filedBy: c.filedBy,
    standing: c.undone
      ? `undone by ${c.undone.by} at ${c.undone.at}${c.undone.reason ? `: "${c.undone.reason}"` : ""}`
      : "stands",
  };
  const given = readerKbs === "all" || (readerKbs?.includes(c.kb) ?? false);
  if (!given) {
    const leftOut = await agentsLeftOut(ctx, projectSlug, c);
    if (leftOut.length > 0) return { ...head, notQuoted: notQuotedSentence(c.kb, leftOut) };
  }
  return { ...head, was: c.replaced, now: c.text, evidence: c.evidence };
}

/**
 * Write one correction into a knowledge base the filer's run holds, then say
 * so on the task in one short entry. Refuses by name, writing nothing, when a
 * field is missing, when the knowledge base is not one this filer was given,
 * when the project names no rulings knowledge base and none was named, and
 * whatever `mergeKbCorrection` refuses.
 */
export async function correctKnowledgeDoc(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: CorrectKnowledgeDocInput,
): Promise<CorrectKnowledgeDocResult> {
  const doc = input.doc.trim();
  const text = input.text.trim();
  const evidence = withoutEvidenceLabel(input.evidence);
  const replaces = input.replaces?.trim() ? input.replaces : null;
  // Ruling 581: an empty `text` deletes the passage `replaces` names.
  if (!doc || (!text && !replaces) || !evidence) {
    return {
      outcome: "noop",
      message:
        "A correction needs the document to correct, the text to write (empty only to delete the passage in `replaces`), and the evidence that proves it. Nothing was written.",
    };
  }
  const rulingsKb = projectRulingsKb(input.projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {});
  const named = input.kb?.trim() || null;
  const kb = named ?? rulingsKb;
  if (!kb) {
    return {
      outcome: "noop",
      message:
        `${input.projectSlug} names no rulings knowledge base, so there is no settled document to correct. ` +
        "Name the knowledge base the passage is in, or say what you found on the timeline; a project admin can name a rulings knowledge base by asking the controller.",
    };
  }
  if (!input.allowedKbs.includes(kb)) {
    return {
      outcome: "noop",
      message:
        `No knowledge base \`${kb}\` was given to a run on this task, so it is not yours to correct. Nothing was written. ` +
        (input.allowedKbs.length > 0
          ? `You may correct: ${input.allowedKbs.map((n) => `\`${n}\``).join(", ")}.`
          : "No knowledge base was given to a run on this task."),
    };
  }
  const rulings = kb === rulingsKb;
  const merged = await mergeKbCorrection(
    db,
    {
      kb,
      doc,
      replaces,
      text: input.text,
      evidence,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      filedBy: input.filedBy,
      actorRef: encodeActorRef(input.actorRef),
      rulings,
      actor: input.auditActor,
    },
    ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {},
  );
  if (!merged.ok) return { outcome: "noop", message: merged.message };
  const c = merged.correction;
  const leftOut = await agentsLeftOut(ctx, input.projectSlug, c);
  const event: TaskFileEvent = {
    occurredAt: c.at,
    type: "kb_correction",
    actor: input.actorRef,
    title: rulings ? RULINGS_CORRECTED_TITLE : KB_CORRECTED_TITLE,
    text: correctionEventText(c, leftOut),
    toAgent: false,
    evidence: null,
  };
  await appendTimelineEvent(taskRef(ctx, input.projectSlug, input.taskKey), event);
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  return {
    outcome: "done",
    message:
      `Corrected \`${c.kb}/${c.doc}\` as ${c.id}: ` +
      (rulings
        ? "the project's rulings, which every run on this project reads, now say what you wrote. "
        : "every run given that knowledge base reads what you wrote from now on. ") +
      (leftOut.length > 0
        ? "The task's entry names the document and this correction without quoting it, because agents that read this task are not given that knowledge base. "
        : "") +
      "A person may undo it from the project's Controller page; if one does, do not write it again.",
  };
}

export interface UndoKbCorrectionOnTaskInput {
  id: string;
  /** The board the person undoes it from. */
  projectSlug: string;
  reason: string | null;
  person: { userId: string; label: string; name: string };
}

/**
 * A person undoes one correction: the document reads as it did before it, and
 * the task that made it says so, so its record does not go on claiming a
 * correction that no longer stands. The caller has checked the person may
 * (an org admin: this edits an org knowledge base).
 */
export async function undoKbCorrectionOnTask(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: UndoKbCorrectionOnTaskInput,
): Promise<CorrectKnowledgeDocResult> {
  const reason = input.reason?.trim() || null;
  const result = await undoKbCorrection(
    db,
    { id: input.id, projectSlug: input.projectSlug, reason, byName: input.person.name },
    { userId: input.person.userId, label: input.person.label },
    ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {},
  );
  if (result.outcome !== "done") return result;
  const c = result.correction;
  const where = `\`${c.kb}/${c.doc}\``;
  const leftOut = await agentsLeftOut(ctx, c.projectSlug, c);
  const quoted =
    c.replaced === null
      ? `The text \`${c.id}\` added to ${where} is gone:\n\n- **Removed:** ~~${clipLine(c.text, 280)}~~`
      : `${where} reads as it did before \`${c.id}\`:\n\n` +
        `- **Was:** ~~${clipLine(c.text, 160)}~~\n` +
        `- **Now:** ${clipLine(c.replaced, 280)}`;
  // Ruling 568: an undo quotes what the correction quoted, and no more.
  const body =
    leftOut.length > 0
      ? `${where} reads as it did before \`${c.id}\`. ${notQuotedSentence(c.kb, leftOut)}`
      : quoted;
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "kb_correction",
    actor: { kind: "human", userId: input.person.userId, nameHint: input.person.name },
    title: KB_CORRECTION_UNDONE_TITLE,
    text: body + (reason ? `\n\n**Why:** ${reason}` : ""),
    toAgent: false,
    evidence: null,
  };
  try {
    await appendTimelineEvent(taskRef(ctx, c.projectSlug, c.taskKey), event);
    reprojectTask(db, ctx, c.projectSlug, c.taskKey);
  } catch (error) {
    // The document is restored and the undo recorded; a task that can no
    // longer be written (removed since) only misses the note.
    logger.warn("kb correction undo: task note not written", {
      taskKey: c.taskKey,
      id: c.id,
      err: toError(error),
    });
  }
  return { outcome: "done", message: result.message };
}
