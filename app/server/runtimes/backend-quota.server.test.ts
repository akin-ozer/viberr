import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  backendDispatchHold,
  latestBackendRateLimits,
  parseQuotaResetAt,
  recordBackendQuotaExhaustion,
  recordBackendRateLimit,
  retireBackendRecordsFor,
  UNDATED_HOLD_MS,
  type BackendQuotaExhaustion,
  type QuotaReset,
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

describe("parseQuotaResetAt: an emitted epoch and a (UTC) clock (D5, ruling 130(d))", () => {
  it("reads an emitted epoch as exact and a (UTC) clock as its next UTC occurrence, and answers null rather than guessing", () => {
    const rows: { text: string; observed?: string; expected: QuotaReset | null }[] = [
      // Claude: a bare unix epoch after a pipe — no interpretation, no timezone.
      { text: "Claude AI usage limit reached|1750000000", expected: { at: 1_750_000_000, precision: "exact" } },
      // No date named, and prose that only mentions the limit: null, so the card
      // falls back to the observed instant instead of inventing a window.
      { text: "You've hit your usage limit. Upgrade to Plus.", expected: null },
      // A word in a month's position that is not a month is not a date.
      { text: "try again at soon 18, 2026", expected: null },
      {
        text: "You've hit your session limit · resets 11:50am (UTC)",
        observed: "2026-09-07T09:00:00.000Z",
        expected: { at: Date.UTC(2026, 8, 7, 11, 50) / 1000, precision: "clock" },
      },
      // Already past today: tomorrow.
      {
        text: "resets 11:50am (UTC)",
        observed: "2026-09-07T12:00:00.000Z",
        expected: { at: Date.UTC(2026, 8, 8, 11, 50) / 1000, precision: "clock" },
      },
      {
        text: "resets 7pm (UTC)",
        observed: "2026-09-07T12:00:00.000Z",
        expected: { at: Date.UTC(2026, 8, 7, 19, 0) / 1000, precision: "clock" },
      },
    ];
    for (const { text, observed, expected } of rows) {
      expect(parseQuotaResetAt(text, observed), text).toEqual(expected);
    }
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
 * The exhaustion and the credential refusal are retired through the real
 * writers in `backend-credentials.server.test.ts` ("a change of the account in
 * use retires the refusal observed on the previous one"), which record no
 * reading; the reading is retired here.
 */
describe("retireBackendRecordsFor (ruling 165)", () => {
  const OBSERVED = "2026-09-07T15:33:00.000Z";
  const nowMs = Date.parse(OBSERVED) + 5 * 60_000;
  const nowIso = new Date(nowMs).toISOString();
  const OWNER = "u_arda";
  const rowsOf = (db: Parameters<typeof latestBackendRateLimits>[0]) =>
    new Map(latestBackendRateLimits(db, nowIso).map((row) => [row.backend, row]));

  /**
   * Ruling 294 (pass 37, F37-129): the utilization READING goes with the
   * account too. Ruling 165's own sentence is "the refusal Viberr observed on
   * the slot goes with it", and it was applied to two of the three records this
   * module keeps.
   *
   * The live failure, on this instance while it was written: the owner
   * connected a Claude account with a fresh window and /insights went on
   * reading "claude · 95% of seven day" — a figure about an account no longer
   * connected, on the surface a person checks to decide whether there is room
   * to run. The refusal beside it retired correctly; only the percentage lied.
   */
  it("ruling 294: retires the READING naming the person, and leaves another account's alone", () => {
    const db = ctx.makeDb();
    const reading = {
      credentialUserId: OWNER,
      credentialLabel: "Arda",
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.95,
      resetsAt: Math.round(nowMs / 1000) + 3600,
      isUsingOverage: false,
      observedAt: OBSERVED,
    };
    recordBackendRateLimit(db, "claude", reading);
    recordBackendRateLimit(db, "codex", { ...reading, credentialUserId: "u_murat", credentialLabel: "Murat" });
    expect(rowsOf(db).get("claude")!.reading).not.toBeNull();

    // CANARY: drop the KEY_PREFIX branch from `retireBackendRecordsFor` and the
    // old account's 95% survives its own disconnection.
    retireBackendRecordsFor(db, "claude", OWNER);

    expect(rowsOf(db).get("claude")!.reading).toBeNull();
    // A reading about SOMEONE ELSE's account is not this person's to retire,
    // the same line the exhaustion and the refusal take.
    expect(rowsOf(db).get("codex")!.reading?.credentialUserId).toBe("u_murat");
  });
});
