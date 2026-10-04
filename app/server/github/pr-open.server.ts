import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  activeWorkRevision,
  type PrBodyWritten,
  type PrRef,
  type TaskFileEvent,
  type TaskFrontmatter,
} from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { markWriteScopeProven } from "~/server/secrets/pat-store.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
  type TaskFileReadResult,
  type TaskFileRef,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { appOrigin } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import { toError } from "~/shared/errors";
import { taskBranchName } from "./branch-sync.server";
import type { GithubActionContext } from "./github-reconciler.server";
import { githubFailureMessage, githubWebHost } from "./github-client.server";
import {
  getProjectGithubContext,
  type GithubContext,
  type GithubContextFailure,
  type GithubContextOptions,
} from "./github-context.server";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";
import { recordPrAdoption } from "./pr-adoption-record.server";
import { mapPrToCacheState } from "./pr-linker.server";
import {
  type FlagScopeViolationInput,
  flagScopeViolation,
  policyViolationText,
} from "./scope-flag.server";

/**
 * Compose the review PR body from the task contract (FR31/FR32). This is the
 * governed hand-off the PRD promises: a reviewer opening the PR on GitHub can
 * see the task's goal, a change summary, evidence, and — critically — a link
 * back to the canonical Viberr task, so task ↔ branch ↔ PR stays traceable
 * without asking. Pure + exported so its exact contents are unit-tested.
 */
export function composePrBody(input: {
  taskKey: string;
  projectSlug: string;
  title: string;
  goal: string;
  /**
   * N20-4 (§5a): the app's absolute public origin, or `null` when it is not
   * configured (the caller passes `appOrigin()`). When `null` the link is
   * OMITTED and the plain store key is written instead — a relative
   * `/projects/…` link 404s on github.com, which is worse than no link.
   */
  appOrigin: string | null;
  changeSummary?: string | null;
  evidence?: string[] | null;
}): string {
  const lines: string[] = [];
  if (input.appOrigin) {
    const url = `${input.appOrigin}/projects/${input.projectSlug}/tasks/${input.taskKey}`;
    lines.push(`**Viberr task:** [${input.taskKey} · ${input.title}](${url})`);
  } else {
    // N20-4 (§5a): no absolute origin to link to — name the task by its store
    // key so a reviewer can still find it, rather than emitting a relative link
    // that dead-ends on github.com (ruling 3: the store-relative key is the
    // honest fallback).
    lines.push(`**Viberr task:** ${input.taskKey} · ${input.title}`);
  }
  lines.push("");
  lines.push("## Goal");
  lines.push(input.goal.trim() || "_No goal recorded on the task._");
  if (input.changeSummary && input.changeSummary.trim()) {
    lines.push("");
    lines.push("## Change summary");
    lines.push(input.changeSummary.trim());
  }
  if (input.evidence && input.evidence.length > 0) {
    lines.push("");
    lines.push("## Evidence");
    for (const e of input.evidence) lines.push(`- ${e}`);
  }
  lines.push("");
  lines.push(
    `---\n_Opened by Viberr for task ${input.taskKey}. Review and merge are human-authorized; accepting the completion in Viberr merges this PR when GitHub is reachable. When it is not, the acceptance is recorded as merge-pending until a human completes the merge._`,
  );
  return lines.join("\n");
}

/** Ruling 526: a PR-body row names a check's ending in words; a reference
 *  that is neither goes unmarked. */
const EVIDENCE_LINE_LEAD = { pass: "**Passed:** ", fail: "**Failed:** ", info: "" } as const;

/**
 * P13-D-26 — the newest event's `evidence:` rows, as PR-body bullet lines
 * (`<label> · <result>`, an empty result dropped, a pass or a failure led by
 * its word). Newest-first timeline, so the first event carrying evidence is
 * the latest outcome. Returns null when the task has none, which keeps the
 * "## Evidence" section out of the body.
 */
function latestEvidenceLines(
  timeline: readonly TaskFileEvent[],
): string[] | null {
  const withEvidence = timeline.find((e) => e.evidence && e.evidence.length > 0);
  if (!withEvidence?.evidence) return null;
  return withEvidence.evidence.map(
    (row) => EVIDENCE_LINE_LEAD[row.status] + (row.result ? `${row.label} · ${row.result}` : row.label),
  );
}

/**
 * F22-10 — the ACTUAL delivered diff, from GitHub's compare of `base...head`
 * AFTER the push. The PR body's change-summary and evidence used to come from
 * `fm.github.changed` / `fm.github.commits`, which are RECONCILED values: when a
 * stale remote branch (or a prior PR) occupied the head, the reconciler wrote
 * that branch's stats onto the task, and the freshly-opened PR body inherited
 * them (live: PR #187 claimed "3 file(s) changed (+214/-16), 3 commit(s)" while
 * the real diff was 1 file / +5). Computing from the live compare makes the PR
 * body an authoritative record of what THIS PR changes, independent of any
 * reconcile snapshot. `null` on any network/decode failure — the caller then
 * falls back to the frontmatter (best-effort, the prior behavior).
 *
 * `files` is capped by GitHub at 300 per page; a truncated compare undercounts,
 * so `truncated` marks it and the label reads "300+". Sufficient for a summary.
 */
interface DeliveredDiffStats {
  files: number;
  add: number;
  del: number;
  commits: number;
  truncated: boolean;
}

const ghCompareStatsSchema = z
  .object({
    total_commits: z.number().optional().catch(undefined),
    files: z
      .array(
        z
          .object({
            additions: z.number().optional().catch(undefined),
            deletions: z.number().optional().catch(undefined),
          })
          .catch({}),
      )
      .optional()
      .catch(undefined),
  })
  .catch({});

async function deliveredDiffStats(
  gh: Pick<GithubContext, "client" | "repo">,
  base: string,
  head: string,
): Promise<DeliveredDiffStats | null> {
  const res = await gh.client.request(
    "GET",
    `/repos/${gh.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    ghCompareStatsSchema,
    { searchParams: { per_page: "300" } },
  );
  if (!res.ok) return null;
  const files = res.data.files ?? [];
  let add = 0;
  let del = 0;
  for (const f of files) {
    add += f.additions ?? 0;
    del += f.deletions ?? 0;
  }
  return {
    files: files.length,
    add,
    del,
    commits: res.data.total_commits ?? 0,
    // 300 files back means GitHub likely paginated/truncated the file list.
    truncated: files.length >= 300,
  };
}

/** The two PR-body fragments derived from live compare stats: the one-line
 *  change summary and the delivery evidence rows. */
interface DeliveredPrParts {
  changeSummary: string;
  evidence: string[];
}

/** The PR-body change-summary + delivery evidence rows, from live compare stats. */
function deliveredStatsToPrParts(
  stats: DeliveredDiffStats,
  branch: string,
  revisionHeadSha: string | null,
): DeliveredPrParts {
  const fileLabel = stats.truncated ? "300+" : String(stats.files);
  const evidence: string[] = [
    `${fileLabel} file(s) changed on \`${branch}\` · +${stats.add} · −${stats.del}`,
  ];
  if (stats.commits > 0) {
    evidence.push(
      `${stats.commits} commit(s) delivered` +
        (revisionHeadSha ? `, revision ${revisionHeadSha.slice(0, 7)}` : ""),
    );
  }
  return {
    changeSummary: `${fileLabel} file(s) changed (+${stats.add}/-${stats.del}).`,
    evidence,
  };
}

/**
 * Ruling 474: the hash recorded for a PR body Viberr wrote (`pr.bodyWritten`),
 * compared with the body GitHub holds to tell a person's edit from Viberr's
 * own text. Line endings read as LF: GitHub's web editor saves CRLF, so a
 * description opened and saved unchanged is not an edit.
 */
export function prBodySha256(body: string): string {
  return createHash("sha256").update(body.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/**
 * The app origin the PR body links back to (N20-4, §5a): `appOrigin()`
 * (BETTER_AUTH_URL), never a request, since delivery runs off background
 * operator runs. `null` means the link is omitted (a relative link 404s on
 * github.com); logged once at debug so the deployment fix is discoverable.
 */
function prBodyOrigin(input: { projectSlug: string; taskKey: string }): string | null {
  const origin = appOrigin();
  if (!origin) {
    logger.debug(
      "PR body omits the task back-link: no absolute app origin; set BETTER_AUTH_URL",
      { taskKey: input.taskKey, projectSlug: input.projectSlug },
    );
  }
  return origin;
}

/**
 * The review PR body for the task as it stands: the current goal, the
 * delivered revision and the live compare's stats. The create path and ruling
 * 474's rewrite of a reused PR both compose through here, so a rewritten body
 * is exactly the body a freshly opened PR would carry.
 */
function composeTaskPrBody(
  input: { projectSlug: string; taskKey: string },
  file: TaskFileReadResult,
  branch: string,
  origin: string | null,
  liveStats: DeliveredDiffStats | null,
): string {
  const fm = file.parsed.frontmatter;
  // F22-10: prefer the LIVE compare of the base against the freshly-pushed head
  // for the change-summary + evidence. `fm.github.changed`/`commits` are
  // reconciled values that can carry a colliding branch's stats at open time
  // (PR #187 shipped "3 file(s) changed (+214/-16)" over a 1-file diff). Fall
  // back to the frontmatter only when the compare is unreachable.
  const liveParts = liveStats
    ? deliveredStatsToPrParts(liveStats, branch, activeWorkRevision(fm.workRevision)?.headSha ?? null)
    : null;
  return composePrBody({
    taskKey: input.taskKey,
    projectSlug: input.projectSlug,
    title: fm.title,
    goal: file.parsed.goal,
    appOrigin: origin,
    changeSummary:
      liveParts?.changeSummary ??
      (fm.github?.changed
        ? `${fm.github.changed.files} file(s) changed (+${fm.github.changed.add}/-${fm.github.changed.del}).`
        : null),
    // P13-D-26: `composePrBody` has always taken `evidence` and its one caller
    // never passed it, so the "## Evidence" section was unreachable. The task
    // record now carries real evidence rows on outcome events — hand the newest
    // set to the PR body so the governed hand-off (FR31/FR32) actually carries
    // the evidence the PRD promises a GitHub reviewer. F22-10: the live compare
    // wins when available so the numbers match the actual PR diff.
    evidence: liveParts?.evidence ?? latestEvidenceLines(file.parsed.timeline),
  });
}

export interface OpenTaskPrContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
}

export type OpenTaskPrResult =
  | {
      status: "ok";
      prNumber: number;
      /** True when this call CREATED the PR; false when an open PR was reused. */
      created: boolean;
      url: string;
    }
  | GithubContextFailure
  | { status: "task_not_found" }
  | { status: "no_branch" }
  /** R16-1: an OPEN pull request already occupies this head branch and it is not
   *  this task's (see `decidePrAdoption`). GitHub cannot hold two PRs for one
   *  head, so no PR was opened — the remote branch has to be resolved first. */
  | {
      status: "branch_collision";
      prNumber: number;
      branch: string;
      message: string;
    }
  | { status: "scope_violation"; scope: string; violationId: string }
  /** Ruling 160 (pass 35, F35-11): the task's pull request was closed WITHOUT
   *  merging by a person, and no person has answered the recovery packet yet.
   *  Nothing was opened. `closedBy` is the GitHub login GitHub named as the
   *  closer, null when it named none. */
  | { status: "closed_by_human"; prNumber: number; closedBy: string | null }
  | { status: "auth_failed"; message: string }
  /** GitHub said "No commits between <base> and <head>" — the branch has no
   *  commits ahead of base, so there is nothing to review. An honest "nothing to
   *  review", NOT a network failure (which is how it used to be mislabeled).
   *  ONLY that refusal: the other 422s on POST /pulls mean different things and
   *  must not arrive here — a task whose PR already exists has not "produced no
   *  change", and the delivery path acts on this by flagging the task `noChanges`. */
  | { status: "nothing_to_review"; message: string }
  /** Ruling 128: GitHub refused the PR because the BASE branch does not exist
   *  (422 `field: base, code: invalid`). The repository has no default branch
   *  to open the pull request against; never a network failure. */
  | { status: "base_branch_missing"; base: string; message: string }
  /** Ruling 128: GitHub ANSWERED and refused, for a reason this reader does
   *  not map (any other 422, a decode failure, an unmapped HTTP status). The
   *  message quotes GitHub; it was not the network. */
  | { status: "refused"; message: string }
  | { status: "network_unavailable"; message: string };

/**
 * The slice of a pulls payload this module reads — list item, detail and
 * create response alike. The identity fields are on every PR payload GitHub
 * sends; the merge facts (absent on list items) and the head sha carry the
 * tolerance their optional-chained readers already had, parsing to `undefined`
 * on drift rather than voiding the response. `title` is recoverable (an empty
 * label costs nothing else), so it degrades instead of voiding; `number`,
 * `html_url` and `state` stay strict — a PR record with a guessed number or an
 * assumed state is worse than a typed refusal, and the create path salvages a
 * refused response through {@link ghCreatedPrSalvageSchema} rather than losing
 * the PR entirely.
 */
const ghPullSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  title: z.string().catch(""),
  state: z.string(),
  /** Merge facts from GET /pulls/{n} (absent on list items). */
  merged: z.boolean().optional().catch(undefined),
  merged_at: z.string().nullable().optional().catch(undefined),
  /** Present on both the list item and the detail — the adoption rule's subject. */
  head: z
    .object({ sha: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  /** Ruling 474: the description as GitHub holds it now (null when empty), on
   *  the list item and the detail alike. Absent only on drift, which leaves a
   *  recorded body unverifiable rather than assumed unedited. */
  body: z.string().nullable().optional().catch(undefined),
});
type GhPull = z.output<typeof ghPullSchema>;

/**
 * F21-9 — what is still worth keeping from a CREATE response that did not
 * decode.
 *
 * `POST /pulls` is a write: by the time the body is read the pull request
 * EXISTS on GitHub. Losing the response therefore loses the task's only record
 * of a PR that is out there collecting reviews — the orphan window this
 * salvage closes. Only the number is required (it is the PR's identity and the
 * thing every later reconcile keys on); the rest degrades, and the task keeps a
 * minimal but true `pr` record instead of nothing. `state` defaults to "open"
 * because that is what a just-created pull request IS — not a guess about a
 * value GitHub sent.
 */
const ghCreatedPrSalvageSchema = z.object({
  number: z.number(),
  html_url: z.string().catch(""),
  title: z.string().catch(""),
  state: z.string().catch("open"),
});

/**
 * A 422's `errors[]` rows — where GitHub actually says WHICH validation failed.
 * The envelope's `message` is the constant "Validation Failed", so a reader that
 * sniffs only that text can tell no two 422s apart. Tolerant end to end (every
 * level catches to an empty result): this decodes a FAILURE body purely to
 * explain and classify it, and drift there must cost the explanation, nothing
 * more — so `parse` on any input at all yields rows, never a throw.
 */
const ghValidationBodySchema = z
  .object({
    errors: z
      .array(
        z.object({
          message: z.string().catch(""),
          // Ruling 128: GitHub's structured refusal row. A missing base branch
          // answers `{resource: "PullRequest", field: "base", code: "invalid"}`
          // with NO message, which is why the prose sniff below could never
          // name it and the residual called it a network failure.
          resource: z.string().optional().catch(undefined),
          field: z.string().optional().catch(undefined),
          code: z.string().optional().catch(undefined),
        }),
      )
      .catch([]),
  })
  .catch({ errors: [] });

/**
 * Open (or reuse) the review pull request for a task's execution branch
 * (FR31). Idempotent twice over (NFR16): a live PR already cached on the task
 * (e.g. agent-side delivery on its own branch) is reconciled and reused, and
 * an open PR for the deterministic `head` branch is adopted — a duplicate is
 * never created. Writes `frontmatter.pr` in the canonical cache vocabulary
 * (open → "review"; a human-set "accepted" is never downgraded), appends a
 * `github` timeline event on creation, and audits. A 403 opens a
 * `pull_request:write` scope violation carried by the task (NFR14) instead of
 * throwing. Never fabricates a PR: on any non-ok GitHub result the task's `pr`
 * cache is left untouched.
 */
export async function openTaskPr(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor & { userId?: string; operatorAuthorized?: boolean },
  ctx: OpenTaskPrContext = {},
): Promise<OpenTaskPrResult> {
  const ref = {
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    dataRoot: ctx.dataRoot,
  };
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found" };
  let fm = file.parsed.frontmatter;

  // P13-D-5: task-level repo override deleted (owner ruling) — project repo only.
  // Optional key: only a test hands over a transport.
  const ghOptions: GithubContextOptions = {};
  if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
  const gh = getProjectGithubContext(db, input.projectSlug, ghOptions);
  if (gh.status !== "ok") return gh;

  // 0. The task already carries a PR. Three cases, by what the cache says
  //    and what GitHub says now:
  //    · MERGED (cached, or discovered live): DG-1. Reworking a branch whose PR
  //      already merged must open a new review PR, never resurrect the merged
  //      one (which would dead-end acceptance at "merge pending" forever).
  //    · CLOSED WITHOUT MERGING: ruling 160 (pass 35, F35-11). A person closed
  //      the pull request, and that is a decision about the task. No new PR is
  //      opened for the branch until a person has answered the closed-PR
  //      recovery packet (`pr.closure.answered`); until then delivery answers
  //      `closed_by_human`. A cached closure that was never surfaced (the
  //      cache still says review while GitHub says closed) is handed to the
  //      reconciler, the ONE writer of `pr.state: closed` and of the R8-6
  //      event, notification and operator wake, so the packet appears in the
  //      same turn. Live (KNC-23) this door used to "fall through to a fresh
  //      PR" and overwrite the cache with #26 before any reconcile saw #10
  //      close: the owner's rejection vanished from every surface.
  //    · LIVE: reuse it, never open a duplicate (a PR captured from agent-side
  //      delivery on a branch the head= dedup below would never match).
  //
  //    A cached `closed` with NO closure record is a close nobody surfaced.
  //    `pr.state: closed` has a second writer: the workspace reconcile reads
  //    `gh pr view <branch>` from the agent's clone and writes the state it
  //    sees, knowing nothing of who closed it, and `performDelivery` runs that
  //    reconcile one step BEFORE this door. Refusing straight off such a cache
  //    would be a wedge: the R8-6 note, the inbox alert and the `pr-diverged`
  //    wake that raises the recovery packet all key on the closure being
  //    unrecorded, and `resolvePacket` has no record to stamp, so the refusal
  //    would stand with nothing able to lift it. So the closure is repaired
  //    first, through the one writer that owns it, and the refusal is read off
  //    what that pass recorded (including a PR reopened in the meantime, which
  //    lifts the block entirely).
  if (fm.pr?.state === "closed" && !fm.pr.closure) {
    const { reconcileTask } = await import("./github-reconciler.server");
    const repairCtx: GithubActionContext = {};
    if (ctx.dataRoot) repairCtx.dataRoot = ctx.dataRoot;
    if (ctx.fetchImpl) repairCtx.fetchImpl = ctx.fetchImpl;
    await reconcileTask(db, input, actor, repairCtx);
    fm = readTaskFile(ref)?.parsed.frontmatter ?? fm;
  }
  if (fm.pr?.state === "closed" && !fm.pr.closure?.answered) {
    return {
      status: "closed_by_human",
      prNumber: fm.pr.number,
      closedBy: fm.pr.closure?.by ?? null,
    };
  }
  const cachedPrIsTerminal =
    fm.pr?.state === "closed" || fm.pr?.state === "merged";
  if (fm.pr && !cachedPrIsTerminal) {
    const live = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/pulls/${fm.pr.number}`,
      ghPullSchema,
    );
    if (live.ok) {
      const liveIsOpen =
        live.data.state === "open" && live.data.merged !== true;
      if (liveIsOpen) {
        await writePrToTask(db, ref, input, gh, live.data, actor, false, ctx, fm.pr);
        await refreshReusedPrBody(db, ref, input, gh, live.data, actor, ctx);
        return {
          status: "ok",
          prNumber: live.data.number,
          created: false,
          url: live.data.html_url,
        };
      }
      const liveClosedUnmerged =
        live.data.state === "closed" && mapPrToCacheState(live.data) === "closed";
      if (liveClosedUnmerged) {
        // Ruling 160: the transition is the reconciler's to record. It reads
        // the cached number directly when the branch listing no longer names
        // it (the push that preceded this call moved the branch), writes the
        // closure with the closer's login, posts the divergence note, notifies
        // the task's watchers and wakes the operator for the recovery packet.
        // A pass that could not land the state leaves the cache as it was:
        // this door refuses on GitHub's live answer either way, and the next
        // pass records the transition.
        const { reconcileTask } = await import("./github-reconciler.server");
        const reconcileCtx: GithubActionContext = {};
        if (ctx.dataRoot) reconcileCtx.dataRoot = ctx.dataRoot;
        if (ctx.fetchImpl) reconcileCtx.fetchImpl = ctx.fetchImpl;
        await reconcileTask(db, input, actor, reconcileCtx);
        const after = readTaskFile(ref)?.parsed.frontmatter.pr ?? null;
        return {
          status: "closed_by_human",
          prNumber: live.data.number,
          closedBy:
            after && after.number === live.data.number ? (after.closure?.by ?? null) : null,
        };
      }
      // Merged on GitHub → fall through to the create path below (DG-1). The
      // merged PR is not reconciled into the cache here (that would record a
      // misleading `github.pr.opened` audit); the create path overwrites it
      // with the fresh PR on success and the poller keeps the cache honest.
    } else if (live.kind === "network") {
      return { status: "network_unavailable", message: live.message };
    } else if (live.kind === "http" && live.status === 401) {
      return { status: "auth_failed", message: live.message };
    }
    // Any other refusal (404 gone, 403 read scope): the cached PR can't be
    // confirmed — fall through to the normal head-dedup + create path.
  }

  const branch = fm.branch ?? taskBranchName(input.taskKey);
  if (!branch) return { status: "no_branch" };

  const owner = gh.repo.split("/")[0] ?? "";

  /**
   * 1. Idempotency: what already occupies this head branch? `null` — and only
   *    `null` — clears the way for the create below, because "another PR is on
   *    this head" and "we could not find out" both forbid a second attempt.
   *
   *    Reuse is ADOPTION (R16-1): the branch name alone proved it can bind a
   *    foreign PR to a task that delivered nothing (H8), so the head sha must be
   *    the delivered revision. A name-matched PR that fails the rule is a branch
   *    COLLISION: creating a second PR for the same head is impossible on GitHub
   *    anyway (422), so delivery stops here and says why.
   *
   *    A function rather than a straight-line step because the 422 arm below
   *    asks the same question again — GitHub itself says a PR exists there, and
   *    the answer has to name which one. (An arrow const, not a declaration: a
   *    hoisted `function` would forfeit `gh`'s narrowing to the ok-context.)
   */
  const prAlreadyOnHead = async (): Promise<OpenTaskPrResult | null> => {
    const existing = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/pulls`,
      z.array(ghPullSchema),
      { searchParams: { head: `${owner}:${branch}`, state: "open", per_page: 1 } },
    );
    if (existing.ok) {
      const pr = existing.data[0];
      if (!pr) return null;
      const adoption =
        fm.pr?.number === pr.number
          ? { adopt: true as const }
          : decidePrAdoption({
              state: mapPrToCacheState(pr),
              prHeadSha: pr.head?.sha ?? null,
              revisionHeadSha: activeWorkRevision(fm.workRevision)?.headSha ?? null,
            });
      if (!adoption.adopt) {
        return {
          status: "branch_collision",
          prNumber: pr.number,
          branch,
          message: prAdoptionRefusalNote({
            refusal: adoption.refusal,
            taskKey: input.taskKey,
            branch,
            prNumber: pr.number,
            revisionHeadSha: activeWorkRevision(fm.workRevision)?.headSha ?? null,
          }),
        };
      }
      await writePrToTask(db, ref, input, gh, pr, actor, false, ctx, fm.pr);
      // F34-9: a reuse of a DIFFERENT number is an adoption, recorded on its
      // own (the "Opened PR" event and audit are gated on `created`).
      if (fm.pr?.number !== pr.number) {
        await recordPrAdoption(
          db,
          ref,
          {
            repo: gh.repo,
            branch,
            prNumber: pr.number,
            previousPrNumber: fm.pr?.number ?? null,
            previousState: fm.pr?.state ?? null,
            headSha: pr.head?.sha ?? null,
            source: "delivery",
          },
          actor,
        );
      }
      await refreshReusedPrBody(db, ref, input, gh, pr, actor, ctx);
      return { status: "ok", prNumber: pr.number, created: false, url: pr.html_url };
    }
    if (existing.kind === "network") {
      return { status: "network_unavailable", message: existing.message };
    }
    // F21-9 (residual): a 2xx whose body this reader refused says NOTHING about
    // what is on the head — and "I could not tell" is not "the head is free".
    // Falling through turned an unreadable answer into a create attempt against
    // a head that may already carry a PR: GitHub answers that with a 422 the
    // delivery path used to record as "this branch produced no change".
    if (existing.kind === "decode") {
      return { status: "network_unavailable", message: existing.message };
    }
    if (existing.kind === "http" && existing.status === 401) {
      return { status: "auth_failed", message: existing.message };
    }
    // A 403/404 on the LIST is not proof either way (fine-grained tokens mask
    // both), and the create below fails honestly on its own terms — including
    // opening the scope violation a 403 there earns.
    return null;
  };

  const occupied = await prAlreadyOnHead();
  if (occupied) return occupied;

  // 2. Create the PR, from the file as it stands now (a closed-PR repair above
  // may have rewritten it).
  const bodyFile = readTaskFile(ref) ?? file;
  const body = composeTaskPrBody(
    input,
    bodyFile,
    branch,
    prBodyOrigin(input),
    await deliveredDiffStats(gh, gh.defaultBranch, branch),
  );
  // Ruling 474: what this body is, recorded with the PR so a later delivery
  // can tell whether it still describes the head and whether a person has
  // edited it since.
  const bodyWritten = (prHeadSha: string | undefined): PrBodyWritten => ({
    sha256: prBodySha256(body),
    revision: bodyRevisionOf(bodyFile.parsed.frontmatter, prHeadSha),
  });
  const created = await gh.client.request(
    "POST",
    `/repos/${gh.repo}/pulls`,
    ghPullSchema,
    {
      body: {
        title: `[${input.taskKey}] ${fm.title}`,
        head: branch,
        base: gh.defaultBranch,
        body,
      },
    },
  );

  if (created.ok) {
    await writePrToTask(
      db,
      ref,
      input,
      gh,
      created.data,
      actor,
      true,
      ctx,
      fm.pr,
      bodyWritten(created.data.head?.sha),
    );
    // F27-U2: a fresh PR just opened — a real, solicited write that PROVES
    // `pull_request:write`, so its cached scope stops reading "unproven
    // (verified on first use)" after the first actual use. F28-U2b: prove it on
    // the credential that MADE the call (`gh.patId`), not whatever is bound now.
    markWriteScopeProven(db, gh.patId, gh.repo, "pull_request");
    return {
      status: "ok",
      prNumber: created.data.number,
      created: true,
      url: created.data.html_url,
    };
  }
  // F21-9: GitHub CREATED the pull request and then sent a body this reader
  // could not decode. The write already happened, so returning a failure here
  // and recording nothing left a real PR with no task record — the next
  // delivery would try to open a second one for the same head (422) and the
  // human would see a task claiming no PR exists. Salvage the identity and
  // record the minimal true fact instead.
  if (created.kind === "decode") {
    const salvaged = ghCreatedPrSalvageSchema.safeParse(created.data);
    if (!salvaged.success) {
      logger.error("PR created on GitHub but its response was unreadable", {
        taskKey: input.taskKey,
        projectSlug: input.projectSlug,
        repo: gh.repo,
        branch,
        reason: created.message,
      });
      return { status: "network_unavailable", message: created.message };
    }
    const pr = salvaged.data;
    const url =
      pr.html_url || `${githubWebHost()}/${gh.repo}/pull/${pr.number}`;
    logger.warn("PR created on GitHub with a partly unreadable response", {
      taskKey: input.taskKey,
      projectSlug: input.projectSlug,
      repo: gh.repo,
      prNumber: pr.number,
      reason: created.message,
    });
    await writePrToTask(
      db,
      ref,
      input,
      gh,
      { number: pr.number, html_url: url, title: pr.title, state: pr.state },
      actor,
      true,
      ctx,
      fm.pr,
      bodyWritten(undefined),
    );
    // F28-U2a: GitHub still CREATED the PR (2xx) — a real write proves the
    // scope here too, not only on the cleanly-decoded success path above.
    markWriteScopeProven(db, gh.patId, gh.repo, "pull_request");
    return { status: "ok", prNumber: pr.number, created: true, url };
  }
  if (created.kind === "network") {
    return { status: "network_unavailable", message: created.message };
  }
  if (created.kind === "http" && created.status === 401) {
    return { status: "auth_failed", message: created.message };
  }
  if (created.kind === "http" && created.status === 403) {
    const flagInput: FlagScopeViolationInput = {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      scope: "pull_request:write",
      detail: policyViolationText(
        "pull_request:write",
        "opening the review pull request",
      ),
    };
    // Optional key — with no actor the violation records the system as the one
    // that found it.
    if (actor) flagInput.actor = actor;
    const { violation } = await flagScopeViolation(db, flagInput, {
      dataRoot: ctx.dataRoot,
    });
    return {
      status: "scope_violation",
      scope: "pull_request:write",
      violationId: violation.id,
    };
  }
  // GitHub answers 422 to SEVERAL different refusals on POST /pulls, and they
  // are not interchangeable:
  //  · "No commits between <base> and <head>" — the branch carries no diff, so
  //    there is nothing to review. An honest empty-diff state, not a network
  //    failure, and the delivery path turns it into a no-change completion.
  //  · "A pull request already exists for <owner>:<head>" — the OPPOSITE claim:
  //    a review PR is out there right now. Reading it as the empty-diff case
  //    flagged a task that HAS a live PR as having produced no change, and
  //    marked it `noChanges` on the way. Ask the head who won instead.
  //  · anything else — an unmapped validation refusal, which stays with the
  //    residual below rather than borrowing either meaning.
  if (created.kind === "http" && created.status === 422) {
    // GitHub's refusal in one line: the envelope message plus the specific
    // reasons under it. Both halves matter — the distinguishing sentence rides
    // in either place depending on the endpoint and the error.
    const rows = ghValidationBodySchema.parse(created.data).errors;
    const reasons = rows.map((e) => e.message).filter((reason) => reason.trim() !== "");
    const detail =
      reasons.length > 0
        ? `${created.message}: ${reasons.join("; ")}`
        : created.message;
    if (/no commits between/i.test(detail)) {
      return { status: "nothing_to_review", message: detail };
    }
    if (/already exists/i.test(detail)) {
      // The probe above found the head free, so a PR landed on it between the
      // two calls (or the list read could not see it). Re-read the head: the
      // same adoption rule decides whether that PR is this task's to reuse or a
      // collision to report, and the answer names its number instead of
      // guessing one.
      const raced = await prAlreadyOnHead();
      if (raced) return raced;
    }
    // Ruling 128 (F34-4): the base branch does not exist. GitHub sends the
    // structured row with no message, so only the fields can say it.
    if (rows.some((row) => row.field === "base" && row.code === "invalid")) {
      return {
        status: "base_branch_missing",
        base: gh.defaultBranch,
        message: `GitHub refused the pull request: its base branch \`${gh.defaultBranch}\` does not exist (422 base invalid).`,
      };
    }
    return { status: "refused", message: detail };
  }
  // Ruling 128: GitHub answered. An unmapped status or a body this reader
  // could not decode is a REFUSAL that quotes GitHub, never "unreachable".
  return {
    status: "refused",
    message: created.kind === "http" ? created.message : "GitHub answered 304 (not modified) to a create",
  };
}

async function writePrToTask(
  db: DatabaseSync,
  ref: TaskFileRef,
  input: { projectSlug: string; taskKey: string },
  gh: { repo: string },
  pr: GhPull,
  actor: AuditActor & { userId?: string; operatorAuthorized?: boolean },
  created: boolean,
  ctx: OpenTaskPrContext,
  existingPr: PrRef | null,
  /** Ruling 474: the body this call just sent, on a create. A reuse passes
   *  nothing and the SAME number keeps its record through the spread below. */
  bodyWritten: PrBodyWritten | null = null,
): Promise<void> {
  // Canonical cache vocabulary: an open PR is "review" — never the raw
  // GitHub "open" (off-contract, and it would ping-pong against reconcilers).
  const live = mapPrToCacheState(pr);
  const samePr = existingPr !== null && existingPr.number === pr.number;
  // H1 guard: never downgrade a human-set "accepted" (merge pending) — or an
  // already terminal "merged" — while GitHub still reports the PR open. Only
  // a real terminal state from GitHub overrides.
  const state =
    samePr &&
    live === "review" &&
    (existingPr.state === "accepted" || existingPr.state === "merged")
      ? existingPr.state
      : live;
  // Preserve the reconciler-owned facts (`checks`, `review` — P13-D-28) when
  // refreshing the SAME PR: this path never reads them, so rebuilding the ref
  // from scratch would blank both pills until the next 5-minute poll. A
  // DIFFERENT (freshly opened) PR correctly starts with neither.
  const fresh: PrRef = { number: pr.number, state, title: pr.title };
  // Ruling 135: the PR head as GitHub reported it on THIS read. Carried across
  // a reuse of the SAME number by the spread below; a different PR never
  // inherits the old head (the salvage path passes no `head` at all).
  if (pr.head?.sha) fresh.headSha = pr.head.sha;
  if (bodyWritten) fresh.bodyWritten = bodyWritten;
  const next: PrRef = samePr ? { ...existingPr, ...fresh } : fresh;
  // A recorded unpushed revision that the live head now carries is satisfied.
  if (next.headSha && next.unpushedRevision?.revisionSha === next.headSha) {
    delete next.unpushedRevision;
  }
  const changed = JSON.stringify(existingPr) !== JSON.stringify(next);
  if (changed) {
    await patchTaskFrontmatter(ref, { pr: next });
  }
  if (created) {
    // Authorship of the "Opened PR" event: an operator-authorized delivery is
    // the OPERATOR, not a human — its TaskActor carries the sentinel user id
    // "operator", which is not a users-table row, so rendering it as a human
    // produced a bogus "no longer a member" guest pill (F17-1). A genuine human
    // delivery (manual button / applied recommendation) still renders as that
    // human; the agentless fallback keeps its historical "Implementation" render.
    const humanUserId =
      !actor.operatorAuthorized && actor.userId ? actor.userId : null;
    // SAFETY: `users.name` is TEXT NOT NULL (0001_baseline.sql), so the single
    // selected column is a string on any row that exists; `get` returns
    // undefined when the id matches none.
    const nameHint = humanUserId
      ? ((db.prepare(`SELECT name FROM users WHERE id = ?`).get(humanUserId) as
          | { name: string }
          | undefined)?.name ?? null)
      : null;
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: actor.operatorAuthorized
        ? { kind: "operator" }
        : humanUserId
          ? { kind: "human", userId: humanUserId, nameHint }
          : {
              kind: "agent",
              backend: "claude",
              // Synthetic fallback author (no engaged profile in scope here) -
              // renders as "Implementation" exactly as before.
              profileId: "implementation",
              roleHint: "Implementation",
            },
      title: null,
      text: `Opened **PR #${pr.number}** for review.`,
      toAgent: false,
      evidence: null,
    });
  }
  if (changed || created) {
    rebuildPath(db, resolveTaskFilePath(ref), {
      dataRoot: ctx.dataRoot,
    });
  }
  // B-GH4: the audit row records the PR being OPENED — a reuse pass that merely
  // re-confirmed an existing PR must not append another "opened" row per visit.
  if (created) {
    recordAudit(db, {
      action: "github.pr.opened",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${pr.number}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { repo: gh.repo, prNumber: pr.number, created },
    });
  }
}

/** Ruling 474: the revision a PR body describes — the delivered revision its
 *  Evidence line names, else the PR head as GitHub reported it. */
function bodyRevisionOf(
  fm: TaskFrontmatter,
  prHeadSha: string | null | undefined,
): string | null {
  return activeWorkRevision(fm.workRevision)?.headSha ?? prHeadSha ?? null;
}

/** A revision as the timeline names it. */
function revisionPhrase(sha: string | null, unknown: string): string {
  return sha ? `revision \`${sha.slice(0, 7)}\`` : unknown;
}

/** What a body refresh moves from and to: the audit row's details. */
interface PrBodyChange {
  prNumber: number;
  fromRevision: string | null;
  toRevision: string | null;
}

/** The delivery's own note on the task timeline (the author every other
 *  delivery-surfaced event carries). */
function deliveryNote(text: string): TaskFileEvent {
  return {
    occurredAt: new Date().toISOString(),
    type: "github",
    actor: { kind: "system", systemId: "delivery" },
    title: null,
    text,
    toAgent: false,
    evidence: null,
  };
}

/**
 * Ruling 474 (pass 40, F40-19): a reused review PR's body follows the delivery
 * it describes. The body used to be composed on the create path only, so a
 * rework pushed to the same PR left it describing the FIRST delivery: live on
 * akin-ozer/website PR #2 the Evidence said "3 commit(s) delivered, revision
 * 7cf1edc" over a head at cc9aa30 carrying 5 commits.
 *
 * Runs after `writePrToTask` on both reuse arms. When the revision the body was
 * written for (`pr.bodyWritten.revision`) is not the one delivered now, the body
 * is recomposed from the current task through `composeTaskPrBody` (the create
 * path's inputs) and sent as ONE `PATCH`, never retried on a 5xx. First the body
 * GitHub holds is hashed against the one Viberr last wrote: a mismatch is a
 * person's edit, which is kept, with one timeline note per revision saying so
 * and what changed. A body Viberr never recorded (a PR opened before this
 * ruling, or one it adopted) counts as Viberr's. A failed `PATCH` is a timeline
 * note and a `github.pr.body_update_failed` row, never a failed delivery; nor is
 * anything else here, so a throw is logged and the reuse stands.
 */
async function refreshReusedPrBody(
  db: DatabaseSync,
  ref: TaskFileRef,
  input: { projectSlug: string; taskKey: string },
  gh: GithubContext,
  pr: GhPull,
  actor: AuditActor,
  ctx: OpenTaskPrContext,
): Promise<void> {
  try {
    const file = readTaskFile(ref);
    const cached = file?.parsed.frontmatter.pr;
    // `writePrToTask` just recorded this number; any other is not this
    // delivery's PR to describe.
    if (!file || cached?.number !== pr.number) return;
    const fm = file.parsed.frontmatter;
    const branch = fm.branch ?? taskBranchName(input.taskKey);
    if (!branch) return;
    const written = cached.bodyWritten ?? null;
    const toRevision = bodyRevisionOf(fm, pr.head?.sha);
    // The body already describes what is delivered.
    if (written && written.revision === toRevision) return;
    const change: PrBodyChange = {
      prNumber: pr.number,
      fromRevision: written?.revision ?? null,
      toRevision,
    };
    if (written) {
      if (pr.body === undefined) {
        await recordPrBodyUpdateFailed(
          db,
          ref,
          input,
          gh,
          change,
          "GitHub's answer did not include the current description, so a person's edit could not be ruled out",
          actor,
          ctx,
        );
        return;
      }
      if (prBodySha256(pr.body ?? "") !== written.sha256) {
        if (written.keptRevision !== toRevision) {
          await recordPrBodyKept(
            db,
            ref,
            change,
            await deliveredDiffStats(gh, gh.defaultBranch, branch),
            ctx,
          );
        }
        return;
      }
    }
    const body = composeTaskPrBody(
      input,
      file,
      branch,
      prBodyOrigin(input),
      await deliveredDiffStats(gh, gh.defaultBranch, branch),
    );
    const patched = await gh.client.request(
      "PATCH",
      `/repos/${gh.repo}/pulls/${pr.number}`,
      z.unknown(),
      { body: { body }, retryServerError: false },
    );
    if (!patched.ok) {
      const reason =
        patched.kind === "network"
          ? `GitHub could not be reached (${patched.message})`
          : patched.kind === "http"
            ? `GitHub answered ${patched.status} (${patched.message})`
            : githubFailureMessage(patched);
      await recordPrBodyUpdateFailed(db, ref, input, gh, change, reason, actor, ctx);
      return;
    }
    await updateTaskFile(ref, (parsed) => {
      const current = parsed.frontmatter.pr;
      if (current?.number === pr.number) {
        current.bodyWritten = { sha256: prBodySha256(body), revision: toRevision };
      }
    });
    rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
    recordAudit(db, {
      action: "github.pr.body_updated",
      actor,
      subjectKind: "pull_request",
      subjectId: `${gh.repo}#${pr.number}`,
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      details: { ...change },
    });
  } catch (error) {
    logger.warn("review PR body refresh failed; the delivery stands", {
      taskKey: input.taskKey,
      projectSlug: input.projectSlug,
      prNumber: pr.number,
      err: toError(error),
    });
  }
}

/** Ruling 474: a person edited the body on GitHub, so it stays as written. One
 *  note per delivered revision (`keptRevision`), naming what it no longer says. */
async function recordPrBodyKept(
  db: DatabaseSync,
  ref: TaskFileRef,
  change: PrBodyChange,
  stats: DeliveredDiffStats | null,
  ctx: OpenTaskPrContext,
): Promise<void> {
  const delivered = stats
    ? ` (${stats.commits} commit(s), ${stats.truncated ? "300+" : stats.files} file(s) changed, +${stats.add}/−${stats.del})`
    : "";
  const text =
    `The description of **PR #${change.prNumber}** was edited on GitHub, so Viberr left it as the person wrote it. ` +
    `It was written for ${revisionPhrase(change.fromRevision, "an earlier revision")}; the PR now carries ` +
    `${revisionPhrase(change.toRevision, "a later one")}${delivered}.`;
  await updateTaskFile(ref, (parsed) => {
    parsed.timeline.unshift(deliveryNote(text));
    const current = parsed.frontmatter.pr;
    if (current?.number === change.prNumber && current.bodyWritten) {
      current.bodyWritten.keptRevision = change.toRevision;
    }
  });
  rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
}

/** Ruling 474: the body could not be brought up to date. The delivery stands;
 *  the timeline says which revision the body still describes, and why. */
async function recordPrBodyUpdateFailed(
  db: DatabaseSync,
  ref: TaskFileRef,
  input: { projectSlug: string; taskKey: string },
  gh: { repo: string },
  change: PrBodyChange,
  reason: string,
  actor: AuditActor,
  ctx: OpenTaskPrContext,
): Promise<void> {
  await appendTimelineEvent(
    ref,
    deliveryNote(
      `The description of **PR #${change.prNumber}** still describes ` +
        `${revisionPhrase(change.fromRevision, "an earlier revision")}; updating it to ` +
        `${revisionPhrase(change.toRevision, "this delivery")} failed: ${reason}. ` +
        `The delivery itself went through, and the next delivery tries the description again.`,
    ),
  );
  rebuildPath(db, resolveTaskFilePath(ref), { dataRoot: ctx.dataRoot });
  recordAudit(db, {
    action: "github.pr.body_update_failed",
    actor,
    subjectKind: "pull_request",
    subjectId: `${gh.repo}#${change.prNumber}`,
    projectSlug: input.projectSlug,
    taskKey: input.taskKey,
    details: { ...change, reason },
  });
}
