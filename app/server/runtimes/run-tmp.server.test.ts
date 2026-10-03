import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pollUntil } from "../../../test-support/polling";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  prepareRunTmp,
  removeRunTmp,
  runTmpEnv,
  scheduleRunTmpRemoval,
  sweepRunTmp,
} from "./run-tmp.server";

/**
 * Ruling 636: a run's temporary directory is its own, starts empty, and goes
 * once the run is over. Which uid can enter it is the isolation module's
 * (`passThroughDirForAgents`, `shareDirWithAgents`) and the image's
 * (`scripts/check-agent-isolation.sh`); these pin the lifecycle, with no
 * launcher, as the server's own user.
 */

let ctx: TestDbContext;

beforeEach(() => {
  ctx = createTestDbContext();
});

afterEach(() => {
  ctx.cleanup();
});

describe("a run's temporary directory (ruling 636)", () => {
  it("is made under the root for the run alone, and starts clean", () => {
    // A crashed predecessor of the same id never hands its files on.
    // CANARY: drop the removal before the `mkdirSync` in `prepareRunTmp` and
    // the launch fails on the leftover directory.
    const root = path.join(ctx.makeTempDir("viberr-run-tmp-"), "viberr-runs");
    mkdirSync(path.join(root, "run_one"), { recursive: true });
    writeFileSync(path.join(root, "run_one", "left-by-a-crash.json"), "{}");

    const dir = prepareRunTmp("run_one", null, root);

    expect(dir).toBe(path.join(root, "run_one"));
    expect(readdirSync(dir)).toEqual([]);
    expect(runTmpEnv(dir)).toEqual({ TMPDIR: dir, TMP: dir, TEMP: dir });
  });

  it("is removed whole, including what a tool left unwritable, and a removal that fails never throws", async () => {
    // The settle and a failed launch call it without awaiting a verdict: a
    // throw there would take the run's settle down with it.
    // CANARY: drop the try/catch in `removeRunTmp` and the second call rejects.
    const root = ctx.makeTempDir("viberr-run-tmp-");
    const dir = prepareRunTmp("run_two", null, root);
    mkdirSync(path.join(dir, "cache", "locked"), { recursive: true });
    writeFileSync(path.join(dir, "cache", "locked", "scratch.csv"), "a,b\n");
    chmodSync(path.join(dir, "cache", "locked"), 0o500);

    await removeRunTmp(dir, null, "run_two");

    expect(existsSync(dir)).toBe(false);
    await expect(removeRunTmp("not/an/absolute/path", null, "run_two")).resolves.toBeUndefined();
  });

  it("waits for its delay before it goes", async () => {
    // The settle sweep needs its grace to stop the run's last processes, and a
    // directory removed under a process still writing it is left half there.
    // CANARY: call `removeRunTmp` at once instead of from the timer and the
    // directory is gone on the look made well inside the delay.
    const dir = prepareRunTmp("run_three", null, ctx.makeTempDir("viberr-run-tmp-"));

    scheduleRunTmpRemoval(dir, null, "run_three", 1_500);
    // Long enough for a removal begun at once (two short child processes) to
    // finish; a timer can fire late under load, never early.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(existsSync(dir)).toBe(true);
    expect(await pollUntil(() => !existsSync(dir))).toBe(true);
  });

  it("boot removes every directory runs left, whoever they were, and counts them", () => {
    // Nothing runs at boot, so all of them are leftovers: a server that stopped
    // before its removal timer, a removal that failed.
    // CANARY: skip directories with no run in the projection and the second stays.
    const db = ctx.makeDb();
    const root = ctx.makeTempDir("viberr-run-tmp-");
    prepareRunTmp("run_four", null, root);
    prepareRunTmp("run_unknown", null, root);

    expect(sweepRunTmp(db, { root })).toBe(2);
    expect(readdirSync(root)).toEqual([]);
    expect(sweepRunTmp(db, { root: path.join(root, "never-made") })).toBe(0);
  });
});
