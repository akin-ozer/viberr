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
  codexRolloutRunStats,
  sessionContextTokens,
} from "./session-export.server";
import { userBackendHome } from "./user-homes.server";

/**
 * Session export: locate a provider transcript by session id (robust to the
 * cwd->folder encoding) and build the self-contained resume installer.
 */

let tmp: string;
/** Ruling 127: transcripts live in the credential PRINCIPAL's own runtime home,
 *  so every lookup names the person whose run wrote it. Two people here, so a
 *  probe that ignored the principal would be visible. */
const OWNER = "u_owner";
const OTHER = "u_other";

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

const savedDataRoot = process.env.VIBERR_DATA_ROOT;

beforeEach(() => {
  // A fresh, EMPTY data root per test: "no transcript store at all" is a state
  // several cases assert on, and an ambient data root a developer's `.env`
  // supplies would silently answer `missing` where they want `unknown`. Each
  // person's homes are created only when a test writes into them.
  tmp = mkdtempSync(path.join(os.tmpdir(), "viberr-export-"));
  process.env.VIBERR_DATA_ROOT = path.join(tmp, "data-root");
  resetEnvCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedDataRoot === undefined) delete process.env.VIBERR_DATA_ROOT;
  else process.env.VIBERR_DATA_ROOT = savedDataRoot;
  resetEnvCacheForTests();
});

/** One person's claude/codex home under the test data root. */
function home(userId: string, backend: "claude" | "codex"): string {
  return userBackendHome(userId, backend);
}

/** Write a Claude session transcript into `userId`'s home, at the encoded-cwd
 *  project dir. */
function writeClaudeSession(
  sid: string,
  cwd: string,
  lines: object[],
  userId = OWNER,
): string {
  const dir = path.join(home(userId, "claude"), "projects", encode(cwd));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** A dated codex rollout dir inside `userId`'s codex home. */
function codexDir(day: string, userId = OWNER): string {
  const dir = path.join(home(userId, "codex"), "sessions", "2026", "07", day);
  mkdirSync(dir, { recursive: true });
  return dir;
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
    const found = locateTranscript("claude", OWNER, sid);
    expect(found).not.toBeNull();
    expect(found!.sessionId).toBe(sid);
    expect(found!.cwd).toBe(cwd);
    expect(found!.lineCount).toBe(3);
    expect(found!.filePath.endsWith(`${sid}.jsonl`)).toBe(true);
  });

  it("returns null when no transcript exists for the id", () => {
    expect(locateTranscript("claude", OWNER, "does-not-exist")).toBeNull();
    expect(locateTranscript("claude", OWNER, "")).toBeNull();
  });

  it("never reaches into another person's home, and has none for a null principal", () => {
    // Ruling 127: a session id names a conversation inside ONE person's
    // account. Searching every home for it would hand somebody else's
    // transcript to whoever could name the id — and a run refused before it
    // started (`credential_user_id` null) wrote no transcript at all.
    writeClaudeSession(sid, cwd, [{ type: "queue-operation", sessionId: sid }], OTHER);
    expect(locateTranscript("claude", OWNER, sid)).toBeNull();
    expect(locateTranscript("claude", null, sid)).toBeNull();
    expect(locateTranscript("claude", OTHER, sid)).not.toBeNull();
  });
});

describe("locateTranscript (codex)", () => {
  const sid = "0199a2c4-7b31-7802-abcd-000000000001";

  it("finds a rollout file whose name embeds the session id, under dated dirs", () => {
    const dir = codexDir("05");
    const file = path.join(dir, `rollout-2026-07-05T12-00-00-${sid}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/work/repo" } }) + "\n");
    const found = locateTranscript("codex", OWNER, sid);
    expect(found).not.toBeNull();
    expect(found!.filePath).toBe(file);
    expect(found!.cwd).toBe("/work/repo");
  });

  it("returns null when the sessions dir has no matching rollout", () => {
    expect(locateTranscript("codex", OWNER, sid)).toBeNull();
  });
});

describe("transcriptExists (loader-path probe)", () => {
  it("claude: true only when the sid transcript file exists", () => {
    const sid = "aaaa1111-ae14-41da-a8d9-f8c48b800605";
    expect(transcriptExists("claude", OWNER, "missing-claude-sid")).toBe(false);
    expect(transcriptExists("claude", OWNER, "")).toBe(false);
    writeClaudeSession(sid, "/w/x", [{ type: "queue-operation", sessionId: sid }]);
    expect(transcriptExists("claude", OWNER, sid)).toBe(true);
  });

  it("codex: matches by FILENAME only — a content-only id is a conservative miss", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ee01";
    const dir = codexDir("06");
    writeFileSync(
      path.join(dir, `rollout-2026-07-06T12-00-00-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n",
    );
    expect(transcriptExists("codex", OWNER, sid)).toBe(true);

    // An id present ONLY inside file content (not the filename) is skipped by
    // the probe (no file reads on a loader path) — the full locator still
    // finds it for the one-shot export route.
    const contentOnly = "0199a2c4-7b31-7802-abcd-00000000ee02";
    writeFileSync(
      path.join(dir, "rollout-2026-07-06T13-00-00-unrelated.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: contentOnly } }) + "\n",
    );
    expect(transcriptExists("codex", OWNER, contentOnly)).toBe(false);
    expect(locateTranscript("codex", OWNER, contentOnly)).not.toBeNull();
  });

  it("caches within the TTL: a hit stays true after the file is deleted", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ee03";
    const dir = codexDir("07");
    const file = path.join(dir, `rollout-2026-07-07T12-00-00-${sid}.jsonl`);
    writeFileSync(file, "{}\n");
    expect(transcriptExists("codex", OWNER, sid)).toBe(true);
    rmSync(file);
    expect(transcriptExists("codex", OWNER, sid)).toBe(true); // served from the cache
  });
});

/* ------------------- resume-time continuity probe (P13-D-2) ------------------ */

describe("probeSessionContinuity", () => {
  it("claude: unknown with no transcript store, present/missing once there is one", () => {
    const sid = "bbbb2222-ae14-41da-a8d9-f8c48b800605";
    // No `<config>/projects` dir at all → absence proves NOTHING. Answering
    // "missing" here would throw away every live session on any deployment
    // whose transcripts this process cannot see.
    expect(probeSessionContinuity("claude", OWNER, sid)).toBe("unknown");

    writeClaudeSession(sid, "/w/x", [{ type: "queue-operation", sessionId: sid }]);
    expect(probeSessionContinuity("claude", OWNER, sid)).toBe("present");
    // The store exists and does not hold this id → genuinely swept.
    expect(probeSessionContinuity("claude", OWNER, "never-existed")).toBe("missing");
  });

  it("codex: finds a rollout by CONTENT too — a filename miss is not a dead session", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ff01";
    expect(probeSessionContinuity("codex", OWNER, sid)).toBe("unknown"); // no sessions dir

    const dir = codexDir("08");
    writeFileSync(
      path.join(dir, `rollout-2026-07-08T12-00-00-${sid}.jsonl`),
      JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n",
    );
    expect(probeSessionContinuity("codex", OWNER, sid)).toBe("present");
    expect(probeSessionContinuity("codex", OWNER, "0199-nope")).toBe("missing");

    // `transcriptExists` (the loader-path Export probe) matches by FILENAME
    // only, so a content-only id reads as a conservative miss there. Doing that
    // here would discard a LIVE session's context, so the resume probe uses the
    // full locator.
    const contentOnly = "0199a2c4-7b31-7802-abcd-00000000ff02";
    writeFileSync(
      path.join(dir, "rollout-2026-07-08T13-00-00-anon.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: contentOnly } }) + "\n",
    );
    expect(transcriptExists("codex", OWNER, contentOnly)).toBe(false);
    expect(probeSessionContinuity("codex", OWNER, contentOnly)).toBe("present");
  });

  it("is uncached — a transcript deleted after a hit reads as missing at once", () => {
    const sid = "0199a2c4-7b31-7802-abcd-00000000ff03";
    const dir = codexDir("09");
    const file = path.join(dir, `rollout-2026-07-09T12-00-00-${sid}.jsonl`);
    writeFileSync(file, "{}\n");
    expect(probeSessionContinuity("codex", OWNER, sid)).toBe("present");
    rmSync(file);
    // `transcriptExists` would still say true here (30 s TTL) — a stale `true`
    // is exactly the dead id this probe exists to catch.
    expect(probeSessionContinuity("codex", OWNER, sid)).toBe("missing");
  });

  it("treats a null/empty session id as unknown, never missing", () => {
    expect(probeSessionContinuity("claude", OWNER, null)).toBe("unknown");
    expect(probeSessionContinuity("codex", OWNER, "")).toBe("unknown");
  });

  it("an owner change reads as MISSING — the resume never enters the old owner's account", () => {
    // Ruling 127, stated as behaviour: a resumed task run bills the owner AS OF
    // NOW, and the probe looks in THAT person's home. So a task whose seat
    // changed hands since the original run reports the session gone and takes
    // the continuity-reset path (one fresh run, re-anchored on task.md, with
    // the timeline saying context was lost) — rather than replaying one
    // person's conversation inside another person's account.
    const sid = "cccc3333-ae14-41da-a8d9-f8c48b800605";
    writeClaudeSession(sid, "/w/x", [{ type: "queue-operation", sessionId: sid }], OTHER);
    expect(probeSessionContinuity("claude", OTHER, sid)).toBe("present");
    // The new owner HAS a store (they run agents too) and it does not hold it.
    writeClaudeSession("their-own-session", "/w/x", [{}], OWNER);
    expect(probeSessionContinuity("claude", OWNER, sid)).toBe("missing");
  });

  it("a run with no principal probes nothing — there is no home to look in", () => {
    writeClaudeSession("orphan-sid", "/w/x", [{}], OWNER);
    expect(probeSessionContinuity("claude", null, "orphan-sid")).toBe("unknown");
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
    const located = locateTranscript("claude", OWNER, sid)!;
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

  it("scrubs a provider credential the transcript captured, and stays parseable", () => {
    // The run sink redacts Viberr's own .jsonl and the console (P13-U-1), but
    // this bundle embedded the VENDOR's transcript verbatim — the sibling
    // channel that bypassed it. One `env`-printing tool call puts the run's
    // credential in there, and since ruling 127 that is somebody's PERSONAL
    // key, while any member of the run's project can download this file.
    // Canary: drop the `redact(...)` around the readFileSync and the token
    // below comes back in the decoded payload.
    const leaked = `sk-ant-api03-${"x".repeat(40)}`;
    const lines = [
      { type: "assistant", sessionId: sid, cwd, message: { role: "assistant", content: `ANTHROPIC_API_KEY=${leaked}` } },
    ];
    writeClaudeSession(sid, cwd, lines);
    const located = locateTranscript("claude", OWNER, sid)!;
    const { body } = buildResumeScript(located, { taskKey: "CTL-1" });

    const decoded = decodeEmbedded(body);
    expect(decoded, "the credential must not ride the download").not.toContain(leaked);
    // Still a usable transcript: every line parses, and the envelope around
    // the redacted value is intact so `claude --resume` can read it.
    // SAFETY: every line written by `writeClaudeSession` above is a JSON
    // object carrying a string `type`, and redaction only shortens string
    // VALUES (the marker has no quote or backslash), so the shape is unchanged.
    const parsed = decoded
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { type: string });
    expect(parsed.map((l) => l.type)).toEqual(["assistant"]);
  });

  it("codex: keeps the rollout filename and prints `codex resume`", () => {
    const dir = codexDir("05");
    const origName = `rollout-2026-07-05T12-00-00-${sid}.jsonl`;
    writeFileSync(path.join(dir, origName), JSON.stringify({ type: "session_meta", payload: { id: sid } }) + "\n");
    const located = locateTranscript("codex", OWNER, sid)!;
    const { body } = buildResumeScript(located, { taskKey: "CTL-1" });
    expect(body).toContain('BACKEND="codex"');
    expect(body).toContain(`ORIG_NAME="${origName}"`);
    expect(body).toContain("codex resume $SID");
    expect(body).toContain("sessions/imported");
  });
});

/**
 * Rulings 369 and 372: the size a resume would replay, read off the provider's
 * own transcript, and a Codex run's per-call figures read off its rollout.
 */
describe("sessionContextTokens and codexRolloutRunStats", () => {
  const usage = (input: number, write: number, read: number) => ({
    input_tokens: input,
    cache_creation_input_tokens: write,
    cache_read_input_tokens: read,
  });

  it("claude: the LAST main-loop assistant line's whole prompt; a sidechain line after it does not count", () => {
    const sid = "0f0f0f0f-aaaa-4bbb-8ccc-000000000001";
    writeClaudeSession(sid, "/w/x", [
      { type: "user", message: { role: "user", content: "go" } },
      { type: "assistant", isSidechain: false, message: { usage: usage(2, 100, 0) } },
      { type: "assistant", isSidechain: false, message: { usage: usage(2, 500, 180_000) } },
      // A subagent's line lands last in the file and is not the session's context.
      { type: "assistant", isSidechain: true, message: { usage: usage(2, 5, 5) } },
    ]);
    expect(sessionContextTokens("claude", OWNER, sid)).toBe(180_502);
  });

  it("claude: null with no transcript, no usage, or no principal", () => {
    const sid = "0f0f0f0f-aaaa-4bbb-8ccc-000000000002";
    expect(sessionContextTokens("claude", OWNER, sid)).toBeNull();
    writeClaudeSession(sid, "/w/x", [{ type: "user", message: { role: "user", content: "go" } }]);
    expect(sessionContextTokens("claude", OWNER, sid)).toBeNull();
    expect(sessionContextTokens("claude", null, sid)).toBeNull();
  });

  it("codex: the rollout's last token_count carries the last call's prompt; the run window bounds the stats", () => {
    const sid = "01a0a30a-e256-7c91-b8da-6093b9f8424c";
    const dir = codexDir("15");
    const line = (ts: string, input: number, type = "token_count") =>
      JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload:
          type === "token_count"
            ? { type, info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0 } } }
            : { type },
      });
    writeFileSync(
      path.join(dir, `rollout-2026-07-15T03-09-54-${sid}.jsonl`),
      [
        JSON.stringify({ timestamp: "2026-07-15T03:09:54.000Z", type: "session_meta", payload: { id: sid } }),
        line("2026-07-15T03:10:00.000Z", 21_825),
        line("2026-07-15T03:10:30.000Z", 44_000),
        // A second run on the same thread, an hour later.
        line("2026-07-15T04:10:00.000Z", 50_000),
        line("2026-07-15T04:10:05.000Z", 0, "context_compacted"),
        line("2026-07-15T04:11:00.000Z", 12_000),
      ].join("\n") + "\n",
    );
    expect(sessionContextTokens("codex", OWNER, sid)).toBe(12_000);
    expect(codexRolloutRunStats(OWNER, sid, "2026-07-15T04:00:00.000Z")).toEqual({
      peakPromptTokens: 50_000,
      lastPromptTokens: 12_000,
      compactions: 1,
      calls: 2,
    });
    // The whole thread, when the caller has no start instant.
    expect(codexRolloutRunStats(OWNER, sid, null)).toMatchObject({ peakPromptTokens: 50_000, calls: 4 });
    expect(codexRolloutRunStats(OWNER, "0000-missing", null)).toBeNull();
  });
});
