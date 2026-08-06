import { describe, expect, it } from "vitest";
import { gitErrorText, redactGitOutput } from "./git-output-redact.server";

describe("redactGitOutput (F19-6 / F19-18)", () => {
  it("removes the project PAT by value, wherever git echoed it", () => {
    // Deliberately BELOW the shape rule's 16-char floor: only the by-value
    // layer can catch this one, which is the layer the call sites exist to
    // supply (they hold the token at the failure site).
    // Canary: delete the `opts.token` split → the token survives.
    const out = redactGitOutput(
      "remote: Invalid credentials ghp_short\n" +
        "fatal: Authentication failed for 'https://github.com/a/b.git'",
      { token: "ghp_short" },
    );
    expect(out).toContain("Authentication failed");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("ghp_short");
  });

  it("removes a legacy token-bearing origin URL even when the token value is unknown", () => {
    // The one shape a token can reach stderr in without anyone here supplying
    // it: a `remote.origin.url` written by an older Viberr.
    // Canary: remove the URL_USERINFO_RE replace → `x-access-token:` and the
    // userinfo survive (the shape rule alone leaves the username half).
    const out = redactGitOutput(
      "fatal: unable to access 'https://x-access-token:github_pat_11ABCDE_zzzzzzzzzzzzzzzzzzzzzzzz@github.com/a/b.git/'",
    );
    expect(out).toContain("unable to access");
    expect(out).not.toContain("github_pat_");
    expect(out).not.toContain("x-access-token:");
  });

  it("keeps git's diagnosis and never mangles ordinary output", () => {
    // The failure mode that makes surfacing worthless: a redactor that eats the
    // words. Canary: widen TOKEN_SHAPE_SOURCE to an entropy heuristic and the
    // equality below fails.
    const input =
      "remote: error: GH006: Protected branch update failed for refs/heads/vib-7.\n" +
      "remote: error: At least 1 approving review is required by reviewers with write access.\n" +
      "To https://github.com/akin-ozer/viberr.git\n" +
      " ! [remote rejected] vib-7 -> vib-7 (protected branch hook declined)\n" +
      "error: failed to push some refs to 'https://github.com/akin-ozer/viberr.git'";
    const out = redactGitOutput(input, { token: "ghp_realtoken0123456789" });
    expect(out).toContain("GH006");
    expect(out).toContain("Protected branch");
    expect(out).toBe(input);
  });

  it("clamps to the TAIL so a timeline note stays inside the operator's 1500-char snapshot cap", () => {
    // git states its verdict last (and a clone's head is transfer progress), so
    // a clamp that kept the head would drop the only sentence worth reading.
    // Canary: drop the line/char clamp → both size assertions fail; clamp from
    // the head instead → the last-line assertion fails.
    const lines = Array.from(
      { length: 40 },
      (_, i) => `line${String(i).padStart(2, "0")}${"x".repeat(93)}`,
    );
    const out = redactGitOutput(lines.join("\n"));
    expect(out.split("\n").length).toBeLessThanOrEqual(8);
    expect(out.length).toBeLessThanOrEqual(601);
    expect(out).toContain(lines[39]!);
    expect(out).not.toContain(lines[0]!);
  });

  it("treats a bare CR as a line break, so transfer progress cannot spend the whole clamp", () => {
    // `git clone` rewrites one physical line with \r. Splitting on \n only, the
    // whole transfer plus the fatal is a SINGLE 1.4 kB line, so the char clamp
    // has to bite and the reader gets 600 chars of percentages with the verdict
    // glued on the end.
    // Canary: split on /\r?\n/ only → the result is one truncated line, so both
    // assertions below fail.
    const out = redactGitOutput(
      `Cloning into 'viberr'...\r${"Receiving objects:  41% (900/2200)\r".repeat(40)}fatal: the remote end hung up unexpectedly`,
    );
    expect(out).toContain("fatal: the remote end hung up unexpectedly");
    // Nothing had to be truncated, and the verdict is its own line.
    expect(out.startsWith("…")).toBe(false);
    expect(out.split("\n").length).toBeGreaterThan(1);
  });

  it("is empty for empty input", () => {
    // Guards the early return that keeps the no-failure path allocation-free,
    // and the `detail ? {detail} : {}` spreads that depend on "" meaning absent.
    expect(redactGitOutput("")).toBe("");
    expect(redactGitOutput(null)).toBe("");
    expect(redactGitOutput(undefined)).toBe("");
  });
});

describe("gitErrorText", () => {
  it("prefers stderr, falls back to the wrapper message", () => {
    // Canary: swap the precedence → the first assertion reads the argv echo
    // instead of git's own words.
    expect(
      gitErrorText({ stderr: "fatal: x", message: "Command failed: git clone …" }),
    ).toBe("fatal: x");
    expect(gitErrorText({ message: "Command failed: git clone …" })).toBe(
      "Command failed: git clone …",
    );
    expect(gitErrorText({})).toBe("");
    expect(gitErrorText(null)).toBe("");
  });
});
