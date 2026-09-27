import type { DatabaseSync } from "node:sqlite";
import { OPERATOR_AUDIT_ACTOR, recordAudit } from "~/server/audit/audit-recorder.server";
import {
  listTaskAttachments,
  taskAttachmentExists,
  type TaskAttachmentEntry,
} from "~/server/files/task-attachments.server";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import {
  activeWorkRevision,
  requiredReviewers,
  reviewSubjectId,
  type CompletionPacket,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import {
  COMPLETION_CAPTION_MAX,
  COMPLETION_CHANGES_MAX,
  COMPLETION_SCREENSHOTS_MAX,
  COMPLETION_SMALL_CHANGE_LINES,
  COMPLETION_SUMMARY_MAX,
  SCREENSHOT_NAME_RE,
  changedLines,
  isSmallChange,
} from "~/shared/completion-packet";
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
  return entries.filter((e) => SCREENSHOT_NAME_RE.test(e.name)).map((e) => e.name);
}

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
  note: string;
}

export function completionPacketFact(
  fm: TaskFrontmatter,
  input: { projectSlug: string; taskKey: string; dataRoot?: string | undefined },
): CompletionPacketFact {
  const subject = reviewSubjectId(fm);
  const lines = activeWorkRevision(fm.workRevision) ? changedLines(fm.github?.changed) : null;
  const changesSummaryRequired = lines !== null && lines > COMPLETION_SMALL_CHANGE_LINES;
  if (subject === null) {
    return {
      state: "not_applicable",
      writtenAt: null,
      changedLines: lines,
      changesSummaryRequired: false,
      screenshotCandidates: [],
      note: "Nothing is delivered yet, so there is no completion packet to write.",
    };
  }
  const current = currentCompletionPacket(fm);
  const state = current ? "current" : fm.completionPacket ? "stale" : "none";
  const candidates = screenshotCandidates(
    listTaskAttachments(input.projectSlug, input.taskKey, input.dataRoot),
  ).slice(0, 20);
  const size =
    lines === null
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
    note,
  };
}

export interface CompletionPacketInput {
  projectSlug: string;
  taskKey: string;
  summary: string;
  changes?: string | null;
  screenshots?: readonly { name: string; caption?: string | null }[];
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

  const seen = new Set<string>();
  const screenshots: CompletionPacket["screenshots"] = [];
  for (const shot of input.screenshots ?? []) {
    const name = shot.name.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const caption = (shot.caption ?? "").trim();
    screenshots.push({
      name,
      caption:
        caption.length > COMPLETION_CAPTION_MAX
          ? `${caption.slice(0, COMPLETION_CAPTION_MAX - 1)}…`
          : caption,
    });
  }
  if (screenshots.length > COMPLETION_SCREENSHOTS_MAX) {
    return {
      written: false,
      message: `Pick at most ${COMPLETION_SCREENSHOTS_MAX} screenshots: the ones that show the result.`,
    };
  }
  const notImages = screenshots.filter((s) => !SCREENSHOT_NAME_RE.test(s.name)).map((s) => s.name);
  const missing = screenshots
    .filter((s) => SCREENSHOT_NAME_RE.test(s.name))
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
  const packet: CompletionPacket = { subject, summary, changes, screenshots, at };
  if (rev) packet.headSha = rev.headSha;
  const what = subjectPhrase(fm);
  const parts = [
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
    details: { subject, screenshots: screenshots.length, changes: changes !== null },
  });
  const size =
    lines === null
      ? ""
      : isSmallChange(fm.github?.changed)
        ? ` The ${lines}-line change is shown whole beside it.`
        : ` The ${lines}-line change is shown as your summary, with the diff one press away.`;
  return {
    written: true,
    message:
      `Wrote the completion packet for ${what}` +
      (parts.length > 0 ? ` (the summary, ${parts.join(" and ")}).` : " (the summary).") +
      `${size} It stands until new work replaces ${what}.`,
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
}

/**
 * The completion packet as the task page shows it, from the task file the
 * loader has already read. `canSee` answers whether the viewer may see a
 * named attachment and it is still there (null for a viewer who may see no
 * attachments); `nameOf` names a reviewer; `ruleReviewers` are the profiles
 * the project's rules require on every delivered task (ruling 178). None of
 * them reads a store file, so the task page's revalidation budget is
 * untouched (ruling 457).
 */
export function completionView(
  fm: TaskFrontmatter,
  opts: {
    canSee: ((name: string) => boolean) | null;
    nameOf: (profileId: string) => string;
    ruleReviewers: readonly string[];
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
    packet = {
      summary: onFile.summary,
      changes: onFile.changes,
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
  return {
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
  };
}
