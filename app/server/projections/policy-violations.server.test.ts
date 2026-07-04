import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed } from "~/server/seed/demo-seed.server";
import { countOpenPolicyViolations } from "./policy-violations.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function seed() {
  const db = ctx.makeDb();
  const dataRoot = ctx.makeTempDir();
  runDemoSeed(db, { dataRoot });
  return db;
}

function insertPolicyEvent(
  db: ReturnType<typeof ctx.makeDb>,
  taskKey: string,
  position: number,
  text: string,
) {
  db.prepare(
    `INSERT INTO task_events
       (project_slug, task_key, position, occurred_at, type, actor_kind,
        actor_ref, actor_json, title, text, to_agent, evidence_json)
     VALUES ('viberr-core', ?, ?, ?, 'policy', 'system', 'system:policy-engine',
             '{"kind":"system","name":"Policy engine"}', NULL, ?, 0, NULL)`,
  ).run(taskKey, position, new Date().toISOString(), text);
}

describe("countOpenPolicyViolations (phase-4 rail badge derivation)", () => {
  it("counts the seeded VIB-142 PAT-scope violation as 1 open", () => {
    const db = seed();
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(1);
    expect(countOpenPolicyViolations(db, "deploy-pipeline")).toBe(0);
  });

  it("a newer **Policy update:** event on the same task resolves it", () => {
    const db = seed();
    insertPolicyEvent(
      db,
      "VIB-142",
      -1, // newer than position 0 (newest-first order)
      "**Policy update:** `pull_request:write` granted on the project credential.",
    );
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(0);
  });

  it("violations on distinct tasks accumulate; non-marker policy events are neutral", () => {
    const db = seed();
    insertPolicyEvent(
      db,
      "VIB-139",
      -1,
      "**Policy violation:** example second violation.",
    );
    // Neutral policy event (blocked agent action) must not resolve anything.
    insertPolicyEvent(db, "VIB-142", -2, "Blocked agent action: example.");
    expect(countOpenPolicyViolations(db, "viberr-core")).toBe(2);
  });
});
