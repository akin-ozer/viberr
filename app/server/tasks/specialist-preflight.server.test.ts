import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { taskDir } from "~/server/files/file-store-root.server";
import {
  preflightSpecialistWorkspace,
  repositoryWorkspaceKey,
  workspaceNamespaceKey,
  type PreflightExec,
} from "./specialist-preflight.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("preflightSpecialistWorkspace", () => {
  it("keys workspaces by full repository identity, not basename", () => {
    expect(repositoryWorkspaceKey("acme/web")).not.toBe(
      repositoryWorkspaceKey("fork/web"),
    );
    expect(workspaceNamespaceKey("../../reviewer/a")).toBe("..-..-reviewer-a");
  });

  it("blocks a real specialist when no repository is configured", async () => {
    const store = setupTestStore(ctx);
    await expect(
      preflightSpecialistWorkspace(store.db, {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: null,
        dataRoot: store.dataRoot,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      code: "repository_not_configured",
    });
  });

  it("returns only a verified cloned Git worktree and disposes auth material", async () => {
    const store = setupTestStore(ctx);
    let sawAskpass = false;
    const exec: PreflightExec = async (_file, args, options) => {
      if (args[0] === "clone") {
        sawAskpass = Boolean(options.env?.GIT_ASKPASS);
        const destination = args.at(-1)!;
        mkdirSync(path.join(destination, ".git"), { recursive: true });
        return { ok: true, stdout: "" };
      }
      if (args.includes("--is-inside-work-tree")) {
        return { ok: true, stdout: "true\n" };
      }
      return { ok: false, reason: "failed" };
    };

    const result = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "akin-ozer/viberr",
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({ status: "ready", reused: false });
    // The test store has no project PAT, so the public-clone path has no askpass.
    expect(sawAskpass).toBe(false);
  });

  it("prepares a distinct verified workspace for each assigned reviewer", async () => {
    const store = setupTestStore(ctx);
    const exec: PreflightExec = async (_file, args) => {
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        mkdirSync(path.join(destination, ".git"), { recursive: true });
        return { ok: true, stdout: "" };
      }
      if (args.includes("--is-inside-work-tree")) {
        return { ok: true, stdout: "true\n" };
      }
      return { ok: true, stdout: "" };
    };

    const first = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "akin-ozer/viberr",
        workspaceKey: "reviewer-a",
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    const second = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "akin-ozer/viberr",
        workspaceKey: "reviewer-b",
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(first.workdir).not.toBe(second.workdir);
    expect(first.workdir).toContain(`${path.sep}reviewer-a${path.sep}`);
    expect(second.workdir).toContain(`${path.sep}reviewer-b${path.sep}`);
  });

  it("authenticates an exact reviewer branch fetch and verifies its head", async () => {
    const store = setupTestStore(ctx);
    const actor = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "Private review checkout",
        token: "ghp_private_review_fixture",
      },
      actor,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      actor,
    );
    const headSha = "b".repeat(40);
    let fetchedArgs: string[] | null = null;
    let fetchAuthenticated = false;
    const exec: PreflightExec = async (_file, args, options) => {
      if (args[0] === "clone") {
        mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
        return { ok: true, stdout: "" };
      }
      if (args.includes("--is-inside-work-tree")) {
        return { ok: true, stdout: "true\n" };
      }
      if (args.includes("fetch")) {
        fetchedArgs = args;
        fetchAuthenticated = Boolean(options.env?.GIT_ASKPASS);
        return { ok: true, stdout: "" };
      }
      if (args.includes("checkout")) return { ok: true, stdout: "" };
      if (args.at(-1) === "HEAD") return { ok: true, stdout: `${headSha}\n` };
      return { ok: false, reason: "failed" };
    };

    const result = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "private/repository",
        workspaceKey: "reviewer-a",
        checkoutRef: "atl-1-governed-change",
        expectedHeadSha: headSha,
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({ status: "ready", headSha });
    expect(fetchedArgs).toEqual(
      expect.arrayContaining([
        "fetch",
        "--depth",
        "1",
        "origin",
        "refs/heads/atl-1-governed-change",
      ]),
    );
    expect(fetchAuthenticated).toBe(true);
  });

  it("classifies a failed unauthenticated checkout without leaking diagnostics", async () => {
    const store = setupTestStore(ctx);
    const secret = "github_pat_NEVER_REPORT_ME";
    const exec: PreflightExec = async () => ({
      ok: false,
      reason: "failed",
      code: 128,
    });
    const result = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "private/repo",
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({
      status: "blocked",
      code: "checkout_auth_or_access_required",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects an existing .git marker unless git verifies the worktree", async () => {
    const store = setupTestStore(ctx);
    const dir = path.join(
      taskDir(store.slug, "ATL-1", store.dataRoot),
      "workspace",
      repositoryWorkspaceKey("akin-ozer/viberr"),
      ".git",
    );
    mkdirSync(dir, { recursive: true });
    const exec: PreflightExec = async (_file, args) =>
      args.includes("remote.origin.url")
        ? { ok: true, stdout: "" }
        : { ok: false, reason: "failed" };
    const result = await preflightSpecialistWorkspace(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "ATL-1",
        repo: "akin-ozer/viberr",
        dataRoot: store.dataRoot,
      },
      { exec },
    );
    expect(result).toMatchObject({
      status: "blocked",
      code: "checkout_invalid",
    });
  });
});
