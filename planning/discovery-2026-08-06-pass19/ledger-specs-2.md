# Pass-19 ledger specs — batch 2 (F19-5, F19-6, F19-21, UX19-1)

Grounded 2026-08-06 against the worktree at `claude/viberr-app-inspection-4e5bf2`
(main @65063b8 + pass-19 markers). Every file:line below was re-read in code, not
taken from the ledger. Paths are repo-relative.

---

## F19-5 — a11y: resource grant chips lack `aria-pressed` (create/edit-profile modal)

### Current code — confirmed

`app/features/agents/create-profile-modal.tsx`, the `ResourcesField` chip render
(lines 677–697):

```tsx
{displayItems.map((it) => (
  <button
    type="button"
    key={it.id}
    className={
      "pick-chip" +
      (g.mono ? " mono" : "") +
      (selSet.has(it.id) ? " on" : "") +
      (it.missing ? " missing" : "")
    }
    title={ ... }
    onClick={() => toggleRes(g.key, it.id)}
  >
    {selSet.has(it.id) && <Icon name="check" />}
    {it.id}
  </button>
))}
```

No `aria-pressed`. Every sibling toggle in the SAME file has it:

- backend chips — line 243: `aria-pressed={backend === b.id}`
- autonomy chips — line 304: `aria-pressed={autonomy === a.id}`
- stage chips — line 430: `aria-pressed={stg.includes(s.id)}`

And the org-level template modal (`app/features/org-settings/agent-template-modal.tsx`)
carries it on its OWN resource chips: skills :317, MCP :341, KB :365 (each
`aria-pressed={sel…Set.has(…)}`). So the project profile modal's resource chips are
the one surviving gap of the G5/UXA-4 sweep.

**Secondary site found while grounding:** `agent-template-modal.tsx` `MissingChips`
(lines 62–74) — the red "no longer in the store" chips — also render a bare
`<button className="pick-chip missing on">` with no `aria-pressed`. A missing grant
is a GRANT (it is selected; clicking removes it), so it should carry
`aria-pressed={true}`. Same for the `missing` items inside `ResourcesField`'s
`displayItems` — those get the fix for free since `selSet.has(it.id)` is true for
every dangling grant (they come from `sel`).

### Root cause

G5 (pass 18) added `aria-pressed` to the mini-seg/backend/autonomy/stage toggles by
sweeping the obvious `pick-chip` groups; `ResourcesField` renders inside a
collapsed `<details>`-style group (`cap-mgroup`, only when `open`), so it was
missed by an eyeball sweep. Screen readers currently announce granted and
ungranted resources identically.

### Mini-spec

**Change 1** — `create-profile-modal.tsx` ~line 686, add one line to the chip:

```tsx
className={ ... }
aria-pressed={selSet.has(it.id)}      // ← add
title={ ... }
```

**Change 2** — `agent-template-modal.tsx` `MissingChips` (line 68 area), add
`aria-pressed={true}` (the chip is always in the granted state).

No other behavior change; `selSet.has(it.id)` is already computed for the check icon.

### Test plan

- File: `app/features/agents/agents-page.test.tsx` (already imports and renders
  `CreateProfileModal` via a route stub — `describe("CreateProfileModal")` at :689).
- New test: open a resource group, assert every chip in `pick-chips` under the
  Context-resources group has `aria-pressed` equal to its granted state — e.g.
  render with one skill granted, query `getAllByRole("button", { pressed: true })`
  scoped to the group and assert it contains exactly the granted id; assert the
  ungranted chip reports `pressed: false` (i.e., HAS the attribute with value
  `"false"`, not absent — `toHaveAttribute("aria-pressed", "false")`).
- Second assertion in the org-settings suite for `MissingChips`
  (`app/features/org-settings/*.test.tsx`; `users-panel.test.tsx` shows the
  pattern, but the template modal test lives wherever `AgentModal` is rendered —
  add to the existing agent-template test file, or to `agents-page.test.tsx`'s
  org section if none exists).
- **Canary:** revert the `aria-pressed` line — the `toHaveAttribute` assertions
  fail (attribute absent).

---

## F19-6 — clone failure `git exit 128` is undiagnosable: stderr dropped everywhere

### Current code — confirmed

1. `app/server/tasks/git-clone-auth.server.ts:223-247` — the drop is deliberate
   and total:

```ts
/**
 * Return an intentionally small, credential-safe description for logs.
 * `Error.message`, `stderr`, and `cmd` are deliberately ignored because child
 * process errors may echo command arguments or authentication diagnostics.
 */
export function cloneFailureLogDetails(error: unknown): CloneFailureLogDetails {
```

   Only `{reason, exitCode?, signal?}` survive (`CloneFailureLogDetails`,
   :183-187).

2. `app/server/tasks/specialist-run.server.ts:1899-1925` — the ONLY log of a
   failed clone is `logger.warn("specialist run clone failed — running WITHOUT a
   checkout", { taskKey, repo, hadCredential, timeoutMs, ...details })` — no
   stderr, no message.

3. The human-facing surfaces carry only `cloneFailureSentence` (generic:
   `"The workspace checkout failed (git exit 128). The project's GitHub credential
   WAS supplied…"`, git-clone-auth.server.ts:214-219):
   - timeline note "**Workspace checkout failed:**" — specialist-run.server.ts:941-962
   - the run prompt's workspace contract — specialist-run.server.ts:1418-1434
     (the agent is told to "quote the reason above verbatim… and stop", so the
     operator's blocked packet can only ever contain "git exit 128").

So the live VC-3 symptom is fully explained: exit 128 covers auth rejection,
missing remote branch protection, DNS failure, proxy, LFS hooks — and every
channel a human could read says only "128".

### Root cause

The credential-safety rule was implemented as "drop all diagnostics" instead of
"redact the one secret that can appear". But the token is supplied ONLY through
the askpass env (`ASKPASS_PASSWORD_ENV`, git-clone-auth.server.ts:62/144) — never
argv, never the URL (`args: ["clone","--depth","1", url, dest]`, :149), never
persisted config. The server KNOWS the exact secret string at the catch site
(`token` is in scope in `cloneRepo`, specialist-run.server.ts:1874), so literal
scrub + pattern scrub is sufficient, exactly as the ledger states.

### Mini-spec

**New helper** in `git-clone-auth.server.ts`:

```ts
/** Redacted, truncated stderr excerpt safe for logs, timeline, and prompts.
 *  Scrubs the known token literal plus userinfo-in-URL patterns; keeps the
 *  LAST 500 chars (git puts the fatal: line at the end). */
export function redactedCloneStderr(
  error: unknown,
  secrets: readonly string[],
): string | undefined {
  const raw =
    typeof (error as { stderr?: unknown })?.stderr === "string"
      ? (error as { stderr: string }).stderr
      : error instanceof Error ? error.message : undefined;
  if (!raw?.trim()) return undefined;
  let out = raw;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  out = out
    .replace(/x-access-token:[^@\s]+@/g, "x-access-token:[redacted]@")
    .replace(/(https?:\/\/)[^\/@\s]+@/g, "$1[redacted]@");
  out = out.trim().slice(-500);
  return out || undefined;
}
```

`cloneFailureLogDetails` stays untouched (its "intentionally small" contract and
test remain the base guarantee); the excerpt is a separate, opt-in channel.

**Carry it** — `specialist-run.server.ts`:

- `CloneFailure` (:1809-1814) gains `stderrExcerpt?: string`.
- `cloneRepo`'s catch (:1899-1925): compute
  `const stderrExcerpt = redactedCloneStderr(error, [token ?? ""]);`
  (hoist `token` — it is currently `const` inside the `try`; declare
  `let token: string | null = null` before the try so the catch can see it),
  add it to the `logger.warn` payload and to the returned `failure`.

**Surface it** (both bounded to the already-redacted excerpt):

- Timeline note (:941-962): append, when present,
  `` `\n\nGit reported: \`${cloneFailure.stderrExcerpt}\`` `` — the note is the
  run-log-adjacent record the ledger asks for.
- Prompt (:1380 input type + :1418-1434 rendering): extend the `cloneFailure`
  prompt field with `stderrExcerpt`, and render one extra contract line
  `` `- Git's own (redacted) error output: \`${…}\` — include it verbatim when you report the failure.\n` ``
  so the operator's blocked packet finally carries the actionable reason.

**Explicitly out of scope here:** the identical hole on the delivery push path
(`push-workspace.server.ts:401`) is F19-18 (audit finding, other spec batch) —
but `redactedCloneStderr` should be written repo-generic so F19-18 can reuse it
(the push path already builds `createGitHubAskpassEnv`, same single-secret shape).

### Test plan

- File: `app/server/tasks/git-clone-auth.server.test.ts` (the
  `cloneFailureLogDetails` describe at :122 stays as-is — its contract is
  unchanged). New describe `redactedCloneStderr`:
  1. token literal in stderr → replaced with `[redacted]`, rest preserved
     (`fatal: unable to access` survives);
  2. `x-access-token:<tok>@github.com` and `https://user:pass@` userinfo patterns
     scrubbed even when the literal secret is NOT in the secrets list;
  3. >500-char stderr keeps the TAIL (the `fatal:` line);
  4. empty/missing stderr → `undefined` (falls back to `Error.message`).
- File: `app/server/tasks/specialist-run.server.test.ts` (clone-failure coverage
  already exists — prompt test at :1062-1067): extend the existing prompt test
  with `stderrExcerpt` and assert the "Git's own (redacted) error output" line;
  add a timeline-note assertion that the note contains the excerpt and does NOT
  contain a planted token string.
- **Canary:** stub the excerpt wiring back out (return `undefined`) — prompt and
  timeline tests fail; plant the raw token in the mocked stderr and assert its
  absence everywhere (fails if redaction is bypassed).

---

## F19-21 — R17-2 "Completed — no changes" is unreachable without a delivery attempt

### Current code — confirmed (three interlocking gates)

1. **The flag has exactly two writers, both inside `performDelivery`**
   (`app/server/tasks/task-actions.server.ts`):
   - :3480-3484 — push returned `no_commits`:
     ```ts
     push.status === "no_commits"
       ? (fm) => { fm.noChanges = true; }
       : undefined,
     ```
     with the comment "The other push outcomes are genuine failures and must NOT
     set the flag."
   - :3620-3622 — `openTaskPr` returned `nothing_to_review` (empty diff on the
     remote): `(fm) => { fm.noChanges = true; }`.

2. **A never-branched workspace can't reach either writer.**
   `app/server/github/push-workspace.server.ts:252-254` classifies HEAD-on-default
   as a failure BEFORE the commits-ahead check (:356-358):
   ```ts
   if (!branch || branch === "HEAD" || branch === defaultBranch) {
     return { status: "no_branch", reason: `HEAD not on a task branch (${branch || "detached"})` };
   }
   ```
   So a verify-only task (reviewer ran on main, zero commits) yields `no_branch`
   → "Delivery could not run" → no flag. No workspace at all yields
   `no_workspace` → same. The pinned test agrees
   (`delivery-decision.server.test.ts:291-294` expects `no_branch` → `failed`).

3. **Even with the flag, the F10-15 gate blocks first.**
   `app/schemas/task-file.schema.ts:581-587`:
   ```ts
   if (!fm.workRevision) {
     return required.length > 0
       ? "No reviewed revision yet — nothing for the required reviewers to approve."
       : null;
   }
   ```
   — the EXACT live `[noop]` string from VC-5. It runs at
   `acceptanceRefusalReason` (task-actions.server.ts:4754) BEFORE
   `verdictGateReason` (:4756), and it does not consult `noChanges`. The
   `noChanges` bypass that exists (`verdictGateReason` :4715 `if (fm.noChanges)
   return null;`) is only reachable when a `workRevision` EXISTS (:4708 returns
   null early otherwise) — i.e., only after a delivering run minted one.

4. **The reviewer's approval was discarded, not recorded.**
   `recordAgentCompletion` (task-actions.server.ts:1944-1962) binds a verdict
   only when `parsed.frontmatter.workRevision` is non-null; otherwise :1968-1972:
   ```ts
   } else if (!rev || !reviewerProfileId) {
     title = "Approval noted";
     summary = `${roleDisplay} approved, but there is no delivered revision to bind the verdict to yet.`;
   ```
   Prose on the timeline, zero gate effect.

The shipped R17-2 test fixture (`acceptance-closed-pr.server.test.ts:253-293`)
confirms the working path REQUIRES a branch + minted `workRevision` — its task has
`branch: "vib-1-normalize"` and a full `workRevision` object. VC-5's shape
(no branch, no revision, engaged required reviewer) has no path to Done except
force-accept or "manually mark Done" — exactly the ceremony bypass R17-2 exists
to prevent. **Finding confirmed.**

### Root cause

`noChanges` was implemented as a *delivery outcome* (F17-L9 fixed the case "the
delivering run produced an empty branch"), not as a *task outcome*. A task whose
goal is satisfied without any branch ever existing — verification, audit,
"confirm X still holds" — was the other half of R17-2's named shape and has no
writer, and the F10-15 no-revision refusal plus verdict-binding both assume a
revision exists.

### Mini-spec

Mechanism: make the existing delivery machinery able to VERIFY "no changes" for a
clean, never-branched workspace, and mint a base-anchored `workRevision` so every
downstream gate (verdict binding, F10-15, `verdictGateReason`'s existing
`noChanges` bypass, acceptance ceremony) works UNCHANGED.

**Change 1 — `push-workspace.server.ts` (:252-254 area):** before returning
`no_branch`, when `branch === defaultBranch`, check the working tree is clean AND
`countCommitsAhead(...) === 0` AND (cheap, local) no `refs/heads/<taskKey>-*`
task branch exists in the workspace. If all hold, return
`{ status: "no_commits", reason: "workspace is on the default branch with no changes — verified no-change" }`.
A dirty tree or local commits on main keeps `no_branch` (a developer that forgot
to branch is still a genuine failure — do NOT auto-commit onto main; note the
auto-commit block at :283-348 is only reachable AFTER the task-branch check, keep
it that way by doing the clean-tree test read-only).

**Change 2 — `performDelivery` `no_commits` handler (task-actions.server.ts
:3477-3491):** alongside `fm.noChanges = true`, mint a `workRevision` when none
exists, anchored to the verified base:

```ts
(fm) => {
  fm.noChanges = true;
  if (!fm.workRevision) {
    fm.workRevision = {
      id: newRevisionId(),            // same generator nextWorkRevision uses
      headSha: <origin/default head sha from push-workspace>,   // add to the no_commits result
      treeSha: null,
      branch: <defaultBranch>,
      createdAt: new Date().toISOString(),
      sourceProfileId: <delivering engagement's profileId>,
    };
  }
}
```

(`push-workspace` must return the base head sha on the `no_commits` result — it
already resolves `defaultBranch`; one `git rev-parse origin/<default>` adds it.)
With a revision minted, `recordAgentCompletion` binds the reviewer's next verdict
normally, `acceptanceBlockedReason` gates on real approvals, and
`verdictGateReason`'s `noChanges` bypass (:4715) closes the no-PR hole — the
ceremony is preserved, not skipped.

**Change 3 — reachability.** The trigger is the EXISTING deliver path (operator
`deliver_for_review` tool, human "Deliver branch & open PR", applied delivery
recommendation): on a verify-only task it now returns `nothing_to_review`
("nothing to review and no PR was opened…") instead of a false failure, sets the
flag, and mints the revision. Additionally, soften the dead-end the live run hit:
when `operatorAcceptCompletion` / `acceptCompletion` refuse with the
"No reviewed revision yet" reason AND the task has a repo, append
"— if this task requires no changes, run delivery once to verify and record that."
(copy joins the refusal string in `acceptanceBlockedReason` callers, not the pure
schema helper).

**Sequencing note for personas (no code):** the operator should verify-no-changes
BEFORE engaging the reviewer, so the reviewer's verdict binds to the minted base
revision on its first run. A reviewer that already ran (VC-5) re-runs after the
verification — its approve then binds.

### Owner decision needed (crisp)

Does the no-change closure of a task WITH an engaged required reviewer require
that reviewer's verdict to bind to the minted base revision?

- **Option A (spec above, recommended):** yes — mint the base-anchored revision;
  required reviewers must approve it (possibly re-running once). Full R17-2
  ceremony; one extra reviewer run in the VC-5 ordering.
- **Option B:** no — additionally change `acceptanceBlockedReason`'s no-revision
  branch to `required.length > 0 && !fm.noChanges`, letting a verified no-change
  task close without any bound verdict. Cheaper, but a required reviewer's gate
  is silently waived exactly when the claim is "nothing changed" — the claim a
  reviewer exists to check.

### Test plan

- File: `app/server/github/push-workspace.server.test.ts` (or wherever
  `pushWorkspace` is covered — the `no_branch` classification test): clean
  workspace on default branch, 0 ahead → `no_commits` + base head sha in result;
  dirty tree on default → stays `no_branch`; local commits on default → stays
  `no_branch`.
- File: `app/server/tasks/delivery-decision.server.test.ts` — the A3 table
  (:270-323): the `no_branch` fixture stays `failed` (dirty/committed variant);
  NEW case: verified-clean default-branch push result → outcome
  `nothing_to_review`, `fm.noChanges === true`, `fm.workRevision` minted with
  `branch: <default>` and the base head sha.
- File: `app/server/tasks/acceptance-closed-pr.server.test.ts` — new test beside
  :253: VC-5 shape end-to-end: verify-only task, required reviewer engaged,
  delivery → `nothing_to_review`, reviewer verdict binds to minted revision,
  human `acceptCompletion` closes to Done with the "completed with no changes
  required" completion text and `pr: null`; and the counter-case: WITHOUT a bound
  approve, acceptance still refuses (ceremony held).
- **Canary:** revert Change 1 (restore unconditional `no_branch`) — the new
  push-workspace and end-to-end tests fail with the live `[noop]` refusal string,
  reproducing VC-5 exactly.

---

## UX19-1 — internal ruling id "R6-2" in rendered Permissions-panel copy

### Current code — confirmed

`app/features/task-detail/task-side-panels.tsx:326-330`, inside `PolicyPanel`'s
JSX (rendered, not a comment):

```tsx
<p className="fine xs perm-intro">
  Platform rules as they apply to <b>you on this task</b> — role grants,
  plus the owner authority R6-2 adds. This task's live stage, owner and
  waiting-on are in <b>Current state</b> above.
</p>
```

An end user reads "R6-2" — an internal decisions.md ruling number (ruling 22,
owner acceptance authority). The same id appears correctly as CODE COMMENTS in the
same file (:262, :535) — those are fine and stay.

A render-layer scan for `/\bR\d{1,2}-\d+\b/` (comments stripped, copy-ban style)
across `app/features` + `app/routes` found exactly TWO hits: this line, and a SQL
`--` comment inside a template string (`app/features/home/home-query.server.ts:155`
"-- R14-3: …" — not rendered). So this is the only live violation, and a gate is
cheap to keep honest.

### Root cause

Same failure class as F18-14 (govern* ban): copy written by implementers citing
canon leaked the citation into user-visible text, and nothing lints for it.

### Mini-spec

**Change 1 — the copy** (task-side-panels.tsx:328):

Before: `plus the owner authority R6-2 adds.`
After: `plus the authority that comes with owning this task.`

(The sentence already contrasts "role grants" with owner authority; the ruling id
adds nothing a user can act on. Keep the code-comment citations untouched.)

**Change 2 — the gate**: extend `app/features/copy-ban.test.ts` (or a sibling
`internal-jargon-ban.test.ts` reusing its `walk`/`stripComments` machinery) with a
second banned pattern for rendered ruling ids:

```ts
const BANNED_RULING_ID = /\bR\d{1,2}-\d+\b/;
```

Strip SQL `--` comment lines too (add `.replace(/^\s*--.*$/gm, "")` inside the
scanned-source pipeline, or allowlist `home-query.server.ts`'s SQL-comment line by
substring, matching the existing `ALLOW_SUBSTRINGS` mechanism). The current tree
then passes with zero offenders once Change 1 lands.

### Test plan

- File: `app/features/copy-ban.test.ts` — the new banned-pattern scan IS the test
  (fails today on task-side-panels.tsx:328, passes after the copy fix — that
  order is the built-in canary: write the gate first, watch it name the line,
  then fix the copy).
- Optional targeted render assertion in
  `app/features/task-detail/task-detail-components.test.tsx`: render
  `PolicyPanel` and assert the intro text matches the new copy and contains no
  `/R\d+-\d+/`.
- **Canary:** revert Change 1 — the copy-ban scan fails naming
  `task-side-panels.tsx:328`.
