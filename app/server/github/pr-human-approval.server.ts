import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { PrRef, Validation, WorkRevision } from "~/schemas/task-file.schema";
import type { PrApproval } from "./pr-linker.server";

/**
 * R19-B (owner ruling, pass 19) — **a project member's GitHub approval on the
 * PR counts as the approving verdict.**
 *
 * The asymmetry this closes: a human's DISAPPROVAL already binds the gate
 * (closing the PR unmerged is a terminal fact that outranks every process gate,
 * R16-3), while their APPROVAL was inert — `deriveReviewState`'s own docstring
 * calls the review state "a status pill, not the merge gate". So on a project
 * running no verdict-capable agent, EVERY acceptance had to be an admin
 * force-accept, permanently audited as bypassing a gate no one could satisfy.
 * FR37 names the task owner "reviewer + acceptance authority"; the verdict
 * machinery could not express it.
 *
 * Four things make this evidence rather than a rubber stamp:
 *
 *  1. **It is bound to the delivered revision.** GitHub keeps an approval
 *     standing after new commits land, so "approved" alone says nothing about
 *     WHAT was approved. The approval's `commit_id` must equal the delivered
 *     revision's head — checked when it is recorded AND again on every read, so
 *     a re-delivery invalidates it instantly without waiting for a reconcile.
 *     Same contract as an agent verdict, which binds to `workRevision.id`.
 *  2. **The approver must be a project member**, resolved from the GitHub login
 *     to a Viberr user through `users.github_handle`.
 *  3. **It fails CLOSED.** An approval we cannot confidently map — no linked
 *     handle, two users claiming it, someone who is not a member — does not
 *     count, and the reason is recorded so the acceptance surface can SAY why
 *     instead of going quiet.
 *  4. **It is never silent.** A gate satisfied this way names the human, their
 *     handle and the commit.
 *
 * The record rides on `pr` in the task file. `prRefSchema` is `.loose()`, so it
 * round-trips through the tolerant parser and the YAML writer untouched; this
 * module owns its shape, validates it on the way in AND out, and is the only
 * place that reads it.
 */

/** Why a GitHub approval does — or does not — count as the verdict. */
export const PR_APPROVAL_STATUSES = [
  /** A project member approved the delivered revision. This IS the verdict. */
  "counted",
  /** No Viberr user carries that GitHub handle. */
  "unlinked_handle",
  /** More than one user claims the handle — never guess an identity. */
  "ambiguous_handle",
  /** The handle maps to a real user who is not a member of this project. */
  "not_a_member",
  /** The approval was submitted on a different commit than the delivered one. */
  "stale_revision",
] as const;
export type PrApprovalStatus = (typeof PR_APPROVAL_STATUSES)[number];

export const prHumanApprovalSchema = z
  .object({
    /** The approver's GitHub login, as GitHub reported it. */
    login: z.string().min(1),
    /** The commit the approval was submitted on (null = GitHub omitted it,
     *  which can never count — an unbound approval is not evidence). */
    commitSha: z.string().nullable().default(null),
    at: z.string().nullable().default(null),
    /** The Viberr user, when the handle mapped confidently. */
    userId: z.string().nullable().default(null),
    /** Their display name, for the sentence on the acceptance surface. */
    name: z.string().nullable().default(null),
    status: z.enum(PR_APPROVAL_STATUSES),
  })
  .loose();
export type PrHumanApproval = z.infer<typeof prHumanApprovalSchema>;

/** The `pr` key this record lives under. */
export const PR_HUMAN_APPROVAL_KEY = "humanApproval";

/** A project member, as the reconciler can cheaply supply it. */
export interface ProjectMemberIds {
  userId: string;
}

type UserHandleRow = {
  id: string;
  name: string | null;
};

/**
 * Resolve a GitHub login to a Viberr user id — case-insensitively, and only
 * when the answer is unambiguous. Two users carrying the same handle is a data
 * problem, not a coin flip: it resolves to "ambiguous" and the approval fails
 * closed.
 */
export function resolveGithubHandle(
  db: DatabaseSync,
  login: string,
): { kind: "found"; userId: string; name: string } | { kind: "none" } | { kind: "ambiguous" } {
  const handle = login.trim().toLowerCase().replace(/^@/, "");
  if (!handle) return { kind: "none" };
  // SAFETY: both selected columns are declared TEXT on `users`
  // (0001_baseline.sql — `name` NOT NULL, so the nullable read below is a
  // defensive widening), and `all` returns one object per matching row.
  const rows = db
    .prepare(
      `SELECT id, name FROM users
        WHERE lower(github_handle) = ? AND disabled = 0
        ORDER BY id ASC`,
    )
    .all(handle) as UserHandleRow[];
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) return { kind: "ambiguous" };
  const row = rows[0]!;
  return { kind: "found", userId: row.id, name: row.name ?? handle };
}

/**
 * R19-B — classify the PR's standing approvals against the delivered revision
 * and the project's membership, and return the ONE record worth persisting.
 *
 * Preference order is deliberate: a COUNTED approval always wins, so one
 * stranger's approval can never mask a member's. Otherwise the best near-miss
 * is kept, because the acceptance surface has to be able to explain the near
 * miss — "@octocat approved, but that handle is not linked to a member" is the
 * fail-closed disclosure the ruling asks for, and silence is not.
 *
 * Returns null when the PR carries no standing approval at all.
 */
export function derivePrHumanApproval(input: {
  approvals: readonly PrApproval[];
  /** The delivered revision's head sha — the only commit an approval may bind
   *  to. Null (nothing delivered) means no approval can count. */
  deliveredSha: string | null;
  memberUserIds: ReadonlySet<string>;
  db: DatabaseSync;
}): PrHumanApproval | null {
  const classified = input.approvals.map((approval) => {
    const base = {
      login: approval.login,
      commitSha: approval.commitSha,
      at: approval.at,
    };
    const resolved = resolveGithubHandle(input.db, approval.login);
    if (resolved.kind === "ambiguous") {
      return { ...base, userId: null, name: null, status: "ambiguous_handle" as const };
    }
    if (resolved.kind === "none") {
      return { ...base, userId: null, name: null, status: "unlinked_handle" as const };
    }
    if (!input.memberUserIds.has(resolved.userId)) {
      return {
        ...base,
        userId: resolved.userId,
        name: resolved.name,
        status: "not_a_member" as const,
      };
    }
    // Mapped and a member — the only remaining question is WHAT they approved.
    const bound =
      input.deliveredSha !== null &&
      approval.commitSha !== null &&
      approval.commitSha === input.deliveredSha;
    return {
      ...base,
      userId: resolved.userId,
      name: resolved.name,
      status: bound ? ("counted" as const) : ("stale_revision" as const),
    };
  });
  if (classified.length === 0) return null;
  const rank = {
    counted: 0,
    stale_revision: 1,
    not_a_member: 2,
    ambiguous_handle: 3,
    unlinked_handle: 4,
  } satisfies Record<PrApprovalStatus, number>;
  return classified.sort((a, b) => rank[a.status] - rank[b.status])[0]!;
}

/** The persisted record on `pr`, validated — or null when absent/garbage.
 *  Never throws: a hand-edited task.md must not break a read path. */
export function readPrHumanApproval(pr: PrRef | null | undefined): PrHumanApproval | null {
  if (!pr) return null;
  // `pr` is a LOOSE schema — unknown keys survive parsing, which is what lets
  // this record ride along on the ref without a schema change.
  const raw = pr[PR_HUMAN_APPROVAL_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = prHumanApprovalSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * R19-B — the human GitHub approval that SATISFIES the R15-1 verdict gate right
 * now, or null.
 *
 * The revision binding is re-checked HERE, against the task's current
 * `workRevision`, not trusted from when the record was written. That is what
 * makes a re-delivery revoke the approval the moment it lands: the new revision
 * has a new head sha, the stored approval no longer matches it, and the gate
 * closes again with no GitHub round-trip.
 *
 * It is also why GitHub being unreachable cannot flip a satisfied gate red. The
 * reconciler treats an unread `/reviews` call as UNKNOWN and carries the last
 * record forward (exactly as it already does for `checks`, `review` and
 * `mergeable`), so an offline GitHub changes nothing here — the gate stays
 * satisfied on the same revision it was satisfied on. Only two things can
 * revoke it: a NEW delivered revision (checked here, offline), or GitHub
 * actually telling us the approval is gone (dismissed / changes requested),
 * which is a real fact and should close the gate.
 */
export function humanVerdictApproval(fm: {
  pr: PrRef | null;
  workRevision: WorkRevision | null;
}): PrHumanApproval | null {
  const approval = readPrHumanApproval(fm.pr);
  if (!approval || approval.status !== "counted") return null;
  if (!approval.userId || !approval.commitSha) return null;
  const delivered = fm.workRevision?.headSha ?? null;
  if (!delivered || delivered !== approval.commitSha) return null;
  return approval;
}

/** "Arda Yılmaz (@arda)" — the human, named. */
function approverLabel(approval: PrHumanApproval): string {
  return approval.name ? `${approval.name} (@${approval.login})` : `@${approval.login}`;
}

/**
 * R19-B — the sentence the acceptance surface shows when the gate IS satisfied
 * by a human's GitHub approval. The gate must never just go green: whoever
 * accepts has to see whose judgement they are relying on, and on what commit.
 */
export function humanVerdictNote(approval: PrHumanApproval): string {
  return (
    `Approved on GitHub by ${approverLabel(approval)} on the delivered revision ` +
    `\`${(approval.commitSha ?? "").slice(0, 7)}\` — a project member's PR approval is the verdict.`
  );
}

/**
 * R19-B — why a GitHub approval that EXISTS did not count, or null when there
 * is nothing to explain.
 *
 * The fail-closed half of the ruling. Silence here would be the worst outcome:
 * a reviewer who approved on GitHub, saw nothing change, and has no idea their
 * account was never linked. Each sentence names the concrete repair.
 */
export function humanApprovalRefusalNote(fm: {
  pr: PrRef | null;
  workRevision: WorkRevision | null;
}): string | null {
  const approval = readPrHumanApproval(fm.pr);
  if (!approval) return null;
  if (approval.status === "counted") {
    // It counted when it was recorded. If it no longer binds, the delivered
    // revision moved under it (a re-delivery) — say exactly that rather than
    // reverting to the generic "no approving verdict yet".
    if (humanVerdictApproval(fm)) return null;
    return (
      `${approverLabel(approval)} approved commit \`${(approval.commitSha ?? "unknown").slice(0, 7)}\` ` +
      `on GitHub, which is no longer the delivered revision — re-approve the current head.`
    );
  }
  switch (approval.status) {
    case "stale_revision":
      return (
        `${approverLabel(approval)} approved commit ` +
        `\`${(approval.commitSha ?? "unknown").slice(0, 7)}\` on GitHub, not the delivered ` +
        `revision — the approval cannot stand in for a verdict until they approve the current head.`
      );
    case "unlinked_handle":
      return (
        `@${approval.login} approved the pull request on GitHub, but no Viberr account carries ` +
        `that GitHub handle — link it on their profile and it will count as the verdict.`
      );
    case "ambiguous_handle":
      return (
        `@${approval.login} approved the pull request on GitHub, but more than one Viberr account ` +
        `claims that handle — resolve the duplicate before the approval can count.`
      );
    case "not_a_member":
      return (
        `${approverLabel(approval)} approved the pull request on GitHub, but they are not a member ` +
        `of this project — only a project member's approval can be the verdict.`
      );
  }
}

/**
 * R15-1 (owner ruling 2026-07-28) — the verdict gate: DELIVERED work needs a
 * healthy verdict on the delivered revision before a human may accept it.
 *
 * ONE definition, two readers: the runtime acceptance path
 * (`acceptanceRefusalReason`, task-actions.server) and the projection
 * (`acceptanceBlockReason`, rebuilder.server) both call this, so the review
 * queue and decisions inbox can never disagree with what the task page will
 * accept. `validation` is passed in — the caller already holds the FRESH
 * derivation (`deriveValidation(fm)`), never a stored cache.
 *
 * Live-proven hole (F15-19): VIB-9's revision wore an "awaiting verdict" chip
 * and plain human acceptance still merged PR #117 with ZERO verdicts on it —
 * the required-reviewer gate only binds when a verdict-capable reviewer is
 * engaged, so an unreviewed delivery sailed through. A task with NO delivered
 * revision stays acceptable (planning / non-repo work). Force-accept is the
 * audited bypass.
 */
export function verdictGateReason(
  fm: {
    pr: PrRef | null;
    workRevision: WorkRevision | null;
    noChanges?: boolean;
  },
  validation: Validation,
  taskKey: string,
): string | null {
  if (!fm.workRevision) return null;
  // Delivered work with no PR: nothing stands for review, so acceptance would
  // close the task on work no PR ever carried (R15-1 gate 1).
  if (!fm.pr) {
    // R17-2 (F17-L9) / R19-8: unless the branch is verified empty, or the
    // revision IS a verification revision (a reviewer judged the base sha
    // because there was nothing to deliver) — a "Completed — no changes"
    // outcome. There is nothing to open a PR for; acceptance closes it to Done
    // without a merge, after re-proving the basis live.
    if (fm.noChanges || fm.workRevision.kind === "verified") return null;
    return `${taskKey} has delivered work but no review pull request — deliver the branch & open the PR before accepting.`;
  }
  // `healthy` clears the gate; `failing` was already named precisely by
  // `acceptanceBlockedReason`, which runs first in both callers.
  if (validation === "healthy" || validation === "failing") return null;
  // R19-B (owner ruling, pass 19): a PROJECT MEMBER'S GITHUB APPROVAL ON THE PR
  // IS the approving verdict. On a project running no verdict-capable agent,
  // `deriveValidation` can never reach `healthy`, so every acceptance had to be
  // an admin force-accept — an override row asserting the human bypassed a gate
  // he had actually satisfied, in the exact audit trail FR33 exists for. Bound
  // to the delivered revision, mapped to a member, re-checked on this read (see
  // `humanVerdictApproval`). It does NOT relax `acceptanceBlockedReason` above:
  // a reviewer the project deliberately ENGAGED still owes its verdict.
  if (humanVerdictApproval(fm)) return null;
  // Fail closed, but never silently: an approval that exists and did not count
  // says why (unlinked handle, non-member, approved an older commit) instead of
  // sending the reviewer to look for a review that already happened.
  const nearMiss = humanApprovalRefusalNote(fm);
  if (nearMiss) {
    return `${taskKey}'s delivered revision has no approving verdict yet — ${nearMiss}`;
  }
  return `${taskKey}'s delivered revision has no approving verdict yet — run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept.`;
}
