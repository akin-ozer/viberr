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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
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

  it("keeps the skills a LIVE run mounted — a second run must not unmount it (F19-15)", async () => {
    // The workspace checkout belongs to the TASK, not to a run: every
    // engagement shares it. Run B starting while run A still executes calls the
    // strip on run A's tree (cloneRepo's reuse path does it before B has
    // decided anything). Before this fix that deleted the skills A had mounted
    // and A kept going without them — no error, no event, nothing visible.
    //
    // Canary: make `stripUngovernedRepoCatalog` `rmSync` the whole catalog
    // again and the first assertion below fails with
    // `expected false to be true` on live-craft/SKILL.md.
    const dataRoot = storeWithSkills([
      { name: "live-craft", skillMd: "SENTINEL-LIVE\n" },
      { name: "later-craft", skillMd: "SENTINEL-LATER\n" },
    ]);
    const ws = await gitCheckout();

    // Run A mounts and is still executing.
    const runA = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["live-craft"],
      dataRoot,
    });
    expect(runA.mounted).toEqual(["live-craft"]);

    // Run B starts on the same task: cloneRepo re-strips the shared workspace…
    await stripUngovernedRepoCatalog(ws);
    expect(
      existsSync(path.join(ws, ".claude", "skills", "live-craft", "SKILL.md")),
    ).toBe(true);

    // …and then mounts its own. Both runs now hold what they were granted.
    const runB = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["later-craft"],
      dataRoot,
    });
    expect(runB.mounted).toEqual(["later-craft"]);
    expect(readFileSync(path.join(ws, ".claude", "skills", "live-craft", "SKILL.md"), "utf8"))
      .toContain("SENTINEL-LIVE");
    expect(readFileSync(path.join(ws, ".claude", "skills", "later-craft", "SKILL.md"), "utf8"))
      .toContain("SENTINEL-LATER");
  });

  it("F31-C4: a successful mount writes the CLAUDE.md excludes into the catalog settings", async () => {
    // The project settings source is the only channel the live probe showed
    // actually delivers `claudeMdExcludes` (Options.managedSettings drops the
    // key on the SDK's restrictive-only allowlist). The file must contain the
    // excludes and NOTHING else — a hooks/permissions key here would be an
    // instruction channel viberr just handed to itself.
    // Canary: skip writeCatalogSettings and the existsSync below fails.
    const dataRoot = storeWithSkills([{ name: "craft", skillMd: "S\n" }]);
    const ws = await gitCheckout();
    const run = await mountGrantedSkills({ workspaceDir: ws, skills: ["craft"], dataRoot });
    expect(run.mounted).toEqual(["craft"]);
    const settingsPath = path.join(ws, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(readFileSync(settingsPath, "utf8")));
    expect(Object.keys(settings)).toEqual(["claudeMdExcludes"]);
    expect(settings.claudeMdExcludes).toEqual([
      "**/CLAUDE.md",
      "**/CLAUDE.local.md",
      "**/.claude/**",
    ]);
  });

  it("preserving a live mount preserves NOTHING else — settings, commands and repo skills still go", async () => {
    // The narrow exception must stay narrow: `settings.json` carries hooks the
    // project setting source would execute on the next run, which is the whole
    // reason the strip exists (R18-3).
    const dataRoot = storeWithSkills([{ name: "live-craft", skillMd: "SENTINEL-LIVE\n" }]);
    const ws = await gitCheckout();
    await mountGrantedSkills({ workspaceDir: ws, skills: ["live-craft"], dataRoot });
    // …then the repo (or a previous agent) leaves its own catalog content next
    // to the mount.
    writeFileSync(path.join(ws, ".claude", "settings.json"), '{"hooks":{}}');
    mkdirSync(path.join(ws, ".claude", "commands"), { recursive: true });
    writeFileSync(path.join(ws, ".claude", "commands", "verify.md"), "# verify");
    mkdirSync(path.join(ws, ".claude", "skills", "repo-authored"), { recursive: true });
    writeFileSync(
      path.join(ws, ".claude", "skills", "repo-authored", "SKILL.md"),
      "SENTINEL-REPO\n",
    );

    await stripUngovernedRepoCatalog(ws);

    expect(existsSync(path.join(ws, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(path.join(ws, ".claude", "commands"))).toBe(false);
    expect(existsSync(path.join(ws, ".claude", "skills", "repo-authored"))).toBe(false);
    expect(existsSync(path.join(ws, ".claude", "skills", "live-craft"))).toBe(true);
  });

  it("a repo that FORGES the Viberr mount marker is stripped anyway", async () => {
    // `.claude` arrives from an untrusted clone. If the marker were a fixed,
    // guessable value, a repository could ship it and buy its own skills — and
    // its `settings.json` — immunity from the strip. The mark is minted per
    // process and never leaves it.
    //
    // Canary: replace the random `MOUNT_MARK` with a constant literal and this
    // test starts failing (`.claude` survives).
    const ws = await gitCheckout();
    mkdirSync(path.join(ws, ".claude", "skills", "impostor"), { recursive: true });
    writeFileSync(path.join(ws, ".claude", "skills", "impostor", "SKILL.md"), "EVIL\n");
    for (const forged of [
      "viberr-skill-mount",
      "viberr-skill-mount 00000000-0000-0000-0000-000000000000",
      "true",
    ]) {
      writeFileSync(path.join(ws, ".claude", "skills", "impostor", ".viberr-mount"), forged);
      await stripUngovernedRepoCatalog(ws);
      expect(existsSync(path.join(ws, ".claude"))).toBe(false);
      mkdirSync(path.join(ws, ".claude", "skills", "impostor"), { recursive: true });
      writeFileSync(path.join(ws, ".claude", "skills", "impostor", "SKILL.md"), "EVIL\n");
    }
  });
});

/**
 * F19-2 / ruling 57 (R19-3) — a doc-drift gate, in the same family as
 * `copy-ban.test.ts` and `prd-sync.test.ts`.
 *
 * `deliveringContextGrants` / `withDeliveringGrants` in specialist-run.server
 * carried a docstring saying the reviewer's inherited grants had been "widened
 * to SKILLS by LV-F3". No call site ever did it, and ruling 57 settled that none
 * should: a KB is shared CONVENTION (deliverer and reviewer must be held to the
 * same one), a skill is ROLE INSTRUCTION (a reviewer running the deliverer's
 * method judges nothing). The comment was a false description of the code for a
 * whole pass, which is the failure ruling 44 exists to catch.
 *
 * It lives in the SKILL-mount test file because the boundary it defends is which
 * skills reach which run — the question this module answers everywhere else. The
 * behavioural half (engage a reviewer, assert the deliverer's skill body is
 * absent from its persona) belongs next to the R18-1 KB tests in
 * `specialist-run.server.test.ts` and is not yet written.
 */
describe("reviewer inheritance is KBs only (F19-2 / ruling 57)", () => {
  const SOURCE = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../tasks/specialist-run.server.ts",
  );

  it("neither call site unions anything but `kb`, and no comment claims otherwise", () => {
    const src = readFileSync(SOURCE, "utf8");

    // Canary (code): change either call site to union `skills` and this fails.
    const calls = [...src.matchAll(/(\w+)\s*=\s*withDeliveringGrants\(/g)].map(
      (m) => m[1],
    );
    const resumeCalls = [...src.matchAll(/withDeliveringGrants\(resolved\.(\w+)/g)].map(
      (m) => m[1],
    );
    expect(calls.length + resumeCalls.length).toBeGreaterThanOrEqual(2);
    for (const target of [...calls, ...resumeCalls]) expect(target).toBe("kb");

    // Canary (prose): restore "R18-1 (widened to SKILLS by LV-F3)" above
    // `deliveringContextGrants` and this fails.
    expect(src).not.toMatch(/widened to SKILLS/i);
    expect(src).not.toContain("LV-F3");
    // …and the ruling that settles it is cited where the rule lives.
    expect(src).toMatch(/Ruling 57 \(R19-3/);
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

  it("re-mounting is idempotent — one exclude entry, and only THIS run's grants are handed to the SDK", async () => {
    // Every run (fresh AND resumed) re-mounts into a workspace that survives
    // between runs, and the exclude file must not grow a line per run.
    //
    // The un-granted `first` folder deliberately SURVIVES on disk (F19-15):
    // this process cannot tell a finished run from one still executing, so it
    // never deletes its own mounts. What bounds the run is the returned
    // `mounted` list — the adapter passes exactly that as the SDK's `skills`
    // allow-list, which rejects every unlisted skill.
    const dataRoot = storeWithSkills([
      { name: "first", skillMd: "one\n" },
      { name: "second", skillMd: "two\n" },
    ]);
    const ws = await gitCheckout();

    await mountGrantedSkills({ workspaceDir: ws, skills: ["first"], dataRoot });
    const second = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["second"],
      dataRoot,
    });

    expect(second.mounted).toEqual(["second"]);
    const skillsDir = path.join(ws, ".claude", "skills");
    expect(existsSync(path.join(skillsDir, "second"))).toBe(true);
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
    // F31-C4: the strip removed the FOREIGN settings (its hooks with it), and
    // the mount re-wrote the file as viberr's own — excludes only, no hooks.
    // The spirit of this test is unchanged: no ungoverned settings survive.
    const rewritten = z
      .record(z.string(), z.unknown())
      .parse(
        JSON.parse(readFileSync(path.join(ws, ".claude", "settings.json"), "utf8")),
      );
    expect(Object.keys(rewritten)).toEqual(["claudeMdExcludes"]);
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

  it("a run that mounts NOTHING still leaves a live run's mount alone (F19-15)", async () => {
    // The other half of the unmount path: when nothing mounted we clear the
    // catalog so the workspace matches a skill-less run — which used to `rm -rf`
    // a concurrent run's skills as collateral.
    //
    // Canary: restore `rmSync(path.join(dir, ".claude"), …)` in place of the
    // strip call and `live-craft` disappears.
    const dataRoot = storeWithSkills([{ name: "live-craft", skillMd: "SENTINEL-LIVE\n" }]);
    const ws = await gitCheckout();
    await mountGrantedSkills({ workspaceDir: ws, skills: ["live-craft"], dataRoot });

    const runB = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["ghost"],
      dataRoot,
    });

    expect(runB.mounted).toEqual([]);
    expect(existsSync(path.join(ws, ".claude", "skills", "live-craft", "SKILL.md"))).toBe(
      true,
    );
  });
});
