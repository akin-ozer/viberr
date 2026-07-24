import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetEnvCacheForTests } from "../config/env.server";
import {
  SESSION_MISSING_RE,
  buildResumeScript,
  locateTranscript,
  probeSessionContinuity,
  transcriptExists,
} from "./session-export.server";

/**
 * Session export: locate a provider transcript by session id (robust to the
 * cwd->folder encoding) and build the self-contained resume installer.
 */

let tmp: string;
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
const savedCodex = process.env.CODEX_HOME;

/** Claude encoding: absolute cwd with every non-alphanumeric char -> '-'. */
function encode(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Pull the base64 payload out of a generated script's heredoc + decode it. */
function decodeEmbedded(script: string): string {
  const m = script.match(
    /<<'VIBERR_TRANSCRIPT_B64'\n([\s\S]*?)\nVIBERR_TRANSCRIPT_B64/,
  );
  if (!m) throw new Error("no embedded transcript");
  return Buffer.from(m[1]!.replace(/\n/g, ""), "base64").toString("utf8");
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "viberr-export-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude-home");
  process.env.CODEX_HOME = path.join(tmp, "codex-home");
  resetEnvCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  if (savedCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodex;
  resetEnvCacheForTests();
});

/** Write a Claude session transcript at the encoded-cwd project dir. */
function writeClaudeSession(sid: string, cwd: string, lines: object[]): string {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", encode(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("locateTranscript (claude)", () => {
  const sid = "c5e944e2-ae14-41da-a8d9-f8c48b800605";
  const cwd = "/data/projects/containerless/tasks/CTL-1/workspace/containerless";

  it("finds the transcript by session id regardless of the encoded folder name", () => {
    writeClaudeSession(sid, cwd, [
      { type: "queue-operation", sessionId: sid },
      { type: "user", sessionId: sid, cwd, message: { role: "user" } },
      { type: "assistant", sessionId: sid, message: { role: "assistant" } },
    ]);
    const found = locateTranscript("claude", sid);
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe(sid);
    expect(found!.cwd).toBe(cwd);
    expect(found!.lineCount).toBe(3);
    expect(found!.filePath.endsWith(`${sid}.jsonl`)).toBe(true);
  });

  it("returns null when no transcript exists for the id", () => {
    expect(locateTranscript("claude", "does-not-exist")).toBeNull();
    expect(locateTranscript("claude", "")).toBeNull();
  });
});

describe("locateTranscript (codex)", () => {
  const sid = "0199a2c4-7b31-7802-abcd-000000000001";

  it("finds a rollout file whose name embeds the session id, under dated dirs", () => {
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "05");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-07-05T12-00-00-${sid}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/work/repo" } }) + "\n");
    const found = locateTranscript("codex", sid);
    expect(found).not.toBeNull();
    expect(found!.filePath).toBe(file);
    expect(found!.cwd).toBe("/work/repo");
  });

  it("returns null when the sessions dir has no matching rollout", () => {
    expect(locateTranscript("codex", sid)).toBeNull();
  });
});

describe("transcriptExists (loader-path probe)", () => {
  it("claude: true only when the sid transcript file exists", () => {
    const sid = "aaaa1111-ae14-41da-a8d9-f8c48b800605";
    expect(transcriptExists("claude", "missing-claude-sid")).toBe(false);
    expect(transcriptExists("claude", "")).toBe(false);
    writeClaudeSession(sid, "/w/x", [{ type: "queue-operation", sessionId: sid }]);
    expect(transcriptExists("claude", sid)).toBe(true);
  });

  it("codex: matches by FILENAME only — a content-only id is a conservative miss", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ee01";
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "06");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-07-06T12-00-00-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n",
    );
    expect(transcriptExists("codex", sid)).toBe(true);

    // An id present ONLY inside file content (not the filename) is skipped by
    // the probe (no file reads on a loader path) — the full locator still
    // finds it for the one-shot export route.
    const contentOnly = "0199a2c4-7b31-7802-abcd-00000000ee02";
    writeFileSync(
      path.join(dir, "rollout-2026-07-06T13-00-00-unrelated.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: contentOnly } }) + "\n",
    );
    expect(transcriptExists("codex", contentOnly)).toBe(false);
    expect(locateTranscript("codex", contentOnly)).not.toBeNull();
  });

  it("caches within the TTL: a hit stays true after the file is deleted", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ee03";
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "07");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-07-07T12-00-00-${sid}.jsonl`);
    writeFileSync(file, "{}\n");
    expect(transcriptExists("codex", sid)).toBe(true);
    rmSync(file);
    expect(transcriptExists("codex", sid)).toBe(true); // served from the cache
  });
});

/* ------------------- resume-time continuity probe (P13-D-2) ------------------ */

describe("probeSessionContinuity", () => {
  it("claude: unknown with no transcript store, present/missing once there is one", () => {
    const sid = "bbbb2222-ae14-41da-a8d9-f8c48b800605";
    // No `<config>/projects` dir at all → absence proves NOTHING. Answering
    // "missing" here would throw away every live session on any deployment
    // whose transcripts this process cannot see.
    expect(probeSessionContinuity("claude", sid)).toBe("unknown");

    writeClaudeSession(sid, "/w/x", [{ type: "queue-operation", sessionId: sid }]);
    expect(probeSessionContinuity("claude", sid)).toBe("present");
    // The store exists and does not hold this id → genuinely swept.
    expect(probeSessionContinuity("claude", "never-existed")).toBe("missing");
  });

  it("codex: finds a rollout by CONTENT too — a filename miss is not a dead session", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ff01";
    expect(probeSessionContinuity("codex", sid)).toBe("unknown"); // no sessions dir

    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "08");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `rollout-2026-07-08T12-00-00-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n",
    );
    expect(probeSessionContinuity("codex", sid)).toBe("present");
    expect(probeSessionContinuity("codex", "0199-nope")).toBe("missing");

    // `transcriptExists` (the loader-path Export probe) matches by FILENAME
    // only, so a content-only id reads as a conservative miss there. Doing that
    // here would discard a LIVE session's context, so the resume probe uses the
    // full locator.
    const contentOnly = "0199a2c4-7b31-7802-abcd-00000000ff02";
    writeFileSync(
      path.join(dir, "rollout-2026-07-08T13-00-00-anon.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: contentOnly } }) + "\n",
    );
    expect(transcriptExists("codex", contentOnly)).toBe(false);
    expect(probeSessionContinuity("codex", contentOnly)).toBe("present");
  });

  it("is uncached — a transcript deleted after a hit reads as missing at once", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ff03";
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "09");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-07-09T12-00-00-${sid}.jsonl`);
    writeFileSync(file, "{}\n");
    expect(probeSessionContinuity("codex", sid)).toBe("present");
    rmSync(file);
    // `transcriptExists` would still say true here (30 s TTL) — a stale `true`
    // is exactly the dead id this probe exists to catch.
    expect(probeSessionContinuity("codex", sid)).toBe("missing");
  });

  it("treats a null/empty session id as unknown, never missing", () => {
    expect(probeSessionContinuity("claude", null)).toBe("unknown");
    expect(probeSessionContinuity("codex", "")).toBe("unknown");
  });

  it("SESSION_MISSING_RE matches what the two CLIs actually print", () => {
    expect(SESSION_MISSING_RE.test("No conversation found with session ID 8a1f")).toBe(true);
    expect(SESSION_MISSING_RE.test("Error: session not found: 0199a2c4")).toBe(true);
    expect(SESSION_MISSING_RE.test("rollout not found for id 0199a2c4")).toBe(true);
    // Must NOT swallow the auth/quota classes that come first in the classifiers.
    expect(SESSION_MISSING_RE.test("401 Unauthorized: invalid api key")).toBe(false);
    expect(SESSION_MISSING_RE.test("You've hit your usage limit")).toBe(false);
  });
});

describe("buildResumeScript", () => {
  const sid = "c5e944e2-ae14-41da-a8d9-f8c48b800605";
  const cwd = "/data/projects/containerless/tasks/CTL-1/workspace/containerless";

  it("claude: embeds the transcript verbatim and prints the resume command", () => {
    const lines = [
      { type: "queue-operation", sessionId: sid },
      { type: "assistant", sessionId: sid, cwd, message: { role: "assistant", content: "hi" } },
    ];
    writeClaudeSession(sid, cwd, lines);
    const located = locateTranscript("claude", sid)!;
    const { filename, body } = buildResumeScript(located, { taskKey: "CTL-1" });

    expect(filename).toBe(`resume-CTL-1-${sid.slice(0, 8)}.sh`);
    expect(body).toContain("#!/usr/bin/env bash");
    expect(body).toContain(`SID="${sid}"`);
    expect(body).toContain('BACKEND="claude"');
    // The Claude branch encodes the CURRENT dir and prints the exact command.
    expect(body).toContain("sed 's/[^A-Za-z0-9]/-/g'");
    expect(body).toContain("claude --resume $SID");
    expect(body).toContain(cwd); // origin cwd surfaced in the header
    // The embedded payload decodes back to the exact transcript file.
    const expected = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    expect(decodeEmbedded(body)).toBe(expected);
  });

  it("codex: keeps the rollout filename and prints `codex resume`", () => {
    const dir = path.join(process.env.CODEX_HOME!, "sessions", "2026", "07", "05");
    mkdirSync(dir, { recursive: true });
    const origName = `rollout-2026-07-05T12-00-00-${sid}.jsonl`;
    writeFileSync(path.join(dir, origName), JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n");
    const located = locateTranscript("codex", sid)!;
    const { body } = buildResumeScript(located, { taskKey: "CTL-1" });
    expect(body).toContain('BACKEND="codex"');
    expect(body).toContain(`ORIG_NAME="${origName}"`);
    expect(body).toContain("codex resume $SID");
    expect(body).toContain("sessions/imported");
  });
});
