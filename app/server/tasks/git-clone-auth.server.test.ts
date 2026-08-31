import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cloneTimeoutMs,
  cloneFailureLogDetails,
  cloneFailureSentence,
  createGitHubClonePlan,
  githubRemoteSanitizationArgs,
} from "./git-clone-auth.server";

describe("createGitHubClonePlan", () => {
/**
 * Run the generated askpass program, retrying only the transient exec failures
 * that come from EXECUTING A FILE THIS TEST JUST WROTE while the suite runs
 * many workers in parallel: the kernel can still hold the image busy (ETXTBSY)
 * or refuse a fork under load (EAGAIN). Those say nothing about the program's
 * behavior — but they turned this security assertion red about once per full
 * suite, and a security gate that cries wolf is a security gate someone deletes.
 * Every other failure, including a WRONG answer, propagates on the first try.
 */
function runAskpass(
  askpassPath: string,
  prompt: string,
  env: NodeJS.ProcessEnv,
): string {
  const TRANSIENT = new Set(["ETXTBSY", "EAGAIN", "EBUSY"]);
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(askpassPath, [prompt], { encoding: "utf8", env }).trim();
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= 3 || !TRANSIENT.has(code)) throw error;
    }
  }
}

  it("keeps a GitHub PAT out of argv, the remote URL, and the askpass file", () => {
    const token = "github_pat_DO_NOT_LEAK_123";
    const plan = createGitHubClonePlan({
      repo: "acme/private-repo",
      destination: "/tmp/private-repo",
      token,
      baseEnv: { PATH: process.env.PATH },
    });
    const askpassPath = plan.env.GIT_ASKPASS!;

    try {
      expect(plan.args).toEqual([
        "clone",
        "--depth",
        "1",
        "https://github.com/acme/private-repo.git",
        "/tmp/private-repo",
      ]);
      expect(plan.args.join(" ")).not.toContain(token);
      expect(plan.args.join(" ")).not.toContain("x-access-token@");

      const askpass = readFileSync(askpassPath, "utf8");
      expect(askpass).not.toContain(token);
      expect(statSync(askpassPath).mode & 0o777).toBe(0o700);
      expect(plan.env.VIBERR_GIT_ASKPASS_PASSWORD).toBe(token);
      expect(plan.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
      expect(plan.env.GIT_CONFIG_VALUE_0).toBe("");
      expect(runAskpass(askpassPath, "Username for 'https://github.com':", plan.env)).toBe(
        "x-access-token",
      );
      expect(runAskpass(askpassPath, "Password for 'https://github.com':", plan.env)).toBe(
        token,
      );
    } finally {
      plan.dispose();
    }

    expect(existsSync(askpassPath)).toBe(false);
    expect(plan.env.VIBERR_GIT_ASKPASS_PASSWORD).toBeUndefined();
    expect(plan.env.GIT_ASKPASS).toBeUndefined();
  });

  it("does not reuse ambient askpass credentials when no project PAT exists", () => {
    const plan = createGitHubClonePlan({
      repo: "acme/public-repo",
      destination: "/tmp/public-repo",
      baseEnv: {
        PATH: process.env.PATH,
        GIT_ASKPASS: "/unsafe/inherited-helper",
        SSH_ASKPASS: "/unsafe/inherited-helper",
      },
    });
    try {
      expect(plan.env.GIT_ASKPASS).toBeUndefined();
      expect(plan.env.SSH_ASKPASS).toBeUndefined();
      expect(plan.env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      plan.dispose();
    }
  });

  it("removes a legacy embedded PAT before reusing an existing clone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "viberr-git-clone-test-"));
    const repo = path.join(root, "repo");
    const token = "github_pat_LEGACY_DO_NOT_LEAK";
    try {
      execFileSync("git", ["init", "--quiet", repo]);
      execFileSync("git", [
        "-C",
        repo,
        "config",
        "remote.origin.url",
        `https://x-access-token:${token}@github.com/acme/private-repo.git`,
      ]);

      const args = githubRemoteSanitizationArgs(
        "acme/private-repo",
        repo,
      );
      expect(args.join(" ")).not.toContain(token);
      execFileSync("git", args);

      const stored = execFileSync(
        "git",
        ["-C", repo, "config", "--get-all", "remote.origin.url"],
        { encoding: "utf8" },
      ).trim();
      expect(stored).toBe("https://github.com/acme/private-repo.git");
      expect(readFileSync(path.join(repo, ".git", "config"), "utf8")).not.toContain(token);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cloneFailureLogDetails", () => {
  it("F19-6: carries git's words but never the credential", () => {
    // This used to assert `toEqual({ reason, exitCode })` — that assertion WAS
    // the defect. A live `git exit 128` on VC-3 left exactly those two fields as
    // the only artifact in the whole product: the agent reported blocked, the
    // operator opened an honest blocked packet recommending "hold for infra to
    // investigate", and there was nothing to investigate.
    // Canary: delete the `detail` line from the return object → the
    // "remote rejected" assertion fails.
    const token = "github_pat_DO_NOT_LEAK_456";
    const error = Object.assign(
      new Error(`fatal: authentication failed for https://x-access-token:${token}@github.com/acme/repo.git`),
      {
        code: 128,
        stderr: `remote rejected ${token}`,
        cmd: `git clone https://x-access-token:${token}@github.com/acme/repo.git`,
      },
    );

    const details = cloneFailureLogDetails(error, { token });
    expect(details.reason).toBe("clone_failed");
    expect(details.exitCode).toBe(128);
    expect(details.detail).toContain("remote rejected");
    expect(JSON.stringify(details)).not.toContain(token);
  });

  it("F19-6: scrubs a token it was NOT told about, by shape", () => {
    // Defence in depth for the case the by-value layer cannot cover: a
    // credential nobody here supplied (a legacy origin URL, a PAT the repo's
    // own hooks echoed).
    // Canary: drop TOKEN_SHAPE_SOURCE from redactGitOutput → the token survives.
    const token = "github_pat_11AAAAAAA0aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const details = cloneFailureLogDetails(
      Object.assign(new Error("fatal: clone failed"), {
        code: 128,
        stderr: `remote: Invalid credentials ${token}`,
      }),
    );
    expect(details.detail).toContain("[redacted]");
    expect(details.detail).not.toContain(token);
  });
});

describe("clone timeout + failure sentence", () => {
  it("gives a clone far more than the old 60s — that ceiling was a bet on repo size", () => {
    // Viberr's own repo needs ~71s for `--depth 1` (55 MB working tree, most of
    // it screenshots). At 60s the clone was SIGTERM'd on a healthy project with a
    // probe-verified credential, and every downstream signal blamed the
    // credential. A shallow clone is bounded by repo size and link speed; this
    // ceiling exists to stop a HUNG clone, not to cap how big a repo may be.
    expect(cloneTimeoutMs()).toBeGreaterThanOrEqual(600_000);
  });

  it("a timeout with a working credential says so, in as many words", () => {
    // The whole point: the sentence has to make the wrong conclusion
    // unavailable. "Provision credentials" was the guess that cost a human a
    // debugging session on a credential that was never at fault.
    // Canary: return a generic "clone failed" string for every reason.
    const sentence = cloneFailureSentence(
      { reason: "clone_terminated", signal: "SIGTERM" },
      { hadCredential: true, timeoutMs: 900_000 },
    );
    expect(sentence).toContain("900s");
    expect(sentence).toContain("ran past its time limit");
    expect(sentence).toContain("not a missing-credential problem");
  });

  it("says the opposite when the clone really did run anonymously", () => {
    const sentence = cloneFailureSentence(
      { reason: "clone_failed", exitCode: 128 },
      { hadCredential: false },
    );
    expect(sentence).toContain("No GitHub credential is attached");
    expect(sentence).toContain("git exit 128");
    expect(sentence).not.toContain("not a missing-credential problem");
  });

  it("names a missing git binary as the server's problem, not the repo's", () => {
    expect(
      cloneFailureSentence({ reason: "git_unavailable" }, { hadCredential: true }),
    ).toContain("git is not installed on the Viberr server");
  });

  it("carries no token, whatever the inputs", () => {
    const token = "github_pat_DO_NOT_LEAK_456";
    const details = cloneFailureLogDetails(
      Object.assign(new Error(`fatal: auth failed ${token}`), { code: 128 }),
      { token },
    );
    expect(
      cloneFailureSentence(details, { hadCredential: true }),
    ).not.toContain(token);
    // F19-6: the detail rides its OWN field. The sentence stays one plain
    // sentence because the agent prompt tells the agent to quote it verbatim —
    // folding a stack of `remote:` lines into it would have the agent parrot
    // them back as its blocked reason.
    // Canary: append details.detail into cloneFailureSentence → this fails.
    expect(details.detail).toBeTruthy();
    expect(
      cloneFailureSentence(details, { hadCredential: true }),
    ).not.toContain(details.detail!);
  });
});
