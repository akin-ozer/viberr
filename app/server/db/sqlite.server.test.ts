import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
import { DATA_ROOT_LOCK_FILENAME, isProcessAlive } from "./data-root-lock.server";
import {
  closeDb,
  copyStorePair,
  ensureBaselineColumns,
  getDb,
  getProjectionDbPath,
  isDatabaseShuttingDown,
  openDatabase,
  openDatabaseReadOnly,
  READER_SNAPSHOT_DIR,
  readWalIdentity,
  shutdownDatabase,
} from "./sqlite.server";

describe("ensureBaselineColumns (pass 32 C02-R11; ruling 121 controller tables)", () => {
  it("adds every baseline column a pre-existing root lacks, idempotently", () => {
    // A data root that applied 0001 BEFORE the columns existed never re-runs
    // the file (migrations stay squashed pre-prod), and `patchRun` naming a
    // missing column would fail every agent completion on that root. The
    // backstop applies the boot WARN's own remedy (ALTER TABLE … ADD COLUMN).
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-runrow-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE agent_runs (id TEXT PRIMARY KEY, outcome_key TEXT)`,
      );
      const columns = () =>
        // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
        (db.prepare(`PRAGMA table_info(agent_runs)`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      expect(columns()).toEqual(["id", "outcome_key"]);
      ensureBaselineColumns(db);
      expect(columns()).toEqual([
        "id",
        "outcome_key",
        "dispatched_by_name",
        "dispatched_by_user_id",
        // Ruling 127: `upsertRun` names the credential principal on every
        // insert, so a root without this column could not start a run at all.
        "credential_user_id",
        // Pass 35 U35-7: boot recovery writes the reason on every orphan sweep.
        "interrupted_reason",
        // F35-1: the sink patches it on every persisted line.
        "usage_final",
        // Ruling 248: `patchRun` names it on every completion registration.
        "no_checkout",
        // Ruling 316: `upsertRun` names it on every insert, so a root without
        // it could not start a run at all — the ruling-127 failure shape.
        "verdict_withheld",
        // Ruling 369: the sink names every one of these on a run's first
        // persisted line, and `upsertRun` names `credential_kind` on every
        // insert — the same failure shape on a root that lacks them.
        "cache_write_tokens",
        "first_call_prompt_tokens",
        "first_call_cache_write",
        "first_call_cache_read",
        "first_call_warm",
        "first_call_miss_reason",
        "cache_ttl_bucket",
        "peak_prompt_tokens",
        "last_prompt_tokens",
        "compactions",
        "credential_kind",
      ]);
      // Second boot: nothing to add, nothing thrown.
      ensureBaselineColumns(db);
      expect(columns()).toHaveLength(20);
      db.prepare(`UPDATE agent_runs SET dispatched_by_name = ? WHERE id = ?`).run("x", "none");

      // F37-71: a task projection from before the recommendation-kinds column.
      // The rebuilder names it on EVERY task write, so a root without it could
      // not project a single task. CANARY: drop the `task_projections` entry
      // from BASELINE_COLUMNS and this reads two columns, not three.
      db.exec(
        `CREATE TABLE task_projections (project_slug TEXT NOT NULL, task_key TEXT NOT NULL)`,
      );
      ensureBaselineColumns(db);
      // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
      const taskColumns = (db.prepare(`PRAGMA table_info(task_projections)`).all() as {
        name: string;
      }[]).map((c) => c.name);
      expect(taskColumns).toEqual([
        "project_slug",
        "task_key",
        "recommendation_kinds",
      ]);

      // Ruling 176: an org MCP registry from before the write-tool columns.
      // `listMcpServers` names both on every Settings render and run mount.
      // Ruling 469: and the OAuth sign-in's sealed and public halves, which
      // every MCP read (`oauth_json`) and the gateway (`oauth_ref`) name.
      db.exec(`CREATE TABLE org_mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
      ensureBaselineColumns(db);
      ensureBaselineColumns(db);
      // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
      const mcpColumns = (db.prepare(`PRAGMA table_info(org_mcp_servers)`).all() as {
        name: string;
      }[]).map((c) => c.name);
      expect(mcpColumns).toEqual([
        "id",
        "name",
        "tool_policy_json",
        "tool_names_json",
        "oauth_ref",
        "oauth_json",
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * F35-1 (pass 35 review). `usage_final` is added with `DEFAULT 0`, and 0
   * means "no provider figure landed for this run" — which the Insights token
   * sums read as "leave this row out". On a root that already has history,
   * SQLite writes that 0 into every existing row, so without a backfill the
   * whole store's token accounting would disappear from the dashboard at the
   * first boot after the upgrade while Runs, Turns and Cost kept counting the
   * same rows. Before the column existed the token columns of a FINISHED run
   * held the provider's own figures, so those rows are healed to 1; a stopped
   * or errored row held the live placeholder, which is not a total, and stays
   * 0. Canary: drop the `backfill` from BASELINE_COLUMNS and the finished row
   * reads 0.
   */
  it("backfills usage_final on the finished runs a pre-column root already holds", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-usagefinal-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      // The agent_runs shape a root carried before F35-1 added the column.
      db.exec(
        `CREATE TABLE agent_runs (
           id TEXT PRIMARY KEY, state TEXT NOT NULL, finished_at TEXT,
           input_tokens INTEGER NOT NULL DEFAULT 0,
           output_tokens INTEGER NOT NULL DEFAULT 0);
         INSERT INTO agent_runs (id, state, finished_at, input_tokens, output_tokens)
           VALUES ('run_done', 'finished', '2026-09-01T10:00:00.000Z', 4000, 900),
                  ('run_cut', 'interrupted', '2026-09-01T11:00:00.000Z', 300, 40),
                  ('run_live', 'running', NULL, 120, 8);`,
      );

      ensureBaselineColumns(db);

      const finals = new Map(
        // SAFETY: the two columns are read straight back from the row above.
        (
          db.prepare(`SELECT id, usage_final FROM agent_runs ORDER BY id`).all() as {
            id: string;
            usage_final: number;
          }[]
        ).map((r) => [r.id, r.usage_final]),
      );
      expect(finals.get("run_done")).toBe(1);
      expect(finals.get("run_cut")).toBe(0);
      expect(finals.get("run_live")).toBe(0);

      // Idempotent: the second boot adds nothing and re-stamps nothing, so a
      // row the sink has since corrected is not overwritten.
      db.prepare(`UPDATE agent_runs SET usage_final = 0 WHERE id = 'run_done'`).run();
      ensureBaselineColumns(db);
      expect(
        // SAFETY: one INTEGER column of one row, named in the statement.
        (db.prepare(`SELECT usage_final FROM agent_runs WHERE id = 'run_done'`).get() as {
          usage_final: number;
        }).usage_final,
      ).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 121 (review G1). The dock's loader names `task_key` on the FIRST
   * signed-in page of every surface, so on a root that applied 0001 before
   * ruling 121 the missing column would 500 that loader and, fetcher errors
   * going to the route's boundary, replace every page with the root error
   * page. Reproduced here against the PRE-121 controller schema.
   */
  it("adds the ruling-121 controller columns and the scope index a pre-121 root lacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ctlrow-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      // The exact shape 0001 created before ruling 121: no task_key, no
      // surface, and only the per-user index.
      db.exec(
        `CREATE TABLE controller_conversations (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_label TEXT NOT NULL,
           project_slug TEXT, title TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT);
         CREATE INDEX idx_controller_conversations__user
           ON controller_conversations (user_id, last_message_at DESC);
         CREATE TABLE controller_messages (
           id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
           author TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, run_id TEXT,
           created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));`,
      );
      const columns = (table: string) =>
        // SAFETY: PRAGMA table_info rows always carry a TEXT `name`.
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      // The failure this backstop exists to prevent, proven first.
      expect(() =>
        db.prepare(`SELECT id FROM controller_conversations WHERE task_key IS NULL`).all(),
      ).toThrow(/task_key/);

      ensureBaselineColumns(db);

      expect(columns("controller_conversations")).toContain("task_key");
      expect(columns("controller_messages")).toContain("surface");
      // SAFETY: sqlite_master rows carry a TEXT `name`; only `name` is read.
      const indexes = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'controller_conversations'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(indexes).toContain("idx_controller_conversations__scope");
      // The reads and writes the dock and the store make now work.
      expect(
        db.prepare(`SELECT id FROM controller_conversations WHERE task_key IS NULL`).all(),
      ).toEqual([]);
      db.prepare(
        `INSERT INTO controller_conversations
           (id, user_id, user_label, project_slug, task_key, title, created_at, updated_at)
         VALUES ('c1', 'u1', 'a@b.dev', 'p', 'VIB-1', '', '2026-09-02', '2026-09-02')`,
      ).run();
      db.prepare(
        `INSERT INTO controller_messages
           (id, conversation_id, seq, author, user_id, text, run_id, surface, created_at)
         VALUES ('m1', 'c1', 1, 'user', 'u1', 'hi', NULL, '/projects/p/board', '2026-09-02')`,
      ).run();
      // Idempotent: a second boot adds nothing and throws nothing.
      ensureBaselineColumns(db);
      expect(columns("controller_conversations").filter((c) => c === "task_key")).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 457: the task page's freshness reads got composite indexes after
   * roots had applied the baseline; boot adds them to an older root.
   */
  it("adds the freshness indexes a pre-457 root lacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-freshidx-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE audit_events (
           id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, actor_user_id TEXT,
           actor_label TEXT NOT NULL, action TEXT NOT NULL, subject_kind TEXT,
           subject_id TEXT, project_slug TEXT, task_key TEXT, details_json TEXT);
         CREATE INDEX idx_audit_events__action ON audit_events (action);
         CREATE TABLE provenance (
           id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL,
           content_hash TEXT, observed_at TEXT NOT NULL, action TEXT NOT NULL,
           details_json TEXT);
         CREATE INDEX idx_provenance__source_path ON provenance (source_path);`,
      );
      ensureBaselineColumns(db);
      // SAFETY: sqlite_master rows carry a TEXT `name`; only `name` is read.
      const indexes = (
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      expect(indexes).toContain("idx_audit_events__task_action");
      expect(indexes).toContain("idx_provenance__path_action");
      // SAFETY: EXPLAIN QUERY PLAN rows always carry a TEXT `detail`.
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT MAX(occurred_at) FROM audit_events
           WHERE action = ? AND project_slug = ? AND task_key = ?`,
        )
        .all("github.reconcile.task", "p", "P-1") as { detail: string }[];
      expect(plan.map((p) => p.detail).join("\n")).toContain(
        "COVERING INDEX idx_audit_events__task_action",
      );
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * O39-d: `seen_seq` says what a conversation's owner has seen. A root that
   * predates it has conversations with replies in them already, and a
   * default of 0 would mark every one a new reply on the first page after
   * the deploy. The healer backfills each to its newest message.
   */
  it("adds seen_seq to an older root with every existing conversation read", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ctlseen-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE controller_conversations (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_label TEXT NOT NULL,
           project_slug TEXT, task_key TEXT, title TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT);
         CREATE TABLE controller_messages (
           id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
           author TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, run_id TEXT,
           surface TEXT, created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));
         INSERT INTO controller_conversations (id, user_id, user_label, title, created_at, updated_at)
           VALUES ('c1', 'u1', 'a@b.dev', '', '2026-09-22', '2026-09-22'),
                  ('c2', 'u1', 'a@b.dev', '', '2026-09-22', '2026-09-22');
         INSERT INTO controller_messages (id, conversation_id, seq, author, user_id, text, created_at)
           VALUES ('m1', 'c1', 1, 'user', 'u1', 'hi', '2026-09-22'),
                  ('m2', 'c1', 2, 'controller', NULL, 'hello', '2026-09-22');`,
      );
      ensureBaselineColumns(db);
      // SAFETY: both columns are selected by name; `seen_seq` is NOT NULL.
      const seen = db
        .prepare(`SELECT id, seen_seq FROM controller_conversations ORDER BY id`)
        .all() as { id: string; seen_seq: number }[];
      // CANARY: drop the backfill and c1's reply reads as new after a deploy.
      expect(seen).toEqual([
        { id: "c1", seen_seq: 2 },
        { id: "c2", seen_seq: 0 },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 480: `repo_scopes_json` holds what each repository proved about a
   * token. Every PAT read names it, so a root that predates it would fail the
   * credential card and every GitHub call's context. NULL is "nothing stored
   * yet", and a second boot adds nothing.
   */
  it("adds repo_scopes_json to an older root's PATs, empty, idempotently", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-patproof-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE github_pats (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, label TEXT NOT NULL,
           encrypted_token TEXT NOT NULL, token_suffix TEXT NOT NULL,
           created_at TEXT NOT NULL, last_validated_at TEXT, validation_json TEXT);
         INSERT INTO github_pats (id, user_id, label, encrypted_token, token_suffix, created_at)
           VALUES ('pat_1', 'u_1', 'connection · akin-ozer', 'v1$x', 'k3ui', '2026-09-20');`,
      );
      ensureBaselineColumns(db);
      ensureBaselineColumns(db);
      // SAFETY: the SELECT names two columns; `repo_scopes_json` is nullable TEXT.
      const rows = db
        .prepare(`SELECT id, repo_scopes_json FROM github_pats`)
        .all() as { id: string; repo_scopes_json: string | null }[];
      // CANARY: drop the `github_pats` entry from BASELINE_COLUMNS and this
      // SELECT fails with "no such column".
      expect(rows).toEqual([{ id: "pat_1", repo_scopes_json: null }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 463: `reach_json` says which repositories a connection's token
   * reaches. Every connection reader names it, so a root that predates it
   * would fail the Instance settings card, the New project dialog and the
   * controller's read. NULL is the truth for an existing connection ("not
   * read yet"), and a second boot adds nothing.
   */
  it("adds reach_json to an older root's connections, unread, idempotently", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-connreach-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE github_connections (
           id TEXT PRIMARY KEY, owner TEXT NOT NULL UNIQUE, pat_id TEXT NOT NULL,
           is_default INTEGER NOT NULL DEFAULT 0, repos_count INTEGER, expires_at TEXT,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         INSERT INTO github_connections (id, owner, pat_id, is_default, repos_count, created_at, updated_at)
           VALUES ('akin-ozer', 'akin-ozer', 'pat_1', 1, 3, '2026-09-20', '2026-09-20');`,
      );
      ensureBaselineColumns(db);
      ensureBaselineColumns(db);
      // SAFETY: the SELECT names two columns; `reach_json` is nullable TEXT.
      const rows = db
        .prepare(`SELECT id, reach_json FROM github_connections`)
        .all() as { id: string; reach_json: string | null }[];
      // CANARY: drop the `github_connections` entry from BASELINE_COLUMNS and
      // this SELECT fails with "no such column".
      expect(rows).toEqual([{ id: "akin-ozer", reach_json: null }]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 465: `reply_to` says which user message a controller row answers.
   * An older root holds replies already, and boot recovery notes every user
   * message no reply names, so a NULL would write a restart note under every
   * old message. The backfill replays the writers' order: a turn's reply
   * (it carries a run) answers the OLDEST waiting message, a run-less note the
   * NEWEST (it was written right after the message it refused), the queued-
   * start failure its head (the rest were dropped, and said so), and a
   * released project's note nothing.
   */
  it("adds reply_to to an older root, linking each old reply the way its writer wrote it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ctlreply-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE controller_conversations (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_label TEXT NOT NULL,
           project_slug TEXT, task_key TEXT, title TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT,
           seen_seq INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE controller_messages (
           id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
           author TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, run_id TEXT,
           surface TEXT, created_at TEXT NOT NULL, UNIQUE (conversation_id, seq));
         INSERT INTO controller_conversations (id, user_id, user_label, created_at, updated_at)
           VALUES ('c1', 'u1', 'a@b.dev', '2026-09-24', '2026-09-24'),
                  ('c2', 'u1', 'a@b.dev', '2026-09-24', '2026-09-24');
         INSERT INTO controller_messages (id, conversation_id, seq, author, user_id, text, run_id, created_at) VALUES
           ('p1', 'c1', 1, 'user', 'u1', 'part 1', NULL, 'x'),
           ('p2', 'c1', 2, 'user', 'u1', 'part 2', NULL, 'x'),
           ('p3', 'c1', 3, 'user', 'u1', 'part 3', NULL, 'x'),
           ('full', 'c1', 4, 'user', 'u1', 'one too many', NULL, 'x'),
           ('rfull', 'c1', 5, 'controller', NULL, 'I could not take that on: the queue is full.', NULL, 'x'),
           ('r1', 'c1', 6, 'controller', NULL, 'reply to part 1', 'run_1', 'x'),
           ('fix', 'c1', 7, 'user', 'u1', 'correction', NULL, 'x'),
           ('r2', 'c1', 8, 'controller', NULL, 'reply to part 2', 'run_2', 'x'),
           ('r3', 'c1', 9, 'controller', NULL, 'reply to part 3', 'run_3', 'x'),
           ('rfix', 'c1', 10, 'controller', NULL, 'reply to the correction', 'run_4', 'x'),
           ('q1', 'c2', 1, 'user', 'u1', 'a', NULL, 'x'),
           ('q2', 'c2', 2, 'user', 'u1', 'b', NULL, 'x'),
           ('q3', 'c2', 3, 'user', 'u1', 'c', NULL, 'x'),
           ('ra', 'c2', 4, 'controller', NULL, 'answer a', 'run_a', 'x'),
           ('fail', 'c2', 5, 'controller', NULL, 'I could not start the queued turn, and I dropped the 1 message you sent after it. Say them again to retry.', NULL, 'x'),
           ('rel', 'c2', 6, 'controller', NULL, 'The project "Web" was deleted, so this conversation is no longer bound to it. Everything above stays on the record.', NULL, 'x');`,
      );
      ensureBaselineColumns(db);
      // SAFETY: both columns are selected by name; `id` is NOT NULL TEXT.
      const links = Object.fromEntries(
        (
          db
            .prepare(`SELECT id, reply_to FROM controller_messages WHERE author = 'controller'`)
            .all() as { id: string; reply_to: string | null }[]
        ).map((r) => [r.id, r.reply_to]),
      );
      // CANARY: drop the backfill and every link is null; take the newest for
      // a run-carrying reply and part 1's reply lands under the correction.
      expect(links).toEqual({
        rfull: "full",
        r1: "p1",
        r2: "p2",
        r3: "p3",
        rfix: "fix",
        // The failure note answers the head it tried (q2); q3 was dropped and
        // stays unanswered, as the note itself said.
        ra: "q1",
        fail: "q2",
        rel: null,
      });
      // Ruling 465 (2026-09-25): and q3 is earlier history, not linked, so
      // boot recovery does not write a restart note under it.
      // SAFETY: the SELECT names one TEXT column.
      const history = db
        .prepare(`SELECT id FROM controller_messages WHERE unlinked_history = 1`)
        .all() as { id: string }[];
      expect(history.map((r) => r.id)).toEqual(["q3"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Ruling 465 (2026-09-25): a root the first backfill already linked (the
   * owner's, deployed 2026-09-24 21:50 UTC) has `reply_to` and lacks
   * `unlinked_history`. Adding that column runs the corrected walk there once,
   * which replaces the links the first one shifted past a lost message.
   */
  it("walks a root the first reply_to backfill already linked once more, when unlinked_history arrives", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ctlrelink-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(
        `CREATE TABLE controller_conversations (
           id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_label TEXT NOT NULL,
           project_slug TEXT, task_key TEXT, title TEXT NOT NULL DEFAULT '',
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_at TEXT,
           seen_seq INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE controller_messages (
           id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
           author TEXT NOT NULL, user_id TEXT, text TEXT NOT NULL, run_id TEXT,
           surface TEXT, created_at TEXT NOT NULL, reply_to TEXT, UNIQUE (conversation_id, seq));
         INSERT INTO controller_conversations (id, user_id, user_label, created_at, updated_at)
           VALUES ('c1', 'u1', 'a@b.dev', '2026-09-20', '2026-09-20');
         INSERT INTO controller_messages (id, conversation_id, seq, author, user_id, text, run_id, reply_to, created_at) VALUES
           ('A', 'c1', 1, 'user', 'u1', 'a', NULL, NULL, '2026-09-20T10:00:00.000Z'),
           ('B', 'c1', 2, 'user', 'u1', 'b', NULL, NULL, '2026-09-20T10:01:00.000Z'),
           ('n1', 'c1', 3, 'controller', NULL, 'This turn was interrupted by a server restart before I could answer. Say it again and I will pick it up.', 'run_1', 'A', '2026-09-20T10:30:00.000Z'),
           ('C', 'c1', 4, 'user', 'u1', 'c', NULL, NULL, '2026-09-20T10:40:00.000Z'),
           ('rC', 'c1', 5, 'controller', NULL, 'answer c', 'run_3', 'B', '2026-09-20T10:41:00.000Z');`,
      );
      ensureBaselineColumns(db);
      // SAFETY: both columns are selected by name; `id` is NOT NULL TEXT.
      const links = Object.fromEntries(
        (
          db
            .prepare(`SELECT id, reply_to FROM controller_messages WHERE author = 'controller'`)
            .all() as { id: string; reply_to: string | null }[]
        ).map((r) => [r.id, r.reply_to]),
      );
      // CANARY: drop `backfillWith` from `unlinked_history` and rC keeps the
      // first backfill's B.
      expect(links).toEqual({ n1: "A", rC: "C" });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * P13-D-43: nothing ever closed the database. `closeDb()` had no non-test
 * caller and no `wal_checkpoint` existed anywhere, so an exited container was
 * observed leaving a 4.1 MB `-wal` and a `-shm` beside a stale
 * `projection.sqlite` — and this file is PRIMARY storage for users, sessions
 * and PATs, none of which a rescan can rebuild.
 *
 * SQLite unlinks both sidecars on a clean close, so their absence is the
 * observable proof the shutdown happened.
 */

let dataRoot: string;
let previousRoot: string | undefined;

beforeEach(() => {
  previousRoot = process.env.VIBERR_DATA_ROOT;
  dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-shutdown-"));
  process.env.VIBERR_DATA_ROOT = dataRoot;
  resetEnvCacheForTests();
  closeDb();
});

afterEach(() => {
  closeDb();
  if (previousRoot === undefined) delete process.env.VIBERR_DATA_ROOT;
  else process.env.VIBERR_DATA_ROOT = previousRoot;
  resetEnvCacheForTests();
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("shutdownDatabase", () => {
  it("checkpoints the WAL and closes, leaving no -wal/-shm behind", () => {
    const db = getDb();
    const dbPath = getProjectionDbPath();
    db.prepare(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('u_1', 'a@b.dev', 'A', 'member', '2026-07-24', '2026-07-24')`,
    ).run();
    // Journal mode is WAL, so the write lives in the sidecar until checkpointed.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    shutdownDatabase();

    expect(db.isOpen).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });

  it("leaves the committed rows durable in the main file", () => {
    const db = getDb();
    const dbPath = getProjectionDbPath();
    db.prepare(
      `INSERT INTO users (id, email, name, role, created_at, updated_at)
       VALUES ('u_keep', 'keep@b.dev', 'Keep', 'admin', '2026-07-24', '2026-07-24')`,
    ).run();
    shutdownDatabase();

    const reopened = openDatabase(dbPath);
    try {
      expect(
        reopened.prepare(`SELECT role FROM users WHERE id = 'u_keep'`).get(),
      ).toEqual({ role: "admin" });
    } finally {
      reopened.close();
    }
  });

  /**
   * F21-24 (live, UC-31 — `docker restart` mid-run): SIGTERM closed sqlite, and
   * then an in-flight request took `getDb`'s lazy-open branch and logged "sqlite
   * ready" BETWEEN "sqlite closed" and process exit. The drain re-opened the
   * database it had just checkpointed and released, re-ran migrations against
   * it, and left a second handle for a process that was dying — which is exactly
   * what the single-writer story (B-FD1/F18-5) exists to prevent.
   *
   * This test USED to assert the opposite ("forgets the cached handle so the
   * next getDb() reopens"), which is how the behavior survived: the defect was
   * pinned as the contract.
   */
  it("refuses to lazily reopen once the shutdown has closed it", () => {
    const first = getDb();
    shutdownDatabase();
    expect(first.isOpen).toBe(false);
    expect(isDatabaseShuttingDown()).toBe(true);
    expect(() => getDb()).toThrow(/shutting down/i);
    // Twice: the refusal is a latch, not a one-shot.
    expect(() => getDb()).toThrow(/shutting down/i);
  });

  it("latches even when the handle was already closed — a total shutdown path", () => {
    getDb();
    closeDb();
    shutdownDatabase();
    expect(isDatabaseShuttingDown()).toBe(true);
    expect(() => getDb()).toThrow(/shutting down/i);
  });

  it("closeDb clears the latch, so tests (and only tests) can reopen", () => {
    getDb();
    shutdownDatabase();
    closeDb();
    expect(isDatabaseShuttingDown()).toBe(false);
    expect(getDb().isOpen).toBe(true);
  });

  it("is a no-op (never throws) when nothing is open — the shutdown path must be total", () => {
    closeDb();
    expect(() => shutdownDatabase()).not.toThrow();
    expect(() => shutdownDatabase()).not.toThrow();
  });
});

describe("ensureBaselineColumns — baseline TABLES a pre-existing root lacks", () => {
  it("creates user_backend_credentials on a root that predates ruling 127", () => {
    // The healer's own sibling miss: ruling 127 added BOTH the
    // `agent_runs.credential_user_id` column and the `user_backend_credentials`
    // table to the squashed baseline, but only the column was added to the
    // healer's list. 0001 never re-runs, so a root created before that commit
    // booted with the column and WITHOUT the table — and the first read of
    // Profile → Agent accounts, or the first run start, 500s on "no such
    // table". Canary: drop the table from BASELINE_TABLES and this fails.
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-ubc-"));
    try {
      const db = openDatabase(path.join(dir, "old.sqlite"));
      db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO users (id) VALUES (?)`).run("u1");
      const hasTable = () =>
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
          )
          .get("user_backend_credentials") !== undefined;
      expect(hasTable(), "the old root starts without it").toBe(false);
      ensureBaselineColumns(db);
      expect(hasTable(), "the healer must create it").toBe(true);
      // The shape readers actually name, and idempotent on the next boot.
      db.prepare(
        `INSERT INTO user_backend_credentials
           (id, user_id, backend, kind, detail_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("ubc_1", "u1", "claude", "login", "{}", "t", "t");
      ensureBaselineColumns(db);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM user_backend_credentials`).get(),
      ).toEqual({ n: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/**
 * Ruling 158, pass 35 review. A reader copies the database and then its WAL,
 * and nothing used to pin the two: SQLite checkpoints on its own (the writer
 * leaves `wal_autocheckpoint` at its default) and a checkpoint RESETS the log,
 * renumbering frames from 1 under a new salt. A copy taken across that reset
 * applies post-reset frames to a pre-reset main file. Frame checksums do not
 * catch it — they cover a torn tail — and `backup` labels the artefact a
 * consistent point-in-time copy, so the reader has to detect the reset itself.
 */
describe("copyStorePair (ruling 158): the copied pair comes from one moment", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function busyStore() {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "viberr-walpin-")));
    dirs.push(dir);
    const dbPath = path.join(dir, "projection.sqlite");
    const db = openDatabase(dbPath);
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    const insert = db.prepare(`INSERT INTO t (v) VALUES (?)`);
    for (let i = 0; i < 200; i += 1) insert.run("x".repeat(200));
    return { dir, dbPath, db };
  }

  it("the WAL identity is stable while frames are appended and changes when the log is reset", () => {
    const { dbPath, db } = busyStore();
    const wal = `${dbPath}-wal`;
    expect(readWalIdentity(path.join(path.dirname(dbPath), "nothing-here-wal"))).toBeNull();

    const before = readWalIdentity(wal);
    expect(before).not.toBeNull();
    // An ordinary commit only APPENDS frames: the pair stays coherent, so a
    // reader that treated this as a change would retry on every busy root.
    db.prepare(`INSERT INTO t (v) VALUES (?)`).run("appended");
    expect(readWalIdentity(wal)).toBe(before);

    // The event that breaks a copy: the log is reset, then written again.
    db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
    for (let i = 0; i < 50; i += 1) db.prepare(`INSERT INTO t (v) VALUES (?)`).run("y".repeat(200));
    // Canary: without `readWalIdentity` the reader has nothing to compare, and
    // the copy below is taken and used as if it were a snapshot.
    expect(readWalIdentity(wal)).not.toBe(before);
    db.close();
  });

  it("a pair taken across a reset is not a faithful copy, which is why the copy is pinned", () => {
    const { dir, dbPath, db } = busyStore();
    const badDir = path.join(dir, "unpinned");
    mkdirSync(badDir, { recursive: true });
    const bad = path.join(badDir, "projection.sqlite");
    // The old copy order, with the reset landing in the window between them.
    copyFileSync(dbPath, bad);
    db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
    for (let i = 0; i < 50; i += 1) db.prepare(`INSERT INTO t (v) VALUES (?)`).run("y".repeat(200));
    copyFileSync(`${dbPath}-wal`, `${bad}-wal`);
    let faithful: boolean;
    try {
      const opened = openDatabase(bad);
      // SAFETY: one INTEGER column named in the statement.
      const row = opened.prepare(`SELECT count(*) AS n FROM t`).get() as { n: number };
      faithful = row.n === 250;
      opened.close();
    } catch {
      faithful = false;
    }
    expect(faithful).toBe(false);

    // Pinned, with no reset in the window: the copy carries every committed
    // row, the uncheckpointed ones included.
    const goodDir = path.join(dir, "pinned");
    mkdirSync(goodDir, { recursive: true });
    const good = path.join(goodDir, "projection.sqlite");
    copyStorePair(dbPath, good);
    const copy = openDatabase(good);
    // SAFETY: one INTEGER column named in the statement.
    expect((copy.prepare(`SELECT count(*) AS n FROM t`).get() as { n: number }).n).toBe(250);
    copy.close();
    db.close();
  });
});

/**
 * Ruling 158 (pass 35 F35-9): no process but the server opens a live root's
 * `projection.sqlite`. Until this, `openDatabaseReadOnly` opened the live file
 * with `readOnly: true` and the runbook called that the safe form. Live it was
 * not: an in-container `readOnly: true` reader preceded the server's SIGBUS
 * (exit 135) by one second (NOTES 18:40Z), the same exit a host-side reader had
 * produced in pass 34. The mapping of the WAL index is the hazard, not the
 * write, so the reader now copies the database and its WAL beside the store
 * whenever `state/writer.lock` is there AT ALL and opens the COPY. Presence is
 * the whole question (amended in this pass's review): the boot's staleness
 * tests are pid-namespace-local and `compose.yml` pins the hostname, so a
 * reader that reused them would call a live holder in a second container stale
 * and open the live file. Canary: make `openDatabaseReadOnly` open `dbPath` in
 * place under a live lock and both assertions in the first case fail (the file
 * is the live path, the later row is visible); restore the boot's verdict as
 * the reader's rule and the dead-pid case opens the live file too.
 */
describe("openDatabaseReadOnly (ruling 158): a reader never opens a live root", () => {
  interface Root {
    dir: string;
    stateDir: string;
    dbPath: string;
  }

  function root(): Root {
    // Resolved, so SQLite's own report of the opened file compares equal on a
    // macOS temp dir (`/var` is a link to `/private/var`).
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "viberr-reader-")));
    const stateDir = path.join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const dbPath = path.join(stateDir, "projection.sqlite");
    return { dir, stateDir, dbPath };
  }

  /** A writer that is alive by every probe: this very process, on this host. */
  function liveLock(r: Root, pid = process.pid): void {
    writeFileSync(
      path.join(r.stateDir, DATA_ROOT_LOCK_FILENAME),
      JSON.stringify({ pid, hostname: hostname(), startedAt: "2026-09-06T18:00:00.000Z" }),
    );
  }

  /** A pid nothing occupies, so a lock naming it is stale by the boot's own rule. */
  function deadPid(): number {
    for (let pid = 4_194_303; pid > 1; pid -= 1) {
      if (!isProcessAlive(pid)) return pid;
    }
    throw new Error("every pid is alive");
  }

  /** The file the handle really opened, as SQLite reports it. */
  function openedFile(reader: ReturnType<typeof openDatabaseReadOnly>): string {
    // SAFETY: `PRAGMA database_list` yields one row per attached database with
    // a TEXT `file`; the main database is always the first row.
    const rows = reader.db.prepare(`PRAGMA database_list`).all() as { file: string }[];
    return rows[0]!.file;
  }

  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seeded(): Root & { live: ReturnType<typeof openDatabase> } {
    const r = root();
    roots.push(r.dir);
    const live = openDatabase(r.dbPath);
    live.exec(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
    live.prepare(`INSERT INTO users (id) VALUES ('u_before')`).run();
    return { ...r, live };
  }

  it("with a live writer lock, opens a copy under state/tmp/ and never sees a row written after the open", () => {
    const r = seeded();
    liveLock(r);
    // Committed, not checkpointed: the row lives in the -wal beside the file, so
    // a reader that copied only the main file would miss it.
    expect(existsSync(`${r.dbPath}-wal`)).toBe(true);

    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      const file = openedFile(reader);
      expect(file).not.toBe(r.dbPath);
      expect(path.dirname(path.dirname(file))).toBe(path.join(r.stateDir, READER_SNAPSHOT_DIR));
      expect(path.basename(path.dirname(file))).toBe(`reader-${process.pid}`);
      expect(reader.snapshot).not.toBeNull();
      expect(reader.snapshot?.holder?.pid).toBe(process.pid);

      // The copy carries the WAL: what was committed before the open is there.
      expect(reader.db.prepare(`SELECT id FROM users ORDER BY id`).all()).toEqual([
        { id: "u_before" },
      ]);
      // Snapshot semantics: a row the server writes after the open is invisible.
      r.live.prepare(`INSERT INTO users (id) VALUES ('u_after')`).run();
      expect(reader.db.prepare(`SELECT id FROM users ORDER BY id`).all()).toEqual([
        { id: "u_before" },
      ]);
      reader.close();
      // Close removes the copy and, it being the last reader, `state/tmp/`
      // itself: nothing of the reader is left beside the store.
      expect(existsSync(path.join(r.stateDir, READER_SNAPSHOT_DIR))).toBe(false);
      // The reader never touched the live database's own sidecars (the live
      // handle is still open here; its own clean close is what removes them).
      expect(existsSync(`${r.dbPath}-wal`)).toBe(true);
    } finally {
      reader.close();
      r.live.close();
    }
  });

  it("with no lock at all, opens the live file itself, read-only", () => {
    const r = seeded();
    r.live.close();
    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      expect(openedFile(reader)).toBe(r.dbPath);
      expect(reader.path).toBe(r.dbPath);
      expect(reader.snapshot).toBeNull();
      expect(() => reader.db.prepare(`INSERT INTO users (id) VALUES ('x')`).run()).toThrow(
        /readonly/i,
      );
    } finally {
      reader.close();
    }
    expect(existsSync(path.join(r.stateDir, READER_SNAPSHOT_DIR))).toBe(false);
  });

  it("with a lock naming a pid nothing occupies here, still copies: a reader cannot judge liveness across a pid namespace", () => {
    // The boot would call this stale (same host, dead pid) and reclaim it. A
    // READER must not: `compose.yml` pins `hostname: viberr`, so a second
    // container from that file (`docker compose run --rm app npm run backup`)
    // has the app's own hostname and its OWN pid namespace, where the live
    // holder's pid is simply unoccupied. Answering "stale" there opens the live
    // database beside the running server: the second `-shm` mapping ruling 158
    // exists to prevent. A needless copy costs disk; this costs the server.
    const r = seeded();
    const gone = deadPid();
    liveLock(r, gone);
    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      expect(openedFile(reader)).not.toBe(r.dbPath);
      expect(reader.snapshot?.holder?.pid).toBe(gone);
    } finally {
      reader.close();
      r.live.close();
    }
  });

  it("with a lock naming THIS pid at another start time, still copies: the self-pid tie-break is namespace-local too", () => {
    // `classifyLock`'s other staleness test compares `/proc/<self.pid>` start
    // ticks, which across a namespace are never the holder's — two containers
    // over one data root routinely land on the same low pid. Same answer: copy.
    const r = seeded();
    writeFileSync(
      path.join(r.stateDir, DATA_ROOT_LOCK_FILENAME),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        startedAt: "2026-09-06T18:00:00.000Z",
        procStartedAt: 1,
      }),
    );
    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      expect(openedFile(reader)).not.toBe(r.dbPath);
      expect(reader.snapshot).not.toBeNull();
    } finally {
      reader.close();
      r.live.close();
    }
  });

  it("with a lock file it cannot read as a holder, copies first: an unknown holder may be live", () => {
    const r = seeded();
    writeFileSync(path.join(r.stateDir, DATA_ROOT_LOCK_FILENAME), "not json");
    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      expect(openedFile(reader)).not.toBe(r.dbPath);
      expect(reader.snapshot).toEqual({
        dir: path.join(r.stateDir, READER_SNAPSHOT_DIR, `reader-${process.pid}`),
        holder: null,
      });
    } finally {
      reader.close();
      r.live.close();
    }
  });

  it("removes the copy a reader that died mid-read left behind, and leaves a live reader's alone", () => {
    const r = seeded();
    liveLock(r);
    const tmpRoot = path.join(r.stateDir, READER_SNAPSHOT_DIR);
    const dead = path.join(tmpRoot, `reader-${deadPid()}`);
    mkdirSync(dead, { recursive: true });
    writeFileSync(path.join(dead, "projection.sqlite"), "left behind");
    // A directory named for a live pid (a sibling reader mid-read) is not ours to remove.
    const alive = path.join(tmpRoot, "reader-1");
    mkdirSync(alive, { recursive: true });
    const unrelated = path.join(tmpRoot, "not-a-reader");
    mkdirSync(unrelated, { recursive: true });

    const reader = openDatabaseReadOnly(r.dbPath);
    try {
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(alive)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(readdirSync(tmpRoot).sort()).toEqual(
        ["not-a-reader", "reader-1", `reader-${process.pid}`].sort(),
      );
    } finally {
      reader.close();
      r.live.close();
    }
  });
});
