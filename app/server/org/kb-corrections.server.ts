import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import { kbDirPath } from "~/server/files/file-store-root.server";
import { collectKbDocs, resolveKbDocPath } from "~/server/files/kb-injection.server";
import { fenceFor } from "~/shared/text/fence";
import { legacyProposalsSpan, looseText } from "./kb-proposals.server";
import { publishResourceUpdated } from "./resource-events.server";
import { kbStoreTargetForDir } from "./resources.server";
import { utf8Bytes, writeStoreDoc } from "./store-files.server";

/**
 * Ruling 498: a correction an agent PROVED, written straight into the
 * knowledge-base document it corrects, and undone by a person who disagrees.
 *
 * Rulings 378 and 483 filed every correction as a proposal under "Proposed
 * corrections (not binding)" for a person to promote, one controller turn per
 * Promote. The owner, 2026-09-26, on a Platform Engineer's proposal about the
 * deploy runbook: "proposal spam is exhausting, it should be easier to get them
 * merged to the kb. No human can approve all of these while inspecting them
 * thoroughly." A queue nobody can review thoroughly is a rubber stamp with a
 * delay, and the stale line stays the settled text until the stamp comes. So
 * the agent that proved the line wrong writes the fix: the exact passage it
 * replaces, the text that takes its place, and its evidence. Every run after
 * it reads the corrected document; a person reads what changed afterwards and
 * undoes what they disagree with. That holds for the project's rulings too.
 *
 * The record is an audit row, `task.kb_correction.merged`, carrying the
 * passage that was replaced and the text that replaced it, so an undo is the
 * same edit in reverse and needs no second copy of the document. It lives as
 * long as audit retention keeps it (`AUDIT_RETENTION_DAYS`). An undo writes
 * `task.kb_correction.undone`, and a later attempt to write the same text into
 * the same document is refused, naming the person who undid it: an agent does
 * not argue with a person by re-filing.
 *
 * Two rules keep every correction undoable: the passage replaced must stand
 * exactly once in the document, and the text written must stand exactly once
 * after the write. A document edited since (by hand, or by a later correction
 * over the same text) is not undone blindly: the undo refuses and says to edit
 * it by hand.
 */

export const KB_CORRECTION_MERGED_ACTION = "task.kb_correction.merged";
export const KB_CORRECTION_UNDONE_ACTION = "task.kb_correction.undone";

/** A correction replaces a passage, not a document: each side is capped, which
 *  also bounds the audit row that carries both (UTF-8 bytes, ruling 466). */
export const KB_CORRECTION_MAX_BYTES = 8 * 1024;

/** The evidence kept on the record. It is read, never replayed, so a long
 *  command output is clipped rather than refused. */
const EVIDENCE_KEPT_CHARS = 4000;

/** One correction, as its record holds it. */
export interface KbCorrection {
  /** `kc-` and ten hex characters. */
  id: string;
  /** The knowledge base's store directory (the grant key). */
  kb: string;
  /** The document's path inside it. */
  doc: string;
  /** It was written into the project's rulings knowledge base. */
  rulings: boolean;
  /** The passage it replaced; null when it added text at the document's end. */
  replaced: string | null;
  /** The text it wrote. */
  text: string;
  evidence: string;
  projectSlug: string;
  taskKey: string;
  /** Who made it: the agent's name, or "Operator". */
  filedBy: string;
  /** When it was written (ISO). */
  at: string;
  /** Set once a person undid it. */
  undone: { at: string; by: string; reason: string | null } | null;
}

// ------------------------------------------------------------------ text

/** The document's line ending: a correction is matched and written in it. */
function eolOf(raw: string): string {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

/** A value as the document would hold it: its line endings, and no blank
 *  lines leading or trailing (a model's value often ends in one). */
function asDocText(value: string, eol: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .join(eol);
}

/**
 * How many times `needle` stands in `hay`, overlapping ones included (ruling
 * 581): an undo takes the first match, so "\n- a\n" in "\n- a\n- a\n" stands
 * twice, not the once a split sees.
 */
function occurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) count += 1;
  return count;
}

/**
 * The document with an unmerged proposals section (rulings 378 and 483) masked
 * out, index for index: a passage an entry merely quotes is not in the settled
 * text, so it can be neither replaced nor counted.
 */
function settledView(raw: string): string {
  const span = legacyProposalsSpan(raw);
  return span
    ? raw.slice(0, span.start) + "\u0000".repeat(span.end - span.start) + raw.slice(span.end)
    : raw;
}

/** Where an addition goes: the end of the settled text, which is before an
 *  unmerged proposals section when the document still has one. */
function appendAt(raw: string): number {
  return legacyProposalsSpan(raw)?.start ?? raw.length;
}

/** The document with `text` added at the end of its settled text, a blank
 *  line before it. */
function withAppended(raw: string, text: string, eol: string): string {
  const at = appendAt(raw);
  const head = raw.slice(0, at).trimEnd();
  const rest = raw.slice(at);
  return `${head ? `${head}${eol}${eol}` : ""}${text}${eol}${rest ? `${eol}${rest}` : ""}`;
}

/** The document without an addition standing at `at`, and the blank lines
 *  that set it apart. */
function withoutAddition(raw: string, at: number, length: number, eol: string): string {
  const before = raw.slice(0, at).trimEnd();
  const after = raw.slice(at + length).replace(/^(\r?\n)+/, "");
  if (!before) return after;
  return after ? `${before}${eol}${eol}${after}` : `${before}${eol}`;
}

/**
 * The document's lines closest to a passage that is not in it, verbatim, so
 * the agent can copy what the document actually says. A model quotes the line
 * it means with its own emphasis, quotes and list marker; the refusal hands
 * back the document's.
 */
function closestLines(raw: string, passage: string): string[] {
  const first = passage.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const words = [...new Set(looseText(first).split(" ").filter((w) => w.length >= 3))];
  if (words.length === 0) return [];
  const need = Math.max(1, Math.ceil(words.length * 0.6));
  const scored: { line: string; score: number }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.includes("\u0000")) continue;
    const loose = looseText(line);
    const score = words.filter((w) => loose.includes(w)).length;
    if (score >= need) scored.push({ line, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.line);
}

function heldDocsSentence(kb: string, dataRoot?: string): string {
  let held: string[] = [];
  try {
    held = collectKbDocs(kbDirPath(kb, dataRoot)).map((d) => d.rel);
  } catch {
    held = [];
  }
  if (held.length === 0) return "It holds no documents.";
  const shown = held.slice(0, 40);
  return (
    `It holds: ${shown.join(", ")}` +
    (held.length > shown.length ? `, and ${held.length - shown.length} more.` : ".")
  );
}

function clipEvidence(value: string): string {
  return value.length > EVIDENCE_KEPT_CHARS
    ? `${value.slice(0, EVIDENCE_KEPT_CHARS).trimEnd()}…`
    : value;
}

/** The day part of an ISO instant, for the sentences that name one. */
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

// ------------------------------------------------------------------ record

const MergedDetails = z.object({
  id: z.string(),
  kb: z.string(),
  doc: z.string(),
  rulings: z.boolean(),
  replaced: z.string().nullable(),
  text: z.string(),
  evidence: z.string(),
  filedBy: z.string(),
});

const UndoneDetails = z.object({
  id: z.string(),
  reason: z.string().nullable().optional(),
  byName: z.string().nullable().optional(),
});

/** A type literal, not an interface: the SQLite row type converts to one. */
type CorrectionAuditRow = {
  action: string;
  occurred_at: string;
  actor_label: string;
  project_slug: string | null;
  task_key: string | null;
  details_json: string | null;
};

/** A row's `details_json` read as one record's shape, or null when it is
 *  absent, not JSON, or another shape. */
function detailsAs<T extends z.ZodType>(schema: T, json: string | null): z.infer<T> | null {
  if (!json) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Which corrections {@link listKbCorrections} reads. */
export interface KbCorrectionFilter {
  /** One board's tasks. */
  projectSlug?: string;
  /** One correction. */
  id?: string;
}

/**
 * The corrections on record, newest first, each with whether a person undid
 * it. Read from the audit rows the merge and the undo write.
 */
export function listKbCorrections(
  db: DatabaseSync,
  filter: KbCorrectionFilter = {},
): KbCorrection[] {
  const where = ["action IN (?, ?)"];
  const args: string[] = [KB_CORRECTION_MERGED_ACTION, KB_CORRECTION_UNDONE_ACTION];
  if (filter.projectSlug) {
    // The unary plus keeps this term off `idx_audit_events__task_action`,
    // whose leading column it is: that index walks every reconcile row the
    // project ever wrote (288 a day per task), where the action index holds
    // only the corrections.
    where.push("+project_slug = ?");
    args.push(filter.projectSlug);
  }
  if (filter.id) {
    where.push("json_extract(details_json, '$.id') = ?");
    args.push(filter.id.trim());
  }
  // SAFETY: the six selected columns are the `audit_events` columns of the
  // same names (0001_baseline.sql): `action`, `occurred_at` and `actor_label`
  // TEXT NOT NULL, the other three nullable TEXT.
  const rows = db
    .prepare(
      `SELECT action, occurred_at, actor_label, project_slug, task_key, details_json
         FROM audit_events
        WHERE ${where.join(" AND ")}
        ORDER BY occurred_at DESC, rowid DESC`,
    )
    .all(...args) as CorrectionAuditRow[];
  const undone = new Map<string, NonNullable<KbCorrection["undone"]>>();
  for (const row of rows) {
    if (row.action !== KB_CORRECTION_UNDONE_ACTION) continue;
    const details = detailsAs(UndoneDetails, row.details_json);
    if (!details || undone.has(details.id)) continue;
    undone.set(details.id, {
      at: row.occurred_at,
      by: details.byName?.trim() || row.actor_label,
      reason: details.reason?.trim() || null,
    });
  }
  const out: KbCorrection[] = [];
  for (const row of rows) {
    if (row.action !== KB_CORRECTION_MERGED_ACTION || !row.project_slug || !row.task_key) continue;
    const details = detailsAs(MergedDetails, row.details_json);
    if (!details) continue;
    out.push({
      ...details,
      projectSlug: row.project_slug,
      taskKey: row.task_key,
      at: row.occurred_at,
      undone: undone.get(details.id) ?? null,
    });
  }
  return out;
}

// ------------------------------------------------------------------ merging

export interface MergeKbCorrectionInput {
  /** The knowledge base's store directory. */
  kb: string;
  /** The document's path inside it. */
  doc: string;
  /** The passage the correction replaces, exactly as the document has it;
   *  null adds `text` at the end of the document. */
  replaces: string | null;
  /** The text to write. */
  text: string;
  evidence: string;
  projectSlug: string;
  taskKey: string;
  /** The filer's name, for the record ("Operator", "Platform Engineer"). */
  filedBy: string;
  /** The filer's timeline actor, encoded, for the record. */
  actorRef: string;
  /** The knowledge base is the project's rulings. */
  rulings: boolean;
  actor: AuditActor;
  now?: Date;
}

export type MergeKbCorrectionResult =
  | { ok: true; correction: KbCorrection }
  | { ok: false; message: string };

/** Ruling 581: the most neighbouring characters a record takes on each side. */
const ANCHOR_MAX_CHARS = 400;

/** Not whitespace, and not a masked proposals character. */
const isWordChar = (ch: string | undefined) => ch !== undefined && ch !== "\u0000" && !/\s/.test(ch);

/**
 * Ruling 581: the span of `doc` a record names for the text written at
 * `doc[start, start + length)`, so that it stands once and is not blank: the
 * text itself when it does; else the lines it sits in, taking the lines after
 * and before in turn until they do; else, where lines run long, characters
 * after and before in turn, finishing the word it cut. It never reaches into
 * a masked proposals section. Null when {@link ANCHOR_MAX_CHARS} on each side
 * is not enough.
 */
function anchorAround(doc: string, start: number, length: number): { from: number; to: number } | null {
  const end = start + length;
  const standsOnce = (from: number, to: number) => {
    const span = doc.slice(from, to);
    return span.trim() !== "" && !span.includes("\u0000") && occurrences(doc, span) === 1;
  };
  if (standsOnce(start, end)) return { from: start, to: end };
  const lineStart = (at: number) => doc.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = (at: number) => {
    const nl = doc.indexOf("\n", at);
    return nl === -1 ? doc.length : nl + 1;
  };
  let from = lineStart(start);
  let to = length > 0 && doc[end - 1] === "\n" ? end : lineEnd(end);
  for (let takeAfter = true; start - from <= ANCHOR_MAX_CHARS && to - end <= ANCHOR_MAX_CHARS; takeAfter = !takeAfter) {
    if (standsOnce(from, to)) return { from, to };
    if (doc.slice(from, to).includes("\u0000")) break;
    const after = lineEnd(to);
    const before = from > 0 ? lineStart(from - 1) : 0;
    if (after === to && before === from) break;
    if ((takeAfter && after !== to) || before === from) to = after;
    else from = before;
  }
  let before = 0;
  let after = 0;
  const canTakeAfter = () => after < ANCHOR_MAX_CHARS && end + after < doc.length && doc[end + after] !== "\u0000";
  const canTakeBefore = () => before < ANCHOR_MAX_CHARS && start - before > 0 && doc[start - before - 1] !== "\u0000";
  while (!standsOnce(start - before, end + after)) {
    if (canTakeAfter() && (after <= before || !canTakeBefore())) after += 1;
    else if (canTakeBefore()) before += 1;
    else return null;
  }
  // A longer span holds the one that stands once, so it stands once too.
  while (before > 0 && isWordChar(doc[start - before]) && isWordChar(doc[start - before - 1]) && canTakeBefore()) before += 1;
  while (after > 0 && isWordChar(doc[end + after - 1]) && isWordChar(doc[end + after]) && canTakeAfter()) after += 1;
  return { from: start - before, to: end + after };
}

/**
 * Write one correction into a document the knowledge base already holds, and
 * keep the record an undo reads.
 *
 * An empty `text` deletes the passage `replaces` names (ruling 581). When the
 * text written would not stand once, the record takes the lines around it
 * until it does, so an undo can still find it; the document is written the
 * same.
 *
 * Refuses, writing nothing: a document the knowledge base does not hold (a
 * typo would otherwise CREATE a settled-looking document, ruling 378); a
 * passage that does not stand exactly once in the settled text, handing back
 * the document's closest lines; an addition the document already holds; a
 * side over {@link KB_CORRECTION_MAX_BYTES}; and a correction a person already
 * undid in this document.
 */
export async function mergeKbCorrection(
  db: DatabaseSync,
  input: MergeKbCorrectionInput,
  ctx: { dataRoot?: string } = {},
): Promise<MergeKbCorrectionResult> {
  if (
    utf8Bytes(input.text) > KB_CORRECTION_MAX_BYTES ||
    utf8Bytes(input.replaces ?? "") > KB_CORRECTION_MAX_BYTES
  ) {
    return {
      ok: false,
      message:
        `A correction replaces a passage, not a document: \`replaces\` and \`text\` are each at most ${KB_CORRECTION_MAX_BYTES} bytes. ` +
        "Nothing was written. Correct the lines that are wrong, one passage at a time.",
    };
  }
  const located = resolveKbDocPath(input.kb, input.doc, ctx.dataRoot);
  if (!located) {
    return {
      ok: false,
      message:
        `"${input.doc}" is not a document in the knowledge base ${input.kb}. Nothing was written. ` +
        heldDocsSentence(input.kb, ctx.dataRoot),
    };
  }
  const target = kbStoreTargetForDir(db, input.kb, ctx);
  if (!target) {
    return {
      ok: false,
      message: `The knowledge base "${input.kb}" no longer resolves in the store. Nothing was written.`,
    };
  }
  const where = `${input.kb}/${located.rel}`;
  const undoneBefore = (text: string) => {
    const refused = listKbCorrections(db).find(
      (c) => c.undone && c.kb === input.kb && c.doc === located.rel && looseText(c.text) === looseText(text),
    );
    if (!refused?.undone) return null;
    return {
      ok: false as const,
      message:
        `${refused.undone.by} undid this same correction of ${where} on ${dayOf(refused.undone.at)} ` +
        `(${refused.id}${refused.undone.reason ? `: "${refused.undone.reason}"` : ""}). Nothing was written. ` +
        "Do not write it again. If your evidence says they are wrong, put it to a person (a question, or a decision packet) and let them decide.",
    };
  };
  const refused = undoneBefore(input.text);
  if (refused) return refused;
  return withFileLock(`kb-doc:${located.abs}`, () => {
    const raw = readFileSync(located.abs, "utf8");
    const eol = eolOf(raw);
    const text = asDocText(input.text, eol);
    const replaces = input.replaces === null ? null : asDocText(input.replaces, eol);
    // Ruling 581: an empty `text` deletes the passage `replaces` names; with
    // no passage there is nothing to delete and nothing to add.
    if (!text.trim() && !replaces) {
      return {
        ok: false as const,
        message: "A correction needs the text to write, or the passage to delete in `replaces`. Nothing was written.",
      };
    }
    // The settled view masks a proposals section with NUL, which no text
    // document holds: a passage of them would reach into the masked span.
    if (text.includes("\u0000") || replaces?.includes("\u0000")) {
      return {
        ok: false as const,
        message: "A correction is text: `replaces` and `text` cannot hold a NUL character. Nothing was written.",
      };
    }
    const settled = settledView(raw);
    let next: string;
    /** What the record names, which an undo swaps back: ruling 581 widens it. */
    let recorded = { replaced: replaces, text };
    if (replaces) {
      const count = occurrences(settled, replaces);
      if (count === 0) {
        // Ruling 581: a retry finds its own record. Text that merely stands
        // in the document proves nothing: " Evidence:" stood 56 times in the
        // calculator research when a Researcher's passage was one character
        // off, and a deletion writes no text at all.
        const made = listKbCorrections(db).find(
          (c) =>
            !c.undone &&
            c.kb === input.kb &&
            c.doc === located.rel &&
            c.replaced !== null &&
            asDocText(c.replaced, eol).includes(replaces) &&
            asDocText(c.text, eol).includes(text) &&
            occurrences(settled, asDocText(c.text, eol)) === 1,
        );
        if (made) {
          return {
            ok: false as const,
            message: `${made.id} made this correction of ${where} on ${dayOf(made.at)}, and it stands. Nothing needed writing.`,
          };
        }
        const standing = occurrences(settled, text);
        const near = closestLines(settled, replaces);
        return {
          ok: false as const,
          message:
            `The passage you sent as \`replaces\` is not in ${where} exactly as you sent it. Nothing was written. ` +
            (standing > 0
              ? `Your \`text\` stands there ${standing === 1 ? "once" : `${standing} times`} already: if the correction you meant is in, it needs nothing more. If not, copy`
              : "Copy") +
            " the passage character for character from the document (read_knowledge_doc returns it), list marker and emphasis included" +
            (near.length > 0
              ? `; the lines closest to it read:\n${fenceFor(near.join("\n"))}\n${near.join("\n")}\n${fenceFor(near.join("\n"))}`
              : ". No line of the document is close to it."),
        };
      }
      if (count > 1) {
        return {
          ok: false as const,
          message: `The passage you sent as \`replaces\` stands ${count} times in ${where}. Nothing was written. Send more of it, so it stands once.`,
        };
      }
      if (replaces === text) {
        return {
          ok: false as const,
          message: `${where} already says that: \`text\` is the passage it would replace. Nothing needed writing.`,
        };
      }
      const at = settled.indexOf(replaces);
      next = raw.slice(0, at) + text + raw.slice(at + replaces.length);
      // Ruling 581: an undo finds a correction by the text it wrote, so that
      // text has to stand once. A deletion writes none, and a corrected line
      // can repeat one the document holds elsewhere, so the record takes the
      // lines around it until it does. The document written is the same
      // either way; only what the record names grows.
      const anchor = anchorAround(settledView(next), at, text.length);
      if (!anchor) {
        return {
          ok: false as const,
          message:
            `Your \`text\` would not stand once in ${where} after the write, even with the lines around it, so an undo could not tell which one is yours. ` +
            "Nothing was written. Correct a longer passage, so the corrected text is one of a kind.",
        };
      }
      // The written text and the passage share what lies around them.
      recorded = {
        replaced: raw.slice(anchor.from, anchor.to - text.length + replaces.length),
        text: next.slice(anchor.from, anchor.to),
      };
    } else {
      if (occurrences(settled, text) > 0) {
        return {
          ok: false as const,
          message: `${where} already says that. Nothing needed writing.`,
        };
      }
      next = withAppended(raw, text, eol);
    }
    const standing = occurrences(settledView(next), recorded.text);
    if (standing !== 1) {
      return {
        ok: false as const,
        message:
          `Your \`text\` would stand ${standing} times in ${where} after the write, so an undo could not tell which one is yours. ` +
          "Nothing was written. Include more of the line in `replaces` and `text`, so the corrected text stands once.",
      };
    }
    // Ruling 581: the same correction made again takes the same lines around
    // it, so a person's undo still refuses its repeat.
    const undoneAnchored = recorded.text === text ? null : undoneBefore(recorded.text);
    if (undoneAnchored) return undoneAnchored;
    const segments = located.rel.split("/");
    const name = segments.pop()!;
    writeStoreDoc(db, target, segments, name, next, input.actor, { overwrite: true });
    const at = (input.now ?? new Date()).toISOString();
    const correction: KbCorrection = {
      id: `kc-${sha256Hex(`${input.kb}\n${located.rel}\n${recorded.replaced ?? ""}\n${recorded.text}\n${at}`).slice(0, 10)}`,
      kb: input.kb,
      doc: located.rel,
      rulings: input.rulings,
      replaced: recorded.replaced,
      text: recorded.text,
      evidence: clipEvidence(input.evidence.trim()),
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      filedBy: input.filedBy,
      at,
      undone: null,
    };
    recordAudit(db, {
      action: KB_CORRECTION_MERGED_ACTION,
      actor: input.actor,
      subjectKind: "task",
      subjectId: input.taskKey,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: {
        id: correction.id,
        kb: correction.kb,
        doc: correction.doc,
        rulings: correction.rulings,
        replaced: correction.replaced,
        text: correction.text,
        evidence: correction.evidence,
        filedBy: correction.filedBy,
        actorRef: input.actorRef,
        // Ruling 466: UTF-8 bytes, never a string length.
        bytes: utf8Bytes(text),
      },
    });
    publishResourceUpdated("kb", target.id);
    return { ok: true as const, correction };
  });
}

// ------------------------------------------------------------------ editing

export interface EditKbPassageInput {
  /** The knowledge base's store directory. */
  kb: string;
  /** The document's path inside it. */
  doc: string;
  /** The passage to replace, exactly as the document has it. */
  was: string;
  /** What takes its place; empty deletes the passage. */
  now: string;
  actor: AuditActor;
}

export type EditKbPassageResult =
  | { ok: true; bytes: number; previousBytes: number }
  | { ok: false; message: string };

/**
 * Ruling 637: a person's edit of one passage of a knowledge-base document,
 * made through the controller.
 *
 * The controller could only replace a document whole or append to it. Live on
 * 2026-10-03, to put three sentences into the 104 KB
 * `aws-migration-mapping/mapping.md`, it read the document in four pages and
 * typed it back in nine calls: a replace that cut it to 19,587 bytes, then
 * eight appends. Between the first call and the last, every run that read the
 * document read part of it, and every line in it was the model's copy of what
 * it had read. This replaces one passage the way an agent's correction does:
 * the passage must stand exactly once, and the document is written once, under
 * the lock corrections take. It keeps no correction record, because the person
 * who asked for the edit decided it and there is nothing left for a person to
 * undo; the audit row of the write names the passage and what replaced it.
 *
 * Refuses, writing nothing: a document the knowledge base does not hold; an
 * empty passage (adding at the end is an append); a passage that does not stand
 * exactly once, handing back the document's closest lines; an edit that changes
 * nothing; and a side over {@link KB_CORRECTION_MAX_BYTES}.
 */
export async function editKbPassage(
  db: DatabaseSync,
  input: EditKbPassageInput,
  ctx: { dataRoot?: string } = {},
): Promise<EditKbPassageResult> {
  if (utf8Bytes(input.was) > KB_CORRECTION_MAX_BYTES || utf8Bytes(input.now) > KB_CORRECTION_MAX_BYTES) {
    return {
      ok: false,
      message:
        `An edit replaces a passage: \`was\` and \`now\` are each at most ${KB_CORRECTION_MAX_BYTES} bytes. ` +
        "Nothing was written. Change a long section in more than one edit.",
    };
  }
  const located = resolveKbDocPath(input.kb, input.doc, ctx.dataRoot);
  if (!located) {
    return {
      ok: false,
      message:
        `"${input.doc}" is not a document in the knowledge base ${input.kb}. Nothing was written. ` +
        heldDocsSentence(input.kb, ctx.dataRoot),
    };
  }
  const target = kbStoreTargetForDir(db, input.kb, ctx);
  if (!target) {
    return {
      ok: false,
      message: `The knowledge base "${input.kb}" no longer resolves in the store. Nothing was written.`,
    };
  }
  const where = `${input.kb}/${located.rel}`;
  return withFileLock(`kb-doc:${located.abs}`, () => {
    const raw = readFileSync(located.abs, "utf8");
    const eol = eolOf(raw);
    const was = asDocText(input.was, eol);
    const now = asDocText(input.now, eol);
    if (!was.trim()) {
      return {
        ok: false as const,
        message:
          "An edit names the passage it replaces in `was`. Nothing was written. To add text at the end of the document, append it.",
      };
    }
    const count = occurrences(raw, was);
    if (count === 0) {
      const near = closestLines(raw, was);
      return {
        ok: false as const,
        message:
          `The passage you sent as \`was\` is not in ${where} exactly as you sent it. Nothing was written. ` +
          "Copy it character for character from the document (read_knowledge_base_doc returns it), list marker and emphasis included" +
          (near.length > 0
            ? `; the lines closest to it read:\n${fenceFor(near.join("\n"))}\n${near.join("\n")}\n${fenceFor(near.join("\n"))}`
            : ". No line of the document is close to it."),
      };
    }
    if (count > 1) {
      return {
        ok: false as const,
        message: `The passage you sent as \`was\` stands ${count} times in ${where}. Nothing was written. Send more of it, so it stands once.`,
      };
    }
    if (was === now) {
      return {
        ok: false as const,
        message: `${where} already says that: \`now\` is the passage it would replace. Nothing needed writing.`,
      };
    }
    const at = raw.indexOf(was);
    const next = raw.slice(0, at) + now + raw.slice(at + was.length);
    const segments = located.rel.split("/");
    const name = segments.pop()!;
    const written = writeStoreDoc(db, target, segments, name, next, input.actor, {
      overwrite: true,
      edit: { replaced: was, text: now },
    });
    publishResourceUpdated("kb", target.id);
    return { ok: true as const, bytes: written.bytes, previousBytes: written.previousBytes ?? 0 };
  });
}

// ------------------------------------------------------------------ undoing

export interface UndoKbCorrectionInput {
  id: string;
  /** The board the person is on: a correction is undone from its own. */
  projectSlug?: string;
  reason: string | null;
  /** The person's name, which the record and the refusal show. */
  byName: string;
}

export type UndoKbCorrectionResult =
  | { outcome: "done"; message: string; correction: KbCorrection }
  | { outcome: "noop"; message: string };

/**
 * Put back what one correction replaced (or take away what it added), and
 * record who did and why. The caller has already decided who may: an org
 * admin, directly on the Controller page or through the controller, because
 * this edits an org knowledge base.
 *
 * Refuses, writing nothing, when the corrected text no longer stands exactly
 * once in the settled text: the document changed since, and a blind undo
 * would take the later edit with it.
 */
export async function undoKbCorrection(
  db: DatabaseSync,
  input: UndoKbCorrectionInput,
  actor: AuditActor,
  ctx: { dataRoot?: string } = {},
): Promise<UndoKbCorrectionResult> {
  const id = input.id.trim();
  const filter: KbCorrectionFilter = { id };
  if (input.projectSlug) filter.projectSlug = input.projectSlug;
  const [correction] = listKbCorrections(db, filter);
  if (!correction) {
    return {
      outcome: "noop",
      message:
        `No knowledge-base correction ${id} is on record${input.projectSlug ? ` for ${input.projectSlug}` : ""}. ` +
        "Its record may have aged out of the audit log; the document itself can still be edited by hand.",
    };
  }
  if (correction.undone) {
    return {
      outcome: "noop",
      message: `${id} was already undone by ${correction.undone.by} on ${dayOf(correction.undone.at)}. Nothing was written.`,
    };
  }
  const where = `${correction.kb}/${correction.doc}`;
  const located = resolveKbDocPath(correction.kb, correction.doc, ctx.dataRoot);
  const target = kbStoreTargetForDir(db, correction.kb, ctx);
  if (!located || !target) {
    return {
      outcome: "noop",
      message: `${where} no longer resolves in the store. Nothing was written.`,
    };
  }
  return withFileLock(`kb-doc:${located.abs}`, () => {
    const raw = readFileSync(located.abs, "utf8");
    const eol = eolOf(raw);
    const text = asDocText(correction.text, eol);
    const settled = settledView(raw);
    const count = occurrences(settled, text);
    if (count !== 1) {
      return {
        outcome: "noop" as const,
        message:
          (count === 0
            ? `${where} no longer reads as ${id} left it: that passage was edited since. `
            : `The text ${id} wrote now stands ${count} times in ${where}. `) +
          "Nothing was written. Open the document and change it by hand.",
      };
    }
    const at = settled.indexOf(text);
    const next =
      correction.replaced === null
        ? withoutAddition(raw, at, text.length, eol)
        : raw.slice(0, at) + asDocText(correction.replaced, eol) + raw.slice(at + text.length);
    const segments = located.rel.split("/");
    const name = segments.pop()!;
    writeStoreDoc(db, target, segments, name, next, actor, { overwrite: true });
    const reason = input.reason?.trim() || null;
    recordAudit(db, {
      action: KB_CORRECTION_UNDONE_ACTION,
      actor,
      subjectKind: "task",
      subjectId: correction.taskKey,
      projectSlug: correction.projectSlug,
      taskKey: correction.taskKey,
      details: { id, kb: correction.kb, doc: correction.doc, reason, byName: input.byName },
    });
    publishResourceUpdated("kb", target.id);
    const undone = { at: new Date().toISOString(), by: input.byName, reason };
    return {
      outcome: "done" as const,
      message:
        correction.replaced === null
          ? `Undid ${id}: the text it added to ${where} is gone.`
          : `Undid ${id}: ${where} reads as it did before it.`,
      correction: { ...correction, undone },
    };
  });
}
