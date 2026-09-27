import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LogLine } from "~/features/runtime/runtime-types";
import type { RunCallbacks, RuntimeAdapter } from "~/server/runtimes/adapter.server";
import { listAuditEvents } from "../../../test-support/audit-log";
import { setupAppTest, type AppTestContext } from "../../../test-support/test-app";

/**
 * Ruling 525 — deleting a controller conversation.
 *
 * WHO: its starter, always; an org admin, any; and, on a conversation about a
 * project, whoever holds `delete-controller-conversations` there (a project
 * admin by default). WHAT: the conversation, its messages, and what its turns
 * said and did (console lines, raw logs, the provider's transcript), while the
 * turns' run rows stay as the record of what was spent. A running turn is
 * stopped first and its queue goes with it.
 *
 * The demo seed's people: selin is a contributor on viberr-core and starts
 * every conversation here; elif is a project admin there (and a maintainer on
 * deploy-pipeline) but no org admin; murat is a maintainer on viberr-core;
 * deniz is a member of no project; arda is an org admin.
 */

let app: AppTestContext;
type Person = { id: string; email: string };
let selin: Person;
let elif: Person;
let murat: Person;
let deniz: Person;
let arda: Person;
const SLUG = "viberr-core";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  selin = { id: userIds.selin, email: "selin@viberr.dev" };
  elif = { id: userIds.elif, email: "elif@viberr.dev" };
  murat = { id: userIds.murat, email: "murat@viberr.dev" };
  deniz = { id: userIds.deniz, email: "deniz@viberr.dev" };
  arda = { id: userIds.arda, email: "arda@viberr.dev" };
  // Ruling 127: a turn runs on its asker's own Claude account.
  const { connectFakeBackend } = await import("../../../test-support/backend-credentials");
  await connectFakeBackend(app.db, selin.id, "claude");
});
afterAll(async () => {
  const { drainRunCompletions } = await import("../../../test-support/fake-runtime");
  await drainRunCompletions();
  app.cleanup();
});

type Scope = { projectSlug: string | null; taskKey?: string };
const INSTANCE: Scope = { projectSlug: null };
const BOARD: Scope = { projectSlug: SLUG };
const TASK: Scope = { projectSlug: SLUG, taskKey: "VIB-142" };

/** A conversation of `owner`'s in `scope`, with the question that titled it. */
async function conversationOf(owner: Person, scope: Scope, text = "What is holding up the release train?") {
  const { createConversation, appendMessage } = await import("./controller-conversations.server");
  const conversation = createConversation(app.db, {
    userId: owner.id,
    userLabel: owner.email,
    projectSlug: scope.projectSlug,
    taskKey: scope.taskKey ?? null,
  });
  appendMessage(app.db, { conversationId: conversation.id, author: "user", userId: owner.id, text });
  return conversation;
}

/** Delete it from the page of `pageSlug` (null: the instance page) as `actor`. */
async function deleteAs(actor: Person, conversationId: string, pageSlug: string | null) {
  const { deleteControllerConversation } = await import("./controller-deletion.server");
  return deleteControllerConversation(
    app.db,
    { conversationId, projectSlug: pageSlug, dataRoot: app.dataRoot },
    { userId: actor.id, label: actor.email },
  );
}

async function stillThere(conversationId: string): Promise<boolean> {
  const { getConversation } = await import("./controller-conversations.server");
  return getConversation(app.db, conversationId) !== null;
}

/** The newest `controller.conversation.deleted` row about `conversationId`. */
function deletionRow(conversationId: string) {
  return listAuditEvents(app.db, { action: "controller.conversation.deleted" }).find(
    (row) => row.subjectId === conversationId,
  );
}

function count(sql: string, ...args: string[]): number {
  // SAFETY: every caller passes a `SELECT COUNT(*) AS n`, which answers exactly
  // one row whose `n` is an INTEGER.
  return (app.db.prepare(sql).get(...args) as { n: number }).n;
}

function logLines(runId: string): number {
  return count(`SELECT COUNT(*) AS n FROM run_log_lines WHERE run_id = ?`, runId);
}

/** Wait until the run is terminal and its completion settle has run. */
async function settled(runId: string): Promise<void> {
  const { getRun } = await import("~/server/runtimes/run-store.server");
  for (let i = 0; i < 400; i += 1) {
    const state = getRun(app.db, runId)?.state;
    if (state && state !== "running" && state !== "queued") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Selin's turn in `conversationId`, played by the fake runtime. */
async function turn(conversationId: string, text: string) {
  const { runControllerTurn } = await import("./controller-run.server");
  return runControllerTurn(app.db, {
    conversationId,
    text,
    user: { id: selin.id, email: selin.email, name: "Selin", orgRole: "member" },
    dataRoot: app.dataRoot,
  });
}

/** Where the provider keeps a session's transcript in selin's Claude home,
 *  written the way it writes one: the file, and the folder named for it. */
async function writeTranscript(sessionId: string): Promise<{ file: string; folder: string }> {
  const { userBackendHome } = await import("~/server/runtimes/user-homes.server");
  const dir = path.join(userBackendHome(selin.id, "claude", app.dataRoot), "projects", "-controller-scratch");
  const file = path.join(dir, `${sessionId}.jsonl`);
  const folder = path.join(dir, sessionId);
  mkdirSync(path.join(folder, "subagents"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ sessionId, cwd: "/scratch", message: "the question" })}\n`);
  writeFileSync(path.join(folder, "subagents", "agent-1.jsonl"), "{}\n");
  return { file, folder };
}

const answered = (sessionId: string, text: string) => ({
  sessionId,
  lines: [
    { t: "1", ev: "init", tag: "system·init", text: "session" },
    { t: "2", ev: "text", tag: "assistant", text },
    { t: "3", ev: "result", tag: "result", text: "done", stats: { dur: 100, api: 90, turns: 1, cost: 0.25, in: 1_000, cached: 0, out: 40 } },
  ] satisfies LogLine[],
});

describe("who may delete a controller conversation (ruling 525)", () => {
  it("its starter, whatever it is about", async () => {
    for (const scope of [INSTANCE, BOARD, TASK]) {
      const conversation = await conversationOf(selin, scope);
      await deleteAs(selin, conversation.id, scope.projectSlug);
      expect(await stillThere(conversation.id)).toBe(false);
      expect(deletionRow(conversation.id)?.details).toMatchObject({ deletedAs: "starter" });
    }
  });

  it("a project admin, another person's about the project; nobody below admin", async () => {
    // CANARY: give `delete-controller-conversations` to maintainers in
    // app/shared/rbac.ts and murat's delete goes through.
    for (const scope of [BOARD, TASK]) {
      const conversation = await conversationOf(selin, scope);
      for (const refused of [murat, deniz]) {
        await expect(deleteAs(refused, conversation.id, SLUG)).rejects.toMatchObject({ status: 403 });
        expect(await stillThere(conversation.id)).toBe(true);
      }
      await deleteAs(elif, conversation.id, SLUG);
      expect(await stillThere(conversation.id)).toBe(false);
      const row = deletionRow(conversation.id)!;
      expect(row.actorUserId).toBe(elif.id);
      expect(row.projectSlug).toBe(SLUG);
      expect(row.taskKey).toBe(scope.taskKey ?? null);
      expect(row.details).toMatchObject({ ownerUserId: selin.id, deletedAs: "project-role" });
    }
  });

  it("one about no project stays its starter's and the org admins'", async () => {
    const conversation = await conversationOf(selin, INSTANCE);
    // Elif administers a project, not this conversation: she is answered as
    // if it did not exist, as she is when she asks to read it (ruling 99(d)).
    await expect(deleteAs(elif, conversation.id, null)).rejects.toMatchObject({ status: 404 });
    expect(await stillThere(conversation.id)).toBe(true);
    await deleteAs(arda, conversation.id, null);
    expect(await stillThere(conversation.id)).toBe(false);
    const row = deletionRow(conversation.id)!;
    expect(row.projectSlug).toBeNull();
    expect(row.details).toMatchObject({ ownerUserId: selin.id, deletedAs: "org-admin" });
  });

  it("each page deletes only the conversations it lists", async () => {
    // Ruling 121: a page opens only its own scope's threads, so it deletes
    // only those. The starter herself gets the not-found shape elsewhere.
    const board = await conversationOf(selin, BOARD);
    const instance = await conversationOf(selin, INSTANCE);
    await expect(deleteAs(selin, board.id, null)).rejects.toMatchObject({ status: 404 });
    await expect(deleteAs(selin, board.id, "deploy-pipeline")).rejects.toMatchObject({ status: 404 });
    await expect(deleteAs(selin, instance.id, SLUG)).rejects.toMatchObject({ status: 404 });
    expect(await stillThere(board.id)).toBe(true);
    expect(await stillThere(instance.id)).toBe(true);
    await expect(deleteAs(selin, "cnv_missing", null)).rejects.toMatchObject({ status: 404 });
  });

  it("offers Delete exactly where the server allows it", async () => {
    // The page draws the button from `mayDeleteConversation`, the server
    // re-decides through its guards. CANARY: let `mayDeleteConversation`
    // answer true for a maintainer and the pairs below disagree.
    const { mayDeleteConversation } = await import("./controller-deletion.server");
    const { listProjectMembers } = await import("~/server/projections/board-query.server");
    const { isOrgAdmin } = await import("~/server/auth/project-authority.server");
    const scopes: Scope[] = [INSTANCE, BOARD, TASK, { projectSlug: "deploy-pipeline" }];
    const disagreements: string[] = [];
    for (const owner of [selin, murat]) {
      for (const scope of scopes) {
        for (const viewer of [selin, elif, murat, deniz, arda]) {
          const conversation = await conversationOf(owner, scope);
          const projectRole = scope.projectSlug
            ? (listProjectMembers(app.db, scope.projectSlug).find((m) => m.userId === viewer.id)?.role ?? null)
            : null;
          const offered = mayDeleteConversation(conversation, {
            userId: viewer.id,
            orgAdmin: isOrgAdmin(app.db, viewer.id),
            projectRole,
          });
          const allowed = await deleteAs(viewer, conversation.id, scope.projectSlug).then(
            () => true,
            () => false,
          );
          if (offered !== allowed) {
            disagreements.push(
              `${viewer.email} on ${owner.email}'s ${scope.taskKey ?? scope.projectSlug ?? "instance"} conversation: offered ${offered}, allowed ${allowed}`,
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});

describe("what a deletion takes away (ruling 525)", () => {
  it("its messages and what its turns said, keeping each turn's run row as the spend", async () => {
    // CANARY: drop the `run_log_lines` delete from
    // `purgeDeletedConversationLogs` and the console lines survive.
    const { queueFakeRun } = await import("../../../test-support/fake-runtime");
    const { getRun, rawLogPath } = await import("~/server/runtimes/run-store.server");
    const { canReadControllerRunLog, listMessages } = await import("./controller-conversations.server");
    const { purgeDeletedConversationLogs } = await import("./controller-purge.server");

    const title = "Which invoices failed to sync last night?";
    const conversation = await conversationOf(selin, INSTANCE, title);
    queueFakeRun(answered("sess-delete-what", "Three invoices failed on a timeout."));
    const first = await turn(conversation.id, "And why?");
    if (first.state !== "started") throw new Error(`turn ${first.state}`);
    await settled(first.runId);
    // Another thread of hers, whose record must not be touched.
    const kept = await conversationOf(selin, INSTANCE, "What shipped this week?");
    queueFakeRun(answered("sess-delete-kept", "Two releases shipped."));
    const other = await turn(kept.id, "Anything else?");
    if (other.state !== "started") throw new Error(`turn ${other.state}`);
    await settled(other.runId);

    const transcript = await writeTranscript("sess-delete-what");
    const before = getRun(app.db, first.runId)!;
    expect(before.total_cost_usd).toBeGreaterThan(0);
    expect(logLines(first.runId)).toBeGreaterThan(0);
    expect(existsSync(rawLogPath("claude", first.runId, app.dataRoot))).toBe(true);
    // The purge refuses a conversation that is still there.
    expect(purgeDeletedConversationLogs(app.db, conversation.id, app.dataRoot)).toBe(0);
    expect(logLines(first.runId)).toBeGreaterThan(0);

    const result = await deleteAs(selin, conversation.id, null);
    expect(result.stopped).toBe(0);

    expect(await stillThere(conversation.id)).toBe(false);
    expect(listMessages(app.db, conversation.id)).toEqual([]);
    expect(logLines(first.runId)).toBe(0);
    expect(existsSync(rawLogPath("claude", first.runId, app.dataRoot))).toBe(false);
    expect(existsSync(transcript.file)).toBe(false);
    expect(existsSync(transcript.folder)).toBe(false);
    // The row stays, with what it spent, and nobody can open it any more.
    const after = getRun(app.db, first.runId)!;
    expect(after.total_cost_usd).toBe(before.total_cost_usd);
    expect(after.output_tokens).toBe(before.output_tokens);
    expect([after.phase, after.step]).toEqual([null, null]);
    expect(canReadControllerRunLog(app.db, after, { id: selin.id })).toBe(false);
    expect(canReadControllerRunLog(app.db, after, { id: arda.id })).toBe(false);

    // The other thread keeps everything.
    expect(await stillThere(kept.id)).toBe(true);
    expect(logLines(other.runId)).toBeGreaterThan(0);
    expect(existsSync(rawLogPath("claude", other.runId, app.dataRoot))).toBe(true);

    // The audit row says whose it was and how much of it went, never a word
    // of it.
    const row = deletionRow(conversation.id)!;
    expect(row.actorUserId).toBe(selin.id);
    expect(row.subjectKind).toBe("conversation");
    expect(row.details).toEqual({
      ownerUserId: selin.id,
      ownerLabel: selin.email,
      deletedAs: "starter",
      messages: 3,
      turns: 1,
      stoppedTurns: 0,
    });
    expect(JSON.stringify(row)).not.toContain("invoices");
  });
});

describe("a turn still working when its conversation is deleted (ruling 525)", () => {
  it("is stopped as the deleter, answers nobody, and starts nothing queued behind it", async () => {
    // CANARY: drop the interrupt loop from `deleteControllerConversation` and
    // the turn is still running when the deletion has returned.
    const { queueFakeRun, startedRunSpecs } = await import("../../../test-support/fake-runtime");
    const { getRun } = await import("~/server/runtimes/run-store.server");
    const { liveTurnConversationIds } = await import("./controller-run.server");

    const conversation = await conversationOf(selin, BOARD);
    queueFakeRun({
      sessionId: "sess-delete-live",
      lines: [{ t: "1", ev: "text", tag: "assistant", text: "Reading the board." }],
      keepRunning: true,
    });
    const working = await turn(conversation.id, "Go through every blocked task.");
    if (working.state !== "started") throw new Error(`turn ${working.state}`);
    const queued = await turn(conversation.id, "And then the stale ones.");
    expect(queued.state).toBe("queued");
    const transcript = await writeTranscript("sess-delete-live");
    const spawned = startedRunSpecs().length;

    const result = await deleteAs(elif, conversation.id, SLUG);
    expect(result.stopped).toBe(1);
    await settled(working.runId);

    const run = getRun(app.db, working.runId)!;
    expect(run.state).toBe("interrupted");
    expect(run.interrupted_by).toBe(elif.id);
    const interrupted = listAuditEvents(app.db, { action: "runtime.run.interrupted" }).find(
      (row) => row.subjectId === working.runId,
    )!;
    expect(interrupted.details).toMatchObject({ reason: "conversation-deleted", deletedBy: elif.id });
    // No "this turn was stopped" note, no second turn, no lease left behind.
    expect(count(`SELECT COUNT(*) AS n FROM controller_messages WHERE conversation_id = ?`, conversation.id)).toBe(0);
    expect(startedRunSpecs().length).toBe(spawned);
    expect(count(`SELECT COUNT(*) AS n FROM agent_runs WHERE task_key = ?`, conversation.id)).toBe(1);
    expect(liveTurnConversationIds()).not.toContain(conversation.id);
    expect(logLines(working.runId)).toBe(0);
    expect(existsSync(transcript.file)).toBe(false);
    expect(deletionRow(conversation.id)?.details).toMatchObject({
      deletedAs: "project-role",
      // The question that titled it, the one the turn answered, the queued one.
      messages: 3,
      turns: 1,
      stoppedTurns: 1,
    });
  });

  it("purges the lines a stopped turn writes on its way out when it settles", async () => {
    // A real process answers an interrupt by writing its last lines and then
    // exiting, after the deletion has returned. This adapter does exactly
    // that, on the test's word.
    // CANARY: drop the purge from `settleTurn`'s deleted branch and the last
    // line stays.
    const { installFakeRuntime, installRunAdapters } = await import("../../../test-support/fake-runtime");
    const { rawLogPath } = await import("~/server/runtimes/run-store.server");
    const { liveTurnConversationIds } = await import("./controller-run.server");
    const started: RunCallbacks[] = [];
    const interrupted: string[] = [];
    const slow: RuntimeAdapter = {
      backend: "claude",
      start(spec, cb) {
        started.push(cb);
        return {
          runId: spec.runId,
          interrupt() {
            interrupted.push(spec.runId);
          },
        };
      },
    };
    installRunAdapters({ claude: slow, codex: slow });
    try {
      const conversation = await conversationOf(selin, INSTANCE);
      const working = await turn(conversation.id, "Summarize the week.");
      if (working.state !== "started") throw new Error(`turn ${working.state}`);
      const callbacks = started[0]!;
      const emit = (text: string) => {
        const occurredAt = new Date().toISOString();
        callbacks.onLine({
          raw: JSON.stringify({ type: "test", text }),
          display: { t: occurredAt.slice(11, 19), ev: "text", tag: "assistant", text },
          facts: { sessionId: "sess-delete-slow" },
          occurredAt,
        });
      };
      emit("Reading the week's tasks.");

      await deleteAs(selin, conversation.id, null);
      expect(interrupted).toEqual([working.runId]);
      expect(logLines(working.runId)).toBe(0);
      // It stops counting as working at once, not when its process exits.
      // CANARY: drop `dropConversationLease` from the deletion.
      expect(liveTurnConversationIds()).not.toContain(conversation.id);

      emit("Stopping here.");
      expect(logLines(working.runId)).toBe(1);
      callbacks.onExit({ outcome: "interrupted", effectiveBackend: "claude", sessionId: "sess-delete-slow" });
      await settled(working.runId);
      expect(logLines(working.runId)).toBe(0);
      expect(existsSync(rawLogPath("claude", working.runId, app.dataRoot))).toBe(false);
    } finally {
      installFakeRuntime();
    }
  });
});

describe("boot finishes a purge a restart cut short (ruling 525)", () => {
  it("clears what a deleted conversation's turn wrote after the deletion, and nothing of a live one", async () => {
    // A turn stopped by a deletion writes its last lines as it exits; a
    // restart before its settle leaves them. CANARY: return early from
    // `purgeOrphanedConversationLogs` and they stay.
    const { upsertRun, appendRunLine } = await import("~/server/runtimes/run-store.server");
    const { purgeOrphanedConversationLogs } = await import("./controller-purge.server");
    const run = (id: string, conversationId: string) => ({
      id,
      projectSlug: "",
      taskKey: conversationId,
      threadId: `controller-${id}`,
      role: "Controller",
      kind: "controller" as const,
      backend: "claude" as const,
      model: "claude-sonnet",
      sdk: "Claude Agent SDK",
      agentProfileId: "controller",
      state: "interrupted" as const,
    });
    const line = (runId: string, text: string) =>
      appendRunLine(app.db, {
        runId,
        occurredAt: new Date().toISOString(),
        raw: JSON.stringify({ text }),
        display: { t: "12:00:00", ev: "text", tag: "assistant", text },
      });

    const deleted = await conversationOf(selin, INSTANCE);
    const live = await conversationOf(selin, INSTANCE);
    upsertRun(app.db, run("run_boot_deleted", deleted.id));
    upsertRun(app.db, run("run_boot_live", live.id));
    await deleteAs(selin, deleted.id, null);
    line("run_boot_deleted", "The last words, after the deletion.");
    line("run_boot_live", "A reply someone can still read.");

    expect(purgeOrphanedConversationLogs(app.db, app.dataRoot)).toBe(1);
    expect(logLines("run_boot_deleted")).toBe(0);
    expect(logLines("run_boot_live")).toBe(1);
    // Nothing is left for the next boot.
    expect(purgeOrphanedConversationLogs(app.db, app.dataRoot)).toBe(0);
  });
});
