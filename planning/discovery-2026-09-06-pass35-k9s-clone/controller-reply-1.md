Setup is complete and the build has started. Here is what exists.

## Project
**`k9c — k9s clone`** · slug `k9c-k9s-clone` · keys `KNC-n` · repo `akin-ozer/k9s-clone` (connection **connected**, default branch `main`).

Stages and boundaries:
`Triage →auto→ Design →auto→ Impl →auto→ Validation →auto→ Review →approval→ Merge →human(locked)→ Done`

The reviewer gate you asked for is the `Review → Merge` **approval** boundary, backed by reviewer agents holding `report-validation-verdict` at direct. Nothing reaches Merge without a verdict plus your approval, and Merge → Done is locked human.

## The product I decided on
`k9c`: a single static Go binary. Go 1.23+, **tview/tcell** for the TUI, **client-go** typed + dynamic with discovery and a deferred RESTMapper (so CRDs are browsable for free), **dynamic shared informers** for live tables, cobra, slog-to-file, goreleaser. Layering is strictly one-directional `ui → model → client → cluster`, with `internal/model` testable at zero cluster access. Ten screens: resource table, describe, YAML, logs, exec, port-forward, contexts, namespaces, pulse, help.

## Resources created
- **Knowledge bases (3):** `k9c-product-spec`, `k9c-engineering-standards`, `kubernetes-client-notes`
- **Skills (3):** `k9c-delivery`, `k9c-review`, `k9c-release-ops`
- **Agent templates (8):** rewrote stock `developer` and `reviewer`; created `tui-engineer`, `kubernetes-platform-engineer`, `test-amp-ci-engineer`, `docs-amp-release-engineer`, `architecture-reviewer`, `security-amp-dependency-auditor`

## Deployments — models verified by read
| Agent | Backend | Model | Effort |
|---|---|---|---|
| Operator | claude | opus | high |
| Developer, TUI Engineer, Kubernetes Platform Engineer, Test & CI Engineer, Docs & Release Engineer | codex | gpt-6-astra | medium |
| Reviewer, Architecture Reviewer, Security & Dependency Auditor | claude | opus | high |

Your model rule is satisfied on every deployment. Delivery agents hold write/branch/commit/PR at direct; all three reviewers are read-and-verdict only (no repo write, no branch, no PR). Merge and transition-to-done are `human` everywhere.

## Goal chains — 29 tasks
- **goal-1** Foundation, 8 links → live now as **KNC-1** (ADR)
- **goal-2** Navigation & resource coverage, 7 links → **KNC-2**, held on `goal-1 link 8`
- **goal-3** Daily-driver operations, 7 links → **KNC-3**, held on `goal-2 link 6`
- **goal-4** Hardening & v0.1.0 release, 7 links → **KNC-4**, held on `goal-2 link 3`; link 5 waits on `goal-3 link 6`, link 7 on `goal-3 link 7`

All four `onFailure: pause`. Each link is a branch-plus-PR cycle, so this is 29 cycles, not 8. An operator run is **started on KNC-1**.

## Deviations and refusals
- **Task key `K9C` was refused** — "must be 2-4 letters", digits not allowed. Used **`KNC`**.
- **Schedules: no tool exists.** There is no scheduling tool in my set and no schedule field on `create_project` or `update_project_settings`. I could not create any. The chains self-advance on task completion instead, which covers sequencing but not wall-clock triggers.
- **No MCP servers created, deliberately.** Nothing in this build needs one — GitHub access is the stored `akin-ozer` connection plus the `read-github-api` grant. I also cannot accept credentials through chat, so a server needing a token would have to be added by you in Org settings anyway. Say the word if you want a specific one registered and I'll create the connection for you to add the secret to.
- **Model/effort are not settable on global templates**, only per-deployment. Your rule is enforced on all nine deployments; if a template is ever deployed to a *new* project it will fall back to that template's default, so re-apply there.
- **I set operator autonomy to `full`, then reverted it to `supervised`.** The tool told me full autonomy means "it performs approval-boundary transitions itself" — that would have let the operator self-approve `Review → Merge` and hollow out the reviewer gate you required. Supervised means you approve each of the 29 transitions into Merge. Tell me if you'd rather trade that gate for throughput.
- **Architecture Reviewer and Security Auditor** resolved with `approve-review`/`request-changes` at `off` — those are matrix-only advisory ids with no toggle, tied to the stock reviewer template. Both still hold `report-validation-verdict` at direct, so they give verdicts; the formal approve/request-changes belongs to **Reviewer**. Treat the other two as specialist consults.
- Cosmetic: `&` in three template names stored HTML-escaped (`Test &amp; CI Engineer`). Harmless, but I can't rename it away cleanly — the id is `test-amp-ci-engineer`.
- Out of my reach by design, all yours on the task page: merging each PR, accepting completions, and moving tasks into Done. I also cannot delete anything.
