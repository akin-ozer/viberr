import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, writeProject, type TestStore } from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import type { OperatorAutonomy } from "~/server/tasks/operator-actions.server";
import { resolveAcceptanceAuthority } from "./review-acceptance-authority.server";

/**
 * P13-D-9: the Review queue's "always a human action" claim is now conditional,
 * so the condition itself needs pinning. Owner ruling Q1 makes the exception
 * deliberately narrow — FULL autonomy *and* an explicit
 * `completion-for-acceptance: direct` grant — and `gate()` refuses to promote
 * `recommend → direct` for that one capability even at full autonomy, precisely
 * so an admin who configured `recommend` never gets a silent agent close.
 *
 * The decision table is driven through the REAL resolver: each case deploys the
 * operator it describes into the project file, so a change to how autonomy or a
 * grant is read off that file cannot pass here while breaking the queue.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

/** Deploy an operator carrying one `completion-for-acceptance` grant, or none
 *  at all when `deployed` is false. */
function deployOperator(
  store: TestStore,
  operator: {
    deployed?: boolean;
    autonomy?: OperatorAutonomy;
    completion?: CapabilityMode;
  },
): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents:
      operator.deployed === false
        ? []
        : [
            {
              profileId: "operator",
              capabilities: [
                {
                  capabilityId: "completion-for-acceptance",
                  mode: operator.completion ?? "recommend",
                },
              ],
              extras: [],
              definition: {
                kind: "operator",
                backends: ["claude"],
                model: "sonnet",
                autonomy: operator.autonomy ?? "supervised",
              },
            },
          ],
  });
}

describe("resolveAcceptanceAuthority", () => {
  it("grants the exception only for full autonomy + an explicit direct grant", () => {
    const store = setupTestStore(ctx);
    deployOperator(store, { autonomy: "full", completion: "direct" });
    // Ruling 518: the operator is always called Operator.
    expect(resolveAcceptanceAuthority(store.slug, { dataRoot: store.dataRoot })).toEqual({
      operatorCanAccept: true,
      operatorName: "Operator",
    });
  });

  it("refuses to promote recommend → direct at full autonomy (ruling Q1)", () => {
    const store = setupTestStore(ctx);
    deployOperator(store, { autonomy: "full", completion: "recommend" });
    expect(
      resolveAcceptanceAuthority(store.slug, { dataRoot: store.dataRoot }).operatorCanAccept,
    ).toBe(false);
  });

  it("refuses a direct grant held by a supervised operator", () => {
    const store = setupTestStore(ctx);
    deployOperator(store, { autonomy: "supervised", completion: "direct" });
    expect(
      resolveAcceptanceAuthority(store.slug, { dataRoot: store.dataRoot }).operatorCanAccept,
    ).toBe(false);
  });

  it("refuses when no operator is deployed at all", () => {
    const store = setupTestStore(ctx);
    deployOperator(store, { deployed: false });
    expect(
      resolveAcceptanceAuthority(store.slug, { dataRoot: store.dataRoot }).operatorCanAccept,
    ).toBe(false);
  });

  // The "unreadable project falls back to the strict boundary" case runs
  // against the REAL resolver in review-route.server.test.ts too.
});
