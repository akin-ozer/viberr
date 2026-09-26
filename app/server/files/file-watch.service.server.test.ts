import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  projectionFaultCount,
  resetProjectionFaultsForTests,
} from "~/server/projections/store-health.server";
import { projectDir, projectFilePath, taskDir } from "./file-store-root.server";
import { updateProjectFile } from "./project-writer.server";
import {
  isFileWatcherAlive,
  shouldIgnoreWatchPath,
  RETRY_BACKOFF_MS,
  startFileWatcher,
  stopFileWatcher,
} from "./file-watch.service.server";

const ctx = createTestDbContext();
afterEach(() => {
  stopFileWatcher();
  resetProjectionFaultsForTests();
  ctx.cleanup();
});

const WAIT_TIMEOUT_MS = 12_000;

/**
 * Poll for `cond`. macOS can DROP (not just delay) coalesced FSEvents when
 * the machine is churning temp dirs (back-to-back full-suite runs); `nudge`
 * runs every few seconds to RE-OFFER the awaited event — e.g. touching an
 * ignored dotfile in a removed directory's parent forces the watcher to
 * re-diff the listing and emit the missed unlink. A genuinely broken
 * reconcile path never converges regardless and still times out.
 */
async function waitFor(
  cond: () => boolean,
  what: string,
  nudge?: () => void,
  /** Ruling 218's retry test needs its own budget — see the call site. */
  budgetMs: number = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let lastNudge = Date.now();
  while (Date.now() < deadline) {
    if (cond()) return;
    if (nudge && Date.now() - lastNudge > 4_000) {
      lastNudge = Date.now();
      nudge();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

/** Touch a WORK-NEUTRAL file under `dir` so the watcher re-reads its listing:
 *  not dot/tmp (an ignored name can skip the rescan entirely), and not a
 *  canonical basename, so the add event reaches chokidar's differ but never
 *  the projection handlers. */
function pokeDir(dir: string): void {
  writeFileSync(path.join(dir, "poke-marker"), String(Date.now()));
}

async function startWatcherReady(
  store: ReturnType<typeof setupTestStore>,
  retryBackoffMs?: readonly number[],
) {
  const options: Parameters<typeof startFileWatcher>[0] = {
    dataRoot: store.dataRoot,
    db: store.db,
  };
  if (retryBackoffMs) options.retryBackoffMs = retryBackoffMs;
  const watcher = startFileWatcher(options);
  // Chokidar arms asynchronously — `ready` marks the initial scan complete.
  // The listener attaches in the same synchronous frame as the start, so the
  // event cannot have fired before it.
  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return watcher;
}

function taskCount(store: ReturnType<typeof setupTestStore>): number {
  return Number(
    store.db
      .prepare(`SELECT count(*) AS c FROM task_projections WHERE project_slug = ?`)
      .get(store.slug)!.c,
  );
}

describe("unlinkDir handling (E13)", () => {
  it("a recursive task-dir rm prunes that task's projection rows", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(taskCount(store)).toBe(2);

    await startWatcherReady(store);
    rmSync(taskDir(store.slug, "VIB-1", store.dataRoot), {
      recursive: true,
      force: true,
    });

    await waitFor(
      () => taskCount(store) === 1,
      "VIB-1 rows pruned",
      () => pokeDir(path.join(projectDir(store.slug, store.dataRoot), "tasks")),
    );
    const left = store.db
      .prepare(`SELECT task_key FROM task_projections WHERE project_slug = ?`)
      .all(store.slug);
    expect(left.map((r) => r.task_key)).toEqual(["VIB-2"]);
  }, 15000);

  it("a recursive PROJECT rm reconciles the whole project (no orphan rows)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    await startWatcherReady(store);
    rmSync(projectDir(store.slug, store.dataRoot), { recursive: true, force: true });

    await waitFor(
      () =>
        store.db.prepare(`SELECT slug FROM projects WHERE slug = ?`).get(store.slug) ===
          undefined && taskCount(store) === 0,
      "project + task rows pruned",
      () => pokeDir(path.join(store.dataRoot, "projects")),
    );
  }, 15000);
});

describe("subtree pruning (F-SPAWN1 — fd explosion)", () => {
  const root = "/data/projects";
  it("keeps project.md and task.md, prunes workspace clones", () => {
    expect(shouldIgnoreWatchPath(root, `${root}/p/project.md`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/task.md`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1`)).toBe(false);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/workspace`)).toBe(true);
    expect(shouldIgnoreWatchPath(root, `${root}/p/tasks/VIB-1/workspace/repo/src/index.ts`)).toBe(true);
  });

  it("does not prune outside the watch root", () => {
    expect(shouldIgnoreWatchPath(root, root)).toBe(false);
    expect(shouldIgnoreWatchPath(root, "/somewhere/else")).toBe(false);
  });

  it("integration: a workspace-file write never reprojects; task.md edits still do", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1") });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const projectedTitle = () =>
      store.db
        .prepare(`SELECT title FROM task_projections WHERE project_slug = ? AND task_key = ?`)
        .get(store.slug, "VIB-1")!.title;
    const originalTitle = projectedTitle();

    await startWatcherReady(store);

    // Write a file deep inside the task's workspace clone — must be ignored (the
    // pruning keeps the recursive watcher out of cloned-repo files).
    const wsDir = path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace", "repo", "src");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(path.join(wsDir, "index.ts"), "export const x = 1;\n");
    // Give the watcher a beat; the workspace write must NOT reproject.
    await new Promise((r) => setTimeout(r, 600));
    expect(projectedTitle()).toBe(originalTitle);

    // A real task.md edit still reprojects (proves pruning didn't kill watching).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: { ...baseTaskFrontmatter("VIB-1"), title: "Edited title after pruning" },
    });
    await waitFor(
      () => projectedTitle() === "Edited title after pruning",
      "task.md reprojected after edit",
    );
  }, 15000);
});

/**
 * Ruling 218 (F37-38). A projection is rebuilt when its file CHANGES. If that
 * one rebuild fails, the file does not change again — so the row keeps whatever
 * it held before, forever. Live: ninety seconds of `disk I/O error` left
 * SHOP-4's card reading "waiting on you" while its own file said `waiting:
 * agent`, and it stayed wrong until a human pressed Re-scan. Nobody would have,
 * because nothing on any surface said to.
 */
describe("a failed rebuild is retried (ruling 218)", () => {
  it("heals a stale projection whose ONE rebuild failed, with no further file change", async () => {
    const store = setupTestStore(ctx);
    const uid = store.users.arda.id;
    const comment = (at: string, text: string) => ({
      occurredAt: at,
      type: "comment" as const,
      actor: { kind: "human" as const, userId: uid, nameHint: null },
      title: null,
      toAgent: false,
      evidence: null,
      text,
    });
    const events = (): number =>
      Number(
        store.db
          .prepare(
            `SELECT count(*) AS c FROM task_events WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, "VIB-1")!.c,
      );

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [comment("2026-08-26T10:00:00.000Z", "first")],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(events()).toBe(1);

    // Ruling 218's real ladder is 2s / 5s / 15s. This test has to WAIT for a
    // retry, so with the production numbers a repair landing just after the
    // second attempt waits fifteen more seconds for the third — and the budget
    // then has to beat full-suite scheduling noise on top. It was raised to 12s
    // and failed at 12,087ms; raised to 26s and failed at 26,052ms. The ladder
    // is the variable, not the budget, so the canary drives a fast one: the
    // BEHAVIOUR under test is "a failed rebuild is retried at all", which the
    // interval does not change.
    //
    // The LENGTH matters as much as the delays, and getting it wrong is how
    // this test was made flaky a third time. Every failed attempt consumes a
    // rung, and `scheduleRetry` gives up after the last one. The latch wait
    // below pokes until the fault is recorded, and each poke is another failed
    // attempt — so a five-rung ladder was spent in about 300ms, long before the
    // table came back, and the heal then waited on a retry that would never be
    // scheduled. It passed alone and failed at 12,035ms under load, which is
    // the same shape as the bug it replaced. The rungs are therefore many and
    // short: ~20s of retry capacity at 40ms granularity outlasts any plausible
    // latch delay while keeping the heal itself near-instant.
    await startWatcherReady(
      store,
      Array.from({ length: 500 }, () => 40),
    );

    // The store cannot take the events rewrite for the whole first attempt —
    // the shape a transient `disk I/O error` has. `content_hash` is written
    // LAST (F28-D3), so the row is left stale AND re-readable.
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_gone`);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [
        comment("2026-08-26T10:00:00.000Z", "first"),
        comment("2026-08-26T10:01:00.000Z", "second"),
      ],
    });
    // The nudge REWRITES `task.md`, and that is the fix for this test's third
    // flake. `pokeDir` writes `poke-marker`, whose name is deliberately not a
    // canonical basename — by its own contract the add "never [reaches] the
    // projection handlers". So the latch depended on catching the ONE change
    // event from the `writeTask` above, and when full-suite load let chokidar
    // coalesce or miss it, no amount of poking could produce another: the file
    // had not changed since. The failure was always "timed out waiting for: the
    // failing rebuild to be latched", never the heal, which is why raising
    // budgets and shortening the retry ladder both missed it.
    //
    // Rewriting the same bytes gives chokidar a `change` on a canonical
    // basename, so the latch becomes recoverable instead of one-shot. It does
    // not weaken the test: the "nothing touches the file again" invariant
    // belongs to the HEAL below, which still passes no nudge at all.
    const rewriteTask = () => {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
        timeline: [
          comment("2026-08-26T10:00:00.000Z", "first"),
          comment("2026-08-26T10:01:00.000Z", "second"),
        ],
      });
    };
    await waitFor(
      () => projectionFaultCount() > 0,
      "the failing rebuild to be latched",
      rewriteTask,
      12_000,
    );

    // The store recovers. NOTHING touches the file again — that is the whole
    // point: only the retry can bring this row back to the record.
    store.db.exec(`ALTER TABLE task_events_gone RENAME TO task_events`);
    // CANARY: delete `scheduleRetry` from `rebuildFile` and this never
    // converges — the timeline stays one comment behind its own file, which is
    // exactly what SHOP-4 did until a human pressed Re-scan.
    await waitFor(
      () => events() === 2,
      "the retry to heal the stale projection",
      undefined,
      12_000,
    );
    expect(projectionFaultCount()).toBe(0);
  }, 30_000);

  /**
   * Ruling 457: a project's cascade isolates each task (a SAVEPOINT apiece), so
   * a task that cannot re-project no longer fails project.md's rebuild. The
   * project row lands and keeps the F28-D3 sentinel, and the result names the
   * task: without a retry on that, nothing would ever re-run the cascade, since
   * neither file changes again.
   */
  it("re-runs a cascade that left a task behind, with no further file change", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [
        {
          occurredAt: "2026-08-26T10:00:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.selin.id, nameHint: null },
          title: null,
          toAgent: false,
          evidence: null,
          text: "hi",
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const selinIsGuest = (): boolean =>
      String(
        store.db
          .prepare(`SELECT actor_json FROM task_events WHERE project_slug = ? AND task_key = ?`)
          .get(store.slug, "VIB-1")?.actor_json,
      ).includes('"guest":true');
    const selinIsMember = (): boolean =>
      store.db
        .prepare(`SELECT 1 FROM project_members WHERE project_slug = ? AND user_id = ?`)
        .get(store.slug, store.users.selin.id) !== undefined;
    expect(selinIsGuest()).toBe(false);
    // See the test above for why the ladder is long and fast.
    await startWatcherReady(
      store,
      Array.from({ length: 500 }, () => 40),
    );

    // The store cannot take VIB-1's events rewrite, so the cascade the member
    // removal starts fails that task; the project row lands anyway.
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_gone`);
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.members = parsed.frontmatter.members.filter(
        (m) => m.userId !== store.users.selin.id,
      );
    });
    const projectPath = projectFilePath(store.slug, store.dataRoot);
    const rewriteProject = () => writeFileSync(projectPath, readFileSync(projectPath));
    await waitFor(
      () => projectionFaultCount() > 0 && !selinIsMember(),
      "the member removal to land with VIB-1's fault latched",
      rewriteProject,
      12_000,
    );

    store.db.exec(`ALTER TABLE task_events_gone RENAME TO task_events`);
    // CANARY: drop `|| result.failedTasks` from `rebuildFile` and this never
    // converges: VIB-1 keeps showing selin as a member.
    await waitFor(
      () => selinIsGuest() && projectionFaultCount() === 0,
      "the retry to re-run the cascade",
      undefined,
      12_000,
    );
  }, 30_000);

  /**
   * The ruled ladder, pinned (ruling 218(a)). `scheduleRetry` gives up after
   * the last rung, which is why the test ladder above is 500 long: a test
   * ladder that runs out mid-wait stops retrying and the canary fails for a
   * reason that has nothing to do with ruling 218.
   */
  it("ruling 218's ladder is 2s, 5s, 15s, 45s, 120s", () => {
    expect(RETRY_BACKOFF_MS).toEqual([2_000, 5_000, 15_000, 45_000, 120_000]);
  });
});

describe("watcher liveness (E8)", () => {
  it("an fs watcher error clears the cached handle", async () => {
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    expect(isFileWatcherAlive()).toBe(true);

    watcher.emit("error", new Error("EMFILE: too many open files"));
    expect(isFileWatcherAlive()).toBe(false);
  }, 15000);

  it("ENOENT is benign: deleting a watched path must not kill the watcher", async () => {
    // Deleting a watched subtree can race chokidar into a spurious ENOENT
    // while the deletion's own debounced reconcile is still queued — killing
    // the watcher then cancels that reconcile and orphans the projections.
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    watcher.emit(
      "error",
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );
    expect(isFileWatcherAlive()).toBe(true);
  }, 15000);
});

describe("watcher re-arm lifecycle (F10-08)", () => {
  it("teardown cancels a pending transient re-arm — it cannot resurrect the watcher", async () => {
    const store = setupTestStore(ctx);
    const watcher = await startWatcherReady(store);
    expect(isFileWatcherAlive()).toBe(true);

    // Only fake timers so the native watcher stays real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A transient error WITH a code schedules the 2s self-heal re-arm.
      watcher.emit(
        "error",
        Object.assign(new Error("EMFILE"), { code: "EMFILE" }),
      );
      expect(isFileWatcherAlive()).toBe(false);
      // Teardown must cancel that pending re-arm and bump the generation, so
      // advancing well past the backoff never brings a watcher back (the old
      // untracked timer re-fired on `cache === undefined` — exactly what
      // teardown creates — resurrecting a watcher against a deleted root).
      stopFileWatcher();
      vi.advanceTimersByTime(10_000);
      expect(isFileWatcherAlive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);
});
