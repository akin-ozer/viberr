# Agent profile lifecycle & operator selection inputs — pass 13 (2026-07-24)

Scope: the two agent-profile creation surfaces (org-level "Global agent profiles"
vs project-level agent editor), the profile file schema (`desc` vs body), capability
grant storage/defaults, deployment/engagement lifecycle, and exactly what the
operator sees when it picks an agent.

Every claim below was re-verified against `main @ c7abebf` (post PR #94). Paths are
repo-relative; line numbers from that snapshot. Prior art
(`planning/discovery-2026-07-24-pass12/docs/agents-operator-runtimes.md`) was read
first and its §1/§2 claims re-checked — corrections are called out inline.

---

## (a) Summary

**The two editors are not two views of one thing — they are two different objects
with an accidental collision.**

- The **project editor** (`app/routes/project.agents.tsx` →
  `agent-profile-actions.server.ts`) writes a `project.md` **deployment** with a full
  `definition` override. It is the complete editor: name, role, backend, model,
  effort, stages, **Description (`desc`)** and **Persona / instructions (body)** as
  two separate textareas, capability grants, resources. It never touches an org
  template file.
- The **org editor** (`app/features/org-settings/resources-panel.tsx` →
  `app/server/org/gagents.server.ts`) writes an org **template file** with 6 fields
  (name, backend, one-line "Role summary", stages, skills/mcps/kbs). It has no
  capability UI, no model, no persona field, and no `desc` field.

Three structural problems fall out of that:

1. **The org editor's one-line "Role summary" is written into the markdown BODY** —
   which is the agent's persona / system prompt (`gagents.server.ts:179`, `:223`).
   Editing a seeded profile from the org editor **destroys the shipped persona**.
   The frontmatter `desc` — the field that same input claims to edit ("One line the
   operator sees when assigning work") — is *never updated on edit*. Confirmed: the
   pass-12 doc's §1 characterisation ("writes it into BOTH frontmatter `desc` and
   the markdown body") is only true on **create**; on **edit** it writes ONLY the
   body and leaves `desc` stale. Both halves are wrong in different directions.
2. **A global agent profile created in the org editor can never be used.** There is
   no code path anywhere that adds an org template to a project's `agents:` array.
   The only writers are `createAgentProfile` (project-local, which actively *avoids*
   template ids), project creation, and the built-in backfill. So the create toast
   ("grant it eligibility in a project's policy to deploy") and the panel note
   ("Each project's policy decides which profiles are eligible") describe a surface
   that does not exist. `used` is permanently 0 for anything created there.
3. **`npm run seed` — step 3 of the documented install — downgrades the built-in
   personas.** `runSeed` unconditionally overwrites `agents/profiles/{developer,
   reviewer}.md` with body = the 2-sentence catalog blurb
   (`seed.server.ts:169-176`), while the rich 20-line personas only ship through
   `seedDefaultAgentAssets`, which skips any file that already exists
   (`default-assets.server.ts:104`). On the README order (seed → dev) the shipped
   personas in `app/server/seed/assets/{developer,reviewer}.definition.md` never
   reach disk.

Plus one independent, high-impact selection bug: the **"Lightweight · 3 stages"**
project template ships the built-in Developer/Reviewer whose eligible stages are
governed-5 ids (`ready`/`impl`/`review`), so on a lightweight board (`todo`/`doing`/
`done`) **no specialist is ever stage-eligible** and the operator cannot hand off.

---

## (b) Verified code map

### 1. Profile file schema — `desc` vs body

`app/server/files/agent-profile-file.server.ts` (there is **no** agent schema under
`app/schemas/*`; the pass-12 doc's pointer to `app/schemas` for profiles is wrong —
`app/schemas/` holds only project/task/sse/pat/github schemas).

| thing | where | meaning |
|---|---|---|
| `frontmatter.desc` | `agent-profile-file.server.ts:32-36` | "Short scannable description … what the OPERATOR reads when picking a profile." Empty → views fall back to the body. |
| markdown body → `ParsedAgentProfile.description` | `:93-97`, set at `:140` (`body.trim()`) | the long persona / system-prompt material |
| known-key drift warning | `:76-91`, `:126-138` | unknown frontmatter keys are preserved but warned |
| serialize | `:145-151` | frontmatter + body, no transformation |

Resolution into a run (`app/features/agents/agents-query.server.ts`):

- `readTemplate` :136-166 — surfaces both (`desc` :163, `description` :164).
- `effectiveProfileView` :169-247:
  - `desc: def?.desc ?? (template?.desc || template?.description) ?? ""` (**:227**)
    → **this is what the operator selects on**.
  - `definition: def?.persona ?? template?.description ?? ""` (**:232**) → **this is
    the run's system prompt**.
  - `capabilities` come **only** from `deployment.capabilities` (:186-195). The
    template file's `capabilities:` array is **never read by anything** (grep of
    `agentProfileFilePath` readers: agents-query, gagents, agent-profile-actions
    (existence check only), seed).

Consumers of each:
- `desc` → `listDeployedSpecialists` :1446-1497 (`desc: view.desc`, :1481) →
  `operatorSnapshot.deployedSpecialists` (`operator-actions.server.ts:784-787`) →
  `get_task` tool result (`operator-toolkit.server.ts:86-95`) and, for Codex, the
  whole snapshot inlined as JSON (`operator-run.server.ts:1113-1118`).
- `definition` → `toResolved` (`specialist-run.server.ts:142`) →
  `buildSpecialistPersona` (:888-946, `definition` is the first part) → `startRun`
  `systemPrompt`. Same on resume (`resolveResumeConfinement` :1131-1136).

### 2. ORG-level editor (Global agent profiles)

UI: `app/features/org-settings/resources-panel.tsx`
- `AgentModal` :355-…; state seeded from `initial.summary` (:378) — and
  `GagentView.summary` **is the markdown body** (`gagents.server.ts:107`).
- The only prose field is a single-line `<input id="ga-sum">` labelled **"Role
  summary"**, placeholder **"One line the operator sees when assigning work"**
  (:494-505).
- `canSave` requires name ≥2 chars and ≥1 stage — **summary may be empty** (:410).
  (Contrast the Skill modal at :267, which requires `summary.trim().length > 3`.)
- Submit payload: `{name, backend, summary, stages, skills, mcps, kbs}` (:429-443).
  No desc/persona split, no model, no effort, no capabilities, no `spanAll`.
- Footer hint: `"used in N projects — changes apply on next run"` (:424-428).
- Row subtitle renders `{a.summary}` = **the full markdown body** (:932).
- Panel note: "Each project's policy decides which profiles are eligible…" (:1065-1072).

Route: `app/routes/org.settings.tsx:297-318` (`agent-save` / `agent-delete`), org
`admin` + CSRF (:99-110).

Server: `app/server/org/gagents.server.ts`
- `GagentView.summary` ← `parsed.description` (body) at **:107**.
- `listGlobalAgentProfiles` :117-133 — specialists only (:129).
- `saveGlobalAgentProfile` **create** :199-240:
  `desc: input.summary.trim()` (:212), `backends: [backend]` (:214),
  `model: ""`, `capabilities: []` (:219), `extras: []`,
  `description: input.summary.trim()` (:223), `spanAll: false`.
- `saveGlobalAgentProfile` **edit** :165-197:
  frontmatter = `{...existing.frontmatter, name, role, backends:[backend], stages,
  resources}` (:170-178) — **`desc` is NOT in the spread override, so it keeps the
  old value**; `description: input.summary.trim()` (**:179**) — **the body is
  replaced wholesale**.
- `deleteGlobalAgentProfile` :246-276 — refuses while `used > 0` (:259-266),
  refuses the operator (:254-258), else `rmSync` (:267).
- `usedByProject` :70-95 — distinct-profileId deployment count over **all** rows of
  `projects` (no `archived` filter; `archived` column exists,
  `db/migrations/0001_baseline.sql:52`).

### 3. PROJECT-level editor

UI: `app/features/agents/create-profile-modal.tsx`
- Payload shape :33-48 — `definition` (= desc) **and** `persona` as separate fields.
- `DefinitionField` :417-470: "Description — one short paragraph — the OPERATOR
  reads this to pick the right agent" (textarea, :443-449) and "Persona /
  instructions — injected as its system prompt on every run" (textarea, :460-466).
- Edit seeds `definition ← initial.desc` (:760) and `persona ← initial.definition`
  (:761) — the correct mapping.
- `seedCaps` :101-125 — every toggle seeded from the STORED grant only.

Server: `app/features/agents/agent-profile-actions.server.ts`
- `createAgentProfile` :213-283 — pushes a `project.md` deployment with a full
  `definition` (:244-263): `desc` from the form's Description or a generated
  fallback (:256-258), `persona` only when non-empty (:260). Grants =
  `createModalGrants` :191-209 (**exactly the submitted modal caps**, no permissive
  defaults, ALWAYS_HUMAN coerced, verdict explicit-only, then
  `normalizeDeliveryGrants`).
- Id allocation :232-241 — bumps `-2` if the slug collides with an existing
  deployment **or an existing org template file**.
- `updateAgentProfile` :287-371 — always writes a **full** definition snapshot
  (:328-357); empty desc/persona keep `current.desc` / `current.definition`
  (:345, :348-352).
- `deleteAgentProfile` :375-420 — deployment only; operator refused (:397-403).
- RBAC: `manage-agents` (project admin), `requireProjectAction` :92-107.

Route: `app/routes/project.agents.tsx` — intents `create-profile` / `update-profile`
/ `delete-profile` (:81-121). **There is no "deploy a global profile" intent.**

### 4. How a deployment actually comes into existence

Only three writers of `project.md` `agents:` exist:
1. `app/features/home/project-create.server.ts:240` —
   `presetAgents(policy, defaultAgentDeployments())` (operator + developer +
   reviewer, `agent-catalog.server.ts:160-189`).
2. `app/server/seed/ensure-base-agents.server.ts:32-88` — boot backfill: operator
   always; the base specialists **only when the project has zero specialists**.
3. `agent-profile-actions.server.ts:270` — the project editor's create.

`grep -rn "agents.push\|agentPolicy" app` returns nothing else. → **an org-created
template is unreachable**.

### 5. Capabilities

- Catalog: `app/shared/capabilities.ts:33-75` (`UNIFIED_CAP_CATALOG`); editor
  projection `app/features/agents/capability-catalog.ts:38-71` (`group: null` =
  matrix-only, no toggle; `CAP_MODAL_DEFAULTS` :66-71 mirrors `defaultMode`).
- Grant storage: **per deployment** (`project.md agents[].capabilities`), never per
  template at runtime (see §1).
- **Empty grant list = FULL power, not "nothing":** polarity is safe-by-default —
  `isWithheld` only fires on `human`/`off`/ALWAYS_HUMAN
  (`specialist-tool-policy.ts:71-79`), so `resolveSpecialistDisallowedTools([])`
  denies only `Bash(gh pr merge:*)` (:85-96) and `resolveDeliveryPermissions([])`
  returns `{canBranch:true, canCommitPush:true, canOpenPr:true}` (:124-143).
  Collaboration falls back to catalog defaults: comment/ask **on**, verdict **off**
  (`agent-outcome.server.ts` `resolveAgentCollab`, catalog `capabilities.ts:54-58`).
- The matrix modal is read-only (`capability-matrix-modal.tsx:9`).

### 6. Operator selection inputs

`DeployedSpecialistView` per candidate (`specialist-run.server.ts:1446-1497`):
`{id, name, role, backend, model, effort, desc, capabilities:{delivery, verdict,
askHuman}, resources:{skills,mcps,kb}, stages, spanAll}` + `eligibleForCurrentStage`
(`operator-actions.server.ts:784-787`). `delivery`/`verdict` require an explicit
`direct` grant (:1478-1489); `askHuman` uses `effectiveCollabMode` so it is `true`
for nearly every profile (pass-12 finding #8, still true).

The Claude operator gets it via `get_task` (tool description instructs
"SELECT agents by `desc` … and `capabilities` … never by guessing from names",
`operator-toolkit.server.ts:92`). The Codex operator gets the entire snapshot
inlined as JSON (`operator-run.server.ts:1113-1118`), so a bloated `desc` costs
tokens on every Codex operator turn. Every engage/run/prompt writes an audit
selection trace with the full candidate list
(`recordAgentSelectionTrace`, `operator-actions.server.ts:1262-1305`).

---

## (c) Findings candidates

### F13-A1 — HIGH — Editing a seeded profile in the org editor destroys its persona (system prompt)

`app/server/org/gagents.server.ts:179` · `app/features/org-settings/resources-panel.tsx:378,494-505,410`

`GagentView.summary` is the markdown **body** (`gagents.server.ts:107`), which is the
agent's persona and becomes its run `systemPrompt`
(`agents-query.server.ts:232` → `specialist-run.server.ts:142` →
`buildSpecialistPersona:888`). The org "Edit agent profile" modal pre-fills a
**single-line `<input>`** with that body (`resources-panel.tsx:378`) and saves it back
as the body (`gagents.server.ts:179`).

Failure scenario: an org admin opens Settings → Global agent profiles → Edit
"Developer". The one-line field is pre-filled with the whole ~20-line persona
(HTML input value sanitisation strips the newlines, so it renders as an unreadable
run-on). The admin does what the label says — replaces it with "Implements features"
— and saves. `agents/profiles/developer.md`'s body is now that one line. Every
subsequent Developer run on **every project** loses "Orient → implement the smallest
correct change → validate → report precisely", its boundaries section, and its
reporting contract. Nothing in the UI warns, and the toast says "Developer updated —
running threads re-anchor on next turn". Even a *no-op* open-and-save flattens the
persona the moment the admin types any character (the DOM-sanitised, newline-free
value replaces the React state). `canSave` doesn't require a summary
(`resources-panel.tsx:410`), so clearing the field writes an **empty** persona.

Suggested fix: give the org editor the same two-field split the project editor
already has (`create-profile-modal.tsx:417-470`) — a `desc` input and a `persona`
textarea — and make `saveGlobalAgentProfile` write `desc` from the summary and leave
the body untouched unless a persona field was submitted. Minimum viable fix: change
`GagentView.summary` to `fm.desc || parsed.description`, write `desc` on both create
and edit, and never write the body from that field.

### F13-A2 — HIGH — The org editor's "Role summary" does not change what the operator sees

`app/server/org/gagents.server.ts:170-180` vs `app/features/agents/agents-query.server.ts:227`

On the **edit** path the frontmatter spread (`:170-178`) does **not** include `desc`,
so `desc` keeps its creation-time value forever, while the body is replaced (`:179`).
The operator reads `template.desc || template.description` (`agents-query.server.ts:227`)
— a non-empty stale `desc` wins.

Failure scenario: admin creates "Security reviewer" globally with summary "IAM
second pair of eyes" → file gets `desc: "IAM second pair of eyes"` **and** the same
body. Later they broaden it to "Reviews IAM, secrets handling and supply-chain
risk". The card subtitle updates (it renders the body, `resources-panel.tsx:932`), so
the UI says the change landed — but `desc` is still "IAM second pair of eyes", and
that is the only string the operator ever sees. The field whose placeholder is
literally "One line the operator sees when assigning work" is the one field that has
no effect on the operator.

Note this is also the assertion the current test **enshrines**:
`app/server/org/gagents.server.test.ts` expects `frontmatter.desc` to be preserved
("another field the modal doesn't own") and `parsed.description` to become the new
summary. The fixture body is a short blurb ("Implements stage work."), which is why
the persona-destruction in F13-A1 is invisible to the suite.

Suggested fix: write `desc` on the edit path too (same value), and stop writing the
body — i.e. the same fix as F13-A1, plus updating that test to assert the body is
preserved byte-for-byte.

### F13-A3 — HIGH — `npm run seed` (documented install step 3) replaces the built-in personas with a 2-sentence blurb

`app/server/seed/seed.server.ts:168-176` · `app/server/seed/default-assets.server.ts:74-95,104` · `README.md:47`

`specialistProfileAssets()` builds developer/reviewer templates with
`desc: p.frontmatter.desc` and `description: SPECIALIST_PERSONA_BY_ID[id]` — the rich
persona from `assets/{developer,reviewer}.definition.md`
(`default-assets.server.ts:88-94`) — but `seedDefaultAgentAssets` writes **only when
the destination is missing** (`:104`). `runSeed` writes the same two files
**unconditionally** with `description: profile.description`
(`seed.server.ts:169-176`), and `profile()` sets both `desc` and `description` to the
short catalog blurb (`agent-catalog.server.ts:68-76`, developer blurb at :126,
reviewer at :150).

Failure scenario: a fresh install follows the README — `npm run seed` (step 3) then
`npm run dev` (step 4). Seed writes `developer.md` with a 2-sentence body; boot's
`seedDefaultAgentAssets` sees the file exists and skips. The Developer agent's system
prompt is permanently "Implements stage work on the task-key branch: …" instead of
the full operating manual, on every board, forever. `npm run seed -- --reset` makes
it worse: `resetStore` deletes `agents/profiles/` (`seed.server.ts:106-109`) and
`runSeed` immediately re-creates the short versions — the persona can never come
back without deleting the files and restarting. The two seed paths also disagree on
`resources.kb` (the boot asset strips KB grants, `default-assets.server.ts:92`; seed
keeps `["architecture-notes","api-contracts"]`), so `npm run seed` can leave dangling
"N of 0" KB grants that the 2026-07-18 owner fix removed.

Suggested fix: make `SEED_AGENT_PROFILES` (or a shared builder) the single source for
the on-disk template content including the persona body and the KB-stripping rule, and
have both `runSeed` and `seedDefaultAgentAssets` emit identical bytes. Add a test that
asserts the seeded `developer.md` body contains "You are the Developer".

### F13-A4 — HIGH — A "Lightweight · 3 stages" project ships specialists that are ineligible for every one of its stages

`app/shared/workflow/templates.ts:65-72` · `app/features/home/project-create.server.ts:184-185,228,240` · `app/server/tasks/specialist-run.server.ts:1413-1437`

Project creation uses `template.stages` for the board but the **stage-agnostic**
`defaultAgentDeployments()` for the roster. The built-in Developer's eligible stages
are `["ready","impl"]` and the Reviewer's `["impl","review"]`
(`agent-catalog.server.ts:106,133`); a lightweight board's stages are
`todo`/`doing`/`done`. `specialistEligibleForStage` returns false for all of them
(non-empty `stages`, `spanAll:false`, no match, :1413-1420), and `assertStageEligible`
throws at both assign and run (:1427-1437).

Failure scenario: a user creates a project with the "Lightweight · 3 stages"
template and adds a task. The operator auto-invokes, sees `deployedSpecialists` all
with `eligibleForCurrentStage: false`, and either strands the task or picks one
anyway — in which case `operatorPromptAgentGeneric` throws *"Developer is not
eligible for the 'doing' stage — its profile is scoped to ready, impl"*, aborting the
Codex plan / erroring the Claude tool call. A human clicking Run gets the same 400.
The board is unusable for agent work with no diagnosis surfaced anywhere; the org
editor can't fix it either, because its stage chips come from `GOVERNED_TEMPLATE`
(`app/server/org/org-view.server.ts:51`) and never offer `todo`/`doing`.

Suggested fix: either give the built-in specialists `spanAll: true`, or have
`project-create.server.ts` remap the default roster's `stages` onto the chosen
template's resolved stage roles (`resolveStageRoles` already yields work/review ids),
storing the mapped stages in the deployment `definition`.

### F13-A5 — HIGH — A profile created in the org editor can never be deployed, run, or selected

`app/server/org/gagents.server.ts:238` · `app/features/org-settings/resources-panel.tsx:1065-1072` · `app/routes/project.agents.tsx:81-121`

No code path adds an org template to a project's `agents:` array (§b.4). The project
create action even bumps a colliding slug to `-2` to *avoid* an existing template
(`agent-profile-actions.server.ts:234-241`).

Failure scenario: an admin follows the org-settings affordance, creates "Security
reviewer" globally, and gets the toast *"Security reviewer created — grant it
eligibility in a project's policy to deploy"*. They open the project's Agents page
looking for that grant. There is no such control — only "New profile", which creates
an unrelated project-local profile. The global one shows "not deployed" forever, the
operator never sees it, and its stages/skills/MCP/KB selections are inert. The panel
note ("Each project's policy decides which profiles are eligible, which of their
context resources may load, and what they may do") describes a feature that was never
built.

Suggested fix: add a "Deploy from global profile" action on `project.agents.tsx`
(append `{profileId, capabilities: <template caps or catalog defaults>, extras}` to
`project.md`), or — if that is not wanted — remove the org-level agent CRUD and its
copy so the surface stops promising a lifecycle it can't complete.

### F13-A6 — MEDIUM — A deployment with `capabilities: []` gets FULL repo-write power

`app/server/org/gagents.server.ts:219` · `app/server/tasks/specialist-tool-policy.ts:71-79,85-96,124-143`

Org-created templates persist `capabilities: []`, and the org editor exposes no
capability UI at all. The template's grants are never read at runtime anyway
(`agents-query.server.ts:186-195`), but the same shape is what a hand-written
deployment looks like — and empty grants mean **allow everything except
`gh pr merge`**, because the polarity is "deny only on explicit `human`/`off`".

Failure scenario: any path that produces a deployment with no grants (a hand-edited
`project.md`, an import, or a future "deploy from global" that copies the template's
empty array) yields an agent with `Edit`/`Write`/`Bash(git commit)` and
`canBranch/canCommitPush/canOpenPr` all true — the opposite of the "safe by default"
posture the create modal enforces (`createModalGrants` persists *only* what was
ticked, `agent-profile-actions.server.ts:178-209`). The org UI shows no capability
row for these profiles, so nothing indicates the agent is fully privileged.

Suggested fix: seed `CAP_MODAL_DEFAULTS` (minus verdict) on org-level create so a
template carries an honest, explicit grant set, and — regardless — make any future
deploy path run the grants through `createModalGrants`/`normalizeDeliveryGrants`
rather than passing `[]` through.

### F13-A7 — MEDIUM — The first project-level edit of a built-in profile permanently freezes it against org-level edits

`app/features/agents/agent-profile-actions.server.ts:328-357` · `app/features/agents/agents-query.server.ts:215-244` · `app/features/org-settings/resources-panel.tsx:424-428`

`updateAgentProfile` always writes a **complete** `definition` snapshot — name, role,
backends, model, effort, scope, desc, persona, stages, resources — copied from
`effectiveProfileView` when the form leaves a field empty (:340-356). Every one of
those fields wins over the template in `effectiveProfileView` (`def?.x ?? template?.x`).

Failure scenario: an admin toggles one capability on the Developer in project A. From
that moment, project A's Developer is a frozen copy: a later org-level rename, stage
change, resource change, or (fixed) persona edit never reaches it. The org modal
nevertheless promises *"used in 4 projects — changes apply on next run"*
(`resources-panel.tsx:424-428`) and the toast says *"running threads re-anchor on next
turn"* (`gagents.server.ts:195`). There is no indicator on either surface that a
project has detached from the template.

Suggested fix: only persist the fields the project form actually *changed* (diff
against `effectiveProfileView`), so untouched fields keep inheriting; and surface
"overridden in this project" on the roster card + a truthful count in the org modal
footer.

### F13-A8 — MEDIUM — The org editor collapses a multi-backend profile to one backend

`app/server/org/gagents.server.ts:106,175,214`

`toView` reduces `backends[]` to a single value (`fm.backends[0] === "claude" ?
"claude" : "codex"`, :106) and every save writes `backends: [backend]` (:175, :214).
The seeded Developer ships `backends: ["codex","claude"]`.

Failure scenario: an admin opens Edit on Developer only to fix a typo in the name.
The backend picker shows "Codex" (backends[0]); saving writes `backends: ["codex"]`,
silently dropping Claude. `pickBackend` (`specialist-run.server.ts:120-124`) only uses
`[0]` so nothing breaks immediately, but the profile's declared multi-backend support
is gone from the canonical file with no warning and no way to restore it from the UI.

Suggested fix: preserve the untouched tail of `backends` on edit (move the picked
backend to the front rather than replacing the array), or make the picker
multi-select.

### F13-A9 — MEDIUM — The org card subtitle renders the entire persona body

`app/features/org-settings/resources-panel.tsx:932` · `app/server/org/gagents.server.ts:107`

The row subtitle is `{a.summary}` = the markdown body. For the shipped Developer /
Reviewer that is a ~2,500-character multi-section document rendered into a `.sub`
span.

Failure scenario: on a store bootstrapped by `seedDefaultAgentAssets` (i.e. *without*
`npm run seed` — see F13-A3), Settings → Resources renders two rows whose subtitles
are entire persona documents, blowing out the panel layout and burying the
"Codex · Ready · In Progress · 2 context resources · used in N projects" meta line.
The UI test never sees this because `GAGENTS` uses a one-line fixture summary
(`org-settings-page.test.tsx:288-294`).

Suggested fix: subtitle should be `fm.desc || firstParagraph(body)`, clamped.

### F13-A10 — LOW — `used in N projects` counts archived projects, and trusts a projection

`app/server/org/gagents.server.ts:70-95,259-266` · `db/migrations/0001_baseline.sql:52`

`usedByProject` selects every row of `projects` with no `archived` filter, and
`deleteGlobalAgentProfile` refuses while `used > 0` with *"Detach X from its N
projects first"*. An archived project is read-only for everyone
(`app/server/auth/project-authority.server.ts:73-80`), so the deployment cannot be
detached without restoring the project first — the error is unactionable as written.
Conversely, the count reads the SQLite **projection**, not `project.md`: if a rescan
failed or a project file exists un-projected, `used` reads 0 and the template is
deleted out from under a live deployment.

Suggested fix: exclude/annotate archived projects in the count and say so in the
message; consider reading `project.md` for the delete gate.

### F13-A11 — LOW — `agentProfileFilePath` has no traversal guard, unlike skills/KB

`app/server/files/file-store-root.server.ts:81-86` vs `resolveStoreSegment` (:87+)

`profileId` is `path.join`'d straight into the store path. `deleteGlobalAgentProfile`
and `saveGlobalAgentProfile` take it from a form field
(`app/routes/org.settings.tsx:301,315`). Exploitation requires org-admin + CSRF + a
target file that parses as a `kind: specialist` agent profile, so impact is low — but
skills/KB names got an explicit containment guard (F10-18) and this sibling path did
not. Suggested fix: route `profileId` through `resolveStoreSegment`.

### F13-A12 — LOW — Org create doesn't check project-local profile ids

`app/server/org/gagents.server.ts:199-203`

Create only refuses when a template **file** exists; it doesn't look at deployments.
A project-created profile with id `security-reviewer` (which has no template) can be
shadowed later by a global `security-reviewer` template. Impact is small today
because a project-created deployment carries a full `definition` that overrides
almost every template field — but `spanAll` (and any future template-only field)
would start leaking in. Mirror the check the project side already does
(`agent-profile-actions.server.ts:234-241`).

---

## (d) Test-coverage reality

| area | covered? | file |
|---|---|---|
| org profile list / create / delete / operator-undeletable | yes | `app/server/org/gagents.server.test.ts` |
| org edit preserves capabilities/extras/`desc` | yes — **and asserts the body clobber as intended** (`expect(parsed!.description).toBe("New summary.")`) with a *short* fixture body | same file |
| org edit against a **long persona body** | **no** | — |
| `backends[]` collapse on org edit | asserted as correct (`toEqual(["claude"])`) | same file |
| org agent modal UI (stage chips, ctx chips, used-count) | yes | `app/features/org-settings/org-settings-page.test.tsx:356-368`; fixture summary is one line (:288-294), so the body-in-subtitle problem is invisible |
| org route intents `agent-save`/`agent-delete` | **no** — the route test only reads `view.gagents` (`org-settings-route.server.test.ts:100-105`) |
| project profile create/update/delete + `desc` keep-on-empty | yes | `app/features/agents/agents-route.server.test.ts:515-519,597` |
| project `persona` field round-trip / precedence over template body | **no** — `persona` appears in no agents test (`grep -rn persona app/features/agents/*.test.*` → 0) |
| `effectiveProfileView` desc/definition fallback chain | **none — `agents-query.server.test.ts` covers only `capabilitiesToActionLabels`; `effectiveProfileView` has no direct test** | `agents-query.server.test.ts:13` |
| persona assembly from the profile body + skills | yes | `app/server/seed/base-agents.server.test.ts:122-155` (asserts "You are the Developer" via `seedDefaultAgentAssets`) |
| `runSeed` template **content** (vs existence) | **no** — only `existsSync` | `app/server/seed/seed.server.test.ts:57-59` |
| seed↔boot-asset agreement on the persona body | **no** | — |
| a global template becoming deployable | **no test, because no code** | — |
| stage eligibility mechanics | yes | `specialist-run.server.test.ts:307,529`; `task-detail-route.server.test.ts:601` |
| lightweight template × default agent roster eligibility | **no** | — |
| capability catalog ↔ editor projection consistency | yes | `app/features/agents/capability-catalog.test.ts` |
| empty-grant runtime semantics (`[]` = full power) | partially, via tool-policy tests | `app/server/tasks/specialist-tool-policy*` / `specialist-run.server.test.ts` |
| operator selection trace / `eligibleForStage` in candidates | yes | `app/server/tasks/operator-actions.server.test.ts:320-332` |

---

## (e) Corrections to the pass-12 doc

1. §1 says the org editor "writes it into BOTH frontmatter `desc` and the markdown
   body". True on **create** (`gagents.server.ts:212,223`); on **edit** it writes
   ONLY the body and leaves `desc` stale (`:170-179`).
2. The agent-profile schema lives at
   `app/server/files/agent-profile-file.server.ts:26-69`, not under `app/schemas/`.
3. §1's line refs for `gagents.server.ts` drifted: the operator is skipped at
   `:129`, delete-refuses-operator at `:254-258` (doc said :129-130 / :253-257).
4. Template `capabilities:` are stated as part of the "base profile"
   (agent-profile-file.server.ts:18-21 says the same) but **no runtime or view code
   reads them** — `effectiveProfileView` takes grants exclusively from the
   deployment (`agents-query.server.ts:186-195`).
