import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { baseTaskFrontmatter, setupTestStore, writeTask } from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { prAdoptionText, recordPrAdoption } from "./pr-adoption-record.server";

/**
 * Pass 34 (F34-9): an adoption is recorded — one `github` timeline event
 * naming the adopted PR, its head and the PR it replaces, and a
 * `github.pr.adopted` audit row — from both doors.
 *
 * Canary: skip the `appendTimelineEvent` call (or the `recordAudit` call) and
 * the matching assertion fails.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("recordPrAdoption", () => {
  it("writes the timeline event and the audit row, attributed to the door that adopted", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("JC-4", { branch: "jc-4", pr: { number: 5, state: "closed", title: "old" } }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const ref = { projectSlug: store.slug, taskKey: "JC-4", dataRoot: store.dataRoot };
    await recordPrAdoption(
      store.db,
      ref,
      {
        repo: "akin-ozer/viberr",
        branch: "jc-4",
        prNumber: 6,
        previousPrNumber: 5,
        previousState: "closed",
        headSha: "c3efdbe".padEnd(40, "0"),
        source: "reconciler",
      },
      { userId: "policy-engine", label: "system:policy-engine" },
    );
    const event = readTaskFile(ref)!.parsed.timeline.find((e) => e.text.includes("Adopted **PR #"));
    expect(event).toBeTruthy();
    expect(event!.type).toBe("github");
    expect(event!.actor).toEqual({ kind: "system", systemId: "policy-engine" });
    expect(event!.text).toContain("Adopted **PR #6** (head `c3efdbe`, the delivered revision) as JC-4's review PR, replacing PR #5 (closed)");
    expect(event!.text).toContain("Viberr did not open it");
    const audit = listAuditEvents(store.db).find((e) => e.action === "github.pr.adopted");
    expect(audit?.details).toMatchObject({
      prNumber: 6,
      previousPrNumber: 5,
      previousState: "closed",
      source: "reconciler",
      branch: "jc-4",
    });
    // The projection saw the new event.
    // SAFETY: a `count(*) AS c` aggregate answers exactly one row with the integer `c`.
    const count = (store.db
      .prepare(`SELECT count(*) AS c FROM task_events WHERE task_key = 'JC-4' AND type = 'github'`)
      .get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("a first adoption (no previous PR) and the delivery door read honestly", () => {
    expect(
      prAdoptionText("JC-4", {
        repo: "r",
        branch: "jc-4",
        prNumber: 9,
        previousPrNumber: null,
        previousState: null,
        headSha: null,
        source: "delivery",
      }),
    ).toBe("Adopted **PR #9** as JC-4's review PR. Viberr did not open it; it was found on branch `jc-4` with this task's delivered head.");
  });
});
