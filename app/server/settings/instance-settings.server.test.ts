import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  getMaxConcurrentRuns,
  MAX_CONCURRENT_RUNS_CEILING,
  setMaxConcurrentRuns,
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
    setMaxConcurrentRuns(db, 4);
    expect(getMaxConcurrentRuns(db)).toBe(4);
    setMaxConcurrentRuns(db, 0);
    expect(getMaxConcurrentRuns(db)).toBe(0);
  });

  it("clamps into [0, ceiling] and floors a fractional value", () => {
    const db = ctx.makeDb();
    expect(setMaxConcurrentRuns(db, -5)).toBe(0);
    expect(getMaxConcurrentRuns(db)).toBe(0);
    expect(setMaxConcurrentRuns(db, 999)).toBe(MAX_CONCURRENT_RUNS_CEILING);
    expect(getMaxConcurrentRuns(db)).toBe(MAX_CONCURRENT_RUNS_CEILING);
    expect(setMaxConcurrentRuns(db, 3.9)).toBe(3);
  });

  it("refuses a non-finite value rather than disabling the gate", () => {
    const db = ctx.makeDb();
    setMaxConcurrentRuns(db, 5);
    expect(() => setMaxConcurrentRuns(db, Number.NaN)).toThrow();
    // The prior value is intact — a bad write never silently reset the cap.
    expect(getMaxConcurrentRuns(db)).toBe(5);
  });
});
