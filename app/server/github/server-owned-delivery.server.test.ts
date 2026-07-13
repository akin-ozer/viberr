import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";
import {
  deliverSpecialistWorkspace,
  type DeliveryExec,
} from "./server-owned-delivery.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
const ACTOR = { userId: "u_admin", label: "admin@test" };
const BRANCH = "atl-3-deliver-feature";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function setup() {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("ATL-3", {
      title: "Deliver feature",
      stage: "impl",
    }),
    goal: "Deliver the feature.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  const workdir = ctx.makeTempDir();
  mkdirSync(path.join(workdir, ".git"), { recursive: true });
  return { store, workdir };
}

function execFixture(
  input: {
    branch?: string;
    commits?: string;
    dirty?: string;
    pushOk?: boolean;
    token?: string;
    sha?: string;
  } = {},
): {
  exec: DeliveryExec;
  calls: Array<{ args: string[]; token: string | null }>;
} {
  const calls: Array<{ args: string[]; token: string | null }> = [];
  const exec: DeliveryExec = async (_file, args, options) => {
    calls.push({
      args,
      token: options.env?.VIBERR_GIT_ASKPASS_PASSWORD ?? null,
    });
    if (args.includes("--abbrev-ref")) {
      return { ok: true, stdout: `${input.branch ?? BRANCH}\n` };
    }
    if (args.includes("--porcelain")) {
      return { ok: true, stdout: input.dirty ?? "" };
    }
    if (args.some((arg) => arg.startsWith("--format="))) {
      return {
        ok: true,
        stdout: input.commits ?? `0123456\t[ATL-3] Deliver feature\n`,
      };
    }
    if (args.at(-1) === "HEAD") {
      return { ok: true, stdout: `${input.sha ?? SHA}\n` };
    }
    if (args.includes("push")) {
      return input.pushOk === false
        ? { ok: false, reason: "failed" }
        : { ok: true, stdout: "" };
    }
    if (args.includes("--is-shallow-repository")) {
      return { ok: true, stdout: "false\n" };
    }
    if (args.includes("rev-parse")) {
      return { ok: true, stdout: `${input.branch ?? BRANCH}\n` };
    }
    if (args.includes("log")) {
      return { ok: true, stdout: "0123456 [ATL-3] Deliver feature\n" };
    }
    return { ok: true, stdout: "" };
  };
  return { exec, calls };
}

function githubFetch(): typeof fetch {
  return (async (raw, init) => {
    const url = new URL(String(raw));
    const method = init?.method ?? "GET";
    if (url.pathname.includes("/git/ref/")) {
      return Response.json({ object: { sha: SHA } });
    }
    if (url.pathname.includes("/compare/")) {
      return Response.json({
        ahead_by: 1,
        behind_by: 0,
        status: "ahead",
        commits: [{ sha: SHA, commit: { message: "[ATL-3] Deliver feature" } }],
      });
    }
    if (url.pathname.endsWith("/pulls") && method === "GET") {
      return Response.json([]);
    }
    if (url.pathname.endsWith("/pulls") && method === "POST") {
      return Response.json(
        {
          number: 42,
          html_url: "https://github.com/akin-ozer/viberr/pull/42",
          title: "[ATL-3] Deliver feature",
          state: "open",
          head: { sha: SHA },
          base: {
            ref: "main",
            repo: { full_name: "akin-ozer/viberr" },
          },
        },
        { status: 201 },
      );
    }
    if (url.pathname.endsWith("/pulls/42") && method === "GET") {
      return Response.json({
        number: 42,
        html_url: "https://github.com/akin-ozer/viberr/pull/42",
        title: "[ATL-3] Deliver feature",
        state: "open",
        head: { sha: SHA },
        base: {
          ref: "main",
          repo: { full_name: "akin-ozer/viberr" },
        },
      });
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  }) as typeof fetch;
}

describe("deliverSpecialistWorkspace", () => {
  it("pushes with server-only askpass, verifies exact remote HEAD/diff, and opens the PR", async () => {
    const { store, workdir } = setup();
    const token = "github_pat_SERVER_ONLY_123";
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "delivery", token },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const { exec, calls } = execFixture();
    const result = await deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "claude",
        role: "Developer",
        permissions: { canBranch: true, canCommitPush: true, canOpenPr: true },
        dataRoot: store.dataRoot,
      },
      { exec, fetchImpl: githubFetch() },
    );
    expect(result).toEqual({
      status: "delivered",
      branch: BRANCH,
      remoteSha: SHA,
      prNumber: 42,
    });
    const push = calls.find((call) => call.args.includes("push"))!;
    expect(push.args.join(" ")).not.toContain(token);
    expect(push.token).toBe(token);
    expect(
      calls.filter((call) => call.token !== null).map((call) => call.args),
    ).toEqual([push.args]);

    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "ATL-3",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.branch).toBe(BRANCH);
    expect(task.frontmatter.pr).toMatchObject({
      number: 42,
      state: "review",
      headSha: SHA,
    });
    expect(JSON.stringify(task)).not.toContain(token);
    expect(
      listAuditEvents(store.db, { action: "github.workspace.branch_pushed" }),
    ).toHaveLength(1);
  });

  it("recovers the full-SHA delivery audit after a crash behind the canonical event", async () => {
    const { store, workdir } = setup();
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "delivery",
        token: "github_pat_DELIVERY_RECOVERY",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const { exec } = execFixture();
    const input = {
      projectSlug: store.slug,
      taskKey: "ATL-3",
      workdir,
      backend: "claude" as const,
      role: "Developer",
      permissions: {
        canBranch: true,
        canCommitPush: true,
        canOpenPr: false,
      },
      dataRoot: store.dataRoot,
    };

    await expect(
      deliverSpecialistWorkspace(
        store.db,
        {
          ...input,
          afterDeliveryCanonicalHookForTests: () => {
            throw new Error("injected post-delivery crash");
          },
        },
        { exec, fetchImpl: githubFetch() },
      ),
    ).rejects.toThrow("injected post-delivery crash");
    expect(
      listAuditEvents(store.db, {
        action: "github.workspace.branch_pushed",
      }),
    ).toHaveLength(0);

    await expect(
      deliverSpecialistWorkspace(store.db, input, {
        exec,
        fetchImpl: githubFetch(),
      }),
    ).resolves.toMatchObject({ status: "delivered", remoteSha: SHA });

    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "ATL-3",
      dataRoot: store.dataRoot,
    })!.parsed;
    const deliveryEvents = task.timeline.filter(
      (event) =>
        event.sourceIntentId ===
        `github-delivery:${task.frontmatter.createdAt}:${SHA}`,
    );
    expect(deliveryEvents).toHaveLength(1);
    const audits = listAuditEvents(store.db, {
      action: "github.workspace.branch_pushed",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details).toMatchObject({
      remoteSha: SHA,
      taskIncarnation: task.frontmatter.createdAt,
      sourceIntentId: `github-delivery:${task.frontmatter.createdAt}:${SHA}`,
    });
  });

  it("aborts an in-flight PR create when project ownership is revoked", async () => {
    const { store, workdir } = setup();
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "delivery",
        token: "github_pat_ABORT_PR_CREATE",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const controller = new AbortController();
    let enteredPost!: () => void;
    const postStarted = new Promise<void>((resolve) => {
      enteredPost = resolve;
    });
    const fetchImpl: typeof fetch = (async (raw, init) => {
      const url = new URL(String(raw));
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/git/ref/")) {
        return Response.json({ object: { sha: SHA } });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json({
          ahead_by: 1,
          behind_by: 0,
          status: "ahead",
          commits: [
            { sha: SHA, commit: { message: "[ATL-3] Deliver feature" } },
          ],
        });
      }
      if (url.pathname.endsWith("/pulls") && method === "GET") {
        return Response.json([]);
      }
      if (url.pathname.endsWith("/pulls") && method === "POST") {
        enteredPost();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const { exec } = execFixture();
    const delivery = deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "claude",
        role: "Developer",
        permissions: { canBranch: true, canCommitPush: true, canOpenPr: true },
        dataRoot: store.dataRoot,
        signal: controller.signal,
      },
      { exec, fetchImpl },
    );
    await postStarted;
    controller.abort();
    await expect(delivery).rejects.toMatchObject({ name: "AbortError" });
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "ATL-3",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr,
    ).toBeNull();
  });

  it("refreshes the canonical full head when redelivering the same PR", async () => {
    const { store, workdir } = setup();
    const nextSha = "f".repeat(40);
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        dataRoot: store.dataRoot,
      },
      (parsed) => {
        parsed.frontmatter.branch = BRANCH;
        parsed.frontmatter.pr = {
          number: 42,
          state: "review",
          title: "[ATL-3] Deliver feature",
          headSha: SHA,
        };
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "delivery",
        token: "github_pat_SERVER_ONLY_REDELIVERY",
      },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const { exec } = execFixture({ sha: nextSha });
    const fetchImpl: typeof fetch = (async (raw, init) => {
      const url = new URL(String(raw));
      const method = init?.method ?? "GET";
      if (url.pathname.includes("/git/ref/")) {
        return Response.json({ object: { sha: nextSha } });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json({
          ahead_by: 2,
          behind_by: 0,
          status: "ahead",
          commits: [
            { sha: SHA, commit: { message: "[ATL-3] Deliver feature" } },
            { sha: nextSha, commit: { message: "[ATL-3] Fix review" } },
          ],
        });
      }
      if (url.pathname.endsWith("/pulls/42") && method === "GET") {
        return Response.json({
          number: 42,
          html_url: "https://github.com/akin-ozer/viberr/pull/42",
          title: "[ATL-3] Deliver feature",
          state: "open",
          head: { sha: nextSha },
          base: {
            ref: "main",
            repo: { full_name: "akin-ozer/viberr" },
          },
        });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }) as typeof fetch;

    const result = await deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "codex",
        role: "Developer",
        permissions: { canBranch: true, canCommitPush: true, canOpenPr: true },
        dataRoot: store.dataRoot,
      },
      { exec, fetchImpl },
    );

    expect(result).toMatchObject({ status: "delivered", remoteSha: nextSha });
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "ATL-3",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.pr?.headSha,
    ).toBe(nextSha);
  });

  it("fails before push when local changes are uncommitted", async () => {
    const { store, workdir } = setup();
    const { exec, calls } = execFixture({ commits: "", dirty: " M app.ts\n" });
    const result = await deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "codex",
        role: "Developer",
        permissions: { canBranch: true, canCommitPush: true, canOpenPr: true },
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "uncommitted_changes",
    });
    expect(calls.some((call) => call.args.includes("push"))).toBe(false);
  });

  it("does not push when delivery is withheld by policy", async () => {
    const { store, workdir } = setup();
    const { exec, calls } = execFixture();
    const result = await deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "claude",
        role: "Reviewer",
        permissions: {
          canBranch: false,
          canCommitPush: false,
          canOpenPr: false,
        },
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result.status).toBe("withheld");
    expect(calls).toHaveLength(0);
  });

  it("returns a secret-free recovery result when authenticated push fails", async () => {
    const { store, workdir } = setup();
    const token = "github_pat_NEVER_LEAK_456";
    const pat = createPat(
      store.db,
      { userId: store.users.arda.id, label: "delivery", token },
      ACTOR,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      ACTOR,
    );
    const { exec } = execFixture({ pushOk: false });
    const result = await deliverSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-3",
        workdir,
        backend: "claude",
        role: "Developer",
        permissions: { canBranch: true, canCommitPush: true, canOpenPr: true },
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({ status: "failed", code: "push_failed" });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
