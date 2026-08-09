# Pass 19 — executed use cases

Every row below was **run against the live app**, not reasoned about. Project under test:
**Viberr Core** (`akin-ozer/viberr`, the app's own repository), created through the UI at the start of
this pass. Tasks VC-1 … VC-9. Pull requests #147–#153 on the real repo.

Evidence column names the artefact that proves it: a task file, a PR number, an audit row, a DB row,
an HTTP status, or a screenshot. Where a case produced a finding, the finding id is linked to the
ledger in `NOTES.md`.

Legend: ✓ behaved correctly · ✗ produced a finding (fixed this pass unless noted)

---

## A. The delivery loop

| # | Use case | Result | Evidence |
|---|----------|--------|----------|
| 1 | **Create a project** against a real GitHub repo, Balanced policy preset, standard 5-stage workflow | ✓ | `docker-data/projects/viberr-core/project.md`; board renders 5 columns |
| 2 | **Create a task; operator triages it** — auto-advances Triage→Ready→In Progress and deploys a delivering agent unprompted | ✓ | VC-1 timeline: 2 transitions + "Deployed Developer (Implementation, Codex)" |
| 3 | **Codex agent implements on the task branch** — writes the file, validates, commits with a traceable message, reports back | ✓ | VC-1 commit `10f964d`, branch `vc-1` |
| 4 | **Operator delivers** — pushes and opens the review PR as its own decision, not a stage side-effect | ✓ | PR #147 opened by the operator (R15-2) |
| 5 | **Reviewer engages at the boundary and returns a verdict bound to the delivered revision** | ✓ | VC-1 `verdicts[]` pinned to `rev_DoiF7MnIu5jR` / `10f964d` |
| 6 | **Human accepts → real merge + branch deleted** | ✗ [F19-3] | PR #147 MERGED; branch 404 after. Accept happened with **no confirmation dialog** |
| 7 | **A second full loop on a different agent/backend** | ✓ | VC-3 → PR #148 merged |

## B. Agent selection, skills, knowledge and MCP

| # | Use case | Result | Evidence |
|---|----------|--------|----------|
| 8 | **Operator picks the right agent from descriptions** — a documentation task went to Doc Writer (Claude), not the Developer | ✓ | VC-4 `engagements[0].profileId: doc-writer` |
| 9 | **Operator picks a reviewer alone** for a verify-only task — no deliverer engaged, correctly | ✓ | VC-5 `engagements[0]` = reviewer, `delivers: false` |
| 10 | **Knowledge base grounds the work** — created a KB with a deliberately distinctive convention, granted it, agent followed it | ✓ | VC-3 file carries the KB's `Marker-Convention: v3` |
| 11 | **MCP server end to end** — built a stdio MCP server, registered it in the UI (real handshake on save), granted it, agent called it | ✓ | "1 tools · checked just now"; VC-7 returned canary `MCP-CANARY-PASS19-4417` |
| 12 | **Skill routing — only granted skills load.** An ungranted decoy skill (`kubernetes-rollback`, canary `SECRET-CANARY-KUBE-7788`) sat in the store all pass | ✓ | VC-7 + VC-8 agents both reported seeing ONLY `developer-expertise`, explicitly no Kubernetes skill; decoy canary appears in no run |
| 13 | **Codex vs Claude parity on the same MCP server** | ✓ | Claude: `mcp__pass19-probe__viberr-pass19-probe`; Codex: `mcp__pass19_probe__viberr_pass19_probe` — hyphens→underscores in **both** segments, exactly as the capability matrix documents. Same canary returned |
| 14 | **KB vs repo conflict is surfaced, not silently resolved** | ✓ (ruled) | VC-7's agent flagged unprompted that the KB-driven file breaks the repo's own README format → owner ruling **R19-2** |

## C. Governance, RBAC and secrecy

| # | Use case | Result | Evidence |
|---|----------|--------|----------|
| 15 | **Provision a user through the real admin flow**, including the forced set-a-new-password gate on first sign-in | ✓ | Elif + Murat created; `/login` served "Set a new password"; `set-password` → 302 |
| 16 | **Contributor tier boundary** — 9 governed writes attempted on tasks she does not own | ✓ | comment 200, owner-take 200; transition / accept-completion / update-goal / assign-specialist / run-specialist / archive-task / schedule-action / force-accept / run-operator all **403**, task file byte-unchanged |
| 17 | **Non-admin is refused org settings** | ✓ | `/org/settings` → 403 for a member |
| 18 | **Members-only secrecy (R15-4), exhaustively** — a genuine non-member across every surface | ✓ | all 8 project routes **404**; ⌘K search **0 hits**; home never names the project; comment POST **404**. Not "refused" — invisible |
| 19 | **Org-admin emergency authority on a non-member project** | ✗ [F19-26] | Promoting Murat to org admin gave access without membership (correct), but the action audited as an ordinary `task.comment` — the override is **not** recorded as an override. Open owner question |
| 20 | **Every denial is audited with role and action** | ✓ | `project.authority.denied` rows carrying `action`, `what`, `memberRole` |
| 21 | **Task ownership** — take, and a contributor-owner's authority over their own task | ✓ | VC-4 `ownerUserId` = Elif via `owner-take` 200 |

## D. Recovery, reconciliation and the unhappy paths

| # | Use case | Result | Evidence |
|---|----------|--------|----------|
| 22 | **Reject a PR externally** (`gh pr close`) → Viberr notices and recovers | ✓ | PR #149 CLOSED → divergence note + recovery packet + moot recommendation withdrawn |
| 23 | **Merge a PR externally behind Viberr's back** → reconcile surfaces the divergence honestly | ✓ | PR #153 merged out-of-band → typed note "merged on GitHub, but VC-8 hasn't been accepted through Viberr" |
| 24 | **Underspecified goal is refused at the triage gate** rather than guessed at | ✓ | VC-2 "Improve the docs" → `input_required` + a 4-option scoping packet |
| 25 | **Resolve a blocking packet and have the operator act on the choice** | ✓ | VC-3 retry option → operator re-prompted the deliverer |
| 26 | **The rejection loop, unassisted** — reviewer returns `request_changes`, operator re-engages the deliverer, work strengthens, re-review | ✓ | VC-7: reviewer refused to treat a self-report as proof; operator re-ran the deliverer without human help |
| 27 | **Force-accept past a missing verdict, audited as an override** | ✓ | VC-8 → Done; `task.acceptance.forced` naming the exact gate bypassed |
| 28 | **Archive a task, and an archived task cannot move** | ✓ | VC-5 archive → `waiting: none`; transition attempt → **409**, stage unchanged |
| 29 | **Hand-edit `task.md` outside the app (FR10)** | ✓ | watcher reconciled the projection within seconds, no manual re-scan; board showed the new title |
| 30 | **Schedule a future operator re-run, then cancel it (FR39)** | ✓ | written canonically into `task.md` with backend/autonomy/creator; cancel → `status: cancelled`, record **retained** for audit |
| 31 | **Interrupt a live agent run** | ✓ | run → `interrupted`, `interrupted_by` = the actor, audit `runtime.run.interrupted` |
| 32 | **"Completed — no changes" end to end (R19-1)** — a verification-only task with nothing to deliver | ✗ [F19-27] | VC-9 → `done` + `noChanges: true`, no PR, no merge, completion event re-checked the branch **at acceptance**. But the board card claimed **"awaiting verdict"** on a closed task |

## E. Cross-cutting surfaces

| # | Use case | Result | Evidence |
|---|----------|--------|----------|
| 33 | **@mention a teammate → notification routes with context** | ✓ | Elif's inbox: "Arda · mentioned you", quoted text, project·task, Mark read |
| 34 | **⌘K search** across tasks and branches, scoped by membership | ✓ | hits for admin + member; 0 for non-member |
| 35 | **Review queue reflects the same truth as the task page** | ✗ [UX19-3, later retracted] | My two screenshots were taken at different instants — see the retraction note in `NOTES.md` |
| 36 | **A full visual sweep of every principal surface at 1440×900** | ✓ | screenshots of home, board, task detail, review queue, agents, policy, notifications, settings |

---

## What the use cases produced

- **27 findings** from rounds 1–3 (F19-1 … F19-27, UX19-1/2, plus notes and questions), all in `NOTES.md`.
- **24 further UX-coherence findings** from the adversarial audit that the use cases motivated.
- **4 owner rulings** (R19-1 … R19-4), promoted into `docs/architecture/decisions.md` as 55–58.
- **3 retractions** where my own claim did not survive scrutiny — recorded deliberately, because the
  correction is the useful artefact.

The two findings that only a live run could have produced are worth naming: **F19-3** (accepting from a
recommendation merged a PR with no dialog — found by clicking Apply and watching the merge land) and
**F19-27** (a closed no-change task claiming a pending verdict — found by running R19-1's own use case
end to end for the first time, after implementing it). Neither is visible from reading the code.


---

## F. Round 6 — driving the NEW features as an end user

The 14 roadmap features were verified by code, curl, sqlite and unit tests. That is not the same as
using them. This round created a fresh project (**Pass19 Verify**, PV-1) and drove the new surfaces
through the browser. Two defects fell out that no test could have caught, because both were about how
the app reads to a person.

| # | Use case | Result |
|---|----------|--------|
| 37 | **Fresh project through the UI** with the new features present | ✓ board renders the new **No activity** filter chip alongside the four existing ones |
| 38 | **Vocabulary collision, home vs board** | ✗ **found and fixed.** The home project card has always read "9 tasks · quiet" for `running === 0` — a healthy project with nothing in flight. Gap 10 then shipped a task-level "Gone quiet" meaning the opposite: *this task has stalled*. Two meanings for one word, one click apart. The newer one was mine, so the chip became **"No activity"**, matching the pill it selects rather than paraphrasing it. |
| 39 | **Autonomy selector honesty, both panels** | ✗ **found and fixed.** The run picker correctly offered only "Supervised" on a supervised project; the schedule form one panel above still offered "Full". I had applied one half of the patch. The half I missed was the worse one — a scheduled run fires unattended, so nobody would be watching when the level was silently clamped. Both now offer only what will run, and the writer clamps at schedule time so the canonical entry cannot advertise a level the run will not have. |
| 40 | **The clamp bites and says so** | ✓ live: running at `full` on a supervised project wrote `task.operator.autonomy_clamped {"requested":"full","ranAt":"supervised"}`. This audit row exists only because an earlier live test found the clamp working but INVISIBLE — its audit needed a `db` handle the run path never passed. |
| 41 | **Corrupted task file is refused, not destroyed** | ✓ live: a tab-indented frontmatter on a real task made a comment return **409** with the file byte-intact and all 4 timeline entries preserved. Before the guard, that one comment reset every field and took the goal and timeline with it. |
| 42 | **`store:check` names the break** | ✓ live: file path, parse error, offending line with a numbered excerpt, and the recovery command. |
| 43 | **Backup on a live instance** | ✓ live: `npm run backup` against the running app — `integrity_check ok`, 3 users / 826 audit rows / 10 tasks readable *out of the artefact*, one file, no WAL sidecars. |
| 44 | **Health tells the truth** | ✓ live: `status`/`degraded`/`disk`/`maintenance`/`build`, and `build.revision` matched the HEAD commit exactly — proof it reads real git state rather than a placeholder. |

**What this round is really evidence for:** every one of these features passed its unit tests before I
opened the browser. Two were still wrong in the way that matters to a user, and a third (the clamp's
audit) was wrong in a way only a live run could expose. Tests prove a function does what it says;
they do not prove the product reads honestly.
