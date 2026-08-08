# Viberr — what to build next

This is the forward-looking half of pass 19. Everything else in this folder is about what is *wrong*;
this is about what is *absent*.

Method: five analysts (MVP completeness, journey walk-throughs, implied capability, operations,
product choices) each read the PRD, the 58 rulings and the code, then **every claimed gap was handed to
a separate agent whose job was to find the thing and prove the claim wrong**. 30 claims → **27 survived,
3 disproved**. Several survivors came back "partially exists" with the precise boundary, and those
corrections are folded in — they are usually the most useful part.

Full detail per item, with the grep/route/schema evidence: [`gap-analysis-result.json`](gap-analysis-result.json).

Nothing here is a defect. Defects are in [`NOTES.md`](NOTES.md), and the 45 found this pass are fixed.

---

## The one I would fix first

**Agent threads are not actually persistent** — the product's headline differentiator.

`resumeRun` exists and is excellent: it re-applies confinement, skills, MCP servers, persona and the
profile's current model, and it *pre-probes* provider transcript continuity so a dead session cold-starts
with an honest preamble instead of a crash. It has exactly two triggers, both human-shaped: an
`@mention` reply, and R15-14's resolved `ask_human` packet.

**The operator cannot pull it.** `run_agent` and `prompt_agent` always cold-start. And a cold start
receives no canonical anchor — `buildAnalyzePrompt` carries role, goal, repo contract and directive, but
no timeline, no prior verdict, no decision history. The specialist MCP surface has three tools
(`post_comment`, `ask_human`, `report_outcome`) and no task-read tool, and the run's cwd is deliberately
the workspace, never the task dir — so there is no pull-side substitute either.

Consequence in the loop that runs every day: reviewer requests changes → operator re-prompts the
deliverer → reviewer re-reviews. Each of those is a brand-new agent knowing only what the operator
retyped. The reviewer cannot tell whether its own request was honoured. The deliverer does not know why
it made the choices sitting in its own branch. Continuity is carried entirely by operator prose — the
"rebuild context from scattered notes" problem the product exists to remove.

> **FR22** promises threads resumable "across stages and later consultations"; the Differentiators
> section sells "persistent specialists… materially different from stateless automations". Not on the
> deliberate-divergence list.

Two changes close it, both following a shape already ruled correct in R15-14: pass `canonicalTaskAnchor`
into every fresh run, and give the operator's run/prompt tools the same resume-if-a-session-exists
branch `commentToAgent` already has.

---

## Journey 4 barely exists

The PRD's fourth journey — Murat investigating a continuity failure — is the one that makes runtime
failure feel governed rather than broken. Pass 18 added the `continuity` typed event. That is the whole
of it.

- **Nothing calls anyone** (gap 5). No board cue, no Current-state row, no notification, no filter. The
  journey opens with Murat being *called into* the task; in the shipped app detection dies in one
  timeline row and discovery is accidental.
- **Nothing states what survived** (gap 6). No panel separating what is known, missing, and still
  authoritative; no recovery choices; no operator turn queued to produce the summary the journey
  describes. The app silently auto-rehydrates and moves on.
- **Nothing lets a human verify the rehydration** (gap 8) — you cannot see what the agent was actually
  given, so "I confirmed the task file holds enough to continue" is not a check anyone can perform.

## The board cannot answer its own question

The board is specified as a triage-first console whose job is to say what needs a human.

- **No task shows how long it has been where it is, and nothing notices one that stopped moving**
  (gap 10). An operator turn that ended without queuing anything, a run that errored after writing, a
  task waiting on an agent nobody re-engaged — all look exactly like healthy work.
- **A declined recommendation leaves no trace** (gap 1). `dismissRecommendation` writes an audit row and
  nothing else: no timeline event, no note. The operator's next turn cannot see what it already proposed,
  so it proposes it again. Journey 2's loop can spin, and the durable record never says why the human
  said no.
- **The change summary counts files, never names them** (gap 7).

## One repo, many tasks — and no way to catch up

**Nothing anywhere integrates the base branch into a task branch** (gap 9) — no server action, no
operator tool, no button, no agent affordance. The moment a team runs two tasks against one repo (the
normal case, since FR7 is one repo per project) the first merge puts every other open task behind. The
product *detects* this precisely — `behind_main`, `mergeable` — and then offers nothing.

## Running it for real

The self-hosted operator is not a persona the product serves (gap 23) — every operational act is docs,
logs and shell. The concrete holes:

| | Gap |
|---|---|
| **Upgrades** | No non-destructive path (13). The ledger is filename-only, the schema a re-squashed baseline, and nothing detects that the baseline changed under a migrated DB. **If you are near a first real deployment, freezing `0001_baseline.sql` and adding a content hash is a now-or-never decision.** |
| **Backups** | No tooling, and no way to take a *consistent* one without stopping the app (14). `projection.sqlite` is the only home of users, credentials, sealed PATs, audit and notifications — none of it rebuildable from the markdown. The product's own answer to FR33's 90-day hard delete is "snapshot the data root", which it gives you no safe way to do. |
| **Growth** | Retention and workspace reclaim run **only at boot** (15) — coupled to exactly the event a stable deployment avoids. No disk-space awareness at all (16). Raw transcripts and SDK session homes are never pruned (20). |
| **Visibility** | Health returns 200 while degraded and no admin surface shows it (17); the running app has no version identity (18). |
| **Safety** | The maintenance CLIs open the data root **without taking the single-writer lock** (19) — the one guard that exists against the dual-writer corruption this project has already suffered once. |
| **Secrets** | Key rotation can never be finished: no re-encrypt pass, no count of secrets still on the old key (21). |
| **Repair** | No recovery path for a corrupted or badly hand-edited task file (22) — and the store is *designed* to be hand-edited. |

---

## Decisions only you can make

Fourteen questions came out of this. These are the six I would want answered first; the rest are in the
JSON under `owner_question`.

1. **Should a human be able to record the approving verdict?** (gap 24) Today `report-validation-verdict`
   is agent-only, so on a small team where the tech lead *is* the reviewer his options are to engage an AI
   reviewer he does not need, or to force-accept — writing an override row claiming he bypassed a gate he
   actually satisfied. Human review currently has to masquerade as an admin override, which pollutes the
   audit trail R15-1 exists to keep clean. *I would let a human record it, or admit a GitHub approval from
   a project member.*

2. **Should per-run autonomy be clamped to the project's policy?** (gap 25) `resolveOperatorAuthority`
   returns the override verbatim, so a maintainer on a Strict project can run one turn at full autonomy —
   converting every recommend-mode capability to direct execution — with no confirm, no distinct audit row,
   and only a toast. *I would clamp it and make raising it an audited, disclosed escalation.*

3. **Is the operator meant to resume, or always cold-start?** (gap 0) If cold-start is intended, the fresh-run
   prompt needs the canonical anchor. Either answer is coherent; the current state is neither.

4. **Should a continuity break open a real packet, or just a panel?** (gap 6) Auto-rehydrate-without-asking
   may well be right — but then Journey 4 should be rewritten to match, rather than left describing a
   recovery experience that does not exist.

5. **Should a human be able to correct a recorded agent claim?** (gap 12) Append-only is defensible; the
   current escape hatch is editing the file on disk, which is worse than either principled answer.

6. **Is agent spend deliberately out of V1?** (gap 26) Viberr already records cost per run and shows it
   nowhere, and nothing bounds unattended work — the scheduled-run feature means a task can spend money
   with no human present.

---

## Deliberately excluded

Phase 2/3 items (analytics, task graphs, richer profile templates), and everything on INTENT.md's
deliberate-divergence list — the per-task repo override, the sub-768px review-first mode, agent-created
tasks. Those are decisions, not gaps, and re-litigating them is how a roadmap becomes noise.

Three claims were **disproved** by the check and are recorded in the JSON rather than dropped, because a
false "this is missing" is the most expensive thing this document could contain. One of mine nearly made
it: I was about to file "evidence is not readable by humans" before finding that evidence is deliberately
a *citation* and the raw output lives in the run logs the guardrail points at.
