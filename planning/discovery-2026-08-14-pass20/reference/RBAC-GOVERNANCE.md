# RBAC-GOVERNANCE — Viberr current state (pass 20)

> Verified against `main @b97ad02` on 2026-08-14 (pass 20). Every anchor below
> was re-read at that sha; the pass-19 copy of this doc was verified at
> `65063b8` (the pass-18 merge) and therefore predates the entire pass-19
> implementation — several of its claims had already gone stale by the time it
> was filed. Corrections are called out inline and collected in §7.

Viberr has **two distinct permission systems** that never mix:

1. **Human RBAC** — what a *person* may do on a project, keyed by their project
   role. Source of truth: `app/shared/rbac.ts`.
2. **Agent capability policy** — what an *AI agent* (specialist/operator) may do
   at runtime, keyed by per-profile capability grants. Source of truth:
   `app/shared/capabilities.ts`.

Plus the **acceptance gate** (verdict-gated completion) that sits across both.

Since pass 19 the movement is: `rbac.ts` **unchanged**; `capabilities.ts` gained
two capabilities (`update-task-branch`, N19-9; `use-browser`, R19-19 / ruling
75); `project-authority.server.ts` changed materially (F19-30 — the
`"any-member"` override is audited now); and the acceptance ceremony was
consolidated into one dialog with six modes.

---

## 1. Human RBAC (`app/shared/rbac.ts`)

**The file is byte-identical to pass 17** — every anchor below still resolves.

### 1.1 Roles

Two org roles: `admin` | `member` (stored on the `users` row; the sole org
authority — there is no better-auth membership plugin,
`project-authority.server.ts:147-153`).

Four project roles, a strict tier `viewer ⊂ contributor ⊂ maintainer ⊂ admin`
(`ROLE_RANK` `rbac.ts:31-36`, labels `:38-43`, the tuple itself at
`project-file.schema.ts:23-24`). `contributor` was formerly `reviewer`; the
rename dropped a misleading label — review authority actually rides per-task
ownership, not the role.

### 1.2 `ACTION_ROLES` — the single source (`rbac.ts:61-105`)

`RBAC_DEFINITIONS` (`:61-88`) is one array of `{id, label, roles[]}`. The
**server guards consult it and the Policy/Profile permission tables render the
same object**, so enforcement and display can never drift
(`policy-rbac.server.test.ts` drives each guard per role to keep them bound).
`RbacAction` is derived at `:90`, `ACTION_ROLES` at `:92-94`; `roleCan(role,
action)` (`:97-100`) and `rolesForAction(action)` (`:103-105`) are the
accessors.

The 18 actions and their holding roles (A=admin M=maintainer C=contributor
V=viewer):

| Action | Roles |
| --- | --- |
| `view`, `comment` | A M C V (never role-narrowed — enforcement IS the membership gate) |
| `create-task`, `own-task` | A M C |
| `approve-transition`, `resolve-packet`, `accept-completion`, `update-goal`, `run-agents`, `reorder-board`, `reconcile-github`, `grant-github-scope`, `rescan-project` | A M |
| `release-any-ownership`, `manage-members`, `manage-agents`, `edit-policy` | A |
| `force-accept-completion` | A (narrowest — the audited escape hatch, §3) |

**Membership is the outer gate on every action** (R15-4 / ruling 25,
`rbac.ts:18-27`): a project is visible only to its members (plus org admins via
the D2 override); a non-member gets the unknown-slug 404. `view`/`comment` never
call `requireAction` — their entire enforcement is that membership gate.

**F19-28 (pass 19) closed a project-existence oracle in that gate.**
`requireProjectMember` (`app/server/auth/require-project.server.ts:33-61`) is the
loader guard for the six config views and the two run-artifact resource routes.
It used to throw `assertProjectAction`'s own 403 ("Only project members can view
this project's policy"), which distinguished "exists but you're not a member"
from "does not exist" — reachable directly because single-fetch honors a
client-supplied `?_routes=` filter, so `GET /projects/<slug>/policy.data?_routes=…`
runs the child loader alone and the layout's 404 never executes. Both failure
modes now collapse into one byte-identical 404 (`projectNotFound`, `:81-89`),
which also declines to echo the slug on the two run-addressed resource routes
(`/resources/run-log`, `/resources/session-export`) where the slug came from the
run row rather than from the requester.

### 1.3 Authority resolution + the D2 org-admin override

`app/server/auth/project-authority.server.ts` is THE single resolution path
(pass-7 R7-1). `resolveProjectAuthority(db, project, actor, allowed, audit)`
(`:169-254`) owns three rules:

1. **Membership role** (`:176-182`) — the actor's live role from `project.md`
   members[] checked against `ACTION_ROLES`. Granted under the actor's own role
   (never marked an override).
2. **D2 org-admin emergency override** (`:183-227`) — an ORG admin whose
   membership role would be denied (non-member, or a member below tier) is
   granted project-admin-equivalent authority, and **every such grant writes a
   `project.org_admin.override` audit row** (visible, never silent). An org admin
   whose own membership suffices is NOT an override (no row).
3. **Denial** (P13-D-8, `:228-252`) — every refusal writes a
   `project.authority.denied` row (NFR10), deduped per
   `deny|actor|project|action` in a 60 s window (`shouldRecordOnce` `:103-119`,
   window/bound constants `:99-101`) so a polling client can't bury the
   deliberate probe.

> **CORRECTION vs the pass-19 doc.** It stated: *"Reads (`any-member`) do not
> audit the override (was per-page-load noise)."* **That is no longer true —
> F19-30 reversed it** (`:184-210`). The exemption was justified as "every real
> mutation the override enables names a concrete `RbacAction`", and that claim
> was false: **commenting** is a real, deliberately role-free mutation
> (`appendComment` never calls `requireAction`, so the `"any-member"` gate
> reached through `requireVisibleProject` is its ONLY authority). An org-admin
> non-member could therefore write into a members-only project and leave no
> override row at all. The `"any-member"` override is audited now; the
> page-load-noise complaint is answered by **collapsing repeats inside the same
> 60 s window** rather than by silence, keyed `ovr|userId|slug|what` — the
> caller's `what` is in the key, so a READ gate ("view this project's policy")
> can never mask a WRITE gate ("act on this project"). `RbacAction` gates are
> never collapsed.

Throwing wrappers: `requireProjectAuthority` (`:261-278`, canonical task-guard
403), `requireRunAgents` (`:289-303`, adds the archived read-only gate before the
tier check — F17), `canRunAgents` (non-throwing @mention sibling, `silentDeny`,
`:307-323`), `assertProjectAction` (slug-only config surfaces, reads project.md
fresh, `:333-386`). `requireProjectMutable` (`:131-142`) is the single R6-3
archived-read-only gate. `isOrgAdmin` reads `users.role` directly and excludes
disabled accounts (`:147-153`).

### 1.4 F18-6 — last-live-admin guard (the ghost-admin deadlock fix)

`removeMember` in `app/features/project-settings/settings-actions.server.ts:654`.
When the target member has `role === "admin"` the guard counts only **live**
admins: it reads the target's `users.disabled` flag, computes `targetLive`
(`:700`), and refuses only when `targetLive && countLiveAdmins(...) <= 1`
(`:701-704`; `countLiveAdmins` imported from `./membership.server`, `:31`). A
**ghost admin** (its org account was deleted, so it's not counted live) is
therefore always removable — closing the deadlock where Settings→Members refused
the removal ("…is the only admin — assign another admin in Policy first") while
Policy pointed circularly back to Members. A real last live admin stays
protected. The org-level sibling — `deleteOrgUser` uses `countActiveAdmins(db)
<= 1` and `pruneUserFromProjects` drops the deleted account from every project's
membership so no ghost is created in the first place (UI-29,
`app/server/org/org-users.server.ts`).

---

## 2. Agent capability policy (`app/shared/capabilities.ts`)

Separate from human RBAC: what an AGENT may do at runtime. Grants are stored
per-deployment in `project.md` `agents[].capabilities[]` as `{capabilityId, mode}`
(`project-file.schema.ts:65-76`).

### 2.1 Modes and the catalog

`CapabilityMode` = `direct` | `recommend` | `human` | `off`
(`project-file.schema.ts:36`): `direct` = the agent performs it; `recommend` =
the operator proposes, a human applies; `human` = reserved for a human; `off` =
withheld entirely (the tool isn't even offered). `UNIFIED_CAP_CATALOG`
(`capabilities.ts:33-137` — **was `:33-105` in pass 19; two capabilities were
added**) is the single catalog, each entry tagged with `kinds` (`operator` |
`agent`), an editor `group` (`null` = matrix-only, no toggle), a `defaultMode`,
and `promotable` (`UnifiedCapabilityDef` `:13-22`).

**Critical polarity (P13-AP-06, `:143-147`):** `capabilities: []` does NOT mean
"no powers" — the tool policy treats an *unspecified* capability as **granted**,
so every creation path persists explicit grants. `defaultGrantsFor(kind)`
(`:148-155`) grants everything at its default; `conservativeGrantsFor(kind)`
(`:175-186`) is the org-template starting set that WITHHOLDS the dangerous ones
(`execute-code-or-write-repo`, the scoped delivery trio, the verdict outcomes)
because the org editor has no capability UI.

The runtime's own read of a grant is `effectiveCollabMode`
(`app/server/tasks/agent-outcome.server.ts:300-321`): an explicit
`direct`/`human`/`off` is authoritative, `recommend` is NOT (it has no agent
runtime meaning and falls through to the catalog default, which is `off` for
everything but the `direct`-default caps). Every capability-mount decision in
§2.5 goes through this function.

**Two capabilities post-date the pass-19 doc:**

- **`update-task-branch`** (`:76`, N19-9 owner ruling) — bringing a task branch
  up to date with its base is an OPERATOR decision, like delivery. The server
  executes the merge+push; agents never rebase or force-push. An absent grant
  follows the DELIVERY gate (`updateBranchGate`), because the capability
  post-dates every deployment. `operator` kind, group `Permissions`.
- **`use-browser`** (`:111`, R19-19 / ruling 75) — see §2.5.

### 2.2 ALWAYS_HUMAN — the structural locks

`ALWAYS_HUMAN_CAPABILITY_IDS` (`:194-198`): **`merge-pull-request`,
`transition-to-done`, `change-project-policy`**. These are `human` mode in the
catalog with `promotable: false` (`:134-136`), and `capabilityEnforcement`
returns `"both"` for them (enforced on Claude AND Codex, checked before the
claude-only set so a cap that is both is never mislabeled advisory,
`:263-271`). No agent ever holds them in an actionable mode. Done stays
human-only except the one deliberate `operatorAcceptCompletion` exception
(§3).

### 2.3 Enforcement scope (honesty metadata)

`capabilityEnforcement(id)` (`:263-271`) → `both` | `claude-only` | `advisory`:

- `ENFORCED_CAPABILITY_IDS` (`:206-241`) — withholding actually constrains
  runtime on both backends: branch/commit/PR/merge caps, `execute-code-or-write-repo`,
  the operator coordination caps, `deliver-review-pr`, **`update-task-branch`**
  (`:221`), `transition-to-done`, `change-project-policy`,
  `report-validation-verdict`, `ask-human`, `attach-evidence-references`,
  `use-web-search-fetch`, and **`use-browser`** (`:240`).
- `CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS` (`:250-258`) — enforced via Claude's tool
  denylist, advisory on Codex (`create-task-branch`, `commit-push-branch`,
  `open-review-pr`, `comment-on-task`).
- Everything else is advisory (persona guidance only).

The **toggleable** subset — the ids whose mode is genuinely consulted at runtime,
and therefore the only ones the capability-matrix modal offers — is now **13**
(`app/features/agents/capability-catalog.test.ts:39-56` pins the exact set and
the group order `Repository & execution` → `Collaboration` → `Reserved for
humans`): 4 repo caps + 5 collaboration gates (`comment-on-task`, `ask-human`,
`report-validation-verdict`, `attach-evidence-references`,
`use-web-search-fetch`) + `use-browser` + the 3 always-human. Pass 19's count
was 12; `use-browser` is the thirteenth.

### 2.4 The delivery headline + scoped grants

`execute-code-or-write-repo` (`:78`) is the headline gate over the three scoped
delivery caps `SCOPED_DELIVERY_CAPABILITY_IDS` (`:324-328`: create-task-branch,
commit-push-branch, open-review-pr). `repairDeliveryGrants` (`:361-403`)
materializes an ABSENT headline to `direct` when scoped grants are actionable
(the editor artifact), but an EXPLICIT `off`/`human` headline is **respected**
(B-AG1: the save layer only fills in what nobody set, never flips an admin's
withholding — it returns a `DeliveryGrantNotice` of kind `withheld` so the
contradiction is *reported*, not resolved behind the admin's back).
`applyVerdictOutcomeGate` (`:300-314`): the three verdict-outcome caps
(`VERDICT_OUTCOME_CAPABILITY_IDS` `:279-283` — approve-review, request-changes,
post-quality-flags) render as granted only when `report-validation-verdict` is
explicitly `direct` — else off (F15-06 honesty).
`absentDeliverReviewPrMode(humanGatedBeforeWork)` (`:434-438`) derives the mode
for a pre-R15-2 deployment from whether the project human-gates advancement, so
the runtime gate and policy surface can't drift (R15-9).

### 2.5 `use-browser` — the browser capability (R19-19, ruling 75) **[NEW]**

Owner ruling 75 (`docs/architecture/decisions.md`) gave agents a real headless
browser, and made it a **first-class capability rather than an org-registry MCP
row**. That distinction is the whole governance story: registry MCPs sit outside
capability policy (P13-KM-04 — governance by instruction only), and a browser is
exactly the tool that must not ride that gap, because it IS network egress, it
executes page JavaScript, and it feeds page content back into an agent that may
hold repo-write.

**Catalog entry** — `capabilities.ts:111`, `kinds: ["agent"]`, group
`Collaboration`, **`defaultMode: "off"`**, promotable. Default-off for the same
reason `report-validation-verdict` is: a casually created profile must not
silently acquire a driven browser. Under the P14-LV-01 polarity, *absence is
withholding* for this cap (the catalog default is what an absent grant resolves
to).

**Enforcement is the MOUNT itself** — `app/server/tasks/specialist-browser-mcp.server.ts`:

- `resolveBrowserMcp({grants, attachmentsDir, backend})` (`:93-142`) returns
  `{server, refused}`. It mounts nothing unless
  `effectiveCollabMode(grants, "use-browser") === "direct"` (`:99`).
- **The egress pair (`:106-114`)** — the mount *additionally* requires effective
  `use-web-search-fetch === "direct"`. A profile whose web egress was revoked
  must not re-acquire it one row down. The contradictory pair is **surfaced**
  (an `UnresolvedMcpGrant` riding the existing P14-LV-09 disclosure pipe), never
  resolved silently in either direction — the same stance `repairDeliveryGrants`
  takes on a withheld delivery headline.
- A missing `@playwright/mcp` install refuses the same way (`:116-121`), so
  "granted but not mounted" always carries a reason.
- This is `"both"`-backend enforcement of the strongest available shape: withheld
  ⇒ the server is never attached, so the tool surface simply does not exist and
  no deny rule is needed (`capabilities.ts:237-240`).

**Run wiring** — `app/server/tasks/specialist-run.server.ts`: the mount resolves
from the SAME grants the collaboration gates use, and only for a real backend
(`:1180-1195`); an unresolvable deployment passes `withheldAgentGrants()`. The
server name `viberr_browser` joins `viberr`/`viberr_agent` in `RESERVED_MCP_NAMES`
(`specialist-mcp.server.ts:60-65`, skipped at `:139`) so an org registry row can
never shadow or impersonate it. The persona section is appended **only when the
server actually mounted** (`:1775-1784`, text in
`specialist-browser-mcp.server.ts:150-173`); a granted-but-refused browser gets a
"Browser not mounted" section naming the reason instead, and the refusal also
joins the run-input disclosure (`:1227`) — a granted resource that silently
reaches no run is the silent-resource class this codebase keeps re-finding.
**Resume re-mounts from the same grants** (`:2187-2226`), so a resumed run cannot
lose or gain the browser the fresh run had.

**Containment the server config keeps** (`:123-138`, deliberate and tested):
`--isolated` (in-memory profile — no cookies/storage surviving a run or leaking
across tasks); no `--allow-unrestricted-file-access`, so Playwright MCP blocks
`file://` and confines file access to the child's cwd (the run workspace) — the
browser cannot read the data root; `--output-dir` → the task's canonical
`attachments/` dir; `--image-responses omit` on Codex only (image content blocks
in MCP tool results are unproven on the codex CLI). Injection stance is
**prompt-level** (owner decision b): page content is data, never instructions;
never enter credentials; *the browser widens no authority* — everything the
capability policy withholds stays withheld.

**Output governance** — files land in `taskAttachmentsDir`
(`app/server/files/file-store-root.server.ts:87-93`, i.e.
`projects/<slug>/tasks/<KEY>/attachments/`) and are served by
`app/routes/task-attachment.ts`. Authorization is **project membership**
(`requireProjectMember`, `:32-33`) — the same bar as `/resources/run-log`,
because a screenshot of the running app is run-artifact material, and org admins
pass via the audited D2 override inside that same guard. Serving is hostile to
content smuggling: traversal violations collapse into a plain 404 (no oracle),
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
default-src 'none'` on every response, only whitelisted types inline, and a
50 MB refusal bound (`:29`).

> **Gotcha worth carrying forward** (`specialist-browser-mcp.server.ts:39-44`,
> verified live on Playwright MCP 0.0.79): a **default-named** screenshot saves
> into `--output-dir` (the attachments dir a human can see); an
> explicitly-`filename:`d one resolves against the **child's cwd** (the run
> workspace) instead, because the SDK's stdio config carries no `cwd`. The
> persona therefore steers agents to default naming and says outright that a
> self-named file stays workspace-local where no human sees it.

---

## 3. The acceptance gate (verdict-gated completion)

Acceptance into Done is gated by the revision-bound review model
(DOMAIN-MODEL.md §2.3). The gate is `acceptanceBlockedReason(fm)`
(`app/schemas/task-file.schema.ts:630` — **was `:575-593`**) plus the closed-PR /
conflicting-PR / archived guards (`closedPrBlockedReason` `:674`,
`conflictingPrBlockedReason` `:695`) — one reason-or-null helper per condition,
composed server-side by `acceptanceRefusalReason`
(`app/server/tasks/task-actions.server.ts:5081`, which also folds in
`acceptanceStageBlockedReason` `:5045`) and consulted at every writer that lands
`stage=done`. A task with NO required reviewers and NO revision stays acceptable
(planning work); once a revision exists, every required reviewer must approve
THAT revision and none may request changes.

- **`accept-completion`** (A M) is the normal path.
- **`force-accept-completion`** (A only, `rbac.ts:79-83`) is the audited escape
  hatch (DG-2): it BYPASSES the verdict gate for a stuck task. Authority is
  resolved in `app/features/review/review-acceptance-authority.server.ts`
  (`AcceptanceAuthority` `:22`, `resolveAcceptanceAuthority` `:29`).
- **R19-5 (ruling 59) — force MAY jump, but must SAY so.** A pass-19 implementer
  read F19-25 as "force-accept must not jump the workflow graph" and added a
  server 409 refusing an off-boundary force; **the owner REVERTED it**. Force
  exists to unstick a wedged board, and a refusal would turn the one escape hatch
  into another wall. The burden is HONESTY: the dialog **enumerates the stages
  being skipped**, by name, in order. What force does NOT bypass is unchanged and
  non-negotiable — `forceIrreducibleRefusal`
  (`task-actions.server.ts:5155`) keeps the ruling-37 terminal GitHub fact (a
  closed, unmerged PR still refuses, **server-side**, not merely by hiding the
  button) and ruling 20's PR-head containment check.
- **R19-8 (ruling 62) — "Completed — no changes required" passes the SAME gate.**
  Ruling 43's "reviewer verdict optional" clause is superseded. The no-change
  path mints a `workRevision` anchored to the real default-branch head (a verdict
  needs a subject), keeps the full ceremony, and only loses the PR. The
  counterpart honesty rule: `defaultBranchEvidence.verified` from push-workspace
  is required on both doors (`no_branch`, `no_commits`), so a dirty tree, local
  commits on the default branch, an abandoned task branch or a swallowed
  auto-commit failure all stay a genuine delivery failure. Machinery in
  `app/server/tasks/no-change-completion.server.ts`.
- **R19-B (ruling 68) — a project member's GitHub approval counts as the
  approving verdict.** Closes the asymmetry where a human's *disapproval* bound
  the gate (ruling 37) while their *approval* was inert, forcing every acceptance
  on an agent-less project to be an audited force-accept. Four things make it
  evidence rather than a rubber stamp: it is bound to the delivered revision (the
  approval's `commit_id` must equal the delivered head, checked on record AND on
  every read, so a re-delivery invalidates it); the approver must be a project
  member resolved through `users.github_handle`; it **fails closed** (no linked
  handle, two claimants, or a non-member ⇒ it does not count, and the reason is
  recorded); and it is never silent. `humanVerdictApproval` /
  `verdictGateReason(fm, validation, taskKey)` in
  `app/server/github/pr-human-approval.server.ts:301`, threaded through the
  rebuilder's acceptance-block derivation
  (`app/server/projections/rebuilder.server.ts:332`).
- **R17-1 revision drift** — accepting a PR head strictly ahead of the reviewed
  revision is allowed but the accept dialog surfaces the extra unreviewed commits
  (`pr.revisionDrift`).
- **R16-x out-of-band merge** — a PR merged/closed on GitHub outside the app is
  NOT auto-advanced; the reconciler notes the divergence and recommends.
- **`operatorAcceptCompletion`** (`operator-actions.server.ts:2519` — **was
  `:2017`**) is the ONE deliberate exception to human-only-Done: a `full`-autonomy
  operator holding an explicit `completion-for-acceptance: direct` grant moves the
  task to Done itself (owner ruling Q1; the cap is `promotable:false`, and `gate`
  refuses to promote `recommend`→`direct` for exactly this id,
  `operator-actions.server.ts:449`).

### 3.1 One ceremony, six modes (pass 19's R15-1 consolidation)

The pass-19 doc recorded only the **board** half of this (B1 /
`AcceptOnBoardConfirm`). The larger fix is on task detail:
`app/features/task-detail/accept-confirm.tsx` is now **the one acceptance
ceremony**, with `AcceptCeremonyMode` (`:38-44`) covering every writer that lands
Done — rulings 12/14, never fork a mapping per surface:

| Mode | The path that raises it |
| --- | --- |
| `accept` | the ordinary Accept button |
| `force` | admin force-accept (adds the `Skips` and `Bypassing` rows) |
| `complete-merge` (F19-24) | the mandatory human half of a full-autonomy operator acceptance (R16-6) — it performs the real, irreversible merge |
| `apply-recommendation` (F19-3/F19-26) | applying an operator recommendation whose TARGET is the terminal stage, whatever its `kind` says |
| `packet` (F19-7) | resolving a decision packet's `accept_completion` option, whose "Confirm decision" button named no merge at all |
| `stage-move` (F19-37) | the Current-state stage menu picking the LAST stage, which the server reads as an acceptance |

The dialog states exactly what merges: PR number + state pill (rendered through
the one PR-state map — F19-14 caught the raw internal token leaking here), the
delivered revision sha, the **merge head when it has drifted ahead** (R17-1,
`:274-291`), the verdict — **naming the human and commit when R19-B's GitHub
approval cleared it** (`:292-305`) — the target branch, and any bypassed refusal.
The `Skips` row (`:312-326`) is **force-only by construction** (`skipsStages =
force && !atBoundary`, `:164`): force is the only mode where the server skips the
gate stack, so it is the only mode that may claim a jump. Two earlier rounds got
this wrong in opposite directions and the reasoning is preserved in-file at
`:132-162` — worth reading before touching that predicate.

Wired at `app/features/task-detail/task-detail-page.tsx:8` (import), `:63-80`
(pending state, one variant per path), `:696-707` (render).

The **board** keeps its own narrower dialog, `AcceptOnBoardConfirm`
(`app/features/board/board-page.tsx:824`, state `:1505`, raised from the drag
path `:1582` and the keyboard Move `:1620`, rendered `:1987-1998`) — a board drag
into the FINAL stage routes through `reorderTask` → `acceptCompletion`, i.e. it
attempts a real PR merge (R18-7 / ruling 53). It also handles the card that
leaves the board while the confirm is open (`:1685-1691`) rather than rendering a
dialog about a task that no longer exists.

---

## 4. Operator autonomy

`OperatorAutonomy` = `supervised` | `full` (`operator-actions.server.ts:95` —
**was `:84`**), read from the deployment `definition.autonomy` via `readAutonomy`
(`:177`) and resolved by `resolveOperatorAuthority` (`:338`). Supervised: the
operator RECOMMENDS at governed boundaries (delivery, transitions, acceptance)
and a human applies. Full: it performs them and may accept completion to Done.

`gate` (`:434-453`) and `deliverGate` (`:464`) map a capability grant + autonomy
to a `Gate = "direct" | "recommend" | "deny"` decision (the type is at `:151`;
note `off` is the capability MODE name, not a gate outcome). `deliverGate` and
`updateBranchGate` carry the deliberate **absent-means-granted** polarity for
capabilities that post-date live deployments — but both refuse outright when no
operator is deployed at all (A4), which is the hole that once let an
operator-less project push a branch and open a PR.

### 4.1 R19-A (ruling 67) — autonomy is a CEILING, not a pin **[NEW since pass 19]**

`resolveOperatorAuthority` used to return `overrides.autonomy ?? configured`
verbatim, so **any `run-agents` role (maintainer+) could launch one turn at
`full` on a project whose operator is deployed `supervised`** — promoting every
`recommend` capability (stage transitions, packets, typed events,
`deliver-review-pr`) to direct execution with no confirm, no distinct audit row,
only a toast. The Policy page presents operator autonomy as *project*
configuration (ruling 2); a per-run dropdown that silently outranks it makes that
page a lie.

The configured autonomy is now a ceiling the run is clamped to —
`clampAutonomy` (`:215`), applied at `:365-367` (undeployed ⇒ `supervised`) and
`:406-409` (the configured level). Choosing **less** autonomy for a single run
stays allowed and is not a clamp; omitting the override is not a clamp either.
The clamp is audited **only when it actually bites**, via the typed
`task.operator.autonomy_clamped` fact (`auditAutonomyClamp` `:237`), and the
selector offers exactly the options that will really run. `operatorAutonomyFor`
(`:322`) is the shared read of a deployment's configured level.

### 4.2 R19-6 (ruling 60) — `off` is a HARD REFUSE on every route **[NEW since pass 19]**

The leak: with `completion-for-acceptance: off`, an operator that could not
*recommend* accepting a completion still produced an `accept_completion` card and
a `task.operator.recommended_completion` audit row **by rerouting through a plain
terminal-stage transition** (F19-26's target-not-kind hole). `off` is a withheld
capability, not a routing hint. The gate is now checked **FIRST — before any
read, card or audit row — on every path that reaches the action**, including the
terminal-target reroute (`operator-actions.server.ts:2364` for the reroute,
`:2472-2473` and `:2525` for the acceptance path). `human` refuses the same way
while saying the decision is reserved for a human. The operator refuses **out
loud** and narrates it: a silent reroute is worse than a refusal, because the
human sees a card whose authority does not exist.

See AGENTS-RUNTIME.md for how autonomy drives the R18-2 post-delivery re-queue.

---

## 5. Human RBAC → UI honesty (what a denied role SEES)

Enforcement was already correct for every role; passes 19-20 closed the surfaces
that disabled a control without saying why (a disabled control cannot explain
itself through `title`). This matters for RBAC because the reader's model of the
policy comes from these notes. **Every anchor below was re-verified at `b97ad02`
— the pass-19 line numbers had all shifted.**

| Surface | Rule | Anchor |
| --- | --- | --- |
| Project Settings — Project panel | lock note naming the missing **Change project settings** grant | `settings-page.tsx:109-118` |
| Project Settings — Stages panel | same lock note; the "drag to reorder / click to rename" how-to renders only for a reader who can act (LV-F2) | `settings-page.tsx:776-795` |
| Project Settings — Members panel | lock note naming **Manage members & roles** | `settings-page.tsx:882-890` |
| Project Settings — RepoPanel | same lock note (UXA-3) | `settings-page.tsx:1169-1180` |
| Project Settings — **Danger zone** | **Q-V1 owner ruling**: the section renders ONLY when `roleCan(myRole,"edit-policy")`. It used to render for every member with disabled buttons + a deny note — honest, but it showed a read-only stakeholder a destructive surface and named archive/delete as if they were on the table. The in-panel deny note stays for in-between roles. | `canEditPolicy` `settings-page.tsx:1483`, gate `:1649`; in-panel `canManageLifecycle` `:1367`, deny note `:1382-1388` |
| **Project GitHub — credential card** | **R19-11 (ruling 65) — the PAT half of Q-V1, now IMPLEMENTED.** See below. | `github-view.tsx:136-150` + `:445-453`; loader predicate `routes/project.github.tsx:101`, redaction `:105` |
| Agents page | read-only note naming the **Manage agents** grant (UXA-15); previously New profile / Add from library / Edit / Delete simply vanished with no explanation | `agents-page.tsx:1255` (`canManage` at `:1059`) |
| Task comment composer | "Every project member can comment · @mentions route to agents" — was the false "Open to every registered user" (UXA-1); membership IS the gate (R15-4) | `timeline.tsx:435` |
| Topbar org-admin override pill | the D2 sentence lives in `aria-label`, not a `title` on a non-focusable span, so keyboard/AT/touch reach it (UXA-13) | `topbar.tsx:155` |

> **CORRECTION vs the pass-19 doc.** Its closing note read: *"NOT implemented,
> recorded honestly: the PAT half of Q-V1. A viewer's Settings HTML still
> carries the GitHub connection tail."* **That is now stale — ruling 65 (R19-11)
> both ruled and shipped it.** The owner's finding was sharper than "still to
> do": the PAT half had been recorded *only in a pass-19 reference doc* and
> quietly never built, so the question read "ruled + shipped" while half of it
> was neither. The shipped rule: the credential card is **withdrawn, not
> disabled** (ruling 37's precedent — a withdrawn affordance is honest, a
> disabled one invites a support question); the predicate is the SAME
> `ACTION_ROLES` entry the route's action guard already enforces
> (**`grant-github-scope`**, covering grant-scope, set-credential and
> clear-credential alike), so a role can never be shown a control it may not
> use; and **the loader redacts on that same rule**, because a client-only gate
> leaves the token tail sitting in the HTML. The ruling additionally requires a
> **full-page render at Viewer asserting the card is ABSENT, canaried by
> removing the gate** — because pass 19's audit caught the Danger-zone half
> sitting on an owner ruling with no test that could fail (the suite rendered the
> section component directly and its only full-page render hardcoded an admin).
> *An owner ruling whose guard cannot go red is a ruling that gets reverted in
> silence.*

---

## 6. Delta (pass 19 → pass 20)

- **`rbac.ts`: no change.** The 18-row `ACTION_ROLES` map, `ROLE_RANK` and the
  accessors are exactly as pass 17 documented; every line anchor still resolves.
- **`project-authority.server.ts`: F19-30** — the `"any-member"` org-admin
  override is audited now (60 s collapse keyed on the caller's `what`), because
  commenting is a real mutation whose only authority is that gate. Every line
  anchor in §1.3 moved.
- **`capabilities.ts`: +2 capabilities.** `update-task-branch` (N19-9, operator,
  `Permissions`) and `use-browser` (R19-19, agent, `Collaboration`, default
  **off**). Both land in `ENFORCED_CAPABILITY_IDS`. The toggleable set went 12 →
  13. Everything else in the module is unchanged in substance; all line anchors
  moved (the catalog grew from `:33-105` to `:33-137`).
- **R19-19 / ruling 75 (commit `308cbc3`)** — the browser mount, its egress pair
  requirement, the reserved `viberr_browser` name, per-run/per-resume resolution,
  the persona guardrails, and member-only attachment serving (§2.5).
- **R19-A / ruling 67** — per-run autonomy is a ceiling, not a pin, with a typed
  clamp fact (§4.1).
- **R19-6 / ruling 60** — a withheld (`off`) or `human` capability is a hard
  refuse on every route, checked before any card or audit row (§4.2).
- **R19-5 / ruling 59** — force-accept may skip stages *and* the review gate, but
  the dialog enumerates what it skips; the server-side irreducible refusals
  (terminal GitHub fact, PR-head containment) are what force never bypasses (§3).
- **R19-8 / ruling 62** and **R19-B / ruling 68** — the no-change path keeps the
  full verdict ceremony; a project member's GitHub approval, bound to the
  delivered revision and failing closed, satisfies that verdict (§3).
- **R19-11 / ruling 65** — the deferred PAT half of Q-V1 shipped, gated and
  redacted on `grant-github-scope` (§5).
- **F19-28** — the six config loaders no longer answer with a 403 that reveals a
  project exists; one byte-identical 404, and no slug echo on run-addressed
  resource routes (§1.2).
- The acceptance ceremony was consolidated into **one dialog with six modes**
  (§3.1); the pass-19 doc described only the board half.

## 7. What the pass-19 doc got wrong

Two of these were already wrong when it was filed (it was verified at `65063b8`,
the pass-18 merge, and pass 19's own implementation landed after):

1. *"Reads (`any-member`) do not audit the override"* — reversed by F19-30. The
   `"any-member"` gate authorizes real mutations (commenting), not just reads.
2. *"NOT implemented, recorded honestly: the PAT half of Q-V1"* — implemented as
   ruling 65 (R19-11), including the loader-side redaction the doc's "exact next
   step" had identified.
3. *"Neither `rbac.ts` nor `capabilities.ts` nor `project-authority.server.ts`
   changed"* — true through pass 18, but `capabilities.ts` and
   `project-authority.server.ts` both changed during pass 19 itself, and
   `capabilities.ts` again at R19-19.
4. Essentially **all line citations for `capabilities.ts`,
   `project-authority.server.ts`, `operator-actions.server.ts`,
   `task-file.schema.ts` and the §5 UI table were stale** — the shifts are large
   (e.g. `operatorAcceptCompletion` `:2017` → `:2519`, `acceptanceBlockedReason`
   `:575` → `:630`). Re-verify anchors before quoting them; the surrounding
   docblocks in those files are the durable part.
5. §3's acceptance story named only `B1`/the board dialog. The load-bearing
   pass-19 work was the six-mode ceremony on task detail (§3.1), of which the
   `stage-move` mode — the Current-state stage menu picking the last stage — was
   the last surface where a task reaching Done merged silently.
