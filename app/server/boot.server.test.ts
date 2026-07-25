import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseSync } from "node:sqlite";

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

const { reconcileRestartedWork } = await import("./boot.server");

/** The chain only passes the handle through — no query runs in these tests. */
const db = {} as DatabaseSync;

beforeEach(() => {
  calls.length = 0;
  recoverUnreactedAgentRuns.mockClear();
  recoverStrandedOperatorPlans.mockClear();
  reclaimTerminalTaskWorkspaces.mockClear();
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
