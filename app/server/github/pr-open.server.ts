import type { DatabaseSync } from "node:sqlite";
import type { PrRef } from "~/schemas/task-file.schema";
import type { AuditActor } from "~/server/audit/audit-recorder.server";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import {
  appendTimelineEvent,
  patchTaskFrontmatter,
  readTaskFile,
  resolveTaskFilePath,
} from "~/server/files/task-writer.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { getEnv } from "~/server/config/env.server";
import { taskBranchName } from "./branch-sync.server";
import {
  getProjectGithubContext,
  type GithubContextFailure,
} from "./github-context.server";
import { mapPrToCacheState } from "./pr-linker.server";
import { flagScopeViolation, policyViolationText } from "./scope-flag.server";

/**
 * Compose the review PR body from the task contract (FR31/FR32). This is the
 * governed hand-off the PRD promises: a reviewer opening the PR on GitHub can
 * see the task's goal, a change summary, evidence, and — critically — a link
 * back to the canonical Viberr task, so task ↔ branch ↔ PR stays traceable
 * without asking. Pure + exported so its exact contents are unit-tested.
 */
export function composePrBody(input: {
  taskKey: string;
  title: string;
  goal: string;
  taskUrl: string;
  changeSummary?: string | null;
  evidence?: string[] | null;
}): string {
  const lines: string[] = [];
  lines.push(`**Viberr task:** [${input.taskKey} — ${input.title}](${input.taskUrl})`);
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
    `---\n_Opened by Viberr for task ${input.taskKey}. Review and merge are human-authorized; accepting the completion in Viberr merges this PR when GitHub is reachable — otherwise the acceptance is recorded as merge-pending until a human completes the merge._`,
  );
  return lines.join("\n");
}

/** Absolute Viberr URL for a task, from BETTER_AUTH_URL when configured. */
export function taskUrl(
  projectSlug: string,
  taskKey: string,
  appOrigin?: string,
): string {
  const origin = (appOrigin ?? getEnv().BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
  const path = `/projects/${projectSlug}/tasks/${taskKey}`;
  return origin ? `${origin}${path}` : path;
}

export interface OpenTaskPrContext {
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  /** App origin for the task back-link when BETTER_AUTH_URL is unset (dev). */
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
  | { status: "scope_violation"; scope: string; violationId: string }
  | { status: "auth_failed"; message: string }
  /** GitHub 422 on POST /pulls — the branch has no commits ahead of base, so
   *  there is nothing to review. An honest "nothing to review", NOT a network
   *  failure (which is how it used to be mislabeled). */
  | { status: "nothing_to_review"; message: string }
  | { status: "network_unavailable"; message: string };

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  state: string;
  /** Merge facts from GET /pulls/{n} (absent on list items). */
  merged?: boolean;
  merged_at?: string | null;
}

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
  actor: AuditActor & { userId?: string },
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

  const gh = getProjectGithubContext(db, input.projectSlug, {
    repoOverride: fm.repo,
    ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
  });
  if (gh.status !== "ok") return gh;

  // 0. The task already carries a live PR — e.g. captured from agent-side
  //    delivery on a branch the head= dedup below would never match. Never
  //    open a duplicate: reconcile the cached record against the real PR and
  //    reuse it. Only a closed-unmerged PR clears the way for a fresh one.
  if (fm.pr && fm.pr.state !== "closed") {
    const live = await gh.client.request<GhPull>(
      "GET",
      `/repos/${gh.repo}/pulls/${fm.pr.number}`,
    );
    if (live.ok) {
      await writePrToTask(db, ref, input, gh, live.data, actor, false, ctx, fm.pr);
      return {
        status: "ok",
        prNumber: live.data.number,
        created: false,
        url: live.data.html_url,
      };
    }
    if (live.kind === "network") {
      return { status: "network_unavailable", message: live.message };
    }
    if (live.kind === "http" && live.status === 401) {
      return { status: "auth_failed", message: live.message };
    }
    // Any other refusal (404 gone, 403 read scope): the cached PR can't be
    // confirmed — fall through to the normal head-dedup + create path.
  }

  const branch = fm.branch ?? taskBranchName(input.taskKey);
  if (!branch) return { status: "no_branch" };

  const owner = gh.repo.split("/")[0] ?? "";

  // 1. Idempotency: reuse an existing open PR for this head branch.
  const existing = await gh.client.request<GhPull[]>(
    "GET",
    `/repos/${gh.repo}/pulls`,
    { searchParams: { head: `${owner}:${branch}`, state: "open", per_page: 1 } },
  );
  if (existing.ok && existing.data.length > 0) {
    const pr = existing.data[0]!;
    await writePrToTask(db, ref, input, gh, pr, actor, false, ctx, fm.pr);
    return { status: "ok", prNumber: pr.number, created: false, url: pr.html_url };
  }
  if (!existing.ok && existing.kind === "network") {
    return { status: "network_unavailable", message: existing.message };
  }
  if (!existing.ok && existing.kind === "http" && existing.status === 401) {
    return { status: "auth_failed", message: existing.message };
  }

  // 2. Create the PR.
  const body = composePrBody({
    taskKey: input.taskKey,
    title: fm.title,
    goal: file.parsed.goal,
    taskUrl: taskUrl(input.projectSlug, input.taskKey, ctx.appOrigin),
    changeSummary: fm.github?.changed
      ? `${fm.github.changed.files} file(s) changed (+${fm.github.changed.add}/-${fm.github.changed.del}).`
      : null,
  });
  const created = await gh.client.request<GhPull>("POST", `/repos/${gh.repo}/pulls`, {
    body: {
      title: `[${input.taskKey}] ${fm.title}`,
      head: branch,
      base: gh.defaultBranch,
      body,
    },
  });

  if (created.ok) {
    await writePrToTask(db, ref, input, gh, created.data, actor, true, ctx, fm.pr);
    return {
      status: "ok",
      prNumber: created.data.number,
      created: true,
      url: created.data.html_url,
    };
  }
  if (created.kind === "network") {
    return { status: "network_unavailable", message: created.message };
  }
  if (created.kind === "http" && created.status === 401) {
    return { status: "auth_failed", message: created.message };
  }
  if (created.kind === "http" && created.status === 403) {
    const { violation } = await flagScopeViolation(
      db,
      {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        scope: "pull_request:write",
        detail: policyViolationText(
          "pull_request:write",
          "opening the review pull request",
        ),
        ...(actor ? { actor } : {}),
      },
      { dataRoot: ctx.dataRoot },
    );
    return {
      status: "scope_violation",
      scope: "pull_request:write",
      violationId: violation.id,
    };
  }
  // GitHub 422 on create = "No commits between <base> and <head>" — the branch
  // carries no diff, so there is nothing to open a review PR for. That's an
  // honest empty-diff state, not a network failure.
  if (created.kind === "http" && created.status === 422) {
    return { status: "nothing_to_review", message: created.message };
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
  actor: AuditActor & { userId?: string },
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
  // Preserve extra cached fields (e.g. checks) when refreshing the same PR.
  const next: PrRef = {
    ...(samePr ? existingPr : {}),
    number: pr.number,
    state,
    title: pr.title,
  };
  const changed = JSON.stringify(existingPr) !== JSON.stringify(next);
  if (changed) {
    await patchTaskFrontmatter(ref, { pr: next });
  }
  if (created) {
    const nameHint = actor.userId
      ? ((db.prepare(`SELECT name FROM users WHERE id = ?`).get(actor.userId) as
          | { name: string }
          | undefined)?.name ?? null)
      : null;
    await appendTimelineEvent(ref, {
      occurredAt: new Date().toISOString(),
      type: "github",
      actor: actor.userId
        ? { kind: "human", userId: actor.userId, nameHint }
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
