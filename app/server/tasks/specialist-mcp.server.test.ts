import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import {
  getMcpCredentialState,
  listMcpServers,
  type McpSpawn,
} from "~/server/org/resources.server";
import {
  mcpGatewayMountUrl,
  startMcpGateway,
  stopMcpGateway,
} from "~/server/mcp-proxy/gateway.server";
import { logger } from "~/server/logging/logger.server";
import { sealSecret } from "~/server/secrets/secret-box.server";
import { RESERVED_MCP_NAMES } from "~/shared/mcp-reserved";
import {
  resolveSpecialistMcpServers,
  resolveSpecialistMcpServersDetailed,
  unavailableMcpSection,
  verifyStdioMcpMountsForRun,
} from "./specialist-mcp.server";

/** The two JSON-RPC replies the fake child speaks back over stdout. */
interface HandshakeReply {
  jsonrpc: string;
  id: number;
  result: { capabilities?: object; tools?: { name: string }[] };
}

/** Only the field the fake dispatches on; the rest of the request is ignored. */
const rpcRequestSchema = z.object({ method: z.string().optional() });

/** A stdio child that answers the JSON-RPC handshake with `tools` tools. */
function handshakeSpawn(tools: number): McpSpawn {
  return () => {
    const out = new EventEmitter();
    const emit = (reply: HandshakeReply) =>
      queueMicrotask(() => out.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`)));
    return {
      stdin: {
        write(data: string) {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const msg = rpcRequestSchema.parse(JSON.parse(t));
            if (msg.method === "initialize") {
              emit({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
            } else if (msg.method === "tools/list") {
              emit({
                jsonrpc: "2.0",
                id: 2,
                result: { tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })) },
              });
            }
          }
        },
        end() {},
      },
      stdout: { on: (e, cb) => out.on(e, cb) },
      stderr: { on() {} },
      on() {},
      kill() {},
    };
  };
}

/** A stdio child that dies at spawn the way a half-installed npx tree does. */
function crashSpawn(stderrText: string): McpSpawn {
  return () => {
    const err = new EventEmitter();
    const exit = new EventEmitter();
    queueMicrotask(() => {
      err.emit("data", Buffer.from(stderrText));
      queueMicrotask(() => exit.emit("exit", 1));
    });
    return {
      stdin: { write() {}, end() {} },
      stdout: { on() {} },
      stderr: { on: (e, cb) => err.on(e, cb) },
      on: (e, cb) => {
        if (e === "exit") exit.on("exit", cb);
      },
      kill() {},
    };
  };
}

/** One child of {@link heldSpawn}: its command line, and how the test ends its handshake. */
interface HeldChild {
  command: string;
  /** The probe has settled and killed this child. */
  readonly killed: boolean;
  /** Answer the handshake with one tool, as `handshakeSpawn(1)`'s child does. */
  answer(): void;
  /** Die the way `crashSpawn`'s child does. */
  crash(stderrText: string): void;
}

/**
 * Ruling 700(b): children that hold their handshake until the test ends it, so
 * a test decides which probe finishes when. `aliveAtSpawn` records, at each
 * spawn, how many children were alive (spawned and not yet killed by the
 * probe) counting the new one.
 */
function heldSpawn() {
  const held: HeldChild[] = [];
  const aliveAtSpawn: number[] = [];
  let alive = 0;
  const spawnImpl: McpSpawn = (command, args) => {
    const io = new EventEmitter();
    let answering = false;
    let killed = false;
    alive += 1;
    aliveAtSpawn.push(alive);
    const emit = (reply: HandshakeReply) =>
      queueMicrotask(() => io.emit("stdout", Buffer.from(`${JSON.stringify(reply)}\n`)));
    held.push({
      command: [command, ...args].join(" "),
      get killed() {
        return killed;
      },
      answer() {
        answering = true;
        emit({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
      },
      crash(stderrText) {
        queueMicrotask(() => {
          io.emit("stderr", Buffer.from(stderrText));
          io.emit("exit", 1);
        });
      },
    });
    return {
      stdin: {
        write(data: string) {
          if (answering && rpcRequestSchema.parse(JSON.parse(data)).method === "tools/list") {
            emit({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "t0" }] } });
          }
        },
        end() {},
      },
      stdout: { on: (_e, cb) => io.on("stdout", cb) },
      stderr: { on: (_e, cb) => io.on("stderr", cb) },
      on: (e, cb) => {
        if (e === "exit") io.on("exit", cb);
      },
      kill() {
        if (killed) return;
        killed = true;
        alive -= 1;
      },
    };
  };
  return { spawnImpl, held, aliveAtSpawn };
}

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function addMcp(
  db: ReturnType<typeof setupTestStore>["db"],
  name: string,
  transport: "HTTP" | "stdio",
  target: string,
  sealedCred: string | null = null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(`mcp_${name}`, name, transport, target, sealedCred, now, now);
}

/** Ruling 176: mark a registry row's write tools, as the editor's save does. */
function markWriteTools(
  db: ReturnType<typeof setupTestStore>["db"],
  name: string,
  tools: string[],
): void {
  db.prepare(`UPDATE org_mcp_servers SET tool_policy_json = ? WHERE name = ?`).run(
    JSON.stringify(tools.map((tool) => ({ name: tool, gate: "repo-write" }))),
    name,
  );
}

describe("resolveSpecialistMcpServers (item-1: MCP wiring)", () => {
  it.each([
    {
      row: "an HTTP row",
      name: "billing-api",
      transport: "HTTP",
      target: "https://mcp.example/sse",
      config: { type: "http", url: "https://mcp.example/sse" },
    },
    {
      row: "a stdio row (command + args)",
      name: "pg-ro",
      transport: "stdio",
      target: "npx -y @mcp/server-postgres",
      config: { command: "npx", args: ["-y", "@mcp/server-postgres"] },
    },
    {
      row: "a quoted stdio command, its arguments whole (P14-KM-04)",
      name: "quoted",
      transport: "stdio",
      target: `"/opt/my tools/mcp" --config '{"a": 1}'`,
      config: { command: "/opt/my tools/mcp", args: ["--config", '{"a": 1}'] },
    },
  ] as const)("builds the mcpServer config from $row", ({ name, transport, target, config }) => {
    const store = setupTestStore(ctx);
    addMcp(store.db, name, transport, target);
    expect(resolveSpecialistMcpServers(store.db, [name])).toEqual({ [name]: config });
  });

  it("ruling 107: every name on the ONE reserved list resolves to nothing, even as a registry row", () => {
    const store = setupTestStore(ctx);
    // Every name Viberr's own tooling owns, written STRAIGHT into SQLite — the
    // path the save-time refusal cannot reach: a hand-written row, a restored
    // backup, or a row created back when the name was still legal. This layer
    // kept a private copy of the list and fell two rulings behind it, so a
    // `viberr_ops` row resolved normally and, because org servers mount LAST,
    // replaced the instance's own diagnostics under its own mount key while the
    // persona still promised read-only built-in tools.
    const names = [...RESERVED_MCP_NAMES];
    for (const name of names) {
      addMcp(store.db, name, "HTTP", `https://evil.example/${name}`);
    }
    const resolved = resolveSpecialistMcpServersDetailed(store.db, names);
    expect(resolved.servers).toEqual({});
    // Reserved names are BUILT in-process, not broken grants — nothing to
    // report to the run, and nothing for the persona to contradict itself over.
    expect(resolved.unresolved).toEqual([]);
    // The rows really are in the registry: the refusal above is a refusal, not
    // an empty database.
    expect(listMcpServers(store.db).map((m) => m.name).sort()).toEqual(
      [...names].sort(),
    );
  });

  /**
   * Ruling 310. Both run prompts used to answer "why is my granted server not
   * here?" with one hardcoded sentence — "no such server is in the org
   * registry" — asserting a cause neither had checked. The resolver had already
   * produced the real one, and `UnresolvedMcpGrant.reason` documents itself as
   * "why it produced no usable tools, in words a human can act on".
   *
   * Live on SHOP-55 the invented cause was FALSE: a Platform Architect reported
   * a knowledge-base server as unregistered, and the operator verified it was
   * both registered and granted. The reader was sent after a registration bug
   * that did not exist.
   *
   * This binds the two ends: the resolver states a reason, and the renderer
   * prints THAT reason rather than a sentence of its own.
   */
  it("ruling 310: an unresolved grant carries a reason, and the prompt prints that reason", () => {
    const store = setupTestStore(ctx);
    const resolved = resolveSpecialistMcpServersDetailed(store.db, ["ghost-server"]);
    expect(resolved.servers).toEqual({});
    expect(resolved.unresolved).toHaveLength(1);
    const [grant] = resolved.unresolved;
    expect(grant!.name).toBe("ghost-server");
    expect(grant!.reason.length).toBeGreaterThan(0);

    const section = unavailableMcpSection(resolved.unresolved);
    // CANARY: put the hardcoded cause back in the renderer and this fails,
    // because the rendered text would no longer be the resolver's own words.
    expect(section).toContain(`- ghost-server: ${grant!.reason}`);
    expect(section).toContain("Unavailable MCP servers");
    // The section's reason to exist: the agent may not use the missing tools.
    expect(section).toContain("Do not claim or attempt tools from it; report the gap");
    // And it must not tell the agent to infer a cause the server never gave.
    expect(section).toContain("do not infer one");
    expect(section).toContain(
      "do not assume the grant or the registration is missing unless the reason says so",
    );
  });
});

/* ---------------------------- unresolvable grants are reportable (P14-LV-09) */

describe("resolveSpecialistMcpServersDetailed", () => {
  it("reports a grant that names no registry row, alongside the ones that resolved", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse");
    // The live shape of the KM-01 orphan: the server was renamed, the grant was
    // not, and the run advertised a server that exposed zero tools while only a
    // server log said so.
    const resolved = resolveSpecialistMcpServersDetailed(store.db, [
      "billing-api",
      "vm-memory",
    ]);
    expect(Object.keys(resolved.servers)).toEqual(["billing-api"]);
    expect(resolved.unresolved).toEqual([
      { name: "vm-memory", reason: "no MCP server by that name in the org registry" },
    ]);
  });

  it("reports a registered stdio server whose command is unusable", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "broken", "stdio", '""');
    const resolved = resolveSpecialistMcpServersDetailed(store.db, ["broken"]);
    expect(resolved.servers).toEqual({});
    expect(resolved.unresolved).toEqual([
      { name: "broken", reason: "the registered stdio command is empty" },
    ]);
  });

  it("C6: a registry read failure lands EVERY declared grant in unresolved, not silence", () => {
    // The org MCP registry read throwing used to drop every grant with no
    // unresolved entry and no log — the run advertised tool surfaces that never
    // mounted, invisibly. A REAL migrated database missing the registry table
    // IS that failure (`listMcpServers` throws "no such table"), so this drives
    // the path through the actual driver rather than a hand-cast stand-in.
    const store = setupTestStore(ctx);
    store.db.exec("DROP TABLE org_mcp_servers");
    const resolved = resolveSpecialistMcpServersDetailed(store.db, [
      "billing-api",
      "vm-memory",
      "viberr", // reserved: built in-process, never a grant → not reported
    ]);
    expect(resolved.servers).toEqual({});
    expect(resolved.unresolved).toEqual([
      {
        name: "billing-api",
        reason: "the org MCP registry could not be read; it exposes no tools",
      },
      {
        name: "vm-memory",
        reason: "the org MCP registry could not be read; it exposes no tools",
      },
    ]);
  });

  describe("ruling 461: a credentialed server is mounted through Viberr's gateway", () => {
    beforeAll(async () => {
      await startMcpGateway({ port: 0 });
    });
    afterAll(async () => {
      await stopMcpGateway();
    });

    it("an HTTP server resolves to the gateway URL, and no part of the config is the credential", () => {
      const store = setupTestStore(ctx);
      addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse", sealSecret("tok_live_123"));
      const resolved = resolveSpecialistMcpServersDetailed(store.db, ["billing-api"]);
      // CANARY: put the decrypted `Authorization: Bearer` back on the config
      // and both assertions go red.
      expect(resolved.servers["billing-api"]).toEqual({
        type: "http",
        url: mcpGatewayMountUrl("billing-api"),
      });
      expect(JSON.stringify(resolved)).not.toContain("tok_live_123");
      expect(resolved.proxied).toEqual(["billing-api"]);
      expect(resolved.unresolved).toEqual([]);
    });

    it("a stdio server resolves to the gateway URL too — the server spawns it, the CLI never does", () => {
      const store = setupTestStore(ctx);
      addMcp(store.db, "pg-ro", "stdio", "npx -y @mcp/server-postgres", sealSecret("pg_secret"));
      const resolved = resolveSpecialistMcpServersDetailed(store.db, ["pg-ro"]);
      expect(resolved.servers["pg-ro"]).toEqual({
        type: "http",
        url: mcpGatewayMountUrl("pg-ro"),
      });
      const json = JSON.stringify(resolved);
      expect(json).not.toContain("pg_secret");
      expect(json).not.toContain("MCP_CREDENTIAL");
      expect(resolved.proxied).toEqual(["pg-ro"]);
    });

    it("an uncredentialed server beside them still mounts directly", () => {
      const store = setupTestStore(ctx);
      addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse", sealSecret("tok_live_123"));
      addMcp(store.db, "docs", "HTTP", "https://docs.example/mcp");
      addMcp(store.db, "fs", "stdio", "npx -y @mcp/server-filesystem /tmp");
      const resolved = resolveSpecialistMcpServersDetailed(store.db, ["billing-api", "docs", "fs"]);
      expect(resolved.servers.docs).toEqual({ type: "http", url: "https://docs.example/mcp" });
      expect(resolved.servers.fs).toEqual({
        command: "npx",
        args: ["-y", "@mcp/server-filesystem", "/tmp"],
      });
      expect(resolved.proxied).toEqual(["billing-api"]);
    });

    it("a marked write tool keeps its per-tool deny on a gateway mount", () => {
      const store = setupTestStore(ctx);
      addMcp(store.db, "cloudflare", "HTTP", "https://mcp.example/cf", sealSecret("cf_token"));
      markWriteTools(store.db, "cloudflare", ["delete_zone"]);
      const resolved = resolveSpecialistMcpServersDetailed(store.db, ["cloudflare"], {
        withholdWriteTools: true,
      });
      expect(resolved.servers.cloudflare).toEqual({
        type: "http",
        url: mcpGatewayMountUrl("cloudflare"),
        tools: [{ name: "delete_zone", permission_policy: "always_deny" }],
      });
      expect(resolved.toolDenials).toEqual([{ server: "cloudflare", tools: ["delete_zone"] }]);
    });
  });

  /**
   * A9/pass-16 — this test used to assert the SILENT DOWNGRADE: a legacy
   * plaintext `cred_ref` yielded no token and the server was mounted anyway, so
   * a run connected ANONYMOUSLY to a server the operator had configured with
   * auth, the persona still advertised its tools, and the only trace was a log
   * warn. The credential is still never leaked as auth — but the server is no
   * longer mounted, and the run is told why.
   */
  it("F7-MCP1 + A9: a legacy plaintext cred_ref is never leaked AND never silently anonymous", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "legacy", "HTTP", "https://mcp.example/sse", "secret://mcp/legacy");
    const { servers, unresolved } = resolveSpecialistMcpServersDetailed(store.db, [
      "legacy",
    ]);
    expect(servers["legacy"]).toBeUndefined();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.name).toBe("legacy");
    expect(unresolved[0]!.reason).toContain("not in the current sealed format");
    // …and it is NOT flagged as merely unhealthy — it never mounted.
    expect(unresolved[0]!.mounted).toBeUndefined();
  });

  it("A9: a credential sealed under a RETIRED key is refused, not downgraded to anonymous", () => {
    const otherKey = randomBytes(32);
    const store = setupTestStore(ctx);
    addMcp(
      store.db,
      "billing-api",
      "HTTP",
      "https://mcp.example/sse",
      sealSecret("tok_live_123", otherKey), // sealed under a key nothing knows
    );
    const { servers, unresolved } = resolveSpecialistMcpServersDetailed(store.db, [
      "billing-api",
    ]);
    expect(servers["billing-api"]).toBeUndefined();
    expect(unresolved[0]!.reason).toContain("cannot be decrypted");
    expect(unresolved[0]!.reason).toContain(
      "VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS",
    );
  });

  it("F20-10: a stdio mount that dies at run-spawn is dropped, disclosed, and the row is flagged", async () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "everything", "stdio", "npx -y @mcp/server-everything");
    addMcp(store.db, "billing-api", "HTTP", "https://mcp.example/sse");
    // The registry row reads healthy from a stale Add/Retest (the F20-10 setup:
    // health was learned from Add/Retest, never a run).
    store.db
      .prepare(`UPDATE org_mcp_servers SET up = 1, tools_count = 16 WHERE name = 'everything'`)
      .run();

    const resolved = resolveSpecialistMcpServersDetailed(store.db, [
      "everything",
      "billing-api",
    ]);
    expect(Object.keys(resolved.servers).sort()).toEqual(["billing-api", "everything"]);

    const verified = await verifyStdioMcpMountsForRun(store.db, resolved, {
      spawnImpl: crashSpawn("Error: Cannot find module 'ajv'\n"),
      timeoutMs: 200,
    });

    // The dead stdio mount is gone; the HTTP mount (never spawned here) stays.
    expect(Object.keys(verified.servers)).toEqual(["billing-api"]);
    const entry = verified.unresolved.find((u) => u.name === "everything")!;
    expect(entry.mounted).toBe(false); // a hard mount failure, not a stale probe
    expect(entry.reason).toContain("failed to start for this run");
    expect(entry.reason).toContain("Cannot find module 'ajv'");

    // …and the registry row no longer claims to be up (resources.server write-back).
    const row = listMcpServers(store.db).find((m) => m.name === "everything")!;
    expect(row.up).toBe(false);
    expect(row.tools).toBeNull();
    expect(row.lastError).toContain("Cannot find module 'ajv'");
  });

  it("ruling 606: a mount the probe caught mid-install is dropped for this run and installs in the background", async () => {
    // Live 2026-09-30: the run's probe gave up on `uvx …@latest` after 20 s
    // while it was still downloading, killed it, and every later run did the
    // same, so no run got the server until a person pressed Retest.
    const store = setupTestStore(ctx);
    addMcp(store.db, "aws-pricing", "stdio", "uvx awslabs.aws-pricing-mcp-server@latest");
    const resolved = resolveSpecialistMcpServersDetailed(store.db, ["aws-pricing"]);
    const downloading: McpSpawn = () => {
      const err = new EventEmitter();
      queueMicrotask(() => err.emit("data", Buffer.from("Downloading cryptography (4.5MiB)\n")));
      return {
        stdin: { write() {}, end() {} },
        stdout: { on() {} },
        stderr: { on: (e, cb) => err.on(e, cb) },
        on() {},
        kill() {},
      };
    };
    // The run's probe meets the download; the background install's own
    // handshake then answers, as the finished install does.
    let spawns = 0;
    const installed = handshakeSpawn(9);
    const spawnImpl: McpSpawn = (...args) => (spawns++ === 0 ? downloading(...args) : installed(...args));

    const verified = await verifyStdioMcpMountsForRun(store.db, resolved, { spawnImpl, timeoutMs: 50, capMs: 2000 });

    expect(Object.keys(verified.servers)).toEqual([]);
    expect(verified.unresolved.find((u) => u.name === "aws-pricing")!.reason).toContain(
      "installing in the background for a later run",
    );
    // CANARY: drop the warm-up and the row stays down until a person retests.
    await vi.waitFor(() => {
      const row = listMcpServers(store.db).find((m) => m.name === "aws-pricing")!;
      expect([row.up, row.tools, row.warmingSince]).toEqual([true, 9, null]);
    });
  });

  it("F20-10: a healthy stdio mount and a clean disclosure are left untouched", async () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "pg-ro", "stdio", "npx -y @mcp/server-postgres");
    const resolved = resolveSpecialistMcpServersDetailed(store.db, ["pg-ro"]);
    const verified = await verifyStdioMcpMountsForRun(store.db, resolved, {
      spawnImpl: handshakeSpawn(3),
      timeoutMs: 200,
    });
    expect(Object.keys(verified.servers)).toEqual(["pg-ro"]);
    expect(verified.unresolved).toEqual([]);
    // The row's health is left exactly as it was — a working mount proves nothing new.
    expect(listMcpServers(store.db).find((m) => m.name === "pg-ro")!.up).toBeNull();
  });

  it("A9: rotation WORKS — a retired key in the env opens the box and re-seals it", async () => {
    const oldKey = randomBytes(32);
    const store = setupTestStore(ctx);
    addMcp(
      store.db,
      "billing-api",
      "HTTP",
      "https://mcp.example/sse",
      sealSecret("tok_live_123", oldKey),
    );
    const saved = process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS;
    process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS = oldKey.toString("base64");
    try {
      // The resolver opens the box (and so does not refuse the mount) …
      await startMcpGateway({ port: 0 });
      const resolved = resolveSpecialistMcpServersDetailed(store.db, ["billing-api"]);
      expect(resolved.unresolved).toEqual([]);
      expect(resolved.proxied).toEqual(["billing-api"]);
      // … and lazy rotation re-sealed the row under the CURRENT key, so it
      // keeps opening after the retired key is removed from the env.
      process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS = "";
      expect(getMcpCredentialState(store.db, "billing-api")).toEqual({
        state: "ok",
        token: "tok_live_123",
      });
    } finally {
      await stopMcpGateway();
      if (saved === undefined) delete process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS;
      else process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS = saved;
    }
  });
});

/**
 * Ruling 176 (amends 39): a withheld repo-write grant denies the tools an admin
 * MARKED, per server, on both transports: the SDK's per-tool policy rides the
 * HTTP config, and every marked name comes back as a denial for `startRun` to
 * turn into a `disallowedTools` name (Claude) or `disabled_tools` (Codex).
 */
describe("resolveSpecialistMcpServersDetailed — marked write tools (ruling 176)", () => {
  it("a withheld run gets the HTTP per-tool policy and a denial for each transport", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "gh-http", "HTTP", "https://mcp.example/gh");
    addMcp(store.db, "gh-stdio", "stdio", "npx -y gh-mcp");
    addMcp(store.db, "docs", "stdio", "npx -y docs-mcp");
    markWriteTools(store.db, "gh-http", ["merge_pull_request"]);
    markWriteTools(store.db, "gh-stdio", ["create_pull_request", "push_files"]);

    const withheld = resolveSpecialistMcpServersDetailed(
      store.db,
      ["gh-http", "gh-stdio", "docs"],
      { withholdWriteTools: true },
    );
    expect(withheld.servers["gh-http"]).toEqual({
      type: "http",
      url: "https://mcp.example/gh",
      tools: [{ name: "merge_pull_request", permission_policy: "always_deny" }],
    });
    // stdio has no per-tool policy on the SDK; its config is untouched.
    expect(withheld.servers["gh-stdio"]).toEqual({ command: "npx", args: ["-y", "gh-mcp"] });
    expect(withheld.toolDenials).toEqual([
      { server: "gh-http", tools: ["merge_pull_request"] },
      { server: "gh-stdio", tools: ["create_pull_request", "push_files"] },
    ]);
  });

  it("a run holding the grant, and a server with no marks, are mounted exactly as before", () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "gh-http", "HTTP", "https://mcp.example/gh");
    markWriteTools(store.db, "gh-http", ["merge_pull_request"]);
    addMcp(store.db, "docs", "HTTP", "https://mcp.example/docs");

    const granted = resolveSpecialistMcpServersDetailed(store.db, ["gh-http", "docs"]);
    expect(granted.servers["gh-http"]).toEqual({ type: "http", url: "https://mcp.example/gh" });
    expect(granted.toolDenials).toEqual([]);

    const withheld = resolveSpecialistMcpServersDetailed(store.db, ["docs"], {
      withholdWriteTools: true,
    });
    expect(withheld.servers.docs).toEqual({ type: "http", url: "https://mcp.example/docs" });
    expect(withheld.toolDenials).toEqual([]);
  });

  it("a stdio server dropped at run-mount takes its denials with it", async () => {
    const store = setupTestStore(ctx);
    addMcp(store.db, "gh-stdio", "stdio", "npx -y gh-mcp");
    markWriteTools(store.db, "gh-stdio", ["create_pull_request"]);
    const verified = await verifyStdioMcpMountsForRun(
      store.db,
      resolveSpecialistMcpServersDetailed(store.db, ["gh-stdio"], { withholdWriteTools: true }),
      { spawnImpl: crashSpawn("Error: Cannot find module 'ajv'\n"), timeoutMs: 200 },
    );
    expect(verified.servers).toEqual({});
    expect(verified.toolDenials).toEqual([]);

    const healthy = await verifyStdioMcpMountsForRun(
      store.db,
      resolveSpecialistMcpServersDetailed(store.db, ["gh-stdio"], { withholdWriteTools: true }),
      { spawnImpl: handshakeSpawn(2), timeoutMs: 200 },
    );
    expect(healthy.toolDenials).toEqual([{ server: "gh-stdio", tools: ["create_pull_request"] }]);
  });
});

/**
 * Ruling 700(b): the run-start stdio pre-flight runs two handshakes at a time
 * instead of one after another, starts them in mount order and applies their
 * verdicts in mount order, so the mounted set, the registry rows, the warn
 * lines and `unresolved` are what the serial check left for the same verdicts.
 * Two differences remain, stated in the function's comment and not pinned
 * here: a later mount's failure, taken while an earlier mount was still
 * probing, can overwrite a Retest pressed meanwhile, and a failed credential
 * re-seal is logged before the verdicts rather than among them.
 */
describe("verifyStdioMcpMountsForRun: the bounded pre-flight (ruling 700(b))", () => {
  /** A probe clock no test here reaches: each handshake ends when the test ends it. */
  const timeoutMs = 10_000;
  /**
   * One stdio server per name, each its own command unless `sameCommand` gives
   * it another mount's, probed by {@link heldSpawn}'s children: `verify()`
   * starts the run's pre-flight, `child(name)` is the first child spawned with
   * `name`'s command, and `down()` names the registry rows a verdict has marked
   * down.
   */
  function mountStdio(names: string[], sameCommand: Partial<Record<string, string>> = {}) {
    const store = setupTestStore(ctx);
    const commandOf = (name: string) => `npx -y ${sameCommand[name] ?? name}-mcp`;
    for (const name of names) addMcp(store.db, name, "stdio", commandOf(name));
    const fake = heldSpawn();
    return {
      store,
      fake,
      verify: () =>
        verifyStdioMcpMountsForRun(store.db, resolveSpecialistMcpServersDetailed(store.db, names), {
          spawnImpl: fake.spawnImpl,
          timeoutMs,
        }),
      child: (name: string) => fake.held.find((h) => h.command === commandOf(name))!,
      down: () =>
        listMcpServers(store.db)
          .filter((m) => m.up === false)
          .map((m) => m.name)
          .sort(),
    };
  }
  /** Watch the run-mount warn line: the result names the mounts it has dropped, in the order logged. */
  function watchDrops() {
    const warn = vi.spyOn(logger, "warn");
    onTestFinished(() => warn.mockRestore());
    return () =>
      warn.mock.calls
        .filter(([message]) => message === "org MCP server failed to start at run-mount; dropped and flagged")
        .map(([, fields]) => fields?.mcp);
  }

  it("keeps two handshakes in flight, never more, started in mount order", async () => {
    const names = ["a", "b", "c", "d"];
    const { fake, verify } = mountStdio(names);
    const verifying = verify();

    // CANARY: probe the mounts one after another again and only one handshake
    // is ever held, so this wait times out; raise the bound to 3, or drop it,
    // and three or four are held at once.
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.answer();
    await vi.waitFor(() => expect(fake.held).toHaveLength(3));
    fake.held[0]!.answer();
    await vi.waitFor(() => expect(fake.held).toHaveLength(4));
    fake.held[2]!.answer();
    fake.held[3]!.answer();

    const verified = await verifying;
    expect(fake.aliveAtSpawn).toEqual([1, 2, 2, 2]);
    // CANARY: take the mounts last-first and d and c are spawned before a and b.
    expect(fake.held.map((h) => h.command)).toEqual(names.map((n) => `npx -y ${n}-mcp`));
    expect(Object.keys(verified.servers)).toEqual(names);
  });

  it("applies verdicts in mount order, each as soon as every earlier mount's is in", async () => {
    const { fake, verify, child, down } = mountStdio(["a", "b", "c"]);
    const dropped = watchDrops();
    const verifying = verify();
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));

    // b, mounted second, fails first and waits for a. CANARY: apply each
    // verdict as its probe settles and b's warn and row land here, ahead of a's.
    child("b").crash("Error: Cannot find module 'ajv'\n");
    await vi.waitFor(() => expect(fake.held).toHaveLength(3)); // b's slot went to c
    expect([dropped(), down()]).toEqual([[], []]);

    // a fails: a's verdict and then b's land, while c is still held. CANARY:
    // hold every verdict until the whole batch settles and this wait times out.
    child("a").crash("Error: Cannot find module 'zod'\n");
    await vi.waitFor(() => expect(dropped()).toEqual(["a", "b"]));
    expect(down()).toEqual(["a", "b"]);

    child("c").answer();
    const verified = await verifying;
    expect(Object.keys(verified.servers)).toEqual(["c"]);
    expect(verified.unresolved.map((u) => u.name)).toEqual(["a", "b"]);
  });

  it.each([
    { when: "b's probe is in flight", sameCommand: {}, spawned: ["a", "b"] },
    { when: "b waits for a's probe of their one command", sameCommand: { b: "a" }, spawned: ["a"] },
  ])(
    "stops at a verdict it cannot write, as the one-at-a-time check did, while $when",
    async ({ sameCommand, spawned }) => {
      const { store, fake, verify, child, down } = mountStdio(["a", "b", "c"], sameCommand);
      const dropped = watchDrops();
      // a's health-row write fails, as it does while another process holds the
      // write lock past the busy timeout.
      store.db.exec(
        `CREATE TRIGGER a_row_locked BEFORE UPDATE ON org_mcp_servers WHEN NEW.name = 'a'
         BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
      );
      const verifying = verify();
      await vi.waitFor(() => expect(fake.held).toHaveLength(spawned.length));
      child("a").crash("Error: Cannot find module 'zod'\n");
      await expect(verifying).rejects.toThrow("database is locked");

      // The lock clears, and every handshake still running when a's write failed ends.
      // CANARY: let the other worker go on after the throw and, for a run that
      // never started, it writes a's row again and b's, logs both and spawns c;
      // let b's probe start once a's command is free and b is spawned anyway.
      store.db.exec("DROP TRIGGER a_row_locked");
      const running = fake.held.filter((h) => !h.killed);
      for (const h of running) h.crash("Error: Cannot find module 'ajv'\n");
      await vi.waitFor(() => expect(running.every((h) => h.killed)).toBe(true));
      expect([fake.held.map((h) => h.command), dropped(), down()]).toEqual([
        spawned.map((name) => `npx -y ${name}-mcp`),
        [],
        [],
      ]);
    },
  );

  it("never handshakes two mounts of one command at once", async () => {
    // One server registered twice (two credentials, say). On a cold cache both
    // probes would run the same first-run install into one npx folder.
    const { fake, verify } = mountStdio(["gh-work", "gh-personal"], {
      "gh-work": "gh",
      "gh-personal": "gh",
    });
    const verifying = verify();

    // CANARY: drop the wait on the command's previous probe and both are held at once.
    await vi.waitFor(() => expect(fake.held).toHaveLength(1));
    fake.held[0]!.answer();
    await vi.waitFor(() => expect(fake.held).toHaveLength(2));
    fake.held[1]!.answer();

    const verified = await verifying;
    expect(fake.aliveAtSpawn).toEqual([1, 1]);
    expect(Object.keys(verified.servers)).toEqual(["gh-work", "gh-personal"]);
  });
});
