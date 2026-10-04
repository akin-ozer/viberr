import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  TaskSchedule,
} from "~/schemas/task-file.schema";
import { GOVERNED_TEMPLATE } from "~/shared/workflow/templates";
import { onProjectionEvent } from "~/server/events/projection-events.server";
import {
  allocateTaskKey,
  updateProjectFile,
} from "~/server/files/project-writer.server";
import {
  rebuildAll,
  rebuildPath,
  rebuildProject,
  rebuildTaskFile,
  reprojectProject,
} from "./rebuilder.server";
import { getBoardWithTasks, listProjectTasks } from "./board-query.server";
import {
  projectionFault,
  projectionFaultCount,
  resetProjectionFaultsForTests,
} from "./store-health.server";
import { getTaskDetail, getTaskSummary } from "./task-query.server";

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
    requiredReviewers: [],
  fileLeases: [],
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

    const board = getBoardWithTasks(store.db, store.slug)?.board;
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
    const board = getBoardWithTasks(store.db, store.slug)?.board;
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

  // LV-04: an unresolvable user id must never render as the raw `u_…` string.
  it("labels an owner whose account no longer exists", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-904", {
        ownerUserId: "u_RT7-QeTWOwP4",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const owner = getTaskSummary(store.db, store.slug, "VIB-904")!.owner!;
    expect(owner.kind).toBe("human");
    expect(owner.name).not.toBe("u_RT7-QeTWOwP4");
    expect(owner.name).toContain("Removed account");
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
      { id: "qa", name: "QA", color: "teal" },
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
      requiredReviewers: [],
    fileLeases: [],
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
            rounds: 1,
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
    rounds: 1,
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
      "VIB-9's review PR #900 conflicts with the base branch. GitHub can't merge it, so it can't be accepted. " + "Resolve the conflict on the branch by merging the base INTO it (never by rebasing, which rewrites commits the pull request already published), then re-review, or archive the task.",
    );
  });

  it("ruling 135: an UNPUSHED delivered revision projects its own block reason ABOVE the conflict", () => {
    // Canary: drop `unpushedRevisionBlockedReason` from `acceptanceBlockReason`
    // and the column names a rebase for a branch that only needs a push.
    const store = setupTestStore(ctx);
    const task = seed(store, {
      verdicts: [APPROVAL],
      pr: {
        number: 900, state: "review", title: "Work", mergeable: "conflicting", headSha: "1".repeat(40),
        unpushedRevision: { revisionSha: REV.headSha, prHeadSha: "1".repeat(40), relation: "behind" },
      },
    });
    expect(task.validation).toBe("healthy");
    expect(task.blockReason).toBe(
      `VIB-9's delivered revision \`${REV.headSha.slice(0, 7)}\` is not on PR #900 (its head is \`1111111\`). Deliver the branch to push it; it cannot be accepted until the PR carries the reviewed revision.`,
    );
    // A record for a revision that is no longer current is stale and silent.
    const stale = seed(store, {
      verdicts: [APPROVAL],
      pr: { number: 900, state: "review", title: "Work", unpushedRevision: { revisionSha: "0".repeat(40), prHeadSha: "1".repeat(40), relation: "behind" } },
    });
    expect(stale.blockReason).toBeNull();
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

/* ------------------------------------------------------ reprojectProject */
describe("reprojectProject", () => {
  const nameRow = z.object({ name: z.string() });

  it("re-projects project.md from the context's data root after a write", () => {
    const store = setupTestStore(ctx);
    writeSecondProject(store, "other-proj");
    const nameOf = () =>
      nameRow.parse(
        store.db.prepare(`SELECT name FROM projects WHERE slug = ?`).get("other-proj"),
      ).name;

    reprojectProject(store.db, { dataRoot: store.dataRoot }, "other-proj");
    expect(nameOf()).toBe("Other Project");

    const file = projectFilePath("other-proj", store.dataRoot);
    const before = readFileSync(file, "utf8");
    const after = before.replace("Other Project", "Renamed Project");
    expect(after).not.toBe(before);
    writeFileSync(file, after);
    reprojectProject(store.db, { dataRoot: store.dataRoot }, "other-proj");
    expect(nameOf()).toBe("Renamed Project");
  });

  it("records a failed rebuild instead of throwing into the write that already happened", () => {
    const store = setupTestStore(ctx);
    resetProjectionFaultsForTests();
    writeSecondProject(store, "other-proj");
    store.db.exec(`ALTER TABLE project_members RENAME TO project_members_gone`);
    try {
      expect(() =>
        reprojectProject(store.db, { dataRoot: store.dataRoot }, "other-proj"),
      ).not.toThrow();
      expect(projectionFault()?.sourcePath).toContain("other-proj");
    } finally {
      store.db.exec(`ALTER TABLE project_members_gone RENAME TO project_members`);
      resetProjectionFaultsForTests();
    }
  });
});

/* ------------------------------------------------------ F28-D3 crash-consistency */
describe("rebuildTaskFile crash-consistency (F28-D3)", () => {
  const mkEvent = (userId: string, at: string, text: string) => ({
    occurredAt: at,
    type: "comment" as const,
    actor: { kind: "human" as const, userId, nameHint: null },
    title: null,
    toAgent: false,
    evidence: null,
    text,
  });

  const countRow = z.object({ c: z.number() });

  it("a crash during the events rewrite heals on the next rebuild, never strands the timeline", () => {
    const store = setupTestStore(ctx);
    const uid = store.users.arda.id;
    const eventCount = () =>
      countRow.parse(
        store.db
          .prepare(
            `SELECT COUNT(*) AS c FROM task_events WHERE project_slug = ? AND task_key = ?`,
          )
          .get(store.slug, "VIB-1"),
      ).c;

    // Baseline: a task with a 2-event timeline, fully projected.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      goal: "Do the thing.",
      timeline: [
        mkEvent(uid, "2026-08-26T10:00:00.000Z", "first"),
        mkEvent(uid, "2026-08-26T10:01:00.000Z", "second"),
      ],
    });
    rebuildTaskFile(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot });
    expect(eventCount()).toBe(2);

    // A 3rd comment lands (new file content, new hash).
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      goal: "Do the thing.",
      timeline: [
        mkEvent(uid, "2026-08-26T10:00:00.000Z", "first"),
        mkEvent(uid, "2026-08-26T10:01:00.000Z", "second"),
        mkEvent(uid, "2026-08-26T10:02:00.000Z", "third"),
      ],
    });

    // Simulate a crash DURING the task_events rewrite by pulling the table out
    // from under it — the DELETE/INSERT throws, aborting the rebuild AFTER the
    // task_projections upsert (which now writes only the sentinel hash) but
    // BEFORE the events are rewritten. Restore it immediately after.
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_crashed`);
    expect(() =>
      rebuildTaskFile(store.db, store.slug, "VIB-1", {
        dataRoot: store.dataRoot,
      }),
    ).toThrow();
    store.db.exec(`ALTER TABLE task_events_crashed RENAME TO task_events`);

    // content_hash is written LAST, so the interrupted rebuild left the sentinel
    // — NOT the new file's hash — and the next ORDINARY rebuild re-runs (not
    // short-circuited) and heals to 3 events. Before F28-D3 the hash rode the
    // upsert, so this state read "unchanged" forever and the 3rd comment was
    // invisible.
    const healed = rebuildTaskFile(store.db, store.slug, "VIB-1", {
      dataRoot: store.dataRoot,
    });
    expect(healed.action).toBe("projected");
    expect(eventCount()).toBe(3);
  });

  /**
   * Ruling 217 (F37-37). `rebuildPath`'s catch is deliberately quiet so one bad
   * file cannot take the process down. Live on pass 37 the store went to
   * `SQLITE_CORRUPT` and quiet is exactly what it stayed: every rebuild threw,
   * every task page 500ed, and `/resources/health` answered `degraded: []` for
   * twelve minutes. Viberr logged the store's own error on every failure and
   * had nowhere to put the fact. This is that place, and the test uses the
   * crash technique above to produce a REAL failing rebuild rather than calling
   * the latch by hand.
   */
  it("latches a failing rebuild for health, and clears it on the next one that writes", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      goal: "Do the thing.",
      timeline: [mkEvent(store.users.arda.id, "2026-08-26T10:00:00.000Z", "first")],
    });
    const taskPath = path.join(
      store.dataRoot,
      "projects",
      store.slug,
      "tasks",
      "VIB-1",
      "task.md",
    );
    expect(rebuildPath(store.db, taskPath, { dataRoot: store.dataRoot }).action).not.toBe(
      "error",
    );
    expect(projectionFault()).toBeNull();

    // A store that cannot take the write — the same way the crash test above
    // produces one, and the same shape SQLITE_CORRUPT produced live.
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_gone`);
    // The file must differ, or the rebuild short-circuits as "unchanged" and
    // never reaches the write. (Without this the test passes against broken
    // code, because nothing throws.)
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      goal: "Do the thing.",
      timeline: [
        mkEvent(store.users.arda.id, "2026-08-26T10:00:00.000Z", "first"),
        mkEvent(store.users.arda.id, "2026-08-26T10:01:00.000Z", "second"),
      ],
    });
    // CANARY: drop `recordProjectionFault` from the catch and this is null —
    // the rebuild still fails, the log line is still written, and every surface
    // still reports a healthy instance.
    expect(rebuildPath(store.db, taskPath, { dataRoot: store.dataRoot }).action).toBe(
      "error",
    );
    const fault = projectionFault();
    expect(fault).not.toBeNull();
    expect(fault!.sourcePath).toContain("VIB-1");
    // The STORE's own words, not viberr's paraphrase of them.
    expect(fault!.message).toContain("task_events");
    expect(fault!.failures).toBe(1);

    store.db.exec(`ALTER TABLE task_events_gone RENAME TO task_events`);
    expect(rebuildPath(store.db, taskPath, { dataRoot: store.dataRoot }).action).not.toBe(
      "error",
    );
    // CANARY: drop the `succeeded()` clear and the instance alarms forever
    // after one bad write, which is what ruling 146 refused to let it do.
    expect(projectionFault()).toBeNull();
    resetProjectionFaultsForTests();
  });

  /**
   * Ruling 219 (F37-39). `rebuildPath`'s catch exists so one bad file cannot
   * take the process down — and it wrote its "this failed" provenance row to
   * the SAME store that had just failed, so when the store itself was the
   * fault, the catch threw and `rebuildPath` raised after all.
   *
   * Live cost: `resolvePacket` wrote SHOP-4's file (packet resolved, `waiting:
   * agent`), called `reprojectTask`, and died right here. The operator
   * re-invoke that the resolution owes never ran, and the task sat reading
   * "agent working" with nothing running for eleven minutes — after the
   * canonical write had already succeeded. Only the mirror had failed.
   */
  it("never throws into its caller, even when the store cannot take the failure note (ruling 219)", () => {
    const store = setupTestStore(ctx);
    resetProjectionFaultsForTests();
    const uid = store.users.arda.id;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [mkEvent(uid, "2026-08-26T10:00:00.000Z", "first")],
    });
    const taskPath = path.join(
      store.dataRoot,
      "projects",
      store.slug,
      "tasks",
      "VIB-1",
      "task.md",
    );
    rebuildPath(store.db, taskPath, { dataRoot: store.dataRoot });

    // The store is broken for BOTH the rebuild and the note about it — which
    // is the only interesting case, because a store that can still write the
    // note was never the one that hurt anybody.
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_gone`);
    store.db.exec(`ALTER TABLE provenance RENAME TO provenance_gone`);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [
        mkEvent(uid, "2026-08-26T10:00:00.000Z", "first"),
        mkEvent(uid, "2026-08-26T10:01:00.000Z", "second"),
      ],
    });

    // CANARY: take the inner try/catch off `recordProvenance` and this THROWS,
    // which is what aborted resolvePacket's operator re-invoke live.
    let result: ReturnType<typeof rebuildPath> | null = null;
    expect(() => {
      result = rebuildPath(store.db, taskPath, { dataRoot: store.dataRoot });
    }).not.toThrow();
    expect(result!.action).toBe("error");
    // …and the caller still learns about it, through the latch health reads.
    expect(projectionFaultCount()).toBe(1);

    store.db.exec(`ALTER TABLE provenance_gone RENAME TO provenance`);
    store.db.exec(`ALTER TABLE task_events_gone RENAME TO task_events`);
    resetProjectionFaultsForTests();
  });

  /**
   * Ruling 218 (F37-38): 217's latch held ONE slot, so any later rebuild that
   * wrote cleared it. Live, ninety seconds after the corrupt store was
   * replaced, a transient `disk I/O error` on SHOP-4 left its card reading
   * "waiting on you" while its file said `waiting: agent` — and health was back
   * to `ok`, because SHOP-16's file had rebuilt fine in between.
   */
  it("keeps one file's fault when a DIFFERENT file projects (ruling 218)", () => {
    const store = setupTestStore(ctx);
    resetProjectionFaultsForTests();
    const uid = store.users.arda.id;
    const write = (key: string, events: number) =>
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "impl" }),
        goal: "Do the thing.",
        timeline: Array.from({ length: events }, (_, i) =>
          mkEvent(uid, `2026-08-26T10:0${i}:00.000Z`, `e${i}`),
        ),
      });
    const pathOf = (key: string) =>
      path.join(store.dataRoot, "projects", store.slug, "tasks", key, "task.md");
    write("VIB-1", 1);
    write("VIB-2", 1);
    rebuildPath(store.db, pathOf("VIB-1"), { dataRoot: store.dataRoot });
    rebuildPath(store.db, pathOf("VIB-2"), { dataRoot: store.dataRoot });

    // VIB-1 fails against a store that cannot take the write…
    store.db.exec(`ALTER TABLE task_events RENAME TO task_events_gone`);
    write("VIB-1", 2);
    expect(rebuildPath(store.db, pathOf("VIB-1"), { dataRoot: store.dataRoot }).action).toBe(
      "error",
    );
    expect(projectionFaultCount()).toBe(1);

    // …and VIB-2 then projects fine. VIB-1's row is still stale.
    store.db.exec(`ALTER TABLE task_events_gone RENAME TO task_events`);
    write("VIB-2", 2);
    expect(
      rebuildPath(store.db, pathOf("VIB-2"), { dataRoot: store.dataRoot }).action,
    ).not.toBe("error");
    // CANARY: clear the latch wholesale instead of per path and this is 0,
    // which is the instance reporting itself healthy over a stale row.
    expect(projectionFaultCount()).toBe(1);
    expect(projectionFault()!.sourcePath).toContain("VIB-1");

    // Only VIB-1's own success ends it.
    expect(
      rebuildPath(store.db, pathOf("VIB-1"), { dataRoot: store.dataRoot }).action,
    ).not.toBe("error");
    expect(projectionFaultCount()).toBe(0);
  });
});

/**
 * Ruling 131 (pass 34): the projection carries `blockedBy` verbatim and the
 * DERIVED readiness floors at `blocked` while the list is non-empty; the
 * stored value is untouched (the floor never improves anything).
 *
 * Canary: pass `dependenciesListed: false` into `deriveReadiness` and the
 * derived `blocked` assertion fails while the column still fills.
 */
describe("task dependencies projection (ruling 131)", () => {
  it("stores blocked_by_json verbatim and floors the derived readiness at blocked, leaving the stored value alone", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-7", {
          readiness: "ready",
          blockedBy: ["VIB-2", "VIB-3", "VIB-4"],
        }),
      });
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-8", { readiness: "ready" }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });
      // SAFETY: the three selected columns are TEXT NOT NULL on `task_projections`.
      const rows = store.db
        .prepare(
          `SELECT task_key, readiness, stored_readiness, blocked_by_json FROM task_projections WHERE task_key IN ('VIB-7', 'VIB-8') ORDER BY task_key`,
        )
        .all() as { task_key: string; readiness: string; stored_readiness: string; blocked_by_json: string }[];
      expect(rows).toEqual([
        {
          task_key: "VIB-7",
          readiness: "blocked",
          stored_readiness: "ready",
          blocked_by_json: JSON.stringify(["VIB-2", "VIB-3", "VIB-4"]),
        },
        { task_key: "VIB-8", readiness: "ready", stored_readiness: "ready", blocked_by_json: "[]" },
      ]);
    } finally {
      ctx.cleanup();
    }
  });
});

/**
 * LV-20 — a terminal-stage task is CLOSED, so nothing can be waiting on a human.
 *
 * Live-proven: a conversational operator turn on a Done+merged task left
 * `waiting: human` in the task file forever (the run start flips it to `agent`,
 * `clearWaitingToHuman` flips it back to `human` when the run ends — see
 * app/server/tasks/task-actions.server.ts). The task detail then reported
 * "Waiting on: Human decision", the board counted it in "N waiting on a human
 * decision", and the review queue (which filters on the review boundary)
 * reported 0 — two surfaces disagreeing about one task.
 */
describe("LV-20: waiting is normalized at the terminal stage", () => {
  it("projects a done task's stored `waiting: human` as `none`", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-900", {
        stage: "done",
        waiting: "human",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });

    const summary = getTaskSummary(store.db, store.slug, "VIB-900")!;
    expect(summary.stage).toBe("done");
    expect(summary.waiting).toBe("none");

    // The board counter reads the same projection, so it agrees.
    const board = getBoardWithTasks(store.db, store.slug)!.board;
    const all = board.columns.flatMap((c) => c.tasks);
    expect(all.filter((t) => t.waiting === "human")).toHaveLength(0);
  });

  it("leaves a NON-terminal task's waiting state untouched", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-901", {
        stage: "review",
        waiting: "human",
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(getTaskSummary(store.db, store.slug, "VIB-901")!.waiting).toBe(
      "human",
    );
  });
});

/**
 * Ruling 225 (F37-45). The live failure: ruling 224 taught viberr to answer a
 * shut quota window by scheduling its own resumption, and four pass-37 tasks
 * did exactly that — packet resolved, `run-operator` pending for 02:28 UTC,
 * nothing asked of anybody. Every card still read "waiting on a human" and the
 * board header counted them, because `waiting: human` is simply what
 * `clearWaitingToHuman` writes when the last run ends. The packet that put them
 * there had promised "Nothing runs until then and the board says so."
 *
 * These assert the derivation and, just as hard, its LIMITS: a decision a human
 * can act on always outranks the clock, because `decisionsRequiring` reads this
 * same column and a wrong answer here would hide work rather than describe it.
 */
describe("ruling 225: a task resting on a clock", () => {
  /**
   * The live shape these four tasks were in: delivered work at the review
   * boundary with no approving verdict, so no human can accept it either. That
   * last clause is load-bearing — a task a human COULD accept is a decision,
   * and stays one (see the packet and recommendation cases below).
   */
  const unaccepted: Partial<TaskFrontmatter> = {
    stage: "review",
    readiness: "ready",
    waiting: "human",
    validation: "changed",
    engagements: [
      {
        profileId: "code-reviewer",
        backend: "codex",
        role: "Code Reviewer",
        delivers: false,
        verdictCapable: true,
      },
    ],
    workRevision: {
      id: "rev_1",
      headSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      branch: "vib-1",
      createdAt: "2026-09-13T23:11:18.732Z",
      sourceProfileId: "developer",
      kind: "delivered",
      pushedAt: "2026-09-13T23:11:54.461Z",
    },
    verdicts: [],
  };

  /** An open decision a human can act on, in the shape `decisions.server` counts. */
  const OPEN_PACKET: TaskPacket = {
    type: "input",
    kind: "Decision required",
    from: "operator",
    title: "Pick one",
    body: "",
    observations: [],
    options: [{ kind: "request_edit", t: "Send back", d: "", rec: true }],
  };

  const pending = (dueAt: string, patch: Partial<TaskSchedule> = {}): TaskSchedule => ({
    id: `sch_${dueAt}`,
    action: "run-operator" as const,
    dueAt,
    profileId: null,
    prompt: "The usage window reopened.",
    createdBy: "u_1",
    createdByLabel: "Arda",
    createdAt: "2026-09-14T00:14:57.815Z",
    status: "pending" as const,
    firedAt: null,
    claimedAt: null,
    retries: 0,
    ...patch,
  });

  it("projects `schedule`, and names the earliest pending instant", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          // The LATER occurrence is written first on purpose: the answer is the
          // one that fires next, not the one that happens to be listed first.
          schedules: [
            pending("2026-09-14T06:00:00.000Z"),
            pending("2026-09-14T02:28:00.000Z"),
          ],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      const task = listProjectTasks(store.db, store.slug)[0]!;
      expect(task.waiting).toBe("schedule");
      expect(task.resumesAt).toBe("2026-09-14T02:28:00.000Z");
      // The canonical file is untouched — this is a derived display value, the
      // same contract LV-20's terminal `none` keeps.
      expect(
        readFileSync(taskFilePath(store.slug, "VIB-1", store.dataRoot), "utf8"),
      ).toContain("waiting: human");
    } finally {
      ctx.cleanup();
    }
  });

  it("leaves an already-fired schedule alone", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          schedules: [
            pending("2026-09-13T08:19:58.271Z", {
              status: "fired",
              firedAt: "2026-09-13T08:20:09.950Z",
            }),
          ],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      const task = listProjectTasks(store.db, store.slug)[0]!;
      expect(task.waiting).toBe("human");
      expect(task.resumesAt ?? null).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("lets an open packet outrank the clock", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          readiness: "input_required",
          schedules: [pending("2026-09-14T02:28:00.000Z")],
        }),
        packet: OPEN_PACKET,
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      // The schedule does not take the decision off anybody's hands, so the
      // task still says a human is needed — and `decisionsRequiring`, which
      // filters on this column, still counts it.
      expect(listProjectTasks(store.db, store.slug)[0]!.waiting).toBe("human");
    } finally {
      ctx.cleanup();
    }
  });

  it("lets a pending recommendation outrank the clock", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          schedules: [pending("2026-09-14T02:28:00.000Z")],
          recommendations: [
            {
              id: "rec_1",
              kind: "transition" as const,
              toStageId: "done",
              label: "Move this to Done",
              detail: "The work looks finished.",
            },
          ],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      expect(listProjectTasks(store.db, store.slug)[0]!.waiting).toBe("human");
    } finally {
      ctx.cleanup();
    }
  });

  it("rests on the clock at a stage nobody can accept from", () => {
    // Caught on the live board, not by reading. SHOP-21 sat at Build with no
    // revision, no PR and a `run-operator` schedule pending for 07:29, and its
    // card and rail both still read "waiting on a human" after this ruling
    // shipped — while the board's own "Waiting on me" tally read zero.
    //
    // The cause: `acceptanceRefusal === null` is NOT "a human could accept".
    // The STAGE gate is the one acceptance refusal `acceptanceBlockReason`
    // deliberately omits (it turns on the workflow graph, not the task file),
    // so an early-stage task with nothing delivered has no refusal to report —
    // not because it is acceptable, but because the only thing refusing it was
    // never consulted.
    //
    // Canary: drop `isAtAcceptanceBoundary` from `couldBeAcceptedNow`.
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          // `impl` is neither the review stage nor a stage with an edge to the
          // terminal one, so nothing can be accepted from here.
          stage: "impl",
          readiness: "ready",
          waiting: "human",
          schedules: [pending("2026-09-14T07:29:00.000Z")],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      const task = listProjectTasks(store.db, store.slug)[0]!;
      expect(task.waiting).toBe("schedule");
      expect(task.resumesAt).toBe("2026-09-14T07:29:00.000Z");
    } finally {
      ctx.cleanup();
    }
  });

  it("never promises a resume the schedule runner will refuse", () => {
    // Caught by re-reading my own predicate, not by any of the 41 tests that
    // were already green. A task that waits on other work is HELD (ruling
    // 131(d)), and the schedule runner refuses its occurrence on exactly those
    // grounds: "waits on other work (…) — no operator run was started; Viberr
    // releases the task when every entry is done." A card reading "resumes Sep
    // 14 · 02:28" over an occurrence that will be refused is the same lie this
    // ruling removes, reintroduced by it.
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          blockedBy: ["VIB-2"],
          schedules: [pending("2026-09-14T02:28:00.000Z")],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      const task = listProjectTasks(store.db, store.slug)[0]!;
      expect(task.waiting).not.toBe("schedule");
      expect(task.resumesAt ?? null).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("never promises a resume on an archived task either", () => {
    // Third instance of the same hole, found the same way: by asking which
    // tasks the schedule runner refuses. It has a dedicated `skipped-archived`
    // outcome, so a resume time on an archived card is a run that will not
    // happen. Archiving leaves every view but the Archived filter — which
    // still draws the card, and the card still draws this tag.
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          archived: true,
          schedules: [pending("2026-09-14T02:28:00.000Z")],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      const task = listProjectTasks(store.db, store.slug, { includeArchived: true })[0]!;
      expect(task.archived).toBe(true);
      expect(task.waiting).not.toBe("schedule");
    } finally {
      ctx.cleanup();
    }
  });

  it("invents no claim on a task that was making none", () => {
    // `waiting: "none"` renders NO wait tag at all, so it tells nobody
    // anything and there is nothing to correct. The ruling is about the one
    // stored value that says the false sentence.
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          waiting: "none",
          schedules: [pending("2026-09-14T02:28:00.000Z")],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      expect(listProjectTasks(store.db, store.slug)[0]!.waiting).toBe("none");
    } finally {
      ctx.cleanup();
    }
  });

  it("never lets a hand-authored `schedule` claim a rest it has not earned", () => {
    const ctx = createTestDbContext();
    try {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          ...unaccepted,
          // Nothing authors this value; a file that carries it anyway must not
          // be able to talk the board out of naming a human.
          waiting: "schedule",
          schedules: [],
        }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot });

      expect(listProjectTasks(store.db, store.slug)[0]!.waiting).toBe("human");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("ruling 457: projection write cost, behaviour kept", () => {
  const comment = (userId: string, at: string, text: string) => ({
    occurredAt: at,
    type: "comment" as const,
    actor: { kind: "human" as const, userId, nameHint: null },
    title: null,
    toAgent: false,
    evidence: null,
    text,
  });
  const rowsSchema = z.array(
    z.object({
      id: z.number(),
      position: z.number(),
      occurred_at: z.string(),
      type: z.string(),
      actor_ref: z.string(),
      actor_json: z.string(),
      title: z.string().nullable(),
      text: z.string(),
    }),
  );
  const eventRows = (store: ReturnType<typeof setupTestStore>, key: string) =>
    rowsSchema.parse(
      store.db
        .prepare(
          `SELECT id, position, occurred_at, type, actor_ref, actor_json, title, text
             FROM task_events WHERE project_slug = ? AND task_key = ? ORDER BY position`,
        )
        .all(store.slug, key),
    );
  /** The rows a from-scratch projection of the same file produces, ids aside. */
  const scratchRows = (store: ReturnType<typeof setupTestStore>, key: string) => {
    store.db
      .prepare(`DELETE FROM task_events WHERE project_slug = ? AND task_key = ?`)
      .run(store.slug, key);
    rebuildTaskFile(store.db, store.slug, key, { dataRoot: store.dataRoot, force: true });
    return eventRows(store, key).map(({ id: _id, ...rest }) => rest);
  };
  const taskUpdates = () => {
    const keys: string[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type === "task.updated") keys.push(e.taskKey);
    });
    return { keys, off };
  };

  function twoTasks(store: ReturnType<typeof setupTestStore>) {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
      timeline: [comment(store.users.selin.id, "2026-07-01T10:00:00.000Z", "hi")],
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
  }

  it("SRV-3: a nextTaskNumber bump updates the project row and re-projects no task", async () => {
    const store = setupTestStore(ctx);
    twoTasks(store);
    const projectEvents: string[] = [];
    const offProject = onProjectionEvent((e) => {
      if (e.type === "project.updated") projectEvents.push(e.projectSlug);
    });
    const tasks = taskUpdates();
    await allocateTaskKey({ projectSlug: store.slug, dataRoot: store.dataRoot });
    const result = rebuildPath(store.db, projectFilePath(store.slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    offProject();
    tasks.off();
    expect(result).toMatchObject({ action: "projected", taskFacingChanged: false });
    expect(projectEvents).toEqual([store.slug]);
    expect(tasks.keys).toEqual([]);
  });

  it("SRV-3: a stage change still re-projects every task", async () => {
    const store = setupTestStore(ctx);
    twoTasks(store);
    const tasks = taskUpdates();
    // Drop the `impl` stage: VIB-1 now sits on a stage the project does not have.
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.stages = parsed.frontmatter.stages.filter((s) => s.id !== "impl");
      parsed.frontmatter.workflow = parsed.frontmatter.workflow.filter(
        (w) => w.from !== "impl" && w.to !== "impl",
      );
    });
    rebuildPath(store.db, projectFilePath(store.slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    tasks.off();
    expect([...tasks.keys].sort()).toEqual(["VIB-1", "VIB-2"]);
    const codes = z
      .array(z.object({ code: z.string() }))
      .parse(store.db.prepare(`SELECT code FROM diagnostics WHERE task_key = ?`).all("VIB-1"))
      .map((d) => d.code);
    expect(codes).toContain("reference.unknown_stage");
  });

  it("SRV-3: a membership change still re-projects every task (guest flags)", async () => {
    const store = setupTestStore(ctx);
    twoTasks(store);
    const tasks = taskUpdates();
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.members = parsed.frontmatter.members.filter(
        (m) => m.userId !== store.users.selin.id,
      );
    });
    rebuildPath(store.db, projectFilePath(store.slug, store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    tasks.off();
    expect([...tasks.keys].sort()).toEqual(["VIB-1", "VIB-2"]);
    expect(JSON.parse(eventRows(store, "VIB-1")[0]!.actor_json)).toMatchObject({ guest: true });
  });

  it("SRV-3: a rescan after a counter-only change forces no task", async () => {
    const store = setupTestStore(ctx);
    twoTasks(store);
    await allocateTaskKey({ projectSlug: store.slug, dataRoot: store.dataRoot });
    const summary = rebuildAll(store.db, { dataRoot: store.dataRoot });
    expect(summary).toMatchObject({ projects: 1, tasks: 2, changed: 1, unchanged: 2 });
  });

  it("SRV-4: projection events arrive after the rows commit", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
      timeline: [comment(store.users.arda.id, "2026-07-01T10:00:00.000Z", "hi")],
    });
    const seen: { inTransaction: boolean; events: number }[] = [];
    const off = onProjectionEvent((e) => {
      if (e.type !== "task.updated") return;
      seen.push({
        inTransaction: store.db.isTransaction,
        events: eventRows(store, "VIB-1").length,
      });
    });
    rebuildPath(store.db, taskFilePath(store.slug, "VIB-1", store.dataRoot), {
      dataRoot: store.dataRoot,
    });
    off();
    expect(seen).toEqual([{ inTransaction: false, events: 1 }]);
  });

  it("CS-6: an append keeps every existing row, and the rows match a from-scratch projection", () => {
    const store = setupTestStore(ctx);
    const uid = store.users.arda.id;
    const older = [
      comment(uid, "2026-07-01T10:02:00.000Z", "third"),
      comment(uid, "2026-07-01T10:01:00.000Z", "second"),
      comment(uid, "2026-07-01T10:00:00.000Z", "first"),
    ];
    const frontmatter = baseTaskFrontmatter("VIB-1");
    writeTask(store.dataRoot, store.slug, { frontmatter, timeline: older });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const before = eventRows(store, "VIB-1");

    writeTask(store.dataRoot, store.slug, {
      frontmatter,
      timeline: [comment(store.users.murat.id, "2026-07-01T10:03:00.000Z", "fourth"), ...older],
    });
    rebuildTaskFile(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot });
    const after = eventRows(store, "VIB-1");
    expect(after.map((r) => r.text)).toEqual(["fourth", "third", "second", "first"]);
    expect(after.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(after.slice(1).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map(({ id: _id, ...rest }) => rest)).toEqual(scratchRows(store, "VIB-1"));
  });

  it("CS-6: an edit in the middle keeps the rows before it and rewrites the rest", () => {
    const store = setupTestStore(ctx);
    const uid = store.users.arda.id;
    const frontmatter = baseTaskFrontmatter("VIB-1");
    writeTask(store.dataRoot, store.slug, {
      frontmatter,
      timeline: [
        comment(uid, "2026-07-01T10:03:00.000Z", "fourth"),
        comment(uid, "2026-07-01T10:02:00.000Z", "third"),
        comment(uid, "2026-07-01T10:01:00.000Z", "second"),
        comment(uid, "2026-07-01T10:00:00.000Z", "first"),
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const before = eventRows(store, "VIB-1");

    // "third" is folded away (a compaction or a hand edit) and "second" is
    // reworded in place.
    writeTask(store.dataRoot, store.slug, {
      frontmatter,
      timeline: [
        comment(uid, "2026-07-01T10:04:00.000Z", "fifth"),
        comment(uid, "2026-07-01T10:03:00.000Z", "fourth"),
        comment(uid, "2026-07-01T10:01:00.000Z", "second, reworded"),
        comment(uid, "2026-07-01T10:00:00.000Z", "first"),
      ],
    });
    rebuildTaskFile(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot });
    const after = eventRows(store, "VIB-1");
    expect(after.map((r) => r.text)).toEqual(["fifth", "fourth", "second, reworded", "first"]);
    // The two oldest events kept their rows (one of them updated in place).
    expect(after.slice(2).map((r) => r.id)).toEqual(before.slice(2).map((r) => r.id));
    expect(after.map(({ id: _id, ...rest }) => rest)).toEqual(scratchRows(store, "VIB-1"));
  });

  it("CS-6: a renamed author's snapshot is refreshed on the kept rows", () => {
    const store = setupTestStore(ctx);
    const uid = store.users.arda.id;
    const frontmatter = baseTaskFrontmatter("VIB-1");
    writeTask(store.dataRoot, store.slug, {
      frontmatter,
      timeline: [comment(uid, "2026-07-01T10:00:00.000Z", "first")],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const before = eventRows(store, "VIB-1");

    store.db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run("Arda Renamed", uid);
    rebuildTaskFile(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot, force: true });
    const after = eventRows(store, "VIB-1");
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(JSON.parse(after[0]!.actor_json)).toMatchObject({ name: "Arda Renamed" });
  });

  /**
   * SRV-4 made a project's re-projection one transaction, cascade included, so
   * a task that could not re-project rolled back the project row with it: an
   * admin's member change never landed, the fault was pinned on project.md,
   * and every later write of project.md failed the same way.
   */
  it("SRV-4: a cascaded task that cannot re-project keeps the project row and the other tasks", async () => {
    const store = setupTestStore(ctx);
    twoTasks(store);
    resetProjectionFaultsForTests();
    // VIB-2's file cannot be read (EISDIR here; EACCES or EIO live).
    const brokenTask = taskFilePath(store.slug, "VIB-2", store.dataRoot);
    rmSync(brokenTask);
    mkdirSync(brokenTask);
    const tasks = taskUpdates();
    await updateProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }, (parsed) => {
      parsed.frontmatter.members = parsed.frontmatter.members.filter(
        (m) => m.userId !== store.users.selin.id,
      );
    });
    const projectPath = projectFilePath(store.slug, store.dataRoot);
    // CANARY: call `rebuildTaskFile` straight from the cascade loop again and
    // this is `error`, with selin still a member.
    const result = rebuildPath(store.db, projectPath, { dataRoot: store.dataRoot });
    tasks.off();
    expect(result).toMatchObject({ action: "projected", failedTasks: ["VIB-2"] });
    const members = z
      .array(z.object({ user_id: z.string() }))
      .parse(
        store.db
          .prepare(`SELECT user_id FROM project_members WHERE project_slug = ?`)
          .all(store.slug),
      )
      .map((m) => m.user_id);
    expect(members).not.toContain(store.users.selin.id);
    expect(tasks.keys).toEqual(["VIB-1"]);
    expect(JSON.parse(eventRows(store, "VIB-1")[0]!.actor_json)).toMatchObject({ guest: true });
    expect(projectionFaultCount()).toBe(1);
    expect(projectionFault()!.sourcePath).toBe(`projects/${store.slug}/tasks/VIB-2/task.md`);

    // The file is readable again: rebuilding project.md, unchanged, runs the
    // cascade again (the row kept the F28-D3 sentinel), and only then settles.
    rmSync(brokenTask, { recursive: true });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review" }),
    });
    expect(rebuildPath(store.db, projectPath, { dataRoot: store.dataRoot })).toMatchObject({
      action: "projected",
      taskFacingChanged: true,
    });
    expect(projectionFaultCount()).toBe(0);
    expect(rebuildPath(store.db, projectPath, { dataRoot: store.dataRoot }).action).toBe(
      "unchanged",
    );
  });
});
