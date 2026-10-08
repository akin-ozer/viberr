import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  clearS3AuditConfig,
  getS3AuditConfigView,
  setS3AuditConfig,
} from "./s3-config.server";

/**
 * The S3 audit-export TARGET is where the audit log gets shipped, so pointing
 * it somewhere new — or removing it — is a governed action under the same rule
 * as every other org setting. It recorded nothing at all: the one governed
 * action that left no trace in the log it redirects, on a surface whose whole
 * job is the record. `audit-coverage.server.test.ts` did not catch it because
 * that test is a hand-listed enumeration of actions and this family was never
 * on the list.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ACTOR = { userId: "u_admin", label: "admin@viberr.dev" };

const TARGET = {
  bucket: "acme-audit",
  region: "eu-west-1",
  prefix: "viberr/",
  endpoint: "",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cret-key-value",
};

describe("S3 audit-export target records audit", () => {
  it("saving a target audits it, without the secret", () => {
    // Canary: drop the recordAudit from setS3AuditConfig and this reads 0 rows.
    const db = ctx.makeDb();
    setS3AuditConfig(db, TARGET, ACTOR);

    const rows = listAuditEvents(db, { action: "org.audit_export.target_saved" });
    expect(rows).toHaveLength(1);
    const details = rows[0]!.details ?? {};
    expect(details.bucket).toBe("acme-audit");
    expect(details.region).toBe("eu-west-1");
    // The access key ID is what the settings form already renders; the SECRET
    // is a sealed box and must never reach the audit log (or any log).
    expect(details.accessKeyId).toBe("AKIAEXAMPLE");
    expect(JSON.stringify(details)).not.toContain("s3cret-key-value");
    expect(details.created).toBe(true);
    expect(details.secretRotated).toBe(true); // a first save seals a new secret
  });

  it("a later edit reads as an update, and says whether the key was rotated", () => {
    const db = ctx.makeDb();
    setS3AuditConfig(db, TARGET, ACTOR);
    // Blank secret = keep the sealed one (the form's edit-without-retyping path).
    setS3AuditConfig(
      db,
      { ...TARGET, bucket: "acme-audit-2", secretAccessKey: "" },
      ACTOR,
    );

    const rows = listAuditEvents(db, { action: "org.audit_export.target_saved" });
    expect(rows).toHaveLength(2);
    // Both rows land in the same millisecond, so `occurred_at DESC, id DESC`
    // does not reliably order them — pick the edit by what it says, not by
    // where it sits.
    const edit = rows
      .map((r) => r.details ?? {})
      .find((d) => d.bucket === "acme-audit-2");
    expect(edit, "the edit must be recorded").toBeDefined();
    expect(edit!.created).toBe(false);
    expect(edit!.secretRotated).toBe(false);
    // The kept secret still works, so this really was an edit, not a re-create.
    expect(getS3AuditConfigView(db)?.hasSecret).toBe(true);
  });

  it("clearing the target audits it too, naming what was removed", () => {
    const db = ctx.makeDb();
    setS3AuditConfig(db, TARGET, ACTOR);
    clearS3AuditConfig(db, ACTOR);

    const rows = listAuditEvents(db, {
      action: "org.audit_export.target_cleared",
    });
    expect(rows).toHaveLength(1);
    expect((rows[0]!.details ?? {}).bucket).toBe("acme-audit");
    expect(getS3AuditConfigView(db)).toBeNull();
  });
});
