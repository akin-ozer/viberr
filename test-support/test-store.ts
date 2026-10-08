import type { DatabaseSync } from "node:sqlite";
import { insertUser } from "~/server/auth/user-store.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  ensureDataRootDirs,
  projectFilePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeTaskFile } from "~/server/files/task-file.server";
import type {
  AgentDeployment,
  ProjectFrontmatter,
  ProjectRole,
  WorkflowBoundary,
} from "~/schemas/project-file.schema";
import type {
  Engagement,
  ParsedTaskFile,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { defaultTransitionBy } from "~/shared/workflow/transitions";
import type { TestDbContext } from "./test-db";

/**
 * Test fixture for file-store/projection tests: a temp data root + migrated
 * DB + users with distinct project roles on a `viberr-core` project.
 *
 * Roles: arda → project admin, murat → maintainer, selin → contributor,
 * elif → viewer, deniz → registered NON-member (guest).
 */

export interface TestStoreUser {
  id: string;
  email: string;
  name: string;
  projectRole: ProjectRole | null;
}

export interface TestStore {
  db: DatabaseSync;
  dataRoot: string;
  slug: string;
  users: {
    arda: TestStoreUser;
    murat: TestStoreUser;
    selin: TestStoreUser;
    elif: TestStoreUser;
    deniz: TestStoreUser;
  };
}

let counter = 0;

export function setupTestStore(ctx: TestDbContext): TestStore {
  const db = ctx.makeDb();
  const dataRoot = ctx.makeTempDir();
  ensureDataRootDirs(dataRoot);

  const mkUser = (
    name: string,
    role: "admin" | "member",
    projectRole: ProjectRole | null,
  ): TestStoreUser => {
    counter += 1;
    const email = `${name.toLowerCase()}${counter}@viberr.test`;
    const record = insertUser(db, {
      id: `u_${name.toLowerCase()}${counter}`,
      email,
      name: `${name} Test`,
      role,
    });
    return { id: record.id, email, name: record.name, projectRole };
  };

  const users = {
    arda: mkUser("Arda", "admin", "admin"),
    murat: mkUser("Murat", "member", "maintainer"),
    selin: mkUser("Selin", "member", "contributor"),
    elif: mkUser("Elif", "member", "viewer"),
    deniz: mkUser("Deniz", "member", null),
  };

  const slug = "viberr-core";
  writeProject(dataRoot, {
    name: "Viberr Core",
    slug,
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    taskPrefix: "VIB",
    nextTaskNumber: 100,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: Object.values(users)
      .filter((u) => u.projectRole !== null)
      .map((u) => ({ userId: u.id, role: u.projectRole! })),
    agents: [],
    credentialPolicy: null,
    guardrails: [],
    requiredReviewers: [],
    fileLeases: [],
  });

  return { db, dataRoot, slug, users };
}

/** A real users row for `id` alone (name `id`, email `<id>@viberr.test`, org
 *  member), without the store fixture: user_prefs FKs to users, so a test can
 *  then store a pref for it. */
export function insertTestUser(db: DatabaseSync, id: string): void {
  insertUser(db, {
    id,
    email: `${id}@viberr.test`,
    name: id,
    role: "member",
  });
}

/** The actor a store user writes as: their id, with their email as the audit label. */
export function actorOf(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

export function writeProject(
  dataRoot: string,
  frontmatter: ProjectFrontmatter,
  description = "Test project.",
): void {
  writeFileAtomic(
    projectFilePath(frontmatter.slug, dataRoot),
    serializeProjectFile({ frontmatter, unknownFrontmatter: {}, description }),
  );
}

/**
 * The Standard board with a person approving the move into Review: the
 * template before ruling 519, and a strict board still. For a suite whose
 * contract needs an `approval` boundary to cross, or a work stage the operator
 * does not leave on its own (so the settle-time backstop stays quiet there).
 */
export const REVIEW_APPROVAL_WORKFLOW: WorkflowBoundary[] = GOVERNED_TEMPLATE.workflow.map((w) =>
  w.from === "impl" && w.to === "review"
    ? { ...w, boundary: "approval" as const, by: defaultTransitionBy("approval") }
    : w,
);

/** Puts `REVIEW_APPROVAL_WORKFLOW` on the store's project.md, keeping the rest
 *  of the file. A suite that reads the projection reprojects after. */
export function approveReviewEntry(store: Pick<TestStore, "dataRoot" | "slug">): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(
    store.dataRoot,
    { ...file.parsed.frontmatter, workflow: REVIEW_APPROVAL_WORKFLOW },
    file.parsed.description,
  );
}

/**
 * The k9s clone's board (pass 35): a Merge stage past Review, whose step to
 * Done is the person's. Rulings 162 and 163 (acceptance and rework at a stage
 * past review) run on it.
 */
export const MERGE_STAGE_BOARD = {
  stages: [
    { id: "triage", name: "Triage", color: "slate" },
    { id: "impl", name: "In Progress", color: "violet" },
    { id: "review", name: "Review", color: "blue" },
    { id: "merge", name: "Merge", color: "teal" },
    { id: "done", name: "Done", color: "green" },
  ],
  workflow: [
    { from: "triage", to: "impl", boundary: "auto", by: "Operator", locked: false },
    { from: "impl", to: "review", boundary: "approval", by: "Operator", locked: false },
    { from: "review", to: "merge", boundary: "approval", by: "Operator", locked: false },
    { from: "merge", to: "done", boundary: "human", by: "Human", locked: true },
  ],
} satisfies Pick<ProjectFrontmatter, "stages" | "workflow">;

/** A verdict-capable reviewer eligible at Review only, as the k9s board's
 *  reviewers were: nobody can give a verdict at Merge. */
export const REVIEW_STAGE_REVIEWER = {
  profileId: "reviewer",
  capabilities: [{ capabilityId: "report-validation-verdict", mode: "direct" }],
  extras: [],
  definition: { kind: "specialist", name: "Rev", role: "Code review", backends: ["claude"], model: "sonnet", stages: ["review"] },
} satisfies AgentDeployment;

/** The seeded Reviewer engaged on a task: verdict-capable and delivering
 *  nothing, under its seed role, so its verdict binds and gates acceptance. */
export const REVIEWER_ENGAGEMENT: Engagement = {
  profileId: "reviewer",
  backend: "claude",
  role: "Review & validation",
  delivers: false,
  verdictCapable: true,
};

/** An open decision a person can act on: the operator's input packet with
 *  one `request_edit` option, the shape `decisions.server` counts. */
export const OPEN_DECISION: TaskPacket = {
  type: "input",
  kind: "Decision required",
  from: "operator",
  title: "Pick one",
  body: "",
  observations: [],
  options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
};

export function baseTaskFrontmatter(
  key: string,
  patch: Partial<TaskFrontmatter> = {},
): TaskFrontmatter {
  return {
    key,
    title: `Task ${key}`,
    deliveredAt: null,
    schedules: [],
    queuedQuestions: [],
    stage: "triage",
    previousStageId: null,
    heldAtStage: null,
    epic: null,
    readiness: "input_required",
    waiting: "human",
    ownerUserId: null,
    engagements: [],
    operator: null,
    recommendations: [],
    urgent: false,
    priority: "normal",
    labels: [],
    dueDate: null,
    blockedBy: [],
    archived: false,
    validation: "none",
    workRevision: null,
    verdicts: [],
    baseRefreshes: [],
    branch: null,
    pr: null,
    github: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    boardRank: null,
    ...patch,
  };
}

export function writeTask(
  dataRoot: string,
  slug: string,
  task: Partial<ParsedTaskFile> & { frontmatter: TaskFrontmatter },
): void {
  writeFileAtomic(
    taskFilePath(slug, task.frontmatter.key, dataRoot),
    serializeTaskFile({
      unknownFrontmatter: {},
      goal: "Test goal.",
      packet: null,
      timeline: [],
      extraSections: [],
      ...task,
    }),
  );
}
