import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { listAuditEvents } from "../../../test-support/audit-log";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { recordProvenance } from "~/server/provenance/provenance-recorder.server";
import { taskProvenancePath } from "~/server/provenance/provenance-query.server";
import type { pushWorkspaceBranch } from "~/server/github/push-workspace.server";
import { reconcileTask, recompareAfterPush } from "~/server/github/github-reconciler.server";
import type { WorkRevision } from "~/schemas/task-file.schema";
import { operatorDeliverForReview, operatorSnapshot } from "./operator-actions.server";
import type { OperatorAuthority } from "./operator-authority.server";
import type { TaskActionContext } from "./task-action-core.server";

/**
 * Ruling 494 (pass 40, F40-70): a push that moves a task's branch re-compares
 * it, and the compare names the head it read.
 *
 * Live on WEB-16 (deploy 9, 2026-09-25): at 21:25:48.527Z the poller compared
 * GitHub's copy of `web-16` (`aafee66`), which the workspace had moved past,
 * and recorded it 6 commits behind `main`. At 21:25:55Z the delivery pushed
 * `20534f6`, whose parents are the branch and `main`'s tip, and nothing
 * compared again until the 21:30:48Z poll. For those five minutes
 * `get_task.baseBehindBy` said 6, and two packets the owner decided on said
 * "web-16, 6 commits behind main".
 */

let ctx: TestDbContext;
let store: TestStore;

const REPO_PATH = "/repos/akin-ozer/viberr";
const MAIN = "3790c88".padEnd(40, "0");
const OLD = "aafee66".padEnd(40, "0");
const WORK = "ca98c6e".padEnd(40, "0");
const NEW = "20534f6".padEnd(40, "0");
const SYS = { userId: null, label: "test" };

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  const pat = createPat(
    store.db,
    { userId: store.users.arda.id, label: "t", token: "ghp_recompare0000001" },
    SYS,
  );
  setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, SYS);
});

afterEach(() => ctx.cleanup());

const task = () => ({ projectSlug: store.slug, taskKey: "VIB-1" });

function authority(): OperatorAuthority {
  return {
    policy: new Map([["deliver-review-pr", "direct"]]),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: true,
    humanGatedBeforeWork: false,
  };
}

function revision(headSha: string): WorkRevision {
  return {
    id: "rev_2",
    headSha,
    treeSha: "t".repeat(40),
    branch: "vib-1",
    createdAt: "2026-09-25T21:25:40.000Z",
    sourceProfileId: "developer",
  };
}

/** VIB-1 under review on PR #7, whose head GitHub last showed as `OLD`. */
function seedReviewTask(): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      branch: "vib-1",
      workRevision: revision(NEW),
      pr: { number: 7, state: "review", title: "[VIB-1] t", headSha: OLD },
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const pull = (head: string) => ({
  number: 7,
  html_url: "https://github.com/akin-ozer/viberr/pull/7",
  title: "[VIB-1] t",
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  head: { sha: head },
  body: null,
});

/** GitHub as it stands with `head` on `vib-1`: the PR, and a compare that is
 *  6 behind `main` for the old head and level with it for the pushed one. */
function githubAt(head: string) {
  const compare =
    head === OLD
      ? {
          status: "diverged",
          ahead_by: 1,
          behind_by: 6,
          total_commits: 1,
          base_commit: { sha: MAIN },
          merge_base_commit: { sha: "f".repeat(40) },
          commits: [{ sha: OLD, commit: { message: "[VIB-1] work" }, parents: [{ sha: "f".repeat(40) }] }],
        }
      : {
          status: "ahead",
          ahead_by: 2,
          behind_by: 0,
          total_commits: 2,
          base_commit: { sha: MAIN },
          merge_base_commit: { sha: MAIN },
          commits: [
            { sha: WORK, commit: { message: "[VIB-1] work" }, parents: [{ sha: OLD }] },
            {
              sha: NEW,
              commit: { message: "[VIB-1] merge main into vib-1" },
              parents: [{ sha: WORK }, { sha: MAIN }],
            },
          ],
        };
  return fakeGithubFetch({
    [`GET ${REPO_PATH}/git/ref/heads/main`]: { body: { object: { sha: MAIN } } },
    [`GET ${REPO_PATH}/compare/main...vib-1`]: { body: compare },
    [`GET ${REPO_PATH}/pulls`]: { body: [pull(head)] },
    [`GET ${REPO_PATH}/pulls/7`]: { body: pull(head) },
    [`PATCH ${REPO_PATH}/pulls/7`]: { body: pull(head) },
  });
}

/** The poll that ran 0.2 s after the branch update: GitHub's copy, unpushed. */
async function pollAtOldHead(): Promise<void> {
  const polled = await reconcileTask(store.db, task(), SYS, {
    dataRoot: store.dataRoot,
    fetchImpl: githubAt(OLD).fetchImpl,
    skipUnchangedProvenance: true,
  });
  expect(polled).toMatchObject({ status: "reconciled", compare: { behindBy: 6, headSha: OLD } });
}

/** The delivery's push, as `pushWorkspaceBranch` reports publishing `NEW`. */
const pushNew: typeof pushWorkspaceBranch = async () => ({
  status: "pushed",
  branch: "vib-1",
  commits: 2,
  headSha: NEW,
  remoteHeadBefore: OLD,
  workflowFiles: [],
});

function deliverWith(fetchImpl: typeof fetch) {
  const callCtx: TaskActionContext = {
    dataRoot: store.dataRoot,
    fetchImpl,
    deps: { pushWorkspaceBranch: pushNew },
  };
  return operatorDeliverForReview(store.db, callCtx, task(), authority());
}

function snapshot() {
  return operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", authority());
}

/** The task's provenance rows this ruling reads, oldest first. */
const rowSchema = z.object({
  behindBy: z.number().nullable().optional(),
  headSha: z.string().nullable().optional(),
});
function rows(): { action: string; behindBy: number | null | undefined; headSha: string | null | undefined }[] {
  // SAFETY: `action` is TEXT NOT NULL and `details_json` nullable TEXT
  // (0001_baseline.sql), the two columns selected.
  const found = store.db
    .prepare(
      `SELECT action, details_json FROM provenance
       WHERE source_path = ? AND action IN ('github.reconcile', 'github.push')
       ORDER BY id ASC`,
    )
    .all(taskProvenancePath(store.slug, "VIB-1")) as { action: string; details_json: string | null }[];
  return found.map((r) => {
    const d = rowSchema.parse(JSON.parse(r.details_json ?? "{}"));
    return { action: r.action, behindBy: d.behindBy, headSha: d.headSha };
  });
}

describe("ruling 494: a push re-compares the branch it moved", () => {
  it("push then read: a delivery through the reuse-an-open-PR path leaves the pushed head's count, and get_task reads 0", async () => {
    // CANARY: drop the post-push re-compare from `performDelivery`, and the
    // newest count is the older row's 6.
    seedReviewTask();
    await pollAtOldHead();
    expect(snapshot().baseBehindBy).toBe(6);

    const res = await deliverWith(githubAt(NEW).fetchImpl);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("to the open review PR #7");
    // What the caller reports: where the pushed branch now stands.
    expect(res.message).toContain("Re-compared after the push: `vib-1` at `20534f6` is level with `main`.");

    // The push is recorded, and the compare after it counts the pushed head.
    expect(rows().slice(-2)).toEqual([
      { action: "github.push", behindBy: undefined, headSha: NEW },
      { action: "github.reconcile", behindBy: 0, headSha: NEW },
    ]);
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(0);
    expect(snap.baseComparedHead).toMatchObject({ sha: NEW, current: true, pushedSince: null });
    expect(snap.baseBehindBySentence).toBe("");
    // The pass is the operator's delivery's, audited as the operator, never
    // under its task actor's sentinel id. CANARY: pass the task actor through.
    expect(listAuditEvents(store.db, { action: "github.reconcile.task" })[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "operator",
    });
  });

  it("re-compare fails: the push stands, no row claims a count for the pushed head, and get_task says the count is the older head's", async () => {
    // CANARIES: write the push row only after a pass that succeeded (the
    // count reads as current); drop the failure arm of the reply sentence.
    seedReviewTask();
    await pollAtOldHead();
    // GitHub answers the PR door and fails every compare after the push.
    const reachable = githubAt(NEW);
    const failingCompare: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/compare/")) throw new TypeError("fetch failed");
      return reachable.fetchImpl(input, init);
    };
    const res = await deliverWith(failingCompare);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain("to the open review PR #7");
    expect(res.message).toContain(
      "`vib-1` could not be compared with `main` again after the push (network_unavailable), so the count of commits it is behind stays the one from before the push until the next GitHub pass.",
    );

    // The push row stands after the old count, and nothing counted NEW.
    const recorded = rows();
    expect(recorded.at(-1)).toEqual({ action: "github.push", behindBy: undefined, headSha: NEW });
    expect(recorded.filter((r) => r.action === "github.reconcile" && r.headSha === NEW)).toEqual([]);
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(6);
    expect(snap.baseComparedHead).toMatchObject({
      sha: OLD,
      current: false,
      pushedSince: { sha: NEW },
    });
    expect(snap.baseBehindBySentence).toContain(
      "`baseBehindBy` (6) was counted on `aafee66`, and Viberr pushed `20534f6` to `vib-1` after that compare, so the count describes the older head.",
    );
    expect(snap.baseBehindBySentence).toContain("Do not quote it, in a comment or a decision packet");
  });

  it("a re-compare GitHub answers before it shows the push: the reply names both heads, and get_task reads the count as not the pushed head's until the next pass", async () => {
    // CANARY: read only a push recorded AFTER the newest compare
    // (`createBaseCompareLookup`'s old `id > ?` bound), and the count the
    // re-compare read on the replaced head reads as current, with no sentence.
    seedReviewTask();
    await pollAtOldHead();
    // GitHub still shows `vib-1` at the head the push replaced, on the pull
    // request and on the compare.
    const res = await deliverWith(githubAt(OLD).fetchImpl);
    expect(res.outcome).toBe("done");
    expect(res.message).toContain(
      "Re-compared after the push: GitHub's `vib-1` stands at `aafee66`, not the `20534f6` just pushed, and is 6 commits behind `main`.",
    );
    expect(rows().slice(-2)).toEqual([
      { action: "github.push", behindBy: undefined, headSha: NEW },
      { action: "github.reconcile", behindBy: 6, headSha: OLD },
    ]);
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(6);
    expect(snap.baseComparedHead).toMatchObject({
      sha: OLD,
      current: false,
      pushedSince: { sha: NEW },
    });
    expect(snap.baseBehindBySentence).toContain(
      "`baseBehindBy` (6) was counted on `aafee66`, not on `20534f6`, which Viberr pushed to `vib-1` before that compare, so the count does not describe the pushed head.",
    );
    expect(snap.baseBehindBySentence).toContain("Do not quote it, in a comment or a decision packet");

    // The next pass reads the pushed head, and its count is the branch's.
    await reconcileTask(store.db, task(), SYS, {
      dataRoot: store.dataRoot,
      fetchImpl: githubAt(NEW).fetchImpl,
      skipUnchangedProvenance: true,
    });
    const after = snapshot();
    expect(after.baseBehindBy).toBe(0);
    expect(after.baseComparedHead).toMatchObject({ sha: NEW, current: true, pushedSince: null });
    expect(after.baseBehindBySentence).toBe("");
  });

  it("a delivery that throws after its push still re-compares before it returns", async () => {
    // CANARY: drop the re-compare from `performDelivery`'s catch.
    seedReviewTask();
    await pollAtOldHead();
    const throwing: TaskActionContext = {
      dataRoot: store.dataRoot,
      fetchImpl: githubAt(NEW).fetchImpl,
      deps: {
        pushWorkspaceBranch: pushNew,
        openTaskPr: async () => {
          throw new Error("the PR door broke");
        },
      },
    };
    const res = await operatorDeliverForReview(store.db, throwing, task(), authority());
    expect(res.message).toContain("the PR door broke");
    expect(rows().slice(-2)).toEqual([
      { action: "github.push", behindBy: undefined, headSha: NEW },
      { action: "github.reconcile", behindBy: 0, headSha: NEW },
    ]);
    expect(snapshot().baseBehindBy).toBe(0);
  });

  it("a pass that read the branch before the push cannot record its count after the push", async () => {
    // The poller's pass holds the task's lock and is mid-compare when the
    // push lands; the push's re-compare then fails. CANARY: write the push
    // row before taking the lock, and the older pass's row lands after it,
    // so its count reads as the pushed head's.
    seedReviewTask();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const inCompare = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const old = githubAt(OLD);
    const slowFetch: typeof fetch = async (input, init) => {
      entered();
      await released;
      return old.fetchImpl(input, init);
    };
    const polling = reconcileTask(store.db, task(), SYS, {
      dataRoot: store.dataRoot,
      fetchImpl: slowFetch,
    });
    await inCompare;
    const recompare = recompareAfterPush(
      store.db,
      { ...task(), branch: "vib-1", headSha: NEW, via: "delivery" },
      SYS,
      { dataRoot: store.dataRoot, fetchImpl: unreachableFetch() },
    );
    release();
    await polling;
    expect(await recompare).toMatchObject({ status: "network_unavailable" });
    expect(rows()).toEqual([
      { action: "github.reconcile", behindBy: 6, headSha: OLD },
      { action: "github.push", behindBy: undefined, headSha: NEW },
    ]);
    expect(snapshot().baseComparedHead).toMatchObject({ sha: OLD, current: false });
  });
});

describe("ruling 494: get_task names the head its count was counted on", () => {
  const A = "a1a1a1a".padEnd(40, "1");
  const B = "b2b2b2b".padEnd(40, "2");

  function seedTask(): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl", branch: "vib-1" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }
  const compareRow = (details: Record<string, string | number>, observedAt: string) =>
    recordProvenance(store.db, {
      sourcePath: taskProvenancePath(store.slug, "VIB-1"),
      action: "github.reconcile",
      details: { repo: "akin-ozer/viberr", branch: "vib-1", ...details },
      observedAt,
    });
  const pushRow = (headSha: string, observedAt: string) =>
    recordProvenance(store.db, {
      sourcePath: taskProvenancePath(store.slug, "VIB-1"),
      action: "github.push",
      details: { repo: "akin-ozer/viberr", branch: "vib-1", headSha, via: "delivery" },
      observedAt,
    });

  it("compared head: a count for head A with the task's pushed head B names A and says the count is not B's", () => {
    // CANARIES: compare the heads without the push row (the count reads as
    // current); drop the sentence.
    seedTask();
    compareRow({ sync: "behind_main", behindBy: 3, headSha: A }, "2026-09-25T21:25:48.527Z");
    pushRow(B, "2026-09-25T21:25:55.000Z");
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(3);
    expect(snap.baseComparedHead).toEqual({
      sha: A,
      observedAt: "2026-09-25T21:25:48.527Z",
      current: false,
      pushedSince: { sha: B, at: "2026-09-25T21:25:55.000Z" },
    });
    expect(snap.baseBehindBySentence).toBe(
      "`baseBehindBy` (3) was counted on `a1a1a1a`, and Viberr pushed `b2b2b2b` to `vib-1` after that compare, " +
        "so the count describes the older head. Do not quote it, in a comment or a decision packet, as how far " +
        "`vib-1` is behind `main` now: a count describes only the head it was counted on. " +
        "The next GitHub pass compares the pushed head.",
    );
  });

  it("compared head: the compare right after a push of B that read A says the count is not B's, and a later compare is the branch's", () => {
    // CANARIES: read only a push recorded after the compare (the lookup's old
    // `id > ?` bound), and the count reads as current with no sentence; check
    // every compare against the newest push, and the head a person moved on
    // GitHub reads as not current.
    seedTask();
    compareRow({ sync: "behind_main", behindBy: 6, headSha: A }, "2026-09-25T21:25:48.527Z");
    pushRow(B, "2026-09-25T21:25:55.000Z");
    // The push's own re-compare, which GitHub answered with the older head.
    compareRow({ sync: "behind_main", behindBy: 6, headSha: A }, "2026-09-25T21:25:56.000Z");
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(6);
    expect(snap.baseComparedHead).toEqual({
      sha: A,
      observedAt: "2026-09-25T21:25:56.000Z",
      current: false,
      pushedSince: { sha: B, at: "2026-09-25T21:25:55.000Z" },
    });
    expect(snap.baseBehindBySentence).toBe(
      "`baseBehindBy` (6) was counted on `a1a1a1a`, not on `b2b2b2b`, which Viberr pushed to `vib-1` before that compare, " +
        "so the count does not describe the pushed head. Do not quote it, in a comment or a decision packet, as how far " +
        "`vib-1` is behind `main` now: a count describes only the head it was counted on. " +
        "The next GitHub pass compares the branch again.",
    );
    // The next pass read the pushed head.
    compareRow({ sync: "synced", behindBy: 0, headSha: B }, "2026-09-25T21:30:48.000Z");
    expect(snapshot()).toMatchObject({
      baseBehindBy: 0,
      baseComparedHead: { sha: B, current: true, pushedSince: null },
      baseBehindBySentence: "",
    });
    // A head that moved on GitHub after that (a person's commit there) is
    // the branch's head: its count is current, not an older head's.
    const C = "c3c3c3c".padEnd(40, "3");
    compareRow({ sync: "behind_main", behindBy: 1, headSha: C }, "2026-09-25T21:35:48.000Z");
    expect(snapshot()).toMatchObject({
      baseBehindBy: 1,
      baseComparedHead: { sha: C, current: true, pushedSince: null },
      baseBehindBySentence: "",
    });
  });

  it("a compare made after the push describes the head it read", () => {
    seedTask();
    pushRow(B, "2026-09-25T21:25:55.000Z");
    compareRow({ sync: "synced", behindBy: 0, headSha: B }, "2026-09-25T21:25:56.000Z");
    const snap = snapshot();
    expect(snap.baseComparedHead).toMatchObject({ sha: B, current: true, pushedSince: null });
    expect(snap.baseBehindBySentence).toBe("");
  });

  it("a row without a head reads as head unknown, never as current", () => {
    // CANARY: read a missing head as current.
    seedTask();
    compareRow({ sync: "behind_main", behindBy: 6 }, "2026-09-25T21:25:48.527Z");
    const snap = snapshot();
    expect(snap.baseBehindBy).toBe(6);
    expect(snap.baseComparedHead).toMatchObject({ sha: null, current: null, pushedSince: null });
    expect(snap.baseBehindBySentence).toContain(
      "The last compare did not record which head it read, so `baseBehindBy` (6) may describe an older head than `vib-1` carries now.",
    );
  });

  it("carries nothing when no pass has compared the branch", () => {
    seedTask();
    const snap = snapshot();
    expect(snap.baseBehindBy).toBeNull();
    expect(snap.baseComparedHead).toBeNull();
    expect(snap.baseBehindBySentence).toBe("");
  });
});
