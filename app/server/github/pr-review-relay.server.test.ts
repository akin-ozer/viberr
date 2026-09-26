import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch, type FakeResponder } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { drainRunCompletions, installFakeRuntime } from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { updateUserFields } from "~/server/auth/user-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { interruptRun } from "~/server/runtimes/run-service.server";
import { listRunsForTaskRows, upsertRun } from "~/server/runtimes/run-store.server";
import type { Engagement } from "~/schemas/task-file.schema";
import { reconcileTask } from "./github-reconciler.server";
import { readReviewRelay } from "./pr-review-relay.server";

/**
 * Ruling 484 (pass 40, F40-54): a project member's GitHub review of the
 * delivered revision reaches the agent that delivered it, once.
 *
 * Live on akin-ozer/website the owner's plan was to approve each note in
 * review; a CHANGES_REQUESTED review there became a pill state and its line
 * comments were never read, so a rejected note never reached the Content
 * Writer. These run the real reconciler over a fake GitHub and read what lands
 * in task.md.
 */

const REPO = "/repos/akin-ozer/viberr";
const HEAD = "headsha318";
const KEY = "VIB-301";

let ctx: TestDbContext;
let store: TestStore;

interface FakeRoutes {
  [routeKey: string]: FakeResponder;
}

function deployDeveloper(): void {
  const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
    .frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    agents: [
      {
        profileId: "developer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "Developer",
          role: "developer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      },
    ],
  });
}

const DELIVERER: Engagement = {
  profileId: "developer",
  backend: "claude",
  role: "developer",
  delivers: true,
  verdictCapable: false,
};

function writeDeliveredTask(engagements: Engagement[] = [DELIVERER]): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(KEY, {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
      engagements,
      pr: { number: 318, state: "review", title: "Attach execution workspace", headSha: HEAD },
      workRevision: {
        id: "rev_1",
        headSha: HEAD,
        treeSha: null,
        branch: "vib-301-workspace",
        createdAt: "2026-09-24T08:00:00Z",
        sourceProfileId: "developer",
        kind: "delivered",
      },
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDeveloper();
  writeDeliveredTask();
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_relay0001" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
  updateUserFields(store.db, store.users.selin.id, { githubHandle: "selindev" });
  updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
  updateUserFields(store.db, store.users.deniz.id, { githubHandle: "denizdev" });
  resetSseBrokerForTests();
});

afterEach(async () => {
  for (const run of listRunsForTaskRows(store.db, store.slug, KEY)) {
    if (run.state !== "running" && run.state !== "queued") continue;
    try {
      await interruptRun(
        store.db,
        { projectSlug: store.slug, taskKey: KEY, runId: run.id, dataRoot: store.dataRoot },
        { userId: store.users.arda.id, label: "arda@viberr.test" },
      );
    } catch {
      // already settled
    }
  }
  await drainRunCompletions();
  resetSseBrokerForTests();
  ctx.cleanup();
});

/** One `GET …/reviews` entry as GitHub sends it. */
interface GhReviewRow {
  id: number;
  user: { login: string };
  state: string;
  commit_id: string;
  body: string;
  submitted_at?: string;
}

/** One `GET …/reviews/{id}/comments` entry as GitHub sends it. */
interface GhCommentRow {
  id: number;
  path: string;
  body: string;
  line?: number | null;
  original_line?: number | null;
  original_start_line?: number;
  start_side?: string;
  side: string;
  original_commit_id: string;
}

/** An open PR #318 at HEAD, with `reviews` and each review's comments. */
function routes(
  reviews: readonly GhReviewRow[],
  comments: ReadonlyMap<number, readonly GhCommentRow[]> = new Map(),
): FakeRoutes {
  const table: FakeRoutes = {
    [`GET ${REPO}/compare/main...vib-301-workspace`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO}/pulls`]: {
      body: [{ number: 318, title: "Attach execution workspace", state: "open", head: { sha: HEAD } }],
    },
    [`GET ${REPO}/pulls/318`]: {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        merged: false,
        head: { sha: HEAD },
        additions: 3,
        deletions: 1,
        changed_files: 2,
      },
    },
    [`GET ${REPO}/commits/${HEAD}/check-runs`]: { body: { total_count: 0, check_runs: [] } },
    [`GET ${REPO}/pulls/318/reviews`]: { body: reviews },
  };
  for (const [id, rows] of comments) {
    table[`GET ${REPO}/pulls/318/reviews/${id}/comments`] = { body: rows };
  }
  return table;
}

function reconcile(fetchImpl: typeof fetch) {
  return reconcileTask(
    store.db,
    { projectSlug: store.slug, taskKey: KEY },
    { userId: null, label: "system" },
    { dataRoot: store.dataRoot, fetchImpl },
  );
}

function taskFile() {
  return readTaskFile({ projectSlug: store.slug, taskKey: KEY, dataRoot: store.dataRoot })!
    .parsed;
}

function comments() {
  return taskFile().timeline.filter((e) => e.type === "comment");
}

/** A contributor's CHANGES_REQUESTED review with three line comments, plus the
 *  reviews the relay must leave alone. */
const SELIN_REVIEW: GhReviewRow = {
  id: 11,
  user: { login: "selindev" },
  state: "CHANGES_REQUESTED",
  commit_id: HEAD,
  body: "Tighten the third note.",
  submitted_at: "2026-09-24T09:00:00Z",
};
const SELIN_COMMENTS: GhCommentRow[] = [
  {
    id: 101,
    path: "notes/three.md",
    body: "Reject this note. @operator need not see it.",
    line: 12,
    original_line: 12,
    side: "RIGHT",
    original_commit_id: HEAD,
  },
  {
    id: 102,
    path: "notes/old.md",
    body: "Keep this line.",
    line: null,
    original_line: 4,
    side: "LEFT",
    original_commit_id: HEAD,
  },
  {
    id: 103,
    path: "notes/range.md",
    body: "Too long.",
    original_start_line: 2,
    start_side: "RIGHT",
    original_line: 5,
    side: "RIGHT",
    original_commit_id: HEAD,
  },
  {
    // Ruling 509: a range from a removed line to an added one.
    id: 104,
    path: "notes/swap.md",
    body: "Keep the old wording.",
    original_start_line: 3,
    start_side: "LEFT",
    original_line: 5,
    side: "RIGHT",
    original_commit_id: HEAD,
  },
];
const IGNORED_REVIEWS: GhReviewRow[] = [
  // A registered NON-member.
  { id: 12, user: { login: "denizdev" }, state: "COMMENTED", commit_id: HEAD, body: "x" },
  // A member's review of an OLDER head.
  { id: 13, user: { login: "selindev" }, state: "COMMENTED", commit_id: "oldsha", body: "" },
  // An unsubmitted draft.
  { id: 14, user: { login: "selindev" }, state: "PENDING", commit_id: HEAD, body: "" },
  // A login nobody claims.
  { id: 15, user: { login: "octocat" }, state: "CHANGES_REQUESTED", commit_id: HEAD, body: "y" },
];

describe("ruling 484: the review relay", () => {
  it("relays a member's review of the delivered head as ONE @deliverer comment quoting file:line, tagged from GitHub", async () => {
    const gh = fakeGithubFetch(
      routes(
        [SELIN_REVIEW, ...IGNORED_REVIEWS],
        new Map([
          [11, SELIN_COMMENTS],
          [12, []],
          [13, []],
          [15, []],
        ]),
      ),
    );
    const result = await reconcile(gh.fetchImpl);
    expect(result.status).toBe("reconciled");

    const posted = comments();
    expect(posted).toHaveLength(1);
    const [comment] = posted;
    expect(comment!.actor).toMatchObject({ kind: "human", userId: store.users.selin.id });
    // The deliverer is a named agent, so the comment is routed to it.
    expect(comment!.toAgent).toBe(true);
    expect(comment!.text).toBe(
      [
        "@developer Review notes on `headsha` (PR #318), from GitHub (a review by selindev):",
        "",
        "- Requested changes: Tighten the third note.",
        "- `notes/three.md:12`: Reject this note. \\@operator need not see it.",
        "- `notes/old.md:4` (removed line): Keep this line.",
        "- `notes/range.md:2-5`: Too long.",
        "- `notes/swap.md` (removed line 3 to line 5): Keep the old wording.",
      ].join("\n"),
    );
    // Audited as the member, with the instrument named.
    const audit = listAuditEvents(store.db, { action: "task.comment" });
    expect(audit.map((a) => a.actorLabel)).toEqual([`${store.users.selin.email} · via GitHub`]);
    // Only the relayed review's comments were listed.
    expect(gh.callsTo(`GET ${REPO}/pulls/318/reviews/11/comments`)).toHaveLength(1);
    for (const id of [12, 13, 14, 15]) {
      expect(gh.callsTo(`GET ${REPO}/pulls/318/reviews/${id}/comments`)).toHaveLength(0);
    }
    // Recorded in the same write as the comment.
    expect([...readReviewRelay(taskFile().frontmatter.pr)].sort()).toEqual([
      "comment:101",
      "comment:102",
      "comment:103",
      "comment:104",
      "review:11",
    ]);
  });

  it("relays each review once: the next pass lists nothing, posts nothing and rewrites nothing", async () => {
    const gh = fakeGithubFetch(routes([SELIN_REVIEW], new Map([[11, SELIN_COMMENTS]])));
    await reconcile(gh.fetchImpl);
    const second = await reconcile(gh.fetchImpl);
    expect(comments()).toHaveLength(1);
    expect(gh.callsTo(`GET ${REPO}/pulls/318/reviews/11/comments`)).toHaveLength(1);
    // The reconciler carries the record for the same PR, so a quiet pass is a
    // quiet pass (no churn, and the record is still there).
    expect(second.status === "reconciled" && second.changed).toBe(false);
    expect(readReviewRelay(taskFile().frontmatter.pr).has("review:11")).toBe(true);
  });

  it("records a review with nothing to relay (an approval, no comments) so it is not listed again", async () => {
    const approval = { ...SELIN_REVIEW, id: 21, state: "APPROVED", body: "Looks good." };
    const gh = fakeGithubFetch(routes([approval], new Map([[21, []]])));
    await reconcile(gh.fetchImpl);
    await reconcile(gh.fetchImpl);
    expect(comments()).toHaveLength(0);
    expect(gh.callsTo(`GET ${REPO}/pulls/318/reviews/21/comments`)).toHaveLength(1);
    expect(readReviewRelay(taskFile().frontmatter.pr).has("review:21")).toBe(true);
    // Written file first, then re-projected: the projection carries it too.
    const row = z
      .object({ pr_json: z.string() })
      .parse(
        store.db
          .prepare(`SELECT pr_json FROM task_projections WHERE project_slug = ? AND task_key = ?`)
          .get(store.slug, KEY),
      );
    expect(row.pr_json).toContain("review:21");
  });

  it("relays nothing, and records nothing, while no agent delivers the task", async () => {
    writeDeliveredTask([]);
    const gh = fakeGithubFetch(routes([SELIN_REVIEW], new Map([[11, SELIN_COMMENTS]])));
    await reconcile(gh.fetchImpl);
    expect(comments()).toHaveLength(0);
    expect(readReviewRelay(taskFile().frontmatter.pr).size).toBe(0);
  });

  it("leaves a review whose comments GitHub would not list for the next pass", async () => {
    const table = routes([SELIN_REVIEW]);
    table[`GET ${REPO}/pulls/318/reviews/11/comments`] = { status: 502, body: { message: "bad" } };
    await reconcile(fakeGithubFetch(table).fetchImpl);
    expect(comments()).toHaveLength(0);
    expect(readReviewRelay(taskFile().frontmatter.pr).size).toBe(0);
    // The next pass, with GitHub answering, relays it.
    await reconcile(fakeGithubFetch(routes([SELIN_REVIEW], new Map([[11, SELIN_COMMENTS]]))).fetchImpl);
    expect(comments()).toHaveLength(1);
  });

  it("resumes the delivering agent's session on a maintainer's review, as a typed @mention would", async () => {
    installFakeRuntime();
    await connectFakeBackend(store.db, store.users.arda.id, "claude");
    upsertRun(store.db, {
      id: "run_dev_prior",
      projectSlug: store.slug,
      taskKey: KEY,
      threadId: "developer-thread",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "claude-sonnet",
      sdk: "claude",
      sessionId: "run_dev_prior-session",
      agentName: "Developer",
      agentProfileId: "developer",
      state: "finished",
    });
    const review = { ...SELIN_REVIEW, id: 31, user: { login: "muratdev" } };
    await reconcile(fakeGithubFetch(routes([review], new Map([[31, SELIN_COMMENTS]]))).fetchImpl);
    expect(comments()[0]!.actor).toMatchObject({ kind: "human", userId: store.users.murat.id });
    const runs = listRunsForTaskRows(store.db, store.slug, KEY).filter(
      (r) => r.agent_profile_id === "developer" && r.id !== "run_dev_prior",
    );
    expect(runs).toHaveLength(1);
  });
});
