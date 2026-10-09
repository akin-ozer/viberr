import { z } from "zod";
import {
  activeWorkRevision,
  deliveringEngagement,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { REVIEW_NOTE_MAX_CHARS } from "~/shared/diff-rows";
import { agentMentionHandle } from "./agent-reply.server";
import { listDeployedSpecialists } from "./specialist-roster.server";
import { taskRef, type TaskMutationContext } from "./task-mutation.server";

/**
 * Ruling 246 (pass 40, F40-54): review notes that reach the agent.
 *
 * The owner's plan for WEB-6 was "Akin approves each note individually in
 * review", and Viberr gave a person `Diff N files · +a −d` and nothing to read
 * or answer. A review on GitHub was the only place to do it, and there a
 * CHANGES_REQUESTED review became a pill state and its line comments were never
 * read, so rejecting one note never reached the Content Writer.
 *
 * Two doors now write the same thing: the task page's Changes panel (a person's
 * line notes, `review-notes` intent) and the reconciler's review relay (a
 * project member's GitHub review on the delivered head). Both post ONE comment
 * through `commentToAgent`, addressed `@<deliverer>` and quoting each note's
 * `file:line`, so the delivering agent is resumed exactly as a person's
 * @mention resumes it, with the same role gate. This module is the one
 * definition of that comment.
 */

/** One note. `path: null` is a review's own body (a CHANGES_REQUESTED review
 *  relayed from GitHub); `line: null` is a note on a whole file. */
export interface ReviewNote {
  path: string | null;
  line: number | null;
  /** The first line of a multi-line range, when there is one. */
  startLine: number | null;
  /** The side `startLine` is numbered on when it is not `side`'s: a range can
   *  run from a removed line to an added one, as a GitHub comment's
   *  `start_side` can (ruling 246). Null reads as `side`. */
  startSide: "new" | "old" | null;
  /** `old` = a removed line, numbered in the file as it was. */
  side: "new" | "old";
  body: string;
}

/** The most notes one post carries (the longest note is
 *  `REVIEW_NOTE_MAX_CHARS`, which the panel's box reads too). */
const REVIEW_NOTES_MAX = 50;

/** A panel note as the `review-notes` intent receives it (JSON). A note on
 *  several lines (ruling 246) also names its first line and that line's side;
 *  on one side a range reads downward, as the diff draws it. */
const panelNoteSchema = z
  .object({
    path: z.string().trim().min(1).max(1_000),
    line: z.number().int().min(1),
    side: z.enum(["new", "old"]),
    startLine: z.number().int().min(1).optional(),
    startSide: z.enum(["new", "old"]).optional(),
    body: z.string().trim().min(1).max(REVIEW_NOTE_MAX_CHARS),
  })
  .refine((note) =>
    note.startLine === undefined
      ? note.startSide === undefined
      : (note.startSide ?? note.side) !== note.side || note.startLine <= note.line,
  );
/** The form field: a JSON array of notes. */
const panelNotesField = z
  .string()
  .transform((text, check) => {
    try {
      return JSON.parse(text);
    } catch {
      check.addIssue({ code: "custom", message: "notes are not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.array(panelNoteSchema).min(1).max(REVIEW_NOTES_MAX));

/** The intent's `notes` field, or a validation refusal a person can act on. */
export function parsePanelReviewNotes(raw: FormDataEntryValue | null): ReviewNote[] {
  const parsed = panelNotesField.safeParse(raw);
  if (!parsed.success) {
    throw AppError.validation(
      `Add between 1 and ${REVIEW_NOTES_MAX} notes, each on a changed line and at most ${REVIEW_NOTE_MAX_CHARS} characters.`,
    );
  }
  return parsed.data.map(({ startLine, startSide, ...note }) => ({
    ...note,
    startLine: startLine ?? null,
    startSide: startSide ?? null,
  }));
}

/**
 * An `@` that would open a mention, escaped. The comment has ONE addressee,
 * the deliverer: the mention resolver routes `@operator` ahead of any agent,
 * and a GitHub body's `@login` names a GitHub account, not a Viberr person. A
 * markdown backslash escape renders as the `@` it was and is no mention to the
 * server (a mention starts at an `@` after whitespace).
 */
function defuseMentions(text: string): string {
  return text.replace(/(^|\s)@(?=[A-Za-z])/g, "$1\\@");
}

/** Where a note points, as the comment quotes it: `path:line`, or
 *  `path:start-end` for lines on one side. A range from a removed line to an
 *  added one has no single numbering, so it names both ends (ruling 246). */
function noteTarget(note: ReviewNote & { path: string }): string {
  const path = note.path.replaceAll("`", "'");
  if (note.line === null) return `\`${path}\``;
  const startSide = note.startSide ?? note.side;
  if (note.startLine !== null && startSide !== note.side) {
    const end = (side: "new" | "old", line: number) =>
      `${side === "old" ? "removed line" : "line"} ${line}`;
    return `\`${path}\` (${end(startSide, note.startLine)} to ${end(note.side, note.line)})`;
  }
  if (note.startLine !== null && note.startLine < note.line) {
    const removed = note.side === "old" ? " (removed lines)" : "";
    return `\`${path}:${note.startLine}-${note.line}\`${removed}`;
  }
  return `\`${path}:${note.line}\`${note.side === "old" ? " (removed line)" : ""}`;
}

/**
 * The comment both doors post. The first line addresses the deliverer and
 * names the revision and pull request the notes were written on; a relayed
 * review says it came from GitHub and whose it was. Each note is one list
 * item, its continuation lines indented so markdown keeps them in the item.
 */
export function reviewNotesDirective(input: {
  /** The deliverer's @handle, without the `@` (`agentMentionHandle`). */
  handle: string;
  revisionSha: string;
  prNumber: number;
  notes: readonly ReviewNote[];
  /** Set by the relay: the GitHub login whose review this is. */
  fromGithub?: { login: string } | null;
}): string {
  const source = input.fromGithub
    ? `, from GitHub (a review by ${input.fromGithub.login.replace(/^@+/, "")}):`
    : ":";
  const head = `@${input.handle} Review notes on \`${input.revisionSha.slice(0, 7)}\` (PR #${input.prNumber})${source}`;
  const items = input.notes.map((note) => {
    const label = note.path === null ? "Requested changes" : noteTarget({ ...note, path: note.path });
    // A panel note is refused past the cap; a GitHub comment is not ours to
    // refuse, so a longer one is cut and says where the rest is.
    const trimmed = note.body.trim();
    const clipped =
      trimmed.length > REVIEW_NOTE_MAX_CHARS
        ? `${trimmed.slice(0, REVIEW_NOTE_MAX_CHARS)}… (cut here; the full comment is on the pull request)`
        : trimmed;
    const body = defuseMentions(clipped).split(/\r?\n/).join("\n  ");
    return `- ${label}: ${body}`;
  });
  return [head, "", ...items].join("\n");
}

/** The delivering agent a note would reach, with the handle that reaches it,
 *  or null when nobody delivers or the deliverer is no longer deployed (the
 *  mention resolver would route the handle to nobody). */
export function noteRecipient(
  ctx: TaskMutationContext,
  projectSlug: string,
  fm: Pick<TaskFrontmatter, "engagements">,
): { profileId: string; name: string; handle: string } | null {
  const delivering = deliveringEngagement(fm);
  if (!delivering) return null;
  const deployed = listDeployedSpecialists(projectSlug, ctx).find(
    (s) => s.id === delivering.profileId,
  );
  if (!deployed) return null;
  return {
    profileId: deployed.id,
    name: deployed.name,
    handle: agentMentionHandle({ profileId: deployed.id, name: deployed.name }),
  };
}

/**
 * The `review-notes` intent's comment: the panel's notes, bound to the
 * revision the person read. A refusal says why and what to do, and the notes
 * stay in the panel.
 */
export function panelReviewNotesText(
  ctx: TaskMutationContext,
  input: { projectSlug: string; taskKey: string; headSha: string; notes: readonly ReviewNote[] },
): string {
  const file = readTaskFile(taskRef(ctx, input.projectSlug, input.taskKey));
  if (!file) throw AppError.notFound(`Task ${input.taskKey} not found.`);
  const fm = file.parsed.frontmatter;
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev || rev.kind === "verified" || !fm.pr) {
    throw AppError.conflict(
      `${input.taskKey} has no delivered revision on a pull request, so there are no changes to note.`,
    );
  }
  if (rev.headSha !== input.headSha) {
    throw AppError.conflict(
      `The delivered revision is now ${rev.headSha.slice(0, 7)} and these notes were written on ${input.headSha.slice(0, 7) || "another revision"}. Reload the changes and check the notes against it before sending.`,
    );
  }
  const recipient = noteRecipient(ctx, input.projectSlug, fm);
  if (!recipient) {
    throw AppError.conflict(
      `No deployed agent delivers ${input.taskKey}, so these notes would reach nobody. Comment on the timeline instead.`,
    );
  }
  return reviewNotesDirective({
    handle: recipient.handle,
    revisionSha: rev.headSha,
    prNumber: fm.pr.number,
    notes: input.notes,
  });
}
