import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef, TaskFileEvent } from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import {
  mergeKbCorrection,
  undoKbCorrection,
  type KbCorrection,
} from "~/server/org/kb-corrections.server";
import { toError } from "~/shared/errors";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 497: the task-side half of a knowledge-base correction, one
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
 * passage was and what it is now, and nobody is notified: nothing is owed.
 * The project's Controller page lists the corrections, with Undo.
 */

export const RULINGS_CORRECTED_TITLE = "Rulings corrected";
export const KB_CORRECTED_TITLE = "Knowledge base corrected";
export const KB_CORRECTION_UNDONE_TITLE = "Knowledge-base correction undone";

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
   *  form. */
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

/** The task's entry for a correction: where, its id, what the passage was and
 *  what it is now. The evidence stays on the record the Controller page reads. */
export function correctionEventText(c: KbCorrection): string {
  const where = `\`${c.kb}/${c.doc}\``;
  return c.replaced === null
    ? `Added to ${where} as \`${c.id}\`:\n\n- **Added:** ${clipLine(c.text, 280)}`
    : `Corrected ${where} as \`${c.id}\`:\n\n` +
        `- **Was:** ~~${clipLine(c.replaced, 160)}~~\n` +
        `- **Now:** ${clipLine(c.text, 280)}`;
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
  if (!doc || !text || !evidence) {
    return {
      outcome: "noop",
      message:
        "A correction needs the document to correct, the text to write, and the evidence that proves it. Nothing was written.",
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
  const event: TaskFileEvent = {
    occurredAt: c.at,
    type: "kb_correction",
    actor: input.actorRef,
    title: rulings ? RULINGS_CORRECTED_TITLE : KB_CORRECTED_TITLE,
    text: correctionEventText(c),
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  return {
    outcome: "done",
    message:
      `Corrected \`${c.kb}/${c.doc}\` as ${c.id}: ` +
      (rulings
        ? "the project's rulings, which every run on this project reads, now say what you wrote. "
        : "every run given that knowledge base reads what you wrote from now on. ") +
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
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "kb_correction",
    actor: { kind: "human", userId: input.person.userId, nameHint: input.person.name },
    title: KB_CORRECTION_UNDONE_TITLE,
    text:
      (c.replaced === null
        ? `The text \`${c.id}\` added to ${where} is gone:\n\n- **Removed:** ~~${clipLine(c.text, 280)}~~`
        : `${where} reads as it did before \`${c.id}\`:\n\n` +
          `- **Was:** ~~${clipLine(c.text, 160)}~~\n` +
          `- **Now:** ${clipLine(c.replaced, 280)}`) +
      (reason ? `\n\n**Why:** ${reason}` : ""),
    toAgent: false,
    evidence: null,
  };
  try {
    await updateTaskFile(taskRef(ctx, c.projectSlug, c.taskKey), (parsed) => {
      parsed.timeline.unshift(event);
    });
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
