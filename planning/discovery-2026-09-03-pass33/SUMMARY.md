# Pass 33 — summary (2026-09-03)

A full-product pass: read the whole code-verified `docs/` set and all 121 rulings, then used
the app as a real team would — five users across four roles, four projects, live Claude and
Codex runs against `akin-ozer/viberr`, real pull requests opened, merged and rejected — and
fixed everything it turned up.

## What it found

**23 findings, all dispositioned: 10 defects, 10 UX/coherence items, 3 canon gaps, plus one
finding of my own that I refuted rather than shipped.** Every one is closed. Nothing was
deferred.

Four were serious enough to change the product's rules:

- **F33-1** A *merged* historical pull request on a task-key branch raised a "branch name
  collision" that stopped the operator and demanded a human decision — and the delivery it
  said was blocked then succeeded on the first press. Reproduced twice (PR #270, #271). Two
  code paths were asking GitHub different questions: `openTaskPr` lists `state: "open"` and
  cannot see a merged PR at all, while `findPrForBranch` lists `state: "all"` and treats the
  newest match as a collision. On a fresh data root — the situation ruling 34 explicitly
  names — this fires on every task whose key was used before.
- **F33-6** An org admin could force-accept an **archived** task straight to Done, leaving it
  `archived: true` + `stage: done` + `acceptance: forced`, a state every other path forbids.
  Proven live on SBX-1.
- **F33-8 / F33-7** Every resource grant made through the controller was **dangling** — it
  stored the ids its own read tools returned while the runtime mounts by folder name,
  registry name and directory — and a partial edit through chat silently erased a template's
  grants, because `save_global_agent` was a full replace with optional fields and no read
  tool exposed what it was about to overwrite. The controller diagnosed the second half
  itself and refused to act, which is the only reason it was not already destructive.
- **F33-9** Mentioning a **non-member** wrote them an inbox row naming the project, the task
  and the comment text — and the link then served them the members-only 404. Ruling 25 read
  backwards.
- **F33-10** Releasing a supporting engagement on a Done, merged task was allowed, and it
  re-derived `validation` from `healthy` to `changed` — rewriting the review history of work
  that had already been accepted and merged.

## What the owner ruled

Five new rulings (**122–126**) plus **117**, which records that the number was skipped and
never used, so the numbering stays honest.

| # | decision |
|---|---|
| 122 | A task's branch **name is allocated, not derived**. "Taken" means a ref **or any past pull request**; the suffix is a short hash; allocation happens once, at first branch creation, on both dispatch paths. |
| 123 | The **archive is irreducible** for force-accept, like a closed PR. Restore first. |
| 124 | Force-accept is an **escape hatch, not a standing offer** — it appears once there is work to accept or a blocked packet proving a wedge. |
| 125 | The Policy page shows **values, not dead controls**, to roles that cannot edit. |
| 126 | **Coordination overhead is the price**: 69% of spend on operator runs is accepted, R29-1 stands. Recorded so a later pass does not re-file the number. |

## What it proved works

Much of the pass was confirmation, and it is worth saying plainly. The delivery pipeline runs
end to end: operator triage → agent selection with a recorded trace → implementation on a
task branch → required-reviewer verdict bound to a revision → acceptance ceremony with the
ruling-88 disclosure → a real merge → branch cleanup. A deliberately rejected PR produced
exactly the documented recovery: divergence note, moot recommendation withdrawn, acceptance
refused by the terminal GitHub fact with force-accept **withdrawn**, and a rework that opened
a fresh PR rather than resurrecting the closed one. Revision drift disclosed itself on the
accept dialog ("1 commit added since review; it merges unreviewed"). A hand-corrupted
`task.md` produced nine typed diagnostics and a 409 that named the cause, the remedy and the
CLI that finds the line, with the draft preserved. A repository that does not exist produced
git's own redacted words. And a Developer agent found prompt-injection text planted in the
repository, refused it, and said so in its report.

MCP, knowledge bases and skills were each proven live rather than assumed: an agent called a
registered MCP tool and wrote its token verbatim, applied a convention that exists only in a
granted KB, and its run record showed `skills: {granted: [...], native: [...], injected: []}`
— only the granted skill, no strays.

## Numbers

- **72 use cases** exercised live ([USE-CASES.md](USE-CASES.md)); 50 was the target.
- **23 findings** ([FINDINGS.md](FINDINGS.md)), all closed; 1 self-refuted.
- Gates at close: `oxlint` 0 errors · `tsc` clean · **5201 unit tests in 319 files** ·
  `build` clean · **e2e 67/67** (65 before this pass). The suite grew by **132 tests in 10
  new files** — the coverage band below.
- 6 new rulings, 8 `docs/` pages updated in the same change.

## Where the material is

| file | what it holds |
|---|---|
| [FINDINGS.md](FINDINGS.md) | every finding, with the live evidence and the code path |
| [USE-CASES.md](USE-CASES.md) | the 72 use cases and what actually happened |
| [QUESTIONS.md](QUESTIONS.md) | the questions put to the owner and the answers, in two batches |
| [TODO.md](TODO.md) | the implementation plan the fixes were built from |
| [TESTPLAN.md](TESTPLAN.md) | how each fix was re-proven, unit and live |
| [NOTES.md](NOTES.md) | environment, traps and method |
| [reference/](reference/) | the UI surface inventory and the test-coverage inventory |
| [screenshots/](screenshots/) | ~60 captures, light and dark, desktop and mobile |

## The coverage band — every named gap closed

The coverage inventory named ten authority chokepoints whose guards could be **deleted with
every gate still green**. Ruling 65 says a guard that cannot go red is a ruling that gets
reverted in silence, so each one now has a test file, written against the real module (no
`vi.mock` of the thing under test, no skips), and each was proven by breaking the source,
watching the test go red, and restoring it.

| chokepoint | new file | tests | what it pins |
|---|---|---|---|
| `requireProjectMember` | `app/server/auth/require-project.server.test.ts` | 13 | ruling 25: a non-member gets the unknown-slug 404 byte for byte; auth resolves before membership; archived projects stay readable to members (R6-3); the refusal is silent to the client, never to the audit log |
| `getProjectGithubContext` | `app/server/github/github-context.server.test.ts` | 9 | repo-less degrades before credential; no project borrows another's PAT; an unreadable secret degrades rather than building an **anonymous** client; `patId` and the token on the wire stay paired |
| `requireFormAction` | `app/server/auth/form-action.server.test.ts` | 12 | the CSRF + intent gate on every POST |
| controller dock cross-scope guard | `app/features/controller/controller-dock-query.server.test.ts` | 11 | ruling 121: the dock's per-surface scope resolution and what it refuses to carry across scopes |
| `canAccessConversation` / `canReadControllerRunLog` / `get_github_state` | `app/server/controller/controller-access.server.test.ts` | 14 | a transcript belongs to one person: the **project admin of the bound board reads nothing**, supervision is org-level and resolved live, and "not yours" is byte-identical to "never existed" |
| `run-events.server.ts` | `app/server/runtimes/run-events.server.test.ts` | 7 | the run event stream's ordering and terminal contract |
| `claude-config.server.ts` | `app/server/runtimes/claude-config.server.test.ts` | 12 | what the Claude backend is actually handed: skills, KBs, MCP grants |
| `write-cache.server.ts` | `app/server/files/write-cache.server.test.ts` | 12 | the read-your-own-writes repair, its 100 ms slack trade stated outright, and the 500-path bound evicting the coldest not the hottest |
| `ACTION_ROLES` | `app/shared/rbac.test.ts` | 17 | the matrix at exactly the floor each ruling assigned it, `force-accept-completion` strictly narrower than `accept-completion`, **and the two domain doc tables pinned against the code** |
| `task-mutation.server.ts` | `app/server/tasks/task-mutation.server.test.ts` | 18 | the governed-mutation envelope every task write passes through |

Three were re-canaried independently of the agents that wrote them, at integration level rather
than by hand-checking their reports: `canAccessConversation` forced to `return true` → 3 red;
`freshestContent` short-circuited to the disk bytes → 6 red; `force-accept-completion` widened
to maintainer → 4 red, two of which are the doc tables. Sources restored, `git diff` empty.

## Left open, deliberately

- **Codex could not be exercised live** — the account's quota is exhausted until 2026-09-18.
  The failure path was proven instead (provider's own words, blocked packet,
  `retry_other_backend`, and a backend pin that stuck), and the confinement was read off the
  run record rather than a running process.
- The `Docs Writer` template left in the dev store still carries its three dangling grants:
  the fix does not retro-repair, and it is kept as the fixture that proves the difference.
