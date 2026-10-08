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
  backendAccountHome,
  ensureBackendAccountHome,
  ensureUserBackendHome,
  vendorLoginCredentialPath,
  type BackendAccountRef,
} from "./user-homes.server";
import {
  agentGitLaunchFor,
  agentLaunchFor,
  launchEnv,
  resolveExecutable,
} from "./agent-isolation.server";
import { removeAgentTree } from "./agent-trees.server";
import { toError } from "~/shared/errors";

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
 * Ruling 507: a row is one ACCOUNT, and a person may keep several per backend
 * — a work and a personal subscription, a key for when both windows are spent.
 * Connecting adds an account instead of replacing the one there was, and
 * exactly one per (person, backend) is ACTIVE: the one runs bill, which is the
 * one selected most recently ({@link ACTIVE_FIRST}). Switching is a write to
 * `selected_at` and nothing else — no vendor process runs, no file moves —
 * because every account signed in since the ruling keeps its sign-in in a home
 * of its own (`backendAccountHome`), where the vendor wrote it. Removing the
 * active account hands runs back to the one used before it.
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

/** A stored credential — one account (ruling 507) — as every reader sees it,
 *  never the box. */
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
  /** Ruling 507: the person's own name for the account, or null. */
  label: string | null;
  /** Ruling 507: when this account last became the active one. */
  selectedAt: string;
  /** Ruling 507: connected before the ruling, so its sign-in lives in the
   *  backend home itself rather than in a home of its own. */
  legacyHome: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Who actually accepts or rejects a pasted key — the company, not the CLI. */
const VENDOR_LABEL = { claude: "Anthropic", codex: "OpenAI" } as const;

const CONNECT_HERE = "Profile → Agent accounts";

/**
 * Ruling 507: how many accounts one person may keep per backend. Each sign-in
 * is a home on the runtime volume and a vendor session; nobody switches among
 * more than a handful, and a ceiling turns a runaway loop of sign-ins into a
 * sentence instead of a directory per attempt.
 */
export const MAX_ACCOUNTS_PER_BACKEND = 10;

/** The longest name a person may give an account (ruling 507). */
export const MAX_ACCOUNT_LABEL_LEN = 60;

// ------------------------------------------------------------------ reads

/** The metadata columns every read selects. `secret_box` is deliberately absent:
 *  a column that is never selected cannot be leaked by a caller that spreads a
 *  row into loader data. */
const CREDENTIAL_COLUMNS = `id, user_id, backend, kind, method, secret_suffix,
       detail_json, verified_at, label, selected_at, legacy_home, created_at, updated_at`;

/**
 * Ruling 507: the order that puts a person's ACTIVE account first — the most
 * recently selected, then the newer row, then the id, so the answer is total.
 * The one definition of "active": every reader that wants the account runs
 * bill takes the first row of it. Selection stamps are unique per person and
 * backend ({@link selectionStamp}), so the tie-breakers never pick the active
 * account.
 */
const ACTIVE_FIRST = "selected_at DESC, created_at DESC, id DESC";

const latestSelectionSchema = z.object({ latest: z.string().nullable() });

/**
 * The `selected_at` that makes an account the active one: now, or one
 * millisecond past the person's latest selection on that backend when that is
 * not already in the past. Two selections in one millisecond (a connect and a
 * switch, two sign-ins) would otherwise tie, and {@link ACTIVE_FIRST} would
 * settle the tie on the random id instead of on which came last.
 */
function selectionStamp(db: DatabaseSync, userId: string, backend: RealBackend): string {
  const now = Date.now();
  const row = latestSelectionSchema.parse(
    db
      .prepare(
        `SELECT MAX(selected_at) AS latest FROM user_backend_credentials
          WHERE user_id = ? AND backend = ?`,
      )
      .get(userId, backend),
  );
  const latest = row.latest === null ? Number.NaN : Date.parse(row.latest);
  return new Date(latest >= now ? latest + 1 : now).toISOString();
}

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
  label: z.string().nullable().catch(null),
  selected_at: z.string().catch(""),
  legacy_home: z.number().catch(0),
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
    label: row.label,
    selectedAt: row.selected_at,
    legacyHome: row.legacy_home === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRows(rows: unknown[]): BackendCredentialRow[] {
  return rows.flatMap((row) => {
    const parsed = credentialRowSchema.safeParse(row);
    return parsed.success ? [mapRow(parsed.data)] : [];
  });
}

/** The ACTIVE account of (person, backend) — the one every run on that backend
 *  bills (ruling 507) — or null when the person has connected none. */
export function getBackendCredential(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
): BackendCredentialRow | null {
  return listBackendAccounts(db, userId, backend)[0] ?? null;
}

/** Every account the person holds on one backend, the active one first, then
 *  the rest in the order they were last used (ruling 507). */
export function listBackendAccounts(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
): BackendCredentialRow[] {
  return parseRows(
    db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM user_backend_credentials
          WHERE user_id = ? AND backend = ? ORDER BY ${ACTIVE_FIRST}`,
      )
      .all(userId, backend),
  );
}

/** One of THIS person's accounts by id, or null — never another person's: an
 *  id from a form is only ever looked up together with the session's user. */
export function getBackendAccount(
  db: DatabaseSync,
  userId: string,
  accountId: string,
): BackendCredentialRow | null {
  const row = credentialRowSchema.safeParse(
    db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM user_backend_credentials
          WHERE user_id = ? AND id = ?`,
      )
      .get(userId, accountId),
  );
  return row.success ? mapRow(row.data) : null;
}

/** Every account the person holds, both backends, each backend's active one
 *  first. */
function listBackendCredentials(
  db: DatabaseSync,
  userId: string,
): BackendCredentialRow[] {
  return parseRows(
    db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM user_backend_credentials
          WHERE user_id = ? ORDER BY backend ASC, ${ACTIVE_FIRST}`,
      )
      .all(userId),
  );
}

/** Where one account's vendor sign-in lives (ruling 507). */
function accountRef(row: Pick<BackendCredentialRow, "id" | "legacyHome">): BackendAccountRef {
  return { id: row.id, legacyHome: row.legacyHome };
}

/**
 * How an account is named to the person who holds it (ruling 507): their own
 * label; else what the vendor reported about a sign-in (the email Claude's
 * `auth status` prints); else what kind of credential it is. The one home of
 * the name, so the Profile list, the toasts and the audit-facing sentences
 * agree.
 */
export function backendAccountName(
  row: Pick<BackendCredentialRow, "label" | "kind" | "method" | "detail" | "secretSuffix">,
): string {
  if (row.label) return row.label;
  if (row.kind === "login") {
    const email = row.detail.email;
    if (email) return email;
    return row.method === "console"
      ? "Console sign-in"
      : row.method === "device"
        ? "ChatGPT sign-in"
        : "Claude sign-in";
  }
  const noun = row.kind === "access_token" ? "Workspace access token" : "API key";
  return row.secretSuffix ? `${noun} ending in ${row.secretSuffix}` : noun;
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
        err: toError(error),
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

/**
 * The env a vendor binary runs on for one ACCOUNT outside a run: the sign-in
 * driver (`startBackendLogin`) and `runVendorLogout`. `filteredSpawnEnv()`
 * (every credential-shaped variable stripped) plus the ONE home variable of
 * this backend, pointed at that account's home (ruling 507), so the child
 * cannot reach any credential but the one it is signing in or revoking — not
 * even the person's other accounts on the same backend.
 */
export function vendorSpawnEnv(
  backend: RealBackend,
  accountHome: string,
): Record<string, string> {
  const env = filteredSpawnEnv();
  // Neither vendor's home variable may be inherited: the child must act on the
  // home this call names and on nothing else, so an ambient CLAUDE_CONFIG_DIR
  // can never make a `codex logout` read a directory nobody chose, nor an
  // ambient CODEX_HOME a `claude auth login`.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  env[HOME_ENV_KEY[backend]] = accountHome;
  return env;
}

/** What a vendor binary run for one person is spawned as. */
export interface VendorCommand {
  file: string;
  env: Record<string, string>;
  /** Ruling 460: `file` is the agent launcher, whose hard kill is SIGUSR2. */
  launched: boolean;
  /** Ruling 507: the account home the binary acts on. */
  accountHome: string;
}

/**
 * Ruling 460: a vendor binary run for one person outside a run — the hosted
 * sign-in, its confirmation, the sign-out — runs as that person's own OS user
 * through the launcher, exactly like their runs, so every file it writes into
 * their home is theirs (and, once the launcher has handed the backend home
 * back after it exits, readable by the server's group). Off (no launcher), it
 * is the binary on `vendorSpawnEnv`, as before. Throws the launch's
 * `run_unavailable` AppError when the person's home cannot be prepared.
 *
 * Ruling 507: it acts on ONE account's home, created here (with its links)
 * when it does not exist yet — a sign-in into a new account starts in an empty
 * home of its own.
 */
export function vendorCommand(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  binary: string,
  account: BackendAccountRef,
  dataRoot?: string,
): VendorCommand {
  const backendHome = ensureUserBackendHome(userId, backend, dataRoot);
  const ensured = ensureBackendAccountHome(userId, backend, account, dataRoot);
  const env = vendorSpawnEnv(backend, ensured.home);
  const agent = agentLaunchFor(db, userId, backendHome, dataRoot, ensured.ownDirs);
  if (!agent) return { file: binary, env, launched: false, accountHome: ensured.home };
  if (agent.home) env.HOME = agent.home;
  return {
    file: agent.launcher,
    env: launchEnv(agent, resolveExecutable(binary, env.PATH), env),
    launched: true,
    accountHome: ensured.home,
  };
}

const LOGOUT_ARGS = {
  claude: ["auth", "logout"],
  codex: ["logout"],
} as const;

/**
 * Ask the vendor's own binary to revoke the sign-in one account holds.
 *
 * argv only, never a shell; the child gets `vendorSpawnEnv` (every
 * credential-shaped variable stripped, plus the one home variable, pointed at
 * THIS account's home), so a logout cannot reach any credential but the one it
 * is revoking. Never throws: a failed or missing logout must not stop the
 * disconnect — the credential FILE is removed either way, which is what makes
 * the account unusable from this server.
 */
async function runVendorLogout(
  db: DatabaseSync,
  row: BackendCredentialRow,
  binary: string,
  dataRoot?: string,
): Promise<void> {
  try {
    // Ruling 460: as the person's own OS user, like the sign-in that wrote it.
    const command = vendorCommand(db, row.userId, row.backend, binary, accountRef(row), dataRoot);
    await execFileAsync(command.file, [...LOGOUT_ARGS[row.backend]], {
      env: command.env,
      timeout: LOGOUT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    logger.warn("vendor logout did not exit cleanly", {
      backend: row.backend,
      exitCode: execFileRejection.parse(error).code,
    });
  }
}

/**
 * Delete what one account left on disk. An account with a home of its own
 * (ruling 507) loses the whole home — its sign-in and whatever its runs wrote
 * there beside the shared transcripts, which the home only LINKS to (a removal
 * unlinks a link; it never descends into it) — removed as the person, because
 * their agents wrote it (ruling 485). An account connected before the ruling
 * lives in the backend home itself, which also holds the person's transcripts
 * and their other accounts, so it loses its credential file and nothing else.
 * Never throws: a disconnect after a volume wipe is still a disconnect.
 */
async function removeAccountFiles(
  db: DatabaseSync,
  row: BackendCredentialRow,
  dataRoot?: string,
): Promise<void> {
  const home = backendAccountHome(row.userId, row.backend, accountRef(row), dataRoot);
  try {
    if (row.legacyHome) {
      if (row.kind === "login") rmSync(vendorLoginCredentialPath(row.backend, home), { force: true });
      return;
    }
    await removeAgentTree(home, agentGitLaunchFor(db, row.userId, dataRoot));
  } catch (error) {
    logger.warn("could not remove a disconnected account's files", {
      backend: row.backend,
      accountId: row.id,
      err: toError(error),
    });
  }
}

/** What retiring ONE account needs from its caller: the binary of THAT vendor,
 *  when this deployment has it. Per backend rather than the pair, so a host
 *  missing one vendor's optional package still runs the other vendor's logout
 *  (`backendBinaryIfPresent`). */
interface VendorDeps {
  binary?: string;
  dataRoot?: string;
}

/**
 * Retire one account: a `login` account is logged out at the vendor and its
 * files deleted FIRST, the row after — leaving a live sign-in file behind
 * would leave a credential on this server that no row accounts for, which the
 * next `runCredentialFor` could bill if the row came back, and which the
 * person could never reach again to revoke.
 */
async function retireAccount(
  db: DatabaseSync,
  row: BackendCredentialRow,
  deps: VendorDeps,
): Promise<void> {
  if (row.kind === "login") {
    if (deps.binary) {
      await runVendorLogout(db, row, deps.binary, deps.dataRoot);
    } else {
      // The route hands `backendBinaryIfPresent(backend)` in. Without it the
      // sign-in can still be made unusable here (the file goes), but the
      // vendor-side session is left for the person to revoke — say so rather
      // than implying a revoke happened.
      logger.warn("disconnecting a vendor login without a binary to log out", {
        backend: row.backend,
      });
    }
  }
  await removeAccountFiles(db, row, deps.dataRoot);
  db.prepare(`DELETE FROM user_backend_credentials WHERE id = ?`).run(row.id);
}

/**
 * Ruling 165, carried into ruling 507: the account that bills the next run on
 * this backend is about to change — a connect, a switch, the active account's
 * removal — so the refusals and the reading Viberr observed on the one that
 * billed until now go. A spent window or a rejected credential is evidence
 * about the account that was billed, and the next one is not that account;
 * left standing, the Profile card kept "usage window spent · reopens 21:30"
 * over a freshly connected account whose runs were going through, and the
 * dispatch hold parked the new account until the old one's instant. Switching
 * BACK to a spent account retires it too: one refused run re-records the
 * window, which is cheaper than a notice that lies about the other account.
 */
function activeAccountChanged(db: DatabaseSync, userId: string, backend: RealBackend): void {
  retireBackendRecordsFor(db, backend, userId);
}

/** Refuse a new account once the person holds the ceiling on this backend. */
function assertRoomForAnotherAccount(db: DatabaseSync, userId: string, backend: RealBackend): void {
  if (listBackendAccounts(db, userId, backend).length >= MAX_ACCOUNTS_PER_BACKEND) {
    throw AppError.validation(
      `You already have ${MAX_ACCOUNTS_PER_BACKEND} ${BACKEND_LABEL[backend]} accounts connected. ` +
        "Disconnect one before adding another.",
    );
  }
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
}

/**
 * The paste path: verify a pasted key against the provider, then seal it as
 * a NEW account of this person's on that backend, which becomes the active
 * one. Whatever was connected before stays connected (ruling 507): the person
 * switches back to it on the same card, with no sign-in.
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
  // Before the provider is asked anything: a refusal that is ours to make
  // costs nobody a network round trip.
  assertRoomForAnotherAccount(db, actor.userId, backend);
  const verifiedAt =
    kind === "access_token"
      ? null
      : await verifyKeyWithProvider(backend, value, deps.fetchImpl ?? fetch);
  const detail: Record<string, string> =
    kind === "access_token" ? { verification: "unverified" } : {};
  // Again after the probe: another connect may have landed while the provider
  // answered, and from here to the insert nothing awaits, so the ceiling holds.
  assertRoomForAnotherAccount(db, actor.userId, backend);

  const id = newId("ubc");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO user_backend_credentials
       (id, user_id, backend, kind, method, secret_box, secret_suffix,
        detail_json, verified_at, selected_at, legacy_home, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    actor.userId,
    backend,
    kind,
    sealSecret(value),
    value.slice(-4),
    JSON.stringify(detail),
    verifiedAt,
    selectionStamp(db, actor.userId, backend),
    now,
    now,
  );
  activeAccountChanged(db, actor.userId, backend);
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
  const row = getBackendAccount(db, actor.userId, id);
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
      `That ${noun} contains a space or line break; copy it again.`,
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
 * Where a hosted sign-in writes (ruling 507): the account it will become, and
 * whether that account already exists. A sign-in for a NEW account runs in an
 * empty home of its own, minted before the vendor process starts; signing an
 * existing `login` account in again (its file went missing, or its vendor
 * session was revoked) runs in that account's own home and updates its row.
 */
export interface LoginTarget extends BackendAccountRef {
  existing: boolean;
}

/**
 * The account a sign-in will record, decided BEFORE the vendor process starts,
 * because the process needs its home. With `accountId`, the person's existing
 * `login` account on this backend is signed in again; without it, a new account
 * is minted — refused once the person holds the ceiling, so the refusal comes
 * before any process runs.
 */
export function loginTargetFor(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  accountId?: string,
): LoginTarget {
  if (accountId === undefined) {
    assertRoomForAnotherAccount(db, userId, backend);
    return { id: newId("ubc"), legacyHome: false, existing: false };
  }
  const row = getBackendAccount(db, userId, accountId);
  if (!row || row.backend !== backend) {
    throw AppError.validation(`That ${BACKEND_LABEL[backend]} account isn't connected any more.`);
  }
  if (row.kind !== "login") {
    throw AppError.validation(
      `That ${BACKEND_LABEL[backend]} account is a pasted ${row.kind === "access_token" ? "access token" : "API key"}, ` +
        "not a sign-in. Add a new account to sign in.",
    );
  }
  return { id: row.id, legacyHome: row.legacyHome, existing: true };
}

/**
 * Called by the sign-in driver the moment the vendor binary reports success:
 * records the `login` account (no secret — the binary owns the credential in
 * the account's home) as the person's ACTIVE account on this backend, and
 * retires the refusal Viberr observed on the one that was active (ruling 165).
 * Every other account the person holds stays connected (ruling 507).
 *
 * A new account is inserted with the id its home was minted under; an account
 * signed in again keeps its id and home and has its vendor facts refreshed.
 * Synchronous, and never runs a vendor logout: the binary has just written a
 * fresh credential, and nothing else is being replaced.
 */
export function recordBackendLogin(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  backend: RealBackend,
  method: LoginMethod,
  detail: Record<string, string>,
  target: LoginTarget,
): BackendCredentialRow {
  const now = new Date().toISOString();
  const selectedAt = selectionStamp(db, actor.userId, backend);
  const facts = JSON.stringify(trimDetail(detail));
  const stored = target.existing && getBackendAccount(db, actor.userId, target.id) !== null;
  if (stored) {
    db.prepare(
      `UPDATE user_backend_credentials
          SET method = ?, detail_json = ?, verified_at = ?, selected_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ?`,
    ).run(method, facts, now, selectedAt, now, target.id, actor.userId);
  } else {
    db.prepare(
      `INSERT INTO user_backend_credentials
         (id, user_id, backend, kind, method, secret_box, secret_suffix,
          detail_json, verified_at, selected_at, legacy_home, created_at, updated_at)
       VALUES (?, ?, ?, 'login', ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
    ).run(
      target.id,
      actor.userId,
      backend,
      method,
      facts,
      now,
      selectedAt,
      target.legacyHome ? 1 : 0,
      now,
      now,
    );
  }
  recordAudit(db, {
    action: "profile.backend.connected",
    actor,
    subjectKind: "backend_credential",
    subjectId: target.id,
    details: { backend, kind: "login", method, signedInAgain: stored },
  });
  logger.info("personal backend sign-in recorded", {
    backend,
    method,
    userId: actor.userId,
  });
  activeAccountChanged(db, actor.userId, backend);
  const row = getBackendAccount(db, actor.userId, target.id);
  if (!row) throw AppError.internal(`backend credential ${target.id} vanished after insert`);
  return row;
}

/**
 * Ruling 507: make one of the person's accounts the one their runs bill.
 *
 * No vendor process runs and no file moves — the account's sign-in has sat in
 * its own home since it was connected — so switching takes effect for the next
 * run that starts, and a run already going keeps the account it started on.
 * Refused, with a sentence, for an account that is not the person's, one that
 * is already active, and one whose sign-in this server no longer holds (a run
 * on it could only fail; the card offers its sign-in instead).
 */
export function switchBackendAccount(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  accountId: string,
  env: UserBackendHealthEnv = {},
): BackendCredentialRow {
  const row = getBackendAccount(db, actor.userId, accountId);
  if (!row) throw AppError.validation("That account isn't connected any more.");
  const label = BACKEND_LABEL[row.backend];
  const active = getBackendCredential(db, actor.userId, row.backend);
  if (active?.id === row.id) {
    throw AppError.validation(`${backendAccountName(row)} is already the ${label} account in use.`);
  }
  const health = backendAccountHealth(row, env);
  if (!health.available) {
    throw AppError.validation(
      `${backendAccountName(row)} can't be used yet: ${health.detail ?? "its credential is not usable."}`,
    );
  }
  db.prepare(
    `UPDATE user_backend_credentials SET selected_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(
    selectionStamp(db, actor.userId, row.backend),
    new Date().toISOString(),
    row.id,
    actor.userId,
  );
  activeAccountChanged(db, actor.userId, row.backend);
  recordAudit(db, {
    action: "profile.backend.switched",
    actor,
    subjectKind: "backend_credential",
    subjectId: row.id,
    details: { backend: row.backend, kind: row.kind, from: active?.id ?? null },
  });
  logger.info("personal backend account switched", {
    backend: row.backend,
    userId: actor.userId,
  });
  const switched = getBackendAccount(db, actor.userId, row.id);
  if (!switched) throw AppError.internal(`backend credential ${row.id} vanished after a switch`);
  return switched;
}

/**
 * Ruling 507: give an account the person's own name, or clear it (an empty
 * name) so it is named by its vendor facts again. A name is display only: it
 * decides nothing about which account runs bill.
 */
export function renameBackendAccount(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  accountId: string,
  name: string,
): BackendCredentialRow {
  const row = getBackendAccount(db, actor.userId, accountId);
  if (!row) throw AppError.validation("That account isn't connected any more.");
  const label = name.trim().replace(/\s+/g, " ");
  if (label.length > MAX_ACCOUNT_LABEL_LEN) {
    throw AppError.validation(`An account name can be at most ${MAX_ACCOUNT_LABEL_LEN} characters.`);
  }
  db.prepare(
    `UPDATE user_backend_credentials SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(label || null, new Date().toISOString(), row.id, actor.userId);
  recordAudit(db, {
    action: "profile.backend.renamed",
    actor,
    subjectKind: "backend_credential",
    subjectId: row.id,
    details: { backend: row.backend, named: label !== "" },
  });
  const renamed = getBackendAccount(db, actor.userId, row.id);
  if (!renamed) throw AppError.internal(`backend credential ${row.id} vanished after a rename`);
  return renamed;
}

export interface DisconnectBackendDeps {
  /** This backend's binary, when the deployment has it: the vendor's own
   *  logout runs with it, and without it only the local half happens. */
  binary?: string;
  dataRoot?: string;
}

/** What a disconnect reports back: the account that went, and the account
 *  runs bill now (null when it was the person's last on the backend). */
export interface DisconnectedAccount {
  removed: BackendCredentialRow;
  wasActive: boolean;
  active: BackendCredentialRow | null;
}

/**
 * Disconnect ONE of the acting person's accounts (ruling 507): log its vendor
 * sign-in out (login accounts), remove its files, drop the row. Transcripts
 * stay — they are the record of what the agents did, not a credential, and
 * they live in the backend home the account only linked to. Removing the
 * active account hands runs back to the account used before it, and retires
 * the refusals observed on the removed one (ruling 165); removing any other
 * changes nothing about which account runs bill.
 *
 * Refuses when the account is not the person's (or is already gone) instead
 * of succeeding silently, so the UI can toast the truth.
 */
export async function disconnectBackendAccount(
  db: DatabaseSync,
  actor: BackendCredentialActor,
  accountId: string,
  deps: DisconnectBackendDeps = {},
): Promise<DisconnectedAccount> {
  const row = getBackendAccount(db, actor.userId, accountId);
  if (!row) throw AppError.validation("That account isn't connected any more.");
  const wasActive = getBackendCredential(db, actor.userId, row.backend)?.id === row.id;
  await retireAccount(db, row, deps);
  if (wasActive) activeAccountChanged(db, actor.userId, row.backend);
  recordAudit(db, {
    action: "profile.backend.disconnected",
    actor,
    subjectKind: "backend_credential",
    subjectId: row.id,
    details: { backend: row.backend, kind: row.kind, wasActive },
  });
  logger.info("personal backend credential disconnected", {
    backend: row.backend,
    kind: row.kind,
    userId: actor.userId,
  });
  return { removed: row, wasActive, active: getBackendCredential(db, actor.userId, row.backend) };
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
 * `retireAccount` exists to prevent: a working credential on this server that
 * no row accounts for, that the person can never again reach
 * `disconnectBackendAccount` to revoke, and that every backup taken with the
 * runtime volume copies forward. So the vendor logout runs and the file goes
 * BEFORE the row does.
 *
 * Transcripts stay. They are the run record, not a credential (the same line
 * `disconnectBackendAccount` draws), and the retention sweep is what ages them
 * out.
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
  // Every account on both backends (ruling 507), not only the active ones: an
  // inactive account's sign-in is as live a credential as the active one's.
  const connected = listBackendCredentials(db, userId);
  if (connected.length === 0) return [];
  for (const row of connected) {
    // Resolved HERE, not by the caller: account removal is org administration
    // and has no business knowing about vendor packages, and there is no UI on
    // that path to report a missing optional dependency to. Per backend and
    // only for a `login` row, so retiring an account whose credentials are
    // pasted keys never reaches for a binary at all, and a host missing ONE
    // vendor's package still logs the OTHER one out.
    const vendorDeps: VendorDeps = {};
    const binary =
      deps.binaries?.[row.backend] ??
      (row.kind === "login" ? await vendorBinaryIfPresent(row.backend) : undefined);
    if (binary) vendorDeps.binary = binary;
    if (deps.dataRoot !== undefined) vendorDeps.dataRoot = deps.dataRoot;
    await retireAccount(db, row, vendorDeps);
  }
  const backends = [...new Set(connected.map((row) => row.backend))];
  // Ruling 165: the records naming this person go with their accounts.
  for (const backend of backends) activeAccountChanged(db, userId, backend);
  logger.info("personal backend credentials retired with the account", {
    userId,
    backends: backends.join(","),
    accounts: connected.length,
  });
  return backends;
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
 *  Agents page, the controller and the run service all read. Since ruling 507
 *  it is the health of the person's ACTIVE account on the backend, the one a
 *  run would bill; {@link backendAccountHealth} answers for any one account. */
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
  /** Ruling 507: the account this answers for, and how it is named to the
   *  person; null when nothing is connected. */
  accountId: string | null;
  accountName: string | null;
}

export interface UserBackendHealthEnv {
  platform?: NodeJS.Platform;
  dataRoot?: string;
}

/**
 * Whether ONE account can bill a run right now (ruling 507's per-account half
 * of {@link userBackendHealth}). Re-probed on every call, never cached, from
 * the account's own home: a wiped runtime volume must read as "sign in again"
 * the moment it happens, and a fresh sign-in must count without a restart.
 */
export function backendAccountHealth(
  row: BackendCredentialRow,
  env: UserBackendHealthEnv = {},
): UserBackendHealth {
  const label = BACKEND_LABEL[row.backend];
  const base = {
    backend: row.backend,
    userId: row.userId,
    kind: row.kind,
    method: row.method,
    secretSuffix: row.secretSuffix,
    verifiedAt: row.verifiedAt,
    connectedAt: row.createdAt,
    accountId: row.id,
    accountName: backendAccountName(row),
  };
  if (row.kind !== "login") {
    // A sealed key is usable by definition — nothing on disk has to survive for
    // it to work. (A box the current encryption key cannot open is a rotation
    // accident, and `runCredentialFor` names that precisely at spawn time
    // rather than making every loader pay a decryption to find out.)
    return { ...base, available: true, verification: "credential", detail: null };
  }
  const home = backendAccountHome(row.userId, row.backend, accountRef(row), env.dataRoot);
  if (pathExists(vendorLoginCredentialPath(row.backend, home))) {
    return { ...base, available: true, verification: "file", detail: null };
  }
  if (
    row.backend === "claude" &&
    (env.platform ?? process.platform) === "darwin" &&
    pathExists(home)
  ) {
    // On macOS the Claude client keeps its sign-in in the login Keychain, which
    // a server-side probe cannot read without popping an unlock dialog. The
    // home exists, so the binary HAS run here: honour the sign-in and report
    // the weaker verification rather than hiding it. Codex signs in to its
    // `auth.json` alone, and a run copies only that file into its home, so a
    // Codex home without it cannot run on any platform.
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

export function userBackendHealth(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): UserBackendHealth {
  const [row, ...others] = listBackendAccounts(db, userId, backend);
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
      accountId: null,
      accountName: null,
    };
  }
  const health = backendAccountHealth(row, env);
  if (health.available) return health;
  // Ruling 507: there is no fallback — a run bills the active account or none
  // (ruling 127) — but the person may hold one that works, and the sentence
  // every refusal quotes should say so rather than send them to a sign-in.
  const usable = others.some((other) => backendAccountHealth(other, env).available);
  return usable
    ? {
        ...health,
        detail: `${health.detail ?? ""} Another of your ${label} accounts is connected there: switching to it needs no sign-in.`.trim(),
      }
    : health;
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
 *  instance-level number that replaced "is the backend configured". A person
 *  counts once however many accounts they keep, and by their ACTIVE one
 *  (ruling 507): that is the account a run of theirs would bill. */
export function connectedUserIds(
  db: DatabaseSync,
  backend: RealBackend,
  env: UserBackendHealthEnv = {},
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT user_id FROM user_backend_credentials
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
  /** The person's backend home: what the launcher prepares and hands back
   *  after every launched process (ruling 460). Shared by all their accounts. */
  homeDir: string;
  /** Ruling 507: the account this run bills — the person's active one when the
   *  credential was resolved — and its own vendor home. A Claude run gets the
   *  account home as `CLAUDE_CONFIG_DIR`; a Codex run's private home takes the
   *  account's `auth.json` from it (the adapter's fork, ruling 181). */
  accountId: string;
  accountHome: string;
  /** Ruling 460 + 507: the directories the launch must hand to the person's
   *  uid besides the backend home (the account home and what it links to). */
  ownDirs: string[];
}

export function runCredentialFor(
  db: DatabaseSync,
  userId: string,
  backend: RealBackend,
  dataRoot?: string,
): RunCredential {
  const health = userBackendHealth(db, userId, backend, { dataRoot });
  // The account `health` answered for, re-read by its id: the one that was
  // active when the health was judged, even if a switch lands in between.
  const row =
    health.available && health.accountId
      ? getBackendAccount(db, userId, health.accountId)
      : null;
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
  const account = ensureBackendAccountHome(userId, backend, accountRef(row), dataRoot);
  // Claude reads its sign-in from its config dir, so the run is pointed at the
  // account's own home (whose `projects/` links to the shared transcripts).
  // Codex keeps the SHARED home here: its adapter forks a private home from
  // it for every run and copies the sign-in from `accountHome` (ruling 181).
  const env = { [HOME_ENV_KEY[backend]]: backend === "claude" ? account.home : homeDir };
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
  return {
    env,
    secrets,
    kind: row.kind,
    homeDir,
    accountId: row.id,
    accountHome: account.home,
    ownDirs: account.ownDirs,
  };
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
      err: toError(error),
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
