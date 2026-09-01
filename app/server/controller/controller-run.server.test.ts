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

describe("controller mounts (ruling 107)", () => {
  it("attaches viberr_ops on a turn with NO org MCP grants at all", async () => {
    const { buildControllerMounts } = await import("./controller-run.server");
    // The empty-grants turn is the whole point: nothing was granted, and the
    // diagnostics are there anyway.
    const mounts = buildControllerMounts(app.db, {
      user,
      projectSlug: null,
      orgServers: {},
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
      orgServers,
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
      orgServers: servers,
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

  it("tells the model the diagnostics are attached, on every turn", async () => {
    const { buildControllerSystemPrompt } = await import(
      "./controller-run.server"
    );
    const { resolveControllerConfig } = await import(
      "./controller-profile.server"
    );
    const { createConversation } = await import(
      "./controller-conversations.server"
    );
    const conversation = createConversation(app.db, {
      userId: user.id,
      userLabel: user.email,
    });
    const prompt = buildControllerSystemPrompt(app.db, {
      conversation,
      user: { ...user, orgRole: "admin" },
      config: resolveControllerConfig(app.dataRoot),
      // No org MCP mounted: the sentence is not conditional on grants.
      mountedMcps: [],
      unresolvedMcps: [],
      dataRoot: app.dataRoot,
    });
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
  });
});
