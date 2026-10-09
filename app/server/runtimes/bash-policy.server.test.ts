import { describe, expect, it } from "vitest";
import { bashDenyPrefixes, deniedPrefixFor } from "./bash-policy.server";

/**
 * Ruling 219(a), amended by Option D PR 5: the normalizer behind the Claude
 * PreToolUse hook. Measured live (2026-09-11), the pinned CLI's own deny rules
 * already stopped `cd . && git push` and `true; git push`, and let
 * `git -C . push` and `sh -c 'git push'` through. Each shape the plan names has
 * a case, and each near-miss that must NOT match has one too.
 */
const PREFIXES = ["git push", "git commit", "gh pr create", "gh pr merge", "git checkout -b"];
const denied = (command: string) => deniedPrefixFor(command, PREFIXES);

describe("bashDenyPrefixes", () => {
  it("reads the prefixes out of the run's `Bash(<prefix>:*)` rules and nothing else", () => {
    expect(
      bashDenyPrefixes(["Edit", "Bash(git push:*)", "WebFetch", "Bash(gh pr create:*)", "Bash(git push:*)"]),
    ).toEqual(["git push", "gh pr create"]);
    expect(bashDenyPrefixes(["Bash", "Edit"])).toEqual([]);
  });
});

describe("deniedPrefixFor — the shapes a prefix rule misses", () => {
  it.each([
    ["git -C . push origin HEAD:refs/heads/x", "git push"],
    ["git -C /work/repo -c core.hooksPath=/dev/null push", "git push"],
    ["git --git-dir=.git --work-tree . push", "git push"],
    ["sh -c 'git push origin main'", "git push"],
    ['bash -lc "cd repo && git push"', "git push"],
    ["cd repo && git push", "git push"],
    ["true; git push", "git push"],
    ["false || git push", "git push"],
    ["echo go | xargs -n 1 git push origin", "git push"],
    ["GIT_TRACE=1 git push", "git push"],
    ["env -i HOME=/tmp git push", "git push"],
    ["/usr/bin/git push", "git push"],
    ["timeout 60 git push", "git push"],
    ["echo $(git push)", "git push"],
    ["echo `git commit -m x`", "git commit"],
    ["eval 'git push'", "git push"],
    ["(git push)", "git push"],
    ["{ git push; }", "git push"],
    ["git add . && git commit -m 'wip' && git push", "git commit"],
    ["gh pr create --fill", "gh pr create"],
    ["git checkout -b feature", "git checkout -b"],
  ])("%s → %s", (command, prefix) => {
    expect(denied(command)).toBe(prefix);
  });

  it.each([
    "git status",
    "git push-mirror-docs",
    "echo 'git push'",
    'echo "see git push"',
    "grep -r 'gh pr create' docs",
    "git log --grep=push",
    "npm test 2>&1 | tail -5",
    // `>& git` sends the output to a file named git; the command is `echo done push`.
    "echo done >& git push",
    "git checkout main",
  ])("%s is not a denied command", (command) => {
    expect(denied(command)).toBeNull();
  });
});
