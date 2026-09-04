import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import type { RunFailure } from "./agent-reply.server";
import { describeRunFailure, formatResetLabel } from "./run-failure-remedy.server";

/**
 * Ruling 130 (pass 34, F34-1 / F34-12): the ONE failure-to-words mapping.
 * Quota and auth name the credential principal's own remedy (Profile → Agent
 * accounts) and the reset instant; nothing says "policy / credential updated"
 * for a failure that was neither; a specialist's backend failure never
 * recommends "redirect" (the agent did nothing wrong).
 *
 * Canary: return the stock option set (`block_on_policy` titled "I've updated
 * the policy / credential…" recommended) for every kind and the quota/auth
 * cases fail on the recommended title and the `ev`.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const RESET = "2026-09-03T11:50:00.000Z";

function failure(kind: RunFailure["kind"], facts?: Partial<ReturnType<typeof emptyRunFailureFacts>>): RunFailure {
  return { kind, text: `run failed (${kind})`, facts: { ...emptyRunFailureFacts(kind), ...facts } };
}

function describe_(store: TestStore, input: Partial<Parameters<typeof describeRunFailure>[1]> & { failure: RunFailure | null }) {
  return describeRunFailure(store.db, {
    backend: "claude",
    taskKey: "JC-6",
    ownerUserId: store.users.arda.id,
    role: "operator",
    dataRoot: store.dataRoot,
    ...input,
  });
}

describe("describeRunFailure", () => {
  it("formats the reset instant absolutely, in UTC", () => {
    expect(formatResetLabel(RESET)).toMatch(/Sep 3, 2026 · 11:50 UTC$/);
    expect(formatResetLabel(null)).toBeNull();
    expect(formatResetLabel("garbage")).toBeNull();
  });

  it("quota (operator): names the spent window, the reset, the owner and Profile → Agent accounts; the recommended option asserts only the window/account", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(d.reason).toContain("five-hour usage window is spent");
    expect(d.reason).toContain("11:50 UTC");
    expect(d.reason).toContain(`${store.users.arda.name}'s`);
    expect(d.remedy).toContain("Profile → Agent accounts");
    expect(d.remedy).toContain("different Claude account or an API key");
    expect(d.resetLabel).toContain("11:50 UTC");
    expect(d.owner).toEqual({ userId: store.users.arda.id, name: store.users.arda.name });
    const rec = d.options.find((o) => o.recommended)!;
    expect(rec.kind).toBe("block_on_policy");
    expect(rec.title).toContain("The usage window has reset");
    expect(rec.title).toContain("switched the Claude account");
    // The title allows an account switch, which IS a credential change: the
    // record denies only what the person did not assert.
    expect(rec.ev).toContain("No project policy was changed");
    expect(rec.ev).not.toContain("credential was changed");
    for (const o of d.options) {
      expect(o.title).not.toMatch(/updated the policy/i);
      expect(o.title).not.toMatch(/[–—]/);
    }
    expect(d.reason + d.remedy).not.toMatch(/retry on the other backend|review the runtime configuration|fix the credential/i);
  });

  it("auth (operator): names the org restriction and the account remedy, and says a retry fails the same way", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      failure: failure("auth", { apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error" }),
    });
    expect(d.reason).toContain("organization does not allow Claude Code");
    expect(d.remedy).toContain("Retrying with the same account fails the same way");
    expect(d.remedy).toContain("Profile → Agent accounts");
    const rec = d.options.find((o) => o.recommended)!;
    expect(rec.title).toContain("I connected a different Claude account or an API key");
    expect(rec.ev).toContain("No project policy was changed");
  });

  it("unknown (operator): a plain re-run, recommended, claiming nothing about credentials", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, { failure: failure("unknown") });
    const rec = d.options.find((o) => o.recommended)!;
    expect(rec.title).toBe("Re-run the operator now");
    expect(rec.ev).toContain("No policy or credential was changed");
    expect(d.options.map((o) => o.kind)).toEqual(["block_on_policy", "redirect", "hold_runtime_debug"]);
    // The unavailable kind carries the run's own ruling-127 sentence.
    const u = describe_(store, { failure: { kind: "unavailable", text: "Arda has not connected Claude." } });
    expect(u.reason).toBe("Arda has not connected Claude.");
  });

  it("specialist quota: retry on the other backend first WHEN the owner has it, else 'send the agent back to continue'; redirect present, never recommended", async () => {
    const store = setupTestStore(ctx);
    const without = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(without.options.map((o) => [o.kind, o.recommended ?? false])).toEqual([
      ["request_edit", true],
      ["redirect", false],
    ]);
    expect(without.options[0]!.title).toContain("send @jc-developer back to continue");
    expect(without.options[0]!.title).not.toMatch(/\.\.$/);
    expect(without.remedy).not.toMatch(/\.\.$/);

    await connectFakeBackend(store.db, store.users.arda.id, "codex");
    const withOther = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(withOther.options.map((o) => [o.kind, o.recommended ?? false])).toEqual([
      ["retry_other_backend", true],
      ["request_edit", false],
      ["redirect", false],
    ]);
    expect(withOther.options[0]).toMatchObject({ backend: "codex" });
  });

  it("an unowned task yields no owner sentence and no retry option", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      ownerUserId: null,
      role: "specialist",
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(d.owner).toBeNull();
    expect(d.reason).toContain("the task owner's");
    expect(d.remedy).toContain("no owner to bill");
    expect(d.options.map((o) => o.kind)).toEqual(["request_edit", "redirect"]);
  });
});
