# Phase 7-UI report — GitHub view

Status: complete. Gates at close: `npm run typecheck` clean, `npm test`
422/422 green (43 new phase-7-UI tests; the concurrent Phase-6 SSE agent's
suites included), `npm run build` clean (only the pre-existing RR v8
future-flag warnings).

Live-verified against the dev server (preview browser, signed in as
arda@viberr.dev): `/projects/viberr-core/github` renders the full surface
from the pristine seed — Repository panel (repo `akin-ozer/viberr`,
Connection pill honestly `no credential` since no PAT is bound, the fixed
Task-attachment / Repos-per-task copy, cred-card "viberr-bot · fine-grained
PAT" + `github_pat_••••42af`, 4 scope chips with `pull_request:write` in
the miss state, cred-warn banner with the VIB-142 keybtn + Grant scope +
Fix in Settings), Pull requests panel ("4 linked to tasks": #318/#311 in
review, #298/#287 merged, sub-lines `{branch} → main · {key}`), Execution
branches table (7 task-key branches; VIB-139/141 merged pills, VIB-142
synced + "3 commits" association + #318, VIB-151/153/160 synced with the
em-dash no-PR placeholder). Grant scope click → toast "No GitHub credential
configured — connect a PAT before re-checking scopes." (typed
`no_pat_configured`, not a crash); Reconcile click → verbatim
"Reconciling branches and PRs with GitHub…" then the honest no-PAT
completion toast; branch-row click → `/projects/viberr-core/tasks/VIB-151`;
"Open on GitHub" is a real external anchor
(`https://github.com/akin-ozer/viberr`, `target=_blank`,
`rel="noopener noreferrer"`). Browser console completely clean (zero
warnings/errors). Both raw action POSTs (grant-scope / reconcile via the
`.data` endpoint with session + CSRF) returned 200 `ok:true` with the typed
copy. No dev-store mutations were left behind (no-PAT actions are no-ops).
Note: the shared dev server on :5173 belongs to the concurrent SSE agent
and was left running; verification used a second instance on an ephemeral
port, stopped afterwards.

No new deps. No new migrations. No CSS additions (every class the mock
uses — `cred-card`, `scope-chips`, `cred-warn/ok`, `keybtn`, `rq-row`,
`gh-table`/`live-table`, `policy-cols`, `pol-note` — already exists in the
ported viberr.css; the mock's inline styles are reproduced verbatim).

## File inventory

```
app/
  features/github/
    github-pills.ts            # client-safe pill mappings: sync (ruling 12),
                               # PR state incl. closed→risk, connection matrix
    github-pills.test.ts
    github-copy.ts             # THE toast copy module (verbatim reconcile pair +
                               # authored degraded-mode matrix)
    github-copy.test.ts
    github-query.server.ts     # getGithubViewData: checkRepoAccess +
                               # getProjectCredentialHealth + PR/branch rows from
                               # task_projections + behindBy from provenance
    github-actions.server.ts   # runReconcile / runGrantScope: 7-core services →
                               # {ok, toast, result}; fetchImpl-injectable
    credential-card.tsx        # THE shared CredentialCard (spec §7.12) with the
                               # warnActions footer slot — Phase 9 Settings reuses it
    github-view.tsx            # RepositoryPanel / PullRequestsPanel / BranchesPanel
                               # (presentational) + GithubViewPage (fetcher/nav wiring,
                               # TODO(phase-6-wire) SSE marker)
    github-view.test.tsx       # [jsdom] banner state matrix, pills, rows, empties
    github-route.server.test.ts# route-level: loader shape from seed, RBAC, no-PAT
                               # degraded actions, grant/reconcile vs fake-github
  routes/project.github.tsx    # REPLACED phase-4 placeholder: async loader + action
                               # (reconcile | grant-scope, CSRF, RBAC, AppError map)
```

## Loader / action contract

Loader returns `{ view: GithubViewData }`:

```ts
GithubViewData = {
  project: { slug; name; repo; defaultBranch };
  connection: RepoAccessResult;              // typed union, never throws
  credential: ProjectCredentialHealth;       // ruling-5 single fact
  prs:      { taskKey; number; state; title; branch }[];      // number DESC
  branches: { taskKey; title; branch; pr; sync; commitCount }[]; // key ASC
}
```

Action intents (POST to the route URL, `_csrf` + `intent`; success is
ALWAYS `{ ok: true, toast, result }` — degraded GitHub states are values
with honest toasts, never 5xx):

| intent | server fn | RBAC | typed results surfaced |
|---|---|---|---|
| `reconcile` | `reconcileProject` | any non-viewer member | ok / no_pat_configured / no_repo_configured; per-task network failures → stale-but-labeled toast |
| `grant-scope` | `revalidateProjectCredential` | admin \| maintainer | resolved / revalidated / no_pat_configured / network_unavailable |

Toast matrix (github-copy.ts, all covered by tests): the two reconcile
strings are verbatim spec; `Scope granted · {taskKey} policy flag resolved`
interpolates the resolved violation's task (mock: VIB-142); degraded copy
is authored ("No GitHub credential configured — …", "GitHub is unreachable
— …", revoked/expired/repo_not_found/org-approval variants, "Re-checked —
{scope} is still missing …", "Scopes re-checked — all required scopes
granted.").

## Sync pill derivation (ruling 12)

`merged > behind > synced`, from REAL data only: `merged` when the
projected `pr.state` is merged; `behind_main` when the latest
`github.reconcile` provenance row for the task records `behindBy > 0`
(the reconciler captures real compare data there); else `synced`. The
mock's `validation === "failing"` conflation is deleted per spec §7.3 —
consequence: seeded VIB-160 renders `synced` (not the mock's "behind
main") until a real reconcile observes it behind. The route test proves
the honest path end-to-end: a fake-transport reconcile reporting VIB-151
`behind_by: 2` flips its loader row to the risk pill.

## Decisions / deviations

1. **Grant scope lives on this page for now.** The mock puts the button on
   Settings → RepoSettings (Phase 9); the banner here only navigates. Since
   the resolution path had to be reachable and Settings is still a
   placeholder, the cred-warn renders BOTH buttons — `Grant scope`
   (re-check, admin|maintainer only, hidden otherwise) and the mock's
   `Fix in Settings`. Phase 9 should move Grant scope into the Settings
   card (pass it via `CredentialCard`'s `warnActions` slot) and drop it
   here if product wants strict mock parity.
2. **"Grant scope" = re-check** (spec open question 1, resolved per
   7-core): it re-validates the stored PAT; for fine-grained tokens the
   unverifiable write scopes count as granted (optimistic, next real 403
   reopens). With no PAT it returns the typed `no_pat_configured` copy.
3. **Connection pill vocabulary authored** (no design existed, spec
   §7.9c): connected→ready `connected`; no_repo→neutral `no repository`;
   no_pat→input `no credential`; repo_not_found→risk `repo not found`;
   auth_failed→blocked `token expired`/`token revoked`;
   org_approval_missing→risk `approval needed`; forbidden→risk
   `access refused`; network_unavailable→neutral `offline`. Never claims
   connected when degraded.
4. **Connect-credential card state** (settings spec §7.11): when the
   project has neither a PAT nor a `credentialPolicy` display block
   (`source: "none"`), the cred-card renders a quiet "No GitHub PAT is
   connected…" affordance instead of scope chips. The seeded viberr-core
   keeps full mock parity via the policy_display fallback.
5. **Ordering** (spec §7.11): PRs by number DESC, branches by numeric task
   key ASC (the projection query's order). Mock used store order.
6. **Commit association count** rendered as a faint "N commits" suffix
   beside the branch trace chip (brief asked for the count; the mock had
   no slot — quiet addition, VIB-142 shows "3 commits").
7. **PR sub-line base branch** is the project's real `defaultBranch`
   (seed: `main`) instead of the mock's hard-coded string.
8. **Empty states added** (spec §7.9a/b): quiet `.pol-note`-style line for
   zero PRs, `.empty` row for zero branches.
9. **RBAC on actions** (mock had none; conventions require it):
   reconcile = any non-viewer member; grant-scope = admin|maintainer
   (PAT/credential change is admin-shaped). Both enforced in the route
   action — the 7-core services carry no role checks.
10. **Reconcile toasts**: first toast client-side on submit (verbatim),
    completion toast from the action result; degraded completions replace
    the verbatim success string with honest copy (full matrix in
    github-copy.test.ts). Partial failures keep last-known projection data
    (spec §7.10) — surfaced live: all-offline runs toast "GitHub is
    unreachable — showing the last-known branch and PR state."
11. **No SSE wiring** — the concurrent Phase-6 agent owns
    app/features/live-updates; a `TODO(phase-6-wire)` JSX comment in
    `GithubViewPage` marks where the project-scope subscription belongs
    (revalidate on `task.updated` / `violation.updated` /
    `projection.rebuilt`). Until then the page refreshes on action
    revalidation/navigation.
12. **"Last reconciled at" line NOT added** (spec open question 5): the
    data exists in provenance rows; deferred as a product call rather than
    inventing UI. `data-screen-label="GitHub"` kept (ruling 16).
13. **jsdom tests target the presentational panels** (phase-5 precedent);
    fetcher/toast wiring is exercised live + at route level (grant/
    reconcile flows against `test-support/fake-github.ts`, incl. the
    VIB-142 resolution writing the typed policy event verified in BOTH the
    task file bytes and the projection timeline).

## What Phase 9 (settings panels) still needs from 7-core — exact remaining wiring

The server API is complete; everything below is UI-only work:

1. **Org settings → PAT management** (org-settings spec token modal):
   `createPat(db, {userId, label, token}, actor)` →
   `validatePat(db, patId, {repo})` for the validate-and-save flow;
   `listPats(db, userId)` for the table (metadata only — tokens never
   leave the server); `deletePat` for revoke. Validation results render
   from the cached `PatMetadata.validation` (typed
   `PatValidation.status` + per-scope `ScopeCheck`s).
2. **Project settings → Repository & credentials card**: bind with
   `setProjectCredential(db, {projectSlug, patId}, actor)` /
   `clearProjectCredential`; render the SAME `CredentialCard`
   (`app/features/github/credential-card.tsx`) fed by
   `getProjectCredentialHealth`, passing the real Grant-scope button via
   `warnActions` (wire it to the existing `grant-scope` intent semantics —
   reuse `runGrantScope` + `grantScopeToast`, both importable). Once a
   PAT can actually be bound there, `source:"policy_display"` projects
   flip to real chip verdicts automatically.
3. **"Fix in Settings" anchor**: this page navigates to
   `/projects/:slug/settings`; Phase 9 should give the repository panel an
   anchor/section id so the navigation can deep-link (spec open
   question 3).
4. **Connection row in Settings**: reuse `checkRepoAccess` +
   `connectionPill` (client-safe) for an identical pill.
5. **Task-attachment / override copy**: this page renders the fixed
   "project default · task-level override allowed" string; when Phase 9
   builds the override toggle (settings spec §5.5), the loader should
   surface the real setting and this KV row should read it (one-line
   change in `github-view.tsx` — accept the value via `GithubViewData`).
6. **Review queue accept-completion** (Phase 5 stand-in, ruling 7):
   `resolvePacket`'s accept path still flips the mirrored `pr.state`;
   switching it to `mergeTaskPr` with the typed failure rendering
   (`not_mergeable` / `head_changed` / `scope_violation` → the VIB-142
   banner path) remains the documented integration point from the 7-core
   report §5.

## Known gaps (intentional)

- No live SSE revalidation until Phase 6 lands its hook (marker comment in
  place; zero component changes needed — the route is pure loader/action).
- Reconcile is manual-only (no scheduler/webhooks — 7-core known gap);
  sync pills are as fresh as the last reconcile.
- Multiple simultaneous missing scopes show first-only in the banner
  (mock/spec behavior, open question 7 unresolved) — chips still show all.
- PR rows link to task detail only (mock behavior; per-row GitHub links
  were explicitly "don't add without a decision", spec open question 6).
