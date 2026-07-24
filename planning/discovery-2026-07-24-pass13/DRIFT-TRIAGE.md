# DRIFT triage — dispositions for every item in INTENT-VS-IMPLEMENTATION.md

Every DRIFT (D-1…D-48) and UNCLEAR (U-1…U-3) item from the intent audit, dispositioned.
Nothing is deferred. Four items were owner-ruled on 2026-07-25; the rest I decided, with
the reasoning recorded so a later pass can see what the call was and why.

Legend — **CODE** fix the implementation · **DOC** fix the source document ·
**BOTH** · **RULED** owner decided this pass.

## Owner rulings (2026-07-25)

| id | question | ruling |
| --- | --- | --- |
| D-1 | transitions uncreatable | **Auto-wire on stage add/remove**, and draw the Policy flow map from the real `workflow` rules. No transitions editor. |
| D-5 + D-27 | task-level repo override | **Delete the feature.** Toggle, audit action, copy and the FR7/FR30 clause all go. One project = one repo. |
| D-26 | the `evidence:` block | **Wire it.** Completion reports emit real evidence rows; the reviewer gets a channel. |
| U-2 | guardrails have no surface | **Leave them invisible.** Always-on-and-enforced is the intended MVP shape; only the orphan CSS comment goes. |

## Dispositions

### HIGH

| id | disposition | what ships |
| --- | --- | --- |
| D-1 | RULED · BOTH | `addStage` splices the new stage into the transition chain (prev→new, new→next) and `removeStage` re-joins its neighbours, both inheriting the boundary of the edge they replace. Policy's flow map renders `frontmatter.workflow`, not stage order. Settings' "set it in Policy" pointer corrected. FR6 stays as written — it is now true. |
| D-2 | CODE | `transcriptExists` probes before `resumeRun` passes a stored session id; a dead id becomes a first-class `session_missing` failure class on both backends; the turn retries once as a fresh canonical-anchored run; `latestSessionRun` skips runs whose session is known-missing so the task is never permanently stranded. The Phase-3 Continuity Recovery *panel* stays out of V1 per the UX spec's own sequencing, but the failure is now named in the UI instead of surfacing as a bogus auth error. |
| D-3 | CODE | `specialistReplyDirective` carries a compact canonical block — goal, stage, readiness, open packet, recent events — so a resumed specialist re-anchors on `task.md` exactly as the product claims in three places. |

### MED

| id | disposition | what ships |
| --- | --- | --- |
| D-4 | CODE | One shared `assertPrNotClosed` guard used by all three writers to Done (`acceptCompletion`, `resolvePacket`'s inline accept, `operatorAcceptCompletion`'s autonomy branch); `pr` added to `operatorSnapshot` so the operator is no longer structurally blind to PR state. |
| D-5 | RULED · BOTH | Delete `setRepoOverride`, the `taskRepoOverride` field, the toggle, the `project.repo_override.changed` audit action and the three copy claims. FR7/FR30 amended. **Revised mid-pass:** the `task.repo` read path goes too. Leaving eight reads of a field nothing can write preserves exactly the half-built state this finding was filed against, and the audit's count was low — beyond the four `repoOverride` call sites there were frontmatter reads in `push-workspace`, `workspace-delivery`, `specialist-run`, `task-actions` and `rebuilder`. `repo` is out of the schema and `TASK_FRONTMATTER_KEYS`, so a hand-written `repo:` line survives as a preserved unknown key rather than being silently honoured or silently dropped. |
| D-6 | CODE | `ValidationPill` on the board card and the list row whenever `validation !== "none"` — the board stops filtering on a signal it refuses to draw. |
| D-7 | CODE | `task.acceptance.forced` and `project.org_admin.override` added to `AUDIT_ACTION_KINDS` with labels. |
| D-8 | CODE | `recordAudit` in the deny branch of `resolveProjectAuthority` and at the `assertProjectAction` throw, carrying attempted action + role. Closes NFR10's fourth category. |
| D-9 | CODE | The review loader passes the project's operator autonomy + acceptance grant; the chip and footer qualify the "always a human action" claim the way Policy already does. |
| D-10 | CODE | `data.ok ? "success" : "error"` in both shared toast helpers and the four hand-rolled handlers; inline error text on the settings / policy / GitHub forms that have no inline surface at all. |
| D-11 | CODE | The task loader ships the newest N run-log lines per agent group; `/resources/run-log?since=` pages backwards for the rest. Paginated, not truncated — UI-53's whole-history console is preserved. |
| D-12 | BOTH | `--faint` and `--placeholder` darkened to ≥4.5:1 on white; an `@axe-core/playwright` sweep over login/board/task/review/policy in both themes runs in the existing e2e job, so the AA claim on the profile page becomes a checked one. |
| D-13 | DOC | `deployment.md` states the TLS-terminating-proxy requirement and the `__Secure-` cookie consequence of skipping it. No TLS in the Node process. |
| D-14 | DOC | The 2026-07-04 amendments (FR4, FR14, FR37, FR38) folded into `planning-artifacts/prd.md`, which `planning/README.md` declares canon. FR37's acceptance-authority clause marked not-implemented. |
| D-15 | DOC | `architecture.md`'s `app/` tree regenerated from the filesystem; packets/operator/KB/skills/MCP added to the FR map; the self-certification made true. |
| D-16 | CODE | Consolidation, not a new feature: `app/server/provenance/{provenance-recorder,provenance-query}.server.ts` absorbs the two duplicated writers and the three ad-hoc readers — including the raw `.prepare(` inside `project.task.tsx`'s loader, the only one in `app/routes/`. `architecture.md`'s user-facing "provenance views" claim drops; the four write-only action kinds stay (they are cheap and the query module now reads them). |
| D-17 | DOC | The binding ORCHESTRATOR RULINGS recovered from `git show c1acf2c^:docs/build/CONVENTIONS.md` into `docs/architecture/decisions.md`; all 26 comments re-pointed. In an AI-maintained repo a ruling nobody can read is a ruling that gets reversed. |
| D-18 | CODE | 11 undefined custom properties mapped to real tokens — the Scheduled re-runs panel gets its border and background back. |
| D-19 | CODE | `btn btn-primary` → `btn primary` on both CTAs; `.muted` and `.hint` utility rules added. |
| D-20 | DOC | The three retention windows documented; `provenance` named as the one unbounded table; the "prune audit by hand" instruction dropped. |
| D-21 | DOC | "You do not need a DB backup" deleted. `state/projection.sqlite` named as primary storage for users, sessions, PATs, audit and notifications. |
| D-22 | CODE | `isOAuthWhitelisted` becomes provider-aware: domain admission is Google-only, matching both the README and the in-app "any Google account with this domain" label; the GitHub role branch is fixed so a domain-mapped role is honoured rather than falling through to `member`. Chosen over widening the copy because the label being narrower than the gate is the failure mode that hurts. |
| D-23 | DOC | `file-formats.md`'s `kb:` example uses folder slugs and says so. `skills:`/`mcps:` were already correct. |

### LOW

| id | disposition | what ships |
| --- | --- | --- |
| D-24 | DOC | Strike "and authorized agents" from FR11. No runtime symptom exists (the operator routes the need through `open_decision_packet`), and the PRD already scopes task-graph orchestration post-MVP. Adding a `create-task` capability would be new product surface nobody asked for. |
| D-25 | DOC | Five edits to `file-formats.md`: `engagements` not `specialist:`/`consultants:`, 10 contract types, 8 packet option kinds, the missing frontmatter fields, `kind: agent`. |
| D-26 | RULED · CODE | The completion pipeline emits per-suite evidence rows; `composePrBody`'s param gets its caller; the reviewer's "Attach evidence references" becomes true. |
| D-27 | RULED | Moot — folded into D-5's deletion. |
| D-28 | CODE | `.checks` stops being fetched and discarded: a CI pill next to the PR pill. Review state (`approved` / `changes_requested`) is read in the same reconcile pass and surfaced, which is what "review-state awareness" meant. |
| D-29 | DOC | Desktop-first is the declared context in two documents; amend `prd.md:161` and the UX spec's Responsive section to say narrow screens get the same surface reflowed. Review-first mode is not being built on spec inertia alone. |
| D-30 | CODE | An `AsyncLocalStorage` request id bound in `entry.server.tsx` and a `logger.child` on run paths. The affordance existed and was deleted unused; this time it has call sites. |
| D-31 | DOC | Strike lint from `architecture.md:400,582,977` and drop `eslint.config.js`, `prettier.config.cjs`, `tailwind.config.ts`, `postcss.config.mjs` from the prescribed structure. No linter has ever existed here; adding one now would produce a large mechanical diff across 400+ files in a pass whose brief says not to bloat the software. The anti-drift rules stay enforced by typecheck, tests and review. |
| D-32 | BOTH | The two 1-hour staleness constants hoisted into `app/server/interpretation/freshness-policy.server.ts` — including the one living inside a UI component, which `architecture.md:542-543` forbids. `pat-diagnostics-policy` dropped from the doc (the build followed the doc's own cross-cutting map). |
| D-33 | CODE | A single-flight guard on rescan/rebuild and a cooldown on PAT revalidation. Both are cheap; the doc's allowance for minimal MVP limiting does not make repeat GitHub calls free. |
| D-34 | CODE | Three-way board empty state (no tasks / no filter match / no search match) with a clear-filter affordance, and a header count that agrees with the columns. |
| D-35 | CODE | `location.search` carried into `boardPath` and the rail's board item. |
| D-36 | CODE | The top-level pending bar F13-04 already prescribed, driven by `useNavigation().state`. |
| D-37 | CODE | `aria-current="page"` on the rail's active item. |
| D-38 | CODE | The `<Icon>` moved out of the `<h2>` in the one panel head that nests it. |
| D-39 | CODE | `useModifierHint` generalized to return the modifier alone and applied to the composer — the last user-visible `⌘` literal in `app/`. |
| D-40 | DOC | README's feature list regenerated; `project-admin` / `org-admin` / `auth` never existed. |
| D-41 | DOC | The data-root inventory corrected in all three docs (`agents/` restored, `auth/`/`cache/`/`logs/` dropped, `kb/`/`skills/` added). |
| D-42 | DOC | One sentence: there is no degraded engine (R7-2 removed it). |
| D-43 | BOTH | `closeDb()` + a WAL checkpoint wired into the existing signal handler, and the misleading "or" dropped from the backup instruction. |
| D-44 | DOC | The runbook lists all six credential paths and the `codexCliAuthUsable` auth.json condition — the docker trap the code itself names. |
| D-45 | DOC | CONTRIBUTING's "Demo data" step renamed and pointed at `npm run seed:demo`. |
| D-46 | DOC | `e2e` added to README's "All npm scripts" table and to CONTRIBUTING's CI description — it is the gate that caught the pass-13 install regression. |
| D-47 | DOC | Drop "and `scripts/`" from `docs/testing.md`. The config side is deliberate. |
| D-48 | DOC | `.env.example`'s `VIBERR_CLAUDE_MAX_TURNS` note corrected — it *is* schema-validated. |

### Unclear

| id | disposition | what ships |
| --- | --- | --- |
| U-1 | CODE | Settled by building rather than ruling: the credential values the app itself injects into agent child envs are redacted from run-log lines and structured log records at the sink. Source-side isolation plus membership scoping stays the primary mitigation; this closes the one concrete path (a Claude tool call printing its environment into a member-visible console and a downloadable session export). |
| U-2 | RULED | Leave invisible; delete the orphan `/* guardrails */` CSS comment. |
| U-3 | — | Pointer to D-26; resolved by the owner ruling to wire it. |

### Section 3 (DELIBERATE) doc edits

`PRD-3` (auto-preset Done exception — including the now-false `capabilities.ts` comment
and label, and the Policy "always reserved for humans" list), `ARCH-1` (projection.sqlite
is primary storage), `ARCH-10` (email+password is the shipped default), `ARCH-6` (task
workspaces exist at `<taskDir>/workspace/`), `PRD-12` (scheduled re-runs need an FR),
`PRD-11` (the 90-day audit window), `UX-12` (typography/palette superseded by
`design/design-system.html`), `DOC-1` (the reconcile poller runs every 5 minutes).

Plus one un-ruled item ARCH-6 surfaced: **task workspaces are never garbage-collected** —
no `rmSync` path removes `<taskDir>/workspace/<repo>`, so every task that ever ran an agent
holds an 11-16 MB clone forever. Measured on the pass-13 test instance: **101 MB across
seven tasks** in one project.

Disposition: **CODE** — shipped as `app/server/tasks/workspace-retention.server.ts`, a boot
sweep that reclaims the workspace of any task in its project's terminal stage. Deliberately
NOT folded into `db/retention.server.ts`, whose own docstring promises it "only compacts the
rebuildable SQLite projection/log tables" — deleting directories from there would make that
false. It runs after run recovery so nothing in flight is touched, keys off the project's
last stage rather than a literal `done` id (the stage editor can rename it, and D-1 now
splices stages in ahead of it), and is idempotent because it runs on every boot. The clone
is a cache — canonical state is `task.md`, delivered work is on the remote — so a reopened
task simply re-clones. Documented in `docs/operations/runbook.md` and
`docs/architecture/file-formats.md`.
