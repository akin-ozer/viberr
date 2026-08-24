import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
} from "../../../test-support/test-store";
import {
  projectFilePath,
  taskFilePath,
} from "~/server/files/file-store-root.server";
import type {
  ParsedTaskFile,
  TaskFrontmatter,
  TaskPacket,
} from "~/schemas/task-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import { rebuildAll, rebuildPath, rebuildProject } from "./rebuilder.server";
import { getBoard, listProjectTasks } from "./board-query.server";
import { getTaskDetail } from "./task-query.server";

/** A second project alongside the store's default, for scope tests. */
function writeSecondProject(store: ReturnType<typeof setupTestStore>, slug: string) {
  writeProject(store.dataRoot, {
    name: "Other Project",
    slug,
    repo: "acme/other",
    defaultBranch: "main",
    taskPrefix: "OTH",
    nextTaskNumber: 2,
    stages: GOVERNED_TEMPLATE.stages,
    workflow: GOVERNED_TEMPLATE.workflow,
    members: [],
    agents: [],
    credentialPolicy: null,
    guardrails: [],
  });
}

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("rebuilder", () => {
  it("full rescan projects projects, members and tasks", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "ready" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2"),
    });

    const summary = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(2);
    expect(summary.changed).toBe(3);
    expect(summary.errors).toBe(0);

    const board = getBoard(store.db, store.slug);
    expect(board?.project.name).toBe("Viberr Core");
    expect(board?.members).toHaveLength(4);
    expect(board?.columns.map((c) => c.tasks.length)).toEqual([1, 1, 0, 0, 0]);
    // Store-relative display path (ruling 3).
    const task = board?.columns[1]?.tasks[0];
    expect(task?.filePath).toBe("projects/viberr-core/tasks/VIB-1/task.md");
  });

  it("N20-14: projects the force-accept `acceptance` fact into task_projections", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "done", acceptance: "forced" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "done" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const rowSchema = z.object({ acceptance: z.string().nullable() });
    const acceptanceOf = (key: string) =>
      rowSchema.parse(
        store.db
          .prepare(
            `SELECT acceptance FROM task_projections WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, key),
      ).acceptance;
    expect(acceptanceOf("VIB-1")).toBe("forced");
    expect(acceptanceOf("VIB-2")).toBeNull();
  });

  it("ruling 53/88: projects the delivered revision head sha the board ceremony discloses", () => {
    // A board card is rendered from this table alone, so a fact the board's
    // acceptance ceremony must DISCLOSE has to be projected. Without the column
    // the ceremony said "No delivered revision recorded." about every task and
    // echoed `revision: "none"` back to a server that compares the echo against
    // the live task — which refused every board acceptance of delivered work.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        branch: "vib-1-work",
        workRevision: {
          id: "rev_1",
          headSha: "a".repeat(40),
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-08-19T09:00:00.000Z",
          sourceProfileId: "developer",
        },
      }),
    });
    // Nothing delivered — the honest absence the ceremony still renders.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "ready" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const rowSchema = z.object({ work_revision_sha: z.string().nullable() });
    const shaOf = (key: string) =>
      rowSchema.parse(
        store.db
          .prepare(
            `SELECT work_revision_sha FROM task_projections WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, key),
      ).work_revision_sha;
    expect(shaOf("VIB-1")).toBe("a".repeat(40));
    expect(shaOf("VIB-2")).toBeNull();

    // And it reaches the summary the board renders from, under the name the
    // ceremony reads (`workRevisionSha`).
    const tasks = listProjectTasks(store.db, store.slug);
    expect(tasks.find((t) => t.key === "VIB-1")?.workRevisionSha).toBe(
      "a".repeat(40),
    );
    expect(tasks.find((t) => t.key === "VIB-2")?.workRevisionSha).toBeNull();
  });

  /**
   * F21-1 (pass 21) — the `validation` CHECK must admit every VALIDATION_VALUES
   * member, `bypassed` included.
   *
   * `deriveValidation` returns `"bypassed"` for a force-accepted task, and the
   * rebuilder binds that return value straight into `task_projections.validation`
   * (rebuilder.server.ts :410 → :538). The baseline's CHECK still listed only the
   * four original values, so the INSERT threw `CHECK constraint failed`, the whole
   * task rebuild aborted inside rebuildPath's catch ("projection rebuild failed")
   * and the row was never written — a force-accepted task simply stopped
   * projecting.
   *
   * The `workRevision` is load-bearing, which is why the sibling N20-14 test
   * above never caught this: `deriveValidation` returns `"none"` on its very
   * first line when there is no revision, so a force-accepted task only reaches
   * the `bypassed` arm once it has one.
   *
   * CANARY: revert the CHECK at db/migrations/0001_baseline.sql to
   * ('healthy','changed','failing','none') — the row disappears and this fails.
   */
  it("F21-1: a force-accepted task WITH a work revision projects validation = 'bypassed'", () => {
    const store = setupTestStore(ctx);
    // A real delivered revision (the shape `nextWorkRevision` mints) plus a
    // required reviewer who never voted — the pending state a force-accept
    // deliberately overrides.
    const revision = {
      id: "rev_f21",
      headSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      branch: "vib-1-work",
      createdAt: "2026-08-19T09:00:00.000Z",
      sourceProfileId: "developer",
      kind: "delivered" as const,
    };
    const engagements = [
      {
        profileId: "developer",
        backend: "claude" as const,
        role: "developer",
        delivers: true,
        verdictCapable: false,
      },
      {
        profileId: "reviewer",
        backend: "claude" as const,
        role: "Review & validation",
        delivers: false,
        verdictCapable: true,
      },
    ];
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "done",
        waiting: "none",
        readiness: "ready",
        acceptance: "forced",
        branch: revision.branch,
        workRevision: revision,
        engagements,
        verdicts: [],
        pr: { number: 421, state: "merged", title: "Delivered work" },
      }),
    });
    // The control: same task, same revision, no force-accept — still `changed`.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "review",
        waiting: "human",
        readiness: "ready",
        branch: revision.branch,
        workRevision: { ...revision, id: "rev_f21b" },
        engagements,
        verdicts: [],
        pr: { number: 422, state: "review", title: "Delivered work" },
      }),
    });

    const summary = rebuildAll(store.db, { dataRoot: store.dataRoot });
    // The CHECK failure surfaced as a swallowed per-file error, never a throw.
    expect(summary.errors).toBe(0);

    const rowSchema = z.object({ validation: z.string() });
    const validationOf = (key: string) => {
      const row = store.db
        .prepare(
          `SELECT validation FROM task_projections WHERE project_slug = ? AND task_key = ?`,
        )
        .get(store.slug, key);
      // A rejected INSERT leaves NO row at all — say so instead of failing on a
      // zod parse of `undefined`.
      expect(row, `VIB task ${key} was not projected at all`).toBeDefined();
      return rowSchema.parse(row).validation;
    };
    expect(validationOf("VIB-1")).toBe("bypassed");
    expect(validationOf("VIB-2")).toBe("changed");

    // …and it reaches the read model the board/queue/hero consume.
    const summaries = listProjectTasks(store.db, store.slug);
    expect(summaries.find((t) => t.key === "VIB-1")?.validation).toBe("bypassed");
  });

  it("D4: projects `continuity: 'degraded'` when the timeline carries a continuity event", () => {
    const store = setupTestStore(ctx);
    // VIB-1 lost its provider session — a `continuity` event is on the timeline,
    // exactly what `noteContinuityReset` (run-service.server.ts) writes.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review" }),
      timeline: [
        {
          occurredAt: "2026-07-05T10:00:00.000Z",
          type: "continuity",
          actor: { kind: "system", systemId: "runtime-continuity" },
          title: null,
          text: "Runtime continuity was lost: the Claude Code session behind Reviewer's thread no longer has a provider transcript.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    // VIB-2 has an ordinary comment — healthy continuity.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review" }),
      timeline: [
        {
          occurredAt: "2026-07-05T10:00:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.murat.id, nameHint: null },
          text: "Looks good.",
          title: null,
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const rowSchema = z.object({ continuity: z.string().nullable() });
    const continuityOf = (key: string) =>
      rowSchema.parse(
        store.db
          .prepare(
            `SELECT continuity FROM task_projections WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, key),
      ).continuity;
    expect(continuityOf("VIB-1")).toBe("degraded");
    expect(continuityOf("VIB-2")).toBeNull();

    // And it reaches the read model the board/queue consume (TaskSummary).
    const summaries = listProjectTasks(store.db, store.slug);
    expect(summaries.find((t) => t.key === "VIB-1")?.continuity).toBe("degraded");
    expect(summaries.find((t) => t.key === "VIB-2")?.continuity).toBeNull();
  });

  it("content-hash short-circuit: unchanged files are not re-projected", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const countSchema = z.object({ c: z.number() });
    const provenanceRows = () =>
      countSchema.parse(
        store.db.prepare(`SELECT count(*) AS c FROM provenance`).get(),
      ).c;
    const provenanceBefore = provenanceRows();

    const second = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(second.changed).toBe(0);
    expect(second.unchanged).toBe(2); // project + task

    // Unchanged files record no per-file provenance; only the rescan summary row.
    expect(provenanceRows()).toBe(provenanceBefore + 1);
  });

  it("single-file incremental rebuild picks up an external edit", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const events: string[] = [];
    const off = onProjectionEvent((e) => events.push(e.type));

    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        title: "Edited directly on disk",
        stage: "impl",
      }),
    });
    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    off();

    expect(result.action).toBe("projected");
    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.title).toBe("Edited directly on disk");
    expect(detail?.stage).toBe("impl");
    expect(events).toContain("task.updated");
  });

  it("user rename reflects in the projected timeline at READ time — no reprojection (E1)", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        {
          occurredAt: "2026-07-02T09:41:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.murat.id, nameHint: null },
          title: null,
          text: "Looks good.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Rename AFTER projection — the baked actor_json still holds the old
    // name and the content-hash short-circuit prevents any reprojection.
    store.db
      .prepare(`UPDATE users SET name = ? WHERE id = ?`)
      .run("Murat Kaya", store.users.murat.id);

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.timeline[0]?.actor).toMatchObject({
      kind: "human",
      userId: store.users.murat.id,
      name: "Murat Kaya",
      initials: "MK",
    });

    // Deleted user → the baked snapshot is the fallback identity.
    store.db.prepare(`DELETE FROM users WHERE id = ?`).run(store.users.murat.id);
    const after = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(after?.timeline[0]?.actor).toMatchObject({
      kind: "human",
      name: "Murat Test",
    });
  });

  it("deleting a task file removes its projection rows + records provenance", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const absPath = taskFilePath(store.slug, "VIB-1", store.dataRoot);
    rmSync(absPath);
    const result = rebuildPath(store.db, absPath, { dataRoot: store.dataRoot });
    expect(result.action).toBe("removed");
    expect(listProjectTasks(store.db, store.slug)).toEqual([]);
    const removedRow = z
      .object({ action: z.string() })
      .parse(
        store.db
          .prepare(`SELECT action FROM provenance ORDER BY id DESC LIMIT 1`)
          .get(),
      );
    expect(removedRow.action).toBe("removed");
  });

  it("malformed file → diagnostics + readiness downgrade, task never dropped", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "no-such-stage",
        readiness: "ready",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail).not.toBeNull();
    // unknown stage reference → warning → floors input_required
    expect(detail?.readiness).toBe("input_required");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);
    // ends up in the orphan bucket, not silently dropped
    const board = getBoard(store.db, store.slug);
    expect(board?.orphanTasks.map((t) => t.key)).toEqual(["VIB-1"]);
  });

  it("resolves human actors and flags non-member commenters as guests", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:12:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.deniz.id, nameHint: null },
          title: null, text: "Following from the platform team.", toAgent: false, evidence: null },
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: null },
          title: null, text: "Member comment.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const detail = getTaskDetail(store.db, store.slug, "VIB-1");
    const [guest, member] = detail!.timeline;
    expect(guest?.actor).toMatchObject({ kind: "human", guest: true });
    expect(member?.actor.kind).toBe("human");
    expect("guest" in (member?.actor ?? {})).toBe(false);
    // Denormalized snapshot: name resolved from the users table.
    expect(guest?.actor).toMatchObject({ name: "Deniz Test" });
  });

  it("membership change in project.md cascades guest flags onto tasks", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [
        { occurredAt: "2026-07-04T07:00:00.000Z", type: "comment",
          actor: { kind: "human", userId: store.users.elif.id, nameHint: null },
          title: null, text: "Was a member when written.", toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect("guest" in detail!.timeline[0]!.actor).toBe(false);

    // Remove elif from the project file → her events re-render as guest.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.members = project.parsed.frontmatter.members.filter(
      (m) => m.userId !== store.users.elif.id,
    );
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildPath(store.db, project.absPath, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail!.timeline[0]!.actor).toMatchObject({ guest: true });
  });

  it("adding a missing stage to project.md clears the task's unknown-stage warning", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "qa", readiness: "ready" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    // Unknown stage → warning → readiness floors at input_required.
    expect(detail?.readiness).toBe("input_required");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);

    // Fix the PROJECT file only — the task file stays byte-identical, so
    // only a project→task cascade can clear the warning.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.stages = [
      ...project.parsed.frontmatter.stages,
      { id: "qa", name: "QA", color: "#187574" },
    ];
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildAll(store.db, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(false);
    expect(detail?.readiness).toBe("ready");
  });

  it("removing a stage tasks sit in flags them on the next rescan", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "ready", readiness: "ready" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    let detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(detail?.readiness).toBe("ready");
    expect(detail?.diagnostics).toEqual([]);

    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { writeFileAtomic } = await import("~/server/files/atomic-file.server");
    const { serializeProjectFile } = await import("~/server/files/project-file.server");
    const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    project.parsed.frontmatter.stages = project.parsed.frontmatter.stages.filter(
      (s) => s.id !== "ready",
    );
    writeFileAtomic(project.absPath, serializeProjectFile(project.parsed));

    rebuildAll(store.db, { dataRoot: store.dataRoot });
    detail = getTaskDetail(store.db, store.slug, "VIB-1");
    expect(
      detail?.diagnostics.some((d) => d.code === "reference.unknown_stage"),
    ).toBe(true);
    expect(detail?.readiness).toBe("input_required");
  });

  it("task projected before its project.md picks up the project repo once it lands", () => {
    const store = setupTestStore(ctx);
    const slug = "fresh-proj";
    // Fresh project dir copied in: the task file is projected FIRST (no
    // project row yet) — e.g. the watcher fires for task.md before project.md.
    writeTask(store.dataRoot, slug, {
      frontmatter: baseTaskFrontmatter("FRS-1"),
    });
    rebuildPath(store.db, taskFilePath(slug, "FRS-1", store.dataRoot), {
      dataRoot: store.dataRoot,
    });

    const rowSchema = z.object({ repo: z.string().nullable() });
    const repoOf = () =>
      rowSchema.parse(
        store.db
          .prepare(
            `SELECT repo FROM task_projections WHERE project_slug = ? AND task_key = ?`,
          )
          .get(slug, "FRS-1"),
      ).repo;
    expect(repoOf()).toBeNull();

    // project.md lands afterwards — its first projection must cascade.
    writeProject(store.dataRoot, {
      name: "Fresh Project",
      slug,
      repo: "acme/fresh",
      defaultBranch: "main",
      taskPrefix: "FRS",
      nextTaskNumber: 2,
      stages: GOVERNED_TEMPLATE.stages,
      workflow: GOVERNED_TEMPLATE.workflow,
      members: [],
      agents: [],
      credentialPolicy: null,
      guardrails: [],
    });
    rebuildPath(store.db, projectFilePath(slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });

    expect(repoOf()).toBe("acme/fresh");
  });
});

/**
 * R16-3 (owner ruling 2026-08-04) — `validation_block_reason` is the sentence
 * every acceptance-readiness surface repeats (review queue, decisions inbox,
 * Home counts). It deliberately excluded PR state, so a task whose PR GitHub
 * had CLOSED still projected the verdict gate — "run a review for a verdict, or
 * an admin can force-accept" — naming a process gate over the terminal fact and
 * advertising the override the task page withholds. The PR's last-reconciled
 * state is in the same frontmatter this projection reads, so ranking it first
 * (as `acceptanceRefusalReason` does) invents nothing.
 */
describe("R16-3: the projected acceptance block names the terminal GitHub fact first", () => {
  const REV = {
    id: "rev_1",
    headSha: "d".repeat(40),
    treeSha: "w".repeat(40),
    branch: "vib-3-work",
    createdAt: "2026-07-04T00:00:00.000Z",
    sourceProfileId: "developer",
  };

  /** Delivered, nobody engaged to give a verdict → the verdict gate binds. */
  function seedDelivered(
    store: ReturnType<typeof setupTestStore>,
    prState: "review" | "merged" | "closed",
  ) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", {
        title: "Delivered, unreviewed",
        stage: "review",
        waiting: "human",
        branch: REV.branch,
        pr: { number: 124, state: prState, title: "Delivered, unreviewed" },
        workRevision: REV,
        engagements: [
          {
            profileId: "developer",
            backend: "claude",
            role: "developer",
            delivers: true,
            verdictCapable: false,
          },
        ],
        verdicts: [],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return listProjectTasks(store.db, store.slug).find((t) => t.key === "VIB-3")!;
  }

  it("a CLOSED PR replaces the verdict-gate sentence — no force-accept is advertised", () => {
    const store = setupTestStore(ctx);
    const task = seedDelivered(store, "closed");
    expect(task.blockReason).toBe(
      "VIB-3's review PR was closed on GitHub without merging, so it can't be accepted. Rework and reopen the PR, or archive the task.",
    );
    expect(task.blockReason).not.toContain("force-accept");
    expect(task.blockReason).not.toContain("approving verdict");
  });

  it("an OPEN PR still projects the verdict gate verbatim (R15-1 unchanged)", () => {
    const store = setupTestStore(ctx);
    expect(seedDelivered(store, "review").blockReason).toBe(
      // R19-B: a project member's GitHub approval is now a third way to satisfy
      // the gate, and the sentence names it.
      "VIB-3's delivered revision has no approving verdict yet. Run a review for a verdict, approve the pull request on GitHub, or an admin can force-accept.",
    );
  });

  it("a MERGED PR is not terminal for acceptance — the verdict gate keeps speaking", () => {
    // Merged-on-GitHub is reachable (someone merged the PR by hand and the
    // poller recorded it) but it is not a refusal: the task page still refuses
    // under the verdict gate and still offers force-accept there, so this
    // column must not start describing the PR instead.
    const store = setupTestStore(ctx);
    expect(seedDelivered(store, "merged").blockReason).toMatch(
      /no approving verdict yet/,
    );
  });

  it("a closed PR blocks even a task the reviewer gate would have cleared", () => {
    // No delivered revision at all — planning work, which R15-1 leaves
    // acceptable. The closed PR is still the fact that decides it.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "review",
        waiting: "human",
        validation: "healthy",
        pr: { number: 77, state: "closed", title: "Rejected on GitHub" },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const task = listProjectTasks(store.db, store.slug).find(
      (t) => t.key === "VIB-2",
    )!;
    expect(task.blockReason).toContain("closed on GitHub without merging");
  });

  it("R19-8: a VERIFICATION revision projects no block reason — it is not undelivered work", () => {
    // The projected sentence is the mirror of `verdictGateReason`, so it has to
    // learn the same thing: a revision a reviewer minted on a task with nothing
    // to deliver is not "delivered work with no PR". Left unmirrored, the review
    // queue and decisions inbox would keep telling a human to "deliver the
    // branch & open the PR" for a task that has no branch (F19-21).
    // CANARY: drop `fm.noChanges || fm.workRevision.kind === "verified"` from
    // acceptanceBlockReason — this reads the deliver-the-branch sentence.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-4", {
        stage: "review",
        waiting: "human",
        validation: "healthy",
        noChanges: true,
        branch: null,
        pr: null,
        engagements: [
          {
            profileId: "reviewer",
            backend: "claude",
            role: "Review & validation",
            delivers: false,
            verdictCapable: true,
          },
        ],
        workRevision: {
          id: "rev_v1",
          headSha: "e".repeat(40),
          treeSha: null,
          branch: null,
          createdAt: "2026-08-06T09:00:00.000Z",
          sourceProfileId: null,
          kind: "verified",
        },
        verdicts: [
          {
            profileId: "reviewer",
            revisionId: "rev_v1",
            headSha: "e".repeat(40),
            result: "approve",
            reason: "Nothing to change.",
            at: "2026-08-06T09:01:00.000Z",
          },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const task = listProjectTasks(store.db, store.slug).find(
      (t) => t.key === "VIB-4",
    )!;
    expect(task.blockReason).toBeNull();

    // The revision KIND clears the gate on its own. `noChanges` and
    // `kind: "verified"` are two separate facts and the mint writes both, so
    // without this case the kind arm would be permanently shadowed by the flag
    // and could be deleted with every test still green.
    // CANARY: remove `|| fm.workRevision.kind === "verified"` — only this
    // assertion fails.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: {
        ...baseTaskFrontmatter("VIB-5", {
          stage: "review",
          waiting: "human",
          validation: "healthy",
          branch: null,
          pr: null,
          workRevision: {
            id: "rev_v2",
            headSha: "f".repeat(40),
            treeSha: null,
            branch: null,
            createdAt: "2026-08-06T09:00:00.000Z",
            sourceProfileId: null,
            kind: "verified",
          },
        }),
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(
      listProjectTasks(store.db, store.slug).find((t) => t.key === "VIB-5")!
        .blockReason,
    ).toBeNull();
  });
});

/**
 * UX19-3 — one projection row must not contradict itself.
 *
 * The row's `validation` column came from `fm.validation` (a CACHE the schema
 * itself calls derived) while `validation_block_reason` beside it derived fresh
 * from the same `fm`. A cache writer that skipped its recompute — or a
 * hand-edited `validation:` line, which "files are canonical truth" lets through
 * — put "validation healthy" on the review-queue card and the task hero pill at
 * the same instant the gate underneath read "no approving verdict yet". Both
 * columns now come from ONE derivation of ONE `fm` snapshot.
 *
 * The same fix closes the SPLIT gate: the projected reason now carries the two
 * refusals it used to leave to each reader (open blocked packet, conflicting PR),
 * which is what `acceptanceRefusalReason` has always enforced on the writers.
 */
describe("UX19-3: the projected validation column and the acceptance gate agree", () => {
  const REV = {
    id: "rev_ux3",
    headSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    branch: "vib-9-work",
    createdAt: "2026-08-06T00:00:00.000Z",
    sourceProfileId: "developer",
  };
  const REVIEWER = {
    profileId: "reviewer",
    backend: "claude" as const,
    role: "Review",
    delivers: false,
    verdictCapable: true,
  };
  const APPROVAL = {
    profileId: "reviewer",
    revisionId: REV.id,
    headSha: REV.headSha,
    result: "approve" as const,
    reason: "looks good",
    at: "2026-08-06T01:00:00.000Z",
  };

  function seed(
    store: ReturnType<typeof setupTestStore>,
    patch: Partial<TaskFrontmatter>,
    packet: TaskPacket | null = null,
  ) {
    const file: Partial<ParsedTaskFile> & { frontmatter: TaskFrontmatter } = {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "review",
        waiting: "human",
        readiness: "ready",
        branch: REV.branch,
        workRevision: REV,
        engagements: [REVIEWER],
        pr: { number: 900, state: "review", title: "Work" },
        ...patch,
      }),
    };
    // Key PRESENCE matters: `writeTask` fills in `packet: null` itself, and a
    // `packet: undefined` key would override that default instead of leaving it.
    if (packet) file.packet = packet;
    writeTask(store.dataRoot, store.slug, file);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    return listProjectTasks(store.db, store.slug).find((t) => t.key === "VIB-9")!;
  }

  it("projects the DERIVED validation, not a stale `validation: healthy` cache", () => {
    const store = setupTestStore(ctx);
    // The file CLAIMS healthy; the engaged reviewer has recorded no verdict on
    // the current revision, so the derivation says `changed`. This is exactly
    // what `removeReviewer` leaves behind after dropping the sole approver.
    const task = seed(store, { validation: "healthy", verdicts: [] });
    expect(task.validation).toBe("changed");
    // …and the gate beside it agrees, from the same snapshot.
    expect(task.blockReason).toMatch(/Waiting on 1 required reviewer approval/);
  });

  it("a genuinely approved revision still projects healthy with no block", () => {
    const store = setupTestStore(ctx);
    // The mirror case: the derivation is what makes the pill trustworthy, so it
    // must still say `healthy` when the verdicts really are in — even when the
    // file's cached line is stale in the OTHER direction.
    const task = seed(store, { validation: "none", verdicts: [APPROVAL] });
    expect(task.validation).toBe("healthy");
    expect(task.blockReason).toBeNull();
  });

  it("F27-L1: a PR-less delivered task is never projected acceptable — the safe fallback for the live no-change gate the sync projection can't run", () => {
    const store = setupTestStore(ctx);
    // acceptanceRefusalReason carries a no-change WORK gate (R20-2/F20-6) driven
    // by a LIVE async GitHub probe this synchronous projection cannot run, so it
    // is structurally absent from acceptanceBlockReason. It must fail SAFE: with
    // the required reviewer approved AND the verdict healthy, the only thing left
    // is the missing review PR — the column must still REFUSE (a lower gate) and
    // never fabricate a ready acceptance the accept action would decline.
    const task = seed(store, { pr: null, verdicts: [APPROVAL] });
    expect(task.blockReason).not.toBeNull();
  });

  it("a CONFLICTING PR blocks acceptance in the projected column (P14-LV-07)", () => {
    const store = setupTestStore(ctx);
    const task = seed(store, {
      verdicts: [APPROVAL],
      pr: {
        number: 900,
        state: "review",
        title: "Work",
        mergeable: "conflicting",
      },
    });
    // Approved and healthy — the ONLY thing standing in the way is the conflict,
    // which used to be left to each reader to re-derive (and one of them didn't).
    expect(task.validation).toBe("healthy");
    expect(task.blockReason).toBe(
      "VIB-9's review PR #900 conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Rebase the branch and re-review, or archive the task.",
    );
  });

  it("an OPEN BLOCKED PACKET blocks acceptance in the projected column", () => {
    const store = setupTestStore(ctx);
    const task = seed(
      store,
      { readiness: "blocked", verdicts: [APPROVAL] },
      {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Credentials missing",
        body: "",
        observations: [],
        options: [],
      },
    );
    expect(task.blockReason).toBe(
      "This task has an open blocked decision. Resolve the operator's packet before accepting it.",
    );
  });

  it("keeps `acceptanceRefusalReason`'s order: the closed PR outranks both new gates", () => {
    const store = setupTestStore(ctx);
    const task = seed(
      store,
      {
        readiness: "blocked",
        verdicts: [APPROVAL],
        pr: {
          number: 900,
          state: "closed",
          title: "Work",
          mergeable: "conflicting",
        },
      },
      {
        type: "blocked",
        kind: "Blocked decision",
        from: "operator",
        title: "Credentials missing",
        body: "",
        observations: [],
        options: [],
      },
    );
    expect(task.blockReason).toContain("closed on GitHub without merging");
  });

  it("an `input` packet is not a blocked decision and does not gate acceptance", () => {
    const store = setupTestStore(ctx);
    // Both halves of the writers' predicate are required: `readiness: blocked`
    // alone, or an `input` packet alone, is not the refusal.
    const task = seed(
      store,
      { readiness: "blocked", verdicts: [APPROVAL] },
      {
        type: "input",
        kind: "Decision required",
        from: "operator",
        title: "Pick one",
        body: "",
        observations: [],
        options: [],
      },
    );
    expect(task.blockReason).toBeNull();
  });
});

describe("scoped project rescan (F20)", () => {
  it("reprojects ONLY the target project, leaving other projects' rows untouched", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "A original" }),
    });
    writeSecondProject(store, "other-proj");
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1", { title: "B original" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Edit a task in BOTH projects directly on disk.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "A edited" }),
    });
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1", { title: "B edited" }),
    });

    // Scoped rescan of project A only.
    const summary = rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });
    expect(summary.projects).toBe(1);
    expect(summary.tasks).toBe(1); // only A's task is walked
    expect(summary.changed).toBe(1); // A's edited task

    // A picked up its edit; B's stale projection is deliberately NOT touched —
    // proving the effect is confined to the authorized project.
    expect(getTaskDetail(store.db, store.slug, "VIB-1")?.title).toBe("A edited");
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")?.title).toBe("B original");
  });

  it("prunes only the target project's vanished task rows, never another project's", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    writeSecondProject(store, "other-proj");
    writeTask(store.dataRoot, "other-proj", {
      frontmatter: baseTaskFrontmatter("OTH-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    // Delete a task file in the OTHER project, then rescan only project A.
    rmSync(taskFilePath("other-proj", "OTH-1", store.dataRoot));
    rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });

    // A's task survives; B's deleted task is NOT pruned by A's scoped rescan.
    expect(listProjectTasks(store.db, store.slug).map((t) => t.key)).toEqual(["VIB-1"]);
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")).not.toBeNull();

    // A scoped rescan of B DOES prune it.
    const summary = rebuildProject(store.db, "other-proj", { dataRoot: store.dataRoot });
    expect(summary.removed).toBe(1);
    expect(getTaskDetail(store.db, "other-proj", "OTH-1")).toBeNull();
  });

  it("emits a project-scoped projection.rebuilt event", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const scopes: string[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "projection.rebuilt") scopes.push(e.scope);
    });
    rebuildProject(store.db, store.slug, { dataRoot: store.dataRoot });
    off();

    expect(scopes).toContain("project");
    expect(scopes).not.toContain("full");
  });
});
