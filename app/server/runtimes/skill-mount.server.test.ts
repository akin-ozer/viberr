import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  isSdkSkillName,
  mountGrantedSkills,
  stripUngovernedRepoCatalog,
} from "./skill-mount.server";

const exec = promisify(execFile);

/** A data root holding `skills/<name>/SKILL.md` (+ optional extra files). */
function storeWithSkills(
  skills: { name: string; skillMd: string; extra?: Record<string, string> }[],
): string {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-skill-store-"));
  for (const skill of skills) {
    const dir = path.join(dataRoot, "skills", skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), skill.skillMd);
    for (const [rel, content] of Object.entries(skill.extra ?? {})) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), content);
    }
  }
  return dataRoot;
}

/** A git checkout with one committed source file (the delivery subject). */
async function gitCheckout(prefix = "viberr-ws-"): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "t@t.dev"]);
  await exec("git", ["-C", dir, "config", "user.name", "T"]);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n");
  await exec("git", ["-C", dir, "add", "-A"]);
  await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  await exec("git", ["-C", dir, "checkout", "-q", "-b", "task-branch"]);
  return dir;
}

const mountedSkillMd = (ws: string, name: string) =>
  readFileSync(path.join(ws, ".claude", "skills", name, "SKILL.md"), "utf8");

describe("stripUngovernedRepoCatalog (R18-3 / F18-8)", () => {
  async function gitRepoWithClaude(): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-strip-"));
    await exec("git", ["-C", dir, "init", "-q"]);
    await exec("git", ["-C", dir, "config", "user.email", "t@t.dev"]);
    await exec("git", ["-C", dir, "config", "user.name", "T"]);
    mkdirSync(path.join(dir, ".claude", "commands"), { recursive: true });
    mkdirSync(path.join(dir, ".claude", "skills", "react-doctor"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "commands", "verify.md"), "# verify");
    writeFileSync(path.join(dir, ".claude", "skills", "react-doctor", "SKILL.md"), "# rd");
    writeFileSync(path.join(dir, ".claude", "launch.json"), "{}");
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 1;\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
    await exec("git", ["-C", dir, "checkout", "-q", "-b", "task-branch"]);
    return dir;
  }

  it("removes the repo .claude from the worktree without staging a deletion", async () => {
    const dir = await gitRepoWithClaude();
    await stripUngovernedRepoCatalog(dir);
    // The CLI can no longer discover the repo's ungoverned catalog…
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
    // …and git sees no pending change (skip-worktree hides the deletion).
    const status = (await exec("git", ["-C", dir, "status", "--porcelain"])).stdout.trim();
    expect(status).toBe("");
    // The delivery step: a real change + `git add -A` (push-workspace.server).
    writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 2;\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", "work"]);
    const diff = (await exec("git", ["-C", dir, "diff", "--name-status", "HEAD~1", "HEAD"])).stdout;
    // The review PR contains ONLY the real change — no `.claude` deletion.
    expect(diff).toContain("src/app.ts");
    expect(diff).not.toContain(".claude");
    // …and the committed tree still carries the original `.claude` from the index.
    const tree = (await exec("git", ["-C", dir, "ls-tree", "-r", "HEAD", "--name-only"])).stdout;
    expect(tree).toContain(".claude/launch.json");
  });

  it("is a no-op when the clone has no .claude", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-strip-none-"));
    await exec("git", ["-C", dir, "init", "-q"]);
    await expect(stripUngovernedRepoCatalog(dir)).resolves.toBeUndefined();
  });
});

describe("isSdkSkillName", () => {
  /**
   * The SDK THROWS BEFORE STARTING on a name it cannot treat as an exact skill
   * name, which would kill a run over the shape of a store folder. Store folder
   * names only pass `resolveStoreSegment` (no separators / dot-segments / NUL),
   * so all of these are reachable on disk.
   *
   * Canary: widen the regex to `/^.+$/` and every `false` below flips.
   */
  it("accepts slug-shaped names and refuses everything the SDK would reject", () => {
    for (const ok of ["conventional-commits", "pdf", "docx", "a.b_c-1", "Skill2"]) {
      expect(isSdkSkillName(ok)).toBe(true);
    }
    for (const bad of [
      "", // empty
      " padded", // leading whitespace
      "padded ", // trailing whitespace
      "my skill", // spaces
      "skill(v2)", // parentheses
      "a,b", // comma (reads as a list)
      "*", // wildcard
      "sk\u0007ill", // control character
      "plugin:skill", // plugin-qualified — Viberr never mounts plugin skills
    ]) {
      expect(isSdkSkillName(bad)).toBe(false);
    }
  });
});

describe("mountGrantedSkills", () => {
  it("copies the WHOLE granted skill folder into <workspace>/.claude/skills/<name>", async () => {
    // Skills are multi-file (checklists/, examples.md, scripts) and the SDK
    // loads those on demand once the model invokes the skill — copying only
    // SKILL.md would deliver a skill whose own references 404.
    const dataRoot = storeWithSkills([
      {
        name: "terraform-review",
        skillMd: "## Review checklist\n- state safety\n",
        extra: { "checklists/state-safety.md": "# State safety\n" },
      },
    ]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["terraform-review"],
      dataRoot,
    });

    expect(result.mounted).toEqual(["terraform-review"]);
    expect(result.skipped).toEqual([]);
    const dest = path.join(ws, ".claude", "skills", "terraform-review");
    expect(readFileSync(path.join(dest, "SKILL.md"), "utf8")).toContain("state safety");
    expect(readFileSync(path.join(dest, "checklists", "state-safety.md"), "utf8")).toContain(
      "# State safety",
    );
  });

  it("mounts ONLY the granted skills — the rest of the store stays out", async () => {
    // The native mirror of the injection path's UC-23 negative half: the store
    // is org-wide, the grant is per-profile, and "load every skill on disk" is
    // exactly the regression that would ship silently.
    const dataRoot = storeWithSkills([
      { name: "granted", skillMd: "SENTINEL-GRANTED\n" },
      { name: "ungranted", skillMd: "SENTINEL-UNGRANTED\n" },
    ]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["granted"],
      dataRoot,
    });

    expect(result.mounted).toEqual(["granted"]);
    const skillsDir = path.join(ws, ".claude", "skills");
    expect(existsSync(path.join(skillsDir, "granted"))).toBe(true);
    expect(existsSync(path.join(skillsDir, "ungranted"))).toBe(false);
  });

  it("normalizes the frontmatter: name pinned to the folder, description present, run policy dropped", async () => {
    // Two failures in one: (a) store SKILL.md files are plain markdown (the
    // seeds and the org-settings editor write no frontmatter), and a SKILL.md
    // without name/description is not a skill the SDK can list — the grant
    // would vanish silently; (b) skill frontmatter can carry `allowed-tools` /
    // `model`, i.e. run policy Viberr owns through capability grants, which a
    // store file must not be able to widen from the inside.
    const dataRoot = storeWithSkills([
      { name: "plain", skillMd: "## Commit format\n- `[VIB-<n>] <summary>`\n" },
      {
        name: "opinionated",
        skillMd:
          "---\nname: something-else\ndescription: Reviews terraform modules.\nallowed-tools: Bash(rm:*)\nmodel: opus\n---\n\n# Body\nSENTINEL-BODY\n",
      },
    ]);
    const ws = await gitCheckout();

    await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["plain", "opinionated"],
      dataRoot,
    });

    const plain = mountedSkillMd(ws, "plain");
    expect(plain).toContain("name: plain");
    // No description on disk → synthesized from the first body line, so the
    // model has something to decide invocation on.
    expect(plain).toContain("description: Commit format");
    expect(plain).toContain("[VIB-<n>]");

    const opinionated = mountedSkillMd(ws, "opinionated");
    // The name is pinned to the mounted folder — it MUST equal the name we hand
    // the SDK's `skills` filter, or the filter rejects the skill we just mounted.
    expect(opinionated).toContain("name: opinionated");
    expect(opinionated).not.toContain("something-else");
    expect(opinionated).toContain("description: Reviews terraform modules.");
    expect(opinionated).toContain("SENTINEL-BODY");
    // Run policy never survives the mount.
    expect(opinionated).not.toContain("allowed-tools");
    expect(opinionated).not.toContain("model: opus");
  });

  it("refuses a skill that leaves the store (symlinked folder) and an SDK-unsafe name", async () => {
    // Same containment rule the injector has enforced since A5/pass-16: a
    // mounted skill is TRUSTED operating context, so the trust boundary is the
    // store — whichever mechanism carries the content to the run.
    const dataRoot = storeWithSkills([{ name: "real", skillMd: "SENTINEL-REAL\n" }]);
    const outside = mkdtempSync(path.join(tmpdir(), "viberr-outside-"));
    writeFileSync(path.join(outside, "SKILL.md"), "SENTINEL-EVIL\n");
    symlinkSync(outside, path.join(dataRoot, "skills", "linked"), "dir");
    mkdirSync(path.join(dataRoot, "skills", "my skill (v2)"), { recursive: true });
    writeFileSync(
      path.join(dataRoot, "skills", "my skill (v2)", "SKILL.md"),
      "SENTINEL-UNSAFE-NAME\n",
    );
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["real", "linked", "my skill (v2)", "ghost"],
      dataRoot,
    });

    expect(result.mounted).toEqual(["real"]);
    expect(result.skipped.map((s) => s.name).sort()).toEqual([
      "ghost",
      "linked",
      "my skill (v2)",
    ]);
    // A name the SDK would throw on never reaches the SDK…
    expect(result.skipped.find((s) => s.name === "my skill (v2)")?.reason).toContain(
      "exact skill name",
    );
    // …and no evil content landed in the workspace at all.
    const skillsDir = path.join(ws, ".claude", "skills");
    expect(existsSync(path.join(skillsDir, "linked"))).toBe(false);
    expect(existsSync(path.join(skillsDir, "ghost"))).toBe(false);
  });

  it("mounts NOTHING when the run has no git checkout — the isolation gate", async () => {
    // `settingSources: ['project']` walks from cwd UP TO THE REPO ROOT. A cwd
    // that is not itself a repo root has no such stop — and the data root can
    // sit inside a host checkout (docker-data/ lives inside the viberr repo on a
    // dev machine), so the walk could reach the host's own `.claude`. The mount
    // refusing here is what makes "we only ever enable skills inside a checkout
    // we rewrote" true by construction: no mount ⇒ the caller passes no skills
    // ⇒ the adapter keeps settingSources: [].
    //
    // Canary: drop the `isPlainGitCheckout` guard and `mounted` becomes ["a"].
    const dataRoot = storeWithSkills([{ name: "a", skillMd: "body\n" }]);
    const bare = mkdtempSync(path.join(tmpdir(), "viberr-no-git-"));

    const noWorkspace = await mountGrantedSkills({
      workspaceDir: null,
      skills: ["a"],
      dataRoot,
    });
    const notARepo = await mountGrantedSkills({
      workspaceDir: bare,
      skills: ["a"],
      dataRoot,
    });

    expect(noWorkspace.mounted).toEqual([]);
    expect(notARepo.mounted).toEqual([]);
    expect(notARepo.skipped[0]?.reason).toContain("no git checkout");
    expect(existsSync(path.join(bare, ".claude"))).toBe(false);
  });

  it("leaves NO trace in the delivery: git stays clean and .claude never reaches a commit", async () => {
    // The load-bearing half of the whole change. Delivery runs `git add -A`
    // (push-workspace.server) over the agent's working tree, and the agent
    // commits itself — neither may pick up the skills Viberr mounted.
    //
    // Canary: remove the `.git/info/exclude` write and the status assertion
    // fails immediately (`?? .claude/`), then the diff assertion.
    const dataRoot = storeWithSkills([{ name: "craft", skillMd: "SENTINEL-CRAFT\n" }]);
    const ws = await gitCheckout();

    await mountGrantedSkills({ workspaceDir: ws, skills: ["craft"], dataRoot });

    // git does not even SEE the mount — so delivery's "did the agent leave
    // uncommitted work?" probe is not tripped by it either.
    const status = (await exec("git", ["-C", ws, "status", "--porcelain"])).stdout.trim();
    expect(status).toBe("");

    writeFileSync(path.join(ws, "src", "app.ts"), "export const a = 2;\n");
    await exec("git", ["-C", ws, "add", "-A"]);
    await exec("git", ["-C", ws, "commit", "-q", "-m", "work"]);
    const diff = (await exec("git", ["-C", ws, "diff", "--name-status", "HEAD~1", "HEAD"]))
      .stdout;
    expect(diff).toContain("src/app.ts");
    expect(diff).not.toContain(".claude");
    // And the skill is still there for the run that is using it.
    expect(existsSync(path.join(ws, ".claude", "skills", "craft", "SKILL.md"))).toBe(true);
  });

  it("re-mounting is idempotent — one exclude entry, no stale skills from a previous grant", async () => {
    // Every run (fresh AND resumed) re-mounts into a workspace that survives
    // between runs. An un-granted skill must not linger from the last run, and
    // the exclude file must not grow a line per run.
    const dataRoot = storeWithSkills([
      { name: "first", skillMd: "one\n" },
      { name: "second", skillMd: "two\n" },
    ]);
    const ws = await gitCheckout();

    await mountGrantedSkills({ workspaceDir: ws, skills: ["first"], dataRoot });
    await mountGrantedSkills({ workspaceDir: ws, skills: ["second"], dataRoot });

    const skillsDir = path.join(ws, ".claude", "skills");
    expect(existsSync(path.join(skillsDir, "second"))).toBe(true);
    expect(existsSync(path.join(skillsDir, "first"))).toBe(false);
    const exclude = readFileSync(path.join(ws, ".git", "info", "exclude"), "utf8");
    expect(exclude.split("\n").filter((l) => l.trim() === ".claude/")).toHaveLength(1);
  });

  it("strips a `.claude` an EARLIER run wrote before mounting (no ungoverned settings survive)", async () => {
    // The workspace is shared by every engagement on a task and survives between
    // runs. A delivering agent can write `.claude/settings.json` — whose hooks
    // the project setting source would execute on the NEXT run, including a
    // read-only reviewer's. The mount owns the whole catalog, so it goes.
    //
    // Canary: drop the `stripUngovernedRepoCatalog` call from `mountGrantedSkills`
    // and the settings file is still there.
    const dataRoot = storeWithSkills([{ name: "craft", skillMd: "body\n" }]);
    const ws = await gitCheckout();
    mkdirSync(path.join(ws, ".claude", "skills", "self-installed"), { recursive: true });
    writeFileSync(path.join(ws, ".claude", "settings.json"), '{"hooks":{}}');
    writeFileSync(
      path.join(ws, ".claude", "skills", "self-installed", "SKILL.md"),
      "SENTINEL-SELF-INSTALLED\n",
    );

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["craft"],
      dataRoot,
    });

    expect(result.mounted).toEqual(["craft"]);
    expect(existsSync(path.join(ws, ".claude", "settings.json"))).toBe(false);
    expect(
      existsSync(path.join(ws, ".claude", "skills", "self-installed")),
    ).toBe(false);
  });

  it("leaves the workspace untouched when a granted skill resolves to nothing", async () => {
    // A run whose grants all miss must look exactly like a run with no grants —
    // no empty `.claude` for the SDK to open a project source over.
    const dataRoot = storeWithSkills([]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["ghost"],
      dataRoot,
    });

    expect(result.mounted).toEqual([]);
    expect(existsSync(path.join(ws, ".claude"))).toBe(false);
  });
});
