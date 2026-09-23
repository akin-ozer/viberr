import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertTestUser } from "../../../test-support/test-store";
import { getHomePrefs, getPref, setPref } from "./user-prefs.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** Hand-edited row: bypasses setPref so value_json can hold non-JSON. */
function writeRawPref(db: DatabaseSync, userId: string, key: string, raw: string): void {
  db.prepare(
    `INSERT INTO user_prefs (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, key, raw, new Date().toISOString());
}

describe("user prefs store", () => {
  it("round-trips a JSON document through setPref/getPref (schemaless read)", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    setPref(db, "u_1", "k", { nested: { on: true }, list: [1, "two", null] });
    expect(getPref(db, "u_1", "k")).toEqual({
      nested: { on: true },
      list: [1, "two", null],
    });
  });

  it("reads a missing row as null", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    expect(getPref(db, "u_1", "never-written")).toBeNull();
    expect(getPref(db, "u_1", "never-written", z.string())).toBeNull();
  });

  it("reads a hand-edited non-JSON blob as null, like a missing row", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    writeRawPref(db, "u_1", "k", "{not json");
    expect(getPref(db, "u_1", "k")).toBeNull();
    expect(getPref(db, "u_1", "k", z.string())).toBeNull();
  });

  it("decodes through a supplied schema and reads non-conforming JSON as null", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    setPref(db, "u_1", "motion", "reduce");
    expect(getPref(db, "u_1", "motion", z.enum(["full", "reduce"]))).toBe("reduce");
    expect(getPref(db, "u_1", "motion", z.number())).toBeNull();
  });

  it("upserts: a second setPref under the same key replaces the value", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    setPref(db, "u_1", "k", "first");
    setPref(db, "u_1", "k", "second");
    expect(getPref(db, "u_1", "k")).toBe("second");
  });

  it("home prefs fall back to defaults for missing and junk rows", () => {
    const db = ctx.makeDb();
    insertTestUser(db, "u_1");
    expect(getHomePrefs(db, "u_1")).toEqual({ view: "grid", stars: {} });
    setPref(db, "u_1", "home", "not-an-object");
    expect(getHomePrefs(db, "u_1")).toEqual({ view: "grid", stars: {} });
    setPref(db, "u_1", "home", { view: "list", stars: { core: true } });
    expect(getHomePrefs(db, "u_1")).toEqual({ view: "list", stars: { core: true } });
  });
});
