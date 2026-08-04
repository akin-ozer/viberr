# Spec — F18-8 / R18-3: govern the SDK-native skill/command catalog out of spawned runs

Status: IMPLEMENTATION SPEC (no source modified by this document). Read-only analysis.
Author pass: discovery-2026-08-04-pass18. Backlog item: **F18-8 / R18-3** (FINDINGS.md §A).

Owner ruling being implemented (R18-3, verbatim):

> A spawned agent run must load ONLY Viberr's granted skills. Strip the `.claude`
> directory from every per-task workspace clone (so the cloned repo's own
> commands don't ride along) and pass the CLI the flags that suppress the
> user-level catalog. Resolves F18-8; closes the same host-leak class the pass-13
> CODEX_HOME isolation addressed, now for the Claude side + repo side.

---

## 0. TL;DR of the change

Two leak channels feed a spawned Claude run's slash-command / skill catalog on
top of Viberr's governed injection. Provenance of each, and what closes it:

| Leak channel | Observed items (live run `run_Gum2jAa-kPIf`) | Present in production? | Closed by |
| --- | --- | --- | --- |
| **Repo-half** — the workspace clone's own committed `.claude/` (commands + skills, incl. submodule-gitlink skills) | `verify`, `debug`, `code-review`, `batch`, the repo's `react-doctor`/animation skills | **YES — rides along everywhere** | **NEW: strip `.claude` from the clone** (§2) |
| **User-half** — the host user-level catalog under `CLAUDE_CONFIG_DIR` | `deep-research`, `design-sync`, `dataviz`, `claude-api`, `goal`, `team-onboarding` | **No** in prod (isolated empty config dir); only leaks under `VIBERR_CLAUDE_USE_CLI_AUTH=1` where the config dir IS `~/.claude` | Already isolated in prod by `resolveClaudeConfigDir` (§3); no CLI flag exists to suppress it while also using the host login — optional Codex-style auth-mirror follow-up (§3.3) |

**The single required code change is §2** (strip the clone's `.claude`). The
Claude launch args already carry `settingSources: []` / `skills: []` /
`plugins: []`; there is **no additional CLI flag** that suppresses user-level or
project-level *slash-command* discovery (verified against the bundled SDK, §3.2).
**Codex needs no change** — its user-half is closed by `CODEX_HOME` isolation and
its repo-half (`AGENTS.md`) by `project_doc_max_bytes: 0`; Codex does not read
`.claude` at all (§4).

**Critical trap the implementer must not fall into:** the delivery path
auto-commits the working tree with `git add -A` (push-workspace.server.ts:299-303),
and `.claude` **is tracked** in this repo (9 index entries incl. submodule
gitlinks). A naive `rm -rf .claude` would therefore ship a **`.claude` deletion
into the review PR**. The strip must be made git-invisible with
`git update-index --skip-worktree` on the tracked `.claude` paths *before*
deleting them (empirically proven in §2.3).

---

## 1. Where the workspace clone is prepared

The per-task workspace clone is finalized in **`cloneRepo`**, the only function
that produces a run's working tree:

- File: `app/server/tasks/specialist-run.server.ts`
- Function: `async function cloneRepo(...)` — **defined at line 1712**
- Checkout dir: `dir = path.join(taskWorkspaceRoot(slug, key, dataRoot), <repo-name>)`
  (lines 1737-1741), i.e. `docker-data/projects/<slug>/tasks/<KEY>/workspace/<repo-name>`.
- Two success return points, both returning the checkout `dir`:
  - **Reuse path** (workspace already cloned for this task): `await setIdentity(dir);` (1751) → `return { dir };` (**line 1752**).
  - **Fresh-clone path** (`git clone --depth 1`): `await setIdentity(dir);` (1769) → `return { dir };` (**line 1770**).
- Caller: `startAgentRun` → `const clone = repo && realBackend ? await cloneRepo(...) : null;`
  (specialist-run.server.ts:782-791). The returned `clone.dir` becomes
  `runWorkdir` (line 800), which is passed as the run's `spec.workdir` — the CLI's
  `cwd`. `cloneRepo` runs for **every** real-backend run (deliverer, reviewer,
  supporting) whenever the project has a repo, so a single strip here covers all
  run kinds.

The `.claude` that leaks is the repo's own, at **`<dir>/.claude`** — i.e. inside
the CLI's cwd, which is exactly where Claude Code discovers project-level
`.claude/commands` and `.claude/skills`. (The task brief's shorthand
"`<workspace>/.claude`" resolves to `<workspaceRoot>/<repo-name>/.claude` = the
run cwd's `.claude`.)

Imports already present in this file (no new import needed): `existsSync,
mkdirSync, rmSync` from `node:fs` (line 2), `path` (line 3), `execFileAsync =
promisify(execFile)` (line 94), `logger` (line 45).

---

## 2. Fix 1 (REQUIRED) — strip the clone's `.claude`, git-invisibly

### 2.1 Why a plain `rm -rf` is wrong

`.claude` is tracked in the repo under test (`git ls-files .claude` → 9 entries:
`.claude/launch.json`, `.claude/skills/react-doctor/SKILL.md`,
`.claude/skills/react-doctor/references/explain.md`, and submodule gitlinks
`.claude/skills/animation-vocabulary`, `apple-design`, `emil-design-eng`,
`find-animation-opportunities`, `improve-animations`, `review-animations`).

Delivery finalization commits the working tree:

```
app/server/github/push-workspace.server.ts:283-303
  git -C <repoDir> status --porcelain     # any dirty state?
  ...
  git -C <repoDir> add -A                  # stages the WHOLE working tree
  git -C <repoDir> commit ...              # → pushed as the review-PR branch
```

So `rm -rf <dir>/.claude` alone → `git status` shows the 9 paths deleted →
`git add -A` stages the deletions → the review PR **deletes the repo's `.claude`**.
Unacceptable.

### 2.2 The git-invisible strip

Mark every tracked `.claude` path `--skip-worktree` **before** deleting. Git then
treats the absent files as unchanged: `git add -A` never stages the deletion, and
the commit's tree is written from the index (which still holds the original
`.claude` blobs). Net effect: the CLI never sees `.claude` on disk during the run,
and the delivered PR shows no `.claude` change.

Add this helper adjacent to `cloneRepo` (export it so the unit test in §5 can
drive it against a git fixture):

```ts
/**
 * R18-3 / F18-8 — remove the cloned repo's own `.claude` catalog from the run's
 * working tree so the Claude CLI cannot discover its ungoverned slash-commands
 * and skills. Viberr injects each agent's GRANTED skill/KB as system-prompt text
 * (buildSpecialistPersona), so a run needs nothing from the repo's `.claude`.
 *
 * `.claude` is TRACKED in many repos (incl. viberr itself: launch.json, skills,
 * submodule gitlinks), and delivery auto-commits the working tree with `git add
 * -A` (push-workspace.server). A plain `rm -rf` would therefore ship a `.claude`
 * DELETION into the review PR. We first mark every tracked `.claude` path
 * `--skip-worktree`: git then treats the absent files as unchanged, `git add -A`
 * never stages the deletion, and the committed tree keeps `.claude` from the
 * index. Verified against regular files AND submodule gitlinks.
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
```

Note on argv size: `.claude` holds ~9 tracked paths, so a single
`update-index ... -- <paths>` argv is safe. If a future repo had thousands, switch
to `git update-index --skip-worktree -z --stdin` fed from the `ls-files` output;
not needed now.

### 2.3 Diffs (before / after)

**Reuse path** — specialist-run.server.ts:1751-1752:

```diff
       await setIdentity(dir);
+      await stripUngovernedRepoCatalog(dir);
       return { dir };
```

**Fresh-clone path** — specialist-run.server.ts:1769-1770:

```diff
       await setIdentity(dir);
+      await stripUngovernedRepoCatalog(dir);
       return { dir };
```

Applying it on **both** paths matters: the reuse path scrubs a workspace created
by an older Viberr version (idempotent — `skip-worktree` re-set + `rmSync` with
`force` are no-ops when `.claude` is already gone).

### 2.4 Empirical proof (run this pass, throwaway repos)

Regular-file `.claude` (`.claude/commands/verify.md`, `.claude/skills/react-doctor/SKILL.md`, `.claude/launch.json`):

```
[2] git ls-files -z -- .claude | xargs -0 git update-index --skip-worktree ; rm -rf .claude
    on-disk .claude exists? NO
[3] git status --porcelain      → (empty)                       # no pending deletion
[4] echo change >> src/app.ts ; git add -A ; git commit         # the delivery step
[5] git diff --name-status HEAD~1 HEAD → "M  src/app.ts"         # .claude NOT in the PR diff
    git ls-tree -r HEAD | grep claude → .claude/... still present # committed tree keeps .claude
```

Submodule-gitlink `.claude` (`.claude/skills/animation-vocabulary` as a gitlink):
same result — `update-index --skip-worktree` succeeded on the gitlink with no
error, status stayed clean, delivery committed only `app.ts`, and the tree
retained `.claude/launch.json` + the gitlink.

### 2.5 Is stripping `.claude` safe? (yes)

- **Granted skills/KB are a SEPARATE channel** and keep working: Viberr injects
  each agent's declared skill and KB **as system-prompt text** via
  `buildSpecialistPersona` (specialist-run.server.ts:1159) — confirmed in the
  runtime comments (claude-runtime.server.ts:64-67, 521-523) and the pass-18
  live evidence (only the granted `smoke-note-style` was injected; the decoy
  `release-announcements` did not leak). The repo's `.claude` contributes
  **nothing** to a governed run.
- **The `Skill` tool is already denied for every run** (`BASE_DENIED_BUILTINS`,
  claude-runtime.server.ts:229-230), so even bundled skills are uninvokable; the
  repo catalog was purely a context/behavior leak.
- **Known, acceptable limitation to document:** a run whose task is literally to
  edit the repo's own `.claude` catalog cannot deliver those edits (skip-worktree
  hides them from `git add -A`). That is the intended governance posture — the
  repo's `.claude` is exactly the ungoverned surface R18-3 removes — but it should
  be noted in the decision record so it is not later mistaken for a bug.

---

## 3. Fix 2 — Claude launch args (what's already done; what's possible)

### 3.1 Already in place (no change needed)

`app/server/runtimes/claude-runtime.server.ts`, the `query()` options built in
`run()` (options object at line 498), lines **537-539**:

```ts
          settingSources: [],   // SDK isolation: drop user/project/local settings.json tiers + CLAUDE.md
          skills: [],           // context filter for the Skill tool's skill LIST
          plugins: [],          // load zero local plugins (F13 plugin-marketplace channel)
```

SDK semantics (verified in the installed `@anthropic-ai/claude-agent-sdk@0.3.220`
type docs, `sdk.d.ts:1900-1933`):

- `settingSources: []` → CLI `--setting-sources=` → disables **filesystem
  settings** (`user`/`project`/`local` `settings.json`) and, because "must include
  `'project'` to load CLAUDE.md", also blocks a repo `CLAUDE.md`. It does **not**
  gate slash-command discovery (see §3.2) — which is why the repo-half leaks
  despite this being set, and why §2 is the actual fix.
- `skills: []` → a context filter (hides skills from the model's listing / the
  Skill tool). Note the standing empirical caveat in the code
  (claude-runtime.server.ts:528-536): `skills: []` does **not** strip the SDK's
  bundled skills from the init list; isolation there is enforced by denying the
  `Skill` tool. Orthogonal to the repo-catalog fix.

### 3.2 Why there is no flag for the slash-command catalog

The SDK translates run options to CLI argv in `sdk.mjs`. The only relevant flags
it can emit are:

```
--setting-sources=<csv>     (from settingSources)   # settings.json tiers only
--strict-mcp-config         (from strictMcpConfig)  # MCP servers only
--mcp-config <json>         (from mcpServers)
```

There is **no** `--no-user-commands` / `--no-project-commands` / command-dir
override (`grep` of `sdk.mjs` for `--*command*` / `--no-*` yields only
`--no-session-persistence`). **Conclusion:** slash-command discovery from
`<cwd>/.claude/commands` and `$CLAUDE_CONFIG_DIR/commands` cannot be suppressed by
a flag. Stripping the clone's `.claude` (§2) is the only mechanism for the
repo-half; `CLAUDE_CONFIG_DIR` isolation is the only mechanism for the user-half.

### 3.3 User-half status and optional hardening

- **Production:** `resolveClaudeConfigDir()`
  (claude-config.server.ts:25-32) returns
  `<VIBERR_DATA_ROOT>/runtimes/claude-home` — an app-owned, effectively empty dir
  — so no user-level commands exist to discover. **Already governed.** R18-3's
  "flags that suppress the user-level catalog" is satisfied here by this existing
  isolation (there is no additional flag to add).
- **Dev/live-verify only:** when `VIBERR_CLAUDE_USE_CLI_AUTH=1` (no explicit
  `CLAUDE_CONFIG_DIR`), the resolver returns the host `~/.claude`
  (claude-config.server.ts:28-30) so the operator's CLI login works — and the
  host user-level catalog rides along. This is the source of the `deep-research`
  /`dataviz`/etc. items in the live init; it does **not** occur in production.
- **Optional follow-up (parity with Codex, out of R18-3's strict scope):** mirror
  `prepareCodexHome` (codex-config.server.ts:121) for Claude — keep an isolated
  empty `CLAUDE_CONFIG_DIR` and copy/symlink only the credential into it, instead
  of pointing the whole config dir at `~/.claude`. That would close the user-half
  even under CLI-auth. Flag it as a separate item; not required to satisfy R18-3.

### 3.4 Optional adjacent hardening — `strictMcpConfig`

Not required by R18-3 (which is about skills/commands), but the same governance
principle applies to the MCP catalog. Setting `strictMcpConfig: true` in the same
options block would make the run ignore any project `.mcp.json`, user MCP, and
plugin MCP, keeping **only** the servers Viberr passes via the `mcpServers`
option (its granted external MCPs + the in-process toolkit). Viberr has no tracked
repo-root `.mcp.json` today and the live run showed no leaked MCP, so this is
defense-in-depth. If adopted, add after line 539:

```diff
           plugins: [],
+          // Only Viberr-granted MCP servers reach a run — ignore a repo `.mcp.json`,
+          // user MCP config, and plugin MCP (governance parity with settingSources).
+          strictMcpConfig: true,
```

Recommend deciding this explicitly rather than bundling silently, since it is a
separate channel from R18-3.

---

## 4. Fix 3 — Codex: already fully governed (no change)

The Codex side already satisfies R18-3; the workspace strip in §2 is a harmless
no-op for it (Codex does not read `.claude`).

- **User-half (host catalog):** closed by the app-owned `CODEX_HOME`
  (`resolveCodexHome`/`prepareCodexHome`, codex-config.server.ts:67-171), which
  the config comment (codex-config.server.ts:30-34) documents as closing host
  `config.toml`, `skills/`, `plugins/`, `marketplaces`, `hooks`, `rules/`, and
  `$CODEX_HOME/AGENTS.md` in one move — the pass-13 fix.
- **Bundled skills:** `codexConfigForRun` sets
  `skills: { include_instructions: false, bundled: { enabled: false } }`
  (codex-runtime.server.ts:234-237), removing the `## Skills` block and refusing
  the `.system` skills the CLI self-installs into every home.
- **Repo-half:** Codex has no `.claude` concept. Its repo-level instruction
  ingress is `AGENTS.md`, which is already governed to zero via
  `project_doc_max_bytes: 0` (codex-runtime.server.ts:218-223). `plugins: false`
  / `hooks: false` / `apps: false` (lines 242-249) close the remaining ambient
  channels.

So no Codex code change is needed. (If desired for symmetry, the §2 helper can be
called unconditionally on any clone regardless of backend — it is safe and cheap —
but it changes nothing for a Codex run.)

---

## 5. Test plan

### 5.1 REQUIRED — the strip helper is git-invisible (new unit test)

Add to `app/server/tasks/specialist-run.server.test.ts` (imports
`mkdtempSync`, `writeFileSync`, `mkdirSync` already present; add
`stripUngovernedRepoCatalog` to the import from `./specialist-run.server`). Drive
a real temp git repo — no GitHub, no backend — mirroring §2.4:

```
describe("stripUngovernedRepoCatalog (R18-3 / F18-8)", () => {
  it("removes the repo .claude from the worktree without staging a deletion", async () => {
    // 1. mkdtempSync repo; git init; write .claude/commands/verify.md,
    //    .claude/skills/react-doctor/SKILL.md, .claude/launch.json, src/app.ts;
    //    git add -A && commit; git checkout -b task-branch.
    // 2. await stripUngovernedRepoCatalog(dir).
    // 3. assert !existsSync(<dir>/.claude)                         // CLI can't discover it
    // 4. assert (git status --porcelain).trim() === ""            // no pending deletion
    // 5. write a real change to src/app.ts; git add -A; git commit // the delivery step
    // 6. assert (git diff --name-status HEAD~1 HEAD) lists ONLY src/app.ts (no .claude)
    // 7. assert (git ls-tree -r HEAD --name-only) still contains .claude/launch.json
  });
  it("is a no-op when the clone has no .claude", async () => {
    // repo without .claude → stripUngovernedRepoCatalog resolves, tree untouched.
  });
});
```

This is the load-bearing test: step 6 is the regression guard against shipping a
`.claude` deletion into the review PR.

### 5.2 REQUIRED-if-adopted — Claude adapter passes the suppression options

The existing test already asserts the isolation trio and can be extended:

- `app/server/runtimes/claude-runtime.server.test.ts:295-308`
  ("isolates every run from the host ~/.claude") captures
  `options.settingSources` / `options.skills` and asserts both `[]`. If §3.4 is
  adopted, extend the captured shape to include `strictMcpConfig` and assert it is
  `true`. If §3.4 is not adopted, no change — the trio assertions remain the
  runtime-adapter guard.

### 5.3 OPTIONAL — harness-hermeticity extension

`app/server/runtimes/harness-hermeticity.server.test.ts` guards suite-level
credential/`CODEX_HOME` hermeticity. A workspace-clone assertion fits more
naturally in the specialist-run suite (§5.1) because it needs a git fixture, so
prefer §5.1. If a hermeticity-flavored guard is still wanted, add a check there
that a prepared workspace fixture contains no on-disk `.claude` after the strip —
but it would duplicate §5.1 and is not required.

---

## 6. File / anchor summary

| Purpose | File:line | Change |
| --- | --- | --- |
| Workspace clone finalize (insert point) | `app/server/tasks/specialist-run.server.ts:1712` (`cloneRepo`); returns at **1752** (reuse) + **1770** (fresh) | Call `stripUngovernedRepoCatalog(dir)` before each `return { dir };` |
| New helper | `app/server/tasks/specialist-run.server.ts` (adjacent to `cloneRepo`) | Add + `export` `stripUngovernedRepoCatalog` (§2.2) |
| Delivery collision (the trap) | `app/server/github/push-workspace.server.ts:283-303` | No change — `git add -A` is why the strip must use `--skip-worktree` |
| Claude launch args (already correct) | `app/server/runtimes/claude-runtime.server.ts:537-539` | No change required; optional `strictMcpConfig: true` (§3.4) |
| Claude config-dir isolation (user-half, prod) | `app/server/runtimes/claude-config.server.ts:25-32` | No change; optional Codex-style auth-mirror follow-up (§3.3) |
| Codex config (already governed) | `app/server/runtimes/codex-runtime.server.ts:218-237`, `codex-config.server.ts:67-171` | No change |
| Required test | `app/server/tasks/specialist-run.server.test.ts` | New `stripUngovernedRepoCatalog` describe (§5.1) |
| Adapter test (if §3.4 adopted) | `app/server/runtimes/claude-runtime.server.test.ts:295-308` | Extend to assert `strictMcpConfig` |
| Decision record | `docs/architecture/decisions.md` | Promote R18-3 + note the "can't deliver repo `.claude` edits" limitation (§2.5) |
