import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { hashPassword } from "~/server/auth/password.server";
import {
  findUserByEmail,
  insertUser,
  updateUserFields,
} from "~/server/auth/user-store.server";
import { serializeAgentProfile } from "~/server/files/agent-profile-file.server";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import {
  agentProfileFilePath,
  ensureDataRootDirs,
  projectFilePath,
  projectsDir,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { serializeTaskFile } from "~/server/files/task-file.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  SEED_AGENT_PROFILES,
  SEED_PEOPLE,
  seedNotifications,
  seedProjects,
  seedTasks,
  type SeedUserIds,
} from "./demo-data.server";

/**
 * Demo seed (replaces the phase-1 placeholder): writes the full mock
 * dataset as REAL canonical files + projections + per-user notification
 * rows, so the app boots looking like the mock.
 *
 * Idempotent: users are upserted by email, files are overwritten, the
 * rescan reconciles projections, notification rows use the mock's
 * deterministic ids (INSERT OR REPLACE). `--reset` additionally wipes
 * ${dataRoot}/projects, agents/profiles and all derived tables first.
 *
 * Passwords: every seeded user gets `viberr-dev-2828` (compliant with the
 * min-8 policy; Arda's comes from VIBERR_SEED_ADMIN_PASSWORD when set).
 * Existing users keep their password (only missing users get one).
 */

export const SEED_DEFAULT_PASSWORD = "viberr-dev-2828";

export interface DemoSeedOptions {
  dataRoot: string;
  reset?: boolean;
  /** Arda's password; defaults to VIBERR_SEED_ADMIN_PASSWORD handling in the CLI. */
  adminPassword?: string;
}

export interface DemoSeedSummary {
  users: number;
  projects: number;
  tasks: number;
  events: number;
  notifications: number;
  agentProfiles: number;
  rescanChanged: number;
}

const DERIVED_TABLES = [
  "notifications",
  "provenance",
  "diagnostics",
  "task_events",
  "task_projections",
  "project_members",
  "projects",
];

function upsertUsers(
  db: Database.Database,
  options: DemoSeedOptions,
): SeedUserIds {
  const ids = {} as SeedUserIds;
  for (const person of SEED_PEOPLE) {
    const existing = findUserByEmail(db, person.email);
    if (existing) {
      // Keep credentials; align display fields with the mock dataset.
      updateUserFields(db, existing.id, {
        name: person.name,
        role: person.orgRole,
        avatarTone: person.tone,
      });
      ids[person.handle] = existing.id;
      continue;
    }
    const password =
      person.handle === "arda"
        ? (options.adminPassword ?? SEED_DEFAULT_PASSWORD)
        : SEED_DEFAULT_PASSWORD;
    const created = insertUser(db, {
      id: newId("u"),
      email: person.email,
      name: person.name,
      role: person.orgRole,
      passwordHash: hashPassword(password),
      idp: "local",
      avatarTone: person.tone,
      createdBy: null,
    });
    ids[person.handle] = created.id;
  }
  return ids;
}

export function runDemoSeed(
  db: Database.Database,
  options: DemoSeedOptions,
): DemoSeedSummary {
  const dataRoot = options.dataRoot;
  ensureDataRootDirs(dataRoot);

  if (options.reset) {
    const projRoot = projectsDir(dataRoot);
    if (existsSync(projRoot)) {
      rmSync(projRoot, { recursive: true, force: true });
    }
    const profilesRoot = path.join(dataRoot, "agents", "profiles");
    if (existsSync(profilesRoot)) {
      rmSync(profilesRoot, { recursive: true, force: true });
    }
    for (const table of DERIVED_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    ensureDataRootDirs(dataRoot);
    logger.info("seed reset complete", { dataRoot });
  }

  // 1. Users (upsert by email — tolerates the phase-2 boot-seeded admin).
  const ids = upsertUsers(db, options);

  // 2. Org-level agent profile templates (two-layer model, layer 1).
  for (const profile of SEED_AGENT_PROFILES) {
    writeFileAtomic(
      agentProfileFilePath(profile.frontmatter.id, dataRoot),
      serializeAgentProfile({
        frontmatter: profile.frontmatter,
        description: profile.description,
      }),
    );
  }

  // 3. Project files (viberr-core + the two ruling-9 stubs).
  const projects = seedProjects(ids);
  for (const project of projects) {
    writeFileAtomic(
      projectFilePath(project.frontmatter.slug, dataRoot),
      serializeProjectFile({
        frontmatter: project.frontmatter,
        unknownFrontmatter: {},
        description: project.description,
      }),
    );
  }

  // 4. Task files (VIB-139..VIB-168, every field + full timelines).
  const tasks = seedTasks(ids);
  let events = 0;
  for (const task of tasks) {
    events += task.timeline.length;
    writeFileAtomic(
      taskFilePath("viberr-core", task.frontmatter.key, dataRoot),
      serializeTaskFile({
        frontmatter: task.frontmatter,
        unknownFrontmatter: {},
        goal: task.goal,
        packet: task.packet,
        timeline: task.timeline,
        extraSections: [],
      }),
    );
  }

  // 5. Projections (force: user renames change actor snapshots without
  //    changing file hashes on re-seed).
  const rescan = rebuildAll(db, { dataRoot, force: true });

  // 6. Arda's notification inbox (deterministic mock ids → idempotent).
  const notifications = seedNotifications(ids);
  const seededAt = new Date().toISOString();
  for (const n of notifications) {
    createNotification(db, {
      id: n.id,
      userId: ids.arda,
      kind: n.kind,
      ptype: n.ptype ?? null,
      title: n.title ?? null,
      text: n.text,
      from: n.from,
      projectSlug: n.projectSlug,
      taskKey: n.taskKey,
      occurredAt: n.occurredAt,
      readAt: n.unread ? null : seededAt,
    });
  }

  recordAudit(db, {
    action: "seed.demo_dataset",
    actor: SYSTEM_ACTOR,
    details: {
      reset: options.reset ?? false,
      projects: projects.length,
      tasks: tasks.length,
      notifications: notifications.length,
    },
  });

  const summary: DemoSeedSummary = {
    users: SEED_PEOPLE.length,
    projects: projects.length,
    tasks: tasks.length,
    events,
    notifications: notifications.length,
    agentProfiles: SEED_AGENT_PROFILES.length,
    rescanChanged: rescan.changed,
  };
  logger.info("demo seed complete", { ...summary });
  return summary;
}
