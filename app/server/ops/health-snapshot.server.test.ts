import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { HERMETIC_TOOLCHAIN } from "../../../test-support/toolchain";
import { recordBackendQuotaExhaustion } from "~/server/runtimes/backend-quota.server";
import { healthSnapshot } from "./health-snapshot.server";

/**
 * Ruling 130(d): the unauthenticated `/resources/health` body never names a
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

describe("healthSnapshot reports the toolchain (ruling 182)", () => {
  it("appends the toolchain reading LAST — key order is the wire contract — with the sandbox verdict", () => {
    // G36-4: nothing probed whether a sandboxed Codex run could exec at all,
    // so bubblewrap's refusal surfaced as a reviewer's "missing evidence"
    // verdict. The reading rides the health body and, through the spread,
    // `instance_health`. Canary: drop `toolchain` from the snapshot.
    const store = setupTestStore(ctx);
    const snapshot = healthSnapshot(store.db);
    expect(Object.keys(snapshot).at(-1)).toBe("toolchain");
    // The one memoized reading (`cachedToolchain`), never a second probe: the
    // suite primes it hermetic in setup-env, and that is what comes back.
    expect(snapshot.toolchain).toEqual(HERMETIC_TOOLCHAIN);
    expect(snapshot.toolchain.codexSandbox).toEqual({
      ok: true,
      detail: expect.any(String),
      // Ruling 184: the second question's answer rides the same field.
      childProcesses: { ok: true, detail: expect.any(String) },
    });
  });
});
