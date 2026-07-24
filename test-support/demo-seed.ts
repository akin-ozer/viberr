import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import {
  credentialPasswordHash,
  isBetterAuthPasswordHash,
  provisionIdentity,
  setCredentialPassword,
} from "~/server/auth/identity.server";
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
  taskFilePath,
} from "~/server/files/file-store-root.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { serializeTaskFile } from "~/server/files/task-file.server";
import { logger } from "~/server/logging/logger.server";
import { createNotification } from "~/server/projections/notifications.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { SEED_AGENT_PROFILES } from "~/server/seed/agent-catalog.server";
import { resetStore, SEED_DEFAULT_PASSWORD } from "~/server/seed/seed.server";
import { newId } from "~/shared/ids/new-id.server";
import {
  SEED_PEOPLE,
  seedNotifications,
  seedProjects,
  seedStubTasks,
  seedTasks,
  type SeedUserIds,
} from "./demo-data";

/**
 * TEST-ONLY demo seed — the former production demo seed, kept verbatim as the
 * fixture the route-level suites are written against: the mock users
 * (arda/elif/murat/selin/deniz), viberr-core + the two stub projects, tasks
 * VIB-139..168 with full timelines, Arda's notification inbox, the VIB-142
 * scope violation and Arda's Home pins. The PRODUCT seed (seed.server.ts)
 * ships none of this — a real instance starts with a clean board (owner
 * ruling, 2026-07-24).
 *
 * Idempotent: users are upserted by email, files are overwritten, the rescan
 * reconciles projections, notification rows use the mock's deterministic ids.
 * `--reset` wipes via the product seed's resetStore first.
 */

export { SEED_DEFAULT_PASSWORD };

export interface DemoSeedOptions {
  dataRoot: string;
  reset?: boolean;
  /** Arda's password; defaults to SEED_DEFAULT_PASSWORD. */
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

async function upsertUsers(
  db: DatabaseSync,
  options: DemoSeedOptions,
): Promise<SeedUserIds> {
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
      // Ensure the better-auth identity exists (idempotent).
      provisionIdentity(db, {
        id: existing.id,
        email: existing.email,
        name: person.name,
        passwordHash: null,
      });
      // P11-01 recovery: re-hash a legacy/unverifiable credential so the
      // fixture always yields sign-in-able users.
      const currentHash = credentialPasswordHash(db, existing.id);
      if (!isBetterAuthPasswordHash(currentHash)) {
        const recoveryPassword =
          person.handle === "arda"
            ? (options.adminPassword ?? SEED_DEFAULT_PASSWORD)
            : SEED_DEFAULT_PASSWORD;
        setCredentialPassword(db, existing.id, await hashPassword(recoveryPassword));
        logger.warn("demo seed re-hashed a legacy/unverifiable credential", {
          email: person.email,
        });
      }
      ids[person.handle] = existing.id;
      continue;
    }
    const password =
      person.handle === "arda"
        ? (options.adminPassword ?? SEED_DEFAULT_PASSWORD)
        : SEED_DEFAULT_PASSWORD;
    const passwordHash = await hashPassword(password);
    const created = insertUser(db, {
      id: newId("u"),
      email: person.email,
      name: person.name,
      role: person.orgRole,
      idp: "local",
      avatarTone: person.tone,
      createdBy: null,
    });
    // Provision the better-auth identity alongside the seeded user.
    provisionIdentity(db, {
      id: created.id,
      email: created.email,
      name: created.name,
      passwordHash,
    });
    ids[person.handle] = created.id;
  }
  return ids;
}

export async function runDemoSeed(
  db: DatabaseSync,
  options: DemoSeedOptions,
): Promise<DemoSeedSummary> {
  const dataRoot = options.dataRoot;
  ensureDataRootDirs(dataRoot);

  if (options.reset) resetStore(db, dataRoot);

  // 1. Users (upsert by email — tolerates a boot-bootstrapped admin).
  const ids = await upsertUsers(db, options);

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

  // 4b. Stub-project tasks (DEP-31, BIL-9) so the cross-project inbox rows
  //     navigate to a real record instead of a "task not found" page.
  const stubTasks = seedStubTasks(ids);
  for (const task of stubTasks) {
    events += task.timeline.length;
    writeFileAtomic(
      taskFilePath(task.projectSlug, task.frontmatter.key, dataRoot),
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
      // A fixture inbox — deterministic regardless of any prefs a prior
      // session left, so a reset stays pristine.
      bypassPrefs: true,
    });
  }

  // The demo store starts with empty run history.

  // 7. The mock's one open scope violation (viberr-core · VIB-142 ·
  //    pull_request:write) so the rail Settings badge reads 1 out of the box.
  //    INSERT OR IGNORE keeps a resolved violation resolved across a re-seed.
  db.prepare(
    `INSERT OR IGNORE INTO scope_violations
       (id, project_slug, task_key, scope, detail, status, created_at)
     VALUES (?, 'viberr-core', 'VIB-142', 'pull_request:write', ?, 'open', ?)`,
  ).run(
    "sv_seed_vib142_pr_write",
    "Project credential is missing `pull_request:write` — flagged by the policy engine on VIB-142. PR status can't auto-sync after merge.",
    seededAt,
  );

  // 8. Arda's Home pins — mirrors the mock's seeded `starred` flags.
  //    INSERT OR IGNORE: a user's own pin changes survive re-seeding.
  db.prepare(
    `INSERT OR IGNORE INTO user_prefs (user_id, key, value_json, updated_at)
     VALUES (?, 'home', ?, ?)`,
  ).run(
    ids.arda,
    JSON.stringify({
      view: "grid",
      stars: { "viberr-core": true, "deploy-pipeline": true },
    }),
    seededAt,
  );

  recordAudit(db, {
    action: "seed.demo_dataset",
    actor: SYSTEM_ACTOR,
    details: {
      reset: options.reset ?? false,
      projects: projects.length,
      tasks: tasks.length + stubTasks.length,
      notifications: notifications.length,
    },
  });

  const summary: DemoSeedSummary = {
    users: SEED_PEOPLE.length,
    projects: projects.length,
    tasks: tasks.length + stubTasks.length,
    events,
    notifications: notifications.length,
    agentProfiles: SEED_AGENT_PROFILES.length,
    rescanChanged: rescan.changed,
  };
  logger.info("demo seed complete (test fixture)", { ...summary });
  return summary;
}
