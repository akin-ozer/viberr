import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  backendDispatchHold,
  latestBackendRateLimits,
  parseQuotaResetAt,
  recordBackendCredentialRefusal,
  recordBackendQuotaExhaustion,
  retireBackendRefusalsFor,
  UNDATED_HOLD_MS,
  type BackendCredentialRefusal,
  type BackendQuotaExhaustion,
} from "./backend-quota.server";

/**
 * G35-4 / ruling 152(c) (pass 35): the reset instant of a five-hour Codex
 * window and the hold a dispatch honours.
 *
 * Live, the Codex CLI refused with "try again at 6:18 PM": a time, no date,
 * no zone. `parseQuotaResetAt` needed a month and a day, so the sink stored
 * `resetsAt: null`, the Insights card could not say when the window reopened
 * and nothing could schedule a retry. The CLI prints the wall clock of the
 * PROCESS that ran it (18:18Z in a UTC container), so the time is resolved
 * with the process's own local setters, never `Date.UTC`.
 *
 * Canaries: delete the time-only arm and every parse below answers null;
 * drop the `resetsAt * 1000 > nowMs` comparison and the passed hold stands.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** The instant the process's local clock names for `h:mm` at or after `observed`. */
function nextLocal(observedIso: string, hour: number, minute: number): number {
  const base = new Date(Date.parse(observedIso));
  const d = new Date(base.getTime());
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() < base.getTime()) d.setDate(d.getDate() + 1);
  return Math.round(d.getTime() / 1000);
}

const CODEX_TIME_ONLY =
  "You've hit your usage limit. To continue using Codex, start a free trial of Plus today, or try again at 6:18 PM.";

describe("parseQuotaResetAt: a time-only Codex refusal (G35-4)", () => {
  it("resolves 'try again at 6:18 PM' in the process zone, at or after the observation, precision clock", () => {
    const observed = "2026-09-06T14:03:00Z";
    const reset = parseQuotaResetAt(CODEX_TIME_ONLY, observed);
    expect(reset).toEqual({ at: nextLocal(observed, 18, 18), precision: "clock" });
    // Never UTC by construction: the same wall clock resolved in UTC is a
    // different instant in every non-UTC zone this test could run in.
    const utc = Math.round(Date.UTC(2026, 8, 6, 18, 18) / 1000);
    const offsetMin = new Date(Date.parse(observed)).getTimezoneOffset();
    if (offsetMin !== 0) expect(reset!.at).not.toBe(utc);
  });

  it("an observation after the named time rolls to the next day", () => {
    // Pick an observation instant that is after 18:18 LOCAL wherever this runs.
    const base = new Date("2026-09-06T12:00:00Z");
    base.setHours(20, 0, 0, 0);
    const observed = base.toISOString();
    const reset = parseQuotaResetAt(CODEX_TIME_ONLY, observed)!;
    expect(reset.precision).toBe("clock");
    expect(reset.at).toBe(nextLocal(observed, 18, 18));
    expect(reset.at * 1000).toBeGreaterThan(base.getTime());
    const day = new Date(reset.at * 1000);
    expect(day.getDate()).toBe(new Date(base.getTime() + 24 * 60 * 60 * 1000).getDate());
  });

  it("accepts a 24-hour clock and a bare hour with a meridiem; refuses an impossible one", () => {
    const observed = "2026-09-06T01:00:00Z";
    expect(parseQuotaResetAt("try again at 18:18", observed)).toEqual({
      at: nextLocal(observed, 18, 18),
      precision: "clock",
    });
    expect(parseQuotaResetAt("try again at 6 PM.", observed)).toEqual({
      at: nextLocal(observed, 18, 0),
      precision: "clock",
    });
    expect(parseQuotaResetAt("try again at 13 PM", observed)).toBeNull();
    expect(parseQuotaResetAt("try again later", observed)).toBeNull();
  });

  it("a dated phrase keeps its prose (UTC) resolution; the time-only arm never steals it", () => {
    expect(parseQuotaResetAt("try again at Sep 18th, 2026 5:20 PM.", "2026-09-06T14:03:00Z")).toEqual({
      at: Math.round(Date.UTC(2026, 8, 18, 17, 20) / 1000),
      precision: "prose",
    });
  });
});

describe("backendDispatchHold (ruling 152(c))", () => {
  const OBSERVED = "2026-09-06T14:03:00.000Z";
  const nowMs = Date.parse(OBSERVED) + 5 * 60_000;
  const OWNER = "u_arda";
  function exhaustion(over: Partial<BackendQuotaExhaustion> = {}): BackendQuotaExhaustion {
    return {
      credentialUserId: OWNER,
      credentialLabel: "Arda",
      resetsAt: Math.round(nowMs / 1000) + 3600,
      resetsAtPrecision: "clock",
      providerText: CODEX_TIME_ONLY,
      runId: "run_refused",
      observedAt: OBSERVED,
      ...over,
    };
  }

  it("holds before the reset instant and not after it, with no grace window", () => {
    const db = ctx.makeDb();
    const record = exhaustion();
    recordBackendQuotaExhaustion(db, "codex", record);
    const before = backendDispatchHold(db, "codex", { nowMs, credentialUserId: OWNER });
    expect(before).toEqual({
      until: record.resetsAt! * 1000,
      providerText: CODEX_TIME_ONLY,
      observedAt: OBSERVED,
    });
    // One second past the instant: the hold trusts the provider (the Insights
    // card's 24 h grace is the card's, not the dispatch's).
    expect(
      backendDispatchHold(db, "codex", { nowMs: record.resetsAt! * 1000 + 1000, credentialUserId: OWNER }),
    ).toBeNull();
    // The other backend is untouched: a Claude retry proceeds while Codex is held.
    expect(backendDispatchHold(db, "claude", { nowMs, credentialUserId: OWNER })).toBeNull();
  });

  it("a record that named no reset holds for UNDATED_HOLD_MS after the refusal", () => {
    const db = ctx.makeDb();
    recordBackendQuotaExhaustion(db, "codex", exhaustion({ resetsAt: null, resetsAtPrecision: null }));
    const observedMs = Date.parse(OBSERVED);
    expect(
      backendDispatchHold(db, "codex", { nowMs: observedMs + UNDATED_HOLD_MS - 1000, credentialUserId: OWNER }),
    ).toMatchObject({ until: null, observedAt: OBSERVED });
    expect(
      backendDispatchHold(db, "codex", { nowMs: observedMs + UNDATED_HOLD_MS, credentialUserId: OWNER }),
    ).toBeNull();
  });

  it("ruling 146: the hold is about the account it names, so another person's dispatch is not held; a record naming nobody holds everyone", () => {
    const db = ctx.makeDb();
    recordBackendQuotaExhaustion(db, "codex", exhaustion());
    expect(backendDispatchHold(db, "codex", { nowMs, credentialUserId: "u_someone_else" })).toBeNull();
    recordBackendQuotaExhaustion(db, "codex", exhaustion({ credentialUserId: null, credentialLabel: null }));
    expect(backendDispatchHold(db, "codex", { nowMs, credentialUserId: "u_someone_else" })).not.toBeNull();
  });

  it("no record, no hold", () => {
    const db = ctx.makeDb();
    expect(backendDispatchHold(db, "codex", { nowMs, credentialUserId: OWNER })).toBeNull();
  });
});

/**
 * Ruling 165: a change to the named person's credential retires the records
 * observed on the credential it replaces, and the dispatch hold with them.
 * Live (2026-09-07) a Claude card kept "usage window spent · reopens 21:30"
 * after its owner signed the backend into another account.
 *
 * Canaries: drop the `credentialUserId` comparison in `retireBackendRefusalsFor`
 * and the ruling-146 case fails; drop either `deleteSetting` and the first case
 * fails on that record.
 */
describe("retireBackendRefusalsFor (ruling 165)", () => {
  const OBSERVED = "2026-09-07T15:33:00.000Z";
  const nowMs = Date.parse(OBSERVED) + 5 * 60_000;
  const nowIso = new Date(nowMs).toISOString();
  const OWNER = "u_arda";
  function exhaustion(over: Partial<BackendQuotaExhaustion> = {}): BackendQuotaExhaustion {
    return {
      credentialUserId: OWNER,
      credentialLabel: "Arda",
      resetsAt: Math.round(nowMs / 1000) + 3600,
      resetsAtPrecision: "exact",
      providerText: "Claude AI usage limit reached|1780000000",
      runId: "run_spent",
      observedAt: OBSERVED,
      ...over,
    };
  }
  function refusal(over: Partial<BackendCredentialRefusal> = {}): BackendCredentialRefusal {
    return {
      credentialUserId: OWNER,
      credentialLabel: "Arda",
      providerText: "The account's organization does not allow Claude Code (oauth_org_not_allowed).",
      runId: "run_refused",
      observedAt: OBSERVED,
      ...over,
    };
  }
  const rowsOf = (db: Parameters<typeof latestBackendRateLimits>[0]) =>
    new Map(latestBackendRateLimits(db, nowIso).map((row) => [row.backend, row]));

  it("retires the exhaustion and the credential refusal naming the person, on that backend only, and the hold with them", () => {
    const db = ctx.makeDb();
    recordBackendQuotaExhaustion(db, "claude", exhaustion());
    recordBackendCredentialRefusal(db, "claude", refusal());
    recordBackendQuotaExhaustion(db, "codex", exhaustion());
    expect(backendDispatchHold(db, "claude", { nowMs, credentialUserId: OWNER })).not.toBeNull();

    retireBackendRefusalsFor(db, "claude", OWNER);

    const rows = rowsOf(db);
    expect(rows.get("claude")).toMatchObject({ exhausted: null, credentialRefused: null });
    // The other backend's record is about a different account of the same
    // person, and nothing about it changed.
    expect(rows.get("codex")!.exhausted).not.toBeNull();
    // The next run on the new credential is the real probe: no hold stands.
    expect(backendDispatchHold(db, "claude", { nowMs, credentialUserId: OWNER })).toBeNull();
  });

  it("ruling 146: a record naming another person, or nobody, is not this person's to retire", () => {
    const db = ctx.makeDb();
    recordBackendQuotaExhaustion(db, "claude", exhaustion({ credentialUserId: "u_murat", credentialLabel: "Murat" }));
    recordBackendCredentialRefusal(db, "claude", refusal({ credentialUserId: null, credentialLabel: null }));

    retireBackendRefusalsFor(db, "claude", OWNER);

    const claude = rowsOf(db).get("claude")!;
    expect(claude.exhausted?.credentialUserId).toBe("u_murat");
    expect(claude.credentialRefused).not.toBeNull();
    expect(claude.credentialRefused?.credentialUserId).toBeNull();
    // Still nobody's record, so it still holds everyone (ruling 146).
    expect(backendDispatchHold(db, "claude", { nowMs, credentialUserId: OWNER })).toBeNull();
  });

  it("nothing recorded, nothing to retire, no error", () => {
    const db = ctx.makeDb();
    expect(() => retireBackendRefusalsFor(db, "codex", OWNER)).not.toThrow();
    expect(rowsOf(db).get("codex")).toMatchObject({ exhausted: null, credentialRefused: null });
  });
});
