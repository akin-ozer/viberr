import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import YAML, { YAMLParseError } from "yaml";
import { z } from "zod";
import type { FileDiagnostic } from "~/schemas/file-diagnostics";
import { parseProjectFileContent } from "./project-file.server";
import { parseTaskFileContent } from "./task-file.server";
import {
  getDataRoot,
  projectFilePath,
  projectsDir,
  storeRelativePath,
  taskFilePath,
} from "./file-store-root.server";

/**
 * Store doctor: find canonical files the app can no longer trust, and say
 * WHICH file and WHY (gap 22).
 *
 * The store is designed to be hand-edited (FR10), so a malformed `task.md` is
 * an expected event. What happened before this module: parsing is deliberately
 * tolerant, so a broken file never throws — it projects with DEFAULTS plus a
 * `hardStop` diagnostic. The consequences were all invisible from outside the
 * task page:
 *
 *  - `npm run rescan` printed `0 errors` for it, because `errors` counts
 *    rebuilds that THREW, and a malformed file never throws. Verified live: a
 *    task.md with unparseable frontmatter yields
 *    `{changed: 2, errors: 0}` and a row whose title is the task key and whose
 *    stage is `""`.
 *  - Nothing anywhere listed the untrusted files. The one remedy in the
 *    runbook is "fix the file on disk", with no way to learn which file.
 *
 * This module answers both questions from the FILES ({@link checkStore}, no
 * database needed — it works on a stopped app) and from the projection
 * ({@link untrustedFileReport}, for the rescan CLI). It never writes: a
 * human's file is never silently rewritten. Recovery is
 * `npm run restore -- --file <path> --from <artefact>`, which puts back one
 * file without rolling the SQLite side back with it.
 */

export type StoreFileKind = "project" | "task";

/** Where in the file the problem is, when we can pin it down. */
export interface FileLocation {
  /** 1-based line number in the file. */
  line: number;
  /** A few numbered lines around it, ready to print. */
  excerpt: string;
}

export interface StoreFileCheck {
  /** Store-relative path — the same string the task page shows (ruling 3). */
  path: string;
  absPath: string;
  kind: StoreFileKind;
  /** No `hardStop` finding: the file's own fields were readable. */
  trusted: boolean;
  findings: FileDiagnostic[];
  /** Findings that cost trust (hardStop) — the ones that block a write. */
  blocking: FileDiagnostic[];
  location: FileLocation | null;
  /** Set when the file could not even be READ (permission, not a file, …). */
  readError: string | null;
}

export interface StoreCheckReport {
  dataRoot: string;
  files: StoreFileCheck[];
  /** Files with a `hardStop` finding or a read failure. */
  untrusted: StoreFileCheck[];
  /** Parsed, but with `error`-severity findings (integrity in doubt). */
  degraded: StoreFileCheck[];
  /** The operator-facing report, ready for stdout. */
  text: string;
}

const EXCERPT_CONTEXT_LINES = 2;

function excerptAround(content: string, line: number): FileLocation {
  const lines = content.split("\n");
  const clamped = Math.min(Math.max(line, 1), Math.max(lines.length, 1));
  const from = Math.max(1, clamped - EXCERPT_CONTEXT_LINES);
  const to = Math.min(lines.length, clamped + EXCERPT_CONTEXT_LINES);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n += 1) {
    const marker = n === clamped ? ">" : " ";
    out.push(`${marker} ${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
  }
  return { line: clamped, excerpt: out.join("\n") };
}

/**
 * The YAML parser reports a line/column for a syntax error, but the tolerant
 * frontmatter parser keeps only the message's first line (deliberately — a
 * diagnostic is a sentence, not a stack). Re-run the parse HERE, where the
 * whole file is in hand, purely to recover the position.
 */
function frontmatterErrorLine(content: string): number | null {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  if (!text.startsWith("---\n")) return 1;
  const closeIdx = text.indexOf("\n---", 3);
  if (closeIdx === -1) return 1;
  const yamlText = text.slice(4, closeIdx);
  try {
    YAML.parse(yamlText);
    return null;
  } catch (error) {
    // Only the parser's own error carries a position; anything else that
    // escaped leaves us with no line to point at, so blame the fence.
    const inner =
      error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    // +1: the YAML body starts on the line after the opening `---` fence.
    return inner === undefined ? 1 : inner + 1;
  }
}

/** Several parser messages quote the offending text (`… "### bad heading"`).
 *  Find that line so the report can point at it. */
function quotedSnippetLine(content: string, message: string): number | null {
  const quoted = /"([^"]{3,})"/.exec(message)?.[1];
  if (!quoted) return null;
  const lines = content.split("\n");
  const index = lines.findIndex((line) => line.includes(quoted));
  return index === -1 ? null : index + 1;
}

function locate(
  content: string,
  blocking: FileDiagnostic[],
): FileLocation | null {
  const first = blocking[0];
  if (!first) return null;
  if (first.code.startsWith("frontmatter.")) {
    const line = frontmatterErrorLine(content);
    if (line !== null) return excerptAround(content, line);
    // `frontmatter.missing` / `.unterminated`: the fence itself is the fault.
    return excerptAround(content, 1);
  }
  const quoted = quotedSnippetLine(content, first.message);
  return quoted === null ? null : excerptAround(content, quoted);
}

function checkFile(
  absPath: string,
  kind: StoreFileKind,
  key: string,
  dataRoot: string | undefined,
): StoreFileCheck {
  const rel = storeRelativePath(absPath, dataRoot);
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch (error) {
    return {
      path: rel,
      absPath,
      kind,
      trusted: false,
      findings: [],
      blocking: [],
      location: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
  const { diagnostics } =
    kind === "task"
      ? parseTaskFileContent(content, { fallbackKey: key })
      : parseProjectFileContent(content, { fallbackSlug: key });
  const blocking = diagnostics.filter((d) => d.hardStop === true);
  return {
    path: rel,
    absPath,
    kind,
    trusted: blocking.length === 0,
    findings: diagnostics,
    blocking,
    location: blocking.length > 0 ? locate(content, blocking) : null,
    readError: null,
  };
}

function listDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

/**
 * Parse every canonical file in the store and report the ones the app cannot
 * trust. Read-only, database-free: it runs against a stopped app, and needs no
 * writer lock (see db/cli-lock.server.ts).
 */
export function checkStore(
  options: { dataRoot?: string } = {},
): StoreCheckReport {
  const root = getDataRoot(options.dataRoot);
  const files: StoreFileCheck[] = [];

  for (const slug of listDirNames(projectsDir(options.dataRoot))) {
    const projectFile = projectFilePath(slug, options.dataRoot);
    if (existsSync(projectFile)) {
      files.push(checkFile(projectFile, "project", slug, options.dataRoot));
    }
    const tasksDir = path.join(projectsDir(options.dataRoot), slug, "tasks");
    for (const key of listDirNames(tasksDir)) {
      const taskFile = taskFilePath(slug, key, options.dataRoot);
      if (existsSync(taskFile)) {
        files.push(checkFile(taskFile, "task", key, options.dataRoot));
      }
    }
  }

  const untrusted = files.filter((f) => !f.trusted);
  const degraded = files.filter(
    (f) => f.trusted && f.findings.some((d) => d.severity === "error"),
  );
  return {
    dataRoot: root,
    files,
    untrusted,
    degraded,
    text: renderCheckReport({ dataRoot: root, files, untrusted, degraded }),
  };
}

function renderCheckReport(
  report: Omit<StoreCheckReport, "text">,
): string {
  const lines: string[] = [
    `viberr store check — ${report.files.length} canonical files under ${report.dataRoot}`,
  ];
  if (report.untrusted.length === 0 && report.degraded.length === 0) {
    lines.push("", "Every project.md and task.md parsed cleanly.");
    return lines.join("\n");
  }

  if (report.untrusted.length > 0) {
    lines.push(
      "",
      `${report.untrusted.length} file(s) the app cannot trust — the task is forced to \`blocked\` and the app REFUSES to write to it (a write would replace your content with defaults):`,
    );
    for (const file of report.untrusted) {
      lines.push("", `  ${file.path}`);
      if (file.readError) {
        lines.push(`    unreadable: ${file.readError}`);
        continue;
      }
      for (const finding of file.blocking) {
        lines.push(`    ${finding.code}: ${finding.message}`);
      }
      if (file.location) {
        lines.push(
          ...file.location.excerpt.split("\n").map((line) => `      ${line}`),
        );
      }
    }
  }

  if (report.degraded.length > 0) {
    lines.push(
      "",
      `${report.degraded.length} file(s) parsed with errors (readable, integrity in doubt):`,
    );
    for (const file of report.degraded) {
      const errors = file.findings.filter((d) => d.severity === "error");
      lines.push(`  ${file.path}`);
      for (const finding of errors) {
        lines.push(`    ${finding.code}: ${finding.message}`);
      }
    }
  }

  lines.push(
    "",
    "Fix the file in your editor, or put back the last good copy of that ONE file:",
    "  npm run restore -- --from <backup> --file <path above>",
    "Then re-project it: the watcher does it within ~1s while the app runs, otherwise `npm run rescan`.",
  );
  return lines.join("\n");
}

// ------------------------------------------------- projection-side reporting

export interface UntrustedProjectionFile {
  path: string;
  projectSlug: string | null;
  taskKey: string | null;
  reasons: string[];
}

export interface UntrustedProjectionReport {
  files: UntrustedProjectionFile[];
  text: string;
}

/** The `diagnostics` columns this report reads: `source_path`, `code` and
 *  `message` are TEXT NOT NULL, the two ids are nullable TEXT. */
const untrustedRowSchema = z.object({
  source_path: z.string(),
  project_slug: z.string().nullable(),
  task_key: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

/**
 * The same "which files are untrusted" answer, read from the projection's
 * `diagnostics` table instead of the disk. Used by `npm run rescan`, which has
 * just written those rows and until now reported `0 errors` beside them.
 */
export function untrustedFileReport(
  db: DatabaseSync,
): UntrustedProjectionReport {
  const rows = z.array(untrustedRowSchema).parse(
    db
      .prepare(
        `SELECT source_path, project_slug, task_key, code, message
           FROM diagnostics
          WHERE hard_stop = 1
          ORDER BY source_path, id`,
      )
      .all(),
  );

  const byPath = new Map<string, UntrustedProjectionFile>();
  for (const row of rows) {
    let file = byPath.get(row.source_path);
    if (!file) {
      file = {
        path: row.source_path,
        projectSlug: row.project_slug,
        taskKey: row.task_key,
        reasons: [],
      };
      byPath.set(row.source_path, file);
    }
    file.reasons.push(`${row.code}: ${row.message}`);
  }
  const files = [...byPath.values()];
  if (files.length === 0) return { files, text: "" };

  const lines = [
    `${files.length} file(s) are NOT trusted — parsed with fallback defaults, so their tasks read as \`blocked\` and the app refuses to write to them:`,
  ];
  for (const file of files) {
    lines.push(`  ${file.path}`);
    for (const reason of file.reasons) lines.push(`    ${reason}`);
  }
  lines.push("", "Run `npm run store:check` for the offending lines.");
  return { files, text: lines.join("\n") };
}
