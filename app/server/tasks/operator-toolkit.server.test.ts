import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { saveMcpServer } from "~/server/org/resources.server";
import {
  buildOperatorToolkit,
  OPERATOR_TOOLKIT_INSTRUCTIONS,
} from "./operator-toolkit.server";
import type { OperatorAuthority } from "./operator-actions.server";
import { operatorPlanToolsFor } from "~/server/runtimes/operator-run.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctxDb = createTestDbContext();
afterEach(() => ctxDb.cleanup());

const ACTOR = { userId: "u_t", label: "t@test" };

/** The instructions string as the MOUNTED server carries it: `createSdkMcpServer`
 *  hands back the live `McpServer` under `instance`, and `instance.server` is its
 *  `Server` handle, which keeps the instructions in `_instructions`. */
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
 * (`operatorPlanToolsFor`, operator-run.server) are two hand-maintained lists
 * with no shared generator. They MUST expose the same governed-action vocabulary
 * for the same authority, or an operator would silently be able to do different
 * things on Codex than on Claude. This pins that parity: add a governed action
 * to one list but not the other and this fails — the guard F21-3 already gives
 * OPERATOR_READ_ONLY_DENIED_TOOLS via capability-denylist-markers.test.
 */
describe("buildOperatorToolkit ↔ operatorPlanToolsFor governed-action parity (F27-O3)", () => {
  // get_task / read_default_branch_file are read-only Claude tools with no plan
  // mirror (Codex gets that information embedded in its prompt). The two packet
  // tools carry different display names either side; everything else matches.
  const READ_ONLY = new Set(["get_task", "read_default_branch_file"]);
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
    // toolkit floor is just `get_task`. What "read-only" excludes is every
    // WRITE, and that is what this asserts: the floor is exactly the one read,
    // and nothing that changes state is reachable.
    expect(toolkit.allowedTools).toEqual(["mcp__viberr__get_task"]);
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
describe("OPERATOR_TOOLKIT_INSTRUCTIONS — reading is expected, writing is not (R19-1)", () => {
  it("states the write prohibition precisely and stops forbidding reads", () => {
    // Canary: restore the "never write code or touch the repository" sentence
    // and every half fails.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toContain("never write code");
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(/cannot edit, create or commit files/);
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toContain("READING the task's repository checkout");
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).not.toMatch(/touch the repository/);
    // The claim-grounding rule the packets depend on, restated where the tools
    // that WRITE those packets are described.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(
      /claim you make about the repository must come from reading it/,
    );
  });

  it("does NOT claim the operator cannot push — delivery is its decision (R15-2)", () => {
    // The over-correction that would break the product: `deliver_for_review`
    // pushes the deliverer's committed branch, and both the operator definition
    // and the tool description tell the model delivery is its call. A blanket
    // "you cannot push the repository" here is a third channel contradicting
    // them, and the careful resolution is an operator that stops delivering.
    // Canary: put "or push the repository" back into the constant and this
    // fails.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).not.toMatch(/or push the repository/);
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(
      /delivery is a decision you make and the server executes/,
    );
  });

  it("is the string the viberr MCP server actually carries", () => {
    // Pins the WIRING, not just the constant: a run reads the server's
    // instructions, not this module's exports. (Reaches into the SDK server's
    // private field — if the SDK moves it, this fails loudly rather than
    // passing while the operator reads something else.)
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    // `_instructions` is `private` on the MCP SDK's `Server`, so no narrowing
    // reaches it — and reading THAT field is the point of this test: it proves
    // the run's server carries the instructions, not merely that this module
    // exports them. Read it the way any other opaque payload is read here, by
    // parsing the shape we expect; a rename in the SDK falls through to `""`
    // and fails the assertion below instead of passing on `undefined`.
    const wired = wiredInstructions.parse(toolkit.mcpServers.viberr);
    expect(wired).toBe(OPERATOR_TOOLKIT_INSTRUCTIONS);
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
