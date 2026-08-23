import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
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
 *
 * ONE workspace, MANY runs (F19-15). The checkout is per TASK, not per run, and
 * every engagement on that task shares it. See {@link MOUNT_MARK} for why the
 * strip is surgical rather than a `rm -rf`.
 */

const execFileAsync = promisify(execFile);

/**
 * F19-15 — the proof that VIBERR mounted a skill folder, in THIS process.
 *
 * The bug this closes: the workspace checkout belongs to the TASK, so a second
 * run starting while the first is still executing re-ran the strip over a live
 * run's `.claude` and deleted the skills it had just mounted. The first run kept
 * going with its granted craft silently gone — no error, no event, nothing a
 * human could see. Skills only WERE mounted natively from R18-5 onward, which is
 * what turned R18-3's strip from harmless into destructive.
 *
 * Why preservation and not a lock. Serializing strip+mount per workspace would
 * only shrink the window: run A holds its skills for its whole RUN (minutes),
 * not for the duration of its mount (milliseconds), and no mutex around the
 * mount can span that. The unmount has to become impossible, so the strip must
 * be able to tell Viberr's own mounts from everything else and keep them.
 *
 * Why a per-process random mark and not a fixed filename. `.claude` arrives from
 * an UNTRUSTED clone — a repository that shipped `.claude/skills/x/<marker>`
 * with a guessable value would survive the strip and re-open exactly the R18-3
 * leak. The mark is minted once per process and never leaves it, so no repo (and
 * no leftover from a previous process, whose runs are dead anyway) can forge it.
 *
 * What preservation does NOT weaken: only `.claude/skills/<name>/` folders this
 * process wrote survive. Everything else — `settings.json` and its hooks,
 * `commands/`, `agents/`, repo-authored skills — is still deleted on every run.
 * And a preserved folder is not usable by a run that did not mount it: the
 * adapter passes the SDK `skills: [<exactly this run's mounted names>]`, which
 * rejects every unlisted skill, and a run that mounted nothing gets
 * `settingSources: []` with the `Skill` tool denied outright
 * (claude-runtime.server:596-665). The allow-list is the fence — never the
 * directory listing.
 *
 * ACCEPTED RESIDUAL, stated rather than hidden: this module cannot tell a
 * FINISHED run's mount from a live one, so a mount is never collected — a
 * profile's skill folders stay readable in a co-engaged agent's cwd for the life
 * of the workspace. Not invokable (see above), and supporting runs already share
 * the delivering run's entire working tree, but not nothing. Collecting them
 * needs run liveness, which lives in `agent_runs` and would have to be passed in
 * by the caller (a mount ledger under `.git/` keyed by profile id, reconciled
 * against `running|queued` rows — the design in
 * `planning/discovery-2026-08-06-pass19/spec-skill-mount-race.md`). That is a
 * signature change through `mountGrantedSkills` and `cloneRepo`; this fix stays
 * inside the module. Losing a live run's craft is the harm that had to stop.
 */
const MOUNT_MARK = `viberr-skill-mount ${randomUUID()}`;
const MOUNT_MARK_FILE = ".viberr-mount";
/** A forged mark can only ever be as long as ours; never read more than that. */
const MOUNT_MARK_MAX_BYTES = 256;

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
 *
 * F19-15: the ONE thing it does not delete is a skill folder THIS process
 * mounted ({@link MOUNT_MARK}) — those belong to a run that may still be using
 * them. Everything else in the catalog goes, on every call.
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
  const ours = ownMountedSkillNames(catalog);
  if (ours.length === 0) {
    // Nothing of ours is in there — the R18-3 behaviour, unchanged.
    rmSync(catalog, { recursive: true, force: true });
    return;
  }
  // A live run's skills are in here. Take out everything else BY NAME rather
  // than deleting and re-creating: another run is reading these files right now,
  // so there must be no window in which they are absent.
  for (const entry of readdirSync(catalog)) {
    if (entry !== "skills") {
      rmSync(path.join(catalog, entry), { recursive: true, force: true });
    }
  }
  const skillsRoot = path.join(catalog, "skills");
  for (const entry of readdirSync(skillsRoot)) {
    if (!ours.includes(entry)) {
      rmSync(path.join(skillsRoot, entry), { recursive: true, force: true });
    }
  }
}

/**
 * The `.claude/skills` entries THIS process mounted — the only survivors of a
 * strip (F19-15). Anything unreadable, symlinked, or carrying a mark we did not
 * write is NOT ours and is reported as such, so the caller deletes it.
 */
function ownMountedSkillNames(catalogDir: string): string[] {
  const skillsRoot = path.join(catalogDir, "skills");
  try {
    // `lstat`, so a `.claude/skills` SYMLINK (a repo pointing the catalog at
    // some other tree) is never walked — it reads as "nothing of ours", and the
    // whole catalog is removed.
    if (!lstatSync(skillsRoot).isDirectory()) return [];
    return readdirSync(skillsRoot).filter((name) =>
      isOwnMountedSkill(path.join(skillsRoot, name)),
    );
  } catch {
    return [];
  }
}

function isOwnMountedSkill(skillDir: string): boolean {
  try {
    if (!lstatSync(skillDir).isDirectory()) return false;
    const mark = path.join(skillDir, MOUNT_MARK_FILE);
    const stat = lstatSync(mark);
    if (!stat.isFile() || stat.size > MOUNT_MARK_MAX_BYTES) return false;
    return readFileSync(mark, "utf8").trim() === MOUNT_MARK;
  } catch {
    return false;
  }
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
    // Leave the workspace exactly as a skill-less run would find it — but go
    // back through the strip rather than `rm -rf`ing the catalog, so a
    // CONCURRENT run's mounts survive our failure to mount anything (F19-15).
    // With no live mounts present this deletes the whole `.claude`, as before.
    await stripUngovernedRepoCatalog(dir);
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
    // C10.5: non-fatal on purpose (a broken exclude write must not abort the
    // run), but this is a real delivery-safety gap, not routine noise — with
    // no working `.git/info/exclude` entry, the mounted `.claude/skills`
    // catalog is NOT git-ignored, so a later `git add -A` (viberr's delivery
    // finalization, or the agent's own commit) can sweep the granted skill
    // folders into the PR. Keep this at WARN and name the risk explicitly so
    // it is findable in the run log rather than reading as a generic I/O
    // warning. A cheap follow-up (out of scope here, would need a
    // `mountGrantedSkills`/`SkillMount` shape change every caller picks up)
    // would be to return an `excluded: boolean` flag so a caller could refuse
    // delivery or surface this to a human instead of only logging it.
    logger.warn(
      "could not write .git/info/exclude — the mounted skill catalog is NOT git-ignored and may be swept into the delivered PR",
      {
        repoDir,
        excludeFile: file,
        err: error instanceof Error ? error : new Error(String(error)),
      },
    );
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
  // Is another run of this process already using a mount under this name? Same
  // process ⇒ same store ⇒ `name` resolves to the same folder, so re-copying
  // over it is a no-op in content. What must NOT happen is the failure path
  // below deleting a mount that is not ours to delete (F19-15).
  const liveMount = isOwnMountedSkill(dest);
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
    writeFileSync(
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
    // LAST — the mark is what makes this folder survive the next run's strip
    // (F19-15), so it is only written once the mount is complete. A half-copied
    // folder stays unmarked and is cleaned up like repo content.
    writeFileSync(path.join(dest, MOUNT_MARK_FILE), `${MOUNT_MARK}\n`);
  } catch (error) {
    // Only clean up a mount we were CREATING. If this name was already mounted
    // for another live run, removing it would be the very silent unmount F19-15
    // closes — and a partial re-copy of the identical store folder is strictly
    // better than no folder at all. This run falls back to prompt-text
    // injection either way, because we return a reason below.
    if (!liveMount) rmSync(dest, { recursive: true, force: true });
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

/**
 * The only frontmatter key a store file gets to keep (see the NORMALIZE note in
 * `mountOneSkill`). `.catch(undefined)` so a non-string `description` falls back
 * to the body's first line instead of failing the whole parse.
 */
const skillFrontmatterSchema = z.object({
  description: z.string().optional().catch(undefined),
});

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
