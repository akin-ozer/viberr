import { afterEach, describe, expect, it, vi } from "vitest";
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

  /**
   * Agent SDK 0.3.261 upgrade: a run the SDK ended on the provider's side
   * (`api_error_status: 529`, structural since 0.3.223) is `overloaded`, its
   * own class. Its words name the provider, not the account, and its remedy is
   * a retry — never Profile → Agent accounts, never "review the runtime
   * configuration".
   *
   * Canary: drop the `case "overloaded"` arm and the reason falls to the
   * default "did not complete" sentence; drop the kind from `backendFailure`
   * and the specialist options lose `retry_other_backend`.
   */
  it("overloaded (operator): names the provider's overload and the status, says nothing is wrong with the account, and recommends a plain re-run", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      failure: failure("overloaded", { apiErrorStatus: 529, terminalReason: "api_error" }),
    });
    expect(d.reason).toBe("Claude could not serve the operator run: the provider was overloaded (HTTP 529).");
    expect(d.remedy).toContain(`Nothing about ${store.users.arda.name}'s account or the task is wrong`);
    expect(d.remedy).toContain("Retry in a few minutes");
    expect(d.remedy).not.toContain("Profile → Agent accounts");
    expect(d.resetLabel).toBeNull();
    const rec = d.options.find((o) => o.recommended)!;
    expect(rec.kind).toBe("block_on_policy");
    expect(rec.title).toBe("Re-run the operator now");
    expect(rec.ev).toContain("No policy or credential was changed");

    // A 5xx that is not an overload reads as the provider's own failure, with
    // the banner code when the SDK sent one.
    const serverError = describe_(store, {
      failure: failure("overloaded", { apiErrorStatus: 500, apiError: "server_error" }),
    });
    expect(serverError.reason).toBe(
      "Claude could not serve the operator run: the provider failed on its own side (HTTP 500, server_error).",
    );
  });

  it("specialist overloaded: retry on the other backend first WHEN the owner has it; the same-backend retry asserts that nothing was changed", async () => {
    const store = setupTestStore(ctx);
    const without = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("overloaded", { apiErrorStatus: 529 }),
    });
    expect(without.options.map((o) => [o.kind, o.recommended ?? false])).toEqual([
      ["request_edit", true],
      ["redirect", false],
    ]);
    expect(without.options[0]!.title).toBe(
      "Retry @jc-developer on Claude now: the provider was overloaded, nothing was changed",
    );
    expect(without.options[0]!.ev).toContain("Claude was overloaded; the agent is retried as it was");
    expect(without.remedy).toBe(
      `Nothing about ${store.users.arda.name}'s account or the task is wrong. Retry in a few minutes.`,
    );

    await connectFakeBackend(store.db, store.users.arda.id, "codex");
    const withOther = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("overloaded", { apiErrorStatus: 529 }),
    });
    expect(withOther.options.map((o) => [o.kind, o.recommended ?? false])).toEqual([
      ["retry_other_backend", true],
      ["request_edit", false],
      ["redirect", false],
    ]);
    expect(withOther.options[0]).toMatchObject({ backend: "codex" });
    expect(withOther.remedy).toContain("or run it on Codex now");
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

/**
 * Pass 34 review: the reset label's clock is UTC, so its DAY must be too. On a
 * host twelve hours ahead of UTC the label used to read the host's calendar
 * date beside a UTC clock and call the pair UTC — wrong by a day on either
 * side of midnight.
 */
describe("formatResetLabel is UTC on both halves", () => {
  it("names the UTC day even when the host zone is a day ahead", async () => {
    // Canary: use `formatCalendarDate` (host zone) for the day again — under
    // Auckland the label reads "Sep 4, 2026 · 23:50 UTC", a day the clock
    // contradicts. The zone is stubbed BEFORE the module (and its module-level
    // Intl formatters) is imported, or the host's own zone decides the case.
    vi.stubEnv("TZ", "Pacific/Auckland");
    vi.resetModules();
    try {
      const { formatResetLabel: underAuckland } = await import("./run-failure-remedy.server");
      // 2026-09-03T23:50Z is already 2026-09-04 in Auckland.
      expect(underAuckland("2026-09-03T23:50:00.000Z")).toBe("Sep 3, 2026 · 23:50 UTC");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
