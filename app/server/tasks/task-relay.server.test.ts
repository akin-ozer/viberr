import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  drainRunCompletions,
  installFakeRuntime,
  queueFakeRun,
  startedRunSpecs,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import {
  resetOperatorLeasesForTests,
  type RunOperatorInput,
} from "~/server/runtimes/operator-run.server";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { stageOutcome } from "./agent-outcome.server";
import { operatorSnapshot, resolveOperatorAuthority } from "./operator-actions.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
import { applyAgentCompletionEffects, type TaskActionContext } from "./task-actions.server";

/**
 * Ruling 488 (F40-67): work on one task reaches another task in the same
 * project, on the record. Live on WEB-9 a goal told the task to post its
 * deployed CPU numbers on WEB-8; nothing that works a task could write on
 * another one, so the Platform Engineer wrote two attachments "for WEB-8" and
 * a person pasted 5,117 characters over by hand.
 *
 * The operator's `relay_to_task` is driven through the real toolkit, and a
 * specialist's `relay` entries through the real completion pipeline.
 */

let ctx: TestDbContext;
let store: TestStore;

const dctx = () => ({ dataRoot: store.dataRoot });
const timeline = (key: string, slug = store.slug): TaskFileEvent[] =>
  readTaskFile({ projectSlug: slug, taskKey: key, dataRoot: store.dataRoot })!.parsed.timeline;
const replyText = z
  .object({ content: z.array(z.object({ text: z.string() })).min(1) })
  .transform((r) => r.content[0]!.text);

/** A `runOperator` stand-in that records what woke whom. */
const runOperatorStub = () =>
  vi.fn((_db: DatabaseSync, _input: RunOperatorInput) =>
    Promise.resolve({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const }),
  );

type Deployment = ProjectFrontmatter["agents"][number];

const OPERATOR: Deployment = {
  profileId: "operator",
  capabilities: [
    { capabilityId: "generate-packets", mode: "direct" },
    { capabilityId: "append-typed-events", mode: "direct" },
  ],
  extras: [],
  definition: {
    kind: "operator",
    backends: ["claude"],
    model: "sonnet",
    autonomy: "supervised",
  },
};

/** The WEB-9 shape: a Platform Engineer that comments and cites evidence,
 *  with no verdict of its own. */
const PLATFORM_ENGINEER: Deployment = {
  profileId: "platform-engineer",
  capabilities: [
    { capabilityId: "comment-on-task", mode: "direct" },
    { capabilityId: "attach-evidence-references", mode: "direct" },
    { capabilityId: "report-validation-verdict", mode: "off" },
  ],
  extras: [],
  definition: {
    kind: "specialist",
    name: "Platform Engineer",
    role: "Platform Engineer",
    backends: ["claude"],
    model: "sonnet",
  },
};

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    repo: null,
    agents: [OPERATOR, PLATFORM_ENGINEER],
  });
  // Another project, whose task a relay must never reach.
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    name: "Shop",
    slug: "shop",
    taskPrefix: "SHOP",
    repo: null,
    agents: [OPERATOR],
  });
  const open = { stage: "impl", readiness: "ready" as const, ownerUserId: store.users.arda.id };
  for (const key of ["VIB-1", "VIB-2", "VIB-5", "VIB-6"]) {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, open) });
  }
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", { ...open, stage: "done" }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { ...open, archived: true }),
  });
  writeTask(store.dataRoot, "shop", { frontmatter: baseTaskFrontmatter("SHOP-1", open) });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(async () => {
  await drainRunCompletions();
  resetOperatorLeasesForTests();
  ctx.cleanup();
});

/** Call the operator's `relay_to_task` on `from`, as the real toolkit builds it. */
async function relay(
  toTaskKey: string,
  text: string,
  over: { from?: string; runOperator?: ReturnType<typeof runOperatorStub> } = {},
): Promise<string> {
  const toolCtx = over.runOperator
    ? { dataRoot: store.dataRoot, deps: { runOperator: over.runOperator } }
    : dctx();
  const toolkit = buildOperatorToolkit({
    db: store.db,
    ctx: toolCtx,
    projectSlug: store.slug,
    taskKey: over.from ?? "VIB-1",
    authority: resolveOperatorAuthority(dctx(), store.slug),
  });
  const def = toolkit.tools.find((t) => t.name === "relay_to_task");
  if (!def) throw new Error("relay_to_task is not built for this operator");
  return replyText.parse(await def.handler({ taskKey: toTaskKey, text }, {}));
}

async function eventually(assertion: () => void, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

const NUMBERS =
  "Deployed cron CPU: 5 ms and 6 ms of the 10 ms limit, 3/50 subrequests.\n\n" +
  "| run | cpu |\n|---|---|\n| 11:17Z | 5 ms |\n| 12:17Z | 6 ms |";

describe("ruling 488: the operator's relay_to_task", () => {
  it("posts on the target as the operator's comment with the source named, audits the relay, and writes one line on the source", async () => {
    // Canaries: drop the `task.relayed` audit row; drop the source task's
    // line; write the target's comment without the "From <task>" header.
    const reply = await relay("VIB-2", NUMBERS, { runOperator: runOperatorStub() });
    expect(reply).toMatch(/^\[done\] Relayed to VIB-2: it is on VIB-2's timeline as your comment/);

    const posted = timeline("VIB-2")[0]!;
    expect(posted).toMatchObject({ type: "comment", actor: { kind: "operator" }, toAgent: true });
    expect(posted.text).toBe(`**From VIB-1 (operator):**\n\n${NUMBERS}`);

    const rows = listAuditEvents(store.db, { action: "task.relayed" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "operator",
      projectSlug: store.slug,
      taskKey: "VIB-2",
    });
    expect(rows[0]!.details).toEqual({ from: "VIB-1", to: "VIB-2" });

    const line = timeline("VIB-1")[0]!;
    expect(line).toMatchObject({ type: "note", actor: { kind: "operator" } });
    expect(line.text).toBe(
      "Relayed to VIB-2: Deployed cron CPU: 5 ms and 6 ms of the 10 ms limit, 3/50 subrequests.…",
    );
  });

  it("wakes the target's operator with the relay trigger, the source and the text", async () => {
    // Canary: drop the wake (`autoInvokeOperator(..., "relayed", { relay })`).
    const runOperator = runOperatorStub();
    await relay("VIB-2", NUMBERS, { runOperator });
    await eventually(() => {
      expect(runOperator).toHaveBeenCalledTimes(1);
    });
    const input = runOperator.mock.calls[0]![1];
    expect(input).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-2",
      trigger: "relayed",
      relay: {
        fromTaskKey: "VIB-1",
        by: "operator",
        text: NUMBERS,
        occurredAt: timeline("VIB-2")[0]!.occurredAt,
      },
    });
  });

  it("the woken operator's turn quotes what arrived and says nobody carries it by hand", async () => {
    // Canary: return the relay branch's instruction empty (`relayInstruction`),
    // or drop the `relay` payload at either prompt builder's call site.
    await relay("VIB-2", NUMBERS);
    await eventually(() => {
      expect(startedRunSpecs().some((s) => s.kind === "operator" && s.taskKey === "VIB-2")).toBe(true);
    });
    const prompt = startedRunSpecs().find((s) => s.kind === "operator" && s.taskKey === "VIB-2")!.prompt;
    expect(prompt).toContain('VIB-1 relayed this to you (ruling 488): the operator there posted it on this task\'s timeline as a comment headed "From VIB-1 (operator)"');
    expect(prompt).toContain(NUMBERS);
    expect(prompt).toContain("never ask a person to copy it here or to confirm it arrived");
  });

  it("refuses another project, the source itself, a missing task and a closed one, and writes nothing", async () => {
    // Canaries: drop the other-project lookup (the refusal stops naming the
    // project); drop the self check; drop the closure check (Done and archived
    // are posted on).
    const runOperator = runOperatorStub();
    const before = (key: string, slug?: string) => timeline(key, slug).length;
    const counts = {
      shop: before("SHOP-1", "shop"),
      self: before("VIB-1"),
      done: before("VIB-3"),
      archived: before("VIB-4"),
    };

    expect(await relay("SHOP-1", NUMBERS, { runOperator })).toBe(
      "[denied] SHOP-1 is a task in project shop, not in viberr-core. A relay reaches only tasks in the same project.",
    );
    expect(await relay("VIB-1", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-1 is the task you are on. A relay reaches ANOTHER task in this project; write on this one as usual.",
    );
    expect(await relay("VIB-99", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-99 is not a task in this project, so nothing was relayed. `read_board` lists the project's tasks.",
    );
    expect(await relay("VIB-3", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-3 is closed (Done is the terminal stage) — move it back to an open stage before relaying to it. " +
        "Nothing was relayed: a closed task's operator starts no run, so the text would reach nobody.",
    );
    expect(await relay("VIB-4", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-4 is archived — restore it before relaying to it. " +
        "Nothing was relayed: a closed task's operator starts no run, so the text would reach nobody.",
    );

    expect(timeline("SHOP-1", "shop")).toHaveLength(counts.shop);
    expect(timeline("VIB-1")).toHaveLength(counts.self);
    expect(timeline("VIB-3")).toHaveLength(counts.done);
    expect(timeline("VIB-4")).toHaveLength(counts.archived);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toEqual([]);
    expect(runOperator).not.toHaveBeenCalled();
  });

  it("is withheld with the comment grant", () => {
    // Canary: build the tool outside the `append-typed-events` block.
    const authority = resolveOperatorAuthority(dctx(), store.slug);
    authority.policy.set("append-typed-events", "off");
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: dctx(),
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority,
    });
    expect(toolkit.allowedTools).not.toContain("mcp__viberr__relay_to_task");
  });
});

describe("ruling 488: a specialist's relay entries", () => {
  let runSeq = 0;
  /** A finished Platform Engineer run on VIB-1 whose outcome carries `relay`. */
  async function completeWithRelays(
    relayEntries: { taskKey: string; text: string }[],
    runOperator: ReturnType<typeof runOperatorStub>,
  ): Promise<void> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text: "Read both deployed cron runs." },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `relay-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "primary",
      role: "Platform Engineer",
      agentProfileId: "platform-engineer",
      credentialUserId: store.users.arda.id,
      backend: "claude",
      model: "sonnet",
      prompt: "read the cron runs",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actorOf(store.users.arda),
      threadId: `relay-th-${runSeq}`,
    });
    await eventually(() => {
      // SAFETY: the SELECT list is the single column `state`, TEXT NOT NULL on
      // `agent_runs` (0001_baseline); `undefined` when no row matches.
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      expect(row?.state).toBe("finished");
    });
    const outcomeKey = `oc-${started.runId}`;
    stageOutcome(store.db, outcomeKey, { summary: "Read both deployed cron runs.", relay: relayEntries });
    // The relay's wake reads the stand-in off the context it is handed.
    const completionCtx: TaskActionContext = { dataRoot: store.dataRoot, deps: { runOperator } };
    await applyAgentCompletionEffects(
      store.db,
      completionCtx,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "platform-engineer",
        role: "Platform Engineer",
        delivers: false,
        workdir: null,
        agentHandle: "platform-engineer",
        outcomeKey,
      },
      { id: started.runId, state: "finished" },
    );
  }

  const agentRef = {
    kind: "agent",
    backend: "claude",
    profileId: "platform-engineer",
    roleHint: "Platform Engineer",
  };

  it("posts each entry on its task after completion, as the agent, and the operator's snapshot shows it went out", async () => {
    // Canary: drop the completion pipeline's `postOutcomeRelays` call.
    const runOperator = runOperatorStub();
    await completeWithRelays([{ taskKey: "VIB-2", text: NUMBERS }], runOperator);

    const posted = timeline("VIB-2")[0]!;
    expect(posted).toMatchObject({ type: "comment", actor: agentRef, toAgent: true });
    expect(posted.text).toBe(`**From VIB-1 (Platform Engineer):**\n\n${NUMBERS}`);
    expect(listAuditEvents(store.db, { action: "task.relayed" })[0]).toMatchObject({
      actorLabel: "agent:claude/platform-engineer (Platform Engineer)",
      taskKey: "VIB-2",
      details: { from: "VIB-1", to: "VIB-2" },
    });

    // The source's line, AFTER the report, which is what the operator reads.
    const source = timeline("VIB-1");
    expect(source[0]).toMatchObject({ type: "note", actor: agentRef });
    expect(source[0]!.text).toMatch(/^Relayed to VIB-2: Deployed cron CPU/);
    const snapshot = operatorSnapshot(
      store.db,
      dctx(),
      store.slug,
      "VIB-1",
      resolveOperatorAuthority(dctx(), store.slug),
      6,
    );
    expect(snapshot.recentTimeline.some((row) => row.text.startsWith("Relayed to VIB-2: Deployed cron CPU"))).toBe(true);

    await eventually(() => {
      expect(runOperator.mock.calls.some((c) => c[1].taskKey === "VIB-2" && c[1].trigger === "relayed")).toBe(true);
    });
    const wake = runOperator.mock.calls.find((c) => c[1].taskKey === "VIB-2")![1];
    expect(wake.relay).toMatchObject({ fromTaskKey: "VIB-1", by: "Platform Engineer", text: NUMBERS });
  });

  it("posts at most two, and names the rest on the source task", async () => {
    // Canary: drop the cap in `postOutcomeRelays` (VIB-6 is posted on).
    await completeWithRelays(
      [
        { taskKey: "VIB-2", text: "First." },
        { taskKey: "VIB-5", text: "Second." },
        { taskKey: "VIB-6", text: "Third." },
      ],
      runOperatorStub(),
    );
    expect(timeline("VIB-2")[0]!.text).toBe("**From VIB-1 (Platform Engineer):**\n\nFirst.");
    expect(timeline("VIB-5")[0]!.text).toBe("**From VIB-1 (Platform Engineer):**\n\nSecond.");
    expect(timeline("VIB-6")).toEqual([]);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toHaveLength(2);
    const note = timeline("VIB-1").find((e) => e.title === "Not relayed")!;
    expect(note.text).toContain("- VIB-6: past the limit of 2 relays in one report.");
    expect(note.text).toContain("nobody is to copy it by hand");
  });

  it("reaches only tasks in the same project", async () => {
    // Canary: drop the other-project lookup (the note no longer names shop).
    const before = timeline("SHOP-1", "shop").length;
    await completeWithRelays([{ taskKey: "SHOP-1", text: NUMBERS }], runOperatorStub());
    expect(timeline("SHOP-1", "shop")).toHaveLength(before);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toEqual([]);
    const note = timeline("VIB-1").find((e) => e.title === "Not relayed")!;
    expect(note.text).toContain(
      "- SHOP-1: SHOP-1 is a task in project shop, not in viberr-core. A relay reaches only tasks in the same project.",
    );
  });
});
