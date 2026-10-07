import type { DatabaseSync } from "node:sqlite";
import { OPERATOR_AUDIT_ACTOR, recordAudit } from "~/server/audit/audit-recorder.server";
import { storedNameAmong } from "~/server/files/file-store-root.server";
import { listKeptDeliveries } from "~/server/files/kept-deliveries.server";
import {
  isBrowserWorkingArtifact,
  listTaskAttachmentNames,
  listTaskAttachments,
  taskAttachmentExists,
  type TaskAttachmentEntry,
} from "~/server/files/task-attachments.server";
import {
  deliverySourceIds,
  readTaskSources,
  sourceFromShown,
  type TaskSource,
  type TaskSourcesRead,
} from "~/server/files/task-sources.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import {
  activeWorkRevision,
  deliveredAsFiles,
  requiredReviewers,
  reviewSubjectId,
  type CompletionPacket,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  COMPLETION_CAPTION_MAX,
  COMPLETION_CHANGES_MAX,
  COMPLETION_FILES_MAX,
  COMPLETION_NOTE_MAX,
  COMPLETION_NOTES,
  COMPLETION_SCREENSHOTS_MAX,
  COMPLETION_SMALL_CHANGE_LINES,
  COMPLETION_SUMMARY_MAX,
  RESULT_PATHS_SHOWN,
  changedLines,
  isSmallChange,
} from "~/shared/completion-packet";
import { IMAGE_RE } from "~/ui/picked-files";
import { reprojectTask, taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 521 (owner, 2026-09-27): the completion packet.
 *
 * "Up to date reviewer verdicts should be visible on a completion to done
 * packet summarized by Operator, including the UI screenshots, code changes
 * (if small full if not summary of code changes)." Before this, the decision a
 * person took at the acceptance boundary carried what the operator chose to
 * type into it: live on AWS-1 a "Reviewer verdict" observation quoted the
 * approval as prose, the change was not on the card at all, and the
 * reviewer's screenshots sat in the attachments panel further down the page.
 *
 * The packet splits what the operator knows from what the file knows. The
 * operator writes a summary of the work, picks the screenshots worth seeing
 * from the task's attachments and, when the change is more than
 * `COMPLETION_SMALL_CHANGE_LINES` lines, summarizes the code changes. The
 * verdicts and the change itself are never copied into it: the task page reads
 * them live beside it (`completionView`), so a verdict that lands after the
 * packet was written is shown as it stands.
 *
 * The operator writes it before it offers the task for acceptance, and the
 * offer is refused until it has (`completionPacketRefusal`): its own
 * `accept_completion`, a decision packet with an `accept_completion` option,
 * and the fold that files the acceptance card after a move onto the boundary.
 * A person's own acceptance is never refused over it.
 *
 * Ruling 668 (owner, 2026-10-06): "we need operator to create summary of the
 * task by outputs (like related output files, what are the considerations,
 * what are the assumptions and what were the gaps), then ask for done. And if
 * that recommendation is accepted, then there is a result card ... including
 * final files (not in progress files)." So the packet also carries three
 * notes (what to weigh, what was assumed, what is missing) and, on a task
 * delivered as files, the files that are its result, each with a line saying
 * what it is; and it stays on the task after the acceptance, where the page
 * shows it as the result. A task delivered as a revision names no files: its
 * pull request holds them, and the result shows the change's size, the
 * operator's summary of it and the paths it changed.
 */

/** The slice of the frontmatter the packet binds to. */
type PacketState = Pick<TaskFrontmatter, "workRevision" | "deliveredAt" | "completionPacket">;

/** The completion packet when it describes the CURRENT review subject, else
 *  null (never written, or written for a subject a newer delivery replaced). */
export function currentCompletionPacket(fm: PacketState): CompletionPacket | null {
  const packet = fm.completionPacket;
  if (!packet) return null;
  const subject = reviewSubjectId(fm);
  return subject !== null && packet.subject === subject ? packet : null;
}

/**
 * Ruling 668: the packet as one text, for a reader that takes prose (another
 * task's read of what this one came to): the summary, each note under its
 * label, and the result's files with what each is.
 */
export function completionPacketText(packet: CompletionPacket): string {
  const parts = [packet.summary];
  for (const { key, label } of COMPLETION_NOTES) {
    const note = packet[key];
    if (note) parts.push(`${label}:\n${note}`);
  }
  if (packet.files.length > 0) {
    const lines = packet.files.map((f) => `- ${f.name}${f.caption ? `: ${f.caption}` : ""}`);
    parts.push(`Result files:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** How a person or the operator names the subject: `revision abc1234`, or
 *  the delivered files. */
function subjectPhrase(fm: Pick<TaskFrontmatter, "workRevision">): string {
  const rev = activeWorkRevision(fm.workRevision);
  return rev ? `revision \`${rev.headSha.slice(0, 7)}\`` : "the files delivered on this task";
}

/**
 * Why the operator may not offer this task for acceptance yet, or null.
 *
 * Null while nothing is delivered: there is no work to summarize, and the
 * acceptance gate speaks for that case itself (ruling 161). Otherwise the
 * packet must describe the current subject.
 */
export function completionPacketRefusal(fm: PacketState, taskKey: string): string | null {
  if (reviewSubjectId(fm) === null) return null;
  if (currentCompletionPacket(fm)) return null;
  const stale = fm.completionPacket
    ? " The packet on file describes earlier work, so write it again for what is delivered now."
    : "";
  return (
    `Write the completion packet for ${subjectPhrase(fm)} first (write_completion_packet), ` +
    `then offer ${taskKey} for acceptance: the person who accepts it reads your summary, the ` +
    `screenshots you pick and the change beside each reviewer's verdict (ruling 521).${stale}`
  );
}

/** The image attachments a packet may show, newest first. */
function screenshotCandidates(entries: readonly TaskAttachmentEntry[]): string[] {
  return entries.filter((e) => IMAGE_RE.test(e.name)).map((e) => e.name);
}

type StoreRef = { projectSlug: string; taskKey: string; dataRoot?: string | undefined };

/**
 * Ruling 668: the files a packet may name as the result of a task delivered as
 * files. They are the files of the delivery under review as it was kept
 * (ruling 597: what the reviewers judged), still on the task; a delivery
 * nobody kept offers the task's files. The browser's working files are never
 * a result (ruling 570). Empty when the delivery is a revision.
 */
function resultFileCandidates(fm: PacketState, ref: StoreRef): string[] {
  if (!deliveredAsFiles(fm)) return [];
  const onTask = listTaskAttachmentNames(ref.projectSlug, ref.taskKey, ref.dataRoot).filter(
    (name) => !isBrowserWorkingArtifact(name),
  );
  const kept = listKeptDeliveries(ref.projectSlug, ref.taskKey, ref.dataRoot).find(
    (d) => d.deliveredAt === fm.deliveredAt,
  );
  if (!kept) return onTask.sort();
  const delivered = new Set(kept.files);
  return onTask.filter((name) => delivered.has(name)).sort();
}

/**
 * Ruling 690: the kept sources the work under review rests on, in id order.
 *
 * A delivery that is files recorded the sources the task held when it was
 * stamped (`recordDeliverySources`), so those are read back; a delivery whose
 * line was never written rests on what was kept at or before its stamp. A
 * revision records no line and is anchored the same way: it rests on what
 * was kept by the instant it was minted (`workRevision.createdAt`). Either
 * way a source a reviewer keeps afterwards, while checking the work, is on
 * the task and not among these. The packet's own time is no anchor: the
 * operator writes it after the reviews, so every page a reviewer fetched to
 * check a claim would read as what the developer's result stood on. Empty
 * while nothing is delivered.
 */
export function sourcesRestedOn(kept: TaskSourcesRead, fm: PacketState): TaskSource[] {
  if (reviewSubjectId(fm) === null) return [];
  if (deliveredAsFiles(fm) && fm.deliveredAt) {
    const ids = new Set(deliverySourceIds(kept, fm.deliveredAt));
    return kept.sources.filter((s) => ids.has(s.id));
  }
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev) return [];
  const minted = Date.parse(rev.createdAt);
  return kept.sources.filter((s) => Date.parse(s.keptAt) <= minted);
}

/** How many candidate names a refusal or the snapshot lists. */
const CANDIDATES_SHOWN = 40;

/** The operator's snapshot fact: what is on file, and what writing it takes. */
export interface CompletionPacketFact {
  /** `current` describes the subject under review; `stale` an earlier one;
   *  `none` was never written; `not_applicable` while nothing is delivered. */
  state: "current" | "stale" | "none" | "not_applicable";
  writtenAt: string | null;
  /** Lines the change adds and removes, when the PR's counts are known. */
  changedLines: number | null;
  /** The packet must carry `changes`, your summary of the code changes. */
  changesSummaryRequired: boolean;
  /** Image attachments you may name as screenshots, newest first. */
  screenshotCandidates: string[];
  /** Ruling 668: the packet must name the result's files (`files`): the
   *  delivery is files on the task. */
  resultFilesRequired: boolean;
  /** Ruling 668: the delivered files you may name as the result. */
  resultFileCandidates: string[];
  /** Ruling 690: how many sources the task keeps (`kept`) and how many of
   *  them the delivery under review rests on (`restedOn`); `read_task_source`
   *  lists them. A result that states facts from outside and rests on none
   *  has a gap to name. */
  sources: CompletionSourcesFact;
  note: string;
}

/** Ruling 690: the snapshot's count of a task's sources. */
interface CompletionSourcesFact {
  kept: number;
  restedOn: number;
}

export function completionPacketFact(
  fm: TaskFrontmatter,
  input: { projectSlug: string; taskKey: string; dataRoot?: string | undefined },
): CompletionPacketFact {
  const subject = reviewSubjectId(fm);
  const lines = activeWorkRevision(fm.workRevision) ? changedLines(fm.github?.changed) : null;
  const changesSummaryRequired = lines !== null && lines > COMPLETION_SMALL_CHANGE_LINES;
  const kept = readTaskSources(input.projectSlug, input.taskKey, input.dataRoot);
  const sources = { kept: kept.sources.length, restedOn: sourcesRestedOn(kept, fm).length };
  if (subject === null) {
    return {
      state: "not_applicable",
      writtenAt: null,
      changedLines: lines,
      changesSummaryRequired: false,
      screenshotCandidates: [],
      resultFilesRequired: false,
      resultFileCandidates: [],
      sources,
      note: "Nothing is delivered yet, so there is no completion packet to write.",
    };
  }
  const current = currentCompletionPacket(fm);
  const state = current ? "current" : fm.completionPacket ? "stale" : "none";
  const candidates = screenshotCandidates(
    listTaskAttachments(input.projectSlug, input.taskKey, input.dataRoot),
  ).slice(0, 20);
  const resultFiles = resultFileCandidates(fm, input);
  const size = deliveredAsFiles(fm)
    ? resultFiles.length > 0
      ? "The delivery is files on the task, so the packet names the ones that are the result (`files`, from `resultFileCandidates`), each with a line saying what it is."
      : "The delivery is files on the task, and none of them is still on it, so the packet names none."
    : lines === null
      ? "The change's size is not known yet."
      : changesSummaryRequired
        ? `The change is ${lines} lines, more than ${COMPLETION_SMALL_CHANGE_LINES}, so the packet shows your summary of it (\`changes\`) and the diff one press away.`
        : `The change is ${lines} lines, so the packet shows it whole.`;
  const note =
    state === "current"
      ? `The completion packet describes ${subjectPhrase(fm)}. ${size}`
      : `Before you offer ${input.taskKey} for acceptance (accept_completion, or a decision packet with an accept_completion option), write the completion packet for ${subjectPhrase(fm)} with write_completion_packet. ${size}`;
  return {
    state,
    writtenAt: fm.completionPacket?.at ?? null,
    changedLines: lines,
    changesSummaryRequired,
    screenshotCandidates: candidates,
    resultFilesRequired: resultFiles.length > 0,
    resultFileCandidates: resultFiles.slice(0, CANDIDATES_SHOWN),
    sources,
    note,
  };
}

export interface CompletionPacketInput {
  projectSlug: string;
  taskKey: string;
  summary: string;
  changes?: string | null;
  /** Ruling 668: the three notes, each markdown or left out. */
  considerations?: string | null;
  assumptions?: string | null;
  gaps?: string | null;
  /** Ruling 668: the files that are the result of a task delivered as files. */
  files?: readonly { name: string; caption?: string | null }[];
  screenshots?: readonly { name: string; caption?: string | null }[];
}

/** A caption as the packet keeps it: trimmed, and cut at the cap. */
function captionOf(raw: string | null | undefined): string {
  const caption = (raw ?? "").trim();
  return caption.length > COMPLETION_CAPTION_MAX
    ? `${caption.slice(0, COMPLETION_CAPTION_MAX - 1)}…`
    : caption;
}

/** A list of names for a sentence: `a`, `b` and so on, cut at `max`. */
function nameList(names: readonly string[], max = 12): string {
  return (
    names
      .slice(0, max)
      .map((n) => `\`${n}\``)
      .join(", ") + (names.length > max ? ", and more" : "")
  );
}

/** What the writer answers: written, or refused with the sentence to fix it. */
export interface CompletionPacketWrite {
  written: boolean;
  message: string;
}

/**
 * The one writer. The caller has checked the operator's authority; this
 * checks the packet against the task and writes it, with a timeline note and
 * an audit row.
 */
export async function writeCompletionPacket(
  db: DatabaseSync,
  ctx: TaskMutationContext,
  input: CompletionPacketInput,
): Promise<CompletionPacketWrite> {
  const { projectSlug, taskKey } = input;
  const ref = taskRef(ctx, projectSlug, taskKey);
  const file = readTaskFile(ref);
  if (!file) return { written: false, message: `Task ${taskKey} not found.` };
  const fm = file.parsed.frontmatter;
  if (fm.archived) {
    return { written: false, message: `${taskKey} is archived, so nothing on it is offered for acceptance.` };
  }
  const subject = reviewSubjectId(fm);
  if (subject === null) {
    return {
      written: false,
      message:
        `Nothing is delivered on ${taskKey} yet. A completion packet summarizes delivered work ` +
        "(a revision, or files a run saved), so write it once there is some.",
    };
  }

  const summary = input.summary.trim();
  if (summary === "") {
    return { written: false, message: "The summary is empty: say what was done and why it meets the goal." };
  }
  if (summary.length > COMPLETION_SUMMARY_MAX) {
    return {
      written: false,
      message: `The summary is ${summary.length} characters; keep it under ${COMPLETION_SUMMARY_MAX}.`,
    };
  }
  const changes = input.changes?.trim() || null;
  if (changes !== null && changes.length > COMPLETION_CHANGES_MAX) {
    return {
      written: false,
      message: `The summary of the code changes is ${changes.length} characters; keep it under ${COMPLETION_CHANGES_MAX}.`,
    };
  }
  const rev = activeWorkRevision(fm.workRevision);
  const lines = rev ? changedLines(fm.github?.changed) : null;
  if (changes === null && rev && isSmallChange(fm.github?.changed) === false) {
    return {
      written: false,
      message:
        `The change is ${lines} lines, more than ${COMPLETION_SMALL_CHANGE_LINES}, so the packet shows ` +
        "your summary of it instead of the whole diff: pass `changes`, what changed by area in a few " +
        "lines, with the files that matter.",
    };
  }

  // Ruling 668: the three notes. One left out or blank is absent; none is cut.
  const notes = {
    considerations: input.considerations?.trim() || null,
    assumptions: input.assumptions?.trim() || null,
    gaps: input.gaps?.trim() || null,
  };
  for (const { key, label } of COMPLETION_NOTES) {
    const note = notes[key];
    if (note !== null && note.length > COMPLETION_NOTE_MAX) {
      return {
        written: false,
        message: `${label} is ${note.length} characters; keep it under ${COMPLETION_NOTE_MAX}.`,
      };
    }
  }

  // Ruling 668: the result's files. A task delivered as files names them; a
  // revision's pull request holds its files, so any named for one are left out
  // and the reply says so.
  const asFiles = deliveredAsFiles(fm);
  const files: CompletionPacket["files"] = [];
  const namedFiles = new Set<string>();
  for (const file of input.files ?? []) {
    const name = file.name.trim();
    if (name === "" || namedFiles.has(name)) continue;
    namedFiles.add(name);
    files.push({ name, caption: captionOf(file.caption) });
  }
  const filesLeftOut = !asFiles && files.length > 0;
  if (filesLeftOut) files.length = 0;
  const candidates = asFiles
    ? resultFileCandidates(fm, { projectSlug, taskKey, dataRoot: ctx.dataRoot })
    : [];
  // A delivery none of whose files is still on the task has nothing to name.
  if (asFiles && candidates.length === 0) files.length = 0;
  if (candidates.length > 0) {
    const offer = ` The delivered files: ${nameList(candidates, CANDIDATES_SHOWN)}.`;
    if (files.length === 0) {
      return {
        written: false,
        message:
          `${taskKey} is delivered as files, so the packet names the ones that are its result: pass ` +
          "`files`, the final version of each output a person takes away, each with a line saying " +
          `what it is. Leave out inputs, drafts, logs and working files.${offer}`,
      };
    }
    if (files.length > COMPLETION_FILES_MAX) {
      return {
        written: false,
        message: `Name at most ${COMPLETION_FILES_MAX} result files: the ones a person takes away.`,
      };
    }
    // Ruling 675: a name is matched to the delivered file in either Unicode
    // form, and the packet keeps the file's own spelling, the one its card
    // opens. A result a script named after a decomposed input is stored so.
    const unknown = files.filter((f) => storedNameAmong(candidates, f.name) === null).map((f) => f.name);
    if (unknown.length > 0) {
      return {
        written: false,
        message:
          `${nameList(unknown)} ${unknown.length === 1 ? "is" : "are"} not among the files ${taskKey} ` +
          `delivered, which is what the reviewers judged.${offer}`,
      };
    }
    const asStored = new Map<string, CompletionPacket["files"][number]>();
    for (const file of files) {
      const stored = storedNameAmong(candidates, file.name) ?? file.name;
      if (!asStored.has(stored)) asStored.set(stored, { name: stored, caption: file.caption });
    }
    files.splice(0, files.length, ...asStored.values());
  }

  const seen = new Set<string>();
  const screenshots: CompletionPacket["screenshots"] = [];
  for (const shot of input.screenshots ?? []) {
    const name = shot.name.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    screenshots.push({ name, caption: captionOf(shot.caption) });
  }
  if (screenshots.length > COMPLETION_SCREENSHOTS_MAX) {
    return {
      written: false,
      message: `Pick at most ${COMPLETION_SCREENSHOTS_MAX} screenshots: the ones that show the result.`,
    };
  }
  const notImages = screenshots.filter((s) => !IMAGE_RE.test(s.name)).map((s) => s.name);
  const missing = screenshots
    .filter((s) => IMAGE_RE.test(s.name))
    .filter((s) => !taskAttachmentExists(projectSlug, taskKey, s.name, ctx.dataRoot))
    .map((s) => s.name);
  if (notImages.length > 0 || missing.length > 0) {
    const candidates = screenshotCandidates(listTaskAttachments(projectSlug, taskKey, ctx.dataRoot));
    const problems = [
      notImages.length > 0
        ? `${notImages.map((n) => `\`${n}\``).join(", ")} ${notImages.length === 1 ? "is not an image" : "are not images"} (png, jpg, webp or gif)`
        : "",
      missing.length > 0
        ? `${missing.map((n) => `\`${n}\``).join(", ")} ${missing.length === 1 ? "is not" : "are not"} among ${taskKey}'s attachments`
        : "",
    ].filter(Boolean);
    const offer =
      candidates.length > 0
        ? ` The images it has: ${candidates
            .slice(0, 12)
            .map((n) => `\`${n}\``)
            .join(", ")}${candidates.length > 12 ? ", and more" : ""}.`
        : ` ${taskKey} has no image attachments; leave \`screenshots\` empty.`;
    return { written: false, message: `${problems.join("; ")}.${offer}` };
  }

  const at = new Date().toISOString();
  const packet: CompletionPacket = { subject, summary, changes, ...notes, files, screenshots, at };
  if (rev) packet.headSha = rev.headSha;
  const what = subjectPhrase(fm);
  const parts = [
    files.length > 0 ? `${files.length} result file${files.length === 1 ? "" : "s"}` : "",
    screenshots.length > 0
      ? `${screenshots.length} screenshot${screenshots.length === 1 ? "" : "s"}`
      : "",
    changes !== null ? "a summary of the code changes" : "",
  ].filter(Boolean);
  await updateTaskFile(ref, (parsed) => {
    parsed.frontmatter.completionPacket = packet;
    parsed.timeline.unshift({
      occurredAt: at,
      type: "note",
      actor: { kind: "operator" },
      title: "Completion packet",
      text:
        `The operator summarized ${what} for the person who accepts it` +
        (parts.length > 0 ? `, with ${parts.join(" and ")}.` : "."),
      toAgent: false,
      evidence: null,
    });
  });
  reprojectTask(db, ctx, projectSlug, taskKey);
  recordAudit(db, {
    action: "task.completion_packet.written",
    actor: OPERATOR_AUDIT_ACTOR,
    subjectKind: "task",
    subjectId: taskKey,
    projectSlug,
    taskKey,
    details: {
      subject,
      screenshots: screenshots.length,
      changes: changes !== null,
      files: files.length,
      notes: COMPLETION_NOTES.filter(({ key }) => notes[key] !== null).map(({ key }) => key),
    },
  });
  const size =
    lines === null
      ? ""
      : isSmallChange(fm.github?.changed)
        ? ` The ${lines}-line change is shown whole beside it.`
        : ` The ${lines}-line change is shown as your summary, with the diff one press away.`;
  const leftOut = filesLeftOut
    ? " `files` was left out: this task's pull request holds its files."
    : "";
  return {
    written: true,
    message:
      `Wrote the completion packet for ${what}` +
      (parts.length > 0 ? ` (the summary, ${parts.join(" and ")}).` : " (the summary).") +
      `${size}${leftOut} It stands until new work replaces ${what}, and stays on the task as its ` +
      "result once a person accepts it.",
  };
}

// ------------------------------------------------------------ the page view

/** One reviewer on the packet, as the task page draws it. */
export interface CompletionVerdictRow {
  profileId: string;
  name: string;
  /** Its verdict on the subject under review, or `pending` for none yet. */
  result: "approve" | "request_changes" | "pending";
  reason: string;
  at: string | null;
  /** Its verdict counts toward acceptance (a required reviewer). */
  required: boolean;
  /** Its latest verdict on EARLIER work, when it has none on this. */
  earlier: { result: "approve" | "request_changes"; sha: string | null; at: string } | null;
}

/** What the task page shows as the completion packet. */
export interface CompletionView {
  /** The revision under review, abbreviated; null when the delivered work
   *  is files. */
  subjectSha: string | null;
  packet: {
    summary: string;
    changes: string | null;
    /** Ruling 668: what to weigh, what was assumed, what is missing. */
    considerations: string | null;
    assumptions: string | null;
    gaps: string | null;
    /** Ruling 668: the result's files the viewer may see. */
    files: { name: string; caption: string }[];
    /** Result files the viewer may not see, or that have left the store. */
    hiddenFiles: number;
    screenshots: { name: string; caption: string }[];
    /** Screenshots the viewer may not see (not a project member) or that
     *  have since left the attachments store. */
    hiddenScreenshots: number;
    at: string;
    /** Written for earlier work: that work's abbreviated sha, or "" for
     *  files. Null when the packet is current. */
    staleFor: string | null;
  } | null;
  verdicts: CompletionVerdictRow[];
  /** The change's size; null when there is no revision or nobody counted. */
  change: { files: number; add: number; del: number; small: boolean } | null;
  /** Ruling 668: the paths the pull request changes, as last read (ruling
   *  236), for the result of a task delivered as a revision: the first
   *  `RESULT_PATHS_SHOWN`, how many more were read, and whether the read
   *  itself was cut. Null when nobody read them. */
  paths: { shown: string[]; more: number; truncated: boolean } | null;
  /** Ruling 690: the kept sources the work under review rests on: how many,
   *  and the first `RESULT_SOURCES_SHOWN` of them. Absent for a viewer who
   *  may not see the task's files, and for a revision that rests on none, so
   *  a task that keeps no sources ships the bytes it always did (ruling 457);
   *  a delivery that is files carries it at zero, which the card says. */
  sources?: ResultSources;
}

/** Ruling 690: a result's sources as its card lists them. */
export interface ResultSources {
  count: number;
  shown: ResultSourceRow[];
}

/** One of them: its id, the name it was saved under (which decides how the
 *  reader card opens it), its title and where it came from. */
export interface ResultSourceRow {
  id: string;
  name: string;
  title: string;
  from: string;
}

/** Ruling 690: how many of a result's sources the card lists; the Sources
 *  panel lists the rest. */
const RESULT_SOURCES_SHOWN = 12;

/**
 * The completion packet as the task page shows it, from the task file the
 * loader has already read. `canSee` answers whether the viewer may see a
 * named attachment and it is still there (null for a viewer who may see no
 * attachments); `nameOf` names a reviewer; `ruleReviewers` are the profiles
 * the project's rules require on every delivered task (ruling 178). None of
 * them reads a store file, so the task page's revalidation budget is
 * untouched (ruling 457). Ruling 690: `sources` is the work's kept sources as
 * the loader read them (`sourcesRestedOn`), or null for a viewer who may not
 * see the task's files.
 */
export function completionView(
  fm: TaskFrontmatter,
  opts: {
    canSee: ((name: string) => boolean) | null;
    nameOf: (profileId: string) => string;
    ruleReviewers: readonly string[];
    sources?: readonly TaskSource[] | null;
  },
): CompletionView | null {
  const subject = reviewSubjectId(fm);
  if (subject === null) return null;
  const rev = activeWorkRevision(fm.workRevision);

  let packet: CompletionView["packet"] = null;
  const onFile = fm.completionPacket;
  if (onFile) {
    const canSee = opts.canSee;
    const screenshots = canSee ? onFile.screenshots.filter((s) => canSee(s.name)) : [];
    const files = canSee ? onFile.files.filter((f) => canSee(f.name)) : [];
    packet = {
      summary: onFile.summary,
      changes: onFile.changes,
      considerations: onFile.considerations,
      assumptions: onFile.assumptions,
      gaps: onFile.gaps,
      files,
      hiddenFiles: onFile.files.length - files.length,
      screenshots,
      hiddenScreenshots: onFile.screenshots.length - screenshots.length,
      at: onFile.at,
      staleFor:
        onFile.subject === subject ? null : (onFile.headSha?.slice(0, 7) ?? ""),
    };
  }

  // Acceptance waits on the task's engaged reviewers and on the project's
  // rules, whether or not anyone engaged a rule's reviewer (ruling 178).
  const required = new Set([
    ...requiredReviewers(fm).map((e) => e.profileId),
    ...opts.ruleReviewers,
  ]);
  // Required reviewers first, the engaged ones in engagement order and then
  // the rules'; then anyone else who gave a verdict on this task, newest first.
  const order: string[] = [...required];
  for (const v of [...fm.verdicts].sort((a, b) => b.at.localeCompare(a.at))) {
    if (!order.includes(v.profileId)) order.push(v.profileId);
  }
  const verdicts = order.map((profileId): CompletionVerdictRow => {
    const current = fm.verdicts.find((v) => v.profileId === profileId && v.revisionId === subject);
    const earlier = current
      ? null
      : ([...fm.verdicts]
          .filter((v) => v.profileId === profileId)
          .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null);
    return {
      profileId,
      name: opts.nameOf(profileId),
      result: current?.result ?? "pending",
      reason: current?.reason ?? "",
      at: current?.at ?? null,
      required: required.has(profileId),
      earlier: earlier
        ? { result: earlier.result, sha: earlier.headSha?.slice(0, 7) ?? null, at: earlier.at }
        : null,
    };
  });

  const stats = rev ? fm.github?.changed : null;
  const changed = rev ? (fm.pr?.paths ?? null) : null;
  const view: CompletionView = {
    subjectSha: rev ? rev.headSha.slice(0, 7) : null,
    packet,
    verdicts,
    change: stats
      ? {
          files: stats.files,
          add: stats.add,
          del: stats.del,
          small: isSmallChange(stats) === true,
        }
      : null,
    paths: changed
      ? {
          shown: changed.changed.slice(0, RESULT_PATHS_SHOWN),
          more: Math.max(0, changed.changed.length - RESULT_PATHS_SHOWN),
          truncated: changed.truncated,
        }
      : null,
  };
  // Ruling 690: a files result says what it rests on even when that is
  // nothing; a revision says so only when it rests on something.
  const rested = opts.sources ?? null;
  if (rested !== null && (rested.length > 0 || !rev)) {
    view.sources = {
      count: rested.length,
      shown: rested.slice(0, RESULT_SOURCES_SHOWN).map((s) => ({
        id: s.id,
        name: s.name,
        title: s.title,
        from: sourceFromShown(s.from),
      })),
    };
  }
  return view;
}
