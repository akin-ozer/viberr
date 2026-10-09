import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { HERMETIC_TOOLCHAIN } from "../../../test-support/toolchain";
import { recordBackendQuotaExhaustion } from "~/server/runtimes/backend-quota.server";
import {
  bindRunToMcpGateway,
  startMcpGateway,
  stopMcpGateway,
} from "~/server/mcp-proxy/gateway.server";
import { healthSnapshot } from "./health-snapshot.server";

/**
 * Ruling 160(a): the unauthenticated `/resources/health` body never names a
 * person; the signed-in `instance_health` read does. Canary: return the rows
 * unstripped by default.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("healthSnapshot and the quota principal", () => {
  it("strips the principal by default and keeps it for a signed-in read", () => {
    const store = setupTestStore(ctx);
    recordBackendQuotaExhaustion(store.db, "claude", {
      resetsAt: null,
      resetsAtPrecision: null,
      providerText: "session limit",
      runId: "run_x",
      observedAt: new Date().toISOString(),
      credentialUserId: store.users.arda.id,
      credentialLabel: "Arda",
    });
    const anonymous = healthSnapshot(store.db).quota.find((q) => q.backend === "claude")!;
    expect(anonymous.exhausted?.providerText).toBe("session limit");
    expect(anonymous.exhausted?.credentialUserId).toBeNull();
    expect(anonymous.exhausted?.credentialLabel).toBeNull();
    expect(JSON.stringify(healthSnapshot(store.db))).not.toContain(store.users.arda.id);
    const signedIn = healthSnapshot(store.db, { principal: true }).quota.find((q) => q.backend === "claude")!;
    expect(signedIn.exhausted?.credentialUserId).toBe(store.users.arda.id);
    expect(signedIn.exhausted?.credentialLabel).toBe("Arda");
  });
});

describe("healthSnapshot reports the MCP gateway (ruling 191)", () => {
  afterEach(async () => {
    await stopMcpGateway();
  });

  it("carries the gateway's live reading as mcpProxy", async () => {
    const store = setupTestStore(ctx);
    // Canary: drop `mcpProxy` from the snapshot. Its slot in the key order is
    // pinned below, with the toolchain's.
    const down = healthSnapshot(store.db);
    expect(down.mcpProxy).toEqual({ listening: false, port: null, liveTokens: 0 });
    // Not listening is reported, never degraded: the instance serves anyway.
    expect(down.degraded).not.toContain("mcpProxy");

    const { port } = await startMcpGateway({ port: 0 });
    bindRunToMcpGateway({
      db: store.db,
      runId: "run_health",
      servers: { cf: { type: "http", url: `http://127.0.0.1:${port}/mcp/cf` } },
      toolDenials: [],
      actor: { userId: null, label: "operator" },
      projectSlug: store.slug,
      taskKey: "VIB-1",
      isLive: () => true,
    });
    expect(healthSnapshot(store.db).mcpProxy).toEqual({ listening: true, port, liveTokens: 1 });
  });
});

describe("healthSnapshot reports the toolchain (ruling 40)", () => {
  it("carries the toolchain reading, then mcpProxy, then agentIsolation — key order is the wire contract", () => {
    // G36-4: nothing probed whether a sandboxed Codex run could exec at all,
    // so bubblewrap's refusal surfaced as a reviewer's "missing evidence"
    // verdict. The reading rides the health body and, through the spread,
    // `instance_health`. Canary: drop `toolchain` from the snapshot.
    // `agentIsolation` comes after it, appended last as the contract says a
    // new field must be.
    const store = setupTestStore(ctx);
    const snapshot = healthSnapshot(store.db);
    // Ruling 191 appended `mcpProxy` after it, and ruling 40 `agentIsolation` after that.
    expect(Object.keys(snapshot).slice(-3)).toEqual(["toolchain", "mcpProxy", "agentIsolation"]);
    // The one memoized reading (`cachedToolchain`), never a second probe: the
    // suite primes it hermetic in setup-env, and that is what comes back.
    expect(snapshot.toolchain).toEqual(HERMETIC_TOOLCHAIN);
  });
});
