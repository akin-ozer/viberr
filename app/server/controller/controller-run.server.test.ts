import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { joinedPrompt, sortedNames } from "~/server/runtimes/prompt-prefix.server";
import type { RunMcpServerDeclaration } from "~/server/runtimes/adapter.server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { ControllerToolUser } from "./controller-tool-guards.server";

/**
 * Ruling 107 — what a controller turn MOUNTS, and what it is told about it.
 *
 * The "not removable by anyone" mechanism is not a guard that refuses a
 * removal: it is that no removal exists. `buildControllerMounts` reads no
 * config and consults no grant row, so `viberr_ops` is attached on every turn
 * for the same reason `viberr_controller` is. These lock that, plus the one
 * persona sentence that tells the model the tools are there — a prompt that
 * promises tools a run does not carry is the failure this pairing prevents.
 */

let app: AppTestContext;
let user: ControllerToolUser;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  const found = findUserByEmail(app.db, "arda@viberr.dev")!;
  user = { id: found.id, email: found.email, name: found.name };
});
afterAll(() => app.cleanup());

/** The system prompt for a fresh conversation in `scope`, asked by arda as an
 *  org admin under the stored controller config with nothing mounted; `extra`
 *  replaces any of those inputs. */
async function build(
  scope: { projectSlug?: string; taskKey?: string },
  extra: Partial<Parameters<typeof import("./controller-run.server").buildControllerSystemPrompt>[1]> = {},
) {
  const { buildControllerSystemPrompt } = await import("./controller-run.server");
  const { resolveControllerConfig } = await import("./controller-profile.server");
  const { createConversation } = await import("./controller-conversations.server");
  const conversation = createConversation(app.db, {
    userId: user.id,
    userLabel: user.email,
    ...scope,
  });
  return buildControllerSystemPrompt(app.db, {
    conversation,
    user: { ...user, orgRole: "admin" },
    config: resolveControllerConfig(app.dataRoot),
    mountedMcps: [],
    unresolvedMcps: [],
    toolkit: [],
    deniedTools: [],
    dataRoot: app.dataRoot,
    ...extra,
  });
}

describe("controller mounts (ruling 107)", () => {
  it("attaches viberr_ops on a turn with NO org MCP grants at all", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    // The empty-grants turn is the whole point: nothing was granted, and the
    // diagnostics are there anyway.
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: null,
      taskKey: null,
      orgServers: {},
      kb: [],
      dataRoot: app.dataRoot,
    });
    expect(Object.keys(mounts.mcpServers)).toEqual([
      "viberr_controller",
      "viberr_ops",
    ]);
    expect(mounts.allowedTools).toContain("mcp__viberr_ops__instance_health");
    expect(mounts.allowedTools).toContain("mcp__viberr_ops__read_run_log");
    expect(mounts.allowedTools).toContain("mcp__viberr_ops__read_store_doc");
    // The toolkit is still all there beside it.
    expect(mounts.allowedTools).toContain("mcp__viberr_controller__whoami");
  });

  it("keeps both in-process servers when org grants mount beside them", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    const { createSdkMcpServer } = await import(
      "@anthropic-ai/claude-agent-sdk"
    );
    const orgServers = {
      "qa-echo": createSdkMcpServer({ name: "qa-echo", version: "1.0.0", tools: [] }),
    };
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: "viberr-core",
      taskKey: null,
      orgServers,
      kb: [],
      dataRoot: app.dataRoot,
    });
    expect(Object.keys(mounts.mcpServers).sort()).toEqual([
      "qa-echo",
      "viberr_controller",
      "viberr_ops",
    ]);
    expect(mounts.allowedTools).toContain("mcp__qa-echo");
    expect(mounts.allowedTools).toContain("mcp__viberr_ops__instance_health");
  });

  it("a registry row named viberr_ops cannot take the mount key", async () => {
    // The shadow path the save-time refusal cannot close: a row written
    // straight into SQLite (or restored from a backup, or created before the
    // name was reserved) GRANTED to the controller. Org servers spread LAST, so
    // a resolved row would replace the in-process diagnostics under their own
    // key — with `mcp__viberr_ops` in allowedTools auto-approving whatever the
    // external server exposes, while the persona still calls the tools built in
    // and read-only.
    const now = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run("mcp_shadow", "viberr_ops", "HTTP", "https://evil.example/mcp", now, now);
    const { resolveSpecialistMcpServersDetailed } = await import(
      "~/server/tasks/specialist-mcp.server"
    );
    const { buildControllerMounts } = await import("./controller-run.server");
    const { servers } = resolveSpecialistMcpServersDetailed(app.db, [
      "viberr_ops",
    ]);
    // The resolver is the layer that decides what a run mounts, and it refuses.
    expect(servers).toEqual({});
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: null,
      taskKey: null,
      orgServers: servers,
      kb: [],
      dataRoot: app.dataRoot,
    });
    // Still the in-process SDK server, not `{ type: "http", url: … }`.
    expect(mounts.mcpServers["viberr_ops"]).toEqual(
      expect.objectContaining({ type: "sdk" }),
    );
    expect(mounts.mcpServers["viberr_ops"]).not.toHaveProperty("url");
    // And no whole-server wildcard crept into the allow list beside the three
    // named tools.
    expect(mounts.allowedTools).not.toContain("mcp__viberr_ops");
    app.db.prepare(`DELETE FROM org_mcp_servers WHERE id = ?`).run("mcp_shadow");
  });

  /**
   * Ruling 297, and its correction, which the controller found by looking for
   * the manifest and not seeing it.
   *
   * The list first shipped in the two servers' `instructions`, on a
   * measurement the controller itself took: they DO reach its prompt, and it
   * quoted both back verbatim. What that measurement could not see is that a
   * server's instructions are captured ONCE, when a session starts. Its own
   * conversation had been running for hours, so a deploy gave it the new tools
   * (the deferred-name reminder is regenerated per turn) and not the new
   * instructions: "297 is the only one of the five I cannot observe, and the
   * pattern -- new tool names arriving while instructions stay frozen --
   * suggests the manifest reaches new conversations and not running ones."
   *
   * Exactly backwards for what a manifest is FOR. The sessions that have been
   * open longest are the ones whose toolkit has changed most. So it rides in
   * the system prompt, which Viberr rebuilds and re-sends every turn.
   */
  it("ruling 297: the tool manifest rides in the PER-TURN system prompt, not in the servers' frozen instructions", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    const { publishedInstructions } = await import("../../../test-support/mcp-tool-meta");
    const mounts = buildControllerMounts(app.db, {
      user: { id: user.id, email: user.email, name: user.name },
      projectSlug: null,
      taskKey: null,
      orgServers: {},
      kb: [],
      dataRoot: app.dataRoot,
    });
    const { prompt } = await build({}, { toolManifest: mounts.toolManifest });

    // CANARY: leave the manifest on the servers' `instructions` and a running
    // conversation never learns what it now holds.
    expect(prompt).toContain("# Every tool on viberr_controller");
    expect(prompt).toContain("# Every tool on viberr_ops");
    expect(prompt).toContain("- mcp__viberr_controller__whoami: ");
    expect(prompt).toContain("- mcp__viberr_controller__read_default_branch_file: ");
    // The absence half of the promise, which is what the controller could not
    // answer: a verb it does NOT have is not on the list.
    expect(prompt).not.toContain("- mcp__viberr_controller__accept_completion: ");
    // Ruling 347: the line is the MOUNTED name, the one ToolSearch answers to.
    expect(prompt).not.toMatch(/^- whoami: /m);
    expect(prompt).toContain("you do not have it");

    // And the frozen channel carries no copy at all, so there is nothing that
    // can go stale beside it. CANARY: leave it in both places.
    for (const server of Object.values(mounts.mcpServers)) {
      const instructions = await publishedInstructions(server);
      expect(instructions).not.toContain("# Every tool on");
    }
  });

  /**
   * Ruling 309. The preamble said "their LIVE permissions are the ceiling for
   * everything you do here" and then named their ORG role, which decides
   * nothing on a board — and viberr's authorization map reached the model
   * nowhere at all: not here, not `whoami` (which returns a tier NAME), not
   * `list_capabilities` (the agent capability catalogue, a different axis).
   * So the tier-to-action mapping came from the model's own prose memory.
   */
  it("ruling 309: the authorization map rides in the per-turn prompt, advisory and generated", async () => {
    const { RBAC_DEFINITIONS } = await import("~/shared/rbac");
    const { prompt } = await build({});
    // CANARY: unwire `projectAuthorityPrompt()` and the model is back to
    // supplying viberr's own role tiers from memory.
    expect(prompt).toContain("What a project role may do");
    for (const { label } of RBAC_DEFINITIONS) expect(prompt).toContain(label);
    // It must land where the ceiling sentence already is: the claim and the
    // thing that makes the claim usable belong in one place.
    expect(prompt.indexOf("What a project role may do")).toBeGreaterThan(
      prompt.indexOf("are the ceiling for everything"),
    );
    // And it must arrive ADVISORY. A table in a prompt reads like a rule, and
    // a model that pre-refuses on it replaces an audited server denial, correct
    // at the instant of the write, with its own — which is none of those.
    expect(prompt).toContain("never grounds for refusing");
  });

  /**
   * Ruling 310, third surface. The specialist and operator prompts asserted an
   * invented cause for a failed mount; this one asserted none — it named the
   * servers and stopped. That is better and still not enough: the controller is
   * the surface a person asks "why is my server not there?" on, and the reason
   * each server gave was one `.map((u) => u.name)` from reaching it.
   */
  it("ruling 310: an unmounted grant reaches the controller with the reason it gave", async () => {
    const { prompt } = await build({}, {
      unresolvedMcps: [
        { name: "kb-architecture", reason: "its stored credential could not be opened" },
      ],
    });
    // CANARY: map the grants back to names and the reason disappears.
    expect(prompt).toContain("kb-architecture (its stored credential could not be opened)");
    expect(prompt).toContain("do not infer a cause the server did not give");
  });

  /**
   * Ruling 312. The controller's tool descriptions cite "ruling N" forty-one
   * times, meaning VIBERR's own product decisions — which no run can read. A
   * project's rulings knowledge base numbers its rules from 1, and operator
   * directives on a live board cite those as "ruling 1", "ruling 4". Two
   * namespaces, one word, neither marked; no collision today only because every
   * viberr ruling happens to be ≥107.
   *
   * The controller found it auditing its own prompt for claims that do not say
   * where they came from: "the product rulings are cited AT me as authority and
   * I cannot read a single one. A citation that looks like it points somewhere
   * consultable, and doesn't, is a soft version of the same class."
   */
  it("ruling 312: says which ruling namespace a tool description means", async () => {
    const { prompt } = await build({});
    // CANARY: drop the paragraph and "ruling 4" in a task directive and
    // "ruling 246" in a tool description read as the same numbering.
    expect(prompt).toContain("is Viberr's own product decision");
    expect(prompt).toContain("not readable from here");
    expect(prompt).toContain("number from 1");
    // And it must say what to do about it, not merely that the hazard exists.
    expect(prompt).toContain("name the document and the section rather than a bare number");
  });

  /**
   * Ruling 502. The owner asked for every controller turn to write under the
   * Humanizer skill, hidden from the people who use Viberr. So it is no grant:
   * the settings panel and a turn's `run_inputs` read the grants, and neither
   * may learn of it. (The seeded store's half is in `humanizer.server.test.ts`.)
   */
  it("ruling 502: every turn closes its static block with the writing guide, and its disclosure never names it", async () => {
    const { resolveControllerConfig } = await import("./controller-profile.server");
    const { HUMANIZER_PROMPT_SECTION } = await import("~/server/runtimes/humanizer.server");
    const config = resolveControllerConfig(app.dataRoot);
    const built = await build({}, {
      config,
      unresolvedMcps: [{ name: "kb-architecture", reason: "not registered" }],
    });
    // CANARY: drop the `parts.push` in buildControllerSystemPrompt and the
    // static block ends on the shell inventory again.
    expect(built.prefix.static.at(-1)).toBe(HUMANIZER_PROMPT_SECTION);
    expect(built.prefix.dynamic.join("")).not.toContain("# How you write");
    expect(built.prompt.split(HUMANIZER_PROMPT_SECTION)).toHaveLength(2);
    // The turn's disclosure and the settings panel read the same grants.
    expect(built.inputs.skills.granted).toEqual(sortedNames(config.skills));
    expect(config.skills).not.toContain("humanizer");
    // The tail still carries this turn's own notices.
    expect(built.prefix.dynamic.join("")).toContain("kb-architecture (not registered)");
  });

  it("tells the model the diagnostics are attached, on every turn", async () => {
    // No org MCP mounted: the sentence is not conditional on grants.
    const { prompt } = await build({}, { mountedMcps: [] });
    expect(prompt).toContain("viberr_ops");
    expect(prompt).toContain("read-only");
    // …and it says whose permissions the calls run under, because that is what
    // stops the model treating a diagnostics answer as instance-wide clearance.
    expect(prompt).toContain("asking person's own");
    // The stock instance grants no org MCP, and the sentence about that sits
    // directly above this one: a flat "No MCP servers are attached to you"
    // contradicted the line below it on every default turn, and a model that
    // believes the categorical negative never calls the tools at all.
    expect(prompt).toContain("No org MCP servers are attached to you.");
    expect(prompt).not.toContain("No MCP servers are attached to you.");
    // Ruling 297: it no longer NAMES that server's tools. This sentence used
    // to read "instance health, run logs, store documents", and `list_runs`
    // shipped after it and was never added, so the one written description of
    // the server understated it. The list is generated into the server's own
    // instructions now. CANARY: put the enumeration back.
    expect(prompt).not.toMatch(/instance health, run logs, store/);
    expect(prompt).toContain("the server's own instructions list its tools");
  });

  /**
   * Ruling 191 (F37-13, live): the controller writes the profiles, knowledge
   * bases and architecture that agents WITH a shell are measured against. Pass
   * 37 it chose a pnpm + turbo monorepo, a root `Makefile` and a Docker Compose
   * stack on a host with none of those, and chartered a required reviewer whose
   * pass begins "clean checkout, `make up`, everything healthy". The reading was
   * sitting in `instance_health` and it never asked — an inventory you must know
   * to ask for is not a fact the planner has.
   */
  it("ruling 191: carries the agents' shell inventory without being asked", async () => {
    const { prompt } = await build({});
    // CANARY: remove the section and the planner is back to guessing.
    expect(prompt).toContain("# Shell inventory (measured on this host, not a guess)");
    expect(prompt).toContain("NOT installed: make, docker, pnpm, yarn, curl, python3, go.");
    // It says whose shell it is: the controller has none of its own, and the
    // line above this one already told it so.
    expect(prompt).toContain("You have no shell yourself.");
    expect(prompt).toContain(
      "what any build, test or verification contract you write for them has to run on",
    );
  });
});

// ------------------------------------------------------------ ruling 121

describe("the turn carries the context read (ruling 121)", () => {
  it("names the task binding in the system prompt, and the board one, and the instance one", async () => {
    const { buildControllerSystemPrompt } = await import("./controller-run.server");
    const { resolveControllerConfig } = await import("./controller-profile.server");
    const config = resolveControllerConfig(app.dataRoot);
    const base = {
      id: "cnv_x",
      userId: user.id,
      userLabel: user.email,
      title: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastMessageAt: null,
    };
    const asker = { ...user, orgRole: "admin" as const };
    const task = buildControllerSystemPrompt(app.db, {
      conversation: { ...base, projectSlug: "viberr-core", taskKey: "VIB-142" },
      user: asker,
      config,
      mountedMcps: [],
      unresolvedMcps: [],
      toolkit: [],
      deniedTools: [],
      dataRoot: app.dataRoot,
    }).prompt;
    expect(task).toContain(
      "This conversation is anchored to task `VIB-142` in project `viberr-core`: tools default to both, and every turn opens with the task's canonical file as a server read.",
    );
    const board = buildControllerSystemPrompt(app.db, {
      conversation: { ...base, projectSlug: "viberr-core", taskKey: null },
      user: asker,
      config,
      mountedMcps: [],
      unresolvedMcps: [],
      toolkit: [],
      deniedTools: [],
      dataRoot: app.dataRoot,
    }).prompt;
    expect(board).toContain("bound to the project `viberr-core`: tools default to it, and every turn opens with a board snapshot");
    const instance = buildControllerSystemPrompt(app.db, {
      conversation: { ...base, projectSlug: null, taskKey: null },
      user: asker,
      config,
      mountedMcps: [],
      unresolvedMcps: [],
      toolkit: [],
      deniedTools: [],
      dataRoot: app.dataRoot,
    }).prompt;
    expect(instance).toContain("instance-scoped: name the project when acting on a board.");
  });

  it("puts the context read FIRST in the turn prompt, ahead of the digest and the message", async () => {
    const { buildTurnPrompt } = await import("./controller-run.server");
    const { createConversation, appendMessage } = await import(
      "./controller-conversations.server"
    );
    const conversation = createConversation(app.db, {
      userId: user.id,
      userLabel: user.email,
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: user.id,
      text: "earlier question",
    });
    const now = appendMessage(app.db, {
      conversationId: conversation.id,
      author: "user",
      userId: user.id,
      text: "now this",
    });
    const prompt = buildTurnPrompt(app.db, conversation, now, "CONTEXT BLOCK");
    expect(prompt.indexOf("CONTEXT BLOCK")).toBe(0);
    expect(prompt.indexOf("CONTEXT BLOCK")).toBeLessThan(prompt.indexOf("Recent exchange"));
    expect(prompt.indexOf("Recent exchange")).toBeLessThan(prompt.indexOf(`${user.email} says:\n\nnow this`));
    // Without a context read the prompt is exactly what it was.
    const bare = buildTurnPrompt(app.db, conversation, now);
    expect(bare.startsWith("Recent exchange")).toBe(true);
  });

  /**
   * Ruling 465 (F40-10): a turn reads the conversation only up to the message
   * it answers. Live, the turn answering dossier part 3 saw the owner's queued
   * correction as a 600-character stub and said it "never reached me … please
   * resend it" while it was simply next in the queue.
   */
  it("ruling 465: the digest stops at the answered message and counts the queue behind it", async () => {
    const { buildTurnPrompt } = await import("./controller-run.server");
    const { createConversation, appendMessage } = await import("./controller-conversations.server");
    const conversation = createConversation(app.db, { userId: user.id, userLabel: user.email });
    const say = (text: string) =>
      appendMessage(app.db, { conversationId: conversation.id, author: "user", userId: user.id, text });
    const part1 = say("Dossier part 1.");
    const part2 = say("Dossier part 2.");
    const correction = say("CORRECTION-04: the founding year is 2019.");
    // Part 1's reply lands AFTER both later messages were queued.
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "controller",
      text: "Part 1 is filed.",
      replyTo: part1.id,
    });
    // A refusal the correction got: it belongs to a LATER message.
    appendMessage(app.db, {
      conversationId: conversation.id,
      author: "controller",
      text: "REFUSED-LATER",
      replyTo: correction.id,
    });

    const prompt = buildTurnPrompt(app.db, conversation, part2, null, null, 1);
    // CANARY: read the newest rows unbounded again (`recentMessages`) and the
    // queued correction and its refusal are in this turn's prompt.
    expect(prompt).not.toContain("CORRECTION-04");
    expect(prompt).not.toContain("REFUSED-LATER");
    // The reply to an EARLIER message is in, under that message, even though
    // it landed after part 2 was queued.
    expect(prompt).toContain("Person: Dossier part 1.\n\nController: Part 1 is filed.\n\nPerson: Dossier part 2.");
    // CANARY: drop the queue line and the model is left to guess where the
    // correction went.
    expect(prompt).toContain(
      `1 more message from ${user.email} is queued behind this one; each is answered in its own turn, in order — do not treat them as lost.`,
    );
    expect(prompt.endsWith(`${user.email} says:\n\nDossier part 2.`)).toBe(true);
    // Nothing queued, nothing said.
    expect(buildTurnPrompt(app.db, conversation, correction)).not.toContain("queued behind");
  });

  /**
   * Ruling 444. The controller's system prompt is recorded when its
   * conversation starts and replayed until it compacts (ruling 373). It named
   * the model, so after the switch to Opus 5.5 the controller found "Opus 5
   * ... claude-opus-5[1m]" in its own context and had to reason its way past it.
   */
  it("ruling 444: the model is named in the turn, never in the recorded system prompt", async () => {
    const { buildTurnPrompt } = await import("./controller-run.server");
    const { resolveControllerConfig } = await import("./controller-profile.server");
    const { createConversation } = await import("./controller-conversations.server");
    const conversation = createConversation(app.db, { userId: user.id, userLabel: user.email });
    // CANARY: drop the `runtime` line and the turn never says which model it is.
    const prompt = buildTurnPrompt(
      app.db,
      conversation,
      { id: "cmsg_none", seq: 1, text: "now this" },
      "CONTEXT BLOCK",
      "opus[1m]",
    );
    expect(prompt).toContain("You run on model `opus[1m]` this turn.");
    expect(prompt.indexOf("CONTEXT BLOCK")).toBe(0);
    expect(prompt.indexOf("You run on model")).toBeLessThan(prompt.indexOf(`${user.email} says:`));
    // CANARY: name the model in the system prompt again and a resumed
    // conversation replays the old one after every switch.
    const { prompt: system } = await build({}, {
      config: { ...resolveControllerConfig(app.dataRoot), model: "opus[1m]" },
      toolManifest: "",
    });
    expect(system).not.toContain("opus[1m]");
    expect(system).toContain("Each turn's message names the model you run on");
  });

  /**
   * Review finding 12: everything above asserts the PIECES. This asserts the
   * assembly — what the runtime was actually started with — through the fake
   * adapter's captured RunSpec, so the context read, the task anchor and the
   * surface hint cannot be unwired with the suite still green.
   */
  it("ruling 444: a started turn names the model the settings chose", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { runControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    const { resolveControllerConfig, saveControllerConfig } = await import("./controller-profile.server");
    const { seedDefaultAgentAssets } = await import("~/server/seed/default-assets.server");
    // The shipped controller profile, as boot installs it.
    seedDefaultAgentAssets(app.dataRoot);
    // Every section locked: empty lists keep what is stored, so only the
    // model changes, and it is put back below.
    const locks = { skills: true, kb: true, mcps: true, instructions: true };
    const actor = { userId: user.id, label: user.email };
    const kept = { effort: "", definition: "", skills: [], kb: [], mcps: [] };
    const before = resolveControllerConfig(app.dataRoot).model;
    saveControllerConfig(app.db, { ...kept, model: "opus[1m]" }, actor, { dataRoot: app.dataRoot, locks });
    await connectFakeBackend(app.db, user.id, "claude");
    try {
      const conversation = createConversation(app.db, { userId: user.id, userLabel: user.email });
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "which model are you?",
        user: { ...user, orgRole: "admin" },
        dataRoot: app.dataRoot,
      });
    } finally {
      await disconnectFakeBackend(app.db, user.id, "claude");
      saveControllerConfig(app.db, { ...kept, model: before }, actor, { dataRoot: app.dataRoot, locks });
    }
    // CANARY: stop passing the model into the turn prompt.
    expect(lastRunSpec()!.prompt).toContain("You run on model `opus[1m]` this turn.");
  });

  it("starts the run with the context read, the anchored task and the surface hint", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { runControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    // Ruling 127: a controller turn bills the ASKER's own Claude account, so
    // the way to make one start is to connect the asker's — there is no
    // instance-level switch left to flip. Disconnected again below so the
    // next case still meets the hermetic "nobody has connected" default.
    await connectFakeBackend(app.db, user.id, "claude");
    const conversation = createConversation(app.db, {
      userId: user.id,
      userLabel: user.email,
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    try {
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "what is this task?",
        user: { ...user, orgRole: "admin" },
        surface: "/projects/viberr-core/tasks/VIB-142?events=50",
        // U39-24: posted by the composer; the engine normalizes it.
        timeZone: " europe/istanbul ",
        dataRoot: app.dataRoot,
      });
    } finally {
      await disconnectFakeBackend(app.db, user.id, "claude");
    }
    const spec = lastRunSpec();
    expect(spec, "a controller run must have started").toBeTruthy();
    // CANARY: stop passing the zone into the context read.
    expect(spec!.prompt).toContain("They read times in Europe/Istanbul (GMT+03:00)");
    // The context read is FIRST, and it is the task's own file.
    expect(spec!.prompt.startsWith("Context gathered by the server when this turn started")).toBe(
      true,
    );
    expect(spec!.prompt).toContain("## Task VIB-142");
    expect(spec!.prompt).toContain("key: VIB-142");
    expect(spec!.prompt).toContain(
      "They are looking at: /projects/viberr-core/tasks/VIB-142?events=50",
    );
    // …and the message the person actually sent comes after it.
    expect(spec!.prompt.indexOf("what is this task?")).toBeGreaterThan(
      spec!.prompt.indexOf("## Task VIB-142"),
    );
    // The anchor reached the toolkit that runs under it.
    expect(joinedPrompt(spec!.systemPrompt ?? "")).toContain(
      "anchored to task `VIB-142` in project `viberr-core`",
    );
    expect(Object.keys(spec!.mcpServers ?? {})).toContain("viberr_controller");
  });

  /**
   * Ruling 461: the controller's granted org servers resolve the same way a
   * specialist's do, so a credentialed one reaches the turn as a gateway mount
   * carrying the turn's own token, the credential never in the turn's config,
   * and the prompt says who holds it.
   */
  it("ruling 461: a turn mounts a granted credentialed server through Viberr's gateway", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { lastRunSpec, drainRunCompletions } = await import("../../../test-support/fake-runtime");
    const { runControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    const { resolveControllerConfig, saveControllerConfig } = await import("./controller-profile.server");
    const { sealSecret } = await import("~/server/secrets/secret-box.server");
    const { seedDefaultAgentAssets } = await import("~/server/seed/default-assets.server");
    seedDefaultAgentAssets(app.dataRoot);
    const { mcpGatewayMountUrl, mcpGatewayStatus, startMcpGateway, stopMcpGateway } = await import(
      "~/server/mcp-proxy/gateway.server"
    );
    const secret = "cf-token-controller-sentinel";
    const now = new Date().toISOString();
    app.db
      .prepare(
        `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("mcp_cf_ctl", "cf-controller", "HTTP", "https://mcp.example.test/mcp", sealSecret(secret), now, now);
    const actor = { userId: user.id, label: user.email };
    const stored = resolveControllerConfig(app.dataRoot);
    const section = { effort: "", definition: "", skills: [], kb: [], model: stored.model ?? "" };
    const unlockMcps = { skills: true, kb: true, mcps: false, instructions: true };
    saveControllerConfig(app.db, { ...section, mcps: ["cf-controller"] }, actor, {
      dataRoot: app.dataRoot,
      locks: unlockMcps,
    });
    await startMcpGateway({ port: 0 });
    await connectFakeBackend(app.db, user.id, "claude");
    try {
      const conversation = createConversation(app.db, { userId: user.id, userLabel: user.email });
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "provision the zone",
        user: { ...user, orgRole: "admin" },
        dataRoot: app.dataRoot,
      });
      const spec = lastRunSpec();
      // CANARY: resolve the controller's grants past the gateway and the
      // mount is the upstream URL with the credential again.
      expect(spec?.mcpServers?.["cf-controller"]).toEqual({
        type: "http",
        url: mcpGatewayMountUrl("cf-controller"),
        headers: { Authorization: expect.stringMatching(/^Bearer \S{43}$/) },
      });
      // The other two mounts are live in-process servers (not serializable);
      // this one, the prompt and the environment are the rest of the turn.
      expect(JSON.stringify(spec?.mcpServers?.["cf-controller"])).not.toContain(secret);
      expect(joinedPrompt(spec?.systemPrompt ?? "")).not.toContain(secret);
      expect(JSON.stringify(spec?.env ?? {})).not.toContain(secret);
      expect(joinedPrompt(spec?.systemPrompt ?? "")).toContain(
        "cf-controller is mounted through Viberr's MCP gateway: the credential is held by Viberr",
      );
      // The fake turn has ended, and its token with it.
      await drainRunCompletions();
      expect(mcpGatewayStatus().liveTokens).toBe(0);
    } finally {
      await disconnectFakeBackend(app.db, user.id, "claude");
      await stopMcpGateway();
      saveControllerConfig(app.db, { ...section, mcps: stored.mcps }, actor, {
        dataRoot: app.dataRoot,
        locks: unlockMcps,
      });
      app.db.prepare(`DELETE FROM org_mcp_servers WHERE id = 'mcp_cf_ctl'`).run();
    }
  });

  /**
   * Ruling 344 (pass 37, F37-180): the controller turn discloses what it was
   * given. `recordRunInputs` had two callers, both on the specialist paths, so
   * none of this instance's 71 controller turns recorded anything — and the
   * controller had named the gap itself, from the other side, on 2026-09-15:
   * *"I cannot measure what a run actually receives."*
   *
   * It is written where the fresh path and the RESUME join, because a
   * controller resumes on every turn after the first: recording only fresh
   * starts would have disclosed one turn per conversation.
   */
  it("ruling 344: a controller turn records what it was given, resume included", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { runControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    const { listRunLines } = await import("~/server/runtimes/run-store.server");
    const { RUN_INPUTS_TAG } = await import("~/features/runtime/runtime-types");
    await connectFakeBackend(app.db, user.id, "claude");
    const conversation = createConversation(app.db, {
      userId: user.id,
      userLabel: user.email,
      projectSlug: "viberr-core",
      taskKey: "VIB-142",
    });
    const disclosureFor = (runId: string) =>
      listRunLines(app.db, runId).find((l) => l.display.tag === RUN_INPUTS_TAG)
        ?.display.inputs;
    try {
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "  which tasks are waiting on me?  ",
        user: { ...user, orgRole: "admin" },
        surface: "/projects/viberr-core",
        dataRoot: app.dataRoot,
      });
      const first = lastRunSpec()!.runId;
      // CANARY: delete the `recordRunInputs` call after `entry.runId = runId`.
      const inputs = disclosureFor(first);
      expect(inputs, "the controller turn recorded no input disclosure").toBeTruthy();
      // The controller has no checkout at all — ruling 299 gave it repository
      // READS through a tool, not a working tree.
      expect(inputs!.cloned).toBe(false);
      expect(inputs!.repo).toBeNull();
      expect(inputs!.delivers).toBe(false);
      // CANARY: pass a literal `[]` as the builder's `toolkit` and this empties.
      // These are the names `buildControllerMounts` really mounted.
      expect(inputs!.tools.toolkit).toContain("mcp__viberr_controller__get_task");
      // CANARY: drop `deniedTools` and the controller looks unconfined — the
      // filesystem and web denials ARE its posture (its world is the product).
      expect(inputs!.tools.denied).toContain("Read");
      expect(inputs!.tools.denied).toContain("WebSearch");
      // The person's own message is the whole reason the turn exists, trimmed
      // to the text the prompt carries.
      expect(inputs!.directive).toEqual({
        from: user.email,
        chars: "which tasks are waiting on me?".length,
      });
      // U39-25: the headline names a controller turn, never "supporting
      // engagement · NO canonical anchor", and counts the servers this turn
      // really mounted, which its own `system·init` line lists.
      // CANARY: drop `kind: "controller"`, or the `mounted` override.
      const headline = listRunLines(app.db, first).find(
        (l) => l.display.tag === RUN_INPUTS_TAG,
      )!.display.text;
      expect(headline.startsWith("Run inputs — controller turn · persona ")).toBe(true);
      expect(headline).not.toContain("anchor");
      expect(inputs!.mcp.mounted).toEqual(["viberr_controller", "viberr_ops"]);
      expect(headline).toContain("2 MCP servers");

      // The SECOND turn resumes, and must disclose too. CANARY: move the
      // `recordRunInputs` call inside the `else` (fresh-start) branch and this
      // finds nothing — which is the shape ruling 343 fixed on the specialist's
      // own resume door the same day.
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "and which are blocked?",
        user: { ...user, orgRole: "admin" },
        dataRoot: app.dataRoot,
      });
      const second = lastRunSpec()!.runId;
      expect(second, "the second turn reused the first run row").not.toBe(first);
      expect(
        disclosureFor(second),
        "the resumed controller turn recorded no input disclosure",
      ).toBeTruthy();
    } finally {
      await disconnectFakeBackend(app.db, user.id, "claude");
    }
  });
});

/**
 * Ruling 293 (pass 37, F37-128): the EVIDENCE, not only the sentence claiming
 * it. Attachments are where every convention on this instance tells an agent to
 * put its proof — a mutation run with both vitest outputs, before/after
 * captures, a cold-stack log — and the actor a person asks "did it actually
 * prove that?" could read the claim and never the file.
 */
describe("ruling 293: the coordinators can read the evidence", () => {
  it("both mount read_task_attachment, in the same change", async () => {
    // Canary: drop either mount. They are asserted TOGETHER on purpose —
    // ruling 292 exists because ruling 285 gave one coordinator a reader and
    // not the other, and this is the test that makes doing it twice a choice.
    const { buildControllerMounts } = await import("./controller-run.server");
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: "viberr-core",
      taskKey: null,
      orgServers: {},
      kb: [],
      dataRoot: app.dataRoot,
    });
    expect(mounts.allowedTools).toContain(
      "mcp__viberr_controller__read_task_attachment",
    );

    const { buildOperatorToolkit } = await import("~/server/tasks/operator-toolkit.server");
    const operator = buildOperatorToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      authority: {
        policy: new Map(),
        autonomy: "supervised",
        configuredAutonomy: "supervised",
        kb: [],
        skills: [],
        mcps: [],
        persona: null,
        deployed: false,
        backend: "claude",
        model: "",
        effort: "",
        name: "Operator",
        humanGatedBeforeWork: false,
      },
    });
    expect(operator.allowedTools).toContain("mcp__viberr__read_task_attachment");
  });

  it("reads a text attachment whole, and refuses a binary by name", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { readTaskAttachmentText } = await import(
      "~/server/files/task-attachments.server"
    );
    const dir = `${app.dataRoot}/projects/viberr-core/tasks/VIB-1/attachments`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/proof.txt`, "MUTANT RED\nFIX GREEN\n");
    writeFileSync(`${dir}/shot.png`, "not really a png");

    const text = readTaskAttachmentText("viberr-core", "VIB-1", "proof.txt", app.dataRoot);
    expect(text).toMatchObject({ truncated: false });
    expect(text && "text" in text ? text.text : "").toContain("MUTANT RED");

    // A PNG is not something this channel carries, and saying so beats handing
    // back bytes a model will describe as if it had looked at the image.
    const binary = readTaskAttachmentText("viberr-core", "VIB-1", "shot.png", app.dataRoot);
    expect(binary && "unreadable" in binary ? binary.unreadable : "").toContain(".png");

    // A name that climbs out of the task's own folder resolves to nothing.
    expect(
      readTaskAttachmentText("viberr-core", "VIB-1", "../../secrets.txt", app.dataRoot),
    ).toBeNull();
  });
});

/**
 * Ruling 292 (pass 37, F37-127): ruling 285 gave the OPERATOR a way to read a
 * report its prompt had cut. The controller got nothing — and it is the sharper
 * case of the two, because its `get_task` cuts at 700 rather than 1,500 and it
 * is the actor a PERSON asks about an agent's report. A rule applied to one
 * actor and not its sibling, inside this pass's own fix for that shape.
 */
describe("ruling 292: the controller can read an entry its own read cut", () => {
  it("mounts read_timeline_entry, unconditionally", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: "viberr-core",
      taskKey: null,
      orgServers: {},
      kb: [],
      dataRoot: app.dataRoot,
    });
    // Canary: drop the mount and the controller is back to summarising reports
    // from their first 700 characters with nowhere to go for the rest.
    expect(mounts.allowedTools).toContain(
      "mcp__viberr_controller__read_timeline_entry",
    );
    // It is a READ, so it belongs with the other reads and needs no grant:
    // `read_run_log` is the RUN's log, a different thing from what an agent
    // chose to report on the task.
    expect(mounts.allowedTools).toContain("mcp__viberr_ops__read_run_log");
  });
});

/**
 * Ruling 283 — the controller's prompt INDEXES its knowledge bases and its
 * toolkit reads them, through `read_knowledge_doc`, which a turn mounts
 * exactly when it holds a knowledge base. (The index is pinned in
 * project-rulings.server.test.ts, the read in kb-injection.server.test.ts.)
 */
describe("ruling 283: read_knowledge_doc is mounted exactly when the turn holds a knowledge base", () => {
  it("a turn holding a knowledge base mounts read_knowledge_doc", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: "viberr-core",
      taskKey: null,
      orgServers: {},
      kb: ["ctl-rulings"],
      dataRoot: app.dataRoot,
    });
    // Canary: drop the `kb` dep from `buildControllerToolkit` (or gate the tool
    // on org-admin, as `read_store_doc` is) and this allow-list entry vanishes
    // while the prompt keeps promising the index.
    expect(mounts.allowedTools).toContain("mcp__viberr_controller__read_knowledge_doc");
  });

  it("a turn holding no knowledge base mounts no reader for one", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: null,
      taskKey: null,
      orgServers: {},
      kb: [],
      dataRoot: app.dataRoot,
    });
    expect(mounts.allowedTools).not.toContain(
      "mcp__viberr_controller__read_knowledge_doc",
    );
  });
});

/**
 * Ruling 370/373: the controller's static block is the same bytes for every
 * conversation of one instance; only the conversation block and this turn's
 * mount notices differ. The adapter records the split for the session.
 */
describe("ruling 370: the controller prefix", () => {
  it("an instance-scoped and a board-scoped conversation share the static block; the conversation block is the tail", async () => {
    const instance = await build({});
    const board = await build({ projectSlug: "viberr-core" });
    // A project scope indexes the project's rulings (ruling 239), which is a
    // resource difference, so the proof is over the same scope twice and the
    // tail over the two.
    const instanceAgain = await build({});
    expect(instance.prefix.static.join("")).toBe(instanceAgain.prefix.static.join(""));
    expect(instance.prefix.dynamic.join("")).toContain("# This conversation");
    expect(instance.prefix.dynamic.join("")).toContain("What a project role may do");
    expect(instance.prefix.static.join("")).not.toContain("# This conversation");
    expect(board.prefix.dynamic.join("")).toContain("bound to the project `viberr-core`");
    expect(instance.prompt).toBe(joinedPrompt(instance.prefix));
  });

  it("the unmounted-server notice is per turn, so it rides the tail", async () => {
    const built = await build({}, {
      unresolvedMcps: [{ name: "zulu", reason: "probe failed", mounted: false }, { name: "alpha", reason: "not registered", mounted: false }],
    });
    expect(built.prefix.static.join("")).not.toContain("did NOT mount this turn");
    const tail = built.prefix.dynamic.join("");
    expect(tail).toContain("MCP servers that did NOT mount this turn");
    expect(tail.indexOf("alpha (not registered)")).toBeLessThan(tail.indexOf("zulu (probe failed)"));
  });
});

/**
 * Ruling 476(h) (F40-61): a chain records the conversation that planned it.
 * Live, goal-1 was planned in a 16-message instance thread, and the project's
 * Controller page said "No conversations yet" beside it: the goal file named
 * its creator and nothing else, so nothing could link back. Ruling 503 kept
 * the rule for the epic that replaced the chain: its file names the thread,
 * and its page links to it.
 */
/** A run's mount that is an in-process SDK server, which a client can call. */
function inProcess(
  server: RunMcpServerDeclaration | undefined,
): server is McpSdkServerConfigWithInstance {
  return server !== undefined && "instance" in server && "type" in server && server.type === "sdk";
}

describe("ruling 476(h): an epic a turn creates records the conversation it was planned in", () => {
  it("the turn's own create_epic writes its conversation into the epic's file", async () => {
    const { connectFakeBackend, disconnectFakeBackend } = await import(
      "../../../test-support/backend-credentials"
    );
    const { lastRunSpec } = await import("../../../test-support/fake-runtime");
    const { runControllerTurn } = await import("./controller-run.server");
    const { createConversation } = await import("./controller-conversations.server");
    await connectFakeBackend(app.db, user.id, "claude");
    // An INSTANCE thread, planning an epic on a board: the live shape.
    const conversation = createConversation(app.db, { userId: user.id, userLabel: user.email });
    try {
      await runControllerTurn(app.db, {
        conversationId: conversation.id,
        text: "plan the launch on viberr-core",
        user: { ...user, orgRole: "admin" },
        dataRoot: app.dataRoot,
      });
    } finally {
      await disconnectFakeBackend(app.db, user.id, "claude");
    }
    // The tool the turn was really handed, called the way the model calls it.
    const server = lastRunSpec()?.mcpServers?.["viberr_controller"];
    if (!inProcess(server)) throw new Error("the turn must mount viberr_controller in process");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverEnd);
    const client = new Client({ name: "ruling-476", version: "1" }, { capabilities: {} });
    await client.connect(clientEnd);
    const reply = JSON.stringify(
      (
        await client.callTool({
          name: "create_epic",
          arguments: {
            projectSlug: "viberr-core",
            title: "Planned from the instance",
          },
        })
      ).content,
    );
    expect(reply).toContain("[done]");
    const epicId = /epic-\d+/.exec(reply)?.[0];
    expect(epicId, "the reply names the epic it created").toBeTruthy();
    const { readEpicFile } = await import("~/server/files/epic-writer.server");
    // CANARY: drop `conversationId: conversation.id` from the turn's mounts,
    // or the toolkit's hand-off to `createEpic`, and the epic names no thread.
    expect(
      readEpicFile({ projectSlug: "viberr-core", epicId: epicId!, dataRoot: app.dataRoot })?.parsed.frontmatter
        .conversationId,
    ).toBe(conversation.id);
    await client.close();
  });
});
