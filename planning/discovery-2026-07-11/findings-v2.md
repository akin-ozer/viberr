# Findings v2 — fresh discovery pass (2026-07-11, session 2)

Consolidated from 7 parallel code audits (task lifecycle, operator runtime, specialist runtime +
adapters, GitHub integration, RBAC surface, UI layer, store/projection) + a live UI walkthrough.
Deduped; every item carries file:line evidence. Severity: **H**igh (breaks a shipped feature or a
product invariant), **M**edium (wrong behavior, visible), **L**ow (paper cut / hygiene).
Status column filled during Phase 3 implementation.

Cross-checked against the 2026-07-10 pass: none of these duplicate the 37 resolved findings;
several are *holes in* those fixes (marked ⟲regression-of).

## A. Runtime state machine (the big ones)

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| A1 | H | **@mention agent runs clobber the verdict+reconcile hook.** `commentToAgent` registers its own completion callback (posts reply only) AFTER `startReviewerRun`/`startSpecialistRun` registered `registerReplyAndReconcile`; `registerRunCompletion` is last-writer-wins → @mention reviewer runs never record a verdict (validation flip, quality event, notification) and @mention specialist runs never run `reconcileWorkspaceDelivery` (branch/PR capture). ⟲regression-of H2/#31. CONFIRMED by direct read. | task-actions.server.ts:840-848 (registration), run-service.server.ts:88-97 (last-writer-wins), specialist-run.server.ts:807/1228-1240 | make `commentToAgent` NOT register its own callback; instead let the default `registerReplyAndReconcile` handle reply+verdict+reconcile on every path (it already posts the reply). The resumed-session branch needs the default hook attached explicitly. | |
| A2 | H | **Operator-prompted / @mention runs never set `waiting="agent"`** → board shows "waiting on human" while an agent works; review queue mis-files; AND `recoverUnreactedAgentRuns` filters `waiting='agent'` so these runs are excluded from boot recovery (NFR17 blind spot). | operatorPromptAgent task-actions.server.ts:1287-1323; recovery filter run-recovery.server.ts:39; deployment mapping agent-deployments:47-49 | set waiting=agent (+readiness untouched) when any real/simulated agent run starts (single helper on startSpecialistRun/startReviewerRun/resume paths); flip back to human/none on completion in registerReplyAndReconcile. Recovery filter can then stay. | |
| A3 | H | **`validation="failing"` is permanent** — re-entering review only sets `changed` from `none`; approve deliberately never clears failing; nothing resets on rework → operator refuses acceptance forever. **LIVE (VST-3): defect→request_changes→failing; defect reverted→reviewer re-APPROVED (quality event recorded)→validation STILL failing→the operator opened a packet admitting it "cannot resolve which signal is authoritative" and refused to propose the transition — the inconsistent state machine paralyzed the coordinator.** | task-actions.server.ts:1866-1870, 1238-1243, 1235-1237; live VST-3 11:17–11:21 | define reset semantics: an approve verdict that POSTDATES the last request_changes clears failing→healthy (verdict ordering, not verdict masking); impl→review entry resets any stale value to `changed`. Keep same-CYCLE multi-reviewer rejection-sticks (H3) by comparing verdict timestamps within the cycle. | |
| A4 | H | **D4 retry-on-other-backend passes the native backend's model id** → cross-backend retry errors immediately (e.g. `opus` sent to Codex `startThread`). Effort ids cross over unnormalized too. The flagship retry affordance is broken exactly when used. | specialist-run.server.ts:491-513 (backend=override but model from native `toResolved`), :688-709 (reviewer same) | when `backendOverride` differs from profile backend, re-resolve model+effort for the override backend (`defaultModelFor(override)` + effort map or nearest-tier translation). | |
| A5 | H | **Any trigger coalescing into an inflight operator run is DROPPED, including human @operator mentions** (live: VST-4 mention at 11:13:45 during run 11:13:22–53 → swallowed, never answered). Same for react re-invokes → task strands (compounded by A2 recovery blind spot). | operator-run.server.ts:126-143; live VST-4 evidence | on coalesce, queue the trigger: register a completion callback on the inflight run that re-invokes runOperator once, carrying the newest trigger. | |
| A6 | M | **Scripted + Codex operator modes escape the single-flight lease** — scripted coordinates BEFORE inserting the lease row; codex coordinates AFTER its run row is finished → concurrent triggers double-drive (double assignment/prompts/transitions) in the default no-credential mode. | operator-run.server.ts:518-664 (scripted), :285-292 (codex) | insert the lease row (queued) FIRST in both modes, before any coordination; release on completion. | |
| A7 | M | **Full-autonomy acceptance ignores the capability contract** (needs owner ruling → Q1): `accept_completion` tool offered under full autonomy even at mode `off`/`human` (posts recommendations); mode `recommend` under full autonomy auto-accepts to Done though invariant #2 says the Done exception requires `direct`. Shipped default (`recommend`) + `auto` preset = silent agent-close. | operator-toolkit.server.ts:321-324; operator-actions.server.ts:176-182 (gate promote), :1139-1204; operator.md:39-40; project-create.server.ts:73 | per owner ruling: hold `completion-for-acceptance` OUT of the full-autonomy promote (require explicit `direct`), and never offer the tool at `off`/`human`. | |
| A8 | M | **Codex runs: no maxTurns, no timeout** → a run that never emits `turn.completed` stays `running` forever; no completion callback → waiting=agent forever, invisible to recovery (which only handles finished runs). | codex-runtime.server.ts (no cap; success only on turn.completed) | add a wall-clock timeout (configurable, e.g. 15m) that interrupts the thread and finishes the run as `error`, letting the react loop/stuck-packet fire. | |
| A9 | M | **Multi-reviewer same-backend simulated collision trips no-progress guard** → spurious BLOCKED "work stalled" packet when 2 reviewers post identical canned reports. | task-actions.server.ts:1059-1066 (match by backend+role only); specialist-run.server.ts:980-1010 (deterministic text) | include profileId/runId in the no-progress identity; vary simulated text per profile. | |
| A10 | M | **Codex operator silent stall on empty/malformed plan** — returns with no comment/packet/log; per-action errors swallowed so a failed transition still lets a later accept run. | operator-run.server.ts:322-333, :435-441 | on unparseable/empty plan → post an operator comment + open BLOCKED packet (reuse stuck-loop packet); abort plan on first governed-action failure. | |
| A11 | L/M | **Boot recovery reacts with the COORDINATE trigger** (`transition`) instead of REACT (`agent-reply`) → after restart the operator re-prompts (redundant run) instead of reading the recovered reply. Also drops verdict+reconcile for recovered reviewer runs (same class as A1). | run-recovery.server.ts:67-84; task-actions.server.ts:484-491 | recovery path: call recordReviewerVerdict + reconcileWorkspaceDelivery before re-invoke; re-invoke with trigger "agent-reply". | |
| A12 | L | **Simulated-run resume derives claude backend for natively-simulated rows** (dead if-branch) — seeded sim run resumed via comment becomes a "claude" run. | run-service.server.ts:299-302 | derive `simulated` from prev row properly; keep backend=prev.backend when prev was seeded-simulated. | |
| A13 | L | `projectOne` interrupt view falls back to `runs[0]` when the interrupted run isn't the group representative → toast shows wrong run. | run-service.server.ts:491-493 | match on thread_id OR id across group members. | |

## B. GitHub delivery & traceability

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| B1 | H | **`reconcileWorkspaceDelivery` clobbers human-set `accepted` → `review`** (⟲regression-of H1): mapGhStateToCache has no accepted case; staleness test overwrites; Complete-merge button vanishes + misleading "PR opened" timeline event. Window: any real agent run completes on an accepted-merge-pending task. | workspace-delivery.server.ts:147-152, :367-377 | port the H1 guard: preserve `accepted` while live PR is open; only merged/closed override. | |
| B2 | H | **Server `reconcileTask` wipes the workspace-captured commit cache** when agent commits lack the `[KEY]` prefix (taskCommits returns `[]`, wholesale github replace). | github-reconciler.server.ts:219-234; branch-sync.server.ts:124-130; workspace-delivery.server.ts:277-301 | when branchCommits filters to empty but existing cache is non-empty for the same branch head, keep existing; or union prefix-matched + workspace-captured. | |
| B3 | M | **`openTaskPr` writes off-contract `pr.state="open"`** and unconditionally overwrites `fm.pr` on the REUSE path → second H1-class clobber of `accepted`; needless "heal to review" churn. | pr-open.server.ts:221, :139 | write "review" (the canonical vocab) and preserve `accepted` unless PR state is terminal. Tighten prRefSchema to the 4-value enum (B8). | |
| B4 | M | **Agents are never told the branch/commit conventions** — analyze prompt lacks branch name + `[KEY]` commit-prefix instructions → traceability (NFR15) holds only by luck; feeds B2 and double-PR risk (B5). | specialist-run.server.ts:932-956 | inject delivery contract into the specialist prompt: work on `fm.branch ?? taskBranchName()`, prefix commits `[KEY]`, open PR against default branch, report branch+PR in reply. | |
| B5 | M | **Double-PR risk**: server opens a PR on the deterministic branch at review entry without checking `fm.pr` captured from agent-side delivery (different branch name / fork head not matched by the head= dedup). | pr-open.server.ts:126-141 | skip openTaskPr when `fm.pr` already exists and is open; reconcile instead. | |
| B6 | M | **Review-stage detection = "first workflow edge into last stage"** — multiple predecessors of Done or custom flows silently misidentify review; PR-open + validation=changed both target the wrong stage. Related: rail/review queue hardcode literal `"review"` id so Lightweight (todo/doing/done) projects always show reviewCount 0. | task-actions.server.ts:172-176, 1919; project.tsx:46 | single canonical stage-role resolver (entry/work/review/terminal) used by ALL consumers (see D-block: stage roles). | |
| B7 | L | Operator full-autonomy acceptance doesn't set `validation="healthy"` (human path does) → Done tasks with stale changed/none health. | operator-actions.server.ts:1173-1179 vs task-actions.server.ts:2346 | set healthy on operator accept too. | |
| B8 | L | `pr.state` schema is free string with stale pre-D3 comment; `github-pills.prStatePill` lacks an `accepted` case (renders "in review" in PR list while branch table says merge-pending). | task-file.schema.ts:118-125; github-pills.ts:21-40 | enum-tighten schema; add accepted pill; keep server+client pill logic in one shared module. | |
| B9 | L | External close of an `accepted` PR downgrades to `closed` and the Complete-merge affordance vanishes with no path back. | github-reconciler.server.ts:206-209 | acceptable; but surface a task timeline `policy` event "accepted PR was closed externally" so the human sees why. | |
| B10 | L | Misleading copy: github-view "the developer specialist opens one at the review boundary" (server opens it), "accepting … merges its PR" (may only record accepted), PR body says merge follows acceptance; scope-resolution audit text hardcodes pull_request:write. | github-view.tsx:157-192; pr-open.server.ts:51; scope-flag.server.ts:47-50 | copy fixes to match D3 reality. | |
| B11 | L | Hardcoded `https://github.com/...` links in task detail (client) though server supports baseUrl. | task-detail-page.tsx:87-92 | build from connection baseUrl. | |
| B12 | L | Operator-path `reconcileWorkspaceDelivery` omits `workdir` (relies on convention); shallow `--depth 1` clone can misreport ahead-commits. | task-actions.server.ts:1401-1409; specialist-run.server.ts:1146 | pass workdir through; fetch with adequate depth before origin/default..HEAD. | |

## C. Lifecycle & governance

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| C1 | H | **Packet accept_completion leaves recommendations standing** — a leftover `transition` rec on a Done task is APPLYABLE and moves the task back out of Done. Other done-paths strip recs. | task-actions.server.ts:2165-2172 vs 2354-2356, 1874-1876 | strip recommendations in the packet-accept mutate (share one done-mutation helper). | |
| C2 | M | **Stale `accept_completion` recommendation bypasses the failing guard** — applyRecommendation → acceptCompletion has no failing check (operator path refuses). | task-actions.server.ts:2477-2486, 2292-2371 | acceptCompletion (human path) warns/refuses on failing validation unless `force` — or applyRecommendation revalidates. Owner ruling folded into Q1 context. | |
| C3 | M | **Packet addressed to the owner; only admin/maintainer can resolve** — contributor owner gets bell + packet + 403 on click. Needs owner ruling → Q2. | task-actions.server.ts:2103-2108; operator-actions.server.ts:485-493; setOwner any-member :1542-1547 | per ruling: either owner-or-admin/maintainer may resolve non-completion packets (accept_completion stays admin/maint) or copy + notification stop naming the owner. | |
| C4 | M | **Drag/dropdown into Done silently runs the full acceptance contract** (merge attempt!) with toast "Moved". | task-actions.server.ts:1772-1784; board.tsx:95-97; task.tsx:278-283 | board drag into last stage → confirm dialog ("accepts completion, merges PR #N"); toast states what actually happened (merged vs accepted). | |
| C5 | M | **Compression-threshold guardrail's configured value (40) is ignored** — hardcoded 60/24; compaction only runs inside operator comment writes (human-comment floods never compact). | operator-actions.server.ts:275; timeline-compaction.server.ts:38-41; templates.ts:101 | pass guardrail value as threshold; also compact on human comment append past threshold. | |
| C6 | M | **3 of 5 anti-noise guardrails are decorative** (meaningful-comment, operator-brevity, evidence-separation ship ON, zero enforcement). PRD calls these product features. Owner ruling → Q3. | operator-actions.server.ts:256-268 (only 2 wired) | per ruling: implement (brevity=length gate on operator comments; meaningful-comment=reject trivial agent comments; evidence-separation=fold evidence into details blocks) or remove from templates+UI. | |
| C7 | M | Stage lifecycle hardcodes literal `triage`/`done` ids: Lightweight `todo` entry stage is removable/reorderable; addStage inserts before literal "done"; done-stage resolution differs across 4 call sites (`find(id==="done") ?? last` vs positional last). | settings-actions.server.ts:45-48, 216-217, 307-311; task-actions.server.ts:2138-2141, 2308-2311 vs 1765; operator-actions.server.ts:1116 | introduce canonical stage-role resolver (entry = first, terminal = last, review = predecessor-of-terminal via workflow, work = predecessor-of-review); replace ALL literal id checks (fixes B6/C7/F-rail). | |
| C8 | L | `notifyTaskWatchers.exceptUserId` promised but never passed — actors get notified about their own actions. | task-actions.server.ts:208-245; call sites | pass the acting user where a human actor exists. | |
| C9 | L | `dismissRecommendation` docstring says any-member; code enforces admin/maint. UI shows Dismiss to everyone (M1). | task-actions.server.ts:2516, 2529 | align: admin|maintainer (matches apply); hide button for others. | |
| C10 | L | Scripted operator stage classification is positional (`stageIds[len-2/3]`) → diverges on non-5-stage projects. | operator-run.server.ts:523-525 | use the C7 stage-role resolver. | |
| C11 | L | Operator decision-E "one entry per turn" unenforced for scripted (plan comment + prompt comment + transition) and codex (reasoning + per-action comments). | operator-run.server.ts:623-632, 337-353 | scripted: fold plan into the prompt comment; codex: single summary comment per plan. | |
| C12 | L | Home greeting pluralization ("across 1 projects"); login placeholder leaks seeded admin email. | home-page.tsx (greeting); login.tsx:429 | trivial copy fixes. | |

## D. Role bindings (owner's declared next phase — see role-bindings-map.md for the full map)

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| D1 | H | **21 of 32 capability ids are dead** (never consulted at runtime); 2 fully orphan; 6 not settable by any UI; `open-or-merge-pr` has a deny rule but is never granted. The capability matrix modal renders authority that doesn't exist (e.g. "Read the task & repository: not granted" while every agent reads everything). Owner ruling → Q4. | capabilities.ts:25-72; capability-catalog.ts; specialist-tool-policy.ts:30-45; full table in role-bindings-map.md | per ruling: prune catalog to consumed ids + honest matrix, wire the handful that matter (execute-code-or-write-repo → Edit/Write/Bash deny; edit-other-task-branch rule; owner-reassignment operator tool or drop). | |
| D2 | M | **PROJECT_CAP_MATRIX is display-only** — ~15 server enforcement points hardcode role lists, sync'd only by a test. | policy-data.ts:36-59; enforcement sites in map | single `actionRequires(action)` lookup consumed by server guards AND the policy page. | |
| D3 | M | **UI-vs-server gating mismatches**: Dismiss button (all users vs admin/maint), DecisionPacket resolve options (all viewers vs admin/maint), "Assign me" (non-members see it). M4: server allows contributor to apply auto-boundary transition recs while UI hides Apply (server more permissive). | operator-recommendations.tsx:90-98; decision-packet.tsx:126; task-detail-page.tsx:585-593 | gate UI by myRole; decide M4 with C3 (Q2). | |
| D4 | M | Reviewer profile ships an extra "Push commits to the branch: human" that is decorative (extras aren't grants; no deny rule fires) → matrix shows a lock that isn't real. | reviewer.md:37-39 | grant `commit-push-branch:human` for the reviewer instead of the extra. | |
| D5 | M | Guard duplication: requireProjectAdmin ×3 copies, requireRuntimeRole/hasRuntimeRole/requireMemberRole near-identical; run-operator role check inlined in route. | policy-actions.server.ts:58; settings-actions.server.ts:75; agent-profile-actions.server.ts:97; specialist-run.server.ts:1288; task-actions.server.ts:885 | consolidate in require-project.server.ts as part of D2. | |
| D6 | M | contributor ≡ viewer except createTask — 4 advertised tiers, 2 real. Owner ruling → Q5 (rework scope). | task-actions.server.ts:358-359 | per ruling (e.g. contributor: take ownership+trigger agents on owned tasks; viewer: read-only strict). | |
| D7 | L | Home `rescan` ungated (any signed-in) vs board rescan admin/maint. | _index.tsx:75-77 vs board.tsx:105-110 | unify: admin|maintainer (org-admin for home global rescan). | |
| D8 | L | Run-operator button audits `userId:null` → not attributable to the pressing human. | project.task.tsx:433 | pass ctx user into the audit actor. | |
| D9 | L | SSE `/resources/events` never checks project membership on project:/task: scopes (cross-project compact-fact leak: slug/key/stage/readiness). Security-adjacent but cheap. | resources.events.ts:44-70; sse-broker.server.ts:73-95 | membership check at subscribe time. | |
| D10 | M | **Home project list is NOT membership-filtered** — LIVE: selin (viewer on selftest only, non-member of Billing/Deploy/Viberr Core/Strictline) saw ALL 5 project cards with counts/progress/avatars, and a New-project button. Deliberate "app-wide visibility" is possible but undocumented; contradicts view-side project RBAC (requireProjectMember on inner config pages). Owner ruling → Q6. | live home as selin; home-query.server.ts | decide: all-projects-visible (document it, drop requireProjectMember inconsistency) OR filter home to member projects. | |
| D11 | — | RETRACTED — logout works correctly via the real Sign-out control (earlier "broken" observation was a mis-targeted synthetic click, not a real defect). |  |  | verified working |
| D12 | L | **OAuth buttons ("Continue with GitHub/Google") render fully enabled on the login page even though no OAuth provider is configured** in this env — prior pass finding #19 claimed unconfigured providers are "disabled with a note". Verify whether clicking them errors. | login.tsx; live login page | if env-gated buttons are meant to hide/disable when unconfigured, honor it; else confirm they work. | |

## E. Store / projection / notifications / resources

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| E1 | M | **User rename never reprojects** — baked actor_json keeps old name/initials in every historical event until a manual rebuild (hash short-circuit hides it). | rebuilder.server.ts:326-328, 429-459; org-users.server.ts:254-262 | on user name/tone change → resolve actor at READ time for user: actors, or enqueue full reprojection of affected tasks (read-time resolve is cleaner). | |
| E2 | M | **Home page never refreshes on task/project SSE events** (subscribes `[user]` only) — landing page stale until manual rescan. | _index.tsx:136-138; event-publisher.server.ts:66,128 | subscribe home to a global `projects` scope (or all-projects compact events). | |
| E3 | M | **Scope-violation policy notifications go ONLY to the task owner** (ownerless task → nobody) — every other governance fan-out uses notifyTaskWatchers. | scope-flag.server.ts:139-149 | use notifyTaskWatchers. | |
| E4 | M | **saveSkill blanks/truncates SKILL.md** — round-trips a 256KB-truncated body and writes `body ?? ""` unconditionally; >256KB skill gets truncated on save; empty body blanks the file. | resources.server.ts:932-934, 789-819 | guard: refuse save when body was truncated at read; treat empty body as "keep existing" unless explicit. | |
| E5 | M | `importGithubSnapshot` reports success on partial import (per-blob failures summed as 0). | store-files.server.ts:448-476 | count + surface skipped blobs like `truncated`. | |
| E6 | L | `touchResource` no-ops for `disk:` ids (freshness never advances for shipped resources). | store-files.server.ts:133-146 | adopt-on-touch (insert row) or skip with log. | |
| E7 | L | buildResourceCatalog KB list is disk-only while skills/MCP union rows → row-only KB grantable nowhere. | resource-catalog.server.ts:28-34 | union rows+disk uniformly. | |
| E8 | L | Health endpoint: watcher liveness = handle-exists (error handler never clears), backend "real" = env-presence (expired token still real). | file-watch.service.server.ts:82-97; runtime-registry.server.ts:83-91 | clear handle on chokidar error; document backend check (or add a cheap validity probe on demand). | |
| E9 | L | `task.readiness-changed` SSE event produced, never consumed (doubles traffic + unbounded map). | event-publisher.server.ts:84-103; sse-event.schema.ts:24 | delete event + bookkeeping (or consume it for toasts). | |
| E10 | L | Base agents (developer/reviewer) re-injected into EVERY project on each boot — deliberate removal undone. | ensure-base-agents.server.ts:40-56 | only ensure operator; or respect a tombstone ("removedAt") for specialists. | |
| E11 | L | `rebuildProjections` emits SSE inside the write transaction. | rebuild.server.ts:33-43 | emit post-commit. | |
| E12 | L | notifications.read emits no SSE → other tabs' badge stale. | notifications.read.tsx | publish user-scope event on read. | |
| E13 | L | Watcher: whole-tree chokidar watch then discard non-md; no addDir/unlinkDir handling (fast recursive rm can orphan rows until rescan). | file-watch.service.server.ts:69-81 | glob-scope the watch; handle unlinkDir with a targeted rescan. | |

## F. Adapters / backend parity

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| F1 | M | **Claude specialist persona REPLACES the claude_code preset system prompt** (loses harness scaffolding); Codex folds persona around its default → materially different base behavior per backend. | specialist-run.server.ts:584,763; claude-runtime.server.ts:42,201 | use `{type:'preset', preset:'claude_code', append: persona}` for specialists (operator too if applicable). | |
| F2 | M | **Codex ignores per-profile MCP servers** (gated backend==="claude") — same deployment gets MCP on Claude, nothing on Codex, silently. | specialist-run.server.ts:595,770 | Codex SDK lacks mcpServers → at minimum surface "MCP unavailable on codex" in run header/persona; ideally map to codex config when SDK supports. | |
| F3 | L | Verdict classifier: `none`/`nothing` not in negation list ("none of the tests fail" → request_changes); noun `failure(s)` unmatched ("suite has failures" → no verdict). | task-actions.server.ts:1183-1190, 1151-1202 | extend negator list + noun forms; regression tests. | |
| F4 | L | Operator persona claims "you have only mcp__viberr__* tools" but Read/Grep/WebFetch etc. remain available (only write builtins denied). | operator-run.server.ts:813; claude-runtime.server.ts:103-110 | fix persona copy (read tools allowed, write denied) — honesty. | |
| F5 | L | `simulatedFinalReport` classifies role by regex on label → odd role names get developer prose; run-recovery idempotency LIKE-prefix match sloppy. | specialist-run.server.ts:963-967; run-recovery.server.ts:40-44 | classify by kind (reviewer runs know they're reviewers); tighten LIKE with closing quote. | |

## G. UI copy & polish

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| G1 | M | **Banned word "governed/governance" in 9 rendered spots** (modal heading, template chip, hero, meta description, autonomy hint, profile notes, capability group header). Explicit owner copy rule. | home-page.tsx:362,471,656,704; _index.tsx:30; create-profile-modal.tsx:223; profile-page.tsx:402,512; capability-catalog.ts:106 | reword per rules (Maintainer/Permissions/managed). | |
| G2 | L | Dead board `transition` intent + misleading canTransition prop comment (stage dropdown never built; task page has the real one). | project.board.tsx:52-75; board-page.tsx:547 | remove dead handler + fix comment (or build the dropdown — not in mock; remove). | |
| G3 | L | Task Permissions panel is hardcoded static rows presented as live policy ("Agent may: Request transition"). | task-detail-page.tsx:184-228 | derive from actual operator capability modes (stage-transitions gate) or reword as fixed rules. | |
| G4 | L | HOME_ACCENTS duplicates 6 raw hex values that exist as CSS tokens. | home-query.server.ts:29-36 | reference var(--…) tokens. | |
| G5 | L | Stale block comment claims presets are cosmetic (S1 wired it). | project-create.server.ts:110-111 | delete comment. | |
| G6 | L | Stat tiles on Agents page: "operators running"/"specialists working" are attachment/task counts, not run counts. | agents-page (stat tiles) | recount from agent_runs running states, or reword ("active tasks"). | |
| G7 | L | Keyboard scrolling dead on task workspace (body overflow hidden; div.detail scroll container never focused). | app.css / task-detail layout | make div.detail focusable (tabIndex=-1 + focus on mount) or move scroll to body. | |
| G8 | L | GitHub page: Connection "no credential" pill contradicts the PAT card rendered beneath (seed state). | github-view.tsx | derive pill from the same source as the card. | |
| G9 | L | Done tasks still render Run operator / Assign specialist as active controls. | task-detail-page.tsx | disable runtime controls at terminal stage (visual "task closed" state). | |

## X. Live-test discoveries (phase 2, added as found)

| id | sev | finding | evidence | fix sketch | status |
|---|---|---|---|---|---|
| X1 | H | **Workspace isolation escape: specialist mutates the HOST checkout when the target repo contains the data root.** Agent cwd = taskDir (inside the product repo since VIBERR_DATA_ROOT=./data) → git ops resolve upward to the host .git; the agent created/pushed branch VST-1 and LEFT THE DEV CHECKOUT ON IT (server source switched under the running app). The empty `workspace/` dir was ignored. **BOTH backends: Claude (VST-1) and Codex (VST-4) each left the host repo on their task branch.** Non-deterministic: the VST-3 reviewer chose to clone fresh instead. | runs run_YvXBhpHch014 + run_9DkM5FvWMS-i; `git branch` showed `* VST-1` then `* VST-4` live | run specialists with cwd=taskDir/workspace; prompt contract "clone into ./ and work only there"; set GIT_CEILING_DIRECTORIES=taskDir to block upward discovery; refuse/flag when resolved git root ≠ workspace. | |
| X2 | M | **A4 live shape: bogus model id silently falls back** — retry run row records `model=gpt-5.5` but system-init shows `claude-sonnet-5` → dishonest run metadata (codex-direction would hard-fail instead). | agent_runs run_YvXBhpHch014 model column vs system·init line | fix A4 properly (re-resolve per backend) + record the RESOLVED model on the run row. | |
| X3 | M | **Seeded fictional MCP server (`github-mcp` → mcp.internal:7801) is injected into real Claude runs** (system-init lists it). Run succeeded (SDK tolerates dead MCP) but every real run carries a phantom server; seed metadata ("14 tools · checked 31m ago") is fiction. | system·init of run_YvXBhpHch014 | seed MCP rows as clearly-fake OR don't reference them from seeded profiles; surface MCP connect failures in run header. | |
| X4 | M | **Quota-dead backend produces NO human signal**: codex developer run errored (usage limit until Aug 10) → no notification, no packet, no operator reaction (react loop skips unclean runs); board still said "waiting on human"+input? Actually board showed nothing amiss — task sat in impl silently. Only opening Agent logs reveals the error + retry button. | run run_vIJrZd4iEfGa; notifications table (nothing new) | on run error: notify watchers (kind=quality or new kind=runtime) + operator react path for error runs (post packet w/ retry-on-other-backend option — D4 exists as packet option kind hold_runtime_debug). | |
| X5 | L | Commit convention mismatch: agent used `VST-1: …` prefix (colon form); server `taskCommits` expects bracketed `[VST-1]` → commit cache will drop it (B2/B4 live confirmation pending reconcile test). | commit 7103fe8 vs branch-sync.server.ts:124-130 | B4 fix: put the exact convention in the prompt; make matcher accept both forms. | |

| X6 | H | **UI-started and D4-retry specialist runs never re-invoke the operator** — the react loop only exists on operatorPromptAgent's callback; the default registerReplyAndReconcile hook posts the reply and stops. Live: developer finished VST-1 (PR #4 opened), task sat in impl, waiting=human, no transition proposal, no operator run. The agent's "@operator done" inside its own reply is not mention-routed either. | agent_runs (no operator run after 10:23); task.md unchanged stage | after ANY primary/reviewer completion (not just operator-prompted), trigger the same operatorShouldReactToReply path; and/or route @mentions in agent-authored reply comments. | |
| X7 | H | **X1 cascade: delivery capture found nothing** — reconcileWorkspaceDelivery looks in the empty workspace/, so branch/pr/github stayed null while PR #4 exists on GitHub. End-to-end traceability broken on the host-repo case. | task.md frontmatter post-run | fixed by X1 (agent works in workspace) + B5 (check fm.pr before server-open). | |

| X9 | H | **Reviewer verdict classification runs on the 1200-char TRUNCATED reply** (`replyTextForRun` → `truncate(MAX_REPLY_CHARS=1200)`); real reviewers write long reports → verdict token lands past the cut → verdict silently lost (validation unchanged, no quality event). Live: run_rYt1IAUNdcWd found a real defect, wrote request-changes reasoning at char ~2300, validation stayed `none`. | agent-reply.server.ts:274,305-306; specialist-run.server.ts:1229-1235; task-actions.server.ts:1372 | classify on the FULL raw reply text (pull from run lines untruncated); truncation stays for the comment display only. Also instruct reviewers (persona) to LEAD with a one-line verdict. | |
| X10 | M | Agent reply comments hard-truncate mid-sentence at 1200 chars with a bare "…" — no "full report in agent logs" link/affordance; reviewers' recommended fixes get cut off. | agent-reply.server.ts:304-306 (live: VST-3 reply cut mid-list) | raise cap; append a link line "(full report → Agent logs)"; fold long bodies into details per Q3 evidence-separation. | |
| X11 | M | Reviewer re-anchor works (good!) but means comment-supplied acceptance criteria are IGNORED by design — @reviewer with added criteria gets overridden by the canonical goal. Product needs a sanctioned way to amend acceptance criteria (no UI edits the Goal section at all). | VST-3 mention run approved against comment criterion, citing canonical goal | add "edit goal/acceptance criteria" (admin|maintainer) to the task UI, appending a `packet`/`policy` note; agents already re-read task.md. | |

| X12 | M | **Create-project with an EMPTY repo field fabricates `repo: <owner>/<slug>`** (nonexistent repo; Strictline got akin-ozer/strictline) instead of `repo: null`. Every GitHub surface then renders a dead repo as configured. | data/projects/strictline/project.md; project-create.server.ts (repo synthesis) | empty repo input → repo:null (repo-less project is a supported state). | |
| X13 | M | **Completion timeline copy asserts "the review PR was merged" unconditionally** — written into the canonical file even when no PR exists (VST-4: pr:null, PR #6 open→closed on GitHub). Same family as B10 but canonicalized. | VST-4 completion event 11:29:28 | acceptCompletion writes copy matching reality: merged / accepted-merge-pending / no PR recorded. | |

| X14 | M | **M2/M3 confirmed live as a VIEWER (selin):** the full packet with all 3 resolve options + "Ask operator" + "Assign me" rendered; clicking "Owner narrows the goal" was server-rejected (state unchanged) but produced no visible error/toast — silent no-op. The @operator mention posted as a comment (app-wide, correct) and triggered NO run (valve held — good). | live VST-2 as viewer; task.md unchanged | gate resolve/assign/packet controls behind myRole in UI; when a denied action is attempted, surface the rejection. | |
| X15 | L | **Project invites create a `status: invited` member who already has full view access** without accepting anything (selin browsed VST-2 immediately). The invited status is decorative — there's no accept-invite flow, and viewer access is immediate. | project.md members (status: invited); live browse | either honor `status:invited` (block access until accepted) or drop the field — currently misleading. | |

## Role-bindings items landed vs. deferred to the dedicated role-bindings phase
LANDED this pass (P3.8): D1/Q4 wiring (execute-code-or-write-repo → deny Edit/Write/
NotebookEdit/git-commit; edit-other-task-branch → deny checkout/switch/reset; reviewer
commit-push made a REAL grant D4; commit-push also denies git commit); removed the 2 fully-orphan
ids (validation-verdict, hold-on-failing-checks) + added `capabilityIsEnforced`/`ENFORCED_CAPABILITY_IDS`
so the matrix can distinguish enforced vs advisory; D10/Q6 home membership filter (org-admin sees all);
D7 rescan → org-admin; D3 UI gating M1 (Dismiss), M2 (packet resolve behind canResolve), M3 (Assign-me
members-only); C9 dismiss docstring.
Also landed after this list was written (hardening waves — see implementation-ledger.md): SSE
`projects`-scope expansion for non-org-admins (partial D9) and packet owner-resolve requiring
CURRENT membership (#8).

DEFERRED to the owner's dedicated role-bindings phase — **phase STARTED 2026-07-12 in a separate
session** (base branch `viberr-selftest-implementation`; read role-bindings-map.md's "Updates since
this map" addendum first):
- **D2/D5** — make PROJECT_CAP_MATRIX the single runtime source (`actionRequires(action)`) and
  consolidate the 5 duplicated guard helpers. ~15 enforcement sites hardcode role lists today; a test
  keeps them in sync. Structural, no behavior bug — pure de-duplication.
- **Deep catalog prune** — the ~17 advisory-only capability ids remain in the catalog (they're
  referenced by seed profiles + the modal + tests; pruning them ripples through seed data). Now that
  the matrix can render "advisory" via `capabilityIsEnforced`, the honesty gap is closed without the
  risky prune.
- **D9** — SSE `/resources/events` project-membership check (compact-fact leak). Security-hardening;
  owner explicitly deprioritized security this pass.
- **Q5 (D6)** — contributor vs viewer differentiation — owner has not ruled; needs a product decision.

## Owner rulings (2026-07-11, via AskUserQuestion — all decided)
- **Q1 → RULED (A7/C2): acceptance requires explicit `direct`.** Full autonomy promotes OTHER
  recommend-capabilities to direct, but completion-for-acceptance only acts at explicit `direct`;
  `off`/`human` never offer the accept tool at all. The `auto` preset must set
  `completion-for-acceptance: direct` explicitly to keep its close-the-loop behavior.
- **Q2 → RULED (C3/D3-M4): owner OR admin/maintainer** resolves non-completion packets;
  `accept_completion` options stay admin|maintainer. UI hides resolve controls from everyone else.
- **Q3 → RULED (C6): implement ALL THREE guardrails for real.** operator-brevity = hard cap on
  operator comment length (truncate-with-details); meaningful-comment = reject/skip trivial agent
  comments; evidence-separation = long evidence folds into a collapsed details block.
- **Q4 → RULED (D1): prune + wire key ones.** Delete dead ids from catalog/matrix; keep the 11
  consumed; WIRE: execute-code-or-write-repo → deny Edit/Write/git-commit for specialists,
  edit-other-task-branch deny rule, reviewer commit-push-branch:human made real. Matrix honest.
- **Q5** (D6): contributor vs viewer differentiation — deferred; ask during/after phase 2 with
  live evidence.
- **Q6 → RULED (D10): filter Home to member projects; org-admins see all.** Home's project list is
  membership-scoped (a member sees only projects they belong to); org-admin role sees every project.
  Consistent with the inner-page `requireProjectMember` gating.
- **Q7 → RULED (X1): FULL workspace isolation now.** Specialists run with cwd = the per-task
  `workspace/`, clone the repo there, `GIT_CEILING_DIRECTORIES` blocks upward `.git` discovery, and
  the runtime flags when the resolved git root ≠ workspace.
- **Q8 → RULED (A8): IDLE timeout, not wall-clock.** A Codex (and Claude) run may legitimately exceed
  15 min total; interrupt only when a SINGLE turn/tool/bash produces NO new event for >15 min
  (inactivity heartbeat). On idle-timeout → finish the run `error` so the react loop / stuck packet
  fires and watchers are notified. Env-configurable idle window.
