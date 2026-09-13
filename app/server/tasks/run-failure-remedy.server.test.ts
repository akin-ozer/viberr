import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import type { RunFailure } from "./agent-reply.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
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
  it("ruling 175: a spending-cap cut-off names the cap and the spend, and who can raise it; re-running is recommended", () => {
    // Canary: drop the `max_budget` case and the reason falls to the generic
    // "did not complete: run failed (max_budget)" with no figure.
    const store = setupTestStore(ctx);
    const d = describe_(store, { failure: failure("max_budget", { spendCapUsd: 0.5, spentUsd: 0.52 }) });
    expect(d.reason).toBe(
      "The operator run was cut off by the instance's spending cap of $0.50 after spending $0.52.",
    );
    expect(d.remedy).toContain("raise the cap in Org settings (Max spend per Claude run)");
    expect(d.options.find((o) => o.recommended)?.title).toBe("Re-run the operator now");
    // A specialist's cut-off is not a backend failure: no other-backend retry.
    const spec = describe_(store, {
      role: "specialist",
      agentHandle: "developer",
      failure: failure("max_budget", { spendCapUsd: 0.5 }),
    });
    expect(spec.reason).toBe("The agent run was cut off by the instance's spending cap of $0.50.");
    expect(spec.options.some((o) => o.kind === "retry_other_backend")).toBe(false);
  });

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

  it("ruling 152(c): the options that assert the window has reset NAME the backend they assert about", () => {
    // The assertion is what retires the instance's exhaustion record
    // (`resolvePacket`), and the record is per backend — so the option carries
    // the backend that refused. Canary: drop `backend: failed` from the quota
    // and auth arms and the resolution has nothing to clear, so the hold that
    // ruling 152(c) put on the next dispatch outlives the person's statement.
    const store = setupTestStore(ctx);
    const operatorQuota = describe_(store, {
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(operatorQuota.options.find((o) => o.recommended)).toMatchObject({
      kind: "block_on_policy",
      backend: "claude",
    });
    const operatorAuth = describe_(store, {
      failure: failure("auth", { apiError: "oauth_org_not_allowed", apiErrorStatus: 403, terminalReason: "api_error" }),
    });
    expect(operatorAuth.options.find((o) => o.recommended)).toMatchObject({
      kind: "block_on_policy",
      backend: "claude",
    });
    const specialistQuota = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    expect(specialistQuota.options[0]).toMatchObject({
      kind: "request_edit",
      backend: "claude",
    });
    // An overload asserts nothing about a usage window, so it names nothing.
    const overloaded = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      failure: failure("overloaded", { apiErrorStatus: 529 }),
    });
    expect(overloaded.options[0]!.kind).toBe("request_edit");
    expect(overloaded.options[0]!.backend).toBeUndefined();
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
   * F36-8 (pass 36): the `retry_other_backend` option says BOTH things the
   * human is choosing — the model the retry will run on (the profile's own id
   * belongs to the failed backend, so the other backend's default runs) and
   * that later runs on this task stay on the backend picked here. Live, the
   * option read "re-run the same agent there and continue", the retry ran on
   * `sonnet`, and nothing on the task named the model.
   *
   * Canary: drop `profileModel` from the option builder and the model sentence
   * falls back to the generic "on its default model".
   */
  it("F36-8: the retry_other_backend option names the model the retry runs on and that the switch pins later runs", async () => {
    const store = setupTestStore(ctx);
    await connectFakeBackend(store.db, store.users.arda.id, "codex");
    const d = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      profileId: "developer",
      profileModel: "sonnet",
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    const retry = d.options.find((o) => o.kind === "retry_other_backend")!;
    expect(retry.detail).toContain(`on \`${defaultModelFor("codex")}\``);
    expect(retry.detail).toContain("`sonnet` is a Claude model");
    expect(retry.detail).toContain("Later runs on this task stay on Codex");
    // A profile whose model the OTHER backend already knows keeps it: no
    // substitution sentence, the model named as its own.
    const native = describe_(store, {
      role: "specialist",
      agentHandle: "jc-developer",
      profileId: "developer",
      profileModel: defaultModelFor("codex"),
      failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
    });
    const keep = native.options.find((o) => o.kind === "retry_other_backend")!;
    expect(keep.detail).toContain(`on its own \`${defaultModelFor("codex")}\``);
    expect(keep.detail).not.toContain("is a Claude model");
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

  /**
   * U35-11 (pass 35): a local TLS or connection failure keeps the overload
   * class and its retry, but is attributed to this deployment's own network
   * path, never to "the provider's own side". Canary: drop the `origin ===
   * "local"` branch and the reason reads "failed on its own side".
   */
  it("overloaded with origin local (operator + specialist): names this deployment's network path, keeps the retry, and the same-backend option says the deployment could not reach the provider", async () => {
    const store = setupTestStore(ctx);
    await connectFakeBackend(store.db, store.users.arda.id, "codex");
    const local = (): RunFailure => ({
      ...failure("overloaded", { apiError: "server_error", apiErrorStatus: null, origin: "local" }),
      providerText: "API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)",
    });
    const op = describe_(store, { failure: local() });
    expect(op.reason).toBe(
      "Claude could not be reached from this deployment: the connection failed before the provider answered (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR).",
    );
    expect(op.reason).not.toContain("provider failed on its own side");
    expect(op.remedy).toBe(
      "Nothing about Arda Test's account or the task is wrong; the fault is on this deployment's network path (TLS, DNS or a proxy). Retry in a few minutes, or run it on Codex now.",
    );
    expect(op.options[0]).toMatchObject({ kind: "block_on_policy", title: "Re-run the operator now", recommended: true });

    const sp = describe_(store, { failure: local(), role: "specialist", agentHandle: "jc-developer", profileId: "jc-developer" });
    // Ruling 212: the other backend is still OFFERED — the owner has it — but it
    // is no longer the recommendation, because this fault was on the
    // deployment's own network path and the other provider is reached over the
    // same path. Taking it would change the task's model permanently to work
    // around a DNS or TLS problem that is still there.
    // CANARY: restore `recommended: true` on the retry_other_backend arm and
    // viberr's default answer to a local network fault is a model change.
    expect(sp.options[0]).toMatchObject({ kind: "retry_other_backend", backend: "codex" });
    expect(sp.options[0]!.recommended).toBeUndefined();
    expect(sp.options[0]!.detail).toContain("a change of model rather than a fix");
    expect(sp.options[1]).toMatchObject({ recommended: true });
    expect(sp.options[1]).toMatchObject({
      kind: "request_edit",
      title: "Retry @jc-developer on Claude now: this deployment could not reach the provider, nothing was changed",
    });
    expect(sp.options[1]!.ev).toContain("this deployment could not reach Claude; the agent is retried as it was");
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

  /**
   * Ruling 224 (F37-44). Live on pass 37 the Codex window went at 23:28 with
   * the provider naming its own reopening ("try again at Sep 14th, 2026 2:27
   * AM"), and every option on the packet was wrong at the moment it was
   * offered: the RECOMMENDED one moved the task permanently off the model its
   * profile declares ("Later runs on this task stay on Claude"), and the
   * alternative asked a human to assert the window had reset three hours
   * before it would. Six tasks stalled that way at once.
   */
  describe("a spent window the provider dated (ruling 224)", () => {
    const FUTURE = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

    it("offers the wait first, takes the recommendation, and carries the instant", () => {
      const store = setupTestStore(ctx);
      const d = describe_(store, {
        role: "specialist",
        agentHandle: "jc-developer",
        profileId: "developer",
        failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: FUTURE }),
      });
      // CANARY: drop the wait arm and the recommendation falls back to an
      // option that changes the deployment's model policy in one click.
      expect(d.options[0]).toMatchObject({
        kind: "wait_for_window",
        recommended: true,
        dueAt: FUTURE,
      });
      expect(d.options[0]!.detail).toContain("the same account and the same model");
      // The resume is an OPERATOR run, not a blind re-dispatch: hours pass,
      // and the board may have moved while the task waited.
      expect(d.options[0]!.detail).toContain("operator run");
      expect(d.options[0]!.profileId).toBeUndefined();
      // Exactly one recommendation, and nothing else holds it.
      expect(d.options.filter((o) => o.recommended)).toHaveLength(1);
      const sendBack = d.options.find((o) => o.kind === "request_edit");
      expect(sendBack?.recommended).not.toBe(true);
      const retry = d.options.find((o) => o.kind === "retry_other_backend");
      expect(retry?.recommended).not.toBe(true);
    });

    it("does the same on the OPERATOR's own packet", () => {
      const store = setupTestStore(ctx);
      // The operator packet is a different builder with the same defect: its
      // recommended option asked the human to assert the window had reset.
      const d = describe_(store, {
        failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: FUTURE }),
      });
      expect(d.options[0]).toMatchObject({
        kind: "wait_for_window",
        recommended: true,
        dueAt: FUTURE,
      });
      const assertReset = d.options.find((o) => o.kind === "block_on_policy");
      expect(assertReset).toBeTruthy();
      // CANARY: leave `recommended: true` on it and viberr recommends the one
      // statement on this packet that is false at the moment it is offered.
      expect(assertReset!.recommended).not.toBe(true);
      expect(d.options.filter((o) => o.recommended)).toHaveLength(1);
    });

    it("leaves the operator packet alone when the window has no dated reopening", () => {
      const store = setupTestStore(ctx);
      const d = describe_(store, {
        failure: failure("quota", { windowRejected: true, window: "five_hour" }),
      });
      expect(d.options.some((o) => o.kind === "wait_for_window")).toBe(false);
      expect(d.options.find((o) => o.recommended)).toMatchObject({
        kind: "block_on_policy",
      });
    });

    it("offers nothing of the kind when the window has no dated reopening", () => {
      const store = setupTestStore(ctx);
      // A quota refusal with no reset instant: there is no moment to schedule,
      // so the old options and the old recommendation stand unchanged.
      const d = describe_(store, {
        role: "specialist",
        agentHandle: "jc-developer",
        failure: failure("quota", { windowRejected: true, window: "five_hour" }),
      });
      expect(d.options.some((o) => o.kind === "wait_for_window")).toBe(false);
      expect(d.options.find((o) => o.recommended)).toBeTruthy();
    });

    it("offers nothing of the kind for a window that has already reopened", () => {
      const store = setupTestStore(ctx);
      // RESET is in the past: waiting for it is not a remedy, it is a no-op.
      const d = describe_(store, {
        role: "specialist",
        agentHandle: "jc-developer",
        failure: failure("quota", { windowRejected: true, window: "five_hour", resetsAt: RESET }),
      });
      expect(d.options.some((o) => o.kind === "wait_for_window")).toBe(false);
    });

    it("offers nothing of the kind for a failure that is not a spent window", () => {
      const store = setupTestStore(ctx);
      // An auth refusal has a reset instant on its facts too in principle, and
      // waiting fixes nothing about a rejected credential.
      const d = describe_(store, {
        role: "specialist",
        agentHandle: "jc-developer",
        failure: failure("auth", { resetsAt: FUTURE }),
      });
      expect(d.options.some((o) => o.kind === "wait_for_window")).toBe(false);
    });
  });

  /**
   * Ruling 221 (F37-41): `session_missing` now has two roads into it, and the
   * difference is what a human does next. A vanished session heals itself on
   * the next fresh run; a session STORE that cannot be opened keeps failing
   * every resume on this host until the file is repaired, so the sentence has
   * to say which one happened.
   */
  it("names the unreadable STORE rather than a vanished session (ruling 221)", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      role: "specialist",
      agentHandle: "developer",
      failure: {
        kind: "session_missing",
        text: "The Codex session could not be resumed — the CLI's own session store on this host could not be opened.",
        facts: emptyRunFailureFacts("session_missing"),
      },
    });
    // CANARY: drop the branch and a human reads "no longer exists" about a
    // file that is right there and will break the next resume too.
    expect(d.reason).toContain("session store on this host could not be opened");
    expect(d.reason).not.toContain("no longer exists");
    expect(d.remedy).toContain("repaired or removed");
  });

  it("keeps the vanished-session sentence for a vanished session (ruling 221)", () => {
    const store = setupTestStore(ctx);
    const d = describe_(store, {
      role: "specialist",
      agentHandle: "developer",
      failure: {
        kind: "session_missing",
        text: "rollout not found",
        facts: emptyRunFailureFacts("session_missing"),
      },
    });
    expect(d.reason).toContain("no longer exists");
    expect(d.remedy).not.toContain("repaired or removed");
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
