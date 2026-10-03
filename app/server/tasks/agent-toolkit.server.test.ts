import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { toolLoading } from "../../../test-support/mcp-tool-meta";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createPat, setProjectCredential } from "~/server/secrets/pat-store.server";
import { insertUser } from "~/server/auth/user-store.server";
import { patchRun, upsertRun } from "~/server/runtimes/run-store.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import { setNotifRoutingPref } from "~/features/profile/profile-actions.server";
import {
  buildAgentToolkit,
  postAgentComment,
  openAgentQuestionPacket,
} from "./agent-toolkit.server";
import { takeStagedOutcome } from "./agent-outcome.server";
import { z, type ZodType } from "zod";
import type { FileActorRef, Recommendation } from "~/schemas/task-file.schema";

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

  /**
   * Ruling 222 (F37-42): the audit row above has named the agent since P11-23.
   * The NOTIFICATION for the same event did not — `notifyTaskWatchers` stamps
   * `OPERATOR_NOTIFY_FROM` on any notice that names nobody, so the owner's
   * inbox announced an agent's question under the Operator's name and avatar,
   * on the one surface whose chip IS "who wants something from you". Live on
   * SHOP-18, the Frontend Engineer's question about a missing catalog contract
   * arrived as "Operator·SHOP-18 cannot satisfy its required filter/facet
   * sidebar…" — the agent's own words, over the operator's name.
   */
  it("attributes the question NOTIFICATION to the agent too, not the operator (ruling 222)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-9",
        actorRef: AGENT_REF,
        title: "Publish the catalog facet contract",
        body: "The frozen contract has no facet endpoint.",
      },
    );

    const note = listNotifications(store.db, store.users.arda.id).find(
      (n) => n.kind === "question" && n.taskKey === "VIB-9",
    );
    expect(note, "the owner must hear about a question put to them").toBeTruthy();
    // CANARY: drop the `notice.from` and this is { kind: "agent", name:
    // "Operator" } — the default every un-attributed notice falls back to.
    expect(note!.from).toMatchObject({ kind: "agent", name: "Security review" });
    expect(note!.from).not.toMatchObject({ name: "Operator" });
  });

  /**
   * Ruling 481(a) (F40-48): the question is filed as what it is. As `approval`
   * it wore the stage arrow and the "approval" pill, and "Approval requests"
   * off (a person quieting stage traffic) meant no bell row and no "Waiting on
   * you" row for any agent question, with nothing on that toggle saying so.
   *
   * Canary: write `kind: "approval"` in `openAgentQuestionPacket` again and
   * the owner with approvals silenced gets nothing.
   */
  it("files an agent's question as a `question` that waits on the owner and ignores the approvals toggle (ruling 481)", async () => {
    const store = setupTestStore(ctx);
    const owner = store.users.arda.id;
    setNotifRoutingPref(store.db, owner, "approvals", false);
    for (const key of ["VIB-9", "VIB-8"]) {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter(key, { stage: "impl", ownerUserId: owner }),
      });
    }
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-9",
        actorRef: AGENT_REF,
        title: "Connect the Worker to Workers Builds",
        body: "Only the owner can press Connect.",
      },
    );

    const mine = listNotifications(store.db, owner).filter((n) => n.taskKey === "VIB-9");
    expect(mine.map((n) => n.kind)).toEqual(["question"]);
    expect(mine[0]!.title).toBe("Security review asks: Connect the Worker to Workers Builds");
    expect(mine[0]!.waitingOnYou).toBe(true);

    // Its own toggle is the one that silences it.
    setNotifRoutingPref(store.db, owner, "questions", false);
    const opened = await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-8",
        actorRef: AGENT_REF,
        title: "Another question",
      },
    );
    expect(opened).toBe(true);
    expect(listNotifications(store.db, owner).filter((n) => n.taskKey === "VIB-8")).toEqual([]);
  });

  it("ruling 137: an agent's question withdraws the standing acceptance offers on the record", async () => {
    // Canary: remove the `withdrawAcceptanceOffers` call in
    // openAgentQuestionPacket and the accept card outlives the question.
    const store = setupTestStore(ctx);
    const cards: Recommendation[] = [
      { id: "r-accept", kind: "accept_completion", toStageId: "done", label: "Accept completion and move VIB-2 to Done", detail: "", forHeadSha: "a".repeat(40) },
      { id: "r-done", kind: "transition", toStageId: "done", label: "Move to Done", detail: "" },
      { id: "r-run", kind: "run_agent", profileId: "developer", label: "Run Developer", detail: "" },
    ];
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "review", recommendations: cards }),
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
      },
    );
    expect(opened).toBe(true);
    const parsed = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-2", dataRoot: store.dataRoot })!.parsed;
    // The accept card AND the terminal transition card (an acceptance too) go;
    // the run_agent card survives.
    expect(parsed.frontmatter.recommendations.map((r) => r.id)).toEqual(["r-run"]);
    const note = parsed.timeline.find((e) => e.type === "note" && e.title === "Recommendation withdrawn");
    expect(note?.actor).toEqual(AGENT_REF);
    expect(note?.text).toContain('a decision packet opened ("Which config should I target?")');
    const row = listAuditEvents(store.db, { action: "task.recommendation.withdrawn" })[0]!;
    expect(row.actorLabel).toBe("agent:claude/security-reviewer (Security review)");
    expect(row.details).toMatchObject({ cause: "packet", surviving: 1 });
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
    evidence?: { label: string; result?: string; status?: string }[];
    /** F4: the only field `github_read`'s handler reads — the report_outcome
     *  handlers ignore it, so one shared arg type serves both tools here. */
    path?: string;
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
    collab: {
      comment: boolean;
      ask: boolean;
      verdict: boolean;
      evidence: boolean;
      githubRead?: boolean;
    },
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
      collab: { ...collab, githubRead: collab.githubRead ?? false },
      kb: [],
    })!;
    lastStore = store;
    return mountedTools.parse(built.mcpServers.viberr_agent);
  }

  /** The live server for one build, so a call crosses real validation. */
  function mountFor(collab: { comment: boolean; ask: boolean; verdict: boolean; evidence?: boolean; githubRead?: boolean }) {
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
      outcomeKey: "ok_max_options",
      collab: {
        ...collab,
        evidence: collab.evidence ?? false,
        githubRead: collab.githubRead ?? false,
      },
      kb: [],
    })!;
    lastStore = store;
    return built.mcpServers.viberr_agent;
  }

  /**
   * Ruling 298 (pass 37, F37-133). The cap was always four; it used to be
   * applied by a silent `.slice(0, 4)` in the packet builder, so an agent that
   * offered five got a decision card with four and nobody -- agent or person --
   * was told a choice had been removed. It is declared on the schema now, so a
   * fifth is refused by name, nothing is written, and the agent re-asks inside
   * the same run at no cost.
   */
  it("ruling 298: a fifth answer choice is refused by name, not trimmed away", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = mountFor({ ...BASE, ask: true });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverEnd);
    const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
    await client.connect(clientEnd);

    const five = ["a", "b", "c", "d", "e"].map((t) => ({ title: t }));
    const refused = await client.callTool({
      name: "ask_human",
      arguments: { title: "Which DB?", options: five },
    });
    const text = z
      .object({ content: z.array(z.object({ text: z.string() })) })
      .parse(refused)
      .content.map((c) => c.text)
      .join("\n");
    // CANARY: drop `.max(ASK_HUMAN_MAX_OPTIONS)` and this answers "[done]".
    expect(text).toMatch(/too big|at most|maximum|expected array to have/i);
    // Nothing was written: no packet reached the task.
    const after = readTaskFile({
      projectSlug: lastStore.slug,
      taskKey: "VIB-3",
      dataRoot: lastStore.dataRoot,
    })!;
    expect(after.parsed.packet).toBeFalsy();

    // And four still works, so this is a bound and not a wall.
    const ok = await client.callTool({
      name: "ask_human",
      arguments: { title: "Which DB?", options: five.slice(0, 4) },
    });
    expect(JSON.stringify(ok)).not.toMatch(/too big|at most|maximum/i);
  });

  /**
   * Ruling 488 (F40-67): a specialist reaches another task through the report
   * it already makes. `relay` rides every variant of `report_outcome`, holds
   * at most two entries (a third is refused by name, so the agent re-reports
   * inside the same run), and is staged with the outcome for the completion
   * pipeline to post.
   */
  it("ruling 488: report_outcome stages up to two relay entries and refuses a third by name", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    // Evidence only: the WEB-9 Platform Engineer's shape, no verdict grant.
    const server = mountFor({ comment: false, ask: false, verdict: false, evidence: true });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverEnd);
    const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
    await client.connect(clientEnd);
    const toolText = z
      .object({ content: z.array(z.object({ text: z.string() })) })
      .transform((r) => r.content.map((c) => c.text).join("\n"));

    const three = ["VIB-8", "VIB-9", "VIB-10"].map((taskKey) => ({ taskKey, text: `For ${taskKey}.` }));
    // CANARY: drop `.max(RELAY_MAX_ENTRIES)` and this stages all three.
    expect(
      toolText.parse(await client.callTool({ name: "report_outcome", arguments: { summary: "Done.", relay: three } })),
    ).toMatch(/too big|at most|maximum|expected array to have/i);

    // CANARY: drop the `relay` field from the tool (the call is refused as an
    // unknown key), or stop copying it onto the staged outcome.
    const ok = toolText.parse(
      await client.callTool({ name: "report_outcome", arguments: { summary: "Done.", relay: three.slice(0, 2) } }),
    );
    expect(ok).toContain("2 relay(s) to VIB-8, VIB-9, posted there when you finish");
    expect(takeStagedOutcome(lastStore.db, "ok_max_options")!.relay).toEqual([
      { taskKey: "VIB-8", text: "For VIB-8." },
      { taskKey: "VIB-9", text: "For VIB-9." },
    ]);
  });

  /**
   * Ruling 526: the timeline draws an outcome's rows as a checklist, so each
   * row says how it came out and carries its mark. A row without one is
   * refused by name, nothing is staged, and the agent re-reports inside the
   * same run.
   */
  it("ruling 526: report_outcome refuses an evidence row with no mark, and stages a marked one", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = mountFor({ ...BASE, verdict: true, evidence: true });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverEnd);
    const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
    await client.connect(clientEnd);
    const toolText = z
      .object({ content: z.array(z.object({ text: z.string() })) })
      .transform((r) => r.content.map((c) => c.text).join("\n"));

    // CANARY: make `status` optional on the row and this stages an unmarked row.
    const refused = toolText.parse(
      await client.callTool({
        name: "report_outcome",
        arguments: { verdict: "approve", summary: "Done.", evidence: [{ label: "npm test", result: "102 passed" }] },
      }),
    );
    expect(refused).toMatch(/status/);
    expect(takeStagedOutcome(lastStore.db, "ok_max_options")).toBeNull();

    await client.callTool({
      name: "report_outcome",
      arguments: {
        verdict: "request_changes",
        summary: "One blocker.",
        evidence: [
          { label: "npm test", result: "102 passed, 0 failed", status: "pass" },
          { label: "README.md:23 against the Output contract", status: "fail" },
        ],
      },
    });
    expect(takeStagedOutcome(lastStore.db, "ok_max_options")!.evidence).toEqual([
      { label: "npm test", result: "102 passed, 0 failed", status: "pass" },
      { label: "README.md:23 against the Output contract", result: "", status: "fail" },
    ]);
  });

  /**
   * Ruling 478(e) (F40-31, F40-57): `ask_human` lets the agent say a choice
   * needs a typed answer, and tells it an unmarked list recommends nothing.
   */
  it("ruling 478(e): a `reply` choice reaches the packet, and an unmarked list recommends nothing", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = mountFor({ ...BASE, ask: true });
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverEnd);
    const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
    await client.connect(clientEnd);

    const listed = await client.listTools();
    const ask = listed.tools.find((t) => t.name === "ask_human");
    // CANARY: put "(first is presented as suggested)" back in the description.
    expect(JSON.stringify(ask?.inputSchema)).toContain("an unmarked list carries none");
    expect(JSON.stringify(ask?.inputSchema)).not.toMatch(/presented as suggested/);

    await client.callTool({
      name: "ask_human",
      arguments: {
        title: "Is Workers Builds connected?",
        options: [
          { title: "Connected; the first build succeeded", reply: true },
          { title: "Not yet" },
        ],
      },
    });
    const packet = readTaskFile({
      projectSlug: lastStore.slug,
      taskKey: "VIB-3",
      dataRoot: lastStore.dataRoot,
    })!.parsed.packet!;
    // CANARY: drop `if (o.reply) option.reply = true;` in the tool handler.
    expect(packet.options.map((o) => [o.reply ?? false, o.rec])).toEqual([
      [true, false],
      [false, false],
    ]);
    // Ruling 586: the question's entry carries the card, which leaves the task
    // when it is answered. CANARY: write the title alone again.
    const asked = readTaskFile({ projectSlug: lastStore.slug, taskKey: "VIB-3", dataRoot: lastStore.dataRoot })!
      .parsed.timeline.find((e) => e.type === "blocked");
    expect(asked?.text).toBe(
      "**Question for a human:** Is Workers Builds connected?\n\nOptions: Connected; the first build succeeded · Not yet",
    );
  });

  let lastStore: ReturnType<typeof setupTestStore>;

  const BASE = { comment: false, ask: false, verdict: true };

  it("loads every collaboration tool up front (Option D PR 4(a))", () => {
    // Canary: drop `alwaysLoad: true` from the viberr_agent server.
    const store = setupTestStore(ctx);
    const built = buildAgentToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-3",
      actorRef: AGENT_REF,
      outcomeKey: "oc_load",
      collab: { comment: true, ask: true, verdict: true, evidence: true, githubRead: true },
      kb: [],
    })!;
    const loading = toolLoading(built.mcpServers.viberr_agent);
    expect(loading.deferred).toEqual([]);
    expect(loading.loaded).toEqual(
      expect.arrayContaining(["report_outcome", "post_comment", "github_read"]),
    );
  });

  /**
   * Ruling 339 (pass 37, F37-175): the run record disclosed a toolkit it had
   * derived a SECOND time, from three of the six gates, and so under-reported
   * what it mounted on 460 of the 834 specialist runs of the shopify-clone
   * pass: `github_read` on 460, `read_board` on 307, `read_knowledge_doc` on
   * 294, `report_outcome` on 227 (its real gate is `verdict || evidence`, and
   * the record read `verdict` alone).
   *
   * `toolNames` comes off the definitions the builder just pushed, so the only
   * way to make this red again is to restate the gates somewhere.
   */
  it("ruling 339: the toolkit reports exactly the tools it mounted", () => {
    // Canary: return a hand-built list from `buildAgentToolkit` instead of
    // `tools.map((t) => t.name)`.
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
      outcomeKey: "oc_names",
      // The exact combination the old record got wrong: no comment, no ask, and
      // `evidence` rather than `verdict` carrying `report_outcome`.
      collab: {
        comment: false,
        ask: false,
        verdict: false,
        evidence: true,
        githubRead: true,
      },
      kb: ["shopify-clone-conventions"],
    })!;
    const mounted = Object.keys(
      mountedTools.parse(built.mcpServers.viberr_agent),
    ).sort();
    expect([...built.toolNames].sort()).toEqual(mounted);
    // Named, so a gate that stops mounting its tool is a failure here and not
    // a silently shorter list agreeing with itself.
    expect(mounted).toEqual([
      "correct_knowledge_doc",
      "github_read",
      "read_board",
      "read_knowledge_doc",
      "read_task_attachment",
      "read_timeline_entry",
      "report_outcome",
    ]);
  });

  /**
   * Ruling 281 (pass 37, F37-114): an agent could read its repository and not
   * the board it works on. A task key it was TOLD about — in a document, a
   * directive, another agent's report — could not be checked.
   *
   * The cost, measured: `services/cart/DESIGN.md:458` claimed "SHOP-39 was
   * created for this gap". Two agents on SHOP-26 read it, correctly refused to
   * trust a document's claim about the board ("a task named in a document is
   * not a task until someone checks"), and had no way to check. The operator
   * re-raised a decision already made, and its recommended option would have
   * created a second task carrying SHOP-39's title word for word.
   */
  it("ruling 281: read_board answers a key, lists the board, and denies a key that is not there", async () => {
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_board");
    const read = tools.read_board!;
    // Ungranted: every fact here is already in the agent's own prompt for its
    // OWN task, so the gap was never permission — it was the tasks beside it.
    // CANARY: put it behind a `collab` flag and the profiles that hit this
    // (a reviewer, a builder reading a DESIGN.md) are the ones without it.
    expect(read).toBeTruthy();
    const store = lastStore;
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "impl" }),
      goal: "Serve the published batch contract.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const call = async (args: { taskKey?: string }) => {
      // SAFETY: every tool in this toolkit answers the text shape
      // `{ content: [{ type: "text", text }] }`; a change fails the parse
      // below rather than reading undefined.
      const out = (await read.handler(
        args as never,
        {} as never,
      )) as { content: { text: string }[] };
      return out.content[0]!.text;
    };

    const one = await call({ taskKey: "VIB-9" });
    expect(one).toContain('"key": "VIB-9"');
    expect(one).toContain("Serve the published batch contract");
    // CANARY: drop the `stage`/`waitsOn` fields and "is this live, and is it
    // waiting on me" stops being answerable, which is the question.
    expect(one).toContain('"stage"');
    expect(one).toContain('"waitsOn"');

    const all = await call({});
    expect(all).toContain('"key": "VIB-3"');
    expect(all).toContain('"key": "VIB-9"');

    // The answer that prompted the whole tool: a key that is not on this board
    // is a claim that was wrong, said plainly.
    // CANARY: return an empty object for a miss and the agent cannot tell
    // "not here" from "here with nothing in it".
    const missing = await call({ taskKey: "VIB-404" });
    expect(missing).toContain("[noop] No task VIB-404 in this project");
    expect(missing).toContain("that claim is wrong");
  });

  it("ruling 563: read_timeline_entry reads one entry of this task whole", async () => {
    // The prompt clips each entry at 220 characters and names the stamp of a
    // clipped one; this is the other half. CANARY: leave it unbuilt and the
    // stamp names an address nothing can read.
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_entry");
    const read = tools.read_timeline_entry!;
    expect(read).toBeTruthy();
    const store = lastStore;
    const answer = "1=Shared tenancy.\n2=RDS for SQL Server.\n3=FSx ONTAP at 128 MB/s.\n4=FSx Windows at 64 MB/s.";
    // The toolkit's own task: the tool reads that one only.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl" }),
      timeline: [
        {
          occurredAt: "2026-09-28T18:43:03.831Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: "Arda" },
          title: null,
          text: answer,
          toAgent: true,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // SAFETY: every tool in this toolkit answers `{ content: [{ type: "text", text }] }`.
    const out = (await read.handler({ occurredAt: "2026-09-28T18:43:03.831Z" } as never, {} as never)) as {
      content: { text: string }[];
    };
    expect(out.content[0]!.text).toContain(JSON.stringify(answer));
  });

  /**
   * Ruling 644: a stamp names every entry written with it. A verdict's quality
   * marker and its report comment land in one millisecond, and the read took
   * the first in the file: on AWSC-96 the Estimate Judge asked for its own
   * earlier verdict, got the marker, and rebuilt the score split from memory.
   * CANARY: `find` instead of `filter` and the report never comes back.
   *
   * Ruling 645: in the order they were written. The file holds them newest
   * first; on AWSC-97 the Judge read the first listed as the first sent.
   * CANARY: drop the `.reverse()` and the marker comes back before its report.
   */
  it("ruling 644: read_timeline_entry returns every entry a stamp names, in the order they were written", async () => {
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_twins");
    const store = lastStore;
    const at = "2026-10-03T13:02:29.579Z";
    const judge = { kind: "agent" as const, backend: "codex" as const, profileId: "estimate-judge", roleHint: "Estimate Judge" };
    const report = "## Verdict: request changes\n\n| Section | Score |\n|---|---:|\n| Questions | 3/10 |";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl" }),
      timeline: [
        { occurredAt: at, type: "quality", actor: judge, title: "Changes requested", text: "**Validation:** failing.", toAgent: false, evidence: null },
        { occurredAt: at, type: "comment", actor: judge, title: "Review verdict", text: report, toAgent: false, evidence: null },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // SAFETY: every tool in this toolkit answers `{ content: [{ type: "text", text }] }`.
    const out = (await tools.read_timeline_entry!.handler({ occurredAt: at } as never, {} as never)) as {
      content: { text: string }[];
    };
    const read = z
      .object({
        occurredAt: z.string(),
        shared: z.string(),
        entries: z.array(z.object({ type: z.string(), title: z.string().nullable(), truncated: z.boolean(), text: z.string() })),
      })
      .parse(JSON.parse(out.content[0]!.text));
    expect(read.occurredAt).toBe(at);
    expect(read.shared).toContain("in the order they were written: the first was written first");
    expect(read.entries.map((e) => [e.type, e.title, e.truncated])).toEqual([
      ["comment", "Review verdict", false],
      ["quality", "Changes requested", false],
    ]);
    expect(read.entries[0]!.text).toBe(report);
  });

  it("ruling 594: read_task_attachment reads one file of this task or another, and read_board lists a task's files", async () => {
    // Live on AWSC-33 the Estimate Judge was told to read two registers on
    // other tasks "where they are", which its workspace contract puts
    // off-limits, and asked a person for access. CANARY: leave the tool
    // unbuilt, or read only this task's files.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { taskAttachmentsDir } = await import("~/server/files/file-store-root.server");
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_files");
    const read = tools.read_task_attachment!;
    expect(read).toBeTruthy();
    const store = lastStore;
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-9", { stage: "done" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const dir = taskAttachmentsDir(store.slug, "VIB-9", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "round-3-comparison.md"), "# Round 3\n\n## Exposure register\n\n| Run | Passage |\n");
    writeFileSync(path.join(dir, "page-2026-09-29T16-02-40-517Z.yml"), "- snapshot\n");
    // SAFETY: every text answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (tool: RegisteredTool, args: Record<string, string>) =>
      ((await tool.handler(args as never, {} as never)) as { content: { text: string }[] }).content[0]!.text;
    expect(await text(read, { taskKey: "VIB-9", name: "round-3-comparison.md" })).toContain("## Exposure register");
    // Without a key it reads this task, which has no such file.
    expect(await text(read, { name: "round-3-comparison.md" })).toContain("[noop] VIB-3 has no attachment");
    expect(await text(read, { taskKey: "VIB-404", name: "x.md" })).toContain("[noop] No task VIB-404 in this project");
    // `read_board` names the files, less the browser's working files.
    const one = z.object({ files: z.array(z.string()) }).parse(JSON.parse(await text(tools.read_board!, { taskKey: "VIB-9" })));
    expect(one.files).toEqual(["round-3-comparison.md"]);
  });

  it("ruling 597: read_task_attachment reads a file as a kept delivery held it, and read_board lists the kept deliveries", async () => {
    // Live on AWSC-46 the Estimate Judge "could not independently diff it
    // against the prior version": the rework had saved the same name. CANARY:
    // drop `delivery` on the way to the reader and the first delivery reads as
    // the rework; leave `deliveries` off read_board and no stamp is offered.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { taskAttachmentsDir } = await import("~/server/files/file-store-root.server");
    const { keepDelivery } = await import("~/server/files/kept-deliveries.server");
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_kept");
    const store = lastStore;
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const dir = taskAttachmentsDir(store.slug, "VIB-9", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    const first = "2026-09-30T02:40:12.567Z";
    const rework = "2026-09-30T02:55:47.995Z";
    writeFileSync(path.join(dir, "comparison.md"), "Six-run total: 535/600");
    keepDelivery(store.slug, "VIB-9", first, ["comparison.md"], store.dataRoot);
    writeFileSync(path.join(dir, "comparison.md"), "Six-run total: 531/600");
    keepDelivery(store.slug, "VIB-9", rework, ["comparison.md"], store.dataRoot);
    // SAFETY: every text answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (tool: RegisteredTool, args: Record<string, string>) =>
      ((await tool.handler(args as never, {} as never)) as { content: { text: string }[] }).content[0]!.text;
    const board = z
      .object({ deliveries: z.array(z.object({ deliveredAt: z.string(), files: z.array(z.string()) })) })
      .parse(JSON.parse(await text(tools.read_board!, { taskKey: "VIB-9" })));
    expect(board.deliveries).toEqual([
      { deliveredAt: rework, files: ["comparison.md"] },
      { deliveredAt: first, files: ["comparison.md"] },
    ]);
    const read = tools.read_task_attachment!;
    expect(await text(read, { taskKey: "VIB-9", name: "comparison.md", delivery: first })).toContain("535/600");
    expect(await text(read, { taskKey: "VIB-9", name: "comparison.md" })).toContain("531/600");
    expect(await text(read, { taskKey: "VIB-9", name: "comparison.md", delivery: "2026-09-30T01:00:00.000Z" })).toBe(
      `[noop] VIB-9 kept no delivery at \`2026-09-30T01:00:00.000Z\`. Its kept deliveries, newest first: ${rework}, ${first}.`,
    );
    expect(await text(read, { taskKey: "VIB-9", name: "mapping.md", delivery: first })).toBe(
      `[noop] VIB-9's delivery of ${first} held no \`mapping.md\`. It held: comparison.md.`,
    );
  });

  it("ruling 596: read_board lists a task's timeline by stamp, and read_timeline_entry opens an entry on it or on another task", async () => {
    // Live in round 4, three Estimate Judges re-reviewing a rework could not
    // find their own first verdict: the prompt carries only recent entries,
    // read_board listed none, and read_timeline_entry read this task only.
    // One wrote the rework's score as the score of record.
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_index");
    const store = lastStore;
    const judge = { kind: "agent" as const, backend: "codex" as const, profileId: "estimate-judge", roleHint: "Estimate Judge" };
    const firstVerdict = "## Verdict: request changes\n\n**Score of record: 75/100.** Mapping 35/40.";
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review" }),
      timeline: [
        {
          occurredAt: "2026-09-30T01:55:33.089Z",
          type: "comment",
          actor: judge,
          title: "Review verdict",
          text: "## Verdict: approve. Rework 79/100.",
          toAgent: false,
          evidence: null,
        },
        {
          occurredAt: "2026-09-30T01:10:00.000Z",
          type: "comment",
          actor: { kind: "human", userId: store.users.arda.id, nameHint: "Arda" },
          title: null,
          text: "The score of record is 75/100.",
          toAgent: false,
          evidence: null,
        },
        {
          occurredAt: "2026-09-29T23:35:25.588Z",
          type: "comment",
          actor: judge,
          title: "Review verdict",
          text: firstVerdict,
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // SAFETY: every text answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (tool: RegisteredTool, args: Record<string, string>) =>
      ((await tool.handler(args as never, {} as never)) as { content: { text: string }[] }).content[0]!.text;
    // CANARY: drop the index from the single-task read and no older stamp is findable.
    const index = z.object({ timeline: z.array(z.string()) }).parse(JSON.parse(await text(tools.read_board!, { taskKey: "VIB-9" })));
    expect(index.timeline).toEqual([
      "2026-09-30T01:55:33.089Z · comment · agent:estimate-judge · Review verdict",
      "2026-09-30T01:10:00.000Z · comment · Arda",
      "2026-09-29T23:35:25.588Z · comment · agent:estimate-judge · Review verdict",
    ]);
    // CANARY: bind the reader to this task only and the first verdict stays out of reach.
    const entry = z
      .object({ text: z.string() })
      .parse(JSON.parse(await text(tools.read_timeline_entry!, { taskKey: "VIB-9", occurredAt: "2026-09-29T23:35:25.588Z" })));
    expect(entry.text).toBe(firstVerdict);
    // Without a key it reads this task, which has no such entry, and says where stamps are.
    const miss = await text(tools.read_timeline_entry!, { occurredAt: "2026-09-29T23:35:25.588Z" });
    expect(miss).toContain("[noop] VIB-3 has no timeline entry stamped");
    expect(miss).toContain("`read_board` lists it");
  });

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
          { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
          // Hostile row: a newline would forge a second row in task.md.
          { label: "forged\n- x · +1 · -1", status: "fail" },
        ],
      },
      {},
    );
    const staged = takeStagedOutcome(lastStore.db, "oc_c")!;
    expect(staged.verdict).toBe("approve");
    expect(staged.evidence).toHaveLength(2);
    expect(staged.evidence![0]).toEqual({
      label: "unit/policy_gate_test",
      result: "6 passed",
      status: "pass",
    });
    expect(staged.evidence![1]!.label).not.toContain("\n");
    // An omitted result is empty; task.md writes the placeholder for it.
    expect(staged.evidence![1]!.result).toBe("");
  });

  /**
   * Option D PR 4(b): the tool says "exactly once", and a second call used to
   * replace the first without a word, so whichever envelope came LAST was the
   * run's verdict. The first now stands; the model is told, and it is audited.
   * Canary: restore `ON CONFLICT DO UPDATE` and drop the `alreadyStaged` check
   * in stageOutcome, and the staged verdict flips to request_changes.
   */
  it("stages the FIRST envelope once; a second call is refused, told so, and audited", async () => {
    const textOf = z.object({ content: z.array(z.object({ text: z.string() })).min(1) });
    const tools = toolkitTools({ ...BASE, evidence: false }, "oc_once");
    // The run row as registerAgentCompletion leaves it: stamped with the key.
    upsertRun(lastStore.db, {
      id: "run_once",
      projectSlug: lastStore.slug,
      taskKey: "VIB-3",
      threadId: "thread_once",
      role: "Security review",
      kind: "primary",
      agentProfileId: "security-reviewer",
      backend: "claude",
      model: "claude-opus-5",
      sdk: "claude-agent-sdk",
      state: "running",
    });
    patchRun(lastStore.db, "run_once", { outcomeKey: "oc_once" });
    const first = textOf.parse(
      await tools.report_outcome!.handler({ verdict: "approve", summary: "LGTM." }, {}),
    );
    expect(first.content[0]!.text).toMatch(/^\[staged\]/);
    const second = textOf.parse(
      await tools.report_outcome!.handler(
        { verdict: "request_changes", summary: "Changed my mind." },
        {},
      ),
    );
    expect(second.content[0]!.text).toBe(
      "[already staged] Your outcome was recorded once; this call was ignored. Finish with your full findings.",
    );
    await tools.report_outcome!.handler({ verdict: "request_changes" }, {});

    const rows = listAuditEvents(lastStore.db, { action: "task.agent.outcome_duplicate" });
    // Both refusals, counted per run (two rows can share a timestamp, so the
    // set is compared, not the order).
    expect(rows.map((r) => r.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "run_once", outcomeKey: "oc_once", count: 1 }),
        expect.objectContaining({ runId: "run_once", outcomeKey: "oc_once", count: 2 }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.actorLabel).toBe("agent:claude/security-reviewer (Security review)");

    expect(takeStagedOutcome(lastStore.db, "oc_once")).toEqual({
      verdict: "approve",
      summary: "LGTM.",
    });
  });

  it("stages no evidence when the grant is withheld, even if the model sends some", async () => {
    const tools = toolkitTools({ ...BASE, evidence: false }, "oc_d");
    await tools.report_outcome!.handler(
      { verdict: "approve", evidence: [{ label: "smuggled", result: "1 passed", status: "pass" }] },
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

    it("advertises evidence but NOT verdict — the tool grants no judgment", () => {
      // The tool is mounted at all: an inert grant leaves `tool` undefined and
      // the schema read below throws.
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
          evidence: [{ label: "unit/policy_gate_test", result: "6 passed", status: "pass" }],
        },
        {},
      );
      const staged = takeStagedOutcome(lastStore.db, "oc_u11c")!;
      expect(staged.verdict).toBeUndefined();
      expect(staged.summary).toBe("Ran the suite.");
      expect(staged.evidence).toEqual([
        { label: "unit/policy_gate_test", result: "6 passed", status: "pass" },
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
          collab: {
            comment: false,
            ask: false,
            verdict: false,
            evidence: false,
            githubRead: false,
          },
          kb: [],
        }),
      ).toBeNull();

    });

    /**
     * Ruling 283: a knowledge base is INDEXED into the prompt now, not injected,
     * so the grant only half-arrives without a way to pull a document. Its gate
     * is the KB grant, not U11's collaboration grants — an agent granted a
     * knowledge base and nothing else still has to be able to read it.
     */
    it("rulings 283, 483 and 498: a KB grant alone mounts read_knowledge_doc and correct_knowledge_doc, and nothing else", () => {
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
        outcomeKey: "oc_kb",
        collab: {
          comment: false,
          ask: false,
          verdict: false,
          evidence: false,
          githubRead: false,
        },
        kb: ["shop-rulings"],
      });
      expect(built).not.toBeNull();
      const names = mountedTools.parse(built!.mcpServers.viberr_agent);
      // Ruling 483 mounts after `read_board`, so a knowledge base alone still
      // widens nothing on U11's collaboration gate.
      expect(Object.keys(names)).toEqual(["read_knowledge_doc", "correct_knowledge_doc"]);
    });

    /**
     * Ruling 483 (F40-53): an agent that PROVES a line of one of its knowledge
     * bases wrong corrects the document. Live on WEB-3 the Platform Engineer
     * wrote "the knowledge-base runbook is read-only to me", an hour after the
     * Site Engineer found the same stale dossier fact. Ruling 498 writes the
     * correction into the settled text as it is made.
     */
    it("rulings 483 and 498: correct_knowledge_doc writes into the agent's own knowledge base, and only its own", async () => {
      const { saveKnowledgeBase, resolveStoreTarget } = await import("~/server/org/resources.server");
      const { writeStoreDoc } = await import("~/server/org/store-files.server");
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-3", { stage: "review" }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const admin = { userId: store.users.arda.id, label: "arda" };
      const { kb } = await saveKnowledgeBase(
        store.db,
        { name: "akin-dossier", refresh: "on change" },
        admin,
        { dataRoot: store.dataRoot },
      );
      const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
      writeStoreDoc(
        store.db,
        target,
        [],
        "06-platform-facts.md",
        "# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/ (see run 12)\n",
        admin,
      );
      const built = buildAgentToolkit({
        db: store.db,
        ctx: { dataRoot: store.dataRoot },
        projectSlug: store.slug,
        taskKey: "VIB-3",
        actorRef: AGENT_REF,
        outcomeKey: "oc_kb_propose",
        collab: { comment: false, ask: false, verdict: false, evidence: false, githubRead: false },
        kb: [kb.dir],
      })!;
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      await built.mcpServers.viberr_agent.instance.connect(serverEnd);
      const client = new Client({ name: "probe", version: "1" }, { capabilities: {} });
      await client.connect(clientEnd);
      const textResult = z
        .object({ content: z.array(z.object({ text: z.string() })) })
        .transform((r) => r.content.map((c) => c.text).join("\n"));

      const filed = textResult.parse(
        await client.callTool({
          name: "correct_knowledge_doc",
          arguments: {
            kb: kb.dir,
            // Ruling 588: the document is `path`, as read_knowledge_doc names it.
            // CANARY: name it `doc` again and the call is refused as invalid.
            path: "06-platform-facts.md",
            replaces: "- T-003: wrangler 4.138.0",
            text: "- T-003: wrangler 4.139.0",
            evidence: "`npx wrangler --version` printed 4.139.0.",
          },
        }),
      );
      // CANARY: drop the tool and the agent can only say so in a comment.
      expect(filed).toMatch(new RegExp(`^\\[done\\] Corrected \`${kb.dir}/06-platform-facts.md\` as kc-[0-9a-f]{10}`));
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const factsPath = path.join(store.dataRoot, "kb", kb.dir, "06-platform-facts.md");
      expect(readFileSync(factsPath, "utf8")).toBe("# Facts\n\n- T-003: wrangler 4.139.0\n- T-013: dist/server/ (see run 12)\n");
      const top = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-3", dataRoot: store.dataRoot })!
        .parsed.timeline[0]!;
      expect(top.type).toBe("kb_correction");
      expect(top.actor).toMatchObject({ kind: "agent", profileId: "security-reviewer" });
      const { listKbCorrections } = await import("~/server/org/kb-corrections.server");
      expect(listKbCorrections(store.db, { projectSlug: store.slug })[0]).toMatchObject({
        filedBy: "Security review",
        taskKey: "VIB-3",
      });

      // Ruling 581: an empty `text` deletes the passage. Live on AWSC-18 the
      // tool refused all 39 deletions a Researcher had to apply.
      const deleted = textResult.parse(
        await client.callTool({
          name: "correct_knowledge_doc",
          arguments: {
            kb: kb.dir,
            path: "06-platform-facts.md",
            replaces: " (see run 12)",
            text: "",
            evidence: "Run 12 was deleted with its workspace.",
          },
        }),
      );
      // CANARY: require `text` in correctKnowledgeDoc again and this is refused.
      expect(deleted).toMatch(/^\[done\] Corrected/);
      expect(readFileSync(factsPath, "utf8")).toBe("# Facts\n\n- T-003: wrangler 4.139.0\n- T-013: dist/server/\n");

      // A knowledge base this run was not given is not its to correct.
      const refused = textResult.parse(
        await client.callTool({
          name: "correct_knowledge_doc",
          arguments: { kb: "someone-elses", path: "x.md", text: "y", evidence: "z" },
        }),
      );
      expect(refused).toContain("[noop] No knowledge base `someone-elses` was given to a run on this task");
    });
  });

  /**
   * F4 — the authenticated GitHub reader. The full request/scope/token behavior
   * lives in agent-github-read.server.test.ts; here we prove the TOOLKIT wiring:
   * the tool mounts on its own grant, and a call is audited (the path is not a
   * secret, the token never appears — it lives in the server-side client).
   */
  describe("github_read (F4)", () => {
    const textOf = z.object({
      content: z.array(z.object({ text: z.string() })).min(1),
    });

    it("mounts only when read-github-api is granted", () => {
      const off = toolkitTools(
        { comment: false, ask: false, verdict: true, evidence: false, githubRead: false },
        "oc_gr_off",
      );
      const on = toolkitTools(
        { comment: false, ask: false, verdict: true, evidence: false, githubRead: true },
        "oc_gr_on",
      );
      expect(off.github_read).toBeUndefined();
      expect(on.github_read).toBeDefined();
    });

    it("returns [unavailable] and audits the read when no credential is configured", async () => {
      // The harness store has a repo but no PAT — the reader must degrade with a
      // clear reason rather than throw, and the attempt is still audited.
      const tools = toolkitTools(
        { comment: false, ask: false, verdict: false, evidence: false, githubRead: true },
        "oc_gr_unavail",
      );
      const result = textOf.parse(
        await tools.github_read!.handler({ path: "pulls/1" }, {}),
      );
      expect(result.content[0]!.text).toContain("[unavailable]");
      const audits = listAuditEvents(lastStore.db, {
        action: "task.agent.github_read",
      });
      expect(audits).toHaveLength(1);
    });

    /** A toolkit whose project has a repo AND a sealed PAT, so the mounted
     *  github_read tool can make a (faked) authenticated call. */
    function configuredToolkit() {
      const store = setupTestStore(ctx);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-3", { stage: "review" }),
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };
      const pat = createPat(
        store.db,
        { userId: store.users.arda.id, label: "bot", token: "ghp_toolkitread01" },
        actor,
      );
      setProjectCredential(store.db, { projectSlug: store.slug, patId: pat.id }, actor);
      const built = buildAgentToolkit({
        db: store.db,
        ctx: { dataRoot: store.dataRoot },
        projectSlug: store.slug,
        taskKey: "VIB-3",
        actorRef: AGENT_REF,
        outcomeKey: "oc_gr_ok",
        collab: { comment: false, ask: false, verdict: false, evidence: false, githubRead: true },
        kb: [],
      })!;
      return { store, tools: mountedTools.parse(built.mcpServers.viberr_agent) };
    }

    it("on success: formats [done] with the rate-limit line, returns the JSON, audits the NORMALIZED path, and leaks no token", async () => {
      const { store, tools } = configuredToolkit();
      // The handler calls runAgentGithubRead with no fetchImpl → it uses the
      // global fetch, so stub it. createGithubClient reads global fetch at call
      // time (inside runAgentGithubRead), so the stub is in effect.
      const gh = fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/7": {
          body: { number: 7, title: "Add F4" },
          headers: { "x-ratelimit-remaining": "58" },
        },
      });
      vi.stubGlobal("fetch", gh.fetchImpl);
      let text: string;
      try {
        text = textOf.parse(
          await tools.github_read!.handler({ path: "pulls/7" }, {}),
        ).content[0]!.text;
      } finally {
        vi.unstubAllGlobals();
      }
      expect(text).toContain("[done] GET /repos/akin-ozer/viberr/pulls/7");
      expect(text).toContain("GitHub rate limit remaining: 58");
      expect(text).toContain('"number": 7');
      expect(text).not.toContain("ghp_toolkitread01");
      // The Bearer token WAS sent server-side, proving it was a real auth call…
      const call = gh.callsTo("GET /repos/akin-ozer/viberr/pulls/7")[0]!;
      expect(call.headers["authorization"]).toBe("Bearer ghp_toolkitread01");
      // …and the audit records the resolved path + ok, never the token.
      const audit = listAuditEvents(store.db, { action: "task.agent.github_read" })[0]!;
      expect(audit.details).toMatchObject({
        path: "/repos/akin-ozer/viberr/pulls/7",
        ok: true,
      });
      expect(JSON.stringify(audit)).not.toContain("ghp_toolkitread01");
    });

    it("caps a large body and marks the truncation", async () => {
      const { tools } = configuredToolkit();
      const big = {
        items: Array.from({ length: 4000 }, (_, i) => ({ i, pad: "x".repeat(40) })),
      };
      const gh = fakeGithubFetch({
        "GET /repos/akin-ozer/viberr/pulls/7/files": { body: big },
      });
      vi.stubGlobal("fetch", gh.fetchImpl);
      let text: string;
      try {
        text = textOf.parse(
          await tools.github_read!.handler({ path: "pulls/7/files" }, {}),
        ).content[0]!.text;
      } finally {
        vi.unstubAllGlobals();
      }
      expect(text).toContain("[truncated");
      expect(text).toContain("narrow the path or paginate");
      // The cap holds (ruling 624): printed as the tool result it is, the
      // message fits a Codex code-mode tool output, 10,000 tokens counted as
      // UTF-8 bytes / 4, not the ~220 KB raw body. CANARY: cap at 48,000.
      expect(Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] })) / 4).toBeLessThanOrEqual(10_000);
    });
  });
});
