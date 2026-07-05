# Phase 9A report — Governance surfaces (Agents · Policy · Project Settings)

Status: complete. Gates at close: `npm run typecheck` clean, `npm test`
**581/581** green (503 prior + 78 new), `npm run build` clean (only the
pre-existing RR v8 future-flag warnings). Live-verified end to end (see
"Live verification"); store re-seeded pristine after
(`npm run seed -- --reset`, VIB-142 violation back to `open`, no PAT rows
left behind).

No new deps. **No migration 0007** — nothing needed a net-new table:
profiles/policy/membership/stages/override all live in project.md (phase-3
writers + loose-schema fields), live deployments are a projection query
over existing `task_projections` + `agent_runs`, and violations/credential
health reuse the phase-7 tables. routes.ts untouched (placeholder route
CONTENTS replaced only).

## File inventory

```
app/
  features/agents/
    capability-catalog.ts            # modal CAP catalog re-keyed onto shared
                                     #   CAP_CATALOG ids + RES_CATALOG + modes [test]
    agent-types.ts                   # AgentProfileView / AgentDeploymentView /
                                     #   MatrixProfile + statusKind/dot helpers
    agents-query.server.ts           # roster assembly: org template files ⊕
                                     #   project.md deployments (definition override)
    agent-profile-actions.server.ts  # create/update/delete profile → project.md
                                     #   writers → reproject → audit (admin-only)
    capability-matrix-modal.tsx      # THE shared matrix modal (Policy imports it)
    create-profile-modal.tsx         # create+edit form (id-based cap seeding)
    agents-page.tsx                  # roster/detail/Live tab/stats + fetcher wiring
    agents-route.server.test.ts      # roster+deployments from seed, CRUD, RBAC
    agents-page.test.tsx             # [jsdom] detail/live/matrix/create-modal smokes
  features/policy/
    policy-data.ts                   # ROLE_IDS/LABELS + THE 9-row RBAC table
                                     #   (contracts §3.2 verbatim) + BOUNDARIES/BCLS
                                     #   + ALWAYS_HUMAN_LABELS (from invariant ids)
    policy-query.server.ts           # members/transitions/roster/edited-chip read model
    policy-actions.server.ts         # setMemberRole (last-admin guard) +
                                     #   setTransitionBoundary (review→done lock)
    policy-page.tsx                  # HumanAccess/AgentCapability/WorkflowRules + page
    policy-route.server.test.ts      # RBAC table, role round trip+audit, guards
    policy-page.test.tsx             # [jsdom] panels incl. locked row + live counts
  features/project-settings/
    membership.server.ts             # membership read model (file `status` + users join)
    settings-query.server.ts         # identity/stages/counts/members/credential/override
    settings-actions.server.ts       # identity, stage editor (rename/reorder/add/remove),
                                     #   invite/remove member, override, deleteProject
    settings-page.tsx                # Project/Stages/Members/Repo/DangerZone + page
    settings-route.server.test.ts    # loader, stage mutations→projection, member CRUD,
                                     #   override, grant-scope, delete-project
    settings-page.test.tsx           # [jsdom] all five panels incl. typed-name delete
  server/projections/
    agent-deployments.server.ts      # THE live-deployment projection (see below) [test]
  routes/
    project.agents.tsx               # REPLACED placeholder: loader + 3 CRUD intents
    project.policy.tsx               # REPLACED placeholder: loader + set-role/set-boundary
    project.settings.tsx             # REPLACED placeholder: loader + 9 intents
```

## Data model decisions (no migration)

**Two-layer agent profiles, resolved (agents spec §8.1).** Org template
files (`agents/profiles/<id>.md`, phase 3) are the global base; project.md
`agents:` deployments are the per-project approval + effective capability
policy. This phase adds a loose `definition` object on the deployment
entry (tolerated by the phase-3 `.loose()` schemas, survives
parse→serialize→projection): project-created profiles carry their FULL
definition there (`scope: "Created in <project>"`), edits of
template-deployed profiles store a full per-field override. **Delete
removes only the deployment entry — the template file is never touched**
("The global base definition is unaffected." is now literally true).
Operator delete is rejected server-side.

**Capabilities are id-based (ruling 7).** The modal's curated 18-action
catalog (`capability-catalog.ts`) is re-keyed onto shared `CAP_CATALOG`
ids; labels render FROM the shared catalog (drift is test-asserted).
Grants outside the modal catalog (operator coordination actions) and
display-only `extras` (the near-miss labels) are preserved verbatim
through edits; the matrix modal collects them into "Other actions" exactly
like the mock.

**Membership.** project.md members gained a loose `status: "invited"`
marker (project_members projection stays userId/role — the panels read
status through `membership.server.ts`). Invite: registered email → member
entry (role viewer, status invited); unregistered email → a passwordless
whitelist user row is created first (phase-2 model: the row IS the
whitelist; OAuth-only sign-in; no mailer in V1 per ruling 13).

**Repo override.** `taskRepoOverride: boolean` as a loose project.md
frontmatter key (absent = true, the mock default). Task-detail/Phase 7 can
read it via `readProjectFile(...).parsed.unknownFrontmatter.taskRepoOverride`;
the GitHub view's fixed "task-level override allowed" KV row was NOT
touched (github-view.tsx is outside 9A ownership — one-line change per
phase-7-ui §5 item 5 remains open).

## The live-deployment projection (exports for other surfaces)

`app/server/projections/agent-deployments.server.ts`:

```ts
listAgentDeployments(db, slug): AgentDeploymentView[]
// { profileId, role, backend|null, engagement operator|primary|consultant,
//   taskKey, taskTitle, status, running }
deploymentCountsByProfile(deployments): Record<profileId, distinctTaskCount>
```

Derivation: task_projections assignment records (operator/specialist/
consultants — joined by the **profileId FK** stored in task frontmatter,
never the mock's `role.toLowerCase()` coincidence) + waiting state → the
mock status vocabulary verbatim (operator: human→`packet open` else
`coordinating`; primary: agent→`working`, human→`waiting on human`, else
`on call`; consultant: `anchored · on call`). Tasks in the project's LAST
stage contribute nothing. **agent_runs join**: an engagement whose run row
(matched project/task/kind, consultants by `c<i>` thread index) is
`state='running'` gets `running: true` — the UI adds the pulsing pill dot
for it (status strings stay mock-verbatim; the dot is the honest
enrichment the brief's runs-join asked for). Statuses like VIB-148's
"packet open" with no packet are 1:1 mock ports (spec §3.3 semantics).

## Shared exports for 9B/9C + later phases

- **`CapabilityMatrixModal`** (`app/features/agents/capability-matrix-modal.tsx`)
  — presentational `{ profiles: MatrixProfile[], projectName, onClose }`;
  Policy already imports it; org-settings (9B) can too.
- **`assembleAgentRoster(db, slug, {dataRoot?})`** — the effective
  profile roster (used by Agents AND Policy loaders); 9B's org surfaces
  can read raw templates via the phase-3 `agent-profile-file.server.ts`.
- **`RBAC_ROWS` / `ROLE_IDS` / `ROLE_LABEL` / `ALWAYS_HUMAN_LABELS`**
  (`app/features/policy/policy-data.ts`) — profile.md's role copy (9C) and
  any RBAC rendering should import these, not restate them.
- **`listMembershipViews(db, slug)`**
  (`app/features/project-settings/membership.server.ts`) — members with
  invite status + render fields, keyed by user id.
- **`listAgentDeployments`** — home/org dashboards wanting live agent
  counts should reuse it rather than re-deriving.
- The Settings grant-scope intent reuses `runGrantScope` + toast copy from
  `app/features/github/github-actions.server.ts` unchanged — the GitHub
  view and Settings can never drift (phase-7-ui integration item 2 done;
  the CredentialCard `warnActions` slot carries the real button).

## What Phase 10 (audit UX) gets from this phase's mutations

Every governed mutation writes `audit_events` with `projectSlug` set and
secret-free details:

| action | subject | details |
|---|---|---|
| `project.agent_profile.created` | agent_profile / id | name, role, backend, projectName |
| `project.agent_profile.updated` | agent_profile / id | name, role, backend |
| `project.agent_profile.deleted` | agent_profile / id | name |
| `project.member.role_changed` | user / userId | from, to, targetUserId |
| `project.policy.boundary_changed` | workflow_boundary / `from>to` | from, to, boundary |
| `project.settings.updated` | project / slug | fields[] |
| `project.stage.renamed/.added/.removed/.reordered` | stage / id (or project) | name / order |
| `project.member.invited` | user / userId | email, role |
| `project.member.removed` | user / userId | invited: bool |
| `project.repo_override.changed` | project / slug | enabled |
| `project.deleted` | project / slug | name |

The Policy header's "last change" chip is already an audit consumer:
`latestPolicyChange` (policy-query.server.ts) reads the newest event in
`POLICY_AUDIT_ACTIONS` — Phase 10's activity/audit surface should link the
chip to its filtered view (policy spec open question 5).

## Decisions / deviations

1. **RBAC for the three surfaces** (specs' open questions): profile CRUD,
   role changes, boundary changes, identity/stages/override/danger =
   project **admin** ("Manage members & roles" / "Edit workflow & policy",
   contracts §3.2); grant-scope = **admin|maintainer** (matches the
   phase-7-ui GitHub route). Non-admins see everything read-only
   (controls disabled/hidden, mock markup unchanged); the server enforces
   every guard regardless (client toasts are UX sugar).
2. **Policy "last change" chip hides on a fresh seed** — the mock's
   "Elif Demir · Mar 30" was fixture data; the chip is derived from real
   policy audit events and appears after the first change ("Arda Kaya ·
   Today" verified live). Seeding a fake audit row was rejected (seed.ts
   is 9B-owned; fabricating attribution felt worse than hiding).
3. **Operator edit preserves `spanAll` + model** (mock dropped spanAll —
   the §4.5 wart is deliberately fixed; multi-backend seeded profiles do
   still collapse to the modal's single backend on edit, mock parity).
4. **Action-bucket label order** differs slightly from the mock: catalog
   labels render in stored order, then extras (Tester's near-miss "Run
   the validation suite" lists after its catalog siblings). Strings are
   identical; only ordering inside a bucket moved.
5. **Stage editor vs workflow rules**: removing a stage drops transition
   rules referencing it (spec §7.4 decision); adding a stage does NOT
   invent rules (mock parity — Policy still shows the 4 declared rules;
   tasks can't be governed-moved into a ruleless stage until rules
   exist). `STAGE_LOCK` stays keyed on the literal `triage`/`done` ids
   (mock contract; the Lightweight template only locks `done`).
   Reorder normalization (triage first, done last) is re-applied
   server-side; add-stage ids are server-generated (`stage-<random>`),
   colors cycle NEW_STAGE_COLORS.
6. **`?profile=` deep link added** (policy spec open question 3): Policy's
   pcap rows navigate to `/agents?profile=<id>`; the Agents page seeds its
   selection from the param. Tab state stays client-local (mock parity).
7. **Boundary/locked enforcement**: any `locked` workflow row AND any
   non-human boundary into the project's final stage are rejected
   server-side with the tooltip copy; the locked row renders disabled
   buttons (the mock's CSS-only pointer-events gap is closed).
8. **Danger zone**: non-admins get the mock's deny toast with the REAL
   role interpolated ("…you're signed in as a maintainer"). Admin
   **Delete project is real**: typed-name confirm dialog → removes the
   project directory → full rescan prunes projections → audit → redirect
   home (verified in tests against the billing-service stub). **Archive
   is not implemented** (an archive flag would need board/task
   enforcement outside 9A file ownership) — admin click toasts
   "Archiving isn't available yet — projects stay active in V1".
   Deviation flagged for a later phase.
9. **Live-deployment status enrichment**: the agent_runs join adds only
   the pulsing dot (`running`), never new status strings — VIB-151's
   consultant shows `anchored · on call` with a live dot. Contracts §2.4
   vocabulary stays exact.
10. **Invite of unregistered emails creates a passwordless org user**
    (role `member`) via the phase-2 `createUser` — acceptable for the
    self-hosted V1 whitelist model; flagged here since it lets a project
    admin (who may be an org member) mint whitelist rows.
11. **Toast copy** for profile CRUD is authored (mock had NO toasts on the
    Agents surface): created/updated/deleted variants echo the modal's
    "future assignments" language. All Policy/Settings toast copy is the
    spec-verbatim §4.6/§4.6 strings with the project name parameterized.
12. **jsdom smokes target presentational components** (phase-5/7
    precedent); fetcher/navigation wiring is covered by the route-level
    tests + the live pass. The mock's dead `TagInput` was not ported
    (agents spec §7); `since` stays unrendered; the unused `running`
    stat stays uncomputed.

## Live verification (dev, preview browser)

`npm run seed -- --reset`, `npm run dev` (:5173), signed in as
arda@viberr.dev. Browser console: **zero warnings/errors** for the whole
pass; server log error-free.

- **/agents**: stats 5 profiles / 6 operators / 3 working / 5 waiting
  (all derived); roster Operator·6 / Developer·5 / Reviewer·1 /
  Tester·idle / Consultant·2; operator detail (lifecycle hint, 3 cap
  columns, resources, orchestration runtime cell); Developer detail lists
  its 5 engagements with per-task statuses. **Live · 14** tab: rows
  grouped by key, operator-first, `orchestration` backend cells, statuses
  exactly per waiting state, and VIB-151's running primary AND running
  consultant carry the pulsing dot from the agent_runs join (VIB-160's
  idle consultant doesn't). Capability matrix modal: 5 profile columns,
  3 catalog groups + "Other actions" (operator coordination + near-miss
  labels), 37 rows, legend; Escape closes.
- **/policy**: 9-row RBAC table with live per-role header counts; Selin
  reviewer→viewer→reviewer round trip (toast "Selin is now Reviewer ·
  enforced on the next action" verbatim, counts flip, "last change ·
  Arda Kaya · Today" chip appears); boundary In Progress→Review flipped
  to auto-advance and back (verbatim toast); Review→Done rendered
  `cap-seg locked`, all three buttons disabled, tooltip verbatim,
  "locked · V1" badge.
- **/settings**: identity panel with the REAL store path
  `projects/viberr-core/tasks/<key>/task.md`; add stage → "New stage"
  inserted before Done in inline-edit mode → renamed to "QA" → **the
  board immediately shows the QA·0 column** → removed; locked/non-empty
  remove guards toast verbatim ("Triage can't be removed — it's the entry
  point", "Move 2 tasks out of Review first"); invite Deniz →
  "4 active · 1 invited" + pending pill + verbatim toast → revoke
  ("Invite revoked · deniz@viberr.dev"); self-removal guard toast.
- **Grant scope / VIB-142 resolution**: the Settings card's Grant scope
  with no PAT → honest typed toast ("No GitHub credential configured…").
  Since this machine has no real GitHub credential, the resolution path
  was then driven through the **same server code path**
  (`createPat` → `setProjectCredential` → `runGrantScope` with the canned
  fake-github transport) against the live dev store: outcome
  `Scope granted · VIB-142 policy flag resolved`; after reload the
  **settings rail badge dropped 1 → 0**, all 4 scope chips green, cred-ok
  copy verbatim, and VIB-142's timeline carries the typed
  "**Policy update:** `pull_request:write` granted…" event from the
  Policy engine. (In-app SSE fan-out fires when the button itself
  resolves — the out-of-band script can't reach the server's in-process
  broker; the fetcher-revalidation path is what real usage exercises.)
- Cleanup: verify PAT deleted, seeded violation reopened, server stopped,
  `npm run seed -- --reset` → pristine (violation `open`/VIB-142, 18 runs
  / 96 log lines, 0 PAT rows).

## Known gaps (intentional)

- Archive project (see decision 8) and the org-settings PAT-binding UI
  (9B) — once a PAT can be bound there, the Settings card flips from
  `policy_display` to real chip verdicts automatically.
- Multiple simultaneously-missing scopes show first-only in the cred-warn
  (mock/spec behavior, chips show all — unchanged from phase-7-ui).
- Stage DnD reorder has no keyboard path (mock parity; spec §8.4 open).
- Removing a member does not touch task ownership seats (owner snapshots
  survive by design; admins release seats from task detail).
