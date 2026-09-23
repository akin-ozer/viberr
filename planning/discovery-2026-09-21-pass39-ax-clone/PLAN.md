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
| 14 | A double-escaped body is repaired, not stored (F39-11) | — | **done**, ruling 383 |
| 15 | The acceptance card stops claiming a review nobody gave (F39-12 a/b) | — | **done**, ruling 384 |
| 16 | A required reviewer holds delivered work, not just commits (F39-12 c) | "hold it on any delivered work" | **done**, ruling 385 |
| 17 | The Settings badge counts violations, not advisories (F39-13) | — | **done**, ruling 386 |
| 18 | A move and its withdrawal land in order (F39-14) | — | **done**, ruling 387 |
| 19 | A non-commit delivery is reviewable like a commit (F39-15) | — | **done**, ruling 388 |
| 20 | Codex's transport prose classifies as a network failure (F39-16) | — | **done**, ruling 389 |
| 21 | The controller's grant request outlives its conversation (F39-17) | "surface a grant request to an admin" | **done**, ruling 390 |
| 22 | A non-commit task is not told its work went missing (F39-18) | — | **done**, ruling 391 |
| 23 | The standing verdicts ride in the agent's anchor (F39-19) | — | **done**, ruling 392 |
| 24 | The force dialog lists every gate it bypasses (F39-20) | — | **done**, ruling 393 |
| 25 | A completed turn is a completed run, on both adapters (F39-21) | — | **done**, ruling 394 |
| 26 | A figure the provider never reports is not a zero (F39-22) | — | **done**, ruling 395 |
| 27 | File leases get a human surface (F39-23) | — | **done**, ruling 396 |
| 28 | A report a failed run left standing is the operator's call (F39-24) | "the operator decides" | **done**, ruling 397 |
| 29 | A goal starts every link nothing makes wait (F39-25) | — | **done**, ruling 398 (+ b, c, d) |
| 30 | A plan Viberr refused is not a deliberate hold (F39-26) | — | **done**, ruling 399 |
| 31 | The plan-refused retry carries the refusals (F39-27) | — | **done**, ruling 400 |
| 32 | A finished task that committed nothing has no branch to be behind (F39-28) | — | **done**, ruling 401 |
| 33 | The operator sees the chain it is one link of (F39-29) | — | **done**, ruling 402 |
| 34 | A compaction size Viberr could not measure is not zero (F39-30) | — | **done**, ruling 403; premise corrected by 414 |
| 35 | A frozen goal header states only facts that cannot move (F39-31) | "stop claiming a total" | **done**, ruling 404 |
| 36 | A conflict verdict belongs to the head it was measured on (F39-32) | — | **done**, ruling 405 (+ b, c) |
| 37 | An operator that acted did not hold (F39-33) | — | **done**, ruling 406 |
| 38 | A never-commit-shaped delivery is not untraced (F39-34) | — | **done**, ruling 407 |
| 39 | A partly refused plan is carried too (F39-35) | — | **done**, ruling 408 |
| 40 | The plan schema may not contradict the guard (F39-36) | — | **done**, ruling 409 |
| 41 | Round two of a review deadlock is the operator's (F39-37) | "let the operator make the call" | **done**, ruling 410 |
| 42 | The op that unblocks a goal link starts it (F39-38) | — | **done**, ruling 411 |
| 43 | A refused transition says why and names the way forward (F39-39) | — | **done**, ruling 412 |
| 44 | The operator sees the cross-task PR collisions (improvement point) | owner: no deferral | **done**, ruling 413 |
| 45 | One Codex compaction is recorded once, with its measured size (F39-40) | — | **done**, ruling 414 |
| 46 | A person's decision never leaves the operator's view; a plan-only operator is never sent to a tool (F39-41) | — | **done**, ruling 415 |
| 47 | A rework the provider refused fought no round (F39-42) | "provider refusals don't count" | **done**, ruling 416 |
| 48 | GPT-6 Luna and Opus 5.5 for the agents (owner request) | "use gpt 6 luna and opus 5.5" | **done**: SDKs upgraded (Codex 0.156.0, Agent SDK 0.3.280), switched through the controller, verified live (VALIDATION §38) |
| 49 | The operator can lease files to its own task (improvement point) | "operator sets it directly" | **done**, ruling 417 |
| 50 | The rulings KB learns from review: missing conventions are proposed (improvement point) | "yes, missing conventions too" | **done**, ruling 418 |
| 51 | A deadlock packet never recommends re-asking an answer given earlier in the streak (AX-24) | within ruling 416 | **done**, ruling 416(b) |
| 52 | The controller page for the person using it (U39-1 to U39-6) | owner: "focus on UI improvements for end users, especially the controller page" (design calls made in the unattended run, marked for review) | **done**, ruling 419 |
| 53 | A done entry in a "waits on" list never reads as the pending one before it (F39-44) | — | **done**, ruling 420 |
| 54 | A review that puts the completeness question is recorded as its answer (F39-43) | — | **done**, ruling 421 |
| 55 | A run may read the knowledge-base folders its index points at (F39-45) | — | **done**, ruling 422 |
| 56 | Another task's PR named with a possessive is not a delivery instruction (F39-46) | — | **done**, ruling 423 |
| 57 | The operator reads where the branch refresh is refused before it plans (F39-47) | — | **done**, ruling 424 |
| 58 | Operator formatting renders on its cards; the packet note's example fits every packet (U39-7) | — | **done** (UI copy and rendering, no ruling) |
| 59 | A chain link says what holds it in words a person can follow (U39-8) | owner: "focus on the controller page" (design call, marked) | **done**, ruling 425 |
| 60 | The controller's working line reads as words, not tool ids (U39-9) | — | **done** (UI, no ruling) |
| 61 | The not-connected remedy is a visible, linked note on both composers (U39-10) | — | **done** (UI, no ruling) |
| 62 | The agent-log console is readable on a phone (U39-11) | — | **done** (UI, no ruling) |
| 63 | A lease that would park waited-on work is a person's call (F39-48) | — | **done**, ruling 426 |
| 64 | The reconciler records a never-pushed revision on the real API (F39-49) | — | **done**, ruling 427 |
| 65 | The base refresh honours file leases (F39-50) | — | **done**, ruling 428 |
| 66 | Small end-user UI fixes found in the unattended run (U39-12 to U39-16) | owner: "UI improvements for end users" | **done** (UI, no rulings) |
| 67 | The acceptance-stage refresh refusal applies to approved work only; a refused move says where the re-verdict is given (F39-51) | design call, marked | **done**, ruling 429 |
| 68 | A plan stops acting at the first decision it causes (F39-52) | — | **done**, ruling 430 |
| 69 | The operator reads the file leases that bind now (F39-53) | — | **done**, ruling 431 |
| 70 | A successful run withdraws a stall packet and nothing else (F39-54) | — | **done**, ruling 432 |
| 71 | An agent's recommendation mark decides the pill and leaves the title (U39-23) | owner: "UI improvements for end users" | **done** (no ruling) |
| 72 | The controller quotes times in the zone the page prints them in (U39-24) | owner: "UI improvements for end users, especially the controller page" | **done** (no ruling) |
| — | "A human cannot defer a task" (improvement point) | — | **withdrawn**: the control exists (FINDINGS) |
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
