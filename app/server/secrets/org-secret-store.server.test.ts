import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { isSecretBox } from "./secret-box.server";
import {
  deleteOrgSecret,
  listOrgSecrets,
  resolveOrgSecretRef,
  saveOrgSecret,
} from "./org-secret-store.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);
const ACTOR = { userId: "u_admin", label: "admin@test" };

describe("org secret store", () => {
  it("stores encrypted values and exposes metadata only", () => {
    const db = ctx.makeDb();
    const saved = saveOrgSecret(
      db,
      { name: "Billing API", value: "plain-super-secret" },
      ACTOR,
    );
    expect(saved.secret).toMatchObject({
      name: "billing-api",
      ref: "secret://org/billing-api",
      masked: "····cret",
    });
    expect(JSON.stringify(listOrgSecrets(db))).not.toContain("plain-super-secret");

    const row = db
      .prepare("SELECT encrypted_value FROM org_secrets WHERE id = ?")
      .get(saved.secret.id) as { encrypted_value: string };
    expect(isSecretBox(row.encrypted_value)).toBe(true);
    expect(row.encrypted_value).not.toContain("plain-super-secret");
    expect(resolveOrgSecretRef(db, saved.secret.ref)).toBe("plain-super-secret");
  });

  it("rotates in place and refuses deletion while an MCP mapping uses the ref", () => {
    const db = ctx.makeDb();
    const { secret } = saveOrgSecret(
      db,
      { name: "api-key", value: "old-secret" },
      ACTOR,
    );
    saveOrgSecret(
      db,
      { id: secret.id, name: secret.name, value: "new-secret" },
      ACTOR,
    );
    expect(resolveOrgSecretRef(db, secret.ref)).toBe("new-secret");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO org_mcp_servers
         (id, name, transport, target, auth_json, created_at, updated_at)
       VALUES ('mcp_x', 'private', 'HTTP', 'https://example.test/mcp', ?, ?, ?)`,
    ).run(JSON.stringify({ "X-API-Key": secret.ref }), now, now);
    expect(() => deleteOrgSecret(db, secret.id, ACTOR)).toThrow(/Remove secret:\/\/org/);
  });

  it("never includes plaintext in audits", () => {
    const db = ctx.makeDb();
    saveOrgSecret(db, { name: "audit-safe", value: "audit-plaintext" }, ACTOR);
    const details = db.prepare("SELECT details_json FROM audit_events").all() as Array<{
      details_json: string;
    }>;
    expect(JSON.stringify(details)).not.toContain("audit-plaintext");
  });
});
