import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resolveDeliveryPushGrant } from "./task-actions.server";

/**
 * P11-13: the Review-time push-grant guard. A withheld-grant deliverer must not
 * have its workspace pushed; and — the regression the adversarial review caught —
 * a deliverer NAMED in the task but whose profile was undeployed between the run
 * and Review must fall back CONSERVATIVE (deny), never permissive.
 */

let ctx: TestDbContext;
let store: TestStore;

/** Deploy a `dev` specialist with a specific commit-push grant mode. */
function deployDev(mode: "direct" | "human" | "off"): void {
  const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed
    .frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: [
          { capabilityId: "execute-code-or-write-repo", mode },
          { capabilityId: "commit-push-branch", mode },
        ],
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "developer",
          backends: ["claude"],
          model: "sonnet",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Write a review-stage task whose delivering engagement names `profileId`. */
function writeDeliveringTask(profileId: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "review",
      engagements: [
        { profileId, backend: "claude", role: "developer", delivers: true, verdictCapable: false },
      ],
    }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

describe("resolveDeliveryPushGrant (P11-13)", () => {
  it("permits the push when no deliverer is engaged (no grant to enforce)", async () => {
    deployDev("direct");
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review", engagements: [] }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    expect(
      await resolveDeliveryPushGrant({ dataRoot: store.dataRoot }, store.slug, "VIB-1"),
    ).toBe(true);
  });

  it("permits the push for a deliverer whose repo-write is granted (direct)", async () => {
    deployDev("direct");
    writeDeliveringTask("dev");
    expect(
      await resolveDeliveryPushGrant({ dataRoot: store.dataRoot }, store.slug, "VIB-1"),
    ).toBe(true);
  });

  it("DENIES the push for a deliverer whose repo-write is withheld", async () => {
    deployDev("human");
    writeDeliveringTask("dev");
    expect(
      await resolveDeliveryPushGrant({ dataRoot: store.dataRoot }, store.slug, "VIB-1"),
    ).toBe(false);
  });

  it("DENIES the push when a NAMED deliverer's profile was undeployed (conservative fallback)", async () => {
    // Only `dev` is deployed, but the task's delivering engagement names `ghost`
    // — resolveDeployedSpecialist throws, and the guard must deny, not permit.
    deployDev("direct");
    writeDeliveringTask("ghost");
    expect(
      await resolveDeliveryPushGrant({ dataRoot: store.dataRoot }, store.slug, "VIB-1"),
    ).toBe(false);
  });
});
