# Pass 39 — the plan, and what landed

Observation ran first (see `TIMELINE.md`, `FINDINGS.md`, `DOCTRINE.md`, `RBAC.md`). This is
the fix list that came out of it, every item with the evidence that produced it, the owner
decision where there was one, and its state. Branch: `pass39/ax-clone-fixes` on
`akin-ozer/viberr`. The clone itself ships through viberr to `akin-ozer/ax-clone` and shares
no commit with this branch.

**Rule for every item: a test that was run RED before it was run green.** Canaries are named
per item and each one was applied to the source and observed failing.

| # | What | Owner decision | State |
|---|---|---|---|
| 1 | `get_project` marks advisory capabilities (F39-4) | — | **done**, ruling 377(a) |
| 2 | `instance_health` probes an arbitrary command (F39-1) | — | **done**, ruling 377(b) |
| 3 | `propose_ruling` on the operator, both backends (F39-7) | "Operator proposes, human promotes" | **done**, ruling 378 |
| 4 | A person can attach a file to a task (F39-6) | "Add human upload" | **done**, ruling 379 |
| 5 | The live run's console is disclosed on its card | "Disclose in place under the strip" | **done**, ruling 380(a) |
| 6 | An advisory scope is not a policy violation (F39-5) | — | **done**, ruling 380(b) |
| 7 | `save_knowledge_base` takes `doc.append` (F39-3) | — | **done**, ruling 377 note |
| 8 | Operator doctrine: packet-vs-comment made testable (F39-7) | — | **done** |
| 9 | Controller doctrine: project bring-up, rulings currency, advisory caps | — | **done** |
| 10 | A C compiler in the image so `-race` can run | "Add a C compiler" | **done**, untracked Dockerfile layer |
| 11 | A manual move BACKWARD says why (F39-8) | "Required backward, optional forward" | **done**, ruling 381 |
| 12 | A state refusal is not a policy refusal (F39-10) | — | **done** |
| 13 | Compaction keeps a comment somebody was notified about (F39-9) | "protect any comment that notified someone" | **done**, ruling 382 |
| — | F39-2 (the model picker offers no plain `opus`) | — | **observed, not worked** — see below |

## Why F39-2 is not on the list

The live `supportedModels()` catalogue for this account offers `default`, `opus[1m]`,
`claude-fable-5-1[1m]`, `sonnet`, `haiku`; the curated fallback in
`model-catalog.server.ts` offers plain `opus`/`sonnet`/`haiku`. So which Opus is selectable
depends on whether the live fetch succeeded. The obvious worry — a profile already stored as
`opus` being silently rewritten to the catalogue default when the picker renders a list that
does not contain it — is already handled: `claudeModelRunsVerbatim`
(`app/shared/model-ids.ts`) exists precisely so a picker never rewrites a value the runtime
would run verbatim, and pass 34's F34-7 put it there. Nothing lies and nothing is lost; the
two lists simply differ. Left alone deliberately rather than churned.

## What was NOT changed, and why

- **The advisory capability rows themselves.** They stay in `project.md` and in the persona
  matrix. They describe the role, which is worth saying; what was wrong was shaping them
  like an authority in the one read an admin is told to make first.
- **`capabilityPatchRefusal`.** Checked before touching it: it already answers an advisory id
  with the right sentence, and the controller never called it — it reasoned from
  `get_project` alone. A better refusal would not have prevented the wrong answer.
- **The `checks:read` violation row itself.** Ruling 360 settled that it is worth recording;
  only the wording and the event type were wrong.
- **The operator's inability to archive a task.** It says so plainly when asked
  ("must be handled by the task-archive action") and `archive_task` is already a packet
  option kind it can propose. That is the designed shape, not a gap.

## Live validation

Each item is validated against the running instance through its own HTTP or MCP surface, not
by re-reading the test that covers it. `VALIDATION.md` records the commands and the answers.
