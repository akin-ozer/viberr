import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
} from "~/server/files/frontmatter.server";
import {
  resolveContainedSkillFile,
  skillFrontmatterSchema,
} from "~/server/files/skill-body.server";
import { logger } from "~/server/logging/logger.server";
import {
  workspaceGitWhenIsolationOff,
  type WorkspaceGit,
} from "~/server/tasks/workspace-git.server";
import { toError } from "~/shared/errors";
import type { AgentLaunch } from "./agent-isolation.server";
import { removeAgentTree, removeAgentTreeSync } from "./agent-trees.server";

/**
 * Viberr's granted skills reach a Claude run as a LOCAL PLUGIN beside the task
 * checkout (ruling 180, pass 36) — never as files inside it.
 *
 * Two halves of one rule ("a governed run may see the resources its profile
 * grants and NOTHING else"), kept in one module so a caller cannot do half:
 *
 *  1. {@link stripUngovernedRepoCatalog} (R18-3 / F18-8) — DELETE whatever
 *     `.claude` the cloned repository ships (or an agent wrote), so nothing
 *     ungoverned is discoverable from the working tree.
 *  2. {@link mountGrantedSkills} — BUILD the run's plugin at
 *     `<checkout>/../.viberr-plugins/<runId>/` (`.claude-plugin/plugin.json` +
 *     `skills/<name>/`), which the Claude adapter hands to the SDK as
 *     `plugins: [{ type: "local", path }]` with the skills filtered by their
 *     plugin-qualified names (`viberr:<name>`).
 *
 * F36-9 — why OUTSIDE the checkout. The mount used to write `.claude/skills`
 * and a `settings.json` into the checkout and open `settingSources:
 * ["project"]` over it, hiding the files from git through `.git/info/exclude`.
 * Git did not see them; every OTHER tool that walks the tree did — the
 * project's own `npm run check` (`prettier --check .`) failed in the agent
 * workspace and passed in a clean clone, and two reviewer runs spent turns
 * proving the tracked tree clean. A sibling directory is invisible to anything
 * that scans the checkout, needs no exclude entry, and closes the CLAUDE.md
 * ingress the project source used to open (nothing under cwd is a settings
 * source any more, so nothing needs excluding). Canaried inside the image on
 * 2026-09-11: the CLI lists the plugin's skill as `viberr:<name>` and the
 * model invokes it.
 *
 * ONE plugin per RUN (not per workspace): the checkout is shared by every
 * engagement on the task, but each run's plugin is its own directory, removed
 * when the run settles ({@link removeSkillPlugin}) — so a second run starting
 * on the same workspace can no longer unmount a live run's skills (the F19-15
 * race the old in-checkout mount needed a per-process marker to survive).
 *
 * Ruling 495(a), F40-71: the plugin is the server's, in a tree the task's
 * person removes, and unlinking needs write on the directory. Every entry is
 * made anew with the mode that removal needs and is never changed once it
 * exists ({@link copySkillFolder}, {@link writeNewPluginFile}): its folders
 * by `mkdir` under the server's umask in the workspace's setgid chain (2775
 * in the workspace's group), its files group-readable, set on their own new
 * descriptor. `cpSync` had given the copy the store folder's own modes, and a
 * store folder's 0755 had left every settled run's plugin on disk, its files
 * unlinkable by the person. A chmod walk after the copy would not do: the
 * plugin's folders are the group's to write, and a path through a folder an
 * agent swapped for a link reaches whatever the link names.
 */

/** The plugin name the CLI qualifies skills with: `viberr:<skill>`. */
const SKILL_PLUGIN_NAME = "viberr";
/** The directory beside a checkout that holds every run's plugin. */
const SKILL_PLUGINS_DIR = ".viberr-plugins";

/**
 * R18-3 / F18-8 — remove the cloned repo's own `.claude` catalog from the run's
 * working tree so the Claude CLI cannot discover its ungoverned slash-commands,
 * settings (hooks!), sub-agents and skills. A governed run needs nothing from
 * the repo's `.claude`: its own craft arrives through its profile's grants
 * (the run plugin on Claude, prompt text on Codex).
 *
 * `.claude` is TRACKED in many repos (incl. viberr itself: launch.json, skills,
 * submodule gitlinks), and delivery auto-commits the working tree with `git add
 * -A` (push-workspace.server). A plain `rm -rf` would therefore ship a `.claude`
 * DELETION into the review PR. We first mark every tracked `.claude` path
 * `--skip-worktree`: git then treats the absent files as unchanged, `git add -A`
 * never stages the deletion, and the committed tree keeps `.claude` from the
 * index. (A run whose task is to edit the repo's own `.claude` cannot deliver
 * those edits — the intended governance posture, not a bug.)
 *
 * Since ruling 180 nothing of Viberr's lives in this directory, so the strip
 * is whole: every entry goes, on every call.
 *
 * Pass 40 review (R-seams-1): the two git reads run as the task's person
 * (`git`), never as the server — the checkout is agent-writable. A caller
 * with no person to name gets the server's own user only where no agent is
 * launched; with isolation on the git step is skipped.
 *
 * Ruling 485: the catalog itself is removed as that same person
 * (`removeAgentTree`), never by the server's own recursive remove — an agent
 * writes `.claude` too. With isolation on and no person to name, the removal
 * refuses and this throws: the catalog is left, and the caller says so.
 */
export async function stripUngovernedRepoCatalog(
  repoDir: string,
  git: WorkspaceGit | null = workspaceGitWhenIsolationOff(),
): Promise<void> {
  const catalog = path.join(repoDir, ".claude");
  if (!existsSync(catalog)) return;
  try {
    if (!git) throw new Error("no person to run the checkout's git as");
    const { stdout } = await git.run(["-C", repoDir, "ls-files", "-z", "--", ".claude"], {
      timeoutMs: 10_000,
    });
    const tracked = stdout.split("\0").filter(Boolean);
    if (tracked.length) {
      await git.run(["-C", repoDir, "update-index", "--skip-worktree", "--", ...tracked], {
        timeoutMs: 10_000,
      });
    }
  } catch (error) {
    // Non-fatal: governance still wins — we strip the catalog regardless. The
    // worst case of a skip-worktree failure is a `.claude` deletion surfacing in
    // the delivery diff for a human to notice, never a silent catalog leak.
    logger.warn("could not skip-worktree repo .claude before stripping", {
      repoDir,
      err: toError(error),
    });
  }
  await removeAgentTree(catalog, git ? git.launch : null);
}

/**
 * Names the Claude Agent SDK accepts in its `skills` context filter.
 *
 * The TS SDK THROWS BEFORE STARTING on a value that cannot be an exact skill
 * name (empty, padded whitespace, parentheses/commas/control characters,
 * wildcards) — a run that would have worked instead dies with a runtime-config
 * error the human cannot act on. Skill folder names come from `slugify`
 * (`[a-z0-9-]+`) for everything the UI mints, but an IMPORTED or hand-created
 * store folder only passes `resolveStoreSegment`, which allows spaces, `*`,
 * `(`, `,` and friends. So this is an ALLOW-list, not a mirror of the SDK's
 * deny-list: anything outside it does not mount and is injected as prompt text
 * instead (see `buildSpecialistPersona`) — a name we cannot prove safe must
 * never be able to fail a run.
 */
const SDK_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSdkSkillName(name: string): boolean {
  return SDK_SKILL_NAME_RE.test(name);
}

/** The run's plugin, as the Claude adapter hands it to the SDK. */
export interface SkillPlugin {
  /** Absolute plugin root: the directory holding `.claude-plugin/plugin.json`. */
  path: string;
  /** The manifest's `name` — the prefix of every skill's qualified name. */
  name: string;
  /** Ruling 485: whom the plugin is removed as — the task's person. It sits in
   *  the task's workspace, which every agent in the group can write. Absent:
   *  the server's own user, which only a server that launches no agents
   *  allows. */
  person?: AgentLaunch;
}

/** What a run's mount produced. */
export interface SkillMount {
  /** Exact skill names the plugin carries — the persona announces these, the
   *  adapter qualifies them as `<plugin>:<name>` for `options.skills`. */
  mounted: string[];
  /** Granted skills that did NOT mount, with the reason (they fall back to
   *  prompt-text injection, so this is diagnostic, not capability loss). */
  skipped: { name: string; reason: string }[];
  /** The plugin directory, when anything mounted; null otherwise. */
  plugin: SkillPlugin | null;
}

/** No checkout ⇒ nothing to mount BESIDE ⇒ no native skills (see below). */
const NO_WORKSPACE_REASON =
  "this run has no git checkout to mount skills beside (Viberr injects it as prompt text instead)";

/** The plugin root could not be built at all: nothing is listed natively. */
const NO_PLUGIN_REASON =
  "the run's skill plugin directory could not be written (Viberr injects it as prompt text instead)";

/** Where a run's plugin lives: a sibling of the checkout, named by the run. */
function skillPluginDir(workspaceDir: string, runId: string): string {
  return path.join(path.dirname(workspaceDir), SKILL_PLUGINS_DIR, runId);
}

/**
 * Build the run's plugin beside the checkout: copy each GRANTED skill from the
 * store into `<plugin>/skills/<name>` and write the manifest the CLI reads.
 *
 * WHY BESIDE THE CHECKOUT AND NOT INSIDE (F36-9, ruling 180): see the module
 * note. Why the checkout is still required: the plugin is a sibling of the
 * working tree, and a run with no checkout runs in the bare task directory
 * with no tree to be beside — it keeps prompt-text injection, exactly as it
 * always has. The strip of the repo's own `.claude` still happens here, on
 * every run (fresh AND resume), because the workspace is shared and an agent
 * can write a catalog between two runs.
 *
 * `runId` names the directory. It is the run's id when the dispatch reserved
 * a row before the mount (every dispatched run with a principal) and a fresh
 * id otherwise (a resume, or a run about to be refused); removal never depends
 * on the name — `removeSkillPlugin` takes the path the run carried.
 *
 * Returns the mounted names and the plugin — the caller passes both to the
 * run and suppresses the mounted skills' prompt-text injection. `plugin` is
 * null (and `mounted` empty) when nothing mounted, so the adapter keeps the
 * fully isolated shape and the `Skill` tool stays denied.
 */
export async function mountGrantedSkills(input: {
  /** The run's git checkout (`clone.dir`), or null when it has none. */
  workspaceDir: string | null;
  /** The profile's GRANTED skill names, in declaration order. */
  skills: readonly string[];
  /** The run id (or a fresh id when the run has none yet) — the plugin
   *  directory's name. */
  runId: string;
  dataRoot?: string;
  /** Pass 40 review (R-seams-1): the checkout's git as the task's person, for
   *  the strip below. */
  git?: WorkspaceGit | null;
}): Promise<SkillMount> {
  const names = [...new Set(input.skills)];
  if (names.length === 0) {
    return { mounted: [], skipped: [], plugin: null };
  }
  const dir = input.workspaceDir;
  if (!dir || !isDirectory(dir)) {
    return {
      mounted: [],
      skipped: names.map((name) => ({ name, reason: NO_WORKSPACE_REASON })),
      plugin: null,
    };
  }

  // Strip FIRST, every run (fresh clone AND resume): the repo may ship its own
  // `.claude`, and an agent may have written one — including a `settings.json`
  // whose hooks a project settings source would execute. No run opens that
  // source any more (ruling 180), and the working tree still must not carry
  // an ungoverned catalog for the model to read by hand.
  const git = input.git === undefined ? workspaceGitWhenIsolationOff() : input.git;
  await stripUngovernedRepoCatalog(dir, git);

  // Ruling 485: the plugin sits in the task's workspace, which any agent in
  // the group can write, so every removal of it is the task's person's.
  const person = git ? git.launch : null;
  const pluginRoot = skillPluginDir(dir, input.runId);
  const skillsRoot = path.join(pluginRoot, "skills");
  try {
    // A stale directory under this name (a run id reused by a resume that
    // died mid-mount) must not leak an earlier grant set into this run.
    await removeAgentTree(pluginRoot, person);
    mkdirSync(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
    writeNewPluginFile(
      path.join(pluginRoot, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(PLUGIN_MANIFEST)}\n`,
    );
  } catch (error) {
    logger.warn("could not build the run's skill plugin — injected as prompt text", {
      pluginRoot,
      err: toError(error),
    });
    removePluginQuietly(pluginRoot, person);
    return {
      mounted: [],
      skipped: names.map((name) => ({ name, reason: NO_PLUGIN_REASON })),
      plugin: null,
    };
  }

  const mounted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of names) {
    const reason = mountOneSkill(name, skillsRoot, person, input.dataRoot);
    if (reason) skipped.push({ name, reason });
    else mounted.push(name);
  }
  if (mounted.length === 0) {
    // A run whose grants all miss looks exactly like a run with no grants: no
    // empty plugin for the CLI to load.
    removePluginQuietly(pluginRoot, person);
  }
  if (skipped.length > 0) {
    logger.warn("granted skills did not mount natively — injected as prompt text", {
      workspaceDir: dir,
      skipped,
    });
  }
  if (!mounted.length) return { mounted, skipped, plugin: null };
  const plugin: SkillPlugin = { path: pluginRoot, name: SKILL_PLUGIN_NAME };
  if (person) plugin.person = person;
  return { mounted, skipped, plugin };
}

/** Remove a plugin tree as `person` (ruling 485), never throwing: residue of a
 *  plugin no run names is inert, and is logged. */
function removePluginQuietly(target: string, person: AgentLaunch | null): void {
  try {
    removeAgentTreeSync(target, person);
  } catch (error) {
    logger.warn("could not remove the run's skill plugin", { path: target, err: toError(error) });
  }
}

/**
 * Remove a run's plugin directory — called by run-service when the run
 * settles, and by the dispatch when a run fails before it starts. Only ever
 * removes a path that sits under a `.viberr-plugins` directory: the plugin
 * lives beside an UNTRUSTED checkout, and a path that is not ours to delete is
 * left alone rather than trusted.
 */
export function removeSkillPlugin(plugin: SkillPlugin | null | undefined): void {
  if (!plugin) return;
  if (path.basename(path.dirname(plugin.path)) !== SKILL_PLUGINS_DIR) {
    logger.warn("refusing to remove a skill plugin outside the plugins directory", {
      path: plugin.path,
    });
    return;
  }
  // Inert residue when it fails: no session names this path once its run has
  // settled. As the task's person (ruling 485).
  removePluginQuietly(plugin.path, plugin.person ?? null);
}

/** Does the run's plugin still hold the manifest the CLI reads? The adapter
 *  asks at start: a plugin somebody deleted between the mount and the spawn
 *  must not be handed to the SDK as if it loaded. */
export function skillPluginInPlace(plugin: SkillPlugin | null | undefined): boolean {
  if (!plugin) return false;
  try {
    return lstatSync(path.join(plugin.path, ".claude-plugin", "plugin.json")).isFile();
  } catch {
    return false;
  }
}

/** The manifest every run plugin carries. The CLI reads `name` (the qualified
 *  skill prefix) and `version`; nothing here is an instruction channel. */
const PLUGIN_MANIFEST = {
  name: SKILL_PLUGIN_NAME,
  description:
    "Skills a Viberr project administrator attached to this agent's profile, mounted for one run.",
  version: "1.0.0",
} as const;

function isDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Copy one skill folder; returns null on success or the reason it did not. */
function mountOneSkill(
  name: string,
  skillsRoot: string,
  person: AgentLaunch | null,
  dataRoot?: string,
): string | null {
  if (!isSdkSkillName(name)) {
    return "its name is not one the Claude SDK accepts as an exact skill name";
  }
  let resolved: ReturnType<typeof resolveContainedSkillFile>;
  try {
    // The SAME containment question the injector asks (A5/pass-16): no symlinked
    // skill folder, no symlinked SKILL.md, nothing resolving outside the store.
    // A mounted skill is TRUSTED operating context — the trust boundary is the
    // store, whichever mechanism carries the content to the run.
    resolved = resolveContainedSkillFile(name, dataRoot);
  } catch {
    return "its store name is not a valid folder name";
  }
  if ("reason" in resolved) return resolved.reason;

  const src = path.dirname(resolved.file);
  const dest = path.join(skillsRoot, name);
  try {
    mkdirSync(skillsRoot, { recursive: true });
    // The WHOLE folder: skills are multi-file (checklists/, examples.md, scripts)
    // and the SDK loads those on demand once the model invokes the skill.
    copySkillFolder(src, dest);
    const { data, body } = splitFrontmatter(readFileSync(resolved.file, "utf8"));
    const frontmatter = skillFrontmatterSchema.safeParse(data);
    // NORMALIZE the frontmatter — do not copy it through. Two reasons:
    //  · DISCOVERY: store SKILL.md files are plain markdown (the seeds and the
    //    org-settings editor never write frontmatter), and a SKILL.md without a
    //    `name`/`description` is not a skill the SDK can list. Injection did not
    //    care; native discovery does, and a granted skill that silently fails to
    //    appear is exactly the silent-resource class this codebase keeps closing.
    //  · GOVERNANCE: skill frontmatter can carry `allowed-tools`, `model`,
    //    `disable-model-invocation`… — run policy that Viberr owns through
    //    capability grants. A store file must not be able to widen (or narrow)
    //    the run's tool policy from inside a skill. Only `name` (pinned to the
    //    mounted folder, so it matches the filter we pass the SDK exactly) and
    //    `description` survive.
    writeNewPluginFile(
      path.join(dest, "SKILL.md"),
      serializeFrontmatterFile(
        {
          name,
          description: skillDescription(
            name,
            frontmatter.success ? frontmatter.data.description : undefined,
            body,
          ),
        },
        {},
        body,
      ),
    );
  } catch (error) {
    // A half-copied folder must not be listed: this run falls back to
    // prompt-text injection for the skill, because we return a reason below.
    // It is in the task's workspace, so it goes as the task's person (ruling
    // 485).
    removePluginQuietly(dest, person);
    logger.warn("granted skill could not be mounted into the run's plugin", {
      skill: name,
      err: toError(error),
    });
    return "its files could not be copied into the run's skill plugin";
  }
  return null;
}

/**
 * Ruling 495(a): make one file of a run's plugin, in a tree every agent in
 * the group can write. It is made anew (`O_EXCL`), never opened where an
 * entry already is, and never through a link at its own name (`O_NOFOLLOW`);
 * its mode is set on the new file's own descriptor, so it is group-readable
 * whatever the umask: 0644, or 0755 when `executable`. A folder above it that
 * an agent swapped for a link can only lead it to make a new file elsewhere.
 */
function writeNewPluginFile(file: string, content: string | Uint8Array, executable = false): void {
  const fd = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, executable ? 0o755 : 0o644);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * Ruling 495(a), F40-71: copy a store skill folder into the run's plugin at
 * `dest`, making every entry anew. A folder is made by `mkdir` (never one
 * already there) under the server's umask, 0002 whenever it launches agents
 * (boot sets it), in the workspace's setgid chain: 2775 in the workspace's
 * group. A file is made by {@link writeNewPluginFile}. Nothing is chmod'ed
 * once it exists, so a folder an agent swaps for a link mid-copy leads the
 * copy to make new entries elsewhere or to stop at one already there, never
 * to change what it finds. The store's modes are not copied (`cpSync` kept
 * them, and a store folder's 0755 left the person unable to unlink the
 * copy's files); a file keeps only whether it is executable. Left behind:
 * symlinks (they leave the store), nested `.git` (an imported skill folder
 * carrying one would turn the plugin into a nested repo), anything that is
 * not a folder or a file, and the store's own SKILL.md, which the mount
 * writes normalized. Exported for its own test.
 */
export function copySkillFolder(src: string, dest: string): void {
  const visit = (from: string, to: string, top: boolean) => {
    mkdirSync(to, { mode: 0o775 });
    for (const name of readdirSync(from)) {
      // Case-folded: on a case-insensitive disk `skill.md` is SKILL.md.
      if (name === ".git" || (top && name.toLowerCase() === "skill.md")) continue;
      let st: Stats;
      try {
        st = lstatSync(path.join(from, name));
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(path.join(from, name), path.join(to, name), false);
      else if (st.isFile()) {
        writeNewPluginFile(
          path.join(to, name),
          readFileSync(path.join(from, name)),
          (st.mode & 0o111) !== 0,
        );
      }
    }
  };
  visit(src, dest, true);
}

/** The one-line description the model reads when deciding to invoke a skill. */
function skillDescription(
  name: string,
  declared: string | undefined,
  body: string,
): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  const text = (
    (declared?.trim() ?? "") ||
    firstLine ||
    `The ${name} skill attached to this agent's Viberr profile.`
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
