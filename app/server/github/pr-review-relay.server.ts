import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  activeWorkRevision,
  type ParsedTaskFile,
  type PrRef,
} from "~/schemas/task-file.schema";
import { findUserById } from "~/server/auth/user-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  resolveTaskFilePath,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { logger } from "~/server/logging/logger.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { taskRef } from "~/server/tasks/task-mutation.server";
import type { ReviewNote } from "~/server/tasks/review-notes.server";
import { toError } from "~/shared/errors";
import type { GithubClient } from "./github-client.server";
import type { PrReviewEvent } from "./pr-linker.server";
import { resolveGithubHandle } from "./pr-human-approval.server";

/**
 * Ruling 484 (pass 40, F40-54): a project member's GitHub review of the
 * delivered revision reaches the agent that delivered it.
 *
 * Before this, a CHANGES_REQUESTED review became the `changes requested` pill
 * and nothing else, and nothing read a line comment at all: the owner's plan
 * was to approve each note in review, and a note he rejected on GitHub never
 * reached the Content Writer.
 *
 * On every reconcile pass that read an open PR's reviews, each review that
 *  · was submitted on the DELIVERED revision's head (a review of an older head
 *    was about work that has since been redone, and a later review of the same
 *    lines will say so again),
 *  · is by a project member (the login mapped through `users.github_handle`,
 *    the R19-B rule, failing closed on an unlinked or ambiguous handle),
 *  · and has not been relayed before,
 * has its line comments read (`GET …/reviews/{id}/comments`) and, with the
 * review's own body when it requested changes, is relayed as ONE comment per
 * reviewer: `@<deliverer>` addressed, each note quoting its `file:line`, tagged
 * "from GitHub", authored by that member (the audit label says
 * `· via GitHub`) and posted through `commentToAgent`, so the deliverer resumes
 * exactly as it would for the same words typed on the task page.
 *
 * Once each: the ids relayed (`review:<id>`, `comment:<id>`) are recorded on
 * the task's `pr` under {@link REVIEW_RELAY_KEY} in the SAME locked write that
 * appends the comment, so a relay and its record cannot come apart. A review
 * that carried nothing to relay (an approval with no line comments) is recorded
 * too, so its comments are not listed again on every pass.
 */

/** The loose `pr` key the relay owns (the `humanApproval` pattern). */
export const REVIEW_RELAY_KEY = "reviewRelay";

/** Ids kept, newest last. A pull request with more relayed comments than this
 *  forgets its oldest, which are on heads long since reworked. */
const RELAYED_KEEP = 500;

const reviewRelaySchema = z.object({ relayed: z.array(z.string().min(1)) });

/** The ids already relayed on this PR, or an empty set. Never throws. */
export function readReviewRelay(pr: PrRef | null | undefined): ReadonlySet<string> {
  const parsed = reviewRelaySchema.safeParse(pr?.[REVIEW_RELAY_KEY]);
  return new Set(parsed.success ? parsed.data.relayed : []);
}

/** Stamp `ids` onto the file's PR record, if it is still PR `prNumber`. */
function stampRelayed(parsed: ParsedTaskFile, prNumber: number, ids: readonly string[]): void {
  const pr = parsed.frontmatter.pr;
  if (!pr || pr.number !== prNumber || ids.length === 0) return;
  const merged = [...new Set([...readReviewRelay(pr), ...ids])].slice(-RELAYED_KEEP);
  parsed.frontmatter.pr = { ...pr, [REVIEW_RELAY_KEY]: { relayed: merged } };
}

const reviewKey = (id: number) => `review:${id}`;
const commentKey = (id: number) => `comment:${id}`;

/** The reviews whose line comments are worth relaying. A DISMISSED review was
 *  withdrawn before it was relayed; PENDING never reaches here. */
const RELAYED_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);

/** One review comment's read slice. The line fields are GitHub's: `line` on
 *  the current head, `original_line` on the commit it was written on. */
const reviewCommentSchema = z.object({
  id: z.number().int(),
  path: z.string().min(1),
  body: z.string().catch(""),
  line: z.number().int().nullable().optional().catch(null),
  original_line: z.number().int().nullable().optional().catch(null),
  start_line: z.number().int().nullable().optional().catch(null),
  original_start_line: z.number().int().nullable().optional().catch(null),
  start_side: z.string().nullable().optional().catch(null),
  side: z.string().nullable().optional().catch(null),
  original_commit_id: z.string().nullable().optional().catch(null),
});
type ReviewComment = z.output<typeof reviewCommentSchema>;
/** A row that does not decode is dropped (and counted), never the page. */
const reviewCommentsSchema = z.array(reviewCommentSchema.nullable().catch(null));

const COMMENT_PAGES = 3;
const PER_PAGE = 100;

/** Every line comment of one review, or null when GitHub did not answer (the
 *  review is then left for the next pass). */
async function readReviewComments(
  gh: { client: GithubClient; repo: string },
  prNumber: number,
  reviewId: number,
): Promise<ReviewComment[] | null> {
  const out: ReviewComment[] = [];
  let dropped = 0;
  for (let page = 1; page <= COMMENT_PAGES; page += 1) {
    const answer = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/pulls/${prNumber}/reviews/${reviewId}/comments`,
      reviewCommentsSchema,
      { searchParams: { per_page: PER_PAGE, page } },
    );
    if (!answer.ok) return null;
    for (const row of answer.data) {
      if (row) out.push(row);
      else dropped += 1;
    }
    if (answer.data.length < PER_PAGE) break;
  }
  if (dropped > 0) {
    logger.warn("review comments partly unreadable; those rows are not relayed", {
      repo: gh.repo,
      prNumber,
      reviewId,
      dropped,
    });
  }
  return out;
}

/** A GitHub line comment as a note: its line on the commit it was written on.
 *  A multi-line comment's first line keeps its own side (ruling 509). */
function commentNote(c: ReviewComment): ReviewNote {
  const line = c.original_line ?? c.line ?? null;
  const start = c.original_start_line ?? c.start_line ?? null;
  return {
    path: c.path,
    line,
    startLine: start,
    startSide: c.start_side === "LEFT" ? "old" : c.start_side === "RIGHT" ? "new" : null,
    side: c.side === "LEFT" ? "old" : "new",
    body: c.body,
  };
}

interface ReviewerBatch {
  userId: string;
  label: string;
  login: string;
  ids: string[];
  notes: ReviewNote[];
}

export interface ReviewRelayResult {
  /** Comments posted (one per reviewer with something to say). */
  relayed: number;
  /** Review and comment ids recorded as handled. */
  recorded: number;
}

/**
 * Relay what members said on GitHub about the delivered revision. Called by
 * the reconciler after its own write, inside the task's reconcile lock, so two
 * passes never relay the same review. Nothing here throws: a failure is logged
 * and the next pass tries again, because a relay the reconcile paid for must
 * never fail the reconcile.
 */
export async function relayPrReviews(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    prNumber: number;
    events: readonly PrReviewEvent[];
  },
  gh: { client: GithubClient; repo: string },
  ctx: { dataRoot?: string } = {},
): Promise<ReviewRelayResult> {
  const none: ReviewRelayResult = { relayed: 0, recorded: 0 };
  const ref = taskRef(ctx, input.projectSlug, input.taskKey);
  const file = readTaskFile(ref);
  if (!file) return none;
  const fm = file.parsed.frontmatter;
  // An accepted (merge pending), merged or closed PR is past review.
  if (fm.pr?.number !== input.prNumber || fm.pr.state !== "review") return none;
  const rev = activeWorkRevision(fm.workRevision);
  if (!rev || rev.kind === "verified") return none;
  const done = readReviewRelay(fm.pr);
  const pending = input.events.filter(
    (e) =>
      RELAYED_STATES.has(e.state) && e.commitSha === rev.headSha && !done.has(reviewKey(e.id)),
  );
  if (pending.length === 0) return none;

  const project = readProjectFile({ projectSlug: input.projectSlug, dataRoot: ctx.dataRoot });
  if (!project) return none;
  const members = new Set(project.parsed.frontmatter.members.map((m) => m.userId));
  // Dynamic: review-notes reaches task-acceptance and task-delivery (through
  // agent-reply), and both load this module's importer, the reconciler, when
  // they run.
  const { noteRecipient, reviewNotesDirective } = await import(
    "~/server/tasks/review-notes.server"
  );
  const recipient = noteRecipient(ctx, input.projectSlug, fm);
  // Nobody to address: left unrecorded, so a deliverer engaged on this same
  // head still gets it.
  if (!recipient) return none;

  const batches = new Map<string, ReviewerBatch>();
  for (const review of pending) {
    const who = resolveGithubHandle(db, review.login);
    if (who.kind !== "found" || !members.has(who.userId)) continue;
    const user = findUserById(db, who.userId);
    if (!user || user.disabled) continue;
    const comments = await readReviewComments(gh, input.prNumber, review.id);
    if (comments === null) continue;
    const batch = batches.get(who.userId) ?? {
      userId: who.userId,
      label: `${user.email} · via GitHub`,
      login: review.login,
      ids: [],
      notes: [],
    };
    batch.ids.push(reviewKey(review.id));
    if (review.state === "CHANGES_REQUESTED" && review.body.trim()) {
      batch.notes.push({
        path: null,
        line: null,
        startLine: null,
        startSide: null,
        side: "new",
        body: review.body,
      });
    }
    for (const c of comments) {
      const key = commentKey(c.id);
      if (done.has(key)) continue;
      // A comment carried into this review from another head is not a note on
      // the delivered one.
      if (c.original_commit_id && c.original_commit_id !== rev.headSha) continue;
      batch.ids.push(key);
      if (c.body.trim()) batch.notes.push(commentNote(c));
    }
    batches.set(who.userId, batch);
  }

  const result: ReviewRelayResult = { relayed: 0, recorded: 0 };
  const { commentToAgent } = await import("~/server/tasks/task-comments.server");
  for (const batch of batches.values()) {
    try {
      if (batch.notes.length === 0) {
        await updateTaskFile(ref, (parsed) => stampRelayed(parsed, input.prNumber, batch.ids));
        rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
      } else {
        const text = reviewNotesDirective({
          handle: recipient.handle,
          revisionSha: rev.headSha,
          prNumber: input.prNumber,
          notes: batch.notes,
          fromGithub: { login: batch.login },
        });
        await commentToAgent(
          db,
          {
            projectSlug: input.projectSlug,
            taskKey: input.taskKey,
            text,
            alsoWrite: (parsed) => stampRelayed(parsed, input.prNumber, batch.ids),
          },
          { userId: batch.userId, label: batch.label },
          { dataRoot: ctx.dataRoot },
        );
        result.relayed += 1;
      }
      result.recorded += batch.ids.length;
    } catch (error) {
      logger.warn("GitHub review relay failed; the next reconcile retries it", {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        prNumber: input.prNumber,
        err: toError(error),
      });
    }
  }
  return result;
}
