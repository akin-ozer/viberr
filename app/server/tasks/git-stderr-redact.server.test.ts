import { describe, expect, it } from "vitest";
import { redactGitStderr } from "./git-stderr-redact.server";

/**
 * F19-6 / F19-18 — the credential-safe diagnostics channel.
 *
 * Both git failures Viberr surfaces (the workspace clone and the delivery push)
 * used to discard stderr wholesale, so "git exit 128" / "git push returned
 * non-zero" was the entire story a human ever got. These pin the two halves of
 * the replacement rule: the WORDS survive, the SECRET does not.
 */
describe("redactGitStderr", () => {
  const TOKEN = "ghp_livetoken0123456789";

  it("keeps git's complaint and replaces the token literal", () => {
    const out = redactGitStderr(
      {
        stderr:
          "remote: Invalid username or password.\n" +
          `fatal: Authentication failed using ${TOKEN} for 'https://github.com/acme/app.git/'`,
      },
      [TOKEN],
    );
    expect(out).toContain("remote: Invalid username or password.");
    expect(out).toContain("fatal: Authentication failed");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(TOKEN);
  });

  it("scrubs URL userinfo even when the secret is NOT in the scrub list", () => {
    // A legacy origin URL an older Viberr wrote can still carry the PAT, and a
    // caller may not have the token in scope — the pattern is the belt.
    const out = redactGitStderr(
      `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/acme/app.git/': 403`,
    );
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[redacted]@github.com");
    expect(out).toContain("403");
  });

  it("keeps the TAIL when git is verbose — the fatal line is printed last", () => {
    const noise = "hint: something long and useless\n".repeat(80);
    const out = redactGitStderr(`${noise}fatal: repository not found`)!;
    expect(out.length).toBeLessThanOrEqual(501 + 1); // cap + the "…" marker
    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("fatal: repository not found");
  });

  it("falls back to the Error message, and answers undefined when there is nothing", () => {
    expect(redactGitStderr(new Error("spawn git ENOENT"))).toBe("spawn git ENOENT");
    expect(redactGitStderr({ stderr: "   \n  " })).toBeUndefined();
    expect(redactGitStderr(undefined)).toBeUndefined();
    expect(redactGitStderr("")).toBeUndefined();
  });

  it("strips ANSI and control characters — a timeline note is plain text", () => {
    const out = redactGitStderr("\u001b[31mfatal:\u001b[0m bad\u0000 remote\r\n");
    expect(out).toBe("fatal: bad remote");
  });

  it("ignores a too-short scrub value instead of shredding the excerpt", () => {
    // An empty/short "secret" split character-wise would turn the whole excerpt
    // into redaction markers — a fail-open of the diagnostics, not of the secret.
    const out = redactGitStderr("fatal: could not read from remote repository", [
      "",
      "a",
    ]);
    expect(out).toBe("fatal: could not read from remote repository");
  });
});
