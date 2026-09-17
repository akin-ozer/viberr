# Pass 37 — the controller and operator sweep

2026-09-17/18. The owner's ask: *"look at shopify clone controller behaviour and create
findings for controller, operator behaviour. Maybe improving knowledge bases, agent
instructions, mcp improvements."*

The board was finished when this started — 82 tasks done, 0 open, 82 merged pull requests on
`akin-ozer/shopify-clone` — so this is an autopsy, not an observation. The evidence is the
instance's own record: **2,317 run logs** under `docker-data/runtimes/`, **83 task files**, and
the 8,400-line rulings document.

Method, unchanged from the three earlier sweeps: measure how often a sentence or a mechanism has
ALREADY been wrong on the live board, then try to refute every candidate before believing it.
**Eight confirmed, rulings 339–346. Twelve refuted**, listed at the bottom with what killed them,
because a refuted candidate is worth as much to the next reader.

---

## The seam this sweep opened: the record of what a run was given

Six of the eight findings come from one place, and it is not a place I had looked before:
`run_inputs`, Viberr's own disclosure of what it handed a run. It is the header the Agent-logs
console expands, and P19-G8/G11 built it for one reason — *"nobody could check the claims the
product makes about a run"*.

It could not be checked either.

| | runs | disclosures |
|---|---|---|
| specialist (fresh) | 823 | 823 |
| specialist (@mention resume) | 11 | **0** |
| operator drive | 953 | **0** |
| controller turn | 71 | **0** |
| **total** | **2,317** | **834** |

And of the 834 that existed, **460 recorded a toolkit shorter than the one they ran with.**

The sweep found this by being misled by it. Investigating why ruling 283's `read_knowledge_doc`
looked unused, I read this field across 834 runs, found the tool in zero recorded toolkits, and
concluded it had never been mounted on a single specialist run. It had been mounted on 294. The
controller had named the same gap a week earlier, from the other side and unprompted:

> "I cannot measure what a run actually receives." — controller, 2026-09-15T03:32Z

---

## F37-175 · The record of what a run received was derived a second time — HIGH

**Ruling 339.** `run_inputs.tools.toolkit` was built from three booleans:

```ts
toolkit: input.toolkit
  ? [
      ...(input.toolkit.comment ? ["post_comment"] : []),
      ...(input.toolkit.ask ? ["ask_human"] : []),
      ...(input.toolkit.verdict ? ["report_outcome"] : []),
    ]
  : [],
```

`buildAgentToolkit` mounts on **six** independent gates. Measured across the pass:

| tool | its real gate | runs mounted | runs recorded |
|---|---|---|---|
| `github_read` | `collab.githubRead` | 460 | 0 |
| `read_board` | `tools.length > 0` | 307 | 0 |
| `read_knowledge_doc` | `kb.length > 0` | 294 | 0 |
| `report_outcome` | `verdict \|\| evidence` | 227 | 0 |

The last row is the sharp one. `report_outcome`'s gate is `verdict || evidence` and the record
read `verdict` alone, so an **evidence-only agent's single structured channel was mounted and
disclosed as absent**. That is not an incomplete list; it is a different rule wearing the same
name.

`buildAgentToolkit` now returns `toolNames`, taken from the definitions it just pushed. A toolkit
gains a tool by pushing it onto that array, so there is no second place to remember.

---

## F37-176 · A closed store said "failed unexpectedly", and eight runs read that as a hiccup — HIGH

**Ruling 340, completes 303.** Ruling 303 stopped `database is not open` reaching a model
verbatim. It answered:

> `get_task` failed unexpectedly and returned no answer. The details are in the server log.

True, and not the useful truth. **All eight runs that met a closed store retried**, and what they
left on the task — the record ruling 338 now points a person at — was:

- *"The store dropped a connection mid-turn. Retrying."* (SHOP-26)
- *"The dispatch hit a transient store error. Retrying."* (SHOP-37)
- *"The live state read failed. Let me retry."* (SHOP-45)

Twenty-one refused calls across `get_task`, `run_agent` and `read_board`, and not one of those
sentences says what happened. Viberr held the fact the whole time: `isDatabaseShuttingDown()` is
the same latch `runPersistDrained` reads one layer down, and `shutdownDatabase` raises it
synchronously inside the `finally` of the close, so it is already true by the time any tool
handler resumes.

The guard now spends it, says retrying cannot succeed, and names the task record as where the
rest of the account lives — promising nothing about re-invocation, which is ruling 338's
discipline one surface over. The shutdown arm is checked **ahead of `AppError`**: a refusal's own
words are a claim about live state read out of a store that has closed.

---

## F37-177 · The rulings document did not keep the convention it states about itself — MEDIUM

**Ruling 341.** Its own header:

> Several rulings have been narrowed or reversed by a later owner decision. Those are marked
> **SUPERSEDED** inline, with what replaced them and when… Never restore a superseded rule
> because you found the ruling text.

Seven rulings are named by a later one as narrowed, reversed or superseded. **Three said nothing
about it**:

| ruling | changed by | what the stale text still says |
|---|---|---|
| 20 | 59 narrows it | that a healthy verdict is required, without saying force-accept skips the review gate too |
| 193 | 204 reverses its counter | escalate on distinct REVISIONS — which in a deadlock sits at one forever, so the escalation never fires |
| 261 | 283 supersedes it | that `RULINGS_KB_FLOOR` reserves 8,000 characters; it has not existed in the source since that evening |

193 is why this is worth a ruling rather than an edit: it is the operator doctrine for a reviewer
that cannot pass, the half 204 reversed had a test defending it, and `CLAUDE.md` points every
agent working on Viberr at this file as the binding rulings.

It is unenforceable by reading, because the two ends of a supersession are written hours or weeks
apart and **only the new end knows**. So it is swept: `rulings-supersession.test.ts` reads every
numbered block for a claim about an earlier number and fails naming both.

---

## F37-178 · A tool description is a prompt, and nothing was reading it — LOW/MEDIUM

**Ruling 342.** Ruling 336's new `releases` paragraph shipped into `list_decisions` with its
closing sentence pasted twice:

> `kind` and `notAcceptableReason` carry that other half. `kind` and `notAcceptableReason` carry
> that other half.

A 1,900-character description, assembled from adjacent string literals, that every controller
turn reads. Six hours old, and mine.

These strings are the only agent instructions in the product with **no human reader at all** — a
persona is reviewed in its editor, a knowledge-base document is opened by a person, a packet body
is read on a card. So the one property a careless edit produces is now swept across the five
surfaces that hand descriptions to a model.

The first draft of the check was wider and wrong: it split on statements, swept three sibling
`.describe()` calls into one text, and called *"Omit to keep the deployment's grants; [] clears
them."* a duplicate. It is said once per field, about that field, and saying it three times is
correct. The check joins a `+` concatenation chain and nothing else — exactly one string as the
model receives it.

---

## F37-179 · The @mention resume disclosed nothing, and its test asserted the record was BUILT — HIGH

**Ruling 343.** `resolveResumeConfinement` has always returned `runInputs`, and its docstring has
always said the caller *"passes the whole thing to `recordRunInputs` once `resumeRun` has minted
the run id"*.

No caller did. `recordRunInputs` had exactly one call site, on the fresh path, and the field had
**no reader anywhere in the application** — declared, built twice, read never. So every @mention
resume, which is the door a *person* uses to talk to an agent, ran with no record of what it
carried: eleven runs on this board, one of them that morning.

The four fields the resolver cannot own are all in scope at that call site, because it is the
function that composes the prompt — `promptChars`, the canonical `anchor` it just attached, the
spend cap, and the one that exists only on this door: a `directive` naming the person who wrote
it.

**And the resume half had a test.** It asserts `resolveResumeConfinement` returns the same record
the fresh path builds, and its comment explains that the caller hands it on; nothing asserted
that anything did. A test that stops at the last honest step is how this survived — rulings 329
and 338's shape, a third time in one pass, and all three mine.

---

## F37-180 · Neither coordinator disclosed anything — HIGH

**Ruling 344.** The table at the top of this document. `recordRunInputs` lived in
`specialist-run.server.ts`, and **that is why this lasted**: disclosing anything would have meant
the operator and controller importing the specialist runtime, a direction this codebase has
already refused once — `KB_PRECEDENCE_NOTE` was moved out of there for exactly that reason. A
run's disclosure is a property of a RUN, so it now lives beside the run store.

What it costs to not have it, concretely: **ruling 261's live incident was an operator receiving
`standing-corrections.md` cut off mid-word at "fails in about thr"**, losing two of its three
rules. That was found by reading code. There was no record to read.

Both coordinators build the record ruling 339's way — off the resolution the prompt was assembled
from, in the same call — and both name their real tool surface: the Claude drive and the
controller from the definitions their toolkits just built, the Codex drive from its plan envelope,
which IS its action surface. Where a field does not apply it says so rather than guessing: neither
has a checkout, and `anchor` is null rather than a prompt pasted into an anchor field.

The controller's is written where the fresh path and the resume **join**, because a controller
resumes on every turn after the first — recording only fresh starts would have disclosed one turn
per conversation, which is F37-179 in a second place.

**Two fixtures had to be corrected, and they are this sweep's own shape once more.** Both faked a
completed Codex drive by writing its plan line at a hard-coded `seq: 0`, where the real sink calls
`nextSeq`. A run now carries the disclosure at seq 0, `insertRunLine` is `ON CONFLICT DO NOTHING`,
so each fixture silently dropped its own plan line and 26 tests read as *"the operator planned
nothing"*. They now number lines the way the thing they imitate does.

---

## F37-181 · Eleven deploys, none of them identifiable — MEDIUM

**Ruling 345.** `build-info.server.ts` exists because *"every upgrade/rollback instruction in
docs/operations/deployment.md ('redeploy the previous image') assumes the operator can tell two
builds apart at runtime; none of them was verifiable"*. It resolves identity from env first and
says why: `.dockerignore` excludes `.git`, so its file-reading fallback cannot fire in an image
and **env is the only source a container can have.**

The Dockerfile declared all three ARGs and promoted each to ENV. The runbook documented a
four-line `--build-arg` incantation. `compose.yml` said `build: .` and passed none of them — so
the DEFAULT deploy could not stamp, and stamping was a thing to remember.

Nobody remembered. Every container on this instance has reported:

```json
"build": { "version": "0.19.0", "revision": null, "revisionSource": null, "builtAt": null }
```

`0.19.0` is identical for every build of the release, so the probe could not distinguish two
images. Eleven deploys on 2026-09-17 alone, none stamped.

It cost the pass directly, which is why it is a ruling rather than a chore. A killed build left
me unable to say whether the running container held the new image or the 17:30 one; I inferred it
from `docker compose ps` uptime and a `ps` on the build process, because the surface built to
answer exactly that returned a constant and three nulls.

`compose.yml` now passes the three args interpolated with empty defaults, so a bare
`docker compose build` still works and is still honestly unstamped. `npm run deploy` fills them
from git and **reads `/resources/health` back**, refusing to report success unless the running
instance names the sha just built — the failure was never "which sha did I build" but "is the
thing answering the port the thing I built". Verified live:

```
deploying 0.19.0 @ c89ba82720a0 built 2026-09-17T19:28:56.520Z
serving   0.19.0 @ c89ba82720a0 (env) built 2026-09-17T19:28:56.520Z
ok — the running instance reports the build that was just made.
```

Three ends have to agree — the module READS a name, the Dockerfile DECLARES it, the compose build
PASSES it — and only the middle one was ever checked. The new test asserts all three against each
other, derived from the module's own `env.VIBERR_BUILD_*` reads.

---

## F37-182 · Ruling 344 put two false sentences into the surface it exists to make trustworthy — MEDIUM, and mine

**Ruling 346, corrects 344.** Found by checking my own work against pass 24's failure mode —
a fix wired into a seam whose prose assumed the old callers.

Two rows of the disclosure describe an absence, and 344 gave that absence two new meanings within
the hour. A coordinator legitimately records `cwd: null` and `anchor: null`. So on the first
coordinator run to reach the console, it would have printed:

| row | what it would have said | why it is false |
|---|---|---|
| `workspace` | "no repository attached to this project" | the project has one; the operator has no *checkout* of it |
| `anchor` | "It saw the goal and its directive only" | a Claude drive's first act is `get_task`; a controller turn is bound to no task |

`runInputRows` now takes the run's `kind`, which the panel already had and already used elsewhere.
A stored line from before this carries no kind and keeps the specialist reading, which is what
those lines were. A real anchor still prints verbatim whatever the kind — the absence is the only
thing this touches.

---

## Refuted

Eleven candidates died. Each is here with what killed it, because the answer to "has anyone
checked this?" is worth as much as a fix.

| candidate | what refuted it |
|---|---|
| A task's completion event is stamped before events it is displayed above — 9 inversions in 5,525 events, one by 8.7 seconds | **Ruling 327, mine, earlier the same day**, and its docstring cites the very task I re-found (SHOP-77). Every inversion predates it; zero after. |
| Ruling 286's report obligation is a prompt paragraph the model walks past — "93% never stated which rulings sections they relied on" | **My regex.** It read `report_outcome` only. Including the final report, which is recorded beside it, the real figure is **238 of 303 stated them — 21% silent**. Ruling 286 holds. |
| `list_runs` refused the controller's `status` argument | Ruling 296 working exactly as designed — it is the refusal, not a gap. |
| The operator planned `update_branch_from_base` on already-current branches — 37 times | All 37 fall on 09-13/09-14; the last is 09-14T03:59Z. F37-11's `baseBehindBy` fix ended them. |
| `kb-architecture` was flagged unhealthy on 143 runs | The run is told the reading's AGE and the server is still mounted — the disclosed-honesty posture, ruling 278's sibling. |
| A cached MCP health verdict has no `lastCheckedAt` (the controller's own 09-15 flag) | Ruling 278 added `lastCheckedAt` and `warmingSince` to the row and told the tool to probe rather than relay a stale red. |
| The Codex KB channel is broken — every `kb-*` MCP call returned `-32601` | Those five calls were `resources/list` against a filesystem MCP that implements `tools/list`. Viberr's own probe uses `tools/list`. The 14 real calls succeeded. |
| Ruling 283's promise that "the index prints the folder's path" is unkept for Codex | It prints ``Folder `<dir>`.`` — a real container path a Codex run can read. Unexercised (no Codex specialist ran after 283), not broken. |
| `createBackup` has no production consumer | `scripts/backup.ts` / `npm run backup`. My sweep only scanned `app/`. |
| `DEFAULT_NOTIF_PREFS` is dead | A test-facing alias for `defaultNotifPrefs()`, which production uses. |
| The controller cannot edit a task title ("and the board is wrong right now because of it") | Ruling 295 added `title` to `update_task`, behind the goal's own gate. |
| The controller's `releases` count is transitive and over-states what a decision frees | Ruling 336, shipped 83 minutes after the controller raised it, split `releases` into `direct` and `downstream` and says only `direct` is a number about this click. |

Five controller tools were never called in 71 turns — `create_user`, `invite_member`,
`schedule_task_action`, `set_task_owner`, `update_user` — and one operator tool, `set_goal`. All
six are unexercised rather than unusable: 46 of the controller's 51 tools and 16 of the operator's
17 were used in anger.

---

## What the refutation rate says

| sweep | confirmed / examined |
|---|---|
| 1 | 16 / 26 (62%) |
| 2 | 5 / 21 (24%) |
| 3 | 2 / 14 (14%) |
| **4 (this one)** | **8 / 20 (40%)** |

The rate went back UP, and the reason is worth recording: sweeps 2 and 3 kept working the same
seam — sentences shown to a person, checked against the code behind them — and that seam is
genuinely thin now. This sweep opened a different one by asking a question about the record
rather than the prose: *can the product's own audit trail be trusted about itself?* Five of six
findings came out of that one question.
