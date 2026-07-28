import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createTestDbContext } from "../../test-support/test-db";

/**
 * P14-RT-09: the boot reconcile chain is ORDERED.
 *
 * The workspace reclaim used to run right after `void`-scheduling the async
 * agent-reply recovery while its comment claimed to run "after the recovery pass
 * above" — so a recovered run's delivery reconcile could race the `rmSync` of
 * the workspace it was reading. These tests pin the sequence, and that one
 * failing step never stops the next.
 */

const calls: string[] = [];
const recoverUnreactedAgentRuns = vi.fn(async () => {
  calls.push("reply-recovery:start");
  await new Promise((r) => setTimeout(r, 5));
  calls.push("reply-recovery:end");
  return { recovered: 0, capped: 0 };
});
const recoverStrandedOperatorPlans = vi.fn(async () => {
  calls.push("plan-recovery:start");
  await new Promise((r) => setTimeout(r, 5));
  calls.push("plan-recovery:end");
  return { recovered: 0 };
});
const reclaimTerminalTaskWorkspaces = vi.fn(() => {
  calls.push("reclaim");
  return { removed: 0, bytes: 0 };
});

vi.mock("./runtimes/run-recovery.server", async () => {
  const actual = await vi.importActual<
    typeof import("./runtimes/run-recovery.server")
  >("./runtimes/run-recovery.server");
  return { ...actual, recoverUnreactedAgentRuns, recoverStrandedOperatorPlans };
});
vi.mock("./tasks/workspace-retention.server", async () => {
  const actual = await vi.importActual<
    typeof import("./tasks/workspace-retention.server")
  >("./tasks/workspace-retention.server");
  return { ...actual, reclaimTerminalTaskWorkspaces };
});

const { reconcileRestartedWork, takeDataRootWriterLock } = await import(
  "./boot.server"
);

/** The chain only passes the handle through — no query runs in these tests. */
const db = {} as DatabaseSync;

beforeEach(() => {
  calls.length = 0;
  recoverUnreactedAgentRuns.mockClear();
  recoverStrandedOperatorPlans.mockClear();
  reclaimTerminalTaskWorkspaces.mockClear();
});

/**
 * G1: a held data root must END the boot with the refusal MESSAGE. `bootServer`
 * is awaited from entry.server.tsx module scope, so an escaping throw reaches
 * the operator as an SSR module-init stack instead — the one text that names the
 * holder and the two remedies never gets read.
 */
describe("takeDataRootWriterLock (G1)", () => {
  const lockCtx = createTestDbContext();
  afterEach(lockCtx.cleanup);

  function foreignHostLock(): string {
    const dataRoot = lockCtx.makeTempDir();
    mkdirSync(path.join(dataRoot, "state"), { recursive: true });
    // The container-vs-host shape: a lock left by a host this process cannot
    // probe for liveness, which is exactly what a recreated container found.
    writeFileSync(
      path.join(dataRoot, "state", "writer.lock"),
      JSON.stringify({
        pid: 1,
        hostname: "some-dead-container",
        startedAt: "2026-07-28T09:00:00.000Z",
      }),
    );
    return dataRoot;
  }

  it("prints the readable refusal and exits 1 instead of throwing an SSR crash", () => {
    const written: string[] = [];
    const exits: number[] = [];

    expect(() =>
      takeDataRootWriterLock(
        { VIBERR_FORCE_DATA_ROOT_LOCK: undefined },
        {
          dataRoot: foreignHostLock(),
          io: {
            write: (message) => void written.push(message),
            exit: (code) => void exits.push(code),
          },
        },
      ),
    ).not.toThrow();

    expect(exits).toEqual([1]);
    const message = written.join("");
    expect(message).toContain("Refusing to boot");
    expect(message).toContain("some-dead-container");
    expect(message).toContain("different host");
    expect(message).toContain("VIBERR_FORCE_DATA_ROOT_LOCK=1");
    expect(message.endsWith("\n")).toBe(true);
  });

  it("the force override boots through the same refusal", async () => {
    const exits: number[] = [];
    takeDataRootWriterLock(
      { VIBERR_FORCE_DATA_ROOT_LOCK: "1" },
      {
        dataRoot: foreignHostLock(),
        io: { write: () => {}, exit: (code) => void exits.push(code) },
      },
    );
    expect(exits).toEqual([]);
    // A forced boot really holds the root afterwards — give it back.
    const { releaseDataRootLock } = await import("./db/data-root-lock.server");
    releaseDataRootLock();
  });
});

describe("reconcileRestartedWork (P14-RT-09)", () => {
  it("reclaims workspaces only after BOTH recovery passes have COMPLETED", async () => {
    await reconcileRestartedWork(db);

    expect(calls).toEqual([
      "reply-recovery:start",
      "reply-recovery:end",
      "plan-recovery:start",
      "plan-recovery:end",
      "reclaim",
    ]);
  });

  it("a failing recovery pass never stops the rest of the chain", async () => {
    recoverUnreactedAgentRuns.mockRejectedValueOnce(new Error("boom"));

    await expect(reconcileRestartedWork(db)).resolves.toBeUndefined();

    expect(recoverStrandedOperatorPlans).toHaveBeenCalledTimes(1);
    expect(reclaimTerminalTaskWorkspaces).toHaveBeenCalledTimes(1);
  });
});
