import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  listMcpServers,
  saveMcpServer,
  type McpSpawn,
} from "./resources.server";
import { reapStaleWarmups, resetWarmupsForTest } from "./mcp-warmup.server";

/**
 * R19-18 — a command that installs on first use finishes in the BACKGROUND and
 * the row settles itself. Before this, the probe killed the install, uv cached
 * nothing, and retesting restarted the same download forever.
 */

const dbCtx = createTestDbContext();
const ACTOR = { userId: "u_admin", label: "admin@viberr.dev" };
afterEach(() => resetWarmupsForTest());

/** Chatters like a package manager, then answers the handshake after `afterMs`. */
function installerSpawn(afterMs: number, tools = 2): McpSpawn {
  return () => {
    const out = new EventEmitter();
    const err = new EventEmitter();
    let ready = false;
    queueMicrotask(() => err.emit("data", Buffer.from("Downloading nvidia-curand (59.1MiB)\n")));
    setTimeout(() => {
      ready = true;
    }, afterMs);
    return {
      stdin: {
        write(data: string) {
          for (const line of data.split("\n")) {
            const t = line.trim();
            if (!t) continue;
            const msg = JSON.parse(t) as { method?: string };
            // Nothing answers until the "install" finishes — exactly why the
            // short probe could never see this server work.
            const reply = (obj: unknown) =>
              setTimeout(
                () => out.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`)),
                ready ? 0 : afterMs,
              );
            if (msg.method === "initialize") {
              reply({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
            } else if (msg.method === "tools/list") {
              reply({
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
      stderr: { on: (e, cb) => err.on(e, cb) },
      on() {},
      kill() {},
    };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 120));

describe("startMcpWarmup (R19-18)", () => {
  it("flags the row installing, then turns it green on its own", async () => {
    const db = dbCtx.makeDb();
    const saved = await saveMcpServer(
      db,
      { name: "slow-stdio", transport: "stdio", target: "uvx big", cred: "" },
      ACTOR,
      // The probe gives up almost immediately; the warm-up gets a real budget.
      { spawnImpl: installerSpawn(40), timeoutMs: 5, capMs: 5000 },
    );
    // Registration does NOT block on the install, and does not call it broken.
    expect(saved.mcp.warmingSince).not.toBeNull();
    expect(saved.toast).toContain("installing in the background");

    await settle();
    const row = listMcpServers(db).find((m) => m.name === "slow-stdio")!;
    expect(row).toMatchObject({ up: true, tools: 2, warmingSince: null, lastError: null });
  });

  it("records a real failure when the install never produces a server", async () => {
    const db = dbCtx.makeDb();
    // Chatters, then still never answers within the warm-up's own budget.
    await saveMcpServer(
      db,
      { name: "doomed-stdio", transport: "stdio", target: "uvx doomed", cred: "" },
      ACTOR,
      { spawnImpl: installerSpawn(10_000), timeoutMs: 5, capMs: 40 },
    );
    await settle();
    const row = listMcpServers(db).find((m) => m.name === "doomed-stdio")!;
    expect(row.warmingSince).toBeNull();
    expect(row.up).toBe(false);
    expect(row.lastError).toBeTruthy();
  });

  it("a restart never leaves a row claiming to install with nothing running", async () => {
    const db = dbCtx.makeDb();
    await saveMcpServer(
      db,
      { name: "orphan-stdio", transport: "stdio", target: "uvx orphan", cred: "" },
      ACTOR,
      { spawnImpl: installerSpawn(10_000), timeoutMs: 5, capMs: 5 },
    );
    // Simulate the process that owned the warm-up going away.
    db.prepare(`UPDATE org_mcp_servers SET warming_since = ? WHERE name = 'orphan-stdio'`)
      .run(new Date().toISOString());
    resetWarmupsForTest();

    expect(reapStaleWarmups(db)).toBe(1);
    const row = listMcpServers(db).find((m) => m.name === "orphan-stdio")!;
    expect(row.warmingSince).toBeNull();
    expect(row.lastError).toBeTruthy();
  });
});
