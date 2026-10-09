import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { reconfigureProject } from "../../../test-support/projected-store";
import type { WorkflowBoundary } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { defaultTransitionBy } from "~/shared/workflow/transitions";
import { convertTemplateReviewEntry } from "./review-entry-conversion.server";

/**
 * Ruling 91: the Standard board's move into Review is `auto`. An older board
 * carries the template's old approval edge in its project.md, and boot
 * converts it once; an approval a person chose stays.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** The template's In Progress → Review edge as project creation once wrote
 *  it. */
const OLD_REVIEW_ENTRY: WorkflowBoundary = {
  from: "impl",
  to: "review",
  boundary: "approval",
  by: "Operator transition request, with evidence attached",
  locked: false,
};

const isReviewEntry = (w: WorkflowBoundary) => w.from === "impl" && w.to === "review";

/** The Standard board as it was created before the ruling. */
const OLD_STANDARD = GOVERNED_TEMPLATE.workflow.map((w) => (isReviewEntry(w) ? OLD_REVIEW_ENTRY : w));

function boardWith(store: TestStore, workflow: WorkflowBoundary[]): void {
  reconfigureProject(store, { workflow });
}

function workflowOf(store: TestStore): WorkflowBoundary[] {
  return readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter
    .workflow;
}

const boundaryChanges = (store: TestStore) =>
  listAuditEvents(store.db, { action: "project.policy.boundary_changed" });

describe("convertTemplateReviewEntry (ruling 91)", () => {
  it("gives a board created before the ruling the template's automatic move into Review, once, on the record", async () => {
    // CANARY: skip the write and the board still asks a person to confirm the
    // move; drop the audit row and the Policy page cannot say who changed it.
    const store = setupTestStore(ctx);
    boardWith(store, OLD_STANDARD);

    expect(await convertTemplateReviewEntry(store.db, { dataRoot: store.dataRoot })).toEqual([
      store.slug,
    ]);
    expect(workflowOf(store)).toEqual(GOVERNED_TEMPLATE.workflow);
    const rows = boundaryChanges(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "system",
      subjectId: "impl>review",
      projectSlug: store.slug,
      details: { from: "In Progress", to: "Review", boundary: "auto" },
    });

    // The next boot finds nothing left to convert and records nothing.
    expect(await convertTemplateReviewEntry(store.db, { dataRoot: store.dataRoot })).toEqual([]);
    expect(boundaryChanges(store)).toHaveLength(1);
  });

  it.each([
    [
      // CANARY: drop the strict check and a strict board loses the gate its
      // preset promised on every advance.
      "a strict board, where a person approves every advance",
      OLD_STANDARD.map((w) =>
        w.boundary === "auto"
          ? { ...w, boundary: "approval" as const, by: "Human approval (strict policy) before work advances" }
          : w,
      ),
    ],
    [
      // CANARY: match on the boundary alone and a choice a person made on the
      // Policy page is undone at the next boot.
      "an approval a person set on the Policy page",
      GOVERNED_TEMPLATE.workflow.map((w) =>
        isReviewEntry(w)
          ? { ...w, boundary: "approval" as const, by: defaultTransitionBy("approval") }
          : w,
      ),
    ],
  ])("leaves %s alone", async (_case, workflow) => {
    const store = setupTestStore(ctx);
    boardWith(store, workflow);

    expect(await convertTemplateReviewEntry(store.db, { dataRoot: store.dataRoot })).toEqual([]);
    expect(workflowOf(store)).toEqual(workflow);
    expect(boundaryChanges(store)).toHaveLength(0);
  });
});
