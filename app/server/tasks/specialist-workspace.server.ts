/**
 * A specialist run's working copy (ruling 656): the task workspace and the
 * clone of the project's repository in it (with the support checkout), the
 * run's environment, and the agent's git identity.
 */

import type { ReviewSubject } from "~/shared/revision-drift";
import {
  describeWorkspaceRefresh,
  refreshWorkspaceFromMirror,
  type WorkspaceRefreshInput,
} from "./workspace-refresh.server";
import { existsSync, mkdirSync } from "node:fs";
import {
  type AgentLaunch,
  shareDirWithAgentsOrWarn,
} from "~/server/runtimes/agent-isolation.server";
import { removeAgentTree } from "~/server/runtimes/agent-trees.server";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  taskWorkspaceGit,
  type WorkspaceGit,
  workspaceGitWhenIsolationOff,
} from "./workspace-git.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { stripUngovernedRepoCatalog } from "~/server/runtimes/skill-mount.server";
import { logger } from "~/server/logging/logger.server";
import { getPatToken, getProjectCredential } from "~/server/secrets/pat-store.server";
import { countLabel } from "~/shared/text/plural";
import {
  type CloneCredential,
  type CloneFailureLogDetails,
  cloneFailureLogDetails,
  cloneFailureSentence,
  cloneTimeoutMs,
  githubRemoteSanitizationArgs,
  WorkspaceFault,
  workspaceStep,
} from "./git-clone-auth.server";
import { cloneWorkspaceRepo, type WorkspaceCloneInput } from "./repo-mirror.server";
import type { TaskMutationContext } from "./task-mutation.server";
import { toError } from "~/shared/errors";

export function projectRepo(ctx: TaskMutationContext, projectSlug: string): string | null {
  const file = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
  });
  return file?.parsed.frontmatter.repo ?? null;
}

/** Keep every specialist cwd below the task workspace and Git discovery ceiling. */
export function taskWorkspaceRoot(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
): string {
  return path.join(taskDir(projectSlug, taskKey, dataRoot), "workspace");
}

/**
 * Where this task's checkout lives — `<taskDir>/workspace/<repo-name>` — or null
 * when the project has no repo. Same derivation `cloneRepo` and `resumeWorkdir`
 * use; the caller (the mount) verifies it is really a checkout, so an unclonded
 * or wiped workspace resolves to "no native skills", never to a stray directory.
 */
export function taskCloneDir(
  ctx: TaskMutationContext,
  projectSlug: string,
  taskKey: string,
  support?: { profileId: string },
): string | null {
  const repo = projectRepo(ctx, projectSlug);
  if (!repo) return null;
  const name = repo.split("/").pop() ?? repo;
  return supportCheckoutDir(
    taskWorkspaceRoot(projectSlug, taskKey, ctx.dataRoot),
    name,
    support,
  );
}

/**
 * P8 (pass 25): per-engagement workspace isolation. The DELIVERING engagement
 * owns the canonical checkout `<workspaceRoot>/<repo>` — the tree delivery's
 * `git add -A` ships (push-workspace), the operator reads, and evidence paths
 * resolve against. Every SUPPORTING (non-delivering) engagement gets its OWN
 * checkout at `<workspaceRoot>/support/<profileId>/<repo>`, so a supporting run's
 * writes — allowed there when its grants allow them (ruling 101(b)), bound by
 * Claude's denylist when they do not, and by this isolation on either backend —
 * can NEVER
 * reach the delivering tree or be swept into the delivered PR (the F-P8
 * governance hole). Keyed by engagement (profileId), so it is
 * reused across that engagement's runs and stays bounded; retention removes it
 * with the rest of `workspace/` when the task reaches its terminal stage.
 */
function supportCheckoutDir(
  workspaceRoot: string,
  repoName: string,
  support?: { profileId: string },
): string {
  return support
    ? path.join(workspaceRoot, "support", support.profileId, repoName)
    : path.join(workspaceRoot, repoName);
}

// NOTE: agent runs are NO LONGER handed push credentials — delivery is
// server-side for both backends (see the delivery-contract comment in
// `dispatchAgentRun`, behind `startAgentRun`). The GIT_ASKPASS push credential
// now lives ONLY in the server-side `pushWorkspaceBranch`
// (push-workspace.server), whose process env is token-safe and
// backend-agnostic.

export function workspaceRunEnv(
  projectSlug: string,
  taskKey: string,
  dataRoot?: string,
) {
  // The ceiling must be a STRICT ANCESTOR of the run cwd — `GIT_CEILING` only
  // blocks git from ascending INTO a listed dir, so a ceiling EQUAL to cwd is a
  // no-op (git's first step up lands in the ceiling's unblocked parent). The
  // empty-workspace run has cwd == the workspace root, so we pin the ceiling to
  // the TASK dir (its parent). That stops git-repo discovery for BOTH cwd
  // shapes — `<taskDir>/workspace` (empty) and `<taskDir>/workspace/<repo>`
  // (cloned) — before it can reach a host `.git` above the data root
  // (adversarial-review HIGH #2).
  const ceiling = taskDir(projectSlug, taskKey, dataRoot);
  return {
    GIT_CEILING_DIRECTORIES: ceiling,
  } satisfies Record<string, string>;
}

/** The git author/committer every commit on a task carries, whichever backend
 *  and whichever profile made it. */
export interface AgentGitIdentity {
  name: string;
  email: string;
}

/** F24 — one delivery identity across BOTH backends. Codex commits with the
 * host's git identity and Claude sets its own, so the same task's commits landed
 * under three different authors. Force every commit the agent makes to the
 * delivering profile identity via the GIT_AUTHOR / GIT_COMMITTER env vars (these
 * override any `git config` the agent sets), matched by the repo config set at
 * clone (for viberr's server-side auto-commit) — so from Viberr's eye codex and
 * claude are indistinguishable in the git history. */
export function agentGitIdentity(profileId: string): AgentGitIdentity {
  return { name: profileId, email: `${profileId}@viberr.local` };
}

export function agentGitIdentityEnv(profileId: string) {
  const { name, email } = agentGitIdentity(profileId);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  } satisfies Record<string, string>;
}

/** Why a workspace checkout is missing — carried to the prompt and the human. */
export interface CloneFailure extends CloneFailureLogDetails {
  /** Ruling 249: what part a credential played — supplied, absent, or not
   *  involved at all (the local arm never reaches GitHub). */
  credential: CloneCredential;
  /** One plain sentence, safe to show a human and to put in a prompt. */
  sentence: string;
  /**
   * F19-6: git's OWN complaint, redacted and truncated. `sentence` classifies
   * the failure ("git exit 128"); this is the only channel that says WHY —
   * exit 128 covers auth rejection, a missing remote, DNS, a proxy and an LFS
   * hook alike, and live (VC-3) the human had a working credential, a repo that
   * cloned from a shell, and nothing to act on. Absent when git printed
   * nothing usable.
   */
  stderrExcerpt?: string;
}

interface CloneOutcome {
  /** The checkout directory, or null when the run has no working tree. */
  dir: string | null;
  failure?: CloneFailure;
  /** Ruling 129 (pass 34, Q34-5): what the pre-run refresh did to a REUSED
   *  checkout, in the words `describeWorkspaceRefresh` gives it. Absent on a
   *  fresh clone (nothing to refresh: it was just built from the mirror). */
  refreshed?: string;
}

// `stripUngovernedRepoCatalog` (R18-3 / F18-8) lives in
// ~/server/runtimes/skill-mount.server: stripping the repo's `.claude` and
// mounting Viberr's granted skills (as a plugin beside the checkout, ruling
// 180) are two halves of one rule — a governed run sees what its profile
// grants and nothing else — and keeping them together is what lets the mount
// guarantee it on its own.

/** Ruling 129: the branch a reused checkout is refreshed against — the
 *  project's own default, read from project.md like every other caller. */
function defaultBranchForRefresh(input: { projectSlug: string; dataRoot?: string }): string {
  const ref = input.dataRoot
    ? { projectSlug: input.projectSlug, dataRoot: input.dataRoot }
    : { projectSlug: input.projectSlug };
  return readProjectFile(ref)?.parsed.frontmatter.defaultBranch || "main";
}

/**
 * Ruling 179 (pass 36): detach a SUPPORTING checkout at the task's revision
 * under review when the commit is present (the fetch-only refresh brings
 * `origin/<branch>` — and with it an external revision — into the clone).
 * Returns the disclosure sentence, or null when there was nothing to pin.
 * Never throws: a reviewer that cannot be pinned still runs, and the
 * disclosure says the revision is missing.
 *
 * Exported for its test: the behaviour is real git, not a string. Pass 40
 * review (R-seams-1): the git runs as the task's person (`git`); with no
 * person to name and isolation on, nothing is pinned and the sentence says so.
 */
export async function pinSupportCheckout(
  dir: string,
  subject: ReviewSubject | null,
  git: WorkspaceGit | null = workspaceGitWhenIsolationOff(),
): Promise<string | null> {
  const sha = subject?.sha ?? null;
  if (!sha) return null;
  const short = sha.slice(0, 7);
  // Ruling 238: when the subject moved past the reviewed revision, every
  // sentence below has to say so. A reviewer told only "checked out at the
  // revision under review" while standing on a different commit would report
  // against a sha it never read, and the record would be a lie with a git
  // object id in it.
  const what = subject?.rePinned
    ? `the reviewed revision \`${subject.rePinned.reviewedSha.slice(0, 7)}\` on its refreshed base, at \`${short}\` (${countLabel(subject.rePinned.baseRefresh.merges, "merge commit")}, ${countLabel(subject.rePinned.baseRefresh.commits, "base commit")}, and no authored work since the review; ruling 238)`
    : `the revision under review \`${short}\``;
  if (!git) return `${what} could not be checked out; HEAD was left as it is`;
  try {
    await git.run(["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { timeoutMs: 5_000 });
  } catch {
    logger.warn("support checkout: the revision under review is not in the clone; HEAD was left as it is", {
      dir,
      revision: sha,
    });
    return `${what} is not in this checkout (origin has not been read since it appeared); HEAD was left as it is`;
  }
  try {
    const head = (await git.run(["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 5_000 })).stdout.trim();
    if (head === sha) return `checked out at ${what}`;
    await git.run(["-C", dir, "checkout", "-q", "--detach", sha], { timeoutMs: 30_000 });
    return `detached at ${what} (the delivering tree stood at \`${head.slice(0, 7)}\`)`;
  } catch (error) {
    logger.warn("support checkout: could not detach at the revision under review", {
      dir,
      revision: sha,
      err: toError(error),
    });
    return `${what} could not be checked out; HEAD was left as it is`;
  }
}

export async function cloneRepo(
  db: DatabaseSync,
  input: {
    projectSlug: string;
    taskKey: string;
    repo: string;
    dataRoot?: string;
    /** F24: the delivering profile identity to stamp on the workspace's git
     *  config, so viberr's server-side auto-commit (push-workspace) attributes
     *  to the same author as the agent's own commits. */
    identity?: { name: string; email: string };
    /** P8 (pass 25): a SUPPORTING engagement's isolated checkout, keyed by its
     *  profileId — `workspace/support/<profileId>/<repo>` instead of the
     *  delivering engagement's canonical `workspace/<repo>`. See
     *  {@link supportCheckoutDir}. */
    support?: { profileId: string };
    /** F27-U1: 0..1 progress for a cold network clone, so the caller can drive a
     *  live percentage onto the run strip. */
    onCloneProgress?: (fraction: number) => void;
    /** Ruling 179 (pass 36): the task's active work revision. A SUPPORTING
     *  checkout is detached at it when it is present after the refresh — a
     *  reviewer judges the revision under review, not the delivering tree's
     *  head, and a sandboxed Codex run could not move `.git` itself (the CLI
     *  kept it read-only until ruling 185). Live (HLC-18, 19:46Z): the
     *  external revision the reconciler minted was never in the reviewer's
     *  clone of the delivering tree, and the reviewer could not check it out. */
    pinSubject?: ReviewSubject | null;
    /** Ruling 179: the task branch, for the delivering refresh's fast-forward
     *  to origin's copy (`refreshWorkspaceFromMirror`). */
    taskBranch?: string | null;
  },
): Promise<CloneOutcome> {
  // Ruling 249: `absent` until an arm proves otherwise — the local arm sets
  // `not_involved` because it never reaches GitHub (ruling 485: before its
  // first step), the network arm sets `supplied` when a token was actually
  // handed to git, and a workspace fault in either arm is `not_involved`.
  let credential: CloneCredential = "absent";
  // F19-6: hoisted out of the try so the catch can scrub it BY VALUE. The token
  // never reaches argv or the remote URL (askpass env only), so this literal
  // scrub plus the userinfo patterns is the whole redaction surface.
  let token: string | null = null;
  // Pass 40 review (R-seams-1): every git in the checkout — the supporting
  // clone of the delivering tree, the origin rewrite, the identity, the
  // strip, the refresh, the pin — runs as the task's person, never as the
  // server. Resolved lazily so a refusal lands in the catch below.
  let workspaceGit: WorkspaceGit | null = null;
  const personGit = (): WorkspaceGit => {
    workspaceGit ??= taskWorkspaceGit(db, {
      projectSlug: input.projectSlug,
      taskKey: input.taskKey,
      dataRoot: input.dataRoot,
    });
    return workspaceGit;
  };
  const setIdentity = async (dir: string) => {
    if (!input.identity) return;
    try {
      await personGit().run(["-C", dir, "config", "user.name", input.identity.name], { timeoutMs: 5_000 });
      await personGit().run(["-C", dir, "config", "user.email", input.identity.email], { timeoutMs: 5_000 });
    } catch {
      // Non-fatal: the run env's GIT_AUTHOR_*/GIT_COMMITTER_* still stamps the
      // agent's own commits; this only benefits the server-side auto-commit.
    }
  };
  // Ruling 485: every LOCAL step — removing or replacing a tree, making a
  // directory, cloning the delivering checkout, rewriting its origin,
  // stripping `.claude` — fails as a workspace fault that names what failed,
  // the path and the OS error (`workspaceStep`). The catch below then says
  // `not_involved`: live on WEB-5 a replace that died on an agent's 0700
  // directory was logged `credential: absent`, and the operator asked the
  // owner for a credential.
  const local = workspaceStep;
  // Ruling 485: a clone that did not finish leaves no tree behind. Removing
  // one is best effort here — its failure is logged, never thrown over the
  // clone's own — and the next run's check below removes what is left.
  const clearUnfinished = async (dir: string, person: AgentLaunch | null) => {
    if (existsSync(path.join(dir, ".git", "HEAD"))) return;
    try {
      await removeAgentTree(dir, person);
    } catch (error) {
      logger.warn("an unfinished checkout could not be removed as its person; the next run removes it", {
        dir,
        err: toError(error),
      });
    }
  };
  try {
    const name = input.repo.split("/").pop() ?? input.repo;
    const workspaceRoot = taskWorkspaceRoot(
      input.projectSlug,
      input.taskKey,
      input.dataRoot,
    );
    const dir = supportCheckoutDir(workspaceRoot, name, input.support);
    // Ruling 485: whom a tree in this workspace is removed as — the task's
    // person, as its git runs; null is the server's own user (isolation off).
    // With isolation on and nobody to name, that is the first local fault.
    const person = await local(`\`${workspaceRoot}\` has no person to work in it as`, () => personGit().launch);

    // P8 (pass 25): a SUPPORTING run gets its OWN checkout, but it must still
    // contain the TASK BRANCH to review the delivering agent's work — and that
    // branch is a LOCAL branch the delivering agent created in the canonical
    // checkout, which the shared mirror does not have until a push. So clone the
    // isolated support checkout FROM the delivering checkout when one exists: a
    // fast `--local` clone that carries the branch and its commits, made FRESH
    // each run (removed and re-cloned) so a re-review never reads a stale tree.
    // origin is re-pointed at GitHub afterwards; the run is read-only here, so
    // nothing it writes can reach the delivering tree or the delivered PR.
    if (input.support) {
      const deliveringDir = supportCheckoutDir(workspaceRoot, name);
      const fromDelivering = existsSync(path.join(deliveringDir, ".git"));
      // Ruling 249, fixed BEFORE any local step (ruling 485): a checkout cloned
      // from the delivering one never reaches GitHub, so no credential is
      // involved from the start. It used to be set after the removal below,
      // so the removal's own failure went out as `credential: absent`.
      if (fromDelivering) credential = "not_involved";
      // Ruling 485: the previous review's tree is the agents' — a tool they ran
      // can leave directories only its uid can enter (wrangler's 0700 temp
      // dirs, F40-62) — so it is replaced as its person, never by the
      // server's own recursive remove, which died half-way and left a tree
      // with no `.git` that every later review tripped over.
      await local(`\`${dir}\` could not be replaced`, () => removeAgentTree(dir, person));
      if (fromDelivering) {
        // Ruling 460: the checkout is edited by agents running as their own
        // users; what is created below the shared root stays in the agent
        // group.
        await local(`\`${path.dirname(dir)}\` could not be created`, () => {
          shareDirWithAgentsOrWarn(workspaceRoot);
          mkdirSync(path.dirname(dir), { recursive: true });
        });
        try {
          // Pass 40 review (R-seams-2): through git's own transport, never
          // `--local`. Under ruling 460 the delivering checkout's objects are
          // written by an agent uid, and `--local` HARDLINKS them — the
          // kernel's `fs.protected_hardlinks` refuses a link to a file the
          // server neither owns nor can write, so every supporting run after
          // the first agent commit lost its checkout. `--no-local` also never
          // trusts that agent-writable directory's layout on disk (git refuses
          // a symlinked object with `--local` for the same reason).
          // R-seams-1: and as the task's person, never the server — the
          // delivering checkout is agent-written, so reading it is theirs.
          await local(`\`${dir}\` could not be cloned from the delivering checkout \`${deliveringDir}\``, () =>
            personGit().run(["clone", "--no-local", deliveringDir, dir], {
              timeoutMs: cloneTimeoutMs(),
            }),
          );
          await local(`the origin of \`${dir}\` could not be rewritten`, () =>
            personGit().run(githubRemoteSanitizationArgs(input.repo, dir), {
              timeoutMs: 10_000,
            }),
          );
          // Ruling 129: the supporting checkout keeps its fetch-only refresh,
          // now through the SAME function the delivering one uses.
          const supportRefresh: WorkspaceRefreshInput = {
            projectSlug: input.projectSlug,
            repo: input.repo,
            dir,
            defaultBranch: defaultBranchForRefresh(input),
            fastForward: false,
            taskKey: input.taskKey,
          };
          if (input.dataRoot) supportRefresh.dataRoot = input.dataRoot;
          await local(`\`${dir}\` could not be refreshed`, () => refreshWorkspaceFromMirror(db, supportRefresh));
          await setIdentity(dir);
          await local(`\`${path.join(dir, ".claude")}\` could not be removed`, () =>
            stripUngovernedRepoCatalog(dir, personGit()),
          );
          const pinned = await pinSupportCheckout(dir, input.pinSubject ?? null, personGit());
          return pinned ? { dir, refreshed: pinned } : { dir };
        } finally {
          await clearUnfinished(dir, person);
        }
      }
      // No delivering checkout yet — nothing has been delivered to review. Fall
      // through to a normal mirror clone (default branch) in the isolated dir.
    }
    // Ruling 485 (3): a checkout with no `.git/HEAD` is no checkout — a clone
    // killed mid-way, or a tree an older build's server-side remove left
    // half-removed. Left in place it is read as "already cloned" or blocks the
    // clone into its path on every run after, so it is removed as its person
    // here and cloned again below.
    if (existsSync(dir) && !existsSync(path.join(dir, ".git", "HEAD"))) {
      logger.warn("a checkout with no .git/HEAD is removed as its person and cloned again", {
        taskKey: input.taskKey,
        dir,
      });
      await local(`\`${dir}\` has no \`.git/HEAD\` and could not be removed`, () => removeAgentTree(dir, person));
    }
    if (existsSync(path.join(dir, ".git"))) {
      // Already cloned for this task — scrub URLs produced by older Viberr
      // versions before reuse. `--replace-all` removes every prior origin URL,
      // including a legacy `x-access-token:<PAT>@github.com` value.
      await local(`the origin of \`${dir}\` could not be rewritten`, () =>
        personGit().run(githubRemoteSanitizationArgs(input.repo, dir), {
          timeoutMs: 10_000,
        }),
      );
      await setIdentity(dir);
      // This is the reuse path, so a run may ALREADY be executing in this
      // workspace. Its skills live in its own plugin beside the checkout
      // (ruling 180), so stripping the repo's `.claude` here takes nothing
      // from it.
      await local(`\`${path.join(dir, ".claude")}\` could not be removed`, () =>
        stripUngovernedRepoCatalog(dir, personGit()),
      );
      // Ruling 129 (pass 34, Q34-5): THIS is the stale-checkout window. A
      // workspace cloned once, from a repository that was still empty, was
      // reused as it stood by every later run — agents hold no credential, so
      // they could not fetch — and the spec writers committed unrelated root
      // commits while the operator read a bootstrapped `main` through the
      // mirror. Refresh `origin/*` from the mirror before the run starts, and
      // fast-forward only a checkout that is unborn or clean on the default
      // branch. A failure degrades with a warning: a cache never blocks a task.
      // A supporting checkout keeps its fetch-only refresh (pass 32, C32-2),
      // now through this same function.
      const refreshInput: WorkspaceRefreshInput = {
        projectSlug: input.projectSlug,
        repo: input.repo,
        dir,
        defaultBranch: defaultBranchForRefresh(input),
        fastForward: !input.support,
        taskBranch: input.taskBranch ?? null,
        taskKey: input.taskKey,
      };
      if (input.dataRoot) refreshInput.dataRoot = input.dataRoot;
      const refresh = await refreshWorkspaceFromMirror(db, refreshInput);
      const described = describeWorkspaceRefresh(refresh, defaultBranchForRefresh(input));
      if (refresh.status === "fetch_failed" || refresh.status === "no_mirror") {
        logger.warn("workspace refresh degraded; the run proceeds on the checkout as it stands", {
          projectSlug: input.projectSlug,
          taskKey: input.taskKey,
          repo: input.repo,
          detail: described,
        });
      }
      return described ? { dir, refreshed: described } : { dir };
    }
    await local(`\`${path.dirname(dir)}\` could not be created`, () => {
      shareDirWithAgentsOrWarn(workspaceRoot);
      mkdirSync(path.dirname(dir), { recursive: true });
    });

    const cred = getProjectCredential(db, input.projectSlug);
    token = cred ? getPatToken(db, cred.id) : null;
    credential = token ? "supplied" : "absent";
    try {
      // R21-4: through the project's mirror cache — the FIRST task in a project
      // pays the network clone, the rest are hardlinked from it in seconds. Any
      // cache trouble falls back to a direct GitHub clone inside this call.
      const cloneInput: WorkspaceCloneInput = {
        projectSlug: input.projectSlug,
        repo: input.repo,
        destination: dir,
        token,
        // Ruling 485: a destination in the clone's way is removed as the
        // task's person.
        person,
      };
      if (input.dataRoot) cloneInput.dataRoot = input.dataRoot;
      if (input.onCloneProgress) cloneInput.onCloneProgress = input.onCloneProgress;
      await cloneWorkspaceRepo(cloneInput);
      await setIdentity(dir);
      await local(`\`${path.join(dir, ".claude")}\` could not be removed`, () =>
        stripUngovernedRepoCatalog(dir, personGit()),
      );
      // Ruling 179: a supporting run that reached here (no delivering checkout
      // to clone from) still judges the revision under review when the fresh
      // clone carries it.
      const freshPin = input.support
        ? await pinSupportCheckout(dir, input.pinSubject ?? null, personGit())
        : null;
      return freshPin ? { dir, refreshed: freshPin } : { dir };
    } finally {
      // A clone killed mid-transfer can leave a partial tree behind. Left in
      // place it is worse than nothing: the next run's `.git` check treats it as
      // "already cloned for this task" and hands the agent a truncated checkout
      // it has no way to recognise as incomplete.
      await clearUnfinished(dir, person);
    }
  } catch (error) {
    // Ruling 485: a local step's fault never involved a credential, whichever
    // arm it happened in — and a network clone's failure keeps the credential
    // state its arm set.
    if (error instanceof WorkspaceFault) credential = "not_involved";
    // Repo private with no cred, network down, git missing, or the clone ran
    // past its ceiling. WARN, not info: the run continues without the working
    // tree it was promised, which changes what the agent can do and what its
    // report means. This used to be an info line nobody read, and the only
    // downstream signal was an empty directory — from which the agent inferred
    // a credential problem that did not exist.
    //
    // F19-6: the token is handed to the classifier so git's own words can be
    // scrubbed by VALUE and then carried on `details.detail`. A live clone
    // failure on VC-3 left `{"reason":"clone_failed","exitCode":128}` as the
    // only artifact in the entire product; the run continues either way, but a
    // human now has something to act on.
    const details = cloneFailureLogDetails(error, { token });
    // A's human-facing renderings (the fenced "What the checkout reported"
    // timeline block and the analyze-prompt verbatim instruction) read the
    // checkout's redacted output off `stderrExcerpt`; it is the SAME scrubbed
    // text `cloneFailureLogDetails` already produced on `details.detail` — one
    // redaction (via the unified `redactGitOutput`), both surfaces.
    const stderrExcerpt = details.detail;
    const warnFields = {
      taskKey: input.taskKey,
      repo: input.repo,
      credential,
      timeoutMs: cloneTimeoutMs(),
      ...details,
    };
    logger.warn(
      "specialist run clone failed, running WITHOUT a checkout",
      stderrExcerpt ? { ...warnFields, stderrExcerpt } : warnFields,
    );
    // Absent when git printed nothing usable — the prompt and the timeline both
    // render the excerpt only when the key is there.
    const failure: CloneFailure = {
      ...details,
      credential,
      sentence: cloneFailureSentence(details, {
        credential,
        timeoutMs: cloneTimeoutMs(),
      }),
    };
    if (stderrExcerpt) failure.stderrExcerpt = stderrExcerpt;
    return { dir: null, failure };
  }
}
