import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { recordAudit } from "~/server/audit/audit-recorder.server";
import { AppError } from "~/server/errors/app-error.server";
import { ERROR_CODES } from "~/server/errors/error-codes";
import { logger } from "~/server/logging/logger.server";
import {
  openSecretRotating,
  sealSecret,
} from "~/server/secrets/secret-box.server";
import { newId } from "~/shared/ids/new-id.server";
import { BACKEND_LABEL } from "~/shared/text/backend-label";
import { retireBackendRecordsFor } from "./backend-quota.server";
import { filteredSpawnEnv, type RealBackend } from "./runtime-registry.server";
import {
  claudeLoginCredentialPath,
  codexLoginCredentialPath,
  ensureUserBackendHome,
  userBackendHome,
} from "./user-homes.server";

/**
 * Personal agent-backend credentials (ruling 127) — the store, and the ONE
 * per-person availability answer every surface reads.
 *
 * A person connects Claude and Codex on Profile → Agent accounts in one of two
 * ways, and the row here records WHICH:
 *
 *  - `login` — the person signed in through the UNMODIFIED bundled vendor
 *    binary (`claude auth login`, `codex login --device-auth`). The row carries
 *    NO secret: the credential lives where the vendor's own client put it,
 *    inside that person's runtime home. Viberr never reads, copies or stores a
 *    Claude.ai or ChatGPT token (Anthropic's Claude Code legal page forbids a
 *    hosting platform from collecting or intermediating them), so the only
 *    thing this module knows about a login is that its FILE exists.
 *  - `api_key` / `access_token` — the person pasted a Console/Platform API key
 *    or a ChatGPT workspace access token. That value IS ours to hold, so it is
 *    sealed (AES-256-GCM, `secret-box`) and the store is registered in
 *    `SEALED_STORES` so a key rotation reaches it.
 *
 * Nothing outside this module ever sees a box: `BackendCredentialRow` has no
 * field for one and the metadata SELECT does not even name the column. The one
 * decryption path is {@link runCredentialFor}, which hands the plaintext
 * straight to the spawn env of the run that person's account is paying for —
 * together with the `secrets` list the run sink redacts from every persisted
 * line.
 *
 * Availability is re-derived on every call (a row read plus, for a login, one
 * `existsSync`) and never cached: a runtime volume that was wiped must read as
 * "sign in again" the moment it happens, and a fresh sign-in must count without
 * a restart. The instance-level probe this replaces (`isBackendAvailable`) had
 * no person in it at all.
 */

export type CredentialKind = "login" | "api_key" | "access_token";
/** The credential kinds a person can PASTE — every `CredentialKind` but
 *  `login`, which no human types (the vendor binary holds it). */
export type PastedKind = Exclude<CredentialKind, "login">;
/** Which vendor flow produced a `login` row. */
export type LoginMethod = "claudeai" | "console" | "device";

/**
 * Absolute paths to the UNMODIFIED vendor binaries. Defined here because this
 * module needs one for `claude auth logout` / `codex logout`; the sign-in
 * driver (`backend-login.server.ts`) owns the resolver and re-exports the type.
 * Always injected by the caller — a server module that guessed at a binary path
 * would run whatever a PATH lookup found.
 */
export interface BackendBinaries {
  claude: string;
  codex: string;
}

/** The person a credential mutation is attributed to (audit actor + subject).
 *  `userId` is non-null here, unlike the generic `AuditActor`: a personal
 *  credential always belongs to a signed-in human. */
export interface BackendCredentialActor {
  userId: string;
  label: string;
}

/** A stored credential as every reader sees it — never the box. */
export interface BackendCredentialRow {
  id: string;
  userId: string;
  backend: RealBackend;
  kind: CredentialKind;
  method: LoginMethod | null;
  /** Last 4 characters of a pasted key, for display. Null on `login` rows. */
  secretSuffix: string | null;
  /** Non-secret facts the vendor reported at connect time. */
  detail: Record<string, string>;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Who actually accepts or rejects a pasted key — the company, not the CLI. */
const VENDOR_LABEL = { claude: "Anthropic", codex: "OpenAI" } as const;

const CONNECT_HERE = "Profile → Agent accounts";

// ------------------------------------------------------------------ reads

/** The metadata columns every read selects. `secret_box` is deliberately absent:
 *  a column that is never selected cannot be leaked by a caller that spreads a
 *  row into loader data. */
const CREDENTIAL_COLUMNS = `id, user_id, backend, kind, method, secret_suffix,
       detail_json, verified_at, created_at, updated_at`;

/** 0001_baseline declares `backend`, `kind`, `detail_json`, `created_at` and
 *  `updated_at` NOT NULL with CHECK constraints pinning the two vocabularies;
 *  a row that fails this parse is a row these readers cannot describe, which is
 *  the same answer as no row at all. */
const credentialRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  backend: z.enum(["claude", "codex"]),
  kind: z.enum(["login", "api_key", "access_token"]),
  method: z.enum(["claudeai", "console", "device"]).nullable().catch(null),
  secret_suffix: z.string().nullable(),
  detail_json: z.string(),
  verified_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
type CredentialRow = z.infer<typeof credentialRowSchema>;

/** The vendor's own non-secret facts. Tolerant per entry: a hand-edited or
 *  half-written blob degrades to "no detail", never to a failed read. */
const detailSchema = z.record(z.string(), z.string()).catch({});

function parseDetail(json: string): Record<string, string> {
  try {
    return detailSchema.parse(JSON.parse(json));
  } catch {
    return {};
  }
}

function mapRow(row: CredentialRow): BackendCredentialRow {
  return {
    id: row.id,
    userId: row.user_id,
    backend: row.backend,
    kind: row.kind,
    method: row.method,
    secretSuffix: row.secret_suffix,
    detail: parseDetail(row.detail_json),
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getBackendCredential(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
): BackendCredentialRow | null {
  const row = credentialRowSchema.safeParse(
    db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM user_backend_credentials
          WHERE user_id = ? AND backend = ?`,
      )
      .get(userId, backend),
  );
  return row.success ? mapRow(row.data) : null;
}

export function listBackendCredentials(
  db: DatabaseSync,
  userId: string,
): BackendCredentialRow[] {
  return db
    .prepare(
      `SELECT ${CREDENTIAL_COLUMNS} FROM user_backend_credentials
        WHERE user_id = ? ORDER BY backend ASC`,
    )
    .all(userId)
    .flatMap((row) => {
      const parsed = credentialRowSchema.safeParse(row);
      return parsed.success ? [mapRow(parsed.data)] : [];
    });
}

/** `secret_box` is a single nullable TEXT column; a row without one is a login
 *  row, which by design has no secret to open. */
const sealedBoxRow = z.object({ secret_box: z.string() });

/**
 * The plaintext behind a sealed row. SERVER-INTERNAL: the only caller is
 * {@link runCredentialFor}, which puts it in a child process env and hands the
 * same value to the run sink's redactor. Never into loader data, logs, audit
 * details or an error message.
 *
 * A9 rotation window: a box sealed under a RETIRED key opens and is re-sealed
 * in place under the current one, exactly like the PAT store — without it,
 * rotating `VIBERR_SECRET_ENCRYPTION_KEY` would brick every connected account
 * with no signal but a failing run.
 */
function openBackendSecret(db: DatabaseSync, credentialId: string): string {
  const row = sealedBoxRow.safeParse(
    db
      .prepare(`SELECT secret_box FROM user_backend_credentials WHERE id = ?`)
      .get(credentialId),
  );
  if (!row.success) {
    throw AppError.internal(
      `backend credential ${credentialId} holds no sealed secret`,
    );
  }
  const opened = openSecretRotating(row.data.secret_box);
  if (opened.staleKey) {
    try {
      db.prepare(
        `UPDATE user_backend_credentials SET secret_box = ? WHERE id = ?`,
      ).run(sealSecret(opened.plaintext), credentialId);
      logger.info("re-sealed a backend credential under the current key", {
        credentialId,
      });
    } catch (error) {
      // The read succeeded — a failed re-seal only costs the next read another
      // fallback, so it never fails the caller.
      logger.warn("could not re-seal a backend credential", {
        credentialId,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return opened.plaintext;
}

// ------------------------------------------------------- vendor logout side

const execFileAsync = promisify(execFile);

/** A vendor logout gets 20 s: it is one local process doing one HTTP revoke,
 *  and a hung binary must never hold the disconnect open. */
const LOGOUT_TIMEOUT_MS = 20_000;

/** What a rejected `execFile` promise carries. Node hangs these on the error
 *  object rather than any declared type. Only the EXIT CODE is read — a vendor
 *  binary's stdout/stderr may echo a credential, so it is never logged. */
const execFileRejection = z
  .object({ code: z.number().nullable().catch(null) })
  .catch(() => ({ code: null }));

/** The env var each vendor binary reads its home from. */
const HOME_ENV_KEY = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
} as const;

const LOGOUT_ARGS = {
  claude: ["auth", "logout"],
  codex: ["logout"],
} as const;

/**
 * Ask the vendor's own binary to revoke the sign-in it holds.
 *
 * argv only, never a shell; the child gets `filteredSpawnEnv()` (every
 * credential-shaped variable stripped) plus the one home variable, so a logout
 * cannot reach any credential but the one it is revoking. Never throws: a
 * failed or missing logout must not stop the disconnect — the credential FILE
 * is removed either way, which is what makes the account unusable from this
 * server.
 */
async function runVendorLogout(
  userId: string,
  backend: RealBackend,
  binary: string,
  dataRoot?: string,
): Promise<void> {
  const home = ensureUserBackendHome(userId, backend, dataRoot);
  const env = filteredSpawnEnv();
  // Neither vendor's home variable may be inherited: the child must act on the
  // home this call names and on nothing else, so an ambient CLAUDE_CONFIG_DIR
  // can never make a `codex logout` read a directory nobody chose.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env[HOME_ENV_KEY[backend]] = home;
  try {
    await execFileAsync(binary, [...LOGOUT_ARGS[backend]], {
      env,
      timeout: LOGOUT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    logger.warn("vendor logout did not exit cleanly", {
      backend,
      exitCode: execFileRejection.parse(error).code,
    });
  }
}

/** Delete the vendor's credential file from the person's home. Transcripts stay
 *  (they are the run record, not a credential). Never throws on a missing
 *  file — a disconnect after a volume wipe is still a disconnect. */
function removeLoginCredentialFile(
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): void {
  const home = userBackendHome(userId, backend, dataRoot);
  const file =
    backend === "claude"
      ? claudeLoginCredentialPath(home)
      : codexLoginCredentialPath(home);
  try {
    rmSync(file, { force: true });
  } catch (error) {
    logger.warn("could not remove a vendor credential file", {
      backend,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** What retiring ONE (user, backend) credential needs from its caller: the
 *  binary of THAT vendor, when this deployment has it. Per backend rather than
 *  the pair, so a host missing one vendor's optional package still runs the
 *  other vendor's logout (`backendBinaryIfPresent`). */
interface VendorDeps {
  binary?: string;
  dataRoot?: string;
}

/**
 * Retire whatever is connected for (user, backend) so a new method can take the
 * slot. A `login` row is logged out at the vendor and its credential file
 * deleted FIRST: leaving a live sign-in file behind would leave a credential on
 * this server that no row accounts for, and the next `runCredentialFor` would
 * happily bill it.
 *
 * Ruling 165: the refusal Viberr observed on the slot goes with it, row or no
 * row. A spent window or a rejected credential is evidence about the account
 * that was billed, and whatever takes the slot next is not that account; left
 * standing, the Profile card kept "usage window spent · reopens 21:30" over a
 * freshly connected account whose runs were going through, and the dispatch
 * hold parked the new account until the old one's instant. Retired before the
 * row is touched, and without a row to touch too, so a record that outlived an
 * earlier disconnect is retired by the connect that follows it.
 */
async function clearExistingCredential(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  existing: BackendCredentialRow | null,
  deps: VendorDeps,
): Promise<void> {
  retireBackendRecordsFor(db, backend, userId);
  if (!existing) return;
  if (existing.kind === "login") {
    if (deps.binary) {
      await runVendorLogout(userId, backend, deps.binary, deps.dataRoot);
    } else {
      // The route hands `backendBinaryIfPresent(backend)` in. Without it the
      // sign-in can still be made unusable here (the file goes), but the
      // vendor-side session is left for the person to revoke — say so rather
      // than implying a revoke happened.
      logger.warn("disconnecting a vendor login without a binary to log out", {
        backend,
      });
    }
    removeLoginCredentialFile(userId, backend, deps.dataRoot);
  }
  db.prepare(`DELETE FROM user_backend_credentials WHERE id = ?`).run(
    existing.id,
  );
}

// ------------------------------------------------------------ paste a key

/** The probe each pasted credential is verified against. Authenticated with the
 *  pasted value itself (it rides a request header, which is why the catch below
 *  never echoes a fetch failure's cause), and free of any cost: listing models
 *  bills nothing (ruling 19's spirit — never spend the person's money to find
 *  out whether their key works). */
const KEY_PROBE = {
  claude: { host: "api.anthropic.com", url: "https://api.anthropic.com/v1/models" },
  codex: { host: "api.openai.com", url: "https://api.openai.com/v1/models" },
} as const;

const PROBE_TIMEOUT_MS = 15_000;
const MAX_SECRET_LEN = 512;

/**
 * Which pasted credentials each backend accepts, and the ONE home of that fact
 * (ruling 127).
 *
 * `setBackendApiKey` refuses anything outside it, and Profile → Agent accounts
 * builds its paste buttons from the same table
 * (`features/profile/profile-query.server.ts`), so the card can never offer a
 * kind this function then rejects. The two lists are not symmetric because
 * Anthropic has no workspace access token.
 */
export const BACKEND_PASTE_KINDS = {
  claude: ["api_key"],
  codex: ["api_key", "access_token"],
} as const satisfies Record<RealBackend, readonly PastedKind[]>;

export interface SetBackendApiKeyDeps {
  /** Injected in tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** This backend's binary, needed only to log a previous `login` row out (see
   *  `clearExistingCredential`). */
  binary?: string;
  dataRoot?: string;
}

/**
 * The paste path: verify a pasted key against the provider, then seal it as
 * this person's credential for that backend, replacing whatever was connected.
 *
 * A ChatGPT workspace ACCESS TOKEN has no free probe (every endpoint that
 * accepts one costs money), so it is stored `verified_at = null` with an
 * explicit `{"verification":"unverified"}` detail — the card says so rather
 * than implying a check that never happened.
 */
export async function setBackendApiKey(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  kind: "api_key" | "access_token",
  secret: string,
  deps: SetBackendApiKeyDeps = {},
): Promise<BackendCredentialRow> {
  const allowed: readonly PastedKind[] = BACKEND_PASTE_KINDS[backend];
  if (!allowed.includes(kind)) {
    throw AppError.validation(
      "Claude has no workspace access token. Use an Anthropic Console API key, or sign in with Claude.",
    );
  }
  const value = validatePastedSecret(backend, kind, secret);
  const verifiedAt =
    kind === "access_token"
      ? null
      : await verifyKeyWithProvider(backend, value, deps.fetchImpl ?? fetch);
  const detail: Record<string, string> =
    kind === "access_token" ? { verification: "unverified" } : {};

  const existing = getBackendCredential(db, actor.userId, backend);
  await clearExistingCredential(db, actor.userId, backend, existing, deps);

  const id = newId("ubc");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_backend_credentials
       (id, user_id, backend, kind, method, secret_box, secret_suffix,
        detail_json, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    actor.userId,
    backend,
    kind,
    sealSecret(value),
    value.slice(-4),
    JSON.stringify(detail),
    verifiedAt,
    now,
    now,
  );
  recordAudit(db, {
    action: "profile.backend.connected",
    actor,
    subjectKind: "backend_credential",
    subjectId: id,
    details: { backend, kind, verified: verifiedAt !== null },
  });
  logger.info("personal backend credential connected", {
    backend,
    kind,
    userId: actor.userId,
  });
  const row = getBackendCredential(db, actor.userId, backend);
  if (!row) throw AppError.internal(`backend credential ${id} vanished after insert`);
  return row;
}

/** Format sanity only — the provider is the real judge. Deliberately strict
 *  about Anthropic's documented `sk-ant-` prefix and deliberately NOT strict
 *  about OpenAI's, whose key prefixes have changed more than once. */
function validatePastedSecret(
  backend: RealBackend,
  kind: "api_key" | "access_token",
  secret: string,
): string {
  const noun = kind === "access_token" ? "access token" : "API key";
  const value = secret.trim();
  if (!value) throw AppError.validation(`Paste the ${noun} first.`);
  if (/\s/.test(value)) {
    throw AppError.validation(
      `That ${noun} contains a space or line break — copy it again.`,
    );
  }
  if (value.length > MAX_SECRET_LEN) {
    throw AppError.validation(`That ${noun} is too long to be a real one.`);
  }
  if (backend === "claude" && !value.startsWith("sk-ant-")) {
    throw AppError.validation(
      "An Anthropic Console API key starts with `sk-ant-`.",
    );
  }
  return value;
}

/** Returns the verification timestamp; throws when the provider refuses or
 *  cannot be reached. The key rides a HEADER, never a URL. */
async function verifyKeyWithProvider(
  backend: RealBackend,
  value: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const probe = KEY_PROBE[backend];
  const headers: Record<string, string> =
    backend === "claude"
      ? { "x-api-key": value, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${value}` };
  let response: Response;
  try {
    response = await fetchImpl(probe.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // Never echo the cause: a fetch failure message can carry the request, and
    // the request carries the key.
    throw AppError.validation(
      `Could not reach ${probe.host} to verify the key. Check this server's network access and try again.`,
    );
  }
  if (!response.ok) {
    throw AppError.validation(
      `${VENDOR_LABEL[backend]} rejected the key (HTTP ${response.status}).`,
    );
  }
  return new Date().toISOString();
}

// ------------------------------------------------------------- vendor login

/** How many vendor facts a login row keeps, and how long each may be. The
 *  driver passes what the vendor PRINTED; a cap keeps a surprise token out of
 *  a row that every surface renders. */
const MAX_DETAIL_ENTRIES = 8;
const MAX_DETAIL_VALUE_LEN = 200;

function trimDetail(detail: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, MAX_DETAIL_ENTRIES)
      .map(([key, value]) => [key, value.slice(0, MAX_DETAIL_VALUE_LEN)]),
  );
}

/**
 * Called by the sign-in driver the moment the vendor binary reports success:
 * records the `login` row (no secret — the binary owns the credential in the
 * person's home), retires any pasted key that held the slot, and retires the
 * refusal Viberr observed on whatever held it (ruling 165).
 *
 * Synchronous, and deliberately does NOT run a vendor logout for a previous
 * `login` row: the binary has just written a fresh credential into that very
 * home, and logging out now would revoke the sign-in this call is recording.
 */
export function recordBackendLogin(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  method: LoginMethod,
  detail: Record<string, string>,
): BackendCredentialRow {
  const existing = getBackendCredential(db, actor.userId, backend);
  if (existing) {
    db.prepare(`DELETE FROM user_backend_credentials WHERE id = ?`).run(
      existing.id,
    );
  }
  const id = newId("ubc");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_backend_credentials
       (id, user_id, backend, kind, method, secret_box, secret_suffix,
        detail_json, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, 'login', ?, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    actor.userId,
    backend,
    method,
    JSON.stringify(trimDetail(detail)),
    now,
    now,
    now,
  );
  recordAudit(db, {
    action: "profile.backend.connected",
    actor,
    subjectKind: "backend_credential",
    subjectId: id,
    details: { backend, kind: "login", method },
  });
  logger.info("personal backend sign-in recorded", {
    backend,
    method,
    userId: actor.userId,
  });
  // Ruling 165: this writer bypasses `clearExistingCredential` on purpose (no
  // vendor logout over a credential the binary has just written), so it
  // retires the refusal observed on the previous account itself.
  retireBackendRecordsFor(db, backend, actor.userId);
  const row = getBackendCredential(db, actor.userId, backend);
  if (!row) throw AppError.internal(`backend credential ${id} vanished after insert`);
  return row;
}

export interface DisconnectBackendDeps {
  /** This backend's binary, when the deployment has it: the vendor's own
   *  logout runs with it, and without it only the local half happens. */
  binary?: string;
  dataRoot?: string;
}

/**
 * Disconnect a backend for the acting person: log the vendor sign-in out (login
 * rows), remove its credential file, drop the row. Transcripts stay — they are
 * the record of what the agents did, not a credential.
 *
 * Refuses when nothing is connected instead of succeeding silently, so the UI
 * can toast the truth ("Claude isn't connected.") rather than "disconnected".
 */
export async function disconnectBackend(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  deps: DisconnectBackendDeps = {},
): Promise<void> {
  const existing = getBackendCredential(db, actor.userId, backend);
  if (!existing) {
    throw AppError.validation(`${BACKEND_LABEL[backend]} isn't connected.`);
  }
  await clearExistingCredential(db, actor.userId, backend, existing, deps);
  recordAudit(db, {
    action: "profile.backend.disconnected",
    actor,
    subjectKind: "backend_credential",
    subjectId: existing.id,
    details: { backend, kind: existing.kind },
  });
  logger.info("personal backend credential disconnected", {
    backend,
    kind: existing.kind,
    userId: actor.userId,
  });
}

export interface RetireUserBackendsDeps {
  /** Both binaries, because this is the one path that may log BOTH vendors
   *  out. Omitted, each is resolved here and only when a `login` row needs it. */
  binaries?: BackendBinaries;
  dataRoot?: string;
}

/**
 * Retire EVERY agent account a person holds on this server, for the one case
 * that is not a disconnect: the ACCOUNT itself is being removed (ruling 127).
 *
 * `DELETE FROM users` cascades the `user_backend_credentials` rows away, but a
 * foreign key cannot reach the filesystem — and a `login` row's credential is a
 * live Claude.ai / ChatGPT sign-in file the vendor client wrote into
 * `<dataRoot>/runtimes/users/<id>/`. Left behind, it is exactly the state
 * `clearExistingCredential` exists to prevent: a working credential on this
 * server that no row accounts for, that the person can never again reach
 * `disconnectBackend` to revoke, and that every backup taken with the runtime
 * volume copies forward. So the vendor logout runs and the file goes BEFORE
 * the row does.
 *
 * Transcripts stay. They are the run record, not a credential (the same line
 * `disconnectBackend` draws), and the retention sweep is what ages them out.
 *
 * Best effort by construction: `runVendorLogout` never throws, the file
 * removal never throws on a missing file, and a deployment installed without
 * the optional vendor packages still gets the local half. Removing an account
 * must not be blockable by a vendor being unreachable. Returns the backends
 * that had a row, for the caller's audit detail.
 */
export async function retireUserBackends(
  db: DatabaseSync,
  userId: string,
  deps: RetireUserBackendsDeps = {},
): Promise<RealBackend[]> {
  const connected = (["claude", "codex"] as const).flatMap((backend) => {
    const row = getBackendCredential(db, userId, backend);
    return row ? [{ backend, row }] : [];
  });
  if (connected.length === 0) return [];
  for (const entry of connected) {
    // Resolved HERE, not by the caller: account removal is org administration
    // and has no business knowing about vendor packages, and there is no UI on
    // that path to report a missing optional dependency to. Per backend and
    // only for a `login` row, so retiring an account whose credentials are
    // pasted keys never reaches for a binary at all, and a host missing ONE
    // vendor's package still logs the OTHER one out.
    const vendorDeps: VendorDeps = {};
    const binary =
      deps.binaries?.[entry.backend] ??
      (entry.row.kind === "login"
        ? await vendorBinaryIfPresent(entry.backend)
        : undefined);
    if (binary) vendorDeps.binary = binary;
    if (deps.dataRoot !== undefined) vendorDeps.dataRoot = deps.dataRoot;
    await clearExistingCredential(
      db,
      userId,
      entry.backend,
      entry.row,
      vendorDeps,
    );
  }
  logger.info("personal backend credentials retired with the account", {
    userId,
    backends: connected.map((entry) => entry.backend).join(","),
  });
  return connected.map((entry) => entry.backend);
}

/** `backendBinaryIfPresent` (backend-login.server.ts) is the ONE home of the
 *  "no optional package installed is still a valid deployment" tolerance; this
 *  is the lazy import that lets THIS module reach it. Dynamic on purpose:
 *  `backend-login.server.ts` imports this module, so a static import would
 *  close the cycle. */
async function vendorBinaryIfPresent(
  backend: RealBackend,
): Promise<string | undefined> {
  try {
    const { backendBinaryIfPresent } = await import("./backend-login.server");
    return backendBinaryIfPresent(backend);
  } catch {
    // Not even the module loaded. Account removal must still take the local
    // half; it is never blockable by a vendor package.
    return undefined;
  }
}

// -------------------------------------------------------------- health

/** Per-person backend health — the ONE answer the task page, the packets, the
 *  Agents page, the controller and the run service all read. */
export interface UserBackendHealth {
  backend: RealBackend;
  userId: string;
  available: boolean;
  kind: CredentialKind | null;
  method: LoginMethod | null;
  /** credential = sealed key/token present · file = login credential file
   *  present · presence = darwin login home exists without a file (the vendor
   *  client keeps it in the login Keychain) · none = nothing usable. */
  verification: "credential" | "file" | "presence" | "none";
  secretSuffix: string | null;
  verifiedAt: string | null;
  /** When this connection was made (the row's created_at). */
  connectedAt: string | null;
  /** Actionable sentence for the person themselves; null when available. */
  detail: string | null;
}

export interface UserBackendHealthEnv {
  platform?: NodeJS.Platform;
  dataRoot?: string;
}

export function userBackendHealth(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): UserBackendHealth {
  const row = getBackendCredential(db, userId, backend);
  const label = BACKEND_LABEL[backend];
  if (!row) {
    return {
      backend,
      userId,
      available: false,
      kind: null,
      method: null,
      verification: "none",
      secretSuffix: null,
      verifiedAt: null,
      connectedAt: null,
      detail: `${label} isn't connected. Connect it on your ${CONNECT_HERE}.`,
    };
  }
  const base = {
    backend,
    userId,
    kind: row.kind,
    method: row.method,
    secretSuffix: row.secretSuffix,
    verifiedAt: row.verifiedAt,
    connectedAt: row.createdAt,
  };
  if (row.kind !== "login") {
    // A sealed key is usable by definition — nothing on disk has to survive for
    // it to work. (A box the current encryption key cannot open is a rotation
    // accident, and `runCredentialFor` names that precisely at spawn time
    // rather than making every loader pay a decryption to find out.)
    return { ...base, available: true, verification: "credential", detail: null };
  }
  // Re-probed EVERY call, never cached: a wiped runtime volume must read as
  // "sign in again" the moment it happens, and a fresh sign-in must count
  // without a restart.
  const home = userBackendHome(userId, backend, env.dataRoot);
  const file =
    backend === "claude"
      ? claudeLoginCredentialPath(home)
      : codexLoginCredentialPath(home);
  if (pathExists(file)) {
    return { ...base, available: true, verification: "file", detail: null };
  }
  if ((env.platform ?? process.platform) === "darwin" && pathExists(home)) {
    // On macOS the vendor client keeps its sign-in in the login Keychain, which
    // a server-side probe cannot read without popping an unlock dialog. The
    // home exists, so the binary HAS run here: honour the sign-in and report
    // the weaker verification rather than hiding it.
    return { ...base, available: true, verification: "presence", detail: null };
  }
  return {
    ...base,
    available: false,
    verification: "none",
    detail:
      `Your ${label} sign-in file is missing from this server (the runtime volume was wiped). ` +
      `Sign in again on your ${CONNECT_HERE}.`,
  };
}

function pathExists(file: string): boolean {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

export function isBackendAvailableFor(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): boolean {
  return userBackendHealth(db, userId, backend, env).available;
}

/** `user_id` is NOT NULL TEXT on `user_backend_credentials`. */
const connectedRowSchema = z.object({ user_id: z.string() });

/** Every person whose connection to this backend actually holds — the
 *  instance-level number that replaced "is the backend configured". */
export function connectedUserIds(
  db: DatabaseSync,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): string[] {
  const rows = db
    .prepare(
      `SELECT user_id FROM user_backend_credentials
        WHERE backend = ? ORDER BY user_id ASC`,
    )
    .all(backend)
    .flatMap((row) => {
      const parsed = connectedRowSchema.safeParse(row);
      return parsed.success ? [parsed.data.user_id] : [];
    });
  return rows.filter((userId) => isBackendAvailableFor(db, userId, backend, env));
}

export function countConnectedUsers(
  db: DatabaseSync,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): number {
  return connectedUserIds(db, backend, env).length;
}

// ------------------------------------------------------- the run credential

/**
 * What a run spawned for this person needs, and what the sink must redact.
 * `env` is ADDITIVE over `filteredSpawnEnv()` — it carries the home the vendor
 * binary reads and, for a pasted credential, that one credential.
 */
export interface RunCredential {
  env: Record<string, string>;
  /** Plaintext values the run sink redacts from every persisted line. */
  secrets: string[];
  kind: CredentialKind;
  homeDir: string;
}

export function runCredentialFor(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): RunCredential {
  const health = userBackendHealth(db, userId, backend, { dataRoot });
  const row = health.available ? getBackendCredential(db, userId, backend) : null;
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.RUN_UNAVAILABLE,
      status: 409,
      userMessage:
        health.detail ??
        `${BACKEND_LABEL[backend]} isn't connected. Connect it on your ${CONNECT_HERE}.`,
      details: { backend, userId },
    });
  }
  const homeDir = ensureUserBackendHome(userId, backend, dataRoot);
  const env = {
    [backend === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: homeDir,
  };
  const secrets: string[] = [];
  if (row.kind !== "login") {
    // A `login` row adds nothing here: the binary reads its own file from the
    // home. Only a PASTED credential rides the env.
    const secret = openStoredSecret(db, row, backend);
    if (backend === "claude") env.ANTHROPIC_API_KEY = secret;
    else if (row.kind === "api_key") env.CODEX_API_KEY = secret;
    else env.CODEX_ACCESS_TOKEN = secret;
    secrets.push(secret);
  }
  // The codex billing trap, closed by construction: a ChatGPT-workspace token
  // must never lose to an ambient Platform key. `filteredSpawnEnv()` strips
  // OPENAI_API_KEY (CREDENTIAL_ENV_RE matches it) and this map never adds it
  // back, so the child sees a Platform key only when this person pasted one —
  // as CODEX_API_KEY, which the Codex CLI reads on its own.
  //
  // The same closure covers the OTHER vendor's home: this map names exactly one
  // of CLAUDE_CONFIG_DIR / CODEX_HOME, and `filteredSpawnEnv()` strips both
  // (RUNTIME_HOME_ENV_RE) before this rides on top — so an ambient CODEX_HOME
  // pointing at some leftover shared `auth.json` cannot reach a Claude run and
  // let one `codex exec` bill an account this run never chose.
  return { env, secrets, kind: row.kind, homeDir };
}

function openStoredSecret(
  db: DatabaseSync,
  row: BackendCredentialRow,
  backend: RealBackend,
): string {
  try {
    return openBackendSecret(db, row.id);
  } catch (error) {
    logger.error("a connected backend credential could not be opened", {
      backend,
      userId: row.userId,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    throw new AppError({
      code: ERROR_CODES.RUN_UNAVAILABLE,
      status: 409,
      userMessage:
        `Your ${BACKEND_LABEL[backend]} key can no longer be decrypted on this server ` +
        `(the encryption key changed). Connect ${BACKEND_LABEL[backend]} again on your ${CONNECT_HERE}.`,
      details: { backend, userId: row.userId },
    });
  }
}
