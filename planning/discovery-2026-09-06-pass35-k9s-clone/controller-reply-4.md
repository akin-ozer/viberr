All five delivery deployments are on Claude/opus/high. One refusal: the goal-3 link-1 edit.

## 1) Backend switch — tool replies verbatim

- `[done] Developer updated on k9c-k9s-clone. Effort is now high.`
- `[done] TUI Engineer updated on k9c-k9s-clone. Effort is now high.`
- `[done] Kubernetes Platform Engineer updated on k9c-k9s-clone. Effort is now high.`
- `[done] Test &amp; CI Engineer updated on k9c-k9s-clone. Effort is now high.`
- `[done] Docs &amp; Release Engineer updated on k9c-k9s-clone. Effort is now high.`

That is the whole of each reply — the tool said **nothing** about the backend switch itself, nothing about grants behaving differently on Claude, and nothing about the model. The only thing it chose to narrate was effort. (I passed backend, model and effort together in one call each, so no "backend switch with no effort resets to the default" warning was triggered.)

**Read-back from `get_project`** — all five now `backends: ["claude"]`, `model: "opus"`, `modelLabel: "Claude Opus"`, `effort: "high"`:

| Deployment | Backend | Model | Effort | Stages |
|---|---|---|---|---|
| Developer | claude | opus (Claude Opus) | high | design, impl |
| TUI Engineer | claude | opus | high | design, impl |
| Kubernetes Platform Engineer | claude | opus | high | design, impl |
| Test & CI Engineer | claude | opus | high | impl, validation |
| Docs & Release Engineer | claude | opus | high | impl, validation |

Capability grants came through unchanged — notably **Docs & Release Engineer still holds `use-browser: direct`**, so the browser task survives the move. Untouched, for the record: Operator, Reviewer, Architecture Reviewer and Security & Dependency Auditor were already claude/opus/high.

*Deviation to flag:* the project description still reads "Delivery agents run on Codex; reviewers and the operator run on Claude." That sentence is now false. I did not edit it — say the word and I'll update the project settings.

## 2) goal-3 link 1 — refused

`update_goal(goal-3, edit_link, index 1, blockedBy [])` answered:

> `[error] Only a pending or failed link can be edited; link 1 is active.`

The link is active because KNC-3 carries it, so its stale `blockedBy: ["goal-2 link 6"]` cannot be cleared through the goal. It is cosmetic only: KNC-3's own task-level `blockedBy` is `[]` (confirmed in this turn's read), so nothing is holding the task — its block is the quota packet. The link record will stop mattering when link 1 completes.

## 3) Stalled tasks — branch and engaged agent (untouched, as asked)

Every stalled task already has a remote branch. Fourteen tasks are sitting blocked:

| Task | Branch (GitHub sync) | Engaged agent | What the open packet actually is |
|---|---|---|---|
| KNC-2 | `knc-2` · behind_main | TUI Engineer | Quota stall — "Retry @tui-engineer on Claude now" (rec) |
| KNC-3 | `knc-3` · behind_main | TUI Engineer | Quota stall — retry on Claude (rec) |
| KNC-6 | `knc-6` · behind_main | Docs & Release Engineer | Quota stall — retry on Claude (rec) |
| KNC-9 | `knc-9` · behind_main | Docs & Release Engineer | Quota stall — retry on Claude (rec) |
| KNC-18 | `knc-18` · behind_main | TUI Engineer | Quota stall — retry on Claude (rec) |
| KNC-19 | `knc-19` · behind_main | Developer | Quota stall — retry on Claude (rec) |
| KNC-22 | `knc-22` · behind_main | Docs & Release Engineer | Quota stall — retry on Claude (rec) |
| KNC-23 | `knc-23` · behind_main | TUI Engineer | Quota stall — retry on Claude (rec) |
| KNC-26 | `knc-26` · behind_main (commit `66f0162` delivered) | Kubernetes Platform Engineer | Quota stall — retry on Claude (rec) |
| KNC-28 | `knc-28` · behind_main | Kubernetes Platform Engineer | Quota stall — retry on Claude (rec) |
| KNC-30 | `knc-30` · **synced** | Docs & Release Engineer | Quota stall (rec) — **plus** a policy note: unowned PR #7 sits on `knc-30`, a branch-name collision needing a `resolve_remote_collision` decision |
| **KNC-8** | `knc-8` · behind_main · PR #6 `conflicting` (`ad25c40`) | Docs & Release Engineer | **Not a quota packet** — "`knc-8` conflicts with `main`" (README.md). Options: agent resolves (rec) / resolve by hand / archive |
| **KNC-20** | `knc-20` · behind_main (commit `c981ba9`, no PR) | Docs & Release Engineer | **Not a quota packet** — "`knc-20` conflicts with `main`" (README.md), same three options |
| **KNC-25** | `knc-25` · behind_main | Developer | **No open packet.** You resolved it at 14:21:02Z with *hold for runtime debug*; it resumes only via **Run operator** on the task page |

So "Retry on Claude now" is available on eleven of them. KNC-8 and KNC-20 need the conflict decision instead (both conflict on `README.md` against the post-bootstrap `main`), and KNC-25 needs an operator run, not a resolution. Every engaged specialist above now resolves to Claude/opus/high after item 1, so a retry lands on the same profile you just re-pointed.

## 4) Identifiers, refusals, deviations

Touched: deployments `developer`, `tui-engineer`, `kubernetes-platform-engineer`, `test-amp-ci-engineer`, `docs-amp-release-engineer` on `k9c-k9s-clone`. **Refusal: one** — `update_goal` on goal-3 link 1, "Only a pending or failed link can be edited; link 1 is active"; I did not retry it. Deviations: the project description's Codex sentence is now stale and I left it alone; I read KNC-8, KNC-20, KNC-25 and KNC-30 beyond the quota-stall set to answer item 3 honestly, and three of them turn out not to be quota stalls at all. I touched no packet.
