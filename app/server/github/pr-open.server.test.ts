import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  composePrBody,
  openTaskPr,
  recoverGithubPrOpenIntents,
  taskUrl,
} from "./pr-open.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };
const BRANCH = "vib-201-attach-execution-workspace-to";
const HEAD_SHA = "a".repeat(40);
const BASE = { ref: "main", repo: { full_name: "akin-ozer/viberr" } };

function setupWithBranch(taskKey = "VIB-201") {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(taskKey, {
      title: "Attach execution workspace to task runtime",
      stage: "review",
      branch: BRANCH,
    }),
    goal: "Wire the runtime workspace to the canonical task so runs anchor on it.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000001" },
    ACTOR,
  );
  setProjectCredential(
    store.db,
    { projectSlug: store.slug, patId: pat.id },
    ACTOR,
  );
  return store;
}

describe("composePrBody", () => {
  it("carries the Viberr task back-link, goal, and change summary", () => {
    const body = composePrBody({
      taskKey: "VIB-201",
      title: "Attach workspace",
      goal: "Wire the workspace.",
      taskUrl: "https://viberr.example/projects/core/tasks/VIB-201",
      changeSummary: "3 files changed.",
      evidence: ["unit tests pass"],
    });
    expect(body).toContain(
      "[VIB-201 — Attach workspace](https://viberr.example/projects/core/tasks/VIB-201)",
    );
    expect(body).toContain("## Goal");
    expect(body).toContain("Wire the workspace.");
    expect(body).toContain("## Change summary");
    expect(body).toContain("## Evidence");
    expect(body).toContain("unit tests pass");
  });

  it("taskUrl falls back to a relative path when no origin is configured", () => {
    expect(taskUrl("core", "VIB-1")).toBe("/projects/core/tasks/VIB-1");
    expect(taskUrl("core", "VIB-1", "https://v.example/")).toBe(
      "https://v.example/projects/core/tasks/VIB-1",
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
        body: {
          number: 42,
          html_url: "https://github.com/akin-ozer/viberr/pull/42",
          title: "[VIB-201] Attach execution workspace to task runtime",
          state: "open",
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
      [`GET ${REPO_PATH}/pulls/42`]: {
        body: {
          number: 42,
          html_url: "https://github.com/akin-ozer/viberr/pull/42",
          title: "[VIB-201] Attach execution workspace to task runtime",
          state: "open",
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        appOrigin: "https://viberr.example",
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.created).toBe(true);
    expect(res.prNumber).toBe(42);

    // The PR request body carries the composed description with the task link.
    const post = gh.callsTo(`POST ${REPO_PATH}/pulls`)[0]!;
    const sent = post.body as {
      title: string;
      head: string;
      base: string;
      body: string;
    };
    expect(sent.title).toBe(
      "[VIB-201] Attach execution workspace to task runtime",
    );
    expect(sent.head).toBe(BRANCH);
    expect(sent.body).toContain("https://viberr.example/projects/");
    expect(sent.body).toContain("VIB-201");

    // fm.pr is written from the real response (not fabricated), in the
    // CANONICAL cache vocabulary: an open PR is "review", never raw "open".
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({
      number: 42,
      state: "review",
      headSha: HEAD_SHA,
    });
    expect(listAuditEvents(store.db, {}).map((a) => a.action)).toContain(
      "github.pr.opened",
    );
  });

  it("is idempotent — reuses an existing open PR instead of creating a duplicate", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 7,
            html_url: "https://github.com/akin-ozer/viberr/pull/7",
            title: "[VIB-201] x",
            state: "open",
            head: { sha: HEAD_SHA },
            base: BASE,
          },
        ],
      },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 500,
        body: { message: "should not be called" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("expected ok");
    expect(res.created).toBe(false);
    expect(res.prNumber).toBe(7);
    // Never attempted to create a second PR.
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
  });

  it("a 403 opens a pull_request:write scope violation, does not fabricate a PR", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res.status).toBe("scope_violation");
    // No fabricated PR on the task.
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toBeNull();
    expect(
      findOpenScopeViolation(
        store.db,
        store.slug,
        "pull_request:write",
        "VIB-201",
      ),
    ).not.toBeNull();
  });

  it("a 422 'No commits between' is an honest nothing_to_review, NOT network_unavailable", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 422,
        body: {
          message: "Validation Failed: No commits between main and vib-201",
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res.status).toBe("nothing_to_review");
    // No fabricated PR, and the reason is honest (was mislabeled network before).
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
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
        pr: {
          number: 7,
          state: "review",
          title: "[VIB-201] agent PR",
          headSha: HEAD_SHA,
        },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "bot",
        token: "ghp_propen00000002",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );

    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: {
          number: 7,
          html_url: "https://github.com/akin-ozer/viberr/pull/7",
          title: "[VIB-201] agent PR",
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 500,
        body: { message: "should not be called" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 7, created: false });
    // Never opened a duplicate PR.
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({
      number: 7,
      state: "review",
      headSha: HEAD_SHA,
    });
  });

  it('never downgrades a human-set "accepted" (merge pending) on the reuse path (B3)', async () => {
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
      {
        userId: store.users.arda.id,
        label: "bot",
        token: "ghp_propen00000003",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );

    const gh = fakeGithubFetch({
      // Still open on GitHub — "review" must NOT clobber "accepted".
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: {
          number: 7,
          html_url: "https://github.com/akin-ozer/viberr/pull/7",
          title: "[VIB-201] x",
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 500,
        body: { message: "should not be called" },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 7, created: false });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 7, state: "accepted" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
  });

  it("a closed-unmerged cached PR clears the way — a fresh PR is created", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        pr: { number: 7, state: "closed", title: "[VIB-201] abandoned" },
      }),
      goal: "Deliver.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "bot",
        token: "ghp_propen00000004",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );

    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: {
        status: 201,
        body: {
          number: 43,
          html_url: "https://github.com/akin-ozer/viberr/pull/43",
          title: "[VIB-201] Attach execution workspace to task runtime",
          state: "open",
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
      [`GET ${REPO_PATH}/pulls/43`]: {
        body: {
          number: 43,
          html_url: "https://github.com/akin-ozer/viberr/pull/43",
          title: "[VIB-201] Attach execution workspace to task runtime",
          state: "open",
          head: { sha: HEAD_SHA },
          base: BASE,
        },
      },
    });
    const res = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { ...ACTOR, userId: store.users.arda.id },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(res).toMatchObject({ status: "ok", prNumber: 43, created: true });
    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 43, state: "review" });
  });

  it("rejects a cached PR whose live head contradicts the verified head and never overwrites from the cache", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-201", {
        title: "Attach execution workspace to task runtime",
        stage: "review",
        branch: BRANCH,
        pr: {
          number: 7,
          state: "review",
          title: "[VIB-201] original",
          headSha: HEAD_SHA,
        },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "bot",
        token: "ghp_propen_head_conflict",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const contradictoryHead = "b".repeat(40);
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls/7`]: {
        body: {
          number: 7,
          html_url: "https://github.com/akin-ozer/viberr/pull/7",
          title: "[VIB-201] contradictory",
          state: "open",
          head: { sha: contradictoryHead },
          base: BASE,
        },
      },
    });

    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
          verifiedHeadSha: HEAD_SHA,
        },
      ),
    ).resolves.toMatchObject({ status: "head_mismatch" });
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-201",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr,
    ).toMatchObject({ title: "[VIB-201] original", headSha: HEAD_SHA });
    expect(
      listAuditEvents(store.db, {}).filter(
        (event) => event.action === "github.pr.opened",
      ),
    ).toHaveLength(0);
  });

  it("rejects a head-filter result whose live head is not the exact verified commit", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 8,
            html_url: "https://github.com/akin-ozer/viberr/pull/8",
            title: "[VIB-201] stale",
            state: "open",
            head: { sha: "c".repeat(40) },
            base: BASE,
          },
        ],
      },
    });
    const result = await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(result).toMatchObject({ status: "head_mismatch" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
  });

  it("re-reads canonical project repo/default branch after GitHub awaits before staging or writing", async () => {
    const store = setupWithBranch();
    const original = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: () => {
        writeProject(store.dataRoot, {
          ...original.frontmatter,
          defaultBranch: "develop",
        });
        return { body: [] };
      },
    });

    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
          verifiedHeadSha: HEAD_SHA,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM github_pr_open_intents`)
        .get(),
    ).toEqual({ n: 0 });
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-201",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr,
    ).toBeNull();
  });

  it("recovers an ambiguous timed-out POST by observing the exact live PR without repeating POST", async () => {
    const store = setupWithBranch();
    const live = {
      number: 55,
      html_url: "https://github.com/akin-ozer/viberr/pull/55",
      title: "[VIB-201] Attach execution workspace to task runtime",
      state: "open",
      head: { sha: HEAD_SHA },
      base: BASE,
    };
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: (call) => ({
        body: call.attempt <= 2 ? [] : [live],
      }),
      [`GET ${REPO_PATH}/pulls/55`]: { body: live },
    });
    let postCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        postCalls += 1;
        throw new TypeError("socket closed after request body was sent");
      }
      return gh.fetchImpl(input, init);
    };
    const originalActor = {
      userId: store.users.murat.id,
      label: store.users.murat.email,
    };
    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        originalActor,
        {
          dataRoot: store.dataRoot,
          fetchImpl,
          verifiedHeadSha: HEAD_SHA,
        },
      ),
    ).resolves.toMatchObject({ status: "network_unavailable" });
    expect(postCalls).toBe(1);
    expect(
      store.db.prepare(`SELECT state FROM github_pr_open_intents`).get(),
    ).toEqual({ state: "posting" });

    await expect(
      recoverGithubPrOpenIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl,
      }),
    ).resolves.toEqual({ completed: 1, cancelled: 0, deferred: 0, errors: 0 });
    expect(postCalls).toBe(1);
    expect(
      store.db
        .prepare(`SELECT count(*) AS n FROM github_pr_open_intents`)
        .get(),
    ).toEqual({ n: 0 });
    const audit = listAuditEvents(store.db, {}).find(
      (event) => event.action === "github.pr.opened",
    )!;
    expect(audit.actorUserId).toBe(originalActor.userId);
    expect(audit.actorLabel).toBe(originalActor.label);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.pr).toMatchObject({
      number: 55,
      headSha: HEAD_SHA,
    });
    expect(
      task.timeline.filter((event) => event.text.includes("PR #55")),
    ).toHaveLength(1);
  });

  it.each(["empty" as const, "http_error" as const])(
    "keeps ambiguous posting observation-only when retry sees $s",
    async (observation) => {
      const store = setupWithBranch();
      const gh = fakeGithubFetch({
        [`GET ${REPO_PATH}/pulls`]: (call) =>
          call.attempt <= 2
            ? { body: [] }
            : observation === "empty"
              ? { body: [] }
              : { status: 500, body: { message: "observation failed" } },
      });
      let postCalls = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        if ((init?.method ?? "GET") === "POST") {
          postCalls += 1;
          throw new TypeError("ambiguous POST timeout");
        }
        return gh.fetchImpl(input, init);
      };
      const originalActor = {
        userId: store.users.murat.id,
        label: store.users.murat.email,
      };
      await expect(
        openTaskPr(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-201" },
          originalActor,
          {
            dataRoot: store.dataRoot,
            fetchImpl,
            verifiedHeadSha: HEAD_SHA,
          },
        ),
      ).resolves.toMatchObject({ status: "network_unavailable" });
      expect(postCalls).toBe(1);

      await expect(
        openTaskPr(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-201" },
          { userId: store.users.arda.id, label: store.users.arda.email },
          {
            dataRoot: store.dataRoot,
            fetchImpl,
            verifiedHeadSha: HEAD_SHA,
          },
        ),
      ).resolves.toMatchObject({ status: "network_unavailable" });
      expect(postCalls).toBe(1);

      await expect(
        recoverGithubPrOpenIntents(store.db, {
          dataRoot: store.dataRoot,
          fetchImpl,
        }),
      ).resolves.toEqual({
        completed: 0,
        cancelled: 0,
        deferred: 1,
        errors: 0,
      });
      expect(postCalls).toBe(1);
      expect(
        store.db
          .prepare(
            `SELECT state, actor_user_id, actor_label
               FROM github_pr_open_intents`,
          )
          .get(),
      ).toEqual({
        state: "posting",
        actor_user_id: originalActor.userId,
        actor_label: originalActor.label,
      });
    },
  );

  it("blocks a new exact head while an older head's POST remains ambiguous", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
    });
    let postCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        postCalls += 1;
        throw new TypeError("ambiguous POST timeout");
      }
      return gh.fetchImpl(input, init);
    };
    await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { userId: store.users.murat.id, label: store.users.murat.email },
      {
        dataRoot: store.dataRoot,
        fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(postCalls).toBe(1);
    const callsBeforeNewHead = gh.calls.length;

    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          fetchImpl,
          verifiedHeadSha: "d".repeat(40),
        },
      ),
    ).resolves.toMatchObject({ status: "network_unavailable" });
    expect(postCalls).toBe(1);
    expect(gh.calls).toHaveLength(callsBeforeNewHead);
    expect(
      store.db
        .prepare(`SELECT state, head_sha FROM github_pr_open_intents`)
        .get(),
    ).toEqual({ state: "posting", head_sha: HEAD_SHA });
  });

  it.each(["cached" as const, "listed" as const])(
    "journals $source existing-PR canonical adoption before the file write",
    async (source) => {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-201", {
          title: "Attach execution workspace to task runtime",
          stage: "review",
          branch: BRANCH,
          ...(source === "cached"
            ? {
                pr: {
                  number: 61,
                  state: "review" as const,
                  title: "stale cached title",
                  headSha: HEAD_SHA,
                },
              }
            : {}),
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });
      const pat = createPat(
        store.db,
        {
          userId: store.users.arda.id,
          label: "bot",
          token: `ghp_propen_adopt_${source}`,
        },
        ACTOR,
      );
      setProjectCredential(
        store.db,
        { projectSlug: store.slug, patId: pat.id },
        ACTOR,
      );
      const live = {
        number: 61,
        html_url: "https://github.com/akin-ozer/viberr/pull/61",
        title: "[VIB-201] exact live title",
        state: "open",
        head: { sha: HEAD_SHA },
        base: BASE,
      };
      const gh = fakeGithubFetch({
        [`GET ${REPO_PATH}/pulls`]: {
          body: source === "listed" ? [live] : [],
        },
        [`GET ${REPO_PATH}/pulls/61`]: { body: live },
      });
      const originalActor = {
        userId: store.users.selin.id,
        label: store.users.selin.email,
      };
      let crashed = false;
      await expect(
        openTaskPr(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-201" },
          originalActor,
          {
            dataRoot: store.dataRoot,
            fetchImpl: gh.fetchImpl,
            verifiedHeadSha: HEAD_SHA,
            prOpenEffectHookForTests: ({ phase }) => {
              if (phase === "after_canonical" && !crashed) {
                crashed = true;
                throw new Error("injected existing-PR canonical crash");
              }
            },
          },
        ),
      ).rejects.toThrow("injected existing-PR canonical crash");
      expect(
        store.db
          .prepare(
            `SELECT state, pr_number, pr_created, actor_user_id
               FROM github_pr_open_intents`,
          )
          .get(),
      ).toEqual({
        state: "observed",
        pr_number: 61,
        pr_created: 0,
        actor_user_id: originalActor.userId,
      });
      expect(
        listAuditEvents(store.db, {}).filter(
          (event) => event.action === "github.pr.opened",
        ),
      ).toHaveLength(0);
      if (source === "listed") {
        expect(
          store.db
            .prepare(
              `SELECT pr_json FROM task_projections
                WHERE project_slug = ? AND task_key = 'VIB-201'`,
            )
            .get(store.slug),
        ).toEqual({ pr_json: null });
      }

      await expect(
        recoverGithubPrOpenIntents(store.db, {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
        }),
      ).resolves.toEqual({
        completed: 1,
        cancelled: 0,
        deferred: 0,
        errors: 0,
      });
      const audits = listAuditEvents(store.db, {}).filter(
        (event) => event.action === "github.pr.opened",
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: originalActor.userId,
        actorLabel: originalActor.label,
        details: { created: false },
      });
      expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(0);
      expect(
        JSON.parse(
          (
            store.db
              .prepare(
                `SELECT pr_json FROM task_projections
                  WHERE project_slug = ? AND task_key = 'VIB-201'`,
              )
              .get(store.slug) as { pr_json: string }
          ).pr_json,
        ),
      ).toMatchObject({ number: 61, headSha: HEAD_SHA });
    },
  );

  it("defers exact PR-open recovery without touching GitHub while the project is archived", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
    });
    let postCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        postCalls += 1;
        throw new TypeError("ambiguous POST timeout");
      }
      return gh.fetchImpl(input, init);
    };
    await openTaskPr(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-201" },
      { userId: store.users.arda.id, label: store.users.arda.email },
      {
        dataRoot: store.dataRoot,
        fetchImpl,
        verifiedHeadSha: HEAD_SHA,
      },
    );
    expect(postCalls).toBe(1);
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!.parsed;
    writeProject(store.dataRoot, {
      ...project.frontmatter,
      archived: true,
    });
    const observedCalls = gh.calls.length;

    await expect(
      recoverGithubPrOpenIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl,
      }),
    ).resolves.toEqual({
      completed: 0,
      cancelled: 0,
      deferred: 1,
      errors: 0,
    });
    expect(gh.calls).toHaveLength(observedCalls);
    expect(postCalls).toBe(1);
    expect(
      store.db.prepare(`SELECT state FROM github_pr_open_intents`).get(),
    ).toEqual({ state: "posting" });
  });

  it("recovers a crash after POST from the observed number with original attribution and no second POST", async () => {
    const store = setupWithBranch();
    const live = {
      number: 56,
      html_url: "https://github.com/akin-ozer/viberr/pull/56",
      title: "[VIB-201] Attach execution workspace to task runtime",
      state: "open",
      head: { sha: HEAD_SHA },
      base: BASE,
    };
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: { status: 201, body: live },
      [`GET ${REPO_PATH}/pulls/56`]: { body: live },
    });
    let crashed = false;
    const originalActor = {
      userId: store.users.selin.id,
      label: store.users.selin.email,
    };
    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        originalActor,
        {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
          verifiedHeadSha: HEAD_SHA,
          prOpenEffectHookForTests: ({ phase }) => {
            if (phase === "after_post" && !crashed) {
              crashed = true;
              throw new Error("injected post-POST crash");
            }
          },
        },
      ),
    ).rejects.toThrow("injected post-POST crash");
    expect(
      store.db
        .prepare(`SELECT state, pr_number FROM github_pr_open_intents`)
        .get(),
    ).toEqual({ state: "observed", pr_number: 56 });

    await expect(
      recoverGithubPrOpenIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).resolves.toEqual({ completed: 1, cancelled: 0, deferred: 0, errors: 0 });
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(1);
    const audits = listAuditEvents(store.db, {}).filter(
      (event) => event.action === "github.pr.opened",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: originalActor.userId,
      actorLabel: originalActor.label,
    });
  });

  it("converges audit exactly once after a crash following the canonical PR file write", async () => {
    const store = setupWithBranch();
    const live = {
      number: 57,
      html_url: "https://github.com/akin-ozer/viberr/pull/57",
      title: "[VIB-201] Attach execution workspace to task runtime",
      state: "open",
      head: { sha: HEAD_SHA },
      base: BASE,
    };
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: { body: [] },
      [`POST ${REPO_PATH}/pulls`]: { status: 201, body: live },
      [`GET ${REPO_PATH}/pulls/57`]: { body: live },
    });
    let crashed = false;
    await expect(
      openTaskPr(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-201" },
        { userId: store.users.arda.id, label: store.users.arda.email },
        {
          dataRoot: store.dataRoot,
          fetchImpl: gh.fetchImpl,
          verifiedHeadSha: HEAD_SHA,
          prOpenEffectHookForTests: ({ phase }) => {
            if (phase === "after_file" && !crashed) {
              crashed = true;
              throw new Error("injected post-file crash");
            }
          },
        },
      ),
    ).rejects.toThrow("injected post-file crash");
    expect(
      listAuditEvents(store.db, {}).filter(
        (event) => event.action === "github.pr.opened",
      ),
    ).toHaveLength(0);

    await expect(
      recoverGithubPrOpenIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).resolves.toEqual({ completed: 1, cancelled: 0, deferred: 0, errors: 0 });
    await expect(
      recoverGithubPrOpenIntents(store.db, {
        dataRoot: store.dataRoot,
        fetchImpl: gh.fetchImpl,
      }),
    ).resolves.toEqual({ completed: 0, cancelled: 0, deferred: 0, errors: 0 });
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-201",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(
      task.timeline.filter((event) => event.text.includes("PR #57")),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, {}).filter(
        (event) => event.action === "github.pr.opened",
      ),
    ).toHaveLength(1);
    expect(gh.callsTo(`POST ${REPO_PATH}/pulls`)).toHaveLength(1);
  });

  it("degrades cleanly when no repo/PAT is configured (no throw, typed result)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "review",
        branch: "vib-9-x",
      }),
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
