import type { DatabaseSync } from "node:sqlite";
import { insertUser } from "~/server/auth/user-store.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  ensureDataRootDirs,
  projectFilePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { serializeTaskFile } from "~/server/files/task-file.server";
import type {
  ProjectFrontmatter,
  ProjectRole,
} from "~/schemas/project-file.schema";
import type {
  ParsedTaskFile,
  TaskFrontmatter,
} from "~/schemas/task-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
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
  });

  return { db, dataRoot, slug, users };
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

export function baseTaskFrontmatter(
  key: string,
  patch: Partial<TaskFrontmatter> = {},
): TaskFrontmatter {
  return {
    key,
    title: `Task ${key}`,
    schedules: [],
    stage: "triage",
    previousStageId: null,
    heldAtStage: null,
    goalRef: null,
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
