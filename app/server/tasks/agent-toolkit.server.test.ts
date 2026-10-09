import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import { connectedClient, toolLoading } from "../../../test-support/mcp-tool-meta";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { reconfigureProject } from "../../../test-support/projected-store";
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
import {
  AGENT_OUTCOME_JSON_SCHEMA,
  ASK_HUMAN_ONLY_NOTE,
  takeStagedOutcome,
} from "./agent-outcome.server";
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
    /** What the tool tells every run that holds it. */
    description?: string;
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
      webEgress: true,
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
      webEgress: true,
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
    const server = mountFor({ ...BASE, ask: true });
    const client = await connectedClient(server);

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
    // Evidence only: the WEB-9 Platform Engineer's shape, no verdict grant.
    const server = mountFor({ comment: false, ask: false, verdict: false, evidence: true });
    const client = await connectedClient(server);
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
    const server = mountFor({ ...BASE, verdict: true, evidence: true });
    const client = await connectedClient(server);
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
   * Ruling 692(c): seven of the nine questions a writer put to a person were
   * its own choices (the reader, the length, the tone), each with a default
   * to approve. One sentence says what a question is for, on the tool a Claude
   * run calls and on the field a Codex run fills, so it reaches an agent no
   * manual does. The run's collaboration note carries it too, which
   * `specialist-run.server.test.ts` owns.
   */
  it("ruling 692: both asking channels say a person is asked only what they alone know, in one question", async () => {
    const server = mountFor({ ...BASE, ask: true });
    const client = await connectedClient(server);

    expect(ASK_HUMAN_ONLY_NOTE).toBe(
      "Ask what only a person knows or may decide, and put all of it in one question. " +
        "A choice that is yours to make, make it and state it in your report as an assumption: " +
        "never ask a person to approve your own choices.",
    );
    const ask = (await client.listTools()).tools.find((t) => t.name === "ask_human");
    // CANARY: drop the note from the tool's description, or from the field's.
    expect(ask?.description).toContain(ASK_HUMAN_ONLY_NOTE);
    expect(AGENT_OUTCOME_JSON_SCHEMA.properties.question.description).toContain(
      ASK_HUMAN_ONLY_NOTE,
    );
  });

  /**
   * Ruling 478(e) (F40-31, F40-57): `ask_human` lets the agent say a choice
   * needs a typed answer, and tells it an unmarked list recommends nothing.
   */
  it("ruling 478(e): a `reply` choice reaches the packet, and an unmarked list recommends nothing", async () => {
    const server = mountFor({ ...BASE, ask: true });
    const client = await connectedClient(server);

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
      webEgress: true,
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
      webEgress: true,
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
      "keep_source",
      "read_board",
      "read_knowledge_doc",
      "read_task_attachment",
      "read_task_source",
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

  it("ruling 690: keep_source is on the toolkit only for a profile that holds attach-evidence-references, and records the run that called it", async () => {
    // CANARY: mount it under holdsCollaborationGrant(collab) and a profile
    // with every other grant, which may not save a file on the task, is
    // offered keep_source. Pass no run id from the handler and the record
    // names no run.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { taskAttachmentsDir } = await import("~/server/files/file-store-root.server");
    const { readTaskSources } = await import("~/server/files/task-sources.server");
    const ungranted = toolkitTools({ comment: true, ask: true, verdict: true, evidence: false, githubRead: true }, "oc_nokeep");
    expect(ungranted.keep_source).toBeUndefined();
    // It still reads what the task keeps.
    expect(ungranted.read_task_source).toBeTruthy();

    const tools = toolkitTools({ comment: false, ask: false, verdict: false, evidence: true }, "oc_keep");
    const store = lastStore;
    // The run row as registerAgentCompletion leaves it: stamped with the key.
    upsertRun(store.db, {
      id: "run_keep",
      projectSlug: store.slug,
      taskKey: "VIB-3",
      threadId: "thread_keep",
      role: "Security review",
      kind: "reviewer",
      agentProfileId: "security-reviewer",
      backend: "claude",
      model: "claude-opus-5",
      sdk: "claude-agent-sdk",
      state: "running",
    });
    patchRun(store.db, "run_keep", { outcomeKey: "oc_keep" });
    const dir = taskAttachmentsDir(store.slug, "VIB-3", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, ".source-advisory.json"), '{"id":"GHSA-xxxx","fixedIn":"4.2.1"}');

    // SAFETY: the tool answers the text block `{ content: [{ type: "text", text }] }`.
    const out = (await tools.keep_source!.handler(
      {
        file: ".source-advisory.json",
        from: "https://api.github.com/advisories/GHSA-xxxx",
        title: "The advisory for the pinned parser",
      } as never,
      {} as never,
    )) as { content: { text: string }[] };
    expect(out.content[0]!.text).toMatch(/^\[kept\] S1: advisory\.json, 36 bytes, sha256 [0-9a-f]{12}\. /);
    expect(readTaskSources(store.slug, "VIB-3", store.dataRoot).sources).toMatchObject([
      {
        id: "S1",
        runId: "run_keep",
        by: { backend: "claude", profileId: "security-reviewer", roleHint: "Security review" },
      },
    ]);
  });

  it("ruling 690: read_task_source lists a task's sources with what each delivery rested on, opens one by id in pages, and reads another task's with taskKey", async () => {
    // The reader the operator's, the controller's and the gateway's tools
    // answer with, unchanged. CANARY: resolve the bytes by the record's
    // `name` instead of its `file` and the read answers [noop] for a source
    // the list just named. List only the deliveries the index has a line for
    // and the first delivery, stamped while the task kept nothing, is not
    // named, so a reader cannot tell it rested on none. Print the start of
    // the hash and the list does not carry the SHA-256 its description says.
    const { createHash } = await import("node:crypto");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { taskAttachmentsDir } = await import("~/server/files/file-store-root.server");
    const { keepDelivery } = await import("~/server/files/kept-deliveries.server");
    const { readTaskSources, recordDeliverySources, writeTaskSource } = await import(
      "~/server/files/task-sources.server"
    );
    // A reviewer with no file grant: it cannot keep a source and still reads them.
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_sources");
    const read = tools.read_task_source!;
    expect(read).toBeTruthy();
    const store = lastStore;
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const by = { backend: "codex", profileId: "researcher", roleHint: "Researcher" };
    // A first delivery, kept before the task kept any source: no line was
    // written for it, and it rested on none.
    const dir = taskAttachmentsDir(store.slug, "VIB-9", store.dataRoot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "estimate.md"), "The first estimate.");
    keepDelivery(store.slug, "VIB-9", "2024-03-01T09:00:00.000Z", ["estimate.md"], store.dataRoot);
    // A page longer than one read, so the second half is only a page away.
    const page = `<html>${"t3.medium $0.0416 per hour. ".repeat(1500)}</html>`;
    const exportJson = '{"monthly":1234.56}';
    writeTaskSource(
      store.slug,
      "VIB-9",
      {
        name: "aws-pricing.html",
        data: Buffer.from(page),
        title: "AWS EC2 on-demand pricing",
        from: "https://aws.amazon.com/ec2/pricing/on-demand/",
        by,
        runId: "run_abc",
      },
      store.dataRoot,
    );
    recordDeliverySources(store.slug, "VIB-9", "2026-10-07T13:00:00.000Z", store.dataRoot);
    writeTaskSource(
      store.slug,
      "VIB-9",
      {
        name: "calc-export.json",
        data: Buffer.from(exportJson),
        title: "The calculator's export",
        from: "curl -sS https://calculator.aws/pricing/2.0/export",
        by,
        runId: null,
      },
      store.dataRoot,
    );
    const [first, second] = readTaskSources(store.slug, "VIB-9", store.dataRoot).sources;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    // SAFETY: every text answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (args: Record<string, string | number>) =>
      ((await read.handler(args as never, {} as never)) as { content: { text: string }[] }).content[0]!.text;

    // The list: what each delivery rested on, what was kept after the newest
    // one and by whom, then each source's record. CANARY: leave the "Kept
    // after it" line out and S2 stands under no delivery, while the card
    // counts it when the deliverer kept it (`sourcesRestedOn`).
    expect(JSON.parse(await text({ taskKey: "VIB-9" }))).toEqual({
      task: "VIB-9",
      kept: 2,
      truncated: false,
      text:
        "Delivery 2024-03-01T09:00:00.000Z rested on no kept source\n" +
        "Delivery 2026-10-07T13:00:00.000Z rested on: S1\n" +
        "Kept after it: S2 by agent:researcher. One the task's deliverer kept counts as what its result rests on; one a reviewer kept while checking does not.\n\n" +
        `S1 · aws-pricing.html · ${page.length.toLocaleString("en-US")} bytes · sha256 ${sha(page)}\n` +
        "title: AWS EC2 on-demand pricing\n" +
        "from: https://aws.amazon.com/ec2/pricing/on-demand/\n" +
        `kept: ${first!.keptAt} by agent:researcher (run run_abc)\n\n` +
        `S2 · calc-export.json · 19 bytes · sha256 ${sha(exportJson)}\n` +
        "title: The calculator's export\n" +
        "from: curl -sS https://calculator.aws/pricing/2.0/export\n" +
        `kept: ${second!.keptAt} by agent:researcher`,
    });

    // One source, a page at a time.
    expect(JSON.parse(await text({ taskKey: "VIB-9", id: "S1" }))).toEqual({
      id: "S1",
      title: "AWS EC2 on-demand pricing",
      from: "https://aws.amazon.com/ec2/pricing/on-demand/",
      keptAt: first!.keptAt,
      by: "agent:researcher",
      name: "aws-pricing.html",
      bytes: page.length,
      sha256: sha(page),
      text: page.slice(0, 32_000),
      truncated: true,
      nextOffset: 32_000,
    });
    expect(JSON.parse(await text({ taskKey: "VIB-9", id: "S1", offset: 32_000 }))).toMatchObject({
      id: "S1",
      text: page.slice(32_000),
      truncated: false,
      offset: 32_000,
    });

    // The misses say what the task does keep.
    expect(await text({ taskKey: "VIB-9", id: "S9" })).toBe(
      "[noop] VIB-9 keeps no source `S9`. It keeps S1 to S2; call read_task_source without `id` to list them.",
    );
    // Without a key it reads this task, which keeps none.
    expect(JSON.parse(await text({}))).toEqual({ task: "VIB-3", kept: 0, text: "VIB-3 keeps no sources.", truncated: false });
    expect(await text({ id: "S1" })).toBe("[noop] VIB-3 keeps no source `S1`. It keeps no sources.");
    expect(await text({ taskKey: "VIB-404" })).toBe(
      "[noop] No task VIB-404 in this project; `read_board` lists the project's tasks.",
    );
    // `read_board` says a task keeps sources and which tool lists them.
    // SAFETY: `read_board` answers the same one text block.
    const boardOut = (await tools.read_board!.handler({ taskKey: "VIB-9" } as never, {} as never)) as {
      content: { text: string }[];
    };
    const board = z.object({ sources: z.string() }).parse(JSON.parse(boardOut.content[0]!.text));
    expect(board.sources).toBe(
      "2 kept; `read_task_source` with this task's key lists them and what each delivery rested on",
    );
  });

  it("ruling 706: read_task_source with `find` answers the places in one source that hold the words, each readable from the offset it gives", async () => {
    // The finding: BLOG-7's post said a figure "isn't recorded" on the
    // strength of one entry of a 2.25 MB decisions file, a later entry of
    // the same file said where it is recorded, and no review of the post
    // opened that file: it is seventy-one pages of a read. CANARY: answer `find` with
    // a page of the source and the first assertion reads `text` where it
    // expects `hits`.
    const { writeTaskSource } = await import("~/server/files/task-sources.server");
    const tools = toolkitTools({ ...BASE, comment: true, evidence: false }, "oc_find");
    const read = tools.read_task_source!;
    const store = lastStore;
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter("VIB-9", { stage: "review" }) });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const by = { backend: "claude", profileId: "writer", roleHint: "Writer" };
    const keep = (name: string, data: Buffer, title: string) =>
      writeTaskSource(store.slug, "VIB-9", { name, data, title, from: `https://example.com/${name}`, by, runId: "run_w" }, store.dataRoot);
    // A record of four hundred entries, one to a line: fourteen pages of it.
    const filler = "The run finalizes first and the session is compacted after it, as the note on the task says. ";
    const entry = (n: number) =>
      n === 506
        ? `506. **A run records what its compaction cost** (2026-09-26) ${filler.repeat(8)}Its tokens go into the run's totals. ${filler.repeat(4)}`
        : n === 536
          ? `536. **The completion compaction adds only its own cost** (2026-09-28) ${filler.repeat(8)}The console line states that share, with the cached part named inside the input. ${filler.repeat(4)}`
          : n === 372
            ? `372. **Compaction is left to the CLI** (2026-09-21) ${filler.repeat(11)}`
            : `${n}. **An entry on another subject** (2026-09-20) ${filler.repeat(11)}`;
    const record = Array.from({ length: 400 }, (_, i) => entry(i + 300)).join("\n");
    expect(Math.ceil(record.length / 32_000)).toBe(14);
    keep("decisions.md", Buffer.from(record), "The decisions file");
    keep("chart.png", Buffer.from("not searched"), "A chart");
    // A page that embeds a picture: a read leaves the picture out (ruling
    // 676), and a place's offset counts the text as a read returns it.
    const embedded = `<html><img src="data:image/png;base64,${"A".repeat(60_000)}"><p>after the picture: the needle</p></html>`;
    keep("report.html", Buffer.from(embedded), "A report");
    // SAFETY: every text answer here is `{ content: [{ type: "text", text }] }`.
    const text = async (args: Record<string, string | number>) =>
      ((await read.handler({ taskKey: "VIB-9", ...args } as never, {} as never)) as { content: { text: string }[] })
        .content[0]!.text;
    const search = z.object({
      id: z.string(),
      title: z.string(),
      from: z.string(),
      find: z.string(),
      found: z.number(),
      hits: z.array(z.object({ line: z.number(), offset: z.number(), text: z.string() })),
      nextOffset: z.number().optional(),
      leftOut: z.string().optional(),
      note: z.string().optional(),
    });
    const find = async (args: Record<string, string | number>) => search.parse(JSON.parse(await text(args)));

    // The later entry, in one call: which line, which entry, the words.
    const later = await find({ id: "S1", find: "cached part" });
    expect(later).toMatchObject({
      id: "S1",
      title: "The decisions file",
      from: "https://example.com/decisions.md",
      find: "cached part",
      found: 1,
    });
    expect(later.note).toBeUndefined();
    expect(later.nextOffset).toBeUndefined();
    expect(later.hits).toHaveLength(1);
    expect(later.hits[0]!.line).toBe(237);
    expect(later.hits[0]!.offset).toBe(record.indexOf("536. "));
    expect(later.hits[0]!.text).toMatch(/^536\. \*\*The completion compaction adds only its own cost\*\* \(2026-09-28\) .* … .*with the cached part named inside the input\./);
    // And the entry is read from the offset the place gives. CANARY: hand the
    // reader an offset counted in another text than the one a read pages.
    const page = z.object({ text: z.string(), offset: z.number() }).parse(JSON.parse(await text({ id: "S1", offset: later.hits[0]!.offset })));
    expect(page.text.startsWith("536. **The completion compaction adds only its own cost** (2026-09-28)")).toBe(true);
    expect(page.text).toContain("with the cached part named inside the input");

    // Letters in either case, and the phrase comes back as it was sought.
    expect(await find({ id: "S1", find: "COMPACTION adds  only" })).toMatchObject({
      find: "COMPACTION adds only",
      found: 1,
      hits: [{ line: 237 }],
    });
    // A subject three entries write about lists the three, in order; a search
    // from the entry the piece cites lists that entry and what stands after
    // it. CANARY: ignore `offset` on a search and the entry of five days
    // before the one cited is listed as if it could be the later word.
    const subject = await find({ id: "S1", find: "compaction" });
    expect(subject.found).toBe(3);
    expect(subject.hits.map((h) => h.line)).toEqual([73, 207, 237]);
    expect(subject.hits[0]!.text.startsWith("372. **Compaction is left to the CLI** (2026-09-21)")).toBe(true);
    const cited = subject.hits[1]!.offset;
    expect(cited).toBe(record.indexOf("506. "));
    const after = await find({ id: "S1", find: "compaction", offset: cited });
    expect(after.found).toBe(3);
    expect(after.hits.map((h) => h.line)).toEqual([207, 237]);
    expect(after.hits[0]!.text.startsWith("506. **A run records what its compaction cost**")).toBe(true);
    // Past the last place: nothing listed, the count stands, and the answer
    // says which way to look. CANARY: answer an empty list with no word and
    // a reader takes "no later entry" for "no entry".
    const past = await find({ id: "S1", find: "cached part", offset: later.hits[0]!.offset + 5_000 });
    expect(past).toMatchObject({ found: 1, hits: [] });
    expect(past.note).toBe(
      `No place at or after offset ${later.hits[0]!.offset + 5_000}: every one is before it. Search again without \`offset\`.`,
    );
    // Nothing found says how the words were matched.
    expect(await find({ id: "S1", find: "isn't recorded" })).toEqual({
      id: "S1",
      title: "The decisions file",
      from: "https://example.com/decisions.md",
      find: "isn't recorded",
      found: 0,
      hits: [],
      note:
        "Nothing in S1 reads this. Letters match in either case and a space matches any run of spaces and line breaks; " +
        "nothing else is loosened, so a curly quote, a dash or an accented letter matches only itself. " +
        "Try fewer words, or one plain word the passage has to use.",
    });
    // Words in every entry: forty places, where to search on from, and no note.
    const common = await find({ id: "S1", find: "the session is compacted" });
    expect(common.found).toBe(398 * 11 + 2 * 12);
    expect(common.hits.length).toBeGreaterThan(0);
    expect(common.hits.length).toBeLessThanOrEqual(40);
    expect(common.nextOffset).toBeGreaterThan(common.hits.at(-1)!.offset);
    expect(common.note).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(common, null, 1))).toBeLessThan(32_000);
    // A word in every sentence: every place is counted, a page of them is
    // listed. CANARY: stop the count at a cap and print it as the total.
    const everywhere = await find({ id: "S1", find: "the" });
    expect(everywhere.found).toBe(record.toLowerCase().split("the").length - 1);
    expect(everywhere.found).toBeGreaterThan(10_000);
    expect(everywhere.hits.length).toBeLessThanOrEqual(40);
    expect(everywhere.note).toBeUndefined();

    // The text searched is the text a read returns: the embedded picture is
    // left out of both, and the answer says so.
    const inPage = await find({ id: "S3", find: "the needle" });
    expect(inPage.found).toBe(1);
    expect(inPage.leftOut).toContain("1 embedded file is left out of this text");
    expect(inPage.hits[0]!.text).toContain("[60,000 base64 characters left out]");
    const pageRead = z.object({ text: z.string() }).parse(JSON.parse(await text({ id: "S3", offset: inPage.hits[0]!.offset })));
    expect(pageRead.text).toContain("after the picture: the needle");
    // Nothing of a picture's bytes is found. CANARY: search the file's bytes.
    expect((await find({ id: "S3", find: "AAAAAAAAAAAAAAAA" })).found).toBe(0);

    // A file of data is searched as data: its indents are nesting, so no
    // place is headed by the first line of the file. CANARY: search every
    // source as prose, and each place in a printed JSON list opens with the
    // list's first item.
    const item = (tag: string, body: string) => `  {\n    "tag_name": "${tag}",\n    "body": "${body}"\n  }`;
    const releases = `[\n${[...Array.from({ length: 12 }, (_, i) => item(`v3.${12 - i}.0`, "Nothing about it.")), item("v2.9.0", "The cache is on by default.")].join(",\n")}\n]\n`;
    keep("releases.json", Buffer.from(releases), "The releases, as the API lists them");
    const inData = await find({ id: "S4", find: "cache is on" });
    expect(inData.hits).toHaveLength(1);
    expect(inData.hits[0]!.offset).toBe(releases.indexOf('    "body": "The cache is on'));
    expect(inData.hits[0]!.text).toContain('"tag_name": "v2.9.0"');
    expect(inData.hits[0]!.text).not.toContain("v3.12.0");

    // What a search cannot answer, said in a sentence. CANARY: answer a
    // search with no `id` with the list of sources, and it reads as "found in
    // none of them".
    expect(await text({ find: "cached part" })).toBe(
      "[noop] `find` searches one source: pass that source's `id` with it. read_task_source without `id` and without `find` lists the sources.",
    );
    expect(await text({ id: "S9", find: "cached part" })).toBe(
      "[noop] VIB-9 keeps no source `S9`. It keeps S1 to S4; call read_task_source without `id` to list them.",
    );
    expect(await text({ id: "S2", find: "cached part" })).toBe(
      "[noop] `chart.png` is an image: it has no text to search. Read it without `find` to look at it.",
    );
    // A phrase is at most twelve words and 200 characters: a search's time
    // grows with its words. CANARY: move either limit by one.
    const tooLong = (words: number, chars: number) =>
      `[noop] \`find\` takes a word or a short phrase, up to 12 words and 200 characters; this one is ${words} words and ${chars} characters. ` +
      "Search for a few words of the passage, then read it from the place found.";
    expect(await text({ id: "S1", find: "word ".repeat(13) })).toBe(tooLong(13, 64));
    expect(await text({ id: "S1", find: "w".repeat(201) })).toBe(tooLong(1, 201));
    expect(await find({ id: "S1", find: "word ".repeat(12) })).toMatchObject({ found: 0, hits: [] });
    expect(await find({ id: "S1", find: `${"w".repeat(100)} ${"w".repeat(99)}` })).toMatchObject({ found: 0, hits: [] });
    expect(await text({ id: "S1", find: "cached part", offset: record.length + 10 })).toBe(
      `[noop] \`decisions.md\` reads as ${record.length.toLocaleString("en-US")} characters; offset ${(record.length + 10).toLocaleString("en-US")} is past its end.`,
    );
    // A `find` of nothing but spaces is no search: the source is read.
    expect(JSON.parse(await text({ id: "S1", find: "   " }))).toMatchObject({ id: "S1", truncated: true, nextOffset: 32_000 });
    // And the tool says it can be searched, where a run reads it. CANARY:
    // build the search and leave the description as it was, and no run that
    // was not told about `find` ever sends it.
    expect(read.description).toContain(
      "With `id` and `find`, the places in that source that hold a word or short phrase, in place of a page: a long record is searched in one call, then read from the place found.",
    );
    const fields = read.inputSchema["shape"] ?? {};
    expect(Object.keys(fields)).toEqual(["id", "taskKey", "offset", "find"]);
    expect(fields.find?.description).toBe(
      "With `id`: a word or short phrase, up to 12 words, to look for in that source. " +
        "Letters match in either case and a space matches any run of spaces and line breaks; nothing else is loosened. " +
        "The answer is `found`, how many places in the source hold it, and `hits`, up to 40 of them from `offset` on: " +
        "each with its `line`, the words where they stand (after the head of their entry, when they stand far into one), and the `offset` to read it from. " +
        "A place that shows in the excerpt before it is not listed again. `nextOffset` is where to search on from when more follow.",
    );
    expect(fields.offset?.description).toBe(
      "Where to start reading, in characters: the `nextOffset` a truncated read returned, or the `offset` of a place `find` listed (a smaller number reads what leads up to it). " +
        "With `find`, where the search starts. Omit for the start.",
    );

    // A source whose bytes a person took out of the store (the runbook's
    // takedown) is searched no more than it is read. CANARY: answer such a
    // search "found: 0", and a reviewer reads a removed source as one that
    // does not hold the words.
    const { rmSync } = await import("node:fs");
    const nodePath = await import("node:path");
    const { taskDir } = await import("~/server/files/file-store-root.server");
    const { readTaskSources } = await import("~/server/files/task-sources.server");
    const report = readTaskSources(store.slug, "VIB-9", store.dataRoot).sources.find((s) => s.id === "S3")!;
    rmSync(nodePath.join(taskDir(store.slug, "VIB-9", store.dataRoot), "sources", report.file));
    const gone = "[noop] S3 (`report.html`) is on VIB-9's list of sources, but its bytes are not in the store as they were kept.";
    expect(await text({ id: "S3", find: "the needle" })).toBe(gone);
    expect(await text({ id: "S3" })).toBe(gone);
  });

  it("capture_page hands a run the pictures of a page on its task in readable stretches, saves nothing on the task, and names a file that is not a page", async () => {
    // Ruling 691: a page judged from its source hides a broken table and a
    // layout that falls apart on a phone. CANARY: mount the tool without the
    // pageCaptureStatus check and a server with no browser lists a tool that
    // cannot answer.
    const { mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { taskAttachmentsDir } = await import("~/server/files/file-store-root.server");
    const { imageHeader } = await import("~/server/files/task-attachments.server");
    const { withEnv } = await import("../../../test-support/env");
    const { writeFakeBrowser } = await import("../../../test-support/fake-browser");
    const grants = { ...BASE, comment: true, evidence: false };
    expect(toolkitTools(grants, "oc_capture_no_browser").capture_page).toBeUndefined();

    const fake = writeFakeBrowser(ctx.makeTempDir("viberr-fake-browser-"));
    await withEnv({ VIBERR_BROWSER_EXECUTABLE: fake.executable, ...fake.env() }, async () => {
      const capture = toolkitTools(grants, "oc_capture").capture_page!;
      const store = lastStore;
      // The run row as registerAgentCompletion leaves it: stamped with the
      // key, so the tool knows which run asks and keeps the pictures for it.
      upsertRun(store.db, {
        id: "run_capture",
        projectSlug: store.slug,
        taskKey: "VIB-3",
        threadId: "thread_capture",
        role: "Editor",
        kind: "reviewer",
        agentProfileId: "editor",
        backend: "claude",
        model: "claude-opus-5",
        sdk: "claude-agent-sdk",
        state: "running",
      });
      patchRun(store.db, "run_capture", { outcomeKey: "oc_capture" });
      const dir = taskAttachmentsDir(store.slug, "VIB-3", store.dataRoot);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "post.html"),
        '<img src="https://fonts.example.com/a.css"><img src="assets/chart.png"><p>fake-height:3412</p>',
      );
      writeFileSync(path.join(dir, "data.csv"), "a,b\n");
      // One screen of page: 800 px on a desktop, 844 on a phone.
      writeFileSync(path.join(dir, "short.html"), "<p>one screen</p>");
      writeFileSync(path.join(dir, "endless.html"), "<p>fake-height:50000</p>");
      writeFileSync(path.join(dir, ".draft.html"), "<p>a dot name is no file of the task to any reader</p>");
      type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
      const call = async (args: {
        name: string;
        view?: string;
        from?: number;
        width?: number;
        height?: number;
        scale?: number;
      }) => {
        // SAFETY: the tool answers with text and image blocks, the SDK's own
        // tool-result shape; the handler's second argument is never read.
        const { content } = (await capture.handler(args as never, {} as never)) as { content: Block[] };
        return {
          text: content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
          pictures: content.flatMap((block) =>
            block.type === "image" ? [imageHeader(Buffer.from(block.data, "base64"))] : [],
          ),
        };
      };

      const first = await call({ name: "post.html" });
      expect(first.text).toMatch(
        new RegExp(
          "^\\[done\\] `post\\.html` as a reader sees it\\. " +
            "Desktop, 1280 px wide: 0 to 2,000 px of 3,412 \\(`nextFrom`: 2000\\)\\. " +
            "Phone, 390 px wide: 0 to 2,000 px of 3,412 \\(`nextFrom`: 2000\\)\\. " +
            "It asked the network for 1 thing \\(fonts\\.example\\.com\\), which a capture never loads, " +
            "and for `assets/chart\\.png`, which is not among this task's files \\(the folder is flat\\)\\. " +
            // In the run's own folder of the task's capture scratch.
            // CANARY: pass `runId: null` from the handler and the pictures
            // land in the folder every run-less ask shares, where the next
            // capture on the task by anyone replaces them, and the reply
            // says so instead.
            "Saved for this run at `\\S+/\\.captures/run_capture/cap_\\S+/out/1-desktop\\.png` and " +
            "`\\S+/\\.captures/run_capture/cap_\\S+/out/1-phone\\.png`: " +
            "scratch, your next capture replaces it, and it goes when this run ends\\.$",
        ),
      );
      // One picture per width, each a stretch a model can read.
      expect(first.pictures).toEqual([
        { mimeType: "image/png", width: 1280, height: 2000 },
        { mimeType: "image/png", width: 390, height: 2000 },
      ]);
      // The rest of the page, at one width.
      const rest = await call({ name: "post.html", view: "phone", from: 2000 });
      expect(rest.text).toContain("Phone, 390 px wide: 2,000 to 3,412 px of 3,412, the end of the page.");
      expect(rest.text).not.toContain("Desktop");
      expect(rest.pictures).toEqual([{ mimeType: "image/png", width: 390, height: 1412 }]);

      // A phone lays a page out taller than a desktop does. Past the shorter
      // layout's end the other width is still handed over, and the reply says
      // which width ended where. CANARY: fail the call when one width has
      // nothing at `from` and following the phone's `nextFrom` ends in an
      // error that names no width.
      const uneven = await call({ name: "short.html", from: 820 });
      expect(uneven.text).toMatch(
        /^\[done\] `short\.html` as a reader sees it\. Desktop, 1280 px wide: the page ends at 800 px, so nothing starts at 820 px\. Phone, 390 px wide: 820 to 844 px of 844, the end of the page\. Saved for this run at /,
      );
      expect(uneven.pictures).toEqual([{ mimeType: "image/png", width: 390, height: 24 }]);
      // Past the end at both widths nothing failed: there is nothing there.
      expect(await call({ name: "short.html", from: 5000 })).toEqual({
        text:
          "[noop] `short.html` ends at 800 px at the desktop width (1280 px) and at 844 px at the phone width (390 px), " +
          "so nothing starts at 5,000 px.",
        pictures: [],
      });
      // A reply never hands out a `nextFrom` the tool would then refuse.
      // CANARY: print `nextFrom` for every cut stretch and this one says 42000.
      expect((await call({ name: "endless.html", view: "desktop", from: 40_000 })).text).toContain(
        "Desktop, 1280 px wide: 40,000 to 42,000 px of 50,000; the page runs on, and a stretch starts no further down than 40,000 px.",
      );

      // Given a size it is one picture of exactly that size. CANARY: leave
      // `width`, `height` or `scale` out of what the handler passes on and
      // this is the page in stretches, a refusal that names a field the run
      // did give, or a 1x picture.
      const sized = await call({ name: "short.html", width: 1200, height: 630, scale: 2 });
      expect(sized.text).toMatch(
        new RegExp(
          "^\\[done\\] `short\\.html` as a picture of the size asked: 1,200 by 630 px at scale 2, " +
            "saved as a PNG of 2,400 by 1,260 px\\. " +
            "It is over 2,000 px on a side, so it is saved and not shown here: " +
            "the same box at a lower scale is the same layout, and shows you it\\. " +
            "Saved for this run at `\\S+/\\.captures/run_capture/cap_\\S+/out/1-desktop\\.png`: " +
            // This run holds the verdict, so the reply stops here: a run that
            // judges pictures is not told how one is kept on the task.
            "scratch, your next capture replaces it, and it goes when this run ends\\.$",
        ),
      );
      expect(sized.pictures).toEqual([]);
      // At a scale that fits, the picture itself comes back.
      expect((await call({ name: "short.html", width: 1200, height: 630 })).pictures).toEqual([
        { mimeType: "image/png", width: 1200, height: 630 },
      ]);
      // Nor does the tool's own description tell a run to copy anything: what
      // it says reaches every run that holds the tool, a reviewer included.
      // CANARY: put the copy instruction back in CAPTURE_PAGE_DESCRIPTION.
      expect(capture.description).toContain("where the PNG was saved for this run");
      expect(capture.description).not.toMatch(/copy that file|keeps it as a file/);
      // A run that makes pictures is told: it can post files and holds no
      // verdict. CANARY: pass `keeps: true` from the handler whatever the run
      // holds, and a reviewer is one copy away from replacing the file under
      // review with its own render of it, and a run told never to write into
      // that folder is told to; pass `keeps: false` and a maker is left with
      // a path in a scratch that goes with its run.
      const onlooker = toolkitTools({ ...BASE, verdict: false, comment: true, evidence: false }, "oc_capture_onlooker").capture_page!;
      const onlookerDir = taskAttachmentsDir(lastStore.slug, "VIB-3", lastStore.dataRoot);
      mkdirSync(onlookerDir, { recursive: true });
      writeFileSync(path.join(onlookerDir, "cover.html"), "<p>a cover</p>");
      // SAFETY: as in `call` above.
      const looked = (await onlooker.handler({ name: "cover.html", width: 1200, height: 630 } as never, {} as never)) as { content: Block[] };
      expect(looked.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")).not.toContain("keeps it as a file");
      // And a reviewer that can also post files, as the shipped Editor can,
      // is still not told: holding the verdict is what decides.
      const editor = toolkitTools({ ...BASE, verdict: true, comment: true, evidence: true }, "oc_capture_editor").capture_page!;
      const editorDir = taskAttachmentsDir(lastStore.slug, "VIB-3", lastStore.dataRoot);
      mkdirSync(editorDir, { recursive: true });
      writeFileSync(path.join(editorDir, "cover.html"), "<p>a cover</p>");
      // SAFETY: as in `call` above.
      const judged = (await editor.handler({ name: "cover.html", width: 1200, height: 630 } as never, {} as never)) as { content: Block[] };
      expect(judged.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")).not.toContain("keeps it as a file");
      const maker = toolkitTools({ ...BASE, verdict: false, comment: true, evidence: true }, "oc_capture_maker").capture_page!;
      const makerDir = taskAttachmentsDir(lastStore.slug, "VIB-3", lastStore.dataRoot);
      mkdirSync(makerDir, { recursive: true });
      writeFileSync(path.join(makerDir, "cover.html"), "<p>a cover</p>");
      // SAFETY: as in `call` above.
      const made = (await maker.handler({ name: "cover.html", width: 1200, height: 630 } as never, {} as never)) as { content: Block[] };
      expect(made.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")).toMatch(
        /Copying that file into the task's attachments folder under a name ending `\.png` keeps it as a file of the task\.$/,
      );
      // The fields it advertises hold a size to what a capture makes: a side
      // of 100 to 4,000 CSS px in whole px, and one of five scales. CANARY:
      // declare `width` as any number and a 99 px or a 12,000 px box reaches
      // the browser; take any scale in a range and 0.7 does.
      const fields = capture.inputSchema["shape"] ?? {};
      const takes = (field: string, value: number) => fields[field]?.safeParse(value).success;
      expect(["width", "height"].flatMap((side) => [99, 100, 630.5, 4000, 4001].map((value) => takes(side, value)))).toEqual([
        false, true, false, true, false,
        false, true, false, true, false,
      ]);
      expect([0.2, 0.25, 0.5, 0.7, 1, 1.5, 2, 2.5].map((value) => takes("scale", value))).toEqual([
        false, true, true, false, true, true, true, false,
      ]);

      // It saved nothing on the task: no file, no entry, no audit row.
      expect(readdirSync(dir).sort()).toEqual([".draft.html", "data.csv", "endless.html", "post.html", "short.html"]);
      const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-3", dataRoot: store.dataRoot })!.parsed;
      expect(file.timeline).toEqual([]);
      expect(file.frontmatter.pageCaptures).toBeUndefined();
      expect(listAuditEvents(store.db, { action: "task.pages.captured" })).toEqual([]);

      // What it does not render, in the reader's own words.
      expect((await call({ name: "data.csv" })).text).toBe(
        "[noop] `data.csv` is not a page. capture_page renders .html, .htm, .md and .markdown files, " +
          "and a .svg drawing given `width` and `height`; read any other file with read_task_attachment.",
      );
      const missing = (await call({ name: "nope.html" })).text;
      expect(missing).toMatch(/^\[noop\] VIB-3 has no attachment `nope\.html`\. It holds: /);
      expect(missing).toContain("post.html");
      // A dot name is hidden from every listing, so it is no page to look at
      // either. CANARY: let a dot name through to the renderer and the answer
      // is no longer the reader's own sentence.
      expect((await call({ name: ".draft.html" })).text).toMatch(/^\[noop\] VIB-3 has no attachment `\.draft\.html`\. It holds: /);
    });
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
          webEgress: true,
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
        webEgress: true,
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
      // Ruling 648: an agent on the project is not given the dossier, so the
      // correction's entry quotes none of it (ruling 568).
      reconfigureProject(store, (fm) => ({
        agents: [
          ...fm.agents,
          {
            profileId: "inventory-analyst",
            capabilities: [],
            extras: [],
            definition: { kind: "specialist", name: "Inventory Analyst", role: "Intake", backends: ["claude"], model: "sonnet" },
          },
        ],
      }));
      const built = buildAgentToolkit({
        db: store.db,
        ctx: { dataRoot: store.dataRoot },
        projectSlug: store.slug,
        taskKey: "VIB-3",
        actorRef: AGENT_REF,
        outcomeKey: "oc_kb_propose",
        collab: { comment: true, ask: false, verdict: false, evidence: false, githubRead: false },
        kb: [kb.dir],
        webEgress: true,
      })!;
      const client = await connectedClient(built.mcpServers.viberr_agent);
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
      // Ruling 648: this run is given the dossier, so it reads the correction
      // whole though the entry quotes none of it. CANARY: drop `readerKbs` from
      // the toolkit's read_timeline_entry and this reads `notQuoted`.
      expect(top.text).toContain("The passage is not quoted here");
      const reading = z
        .object({ correction: z.object({ now: z.string(), evidence: z.string() }) })
        .parse(
          JSON.parse(
            textResult.parse(await client.callTool({ name: "read_timeline_entry", arguments: { occurredAt: top.occurredAt } })),
          ),
        );
      expect(reading.correction).toEqual({
        ...reading.correction,
        now: "- T-003: wrangler 4.139.0",
        evidence: "`npx wrangler --version` printed 4.139.0.",
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
        webEgress: true,
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
