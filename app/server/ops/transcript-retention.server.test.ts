import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { ensureDataRootDirs } from "~/server/files/file-store-root.server";
import {
  DEFAULT_SESSION_HOME_RETENTION_DAYS,
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  pruneRuntimeTranscripts,
  sessionHomeRetentionDays,
  transcriptRetentionDays,
} from "./transcript-retention.server";

/**
 * Gap 20 — the raw `.jsonl` truth under `runtimes/` was pruned by nothing but
 * `npm run seed -- --reset`. `run_log_lines` disappears at 30 days while the
 * file it projected lived forever, so "run logs are kept 30 days" was true of
 * the console and false of the disk.
 */

const ctx = createTestDbContext();
afterEach(() => {
  delete process.env.VIBERR_TRANSCRIPT_RETENTION_DAYS;
  delete process.env.VIBERR_SESSION_HOME_RETENTION_DAYS;
  ctx.cleanup();
});

const DAY = 86_400_000;

function ageFile(file: string, daysAgo: number): void {
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(file, when, when);
}

function writeAged(file: string, body: string, daysAgo: number): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  ageFile(file, daysAgo);
  return file;
}

function makeRoot(): string {
  const dataRoot = ctx.makeTempDir();
  ensureDataRootDirs(dataRoot);
  return dataRoot;
}

describe("pruneRuntimeTranscripts (gap 20)", () => {
  it("removes run transcripts past the window and keeps recent ones", () => {
    const root = makeRoot();
    const old = writeAged(
      path.join(root, "runtimes", "claude", "run_old.jsonl"),
      '{"a":1}\n'.repeat(50),
      DEFAULT_TRANSCRIPT_RETENTION_DAYS + 5,
    );
    const recent = writeAged(
      path.join(root, "runtimes", "codex", "run_recent.jsonl"),
      '{"a":1}\n',
      2,
    );

    const result = pruneRuntimeTranscripts({ dataRoot: root });
    expect(result.transcripts).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("prunes the app-owned provider session homes too", () => {
    const root = makeRoot();
    const claudeSession = writeAged(
      path.join(
        root,
        "runtimes",
        "claude-home",
        "projects",
        "-data-projects-p-tasks-VIB-1-workspace",
        "sess-old.jsonl",
      ),
      "{}\n",
      DEFAULT_SESSION_HOME_RETENTION_DAYS + 1,
    );
    const codexRollout = writeAged(
      path.join(
        root,
        "runtimes",
        "codex-home",
        "sessions",
        "2026",
        "01",
        "02",
        "rollout-2026-01-02T03-04-05-abc.jsonl",
      ),
      "{}\n",
      DEFAULT_SESSION_HOME_RETENTION_DAYS + 1,
    );
    const fresh = writeAged(
      path.join(
        root,
        "runtimes",
        "codex-home",
        "sessions",
        "2026",
        "08",
        "07",
        "rollout-live.jsonl",
      ),
      "{}\n",
      0,
    );

    const result = pruneRuntimeTranscripts({ dataRoot: root });
    expect(result.sessions).toBe(2);
    expect(existsSync(claudeSession)).toBe(false);
    expect(existsSync(codexRollout)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // The emptied date directories go with them.
    expect(
      existsSync(path.join(root, "runtimes", "codex-home", "sessions", "2026", "01")),
    ).toBe(false);
  });

  it("NEVER deletes a credential or config file, only *.jsonl (P11-04)", () => {
    const root = makeRoot();
    const auth = path.join(root, "runtimes", "codex-home", "auth.json");
    writeAged(auth, '{"token":"x"}', 400);
    const claudeConfig = path.join(root, "runtimes", "claude-home", ".credentials.json");
    writeAged(claudeConfig, "{}", 400);
    const configToml = path.join(root, "runtimes", "codex-home", "config.toml");
    writeAged(configToml, "model = 'x'", 400);

    pruneRuntimeTranscripts({ dataRoot: root });

    expect(existsSync(auth)).toBe(true);
    expect(existsSync(claudeConfig)).toBe(true);
    expect(existsSync(configToml)).toBe(true);
  });

  it("collects the orphans a deleted project left behind (no DB row names them)", () => {
    const root = makeRoot();
    // deleteProject removes projects/<slug> and the run rows' project, but has
    // never touched the transcripts — age is the only handle left on them.
    const orphan = writeAged(
      path.join(root, "runtimes", "claude", "run_of_deleted_project.jsonl"),
      "{}\n",
      DEFAULT_TRANSCRIPT_RETENTION_DAYS + 90,
    );
    expect(pruneRuntimeTranscripts({ dataRoot: root }).transcripts).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it("is configurable, and 0 disables a half outright", () => {
    process.env.VIBERR_TRANSCRIPT_RETENTION_DAYS = "7";
    process.env.VIBERR_SESSION_HOME_RETENTION_DAYS = "0";
    expect(transcriptRetentionDays()).toBe(7);
    expect(sessionHomeRetentionDays()).toBe(0);

    const root = makeRoot();
    const transcript = writeAged(
      path.join(root, "runtimes", "claude", "run_10d.jsonl"),
      "{}\n",
      10,
    );
    const session = writeAged(
      path.join(root, "runtimes", "claude-home", "projects", "p", "s.jsonl"),
      "{}\n",
      400,
    );

    const result = pruneRuntimeTranscripts({ dataRoot: root });
    expect(result.transcripts).toBe(1);
    expect(result.sessions).toBe(0);
    expect(existsSync(transcript)).toBe(false);
    expect(existsSync(session)).toBe(true);
  });

  it("is idempotent and never throws on a store with no runtimes dir", () => {
    const bare = ctx.makeTempDir();
    expect(pruneRuntimeTranscripts({ dataRoot: bare })).toEqual({
      transcripts: 0,
      sessions: 0,
      bytes: 0,
    });
    const root = makeRoot();
    writeAged(
      path.join(root, "runtimes", "claude", "old.jsonl"),
      "{}\n",
      DEFAULT_TRANSCRIPT_RETENTION_DAYS + 1,
    );
    expect(pruneRuntimeTranscripts({ dataRoot: root }).transcripts).toBe(1);
    expect(pruneRuntimeTranscripts({ dataRoot: root }).transcripts).toBe(0);
  });
});
