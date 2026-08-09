## 1. Goal

Close **F19-15 (HIGH)**: a second run on a task must never delete the `.claude` skill catalog that a *live* run on the same per-task workspace clone is using. Today three unconditional `stripUngovernedRepoCatalog(dir)` calls `rm -rf` the shared clone's `.claude`, and R18-5 mounts a run's granted skills into exactly that directory — so any concurrently started or resumed run silently unmounts a live Claude run's granted skills mid-flight. The fix replaces the blind strip with an **ownership-aware reconcile** driven by a per-workspace mount ledger plus the app's own run-liveness table, while keeping R18-3's property intact (the repo's own `.claude` is git-hidden with `--skip-worktree` before removal, so delivery's `git add -A` never ships a deletion). Also in scope: **F19-16** (disclose the mounted-vs-injected skills asymmetry in the runtime-differences list) and **R19-3** (correct the stale "widened to SKILLS" docstring — reviewer inheritance is KBs only).

---

## 2. Current behavior

### 2a. The strip is unconditional and total

`app/server/runtimes/skill-mount.server.ts:61-88` — the only removal primitive:

```ts
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
  } catch (error) { /* logger.warn, non-fatal */ }
  rmSync(catalog, { recursive: true, force: true });   // :87 — takes everything
}
```

`mountGrantedSkills` (`skill-mount.server.ts:145-188`) calls it itself:

```ts
  const names = [...new Set(input.skills)];
  if (names.length === 0) return { mounted: [], skipped: [] };   // :152-153
  const dir = input.workspaceDir;
  if (!dir || !isPlainGitCheckout(dir)) { … }
  await stripUngovernedRepoCatalog(dir);        // :166
  excludeCatalogFromDelivery(dir);              // :167
  …
  if (mounted.length === 0) {                   // :177-180
    // Leave the workspace exactly as a skill-less run would find it.
    rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
  }
```

### 2b. Three call sites, all on a per-TASK (shared) clone

`app/server/tasks/specialist-run.server.ts:1829-1898` — `cloneRepo` derives `<taskDir>/workspace/<repo-name>` (`:1854-1857`, same dir `taskCloneDir` at `:1607-1614` and `resumeWorkdir` in `agent-reply.server.ts:598-614` derive) and strips on **both** branches:

```ts
    if (existsSync(path.join(dir, ".git"))) {
      await execFileAsync("git", githubRemoteSanitizationArgs(input.repo, dir), { timeout: 10_000 });
      await setIdentity(dir);
      await stripUngovernedRepoCatalog(dir);      // :1869  ← REUSE path: the wipe
      return { dir };
    }
    …
      await setIdentity(dir);
      await stripUngovernedRepoCatalog(dir);      // :1888  ← fresh clone: correct today
```

Fresh-run mount, `specialist-run.server.ts:868-875`:

```ts
  const skillMount =
    backend === "claude" && realBackend
      ? await mountGrantedSkills({
          workspaceDir: clone?.dir ?? null,
          skills,
          dataRoot: ctx.dataRoot,
        })
      : { mounted: [] as string[], skipped: [] };
```

Resume mount, `specialist-run.server.ts:1691-1698` (inside `resolveResumeConfinement`, called from `task-actions.server.ts:1217-1225` on every @mention resume):

```ts
    const skillMount =
      input.backend === "claude"
        ? await mountGrantedSkills({
            workspaceDir: taskCloneDir(ctx, input.projectSlug, input.taskKey),
            skills: resolved.skills,
            dataRoot: ctx.dataRoot,
          })
        : { mounted: [] as string[], skipped: [] };
```

### 2c. What the live run loses

`app/server/runtimes/claude-runtime.server.ts:607-609` and `:663-665`:

```ts
          settingSources: nativeSkills.length ? ["project"] : [],
          skills: nativeSkills,
          ...(nativeSkills.length ? { managedSettings: MANAGED_SETTINGS } : {}),
…
          ...BASE_DENIED_BUILTINS.filter(
            (tool) => tool !== "Skill" || nativeSkills.length === 0,
          ),
```

The project setting source is the clone; the bodies live **only** on disk — `buildSpecialistPersona` deliberately omits them for mounted skills (`specialist-run.server.ts:1237-1252`: *"invoke one by name … and its full instructions load then"*). Delete the folder and the `Skill` tool fails with nothing logged against the live run.

### 2d. Concurrency — verified, not assumed

The single-flight at `specialist-run.server.ts:685-701` covers **only** `kind === "primary"`:

```ts
  if (delivers) {
    const liveDelivering = listRunsForTaskRows(db, input.projectSlug, input.taskKey).find(
      (r) => r.kind === "primary" && (r.state === "running" || r.state === "queued"),
    );
    if (liveDelivering) { throw new AppError({ code: ERROR_CODES.CONFLICT, status: 409, … }); }
  }
```

and `:682-683` states the intent: *"Supporting agents have their own read-only relationship to the workspace and run concurrently."* So the real overlap windows on one workspace are:

| Overlap | Possible? | Why |
|---|---|---|
| 2nd **delivering** run | **No** | single-flight `:685-701` |
| delivering run + **fresh supporting** run (`@mention` with no session, `prompt_agent`) | **Yes** | `delivers === false` skips the guard |
| delivering run + **resumed** supporting run | **Yes** | `task-actions.server.ts:1217` → `resolveResumeConfinement` → `mountGrantedSkills` (`:1693`), and `resumeRun` has no liveness guard |
| two supporting runs | **Yes** | same |
| **operator** run | **No, today** | `app/server/runtimes/operator-run.server.ts` never clones and has no `workdir` — it does not touch `<taskDir>/workspace`. R19-4 changes this (see Risks). |

A Codex second run is the worst case: `cloneRepo:1869` strips and Codex never re-mounts (`:869` gates on `backend === "claude"`), leaving the live Claude run with no `.claude` at all.

### 2e. F19-16 — the disclosure gap

`app/features/agents/capability-matrix-modal.tsx:195-250`: `<div className="mx-notes">` / `<h3>What differs between the two runtimes</h3>` / `<ul>` with seven `<li>` (harness `:198-201`, mid-run comments `:202-205`, ask-human `:206-209`, MCP credentials `:210-213`, MCP tool names `:214-228`, MCP not gated `:229-244`, operator web egress `:245-249`). Nothing about skills. Meanwhile `SKILL_INJECTION_BUDGET = 24_000` (`app/server/files/skill-body.server.ts:36`) clips a long skill (`:191-198`) or omits it (`:176-189`) on every non-mounted run.

### 2f. R19-3 — the stale docstring

`app/server/tasks/specialist-run.server.ts:261-269` and `:284-288`:

```ts
/**
 * R18-1 (widened to SKILLS by LV-F3): the context grants the task's DELIVERING
 * engagement used, so a reviewer can judge the work against the same
 * conventions. …
 */
function deliveringContextGrants(…)
…
/**
 * Append the delivering engagement's grants (lazily resolved) onto the
 * reviewer's own list, reviewer's first, deduped …
 */
function withDeliveringGrants(own: string[], resolveExtras: () => string[]): string[] {
```

Both call sites (`:788-793`, `:1675-1684`) union `kb` only. `LV-F3` appears nowhere else in `app/` or `docs/`.

---

## 3. Design

**Chosen: an ownership-aware reconcile.** `.claude` stops being "wipe it" and becomes "reconcile it to the union of skills that live runs mounted here." Ownership is recorded in a mount ledger at `<clone>/.git/viberr-skill-mounts.json` (`profileId → skills + mountedAt`); liveness comes from the app's own `agent_runs` rows (`state ∈ {running, queued}`) for the task. Everything not covered by a surviving claim — the repo's own commands/settings/sub-agents, an agent-written `settings.json`, a settled run's leftovers — is still removed, and the `--skip-worktree` hiding still runs first, so R18-3's "no `.claude` deletion in the review PR" property is untouched.

Why a **union on disk is safe**: `options.skills` is a per-run allow-list (`claude-runtime.server.ts:596-605`, `:663-665`) — an unlisted skill is hidden from the model and rejected by the `Skill` tool. Run A never gains run B's skills; it just stops losing its own.

Why the **`.git/` ledger**: `.git` is never committed, is invisible to `git add -A` (`push-workspace.server.ts:301`), and a fresh clone starts without one — so the fresh-clone reconcile (`cloneRepo:1888`) computes an empty keep-set and behaves *exactly* as the current full strip. That is what makes the "a kept `skills/<name>` is always Viberr-written, never the repo's" invariant hold: the repo's catalog is destroyed before any claim can exist.

**One clock caveat, stated rather than hidden.** The mount (`:870`) runs before `startRun` inserts the run row (`:1055`), so a run that just mounted is briefly invisible to the liveness query. A claim younger than `CLAIM_ANNOUNCE_GRACE_MS` (60 s) is therefore honored even without a row — *except* the mounting profile's own prior claim, which is never grace-held (its grants may have changed, and it is re-mounting right now; this is what keeps the existing "no stale skills from a previous grant" behavior). The only cost is that a start that throws between mount and insert leaves its folders on disk until that profile's next run on the task.

**Rejected — a lease covering the whole mount lifetime.** Extending the `:685-701` single-flight to all runs would 409 an `@mention` of a reviewer while the developer is working. That concurrency is a deliberate product property (`:682-683`); trading it away to protect a directory is backwards.

**Rejected — a per-run mount directory.** `settingSources: ['project']` reads `<cwd>/.claude`, and cwd is the checkout — so "per-run mount dir" *means* "per-run checkout". A `git worktree` fails `isPlainGitCheckout` (`:192-198`, `.git` is a file); a per-run local clone is genuinely better isolation but drags in workspace retention, `resumeWorkdir`, `push-workspace`, `GIT_CEILING`, and disk cost, and it is orthogonal to this defect: a supporting run already shares the deliverer's *entire* working tree, uncommitted work included. Noted as the follow-up if the owner wants true per-run isolation; not this cluster.

**Rejected — "never GC another profile's claim" (no DB, no clock).** Simplest, but it leaves a finished profile's granted skills readable in a co-engaged agent's cwd for the life of the workspace — which directly undercuts **R19-3**, decided this pass, that a reviewer must not get the developer's skills. GC is required; therefore liveness is required.

---

## 4. Changes

### C1 — `app/server/runtimes/skill-mount.server.ts`: the mount ledger

**Anchor:** `node:fs` import, lines 2-10. Add `readdirSync`.

```ts
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

**Anchor:** new block inserted directly above `stripUngovernedRepoCatalog` (current `:61`).

```ts
// ------------------------------------------------------------- mount ledger

/** One run's claim on this workspace's catalog: the skills IT mounted, so a
 *  CONCURRENT run's reconcile keeps them instead of deleting them out from
 *  under a live agent (F19-15). */
interface MountClaim {
  profileId: string;
  skills: string[];
  /** epoch ms — read by the announce grace below. */
  mountedAt: number;
}

/** The ledger lives under `.git/`: git never commits it, delivery's `git add
 *  -A` never sees it, and a FRESH clone starts with none — so the fresh-clone
 *  reconcile keeps nothing and behaves exactly like the old full strip. That is
 *  what makes "a kept `.claude/skills/<name>` is always Viberr-written, never
 *  the repo's own" true: the repo's catalog dies before any claim can exist. */
const LEDGER_REL = path.join(".git", "viberr-skill-mounts.json");

/** A claim this young is honoured with no live run row behind it. The mount runs
 *  BEFORE `startRun` inserts the row (persona + prompt assembly sit between
 *  them), so a run that has just mounted is briefly invisible to the liveness
 *  query. Cost of the window: a start that THREW between mount and insert leaves
 *  its skills on disk until that profile's next run reconciles them away. */
const CLAIM_ANNOUNCE_GRACE_MS = 60_000;

function readClaims(repoDir: string): MountClaim[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(repoDir, LEDGER_REL), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is MountClaim =>
        !!c && typeof c === "object" &&
        typeof (c as MountClaim).profileId === "string" &&
        Array.isArray((c as MountClaim).skills) &&
        typeof (c as MountClaim).mountedAt === "number",
    );
  } catch {
    // No ledger (fresh clone) or unreadable → no claims. Fail CLOSED: an
    // unreadable ledger reconciles to a full strip, never to "keep everything".
    return [];
  }
}

function writeClaims(repoDir: string, claims: MountClaim[]): void {
  const file = path.join(repoDir, LEDGER_REL);
  try {
    if (claims.length === 0) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(claims));
  } catch (error) {
    logger.warn("could not record the workspace skill-mount ledger", {
      repoDir,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
```

### C2 — `skill-mount.server.ts`: `stripUngovernedRepoCatalog` → `reconcileWorkspaceCatalog`

**Anchor:** `:45-88` (docblock + function). Replace wholesale.

*Before* — see §2a.

*After*:

```ts
export interface CatalogReconcile {
  /** Profile ids with a `running`/`queued` run on THIS task right now. Their
   *  mounted skills survive; nobody else's does. */
  liveProfileIds: readonly string[];
  /** The profile this call reconciles FOR, when there is one. Its own earlier
   *  claim never rides the announce grace: its grants may have changed and it is
   *  about to re-mount whatever it still grants. */
  profileId?: string;
  /** Injectable clock (tests). */
  now?: number;
}

/**
 * R18-3 / F18-8 — the run's working tree must expose no `.claude` the Claude CLI
 * could discover beyond what Viberr put there: no repo slash-commands, settings
 * (hooks!), sub-agents or skills, and nothing a previous run self-installed.
 *
 * F19-15 — but the workspace clone is per-TASK and shared by every engagement,
 * and R18-5 mounts a run's GRANTED skills into that same `.claude`. A blind
 * `rm -rf` on a second run therefore deleted a LIVE run's mounted skills, whose
 * bodies exist nowhere else (the persona deliberately omits them). So this
 * reconciles instead of wiping: the skills claimed by a still-live run survive,
 * everything else goes. A run only ever SEES its own grants regardless — the
 * SDK's `skills` filter is a per-run allow-list (claude-runtime.server).
 *
 * `.claude` is TRACKED in many repos (incl. viberr itself), and delivery
 * auto-commits with `git add -A` (push-workspace.server). A plain removal would
 * ship a `.claude` DELETION into the review PR. Every tracked `.claude` path is
 * therefore marked `--skip-worktree` FIRST: git treats the absent files as
 * unchanged, `git add -A` never stages the deletion, and the committed tree
 * keeps `.claude` from the index. (A run whose task is to edit the repo's own
 * `.claude` cannot deliver those edits — the intended posture, not a bug.)
 *
 * Returns the skill names still mounted after the reconcile.
 */
export async function reconcileWorkspaceCatalog(
  repoDir: string,
  input: CatalogReconcile,
): Promise<string[]> {
  const now = input.now ?? Date.now();
  const kept = readClaims(repoDir).filter(
    (claim) =>
      input.liveProfileIds.includes(claim.profileId) ||
      (claim.profileId !== input.profileId &&
        now - claim.mountedAt < CLAIM_ANNOUNCE_GRACE_MS),
  );
  const keep = new Set(kept.flatMap((claim) => claim.skills));
  const catalog = path.join(repoDir, ".claude");
  if (!existsSync(catalog)) {
    writeClaims(repoDir, []);           // nothing is mounted; no claim is valid
    return [];
  }
  await hideRepoCatalogFromGit(repoDir);
  if (keep.size === 0) {
    rmSync(catalog, { recursive: true, force: true });
    writeClaims(repoDir, []);
    return [];
  }
  for (const entry of readdirSync(catalog, { withFileTypes: true })) {
    if (entry.name !== "skills") {
      rmSync(path.join(catalog, entry.name), { recursive: true, force: true });
      continue;
    }
    const skillsRoot = path.join(catalog, "skills");
    for (const skill of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!keep.has(skill.name)) {
        rmSync(path.join(skillsRoot, skill.name), { recursive: true, force: true });
      }
    }
  }
  // A catalog that ended up empty must not linger: an empty `.claude` still
  // opens a project setting source for the next run.
  const survivors = [...keep].filter((name) =>
    existsSync(path.join(catalog, "skills", name)),
  );
  if (survivors.length === 0) {
    rmSync(catalog, { recursive: true, force: true });
    writeClaims(repoDir, []);
    return [];
  }
  writeClaims(repoDir, kept);
  return survivors;
}

/** The `--skip-worktree` half of R18-3: make the repo's TRACKED `.claude` paths
 *  invisible to git before any of them is removed, so the delivery diff never
 *  carries a `.claude` deletion. */
async function hideRepoCatalogFromGit(repoDir: string): Promise<void> {
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
    // Non-fatal: the catalog is reconciled regardless. Worst case of a
    // skip-worktree failure is a `.claude` deletion surfacing in the delivery
    // diff for a human to notice, never a silent catalog leak.
    logger.warn("could not skip-worktree repo .claude before reconciling", {
      repoDir,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
```

Also update the module docblock (`:20-41`): item 1 becomes `{@link reconcileWorkspaceCatalog}` and the sentence *"the workspace's `.claude` holds Viberr content or nothing, unconditionally"* becomes *"…holds Viberr content or nothing — this run's mount plus whatever a concurrently LIVE run mounted, never anything ungoverned."*

### C3 — `skill-mount.server.ts`: `mountGrantedSkills` claims its mount

**Anchor:** `:145-188`.

```ts
export async function mountGrantedSkills(input: {
  workspaceDir: string | null;
  skills: readonly string[];
+ /** The profile this run belongs to — the mount is claimed in its name so a
+  *  concurrently live run's reconcile keeps it (F19-15). */
+ profileId: string;
+ /** Profile ids with a live run on this task (see CatalogReconcile). */
+ liveProfileIds: readonly string[];
  dataRoot?: string;
+ now?: number;
}): Promise<SkillMount> {
```

Body, replacing `:164-167`:

```ts
-  await stripUngovernedRepoCatalog(dir);
+  // Reconcile FIRST, every run (fresh AND resume): the repo may ship its own
+  // `.claude`, and a previous run may have written one — including a
+  // `settings.json` whose hooks the project setting source would execute. What
+  // survives is exactly what a still-live run mounted here (F19-15).
+  const survivors = await reconcileWorkspaceCatalog(dir, {
+    liveProfileIds: input.liveProfileIds,
+    profileId: input.profileId,
+    ...(input.now !== undefined ? { now: input.now } : {}),
+  });
   excludeCatalogFromDelivery(dir);
```

and `:177-180`:

```ts
   if (mounted.length === 0) {
-    // Leave the workspace exactly as a skill-less run would find it.
-    rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
+    // Leave the workspace exactly as a skill-less run would find it — unless a
+    // LIVE run's skills are mounted here, which are not ours to remove.
+    if (survivors.length === 0) {
+      rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
+    }
+  } else {
+    // Replace (not merge) this profile's claim: the mount above IS its current
+    // grant set. Narrow accepted case — the same profile with TWO live runs and
+    // changed grants between them loses the dropped skill from the older run.
+    writeClaims(dir, [
+      ...readClaims(dir).filter((c) => c.profileId !== input.profileId),
+      { profileId: input.profileId, skills: mounted, mountedAt: input.now ?? Date.now() },
+    ]);
   }
```

### C4 — `app/server/tasks/specialist-run.server.ts`: liveness helper

**Anchor:** immediately after `withDeliveringKbs` (see C7), i.e. after current `:299`.

```ts
/**
 * Profiles with a run in flight on this task. F19-15: the per-task workspace
 * clone is shared by every engagement, and a live Claude run's granted skills
 * are mounted in its `.claude` — so any catalog reconcile must know whose mounts
 * are still load-bearing. `listRunsForTaskRows` is the same liveness source the
 * delivering single-flight uses.
 */
function liveRunProfileIds(
  db: DatabaseSync,
  projectSlug: string,
  taskKey: string,
): string[] {
  return [
    ...new Set(
      listRunsForTaskRows(db, projectSlug, taskKey)
        .filter((r) => r.state === "running" || r.state === "queued")
        .map((r) => r.agent_profile_id)
        .filter((id): id is string => !!id),
    ),
  ];
}
```

### C5 — `specialist-run.server.ts`: `cloneRepo` reconciles instead of wiping

**Anchor:** signature `:1829-1840`; strips at `:1869` and `:1888`.

```ts
 async function cloneRepo(
   db: DatabaseSync,
   input: {
     projectSlug: string;
     taskKey: string;
     repo: string;
     dataRoot?: string;
     identity?: { name: string; email: string };
+    /** The profile this clone is being prepared for (catalog reconcile). */
+    profileId: string;
+    /** Profiles with a live run on this task — their mounted skills survive the
+     *  reconcile below (F19-15). */
+    liveProfileIds: readonly string[];
   },
 ): Promise<CloneOutcome> {
```

Both strip sites:

```ts
-      await stripUngovernedRepoCatalog(dir);
+      await reconcileWorkspaceCatalog(dir, {
+        liveProfileIds: input.liveProfileIds,
+        profileId: input.profileId,
+      });
```

(At `:1888` the clone is brand-new, so there is no ledger, `keep` is empty, and this is byte-for-byte the old full strip.)

Import line `:46-48`:

```ts
-import { mountGrantedSkills, stripUngovernedRepoCatalog } from "~/server/runtimes/skill-mount.server";
+import { mountGrantedSkills, reconcileWorkspaceCatalog } from "~/server/runtimes/skill-mount.server";
```

Comment block `:1822-1826` — replace `stripUngovernedRepoCatalog` with `reconcileWorkspaceCatalog`.

### C6 — `specialist-run.server.ts`: both mount call sites

**Anchor:** `:838-875` (fresh run).

```ts
   const realBackend = isBackendAvailable(backend);
+  // F19-15: another engagement may be RUNNING in this same per-task clone with
+  // its granted skills mounted in `.claude`. One query serves both the clone's
+  // reconcile and the mount below; this run's own row does not exist yet
+  // (`startRun` inserts it further down), which the announce grace covers.
+  const liveProfileIds = liveRunProfileIds(db, input.projectSlug, input.taskKey);
   const clone =
     repo && realBackend
       ? await cloneRepo(db, {
           projectSlug: input.projectSlug,
           taskKey: input.taskKey,
           repo,
           dataRoot: ctx.dataRoot,
           identity: agentGitIdentity(engagement.profileId),
+          profileId: engagement.profileId,
+          liveProfileIds,
         })
       : null;
…
       ? await mountGrantedSkills({
           workspaceDir: clone?.dir ?? null,
           skills,
           dataRoot: ctx.dataRoot,
+          profileId: engagement.profileId,
+          liveProfileIds,
         })
```

**Anchor:** `:1691-1698` (resume).

```ts
         ? await mountGrantedSkills({
             workspaceDir: taskCloneDir(ctx, input.projectSlug, input.taskKey),
             skills: resolved.skills,
             dataRoot: ctx.dataRoot,
+            profileId: input.profileId,
+            // The DELIVERING run is typically live while a supporting agent is
+            // @mentioned — its mounted skills must survive this re-mount.
+            liveProfileIds: liveRunProfileIds(db, input.projectSlug, input.taskKey),
           })
```

### C7 — R19-3: honest names and docstrings

**Anchor:** `:261-269`.

```ts
/**
 * R18-1 / R19-3 — the KNOWLEDGE BASES the task's DELIVERING engagement used, so
 * a reviewer judges the work against the same conventions. KBs ONLY: R19-3 keeps
 * skills out of this inheritance, because a skill is a role's own operating
 * instructions and a reviewer running the developer's skill blurs the two roles.
 * (An earlier docstring here claimed a widening to skills; no call site ever did
 * it — both union `kb`, and the ruling says they should.) Returns [] when there
 * is no deliverer, when the deliverer IS this profile (its own run already
 * carries them), or when the deliverer is undeployed since delivery (its live
 * grants cannot be confirmed — the reviewer keeps its own). `resolve` throwing
 * (undeployed profile) is treated as "no extras".
 */
-function deliveringContextGrants(
+function deliveringKbGrants(
   frontmatter: Parameters<typeof deliveringEngagement>[0],
   reviewerProfileId: string,
   resolve: (profileId: string) => string[],
 ): string[] {
```

**Anchor:** `:284-289`.

```ts
/**
 * Append the delivering engagement's KBs (lazily resolved) onto the reviewer's
 * own list, reviewer's first, deduped so a KB both grant never injects — or
 * double-charges the shared injection budget — twice.
 */
-function withDeliveringGrants(own: string[], resolveExtras: () => string[]): string[] {
+function withDeliveringKbs(own: string[], resolveExtras: () => string[]): string[] {
```

Call sites `:789-790` and `:1676-1677` rename accordingly (`withDeliveringKbs(kb, () => deliveringKbGrants(…))`). No other file references either symbol (both are module-private; verified by repo-wide grep).

### C8 — F19-16: the runtime-differences bullet

**Anchor:** `app/features/agents/capability-matrix-modal.tsx`, insert as the second `<li>`, between `:201` (`</li>` of the harness bullet) and `:202`.

```tsx
              <li>
                {/* F19-16 / R18-5 ("that asymmetry is disclosed, not silent"):
                    nothing rendered said so. The real discriminator is MOUNTED
                    vs INJECTED — a Claude run with no workspace checkout falls
                    back to the same prompt-text path every Codex run takes. */}
                <b>Attached skills arrive differently.</b> On a Claude run with a
                workspace checkout, each attached skill is installed as a real
                file the agent opens only when it uses that skill — whole,
                however long it is. Everywhere else — every Codex run, and a
                Claude run with no checkout — the skill is pasted into the
                agent's instructions under one shared 24,000-character budget:
                a long skill is cut off at that limit, and a second skill can be
                left out entirely once the budget is spent. Keep a skill short
                if agents on both backends must follow it.
              </li>
```

Voice check against siblings: bolded lead-in + plain consequence + one actionable closing line (matches the MCP-tool-names and MCP-not-gated bullets). Contains no banned word (`app/features/copy-ban.test.ts`, `BANNED = /\bgovern(ance|ed|or|ors|ing|s)?\b/i`).

---

## 5. Tests

### T1 — `app/server/runtimes/skill-mount.server.test.ts`

**Mechanical (required by tsc):** the two `stripUngovernedRepoCatalog(dir)` calls at `:77` and `:99` become `reconcileWorkspaceCatalog(dir, { liveProfileIds: [] })`; the `describe` at `:56` is renamed to `reconcileWorkspaceCatalog — R18-3 / F18-8 strip`; the import at `:14-18` swaps the symbol; every `mountGrantedSkills({…})` call (`:146, :171, :200, :240, :275, :280, :302, :330, :331, :357, :376`) gains `profileId: "dev"` and `liveProfileIds: []`. The `:99` assertion `resolves.toBeUndefined()` becomes `resolves.toEqual([])`.

**New `describe("reconcileWorkspaceCatalog — a live run's mount survives (F19-15)")`:**

1. `it("keeps the skills a LIVE run mounted and removes everything else")`
   Mount `["dev-craft"]` as `dev` (`liveProfileIds: []`); write `.claude/settings.json` and `.claude/skills/self-installed/SKILL.md`; call `reconcileWorkspaceCatalog(ws, { liveProfileIds: ["dev"], profileId: "critic" })`.
   Asserts: `.claude/skills/dev-craft/SKILL.md` still exists; `settings.json` gone; `skills/self-installed` gone; the return value is `["dev-craft"]`.
   **Canary:** replace the reconcile body with the old `rmSync(catalog, …)` → `dev-craft` is gone and the first assertion fails.

2. `it("removes a SETTLED run's mount once nothing claims it")`
   Mount `["dev-craft"]` as `dev` with `now: 0`; then `reconcileWorkspaceCatalog(ws, { liveProfileIds: [], profileId: "critic", now: 10 * 60_000 })`.
   Asserts: `.claude` no longer exists; the ledger file `.git/viberr-skill-mounts.json` is gone; the return value is `[]`.
   **Canary:** make the filter `() => true` (keep every claim forever) → `.claude` survives. This is what pins R19-3's boundary: a settled deliverer's skills do not linger in the reviewer's cwd.

3. `it("honours a mount that has not announced its run row yet")`
   Mount `["dev-craft"]` as `dev` with `now: 1_000`; reconcile with `{ liveProfileIds: [], profileId: "critic", now: 1_000 + 30_000 }`.
   Asserts: `dev-craft` still mounted.
   **Canary:** delete the `now - claim.mountedAt < CLAIM_ANNOUNCE_GRACE_MS` clause → the folder is deleted, reproducing the mount-before-`startRun` window.

**New in `describe("mountGrantedSkills")`:**

4. `it("a SECOND run's mount never unmounts a LIVE run's skills (F19-15)")`
   Store with `dev-craft` + `review-craft`; `ws = await gitCheckout()`; mount `{ profileId: "dev", skills: ["dev-craft"], liveProfileIds: [] }`, then mount `{ profileId: "critic", skills: ["review-craft"], liveProfileIds: ["dev"] }`.
   Asserts: both folders exist on disk; **and** the second call's `result.mounted` is exactly `["review-craft"]` — the union on disk must never widen the SDK filter the caller passes.
   **Canary:** restore the unconditional strip inside `mountGrantedSkills` → `dev-craft` is gone.

**Amended `:320` `it("re-mounting is idempotent — one exclude entry, no stale skills from a previous grant")`:** both calls use `profileId: "dev"`, `liveProfileIds: []`. It now additionally pins that a profile's *own* prior claim is never grace-held (both mounts happen well inside 60 s).
**Canary:** drop `claim.profileId !== input.profileId` from the reconcile filter → `first` survives and `expect(existsSync(…, "first")).toBe(false)` fails.

### T2 — `app/server/tasks/specialist-run.server.test.ts`, in `describe("granted skills reach a Claude run NATIVELY (pass-18)")` (`:1681`)

New helper `deploySkillPair(devSkills, criticSkills)` modelled on `deployKbPair` (`:1589-1619`) but with `repo: "acme/widgets"` and `resources.skills`, deploying `dev` (role `developer`) and `critic` (role `reviewer`), both `backends: ["claude"]`.

`it("a second engagement's run does not unmount the LIVE run's skills (F19-15)")`:
- `deploySkillPair(["dev-craft"], ["review-craft"])`; `writeSkill("dev-craft", "# Dev\n\nSENTINEL-DEV-CRAFT")`, `writeSkill("review-craft", …)`; `const ws = await workspaceCheckout()`.
- `assignSpecialist(dev)` → `startAgentRun(dev)` → `interruptRun` (mounts `dev-craft` and claims it).
- `upsertRun(store.db, { id: "run_dev_live", …, kind: "primary", agentProfileId: "dev", state: "running" })` — the same live-row fixture the `P14-GV-10` tests use (`:305-317`), so the liveness rule is exercised deterministically.
- `assignReviewer(critic)` → `startAgentRun({ profileId: "critic" })` → `interruptRun`.
- Asserts: `existsSync(ws/.claude/skills/dev-craft/SKILL.md)` is `true` (the live run keeps its craft); `existsSync(ws/.claude/skills/review-craft/SKILL.md)` is `true`; `lastRunSpec()?.skills` equals `["review-craft"]` (the reviewer's SDK filter never widened — R19-3's boundary holds on the wire even though both folders sit on disk).
- **Canary:** revert `cloneRepo`'s reuse-path call (`:1869`) to `stripUngovernedRepoCatalog(dir)` → `dev-craft` is gone and the first assertion fails. This is the exact defect, end to end through `startAgentRun`.

Note in the test comment: the *live-row* half of the rule is pinned by T1.2 (which can inject `now`); this test proves the end-to-end wiring.

### T3 — `app/features/agents/agents-page.test.tsx`, in `describe("CapabilityMatrixModal")` (`:619`)

`it("discloses that an attached skill is installed on Claude but pasted under a budget elsewhere (R18-5 / F19-16)")`:
- renders `<CapabilityMatrixModal profiles={[mkProfile({})]} projectName="Viberr Core" onClose={() => {}} />` (same shape as `:674-688`).
- Asserts `getByText("Attached skills arrive differently.")` and that the containing `<li>`'s `textContent` includes `24,000-character budget` and `no checkout` (the honest "not simply Claude-vs-Codex" half).
- **Canary:** delete the new `<li>` → `getByText` throws.

`app/features/copy-ban.test.ts` needs no change; it scans `app/features/**` and will fail on its own if the new copy ever reintroduces the banned family.

---

## 6. Risks / call sites

**Type + signature changes (tsc gate):**
- `mountGrantedSkills` gains two required fields (`profileId`, `liveProfileIds`) — 2 production callers (`specialist-run.server.ts:870`, `:1693`) and 11 test calls in `skill-mount.server.test.ts`.
- `cloneRepo` gains two required fields — 1 caller (`specialist-run.server.ts:841`; the only other repo mention is a comment at `app/server/github/workspace-delivery.server.ts:251`).
- `stripUngovernedRepoCatalog` is **removed**, replaced by `reconcileWorkspaceCatalog`. Referencing sites: `specialist-run.server.ts:47, :1822-1826, :1869, :1888`; `skill-mount.server.ts:26, :38, :46, :61, :166`; `skill-mount.server.test.ts:17, :56, :77, :99, :346`; comment at `specialist-run.server.test.ts:1582-1584`.
- `deliveringContextGrants` → `deliveringKbGrants`, `withDeliveringGrants` → `withDeliveringKbs`: module-private, 2 definitions + 2 call sites (`:789-790`, `:1676-1677`), no test or doc code references.

**No schema or projection change.** The ledger is a file inside `.git`; `agent_runs` is read, never written. No migration, no rebuild.

**Accepted residual (state it, do not hide it):** while two runs are genuinely live on one task, both profiles' mounted skill folders sit in the same cwd, so agent A could `Read` agent B's `SKILL.md` even though the SDK will not let A *invoke* it. This is not new (today's transient mount has the same property) and is dwarfed by the fact that supporting runs already share the deliverer's entire working tree. The only real cure is a per-run checkout — the rejected Design B, worth raising with the owner separately.

**Accepted narrow case:** one profile with two concurrent runs *and* changed grants between them loses the dropped skill from the older run at the newer run's mount (C3 replaces rather than merges the claim). Documented in the code comment.

**R19-4 interaction — flag before landing.** R19-4 gives the operator a read-only repository view. Today the operator has no workdir and never touches `<taskDir>/workspace` (`operator-run.server.ts` has no clone/workdir path), which is why it is not in the overlap table. If R19-4's implementation clones into the *same* per-task workspace, it becomes a fourth writer and must call `reconcileWorkspaceCatalog` with `liveProfileIds` too — a separate shallow fetch dir avoids the question entirely and is the better shape.

**Unaffected but worth re-checking during review:** `push-workspace.server.ts:301` (`git add -A`) — the `.git/info/exclude` entry written by `excludeCatalogFromDelivery` (`skill-mount.server.ts:210-236`) still covers `.claude/`, and the ledger lives under `.git/`, which git never commits. `workspace-retention.server.ts` deletes whole workspaces and needs no ledger awareness.

**Docs to update:**
- `docs/architecture/decisions.md` ruling **49 (R18-3)**, closing pointer at `:433-434`: it names `stripUngovernedRepoCatalog` in `app/server/tasks/specialist-run.server.ts` — stale on both counts. Amend to `reconcileWorkspaceCatalog` in `app/server/runtimes/skill-mount.server.ts`, with a one-line amendment note that F19-15 narrowed the strip to a reconcile so a concurrent run cannot unmount a live run's granted skills (the ruling number stays 49). Ruling **51 (R18-5)** at `:455-456` ("after R18-3 has stripped the clone's own `.claude`") should read "reconciled".
- Pass-19 reference docs (regenerated from main, so refresh when the branch lands): `reference/AGENTS-RUNTIME.md:167` (repeats the "widened to SKILLS by LV-F3" claim R19-3 retires), `:178-187`, `:199-215`, `:369`, `:372`; `reference/TESTING-INFRA.md:137` (points the R18-3 test at `specialist-run.server.test.ts:1510`, which no longer holds it) and `:159`.
- `planning/discovery-2026-08-06-pass19/NOTES.md`: dispositions for F19-15 (FIXED), F19-16 (FIXED), F19-2 (RULED — R19-3).