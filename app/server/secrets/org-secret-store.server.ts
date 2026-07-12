import type Database from "better-sqlite3";
import {
  recordAudit,
  type AuditActor,
} from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { newId } from "~/shared/ids/new-id.server";
import { slugify } from "~/shared/ids/slugify";
import { openSecret, sealSecret } from "./secret-box.server";

const SECRET_REF_PREFIX = "secret://org/";
const MAX_SECRET_BYTES = 64 * 1024;

interface OrgSecretRow {
  id: string;
  name: string;
  value_suffix: string;
  created_at: string;
  updated_at: string;
}

export interface OrgSecretMetadata {
  id: string;
  name: string;
  ref: string;
  masked: string;
  createdAt: string;
  updatedAt: string;
}

function toRef(name: string): string {
  return `${SECRET_REF_PREFIX}${name}`;
}

function mapRow(row: OrgSecretRow): OrgSecretMetadata {
  return {
    id: row.id,
    name: row.name,
    ref: toRef(row.name),
    masked: `····${row.value_suffix}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const META_COLUMNS = "id, name, value_suffix, created_at, updated_at";

/** Metadata-only listing. Encrypted and plaintext values never reach loaders. */
export function listOrgSecrets(db: Database.Database): OrgSecretMetadata[] {
  const rows = db
    .prepare(`SELECT ${META_COLUMNS} FROM org_secrets ORDER BY name ASC`)
    .all() as OrgSecretRow[];
  return rows.map(mapRow);
}

export function getOrgSecretMetadata(
  db: Database.Database,
  id: string,
): OrgSecretMetadata | null {
  const row = db
    .prepare(`SELECT ${META_COLUMNS} FROM org_secrets WHERE id = ?`)
    .get(id) as OrgSecretRow | undefined;
  return row ? mapRow(row) : null;
}

function validateValue(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
    throw AppError.validation("Enter a secret value up to 64 KB.");
  }
  return value;
}

/**
 * Creates or rotates an org secret. Names (and therefore refs) are immutable;
 * rotation never rewrites an MCP config and an empty edit never erases a value.
 */
export function saveOrgSecret(
  db: Database.Database,
  input: { id?: string | null; name: string; value: string },
  actor: AuditActor,
): { secret: OrgSecretMetadata; toast: string } {
  const name = slugify(input.name);
  if (name.length < 2) throw AppError.validation("Give the secret a name.");
  const now = new Date().toISOString();

  if (input.id) {
    const existing = getOrgSecretMetadata(db, input.id);
    if (!existing) throw AppError.notFound("No such org secret.");
    if (name !== existing.name) {
      throw AppError.validation(
        "Secret names are immutable. Create a new secret and update its mappings instead.",
      );
    }
    const value = validateValue(input.value);
    db.prepare(
      `UPDATE org_secrets
       SET encrypted_value = ?, value_suffix = ?, updated_at = ?
       WHERE id = ?`,
    ).run(sealSecret(value), value.slice(-4), now, input.id);
    recordAudit(db, {
      action: "org.secret.rotated",
      actor,
      subjectKind: "org_secret",
      subjectId: input.id,
      details: { name },
    });
    return {
      secret: getOrgSecretMetadata(db, input.id)!,
      toast: `${name} rotated`,
    };
  }

  const value = validateValue(input.value);
  const clash = db
    .prepare("SELECT id FROM org_secrets WHERE name = ?")
    .get(name) as { id: string } | undefined;
  if (clash) throw AppError.validation(`A secret named ${name} already exists.`);
  const id = newId("sec");
  db.prepare(
    `INSERT INTO org_secrets
       (id, name, encrypted_value, value_suffix, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, name, sealSecret(value), value.slice(-4), now, now);
  recordAudit(db, {
    action: "org.secret.created",
    actor,
    subjectKind: "org_secret",
    subjectId: id,
    details: { name },
  });
  return {
    secret: getOrgSecretMetadata(db, id)!,
    toast: `${name} stored`,
  };
}

function authRefs(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed).filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
}

export function deleteOrgSecret(
  db: Database.Database,
  id: string,
  actor: AuditActor,
): { toast: string } {
  const existing = getOrgSecretMetadata(db, id);
  if (!existing) throw AppError.notFound("No such org secret.");
  const rows = db.prepare("SELECT auth_json FROM org_mcp_servers").all() as Array<{
    auth_json: string;
  }>;
  if (rows.some((row) => authRefs(row.auth_json).includes(existing.ref))) {
    throw AppError.validation(
      `Remove ${existing.ref} from its MCP authentication mappings first.`,
    );
  }
  db.prepare("DELETE FROM org_secrets WHERE id = ?").run(id);
  recordAudit(db, {
    action: "org.secret.deleted",
    actor,
    subjectKind: "org_secret",
    subjectId: id,
    details: { name: existing.name },
  });
  return { toast: `${existing.name} deleted` };
}

/** True only for the canonical, explicit org-secret reference syntax. */
export function isOrgSecretRef(value: string): boolean {
  return /^secret:\/\/org\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
}

/**
 * Server-internal execution-boundary resolver. The caller must feed the value
 * directly into a child env / request header and must never persist or log it.
 */
export function resolveOrgSecretRef(
  db: Database.Database,
  ref: string,
): string {
  if (!isOrgSecretRef(ref)) {
    throw AppError.validation("An MCP authentication mapping has an invalid secret reference.");
  }
  const name = ref.slice(SECRET_REF_PREFIX.length);
  const row = db
    .prepare("SELECT encrypted_value FROM org_secrets WHERE name = ?")
    .get(name) as { encrypted_value: string } | undefined;
  if (!row) {
    throw AppError.validation("An MCP authentication secret is missing.");
  }
  return openSecret(row.encrypted_value);
}
