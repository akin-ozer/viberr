import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { installFakeRuntime } from "../../../test-support/fake-runtime";
import { listAuditEvents } from "../../../test-support/audit-log";
import { callToolText } from "../../../test-support/mcp-tool-meta";
import { assertStrictSchema } from "../../../test-support/strict-schema";
import type { CapabilityGrant } from "~/schemas/project-file.schema";
import type { TaskFrontmatter } from "~/schemas/task-file.schema";
import { readEpicFile } from "~/server/files/epic-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listProjectTasks } from "~/server/projections/board-query.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import { insertRunLine, upsertRun } from "~/server/runtimes/run-store.server";
import {
  executeStrandedCodexPlan,
  operatorPlanSchemaFor,
  operatorPlanToolsFor,
  resetOperatorLeasesForTests,
  type runOperator,
} from "~/server/runtimes/operator-run.server";
import { createEpic, type CreateEpicInput } from "./epic-actions.server";
import {
  operatorOpenPacket,
  operatorSetEpic,
  operatorSnapshot,
  resolveOperatorAuthority,
} from "./operator-actions.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
import { resolvePacket } from "./task-actions.server";
import type { TaskActionContext } from "./task-action-core.server";

/**
 * Ruling 503(g): the operator and epics.
 *
 * Its snapshot carries `epic` (the epic its task is in, the description
 * clipped, and the epic's OTHER tasks with their stage and `blockedBy`) where
 * it carried `goalChain`, and `openEpics` for `set_epic`, which moves ITS OWN
 * task in or out under `append-typed-events` and signs every record of the
 * move as the operator. A Codex operator reaches the same verb through its
 * plan schema. And, from 503(b): a task a person creates from the operator's
 * `create_task` option joins the deciding task's epic.
 *
 * Fake adapters only. The epics are made through `createEpic` as the project
 * admin, the door a person uses, so the operator's own writes are the only
 * ones under test.
 */

let ctx: TestDbContext;
let store: TestStore;

/** set_epic's grant, and the packet grant the create_task case opens with. */
const EPIC_POLICY: readonly CapabilityGrant[] = [
  { capabilityId: "append-typed-events", mode: "direct" },
  { capabilityId: "generate-packets", mode: "direct" },
];

/** Every grant a plan verb rides, each direct. */
const FULL_POLICY: readonly CapabilityGrant[] = [
  ...EPIC_POLICY,
  { capabilityId: "dispatch-agents", mode: "direct" },
  { capabilityId: "stage-transitions", mode: "direct" },
  { capabilityId: "deliver-review-pr", mode: "direct" },
  { capabilityId: "update-task-branch", mode: "direct" },
  { capabilityId: "completion-for-acceptance", mode: "direct" },
];

/** Deploy the operator alone, with `policy`, on the backend given. */
function deployOperator(policy: readonly CapabilityGrant[], backend: "claude" | "codex" = "claude"): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot });
  if (!file) throw new Error("the test project has no project.md");
  writeProject(store.dataRoot, {
    ...file.parsed.frontmatter,
    repo: null,
    agents: [
      {
        profileId: "operator",
        capabilities: [...policy],
        extras: [],
        definition: {
          kind: "operator",
          name: "Operator",
          backends: [backend],
          model: defaultModelFor(backend),
          autonomy: "full",
        },
      },
    ],
  });
  rebuild();
}

function rebuild(): void {
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

function authority() {
  return resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, { autonomy: "full" });
}

/** Write one task Arda owns; call `rebuild` once the fixture is written. */
function writeSeedTask(key: string, patch: Partial<TaskFrontmatter> = {}): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, {
      ownerUserId: store.users.arda.id,
      operator: { assignedAtStageId: "triage" },
      ...patch,
    }),
    goal: `Deliver ${key}. Done when its change is merged.`,
  });
}

/** Make an epic as the project admin; returns its id. */
async function makeEpic(title: string, extra: Partial<CreateEpicInput> = {}): Promise<string> {
  const made = await createEpic(
    store.db,
    { projectSlug: store.slug, title, ...extra },
    actorOf(store.users.arda),
    { dataRoot: store.dataRoot },
  );
  return made.epic.id;
}

function snapshot(taskKey = "VIB-1") {
  return operatorSnapshot(store.db, { dataRoot: store.dataRoot }, store.slug, taskKey, authority());
}

function taskOf(taskKey: string) {
  const file = readTaskFile({ projectSlug: store.slug, taskKey, dataRoot: store.dataRoot });
  if (!file) throw new Error(`${taskKey} has no file`);
  return file.parsed;
}

/** An epic's history lines, newest first. */
function historyOf(epicId: string): string[] {
  const file = readEpicFile({ projectSlug: store.slug, epicId, dataRoot: store.dataRoot });
  return file?.parsed.timeline.map((e) => e.text) ?? [];
}

/** The operator's tools for VIB-1, under the policy deployed now. */
function operatorTools() {
  return buildOperatorToolkit({
    db: store.db,
    ctx: { dataRoot: store.dataRoot },
    projectSlug: store.slug,
    taskKey: "VIB-1",
    authority: authority(),
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  installFakeRuntime();
  resetOperatorLeasesForTests();
});

afterEach(() => {
  resetOperatorLeasesForTests();
  ctx.cleanup();
});

// ------------------------------------------------------------ the snapshot

describe("ruling 503(g): the operator's snapshot carries its task's epic", () => {
  it("names the epic, its status and description, and lists its OTHER live tasks with their stage and blockedBy", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl", title: "Build the checkout form" });
    writeSeedTask("VIB-2", { title: "Wire the payment call", blockedBy: ["VIB-1"] });
    writeSeedTask("VIB-3", { stage: "review", title: "Receipt copy" });
    rebuild();
    const epicId = await makeEpic("Checkout redesign", {
      description: "Move checkout onto the new flow.",
      status: "in_progress",
      taskKeys: ["VIB-1", "VIB-2", "VIB-3"],
    });
    // Abandoned work that still names the epic is not work the operator plans around.
    writeSeedTask("VIB-4", { title: "Abandoned spike", archived: true, epic: epicId });
    rebuild();
    // CANARY: drop the `t.key !== fm.key` filter, and the task is listed as its own sibling.
    expect(snapshot().epic).toStrictEqual({
      id: epicId,
      title: "Checkout redesign",
      status: "in_progress",
      description: "Move checkout onto the new flow.",
      // The stage by its NAME, as the rest of the snapshot names stages.
      tasks: [
        { key: "VIB-2", title: "Wire the payment call", stage: "Triage", blockedBy: ["VIB-1"] },
        { key: "VIB-3", title: "Receipt copy", stage: "Review", blockedBy: [] },
      ],
    });
  });

  it("clips the description at EPIC_DESCRIPTION_CAP (2,000 chars) and says the epic's page has it whole", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    writeSeedTask("VIB-2", { stage: "impl" });
    rebuild();
    const exact = "d".repeat(2000);
    await makeEpic("Long brief", { description: `${"a".repeat(1999)}bc`, taskKeys: ["VIB-1"] });
    await makeEpic("Exact brief", { description: exact, taskKeys: ["VIB-2"] });

    const cut = snapshot("VIB-1").epic;
    // CANARY: raise EPIC_DESCRIPTION_CAP.
    expect(cut?.description).toBe(`${"a".repeat(1999)}…`);
    expect(cut?.clipped).toBe("cut at 2,000 chars; the epic's page has it whole");
    // At the cap exactly, nothing is cut and nothing says so.
    const whole = snapshot("VIB-2").epic;
    expect(whole?.description).toBe(exact);
    expect(whole).not.toHaveProperty("clipped");
  });

  it("leaves `epic` off a task in no epic, and lists the open epics for set_epic in number order", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    expect(snapshot()).not.toHaveProperty("openEpics");
    const planned = await makeEpic("Planned work");
    const running = await makeEpic("Running work", { status: "in_progress" });
    await makeEpic("Shipped work", { status: "done" });
    const paused = await makeEpic("Paused work", { status: "paused" });
    await makeEpic("Dropped work", { status: "cancelled" });

    const snap = snapshot();
    expect(snap).not.toHaveProperty("epic");
    // CANARY: drop the `isEpicOpen` filter from `openEpics`.
    expect(snap.openEpics).toEqual([
      { id: planned, title: "Planned work" },
      { id: running, title: "Running work" },
      { id: paused, title: "Paused work" },
    ]);
  });

  it("carries no openEpics when every epic is closed, and still shows a closed epic the task is in", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    const shipped = await makeEpic("Shipped work", { status: "done", taskKeys: ["VIB-1"] });
    await makeEpic("Dropped work", { status: "cancelled" });

    const snap = snapshot();
    // CANARY: answer `openEpics: []` instead of leaving the key off.
    expect(snap).not.toHaveProperty("openEpics");
    expect(snap.epic?.id).toBe(shipped);
    expect(snap.epic?.status).toBe("done");
  });
});

// ------------------------------------------------------------ set_epic

describe("ruling 503(g): set_epic moves the operator's own task", () => {
  it("puts the task in, moves it and takes it out, each move signed by the operator on the task, the epics and the audit", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    const first = await makeEpic("Checkout redesign");
    const second = await makeEpic("Payments platform");
    const { tools } = operatorTools();

    // CANARY: call `setTasksEpic` from operatorSetEpic without `operatorAuthorized: true`.
    expect(await callToolText(tools, "set_epic", { epicId: first, reason: "It is checkout work." })).toBe(
      `[done] Recorded: VIB-1 is now in ${first} (Checkout redesign). Reason: It is checkout work.`,
    );
    expect(taskOf("VIB-1").frontmatter.epic).toBe(first);
    expect(taskOf("VIB-1").timeline[0]).toMatchObject({
      type: "note",
      title: "Epic",
      actor: { kind: "operator" },
      text: `Added to **${first}** (Checkout redesign).`,
    });
    expect(historyOf(first)[0]).toBe("The operator added VIB-1.");
    const audit = listAuditEvents(store.db, { action: "task.epic.changed" });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "operator",
      subjectId: "VIB-1",
      details: { from: null, to: first, title: "Checkout redesign" },
    });

    expect(await callToolText(tools, "set_epic", { epicId: second })).toBe(
      `[done] Recorded: VIB-1 is now in ${second} (Payments platform).`,
    );
    expect(taskOf("VIB-1").timeline[0]?.text).toBe(
      `Moved from **${first}** (Checkout redesign) to **${second}** (Payments platform).`,
    );
    expect(historyOf(first)[0]).toBe(`The operator moved VIB-1 to ${second}.`);
    expect(historyOf(second)[0]).toBe(`The operator moved VIB-1 here from ${first}.`);

    // "" is out, as the tool's argument says.
    expect(await callToolText(tools, "set_epic", { epicId: "" })).toBe(
      "[done] Recorded: VIB-1 is no longer in an epic.",
    );
    expect(taskOf("VIB-1").frontmatter.epic).toBeNull();
    expect(taskOf("VIB-1").timeline[0]?.text).toBe(`Removed from **${second}** (Payments platform).`);
    expect(historyOf(second)[0]).toBe("The operator removed VIB-1.");
    expect(listAuditEvents(store.db, { action: "task.epic.changed" })).toHaveLength(3);
  });

  it("an epic that does not exist, or the one the task is already in, is a noop that writes nothing", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    const epicId = await makeEpic("Checkout redesign", { taskKeys: ["VIB-1"] });
    const { tools } = operatorTools();
    const before = taskOf("VIB-1").timeline.length;

    // CANARY: let operatorSetEpic rethrow the store's not-found instead of answering noop.
    const unknown = await callToolText(tools, "set_epic", { epicId: "epic-99" });
    expect(unknown).toContain("[noop] epic-99 is not an epic in this project.");
    // The operator has no list_epics; its snapshot's list is what it can read.
    expect(unknown).toContain("your snapshot's `openEpics` names the open ones");
    expect(unknown).not.toContain("list_epics");
    expect(await callToolText(tools, "set_epic", { epicId })).toBe(
      `[noop] Unchanged: VIB-1 is already in ${epicId}.`,
    );
    expect(taskOf("VIB-1").frontmatter.epic).toBe(epicId);
    expect(taskOf("VIB-1").timeline).toHaveLength(before);
    expect(historyOf(epicId)).toHaveLength(2);
  });

  it("is built only where append-typed-events is granted, and refuses by name where it is withheld", async () => {
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    const epicId = await makeEpic("Checkout redesign");
    const withheld: readonly (readonly CapabilityGrant[])[] = [
      [{ capabilityId: "generate-packets", mode: "direct" }],
      [
        { capabilityId: "append-typed-events", mode: "off" },
        { capabilityId: "generate-packets", mode: "direct" },
      ],
    ];
    for (const policy of withheld) {
      deployOperator(policy);
      // CANARY: build `set_epic` outside the toolkit's `append-typed-events` block.
      expect(operatorTools().allowedTools).not.toContain("mcp__viberr__set_epic");
      expect(
        await operatorSetEpic(
          store.db,
          { dataRoot: store.dataRoot },
          { projectSlug: store.slug, taskKey: "VIB-1", epicId },
          authority(),
        ),
      ).toEqual({
        outcome: "denied",
        message:
          "The operator cannot change which epic a task is in on this project (the append-typed-events grant is withheld).",
      });
      expect(taskOf("VIB-1").frontmatter.epic).toBeNull();
    }
    deployOperator(EPIC_POLICY);
    expect(operatorTools().allowedTools).toContain("mcp__viberr__set_epic");
  });
});

// ------------------------------------------------------------ the Codex plan

/** One plan step as a Codex operator writes it: every field present, null
 *  where it does not apply (strict structured output). */
function setEpicStep(epicId: string | null) {
  return {
    tool: "set_epic",
    profileId: null,
    delivers: null,
    toStageId: null,
    packetType: null,
    text: null,
    reason: null,
    packetOptions: null,
    epicId,
  };
}

/** A previous boot's finished Codex operator run whose plan never ran. */
function persistPlan(runId: string, plan: string): void {
  const at = new Date().toISOString();
  upsertRun(store.db, {
    id: runId,
    taskKey: "VIB-1",
    projectSlug: store.slug,
    threadId: `op-${runId}`,
    role: "Operator",
    kind: "operator",
    backend: "codex",
    agentProfileId: "operator",
    model: defaultModelFor("codex"),
    sdk: "Codex SDK",
    state: "finished",
    startedAt: at,
    finishedAt: at,
  });
  insertRunLine(store.db, {
    runId,
    seq: 0,
    occurredAt: at,
    raw: "{}",
    display: { t: "1", ev: "text", tag: "agent_message", text: plan },
  });
}

describe("ruling 503(g): a Codex operator reaches set_epic through its plan", () => {
  it("the plan schema offers set_epic and its epicId, and withholds it without append-typed-events", () => {
    deployOperator(FULL_POLICY, "codex");
    const tools = operatorPlanToolsFor(authority());
    expect(tools).toContain("set_epic");
    const schema = operatorPlanSchemaFor(authority());
    const item = schema.properties.actions.items;
    expect(item.properties.tool.enum).toContain("set_epic");
    expect(item.properties.epicId.type).toEqual(["string", "null"]);
    expect(item.properties.epicId.description).toContain('or "" to take it out of its epic');
    // OpenAI strict output: every key required, the field included.
    expect(item.required).toContain("epicId");
    expect(assertStrictSchema(schema)).toEqual([]);

    deployOperator(
      FULL_POLICY.map((g) => (g.capabilityId === "append-typed-events" ? { ...g, mode: "off" } : g)),
      "codex",
    );
    // CANARY: map `set_epic` in OPERATOR_PLAN_TOOL_CAPABILITIES to a grant other than append-typed-events.
    expect(operatorPlanToolsFor(authority())).not.toContain("set_epic");
  });

  it("a plan's set_epic step moves the task, and a step with no epic is narrated as omitted", async () => {
    deployOperator(EPIC_POLICY, "codex");
    // impl -> review is an approval boundary: no stranded-stage nudge follows the plan.
    writeSeedTask("VIB-1", { stage: "impl", readiness: "ready", waiting: "agent" });
    rebuild();
    const epicId = await makeEpic("Checkout redesign");
    persistPlan(
      "run_epic_plan",
      JSON.stringify({
        reasoning: "It belongs with the checkout work.",
        actions: [setEpicStep(epicId), setEpicStep(null)],
      }),
    );

    // CANARY: drop the `set_epic` case from executeCodexPlan's switch.
    expect(
      await executeStrandedCodexPlan(
        store.db,
        { dataRoot: store.dataRoot },
        { projectSlug: store.slug, taskKey: "VIB-1", runId: "run_epic_plan" },
      ),
    ).toBe(true);
    expect(taskOf("VIB-1").frontmatter.epic).toBe(epicId);
    expect(historyOf(epicId)[0]).toBe("The operator added VIB-1.");
    const narration = taskOf("VIB-1").timeline.find((e) => e.text.includes("plan step omitted"));
    expect(narration?.text).toContain("- `set_epic`: plan step omitted the epic");
  });
});

// ------------------------------------------------------------ create_task option

describe("ruling 503(b): a task a person creates from the operator's create_task option joins the deciding task's epic", () => {
  const FOLLOW_ON = "Publish the receipt webhook";

  /** The operator offers the follow-on, and Arda confirms it. */
  async function offerAndConfirm(taskKey: string): Promise<string> {
    const opened = await operatorOpenPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey,
        packetType: "input",
        title: "The receipt webhook has no owner",
        options: [
          {
            kind: "create_task",
            title: "Create the webhook task",
            recommended: true,
            newTask: { title: FOLLOW_ON, goal: "Publish the webhook. Done when a receipt reaches it." },
          },
          { kind: "custom", title: "Leave it for now" },
        ],
      },
      authority(),
    );
    expect(opened.outcome).toBe("done");
    const runOp = vi.fn<typeof runOperator>(async () => ({
      runId: null,
      queued: true,
      backend: "claude" as const,
      autonomy: "full" as const,
    }));
    const decideCtx: TaskActionContext = { dataRoot: store.dataRoot, deps: { runOperator: runOp } };
    const keys = () => listProjectTasks(store.db, store.slug, { dataRoot: store.dataRoot }).map((t) => t.key);
    const before = new Set(keys());
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey, optionIndex: 0 },
      actorOf(store.users.arda),
      decideCtx,
    );
    const made = keys().find((key) => !before.has(key));
    expect(made, "the decision made no task").toBeDefined();
    expect(taskOf(made ?? taskKey).frontmatter.title).toBe(FOLLOW_ON);
    return made ?? "";
  }

  it("the new task is made in the deciding task's epic, with the note and the audit saying so", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    rebuild();
    const epicId = await makeEpic("Checkout redesign", { taskKeys: ["VIB-1"] });

    const made = await offerAndConfirm("VIB-1");
    // CANARY: drop `createInput.epic = deciderEpic` from resolvePacket's create_task arm.
    expect(taskOf(made).frontmatter.epic).toBe(epicId);
    expect(taskOf(made).timeline.find((e) => e.title === "Epic")?.text).toBe(
      `Added to **${epicId}** (Checkout redesign).`,
    );
    // Made by the person who decided, not by the operator that offered it.
    const created = listAuditEvents(store.db, { action: "task.created" }).find((r) => r.subjectId === made);
    expect(created?.actorUserId).toBe(store.users.arda.id);
    expect(created?.details).toMatchObject({ epic: epicId });
  });

  it("a deciding task in no epic, or in one whose file is gone, makes the task in none and still makes it", async () => {
    deployOperator(EPIC_POLICY);
    writeSeedTask("VIB-1", { stage: "impl" });
    // Names an epic the project does not have (a hand edit, a stale copy).
    writeSeedTask("VIB-2", { stage: "impl", epic: "epic-7" });
    rebuild();

    expect(taskOf(await offerAndConfirm("VIB-1")).frontmatter.epic).toBeNull();
    // CANARY: drop the `readEpicFile` check, and the stale epic refuses the create.
    expect(taskOf(await offerAndConfirm("VIB-2")).frontmatter.epic).toBeNull();
  });
});
