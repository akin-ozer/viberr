import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { logger } from "../logging/logger.server";
import { DEFAULT_MIGRATIONS_DIR } from "./migration-runner.server";

/**
 * Self-healing schema reconciler for added columns.
 *
 * The migration runner records each `*.sql` file by name and never re-runs it.
 * That means EDITING an already-shipped migration (e.g. adding a column to a
 * `CREATE TABLE`) silently never reaches any database that applied the older
 * version of that file — the column is simply missing there. On a file-native
 * app whose SQLite is a rebuildable projection, that manifests as a hard break:
 * the projection rebuild writes the new column and throws
 * `table X has no column named Y` for every row, leaving the app with zero
 * projected rows. (Pass-4 F-MIG1: `projects.archived` was added to
 * `0003_projections.sql` post-hoc; every pre-existing DB lost the whole board.)
 *
 * This runs once after `runMigrations` and closes that gap generically:
 *   - the migration files are the single source of truth for the expected schema;
 *   - for every table that ALREADY EXISTS in the DB, any column the migrations
 *     declare but the live table lacks is added with `ALTER TABLE … ADD COLUMN`.
 *
 * It only ADDS columns to existing tables — it never creates or drops tables
 * (migrations own that) and never touches data. Idempotent: on an
 * up-to-date DB every table matches and nothing is altered.
 */
export function reconcileSchemaFromMigrations(
  db: Database.Database,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): string[] {
  const expected = parseExpectedColumns(migrationsDir);
  const healed: string[] = [];

  for (const [table, columns] of expected) {
    // Only heal tables that already exist — table creation stays with migrations.
    const info = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as Array<{ name: string }>;
    if (info.length === 0) continue;
    const present = new Set(info.map((row) => row.name));

    for (const [column, ddl] of columns) {
      if (present.has(column)) continue;
      db.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${ddl}`);
      healed.push(`${table}.${column}`);
    }
  }

  if (healed.length > 0) {
    logger.warn("schema reconcile added missing columns", { columns: healed });
  }
  return healed;
}

/**
 * table name → (column name → full column DDL), replaying every schema
 * statement in migration order so the map reflects the FINAL schema — later
 * DROP/RENAME operations correct earlier CREATE columns (e.g. 0011 renames
 * `consultants_json` → `reviewers_json`, so we must not re-add the old name).
 */
function parseExpectedColumns(
  migrationsDir: string,
): Map<string, Map<string, string>> {
  const expected = new Map<string, Map<string, string>>();
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = stripSqlComments(
      readFileSync(path.join(migrationsDir, file), "utf8"),
    );
    for (const evt of schemaEvents(sql)) applySchemaEvent(expected, evt);
  }
  return expected;
}

type SchemaEvent =
  | { kind: "create"; table: string; body: string }
  | { kind: "add"; table: string; def: string }
  | { kind: "drop-col"; table: string; column: string }
  | { kind: "rename-col"; table: string; from: string; to: string }
  | { kind: "rename-table"; from: string; to: string }
  | { kind: "drop-table"; table: string };

function applySchemaEvent(
  expected: Map<string, Map<string, string>>,
  evt: SchemaEvent,
): void {
  switch (evt.kind) {
    case "create": {
      const columns = expected.get(evt.table) ?? new Map<string, string>();
      for (const def of splitTopLevel(evt.body)) {
        const trimmed = def.trim();
        if (!trimmed || isTableConstraint(trimmed)) continue;
        const name = columnName(trimmed);
        if (name) columns.set(name, trimmed);
      }
      expected.set(evt.table, columns);
      break;
    }
    case "add": {
      const columns = expected.get(evt.table) ?? new Map<string, string>();
      const name = columnName(evt.def);
      if (name) columns.set(name, evt.def);
      expected.set(evt.table, columns);
      break;
    }
    case "drop-col":
      expected.get(evt.table)?.delete(evt.column);
      break;
    case "rename-col": {
      const columns = expected.get(evt.table);
      const def = columns?.get(evt.from);
      if (columns && def) {
        columns.delete(evt.from);
        // Rewrite the leading identifier in the stored DDL to the new name.
        columns.set(evt.to, def.replace(/^["`]?\w+["`]?/, evt.to));
      }
      break;
    }
    case "rename-table": {
      const columns = expected.get(evt.from);
      if (columns) {
        expected.delete(evt.from);
        expected.set(evt.to, columns);
      }
      break;
    }
    case "drop-table":
      expected.delete(evt.table);
      break;
  }
}

/** All schema-shaping statements in one migration file, in source order. */
function* schemaEvents(sql: string): Generator<SchemaEvent> {
  const events: Array<{ at: number; evt: SchemaEvent }> = [];

  for (const { table, body, at } of eachCreateTable(sql)) {
    events.push({ at, evt: { kind: "create", table, body } });
  }
  const patterns: Array<[RegExp, (m: RegExpExecArray) => SchemaEvent]> = [
    [
      /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?([^;]+);/gi,
      (m) => ({ kind: "add", table: m[1], def: m[2].trim() }),
    ],
    [
      /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+DROP\s+(?:COLUMN\s+)?["`]?(\w+)["`]?/gi,
      (m) => ({ kind: "drop-col", table: m[1], column: m[2] }),
    ],
    [
      /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+COLUMN\s+["`]?(\w+)["`]?\s+TO\s+["`]?(\w+)["`]?/gi,
      (m) => ({ kind: "rename-col", table: m[1], from: m[2], to: m[3] }),
    ],
    [
      /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)["`]?/gi,
      (m) => ({ kind: "rename-table", from: m[1], to: m[2] }),
    ],
    [
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)["`]?/gi,
      (m) => ({ kind: "drop-table", table: m[1] }),
    ],
  ];
  for (const [re, make] of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) events.push({ at: m.index, evt: make(m) });
  }

  events.sort((a, b) => a.at - b.at);
  for (const { evt } of events) yield evt;
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
}

function* eachCreateTable(
  sql: string,
): Generator<{ table: string; body: string; at: number }> {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const open = match.index + match[0].length - 1; // index of the '('
    const close = matchingParen(sql, open);
    if (close < 0) continue;
    yield { table: match[1], body: sql.slice(open + 1, close), at: match.index };
  }
}

/** Index of the ')' matching the '(' at `openIndex`, or -1. */
function matchingParen(sql: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a CREATE TABLE body on top-level commas (ignoring commas in parens). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const TABLE_CONSTRAINT_RE =
  /^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\b/i;

function isTableConstraint(def: string): boolean {
  return TABLE_CONSTRAINT_RE.test(def);
}

function columnName(def: string): string | null {
  const match = def.match(/^["`]?(\w+)["`]?/);
  return match ? match[1] : null;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
