import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { recordAudit, type AuditActor } from "~/server/audit/audit-recorder.server";
import { sha256Hex } from "~/server/files/content-hash.server";
import { withFileLock } from "~/server/files/file-mutex.server";
import { kbDirPath, kbRootDir } from "~/server/files/file-store-root.server";
import {
  collectKbDocs,
  resolveKbDocPath,
} from "~/server/files/kb-injection.server";
import { publishResourceUpdated } from "./resource-events.server";
import { kbStoreTargetForDir, subDirNames } from "./resources.server";
import { writeStoreDoc } from "./store-files.server";

/**
 * Ruling 483: a correction to a knowledge base, PROPOSED by an agent that
 * proved a line of it wrong, filed in the document beside what it corrects.
 *
 * Ruling 378 gave the operator this for ONE knowledge base, the project's
 * rulings. Live in pass 40 the facts that went stale were somewhere else: the
 * akin-dossier's platform facts (a wrangler version, an output path) and the
 * deploy runbook's Step 1. The Site Engineer found one at 22:21, the Platform
 * Engineer re-derived both an hour later and wrote "the knowledge-base runbook
 * is read-only to me", the operator answered "I'm not changing them myself",
 * and the next directives still sent agents to the stale lines. So any agent on
 * a task may now propose against any knowledge base its run was given, and the
 * proposal lives in the document itself: every later reader meets it beside
 * the line, and the index every run is handed names the section.
 *
 * A proposal binds nobody. It edits no settled line and removes nothing; a
 * person, or the controller when a person asks it, promotes it into the
 * settled text or dismisses it (the pass-39 model, ruling 378).
 *
 * The document is the record. There is no second list of proposals to drift
 * from it: an entry is open while it stands under the heading, and a person who
 * deletes one by hand in the editor has closed it. Its id is derived from where
 * it stands and what it says, so it names the same entry for as long as nobody
 * edits that entry.
 */

/** The heading every proposal is filed under, in the corrected document. */
export const KB_PROPOSALS_HEADING = "## Proposed corrections (not binding)";

/** This heading, or ruling 378's "## Proposed (not binding)", which rulings
 *  documents filed before ruling 483 carry: read as the same section, and
 *  renamed to {@link KB_PROPOSALS_HEADING} by the next filing. */
const PROPOSALS_HEADING_RE = /^## Proposed(?: corrections)? \(not binding\)\s*$/;

/** The sentence under a new heading: what the section is and who closes it. */
export const KB_PROPOSALS_INTRO =
  "Raised by agents from evidence on a task. **Nothing here is binding.** A person, or the " +
  "controller when a person asks it, promotes an entry into the settled text above or " +
  "dismisses it.";

/** One open proposal, as its document holds it. */
export interface KbProposal {
  /** `kp-` and ten hex characters, derived from the KB, document and entry. */
  id: string;
  /** The knowledge base's store directory (the grant key). */
  kb: string;
  /** The document's path inside that knowledge base. */
  doc: string;
  /** The task it was filed from, as the stamp names it. */
  taskKey: string | null;
  /** The filing day (`YYYY-MM-DD`), as the stamp names it. */
  filedOn: string | null;
  /** Who filed it: the agent's name, or "Operator". Null on ruling 378's entries. */
  filedBy: string | null;
  /** The settled line it corrects, as the filer quoted it; null when it adds one. */
  line: string | null;
  correction: string;
  evidence: string | null;
}

interface EntrySpan {
  start: number;
  end: number;
  text: string;
}

interface ProposalSection {
  /** Offset of the heading line, or -1 when the document has no section. */
  headingStart: number;
  /** Offset just past the heading line (its newline included). */
  headingEnd: number;
  /** Offset where the section stops: the next `#`/`##` heading, or the end. */
  sectionEnd: number;
  entries: EntrySpan[];
}

const STAMP_RE = /^- \*\*\[([^\]]*)\]\*\*\s?(.*)$/;

/**
 * Find the proposals section and its entries. Line-based and fence-aware, so a
 * heading quoted inside a code block is not the section. An entry is a list
 * item that opens with a bold `[stamp]` and runs on through the lines indented
 * under it.
 */
function findSection(raw: string): ProposalSection {
  const lines: { start: number; end: number; text: string }[] = [];
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf("\n", at);
    const end = nl === -1 ? raw.length : nl + 1;
    lines.push({ start: at, end, text: raw.slice(at, nl === -1 ? raw.length : nl) });
    at = end;
  }
  let fenced = false;
  let heading = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced && PROPOSALS_HEADING_RE.test(text)) {
      heading = i;
      break;
    }
  }
  if (heading === -1) {
    return { headingStart: -1, headingEnd: -1, sectionEnd: raw.length, entries: [] };
  }
  let sectionEnd = raw.length;
  const entries: EntrySpan[] = [];
  let open: { start: number; end: number; parts: string[] } | null = null;
  const close = () => {
    if (open) entries.push({ start: open.start, end: open.end, text: open.parts.join("\n") });
    open = null;
  };
  fenced = false;
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line.text)) fenced = !fenced;
    if (!fenced && /^#{1,2}\s/.test(line.text)) {
      sectionEnd = line.start;
      break;
    }
    if (STAMP_RE.test(line.text)) {
      close();
      open = { start: line.start, end: line.end, parts: [line.text] };
    } else if (open && line.text.startsWith("  ") && line.text.trim() !== "") {
      open.parts.push(line.text);
      open.end = line.end;
    } else {
      close();
    }
  }
  close();
  return {
    headingStart: lines[heading]!.start,
    headingEnd: lines[heading]!.end,
    sectionEnd,
    entries,
  };
}

/** The id an entry has where it stands. */
function proposalId(kb: string, doc: string, entryText: string): string {
  return `kp-${sha256Hex(`${kb}\n${doc}\n${entryText}`).slice(0, 10)}`;
}

/** An entry's values as their lines are read, before they are joined. */
interface EntryFieldLines {
  correction: string[];
  line: string[] | null;
  evidence: string[] | null;
}

/** Read one entry's fields. Ruling 378's entries have no filer and no line. */
function parseEntry(kb: string, doc: string, text: string): KbProposal {
  const [first = "", ...rest] = text.split("\n");
  const stamp = STAMP_RE.exec(first);
  const parts = (stamp?.[1] ?? "").split(",").map((p) => p.trim());
  const fields: EntryFieldLines = {
    correction: [stamp?.[2] ?? ""],
    line: null,
    evidence: null,
  };
  let current: string[] = fields.correction;
  for (const raw of rest) {
    const body = raw.slice(2);
    if (body.startsWith("Line: ")) {
      fields.line = [body.slice("Line: ".length)];
      current = fields.line;
    } else if (body.startsWith("Evidence: ")) {
      fields.evidence = [body.slice("Evidence: ".length)];
      current = fields.evidence;
    } else {
      current.push(body);
    }
  }
  return {
    id: proposalId(kb, doc, text),
    kb,
    doc,
    taskKey: parts[0] || null,
    filedOn: parts[1] || null,
    filedBy: parts.length > 2 ? parts.slice(2).join(", ") || null : null,
    line: fields.line ? fields.line.join("\n").trim() || null : null,
    correction: fields.correction.join("\n").trim(),
    evidence: fields.evidence ? fields.evidence.join("\n").trim() || null : null,
  };
}

/** Every open proposal one document's text holds, in document order. */
export function parseKbProposals(kb: string, doc: string, raw: string): KbProposal[] {
  return findSection(raw).entries.map((e) => parseEntry(kb, doc, e.text));
}

/** A value on the entry's own indented lines. Blank lines would end the list
 *  item, so they are dropped; every other line keeps its text. */
function indented(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n  ");
}

export interface KbProposalEntryInput {
  taskKey: string;
  /** `YYYY-MM-DD`. */
  filedOn: string;
  filedBy: string;
  line: string | null;
  correction: string;
  evidence: string;
}

/** The markdown one proposal is filed as. */
export function formatKbProposalEntry(input: KbProposalEntryInput): string {
  // A comma or bracket inside the filer's name would re-split the stamp.
  const filer = input.filedBy.replace(/[,[\]]/g, " ").replace(/\s+/g, " ").trim();
  return (
    `- **[${input.taskKey}, ${input.filedOn}${filer ? `, ${filer}` : ""}]** ${indented(input.correction)}` +
    (input.line ? `\n  Line: ${indented(input.line)}` : "") +
    `\n  Evidence: ${indented(input.evidence)}`
  );
}

/**
 * The document with one entry filed at the end of its proposals section,
 * creating the section at the end of the document when it has none. Ruling
 * 378's heading is renamed in the same write. Built by slicing, never by
 * `String.replace` with a string: a proposal is shell and Makefile evidence,
 * where `$$` and `$&` are ordinary text.
 */
export function withKbProposalFiled(raw: string, entry: string): string {
  const section = findSection(raw);
  if (section.headingStart === -1) {
    return `${raw.trimEnd()}\n\n${KB_PROPOSALS_HEADING}\n\n${KB_PROPOSALS_INTRO}\n\n${entry}\n`;
  }
  const head = raw.slice(0, section.headingStart);
  const body = raw.slice(section.headingEnd, section.sectionEnd).trimEnd();
  const after = raw.slice(section.sectionEnd);
  return (
    `${head}${KB_PROPOSALS_HEADING}\n${body ? `${body}\n\n` : "\n"}${entry}\n` +
    (after ? `\n${after.replace(/^\n+/, "")}` : "")
  );
}

/** The document without one entry. The last entry takes the section with it,
 *  so a document with nothing proposed no longer advertises a section. */
function withoutEntry(raw: string, kb: string, doc: string, id: string): string | null {
  const section = findSection(raw);
  const at = section.entries.findIndex((e) => proposalId(kb, doc, e.text) === id);
  if (at === -1) return null;
  const after = raw.slice(section.sectionEnd);
  if (section.entries.length === 1) {
    const kept = raw.slice(0, section.headingStart).trimEnd();
    return after ? `${kept}\n\n${after.replace(/^\n+/, "")}` : `${kept}\n`;
  }
  const entry = section.entries[at]!;
  const before = raw.slice(section.headingStart, entry.start).trimEnd();
  const rest = raw.slice(entry.end, section.sectionEnd).replace(/^\n+/, "");
  const sectionText = rest ? `${before}\n\n${rest.trimEnd()}\n` : `${before}\n`;
  return (
    raw.slice(0, section.headingStart) +
    sectionText +
    (after ? `\n${after.replace(/^\n+/, "")}` : "")
  );
}

/** Loose comparison for a quoted line: case, markdown emphasis, quotes and
 *  whitespace do not decide whether a model quoted the line it means. */
function looseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_"“”‘’']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The settled text: the document without its proposals section. */
function settledText(raw: string): string {
  const section = findSection(raw);
  if (section.headingStart === -1) return raw;
  return raw.slice(0, section.headingStart) + raw.slice(section.sectionEnd);
}

// ------------------------------------------------------------------ reading

/** Parsed entries per document, keyed on the file's identity on disk, so a
 *  page load or a controller turn re-reads only the documents that changed. */
const parsedCache = new Map<string, { mtimeMs: number; size: number; proposals: KbProposal[] }>();

function docProposals(kb: string, rel: string, abs: string): KbProposal[] {
  let st;
  try {
    st = statSync(abs);
  } catch {
    parsedCache.delete(abs);
    return [];
  }
  const cached = parsedCache.get(abs);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.proposals;
  }
  let raw = "";
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const proposals = raw.includes("(not binding)") ? parseKbProposals(kb, rel, raw) : [];
  parsedCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, proposals });
  return proposals;
}

/**
 * Every open proposal in the store, oldest filing first. Walks every knowledge
 * base, because a proposal may stand in any of them (ruling 483): the rulings,
 * or any base granted to a run on a task.
 */
export function listKbProposals(dataRoot?: string): KbProposal[] {
  const out: KbProposal[] = [];
  for (const kb of subDirNames(kbRootDir(dataRoot)).sort()) {
    if (kb.startsWith(".")) continue;
    let dir: string;
    try {
      dir = kbDirPath(kb, dataRoot);
    } catch {
      continue;
    }
    for (const doc of collectKbDocs(dir)) {
      out.push(...docProposals(kb, doc.rel, doc.abs));
    }
  }
  return out.sort(
    (a, b) =>
      (a.filedOn ?? "").localeCompare(b.filedOn ?? "") ||
      `${a.kb}/${a.doc}`.localeCompare(`${b.kb}/${b.doc}`),
  );
}

/** The task keys of one project, which is how a proposal is tied to it: its
 *  stamp names the task it was filed from. */
function projectTaskKeys(db: DatabaseSync, projectSlug: string): Set<string> {
  // SAFETY: the statement selects the single `task_key` column, TEXT NOT NULL
  // on `task_projections` (0001_baseline.sql).
  const rows = db
    .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
    .all(projectSlug) as { task_key: string }[];
  return new Set(rows.map((r) => r.task_key));
}

/** The open proposals filed from one project's tasks. */
export function listProjectKbProposals(
  db: DatabaseSync,
  projectSlug: string,
  dataRoot?: string,
): KbProposal[] {
  const keys = projectTaskKeys(db, projectSlug);
  return listKbProposals(dataRoot).filter((p) => p.taskKey !== null && keys.has(p.taskKey));
}

/** Open proposals per project, for the instance-wide view. A proposal whose
 *  task no project holds any more is left out: nobody's board raised it. */
export function kbProposalCountsByProject(
  db: DatabaseSync,
  dataRoot?: string,
): Map<string, number> {
  const proposals = listKbProposals(dataRoot);
  const counts = new Map<string, number>();
  if (proposals.length === 0) return counts;
  // SAFETY: both selected columns are TEXT NOT NULL on `task_projections`.
  const rows = db
    .prepare(`SELECT task_key, project_slug FROM task_projections`)
    .all() as { task_key: string; project_slug: string }[];
  const owner = new Map(rows.map((r) => [r.task_key, r.project_slug]));
  for (const p of proposals) {
    const slug = p.taskKey ? owner.get(p.taskKey) : undefined;
    if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

/** One open proposal by id, wherever it stands. */
export function findKbProposal(id: string, dataRoot?: string): KbProposal | null {
  return listKbProposals(dataRoot).find((p) => p.id === id.trim()) ?? null;
}

// ------------------------------------------------------------------ filing

export interface FileKbProposalInput extends Omit<KbProposalEntryInput, "filedOn"> {
  /** The knowledge base's store directory. */
  kb: string;
  /** The document's path inside it. */
  doc: string;
  actor: AuditActor;
  now?: Date;
}

export type FileKbProposalResult =
  | { ok: true; proposal: KbProposal; created: boolean; bytes: number }
  | { ok: false; message: string };

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

/**
 * File one proposal into a document the knowledge base already holds.
 *
 * Refuses, writing nothing, when the document is not one the knowledge base
 * holds (a typo would otherwise CREATE a settled-looking document, ruling 378)
 * and when the quoted line is not in the settled text (a proposal is anchored
 * to the line it corrects, or it is not beside it). The same correction of the
 * same line, still open, is the same proposal: it is returned, not stacked.
 */
export async function fileKbProposal(
  db: DatabaseSync,
  input: FileKbProposalInput,
  ctx: { dataRoot?: string } = {},
): Promise<FileKbProposalResult> {
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
  return withFileLock(`kb-doc:${located.abs}`, () => {
    const raw = readFileSync(located.abs, "utf8");
    const line = input.line?.trim() ? input.line.trim().replace(/^["“]|["”]$/g, "").trim() : null;
    if (line && !looseText(settledText(raw)).includes(looseText(line))) {
      return {
        ok: false as const,
        message:
          `The line you quote is not in the settled text of ${input.kb}/${located.rel}. Nothing was written. ` +
          "Quote it as the document has it (a distinctive phrase of it is enough), or leave `line` empty when the " +
          "correction adds something the document does not say.",
      };
    }
    const existing = parseKbProposals(input.kb, located.rel, raw).find(
      (p) =>
        looseText(p.correction) === looseText(input.correction) &&
        looseText(p.line ?? "") === looseText(line ?? ""),
    );
    if (existing) return { ok: true as const, proposal: existing, created: false, bytes: 0 };
    const entry = formatKbProposalEntry({
      taskKey: input.taskKey,
      filedOn: (input.now ?? new Date()).toISOString().slice(0, 10),
      filedBy: input.filedBy,
      line,
      correction: input.correction,
      evidence: input.evidence,
    });
    const body = withKbProposalFiled(raw, entry);
    const segments = located.rel.split("/");
    const name = segments.pop()!;
    writeStoreDoc(db, target, segments, name, body, input.actor, { overwrite: true });
    publishResourceUpdated("kb", target.id);
    const proposal = parseEntry(input.kb, located.rel, entry);
    return {
      ok: true as const,
      proposal,
      created: true,
      // Ruling 466: UTF-8 bytes, never a string length.
      bytes: Buffer.byteLength(entry, "utf8"),
    };
  });
}

// ------------------------------------------------------------------ closing

export type ResolveKbProposalInput =
  | { id: string; action: "dismiss"; reason: string }
  | {
      id: string;
      action: "promote";
      /** The settled text the correction takes the place of, exactly as the
       *  document has it; null appends `text` to the settled text. */
      replaces: string | null;
      /** The settled text to write. */
      text: string;
      reason: string;
    };

export interface ResolveKbProposalResult {
  outcome: "done" | "noop";
  message: string;
  proposal?: KbProposal;
}

/**
 * Promote or dismiss one open proposal. The caller has already decided who may
 * (ruling 483: an org admin, directly or through the controller, because this
 * edits an org knowledge base).
 *
 * Promote writes `text` into the settled text, in place of `replaces` when it
 * is given (it must stand there exactly once, outside the proposals section:
 * the entry itself quotes the line), or at the end of the settled text, and
 * removes the entry in the same write. Dismiss removes the entry and nothing
 * else.
 */
export async function resolveKbProposal(
  db: DatabaseSync,
  input: ResolveKbProposalInput,
  actor: AuditActor,
  ctx: { dataRoot?: string } = {},
): Promise<ResolveKbProposalResult> {
  const proposal = findKbProposal(input.id, ctx.dataRoot);
  if (!proposal) {
    return {
      outcome: "noop",
      message: `No open proposal has the id ${input.id}. It may have been promoted, dismissed or edited already; get_project lists the open ones.`,
    };
  }
  const located = resolveKbDocPath(proposal.kb, proposal.doc, ctx.dataRoot);
  const target = kbStoreTargetForDir(db, proposal.kb, ctx);
  if (!located || !target) {
    return {
      outcome: "noop",
      message: `${proposal.kb}/${proposal.doc} no longer resolves in the store. Nothing was written.`,
    };
  }
  return withFileLock(`kb-doc:${located.abs}`, () => {
    let raw = readFileSync(located.abs, "utf8");
    if (input.action === "promote") {
      const text = input.text.trim();
      if (!text) {
        return {
          outcome: "noop" as const,
          message: "Promoting needs the settled text to write. Nothing was written.",
        };
      }
      const section = findSection(raw);
      const settledEnd = section.headingStart === -1 ? raw.length : section.headingStart;
      const settled = raw.slice(0, settledEnd);
      const tail = raw.slice(settledEnd);
      if (input.replaces) {
        const count = settled.split(input.replaces).length - 1;
        if (count !== 1) {
          return {
            outcome: "noop" as const,
            message:
              count === 0
                ? `The passage to replace is not in the settled text of ${proposal.kb}/${proposal.doc}. Read the document and send it exactly as it stands. Nothing was written.`
                : `The passage to replace stands ${count} times in the settled text of ${proposal.kb}/${proposal.doc}; send a longer one that stands once. Nothing was written.`,
          };
        }
        const at = settled.indexOf(input.replaces);
        raw = settled.slice(0, at) + text + settled.slice(at + input.replaces.length) + tail;
      } else {
        raw = `${settled.trimEnd()}\n\n${text}\n\n${tail.replace(/^\n+/, "")}`;
      }
    }
    const next = withoutEntry(raw, proposal.kb, proposal.doc, proposal.id);
    if (next === null) {
      return {
        outcome: "noop" as const,
        message: `The proposal ${proposal.id} changed before it could be closed. Nothing was written.`,
      };
    }
    const segments = located.rel.split("/");
    const name = segments.pop()!;
    writeStoreDoc(db, target, segments, name, next, actor, { overwrite: true });
    recordAudit(db, {
      action: input.action === "promote" ? "org.kb.proposal_promoted" : "org.kb.proposal_dismissed",
      actor,
      subjectKind: "org_kb",
      subjectId: target.id,
      details: {
        id: proposal.id,
        kb: proposal.kb,
        doc: proposal.doc,
        taskKey: proposal.taskKey,
        reason: input.reason.trim(),
      },
    });
    publishResourceUpdated("kb", target.id);
    return {
      outcome: "done" as const,
      message:
        input.action === "promote"
          ? `Promoted ${proposal.id} into the settled text of ${proposal.kb}/${proposal.doc}; the entry is gone from its proposals.`
          : `Dismissed ${proposal.id} from ${proposal.kb}/${proposal.doc}; the settled text is unchanged.`,
      proposal,
    };
  });
}

/** The path a person opens a proposal's document at: Instance settings, with
 *  that knowledge base's browser open on the document (org admins). */
export function kbProposalDocHref(proposal: Pick<KbProposal, "kb" | "doc">): string {
  const params = new URLSearchParams({ tab: "resources", kb: proposal.kb, doc: proposal.doc });
  return `/org/settings?${params.toString()}`;
}
