import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { FileActorRef, TaskFileEvent } from "~/schemas/task-file.schema";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { encodeActorRef } from "~/server/files/actor-ref.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { projectRulingsKb } from "~/server/files/project-rulings.server";
import { updateTaskFile } from "~/server/files/task-writer.server";
import { fileKbProposal, KB_PROPOSALS_HEADING } from "~/server/org/kb-proposals.server";
import type { ActorRender } from "~/shared/mapping/actor.server";
import {
  notifyTaskWatchers,
  reprojectTask,
  taskRef,
  type TaskMutationContext,
} from "./task-mutation.server";

/**
 * Ruling 483: the task-side half of a proposed knowledge-base correction, one
 * implementation for every agent that files one — the operator (Claude tool
 * and Codex plan) and any specialist (its Claude tool). The store-side half,
 * which writes the document, is `fileKbProposal`.
 */

/** F40-59: the neutral titles. Ruling 378 titled every proposal "Ruling
 *  contradicted by evidence", which was wrong by design for the missing
 *  conventions ruling 418 sends through the same door and read as a failed
 *  review beside a verdict. */
export const RULING_PROPOSAL_TITLE = "Proposed ruling change";
export const KB_CORRECTION_TITLE = "Proposed knowledge-base correction";

/** What an agent proposes. */
export interface KbCorrection {
  /** The knowledge base, by the name its index heading gives it (its store
   *  directory); null for the project's rulings knowledge base. */
  kb: string | null;
  /** The document's path inside it, as the index lists it. */
  doc: string;
  /** The settled line it corrects, quoted; null when it adds something. */
  line: string | null;
  /** What should be true instead. */
  correction: string;
  /** What proves it: the command and its output, a run, a verdict. */
  evidence: string;
}

export interface ProposeKbCorrectionInput extends KbCorrection {
  projectSlug: string;
  taskKey: string;
  /** The timeline actor: the operator, or the agent that proved it. */
  actorRef: FileActorRef;
  /** Its name, for the entry's stamp ("Operator", "Platform Engineer"). */
  filedBy: string;
  auditActor: AuditActor;
  /** The notification's sender (ruling 361: the actor the timeline names). */
  from: ActorRender;
  /** The knowledge bases this filer's run was given; nothing else is its to
   *  propose against. */
  allowedKbs: readonly string[];
}

export interface ProposeKbCorrectionResult {
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
): Pick<KbCorrection, "kb" | "doc"> {
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

/**
 * File one proposal against a knowledge base the filer's run holds, then say so
 * on the task: a typed `proposal` event with a neutral title, an audit row, and
 * a notification to the task's watchers. Refuses by name, writing nothing, when
 * a field is missing, when the knowledge base is not one this filer was given,
 * when the project names no rulings knowledge base and none was named, and
 * whatever `fileKbProposal` refuses.
 */
export async function proposeKbCorrection(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: ProposeKbCorrectionInput,
): Promise<ProposeKbCorrectionResult> {
  const doc = input.doc.trim();
  const correction = input.correction.trim();
  const evidence = withoutEvidenceLabel(input.evidence);
  const line = input.line?.trim() || null;
  if (!doc || !correction || !evidence) {
    return {
      outcome: "noop",
      message:
        "A proposal needs the document to correct, the correction, and the evidence that proves it. Nothing was written.",
    };
  }
  const rulingsKb = projectRulingsKb(input.projectSlug, ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {});
  const named = input.kb?.trim() || null;
  const kb = named ?? rulingsKb;
  if (!kb) {
    return {
      outcome: "noop",
      message:
        `${input.projectSlug} names no rulings knowledge base, so there is no settled document to amend. ` +
        "Name the knowledge base the line is in, or say what you found on the timeline; a project admin can name a rulings knowledge base by asking the controller.",
    };
  }
  if (!input.allowedKbs.includes(kb)) {
    return {
      outcome: "noop",
      message:
        `No knowledge base \`${kb}\` was given to a run on this task, so it is not yours to propose against. Nothing was written. ` +
        (input.allowedKbs.length > 0
          ? `You may propose against: ${input.allowedKbs.map((n) => `\`${n}\``).join(", ")}.`
          : "No knowledge base was given to a run on this task."),
    };
  }
  const filed = await fileKbProposal(
    db,
    {
      kb,
      doc,
      line,
      correction,
      evidence,
      taskKey: input.taskKey,
      filedBy: input.filedBy,
      actor: input.auditActor,
    },
    ctx.dataRoot ? { dataRoot: ctx.dataRoot } : {},
  );
  if (!filed.ok) return { outcome: "noop", message: filed.message };
  const where = `\`${kb}/${filed.proposal.doc}\``;
  if (!filed.created) {
    return {
      outcome: "noop",
      message: `This correction is already proposed as ${filed.proposal.id} in ${where}, and still open. Nothing new was written.`,
    };
  }
  const rulings = kb === rulingsKb;
  const title = rulings ? RULING_PROPOSAL_TITLE : KB_CORRECTION_TITLE;
  const event: TaskFileEvent = {
    occurredAt: new Date().toISOString(),
    type: "proposal",
    actor: input.actorRef,
    title,
    text:
      `**Not binding until a person promotes it:** ${correction} ` +
      (line ? `It corrects "${line}". ` : "") +
      `Filed as \`${filed.proposal.id}\` under "${KB_PROPOSALS_HEADING.replace(/^#+ /, "")}" in ${where}` +
      (rulings
        ? ", the project's rulings, which every run on this project reads. "
        : ", where every run given that knowledge base reads it beside the line. ") +
      `Evidence: ${evidence}`,
    toAgent: false,
    evidence: null,
  };
  await updateTaskFile(taskRef(ctx, input.projectSlug, input.taskKey), (parsed) => {
    parsed.timeline.unshift(event);
  });
  reprojectTask(db, ctx, input.projectSlug, input.taskKey);
  recordAudit(db, {
    action: "task.kb_proposal.filed",
    actor: input.auditActor,
    subjectKind: "task",
    subjectId: input.taskKey,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: {
      actorRef: encodeActorRef(input.actorRef),
      id: filed.proposal.id,
      kb,
      doc: filed.proposal.doc,
      rulings,
      // Ruling 466: UTF-8 bytes, never a string length.
      bytes: filed.bytes,
    },
  });
  // A proposal is worth nothing if it only exists in a document nobody
  // re-reads: the people who can promote it are told.
  notifyTaskWatchers(
    db,
    {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      kind: "quality",
      title,
      text: event.text,
      occurredAt: event.occurredAt,
      // Ruling 497: its page is the entry on the Controller page, where it is
      // promoted or dismissed, not the task it came from.
      about: { proposal: filed.proposal.id },
      from: input.from,
    },
    ctx,
  );
  return {
    outcome: "done",
    message:
      `Proposed as ${filed.proposal.id} in ${where}. It is NOT binding: a person, or the controller when a person asks it, promotes or dismisses it.`,
  };
}
