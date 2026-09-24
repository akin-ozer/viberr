import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeAdapter } from "./adapter.server";
import { chainRunCompletion, registerRunCompletion } from "./run-service.server";
import { upsertRun } from "./run-store.server";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  drainRunCompletions,
  installFakeRuntime,
  installRunAdapters,
} from "../../../test-support/fake-runtime";

/**
 * The suite's own cleanup helpers. `createTempDirs` removes what a test made;
 * `drainRunCompletions` holds a test's cleanup until the work its runs'
 * completion callbacks started has finished, which no test can await itself.
 */

describe("createTempDirs", () => {
  it("makes prefixed dirs under the OS temp dir and removes every one it made", () => {
    const temp = createTempDirs();
    const a = temp.make("viberr-harness-a-");
    const b = temp.make("viberr-harness-b-");
    writeFileSync(path.join(a, "left-behind.md"), "x");
    expect(path.dirname(a)).toBe(tmpdir());
    expect(path.basename(a)).toMatch(/^viberr-harness-a-.{6}$/);
    expect(existsSync(a) && existsSync(b)).toBe(true);

    temp.cleanup();
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);

    // The list starts over: a later cleanup removes what was made since.
    const c = temp.make("viberr-harness-c-");
    temp.cleanup();
    expect(existsSync(c)).toBe(false);
  });

  it("keeps createTestDbContext's own prefix, and takes another", () => {
    const ctx = createTestDbContext();
    const plain = ctx.makeTempDir();
    const named = ctx.makeTempDir("viberr-pin-");
    expect(path.basename(plain)).toMatch(/^viberr-test-.{6}$/);
    expect(path.basename(named)).toMatch(/^viberr-pin-.{6}$/);
    ctx.cleanup();
    expect(existsSync(plain) || existsSync(named)).toBe(false);
  });
});

describe("drainRunCompletions", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  /** A run that has already settled, so `registerRunCompletion` fires its
   *  callback at once: the path every fake run takes, since it exits before
   *  its caller registers. */
  function settledRun() {
    const db = ctx.makeDb();
    const runId = "run_drain";
    upsertRun(db, {
      id: runId,
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "test",
      agentProfileId: "dev",
      state: "finished",
    });
    return { db, runId };
  }

  const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** What settles first: the drain, or a timer of `ms`. */
  const firstOf = (drain: Promise<void>, ms: number) =>
    Promise.race([drain.then(() => "drain"), later(ms).then(() => "timer")]);

  it("waits for every step of the work a completion callback voided", async () => {
    installFakeRuntime();
    const { db, runId } = settledRun();
    const steps: string[] = [];
    registerRunCompletion(
      runId,
      () => {
        void (async () => {
          await later(20);
          steps.push("reply");
          await later(20);
          steps.push("react");
        })();
      },
      db,
    );
    expect(steps).toEqual([]);

    await drainRunCompletions();
    expect(steps).toEqual(["reply", "react"]);
  });

  it("waits for chained callbacks too, on a test's own adapters", async () => {
    const idle: RuntimeAdapter = {
      backend: "claude",
      start() {
        throw new Error("no run starts here");
      },
    };
    installRunAdapters({ claude: idle, codex: { ...idle, backend: "codex" } });
    const { db, runId } = settledRun();
    const steps: string[] = [];
    registerRunCompletion(runId, () => {
      void later(20).then(() => steps.push("first"));
    });
    chainRunCompletion(
      runId,
      () => {
        void later(30).then(() => steps.push("chained"));
      },
      db,
    );

    await drainRunCompletions();
    expect(steps).toEqual(["first", "chained"]);
  });

  it("stops waiting at its ceiling, and the next drain starts clean", async () => {
    installFakeRuntime();
    const { db, runId } = settledRun();
    registerRunCompletion(
      runId,
      () => {
        void new Promise(() => {});
      },
      db,
    );

    expect(await firstOf(drainRunCompletions(50), 2_000)).toBe("drain");
    // The promise that never settles is no longer waited on.
    expect(await firstOf(drainRunCompletions(), 1_000)).toBe("drain");
  });
});
