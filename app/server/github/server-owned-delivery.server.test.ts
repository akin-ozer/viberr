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
import { readTaskFile } from "~/server/files/task-writer.server";
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

function execFixture(input: {
  branch?: string;
  commits?: string;
  dirty?: string;
  pushOk?: boolean;
  token?: string;
} = {}): { exec: DeliveryExec; calls: Array<{ args: string[]; token: string | null }> } {
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
      return { ok: true, stdout: input.commits ?? `0123456\t[ATL-3] Deliver feature\n` };
    }
    if (args.at(-1) === "HEAD") return { ok: true, stdout: `${SHA}\n` };
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
        { number: 42, html_url: "https://github.com/akin-ozer/viberr/pull/42", title: "[ATL-3] Deliver feature", state: "open" },
        { status: 201 },
      );
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
    expect(task.frontmatter.pr).toMatchObject({ number: 42, state: "review" });
    expect(JSON.stringify(task)).not.toContain(token);
    expect(
      listAuditEvents(store.db, { action: "github.workspace.branch_pushed" }),
    ).toHaveLength(1);
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
    expect(result).toMatchObject({ status: "failed", code: "uncommitted_changes" });
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
        permissions: { canBranch: false, canCommitPush: false, canOpenPr: false },
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
