import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  coordinationLane,
  deleteSetting,
  getMaxConcurrentRuns,
  getSetting,
  setMaxConcurrentRuns,
  setSetting,
} from "./instance-settings.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("instance settings — run concurrency cap", () => {
  it("defaults to 0 (unlimited) when unset", () => {
    const db = ctx.makeDb();
    expect(getMaxConcurrentRuns(db)).toBe(0);
  });

  it("round-trips a set value", () => {
    const db = ctx.makeDb();
    setMaxConcurrentRuns(db, 4, SYSTEM_ACTOR);
    expect(getMaxConcurrentRuns(db)).toBe(4);
    setMaxConcurrentRuns(db, 0, SYSTEM_ACTOR);
    expect(getMaxConcurrentRuns(db)).toBe(0);
  });

  it("clamps into [0, ceiling] and floors a fractional value", () => {
    const db = ctx.makeDb();
    expect(setMaxConcurrentRuns(db, -5, SYSTEM_ACTOR)).toBe(0);
    expect(getMaxConcurrentRuns(db)).toBe(0);
    expect(setMaxConcurrentRuns(db, 999, SYSTEM_ACTOR)).toBe(64);
    expect(getMaxConcurrentRuns(db)).toBe(64);
    expect(setMaxConcurrentRuns(db, 3.9, SYSTEM_ACTOR)).toBe(3);
  });

  it("refuses a non-finite value rather than disabling the gate", () => {
    const db = ctx.makeDb();
    setMaxConcurrentRuns(db, 5, SYSTEM_ACTOR);
    expect(() => setMaxConcurrentRuns(db, Number.NaN, SYSTEM_ACTOR)).toThrow();
    // The prior value is intact — a bad write never silently reset the cap.
    expect(getMaxConcurrentRuns(db)).toBe(5);
  });

  // Ruling 150: one extra slot per four of the cap, minimum one, none when
  // the gate is off. The org-settings sentence, the admission gate and the
  // health snapshot all read this one function.
  it("ruling 150: the coordination lane is one slot per four of the cap, minimum one", () => {
    expect(coordinationLane(0)).toBe(0);
    expect(coordinationLane(1)).toBe(1);
    expect(coordinationLane(4)).toBe(1);
    expect(coordinationLane(5)).toBe(2);
    expect(coordinationLane(8)).toBe(2);
    expect(coordinationLane(9)).toBe(3);
    expect(coordinationLane(64)).toBe(16);
  });
});

/**
 * V14 (pass 31): backend-quota carried its own line-for-line copy of these
 * three accessors (a tolerant read, an upsert, a delete). They are the store's
 * accessors, not the concurrency cap's, so they are exported and shared — which
 * means the record shapes a keyed observation writes have to survive them.
 */
describe("instance settings — the shared key/value accessors", () => {
  const recordSchema = z.object({
    utilization: z.number().nullable(),
    observedAt: z.string(),
    tags: z.array(z.string()),
  });

  it("round-trips a record value, not just a scalar", () => {
    const db = ctx.makeDb();
    const value = {
      utilization: 0.91,
      observedAt: "2026-08-31T09:00:00.000Z",
      tags: ["seven_day"],
    };
    setSetting(db, "quota.claude", value);
    expect(getSetting(db, "quota.claude", recordSchema)).toEqual(value);
    // A later write REPLACES the value under the same key (the upsert arm).
    setSetting(db, "quota.claude", { ...value, utilization: null });
    expect(getSetting(db, "quota.claude", recordSchema)?.utilization).toBeNull();
  });

  it("reads absent, corrupt and off-schema rows as null rather than throwing", () => {
    const db = ctx.makeDb();
    expect(getSetting(db, "quota.codex", recordSchema)).toBeNull();
    // Corrupt JSON — a page must not fail over a value it can live without.
    db.prepare(
      `INSERT INTO instance_settings (key, value_json, updated_at)
       VALUES ('quota.codex', '{not json', '2026-08-31T09:00:00.000Z')`,
    ).run();
    expect(getSetting(db, "quota.codex", recordSchema)).toBeNull();
    // Valid JSON of a shape this schema no longer accepts.
    setSetting(db, "quota.codex", { utilization: 0.5 });
    expect(getSetting(db, "quota.codex", recordSchema)).toBeNull();
  });

  it("deletes a key so absence is readable as absence", () => {
    const db = ctx.makeDb();
    setSetting(db, "quota.claude", {
      utilization: 1,
      observedAt: "2026-08-31T09:00:00.000Z",
      tags: [],
    });
    // CANARY: make `deleteSetting` a no-op and this key survives, which is
    // exactly how a cleared quota-exhaustion flag would come back.
    deleteSetting(db, "quota.claude");
    expect(getSetting(db, "quota.claude", recordSchema)).toBeNull();
    // Deleting a key that was never there is a no-op, not an error.
    expect(() => deleteSetting(db, "quota.claude")).not.toThrow();
  });
});
