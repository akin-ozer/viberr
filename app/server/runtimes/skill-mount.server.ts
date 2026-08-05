import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
} from "~/server/files/frontmatter.server";
import { resolveContainedSkillFile } from "~/server/files/skill-body.server";
import { logger } from "~/server/logging/logger.server";

/**
 * Viberr owns the run workspace's `.claude` catalog — END TO END.
 *
 * This module is the ONLY writer of `<workspace>/.claude`, and it does two
 * halves of one job:
 *
 *  1. {@link stripUngovernedRepoCatalog} (R18-3 / F18-8) — DELETE whatever
 *     `.claude` the cloned repository ships (or an earlier run left behind), so
 *     nothing ungoverned is discoverable.
 *  2. {@link mountGrantedSkills} — WRITE the agent's GRANTED skills back in as
 *     `.claude/skills/<name>/`, which is the filesystem contract the Claude
 *     Agent SDK's native skills mechanism reads.
 *
 * Both halves exist because of the same rule: a governed run may see the
 * resources its profile grants and NOTHING else. Splitting them across modules
 * would let a caller do half the job — strip without mounting (skills silently
 * lost) or mount without stripping (the repo's own catalog stays discoverable
 * next to Viberr's, which is precisely the leak R18-3 closed). So the mount
 * calls the strip itself: after {@link mountGrantedSkills} returns, the
 * workspace's `.claude` holds Viberr content or nothing, unconditionally — the
 * guarantee no longer depends on the caller's ordering.
 */

const execFileAsync = promisify(execFile);

/**
 * R18-3 / F18-8 — remove the cloned repo's own `.claude` catalog from the run's
 * working tree so the Claude CLI cannot discover its ungoverned slash-commands,
 * settings (hooks!), sub-agents and skills. A governed run needs nothing from
 * the repo's `.claude`: its own craft arrives through its profile's grants
 * (mounted below on Claude, injected as prompt text on Codex).
 *
 * `.claude` is TRACKED in many repos (incl. viberr itself: launch.json, skills,
 * submodule gitlinks), and delivery auto-commits the working tree with `git add
 * -A` (push-workspace.server). A plain `rm -rf` would therefore ship a `.claude`
 * DELETION into the review PR. We first mark every tracked `.claude` path
 * `--skip-worktree`: git then treats the absent files as unchanged, `git add -A`
 * never stages the deletion, and the committed tree keeps `.claude` from the
 * index. (A run whose task is to edit the repo's own `.claude` cannot deliver
 * those edits — the intended governance posture, not a bug.)
 */
export async function stripUngovernedRepoCatalog(repoDir: string): Promise<void> {
  const catalog = path.join(repoDir, ".claude");
  if (!existsSync(catalog)) return;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoDir, "ls-files", "-z", "--", ".claude"],
      { timeout: 10_000 },
    );
    const tracked = stdout.split("\0").filter(Boolean);
    if (tracked.length) {
      await execFileAsync(
        "git",
        ["-C", repoDir, "update-index", "--skip-worktree", "--", ...tracked],
        { timeout: 10_000 },
      );
    }
  } catch (error) {
    // Non-fatal: governance still wins — we strip the catalog regardless. The
    // worst case of a skip-worktree failure is a `.claude` deletion surfacing in
    // the delivery diff for a human to notice, never a silent catalog leak.
    logger.warn("could not skip-worktree repo .claude before stripping", {
      repoDir,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  rmSync(catalog, { recursive: true, force: true });
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

/** What a workspace mount produced. */
export interface SkillMount {
  /** Exact names the SDK will discover — pass these as `options.skills`. */
  mounted: string[];
  /** Granted skills that did NOT mount, with the reason (they fall back to
   *  prompt-text injection, so this is diagnostic, not capability loss). */
  skipped: { name: string; reason: string }[];
}

/** No checkout ⇒ no project source we control ⇒ no native skills (see below). */
const NO_WORKSPACE_REASON =
  "this run has no git checkout to mount skills into (Viberr injects it as prompt text instead)";

/**
 * Copy each GRANTED skill from the store into `<workspace>/.claude/skills/<name>`
 * so the Claude Agent SDK discovers it natively.
 *
 * WHY A WORKSPACE MOUNT AND NOT A SETTINGS DIR: the SDK's `settingSources:
 * ['project']` source is `<cwd>/.claude` plus every parent UP TO THE REPO ROOT.
 * The run's cwd is the task's workspace CHECKOUT, whose root is that repo root —
 * so the walk stops inside a directory Viberr just rewrote and cannot reach the
 * data root, let alone a host repo above it (the F13 leak: `docker-data/` lives
 * INSIDE the viberr checkout on a dev machine, so a cwd that is not itself a
 * repo root could walk straight into the host's `.claude`). That is why this
 * refuses to mount anywhere that is not a plain git checkout: the isolation
 * guarantee and the enable-switch are the same fact. A run with no checkout
 * keeps prompt-text injection, which is exactly today's behaviour.
 *
 * NEVER SHIPPED: `.claude/` is appended to the checkout's `.git/info/exclude`
 * (repo-local, never committed, and it takes effect for the agent's own commits
 * as well as viberr's `git add -A` delivery finalization).
 *
 * Returns the mounted names — the caller passes exactly these to the SDK and
 * suppresses their prompt-text injection.
 */
export async function mountGrantedSkills(input: {
  /** The run's git checkout (`clone.dir`), or null when it has none. */
  workspaceDir: string | null;
  /** The profile's GRANTED skill names, in declaration order. */
  skills: readonly string[];
  dataRoot?: string;
}): Promise<SkillMount> {
  const names = [...new Set(input.skills)];
  if (names.length === 0) return { mounted: [], skipped: [] };
  const dir = input.workspaceDir;
  if (!dir || !isPlainGitCheckout(dir)) {
    return {
      mounted: [],
      skipped: names.map((name) => ({ name, reason: NO_WORKSPACE_REASON })),
    };
  }

  // Strip FIRST, every run (fresh clone AND resume): the repo may ship its own
  // `.claude`, and a previous run on this same workspace may have written one —
  // including a `settings.json`, whose hooks the project setting source would
  // execute. After this line the catalog holds only what the loop below writes.
  await stripUngovernedRepoCatalog(dir);
  excludeCatalogFromDelivery(dir);

  const skillsRoot = path.join(dir, ".claude", "skills");
  const mounted: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const name of names) {
    const reason = mountOneSkill(name, skillsRoot, input.dataRoot);
    if (reason) skipped.push({ name, reason });
    else mounted.push(name);
  }
  if (mounted.length === 0) {
    // Leave the workspace exactly as a skill-less run would find it.
    rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
  }
  if (skipped.length > 0) {
    logger.warn("granted skills did not mount natively — injected as prompt text", {
      workspaceDir: dir,
      skipped,
    });
  }
  return { mounted, skipped };
}

/** A plain checkout (`.git` is a real directory) — not a worktree/submodule
 *  pointer file, and not a bare directory that git never created. */
function isPlainGitCheckout(dir: string): boolean {
  try {
    return lstatSync(path.join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

const EXCLUDE_ENTRY = ".claude/";

/**
 * Keep the mounted catalog out of every commit.
 *
 * `.git/info/exclude` is the repo-LOCAL ignore file: it is not a tracked file,
 * so it can never itself appear in the review PR, and it binds `git add -A`
 * (viberr's delivery finalization) and the agent's own `git add`/`git status`
 * alike. A `.gitignore` edit would have been delivered as a change to the repo.
 */
function excludeCatalogFromDelivery(repoDir: string): void {
  const infoDir = path.join(repoDir, ".git", "info");
  const file = path.join(infoDir, "exclude");
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {
    // No exclude file yet (a fresh `git init` usually writes one; a clone may
    // not) — we create it below.
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === EXCLUDE_ENTRY)) {
    return; // idempotent: every run re-mounts, the entry is written once
  }
  try {
    mkdirSync(infoDir, { recursive: true });
    const gap = current === "" || current.endsWith("\n") ? "" : "\n";
    writeFileSync(
      file,
      `${current}${gap}# Viberr: the run's granted skills are mounted here — never deliver them.\n${EXCLUDE_ENTRY}\n`,
    );
  } catch (error) {
    logger.warn("could not exclude the mounted .claude from delivery", {
      repoDir,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}

/** Copy one skill folder; returns null on success or the reason it did not. */
function mountOneSkill(
  name: string,
  skillsRoot: string,
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
    cpSync(src, dest, {
      recursive: true,
      force: true,
      dereference: false,
      filter: copyableEntry,
    });
    const { data, body } = splitFrontmatter(readFileSync(resolved.file, "utf8"));
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
    writeFileSync(
      path.join(dest, "SKILL.md"),
      serializeFrontmatterFile(
        { name, description: skillDescription(name, data, body) },
        {},
        body,
      ),
    );
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    logger.warn("granted skill could not be mounted into the run workspace", {
      skill: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return "its files could not be copied into the run's workspace";
  }
  return null;
}

/** Refuse symlinks (they leave the store) and nested `.git` dirs (an imported
 *  skill folder carrying one would turn the workspace into nested repos). */
function copyableEntry(src: string): boolean {
  if (path.basename(src) === ".git") return false;
  try {
    return !lstatSync(src).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The one-line description the model reads when deciding to invoke a skill. */
function skillDescription(name: string, data: unknown, body: string): string {
  const declared =
    data && typeof data === "object"
      ? (data as { description?: unknown }).description
      : undefined;
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ?? "";
  const text = (
    (typeof declared === "string" ? declared.trim() : "") ||
    firstLine ||
    `The ${name} skill attached to this agent's Viberr profile.`
  )
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
}
