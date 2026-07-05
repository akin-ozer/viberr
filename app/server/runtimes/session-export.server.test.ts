import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetEnvCacheForTests } from "../config/env.server";
import { buildResumeScript, locateTranscript } from "./session-export.server";

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
