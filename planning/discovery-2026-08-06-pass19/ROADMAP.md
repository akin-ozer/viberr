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


---

## Build status (pass 19, round 5)

The owner's instruction was explicit: *"you may not cut corners, you may not defer to future work."*
So the roadmap is not a wish list — the unambiguous items are being built in this branch. The split:

### Building now — no product ambiguity
| Gap | Why it needs no decision |
|-----|--------------------------|
| **[0]** fresh-run canonical anchor (anchor half only) | The domain requirements say *"Any reactivated agent re-anchors on the canonical task artifact before acting"*, and FR22 promises continuation "even when prior runtime history is unavailable". Mandatory whichever way the resume question is answered. |
| **[1]** dismissal writes a typed event; operator sees its own pending recommendations | The canonical record is the operating contract; today it never learns the human said no. The optional *reason* field is a product choice and is NOT being built. |
| **[8] [11]** what a run was given is inspectable | Without it, "I confirmed the rehydration was adequate" is not a check anyone can perform. |
| **[10]** last-activity + stall signal | The board's stated job is to say what needs a human; a stalled task currently looks identical to a moving one. |
| **[14]** backup tooling with a consistent snapshot | `projection.sqlite` holds users, credentials, sealed PATs and audit — none of it rebuildable from the markdown. The product's own answer to FR33 is "snapshot the data root" and it provides no safe way to do that. |
| **[15] [20]** periodic retention + transcript/session pruning | Retention is documented as what bounds a long-lived deployment, but runs only at boot — the event a stable deployment avoids. |
| **[16]** disk-space awareness | A full disk during a task-file write is the corruption case this product cannot afford. |
| **[17]** health tells the truth when degraded | It returns 200 while degraded, so no monitor can act. |
| **[18]** version/build identity | You cannot currently tell which build is running. |
| **[19]** maintenance CLIs take the writer lock | **A live safety bug.** This project has already lost org tables to dual-writer WAL corruption once, and `PRAGMA integrity_check` passed before and after. The CLIs bypass the one guard against a repeat. |
| **[21]** finishable key rotation | Without a re-encrypt pass and a remaining-count, an operator can never know when it is safe to drop the previous key. |
| **[22]** recovery for a corrupted task file | The store is *designed* to be hand-edited (FR10), so a malformed file is expected, not exotic. |

### Held for the owner — genuine forks, listed with their questions above
**[2] [3] [4]** guardrail configuration surface and scope · **[5] [6]** how a continuity break should
reach a human (cue vs notification vs recovery packet) · **[7]** changed-file list vs density ·
**[9]** how a stale branch gets caught up (three viable designs) · **[12]** whether a human may correct
a recorded claim, or append-only is the contract · **[13]** whether to freeze the baseline now ·
**[23]** whether a System/Operations page should exist · **[24]** whether a human may record the
approving verdict · **[25]** whether per-run autonomy should be clamped to project policy ·
**[26]** whether agent spend becomes visible and bounded.

Each of these changes what the product *means*, not just what it does. Guessing would be worse than
asking — several are one-sentence answers.


---

## Owner rulings, 2026-08-08 — four forks decided

Asked mid-build, answered, and now being implemented. Recorded here because each changes what the
product *means*, and the rationale should outlive this branch.

| Fork | Ruling | What it means |
|------|--------|---------------|
| **[24]** who may produce the approving verdict | **Admit the PR's own GitHub approval.** | A project member's GitHub approval satisfies R15-1's gate — no new in-app review action, no force-accept masquerade. It must bind to the *delivered revision* (an approval on an older commit does not count) and the GitHub reviewer must map confidently to a Viberr member, or it fails closed. |
| **[25]** per-run autonomy | **Clamp to project policy.** | A run may never exceed the project's configured autonomy; raising it goes through project policy, which is already an audited admin act. Lowering for one run stays allowed — it is a ceiling, not a pin. |
| **[9]** stale task branches | **Operator-decided.** | The operator updates the branch when it judges it needed and opens a decision packet when it conflicts — mirroring R15-2 (delivery is an operator decision) and R18-4 (a branch collision stays human-gated; never force-reset a remote). |
| **[13]** schema baseline | **Not deployed yet — keep squashing.** | The re-squashed `0001_baseline.sql` stays for now. The content-hash guard is still worth adding so that the day a real deployment exists, a changed baseline refuses to boot instead of drifting silently. |

Still open: **[2] [3] [4]** guardrail configuration · **[5] [6]** how a continuity break reaches a human ·
**[7]** changed-file list · **[12]** whether a human may correct a recorded claim · **[23]** a
System/Operations page · **[26]** agent spend visibility and ceilings.


---

## Delivered in this branch

The 14 unambiguous gaps are built, tested, canaried and — where the app can show it — verified live.
Suite: **3242 tests / 239 files green, `tsc` clean.**

| Gap | Shipped |
|-----|---------|
| **[0]** anchor | Every fresh run carries the canonical task state; anchor hard-bounded at ~3.5 KB regardless of task size. Covers a first @mention, which cold-starts. |
| **[1]** dismissal | Declining a recommendation writes a typed timeline event naming what was declined, and the operator's snapshot carries its own pending + recently-declined cards so it stops re-proposing. Gave the `task.recommendation.dismissed` audit row its first reader anywhere. |
| **[8] [11]** run inputs | The Agent logs disclose what a run was actually given — anchor, resolved skills/KBs/MCP, and the grants whose content never arrived. One builder serves the fresh and resume paths so the two disclosures cannot drift. |
| **[9]** stale branch | Operator-decided `update_branch_from_base`, both backends. Merge never rebase (a rebase reaches the remote only by force-push, which R18-4 refused); conflict aborts and opens a packet; failed push resets to the pre-merge sha. |
| **[10]** stall | `MAX(occurred_at)`, *not* `updated_at` — the reconcile poller re-stamps `updatedAt` every 5 minutes, so a task dead a week read "updated 4m ago". 1h agent-waiting / 3 days human-waiting (clears a weekend), neutral tone, new "Gone quiet" chip. |
| **[14]** backup | `npm run backup` — `VACUUM INTO` from a read-only connection, so it folds in WAL content as ONE file and needs no downtime. Verified live: `integrity_check ok`, rows readable out of the artefact. |
| **[15] [20]** maintenance | Runs on a timer, not only at boot. Workspace reclaim skipped while runs are active; transcripts and session homes pruned, never outside the data root. |
| **[16]** disk | Absolute thresholds, transitions logged once, pressure triggers a pass. A failed atomic write no longer leaks its `*.tmp`, and ENOSPC says so in a sentence. |
| **[17]** health | `status`/`degraded` + `?probe=readiness` → 503. A never-checked backend is not degraded; unmeasurable disk is `null`, never a fabricated 0. |
| **[18]** identity | env → package.json → the checkout's git, file reads only. Absent identity is `null`, never "unknown". |
| **[19]** CLI lock | `rescan`, `seed`, `seed-demo` take the single-writer lock and fail closed naming the holder. **The one guard against the dual-writer corruption this project already suffered once.** |
| **[21]** key rotation | `npm run keys -- status\|reseal` — the count that tells you when dropping the previous key is safe. |
| **[22]** repair | `npm run store:check` names any untrusted file with its parse error and offending line — and `updateTaskFile` now REFUSES to write to one. Verified live: a tab-indented frontmatter made a comment 409 instead of resetting every field and destroying the goal and timeline. |
| **[24] [25]** rulings | A project member's GitHub approval satisfies the verdict gate, bound to the delivered revision and failing closed on an unmappable approver; per-run autonomy clamped to project policy, audited when it bites, with a selector that offers only what will run. |

**Still open for you:** [2] [3] [4] guardrail configuration · [5] [6] how a continuity break reaches a
human · [7] changed-file list · [12] whether a human may correct a recorded claim · [23] a
System/Operations page · [26] agent spend. Each changes what the product *means*; the questions are above.
