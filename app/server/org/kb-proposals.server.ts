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
 * Rulings 210 and 267: the knowledge-base corrections agents PROPOSED, filed in
 * the document beside what they correct, under "## Proposed corrections (not
 * binding)" (ruling 210's "## Proposed (not binding)" before that), for a
 * person to promote into the settled text or dismiss.
 *
 * Ruling 210 ended the filing. The owner, 2026-09-26: "proposal spam is
 * exhausting, it should be easier to get them merged to the kb. No human can
 * approve all of these while inspecting them thoroughly." An agent's correction
 * is now written into the settled text as it is made, and a person undoes the
 * ones they disagree with (`kb-corrections.server.ts`). Nothing files an entry
 * here any more; this module reads and closes the ones documents still hold,
 * which runs keep reading beside the lines they name until someone closes them.
 *
 * The document is the record. There is no second list of proposals to drift
 * from it: an entry is open while it stands under the heading, and a person who
 * deletes one by hand in the editor has closed it. Its id is derived from where
 * it stands and what it says, so it names the same entry for as long as nobody
 * edits that entry.
 */

/** The section's heading as ruling 267 filed it, or ruling 210's
 *  "## Proposed (not binding)", which rulings documents filed before ruling
 *  267 carry: both are the same section. */
const PROPOSALS_HEADING_RE = /^## Proposed(?: corrections)? \(not binding\)\s*$/;

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
  /** Who filed it: the agent's name, or "Operator". Null on ruling 210's entries. */
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
    return { headingStart: -1, sectionEnd: raw.length, entries: [] };
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
  return { headingStart: lines[heading]!.start, sectionEnd, entries };
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

/** Read one entry's fields. Ruling 210's entries have no filer and no line. */
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
export function looseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_"“”‘’']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Where a document's proposals section stands, heading to section end, or null
 * when it has none. Ruling 210 corrects the settled text around it: a passage
 * an entry merely quotes is not in the document.
 */
export function legacyProposalsSpan(raw: string): { start: number; end: number } | null {
  const section = findSection(raw);
  return section.headingStart === -1
    ? null
    : { start: section.headingStart, end: section.sectionEnd };
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
 * base, because a proposal may stand in any of them (ruling 267): the rulings,
 * or any base granted to a run on a task.
 */
function listKbProposals(dataRoot?: string): KbProposal[] {
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
function findKbProposal(id: string, dataRoot?: string): KbProposal | null {
  return listKbProposals(dataRoot).find((p) => p.id === id.trim()) ?? null;
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
 * (ruling 267: an org admin, directly or through the controller, because this
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

/** The path a person opens a knowledge-base document at: Instance settings,
 *  with that knowledge base's browser open on the document (org admins). A
 *  proposal's "Open document" and a correction's (ruling 210) both go there. */
export function kbDocHref(place: { kb: string; doc: string }): string {
  const params = new URLSearchParams({ tab: "resources", kb: place.kb, doc: place.doc });
  return `/org/settings?${params.toString()}`;
}
