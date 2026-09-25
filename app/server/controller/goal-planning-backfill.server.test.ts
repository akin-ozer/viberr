import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { encodeControllerInstrument } from "~/shared/mapping/actor.server";
import { createConversation, appendMessage } from "./controller-conversations.server";
import { backfillGoalConversations } from "./goal-planning-backfill.server";
import { upsertRun } from "~/server/runtimes/run-store.server";
import { createGoalFile, readGoalFile } from "~/server/files/goal-writer.server";
import { goalFilePath } from "~/server/files/file-store-root.server";
import { rebuildGoalFile } from "~/server/projections/rebuilder.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore, type TestStoreUser } from "../../../test-support/test-store";

/**
 * Ruling 476(j) (live verification 2026-09-25, F40-61): goal-1 on the owner's
 * instance was created by the controller before goals recorded their
 * conversation, so its project's Controller page had no "Planned in" link. Boot
 * recovers it from the `goal.created` audit row and the controller turn whose
 * window covers it (live: 20:47:16Z inside run_j6tgNgM5keud, 20:42:11 to
 * 20:48:36, whose reply is in cnv_Edgq8wV-6U_N), when exactly one of the
 * creator's conversations matches.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const CREATED = "2026-09-24T20:47:16.412Z";

async function controllerGoal(
  store: TestStore,
  goalId: string,
  creator: TestStoreUser,
  patch: { conversationId?: string | null; createdByLabel?: string } = {},
): Promise<void> {
  await createGoalFile(
    { projectSlug: store.slug, goalId, dataRoot: store.dataRoot },
    {
      frontmatter: {
        id: goalId,
        title: `Chain ${goalId}`,
        status: "active",
        createdBy: creator.id,
        createdByLabel: patch.createdByLabel ?? encodeControllerInstrument(creator.email),
        conversationId: patch.conversationId ?? null,
        onFailure: "pause",
        links: [
          {
            index: 1,
            title: "Only link",
            goal: "Do the one thing. Done when it exists.",
            taskKey: null,
            status: "pending",
            note: null,
            redeclared: false,
            blockedBy: [],
          },
        ],
        createdAt: CREATED,
        updatedAt: CREATED,
      },
      description: "",
    },
  );
  rebuildGoalFile(store.db, store.slug, goalId, { dataRoot: store.dataRoot });
}

function goalCreatedAudit(db: DatabaseSync, slug: string, goalId: string, creator: TestStoreUser, at = CREATED) {
  db.prepare(
    `INSERT INTO audit_events
       (id, occurred_at, actor_user_id, actor_label, action, subject_kind, subject_id, project_slug, task_key, details_json)
     VALUES (?, ?, ?, ?, 'goal.created', 'goal', ?, ?, NULL, '{}')`,
  ).run(`aud_${goalId}_${at}`, at, creator.id, encodeControllerInstrument(creator.email), goalId, slug);
}

/** A controller turn in a new conversation of `owner`: its run, and the reply it wrote. */
function controllerTurn(
  db: DatabaseSync,
  owner: TestStoreUser,
  runId: string,
  window: { startedAt: string; finishedAt: string | null },
): string {
  const conversation = createConversation(db, { userId: owner.id, userLabel: owner.email, projectSlug: null });
  upsertRun(db, {
    id: runId,
    projectSlug: "",
    taskKey: conversation.id,
    threadId: conversation.id,
    role: "Controller",
    kind: "controller",
    backend: "claude",
    model: "sonnet",
    sdk: "",
    agentProfileId: "controller",
    state: window.finishedAt === null ? "running" : "finished",
    startedAt: window.startedAt,
    finishedAt: window.finishedAt,
  });
  appendMessage(db, { conversationId: conversation.id, author: "user", userId: owner.id, text: "Plan the site." });
  appendMessage(db, { conversationId: conversation.id, author: "controller", text: "Goal created.", runId });
  return conversation.id;
}

function raw(store: TestStore, goalId: string): string {
  return readFileSync(goalFilePath(store.slug, goalId, store.dataRoot), "utf8");
}

function projectedHash(store: TestStore, goalId: string): string {
  return z
    .object({ content_hash: z.string() })
    .parse(
      store.db
        .prepare(`SELECT content_hash FROM goal_projections WHERE project_slug = ? AND goal_id = ?`)
        .get(store.slug, goalId),
    ).content_hash;
}

describe("ruling 476(j): boot backfills the conversation an older chain was planned in", () => {
  it("records the one conversation whose controller turn covers the chain's creation, and a second pass changes nothing", async () => {
    const store = setupTestStore(ctx);
    const { arda, murat } = store.users;
    await controllerGoal(store, "goal-1", arda);
    goalCreatedAudit(store.db, store.slug, "goal-1", arda);
    const planning = controllerTurn(store.db, arda, "run_plan", {
      startedAt: "2026-09-24T20:42:11.000Z",
      finishedAt: "2026-09-24T20:48:36.000Z",
    });
    // Not these: the creator's turn that ended before the chain existed, and
    // another person's turn running at the same moment.
    controllerTurn(store.db, arda, "run_earlier", {
      startedAt: "2026-09-24T20:30:00.000Z",
      finishedAt: "2026-09-24T20:40:00.000Z",
    });
    controllerTurn(store.db, murat, "run_someone_else", {
      startedAt: "2026-09-24T20:45:00.000Z",
      finishedAt: null,
    });

    // CANARY: drop the `updateGoalFile` call and the chain stays null; drop the
    // creator filter or the end of the run's window and the two turns above
    // make it ambiguous.
    const first = await backfillGoalConversations(store.db, { dataRoot: store.dataRoot });
    expect(first.recorded).toEqual([{ projectSlug: store.slug, goalId: "goal-1", conversationId: planning }]);
    expect(first.unresolved).toEqual([]);
    expect(readGoalFile({ projectSlug: store.slug, goalId: "goal-1", dataRoot: store.dataRoot })?.parsed.frontmatter.conversationId).toBe(planning);
    // The projection follows the file it was re-read from.
    const after = raw(store, "goal-1");
    expect(projectedHash(store, "goal-1")).toBe(createHash("sha256").update(after).digest("hex"));

    const second = await backfillGoalConversations(store.db, { dataRoot: store.dataRoot });
    expect(second).toEqual({ recorded: [], unresolved: [] });
    expect(raw(store, "goal-1")).toBe(after);
  });

  it("leaves the chain null when two of the creator's conversations had a turn running at its creation", async () => {
    const store = setupTestStore(ctx);
    const { arda } = store.users;
    await controllerGoal(store, "goal-1", arda);
    goalCreatedAudit(store.db, store.slug, "goal-1", arda);
    controllerTurn(store.db, arda, "run_a", {
      startedAt: "2026-09-24T20:42:11.000Z",
      finishedAt: "2026-09-24T20:48:36.000Z",
    });
    controllerTurn(store.db, arda, "run_b", {
      startedAt: "2026-09-24T20:46:00.000Z",
      finishedAt: null,
    });
    const before = raw(store, "goal-1");

    // CANARY: write the first match instead of requiring exactly one, and
    // the chain names a conversation that may not be the one that planned it.
    const result = await backfillGoalConversations(store.db, { dataRoot: store.dataRoot });
    expect(result.recorded).toEqual([]);
    expect(result.unresolved).toEqual([{ projectSlug: store.slug, goalId: "goal-1", candidates: 2 }]);
    expect(raw(store, "goal-1")).toBe(before);
  });

  it("never touches a chain that already names its conversation, or one a person made without the controller", async () => {
    const store = setupTestStore(ctx);
    const { arda } = store.users;
    await controllerGoal(store, "goal-1", arda, { conversationId: "cnv_recorded" });
    await controllerGoal(store, "goal-2", arda, { createdByLabel: arda.email });
    for (const goalId of ["goal-1", "goal-2"]) goalCreatedAudit(store.db, store.slug, goalId, arda);
    controllerTurn(store.db, arda, "run_plan", {
      startedAt: "2026-09-24T20:42:11.000Z",
      finishedAt: "2026-09-24T20:48:36.000Z",
    });
    const before = [raw(store, "goal-1"), raw(store, "goal-2")];

    // CANARY: drop the `conversationId !== null` skip, or the controller-label
    // check, and one of these files is rewritten.
    const result = await backfillGoalConversations(store.db, { dataRoot: store.dataRoot });
    expect(result).toEqual({ recorded: [], unresolved: [] });
    expect([raw(store, "goal-1"), raw(store, "goal-2")]).toEqual(before);
  });
});
