import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { updateProjectFile } from "~/server/files/project-writer.server";
import {
  readTaskFile,
  updateTaskFile,
} from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { reviewEvidenceFingerprint } from "./review-evidence.server";
import {
  convergeTaskCompletionIntent,
  convergeTaskMergePendingIntent,
  finalizeTaskAcceptanceIntent,
  getTaskCompletionIntent,
  recoverTaskAcceptanceIntents,
  recoverTaskCompletionIntents,
  setTaskCompletionIntentPhase,
  stageTaskMergeAcceptanceIntent,
} from "./task-completion-recovery.server";
import {
  createPat,
  setProjectCredential,
} from "~/server/secrets/pat-store.server";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const HEAD = "b".repeat(40);

function prepared(state: "review" | "accepted" | "merged" = "review") {
  const store = setupTestStore(ctx);
  const frontmatter = baseTaskFrontmatter("VIB-1", {
    stage: "review",
    ownerUserId: store.users.selin.id,
    reviewers: [],
    reviewerVerdicts: [],
    validation: "healthy",
    pr: {
      number: 42,
      state,
      title: "Durable acceptance",
      headSha: HEAD,
    },
  });
  writeTask(store.dataRoot, store.slug, { frontmatter });
  rebuildAll(store.db, { dataRoot: store.dataRoot });
  const intent = stageTaskMergeAcceptanceIntent(store.db, {
    projectSlug: store.slug,
    taskKey: "VIB-1",
    taskIncarnation: frontmatter.createdAt!,
    evidenceFingerprint: reviewEvidenceFingerprint(
      { goal: "Test goal.", frontmatter },
      "akin-ozer/viberr",
    ),
    actorUserId: store.users.selin.id,
    actorLabel: store.users.selin.email,
    authoritySource: "task_owner",
    doneStageId: "done",
    repo: "akin-ozer/viberr",
    defaultBranch: "main",
    prNumber: 42,
    headSha: HEAD,
  });
  return { store, intent };
}

describe("durable task acceptance", () => {
  it("converges merge-pending state and audit idempotently while retaining the original actor", async () => {
    const { store, intent } = prepared("review");

    expect(
      await convergeTaskMergePendingIntent(store.db, intent, {
        dataRoot: store.dataRoot,
      }),
    ).toBe(true);
    const retained = getTaskCompletionIntent(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      taskIncarnation: intent.taskIncarnation,
    });
    expect(retained).toMatchObject({
      id: intent.id,
      phase: "merge_pending",
      actorUserId: store.users.selin.id,
      authoritySource: "task_owner",
    });

    expect(
      await convergeTaskMergePendingIntent(store.db, retained!, {
        dataRoot: store.dataRoot,
      }),
    ).toBe(true);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.pr?.state).toBe("accepted");
    expect(
      task.timeline.filter(
        (event) => event.title === "Completion accepted · merge pending",
      ),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, {
        action: "task.completion.accepted_merge_pending",
      }),
    ).toHaveLength(1);
  });

  it("finishes an exact merged acceptance after a crash without crediting the retrier", async () => {
    const { store, intent } = prepared("merged");

    expect(
      await finalizeTaskAcceptanceIntent(store.db, intent, {
        dataRoot: store.dataRoot,
      }),
    ).toBe(true);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.stage).toBe("done");
    expect(task.timeline[0]).toMatchObject({
      title: "Completion accepted",
      actor: { kind: "human", userId: store.users.selin.id },
    });
    expect(
      listAuditEvents(store.db, { action: "task.transition" })[0],
    ).toMatchObject({
      actorUserId: store.users.selin.id,
      details: expect.objectContaining({
        authoritySource: "task_owner",
        mergedPr: true,
      }),
    });
    expect(
      getTaskCompletionIntent(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        taskIncarnation: intent.taskIncarnation,
      }),
    ).toBeNull();
  });

  it("boot finishes a crash after the merged decision became done but before task.md, without another GitHub call", async () => {
    const { store, intent } = prepared("merged");

    await expect(
      finalizeTaskAcceptanceIntent(store.db, intent, {
        dataRoot: store.dataRoot,
        phaseCommittedHookForTests: () => {
          throw new Error("injected crash after durable merged decision");
        },
      }),
    ).rejects.toThrow("injected crash after durable merged decision");

    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("review");
    expect(
      getTaskCompletionIntent(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        taskIncarnation: intent.taskIncarnation,
      }),
    ).toMatchObject({ phase: "done", mergedPr: true });
    expect(recoverTaskCompletionIntents(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 0,
      retained: 1,
      errors: 0,
    });

    let githubCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      githubCalls += 1;
      throw new Error("recovery must not contact GitHub");
    };
    await expect(
      recoverTaskAcceptanceIntents(store.db, store.dataRoot, { fetchImpl }),
    ).resolves.toEqual({
      completed: 1,
      pending: 0,
      cancelled: 0,
      retained: 0,
      errors: 0,
    });
    expect(githubCalls).toBe(0);

    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.stage).toBe("done");
    expect(
      task.timeline.filter((event) => event.title === "Completion accepted"),
    ).toHaveLength(1);
    expect(
      (
        store.db
          .prepare(
            `SELECT stage FROM task_projections
              WHERE project_slug = ? AND task_key = 'VIB-1'`,
          )
          .get(store.slug) as { stage: string }
      ).stage,
    ).toBe("done");
    expect(
      listAuditEvents(store.db, { action: "task.transition" })[0],
    ).toMatchObject({
      actorUserId: intent.actorUserId,
      actorLabel: intent.actorLabel,
      details: expect.objectContaining({
        authoritySource: intent.authoritySource,
        mergedPr: true,
      }),
    });
    expect(
      getTaskCompletionIntent(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        taskIncarnation: intent.taskIncarnation,
      }),
    ).toBeNull();

    await expect(
      recoverTaskAcceptanceIntents(store.db, store.dataRoot, { fetchImpl }),
    ).resolves.toEqual({
      completed: 0,
      pending: 0,
      cancelled: 0,
      retained: 0,
      errors: 0,
    });
    expect(githubCalls).toBe(0);
    expect(
      listAuditEvents(store.db, { action: "task.transition" }),
    ).toHaveLength(1);
  });

  it("boot observes an exact remote merge, converges its fact, and finishes the original acceptance without another PUT", async () => {
    const { store, intent } = prepared("accepted");
    const admin = {
      userId: store.users.arda.id,
      label: store.users.arda.email,
    };
    const pat = createPat(
      store.db,
      {
        userId: store.users.arda.id,
        label: "Acceptance recovery",
        token: "ghp_acceptance_recovery",
      },
      admin,
    );
    setProjectCredential(
      store.db,
      { projectSlug: store.slug, patId: pat.id },
      admin,
    );
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(
        JSON.stringify({
          state: "closed",
          merged: true,
          merged_at: "2026-07-13T09:00:00.000Z",
          merge_commit_sha: "merge-sha",
          head: { sha: HEAD },
          base: {
            ref: "main",
            repo: { full_name: "akin-ozer/viberr" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      recoverTaskAcceptanceIntents(store.db, store.dataRoot, { fetchImpl }),
    ).resolves.toEqual({
      completed: 1,
      pending: 0,
      cancelled: 0,
      retained: 0,
      errors: 0,
    });
    expect(methods.length).toBeGreaterThanOrEqual(2);
    expect(methods.every((method) => method === "GET")).toBe(true);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("done");
    expect(
      listAuditEvents(store.db, { action: "github.pr.merged" }),
    ).toHaveLength(1);
    expect(
      listAuditEvents(store.db, { action: "task.transition" })[0],
    ).toMatchObject({ actorUserId: intent.actorUserId });
  });

  it("does not reuse a merge audit from an older same-key task incarnation", async () => {
    const { store, intent } = prepared("merged");
    recordAudit(store.db, {
      action: "github.pr.merged",
      actor: {
        userId: store.users.arda.id,
        label: store.users.arda.email,
      },
      subjectKind: "pull_request",
      subjectId: "akin-ozer/viberr#42",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      details: {
        repo: "akin-ozer/viberr",
        prNumber: 42,
        headSha: HEAD,
        taskIncarnation: "2026-06-01T00:00:00.000Z",
      },
    });
    let githubCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      githubCalls += 1;
      throw new Error("no credential means recovery must not fetch");
    };

    await expect(
      recoverTaskAcceptanceIntents(store.db, store.dataRoot, { fetchImpl }),
    ).resolves.toEqual({
      completed: 0,
      pending: 0,
      cancelled: 0,
      retained: 1,
      errors: 0,
    });
    expect(githubCalls).toBe(0);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.frontmatter.stage,
    ).toBe("review");
    expect(
      listAuditEvents(store.db, { action: "task.transition" }),
    ).toHaveLength(0);
    expect(
      getTaskCompletionIntent(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        taskIncarnation: intent.taskIncarnation,
      }),
    ).toMatchObject({ id: intent.id, phase: "accepting_merge" });
  });

  it("retains archived-project acceptance and completion recovery without fetch, projection, audit, or task mutation", async () => {
    const { store, intent } = prepared("merged");
    await updateTaskFile(
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      },
      (task) => {
        task.frontmatter.stage = "done";
      },
    );
    const doneIntent = setTaskCompletionIntentPhase(
      store.db,
      intent,
      "done",
      true,
    );
    await updateProjectFile(
      { projectSlug: store.slug, dataRoot: store.dataRoot },
      (project) => {
        project.frontmatter.archived = true;
      },
    );
    const before = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.content;

    expect(
      convergeTaskCompletionIntent(store.db, doneIntent, {
        dataRoot: store.dataRoot,
      }),
    ).toBe(false);
    await expect(
      finalizeTaskAcceptanceIntent(store.db, doneIntent, {
        dataRoot: store.dataRoot,
      }),
    ).resolves.toBe(false);
    expect(recoverTaskCompletionIntents(store.db, store.dataRoot)).toEqual({
      completed: 0,
      cancelled: 0,
      retained: 1,
      errors: 0,
    });

    let githubCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      githubCalls += 1;
      throw new Error("archived recovery must not contact GitHub");
    };
    await expect(
      recoverTaskAcceptanceIntents(store.db, store.dataRoot, { fetchImpl }),
    ).resolves.toEqual({
      completed: 0,
      pending: 0,
      cancelled: 0,
      retained: 1,
      errors: 0,
    });
    expect(githubCalls).toBe(0);
    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.content,
    ).toBe(before);
    expect(
      (
        store.db
          .prepare(
            `SELECT stage FROM task_projections
              WHERE project_slug = ? AND task_key = 'VIB-1'`,
          )
          .get(store.slug) as { stage: string }
      ).stage,
    ).toBe("review");
    expect(
      listAuditEvents(store.db, { action: "task.transition" }),
    ).toHaveLength(0);
    expect(
      getTaskCompletionIntent(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        taskIncarnation: intent.taskIncarnation,
      }),
    ).toMatchObject({ id: intent.id, phase: "done", mergedPr: true });
  });
});
