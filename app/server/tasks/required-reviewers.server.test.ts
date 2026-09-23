import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  TaskFileEvent,
  Engagement,
  ReviewVerdict,
  TaskFrontmatter,
  TaskPacket,
  WorkRevision,
} from "~/schemas/task-file.schema";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import type { RequiredReviewerView } from "./required-reviewers.server";
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

function seed(
  store: TestStore,
  patch: Partial<TaskFrontmatter>,
  packet: TaskPacket | null = null,
  /** Ruling 385: what a run saved into `attachments/`, on the event that saved it. */
  timeline: TaskFileEvent[] = [],
): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", patch),
    packet,
    timeline,
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
}

/** Ruling 388: when the deliverer saved the report — the task's non-commit
 *  delivery, and the identity its review binds to. */
const REPORT_AT = "2026-09-22T06:23:28.646Z";

/** An agent reply that saved a report into the task's `attachments/` dir. */
function reportEvent(): TaskFileEvent {
  return {
    occurredAt: REPORT_AT,
    type: "comment",
    actor: { kind: "agent", backend: "codex", profileId: "developer", roleHint: "Implementation" },
    title: null,
    text: "The upstream fidelity report is complete and attached.",
    toAgent: false,
    evidence: null,
    attachments: ["AX-12-upstream-fidelity-report.md"],
  };
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
        actorOf(store.users.arda),
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

  /**
   * Ruling 385 (owner, 2026-09-22; F39-12(c)), live on ax-clone AX-12. The task
   * was a standalone upstream-fidelity check: the deliverer wrote a 27KB
   * report, attached it, committed nothing and opened no PR. The gate held on
   * git alone, so the project's own rule — "Reviewer reviews at Review" — owed
   * nothing, and the task reached an enabled one-click Accept with
   * `verdicts: []`. Any task whose deliverable is not a commit walked through.
   */
  it("ruling 385: holds a report-only task — delivered work, no commit", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(
      store,
      { stage: "review", waiting: "human", deliveredAt: REPORT_AT },
      null,
      [reportEvent()],
    );
    // CANARY: restore `if (!rev && !fm.pr) return []` and this is null.
    const reason = resolveAcceptanceAffordance(
      { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
      { dataRoot: store.dataRoot },
    ).blockedReason;
    expect(reason).toContain("Required reviewer Code Reviewer");
    // No sha to name, so it names what there IS to review.
    expect(reason).toContain("the work delivered on this task");
  });

  it("ruling 385: the review queue agrees, so the two surfaces cannot drift", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(
      store,
      { stage: "review", waiting: "human", deliveredAt: REPORT_AT },
      null,
      [reportEvent()],
    );
    const rows = getReviewQueue(store.db, store.slug, {
      dataRoot: store.dataRoot,
      viewerUserId: store.users.arda.id,
    });
    expect(rows.ready.map((t) => t.key)).not.toContain("VIB-1");
    expect(rows.working.find((t) => t.key === "VIB-1")?.blockReason).toContain(
      "Required reviewer Code Reviewer",
    );
  });

  /**
   * Ruling 388 (F39-15). Ruling 385 held the task; nothing could satisfy the
   * hold. `requiredReviewerApproved` keyed on `workRevision`, so with no commit
   * it returned false whatever the reviewer did — and the verdict writer would
   * not have stored an approval to read anyway. Live on AX-12 that was a dead
   * end with force-accept as the only door.
   */
  it("ruling 388: an approval bound to the DELIVERY satisfies the hold", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(
      store,
      {
        stage: "review",
        waiting: "human",
        deliveredAt: REPORT_AT,
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: `files:${REPORT_AT}`,
            result: "approve",
            reason: "The report covers every command and names its sources.",
            at: "2026-09-22T07:24:15.357Z",
            rounds: 1,
          },
        ],
      },
      null,
      [reportEvent()],
    );
    // CANARY: key `requiredReviewerApproved` on `workRevision` again and this
    // is the refusal sentence forever.
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
        { dataRoot: store.dataRoot },
      ).blockedReason,
    ).toBeNull();
  });

  it("ruling 388: a LATER delivery stales the approval, like a new revision", () => {
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(
      store,
      {
        stage: "review",
        waiting: "human",
        // The deliverer saved again after the verdict, so the subject moved.
        deliveredAt: "2026-09-22T09:00:00.000Z",
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: `files:${REPORT_AT}`,
            result: "approve",
            reason: "Approved the earlier draft.",
            at: "2026-09-22T07:24:15.357Z",
            rounds: 1,
          },
        ],
      },
      null,
      [reportEvent()],
    );
    expect(
      resolveAcceptanceAffordance(
        { projectSlug: store.slug, taskKey: "VIB-1", viewerUserId: store.users.arda.id },
        { dataRoot: store.dataRoot },
      ).blockedReason,
    ).toContain("Required reviewer Code Reviewer");
  });

  it("ruling 385: a person's own upload is an INPUT and holds nothing", () => {
    // Ruling 379's human attachment writes a plain `note` with no list — an
    // uploaded fixture is something the work reads, not something it produced.
    const store = prepared([{ stageId: "review", profileId: "reviewer" }]);
    seed(store, { stage: "review", waiting: "human", noChanges: true }, null, [
      {
        occurredAt: "2026-09-22T05:05:20.040Z",
        type: "note",
        actor: { kind: "human", userId: store.users.arda.id, nameHint: "Arda" },
        title: "Attachment added",
        text: "Attached `live-fixture.yaml` (1 KB).",
        toAgent: false,
        evidence: null,
      },
    ]);
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
      actorOf(store.users.arda),
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

/**
 * Ruling 384's clause reads the review SUBJECT (ruling 388). A task whose
 * deliverable is a saved file has no commit revision, and keyed on the
 * revision alone its acceptance card said "No review verdict is recorded"
 * over the approval its reviewer had just given.
 */
describe("ruling 384: the acceptance card's basis reads the review subject", () => {
  const RULES: RequiredReviewerView[] = [
    { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Reviewer" },
  ];

  it("names the approval of a FILES delivery", async () => {
    const { acceptanceOfferBasis } = await import("./required-reviewers.server");
    const deliveredAt = "2026-09-22T10:00:00.000Z";
    const basis = acceptanceOfferBasis(
      {
        workRevision: null,
        deliveredAt,
        pr: null,
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: `files:${deliveredAt}`,
            result: "approve",
            reason: "The report covers every package.",
            at: "2026-09-22T10:05:00.000Z",
            rounds: 1,
          },
        ],
      },
      RULES,
    );
    // CANARY: key the approvals on the commit revision alone again and this
    // reads "No review verdict is recorded on this task…".
    expect(basis).toBe("Reviewer approved the files delivered on this task.");
  });

  it("still names the commit it approved, and says so when nobody approved", async () => {
    const { acceptanceOfferBasis } = await import("./required-reviewers.server");
    const sha = "b".repeat(40);
    const fm = {
      workRevision: {
        id: "rev_1",
        headSha: sha,
        treeSha: null,
        branch: "vib-1",
        createdAt: "2026-09-22T10:00:00.000Z",
        sourceProfileId: "developer",
      },
      pr: null,
      verdicts: [
        {
          profileId: "reviewer",
          revisionId: "rev_1",
          headSha: sha,
          result: "approve" as const,
          reason: "",
          at: "2026-09-22T10:05:00.000Z",
          rounds: 1,
        },
      ],
    };
    expect(acceptanceOfferBasis(fm, RULES)).toBe("Reviewer approved `bbbbbbb`.");
    expect(acceptanceOfferBasis({ ...fm, verdicts: [] }, RULES)).toContain(
      "No review verdict is recorded on this task",
    );
  });
});
