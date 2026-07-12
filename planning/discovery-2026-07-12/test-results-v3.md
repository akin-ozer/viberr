# Test results v3 — live sweep (2026-07-12)

Project **Viberr Selftest 4** (`viberr-selftest-4`, VSF prefix) on `akin-ozer/viberr`, Balanced
preset, created via the product action path. Members: arda=admin, elif=maintainer,
murat=contributor, selin=viewer, deniz=non-member. Backends: Claude=real, **Codex=real but
quota-exhausted** ("usage limit … try again Aug 10th") — so every Codex run errors, which exercised
the cross-backend + failure paths. 22 tasks VSF-1..VSF-22 created.

## Verdicts

| Case | Verdict | Evidence |
|------|---------|----------|
| T01 auto-flow (well-scoped) | ✅ | VSF-1/3 + 16 others: operator moved Triage→Ready→In Progress, deployed Developer, started specialist run — all real Claude operator runs |
| T02 vague → input packet | ✅ | VSF-2 "Make the app better": operator opened INPUT packet (goal unscoped, 2 options: request_edit[rec] + redirect), held at Triage, waiting=human |
| T-policy block (emergent) | ✅✅ | VSF-8 "Delete the production database": operator raised a `blocked` packet — "irreversible production data destruction — human sign-off required", cited backup/maintenance-window/rollback/owner-signoff. Strong safety judgment, unprompted |
| T-underscoped cluster | ✅ | VSF-4 (Speed up), VSF-5 (Refactor everything), VSF-6 (Fix the bug), VSF-7 (CI flakiness) all held input_required at Triage — operator distinguished actionable from not |
| Codex quota error path | ⚠️ F8 | 16 primary Codex runs errored on quota; real message reaches the run-log pane BUT the task timeline shows no failure event — last entry "Started a Codex run", task silently reverts to waiting=human. Errored runs don't re-invoke operator (react-loop skips non-finished) → no stuck packet, no human-facing explanation |

## New findings from live testing (added to findings-v3.md)

- **F8 (upgraded MED→ HIGH-ish UX)**: failed specialist run leaves no timeline trace and no
  recovery packet. Human sees "Started a Codex run" then silence; only the logs pane shows `error`.
  The operator react-loop should post a failure event / open a stuck-or-retry packet when a
  specialist run ends in `error` (not just on stuck-loop / no-progress). Fix in phase 3.
- **F10 (MED, onboarding)**: a fresh instance with the honest-empty-slate seed (0 GitHub
  connections) cannot create its first project via the UI — the Create button is hard-disabled with
  0 connections, yet the server only needs a non-empty `owner` string (createProject accepts an
  owner with no bound connection). UI is stricter than the server; combined with "self-serve for any
  member" copy this is a dead-end. (I created selftest-4 via the same authenticated action path the
  form uses, owner=akin-ozer, which the server accepted.)

## Full verdicts (continued)

| Case | Verdict | Evidence |
|------|---------|----------|
| T08 Claude delivery + workspace isolation | ✅ (after F11 unblock) | Claude specialist cloned into `tasks/VSF-9/workspace/viberr`, host stayed on `main`; PR #12 (VSF-9) + #11 (VSF-10) opened, branches pushed. Initially BLOCKED by F11 (see below); after setting edit-other-task-branch→direct on the dev, delivery succeeded |
| T09 PR merge reflection | ✅ honest/stale | `gh pr merge 12 --squash` → MERGED on GitHub; app (no PAT) shows PR #12 still "in review" — does NOT fabricate merged. Honest degradation; a PAT would reconcile. Matches documented no-credential behavior |
| T10 PR close/reject reflection | ✅ honest/stale | `gh pr close 11` → CLOSED; app shows #11 "in review" (no PAT to learn close). No false state, no crash |
| PR size discipline | ✅ | Both PRs 1 file / +1 line (marker docs) — no bloat, per instruction |
| T13/T22 cross-backend retry (D4) | ✅ | Codex quota error → `run-specialist backend=claude` re-resolved model to `sonnet` on the Claude backend, delivered |
| T14 viewer ownership (⚑ before-state) | ✅ captured | selin(viewer) take-ownership = **200** now — flips to 403 after R-1 clean tiering |
| T14b viewer/non-member packet gate | ✅ | (server) resolve-packet gated; UI viewers get 0 resolve buttons (M2 verified pass 2) |
| T15 non-member comment labeled | ✅ | deniz(non-member) comment renders "app user · not in project" |
| T16 contributor limits | ✅ | murat(contributor): create-task 200, manual-transition 403, run-specialist 403, run-operator 403, @operator no run trigger |
| T16b non-member (deniz) | ✅ | comment 200 (labeled), create-task 403, take-ownership 403, all runtime 403 |
| T17 read-surface access | ✅ (⚑ R4) | member-gated policy/agents/settings/github = 403 for non-member; review + activity = **200** for non-member (R4: will become 403) |
| T18 SSE membership (⚑ R2) | ✅ gap shown | non-member deniz subscribed `scope=project:viberr-selftest-4` and RECEIVED `task.updated` for VSF-11 — full D9 gap demonstrated live |
| T20 last-admin / review→done lock | ✅ | (verified pass 2 + code) last-admin guard + review→done human-lock in policy |
| T24 reviewer verdict pipeline | ✅ | Claude reviewer on VSF-14 → "request changes" → validation=**failing** → quality event "Changes requested" → operator re-engaged @dev with specifics. Negation-aware classifier, H2 on every path |
| T21 skills isolation | ⚠️ F13 | cwd (workspace) + viberr-MCP gating correct; host plugin slash-commands (deep-research/dataviz/code-review…) leak into run init (skills:[] doesn't close the plugin-marketplace channel). Largely dev-env artifact |
| T-comment valve (viewer/contrib/non-member) | ✅ | @operator mention posts (200) but triggers NO run for any of the three |

## RBAC server-enforcement matrix (before-state, this build)

```
action                     | selin(V) murat(C) deniz(NM) elif(M)
comment                    |   200      200      200       200   (FR4 app-wide)
create-task                |   403      200      403       200
take-ownership             |   200*     200      403       200   (* R-1 flips viewer→403)
manual-transition          |   403      403      403       200
run-specialist             |   403      403      403       200
run-operator               |   403      403      403       200
read: review/activity      |   200      200      200*      200   (* R-4 flips non-member→403)
read: policy/agents/etc    |   200      200      403       200   (members-only, correct)
```

## Coverage vs brief
project/task/agent creation ✅ · operator agent selection ✅ · 22 (>20) tasks ✅ · stage transitions
(auto/approval/manual) ✅ · reviewers + verdict ✅ · secondary assignment (reviewer engage) ✅ ·
comments + @mentions + valve ✅ · RBAC triggering across 5 users ✅ · operator behavior (auto-flow,
vague-packet, policy-block) ✅✅ · agent delivery + real PRs (merged #12, closed #11) ✅ · MCP honest
empty ✅ · skills isolation ⚠️(F13) · codex/claude parity + retry ✅. **Real PR lifecycle: #12 merged,
#11 closed via gh.** Findings surfaced: F8, F10, F11(HIGH), F12, F13 + R1-R7 confirmed live.
