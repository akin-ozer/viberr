import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { runDemoSeed, SEED_DEFAULT_PASSWORD } from "../../../test-support/demo-seed";
import { findUserByEmail } from "~/server/auth/user-store.server";
import { credentialPasswordHash } from "~/server/auth/identity.server";
import { verifyPassword } from "~/server/auth/password.server";
import {
  parseTaskFileContent,
  serializeTaskFile,
} from "~/server/files/task-file.server";
import {
  parseProjectFileContent,
  serializeProjectFile,
} from "~/server/files/project-file.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { getBoard, listProjects } from "~/server/projections/board-query.server";
import { listNotifications } from "~/server/projections/notifications.server";
import { getTaskDetail } from "~/server/projections/task-query.server";
import { createTask } from "~/server/tasks/task-actions.server";

/**
 * Shape-pin for the TEST-ONLY demo fixture (test-support/demo-seed.ts) — the
 * mock dataset the route-level suites are written against. The PRODUCT seed
 * ships none of this (see seed.server.test.ts); these tests keep the fixture
 * faithful so the route suites keep meaning what they assert.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

async function seed() {
  const db = ctx.makeDb();
  const dataRoot = ctx.makeTempDir();
  const summary = await runDemoSeed(db, { dataRoot });
  return { db, dataRoot, summary };
}

describe("demo fixture", () => {
  it("produces the expected counts", async () => {
    const { db, summary } = await seed();
    expect(summary).toMatchObject({
      users: 5,
      projects: 3,
      // 10 viberr-core tasks + 2 stub-project tasks (DEP-31, BIL-9) that make
      // the cross-project inbox rows navigate to real records.
      tasks: 12,
      events: 36,
      notifications: 10,
      agentProfiles: 3,
    });
    const rows = (sql: string) =>
      (db.prepare(sql).get() as { c: number }).c;
    expect(rows(`SELECT count(*) AS c FROM projects`)).toBe(3);
    expect(rows(`SELECT count(*) AS c FROM task_projections`)).toBe(12);
    expect(rows(`SELECT count(*) AS c FROM task_events`)).toBe(36);
    expect(rows(`SELECT count(*) AS c FROM notifications`)).toBe(10);
    expect(rows(`SELECT count(*) AS c FROM project_members`)).toBe(7);
    // Clean dataset: no parse diagnostics on seeded files.
    expect(rows(`SELECT count(*) AS c FROM diagnostics`)).toBe(0);
    // The seed ships no fabricated run history.
    expect(rows(`SELECT count(*) AS c FROM agent_runs`)).toBe(0);
    expect(rows(`SELECT count(*) AS c FROM run_log_lines`)).toBe(0);
  });

  it("is idempotent — running twice keeps the same counts", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });
    await runDemoSeed(db, { dataRoot });
    const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    expect(count(`SELECT count(*) AS c FROM users`)).toBe(5);
    expect(count(`SELECT count(*) AS c FROM task_projections`)).toBe(12);
    expect(count(`SELECT count(*) AS c FROM notifications`)).toBe(10);
  });

  it("seeds users with compliant passwords + mock avatar tones", async () => {
    const { db } = await seed();
    const arda = findUserByEmail(db, "arda@viberr.dev");
    expect(arda?.role).toBe("admin");
    await expect(
      verifyPassword(
        SEED_DEFAULT_PASSWORD,
        credentialPasswordHash(db, arda!.id),
      ),
    ).resolves.toBe(true);
    const murat = findUserByEmail(db, "murat@viberr.dev");
    expect(murat?.name).toBe("Murat Yıldız");
    expect(murat?.avatarTone).toBe("teal");
    expect(murat?.role).toBe("member");
    const deniz = findUserByEmail(db, "deniz@viberr.dev");
    expect(deniz).not.toBeNull(); // registered, but member of no project
  });

  it("DRIFT GUARD: every fixture file has zero unknown frontmatter and round-trips the CURRENT serializers", async () => {
    // The fixture is HAND-WRITTEN canonical files — a legitimate input class
    // (the store is human-editable) but one that can silently go stale as the
    // product's schema evolves: loose parsing tolerates unknown keys without a
    // diagnostic, so a renamed/removed field would keep every suite green
    // while the fixture quietly stops representing what the product writes.
    // This trips that wire: any field the current schema no longer knows lands
    // in unknownFrontmatter and fails HERE, forcing a conscious fixture
    // migration in the same change that evolves the schema.
    const { db, dataRoot } = await seed();
    const rows = db
      .prepare(`SELECT project_slug AS slug, task_key AS key FROM task_projections`)
      .all() as { slug: string; key: string }[];
    expect(rows).toHaveLength(12);
    for (const { slug, key } of rows) {
      const file = readTaskFile({ projectSlug: slug, taskKey: key, dataRoot })!;
      expect(file.diagnostics, `${key} diagnostics`).toEqual([]);
      expect(file.parsed.unknownFrontmatter, `${key} unknown frontmatter`).toEqual({});
      // Round-trip: parse(serialize(parsed)) must reproduce the same shape,
      // or the serializer and schema have drifted apart.
      const reparsed = parseTaskFileContent(serializeTaskFile(file.parsed), {
        fallbackKey: key,
      });
      expect(reparsed.diagnostics, `${key} round-trip diagnostics`).toEqual([]);
      expect(reparsed.parsed.frontmatter, `${key} frontmatter`).toEqual(
        file.parsed.frontmatter,
      );
      expect(reparsed.parsed.packet, `${key} packet`).toEqual(file.parsed.packet);
      expect(reparsed.parsed.timeline, `${key} timeline`).toEqual(file.parsed.timeline);
    }
    for (const slug of ["viberr-core", "deploy-pipeline", "billing-service"]) {
      const p = readProjectFile({ projectSlug: slug, dataRoot })!;
      expect(p.diagnostics, `${slug} diagnostics`).toEqual([]);
      expect(p.parsed.unknownFrontmatter, `${slug} unknown frontmatter`).toEqual({});
      const rp = parseProjectFileContent(serializeProjectFile(p.parsed), {
        fallbackSlug: slug,
      });
      expect(rp.diagnostics, `${slug} round-trip diagnostics`).toEqual([]);
      expect(rp.parsed.frontmatter, `${slug} frontmatter`).toEqual(p.parsed.frontmatter);
    }
  });

  it("DRIFT GUARD: a task the PRODUCT writes into the fixture store parses just as clean", async () => {
    // Writer parity: anchor the fixture world and the real write path to the
    // same schema in one place — if the product's own writer ever produces a
    // file this store can't cleanly host, it fails here, not in a route suite.
    const { db, dataRoot } = await seed();
    const arda = findUserByEmail(db, "arda@viberr.dev")!;
    const { key } = await createTask(
      db,
      { projectSlug: "viberr-core", title: "Writer-parity probe" },
      { userId: arda.id, label: "arda@viberr.dev" },
      { dataRoot },
    );
    const file = readTaskFile({ projectSlug: "viberr-core", taskKey: key, dataRoot })!;
    expect(file.diagnostics).toEqual([]);
    expect(file.parsed.unknownFrontmatter).toEqual({});
  });

  it("boards look like the mock: stage buckets + stub projects", async () => {
    const { db } = await seed();
    const projects = listProjects(db);
    expect(projects.map((p) => p.slug).sort()).toEqual([
      "billing-service",
      "deploy-pipeline",
      "viberr-core",
    ]);

    const board = getBoard(db, "viberr-core")!;
    const byStage = Object.fromEntries(
      board.columns.map((c) => [c.stage.id, c.tasks.map((t) => t.key)]),
    );
    expect(byStage.triage).toEqual(["VIB-166", "VIB-168"]);
    expect(byStage.ready).toEqual(["VIB-148"]);
    expect(byStage.impl).toEqual(["VIB-151", "VIB-153", "VIB-160"]);
    expect(byStage.review).toEqual(["VIB-142", "VIB-145"]);
    expect(byStage.done).toEqual(["VIB-139", "VIB-141"]);

    // Done tasks derive the terminal display state (never stored) — VIB-139's
    // PR is seeded merged, so the pill says "merged", not a stale "accepted"
    // (F7-UI3).
    const vib139 = byStage.done && board.columns[4]!.tasks[0]!;
    expect(vib139.readiness).toBe("ready");
    expect(vib139.displayReadiness).toBe("merged");

    // Lightweight template stub (ruling 15).
    const billing = getBoard(db, "billing-service")!;
    expect(billing.columns.map((c) => c.stage.id)).toEqual(["todo", "doing", "done"]);
  });

  it("VIB-142 spot-check: packet + timeline fidelity vs data.js", async () => {
    const { db } = await seed();
    const task = getTaskDetail(db, "viberr-core", "VIB-142")!;

    expect(task.title).toBe("Attach execution workspace to task runtime");
    expect(task.stage).toBe("review");
    expect(task.readiness).toBe("input_required");
    expect(task.waiting).toBe("human");
    expect(task.urgent).toBe(true);
    expect(task.validation).toBe("changed");
    expect(task.branch).toBe("vib-142-attach-workspace");
    expect(task.repo).toBe("akin-ozer/viberr"); // project default, no override
    expect(task.pr).toEqual({ number: 318, state: "review", title: "Attach execution workspace" });
    expect(task.commits).toHaveLength(3);
    expect(task.changed).toEqual({ files: 9, add: 412, del: 87 });
    expect(task.owner).toMatchObject({ name: "Arda Kaya" });
    expect(task.specialist).toMatchObject({ profileId: "developer", backend: "codex", role: "Implementation" });
    expect(task.reviewers[0]).toMatchObject({ backend: "claude", role: "Review & validation" });
    expect(task.operator).toMatchObject({ assignedAtStageId: "triage", sinceLabel: "since Triage" });
    expect(task.filePath).toBe("projects/viberr-core/tasks/VIB-142/task.md");

    // Packet — verbatim strings + stable option kinds (ruling 7).
    const packet = task.packet!;
    expect(packet.type).toBe("input");
    expect(packet.kind).toBe("Completion report");
    expect(packet.from).toBe("Operator");
    expect(packet.title).toBe("Accept completion, or send back for one fix?");
    expect(packet.observations[0]).toEqual({ k: "Changed", v: "9 files · +412 / −87", code: true });
    expect(packet.observations[3]).toEqual({ k: "Flag", v: "PAT scope missing pull_request:write", code: false });
    expect(packet.options.map((o) => o.kind)).toEqual([
      "accept_completion",
      "request_edit",
      "block_on_policy",
    ]);
    expect(packet.options[0]).toMatchObject({ t: "Accept completion", rec: true });
    // The dead `accept` flag was removed — acceptance gates on kind only.
    expect(packet.options[0]).not.toHaveProperty("accept");
    expect(packet.options[1]?.ev).toBe(
      "**Decision:** request one edit. Developer widens the PAT scope, then the completion report returns for acceptance.",
    );

    // Timeline — 9 events, newest first, all types + actors + evidence.
    expect(task.timeline).toHaveLength(9);
    expect(task.timeline.map((e) => e.type)).toEqual([
      "comment", "completion", "github", "policy", "quality",
      "transition", "agent", "comment", "assign",
    ]);
    const [comment, completion, , policy, quality, , agentEv, , assign] = task.timeline;
    expect(comment).toMatchObject({
      toAgent: true,
      text: "@operator if the PAT scope is the only blocker, let's widen it rather than block the whole task.",
    });
    expect(comment?.actor).toMatchObject({ kind: "human", name: "Arda Kaya", initials: "AK" });
    expect(completion).toMatchObject({ title: "Completion report" });
    expect(completion?.evidence).toEqual([
      { label: "unit/policy_gate_test", add: "+14", del: "0" },
      { label: "integration/pr_sync_test", add: "+38", del: "−4" },
    ]);
    expect(completion?.actor).toMatchObject({ kind: "agent", backend: "codex", name: "Codex", role: "Implementation" });
    expect(policy?.actor).toEqual({ kind: "system", name: "Policy engine" });
    expect(quality?.text).toBe(
      "**Quality flag:** snapshot `task_projection.json` changed — confirm the new compact shape is intended before review.",
    );
    expect(agentEv?.actor).toEqual({ kind: "agent", name: "Operator" }); // NO backend
    expect(assign?.text).toBe(
      "Took task ownership — owner is the human reviewer and acceptance authority for this task.",
    );
    // Ruling 4: back-dated — the assign event landed yesterday at 15:12 local.
    const assignDate = new Date(assign!.occurredAt);
    expect(assignDate.getHours()).toBe(15);
    expect(assignDate.getMinutes()).toBe(12);
  });

  it("guest commenter on VIB-153 renders with the guest flag", async () => {
    const { db } = await seed();
    const task = getTaskDetail(db, "viberr-core", "VIB-153")!;
    expect(task.timeline[0]?.actor).toMatchObject({
      kind: "human",
      name: "Deniz Şahin",
      initials: "DŞ",
      guest: true,
    });
  });

  it("Arda's inbox matches the mock rows, sorted by real timestamp DESC", async () => {
    const { db } = await seed();
    const arda = findUserByEmail(db, "arda@viberr.dev")!;
    const list = listNotifications(db, arda.id);
    expect(list.map((n) => n.id)).toEqual([
      "n-160-packet",     // Today 10:31
      "n-dep-31",         // Today 10:12
      "n-142-packet",     // Today 9:41
      "n-142-policy",     // Today 9:38
      "n-142-quality",    // Today 9:20
      "n-145-approval",   // Today 9:12
      "n-bil-9",          // Today 8:47
      "n-148-mention",    // Today 8:20
      "n-145-blockedact", // Yesterday 16:04
      "n-160-reply",      // Yesterday 11:20
    ]);
    expect(list.filter((n) => n.unread).map((n) => n.id)).toEqual([
      "n-160-packet", "n-dep-31", "n-142-packet", "n-142-policy",
      "n-145-approval", "n-bil-9",
    ]);
    // Cross-project soft refs resolve to the stub projects (ruling 9).
    const dep = list.find((n) => n.id === "n-dep-31")!;
    expect(dep.projectSlug).toBe("deploy-pipeline");
    expect(dep.projectName).toBe("Deploy Pipeline");
    expect(dep.taskKey).toBe("DEP-31");
    const mention = list.find((n) => n.id === "n-148-mention")!;
    expect(mention.text).toBe(
      "mentioned you — “needs a reviewer to own the acceptance gate. **@arda** can you take it?”",
    );
    expect(mention.from).toMatchObject({ kind: "human", name: "Elif Demir" });
  });
});
