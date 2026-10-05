import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { publishedSchemas, toolLoading } from "../../../test-support/mcp-tool-meta";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { writeTaskAttachment } from "~/server/files/task-attachments.server";
import { taskAttachmentsDir } from "~/server/files/file-store-root.server";
import { keepDelivery } from "~/server/files/kept-deliveries.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { saveMcpServer } from "~/server/org/resources.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
import { CREATE_TASK_BASE_NOTE } from "./operator-packets.server";
import type { OperatorAuthority } from "./operator-authority.server";
import { DONE_SIGNAL_RULE } from "./done-signal.server";
import {
  operatorPlanSchemaFor,
  operatorPlanToolsFor,
} from "~/server/runtimes/operator-codex-plan.server";

const ctxDb = createTestDbContext();
afterEach(() => ctxDb.cleanup());

const ACTOR = { userId: "u_t", label: "t@test" };

/** The instructions string as the MOUNTED server carries it: `createSdkMcpServer`
 *  hands back the live `McpServer` under `instance`, and `instance.server` is its
 *  `Server` handle, which keeps the instructions in `_instructions`. A run reads
 *  the server's instructions, not the module's constant. The field is `private`
 *  on the MCP SDK's `Server`, so it is read by parsing the shape we expect; if
 *  the SDK renames it, the read falls through to `""` and every positive
 *  assertion on it fails instead of passing on `undefined`. */
const wiredInstructions = z
  .object({ instance: z.object({ server: z.object({ _instructions: z.string() }) }) })
  .transform((mounted) => mounted.instance.server._instructions)
  .catch("");

function authority(mcps: string[]): OperatorAuthority {
  return {
    policy: new Map([
      ["assign-primary-specialist", "direct"],
      ["summon-reviewers", "direct"],
      ["generate-packets", "direct"],
      ["append-typed-events", "direct"],
      ["stage-transitions", "recommend"],
      ["completion-for-acceptance", "recommend"],
    ]),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps,
    persona: null,
    deployed: true,
    humanGatedBeforeWork: false,
  };
}

/**
 * P13-KM-03 — the operator's DECLARED org MCP servers now actually mount.
 * Live evidence for the bug: a project granted the operator `everything-mcp`
 * and the operator reported "MCP servers/tools I can call: none … No
 * `everything-mcp` tools are registered for me", while the grant UI showed it
 * attached. `OperatorAuthority` carried skills + kb only.
 */
describe("buildOperatorToolkit — org MCP grants", () => {
  const build = (db: ReturnType<typeof ctxDb.makeDb>, mcps: string[]) =>
    buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority(mcps),
    });

  it("mounts a granted org MCP server alongside the in-process viberr toolkit", async () => {
    const db = ctxDb.makeDb();
    await saveMcpServer(
      db,
      { name: "everything-mcp", transport: "stdio", target: "/bin/echo hi", cred: "" },
      ACTOR,
      { spawnImpl: () => { throw new Error("no spawn in test"); } },
    );

    const toolkit = build(db, ["everything-mcp"]);
    expect(Object.keys(toolkit.mcpServers).sort()).toEqual([
      "everything-mcp",
      "viberr",
    ]);
    // `allowedTools` CONFINES an operator run, so mounting without allowing
    // would leave the grant decorative in a different way.
    expect(toolkit.allowedTools).toContain("mcp__everything-mcp");
    expect(toolkit.allowedTools).toContain("mcp__viberr__get_task");
  });

  it("mounts nothing extra when the operator declares no MCP servers", () => {
    const db = ctxDb.makeDb();
    const toolkit = build(db, []);
    expect(Object.keys(toolkit.mcpServers)).toEqual(["viberr"]);
  });

  it("never lets a declared name shadow the reserved in-process viberr server", async () => {
    const db = ctxDb.makeDb();
    const toolkit = build(db, ["viberr"]);
    expect(Object.keys(toolkit.mcpServers)).toEqual(["viberr"]);
    // The reserved name resolves to the in-process governance server, not to a
    // row a user could add under the same name.
    expect(toolkit.allowedTools).toContain("mcp__viberr__get_task");
    expect(toolkit.allowedTools).not.toContain("mcp__viberr");
  });
});

describe("buildOperatorToolkit — deliver_for_review (R15-2)", () => {
  it("builds the tool with the grant ABSENT (absent = granted — pre-R15-2 deployments keep delivering)", () => {
    // Fails on main: the tool did not exist.
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    expect(toolkit.allowedTools).toContain("mcp__viberr__deliver_for_review");
  });

  it("withholds the tool when deliver-review-pr is explicitly off", () => {
    const db = ctxDb.makeDb();
    const auth = authority([]);
    auth.policy.set("deliver-review-pr", "off");
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });
    expect(toolkit.allowedTools).not.toContain("mcp__viberr__deliver_for_review");
  });
});

/**
 * F27-O3 — the Claude live toolkit (this file) and the Codex plan-tool schema
 * (`operatorPlanToolsFor`, operator-codex-plan.server) are two hand-maintained
 * lists with no shared generator. They MUST expose the same governed-action
 * vocabulary for the same authority, or an operator would silently be able to
 * do different things on Codex than on Claude. This pins that parity: add a
 * governed action to one list but not the other and this fails.
 */
describe("buildOperatorToolkit ↔ operatorPlanToolsFor governed-action parity (F27-O3)", () => {
  // get_task / read_default_branch_file are read-only Claude tools with no plan
  // mirror (Codex gets that information embedded in its prompt). The two packet
  // tools carry different display names either side; everything else matches.
  // Ruling 282: `read_board` is a READ, like its two siblings — it changes
  // nothing, so it is not part of the governed vocabulary the two toolkits
  // must agree on. (Codex operators get board facts in their prompt, which is
  // why no read here has a plan mirror.)
  // Ruling 283 (`read_knowledge_doc`) and ruling 285 (`read_timeline_entry`) add
  // two more reads for the same reason: each is the pull half of something the
  // prompt now carries only a clipped or indexed form of.
  const READ_ONLY = new Set([
    "get_task",
    "read_default_branch_file",
    "read_board",
    "read_knowledge_doc",
    "read_timeline_entry",
    // Ruling 293: the evidence a report only claims. A read like its siblings.
    "read_task_attachment",
  ]);
  const RENAME = new Map([
    ["open_decision_packet", "open_packet"],
    ["resolve_decision_packet", "resolve_packet"],
  ]);
  const claudeGovernedTools = (allowedTools: string[]): Set<string> =>
    new Set(
      allowedTools
        .filter((t) => t.startsWith("mcp__viberr__"))
        .map((t) => t.slice("mcp__viberr__".length))
        .filter((t) => !READ_ONLY.has(t))
        .map((t) => RENAME.get(t) ?? t),
    );

  const withPolicy = (
    policy: Record<string, "direct" | "recommend" | "off">,
  ): OperatorAuthority => ({
    ...authority([]),
    policy: new Map(Object.entries(policy)),
  });

  const ALL_CAPS = [
    "append-typed-events",
    "generate-packets",
    // Hunt 2026-08-29: the collapsed dispatch grant. It MUST be in the uniform
    // map — `dispatchGate` resolves an ABSENT grant to the catalog default
    // (pre-rework deployments store only the retired assign/summon pair), so
    // an all-off policy that omits it would legitimately keep run_agent.
    "dispatch-agents",
    "stage-transitions",
    "deliver-review-pr",
    "update-task-branch",
    "completion-for-acceptance",
  ] as const;
  const uniform = (mode: "direct" | "off") =>
    Object.fromEntries(ALL_CAPS.map((c) => [c, mode]));

  const build = (auth: OperatorAuthority) =>
    buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });

  // For any policy that grants SOMETHING, the two toolkits expose exactly the
  // same governed vocabulary. This is the drift guard.
  it.each([
    ["every governed capability granted", withPolicy(uniform("direct"))],
    [
      "a realistic supervised mix (transitions/acceptance recommend-only)",
      withPolicy({
        "append-typed-events": "direct",
        "generate-packets": "direct",
        "assign-primary-specialist": "direct",
        "summon-reviewers": "direct",
        "stage-transitions": "recommend",
        "deliver-review-pr": "direct",
        "update-task-branch": "direct",
        "completion-for-acceptance": "recommend",
      }),
    ],
  ])(
    "the two toolkits expose the same governed actions — %s",
    (_label, auth) => {
      const claude = [...claudeGovernedTools(build(auth).allowedTools)].sort();
      const plan = [...operatorPlanToolsFor(auth)].sort();
      expect(claude).toEqual(plan);
    },
  );

  // The one DELIBERATE divergence: with nothing granted, Claude builds an empty
  // governed toolkit (fine — the model just has no governance tools), but a
  // structured-output enum may not be empty, so the Codex plan schema falls back
  // to the full in-Viberr set (never deliver/update — effects OUTSIDE Viberr)
  // and every action the operator then proposes is refused visibly by
  // narrateRefusedActions. Pins that this asymmetry stays the enum-only one.
  it("ruling 131(b): set_dependencies is built under generate-packets, withheld when that grant is off, and the plan enum agrees", () => {
    // Canary: gate the Claude tool under `append-typed-events` instead (the
    // withheld case still builds it; the parity cases above also go red).
    const granted = withPolicy(uniform("direct"));
    expect(build(granted).allowedTools).toContain("mcp__viberr__set_dependencies");
    expect(operatorPlanToolsFor(granted)).toContain("set_dependencies");
    // Every grant direct EXCEPT packets: append-typed-events stays granted, so
    // only the packet gate can explain the tool's absence.
    const withheld = withPolicy({ ...uniform("direct"), "generate-packets": "off" });
    expect(build(withheld).allowedTools).not.toContain("mcp__viberr__set_dependencies");
    expect(build(withheld).allowedTools).toContain("mcp__viberr__post_comment");
    expect(operatorPlanToolsFor(withheld)).not.toContain("set_dependencies");
  });

  it("ruling 488: relay_to_task is built with the comment grant and carries the no-hand-copy doctrine", () => {
    // Canaries: build it outside the `append-typed-events` block (the withheld
    // case still builds it); drop the no-hand-copy sentence.
    const granted = build(withPolicy(uniform("direct")));
    expect(granted.allowedTools).toContain("mcp__viberr__relay_to_task");
    const withheld = build(withPolicy({ ...uniform("direct"), "append-typed-events": "off" }));
    expect(withheld.allowedTools).not.toContain("mcp__viberr__relay_to_task");
    expect(granted.tools.find((t) => t.name === "relay_to_task")!.description).toContain(
      "never ask anyone to copy, paste or post text between tasks, and never ask a person to confirm a relay landed",
    );
  });

  it("ruling 487: the schedule tools are built on a DIRECT dispatch grant, and schedule_task_action carries the doctrine", () => {
    // Canaries: build them on `dispatchGate !== "deny"` (the recommend
    // operator is handed a run that starts with nobody present); drop the
    // no-packet sentence from the description.
    const direct = build(withPolicy(uniform("direct")));
    expect(direct.allowedTools).toContain("mcp__viberr__schedule_task_action");
    expect(direct.allowedTools).toContain("mcp__viberr__cancel_task_schedule");
    for (const mode of ["recommend", "off"] as const) {
      const withheld = build(withPolicy({ ...uniform("direct"), "dispatch-agents": mode }));
      expect(withheld.allowedTools, mode).not.toContain("mcp__viberr__schedule_task_action");
      expect(withheld.allowedTools, mode).not.toContain("mcp__viberr__cancel_task_schedule");
    }
    const desc = (name: string) => direct.tools.find((t) => t.name === name)!.description;
    expect(desc("schedule_task_action")).toContain("That wait is scheduled, never asked");
    expect(desc("schedule_task_action")).toContain("do not ask a person to schedule it or to route it through the controller");
    expect(desc("schedule_task_action")).toContain(
      "A hold that a pending schedule explains needs NO decision packet: write one timeline note naming the schedule and end your turn.",
    );
    expect(desc("get_task")).toContain("`schedules` (ruling 487) lists the runs scheduled on this task that have not fired yet");
  });

  it("ruling 494: get_task and update_branch_from_base say which head a behind count describes, to check it against the pushed head, and never to quote an older head's", () => {
    // Canaries: drop the `baseComparedHead` sentence from either description.
    const defs = build(withPolicy(uniform("direct"))).tools;
    const desc = (name: string) => defs.find((t) => t.name === name)!.description;
    expect(desc("get_task")).toContain(
      "`baseComparedHead` (ruling 494) names the head `baseBehindBy` was counted on (`sha`, `observedAt`): `current: false` means the count was not read on the head Viberr last pushed (`pushedSince` names it), because that push came after the compare or GitHub had not shown it yet when it compared",
    );
    expect(desc("get_task")).toContain("the count is never stated as the branch's, in a comment or a packet");
    expect(desc("update_branch_from_base")).toContain(
      "`get_task`'s `baseComparedHead` names the head that count was read on (ruling 494): check it against the head you just pushed.",
    );
    expect(desc("update_branch_from_base")).toContain(
      "a decision packet never states a behind count for a head other than the one it puts up",
    );
  });

  it("ruling 133 (A19): get_task, run_agent and transition_stage say the engaged deliverer runs at every stage and a hand-off is never a stage workaround", () => {
    // Canary: restore any one of the three original sentences.
    const defs = build(withPolicy(uniform("direct"))).tools;
    const desc = (name: string) => defs.find((t) => t.name === name)!.description;
    expect(desc("get_task")).toContain("it is the engaged deliverer (`engagedAsDeliverer`), which runs at EVERY stage (ruling 133)");
    expect(desc("run_agent")).toContain("A hand-off is a choice about WHO should build, never a way around a stage");
    expect(desc("run_agent")).toContain("never hand delivery to another profile to get around a stage");
    expect(desc("transition_stage")).toContain("never a workaround for a profile's stages");
    expect(desc("transition_stage")).not.toContain("does not work the review stage");
  });

  it("ruling 160 (pass 35, F35-11): deliver_for_review says a closed-unmerged PR is a person's decision and names the packet", () => {
    // Canary: restore the description from before S14.
    const defs = build(withPolicy(uniform("direct"))).tools;
    const desc = (name: string) => defs.find((t) => t.name === name)!.description;
    expect(desc("deliver_for_review")).toContain("A pull request a person closed WITHOUT merging is that person's decision about the task (ruling 160)");
    expect(desc("deliver_for_review")).toContain("the tool answers `closed_by_human`, opens no new PR for the branch");
    expect(desc("deliver_for_review")).toContain("closed-PR recovery packet");
    expect(desc("deliver_for_review")).toContain("Only a MERGED pull request clears the way for a fresh review PR");
  });

  it("pass 35 S15 (rulings 162 and 163): the tool text names the gate's verdict, the acceptance-stage refusal, the rework route and the acceptance-time refresh", () => {
    // Canary: restore any of the four descriptions from before S15.
    const defs = build(withPolicy(uniform("direct"))).tools;
    const desc = (name: string) => defs.find((t) => t.name === name)!.description;
    expect(desc("get_task")).toContain("a PR the gate would refuse cannot be recommended for acceptance");
    expect(desc("accept_completion")).toContain("A pull request the acceptance gate would refuse cannot be recommended for acceptance");
    expect(desc("transition_stage")).toContain("Backwards to the review stage is allowed when the revision changed after a verdict");
    expect(desc("transition_stage")).toContain("Merge means mergeable");
    expect(desc("update_branch_from_base")).toContain("Never call it once the task stands at the acceptance stage");
    expect(desc("update_branch_from_base")).toContain("the acceptance ceremony brings the branch up to date once and merges in the same step");
  });

  it("ruling 492 (review): accept_completion says it waits for the answer to the operator's own follow-up option", () => {
    // The tool refuses while the open decision offers a create_task whose new
    // task waits on this one, because accepting would withdraw it unanswered.
    // Canary: drop the sentence from the accept_completion description.
    const defs = build(withPolicy(uniform("direct"))).tools;
    const desc = (name: string) => defs.find((t) => t.name === name)!.description;
    expect(desc("accept_completion")).toContain(
      "It also refuses while your open decision offers a `create_task` whose new task waits on this one (ruling 492)",
    );
  });

  it("nothing granted: Claude builds no governed tool; the Codex plan enum falls back and never advertises delivery", () => {
    const auth = withPolicy(uniform("off"));
    expect([...claudeGovernedTools(build(auth).allowedTools)]).toEqual([]);
    const plan = operatorPlanToolsFor(auth);
    expect(plan.length).toBeGreaterThan(0); // enum can't be empty
    expect(plan).not.toContain("deliver_for_review");
    expect(plan).not.toContain("update_branch_from_base");
  });
});

/**
 * N19-9 — nothing in the product could bring a task branch up to date with its
 * base. The owner ruled it operator-decided, in the R15-2 shape: a capability
 * gates the tool, the server does the git, a conflict goes to a human.
 */
describe("buildOperatorToolkit — update_branch_from_base (N19-9)", () => {
  const build = (auth: OperatorAuthority) =>
    buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });

  it("builds the tool with the grant ABSENT (it postdates every deployment; it follows the delivery gate)", () => {
    expect(build(authority([])).allowedTools).toContain(
      "mcp__viberr__update_branch_from_base",
    );
  });

  it("withholds the tool when update-task-branch is explicitly off", () => {
    const auth = authority([]);
    auth.policy.set("update-task-branch", "off");
    expect(build(auth).allowedTools).not.toContain(
      "mcp__viberr__update_branch_from_base",
    );
  });

  it("withholds it when DELIVERY is withheld — it is the smaller act on the same branch", () => {
    const auth = authority([]);
    auth.policy.set("deliver-review-pr", "off");
    expect(build(auth).allowedTools).not.toContain(
      "mcp__viberr__update_branch_from_base",
    );
  });
});

/**
 * A4 — with NO operator deployed, `resolveOperatorAuthority` returns an empty
 * policy and `deployed: false`. Every gate then denies, so the toolkit is
 * read-only. The bug: `deliverGate`'s absent-means-granted polarity fired for
 * the empty policy too, so this authority built `get_task` +
 * `deliver_for_review` — a run that could push a branch and open a PR with no
 * operator configured anywhere in the project.
 */
describe("buildOperatorToolkit — no operator deployed (A4)", () => {
  const undeployed = (): OperatorAuthority => ({
    ...authority([]),
    policy: new Map(),
    deployed: false,
    // A non-strict board: the shape whose absent grant resolved to `direct`.
    humanGatedBeforeWork: false,
  });

  it("builds a READ-ONLY toolkit — no delivery, no packets, no transitions", () => {
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: undeployed(),
    });
    // R19-1: the operator reads the repository from the full read-only checkout
    // under its cwd (Read/Grep/Glob), not from an MCP tool — so the in-process
    // toolkit floor is the READS. What "read-only" excludes is every WRITE, and
    // that is what this asserts: the floor is exactly the reads, and nothing
    // that changes state is reachable.
    //
    // Ruling 282: `read_board` joins that floor. An undeployed operator holds
    // no authority, and being able to SEE the board it holds no authority over
    // takes nothing: the whole point of the floor is that reading is never the
    // thing being withheld. Ruling 285's `read_timeline_entry` joins it for the
    // same reason — and more sharply, because the task page shows a person the
    // whole comment this returns, so withholding it from the coordinator
    // withholds nothing from anyone. (`read_knowledge_doc` is NOT here: it is
    // gated on the run's own KB grants, and this authority holds none.)
    expect(toolkit.allowedTools).toEqual([
      "mcp__viberr__get_task",
      "mcp__viberr__read_board",
      "mcp__viberr__read_task_attachment",
      "mcp__viberr__read_timeline_entry",
    ]);
    for (const write of [
      "mcp__viberr__deliver_for_review",
      "mcp__viberr__transition_stage",
      "mcp__viberr__open_decision_packet",
      "mcp__viberr__prompt_agent",
      "mcp__viberr__post_comment",
    ]) {
      expect(toolkit.allowedTools).not.toContain(write);
    }
  });
});

/**
 * R19-1 — the toolkit's own instructions block is a SECOND channel into the
 * same model, and it used to contradict the first.
 *
 * The operator now runs with a read-only checkout of the project repository
 * under its cwd and a system prompt requiring every packet that reasons about
 * repository contents to be grounded in it. The instructions still said "never
 * write code or touch the repository" — written when the operator had no
 * working tree at all. A model told to read the repo by one channel and never
 * to touch it by another can resolve that either way, and the way that loses is
 * exactly F19-4: describing the empty task folder as "the repo".
 */
describe("buildOperatorToolkit — the knowledge tools name the document alike (ruling 588)", () => {
  it("correct_knowledge_doc takes the document as `path`, the field read_knowledge_doc takes", async () => {
    // Live on AWSC-29 the Estimate Judge read mapping.md with `path` and sent
    // its two corrections with `path` too; the tool took `doc`, and both came
    // back refused. CANARY: name the operator's field `doc` again.
    const auth = authority([]);
    auth.kb = ["rulings"];
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });
    const schemas = await publishedSchemas(toolkit.mcpServers.viberr);
    const fields = z.object({ properties: z.record(z.string(), z.unknown()) });
    const read = Object.keys(fields.parse(schemas.get("read_knowledge_doc")).properties);
    const correct = Object.keys(fields.parse(schemas.get("correct_knowledge_doc")).properties);
    expect(read).toContain("path");
    expect(correct).toContain("path");
    expect(correct).not.toContain("doc");
  });
});

describe("the viberr server's instructions — reading is expected, writing is not (R19-1)", () => {
  const wired = () =>
    wiredInstructions.parse(
      buildOperatorToolkit({
        db: ctxDb.makeDb(),
        ctx: { dataRoot: ctxDb.makeTempDir() },
        projectSlug: "p",
        taskKey: "P-1",
        authority: authority([]),
      }).mcpServers.viberr,
    );

  it("states the write prohibition precisely and stops forbidding reads", () => {
    // Canary: restore the "never write code or touch the repository" sentence
    // and every half fails.
    const text = wired();
    expect(text).toContain("never write code");
    expect(text).toMatch(/cannot edit, create or commit files/);
    expect(text).toContain("READING the task's repository checkout");
    expect(text).not.toMatch(/touch the repository/);
    // The claim-grounding rule the packets depend on, restated where the tools
    // that WRITE those packets are described.
    expect(text).toMatch(/claim you make about the repository must come from reading it/);
  });

  it("does NOT claim the operator cannot push — delivery is its decision (R15-2)", () => {
    // The over-correction that would break the product: `deliver_for_review`
    // pushes the deliverer's committed branch, and both the operator definition
    // and the tool description tell the model delivery is its call. A blanket
    // "you cannot push the repository" here is a third channel contradicting
    // them, and the careful resolution is an operator that stops delivering.
    // Canary: put "or push the repository" back into the constant and this
    // fails.
    const text = wired();
    expect(text).not.toMatch(/or push the repository/);
    expect(text).toMatch(/delivery is a decision you make and the server executes/);
  });

  it("loads every viberr tool up front, so the run's first call is not a ToolSearch (Option D PR 4(a))", () => {
    // Canary: drop `alwaysLoad: true` from the viberr server and every tool
    // lands in `deferred`.
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    const loading = toolLoading(toolkit.mcpServers.viberr);
    expect(loading.deferred).toEqual([]);
    expect(loading.loaded).toContain("get_task");
    expect(loading.loaded).toHaveLength(toolkit.tools.length);
  });
});

/**
 * F21-21 (live VIB-7) — the operator's "read-only repository view" is the
 * SHARED task workspace, so once the delivering agent commits it stands on the
 * TASK branch. The operator read a row its own deliverer had just written and
 * raised a blocking packet claiming the DEFAULT branch already contained it.
 * The anchored read has to be a TOOL: `Bash` is denied for every operator run,
 * so `git show origin/main:…` is not something the model can reach.
 */
describe("buildOperatorToolkit — read_default_branch_file (F21-21)", () => {
  it("is offered when the run holds a checkout, and names the anchoring in its description", () => {
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
      workspace: { dir: "/tmp/nowhere", defaultBranch: "main" },
    });
    expect(toolkit.allowedTools).toContain("mcp__viberr__read_default_branch_file");
    const def = toolkit.tools.find((t) => t.name === "read_default_branch_file")!;
    expect(def.description).toContain("origin/main");
    expect(def.description).toContain("DELIVERING AGENT'S workspace");
    expect(def.description).toContain("never conclude from it that work landed out-of-band");
  });

  it("is withheld when the run has no checkout — a read that could only fail", () => {
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    expect(toolkit.allowedTools).not.toContain("mcp__viberr__read_default_branch_file");
    expect(toolkit.tools.some((t) => t.name === "read_default_branch_file")).toBe(false);
  });
});

/**
 * F21-3 — the operator run pre-flights its stdio MCP mounts now
 * (`operatorMcpResolution`), and hands the VERIFIED set here. A second resolve
 * inside the toolkit would silently re-mount a server the pre-flight had just
 * dropped, so the prompt would announce one set and the run would mount another.
 */
describe("buildOperatorToolkit — mounts the caller's pre-flighted resolution (F21-3)", () => {
  /** A db where `everything-mcp` IS registered and healthy — so a second
   *  resolve inside the toolkit would happily mount it. That is what makes the
   *  assertion below a real pin rather than an empty-registry tautology. */
  async function dbWithRegisteredServer() {
    const db = ctxDb.makeDb();
    await saveMcpServer(
      db,
      { name: "everything-mcp", transport: "stdio", target: "/bin/echo hi", cred: "" },
      ACTOR,
      { spawnImpl: () => { throw new Error("no spawn in test"); } },
    );
    return db;
  }

  it("mounts exactly what the caller verified — a dropped server is NOT re-resolved", async () => {
    // Canary: ignore `deps.orgMcpServers` and resolve again here; the grant
    // re-appears and this fails.
    const toolkit = buildOperatorToolkit({
      db: await dbWithRegisteredServer(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority(["everything-mcp"]),
      // What the run's pre-flight produced: the dead stdio mount was dropped.
      orgMcpServers: {},
    });
    expect(Object.keys(toolkit.mcpServers)).toEqual(["viberr"]);
    expect(toolkit.allowedTools).not.toContain("mcp__everything-mcp");
  });

  it("still resolves for a caller with no resolution of its own", async () => {
    const db = ctxDb.makeDb();
    await saveMcpServer(
      db,
      { name: "everything-mcp", transport: "stdio", target: "/bin/echo hi", cred: "" },
      ACTOR,
      { spawnImpl: () => { throw new Error("no spawn in test"); } },
    );
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority(["everything-mcp"]),
    });
    expect(Object.keys(toolkit.mcpServers).sort()).toEqual(["everything-mcp", "viberr"]);
  });
});

/** Ruling 138: the Claude tool declares `goalDraft` on packet options, with a
 *  description that says to write it AS the goal. */
describe("buildOperatorToolkit — open_decision_packet declares goalDraft (ruling 138)", () => {
  it("the option schema carries goalDraft and says what it is", async () => {
    // Canary: remove the field from the option schema.
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    expect(toolkit.tools.some((t) => t.name === "open_decision_packet")).toBe(true);
    // Ruling 296 made the schema a whole strict object, so the field texts are
    // read off the JSON Schema of the whole tool -- which is the copy the model
    // is handed, and the only one that can be wrong in a way that matters.
    const declared = JSON.stringify(
      (await publishedSchemas(toolkit.mcpServers.viberr)).get("open_decision_packet"),
    );
    expect(declared).toContain('"goalDraft"');
    expect(declared).toContain("written AS a goal");
    expect(declared).toContain("Refused on any other kind");
  });

  it("ruling 421: run_agent publishes `completeness`, and get_task names it with the round-two question", async () => {
    // CANARY: drop the `completeness` field from run_agent's schema, and the
    // Claude operator has no way to say the question was put.
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("dispatch-agents", "direct");
        return auth;
      })(),
    });
    const declared = JSON.stringify(
      (await publishedSchemas(toolkit.mcpServers.viberr)).get("run_agent"),
    );
    expect(declared).toContain('"completeness"');
    expect(declared).toContain("records the verdict that run returns as the reviewer's complete set");
    const getTask = toolkit.tools.find((t) => t.name === "get_task")!;
    expect(getTask.description).toContain("Pass `completeness: true` on that `run_agent` (ruling 421)");
  });

  /**
   * Ruling 164 (pass 35, F35-14): the tool that AUTHORS options says the title
   * is a promise, names the two kinds that keep it, and declares `toStage`.
   * The operator wrote "Force-accept as admin ..." as a `custom` title because
   * nothing here told it there was another way.
   */
  it("ruling 164: the tool text names the promise, force_accept, move_stage and toStage", async () => {
    // Canary: restore the description and the option schema from before S18.
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    const def = toolkit.tools.find((t) => t.name === "open_decision_packet")!;
    const published = await publishedSchemas(toolkit.mcpServers.viberr);
    expect(def.description).toContain("An option TITLE is a promise the resolution keeps");
    expect(def.description).toContain("'force_accept'");
    expect(def.description).toContain("'move_stage'");
    const declared = JSON.stringify(published.get("open_decision_packet"));
    expect(declared).toContain('"toStage"');
    expect(declared).toContain("move_stage only");
  });

  it("F39-68: the option kinds say a created task starts from the base branch", async () => {
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    const published = await publishedSchemas(toolkit.mcpServers.viberr);
    // CANARY: drop the sentence and Claude's operator is told only to use
    // `create_task` for "another service", the guidance AX-5's operator
    // followed into a follow-up that could not reach the code.
    expect(JSON.stringify(published.get("open_decision_packet"))).toContain(
      JSON.stringify(CREATE_TASK_BASE_NOTE).slice(1, -1),
    );
  });

  /**
   * Ruling 289 (pass 37, F37-124): the excerpt SAYS it is one.
   *
   * `read_board` returned a bare `.slice` of another task's goal, so a long
   * contract came back ending mid-word and read as the whole of it — the shape
   * rulings 283, 285 and 288 closed on a knowledge base, an agent report and a
   * goal draft, sitting in the reader those rulings' own author wrote the same
   * day. The cap stays: this is the SHALLOW read of the tasks beside your own.
   */
  it("ruling 289: a clipped goal says it is clipped, a short one is untouched, and no key lists the board", async () => {
    const store = setupTestStore(ctxDb);
    const long = `Deliverable: the thing. ${"detail ".repeat(500)}END-OF-CONTRACT`;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "triage" }),
      goal: long,
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "triage" }),
      goal: "Short and whole.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const read = toolkit.tools.find((t) => t.name === "read_board")!;
    const call = async (taskKey?: string) => {
      // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`;
      // a shape change fails the assertions below rather than reading undefined.
      const answer = (await read.handler({ taskKey } as never, {} as never)) as {
        content: { text: string }[];
      };
      return answer.content[0]!.text;
    };

    // Canary: put the bare `.slice` back and the excerpt reads as the contract.
    const clipped = await call("VIB-2");
    expect(clipped).toContain("Deliverable: the thing.");
    expect(clipped).not.toContain("END-OF-CONTRACT");
    expect(clipped).toContain("[excerpt");
    expect(clipped).toContain("the task's own page has all of it");

    // …and a goal that fits carries no marker: a whole contract that claims to
    // be an excerpt sends a reader looking for text that does not exist.
    const whole = await call("VIB-3");
    expect(whole).toContain("Short and whole.");
    expect(whole).not.toContain("[excerpt");

    // Ruling 282: with no key, the operator's read lists the whole board.
    const board = await call();
    for (const key of ["VIB-1", "VIB-2", "VIB-3"]) expect(board).toContain(`"key": "${key}"`);
  });

  /**
   * Ruling 579: live on AWSC-16 the round-2 comparison read AWSC-15's goal,
   * 2,751 characters, and got its first 2,000; the Workflow Researcher said it
   * "cannot say whether a third decision is recorded in the clipped tail".
   * Decisions are appended at a goal's end (ruling 189), the part the cap cut.
   * CANARY: return the bare excerpt and both decisions are gone.
   */
  it("ruling 579: a clipped goal keeps every decision recorded on it, whole", async () => {
    const store = setupTestStore(ctxDb);
    const text = `Deliverable: the estimate. ${"detail ".repeat(400)}END-OF-TEXT`;
    const older =
      "\n\n---\n\n**Decision — 2026-09-28, Arda answered “Headline which total?”:**\n\n" +
      "Calculator's total — the Price List total beside it\n\n" +
      "This decision is part of the task's contract from here on. Where anything above contradicts it, the decision wins.";
    const newer =
      "\n\n---\n\n**Decision: 2026-09-29, Arda answered “Which CloudFront model?”:**\n\n" +
      "Business: the flat-rate plan fits\n\n" +
      "This decision is part of the task's contract from here on. Where anything above contradicts it, the decision wins.";
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review" }),
      goal: `${text}${older}${newer}`,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const read = toolkit.tools.find((t) => t.name === "read_board")!;
    // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`.
    const answer = (await read.handler({ taskKey: "VIB-2" } as never, {} as never)) as {
      content: { text: string }[];
    };
    // SAFETY: readBoardTask answers one task's JSON; only `goal` is read here.
    const goal = (JSON.parse(answer.content[0]!.text) as { goal: string }).goal;
    expect(goal).toContain("Deliverable: the estimate.");
    expect(goal).not.toContain("END-OF-TEXT");
    expect(goal).toContain("every decision recorded on it follows, whole");
    expect(goal).toContain("Calculator's total — the Price List total beside it");
    expect(goal).toContain("Business: the flat-rate plan fits");
    expect(goal.endsWith("the decision wins.")).toBe(true);
  });

  /**
   * Ruling 569: a task that waited on others could learn only THAT they
   * finished. Live on AWSC-8 the research task's operator told its researcher
   * "neither you nor I can read that" about sample-04's 90/100, which lived only
   * in AWSC-7's verdict. CANARIES: drop `outcome` from the single-task read and
   * the finished task reads like an unfinished one; stop filtering on the
   * current subject and a verdict on an earlier delivery reads as the result.
   */
  it("ruling 569: read_board(taskKey) carries a finished task's outcome, and nothing stale", async () => {
    const store = setupTestStore(ctxDb);
    const deliveredAt = "2026-09-28T20:15:47.701Z";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "done",
        deliveredAt,
        completionPacket: {
          subject: `files:${deliveredAt}`,
          summary: "The Judge approved the files and scored them 90/100.",
          changes: null,
          screenshots: [],
          at: "2026-09-28T20:31:34.480Z",
        },
        verdicts: [
          {
            profileId: "estimate-judge",
            revisionId: `files:${deliveredAt}`,
            result: "approve",
            reason: "## Verdict: approve, score 90/100\n\n| Mapping | 40 |",
            at: "2026-09-28T20:31:15.082Z",
            rounds: 1,
          },
          {
            profileId: "estimate-judge",
            revisionId: "files:2026-09-28T19:00:00.000Z",
            result: "request_changes",
            reason: "STALE-VERDICT-ON-AN-EARLIER-DELIVERY",
            at: "2026-09-28T19:10:00.000Z",
            rounds: 1,
          },
        ],
      }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "triage" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const read = toolkit.tools.find((t) => t.name === "read_board")!;
    const call = async (taskKey: string) => {
      // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`.
      const answer = (await read.handler({ taskKey } as never, {} as never)) as {
        content: { text: string }[];
      };
      // SAFETY: readBoardTask answers one task's JSON; only `outcome` is read here.
      return JSON.parse(answer.content[0]!.text) as { outcome?: unknown };
    };
    expect((await call("VIB-2")).outcome).toEqual({
      completion: "The Judge approved the files and scored them 90/100.",
      verdicts: [
        {
          agent: "estimate-judge",
          result: "approve",
          report: "## Verdict: approve, score 90/100\n\n| Mapping | 40 |",
        },
      ],
    });
    // A task with no outcome yet carries no empty one.
    expect(await call("VIB-3")).not.toHaveProperty("outcome");
  });

  it("ruling 596: read_board indexes a task's timeline (capped), and read_timeline_entry opens another task's entry by that stamp", async () => {
    // The operator reads its own task with get_task; another task's history
    // was out of reach, so a results task could not see the first verdict on a
    // benchmark run, where its score of record lives. CANARIES: drop the cap
    // and a long task floods a board-wide read; bind the reader to this task
    // and the other task's entry is a miss.
    const store = setupTestStore(ctxDb);
    const timeline = Array.from({ length: 205 }, (_, i) => ({
      occurredAt: new Date(Date.parse("2026-09-30T02:00:00.000Z") - i * 1000).toISOString(),
      type: "comment" as const,
      actor: { kind: "operator" as const },
      title: i === 204 ? "Review verdict" : null,
      text: `entry ${i}`,
      toAgent: false,
      evidence: null,
    }));
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }) });
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review" }), timeline });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`.
    const text = async (name: string, args: Record<string, string>) =>
      ((await toolkit.tools.find((t) => t.name === name)!.handler(args as never, {} as never)) as {
        content: { text: string }[];
      }).content[0]!.text;
    const index = z.object({ timeline: z.array(z.string()) }).parse(JSON.parse(await text("read_board", { taskKey: "VIB-2" }))).timeline;
    expect(index).toHaveLength(201);
    expect(index[0]).toBe("2026-09-30T02:00:00.000Z · comment · operator");
    expect(index.at(-1)).toBe("[5 older entries not listed]");
    // An entry past the cap is still readable by its stamp.
    const oldest = z.object({ text: z.string(), title: z.string().nullable() }).parse(
      JSON.parse(await text("read_timeline_entry", { taskKey: "VIB-2", occurredAt: timeline[204]!.occurredAt })),
    );
    expect(oldest).toMatchObject({ text: "entry 204", title: "Review verdict" });
  });

  it("ruling 597: read_task_attachment reads this task's file as a kept delivery held it", async () => {
    // CANARY: drop `delivery` on the way to the reader and the rework's text
    // comes back for the first delivery.
    const store = setupTestStore(ctxDb);
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const dir = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "summary.md"), "Score of record: 75/100");
    keepDelivery(store.slug, "VIB-1", "2026-09-29T23:35:25.588Z", ["summary.md"], store.dataRoot);
    writeFileSync(path.join(dir, "summary.md"), "Rework: 79/100");
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    // SAFETY: every answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (args: Record<string, string>) =>
      ((await toolkit.tools.find((t) => t.name === "read_task_attachment")!.handler(args as never, {} as never)) as {
        content: { text: string }[];
      }).content[0]!.text;
    expect(await text({ name: "summary.md", delivery: "2026-09-29T23:35:25.588Z" })).toContain("Score of record: 75/100");
    expect(await text({ name: "summary.md" })).toContain("Rework: 79/100");
    expect(await text({ name: "summary.md", delivery: "2026-09-30T01:55:33.089Z" })).toContain(
      "[noop] VIB-1 kept no delivery at `2026-09-30T01:55:33.089Z`.",
    );
  });

  it("ruling 569: a verdict's report is read whole from its Review verdict comment, not the stored excerpt", async () => {
    // Live on AWSC-8 the researcher read AWSC-7's verdict to character 2,000 of
    // 5,382: a verdict stores 2,000 characters and points at the timeline
    // (ruling 292), which another task's reader cannot open. CANARY: return
    // the stored reason and the report stops at the cut; drop the opening
    // match and an earlier round's report can stand in for this one.
    const store = setupTestStore(ctxDb);
    const deliveredAt = "2026-09-28T20:15:47.701Z";
    const report = `## Verdict: approve, score 90/100\n\n${"The table and the findings. ".repeat(140)}\n\nSENTINEL-PAST-THE-STORED-CUT`;
    const stored =
      `${report.slice(0, 2000)}\n\n[cut here - the reviewer's justification ran to ` +
      `${report.length} characters and this is its first 2,000. Its full report is on this task's timeline, whole.]`;
    const judge = {
      kind: "agent" as const,
      backend: "claude" as const,
      profileId: "estimate-judge",
      roleHint: "Estimate Judge",
    };
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", {
        stage: "done",
        deliveredAt,
        verdicts: [
          {
            profileId: "estimate-judge",
            revisionId: `files:${deliveredAt}`,
            result: "approve",
            reason: stored,
            at: "2026-09-28T20:31:15.087Z",
            rounds: 1,
          },
        ],
      }),
      timeline: [
        {
          occurredAt: "2026-09-28T20:31:15.082Z",
          type: "comment",
          actor: judge,
          title: "Review verdict",
          text: report,
          toAgent: false,
          evidence: null,
        },
        {
          occurredAt: "2026-09-28T19:10:00.000Z",
          type: "comment",
          actor: judge,
          title: "Review verdict",
          text: "An earlier round's report, on an earlier delivery.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const read = toolkit.tools.find((t) => t.name === "read_board")!;
    // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`,
    // and readBoardTask's outcome carries `verdicts[].report` (asserted below).
    const answer = (await read.handler({ taskKey: "VIB-2" } as never, {} as never)) as {
      content: { text: string }[];
    };
    // SAFETY: one task's JSON, whose `outcome.verdicts` this test wrote.
    const parsed = JSON.parse(answer.content[0]!.text) as {
      outcome: { verdicts: { report: string }[] };
    };
    expect(parsed.outcome.verdicts[0]!.report).toBe(report);

    // A verdict whose own report is not on the timeline keeps what it stored,
    // and an earlier round's report is never taken for it.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", {
        stage: "done",
        deliveredAt,
        verdicts: [
          {
            profileId: "estimate-judge",
            revisionId: `files:${deliveredAt}`,
            result: "approve",
            reason: stored,
            at: "2026-09-28T20:31:15.087Z",
            rounds: 1,
          },
        ],
      }),
      timeline: [
        {
          occurredAt: "2026-09-28T19:10:00.000Z",
          type: "comment",
          actor: judge,
          title: "Review verdict",
          text: "An earlier round's report, on an earlier delivery.",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // SAFETY: as above.
    const other = (await read.handler({ taskKey: "VIB-3" } as never, {} as never)) as {
      content: { text: string }[];
    };
    // SAFETY: as above.
    const otherParsed = JSON.parse(other.content[0]!.text) as {
      outcome: { verdicts: { report: string }[] };
    };
    expect(otherParsed.outcome.verdicts[0]!.report).toBe(stored);
  });

  /**
   * Ruling 285 (pass 37, F37-120): the coordinator could not read a report it
   * was handed half of. Its prompt clips an agent report at 4,000 characters,
   * `get_task` clips every `recentTimeline` entry at 1,500, and nothing in the
   * toolkit returned one whole. Live on SHOP-42 it said so in a packet it put
   * to a human — "the reviewer's report reached me truncated at '### Item 3 —',
   * so I have not read its cross-service audit conclusion; the full text is on
   * the timeline" — which was true, and was somewhere it could not go. What it
   * could not read named two unowned defects the reviewer had gone looking for.
   */
  it("ruling 285: read_timeline_entry returns a clipped report whole, by its stamp", async () => {
    const store = setupTestStore(ctxDb);
    // A report past BOTH clips: the prompt's 4,000 and the snapshot's 1,500.
    const report = `## Findings\n\n${"filler ".repeat(900)}\n\nSENTINEL-PAST-THE-CLIP`;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review" }),
      goal: "The task the operator is coordinating.",
      timeline: [
        {
          occurredAt: "2026-09-15T13:53:26.000Z",
          type: "comment",
          actor: {
            kind: "agent",
            backend: "claude",
            profileId: "code-reviewer",
            roleHint: "Code Reviewer",
          },
          title: null,
          text: report,
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const textOf = async (
      name: string,
      args: { occurredAt?: string },
    ): Promise<string> => {
      const tool = toolkit.tools.find((t) => t.name === name)!;
      // SAFETY: every tool here answers `{ content: [{ type: "text", text }] }`;
      // a shape change fails the assertions below rather than reading undefined.
      const answer = (await tool.handler(args as never, {} as never)) as {
        content: { text: string }[];
      };
      return answer.content[0]!.text;
    };

    // What `get_task` shows: the entry CLIPPED, and its address beside the cut.
    const snapshot = await textOf("get_task", {});
    expect(snapshot).not.toContain("SENTINEL-PAST-THE-CLIP");
    expect(snapshot).toContain('"occurredAt": "2026-09-15T13:53:26.000Z"');
    expect(snapshot).toContain("read_timeline_entry with this occurredAt");

    // …and what the tool returns: the report whole.
    const full = await textOf("read_timeline_entry", {
      occurredAt: "2026-09-15T13:53:26.000Z",
    });
    expect(full).toContain("SENTINEL-PAST-THE-CLIP");
    expect(full).toContain('"truncated": false');

    // A stamp that is close but not exact is the likeliest caller error, so the
    // refusal names the real ones rather than implying a deletion.
    const missed = await textOf("read_timeline_entry", {
      occurredAt: "2026-09-15T13:53:26Z",
    });
    expect(missed).toContain("[noop]");
    expect(missed).toContain("2026-09-15T13:53:26.000Z");
  });

  /**
   * Ruling 287's DOOR, tested for the reason ruling 270 exists: rulings 224 and
   * 230 each added an option payload and never added the field to the tool that
   * AUTHORS options, so the only actor that could have sent one could not.
   */
  it("ruling 287: the option schema carries `blocks`, and it reaches the stored packet", async () => {
    // Canary: drop `blocks` from the authoring schema, or from the forwarder
    // beneath it, and the reverse edge becomes unauthorable — a field the
    // resolver reads and nothing can ever write.
    const store = setupTestStore(ctxDb);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "impl" }),
    });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "triage" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    const open = toolkit.tools.find((t) => t.name === "open_decision_packet")!;
    // SAFETY: the SDK types a tool handler's argument as its own generic; this
    // object is the shape the zod schema above declares, and a field the schema
    // rejects fails the call rather than reaching the handler — which is the
    // assertion this test makes.
    const answer = await open.handler(
      {
        title: "The shapes this needs are not published",
        detail: "Three exports are missing and no task opens them.",
        options: [
          {
            kind: "create_task",
            title: "Create the contracts amendment",
            newTask: {
              title: "Contracts amendment: publish the webhook shapes",
              goal: "Three exports. The rest of the freeze stands.",
              blocks: ["VIB-9"],
            },
          },
        ],
      } as never,
      {} as never,
    );
    expect(JSON.stringify(answer)).toContain("[done]");
    // Read the FILE, which is the canonical record the resolver later reads —
    // not a projection, and not the tool's own reply about itself.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      `${store.dataRoot}/projects/${store.slug}/tasks/VIB-1/task.md`,
      "utf8",
    );
    expect(raw).toContain("blocks:");
    expect(raw).toContain("VIB-9");
  });

  /**
   * Ruling 270 (pass 37, F37-102): rulings 230 and 224 each added an option
   * kind with a payload, wrote the two authoring refusals for it, and never
   * added the field to the tool that AUTHORS options. So the operator could
   * name `block_on_dependencies`, be told "needs the work it waits on", and
   * have no way to say — and `block_on_dependencies` has no server-side writer
   * either, so nothing in the product could produce one. Both rulings' tests
   * called `operatorOpenPacket` directly, which accepts the field; the DOOR was
   * never exercised.
   */
  it("ruling 270: the option schema carries blockedBy and dueAt, the payloads two kinds are refused without", async () => {
    // Canary: remove either field from the option schema and its kind becomes
    // unauthorable again — named, refused, and impossible to satisfy.
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    const published = await publishedSchemas(toolkit.mcpServers.viberr);
    const declared = JSON.stringify(published.get("open_decision_packet"));
    expect(declared).toContain('"blockedBy"');
    expect(declared).toContain("block_on_dependencies only");
    expect(declared).toContain('"dueAt"');
    expect(declared).toContain("wait_for_window only");
    // Ruling 269's payload rides the same door, and was written with it.
    expect(declared).toContain('"newTask"');
    expect(declared).toContain("create_task only");
    // Ruling 650: and the flag that makes a send-back take the person's words.
    expect(declared).toContain('"reply"');
    expect(declared).toContain("redirect and request_edit only");
  });

  /**
   * Ruling 433 (F39-55): ruling 270 opened this door on the Claude tool and
   * left the Codex plan's closed. The same three kinds stayed named, refused
   * and impossible to satisfy for every Codex operator, and on ax-clone, where
   * every operator is Codex, that was AX-4 twice and AX-27 once. A new option
   * field is added to both doors or the suite goes red.
   */
  it("ruling 433: the Codex plan's option carries every field the Claude tool's option does", async () => {
    // CANARY: drop any option field from the Codex plan schema.
    const auth = authority([]);
    auth.policy.set("generate-packets", "direct");
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });
    const published = await publishedSchemas(toolkit.mcpServers.viberr);
    const claudeOption = z
      .object({
        properties: z.object({
          options: z.object({ items: z.object({ properties: z.record(z.string(), z.unknown()) }) }),
        }),
      })
      .parse(published.get("open_decision_packet")).properties.options.items.properties;
    const codexOption =
      operatorPlanSchemaFor(auth).properties.actions.items.properties.packetOptions.items.properties;
    expect(Object.keys(codexOption).sort()).toEqual(Object.keys(claudeOption).sort());
  });

  /**
   * Ruling 492 (F40-69): a done signal is something the task can show before
   * acceptance. Live on WEB-16 the operator's own `create_task` option
   * drafted "Done when, after the merge and the Workers Builds deploy, a
   * read-only post-merge read … shows the new field's value". Acceptance
   * closes a task (a person's also merges its PR; the operator's own leaves
   * the merge pending), so nothing after the merge happens inside it, and the
   * owner rewrote the goal by hand. Every goal field the operator writes
   * through said only "deliverable plus acceptance criteria".
   */
  it("ruling 492: every door the operator writes a goal through carries DONE_SIGNAL_RULE, on both backends", async () => {
    // CANARY: drop `DONE_SIGNAL_RULE` from any one door and its assertion
    // fails naming it.
    const auth = authority([]);
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });
    const published = await publishedSchemas(toolkit.mcpServers.viberr);
    // Each door's published description, "" when it has none, so a door that
    // lost its text fails by name instead of in the parse.
    const described = z.object({ description: z.string() });
    const setGoal = z
      .object({ properties: z.object({ goal: described }) })
      .transform((schema) => schema.properties.goal.description)
      .catch("");
    const goalDraft = z
      .object({
        properties: z.object({
          options: z.object({ items: z.object({ properties: z.object({ goalDraft: described }) }) }),
        }),
      })
      .transform((schema) => schema.properties.options.items.properties.goalDraft.description)
      .catch("");
    const newTaskGoal = z
      .object({
        properties: z.object({
          options: z.object({
            items: z.object({
              properties: z.object({
                newTask: z.object({ properties: z.object({ goal: described }) }),
              }),
            }),
          }),
        }),
      })
      .transform((schema) => schema.properties.options.items.properties.newTask.properties.goal.description)
      .catch("");
    const packet = published.get("open_decision_packet");
    // The Codex operator answers with a plan instead; its `set_goal` drafts
    // the goal in the action's `text`.
    const plan = operatorPlanSchemaFor(auth).properties.actions.items.properties;
    const doors: [string, string][] = [
      ["set_goal.goal", setGoal.parse(published.get("set_goal"))],
      ["open_decision_packet options[].goalDraft", goalDraft.parse(packet)],
      ["open_decision_packet options[].newTask.goal", newTaskGoal.parse(packet)],
      ["Codex plan text (set_goal)", plan.text.description],
      ["Codex plan packetOptions[].goalDraft", plan.packetOptions.items.properties.goalDraft.description],
      [
        "Codex plan packetOptions[].newTask.goal",
        plan.packetOptions.items.properties.newTask.properties.goal.description,
      ],
    ];
    for (const [door, description] of doors) {
      expect(description, `${door} does not carry DONE_SIGNAL_RULE`).toContain(DONE_SIGNAL_RULE);
    }
    // The plan's `text` serves every verb, so it says which one the rule is for.
    expect(plan.text.description).toContain("for set_goal: the drafted goal");
  });

  /**
   * Pass-35 cluster review: ONE description carried both halves of a
   * contradiction. Ruling 164's new sentence refuses "a custom option that asks
   * a person to edit an agent profile", while the older ruling-85 clause still
   * told the operator to offer exactly that ("offer it as an option beside any
   * workaround"). An operator following the second sentence burned a turn on
   * the first: `operatorOpenPacket` answers `noop`. Ruling 85's substance is
   * untouched (the remedy is still named); only the surface it is named ON is
   * settled here, which is what ruling 164 already says the refusal means.
   */
  it("ruling 85 and ruling 164 agree in one string: the remedy is named, never offered as an option", () => {
    // Canary: restore "and offer it as an option beside any workaround".
    const toolkit = buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("generate-packets", "direct");
        return auth;
      })(),
    });
    const def = toolkit.tools.find((t) => t.name === "open_decision_packet")!;
    // Ruling 85 still stands: the capability and where a human grants it.
    expect(def.description).toContain("grantable on an agent profile");
    expect(def.description).toContain("Agents surface");
    expect(def.description).toContain("lists only workarounds hides the fix");
    // Ruling 164 decides the surface, and nothing here contradicts it.
    expect(def.description).toContain("never write it as an OPTION");
    expect(def.description).not.toMatch(/offer it (as an option )?beside any workaround/i);
  });
});

/**
 * Pass-35 cluster review of ruling 162. `notAcceptableReason` is
 * `acceptanceRefusalFor`, i.e. the FIRST of EVERY acceptance gate, and its
 * third is `acceptanceStageBlockedReason` — "KNC-x is at Review, not Merge ...
 * Move the task through the workflow first." So the field stands on every task
 * short of the boundary, and the shipped texts keyed the MOVE into that stage
 * on it: the operator was told a legal, required move would be refused for
 * every task, by a sentence whose own remedy is that move.
 *
 * `mergeStageEntryRefusal` never read that field. It reads
 * `mergeReadinessRefusal` — a conflicting pull request or an unpushed
 * delivered revision — which is what F35-12(b) asked for, so the texts are what
 * was wrong.
 */
describe("buildOperatorToolkit — the acceptance-stage move reads the pull request, not the whole gate", () => {
  const toolkitFor = () =>
    buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: (() => {
        const auth = authority([]);
        auth.policy.set("stage-transitions", "direct");
        return auth;
      })(),
    });

  it("transition_stage names the pull request facts and does not key the move on notAcceptableReason", () => {
    // Canary: restore "refused while get_task shows `notAcceptableReason`".
    const def = toolkitFor().tools.find((t) => t.name === "transition_stage")!;
    expect(def.description).toContain("Merge means mergeable");
    expect(def.description).toContain("`pr.unpushedRevision`");
    expect(def.description).not.toMatch(
      /refused while get_task shows `notAcceptableReason`/,
    );
    // And it says outright that the field is not a reason to hold the task.
    expect(def.description).toContain("never read it as a refusal to advance");
  });

  it("get_task keeps notAcceptableReason for the acceptance verbs and says what else it covers", () => {
    // Canary: restore "the task cannot be moved into the acceptance stage".
    const def = toolkitFor().tools.find((t) => t.name === "get_task")!;
    expect(def.description).toContain("`notAcceptableReason`");
    expect(def.description).not.toMatch(/cannot be moved into the\s+acceptance stage/);
    expect(def.description).toContain("has simply not reached the boundary yet");
  });
});

/**
 * Ruling 521's door: a decision that offers acceptance carries the completion
 * packet, and the tool its refusal names is mounted on the same grant as the
 * offer. The writer's own refusals are the completion-packet suite's; the
 * check itself sits in `operatorOpenPacket`, after the boundary check, so both
 * backends meet it.
 */
describe("buildOperatorToolkit — the completion packet goes with the acceptance decision (ruling 521)", () => {
  it("refuses a decision offering accept_completion until write_completion_packet describes the delivered revision", async () => {
    // CANARY: drop the check from `operatorOpenPacket` and the first open
    // files a decision whose card has nothing summarized on it.
    const store = setupTestStore(ctxDb);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "review",
        validation: "healthy",
        ownerUserId: store.users.arda.id,
        operator: { assignedAtStageId: "triage" },
        branch: "vib-1-work",
        workRevision: {
          id: "rev_1",
          headSha: "a".repeat(40),
          treeSha: "t".repeat(40),
          branch: "vib-1-work",
          createdAt: "2026-09-27T09:00:00.000Z",
          sourceProfileId: "developer",
        },
        github: { commits: [], changed: { files: 1, add: 12, del: 3 } },
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    writeTaskAttachment(
      store.slug,
      "VIB-1",
      "after.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      store.dataRoot,
    );
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      authority: authority([]),
    });
    const decision = {
      packetType: "input",
      title: "Accept the attach flow",
      body: "The work is delivered and reviewed.",
      options: [
        { kind: "accept_completion", title: "Accept and move to Done", recommended: true },
        { kind: "request_edit", title: "Ask for one more fix" },
      ],
    };
    const summary = {
      summary: "One repository per task.",
      screenshots: [{ name: "after.png", caption: "The attach dialog" }],
    };
    // SAFETY: the SDK types a handler's argument as its own generic; each
    // object here is the shape the tool's zod schema declares.
    const call = async (name: string, args: typeof decision | typeof summary) =>
      JSON.stringify(
        await toolkit.tools.find((t) => t.name === name)!.handler(args as never, {} as never),
      );
    const packet = () =>
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
        .parsed.packet;

    const refused = await call("open_decision_packet", decision);
    expect(refused).toContain("[noop]");
    expect(refused).toContain(
      "Write the completion packet for revision `aaaaaaa` first (write_completion_packet)",
    );
    expect(packet()).toBeNull();

    expect(await call("write_completion_packet", summary)).toContain("[done]");
    expect(await call("open_decision_packet", decision)).toContain("[done]");
    expect(packet()!.options.map((o) => o.kind)).toEqual(["accept_completion", "request_edit"]);
  });
});
