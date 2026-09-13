import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  Engagement,
  ReviewVerdict,
  TaskFrontmatter,
  TaskPacket,
  WorkRevision,
} from "~/schemas/task-file.schema";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { getReviewQueue } from "~/server/projections/review-queue.server";
import {
  acceptanceRefusalFor,
  forceAcceptCompletion,
  resolveAcceptanceAffordance,
  resolvePacket,
} from "./task-actions.server";

/**
 * Ruling 178 (pass 36, G36-3): a project declares REQUIRED reviewers per review
 * stage in project.md, and the acceptance gate reads that rule.
 *
 * Before the rule, required-ness was emergent — `requiredReviewers(fm)` was
 * the set of engaged, non-delivering, verdict-capable engagements — so a task
 * whose operator never engaged the project's reviewer was acceptable with no
 * verdict from it at all: `deriveValidation` reached `healthy` through
 * whichever other verdict-capable agent DID run (or a member's GitHub
 * approval), and nothing named the reviewer the project meant. Each test here
 * fails on the pre-ruling source.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REVIEWER_DEPLOYMENT: AgentDeployment = {
  profileId: "reviewer",
  capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
  extras: [],
  definition: {
    kind: "specialist",
    name: "Code Reviewer",
    role: "Review & validation",
    backends: ["claude"],
    model: "sonnet",
    stages: ["review"],
  },
};

const OTHER_REVIEWER_DEPLOYMENT: AgentDeployment = {
  profileId: "qa-bot",
  capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
  extras: [],
  definition: {
    kind: "specialist",
    name: "QA Bot",
    role: "QA",
    backends: ["claude"],
    model: "sonnet",
    stages: ["review"],
  },
};

const DEVELOPER: Engagement = {
  profileId: "developer",
  backend: "claude",
  role: "Implementation",
  delivers: true,
  verdictCapable: false,
};

const QA_BOT: Engagement = {
  profileId: "qa-bot",
  backend: "claude",
  role: "QA",
  delivers: false,
  verdictCapable: true,
};

const REVISION: WorkRevision = {
  id: "rev_1",
  headSha: "a".repeat(40),
  treeSha: "t".repeat(40),
  branch: "vib-1-work",
  createdAt: "2026-09-11T09:00:00.000Z",
  sourceProfileId: "developer",
};

function approval(profileId: string): ReviewVerdict {
  return {
    profileId,
    revisionId: "rev_1",
    headSha: "a".repeat(40),
    result: "approve",
    reason: "looks right",
    at: "2026-09-11T09:30:00.000Z",
    rounds: 1,
  };
}

const ACCEPT_PACKET: TaskPacket = {
  id: "pkt_accept_1",
  type: "input",
  kind: "Completion report",
  from: "operator",
  title: "Accept completion?",
  body: "Body.",
  observations: [],
  options: [
    { kind: "accept_completion", t: "Accept completion", d: "", rec: true },
    { kind: "request_edit", t: "Request one edit", d: "", rec: false },
  ],
};

/** A store whose project deploys two verdict-capable reviewers and REQUIRES
 *  `reviewer` at Review. */
function prepared(rules: { stageId: string; profileId: string }[]): TestStore {
  const store = setupTestStore(ctx);
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    agents: [REVIEWER_DEPLOYMENT, OTHER_REVIEWER_DEPLOYMENT],
    requiredReviewers: rules,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  return store;
}

/** Delivered, reviewed-by-QA-Bot work at the acceptance boundary: the exact
 *  shape that was acceptable without the project's reviewer ever running. */
function reviewedByOther(patch: Partial<TaskFrontmatter> = {}): Partial<TaskFrontmatter> {
  return {
    stage: "review",
    waiting: "human",
    branch: "vib-1-work",
    workRevision: REVISION,
    pr: { number: 7, state: "review", title: "[VIB-1] Task VIB-1" },
    engagements: [DEVELOPER, QA_BOT],
    verdicts: [approval("qa-bot")],
    ...patch,
  };
}

function seed(store: TestStore, patch: Partial<TaskFrontmatter>, packet: TaskPacket | null = null): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
    packet,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

const RULE_SENTENCE =
  "Required reviewer Code Reviewer (project rule at Review) has not approved revision aaaaaaa. " +
  "Run the review at Review, or an admin can force-accept.";

describe("ruling 178: a required reviewer the project declares gates acceptance", () => {
  it("refuses acceptance while the declared reviewer has no verdict on the delivered revision, even though another reviewer approved", async () => {
    // Canary: drop the `requiredReviewerRefusals` gate from `acceptanceRefusalReasons`.
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, reviewedByOther(), ACCEPT_PACKET);

    // The affordance every acceptance surface reads.
    const affordance = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    );
    expect(affordance.blockedReason).toBe(RULE_SENTENCE);
    expect(affordance.canAccept).toBe(false);
    // The operator's `notAcceptableReason` is the same stack.
    expect(
      acceptanceRefusalFor({ projectSlug: store.slug, taskKey: "VIB-1" }, { dataRoot: store.dataRoot }),
    ).toBe(RULE_SENTENCE);
    // A real writer refuses with the sentence, and the packet survives.
    await expect(
      resolvePacket(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      ),
    ).rejects.toMatchObject({ status: 409, message: RULE_SENTENCE });
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.frontmatter.stage).toBe("review");
    expect(file.parsed.packet).not.toBeNull();
  });

  it("accepts once the declared reviewer approved THAT revision; an approval of an older revision does not count", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, reviewedByOther({ verdicts: [approval("qa-bot"), { ...approval("reviewer"), revisionId: "rev_0", headSha: "0".repeat(40) }] }));
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
        { dataRoot: store.dataRoot },
      ).blockedReason,
    ).toBe(RULE_SENTENCE);

    seed(store, reviewedByOther({ verdicts: [approval("qa-bot"), approval("reviewer")] }));
    const affordance = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    );
    expect(affordance.blockedReason).toBeNull();
    expect(affordance.canAccept).toBe(true);
  });

  it("does not hold planning work: no active revision and no pull request", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, { stage: "review", waiting: "human", noChanges: true });
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
        { dataRoot: store.dataRoot },
      ).blockedReason,
    ).toBeNull();
  });

  it("force-accept bypasses the rule and the audit row names it", async () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, reviewedByOther());
    await forceAcceptCompletion(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const forced = listAuditEvents(store.db, { action: "task.acceptance.forced" });
    expect(forced).toHaveLength(1);
    expect(String(forced[0]!.details?.bypassed)).toContain("Required reviewer Code Reviewer (project rule at Review)");
  });

  it("the review queue reads the same rule: the task is listed as review work, never offered for acceptance, until the verdict lands", () => {
    // Canary: leave `requiredReviewers` out of `acceptanceBlockReason` (rebuilder).
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, reviewedByOther());
    const held = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(held.ready.map((t) => t.key)).not.toContain("VIB-1");
    expect(held.working.find((t) => t.key === "VIB-1")?.blockReason).toBe(RULE_SENTENCE);

    seed(store, reviewedByOther({ verdicts: [approval("qa-bot"), approval("reviewer")] }));
    const ready = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(ready.ready.map((t) => t.key)).toEqual(["VIB-1"]);
  });
});
