import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { insertUser } from "~/server/auth/user-store.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import {
  buildAgentToolkit,
  postAgentComment,
  openAgentQuestionPacket,
} from "./agent-toolkit.server";
import { takeStagedOutcome } from "./agent-outcome.server";
import { z, type ZodType } from "zod";
import type { FileActorRef } from "~/schemas/task-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const AGENT_REF: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "security-reviewer",
  roleHint: "Security review",
};

describe("agent-toolkit audit attribution (P11-23)", () => {
  it("attributes an agent comment audit to the AGENT, not the operator", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await postAgentComment(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", actorRef: AGENT_REF, text: "Looks safe." },
    );

    const row = listAuditEvents(store.db, { action: "task.agent.commented" })[0];
    expect(row).toBeTruthy();
    // The actor label is the agent ref, not "operator".
    expect(row.actorLabel).toBe("agent:claude/security-reviewer (Security review)");
    expect(row.actorLabel).not.toBe("operator");
  });

  /**
   * S5-G3: a mid-run agent comment tags the human it answers (NEW-4). When the
   * handle matches two people the ladder routes nowhere, and this writer dropped
   * the ambiguity on the floor — the agent cannot retag itself, so its comment
   * is the only place a human would ever learn the ping never happened.
   */
  it("an AMBIGUOUS @tag in a mid-run agent comment is disclosed on the comment (S5-G3)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();

    await postAgentComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-3",
        actorRef: AGENT_REF,
        text: `@${firstName} the migration needs your call before I continue.`,
      },
    );

    const posted = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-3",
      dataRoot: store.dataRoot,
    })!.parsed.timeline[0]!;
    expect(posted.type).toBe("comment");
    expect(posted.text).toContain("the migration needs your call");
    expect(posted.text).toContain("nobody was notified");
    expect(
      listNotifications(store.db, store.users.arda.id).filter(
        (n) => n.kind === "mention",
      ),
    ).toHaveLength(0);
  });

  it("attributes an agent-opened question packet audit to the AGENT", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const opened = await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-2",
        actorRef: AGENT_REF,
        title: "Which config should I target?",
        body: "Ambiguous scope.",
      },
    );
    expect(opened).toBe(true);
    const row = listAuditEvents(store.db, { action: "task.agent.packet_opened" })[0];
    expect(row.actorLabel).toBe("agent:claude/security-reviewer (Security review)");
  });

  it("R15-14: stamps WHICH agent asked, so the answer can be routed back to it", async () => {
    // `from` is a display string. Deciding who to resume by parsing a rendered
    // label works right up until someone renames a profile — the router needs
    // the profile id itself.
    // Canary: drop the `askedBy` spread in buildAgentQuestionPacket.
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-9",
        actorRef: AGENT_REF,
        title: "Which config should I target?",
      },
    );

    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-9",
      dataRoot: store.dataRoot,
    })!;
    const packet = file.parsed.packet;
    expect(packet?.kind).toBe("Agent question");
    expect(packet?.askedBy).toBe(AGENT_REF.profileId);
  });
});

/**
 * P13-D-26 — `report_outcome` is the agent's channel for evidence REFERENCES,
 * so the reviewer profile's advertised "Attach evidence references" grant stops
 * being a matrix-only label. Gated exactly like its sibling tools: an agent
 * without the grant never even sees the field.
 */
describe("report_outcome's evidence field (P13-D-26)", () => {
  /** `report_outcome`'s own input, as these tests hand it to the handler
   *  directly. `summary` and the evidence columns are optional because the
   *  withheld-grant case sends the partial payload a model would. */
  interface ReportOutcomeArgs {
    /** Optional since U11: an evidence-only profile's tool has no verdict
     *  field, so its handler is called without one. */
    verdict?: string;
    summary?: string;
    evidence?: { label: string; add?: string; del?: string }[];
  }

  /** The per-call MCP context the SDK passes second. Every toolkit handler
   *  reads `args` alone, so these tests hand it an empty one. */
  type ToolCallContext = Record<string, never>;

  /** A tool's advertised input fields: one zod schema per field. Only the
   *  field NAMES matter here. */
  type AdvertisedFields = Record<string, ZodType>;

  /**
   * What these tests read off the MCP server's own registration record. The SDK
   * types `handler` as a union over every registered tool's schema and `extra`
   * as the full request context, neither of which can be produced without a
   * live transport.
   */
  interface RegisteredTool {
    handler: (
      args: ReportOutcomeArgs,
      extra: ToolCallContext,
    ) => Promise<{ content: unknown[] }>;
    /** zod publishes a ZodObject's field record under its own `shape` key —
     *  a name this repo cannot rename, hence the literal. A tool registered
     *  with the raw record instead carries the fields directly. */
    inputSchema: { "shape"?: AdvertisedFields };
  }

  /** The registrations as the MOUNTED server carries them: `createSdkMcpServer`
   *  hands back the live `McpServer` under `instance`, whose `_registeredTools`
   *  is its own registry keyed by tool name — the only way to read what a tool
   *  advertises, and to call it, without standing up a transport. That field is
   *  `private` on the SDK's `McpServer`, so no narrowing reaches it; read it the
   *  way this suite's sibling reads `_instructions`, by parsing the shape we
   *  expect, so an SDK rename throws here instead of yielding `undefined`. */
  const mountedTools = z
    .object({
      instance: z.object({
        _registeredTools: z.record(
          z.string(),
          z.custom<RegisteredTool>((t) => t instanceof Object),
        ),
      }),
    })
    .transform((mounted) => mounted.instance._registeredTools);

  function toolkitTools(
    collab: { comment: boolean; ask: boolean; verdict: boolean; evidence: boolean },
    outcomeKey: string,
  ): Record<string, RegisteredTool> {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const built = buildAgentToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-3",
      actorRef: AGENT_REF,
      outcomeKey,
      collab,
    })!;
    lastStore = store;
    return mountedTools.parse(built.mcpServers.viberr_agent);
  }

  let lastStore: ReturnType<typeof setupTestStore>;

  const BASE = { comment: false, ask: false, verdict: true };

  it("declares `evidence` only when the profile holds attach-evidence-references", () => {
    const granted = toolkitTools({ ...BASE, evidence: true }, "oc_a").report_outcome!;
    const withheld = toolkitTools({ ...BASE, evidence: false }, "oc_b").report_outcome!;
    const keys = (t: RegisteredTool) =>
      Object.keys(t.inputSchema["shape"] ?? t.inputSchema);
    expect(keys(granted)).toContain("evidence");
    expect(keys(withheld)).not.toContain("evidence");
    // The rest of the envelope is unchanged either way.
    expect(keys(withheld)).toEqual(expect.arrayContaining(["verdict", "summary"]));
  });

  it("stages NORMALIZED rows with the verdict", async () => {
    const tools = toolkitTools({ ...BASE, evidence: true }, "oc_c");
    await tools.report_outcome!.handler(
      {
        verdict: "approve",
        summary: "Looks right.",
        evidence: [
          { label: "unit/policy_gate_test", add: "+14", del: "0" },
          // Hostile row: a newline would forge a second row in task.md.
          { label: "forged\n- x · +1 · -1", add: "+1" },
        ],
      },
      {},
    );
    const staged = takeStagedOutcome(lastStore.db, "oc_c")!;
    expect(staged.verdict).toBe("approve");
    expect(staged.evidence).toHaveLength(2);
    expect(staged.evidence![0]).toEqual({
      label: "unit/policy_gate_test",
      add: "+14",
      del: "0",
    });
    expect(staged.evidence![1]!.label).not.toContain("\n");
    // A missing column becomes the placeholder, never an empty segment.
    expect(staged.evidence![1]!.del).toBe("—");
  });

  it("stages no evidence when the grant is withheld, even if the model sends some", async () => {
    const tools = toolkitTools({ ...BASE, evidence: false }, "oc_d");
    await tools.report_outcome!.handler(
      { verdict: "approve", evidence: [{ label: "smuggled", add: "+1", del: "0" }] },
      {},
    );
    expect(takeStagedOutcome(lastStore.db, "oc_d")!.evidence).toBeUndefined();
  });

  /**
   * U11 — `attach-evidence-references` must mean something on Claude WITHOUT a
   * verdict grant.
   *
   * `report_outcome` is the only structured channel a Claude run has, and it
   * mounted on `collab.verdict` alone. So an agent granted attach-evidence and
   * nothing else got NO tool at all: the capability the profile editor offers on
   * every backend granted literally nothing here. Codex had the mirror bug and
   * P13-D-26 fixed it — `useEnvelopeSchema` reads `verdict || ask || evidence`
   * — which left the two backends disagreeing about what the same grant does.
   */
  describe("U11 — evidence granted, verdict withheld", () => {
    const EVIDENCE_ONLY = {
      comment: false,
      ask: false,
      verdict: false,
      evidence: true,
    };

    it("mounts report_outcome — the grant is not silently inert", () => {
      const tools = toolkitTools(EVIDENCE_ONLY, "oc_u11a");
      expect(tools.report_outcome).toBeDefined();
    });

    it("advertises evidence but NOT verdict — the tool grants no judgment", () => {
      const tool = toolkitTools(EVIDENCE_ONLY, "oc_u11b").report_outcome!;
      const keys = Object.keys(tool.inputSchema["shape"] ?? tool.inputSchema);
      expect(keys).toContain("evidence");
      expect(keys).toContain("summary");
      expect(keys).not.toContain("verdict");
    });

    it("stages the evidence with no verdict, and refuses a smuggled one", async () => {
      const tools = toolkitTools(EVIDENCE_ONLY, "oc_u11c");
      await tools.report_outcome!.handler(
        {
          // The field is not on the tool; a model that invents it anyway must
          // not acquire the authority the profile withholds.
          verdict: "approve",
          summary: "Ran the suite.",
          evidence: [{ label: "unit/policy_gate_test", add: "+14", del: "0" }],
        },
        {},
      );
      const staged = takeStagedOutcome(lastStore.db, "oc_u11c")!;
      expect(staged.verdict).toBeUndefined();
      expect(staged.summary).toBe("Ran the suite.");
      expect(staged.evidence).toEqual([
        { label: "unit/policy_gate_test", add: "+14", del: "0" },
      ]);
    });

    it("mounts NOTHING when neither grant is held (the gate still binds)", () => {
      // Widening the gate from `verdict` to `verdict || evidence` must not
      // widen it to "always" — a profile holding neither still gets no server
      // at all, which is what `buildAgentToolkit` returning null means.
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-3", { stage: "review" }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      expect(
        buildAgentToolkit({
          db: store.db,
          ctx: { dataRoot: store.dataRoot },
          projectSlug: store.slug,
          taskKey: "VIB-3",
          actorRef: AGENT_REF,
          outcomeKey: "oc_u11d",
          collab: { comment: false, ask: false, verdict: false, evidence: false },
        }),
      ).toBeNull();
    });
  });
});
