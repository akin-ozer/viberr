import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { rescanProjections } from "~/server/projections/rescan.server";
import { rebuildProjections } from "~/server/projections/rebuild.server";
import {
  openScopeViolation,
  resolveScopeViolation,
} from "~/server/projections/policy-violations.server";
import { revalidateProjectCredential } from "~/server/secrets/pat-validator.server";
import {
  appendComment,
  createTask,
  releaseOwner,
  resolvePacket,
  setOwner,
  transitionStage,
} from "~/server/tasks/task-actions.server";
import {
  interruptRun,
  startRun,
} from "~/server/runtimes/run-service.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  installFakeRuntime,
  queueFakeRun,
} from "../../../test-support/fake-runtime";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "triage",
      readiness: "ready",
    }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-2", {
      stage: "review",
      readiness: "ready",
      waiting: "human",
      ownerUserId: null,
    }),
    packet: {
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept?",
      body: "Done.",
      observations: [],
      options: [
        {
          kind: "request_edit",
          t: "Request one edit",
          d: "",
          rec: true,
        },
      ],
    },
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  installFakeRuntime();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

interface CoverageRow {
  name: string;
  action: string;
  /**
   * Runs the governed entry point for its EFFECT — this table asserts on the
   * audit rows it writes, never on what it hands back, which is why the
   * contract returns nothing. The loop below still awaits the call: several of
   * these entry points are async.
   */
  run: () => void;
  /** Expected taskKey (task-scoped rows). */
  taskKey?: string;
  /** Instance-wide maintenance events have no project subject. */
  instanceWide?: boolean;
}

describe("governed actions record audit rows (table-driven)", () => {
  it("runs the table and finds every expected audit row", async () => {
    const actorArda = () => ({
      userId: store.users.arda.id,
      label: store.users.arda.email,
    });
    const fileCtx = { dataRoot: store.dataRoot };

    const table: CoverageRow[] = [
      {
        name: "createTask",
        action: "task.created",
        run: () =>
          createTask(
            store.db,
            { projectSlug: store.slug, title: "Audit sweep task" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "appendComment",
        action: "task.comment",
        taskKey: "VIB-1",
        run: () =>
          appendComment(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", text: "hello" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (take)",
        action: "task.ownership.taken",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.arda.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner (hand-off)",
        action: "task.ownership.handed_off",
        taskKey: "VIB-1",
        run: () =>
          setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "releaseOwner (admin forced)",
        action: "task.ownership.admin_released",
        taskKey: "VIB-1",
        run: () =>
          releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "setOwner + releaseOwner (self)",
        action: "task.ownership.released",
        taskKey: "VIB-1",
        run: async () => {
          await setOwner(
            store.db,
            {
              projectSlug: store.slug,
              taskKey: "VIB-1",
              targetUserId: store.users.murat.id,
            },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
          await releaseOwner(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            {
              userId: store.users.murat.id,
              label: store.users.murat.email,
            },
            fileCtx,
          );
        },
      },
      {
        name: "transitionStage (triage→ready, approval boundary)",
        action: "task.transition",
        taskKey: "VIB-1",
        run: () =>
          transitionStage(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", toStageId: "ready" },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "resolvePacket (request_edit)",
        action: "task.packet.resolved",
        taskKey: "VIB-2",
        run: () =>
          resolvePacket(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-2", optionIndex: 0 },
            actorArda(),
            fileCtx,
          ),
      },
      {
        name: "startRun",
        action: "runtime.run.started",
        taskKey: "VIB-1",
        run: () => {
          queueFakeRun({
            lines: [{ t: "1", ev: "text", tag: "assistant", text: "hi" }],
            sessionId: "s",
            keepRunning: true,
          });
          return startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "Primary specialist",
            kind: "primary",
            agentProfileId: "developer",
            backend: "claude",
            model: "m",
            prompt: "go",
            actor: actorArda(),
            dataRoot: store.dataRoot,
          });
        },
      },
      {
        name: "interruptRun",
        action: "runtime.run.interrupted",
        taskKey: "VIB-1",
        run: async () => {
          queueFakeRun({
            lines: [{ t: "1", ev: "text", tag: "assistant", text: "w" }],
            sessionId: "s2",
            keepRunning: true,
          });
          const { runId } = await startRun(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            role: "R",
            kind: "reviewer", // distinct thread — VIB-1 already has a primary
            agentProfileId: "reviewer",
            backend: "claude",
            model: "m",
            prompt: "go",
            dataRoot: store.dataRoot,
          });
          for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
          // D32-18: interruptRun also notes the interrupt on the task timeline,
          // so it is async and needs the store's data root.
          await interruptRun(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1", runId, dataRoot: store.dataRoot },
            actorArda(),
          );
        },
      },
      {
        name: "openScopeViolation",
        action: "github.scope_violation.opened",
        run: () =>
          openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            scope: "pull_request:write",
            detail: "audit sweep",
            actor: actorArda(),
          }),
      },
      {
        name: "resolveScopeViolation",
        action: "github.scope_violation.resolved",
        run: () => {
          const { violation } = openScopeViolation(store.db, {
            projectSlug: store.slug,
            taskKey: "VIB-2",
            scope: "repo",
            actor: actorArda(),
          });
          resolveScopeViolation(store.db, violation.id, actorArda());
        },
      },
      {
        // C05-H (pass 32): the collision remedy's PR close was locked only in
        // task-governance; the designated coverage file names it too.
        name: "resolveRemoteBranchCollision (closes the unowned PR)",
        action: "github.pr.closed_unowned",
        taskKey: "VIB-1",
        run: async () => {
          const { fakeGithubFetch } = await import("../../../test-support/fake-github");
          const { createPat, setProjectCredential } = await import(
            "~/server/secrets/pat-store.server"
          );
          const { resolveRemoteBranchCollision } = await import(
            "~/server/github/github-reconciler.server"
          );
          const patActor = { userId: store.users.arda.id, label: store.users.arda.email };
          const pat = createPat(
            store.db,
            { userId: store.users.arda.id, label: "bot", token: "ghp_coverage000000000000000000000001" },
            patActor,
          );
          setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, patActor);
          writeTask(store.dataRoot, store.slug, {
            frontmatter: baseTaskFrontmatter("VIB-1", {
              stage: "review",
              branch: "vib-1-work",
              github: { commits: [], changed: null, unownedPr: 232 },
            }),
          });
          rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
          const github = fakeGithubFetch({
            "PATCH /repos/akin-ozer/viberr/pulls/232": { status: 200, body: { state: "closed" } },
            "DELETE /repos/akin-ozer/viberr/git/refs/heads/vib-1-work": { status: 204, body: "" },
          });
          await resolveRemoteBranchCollision(
            store.db,
            { projectSlug: store.slug, taskKey: "VIB-1" },
            actorArda(),
            { dataRoot: store.dataRoot, fetchImpl: github.fetchImpl },
          );
        },
      },
      {
        name: "revalidateProjectCredential (grant-scope attempt, no PAT)",
        action: "github.credential.revalidated",
        run: () =>
          revalidateProjectCredential(store.db, store.slug, actorArda(), {
            dataRoot: store.dataRoot,
          }),
      },
      {
        name: "rescanProjections",
        action: "projection.rescan",
        instanceWide: true,
        run: () =>
          rescanProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
      {
        name: "rebuildProjections (full drop + rebuild)",
        action: "projection.rebuild",
        instanceWide: true,
        run: () =>
          rebuildProjections(store.db, {
            dataRoot: store.dataRoot,
            actor: actorArda(),
          }),
      },
    ];

    for (const row of table) {
      const before = listAuditEvents(store.db, { action: row.action }).length;
      await row.run();
      const rows = listAuditEvents(store.db, { action: row.action });
      expect(
        rows.length,
        `${row.name} did not record audit action ${row.action}`,
      ).toBeGreaterThan(before);

      const newest = rows[0]!;
      expect(
        newest.projectSlug,
        `${row.name}: ${row.action} must carry projectSlug`,
      ).toBe(row.instanceWide ? null : store.slug);
      const taskless = [
        "github.credential.revalidated",
        "projection.rescan",
        "projection.rebuild",
      ].includes(row.action);
      if (!taskless) {
        expect(
          newest.taskKey,
          `${row.name}: ${row.action} must carry taskKey`,
        ).toBeTruthy();
        if (row.taskKey) expect(newest.taskKey).toBe(row.taskKey);
      }
      expect(newest.actorLabel.length).toBeGreaterThan(0);
    }
  });

  it("rebuildProjections drops + re-projects to identical counts", () => {
    const countSchema = z.object({ c: z.number() });
    const rowCounts = () => ({
      projects: countSchema.parse(
        store.db.prepare(`SELECT count(*) c FROM projects`).get(),
      ).c,
      tasks: countSchema.parse(
        store.db.prepare(`SELECT count(*) c FROM task_projections`).get(),
      ).c,
      events: countSchema.parse(
        store.db.prepare(`SELECT count(*) c FROM task_events`).get(),
      ).c,
    });
    const countsBefore = rowCounts();
    expect(countsBefore.projects).toBeGreaterThan(0);
    expect(countsBefore.tasks).toBeGreaterThan(0);

    const summary = rebuildProjections(store.db, {
      dataRoot: store.dataRoot,
      actor: { userId: store.users.arda.id, label: store.users.arda.email },
    });
    expect(summary.projects).toBe(countsBefore.projects);
    expect(summary.tasks).toBe(countsBefore.tasks);
    expect(summary.errors).toBe(0);

    const countsAfter = rowCounts();
    expect(countsAfter).toEqual(countsBefore);
  });
});
