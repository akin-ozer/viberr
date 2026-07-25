import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import {
  fakeGithubFetch,
  unreachableFetch,
  type FakeResponder,
} from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { deleteTaskRemoteBranch, reconcileTask } from "./github-reconciler.server";

/**
 * The pr-diverged coordination seam: an out-of-band PR transition detected by
 * the reconciler must WAKE the task's operator (so the prose divergence turns
 * into a real decision packet), and the healing transition (a closed PR going
 * live again) must both leave a note and wake the operator to withdraw the
 * moot packet. Plus deleteTaskRemoteBranch — the discard half of the
 * archive_task + deleteBranch packet option.
 */

// Observe the exact trigger without spawning any real operator runtime. The
// spread keeps every other task-actions export (notifyTaskWatchers etc.) real.
vi.mock("~/server/tasks/task-actions.server", async (importOriginal) => {
  const mod = await importOriginal<
    typeof import("~/server/tasks/task-actions.server")
  >();
  return { ...mod, autoInvokeOperator: vi.fn(async () => {}) };
});
import { autoInvokeOperator } from "~/server/tasks/task-actions.server";
const invoked = vi.mocked(autoInvokeOperator);

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
beforeEach(() => invoked.mockClear());

const REPO_PATH = "/repos/akin-ozer/viberr";
const BRANCH = "vib-301-workspace";

function setup(
  fmPatch: Parameters<typeof baseTaskFrontmatter>[1] = {},
): { store: TestStore; actor: { userId: string; label: string } } {
  const store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-301", {
      title: "Attach execution workspace",
      stage: "review",
      branch: BRANCH,
      ownerUserId: store.users.arda.id,
      ...fmPatch,
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "bot", token: "ghp_divergence01" },
    actor,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
  return { store, actor };
}

function routesWithPr(pr: {
  number: number;
  state: "open" | "closed";
  merged: boolean;
}): Record<string, FakeResponder> {
  return {
    [`GET ${REPO_PATH}/compare/main...${BRANCH}`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: pr.number,
          title: "Attach execution workspace",
          state: pr.state,
          draft: false,
          merged_at: pr.merged ? "2026-07-25T09:00:00Z" : null,
          head: { sha: "headsha" },
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/${pr.number}`]: {
      body: {
        number: pr.number,
        title: "Attach execution workspace",
        state: pr.state,
        merged: pr.merged,
        merged_at: pr.merged ? "2026-07-25T09:00:00Z" : null,
        head: { sha: "headsha" },
        additions: 1,
        deletions: 0,
        changed_files: 1,
      },
    },
  };
}

async function reconcile(
  store: TestStore,
  actor: { userId: string; label: string },
  routes: Record<string, FakeResponder>,
) {
  return reconcileTask(
    store.db,
    { projectSlug: store.slug, taskKey: "VIB-301" },
    actor,
    { dataRoot: store.dataRoot, fetchImpl: fakeGithubFetch(routes).fetchImpl },
  );
}

describe("pr-diverged wakes the operator", () => {
  it("closed-but-active: fires ONCE on the transition, not on later reconciles", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const routes = routesWithPr({ number: 318, state: "closed", merged: false });
    await reconcile(store, actor, routes);
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(invoked.mock.calls[0]![2]).toBe(store.slug);
    expect(invoked.mock.calls[0]![3]).toBe("VIB-301");
    expect(invoked.mock.calls[0]![4]).toBe("pr-diverged");

    // A persistent divergence is not a new event — no second wake-up.
    await reconcile(store, actor, routes);
    expect(invoked).toHaveBeenCalledTimes(1);
  });

  it("merged-but-not-done fires the trigger too", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 318, state: "closed", merged: true }));
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(invoked.mock.calls[0]![4]).toBe("pr-diverged");
  });

  it("accepted-then-closed (task already Done) fires the trigger", async () => {
    const { store, actor } = setup({
      stage: "done",
      pr: { number: 318, state: "accepted", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 318, state: "closed", merged: false }));
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(invoked.mock.calls[0]![4]).toBe("pr-diverged");
  });

  it("an unchanged happy-path reconcile never wakes the operator", async () => {
    const { store, actor } = setup();
    const routes = routesWithPr({ number: 318, state: "open", merged: false });
    await reconcile(store, actor, routes); // review PR appears (a normal linking)
    await reconcile(store, actor, routes); // steady state
    expect(invoked).not.toHaveBeenCalled();
  });
});

describe("the healing transition — a closed PR goes live again", () => {
  it("same PR reopened: note + policy notification + operator wake", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 318, state: "open", merged: false }));

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 318, state: "review" });

    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(
      events.some((e) => /PR #318 was reopened on GitHub/.test(e.text)),
    ).toBe(true);

    const notifs = listNotifications(store.db, store.users.arda.id);
    expect(notifs.some((n) => n.kind === "policy" && /live again/.test(n.title ?? ""))).toBe(true);

    expect(invoked).toHaveBeenCalledTimes(1);
    expect(invoked.mock.calls[0]![4]).toBe("pr-diverged");
  });

  it("a FRESH PR replacing the closed one is announced as a replacement", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 999, state: "open", merged: false }));
    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(
      events.some((e) =>
        /PR #999 now tracks VIB-301's branch on GitHub, replacing closed PR #318/.test(e.text),
      ),
    ).toBe(true);
    expect(invoked).toHaveBeenCalledTimes(1);
  });
});

describe("deleteTaskRemoteBranch (archive_task + deleteBranch)", () => {
  it("deletes the ref, writes the github event, records the audit", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    const fake = fakeGithubFetch({
      [`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`]: { status: 204 },
    });
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toEqual({ status: "deleted", branch: BRANCH });
    expect(fake.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`)).toHaveLength(1);

    const events = store.db
      .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
      .all() as { text: string }[];
    expect(events.some((e) => e.text === `Deleted branch \`${BRANCH}\` from GitHub.`)).toBe(true);
    expect(
      listAuditEvents(store.db, { action: "github.branch.deleted" }),
    ).toHaveLength(1);
  });

  it("refuses while the PR is still open — deleting the head would close it silently", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const fake = fakeGithubFetch({});
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toMatchObject({ status: "refused" });
    expect((result as { message: string }).message).toMatch(/PR #318 is still open/);
    expect(fake.calls).toHaveLength(0); // refused BEFORE any GitHub write
  });

  it("never deletes the project's default branch", async () => {
    const { store, actor } = setup({ branch: "main" });
    const fake = fakeGithubFetch({});
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toMatchObject({ status: "refused" });
    expect((result as { message: string }).message).toMatch(/default branch/);
    expect(fake.calls).toHaveLength(0);
  });

  it("422 'Reference does not exist' reports already_gone (honest, not an error)", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    const fake = fakeGithubFetch({
      [`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`]: {
        status: 422,
        body: { message: "Reference does not exist" },
      },
    });
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toEqual({ status: "already_gone", branch: BRANCH });
  });

  it("degrades typed on an unreachable GitHub", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: unreachableFetch() },
    );
    expect(result).toMatchObject({ status: "refused" });
    expect((result as { message: string }).message).toMatch(/unreachable/);
  });
});
