import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isSdkSkillName,
  mountGrantedSkills,
  removeSkillPlugin,
  skillPluginDir,
  skillPluginInPlace,
  stripUngovernedRepoCatalog,
} from "./skill-mount.server";
import { createTempDirs } from "../../../test-support/temp-dirs";

const exec = promisify(execFile);

const temp = createTempDirs();
afterAll(temp.cleanup);

/** A data root holding `skills/<name>/SKILL.md` (+ optional extra files). */
function storeWithSkills(
  skills: { name: string; skillMd: string; extra?: Record<string, string> }[],
): string {
  const dataRoot = temp.make("viberr-skill-store-");
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

/**
 * A git checkout with one committed source file (the delivery subject), the
 * way `cloneRepo` leaves one: `<workspace root>/<repo>`, so the plugin has a
 * parent to sit beside.
 */
async function gitCheckout(prefix = "viberr-ws-"): Promise<string> {
  const root = temp.make(prefix);
  const dir = path.join(root, "widgets");
  mkdirSync(dir);
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

const pluginSkillMd = (plugin: string, name: string) =>
  readFileSync(path.join(plugin, "skills", name, "SKILL.md"), "utf8");

describe("stripUngovernedRepoCatalog (R18-3 / F18-8)", () => {
  async function gitRepoWithClaude(): Promise<string> {
    const dir = temp.make("viberr-strip-");
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

    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
    // `git status` sees NO change: the tracked paths are skip-worktree, so a
    // later `git add -A` (delivery finalization) cannot ship the deletion.
    const status = (await exec("git", ["-C", dir, "status", "--porcelain"])).stdout.trim();
    expect(status).toBe("");
    // A real edit still commits normally, and the commit carries no .claude
    // deletion.
    writeFileSync(path.join(dir, "src", "app.ts"), "export const a = 2;\n");
    await exec("git", ["-C", dir, "add", "-A"]);
    await exec("git", ["-C", dir, "commit", "-q", "-m", "work"]);
    const diff = (await exec("git", ["-C", dir, "diff", "--name-status", "HEAD~1", "HEAD"]))
      .stdout;
    expect(diff).toContain("src/app.ts");
    expect(diff).not.toContain(".claude");
  });

  it("is a no-op when the clone has no .claude", async () => {
    const dir = temp.make("viberr-strip-empty-");
    await stripUngovernedRepoCatalog(dir);
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
  });

  it("ruling 180: the strip is whole — an agent-written catalog goes, and a live run's skills are elsewhere", async () => {
    // The in-checkout mount needed a per-process marker (F19-15) so a second
    // run's strip would spare a live run's `.claude/skills`. Skills now live
    // in each run's own plugin beside the checkout, so the strip has nothing
    // of Viberr's to spare: everything under `.claude` goes, every time.
    const dataRoot = storeWithSkills([{ name: "live-craft", skillMd: "SENTINEL-LIVE\n" }]);
    const dir = await gitCheckout();
    const live = await mountGrantedSkills({
      workspaceDir: dir,
      skills: ["live-craft"],
      dataRoot,
      runId: "run_live",
    });
    mkdirSync(path.join(dir, ".claude", "skills", "self-installed"), { recursive: true });
    writeFileSync(path.join(dir, ".claude", "settings.json"), '{"hooks":{}}');
    writeFileSync(
      path.join(dir, ".claude", "skills", "self-installed", "SKILL.md"),
      "SENTINEL-SELF-INSTALLED\n",
    );

    await stripUngovernedRepoCatalog(dir);

    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(skillPluginInPlace(live.plugin)).toBe(true);
    expect(pluginSkillMd(live.plugin!.path, "live-craft")).toContain("SENTINEL-LIVE");
  });
});

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
      "plugin:skill", // plugin-qualified — the ADAPTER adds `viberr:`; a store name carrying one is refused
    ]) {
      expect(isSdkSkillName(bad)).toBe(false);
    }
  });
});

describe("mountGrantedSkills", () => {
  it("ruling 180: writes NOTHING under the checkout — the plugin dir beside it holds the manifest and the skills", async () => {
    // F36-9 (pass 36), live three times: the mount wrote `.claude/` (skills +
    // settings.json) INTO the task checkout, git-excluded but visible to every
    // tool that walks the tree, so the project's own `npm run check`
    // (`prettier --check .`) failed in the agent workspace and passed in a
    // clean clone; two reviewer runs spent turns proving the tracked tree
    // clean. The skills now ride a LOCAL PLUGIN at
    // `<checkout>/../.viberr-plugins/<runId>/` — canaried inside the image
    // (2026-09-11): the CLI lists the skill as `viberr:<name>` and invokes it.
    // Canary: point `skillsRoot` back at `<checkout>/.claude/skills` and the
    // checkout assertion fails; drop the manifest write and the plugin one.
    const dataRoot = storeWithSkills([
      { name: "terraform-review", skillMd: "## Review checklist\n- state safety\n" },
    ]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["terraform-review"],
      dataRoot,
      runId: "run_abc123",
    });

    expect(result.mounted).toEqual(["terraform-review"]);
    // Nothing of Viberr's inside the tree the project's tools scan, and no
    // exclude entry either (`git init` writes a stock `.git/info/exclude`;
    // the mount used to append `.claude/` to it).
    expect(existsSync(path.join(ws, ".claude"))).toBe(false);
    expect(readFileSync(path.join(ws, ".git", "info", "exclude"), "utf8")).not.toContain(".claude");
    expect((await exec("git", ["-C", ws, "status", "--porcelain"])).stdout.trim()).toBe("");
    // The plugin is a sibling of the checkout, named by the run …
    const plugin = path.join(path.dirname(ws), ".viberr-plugins", "run_abc123");
    expect(result.plugin).toEqual({ path: plugin, name: "viberr" });
    expect(skillPluginDir(ws, "run_abc123")).toBe(plugin);
    // … with the manifest the CLI reads and the skill folder it discovers.
    const manifest = z
      .object({ name: z.string(), description: z.string(), version: z.string() })
      .parse(JSON.parse(readFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "utf8")));
    expect(manifest.name).toBe("viberr");
    expect(readFileSync(path.join(plugin, "skills", "terraform-review", "SKILL.md"), "utf8")).toContain(
      "name: terraform-review",
    );
  });

  it("ruling 180: a settled run's plugin is removed — and only a path under .viberr-plugins ever is", async () => {
    // run-service calls this from the exit handler (and from the refusal
    // arm); the dispatch wrapper calls it for a run that failed before it
    // started. Canary: drop the `.viberr-plugins` parent check and the
    // stranger directory below is deleted.
    const dataRoot = storeWithSkills([{ name: "craft", skillMd: "body\n" }]);
    const ws = await gitCheckout();
    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["craft"],
      dataRoot,
      runId: "run_gone",
    });
    expect(skillPluginInPlace(result.plugin)).toBe(true);

    removeSkillPlugin(result.plugin);
    expect(existsSync(result.plugin!.path)).toBe(false);
    expect(skillPluginInPlace(result.plugin)).toBe(false);
    // Idempotent, and null is nothing to do.
    removeSkillPlugin(result.plugin);
    removeSkillPlugin(null);

    const stranger = temp.make("viberr-not-a-plugin-");
    removeSkillPlugin({ path: stranger, name: "viberr" });
    expect(existsSync(stranger)).toBe(true);
  });

  it("copies the WHOLE granted skill folder into the plugin's skills/<name>", async () => {
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
      runId: "run_whole",
    });

    expect(result.mounted).toEqual(["terraform-review"]);
    expect(result.skipped).toEqual([]);
    const dest = path.join(result.plugin!.path, "skills", "terraform-review");
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
      runId: "run_only",
    });

    expect(result.mounted).toEqual(["granted"]);
    expect(readdirSync(path.join(result.plugin!.path, "skills"))).toEqual(["granted"]);
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

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["plain", "opinionated"],
      dataRoot,
      runId: "run_norm",
    });

    const plain = pluginSkillMd(result.plugin!.path, "plain");
    expect(plain).toContain("name: plain");
    // No description on disk → synthesized from the first body line, so the
    // model has something to decide invocation on.
    expect(plain).toContain("description: Commit format");
    expect(plain).toContain("[VIB-<n>]");

    const opinionated = pluginSkillMd(result.plugin!.path, "opinionated");
    // The name is pinned to the mounted folder — it MUST equal the name we hand
    // the SDK's `skills` filter (qualified by the plugin), or the filter
    // rejects the skill we just mounted.
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
    const outside = temp.make("viberr-outside-");
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
      runId: "run_refuse",
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
    // …and no evil content landed in the plugin at all.
    expect(readdirSync(path.join(result.plugin!.path, "skills"))).toEqual(["real"]);
  });

  it("mounts NOTHING when the run has no checkout to mount beside", async () => {
    // A run with no clone runs in the bare task directory: there is no tree
    // to sit beside, and its grants keep prompt-text injection, exactly as
    // before. A recorded checkout that no longer exists is the same case (a
    // resume after the workspace was reclaimed).
    const dataRoot = storeWithSkills([{ name: "a", skillMd: "body\n" }]);

    const noWorkspace = await mountGrantedSkills({
      workspaceDir: null,
      skills: ["a"],
      dataRoot,
      runId: "run_none",
    });
    const gone = await mountGrantedSkills({
      workspaceDir: path.join(temp.make("viberr-gone-"), "widgets"),
      skills: ["a"],
      dataRoot,
      runId: "run_gone",
    });

    expect(noWorkspace).toEqual({
      mounted: [],
      skipped: [{ name: "a", reason: expect.stringContaining("no git checkout") }],
      plugin: null,
    });
    expect(gone.mounted).toEqual([]);
    expect(gone.plugin).toBeNull();
  });

  it("leaves NO trace in the delivery: git never sees the plugin", async () => {
    // The load-bearing half of the whole change. Delivery runs `git add -A`
    // (push-workspace.server) over the agent's working tree, and the agent
    // commits itself — neither can pick up a sibling directory, and no
    // exclude entry is needed to make that so.
    const dataRoot = storeWithSkills([{ name: "craft", skillMd: "SENTINEL-CRAFT\n" }]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["craft"],
      dataRoot,
      runId: "run_clean",
    });

    const status = (await exec("git", ["-C", ws, "status", "--porcelain"])).stdout.trim();
    expect(status).toBe("");
    writeFileSync(path.join(ws, "src", "app.ts"), "export const a = 2;\n");
    await exec("git", ["-C", ws, "add", "-A"]);
    await exec("git", ["-C", ws, "commit", "-q", "-m", "work"]);
    const diff = (await exec("git", ["-C", ws, "diff", "--name-status", "HEAD~1", "HEAD"]))
      .stdout;
    expect(diff).toContain("src/app.ts");
    expect(diff).not.toContain(".claude");
    expect(diff).not.toContain("viberr-plugins");
    // And the skill is still there for the run that is using it.
    expect(existsSync(path.join(result.plugin!.path, "skills", "craft", "SKILL.md"))).toBe(true);
  });

  it("two runs on one workspace get two plugins — a second mount never touches the first run's", async () => {
    // The F19-15 race, closed by construction: the checkout is per TASK and
    // shared by every engagement, but each run's plugin is its own directory.
    // Canary: derive the plugin path from the workspace alone (drop `runId`)
    // and run A's skill is gone after run B mounts.
    const dataRoot = storeWithSkills([
      { name: "first", skillMd: "one\n" },
      { name: "second", skillMd: "two\n" },
    ]);
    const ws = await gitCheckout();

    const a = await mountGrantedSkills({ workspaceDir: ws, skills: ["first"], dataRoot, runId: "run_a" });
    const b = await mountGrantedSkills({ workspaceDir: ws, skills: ["second"], dataRoot, runId: "run_b" });

    expect(a.plugin!.path).not.toBe(b.plugin!.path);
    expect(readdirSync(path.join(a.plugin!.path, "skills"))).toEqual(["first"]);
    expect(readdirSync(path.join(b.plugin!.path, "skills"))).toEqual(["second"]);
    // Re-mounting under the SAME run id replaces, never accumulates.
    const again = await mountGrantedSkills({ workspaceDir: ws, skills: ["second"], dataRoot, runId: "run_a" });
    expect(again.plugin!.path).toBe(a.plugin!.path);
    expect(readdirSync(path.join(a.plugin!.path, "skills"))).toEqual(["second"]);
  });

  it("strips a `.claude` an EARLIER run (or the agent) wrote before mounting", async () => {
    // The workspace is shared by every engagement on a task and survives
    // between runs. A delivering agent can write `.claude/settings.json` into
    // its checkout; no run reads it as a settings source any more (ruling
    // 180), and the working tree still must not carry an ungoverned catalog.
    // Canary: drop the `stripUngovernedRepoCatalog` call from
    // `mountGrantedSkills` and the settings file is still there.
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
      runId: "run_strip",
    });

    expect(result.mounted).toEqual(["craft"]);
    expect(existsSync(path.join(ws, ".claude"))).toBe(false);
  });

  it("leaves no plugin behind when every granted skill resolves to nothing", async () => {
    // A run whose grants all miss must look exactly like a run with no grants —
    // no empty plugin for the CLI to load, and `plugin: null` so the adapter
    // keeps the fully isolated shape.
    const dataRoot = storeWithSkills([]);
    const ws = await gitCheckout();

    const result = await mountGrantedSkills({
      workspaceDir: ws,
      skills: ["ghost"],
      dataRoot,
      runId: "run_ghost",
    });

    expect(result.mounted).toEqual([]);
    expect(result.plugin).toBeNull();
    expect(existsSync(path.join(path.dirname(ws), ".viberr-plugins", "run_ghost"))).toBe(false);
    expect(existsSync(path.join(ws, ".claude"))).toBe(false);
  });
});
