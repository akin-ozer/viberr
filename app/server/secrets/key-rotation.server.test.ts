import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { insertUser } from "~/server/auth/user-store.server";
import {
  SEALED_STORES,
  resealSecrets,
  secretKeyRotationStatus,
} from "./key-rotation.server";
import { openSecret, sealSecret } from "./secret-box.server";

/**
 * Gap 21 — rotation could never be FINISHED. The read side re-seals lazily, so
 * a secret nobody reads stays on the retired key forever, and nothing counted
 * them: the operator was told to "drop the old key once every secret has been
 * re-saved" with no way to know when that was true.
 */

const ctx = createTestDbContext();

/** The retired key: the one the "old" ciphertext was sealed under. */
const OLD_KEY = Buffer.alloc(32, 3);
/** A key that is NEITHER current nor listed as previous — an unreadable box. */
const LOST_KEY = Buffer.alloc(32, 9);

let previousBefore: string | undefined;

beforeEach(() => {
  previousBefore = process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS;
  process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS = OLD_KEY.toString("base64");
});

afterEach(() => {
  if (previousBefore === undefined) {
    delete process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS;
  } else {
    process.env.VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS = previousBefore;
  }
  ctx.cleanup();
});

function addPat(db: DatabaseSync, id: string, label: string, box: string): void {
  const user = insertUser(db, {
    id: `u_${id}`,
    email: `${id}@viberr.dev`,
    name: id,
    role: "member",
  });
  db.prepare(
    `INSERT INTO github_pats
       (id, user_id, label, encrypted_token, token_suffix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, user.id, label, box, "beef", new Date().toISOString());
}

function addMcp(db: DatabaseSync, id: string, name: string, box: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO org_mcp_servers
       (id, name, transport, target, cred_ref, created_at, updated_at)
     VALUES (?, ?, 'HTTP', 'https://example.test/mcp', ?, ?, ?)`,
  ).run(id, name, box, now, now);
}

function boxOf(db: DatabaseSync, table: string, column: string, id: string): string {
  return (
    db.prepare(`SELECT ${column} AS box FROM ${table} WHERE id = ?`).get(id) as {
      box: string;
    }
  ).box;
}

describe("secretKeyRotationStatus", () => {
  it("counts what still opens only under a retired key, across BOTH sealed stores", () => {
    const db = ctx.makeDb();
    addPat(db, "pat_fresh", "Fresh PAT", sealSecret("ghp_new"));
    addPat(db, "pat_dormant", "Dormant PAT", sealSecret("ghp_old", OLD_KEY));
    addMcp(db, "mcp_stale", "linear", sealSecret("mcp-token", OLD_KEY));
    addMcp(db, "mcp_none", "no-auth", null);

    const status = secretKeyRotationStatus(db);
    expect(status.previousKeys).toBe(1);
    expect(status.total).toBe(3); // the null cred_ref is not a stored secret
    expect(status.current).toBe(1);
    expect(status.stale).toBe(2);
    expect(status.unreadable).toBe(0);
    expect(status.converged).toBe(false);

    // Named, so the operator knows which dormant project/server is holding it up.
    expect(status.text).toContain("Dormant PAT");
    expect(status.text).toContain("linear");
    expect(status.text).toContain("Do NOT remove VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS");
    // …and never the secret itself.
    expect(status.text).not.toContain("ghp_old");
    expect(status.text).not.toContain("mcp-token");
  });

  it("says the rotation is finished — and safe to drop the key — only when nothing is stale", () => {
    const db = ctx.makeDb();
    addPat(db, "pat_fresh", "Fresh PAT", sealSecret("ghp_new"));

    const status = secretKeyRotationStatus(db);
    expect(status.stale).toBe(0);
    expect(status.converged).toBe(true);
    expect(status.text).toContain("safe to remove VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS");
  });

  it("does NOT call it converged while a secret opens under no configured key", () => {
    const db = ctx.makeDb();
    addPat(db, "pat_lost", "Lost PAT", sealSecret("ghp_lost", LOST_KEY));

    const status = secretKeyRotationStatus(db);
    expect(status.unreadable).toBe(1);
    expect(status.converged).toBe(false);
    expect(status.text).toContain("open under NO configured key");
  });

  it("classifies a value that is not a sealed box at all", () => {
    const db = ctx.makeDb();
    addMcp(db, "mcp_legacy", "legacy", "secret://plain-old-reference");
    const status = secretKeyRotationStatus(db);
    expect(status.notSealed).toBe(1);
    expect(status.stale).toBe(0);
  });
});

describe("resealSecrets", () => {
  it("re-seals every stale secret under the current key and converges", () => {
    const db = ctx.makeDb();
    addPat(db, "pat_dormant", "Dormant PAT", sealSecret("ghp_old", OLD_KEY));
    addMcp(db, "mcp_stale", "linear", sealSecret("mcp-token", OLD_KEY));

    const result = resealSecrets(db);
    expect(result.resealed.map((s) => s.id).sort()).toEqual([
      "mcp_stale",
      "pat_dormant",
    ]);
    expect(result.unreadable).toEqual([]);
    expect(result.status.converged).toBe(true);

    // The plaintext survives the rewrite, and the box now opens under the
    // CURRENT key with no retired key in play.
    expect(openSecret(boxOf(db, "github_pats", "encrypted_token", "pat_dormant"))).toBe(
      "ghp_old",
    );
    expect(openSecret(boxOf(db, "org_mcp_servers", "cred_ref", "mcp_stale"))).toBe(
      "mcp-token",
    );

    // …and it says so, which is the whole point of the pass.
    expect(result.text).toContain("safe to remove VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS");

    const audit = db
      .prepare(`SELECT action, details_json FROM audit_events WHERE action = ?`)
      .all("secrets.resealed") as { details_json: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.details_json).resealed).toBe(2);
  });

  it("leaves an unreadable box exactly as it was and reports it", () => {
    const db = ctx.makeDb();
    const lost = sealSecret("ghp_lost", LOST_KEY);
    addPat(db, "pat_lost", "Lost PAT", lost);

    const result = resealSecrets(db);
    expect(result.resealed).toEqual([]);
    expect(result.unreadable.map((s) => s.id)).toEqual(["pat_lost"]);
    // Byte-identical: that ciphertext is the operator's only copy.
    expect(boxOf(db, "github_pats", "encrypted_token", "pat_lost")).toBe(lost);
    expect(result.status.converged).toBe(false);
  });

  it("dry run reports the work without writing", () => {
    const db = ctx.makeDb();
    const stale = sealSecret("ghp_old", OLD_KEY);
    addPat(db, "pat_dormant", "Dormant PAT", stale);

    const result = resealSecrets(db, { dryRun: true });
    expect(result.resealed.map((s) => s.id)).toEqual(["pat_dormant"]);
    expect(boxOf(db, "github_pats", "encrypted_token", "pat_dormant")).toBe(stale);
    expect(result.status.stale).toBe(1);
    expect(
      db.prepare(`SELECT count(*) c FROM audit_events WHERE action = ?`).get(
        "secrets.resealed",
      ),
    ).toEqual({ c: 0 });
  });
});

describe("SEALED_STORES covers every sealed store", () => {
  /**
   * A convergence count that silently misses a store is worse than no count:
   * it would tell an operator it is safe to drop the retired key while a whole
   * table still needs it. So the store list is pinned to the `sealSecret(`
   * call sites — add a third sealed store and this fails until it is listed.
   */
  it("no module seals a secret outside the known stores", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const appRoot = path.resolve(here, "../..");
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
        if (statSync(full).size > 2_000_000) continue;
        if (/\bsealSecret\(/.test(readFileSync(full, "utf8"))) {
          callers.push(path.relative(appRoot, full));
        }
      }
    };
    walk(appRoot);

    expect(callers.sort()).toEqual([
      // The definition itself.
      "server/secrets/secret-box.server.ts",
      // The two sealed stores…
      "server/auth/oauth-providers.server.ts",
      "server/org/resources.server.ts",
      "server/secrets/pat-store.server.ts",
      // …and this module, which re-seals all of them.
      "server/secrets/key-rotation.server.ts",
    ].sort());
    expect(SEALED_STORES.map((s) => s.table).sort()).toEqual([
      "github_pats",
      // R19-16: sign-in client secrets rotate with everything else — an
      // unregistered store would silently outlive a key rotation.
      "oauth_providers",
      "org_mcp_servers",
    ]);
  });
});
