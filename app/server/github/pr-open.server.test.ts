import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { PrClosure, TaskFrontmatter } from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { composePrBody, openTaskPr } from "./pr-open.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };
const BRANCH = "vib-201-attach-execution-workspace-to";

/** What the service PUTs on the wire when it creates a PR — the fake records
 *  the request body as `unknown`, so it is parsed here rather than asserted at. */
const createPrRequest = z.object({
  title: z.string(),
  head: z.string(),
  base: z.string(),
  body: z.string(),
});

/** The delivered revision an adoptable PR's head has to be (R16-1). */
const DELIVERED_SHA = "d3l1ver3dsha0000000000000000000000000000";

function deliveredRevision(): TaskFrontmatter["workRevision"] {
  return {
    id: "rev_1",
    headSha: DELIVERED_SHA,
    treeSha: null,
    branch: BRANCH,
    createdAt: "2026-07-25T08:00:00.000Z",
    sourceProfileId: "developer",
  };
}

function setupWithBranch(
  taskKey = "VIB-201",
  fmPatch: Partial<TaskFrontmatter> = {},
) {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, {
      title: "Attach execution workspace to task runtime",
      stage: "review",
      branch: BRANCH,
      ...fmPatch,
    }),
    goal: "Wire the runtime workspace to the canonical task so runs anchor on it.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000001" },
    ACTOR,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
  return store;
}

describe("composePrBody", () => {
  it("carries the absolute Viberr task back-link, goal, and change summary", () => {
    const body = composePrBody({
      taskKey: "VIB-201",
      projectSlug: "core",
      title: "Attach workspace",
      goal: "Wire the workspace.",
      appOrigin: "https://viberr.example",
      changeSummary: "3 files changed.",
      evidence: ["unit tests pass"],
    });
    expect(body).toContain(
      "[VIB-201 · Attach workspace](https://viberr.example/projects/core/tasks/VIB-201)",
    );
    expect(body).toContain("## Goal");
    expect(body).toContain("Wire the workspace.");
    expect(body).toContain("## Change summary");
    expect(body).toContain("## Evidence");
    expect(body).toContain("unit tests pass");
  });

  // N20-4 (§5a): with no configured public origin the back-link used to be a
  // RELATIVE `/projects/…` path that 404s on github.com — worse than none. The
  // composer now omits the link and names the task by its store key instead.
  // Canary: put the relative fallback back and the "no link" assertions go red.
  it("omits the link and writes the plain store key when no origin is configured", () => {
    const body = composePrBody({
      taskKey: "VIB-1",
      projectSlug: "core",
      title: "Wire it",
      goal: "Wire.",
      appOrigin: null,
    });
    expect(body).toContain("**Viberr task:** VIB-1 · Wire it");
    // No markdown link at all, and no relative path a github.com reader could
    // click into a 404.
    expect(body).not.toContain("](");
    expect(body).not.toContain("/projects/core/tasks/VIB-1");
  });

  it("builds the absolute back-link when an origin IS configured", () => {
    const body = composePrBody({
      taskKey: "VIB-1",
      projectSlug: "core",
      title: "Wire it",
      goal: "Wire.",
      appOrigin: "https://v.example",
    });
    expect(body).toContain(
      "[VIB-1 · Wire it](https://v.example/projects/core/tasks/VIB-1)",
    );
  });
});

describe("openTaskPr", () => {
  it("creates a PR whose body embeds the task link + title, writes fm.pr, audits", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      // No existing open PR for the branch…
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      // …so it creates one.
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 42, html_url: "https://github.com/akin-ozer/viberr/pull/42", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl, appOrigin: "https://viberr.example" },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.created).toBe(true);
    expect(res.prNumber).toBe(42);

    // The PR request body carries the composed description with the task link.
    const post = gh.callsTo(`POST ${REPO_PATH}/pulls`)[0]!;
    const sent = createPrRequest.parse(post.body);
    expect(sent.title).toBe("[VIB-201] Attach execution workspace to task runtime");
    expect(sent.head).toBe(BRANCH);
    expect(sent.body).toContain("https://viberr.example/projects/");
    expect(sent.body).toContain("VIB-201");

    // fm.pr is written from the real response (not fabricated), in the
    // CANONICAL cache vocabulary: an open PR is "review", never raw "open".
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 42, state: "review" });
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain("github.pr.opened");
  });

  it("F22-10: the PR body's change-summary + evidence come from the LIVE compare, not stale fm.github", async () => {
    // Reproduce the PR #187 hazard: the reconciled frontmatter carries a
    // colliding branch's stats (3 files / +214 / 3 commits) while the actual
    // delivered diff is 1 file / +5. The compare of main...<branch> is the truth.
    const store = setupWithBranch("VIB-201", {
      github: {
        changed: { files: 3, add: 214, del: 16 },
        commits: [
          { sha: "aaaaaaa", msg: "stale one" },
          { sha: "bbbbbbb", msg: "stale two" },
          { sha: "ccccccc", msg: "stale three" },
        ],
      },
    });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/compare/main...${BRANCH}`]: {
        body: { total_commits: 1, files: [{ additions: 5, deletions: 0 }] },
      },
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 43, html_url: "https://github.com/akin-ozer/viberr/pull/43", title: "[VIB-201] x", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl, appOrigin: "https://viberr.example" },
    );
    expect(res.status).toBe("ok");
    const sent = createPrRequest.parse(gh.callsTo(`POST ${REPO_PATH}/pulls`)[0]!.body);
    // The live compare wins: 1 file / +5, 1 commit.
    expect(sent.body).toContain("1 file(s) changed (+5/-0).");
    expect(sent.body).toContain("1 file(s) changed on `" + BRANCH + "` · +5 · −0");
    expect(sent.body).toContain("1 commit(s) delivered");
    // The stale reconciled numbers must NOT appear.
    expect(sent.body).not.toContain("3 file(s) changed");
    expect(sent.body).not.toContain("+214");
    expect(sent.body).not.toContain("3 commit(s) delivered");
  });

  it("F22-10: falls back to fm.github stats when the compare is unreachable", async () => {
    const store = setupWithBranch("VIB-201", {
      github: { changed: { files: 2, add: 10, del: 3 }, commits: [] },
    });
    // No compare route registered → the fake 404s it → deliveredDiffStats null.
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 44, html_url: "https://github.com/akin-ozer/viberr/pull/44", title: "[VIB-201] x", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl, appOrigin: "https://viberr.example" },
    );
    expect(res.status).toBe("ok");
    const sent = createPrRequest.parse(gh.callsTo(`POST ${REPO_PATH}/pulls`)[0]!.body);
    expect(sent.body).toContain("2 file(s) changed (+10/-3).");
  });

  it("F21-9: a created PR whose response does not decode is still recorded", async () => {
    // The write already happened on GitHub. Losing the response used to lose the
    // task's only record of a live PR — the next delivery then tried to open a
    // second one for the same head (422) while the task claimed none existed.
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        // `html_url` and `state` drifted; the identity survived.
        body: { number: 77, html_url: null, state: 3, title: "[VIB-201] x" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", created: true, prNumber: 77 });
    if (res.status !== "ok") throw new Error("expected ok");
    // A browse link that works, derived from the repo instead of guessed.
    expect(res.url).toBe("https://github.com/akin-ozer/viberr/pull/77");
    const parsed = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed;
    // A minimal but TRUE record: a PR that was just created is open (→ review).
    expect(parsed.frontmatter.pr).toMatchObject({ number: 77, state: "review" });
    expect(
      parsed.timeline.some((e) => /Opened \*\*PR #77/.test(e.text ?? "")),
    ).toBe(true);
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "github.pr.opened",
    );
  });

  it("F21-9: a created PR with no readable number degrades — it never invents one", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: { status: 201, body: { ok: true } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("network_unavailable");
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("F17-1: an operator-authorized delivery writes the OPEN-PR event as the operator, not a guest human", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 51, html_url: "https://github.com/akin-ozer/viberr/pull/51", title: "[VIB-201] x", state: "open" },
      },
    });
    // The operator threads its sentinel user id "operator" (not a users-table
    // row) with operatorAuthorized:true — the bug rendered this as a human with
    // a "no longer a member" guest pill.
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { userId: "operator", label: "operator", operatorAuthorized: true },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed;
    const opened = parsed.timeline.find((e) => e.type === "github" && /Opened \*\*PR #51/.test(e.text ?? ""));
    expect(opened, "the open-PR event exists").toBeTruthy();
    expect(opened!.actor).toEqual({ kind: "operator" });
  });

  it("F17-1: a genuine human delivery still writes the OPEN-PR event as that human", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 52, html_url: "https://github.com/akin-ozer/viberr/pull/52", title: "[VIB-201] x", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { userId: store.users.arda.id, label: "arda@viberr.test", operatorAuthorized: false },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed;
    const opened = parsed.timeline.find((e) => e.type === "github" && /Opened \*\*PR #52/.test(e.text ?? ""));
    expect(opened!.actor).toMatchObject({ kind: "human", userId: store.users.arda.id });
  });

  // P13-D-26: `composePrBody` has always accepted `evidence` and this — its ONE
  // caller — never passed it, so the "## Evidence" section was unreachable in
  // production. The task record now carries real evidence rows on outcome
  // events; the newest set must reach the PR body.
  it("carries the task's newest evidence rows into the PR body (P13-D-26)", async () => {
    const store = setupWithBranch("VIB-202");
    // A reviewer verdict event carrying evidence, plus an older one that must
    // NOT win, plus a newer event with no evidence at all.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-202",
      dataRoot: store.dataRoot,
    })!;
    const agent = {
      kind: "agent" as const,
      backend: "claude" as const,
      profileId: "reviewer",
      roleHint: "Review",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: file.parsed.frontmatter,
      goal: file.parsed.goal,
      timeline: [
        {
          occurredAt: "2026-07-24T12:00:00.000Z",
          type: "comment",
          actor: agent,
          title: null,
          text: "Just a note.",
          toAgent: false,
          evidence: null,
        },
        {
          occurredAt: "2026-07-24T11:00:00.000Z",
          type: "quality",
          actor: agent,
          title: "Review passed",
          text: "**Validation:** healthy.",
          toAgent: false,
          evidence: [
            { label: "unit/policy_gate_test", add: "+14", del: "0" },
            { label: "2 commit(s) delivered", add: "—", del: "—" },
          ],
        },
        {
          occurredAt: "2026-07-24T10:00:00.000Z",
          type: "quality",
          actor: agent,
          title: "Older",
          text: "stale",
          toAgent: false,
          evidence: [{ label: "stale/suite", add: "+1", del: "0" }],
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 43, html_url: "https://github.com/akin-ozer/viberr/pull/43", title: "[VIB-202] x", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-202" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    const sent = createPrRequest.parse(gh.callsTo(`POST ${REPO_PATH}/pulls`)[0]!.body);
    expect(sent.body).toContain("## Evidence");
    expect(sent.body).toContain("- unit/policy_gate_test · +14 · 0");
    // The empty-column placeholder is a serialization detail, not PR prose.
    expect(sent.body).toContain("- 2 commit(s) delivered\n");
    expect(sent.body).not.toContain("stale/suite");
  });

  it("is idempotent — reuses an existing open PR instead of creating a duplicate", async () => {
    // R16-1: reuse is ADOPTION, so the open PR on the branch is only ours
    // because its head IS the delivered revision.
    const store = setupWithBranch("VIB-201", { workRevision: deliveredRevision() });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [{ number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] x", state: "open", head: { sha: DELIVERED_SHA } }],
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.created).toBe(false);
    expect(res.prNumber).toBe(7);
    // Never attempted to create a second PR.
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    // B-GH4: a reuse pass records NO "github.pr.opened" audit — that row means
    // a PR was opened. (Failed on main: every reuse appended another row.)
    expect(
      listAuditEvents(store.db, {}).filter((a) => a.action === "github.pr.opened"),
    ).toHaveLength(0);
  });

  it("R16-1: an open PR on the branch whose head is NOT the delivered revision is a collision, not this task's PR", async () => {
    // The adoption door H8 walked through. `head=owner:branch` finds whatever
    // sits on `vib-201-…`; before R16-1 that PR was written into `pr:` and the
    // task claimed a review it had nothing to do with. GitHub cannot hold two
    // PRs for one head, so the honest answer is to stop and name the collision.
    // Canary: drop the decidePrAdoption branch and this reuses PR #7.
    const store = setupWithBranch("VIB-201", { workRevision: deliveredRevision() });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [{ number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "someone else's work", state: "open", head: { sha: "a-stranger-sha" } }],
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("branch_collision");
    if (res.status !== "branch_collision") throw new Error("expected branch_collision");
    expect(res.prNumber).toBe(7);
    expect(res.message).toContain("Branch name collision");
    expect(res.message).toContain(BRANCH);
    // No PR was created, and the task's `pr` was never fabricated.
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("R16-1: a task that has delivered NO revision adopts nothing", async () => {
    // The H8 shape exactly: a brand-new task, nothing pushed, and an open PR
    // already on the branch from a previous instance of the same key.
    const store = setupWithBranch("VIB-201");
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [{ number: 113, html_url: "https://github.com/akin-ozer/viberr/pull/113", title: "[VIB-4] Verify MCP tool wiring", state: "open", head: { sha: "93435df" } }],
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("branch_collision");
    if (res.status !== "branch_collision") throw new Error("expected branch_collision");
    expect(res.message).toContain("delivered no revision");
  });

  it("R16-1: the PR the task already OWNS is still reused, revision or not", async () => {
    // Adoption is about PRs the task does not own. A cached number that matches
    // the discovery is the link `openTaskPr` itself minted — refreshing it is
    // not adoption and must not need a head match (a re-delivery can advance
    // the revision between the push and this read).
    const store = setupWithBranch("VIB-201", {
      pr: { number: 7, state: "review", title: "[VIB-201] x" },
      workRevision: deliveredRevision(),
    });
    const gh = fakeGithubFetch({
      // Step 0 confirms the cached PR is still open on GitHub and reuses it.
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: { number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] x", state: "open", head: { sha: "moved-on-since" } },
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.prNumber).toBe(7);
    expect(res.created).toBe(false);
  });

  it("a 403 opens a pull_request:write scope violation, does not fabricate a PR", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: { status: 403, body: { message: "Resource not accessible by personal access token" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("scope_violation");
    // No fabricated PR on the task.
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
    expect(findOpenScopeViolation(store.db, store.slug, "pull_request:write", "VIB-201")).not.toBeNull();
  });

  it("a 422 'No commits between' is an honest nothing_to_review, NOT network_unavailable", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: { message: "Validation Failed: No commits between main and vib-201" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("nothing_to_review");
    // No fabricated PR, and the reason is honest (was mislabeled network before).
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("ruling 128: a 422 with `field: base, code: invalid` is `base_branch_missing`, never `network_unavailable`", async () => {
    // Canary: remove `field`/`code` from `ghValidationBodySchema` and this
    // reads `refused` (the residual), not the typed base outcome.
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        // Exactly what GitHub sent on JC-1: a structured row with NO message.
        body: {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "base", code: "invalid" }],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "base_branch_missing", base: "main" });
    expect(res.status === "base_branch_missing" ? res.message : "").toContain("`main` does not exist");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("ruling 128: an unmapped 422 is `refused` and carries GitHub's own words", async () => {
    // Canary: return `network_unavailable` from the residual again.
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", code: "custom", message: "A pull request title is required" }],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("refused");
    expect(res.status === "refused" ? res.message : "").toContain("A pull request title is required");
  });

  it("F21-9: an UNREADABLE head probe never falls through to create", async () => {
    // The probe answered 200 with a payload the reader refused, so whether a PR
    // already occupies `head` is UNKNOWN. Before this, an unreadable answer was
    // treated exactly like an empty list: the create ran, GitHub refused it 422
    // ("a pull request already exists"), and that 422 was recorded as "the
    // branch produced no change".
    // Canary: drop the `decode` arm in `prAlreadyOnHead` → a POST goes out.
    const store = setupWithBranch("VIB-201", { workRevision: deliveredRevision() });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [{ number: "seven", html_url: "https://x", state: "open" }],
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("network_unavailable");
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("reads the 422 reason out of GitHub's errors[] rows, not just the envelope", async () => {
    // The envelope message is the constant "Validation Failed" — the sentence
    // that says WHICH validation failed rides in `errors[].message`. Sniffing
    // only the envelope makes every 422 look identical.
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            { resource: "PullRequest", field: "base", code: "custom",
              message: "No commits between main and vib-201" },
          ],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("nothing_to_review");
    if (res.status !== "nothing_to_review") throw new Error("expected nothing_to_review");
    expect(res.message).toContain("No commits between");
  });

  it("a 422 'a pull request already exists' is a COLLISION, never nothing_to_review", async () => {
    // Two 422s with opposite meanings shared one mapping. This one says a review
    // PR IS on the head — reported as `nothing_to_review` it told the human the
    // branch was empty and flagged the task `noChanges`, on a task whose work is
    // sitting in an open PR. The PR appeared between the probe and the create,
    // so the number has to come from a second read of the head.
    // Canary: map every 422 to nothing_to_review again → status flips.
    const store = setupWithBranch("VIB-201", { workRevision: deliveredRevision() });
    const gh = fakeGithubFetch({
      // Free on the probe, occupied by a STRANGER by the time we create.
      [`GET ${REPO_PATH}/pulls`]: (call) =>
        call.attempt === 1
          ? { body: [] }
          : {
              body: [{ number: 91, html_url: "https://github.com/akin-ozer/viberr/pull/91",
                title: "someone else's work", state: "open", head: { sha: "a-stranger-sha" } }],
            },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for akin-ozer:vib-201-attach-execution-workspace-to." }],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("branch_collision");
    if (res.status !== "branch_collision") throw new Error("expected branch_collision");
    expect(res.prNumber).toBe(91);
    expect(res.message).toContain("Branch name collision");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("a 422 'already exists' whose PR IS this task's delivered revision is adopted", async () => {
    // The racing PR carries the delivered revision — a concurrent delivery of
    // this same task. Adoption applies exactly as it does on the first probe:
    // reuse it, never a failure and never a second PR.
    const store = setupWithBranch("VIB-201", { workRevision: deliveredRevision() });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: (call) =>
        call.attempt === 1
          ? { body: [] }
          : {
              body: [{ number: 92, html_url: "https://github.com/akin-ozer/viberr/pull/92",
                title: "[VIB-201] x", state: "open", head: { sha: DELIVERED_SHA } }],
            },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "A pull request already exists for akin-ozer:vib-201-attach-execution-workspace-to." }],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.prNumber).toBe(92);
    // Reused, not created — a second POST would 422 all over again.
    expect(res.created).toBe(false);
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(1);
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed;
    expect(parsed.frontmatter.pr).toMatchObject({ number: 92, state: "review" });
    // F34-9: the delivery door records the adoption on its own, and no "opened".
    // Canary: drop the `recordPrAdoption` call from `prAlreadyOnHead`.
    const adopted = parsed.timeline.filter((e) => e.type === "github" && e.text.includes("Adopted **PR #92**"));
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.actor).toEqual({ kind: "system", systemId: "delivery" });
    expect(listAuditEvents(store.db, { action: "github.pr.adopted" })[0]!.details).toMatchObject({ prNumber: 92, source: "delivery" });
    expect(listAuditEvents(store.db, { action: "github.pr.opened" })).toHaveLength(0);
  });

  it("an UNRELATED 422 is neither an empty branch nor a collision", async () => {
    // A validation refusal this module has no reading for keeps the residual
    // failure — with GitHub's own words — instead of borrowing the empty-branch
    // meaning and marking the task as having produced no change.
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ message: "base is invalid" }],
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    // Ruling 128: GitHub ANSWERED, so an unmapped 422 is `refused` (quoting
    // GitHub), never `network_unavailable`.
    expect(res.status).toBe("refused");
    if (res.status !== "refused") throw new Error("expected refused");
    expect(res.message).toContain("base is invalid");
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
  });

  it("skips creation when the task already carries a live PR (agent-side capture) — reconciles instead (B5)", async () => {
    const store = setupTestStore(ctx);
    // The agent delivered on ITS OWN branch and the PR was captured into
    // fm.pr — the deterministic-branch head= dedup would never match it.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: "agent-made-this-branch",
        pr: { number: 7, state: "review", title: "[VIB-201] agent PR" },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000002" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: { number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] agent PR", state: "open", merged: false, merged_at: null },
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 7, created: false });
    // Never opened a duplicate PR.
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 7, state: "review" });
  });

  it("never downgrades a human-set \"accepted\" (merge pending) on the reuse path (B3)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "done",
        branch: BRANCH,
        pr: { number: 7, state: "accepted", title: "[VIB-201] x" },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000003" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const gh = fakeGithubFetch({
      // Still open on GitHub — "review" must NOT clobber "accepted".
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: { number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] x", state: "open", merged: false, merged_at: null },
      },
      [`POST ${REPO_PATH}/pulls`]: { status: 500, body: { message: "should not be called" } },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 7, created: false });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 7, state: "accepted" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
  });

  /** Ruling 160 (pass 35, F35-11): a closed-unmerged cache, with or without a
   *  person's answer on it. The three tests below share this seed. */
  function seedClosedCache(closure: PrClosure | null) {
    const store = setupTestStore(ctx);
    const pr: NonNullable<TaskFrontmatter["pr"]> = {
      number: 7,
      state: "closed",
      title: "[VIB-201] abandoned",
    };
    if (closure) pr.closure = closure;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        pr,
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000004" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
    return store;
  }

  it("ruling 160: a cached closed-unmerged PR with no answered closure refuses a fresh PR (closed_by_human)", async () => {
    // Canary: restore the "a TERMINAL cached PR clears the way" arm for
    // `closed` and the POST below fires.
    const store = seedClosedCache({ at: "2026-09-06T19:33:19.000Z", by: "akin-ozer", answered: null });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 43, html_url: "https://github.com/akin-ozer/viberr/pull/43", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toEqual({ status: "closed_by_human", prNumber: 7, closedBy: "akin-ozer" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    // The refusal is decided from the record: GitHub was not asked at all.
    expect(gh.calls).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 7, state: "closed" });
  });

  it("ruling 160: a closed cache whose closure a person ANSWERED clears the way for a fresh PR", async () => {
    const store = seedClosedCache({
      at: "2026-09-06T19:33:19.000Z",
      by: "akin-ozer",
      answered: { at: "2026-09-06T19:40:00.000Z", byUserId: "u_arda" },
    });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 43, html_url: "https://github.com/akin-ozer/viberr/pull/43", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 43, created: true });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    // A different PR never inherits the old one's closure.
    expect(fm.pr).toMatchObject({ number: 43, state: "review" });
    expect(fm.pr?.closure).toBeUndefined();
  });

  it("ruling 160: a cached 'review' PR that GitHub reports CLOSED unmerged is a person's decision: recorded through the reconciler, surfaced once, no fresh PR", async () => {
    // F35-11 live: the owner closed PR #10 at 19:33:19Z, the operator's base
    // refresh moved the branch, and the delivery at 19:33:44Z opened PR #26
    // over it; no event, notification or packet ever named the closure.
    // Canary: restore the "terminal on GitHub → fall through to the create
    // path" arm and the POST fires.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        ownerUserId: store.users.arda.id,
        pr: { number: 10, state: "review", title: "[VIB-201] rejected by hand" },
        recommendations: [
          { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion", detail: "" },
        ],
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000010" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const gh = fakeGithubFetch({
      // The cached number, read live: closed, not merged.
      [`GET ${REPO_PATH}/pulls/10`]: {
        body: { number: 10, html_url: "https://github.com/akin-ozer/viberr/pull/10", title: "[VIB-201] rejected by hand", state: "closed", merged: false, merged_at: null, head: { sha: "0ld".padEnd(40, "0") } },
      },
      // The branch listing no longer names it: the branch advanced past the
      // closed PR's head (the F26 blind spot the reconciler now reads around).
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      // Pull requests are issues, and the issue names who closed it.
      [`GET ${REPO_PATH}/issues/10`]: { body: { closed_by: { login: "akin-ozer" } } },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 26, html_url: "https://github.com/akin-ozer/viberr/pull/26", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toEqual({ status: "closed_by_human", prNumber: 10, closedBy: "akin-ozer" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);

    const read = () =>
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed;
    const fm = read().frontmatter;
    expect(fm.pr).toMatchObject({
      number: 10,
      state: "closed",
      closure: { by: "akin-ozer", answered: null },
    });
    // R8-6 fired from the reconciler, exactly as an out-of-band close does:
    // the divergence note, the withdrawn acceptance offer, the inbox alert.
    const divergence = (events: ReturnType<typeof read>["timeline"]) =>
      events.filter((e) => /PR #10 was closed on GitHub without merging/.test(e.text));
    expect(divergence(read().timeline)).toHaveLength(1);
    expect(fm.recommendations).toEqual([]);
    // SAFETY: the SELECT names one column, declared `title TEXT NOT NULL`.
    const inbox = store.db
      .prepare(`SELECT title FROM notifications WHERE task_key = 'VIB-201'`)
      .all() as { title: string }[];
    expect(inbox.some((n) => /PR #10 closed on GitHub: VIB-201 needs a decision/.test(n.title))).toBe(true);
    expect(listAuditEvents(store.db, { action: "github.pr.opened" })).toHaveLength(0);

    // A second delivery over the recorded closure refuses from the record
    // (no GitHub call) and surfaces nothing twice: a transition, not a repeat.
    const before = gh.calls.length;
    const again = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(again).toEqual({ status: "closed_by_human", prNumber: 10, closedBy: "akin-ozer" });
    expect(gh.calls).toHaveLength(before);
    expect(divergence(read().timeline)).toHaveLength(1);
  });

  it("a MERGED cached PR clears the way — a reworked branch opens a fresh PR (DG-1)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        // The prior PR on this branch already merged; the branch was then
        // reworked (new commits). Resurrecting the merged PR would dead-end
        // acceptance at "merge pending" forever.
        pr: { number: 7, state: "merged", title: "[VIB-201] already merged" },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000005" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const gh = fakeGithubFetch({
      // No open PR for the branch → a fresh one is created (the merged #7 is
      // never GET-reconciled or reused).
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 44, html_url: "https://github.com/akin-ozer/viberr/pull/44", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 44, created: true });
    // The merged PR was never fetched for reuse.
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/7`)).toHaveLength(0);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 44, state: "review" });
  });

  it("a cached 'review' PR that GitHub reports MERGED out-of-band opens a fresh PR, not the dead one (DG-1)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        // Cache still says "review" (reconcile hasn't run), but the PR was
        // merged out-of-band on GitHub and the branch reworked since.
        pr: { number: 7, state: "review", title: "[VIB-201] merged out-of-band" },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000006" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

    const gh = fakeGithubFetch({
      // The live PR is CLOSED+merged on GitHub → must not be reused.
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: { number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] x", state: "closed", merged: true, merged_at: "2026-07-24T00:00:00Z" },
      },
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 45, html_url: "https://github.com/akin-ozer/viberr/pull/45", title: "[VIB-201] Attach execution workspace to task runtime", state: "open" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 45, created: true });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 45, state: "review" });
  });

  it("P13-D-28: reusing the SAME PR keeps the reconciler-owned checks + review", async () => {
    // openTaskPr never reads CI or reviews. Rebuilding the ref from scratch on a
    // reuse would blank both pills until the next 5-minute poller tick.
    const store = setupWithBranch();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        pr: {
          number: 42,
          state: "review",
          title: "old title",
          checks: { total: 3, passing: 2, failing: 0, pending: 1 },
          review: "approved",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/42`]: {
        body: {
          number: 42,
          html_url: "https://github.com/akin-ozer/viberr/pull/42",
          title: "new title",
          state: "open",
          merged: false,
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 42, created: false });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toEqual({
      number: 42,
      state: "review",
      title: "new title",
      checks: { total: 3, passing: 2, failing: 0, pending: 1 },
      review: "approved",
    });
  });

  it("P13-D-28: a DIFFERENT (freshly opened) PR starts with no checks and no review", async () => {
    const store = setupWithBranch();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        pr: {
          number: 42,
          state: "merged",
          title: "old merged PR",
          checks: { total: 3, passing: 3, failing: 0, pending: 0 },
          review: "approved",
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: {
          number: 51,
          html_url: "https://github.com/akin-ozer/viberr/pull/51",
          title: "[VIB-201] Attach execution workspace to task runtime",
          state: "open",
        },
      },
    });
    await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl },
    );
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(Object.keys(fm.pr!)).toEqual(["number", "state", "title"]);
    expect(fm.pr).toMatchObject({ number: 51, state: "review" });
  });

  it("degrades cleanly when no repo/PAT is configured (no throw, typed result)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review", branch: "vib-9-x" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // No credential set → no_pat_configured.
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-9" },
      { ...ACTOR, userId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    );
    expect(["no_pat_configured", "no_repo_configured"]).toContain(res.status);
  });
});

/**
 * Ruling 135: the delivery door writes the PR head it read. A reuse of the
 * SAME PR carries the head forward and clears a satisfied record; a DIFFERENT
 * PR never inherits the old head. Canary: carry `existingPr.headSha`
 * unconditionally (spread `existingPr` even when the number differs).
 */
describe("ruling 135: writePrToTask and the PR head", () => {
  it("reusing the SAME PR writes the live head and clears a satisfied unpushed record", async () => {
    const store = setupWithBranch();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        workRevision: { id: "rev_1", headSha: "9".repeat(40), treeSha: null, branch: BRANCH, createdAt: "2026-09-04T00:00:00.000Z", sourceProfileId: "developer" },
        pr: {
          number: 42, state: "review", title: "old title", headSha: "1".repeat(40),
          unpushedRevision: { revisionSha: "9".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" },
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/42`]: {
        body: { number: 42, html_url: "https://github.com/akin-ozer/viberr/pull/42", title: "new title", state: "open", merged: false, head: { sha: "9".repeat(40) } },
      },
    });
    const res = await openTaskPr(store.db, { projectSlug: store.slug, taskKey: "VIB-201" }, { ...ACTOR, userId: store.users.arda.id }, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl });
    expect(res).toMatchObject({ status: "ok", prNumber: 42, created: false });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toEqual({ number: 42, state: "review", title: "new title", headSha: "9".repeat(40) });
  });

  it("a DIFFERENT PR does not inherit the old head", async () => {
    const store = setupWithBranch();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        // Ruling 160: a closed cache clears the way only once a person has
        // answered the closure; the fresh PR inherits neither the head nor it.
        pr: {
          number: 7,
          state: "closed",
          title: "[VIB-201] abandoned",
          headSha: "1".repeat(40),
          closure: { at: "2026-09-06T19:33:19.000Z", by: "akin-ozer", answered: { at: "2026-09-06T19:40:00.000Z", byUserId: "u_arda" } },
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: { number: 43, html_url: "https://github.com/akin-ozer/viberr/pull/43", title: "[VIB-201] t", state: "open" },
      },
    });
    const res = await openTaskPr(store.db, { projectSlug: store.slug, taskKey: "VIB-201" }, { ...ACTOR, userId: store.users.arda.id }, { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl });
    expect(res).toMatchObject({ status: "ok", prNumber: 43, created: true });
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-201", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr).toEqual({ number: 43, state: "review", title: "[VIB-201] t" });
  });
});
