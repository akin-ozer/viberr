# Implementation spec — cluster: failures that record no reason (F19-6, F19-18) + reliability (F19-19, F19-20)

## 1. Goal

Four server-side reliability defects, fixed as two pairs.

**Pair A — a failure must say what failed.** A workspace clone (F19-6, live-reproduced on VC-3) and a delivery push (F19-18, audit-confirmed HIGH) both throw away git's own words, so the only trace anywhere is `{"reason":"clone_failed","exitCode":128}` / `"git push returned non-zero"`. Both get git's stderr back through **one shared scrub-by-value redactor**, surfaced on the task timeline, in the server log, in the agent's prompt, and (via the operator's snapshot) in the blocked packet.

**Pair B — two idempotency/ordering holes.** `reconcileTask` has a read-then-write TOCTOU with no serialization, so two overlapping passes duplicate the divergence note *and* the watcher inbox alerts (F19-19, NFR16 "calm over chatter"). `fireDueSchedules` decides FR39 mootness from the tick's projection snapshot instead of from the canonical frontmatter it already holds under the claim lock (F19-20), and a scheduled trigger queued behind an in-flight drive is never re-checked at all.

No ruling is created or changed by this work; one documented decision (the deliberate stderr suppression in `cloneFailureLogDetails`) is **reversed** and needs a new numbered entry in `decisions.md`.

---

## 2. Current behavior

### 2a. Clone failure drops everything (F19-6)

`app/server/tasks/git-clone-auth.server.ts:183-187` — the detail type:

```ts
export interface CloneFailureLogDetails {
  reason: "git_unavailable" | "clone_failed" | "clone_terminated";
  exitCode?: number;
  signal?: string;
}
```

`app/server/tasks/git-clone-auth.server.ts:223-247` — the suppression and its stated reason:

```ts
/**
 * Return an intentionally small, credential-safe description for logs.
 * `Error.message`, `stderr`, and `cmd` are deliberately ignored because child
 * process errors may echo command arguments or authentication diagnostics.
 */
export function cloneFailureLogDetails(error: unknown): CloneFailureLogDetails {
  const value =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; signal?: unknown; killed?: unknown })
      : {};
  const code = value.code;
  const signal = typeof value.signal === "string" ? value.signal : undefined;
  const reason =
    code === "ENOENT"
      ? "git_unavailable"
      : value.killed === true || signal
        ? "clone_terminated"
        : "clone_failed";

  return {
    reason,
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(signal ? { signal } : {}),
  };
}
```

**The premise the suppression rests on is verified false for argv and the remote URL.** `createGitHubClonePlan` (`git-clone-auth.server.ts:110-160`) builds `args: ["clone", "--depth", "1", url, input.destination]` where `url = githubRepositoryUrl(input.repo)` = `https://github.com/<owner>/<repo>.git` (`:79-81`), and puts the PAT **only** into `env[ASKPASS_PASSWORD_ENV]` (`:143-144`) behind a `GIT_ASKPASS` helper script that reads it from its own environment (`:11-16`). `createGitHubAskpassEnv` (`:42-76`) does the same for the push. So git's stderr can only carry a token if the *repository's own `.git/config`* still holds a legacy `x-access-token:<PAT>@github.com` origin — which `githubRemoteSanitizationArgs` (`:88-101`) exists to scrub, and which `cloneRepo` runs on every reuse (`specialist-run.server.ts:1863-1867`) but which `pushWorkspaceBranch` never runs.

Consumer, `app/server/tasks/specialist-run.server.ts:1900-1926`:

```ts
  } catch (error) {
    // Repo private with no cred, network down, git missing, or the clone ran
    // past its ceiling. WARN, not info: ...
    const details = cloneFailureLogDetails(error);
    logger.warn("specialist run clone failed — running WITHOUT a checkout", {
      taskKey: input.taskKey,
      repo: input.repo,
      hadCredential,
      timeoutMs: CLONE_TIMEOUT_MS,
      ...details,
    });
    return {
      dir: null,
      failure: {
        ...details,
        hadCredential,
        sentence: cloneFailureSentence(details, {
          hadCredential,
          timeoutMs: CLONE_TIMEOUT_MS,
        }),
      },
    };
  }
```

`hadCredential` is hoisted at `:1842` (`let hadCredential = false;`) but the **token itself is scoped inside the `try`** (`:1874-1876`), so the catch cannot scrub by value today:

```ts
    const cred = getProjectCredential(db, input.projectSlug);
    const token = cred ? getPatToken(db, cred.id) : null;
    hadCredential = !!token;
```

`CloneFailure` (`specialist-run.server.ts:1809-1814`) extends `CloneFailureLogDetails`, so anything added to that interface flows to the two surfaces automatically:

```ts
export interface CloneFailure extends CloneFailureLogDetails {
  /** Whether a real token reached the clone (decides the credential story). */
  hadCredential: boolean;
  /** One plain sentence, safe to show a human and to put in a prompt. */
  sentence: string;
}
```

Surface 1 — the timeline note, `specialist-run.server.ts:942-960`:

```ts
  if (cloneFailure) {
    await updateTaskFile(
      taskRef(ctx, input.projectSlug, input.taskKey),
      (parsed) => {
        parsed.timeline.unshift({
          occurredAt: new Date().toISOString(),
          type: "note",
          actor: { kind: "system", systemId: "policy-engine" },
          title: null,
          text:
            `**Workspace checkout failed:** ${cloneFailure.sentence} ` +
            `The agent is running against an EMPTY workspace, so it cannot read or change ${repo}. ` +
            (cloneFailure.reason === "clone_terminated"
              ? "Raise `VIBERR_GIT_CLONE_TIMEOUT_MS` if this repository simply needs longer, then re-run."
              : "Re-run once the cause above is addressed."),
          toAgent: false,
          evidence: null,
        });
      },
    );
```

Surface 2 — the agent prompt. `buildAnalyzePrompt`'s input type at `specialist-run.server.ts:1381`:

```ts
  cloneFailure?: { sentence: string; hadCredential: boolean } | null;
```

fed at `:922-929`, and rendered at `:1424-1434` (`"...Report that the checkout could not be provisioned, quote the reason above verbatim, and stop."`).

**Why the timeline is load-bearing for the packet:** `operatorSnapshot` (`app/server/tasks/operator-actions.server.ts:1106-1116`) hands the operator `recentTimeline: file.parsed.timeline.slice(0, 6)` with each `text` capped at 1500 chars. So a redacted detail on the note reaches the operator's blocked packet without any new plumbing — and the 1500-char cap is why the detail must be clamped.

### 2b. Push failure drops everything (F19-18)

`app/server/github/push-workspace.server.ts:36-52` — the result union:

```ts
export type PushWorkspaceResult =
  | { status: "pushed"; branch: string; commits: number }
  | { status: "push_conflict"; branch: string; reason: string }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_branch"
        | "no_commits"
        | "push_failed"
        | "grant_withheld"
        | "task_not_found";
      reason: string;
    };
```

`app/server/github/push-workspace.server.ts:361-403` — the token is in scope at the failure site (`:362`), and the residual bucket is a fixed string:

```ts
    const credential = getProjectCredential(db, projectSlug);
    const token = credential ? getPatToken(db, credential.id) : null;
    if (!token) return { status: "no_pat", reason: "no project credential" };

    const askpass = createGitHubAskpassEnv({ token });
    try {
      const pushRes = await exec(
        "git",
        ["-C", repoDir, "push", "origin", `HEAD:refs/heads/${branch}`],
        { cwd: repoDir, timeoutMs: PUSH_TIMEOUT_MS, env: askpass.env },
      );
      if (!pushRes.ok) {
        // ... isNonFastForwardStderr branch at :378-389 ...
        // Redact stderr — a git push failure can echo the remote URL/token.
        logger.info("workspace branch push failed", {
          taskKey,
          branch,
          ...(pushRes.timedOut ? { timedOut: true } : {}),
        });
        return {
          status: "push_failed",
          reason: pushRes.timedOut
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : "git push returned non-zero",
        };
      }
```

That string is interpolated straight into the human-visible timeline event at `app/server/tasks/task-actions.server.ts:3429-3442`:

```ts
    if (push.status === "push_failed" || push.status === "no_pat") {
      const message =
        `${taskKey}'s execution branch could not be pushed (${push.status === "no_pat" ? "no project credential" : push.reason}). ` +
        `No review PR was opened — a PR over a remote missing the newest commits would ` +
        `review the wrong content. Fix the push, then deliver again.`;
      await surfaceDeliveryEvent(
        db, ctx, projectSlug, taskKey, "Delivery push failed", message,
      );
      return { status: "push_failed", message };
    }
```

and into the operator's tool result at `app/server/tasks/operator-actions.server.ts:1899-1903`:

```ts
    case "grant_withheld":
    case "push_failed":
    case "nothing_to_review":
    case "failed":
      return { outcome: "noop", message: `Delivery did not complete: ${outcome.message}` };
```

`DeliveryOutcome`'s member, `task-actions.server.ts:3343-3344`:

```ts
  /** The push failed outright; no PR was opened over a possibly-stale remote. */
  | { status: "push_failed"; message: string }
```

### 2c. Redaction machinery that already exists

`app/server/runtimes/run-sink.server.ts:91-132` — the pattern the audit points at (private consts today):

```ts
const REDACTED = "[redacted]";
const MIN_SECRET_VALUE_LEN = 12;
const TOKEN_SHAPE_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}", // ghp_/gho_/ghu_/ghs_/ghr_ GitHub tokens
  "github_pat_[A-Za-z0-9_]{20,}", // fine-grained PAT
  "sk-[A-Za-z0-9_-]{16,}", // sk-ant-…, sk-proj-…, OpenAI/Anthropic keys
].join("|");
...
export function createLineRedactor(env: NodeJS.ProcessEnv = process.env) { ... }
```

`createLineRedactor` is **not** reusable here: it keys off `CREDENTIAL_ENV_RE` over `process.env`, and the project PAT is never in `process.env` — it comes out of the encrypted store. Only `TOKEN_SHAPE_SOURCE` / `REDACTED` are reusable.

### 2d. Reconcile TOCTOU (F19-19)

`app/server/github/github-reconciler.server.ts:156-172` — read:

```ts
/**
 * Reconciles ONE task with GitHub. Idempotent: unchanged facts produce no
 * file write and no reprojection (`changed: false`), but always record a
 * provenance row for the observation.
 */
export async function reconcileTask(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<TaskReconcileResult> {
  const ref = taskRefOf(input, ctx);
  const file = readTaskFile(ref);
  if (!file) return { status: "task_not_found", taskKey: input.taskKey };
  const fm = file.parsed.frontmatter;
```

2-4 awaited GitHub round trips follow (`getBranchCompare` at `:180`, the PR reads, check-runs). Then `:385-419` computes every transition guard against the **pre-await** `fm.pr`:

```ts
  const acceptedClosedExternally =
    fm.pr?.state === "accepted" && newPr?.state === "closed" && fm.pr.number === newPr.number;
  ...
  const prJustMerged = newPr?.state === "merged" && fm.pr?.state !== "merged";
  const prJustClosed =
    newPr?.state === "closed" && fm.pr?.state !== "closed" && !acceptedClosedExternally;
  const mergedButNotDone = prJustMerged && !taskTerminal;
  const closedButActive = prJustClosed && !taskTerminal;
  const prJustReopened = fm.pr?.state === "closed" && newPr?.state === "review";
```

The write is at `:457` (`await patchTaskFrontmatter(ref, patch);`), the divergence note at `:488-505`, and `notifyTaskWatchers` at `:521-548`. `reconcileTask` ends at `:624`.

Nothing serializes two passes: `reconcileProject` (`:673`) fans out with `RECONCILE_TASK_CONCURRENCY` over **distinct** task keys but takes no per-task lock (`:749`); `runReconcile` (`app/features/github/github-actions.server.ts:44-50`) is not wrapped in `runSingleFlight`; `pollGithubReconcile` (`app/server/github/reconcile-poller.server.ts:115-124`) runs a boot pass plus a 5-minute interval independently. `reconcileTask` has exactly **two** production call sites: `:749` and the poller via `reconcileProject`.

`runSingleFlight` (`app/server/projections/single-flight.server.ts:51-66`) is explicitly *not* a mutex — it is a per-key cooldown for synchronous whole-store sweeps, and its docstring says a skipped run must be acceptable. It is the wrong tool here.

### 2e. Schedule mootness from a stale projection (F19-20)

`app/server/tasks/schedule.server.ts:228-240` — the tick's snapshot:

```ts
export function tasksWithUnresolvedSchedules(db: DatabaseSync): DueRow[] {
  return db
    .prepare(
      `SELECT project_slug, task_key, stage, archived, schedules_json
         FROM task_projections
        WHERE json_valid(schedules_json) ...`,
    )
    .all() as unknown as DueRow[];
}
```

`:303-312` — mootness decided from that snapshot:

```ts
    // P14-RV-03: an ARCHIVED task is as moot as a Done one. ...
    const isMoot =
      row.archived === 1 ||
      (terminalFor(row.project_slug) !== null &&
        row.stage === terminalFor(row.project_slug));
```

`:322-349` — the claim, which holds the canonical frontmatter under the file lock and re-checks **only `target.status`**:

```ts
        let claimed = false;
        const staleClaim = isStaleClaim(s);
        await updateTaskFile(taskFileRef(ctx, row.project_slug, row.task_key), (parsed) => {
          const target = parsed.frontmatter.schedules.find((x) => x.id === s.id);
          if (!target) return;
          if (target.status !== "pending" && !isStaleClaim(target)) return;
          if (isMoot) {
            target.status = "fired";
            target.firedAt = new Date().toISOString();
            parsed.timeline.unshift(
              scheduleEvent(
                { kind: "system", systemId: "schedule-runner" },
                `**Scheduled action skipped:** ${row.task_key} is already Done — the scheduled operator re-run is moot.`,
              ),
            );
          } else {
            target.status = "claimed";
            target.claimedAt = new Date().toISOString();
            parsed.timeline.unshift(
              scheduleEvent(
                { kind: "system", systemId: "schedule-runner" },
                `**Scheduled action starting:** ${staleClaim ? "recovering a stalled claim and re-" : ""}running the scheduled operator re-run for ${row.task_key}${s.note ? ` — ${s.note}` : ""}.`,
              ),
            );
          }
          claimed = true;
        });
        if (!claimed) continue; // another tick/restart already handled it
```

`updateTaskFile` **returns the written `ParsedTaskFile`** (`app/server/files/task-writer.server.ts:117-137`), which the current code discards.

`terminalStageId` (`schedule.server.ts:86-95`) is the structural resolver, module-private:

```ts
function terminalStageId(db: DatabaseSync, projectSlug: string): string | null {
  const project = getProject(db, projectSlug);
  if (!project) return null;
  return (
    resolveStageRoles(project.stages, project.workflow ?? []).terminalId ??
    project.stages[project.stages.length - 1]?.id ??
    null
  );
}
```

The detached drain, `:390-408`, re-checks nothing before running:

```ts
  if (toRun.length > 0) {
    void (async () => {
      const { runOperator } = await import("~/server/runtimes/operator-run.server");
      for (const t of toRun) {
        let ok = false;
        try {
          await runOperator(db, {
            projectSlug: t.projectSlug, taskKey: t.taskKey,
            backend: t.backend, autonomy: t.autonomy,
            trigger: "scheduled",
            ...(t.note ? { scheduleNote: t.note } : {}),
            dataRoot: ctx.dataRoot,
          });
          ok = true;
```

And `runOperator` (`app/server/runtimes/operator-run.server.ts:688-699`) has **no** terminal guard — confirmed: no `isTerminalStage` import in that file. A scheduled trigger arriving while the lease is held is queued (`:713-720`) and drained later by `releaseOperatorLease` (`:366-372`) / `drainPendingAfterInFlight` (`:383-392`) with no mootness re-check — and the drive it queued behind is frequently the one that calls `accept_completion`.

`RunOperatorResult` (`:139-156`) is `{ runId: string | null; queued: boolean; backend; autonomy }`.

---

## 3. Design

### Pair A — one redactor, one `detail` field, four surfaces

Add `app/server/secrets/git-output-redact.server.ts`: `redactGitOutput(text, { token })`, which

1. removes the **exact project PAT by value** (`split(token).join("[redacted]")` — no regex escaping needed, and both call sites hold the token at the failure site);
2. removes **URL userinfo** (`scheme://anything:anything@` → `scheme://[redacted]@`), which is the only shape a legacy token-bearing `remote.origin.url` can reach stderr in;
3. removes **token shapes** (`ghp_…`, `github_pat_…`, `sk-…`) hoisted out of `run-sink.server.ts` so there is one list;
4. **clamps** to the last 8 non-empty lines / 600 chars, so a note stays inside `operatorSnapshot`'s 1500-char cap.

Residual risk, stated plainly: a secret that is (a) not the project PAT, (b) not inside URL userinfo, and (c) not of a known token shape could survive. That requires git to print a credential nobody supplied to it — the PAT never reaches argv or the persisted remote (verified in §2a), and the askpass helper prints only to git's own stdin channel. Given git's stderr is already token-free *by construction*, layers 1-3 are defence in depth, not the primary guarantee. This is a deliberate reversal of the `cloneFailureLogDetails` docstring and needs a numbered ruling.

`detail` is a **separate optional field**, not appended to `sentence`. `cloneFailureSentence`'s contract is "one plain sentence, safe to show a human and to put in a prompt", and the prompt at `:1428` tells the agent to *"quote the reason above verbatim"* — folding multi-line git output into that sentence would have the agent parroting a stack of `remote:` lines as its blocked reason. The detail is rendered next to the sentence, as its own fenced block, at each surface.

Rejected alternative — **classify the push stderr into more typed reasons** (the audit's second correction: "a classified cause plus exit code"). Rejected because it is the same mistake one level up: every new class (`protected_branch`, `pre_receive_hook`, `permission_denied`, `dns`) is a guess at git's message catalogue that goes stale silently, and the human still cannot see what git actually said when the guess misses. `isNonFastForwardStderr` earns its classification because a *different product decision* hangs off it (never blame the credential, never open the PR). Nothing hangs off "protected branch" except the words. Exit code is likewise omitted: `git push` exits 1 for essentially every failure, so it adds a number that carries no information the stderr does not.

Rejected alternative — **reuse `createLineRedactor`**: it only knows credentials that live in `process.env`; the project PAT lives in the encrypted store and would not be redacted at all.

### F19-19 — a per-task async mutex inside `reconcileTask`

Serialize on `${dataRoot}::${projectSlug}/${taskKey}` with a promise chain, and put it **inside `reconcileTask`** so all callers (button, poller, future ones) are covered by construction.

A **queue, not a coalescer**. Coalescing (second caller joins the in-flight promise) would hand someone who clicks "Update status" *after* a merge landed the answer computed *before* they clicked — a freshness lie on the surface whose entire job is freshness. Queuing means the second pass re-reads the file after the first has written it, so `fm.pr.state` is already `merged` and `prJustMerged` is correctly false. That closes the note, the notification, the recommendation withdrawal, and the `autoInvokeOperator` edge in one place, and it fixes the *cause* (the pre-await snapshot) rather than four symptoms.

Rejected alternative — **a dedup key / "already announced" marker in frontmatter** (e.g. `fm.github.announcedPrState`). Rejected: it needs new persistent state, it must be replicated for all four note branches (`divergenceText`, `acceptedClosedText`, `reopenedText`, `collisionNote`), it leaves the underlying stale-read intact (both passes would still write `patch`, still fan out `autoInvokeOperator`), and it is not what NFR16 asks for.

Rejected alternative — **`runSingleFlight`**. Its own docstring forbids this use: it is a cooldown whose contract is "a skipped run is acceptable", and it is synchronous-only. A dropped reconcile after a real merge is exactly the run you must not skip.

Rejected alternative — **`outcome_key`** (grepped: `app/server/tasks/agent-outcome.server.ts:201-258`, the `staged_outcomes` table). That is a one-shot handoff for an agent's `report_outcome` envelope across a run boundary, keyed by a per-run id. It has no relationship to "this PR state was already announced" and would be a misuse of the table.

### F19-20 — decide mootness under the claim lock, then again at drive start

Three layers, in order of how the defect is actually reached:

1. **Primary (as instructed): inside the same locked read that claims the occurrence.** `updateTaskFile` already hands the callback the canonical `parsed.frontmatter` — `stage` and `archived` are right there. The projection row keeps its job (finding *candidates*); it loses its job of *deciding*. The outcome is read back off `updateTaskFile`'s **return value**, not off a closure variable, which also avoids TypeScript's assignment-in-closure narrowing trap.
2. **Drive-start guard for `trigger === "scheduled"`,** in `runOperator`, covering the queued-trigger drain (`releaseOperatorLease` → `void runOperator(db, queued)`) — the window the audit skeptic called "far more reachable", because the in-flight drive it queued behind is often the one that accepts the completion.
3. **Honest finalization**: when layer 2 refuses, the drain loop still retires the occurrence (never leaves it `claimed`) but writes a note saying the re-run was *not started*, instead of silently recording `fired`.

Note on the archived asymmetry, which the audit corrected: `archived` survives today only because `setTaskArchived` *also* flips the task's schedules to `cancelled` in the file (`task-actions.server.ts:4050-4055`, "belt-and-braces"), so the existing `target.status !== "pending"` re-check catches it. Done has no such second layer. Layer 1 gives both dimensions the same guard and lets that belt-and-braces stay belt-and-braces.

---

## 4. Changes

### 4.1 NEW `app/server/secrets/git-output-redact.server.ts`

```ts
/**
 * Scrub git's own output so it can be shown to a human (F19-6 / F19-18).
 *
 * The clone and push paths used to drop `stderr` wholesale "because child
 * process errors may echo command arguments or authentication diagnostics".
 * That premise does not hold for how Viberr invokes git: the PAT travels only
 * through `GIT_ASKPASS` (git-clone-auth.server), argv carries the
 * credential-free `https://github.com/<owner>/<repo>.git`, and the persisted
 * `remote.origin.url` is credential-free too. The cost of the suppression was a
 * real one: a live `git exit 128` clone failure left the agent blocked, the
 * operator opening an honest blocked packet, and no human anywhere able to
 * learn why.
 *
 * So: surface it, scrubbed. Three layers, strongest first —
 *   1. the EXACT project credential, by value (the caller holds it at the
 *      failure site, so this needs no guessing);
 *   2. URL userinfo (`https://user:secret@host`) — the one shape a legacy
 *      token-bearing origin from an older Viberr could reach stderr in;
 *   3. known token SHAPES, shared with the run-log redactor.
 * Then a hard clamp: the text lands on a timeline note the operator reads
 * through `operatorSnapshot`, which caps an event at 1500 chars.
 */
export const REDACTED = "[redacted]";

/** Token shapes worth redacting on sight — anchored prefixes + a length floor,
 *  so ordinary prose ("sk-1", "gh_") is never touched. Shared with
 *  `createLineRedactor` (run-sink.server) so there is ONE list. */
export const TOKEN_SHAPE_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}", // ghp_/gho_/ghu_/ghs_/ghr_ GitHub tokens
  "github_pat_[A-Za-z0-9_]{20,}", // fine-grained PAT
  "sk-[A-Za-z0-9_-]{16,}", // sk-ant-…, sk-proj-…, OpenAI/Anthropic keys
].join("|");

/** `scheme://user:secret@host` — git echoes remote URLs verbatim. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi;

/** Below this a "token" is a flag, not a secret — scrubbing it would mangle
 *  ordinary output. */
const MIN_TOKEN_LEN = 8;

/** The tail is where git puts its diagnosis; the head is the command echo. */
const MAX_DETAIL_LINES = 8;
/** Keeps the note inside operatorSnapshot's 1500-char per-event cap. */
const MAX_DETAIL_CHARS = 600;

export function redactGitOutput(
  text: string | null | undefined,
  opts: { token?: string | null } = {},
): string {
  if (!text) return "";
  let out = text;
  if (opts.token && opts.token.length >= MIN_TOKEN_LEN) {
    out = out.split(opts.token).join(REDACTED);
  }
  out = out.replace(URL_USERINFO_RE, `$1${REDACTED}@`);
  out = out.replace(new RegExp(TOKEN_SHAPE_SOURCE, "g"), REDACTED);
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const kept = lines.slice(-MAX_DETAIL_LINES).join("\n").trim();
  return kept.length > MAX_DETAIL_CHARS ? `${kept.slice(0, MAX_DETAIL_CHARS)}…` : kept;
}

/** The best text a rejected `execFile` promise can offer: git's stderr when it
 *  said anything, else the wrapper's message (which quotes argv — already
 *  credential-free, and scrubbed anyway). */
export function gitErrorText(error: unknown): string {
  const e =
    typeof error === "object" && error !== null
      ? (error as { stderr?: unknown; message?: unknown })
      : {};
  const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
  if (stderr) return stderr;
  return typeof e.message === "string" ? e.message : "";
}
```

### 4.2 `app/server/runtimes/run-sink.server.ts` — use the shared list

Anchor: the consts at `:91-106`, and `createLineRedactor` at `:117-132`.

Before (`:91-106`):
```ts
const REDACTED = "[redacted]";
...
const TOKEN_SHAPE_SOURCE = [
  "gh[pousr]_[A-Za-z0-9]{16,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "sk-[A-Za-z0-9_-]{16,}",
].join("|");
```
After: delete both consts; add to the import block at the top of the file:
```ts
import { REDACTED, TOKEN_SHAPE_SOURCE } from "~/server/secrets/git-output-redact.server";
```
(`MIN_SECRET_VALUE_LEN` at `:98` stays — it is about env-var values, not git output.) `:128` and `:131` are unchanged and now consume the shared values.

### 4.3 `app/server/tasks/git-clone-auth.server.ts` — carry a scrubbed `detail`

Anchor A — `CloneFailureLogDetails`, `:183-187`:

```ts
export interface CloneFailureLogDetails {
  reason: "git_unavailable" | "clone_failed" | "clone_terminated";
  exitCode?: number;
  signal?: string;
+ /**
+  * F19-6: git's OWN failure text, scrubbed (`redactGitOutput`). Absent when
+  * git printed nothing. This is the only channel that can tell a human why a
+  * transient `exit 128` happened — without it the operator's blocked packet
+  * recommends "hold for infra to investigate" with nothing to investigate.
+  */
+ detail?: string;
}
```

Anchor B — `cloneFailureLogDetails`, `:223-247`. Replace the docblock and the signature; the classification body is untouched:

```ts
/**
 * Classify a failed clone, and carry git's own words along — SCRUBBED.
 *
 * This used to drop `Error.message`, `stderr` and `cmd` outright "because child
 * process errors may echo command arguments or authentication diagnostics".
 * That cost more than it bought (F19-6): a transient `git exit 128` on a
 * healthy project produced ONE log line and no other artifact anywhere, so the
 * agent reported blocked, the operator opened an honest blocked packet, and no
 * human could act on either. The PAT reaches git only through `GIT_ASKPASS` —
 * never argv, never the remote URL — so stderr is token-free by construction;
 * `redactGitOutput` scrubs the known token value, URL userinfo and token shapes
 * on top of that. Pass the token whenever the caller has it.
 */
export function cloneFailureLogDetails(
  error: unknown,
  opts: { token?: string | null } = {},
): CloneFailureLogDetails {
  const value = /* …unchanged… */;
  const code = value.code;
  const signal = /* …unchanged… */;
  const reason = /* …unchanged… */;
+ const detail = redactGitOutput(gitErrorText(error), opts);

  return {
    reason,
    ...(typeof code === "number" ? { exitCode: code } : {}),
    ...(signal ? { signal } : {}),
+   ...(detail ? { detail } : {}),
  };
}
```

Add at the top of the file:
```ts
import { gitErrorText, redactGitOutput } from "~/server/secrets/git-output-redact.server";
```

`cloneFailureSentence` (`:199-221`) is **unchanged** — it stays one plain sentence.

### 4.4 `app/server/tasks/specialist-run.server.ts` — hoist the token, render the detail

Anchor A — `cloneRepo`, `:1842`:

```ts
  let hadCredential = false;
+ // Hoisted so the catch below can scrub git's stderr BY VALUE (F19-6).
+ let cloneToken: string | null = null;
```

Anchor B — `:1874-1876`:

```ts
    const cred = getProjectCredential(db, input.projectSlug);
    const token = cred ? getPatToken(db, cred.id) : null;
    hadCredential = !!token;
+   cloneToken = token;
```

Anchor C — `:1907`:

```ts
-   const details = cloneFailureLogDetails(error);
+   const details = cloneFailureLogDetails(error, { token: cloneToken });
```
(`logger.warn` at `:1908-1914` already spreads `...details`, so `detail` lands in the server log with no further edit; `failure: { ...details, ... }` at `:1917-1918` carries it into `CloneFailure` because that interface extends `CloneFailureLogDetails`.)

Anchor D — the timeline note, `:942-960`. Append the fenced block:

```ts
          text:
            `**Workspace checkout failed:** ${cloneFailure.sentence} ` +
            `The agent is running against an EMPTY workspace, so it cannot read or change ${repo}. ` +
            (cloneFailure.reason === "clone_terminated"
              ? "Raise `VIBERR_GIT_CLONE_TIMEOUT_MS` if this repository simply needs longer, then re-run."
              : "Re-run once the cause above is addressed.") +
+           (cloneFailure.detail
+             ? `\n\nWhat git reported (secrets removed):\n\n\`\`\`\n${cloneFailure.detail}\n\`\`\``
+             : ""),
```

Anchor E — the prompt input type, `:1381`:

```ts
- cloneFailure?: { sentence: string; hadCredential: boolean } | null;
+ cloneFailure?: {
+   sentence: string;
+   hadCredential: boolean;
+   /** F19-6: git's own words, scrubbed. The agent quotes them, so the reason
+    *  reaches its report — and through the report, the operator's packet. */
+   detail?: string;
+ } | null;
```

Anchor F — the call site, `:922-929`:

```ts
    ...(cloneFailure
      ? {
          cloneFailure: {
            sentence: cloneFailure.sentence,
            hadCredential: cloneFailure.hadCredential,
+           ...(cloneFailure.detail ? { detail: cloneFailure.detail } : {}),
          },
        }
      : {}),
```

Anchor G — the prompt render, `:1425-1434`. Insert after the `${input.cloneFailure.sentence}\n` line:

```ts
            `- **The workspace has NO checkout, and this is a server-side failure, not something you can fix.** ` +
            `${input.cloneFailure.sentence}\n` +
+           (input.cloneFailure.detail
+             ? `- What git reported (secrets already removed — quote it, do not re-run git):\n\`\`\`\n${input.cloneFailure.detail}\n\`\`\`\n`
+             : "") +
            `- Do NOT try to clone, fetch, or authenticate to \`${input.repo}\` yourself, ...
```

### 4.5 `app/server/github/push-workspace.server.ts` — split `push_failed`, carry `detail`

Anchor A — the result union, `:36-52`:

```ts
export type PushWorkspaceResult =
  | { status: "pushed"; branch: string; commits: number }
  | { status: "push_conflict"; branch: string; reason: string }
+ /** F19-18: the residual failure bucket. `reason` is Viberr's sentence;
+  *  `detail` is git's own text, scrubbed (`redactGitOutput`). Without the
+  *  latter, a protected-branch / pre-receive / permission rejection reached a
+  *  human as the literal words "git push returned non-zero" and they had to
+  *  reproduce the push outside the product to learn the cause. */
+ | { status: "push_failed"; reason: string; detail?: string }
  | {
      status:
        | "no_pat"
        | "no_repo"
        | "no_workspace"
        | "no_branch"
        | "no_commits"
-       | "push_failed"
        | "grant_withheld"
        | "task_not_found";
      reason: string;
    };
```

Anchor B — `:391-402`:

```ts
-       // Redact stderr — a git push failure can echo the remote URL/token.
-       logger.info("workspace branch push failed", {
+       // F19-18: git's stderr is SCRUBBED, not dropped. `createGitHubAskpassEnv`
+       // keeps the PAT out of argv and out of the remote URL, so what remains is
+       // git's diagnosis — the only text that can name a protected branch, a
+       // push ruleset or a pre-receive hook. WARN, not info: this is a delivery
+       // that did not happen (same reasoning as the clone path).
+       const detail = redactGitOutput(pushRes.stderr, { token });
+       logger.warn("workspace branch push failed", {
          taskKey,
          branch,
          ...(pushRes.timedOut ? { timedOut: true } : {}),
+         ...(detail ? { detail } : {}),
        });
        return {
          status: "push_failed",
          reason: pushRes.timedOut
            ? `the push was cancelled after ${PUSH_TIMEOUT_MS / 1000}s — it ran past its time limit rather than failing`
            : "git push returned non-zero",
+         ...(detail ? { detail } : {}),
        };
```

Add to the imports (near `:10`):
```ts
import { redactGitOutput } from "~/server/secrets/git-output-redact.server";
```

### 4.6 `app/server/tasks/task-actions.server.ts` — surface the push detail

Anchor A — `DeliveryOutcome`, `:3343-3344`:

```ts
  /** The push failed outright; no PR was opened over a possibly-stale remote. */
- | { status: "push_failed"; message: string }
+ | { status: "push_failed"; message: string }
```
(unchanged shape — `detail` is folded into `message` so every existing consumer, including `operatorDeliverForReview`'s `Delivery did not complete: ${outcome.message}` at `operator-actions.server.ts:1903`, carries it with no edit.)

Anchor B — `:3429-3442`:

```ts
    if (push.status === "push_failed" || push.status === "no_pat") {
+     const detail = push.status === "push_failed" ? push.detail : undefined;
      const message =
        `${taskKey}'s execution branch could not be pushed (${push.status === "no_pat" ? "no project credential" : push.reason}). ` +
        `No review PR was opened — a PR over a remote missing the newest commits would ` +
-       `review the wrong content. Fix the push, then deliver again.`;
+       `review the wrong content. Fix the push, then deliver again.` +
+       (detail ? `\n\nWhat git reported (secrets removed):\n\n\`\`\`\n${detail}\n\`\`\`` : "");
      await surfaceDeliveryEvent(
        db, ctx, projectSlug, taskKey, "Delivery push failed", message,
      );
      return { status: "push_failed", message };
    }
```

### 4.7 `app/server/github/github-reconciler.server.ts` — per-task reconcile mutex

Anchor — insert immediately above the `reconcileTask` docblock at `:156`, then rename the existing function and wrap it.

Insert before `:156`:

```ts
/**
 * F19-19: ONE reconcile pass per task at a time.
 *
 * `reconcileTask` reads task.md, then awaits 2-4 GitHub round trips before it
 * writes (:167 read → :457 write). Every out-of-band transition guard
 * (`prJustMerged` / `prJustClosed` / `prJustReopened` / `acceptedClosedExternally`,
 * :385-419) compares the LIVE PR against that PRE-AWAIT snapshot, and nothing
 * serialized two passes: the poller runs on its own boot pass + 5-minute
 * interval, `runReconcile` takes no lock, and the "Update status" button's
 * `disabled` is per-fetcher, so two tabs (or a returning maintainer clicking
 * during the boot pass) race. Both passes then read `pr.state: review`, both
 * learn GitHub says merged, and the task gets the divergence note TWICE and
 * every supervisor gets two identical inbox alerts for one event.
 *
 * A QUEUE, not a coalescer: the second pass runs its own read AFTER the first
 * has written, so it sees the new `fm.pr` and correctly reports "nothing new".
 * Coalescing would hand whoever pressed "Update status" the answer computed
 * before they pressed it — a freshness lie on the one surface whose job is
 * freshness.
 *
 * NOT `runSingleFlight`: that is a synchronous per-key COOLDOWN whose contract
 * is "a skipped run is acceptable", and a reconcile dropped right after a real
 * merge is exactly the one that must not be skipped.
 *
 * In-process, matching the single-node deployment (same scope as the operator
 * lease). Keyed per task, so `reconcileProject`'s concurrency is unaffected —
 * different tasks never block each other.
 */
const taskReconcileChain = new Map<string, Promise<void>>();

function withTaskReconcileLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = taskReconcileChain.get(key) ?? Promise.resolve();
  // Run regardless of whether the predecessor resolved or rejected — one
  // task's failed reconcile must never strand the next pass.
  const run = previous.then(work, work);
  // The chain link NEVER rejects, so a failure cannot poison the successor.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  taskReconcileChain.set(key, tail);
  void tail.then(() => {
    if (taskReconcileChain.get(key) === tail) taskReconcileChain.delete(key);
  });
  return run;
}
```

Then at `:161-166`, rename and add the wrapper:

```ts
-export async function reconcileTask(
+async function reconcileTaskUnlocked(
   db: DatabaseSync,
   input: { projectSlug: string; taskKey: string },
   actor: AuditActor,
   ctx: GithubActionContext = {},
 ): Promise<TaskReconcileResult> {
```

…body unchanged through `:624`. Immediately after the closing `}` at `:624`, add:

```ts
/**
 * Reconciles ONE task with GitHub. Idempotent: unchanged facts produce no
 * file write and no reprojection (`changed: false`), but always record a
 * provenance row for the observation. Serialized per task — see
 * `withTaskReconcileLock` (F19-19).
 */
export function reconcileTask(
  db: DatabaseSync,
  input: { projectSlug: string; taskKey: string },
  actor: AuditActor,
  ctx: GithubActionContext = {},
): Promise<TaskReconcileResult> {
  return withTaskReconcileLock(
    // dataRoot is part of the key so two test stores that share a slug do not
    // serialize against each other.
    `${ctx.dataRoot ?? ""}::${input.projectSlug}/${input.taskKey}`,
    () => reconcileTaskUnlocked(db, input, actor, ctx),
  );
}
```

(The old docblock at `:156-160` moves onto the new exported wrapper; `reconcileTaskUnlocked` keeps a one-line `/** Body of reconcileTask — always entered through the per-task lock. */`.)

### 4.8 `app/server/tasks/schedule.server.ts` — decide mootness under the lock

Anchor A — `:303-312`, replace the projection-derived `isMoot`:

```ts
-    // P14-RV-03: an ARCHIVED task is as moot as a Done one. Archiving withdraws
-    // the packet and the recommendations but never touched `schedules`, ...
-    const isMoot =
-      row.archived === 1 ||
-      (terminalFor(row.project_slug) !== null &&
-        row.stage === terminalFor(row.project_slug));
+    // F19-20: the projection row FINDS candidates; it no longer DECIDES. FR39
+    // says a scheduled re-run never fires on a terminal stage, and `row.stage`
+    // is a snapshot taken at the top of the tick — an acceptance that lands
+    // between the SELECT and this row's claim leaves it reading the pre-accept
+    // stage, and the occurrence is claimed and a real, unwatched operator turn
+    // is enqueued on a task that is Done and merged. The claim below already
+    // holds the canonical frontmatter under the file lock; that is what decides.
+    //
+    // (`archived` survived this only because `setTaskArchived` ALSO cancels the
+    // schedules in the file — task-actions.server:4050, "belt-and-braces" — so
+    // the `status !== "pending"` re-check caught it. Done had no second layer.
+    // Both dimensions are now decided from the same locked read.)
+    const terminal = terminalFor(row.project_slug);
```

Anchor B — `:322-349`, the claim:

```ts
         let claimed = false;
         const staleClaim = isStaleClaim(s);
-        await updateTaskFile(taskFileRef(ctx, row.project_slug, row.task_key), (parsed) => {
+        const claimedFile = await updateTaskFile(
+          taskFileRef(ctx, row.project_slug, row.task_key),
+          (parsed) => {
           const target = parsed.frontmatter.schedules.find((x) => x.id === s.id);
           if (!target) return;
           if (target.status !== "pending" && !isStaleClaim(target)) return;
-          if (isMoot) {
+          // FR39, decided HERE: the canonical stage/archived under the lock.
+          const mootNow =
+            parsed.frontmatter.archived === true ||
+            (terminal !== null && parsed.frontmatter.stage === terminal);
+          if (mootNow) {
             target.status = "fired";
             target.firedAt = new Date().toISOString();
             parsed.timeline.unshift(
               scheduleEvent(
                 { kind: "system", systemId: "schedule-runner" },
-                `**Scheduled action skipped:** ${row.task_key} is already Done — the scheduled operator re-run is moot.`,
+                parsed.frontmatter.archived === true
+                  ? `**Scheduled action skipped:** ${row.task_key} has been archived — the scheduled operator re-run is moot.`
+                  : `**Scheduled action skipped:** ${row.task_key} is already Done — the scheduled operator re-run is moot.`,
               ),
             );
           } else {
             /* …claimed branch unchanged… */
           }
           claimed = true;
-        });
+          },
+        );
         if (!claimed) continue; // another tick/restart already handled it
+        // Read the decision back off the file that was WRITTEN, not off a
+        // closure variable — `updateTaskFile` returns the resulting parse, and a
+        // `let` assigned inside the callback would be narrowed to its initializer
+        // by TS at every read site out here.
+        const claimedSchedule = claimedFile.frontmatter.schedules.find(
+          (x) => x.id === s.id,
+        );
+        const wasMoot = claimedSchedule?.status === "fired";
         reproject(db, ctx, row.project_slug, row.task_key);
```

Anchor C — the audit `outcome`, `:358-366`:

```ts
           details: {
             scheduleId: s.id,
-            outcome: isMoot
-              ? row.archived === 1
-                ? "skipped-archived"
-                : "skipped-done"
-              : "claimed",
+            outcome: wasMoot
+              ? claimedFile.frontmatter.archived === true
+                ? "skipped-archived"
+                : "skipped-done"
+              : "claimed",
           },
```

Anchor D — the counters, `:367-378`:

```ts
-        if (isMoot) {
+        if (wasMoot) {
           skipped += 1;
         } else {
           toRun.push({ /* unchanged */ });
           fired += 1;
         }
```

Anchor E — new export, added after `terminalStageId` (`:95`):

```ts
/**
 * FR39, asked at DRIVE time: is a scheduled re-run on this task already moot?
 *
 * The claim-time check above closes the tick's own window. This closes the
 * second, wider one: a scheduled trigger that arrives while another operator
 * drive holds the lease is QUEUED and drained on release
 * (operator-run.server:366) — and the drive it queued behind is frequently the
 * one that called `accept_completion`. Reads the canonical file; a file it
 * cannot read is UNKNOWN, not moot (never swallow a run on a bad read).
 */
export function scheduledRunIsMoot(
  db: DatabaseSync,
  ref: { projectSlug: string; taskKey: string; dataRoot?: string },
): boolean {
  const file = readTaskFile(
    taskFileRef(
      ref.dataRoot ? { dataRoot: ref.dataRoot } : {},
      ref.projectSlug,
      ref.taskKey,
    ),
  );
  if (!file) return false;
  const fm = file.parsed.frontmatter;
  if (fm.archived === true) return true;
  const terminal = terminalStageId(db, ref.projectSlug);
  return terminal !== null && fm.stage === terminal;
}
```

Anchor F — the drain loop, `:393-431`:

```ts
       for (const t of toRun) {
         let ok = false;
+        // Explicit annotation: this is read inside the finalize callback below,
+        // where TS would otherwise use the `false` literal type.
+        let refused: boolean = false;
         try {
-          await runOperator(db, { /* unchanged */ });
+          const result = await runOperator(db, { /* unchanged */ });
+          if (result.refused) {
+            refused = true;
+            logger.info("scheduled operator re-run was not started — the task closed first", {
+              taskKey: t.taskKey,
+              projectSlug: t.projectSlug,
+              refused: result.refused,
+            });
+          }
           ok = true;
         } catch (error) { /* unchanged */ }
```

and inside the finalize callback (`:427-432`):

```ts
               if (ok) {
                 target.status = "fired";
                 target.firedAt = new Date().toISOString();
                 target.claimedAt = null;
+                if (refused) {
+                  // Honesty: the occurrence is retired (never left `claimed`),
+                  // but the record must not read as though the re-run happened.
+                  parsed.timeline.unshift(
+                    scheduleEvent(
+                      { kind: "system", systemId: "schedule-runner" },
+                      `**Scheduled action skipped:** ${t.taskKey} closed before its scheduled operator re-run started — no run was started.`,
+                    ),
+                  );
+                }
                 return;
               }
```

### 4.9 `app/server/runtimes/operator-run.server.ts` — drive-start FR39 guard

Anchor A — `RunOperatorResult`, `:139-156`, add after `queued`:

```ts
+  /** F19-20/FR39: this trigger was REFUSED before any run started. Today the
+   *  only cause is a `scheduled` trigger on a task that reached its terminal
+   *  stage (or was archived) after the schedule was claimed. `runId` is null
+   *  and `queued` is false — nothing ran and nothing is pending. */
+  refused?: "task-closed";
```

Anchor B — insert immediately after `const backend = authority.backend;` (`:699`), **before** the lease block (the `check → set` synchronicity comment at `:772-774` refers to the held-check at `:701` onward, so an await here is safe):

```ts
  // FR39 (F19-20): a SCHEDULED re-run never starts on a task that has reached
  // its terminal stage or been archived. `fireDueSchedules` re-checks under the
  // claim lock, which closes the tick's window; this closes the wider one — a
  // scheduled trigger queued behind an in-flight drive is drained on lease
  // release with no mootness check, and that drive is frequently the one that
  // accepted the completion. Dynamic import keeps operator-run free of a static
  // schedule cycle (schedule.server already imports THIS module dynamically).
  if (input.trigger === "scheduled") {
    const { scheduledRunIsMoot } = await import("~/server/tasks/schedule.server");
    if (
      scheduledRunIsMoot(db, {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
        ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
      })
    ) {
      logger.info("scheduled operator re-run refused — the task is already closed", {
        projectSlug: input.projectSlug,
        taskKey: input.taskKey,
      });
      return {
        runId: null,
        queued: false,
        refused: "task-closed",
        backend,
        autonomy: authority.autonomy,
      };
    }
  }
```

---

## 5. Tests

### T1 — `app/server/secrets/git-output-redact.server.test.ts` (NEW)

`describe("redactGitOutput")`

- **`it("removes the project PAT by value, wherever git echoed it")`** — input `"remote: Invalid credentials ghp_short\nfatal: Authentication failed for 'https://github.com/a/b.git'"` with `{ token: "ghp_short" }`; asserts the output contains `"Authentication failed"` and `"[redacted]"` and **not** `"ghp_short"`. This token is deliberately below the shape regex's 16-char floor, so only the by-value layer can catch it.
  **Canary:** delete the `opts.token` split branch → the token survives.
- **`it("removes a legacy token-bearing origin URL even when the token value is unknown")`** — input `"fatal: unable to access 'https://x-access-token:github_pat_11ABCDE_zzzzzzzzzzzzzzzzzzzzzzzz@github.com/a/b.git/'"` with **no** `token` option; asserts output has no `"github_pat_"` and no `"x-access-token:"`, and still contains `"unable to access"`.
  **Canary:** remove the `URL_USERINFO_RE` replace → the userinfo survives (the shape rule alone would leave `x-access-token:` and the host intact).
- **`it("keeps git's diagnosis and never mangles ordinary output")`** — input a 5-line protected-branch rejection (`remote: error: GH006: Protected branch update failed for refs/heads/vib-7.` … `error: failed to push some refs`) with `{ token: "ghp_realtoken0123456789" }`; asserts the result contains `"GH006"` and `"Protected branch"` and equals the input's non-empty lines joined (nothing redacted).
  **Canary:** widen `TOKEN_SHAPE_SOURCE` to an entropy heuristic → words get mangled and the equality fails.
- **`it("clamps to the tail so a timeline note stays inside the operator's 1500-char snapshot cap")`** — 40 lines of 100 chars; asserts `result.split("\n").length <= 8` and `result.length <= 601`, and that the LAST input line is present (git puts its diagnosis at the end).
  **Canary:** drop the `slice(-MAX_DETAIL_LINES)` / char clamp → both assertions fail.
- **`it("is empty for empty input")`** — `redactGitOutput("")`, `redactGitOutput(null)` → `""`. Guards the `if (!text)` early return that keeps the no-secret path allocation-free.

`describe("gitErrorText")`
- **`it("prefers stderr, falls back to the wrapper message")`** — `{ stderr: "fatal: x", message: "Command failed: git clone …" }` → `"fatal: x"`; `{ message: "Command failed: git clone …" }` → the message; `{}` → `""`.
  **Canary:** swap the precedence → the first assertion fails.

### T2 — `app/server/tasks/git-clone-auth.server.test.ts` (CHANGED)

Two existing tests must move because the shape they assert is now wrong (breaking change, allowed):

- **`:122-137 "never copies credential-bearing child-process diagnostics into logs"`** → rename to **`it("carries git's words but never the credential (F19-6)")`**. Keep the same fixture error (message + `stderr` + `cmd` all carrying `github_pat_DO_NOT_LEAK_456`), call `cloneFailureLogDetails(error, { token })`, then assert:
  - `details.reason === "clone_failed"`, `details.exitCode === 128`;
  - `details.detail` **contains** `"remote rejected"` (git's own words survive);
  - `JSON.stringify(details)` does **not** contain the token.
  The old `expect(details).toEqual({ reason: "clone_failed", exitCode: 128 })` is replaced — that assertion IS the defect.
  **Canary:** delete the `detail` line from the return object → the "contains `remote rejected`" assertion fails.
- **NEW `it("scrubs a token it was not told about, by shape")`** — an error whose stderr carries `github_pat_11AAAAAAA0aaaaaaaaaaaaaaaaaaaaaaaaaaaa` (long enough for the shape rule), called **without** `opts.token`; asserts `details.detail` contains `"[redacted]"` and not the token.
  **Canary:** drop `TOKEN_SHAPE_SOURCE` from `redactGitOutput` → the token survives.
- **`:180-188 "carries no token, whatever the inputs"`** → keep the name, pass `{ token }` to `cloneFailureLogDetails`, and additionally assert `cloneFailureSentence(details, …)` still does **not** contain the detail (the sentence stays one plain sentence — the detail rides its own field).
  **Canary:** append `details.detail` into `cloneFailureSentence` → the new assertion fails.

### T3 — `app/server/github/push-workspace.server.test.ts` (CHANGED + NEW)

- **CHANGED `:252 "returns push_failed when git push errors"`** → extend `fakeGit` call with `pushStderr` and add: `expect(res.status === "push_failed" && res.detail).toContain("GH006")`.
- **NEW `it("F19-18: a rejected push carries git's own reason, scrubbed, instead of 'returned non-zero'")`** — `bindPat()` (which stores `ghp_faketoken123`), `fakeGit({ pushOk: false, pushStderr: "remote: error: GH006: Protected branch update failed for refs/heads/vib-1-work.\nremote: error: At least 1 approving review is required.\nTo https://x-access-token:ghp_faketoken123@github.com/akin-ozer/viberr.git\n ! [remote rejected] vib-1-work -> vib-1-work (protected branch hook declined)\nerror: failed to push some refs" })`. Asserts:
  - `status === "push_failed"` (not `push_conflict` — `isNonFastForwardStderr` must not claim this one);
  - `detail` contains `"GH006"` and `"protected branch hook declined"`;
  - `detail` does **not** contain `"ghp_faketoken123"` nor `"x-access-token:"`.
  **Canary:** delete the `...(detail ? { detail } : {})` spread from the `push_failed` return → the GH006 assertion fails. Second canary: pass `{}` instead of `{ token }` to `redactGitOutput` → the token assertion still passes (URL-userinfo layer), which is the point of the layered design; drop the userinfo rule as well and it fails.
- Unchanged and must stay green: `:262 "a push KILLED by its timeout says so"` (timeout keeps its own `reason`; `detail` will be empty because the fake supplies no stderr for that case) and `:303 "B-GH1/F15-15 … non-fast-forward is push_conflict"` (classification runs **before** the new detail block).

### T4 — delivery timeline, `app/server/tasks/task-actions.server.test.ts` (or the delivery-focused sibling that already exercises `performDelivery`)

- **NEW `describe("performDelivery push failure (F19-18)") > it("puts git's scrubbed reason on the timeline, not just 'returned non-zero'")`** — stub `~/server/github/push-workspace.server` (`vi.mock`) so `pushWorkspaceBranch` resolves `{ status: "push_failed", reason: "git push returned non-zero", detail: "remote: error: GH006: Protected branch update failed" }`. Asserts the `task_events` row written by `surfaceDeliveryEvent` contains `"GH006"`, and that the returned `DeliveryOutcome.message` does too (so `operatorDeliverForReview`'s `Delivery did not complete: ${outcome.message}` carries it into the operator's tool result).
  **Canary:** drop the `detail ? … : ""` concatenation in `task-actions.server.ts:3429-3442` → both assertions fail.

### T5 — `app/server/github/github-reconciler.server.test.ts` (NEW, inside `describe("reconcileTask")`)

- **NEW `it("F19-19: two OVERLAPPING passes announce an out-of-band merge exactly once")`** — reuses the `setup()` fixture (VIB-301 at `review`, owner arda, `pr: { number: 318, state: "review" }`) and the `routes` from the existing `:583` merged-out-of-band test. Fire **concurrently**:

  ```ts
  const gh = fakeGithubFetch(routes);
  await Promise.all([
    reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
    reconcileTask(store.db, { projectSlug: store.slug, taskKey: "VIB-301" }, actor,
      { dataRoot: store.dataRoot, fetchImpl: gh.fetchImpl }),
  ]);
  ```
  Asserts:
  - exactly ONE `task_events` row matching `/\*\*Divergence:\*\* PR #318 was merged on GitHub/`;
  - exactly ONE `listNotifications(store.db, store.users.arda.id)` row matching `/merged on GitHub/`;
  - the stage is still `"review"` (the mutex must not change the no-auto-advance rule).

  **Canary:** call `reconcileTaskUnlocked` directly from the test (or delete `withTaskReconcileLock`'s body so it degrades to `work()`) → both counts become 2. This is the exact assertion the existing sequential test at `:611-622` cannot make.
- **NEW `it("F19-19: the lock is per TASK — a failed reconcile never strands the next pass")`** — two concurrent `reconcileTask` calls where the first task's `fetchImpl` throws (network) and a *second, different* task reconciles normally; asserts the second resolves `status: "reconciled"`. Guards the `previous.then(work, work)` rejection handling.
  **Canary:** change to `previous.then(work)` → the chain rejects and the second call never runs (test times out / rejects).
- Unchanged and must stay green: `:454 "is idempotent: identical GitHub facts → no file write"`, `:421 "the collision is reported ONCE, not on every 5-minute poll"`, `:583` merged-out-of-band, `:1063 describe("reconcileProject")` (fan-out over distinct keys must not serialize — the existing `RECONCILE_TASK_CONCURRENCY` test still passes because the key includes the task key).

### T6 — `app/server/tasks/schedule.server.test.ts` (NEW, inside `describe("fireDueSchedules")`)

- **NEW `it("F19-20/FR39: a task that reached Done AFTER the tick's snapshot never fires")`** — construct the stale snapshot directly:

  ```ts
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { stage: "impl", schedules: [rawSchedule({ id: "sch_race" })] }),
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true }); // projection says `impl`
  // The acceptance that landed mid-tick: the FILE moves to Done, the projection
  // row is deliberately NOT rebuilt — exactly the state fireDueSchedules opens with.
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { stage: terminalStage(), schedules: [rawSchedule({ id: "sch_race" })] }),
  });

  const res = await fireDueSchedules(store.db, dctx());
  expect(res.fired).toBe(0);
  expect(res.skipped).toBe(1);
  expect(schedules("VIB-4")[0]!.status).toBe("fired");
  expect(listAuditEvents(store.db).find((e) => e.action === "task.schedule.fired")!.details?.outcome)
    .toBe("skipped-done");
  expect(startedRunSpecs().some((s) => s.kind === "operator")).toBe(false);
  ```
  **Canary:** restore `const isMoot = row.archived === 1 || row.stage === terminalFor(...)` and use it in the callback → `fired` becomes 1, an operator run spec appears, and the audit outcome reads `"claimed"`.
- **NEW `it("F19-20: an archive that lands mid-tick retires the occurrence with its own words")`** — same stale-projection shape with `archived: true` on the second write; asserts `outcome: "skipped-archived"` and that the timeline note says `"has been archived"`, not `"is already Done"`.
  **Canary:** collapse the two copy branches back to one → the copy assertion fails.
- **NEW `it("F19-20: a scheduled trigger drained after the task closed does not start a run")`** — calls `runOperator(db, { projectSlug, taskKey, trigger: "scheduled", dataRoot })` directly against a task whose file is at `terminalStage()`; asserts `result.refused === "task-closed"`, `result.runId === null`, `result.queued === false`, and `startedRunSpecs()` gained no operator spec.
  **Canary:** remove the `if (input.trigger === "scheduled")` block from `runOperator` → `refused` is undefined and a run spec appears.
- **NEW `it("F19-20: a NON-scheduled trigger on a closed task is untouched")`** — same task, `trigger: "pr-diverged"`; asserts `refused` is undefined and a run started. This pins the guard's scope: FR39 is about *scheduled* runs, and a merged-out-of-band recovery turn on a closed task is legitimate.
  **Canary:** widen the guard to all triggers → this fails.
- Unchanged and must stay green: `:167 "P14-RV-03: an ARCHIVED task never fires"` (its projection and file agree, so the new locked read reaches the same verdict), `:239 "retires a due schedule on a Done task (skipped-done)"`, `:198`/`:219` stale/fresh claim, `:253` B-WF3 scheduled prompt.

---

## 6. Risks / call sites

**Type changes and every site that must move (tsc gate):**

- `cloneFailureLogDetails(error)` → `cloneFailureLogDetails(error, opts?)`. Callers: `specialist-run.server.ts:1907` (updated, §4.4-C) and `git-clone-auth.server.test.ts:134, :182` (updated, §T2). The parameter is optional, so nothing else breaks.
- `CloneFailureLogDetails` gains `detail?`. `CloneFailure` (`specialist-run.server.ts:1809`) extends it — no edit needed, but the new field is now part of the object spread into `logger.warn` at `:1913`.
- `buildAnalyzePrompt`'s `cloneFailure` param gains `detail?` — one caller, `specialist-run.server.ts:922`.
- `PushWorkspaceResult` splits `push_failed` out of the multi-status member. Discriminated-union narrowing keeps working at `task-actions.server.ts:3411` (`push_conflict`), `:3429` (`push_failed || no_pat` — both members carry `reason`), and `:3446` (the residual `push.status !== "pushed"` chain, which now excludes `push_failed` by control flow, as it already did). `github-reconciler`/`workspace-delivery` do not consume this type. Verify by grep: `push_failed` appears only at `push-workspace.server.ts:398`, `task-actions.server.ts:3344/3429/3442`, `operator-actions.server.ts:1899`, plus tests.
- `RunOperatorResult` gains `refused?` — optional; the three other `return` sites in `runOperator` (`:723-728`, `:757-762`, and the success return) need no edit. Consumers: `schedule.server.ts:396` (updated), `operator-run.server.ts:361/389` (`void runOperator(...)`, ignores the result), `task-actions.server.ts` autoInvoke paths (ignore it).
- `TOKEN_SHAPE_SOURCE` / `REDACTED` move out of `run-sink.server.ts` — one import added there, two consts deleted. `MIN_SECRET_VALUE_LEN` and `CREDENTIAL_ENV_RE` stay put.
- `reconcileTask` changes from `async function` to a `function` returning a promise. Identical to callers; `app/server/github/github-reconciler.server.ts:749` and the test file's import need no edit. Confirmed there are exactly two production call sites (`:749` and, transitively, `reconcile-poller.server.ts:124` via `reconcileProject`).

**Projection rebuild:** none required. No schema, no column, no file-format field changes. Timeline events and notifications are existing shapes; `rebuildPath` already runs on both the schedule claim (`reproject`) and the reconcile write (`:507`).

**Store/file format:** unchanged. `detail` lives only in transient results, log lines and rendered note text — nothing new is persisted in `task.md` frontmatter.

**Behavior changes a reader should expect:**
- `logger.info("workspace branch push failed")` becomes `logger.warn`. Any log-level assertion or dashboard filter keyed on `info` for that message moves.
- Timeline notes for clone/push failures grow a fenced code block. `operatorSnapshot` caps an event at 1500 chars (`operator-actions.server.ts:1113-1115`); the 600-char clamp keeps the block well inside it, but a very long *sentence* plus block could still be trimmed — that is the pre-existing cap doing its job, and the detail is placed **last** so the sentence is never the part that gets cut.
- The archived skip note's wording changes ("has been archived" vs "is already Done"). No test asserts the old text (`schedule.server.test.ts:167` asserts only status + audit outcome), but a live store will show both wordings across old and new events.

**Deliberately NOT done, and why:**
- **No exit code on the push result.** `git push` exits 1 for virtually every failure; the scrubbed stderr subsumes it. Adding it would mean threading a field through the `Exec` interface, `defaultExec`, and the test fake for no information gain.
- **No terminal guard for non-`scheduled` triggers** in `runOperator`. `pr-diverged` on a closed task is exactly the case that withdraws a moot recovery packet; blocking it would re-open a defect R8-6 closed.
- **No `refused` audit row.** The claim already wrote `task.schedule.fired`; a second row would double-count the occurrence. The refusal is recorded as a timeline note plus a log line. If the owner wants it audited, the honest shape is a distinct action (`task.schedule.not-run`), not a second `fired`.
- **The clone `detail` does not reach a run log**, because the clone happens in `startSpecialistRun` *before* the run sink exists (`specialist-run.server.ts:840-856` precedes run creation). Its four surfaces are: the server log (`:1908`), the task timeline note (`:952`), the agent's prompt (`:1428`), and — via `operatorSnapshot`'s `recentTimeline` (`operator-actions.server.ts:1106`) — the operator's blocked-packet observations.

**Docs to update:**
- `docs/architecture/decisions.md` — a **new numbered ruling** recording the reversal: *"git's own failure text reaches the human, scrubbed by value."* It must state the residual risk and cite that the PAT never enters argv or the persisted remote. Use the next free number **after** R19-1..R19-4 are promoted from `NOTES.md` (they take 55-58, so this is **59**) — do not squat on a number before those land. This ruling is the one that makes the change legible next pass; the `decisions.md:87` rule ("secrets never appear in files under `projects/`, in logs, or in error messages") is not weakened — it is now enforced by an active scrub instead of by dropping the whole channel.
- `planning/discovery-2026-08-06-pass19/NOTES.md` — disposition `FIXED` on the F19-6 row (`:46`) and the F19-18 / F19-19 / F19-20 rows (`:62-64`).
- `planning/discovery-2026-08-06-pass19/reference/ARCHITECTURE.md` — the `github/` module note (`:57`) should mention that `reconcileTask` is serialized per task; the reference docs are the pass-19 canon for "verified against main".
- No PRD/INTENT edit: FR39 and NFR16 already say what these fixes make true. This closes a gap against the spec rather than changing it.