import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch, type FakeResponder } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { pollGithubReconcile } from "./reconcile-poller.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO_PATH = "/repos/akin-ozer/viberr";

/** A branched review-stage task + a bound PAT for the store's project. */
function seedBranchedTask(store: TestStore, key: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      title: "Branched task",
      stage: "review",
      branch: key.toLowerCase(),
      ownerUserId: store.users.arda.id,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_poller0001" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
}

function happyRoutes(branch: string): Record<string, FakeResponder> {
  return {
    [`GET ${REPO_PATH}/compare/main...${branch}`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO_PATH}/pulls`]: { body: [] },
  };
}

describe("pollGithubReconcile (P11-14)", () => {
  it("reconciles an active branched project WITHOUT the per-project audit (poller path)", async () => {
    const store = setupTestStore(ctx);
    seedBranchedTask(store, "VIB-1");
    const gh = fakeGithubFetch(happyRoutes("vib-1"));

    const summary = await pollGithubReconcile(store.db, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });

    expect(summary.projects).toBe(1);
    // The poller must NOT spam the audit log with a per-project summary each tick.
    const audits = listAuditEvents(store.db, {}).map((a) => a.action);
    expect(audits).not.toContain("github.reconcile.project");
  });

  it("skips an ARCHIVED project", async () => {
    const store = setupTestStore(ctx);
    seedBranchedTask(store, "VIB-1");
    // Archive the project.
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
      .frontmatter;
    writeProject(store.dataRoot, { ...fm, archived: true });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const gh = fakeGithubFetch(happyRoutes("vib-1"));
    const summary = await pollGithubReconcile(store.db, {
      dataRoot: store.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(summary.projects).toBe(0); // archived → not polled
  });

  it("skips a project with no branched tasks", async () => {
    const store = setupTestStore(ctx);
    // A task with NO branch.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", branch: null }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const summary = await pollGithubReconcile(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(0);
  });
});
