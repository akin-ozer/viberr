import type { DatabaseSync as TestStoreDb } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "./rebuilder.server";
import { getSetting, setSetting } from "~/server/settings/instance-settings.server";
import {
  ensureProjectionDerivation,
  PROJECTION_DERIVATION_VERSION,
} from "./derivation-version.server";

/**
 * D32-14 follow-through (pass 32): a derivation change must reach EXISTING
 * rows on every instance without a migration. The stamp forces one full
 * rebuild when it is behind, then records the version; a current stamp leaves
 * the hash short-circuit alone.
 */
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const KEY = "projection.derivationVersion";
const countRow = z.object({ n: z.number() });
const refCount = (db: TestStoreDb, ref: string): number =>
  countRow.parse(
    db.prepare(`SELECT count(*) AS n FROM task_events WHERE actor_ref = ?`).get(ref),
  ).n;

describe("ensureProjectionDerivation", () => {
  it("forces a full rebuild when the stamp is behind, then records the version", () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { title: "Derivation probe" }),
      timeline: [
        {
          occurredAt: "2026-09-01T10:00:00.000Z",
          type: "comment",
          actor: { kind: "agent", backend: "codex", profileId: "developer", roleHint: null },
          title: null,
          text: "hello from the codex leg",
          toAgent: false,
          evidence: null,
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    // Simulate rows projected under the OLD derivation (backend/profile refs)
    // by an instance that never stamped a version.
    store.db
      .prepare(`UPDATE task_events SET actor_ref = 'codex/developer' WHERE actor_ref = 'agent/developer'`)
      .run();
    expect(refCount(store.db, "codex/developer")).toBe(1);

    const check = ensureProjectionDerivation(store.db, { dataRoot: store.dataRoot });
    expect(check.previous).toBe(1);
    expect(check.rebuilt).not.toBeNull();
    // Canary: drop `force: true` in ensureProjectionDerivation — the hash
    // short-circuit keeps the stale ref and this reads 1.
    expect(refCount(store.db, "codex/developer")).toBe(0);
    expect(refCount(store.db, "agent/developer")).toBe(1);
    expect(getSetting(store.db, KEY, z.number())).toBe(PROJECTION_DERIVATION_VERSION);
  });

  it("is a no-op when the stamp is current", () => {
    const store = setupTestStore(ctx);
    setSetting(store.db, KEY, PROJECTION_DERIVATION_VERSION);
    const check = ensureProjectionDerivation(store.db, { dataRoot: store.dataRoot });
    expect(check).toEqual({ previous: PROJECTION_DERIVATION_VERSION, rebuilt: null });
  });
});
