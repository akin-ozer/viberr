/**
 * Deterministic governance fixtures for Playwright only.
 *
 * This runs after the normal demo seed against e2e/.tmp-data. It adds one
 * repo-less project whose only explicit member is a contributor, leaving the
 * seeded organization admin outside the project so emergency authority is a
 * real end-to-end condition rather than a mocked role.
 */
import { findUserByEmail } from "../app/server/auth/user-store.server";
import { getDb } from "../app/server/db/sqlite.server";
import { createProjectFile } from "../app/server/files/project-writer.server";
import { createTaskFile } from "../app/server/files/task-writer.server";
import { rebuildAll } from "../app/server/projections/rebuilder.server";
import type {
  TaskFileEvent,
  TaskFrontmatter,
  TaskPacket,
} from "../app/schemas/task-file.schema";
import { GOVERNED_TEMPLATE } from "../app/shared/workflow/templates";

const dataRoot = process.env.VIBERR_DATA_ROOT;
if (!dataRoot) throw new Error("VIBERR_DATA_ROOT is required for e2e fixtures");

const db = getDb();
const selin = findUserByEmail(db, "selin@viberr.dev");
if (!selin) throw new Error("The demo seed did not create Selin");
const selinId = selin.id;

const projectSlug = "e2e-governance";
const fixedAt = "2026-07-13T08:00:00.000Z";

await createProjectFile(
  { projectSlug, dataRoot },
  {
    frontmatter: {
      name: "E2E Governance",
      slug: projectSlug,
      repo: null,
      defaultBranch: "main",
      taskPrefix: "E2E",
      nextTaskNumber: 4,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: [{ userId: selinId, role: "contributor" }],
      agents: [],
      credentialPolicy: null,
      guardrails: [],
    },
    description:
      "Playwright-only governance fixtures for task ownership, terminal delivery, and organization-admin recovery authority.",
  },
);

function completionPacket(title: string): TaskPacket {
  return {
    type: "input",
    kind: "Completion report",
    from: "operator",
    title,
    body: "The work is validated and awaits the task owner's decision.",
    observations: [{ k: "Validation", v: "healthy", code: false }],
    options: [
      {
        kind: "accept_completion",
        t: "Accept completion",
        d: "Record the owner's acceptance under the delivery contract.",
        rec: true,
      },
    ],
  };
}

function frontmatter(
  key: string,
  title: string,
  patch: Partial<TaskFrontmatter> = {},
): TaskFrontmatter {
  return {
    key,
    title,
    stage: "review",
    readiness: "ready",
    waiting: "human",
    ownerUserId: selinId,
    specialist: null,
    reviewers: [],
    reviewerVerdicts: [],
    operator: { assignedAtStageId: "review" },
    recommendations: [],
    urgent: false,
    validation: "healthy",
    branch: null,
    repo: null,
    pr: null,
    github: null,
    createdAt: fixedAt,
    updatedAt: fixedAt,
    boardRank: null,
    ...patch,
  };
}

const readyForOwner: TaskFileEvent = {
  occurredAt: fixedAt,
  type: "quality",
  actor: { kind: "operator" },
  title: "Review passed",
  text: "**Validation:** healthy. The completion decision belongs to the task owner.",
  toAgent: false,
  evidence: null,
};

await createTaskFile(
  { projectSlug, taskKey: "E2E-1", dataRoot },
  {
    frontmatter: frontmatter(
      "E2E-1",
      "Contributor owner accepts repository-free completion",
    ),
    goal: "Prove a contributor who owns this task may accept healthy completion.",
    packet: null,
    timeline: [readyForOwner],
  },
);

await createTaskFile(
  { projectSlug, taskKey: "E2E-2", dataRoot },
  {
    frontmatter: frontmatter(
      "E2E-2",
      "Accepted repository work waits for a real merge",
      {
        repo: "akin-ozer/viberr",
        branch: "codex/e2e-merge-pending",
        pr: { number: 999_002, state: "review", title: "E2E merge pending" },
      },
    ),
    goal: "Prove acceptance cannot move repository-backed work to Done before merge.",
    packet: completionPacket("Accept while the pull request is still open?"),
    timeline: [readyForOwner],
  },
);

await createTaskFile(
  { projectSlug, taskKey: "E2E-3", dataRoot },
  {
    frontmatter: frontmatter(
      "E2E-3",
      "Externally merged accepted work can be finalized",
      {
        repo: "akin-ozer/viberr",
        branch: "codex/e2e-externally-merged",
        pr: {
          number: 999_003,
          state: "merged",
          title: "E2E externally merged",
        },
      },
    ),
    goal: "Prove a contributor owner can finalize accepted work after GitHub reports an external merge.",
    packet: null,
    timeline: [readyForOwner],
  },
);

const summary = rebuildAll(db, { dataRoot, force: true });
if (summary.errors > 0) {
  throw new Error(
    `E2E fixture projection failed with ${summary.errors} errors`,
  );
}
db.close();
