import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { findOpenScopeViolation } from "~/server/projections/policy-violations.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { composePrBody, openTaskPr, taskUrl } from "./pr-open.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";
const ACTOR = { userId: "u_test", label: "arda@viberr.test" };
const BRANCH = "vib-201-attach-execution-workspace-to";

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
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);
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
    const sent = post.body as { title: string; head: string; base: string; body: string };
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

  it("is idempotent — reuses an existing open PR instead of creating a duplicate", async () => {
    const store = setupWithBranch();
    const gh = fakeGithubFetch({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [{ number: 7, html_url: "https://github.com/akin-ozer/viberr/pull/7", title: "[VIB-201] x", state: "open" }],
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
      { userId: store.users.arda.id, label: "bot", token: "ghp_propen00000004" },
      ACTOR,
    );
    setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, ACTOR);

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
    expect(fm.pr).toMatchObject({ number: 43, state: "review" });
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
