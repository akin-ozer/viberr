import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
import { resolvePacket } from "~/server/tasks/task-actions.server";
import type { TaskPacket } from "~/schemas/task-file.schema";
import { listNotifications } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import {
  deleteTaskRemoteBranch,
  reconcileTask,
  type OperatorWake,
} from "./github-reconciler.server";

/**
 * The pr-diverged coordination seam: an out-of-band PR transition detected by
 * the reconciler must WAKE the task's operator (so the prose divergence turns
 * into a real decision packet), and the healing transition (a closed PR going
 * live again) must both leave a note and wake the operator to withdraw the
 * moot packet. Plus deleteTaskRemoteBranch — the discard half of the
 * archive_task + deleteBranch packet option.
 */

/** One recorded wake: the arguments the reconciler passed the operator. */
interface OperatorWakeCall {
  projectSlug: string;
  taskKey: string;
  trigger: "pr-diverged";
}

/**
 * The reconciler's own `wakeOperator` hook, so the exact trigger is observed
 * without spawning a real operator runtime — and without displacing any other
 * task-actions behaviour these tests rely on.
 */
const invoked: OperatorWakeCall[] = [];
const wakeOperator: OperatorWake = async (
  _db,
  _ctx,
  projectSlug,
  taskKey,
  trigger,
) => {
  invoked.push({ projectSlug, taskKey, trigger });
};

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
beforeEach(() => {
  invoked.length = 0;
});

type FakeRoutes = Parameters<typeof fakeGithubFetch>[0];
const REPO_PATH = "/repos/akin-ozer/viberr";
const BRANCH = "vib-301-workspace";

function setup(fmPatch: Parameters<typeof baseTaskFrontmatter>[1] = {}) {
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
}) {
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
  } satisfies Record<string, FakeResponder>;
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
    {
      dataRoot: store.dataRoot,
      fetchImpl: fakeGithubFetch(routes).fetchImpl,
      wakeOperator,
    },
  );
}

/** `.all()` hands back untyped SQLite cells, so the event rows are parsed on read. */
const eventTextRows = z.array(z.object({ text: z.string() }));

/**
 * A branch deletion answers on one of several members and only the refusals
 * carry a sentence, so the message is read through that narrowing — a member
 * that carries none answers `undefined` and fails its assertion, rather than
 * being asserted into existence.
 */
function refusalMessage(
  result: Awaited<ReturnType<typeof deleteTaskRemoteBranch>>,
): string | undefined {
  return "message" in result ? result.message : undefined;
}

describe("pr-diverged wakes the operator", () => {
  it("closed-but-active: fires ONCE on the transition, not on later reconciles", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const routes = routesWithPr({ number: 318, state: "closed", merged: false });
    await reconcile(store, actor, routes);
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.projectSlug).toBe(store.slug);
    expect(invoked[0]!.taskKey).toBe("VIB-301");
    expect(invoked[0]!.trigger).toBe("pr-diverged");

    // A persistent divergence is not a new event — no second wake-up.
    await reconcile(store, actor, routes);
    expect(invoked).toHaveLength(1);
  });

  it("merged-but-not-done fires the trigger too", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 318, state: "closed", merged: true }));
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.trigger).toBe("pr-diverged");
  });

  it("accepted-then-closed (task already Done) fires the trigger", async () => {
    const { store, actor } = setup({
      stage: "done",
      pr: { number: 318, state: "accepted", title: "Attach execution workspace" },
    });
    await reconcile(store, actor, routesWithPr({ number: 318, state: "closed", merged: false }));
    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.trigger).toBe("pr-diverged");
  });

  it("an unchanged happy-path reconcile never wakes the operator", async () => {
    const { store, actor } = setup();
    const routes = routesWithPr({ number: 318, state: "open", merged: false });
    await reconcile(store, actor, routes); // review PR appears (a normal linking)
    await reconcile(store, actor, routes); // steady state
    expect(invoked).toHaveLength(0);
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

    const events = eventTextRows.parse(
      store.db
        .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
        .all(),
    );
    expect(
      events.some((e) => /PR #318 was reopened on GitHub/.test(e.text)),
    ).toBe(true);

    const notifs = listNotifications(store.db, store.users.arda.id);
    expect(notifs.some((n) => n.kind === "policy" && /live again/.test(n.title ?? ""))).toBe(true);

    expect(invoked).toHaveLength(1);
    expect(invoked[0]!.trigger).toBe("pr-diverged");
  });

  it("a FRESH PR replacing the closed one is announced as a replacement", async () => {
    // R16-1: healing means a human closed OUR PR and opened another over the
    // SAME delivered revision — so the replacement is adopted only because its
    // head IS `workRevision.headSha`. Drop the revision and #999 is a stranger.
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
      workRevision: {
        id: "rev_1",
        headSha: "headsha",
        treeSha: null,
        branch: BRANCH,
        createdAt: "2026-07-25T08:00:00.000Z",
        sourceProfileId: "developer",
      },
    });
    await reconcile(store, actor, routesWithPr({ number: 999, state: "open", merged: false }));
    const events = eventTextRows.parse(
      store.db
        .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
        .all(),
    );
    expect(
      events.some((e) =>
        /PR #999 now tracks VIB-301's branch on GitHub, replacing closed PR #318/.test(e.text),
      ),
    ).toBe(true);
    expect(invoked).toHaveLength(1);
  });

  it("R16-1: a DIFFERENT open PR whose head is not the delivered revision does not heal anything", async () => {
    // The healing branch is the one door through which a task adopts a PR it
    // did not open. Before R16-1 it opened on the branch NAME, so any stranger
    // that appeared on `vib-301-workspace` after our PR closed replaced it —
    // and the closed-PR block lifted on somebody else's work.
    const { store, actor } = setup({
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
      workRevision: {
        id: "rev_1",
        headSha: "the-delivered-sha",
        treeSha: null,
        branch: BRANCH,
        createdAt: "2026-07-25T08:00:00.000Z",
        sourceProfileId: "developer",
      },
    });
    await reconcile(store, actor, routesWithPr({ number: 999, state: "open", merged: false }));

    const fm = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-301",
      dataRoot: store.dataRoot,
    })!.parsed.frontmatter;
    expect(fm.pr).toMatchObject({ number: 318, state: "closed" });

    const events = eventTextRows.parse(
      store.db
        .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
        .all(),
    );
    expect(events.some((e) => /replacing closed PR #318/.test(e.text))).toBe(false);
    const collision = events.find((e) => /Branch name collision/.test(e.text));
    expect(collision, "the stranger is reported as a collision").toBeTruthy();
    expect(collision!.text).toContain("#999");
    expect(collision!.text).toContain("the-del"); // the delivered sha, abbreviated
    expect(invoked).toHaveLength(0);
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

    const events = eventTextRows.parse(
      store.db
        .prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`)
        .all(),
    );
    expect(events.some((e) => e.text === `Deleted branch \`${BRANCH}\` from GitHub.`)).toBe(true);
    expect(
      listAuditEvents(store.db, { action: "github.branch.deleted" }),
    ).toHaveLength(1);
  });

  it("refuses while the PR is still open — deleting the head would close it silently", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    // Ruling 136(c): the refusal is CONFIRMED against GitHub, which reports
    // the PR still open; nothing is written.
    const fake = fakeGithubFetch(livePrRoutes("open"));
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toMatchObject({ status: "refused", reason: "own_pr_open", prNumber: 318 });
    expect(refusalMessage(result)).toMatch(/PR #318 is still open/);
    expect(fake.calls.filter((c) => c.method !== "GET")).toHaveLength(0); // refused BEFORE any GitHub write
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
    expect(refusalMessage(result)).toMatch(/default branch/);
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
    expect(refusalMessage(result)).toMatch(/unreachable/);
  });

  it("B11: URL-encodes the branch — an exotic name addresses its OWN ref, not a different one", async () => {
    // The branch was interpolated raw, so anything outside the `vib-142` shape
    // built a different URL than the ref it meant. `/` stays a separator
    // (`feature/x` is a legal branch and `refs/heads/feature/x` is its path);
    // every other unsafe character is encoded.
    // Canary: drop the encoding and the DELETE lands on an unencoded path.
    const branch = "feature/fix #42 (draft)";
    const { store, actor } = setup({
      branch,
      pr: { number: 318, state: "closed", title: "Attach execution workspace" },
    });
    const encodedPath = `${REPO_PATH}/git/refs/heads/feature/fix%20%2342%20(draft)`;
    const fake = fakeGithubFetch({ [`DELETE ${encodedPath}`]: { status: 204 } });
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toEqual({ status: "deleted", branch });
    expect(fake.callsTo(`DELETE ${encodedPath}`)).toHaveLength(1);
  });
});

/** Ruling 136(c): the reads the in-ceremony re-confirm makes, for a PR GitHub
 *  reports `open` or `closed`. */
function livePrRoutes(state: "open" | "closed"): FakeRoutes {
  const pr = {
    number: 318,
    title: "Attach execution workspace",
    state,
    draft: false,
    merged: false,
    merged_at: null,
    head: { sha: "headsha318" },
    additions: 1,
    deletions: 0,
    changed_files: 1,
  };
  return {
    [`GET ${REPO_PATH}/compare/main...${BRANCH}`]: {
      body: { ahead_by: 1, behind_by: 0, status: "ahead", commits: [] },
    },
    [`GET ${REPO_PATH}/pulls`]: { body: [pr] },
    [`GET ${REPO_PATH}/pulls/318`]: { body: pr },
    [`GET ${REPO_PATH}/commits/headsha318/check-runs`]: { body: { total_count: 0, check_runs: [] } },
    [`GET ${REPO_PATH}/branches/${BRANCH}`]: { body: { commit: { sha: "headsha318" } } },
    [`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`]: { status: 204 },
  };
}

/**
 * Ruling 136(c) (pass 34, F34-10/F34-11): every remote-branch delete
 * re-confirms a cached open PR against GitHub before it can refuse, fails
 * closed on an unconfirmed state, and runs that pass with the divergence
 * notification and the operator wake suppressed. Canaries: decide from the
 * cache (the closed-on-GitHub case refuses); delete regardless (the
 * still-open case deletes); proceed when the reconcile fails (the
 * unreachable case deletes); pass `ctx` through unchanged (the wake fires).
 */
describe("ruling 136(c): the delete re-confirms a cached open PR", () => {
  it("a cached open PR that GitHub reports CLOSED is re-confirmed and the ref deleted", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const fake = fakeGithubFetch(livePrRoutes("closed"));
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toEqual({ status: "deleted", branch: BRANCH });
    expect(fake.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`)).toHaveLength(1);
    const fm = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter;
    expect(fm.pr?.state).toBe("closed");
  });

  it("GitHub unreachable refuses as `unconfirmed` with no DELETE", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const routes = livePrRoutes("closed");
    routes[`GET ${REPO_PATH}/compare/main...${BRANCH}`] = { status: 500, body: { message: "boom" } };
    const fake = fakeGithubFetch(routes);
    const result = await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(result).toMatchObject({ status: "refused", reason: "unconfirmed", prNumber: 318 });
    expect(refusalMessage(result)).toMatch(/could not confirm whether PR #318 is still open/);
    expect(fake.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`)).toHaveLength(0);
  });

  it("the in-ceremony reconcile fires no member notification and no operator wake, but the record still lands", async () => {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const wakes: string[] = [];
    const spy: OperatorWake = async (_db, _ctx, _slug, taskKey) => {
      wakes.push(taskKey);
    };
    const fake = fakeGithubFetch(livePrRoutes("closed"));
    await deleteTaskRemoteBranch(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301" },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl, wakeOperator: spy },
    );
    expect(wakes).toEqual([]);
    for (const user of Object.values(store.users)) {
      expect(
        listNotifications(store.db, user.id).filter((n) => n.kind === "policy"),
        user.email,
      ).toEqual([]);
    }
    // The timeline note about the closure is a true record and stays.
    const events = eventTextRows.parse(
      store.db.prepare(`SELECT text FROM task_events WHERE task_key = 'VIB-301'`).all(),
    );
    expect(events.some((e) => /closed on GitHub/i.test(e.text))).toBe(true);
    expect(events.some((e) => e.text === `Deleted branch \`${BRANCH}\` from GitHub.`)).toBe(true);
  });
});

/**
 * Ruling 136(c): the archive door (`archive_task` + `deleteBranch`) inherits
 * the live re-confirm and its sentence. Canary: drop the transport hook from
 * the archive door's delete context and the delete's reconcile reaches the
 * real network instead of the fake, so the closed-on-GitHub case never deletes.
 */
describe("ruling 136(c): the archive door inherits the re-confirm", () => {
  const ARCHIVE_PACKET: TaskPacket = {
    type: "blocked",
    kind: "Blocked decision",
    from: "operator",
    title: "PR #318 closed on GitHub: VIB-301 needs a decision",
    body: "b",
    observations: [],
    options: [
      { kind: "archive_task", t: "Archive the task and delete its branch", d: "", rec: true, deleteBranch: true },
    ],
  };
  function seedArchive() {
    const { store, actor } = setup({
      pr: { number: 318, state: "review", title: "Attach execution workspace" },
    });
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...file.parsed.frontmatter, readiness: "blocked", waiting: "human" },
      goal: file.parsed.goal,
      packet: ARCHIVE_PACKET,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    return { store, actor };
  }
  const texts = (store: ReturnType<typeof setup>["store"]) =>
    readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.timeline.map((e) => e.text);

  it("archive + deleteBranch on a cached-open PR that GitHub reports CLOSED deletes the ref", async () => {
    const { store, actor } = seedArchive();
    const fake = fakeGithubFetch(livePrRoutes("closed"));
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301", optionIndex: 0 },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(fake.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`)).toHaveLength(1);
    expect(texts(store).some((t) => t === `Deleted branch \`${BRANCH}\` from GitHub.`)).toBe(true);
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter.archived).toBe(true);
  });

  it("an unreachable GitHub refuses the archive's delete with the confirm sentence, and archives anyway", async () => {
    const { store, actor } = seedArchive();
    const routes = livePrRoutes("closed");
    routes[`GET ${REPO_PATH}/compare/main...${BRANCH}`] = { status: 500, body: { message: "boom" } };
    const fake = fakeGithubFetch(routes);
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-301", optionIndex: 0 },
      actor,
      { dataRoot: store.dataRoot, fetchImpl: fake.fetchImpl },
    );
    expect(fake.callsTo(`DELETE ${REPO_PATH}/git/refs/heads/${BRANCH}`)).toHaveLength(0);
    expect(texts(store).some((t) => t.includes("was **not** deleted") && t.includes("could not confirm whether PR #318 is still open"))).toBe(true);
    expect(readTaskFile({ projectSlug: store.slug, taskKey: "VIB-301", dataRoot: store.dataRoot })!.parsed.frontmatter.archived).toBe(true);
  });
});
