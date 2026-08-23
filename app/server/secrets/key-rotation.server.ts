import type { DatabaseSync } from "node:sqlite";
import { recordAudit, SYSTEM_ACTOR } from "~/server/audit/audit-recorder.server";
import { logger } from "~/server/logging/logger.server";
import {
  isSecretBox,
  openSecretRotating,
  previousSecretKeys,
  sealSecret,
} from "./secret-box.server";

/**
 * Finishing a key rotation (A9, gap 21).
 *
 * `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` makes rotation lazy: a box that
 * opens under a retired key is re-sealed in place by whoever read it, so the
 * store converges with no migration and no downtime. secret-box.server.ts ends
 * its rotation note with the operator instruction *"Once nothing opens under a
 * retired key any more, drop it from the env"* — and nothing in the product
 * could tell an operator when that became true.
 *
 * Lazy convergence only reaches secrets somebody READS. The dormant ones are
 * exactly the risky ones: a PAT on a project nobody touched this quarter, an
 * MCP credential used by one agent. Drop the retired key with those still
 * outstanding and they fail later and quietly — the org-resources path
 * degrades an authenticated MCP server to unauthenticated. Keep it forever and
 * the rotation never retires the compromised key, which was the entire point.
 *
 * So: {@link secretKeyRotationStatus} COUNTS what is still on a retired key
 * (read-only — it runs against a live instance), and {@link resealSecrets}
 * finishes the job in one pass (a writer — the CLI takes the data-root lock,
 * see db/cli-lock.server.ts).
 *
 * There is one more way a secret stays stale that the lazy path cannot fix:
 * `org/resources.server.ts`'s `openedForNewRow` deliberately does not re-seal
 * ("there is nothing to lazily re-seal into"), so a credential read on that
 * path stays retired even though it WAS read. The batch pass covers it, which
 * is why a count on its own would not be enough.
 */

/** Every table that stores a sealed box. `sealSecret(` has exactly two homes;
 *  key-rotation.server.test.ts fails if a third appears, because a count that
 *  silently misses a store is worse than no count. */
export const SEALED_STORES = [
  {
    id: "github_pats",
    label: "GitHub PATs",
    table: "github_pats",
    column: "encrypted_token",
    nameColumn: "label",
    idColumn: "id",
  },
  {
    id: "org_mcp_servers",
    label: "MCP server credentials",
    table: "org_mcp_servers",
    column: "cred_ref",
    nameColumn: "name",
    idColumn: "id",
  },
  // R19-16: OAuth client secrets for GitHub/Google sign-in. The row's own
  // `provider` IS its label — there is at most one per provider, and a
  // provider name is not a secret.
  {
    id: "oauth_providers",
    label: "Sign-in provider secrets",
    table: "oauth_providers",
    column: "client_secret",
    nameColumn: "provider",
    // Keyed by the provider itself — a store's primary key is its own, not a
    // column every table is assumed to carry.
    idColumn: "provider",
  },
  // Pass-25: the S3 audit-export secret access key. One row (id 'default'); the
  // secret lives in its OWN column (not a JSON blob) precisely so this rescan
  // reaches it — an unregistered sealed secret silently outlives a rotation.
  {
    id: "s3_audit_config",
    label: "S3 audit-export secret",
    table: "s3_audit_config",
    column: "secret_box",
    nameColumn: "bucket",
    idColumn: "id",
  },
] as const;

export type SealedStoreId = (typeof SEALED_STORES)[number]["id"];

/** How a stored box responded to the configured keys. */
export type SecretKeyState =
  /** Opens under the CURRENT key — nothing to do. */
  | "current"
  /** Opens only under a RETIRED key — the rotation is not finished. */
  | "stale"
  /** No configured key opens it (and no retired key can be dropped safely). */
  | "unreadable"
  /** Not in the v1 box format at all — pre-encryption or hand-edited. */
  | "not_sealed";

export interface SealedSecretRef {
  store: SealedStoreId;
  id: string;
  /** The row's own human label — never the secret. */
  name: string;
  state: SecretKeyState;
}

export interface SealedStoreScan {
  store: SealedStoreId;
  label: string;
  total: number;
  current: number;
  stale: number;
  unreadable: number;
  notSealed: number;
  secrets: SealedSecretRef[];
}

export interface KeyRotationStatus {
  /** How many retired keys VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS carries. */
  previousKeys: number;
  stores: SealedStoreScan[];
  total: number;
  current: number;
  stale: number;
  unreadable: number;
  notSealed: number;
  /**
   * True when NOTHING opens under a retired key and nothing is unreadable —
   * i.e. it is safe to drop VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS. False while
   * any secret is still outstanding, and false when a secret opens under no
   * key at all (dropping the retired key would make that permanent).
   */
  converged: boolean;
  /** Operator-facing report, ready for stdout. */
  text: string;
}

function scanStore(
  db: DatabaseSync,
  store: (typeof SEALED_STORES)[number],
): SealedStoreScan {
  // SAFETY: every SEALED_STORES entry names columns 0001_baseline declares
  // TEXT — its id column is the table's primary key and its name column is NOT
  // NULL in all three stores (so `string | null` is the conservative reading),
  // and `WHERE <box column> IS NOT NULL` is what makes `box` a string on the
  // one store whose box column is nullable (`org_mcp_servers.cred_ref`).
  const rows = db
    .prepare(
      `SELECT ${store.idColumn} AS id, ${store.nameColumn} AS name, ${store.column} AS box
         FROM ${store.table}
        WHERE ${store.column} IS NOT NULL
        ORDER BY ${store.idColumn}`,
    )
    .all() as { id: string; name: string | null; box: string }[];

  const previous = previousSecretKeys();
  const secrets: SealedSecretRef[] = rows.map((row) => ({
    store: store.id,
    id: row.id,
    name: row.name ?? row.id,
    state: classifyBox(row.box, previous),
  }));

  const count = (state: SecretKeyState) =>
    secrets.filter((s) => s.state === state).length;

  return {
    store: store.id,
    label: store.label,
    total: secrets.length,
    current: count("current"),
    stale: count("stale"),
    unreadable: count("unreadable"),
    notSealed: count("not_sealed"),
    secrets,
  };
}

/** Which key (if any) opens this box. Never returns or logs the plaintext. */
function classifyBox(box: string, previous: Buffer[]): SecretKeyState {
  if (!isSecretBox(box)) return "not_sealed";
  try {
    return openSecretRotating(box, undefined, previous).staleKey
      ? "stale"
      : "current";
  } catch {
    return "unreadable";
  }
}

/**
 * Count every stored secret by which key opens it. READ-ONLY: safe against a
 * running instance, and safe on a read-only database handle.
 */
export function secretKeyRotationStatus(db: DatabaseSync): KeyRotationStatus {
  const previousKeys = previousSecretKeys().length;
  const stores = SEALED_STORES.map((store) => scanStore(db, store));
  const sum = (pick: (s: SealedStoreScan) => number) =>
    stores.reduce((total, store) => total + pick(store), 0);

  const status: Omit<KeyRotationStatus, "text"> = {
    previousKeys,
    stores,
    total: sum((s) => s.total),
    current: sum((s) => s.current),
    stale: sum((s) => s.stale),
    unreadable: sum((s) => s.unreadable),
    notSealed: sum((s) => s.notSealed),
    converged: sum((s) => s.stale) === 0 && sum((s) => s.unreadable) === 0,
  };
  return { ...status, text: renderStatus(status) };
}

function renderStatus(status: Omit<KeyRotationStatus, "text">): string {
  const lines: string[] = [
    `viberr secret-key status — ${status.total} stored secret(s), ${status.previousKeys} retired key(s) configured`,
    "",
  ];
  for (const store of status.stores) {
    lines.push(
      `  ${store.label}: ${store.total} total — ${store.current} on the current key, ` +
        `${store.stale} on a retired key, ${store.unreadable} unreadable, ${store.notSealed} not sealed`,
    );
    for (const secret of store.secrets) {
      if (secret.state === "stale" || secret.state === "unreadable") {
        lines.push(`      ${secret.state}: ${secret.name} (${secret.id})`);
      }
    }
  }
  lines.push("");

  if (status.previousKeys === 0) {
    lines.push(
      status.unreadable > 0
        ? `${status.unreadable} secret(s) open under NO configured key. If you rotated VIBERR_SECRET_ENCRYPTION_KEY, put the old key in VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS and run this again; otherwise they must be re-entered.`
        : "No retired keys are configured — there is no rotation in progress.",
    );
    return lines.join("\n");
  }

  if (status.stale > 0) {
    lines.push(
      `${status.stale} secret(s) still open ONLY under a retired key. Do NOT remove VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS yet — those secrets would become unreadable.`,
      "Finish the rotation with: npm run keys -- reseal",
    );
  }
  if (status.unreadable > 0) {
    lines.push(
      `${status.unreadable} secret(s) open under NO configured key — a key is missing from VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS, or they must be re-entered (Settings → GitHub / MCP servers).`,
    );
  }
  if (status.converged) {
    lines.push(
      "Every stored secret is sealed under the CURRENT key.",
      "It is now safe to remove VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS and restart.",
    );
  }
  return lines.join("\n");
}

// ------------------------------------------------------------------ reseal

export interface ResealResult {
  /** Rows rewritten under the current key. */
  resealed: SealedSecretRef[];
  /** Rows no configured key opens — left exactly as they were. */
  unreadable: SealedSecretRef[];
  /** Rows that failed the UPDATE (the read still succeeded). */
  failed: SealedSecretRef[];
  /** Status AFTER the pass. */
  status: KeyRotationStatus;
  text: string;
}

/**
 * Re-seal every secret that opens only under a retired key, under the current
 * key. WRITES — the caller must hold the data-root writer lock.
 *
 * Deliberately not clever: it re-seals the ones it can, leaves the ones it
 * cannot exactly as they were (an unreadable box is the operator's only copy
 * of that ciphertext), and reports both. `dryRun` lists what it would do.
 */
export function resealSecrets(
  db: DatabaseSync,
  options: { dryRun?: boolean } = {},
): ResealResult {
  const dryRun = options.dryRun ?? false;
  const resealed: SealedSecretRef[] = [];
  const unreadable: SealedSecretRef[] = [];
  const failed: SealedSecretRef[] = [];
  const previous = previousSecretKeys();

  for (const store of SEALED_STORES) {
    // SAFETY: the same store/column correspondence `scanStore` states above —
    // this is byte-for-byte its query, run for the write pass.
    const rows = db
      .prepare(
        `SELECT ${store.idColumn} AS id, ${store.nameColumn} AS name, ${store.column} AS box
           FROM ${store.table}
          WHERE ${store.column} IS NOT NULL
          ORDER BY ${store.idColumn}`,
      )
      .all() as { id: string; name: string | null; box: string }[];

    for (const row of rows) {
      const ref: SealedSecretRef = {
        store: store.id,
        id: row.id,
        name: row.name ?? row.id,
        state: "stale",
      };
      if (!isSecretBox(row.box)) continue;
      let plaintext: string;
      try {
        const opened = openSecretRotating(row.box, undefined, previous);
        if (!opened.staleKey) continue; // already on the current key
        plaintext = opened.plaintext;
      } catch {
        unreadable.push({ ...ref, state: "unreadable" });
        continue;
      }
      if (dryRun) {
        resealed.push(ref);
        continue;
      }
      try {
        db.prepare(
          `UPDATE ${store.table} SET ${store.column} = ? WHERE ${store.idColumn} = ?`,
        ).run(sealSecret(plaintext), row.id);
        resealed.push(ref);
      } catch (error) {
        // Never fail the whole pass over one row — and never echo the box.
        logger.warn("could not re-seal a secret under the current key", {
          store: store.id,
          id: row.id,
          err: error instanceof Error ? error : new Error(String(error)),
        });
        failed.push(ref);
      }
    }
  }

  if (!dryRun && resealed.length > 0) {
    recordAudit(db, {
      action: "secrets.resealed",
      actor: SYSTEM_ACTOR,
      details: {
        resealed: resealed.length,
        unreadable: unreadable.length,
        failed: failed.length,
        stores: resealed.map((s) => s.store),
      },
    });
  }

  const status = secretKeyRotationStatus(db);
  return {
    resealed,
    unreadable,
    failed,
    status,
    text: renderReseal({ resealed, unreadable, failed, status }, dryRun),
  };
}

function renderReseal(
  result: Omit<ResealResult, "text">,
  dryRun: boolean,
): string {
  const verb = dryRun ? "would re-seal" : "re-sealed";
  const lines = [
    `viberr secret-key reseal — ${verb} ${result.resealed.length} secret(s) under the current key`,
  ];
  for (const secret of result.resealed) {
    lines.push(`  ${secret.store}: ${secret.name} (${secret.id})`);
  }
  if (result.unreadable.length > 0) {
    lines.push(
      "",
      `${result.unreadable.length} secret(s) open under NO configured key and were left untouched:`,
      ...result.unreadable.map((s) => `  ${s.store}: ${s.name} (${s.id})`),
    );
  }
  if (result.failed.length > 0) {
    lines.push(
      "",
      `${result.failed.length} secret(s) could not be written back (the read succeeded) — check the log and re-run:`,
      ...result.failed.map((s) => `  ${s.store}: ${s.name} (${s.id})`),
    );
  }
  lines.push("", result.status.text);
  return lines.join("\n");
}
