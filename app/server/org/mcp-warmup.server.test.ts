import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
afterEach(() => {
  resetWarmupsForTest();
  dbCtx.cleanup();
});

/** The JSON-RPC request lines the probe writes; this fake routes on `method`
 *  alone and ignores anything else the handshake carries. */
const probeRequest = z.object({ method: z.string() }).loose();

/** What this fake ever answers with: the `initialize` capability advertisement
 *  (the probe only needs a `result` to come back at all) and the tool listing. */
interface McpProbeReply {
  jsonrpc: string;
  id: number;
  result: { capabilities: { tools?: { listChanged?: boolean } } } | { tools: { name: string }[] };
}

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
            const msg = probeRequest.safeParse(JSON.parse(t));
            if (!msg.success) continue;
            // Nothing answers until the "install" finishes — exactly why the
            // short probe could never see this server work.
            const reply = (obj: McpProbeReply) =>
              setTimeout(
                () => out.emit("data", Buffer.from(`${JSON.stringify(obj)}\n`)),
                ready ? 0 : afterMs,
              );
            if (msg.data.method === "initialize") {
              reply({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
            } else if (msg.data.method === "tools/list") {
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

/** Silent: prints nothing and never answers — a cold npx that just times out. */
const silentSpawn: McpSpawn = () => ({
  stdin: { write() {}, end() {} },
  stdout: { on() {} },
  stderr: { on() {} },
  on() {},
  kill() {},
});

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

  /**
   * A warm-up runs for up to 15 minutes, and an admin can re-point the row at
   * a different command while it does. A verdict keyed on the row id alone
   * then lands the OLD command's health — `up`, its tool count, even
   * `first_success_at` — on the NEW one, so the panel shows a green server
   * nobody has ever successfully started.
   */
  it("a warm-up whose row was re-pointed does not stamp the old command's verdict", async () => {
    const db = dbCtx.makeDb();
    const saved = await saveMcpServer(
      db,
      { name: "moving-stdio", transport: "stdio", target: "uvx original", cred: "" },
      ACTOR,
      { spawnImpl: installerSpawn(60), timeoutMs: 5, capMs: 5000 },
    );
    expect(saved.mcp.warmingSince).not.toBeNull();

    // The admin re-points the row while that install is still running. Write
    // the target directly: this is about the warm-up's verdict, not about
    // whatever probe a save runs.
    db.prepare(`UPDATE org_mcp_servers SET target = ?, up = NULL, tools_count = NULL WHERE id = ?`).run(
      "uvx replacement",
      saved.mcp.id,
    );

    await settle();
    const row = listMcpServers(db).find((m) => m.name === "moving-stdio")!;
    expect(row.target).toBe("uvx replacement");
    // The old command's success did not become the new command's.
    expect(row.up).not.toBe(true);
    expect(row.tools).toBeNull();
    // …and the row is not left claiming to install forever.
    expect(row.warmingSince).toBeNull();
  });

  /**
   * bug-sweep #8: re-pointing a row THROUGH a save while its warm-up is in
   * flight. The save's own `startMcpWarmup` used to no-op on the in-flight
   * guard, the old warm-up's target-scoped verdict then matched nothing, and its
   * `finally` cleared the flag — so the NEW command never installed and only a
   * manual retest recovered it. The new command must warm on its own.
   */
  it("re-pointing a server mid-warm-up warms the NEW command (bug-sweep #8)", async () => {
    const db = dbCtx.makeDb();
    // Command A: a slow installer that answers with 2 tools.
    const first = await saveMcpServer(
      db,
      { name: "moving2", transport: "stdio", target: "uvx original", cred: "" },
      ACTOR,
      { spawnImpl: installerSpawn(60, 2), timeoutMs: 5, capMs: 5000 },
    );
    expect(first.mcp.warmingSince).not.toBeNull();

    // Re-point the SAME row to command B (5 tools) while A's warm-up is running.
    // B's own probe gives up ("installing"); only a warm-up can finish it, and
    // the id already has A's warm-up in flight.
    await saveMcpServer(
      db,
      {
        id: first.mcp.id,
        name: "moving2",
        target: "uvx replacement",
        transport: "stdio",
        cred: "",
      },
      ACTOR,
      { spawnImpl: installerSpawn(40, 5), timeoutMs: 5, capMs: 5000 },
    );

    // A finishes (~60ms), which re-arms B; B finishes (~40ms).
    await settle();
    await settle();
    const row = listMcpServers(db).find((m) => m.name === "moving2")!;
    expect(row.target).toBe("uvx replacement");
    // The NEW command's own verdict landed — green, with ITS tool count.
    expect(row).toMatchObject({ up: true, tools: 5, warmingSince: null });
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
    // The orphaned warm-up still writes its verdict; let it land before the
    // database closes.
    await settle();
  });
});

describe("first-run npx warm-up (R20-4 / N20-2)", () => {
  it("only the HEURISTIC arm bumps heuristic_warmups; the evidence arm does not", async () => {
    const db = dbCtx.makeDb();
    // Heuristic: a SILENT npx command — nothing install-y on stderr, but it is a
    // package runner and the row has never succeeded here.
    const heur = await saveMcpServer(
      db,
      { name: "cold-npx", transport: "stdio", target: "npx -y @mcp/x", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 5, capMs: 40 },
    );
    expect(heur.mcp.warmingSince).not.toBeNull();
    expect(heur.mcp.heuristicWarmups).toBe(1);

    // Evidence: it PRINTS an install line, so it warms WITHOUT spending the cap.
    const evid = await saveMcpServer(
      db,
      { name: "loud-uvx", transport: "stdio", target: "uvx big", cred: "" },
      ACTOR,
      { spawnImpl: installerSpawn(10_000), timeoutMs: 5, capMs: 40 },
    );
    expect(evid.mcp.warmingSince).not.toBeNull();
    expect(evid.mcp.heuristicWarmups).toBe(0);
    await settle();
  });

  it("a warm-up that finally answers stamps first_success_at", async () => {
    const db = dbCtx.makeDb();
    const saved = await saveMcpServer(
      db,
      { name: "cold-npx", transport: "stdio", target: "uvx big", cred: "" },
      ACTOR,
      // Chatters (evidence), gives up in the probe, answers inside the warm-up.
      { spawnImpl: installerSpawn(40), timeoutMs: 5, capMs: 5000 },
    );
    expect(saved.mcp.firstSuccessAt ?? null).toBeNull();

    await settle();
    const row = listMcpServers(db).find((m) => m.name === "cold-npx")!;
    expect(row).toMatchObject({ up: true, warmingSince: null });
    expect(row.firstSuccessAt).toBeTruthy();
  });

  it("reapStaleWarmups rolls the heuristic counter back — a killed warm-up is not spent", async () => {
    const db = dbCtx.makeDb();
    await saveMcpServer(
      db,
      { name: "orphan-npx", transport: "stdio", target: "npx -y @mcp/x", cred: "" },
      ACTOR,
      { spawnImpl: silentSpawn, timeoutMs: 5, capMs: 5 },
    );
    // The counter was bumped at ARM time.
    expect(
      listMcpServers(db).find((m) => m.name === "orphan-npx")!.heuristicWarmups,
    ).toBe(1);
    await settle();

    // Simulate the process that owned the warm-up going away mid-install.
    db.prepare(`UPDATE org_mcp_servers SET warming_since = ? WHERE name = 'orphan-npx'`)
      .run(new Date().toISOString());
    resetWarmupsForTest();

    expect(reapStaleWarmups(db)).toBe(1);
    const row = listMcpServers(db).find((m) => m.name === "orphan-npx")!;
    expect(row.warmingSince).toBeNull();
    expect(row.heuristicWarmups).toBe(0); // rolled back so a retest may try once more
  });
});
