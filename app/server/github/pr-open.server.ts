import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  EVIDENCE_EMPTY_COLUMN,
  type PrRef,
  type TaskFileEvent,
} from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { appOrigin } from "~/server/config/env.server";
import { logger } from "~/server/logging/logger.server";
import { taskBranchName } from "./branch-sync.server";
import { githubWebHost } from "./github-client.server";
import {
  getProjectGithubContext,
  type GithubContext,
  type GithubContextFailure,
  type GithubContextOptions,
} from "./github-context.server";
import { decidePrAdoption, prAdoptionRefusalNote } from "./pr-adoption.server";
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

/**
 * P13-D-26 — the newest event's `evidence:` rows, as PR-body bullet lines
 * (`<label> · <add> · <del>`, empty columns dropped). Newest-first timeline, so
 * the first event carrying evidence is the latest outcome. Returns null when
 * the task has none, which keeps the "## Evidence" section out of the body.
 * Pure + exported so the formatting is unit-tested.
 */
export function latestEvidenceLines(
  timeline: readonly TaskFileEvent[],
): string[] | null {
  const withEvidence = timeline.find((e) => e.evidence && e.evidence.length > 0);
  if (!withEvidence?.evidence) return null;
  return withEvidence.evidence.map((row) =>
    [row.label, row.add, row.del]
      .filter((part) => part.trim() !== "" && part.trim() !== EVIDENCE_EMPTY_COLUMN)
      .join(" · "),
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
export interface DeliveredDiffStats {
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

export async function deliveredDiffStats(
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

/** The PR-body change-summary + delivery evidence rows, from live compare stats. */
export function deliveredStatsToPrParts(
  stats: DeliveredDiffStats,
  branch: string,
  revisionHeadSha: string | null,
): { changeSummary: string; evidence: string[] } {
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

export interface OpenTaskPrContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  /**
   * N20-4 (§5a): optional app-origin OVERRIDE. Production never sets it (the
   * delivery path has no request to derive one from), so the origin comes from
   * `appOrigin()` — this exists only so a test can inject one without touching
   * the process env cache.
   */
  appOrigin?: string;
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
  | { status: "auth_failed"; message: string }
  /** GitHub said "No commits between <base> and <head>" — the branch has no
   *  commits ahead of base, so there is nothing to review. An honest "nothing to
   *  review", NOT a network failure (which is how it used to be mislabeled).
   *  ONLY that refusal: the other 422s on POST /pulls mean different things and
   *  must not arrive here — a task whose PR already exists has not "produced no
   *  change", and the delivery path acts on this by flagging the task `noChanges`. */
  | { status: "nothing_to_review"; message: string }
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
    errors: z.array(z.object({ message: z.string().catch("") })).catch([]),
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
  const fm = file.parsed.frontmatter;

  // P13-D-5: task-level repo override deleted (owner ruling) — project repo only.
  // Optional key: only a test hands over a transport.
  const ghOptions: GithubContextOptions = {};
  if (ctx.fetchImpl) ghOptions.fetchImpl = ctx.fetchImpl;
  const gh = getProjectGithubContext(db, input.projectSlug, ghOptions);
  if (gh.status !== "ok") return gh;

  // 0. The task already carries a live PR — e.g. captured from agent-side
  //    delivery on a branch the head= dedup below would never match. Never
  //    open a duplicate: reconcile the cached record against the real PR and
  //    reuse it. A TERMINAL cached PR (closed unmerged OR already merged) clears
  //    the way for a fresh one — reworking a branch whose PR already merged must
  //    open a new review PR, not resurrect the merged one (which would dead-end
  //    acceptance at "merge pending" forever).
  const cachedPrIsTerminal =
    fm.pr?.state === "closed" || fm.pr?.state === "merged";
  if (fm.pr && !cachedPrIsTerminal) {
    const live = await gh.client.request(
      "GET",
      `/repos/${gh.repo}/pulls/${fm.pr.number}`,
      ghPullSchema,
    );
    if (live.ok) {
      // Even a cached "review"/"accepted" PR may have been merged or closed
      // out-of-band on GitHub since we last reconciled. Reuse ONLY a PR that is
      // still genuinely open; otherwise fall through to open a FRESH PR so a
      // reworked branch is never stapled to a dead (merged/closed) PR (DG-1). We
      // do NOT reconcile the terminal PR into the cache here — that would record
      // a misleading `github.pr.opened` audit for a PR being discarded; the
      // reconcile poller keeps the cache honest, and the create path below
      // overwrites it with the fresh PR on success.
      const liveIsOpen =
        live.data.state === "open" && live.data.merged !== true;
      if (liveIsOpen) {
        await writePrToTask(db, ref, input, gh, live.data, actor, false, ctx, fm.pr);
        return {
          status: "ok",
          prNumber: live.data.number,
          created: false,
          url: live.data.html_url,
        };
      }
      // terminal on GitHub → fall through to the create path below.
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
              revisionHeadSha: fm.workRevision?.headSha ?? null,
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
            revisionHeadSha: fm.workRevision?.headSha ?? null,
          }),
        };
      }
      await writePrToTask(db, ref, input, gh, pr, actor, false, ctx, fm.pr);
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

  // 2. Create the PR.
  // N20-4 (§5a): the back-link origin comes from `appOrigin()` (BETTER_AUTH_URL),
  // never from a request — delivery runs off background operator runs. `null`
  // means the link is omitted (a relative link 404s on github.com); log it once
  // at debug so the deployment fix (set BETTER_AUTH_URL) is discoverable.
  const origin = ctx.appOrigin ?? appOrigin();
  if (!origin) {
    logger.debug(
      "PR body omits the task back-link — no absolute app origin; set BETTER_AUTH_URL",
      { taskKey: input.taskKey, projectSlug: input.projectSlug },
    );
  }
  // F22-10: prefer the LIVE compare of the base against the freshly-pushed head
  // for the change-summary + evidence. `fm.github.changed`/`commits` are
  // reconciled values that can carry a colliding branch's stats at open time
  // (PR #187 shipped "3 file(s) changed (+214/-16)" over a 1-file diff). Fall
  // back to the frontmatter only when the compare is unreachable.
  const liveStats = await deliveredDiffStats(gh, gh.defaultBranch, branch);
  const liveParts = liveStats
    ? deliveredStatsToPrParts(liveStats, branch, fm.workRevision?.headSha ?? null)
    : null;
  const body = composePrBody({
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
    await writePrToTask(db, ref, input, gh, created.data, actor, true, ctx, fm.pr);
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
    );
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
    const reasons = ghValidationBodySchema
      .parse(created.data)
      .errors.map((e) => e.message)
      .filter((reason) => reason.trim() !== "");
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
    return { status: "network_unavailable", message: detail };
  }
  return {
    status: "network_unavailable",
    message: created.kind === "http" ? created.message : "unknown",
  };
}

async function writePrToTask(
  db: DatabaseSync,
  ref: { projectSlug: string; taskKey: string; dataRoot?: string },
  input: { projectSlug: string; taskKey: string },
  gh: { repo: string },
  pr: GhPull,
  actor: AuditActor & { userId?: string; operatorAuthorized?: boolean },
  created: boolean,
  ctx: OpenTaskPrContext,
  existingPr: PrRef | null,
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
  const fresh = { number: pr.number, state, title: pr.title };
  const next: PrRef = samePr ? { ...existingPr, ...fresh } : fresh;
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
