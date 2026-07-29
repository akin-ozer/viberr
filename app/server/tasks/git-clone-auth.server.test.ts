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
  CLONE_TIMEOUT_MS,
  cloneFailureLogDetails,
  cloneFailureSentence,
  createGitHubClonePlan,
  githubRemoteSanitizationArgs,
} from "./git-clone-auth.server";

describe("createGitHubClonePlan", () => {
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
      expect(
        execFileSync(askpassPath, ["Username for 'https://github.com':"], {
          encoding: "utf8",
          env: plan.env,
        }).trim(),
      ).toBe("x-access-token");
      expect(
        execFileSync(askpassPath, ["Password for 'https://github.com':"], {
          encoding: "utf8",
          env: plan.env,
        }).trim(),
      ).toBe(token);
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
  it("never copies credential-bearing child-process diagnostics into logs", () => {
    const token = "github_pat_DO_NOT_LEAK_456";
    const error = Object.assign(
      new Error(`fatal: authentication failed for https://x-access-token:${token}@github.com/acme/repo.git`),
      {
        code: 128,
        stderr: `remote rejected ${token}`,
        cmd: `git clone https://x-access-token:${token}@github.com/acme/repo.git`,
      },
    );

    const details = cloneFailureLogDetails(error);
    expect(details).toEqual({ reason: "clone_failed", exitCode: 128 });
    expect(JSON.stringify(details)).not.toContain(token);
  });
});

describe("clone timeout + failure sentence", () => {
  it("gives a clone far more than the old 60s — that ceiling was a bet on repo size", () => {
    // Viberr's own repo needs ~71s for `--depth 1` (55 MB working tree, most of
    // it screenshots). At 60s the clone was SIGTERM'd on a healthy project with a
    // probe-verified credential, and every downstream signal blamed the
    // credential. A shallow clone is bounded by repo size and link speed; this
    // ceiling exists to stop a HUNG clone, not to cap how big a repo may be.
    expect(CLONE_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
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
    );
    expect(
      cloneFailureSentence(details, { hadCredential: true }),
    ).not.toContain(token);
  });
});
