import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "./notification.server";

/**
 * P11-54: the `notifications.kind` CHECK and the TS `NOTIFICATION_KINDS` union
 * were hand-mirrored with no single source. This pins them together — adding a
 * kind in one place without the other fails here instead of at runtime INSERT.
 */
describe("notification kinds — single source (P11-54)", () => {
  it("the baseline migration CHECK lists exactly NOTIFICATION_KINDS", () => {
    const sql = readFileSync(
      path.join(__dirname, "..", "..", "..", "db", "migrations", "0001_baseline.sql"),
      "utf8",
    );
    // Anchor to the notifications table FIRST — other tables also declare a
    // `kind TEXT NOT NULL CHECK (kind IN (…))` column (e.g. agent_runs), so a
    // whole-file match would pin whichever table happens to come first.
    const table = sql.match(/CREATE TABLE notifications \(([\s\S]*?)\);/);
    expect(table, "notifications table not found in baseline").toBeTruthy();
    const match = table![1]!.match(/kind TEXT NOT NULL CHECK \(kind IN \(([^)]+)\)\)/);
    expect(match, "notifications.kind CHECK not found in baseline").toBeTruthy();
    const inCheck = match![1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .sort();
    expect(inCheck).toEqual([...NOTIFICATION_KINDS].sort());
  });
});
