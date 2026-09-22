# Doctrine review — controller and operator (pass 39)

What the owner asked: does the controller create *good* knowledge bases, skills and agents;
does the operator make good decisions and know what viberr can do; and does either of them
keep the project knowledge base current as the project evolves.

## 1. What the controller actually produced (verdict: good)

Unprompted on specifics, from a one-paragraph goal, it produced:

- **Project shape** — 6 custom stages (Triage → Design → Build → Verify → Review → Done),
  auto boundaries except a locked human boundary into Done, Reviewer as a **required
  reviewer** at Review.
- **`ax-clone-rulings` KB**, promoted to the project's **rulings KB** (ruling 239) so every
  run reads it: `environment-and-gates.md` (measured toolchain, the four gates, the
  gofmt-exits-0 trap, "never report an unrun check as a pass") and `architecture.md`
  (settled layout, object model, store design, sandbox boundary).
- **Two skills** — `go-gate-discipline` (three honest gate outcomes; never `|| true`; never
  narrow a gate's scope; never `t.Skip` to clear it) and `ax-clone-engineering`.
- **Agents** — all three on Codex `gpt-5.6-luna` / `max`, with a considered grant matrix
  (Developer's `open-review-pr` **off** so delivery is single-pathed through the operator;
  Reviewer given `execute-code-or-write-repo` so it *runs* the gates rather than eyeballing
  them, with `commit-push-branch` at `human`).
- **26 tasks in 6 chained goals**, each cycle's first task born blocked on the previous
  cycle's last link so they cannot collide on one Go tree.

It also refused to overclaim: it could not verify golangci-lint, said so to the owner, and
made AX-1 prove it empirically. The downstream Developer then ran exactly that probe and it
passed. This is the behaviour the doctrine wants, and it happened.

**But**: the brief told it *"Check what this host can actually run before you promise a
gate."* Nothing in `controller-guide.skill.md` or `handbook.md` says that. The good
behaviour may be the prompt's, not the doctrine's.

## 2. Gaps in the controller's own runtime

`app/server/seed/assets/controller-guide.skill.md` (56 lines) and
`data/kb/controller-handbook/handbook.md` (29 lines) between them cover: the core loop,
the per-turn context block, the two permission scopes, what it never does, chained goals,
working with operators, answer style. They do **not** cover:

| gap | why it matters here |
|---|---|
| **Bringing up a new project.** No section on it at all. | The single highest-leverage thing a controller does. Verify the toolchain before declaring a gate; wire a rulings KB; set models and effort; name required reviewers; decide boundaries. All of it was improvised. |
| **Keeping the rulings KB current.** Nothing. | See §4 — this is the owner's question and the answer is "nothing makes it happen". |
| **Advisory vs enforced capabilities.** Nothing. | It read advisory rows as authority and told its owner something false (F39-4). Doctrine could not have saved it — the surface lied — but the fix should land in both places. |
| **Model and effort discipline.** Nothing. | It happened to get this right because the brief spelled it out. |

## 3. The operator (verdict: good decisions, no KB authority)

Decisions observed on AX-1 were correct and fast (14s and 30s turns on luna/max): auto
transition Triage→Design, then select `developer` with `delivers: true` and a directive that
named the deliverable, demanded the lint probe's *exact command, exit code and output*, and
closed with **"Do not push, open a PR, or merge"** — precisely the `deliver_for_review`
doctrine in `viberr-app-expertise.skill.md`.

## 4. Nobody in the delivery loop can write the project knowledge base

Measured from the live runs' own `run_inputs`:

- **Operator toolkit** (11 tools): `post_comment`, `open_packet`, `resolve_packet`,
  `set_goal`, `run_agent`, `transition_stage`, `deliver_for_review`,
  `update_branch_from_base`, `accept_completion`, `flag_context_conflict`,
  `set_dependencies`. **No knowledge-base write.**
- **Specialist toolkit**: none.
- **Controller**: `save_knowledge_base` — but the controller only runs when a human talks
  to it.

So the rulings KB is injected into every run as read-only truth, and the only way a fact a
review *establishes* gets into it is a human noticing and asking the controller. Over 26
tasks and 6 cycles that is exactly the drift the KB exists to prevent. Open as a product
design question for the owner.
