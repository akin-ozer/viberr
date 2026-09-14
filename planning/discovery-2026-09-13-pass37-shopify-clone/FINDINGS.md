# Pass 37 — findings ledger

Live pass: viberr's controller builds a microservices Shopify clone in
`akin-ozer/shopify-clone`. Observer: Claude (Opus 5). Started 2026-09-13T06:12Z.

Instance at start: 0 projects, 1 user (`arda@viberr.dev`, org admin), 1 GitHub connection
(`akin-ozer`), 2 agent profiles + operator, 1 KB, 0 MCP servers, 4 skills.
Controller set to `opus[1m]` / `high` by the owner (verified on disk in
`agents/profiles/controller.md`). Every other agent is required to run Codex
`gpt-5.6-luna` / `max`.

Severity: **blocker** (no way forward) · **high** (viberr lies, loses work, or forces an
absurd act) · **med** (real but survivable) · **low** (worth fixing, not urgent).

---

## F37-1 · WITHDRAWN — the console already collapses telemetry, honestly

**What I first claimed.** The controller's first turn wrote 66 run-log rows and 41 of them —
62% — were `{"ev":"meta","tag":"system·thinking_tokens","text":"thinking_tokens"}`, one per
100 thinking tokens, with no value in the display line. I called it observability noise and
unbounded growth.

**Why it is not a finding.** Both halves failed on inspection.

1. *The console does not drown.* `app/features/runtime/log-noise.ts` already folds consecutive
   telemetry rows into a single entry reading "N telemetry events (system·thinking_tokens):
   token and rate-limit accounting, hidden here; `{ } raw` shows them". It was built for
   exactly this (P14-WL-02), it covers Codex's `rate_limit_event` too, and its own docstring
   states the posture I would otherwise have argued for: *"The stored line is never touched …
   Hiding without saying so would be the same dishonesty in the other direction."* Deleting
   the stored row would break the `{ } raw` contract — "what the provider sent".

2. *The growth is not unbounded in any meaningful sense.* Measured across the whole pass
   rather than one early turn:

   | | rows | bytes |
   |---|---|---|
   | all run-log lines | 1917 | 4,602,386 |
   | telemetry lines | 245 (12.8%) | 70,187 (1.5%) |

   The 62% was a single short controller turn that happened to be almost all thinking. It is
   not representative and I should not have generalised from it.

**Kept in the ledger deliberately.** A withdrawn finding is worth as much as a confirmed one
to whoever reads this next: the answer to "why does the console show telemetry rows at all"
is that it doesn't, and the answer to "should we stop storing them" is no.

---

## F37-2 · A task held by `blockedBy` still runs agents — viberr says "held", then works it — HIGH

**What happened, to the second.** SHOP-2 ("Identity service") is link 1 of goal chain 2. The
controller declared it as waiting on the foundation chain. Its timeline, oldest first:

```
06:21:05.478Z  assign      Took task ownership by creating the task.
06:21:24.683Z  transition  operator moved SHOP-2 from Triage to Design.
06:21:53.414Z  note        Waits on goal-1 link 5 (added goal-1 link 5).
                           Held until every entry is done; Viberr releases it then.
06:21:54.000Z  comment     @Platform Architect Design SHOP-2's identity service slice …
06:21:54.033Z  agent       Deployed **Platform Architect** (Codex) as the delivering agent.
06:21:55.301Z  agent       Started a Codex run for the Platform Architect agent.
```

1.9 seconds after viberr wrote "Held until every entry is done; Viberr releases it then", it
started a real, billable Codex run on that task. Store state at the time:

```
SHOP-2 | design | readiness=blocked | waiting=agent | blocked_by=["goal-1 link 5"]
run_X8SEzbKT | SHOP-2 | Platform Architect | running
```

The board renders it blocked. The agent is writing code.

**Why it matters.** This is the load-bearing mechanism for the entire multi-agent
coordination strategy — the controller's whole anti-collision design (see `SETUP.md`) rests
on `blockedBy` actually holding work back until the foundation lands. It does not. So the
identity service was being designed against a monorepo skeleton that did not exist yet, and
nothing in viberr stopped it. It also **lies**: the record says held, the machine works.

**The mechanism — the hold is enforced by asking the model nicely.** Ruling 131(d) *does*
gate the operator, but only partially, and the dispatch not at all. Three layers:

1. **`runOperator` refuses three triggers** (`operator-run.server.ts:1534`):

   ```ts
   const HELD_TRIGGERS: ReadonlySet<string> = new Set(["create", "transition", "scheduled"]);
   if (HELD_TRIGGERS.has(input.trigger ?? "manual")) {
     const held = readTaskFile(…)?.parsed.frontmatter.blockedBy ?? [];
     if (held.length > 0) return { … refused: "blocked-by" };
   }
   ```

   Good as far as it goes — "no run, no cost". But every *reactive* trigger (`agent-reply`,
   a human comment, a resolved packet, a goal edit, a PR change, a manual run) is explicitly
   allowed through: "Reactive triggers still run under the held doctrine."

2. **The "held doctrine" is prompt text** (`operator-run.server.ts:3751`). What actually
   stops a held task being worked is this sentence, handed to the model:

   > This task waits on other work (…) and Viberr is holding it: answer them, but **do not
   > advance the stage, dispatch delivery work**, or open a packet about the wait.

   That is an instruction, not a gate.

3. **`startAgentRun` has no hold gate at all** (`specialist-run.server.ts`, ~line 1215). It
   checks exactly one thing — task closure:

   ```ts
   const closure = dispatchBoard ? taskClosure(existing.parsed.frontmatter, dispatchBoard.stages) : …;
   if (closure.closed && dispatchBoard) throw AppError.validation(closureRefusal(…));
   ```

   Its own comment records why that one was added: "the dispatch checked nothing, so an
   abandoned task could still start a real, billable run that wrote to its workspace and its
   timeline" (ruling 177, pass 36). The identical hole for a dependency hold was never closed.
   So **every other door** — the operator's own `run_agent`, the controller's `run_agent`
   tool, and the task page's Run-an-agent control — starts a real run on a held task.

`app/server/tasks/dependencies.server.ts` calls itself "the ONE writer for a task's
`blockedBy` list, and the two halves of its release" — and that is exactly what it is: it
implements the release half thoroughly and the *hold* half not at all.

This sits badly against viberr's own stated invariant that authorization is server-side
(`app/shared/rbac.ts` for humans, `app/shared/capabilities.ts` for agents) and that "no
optimistic UI for governed state". The hold is the one governed rule enforced by prompt.

**Severity: high.** Viberr lies about the state of governed work, and the lie silently
defeats the sequencing a user (or the controller) deliberately set up.

**How it ended, and why it is worse than a wasted run.** The Platform Architect ran to
completion on the held task. Its two closing timeline entries, in this order:

```
comment  Designed and committed the SHOP-2 identity slice: users, rotating refresh-token
         families, password resets, transactional outbox, RS256/Argon2id configuration,
         endpoint/error semantics …
comment  @Arda SHOP-2 is held pending goal-1 link 5; Viberr will release it when that
         dependency is complete.
```

Viberr committed a full service design, and then told the human the task was held. Both
sentences are in viberr's own voice, in the canonical record, seconds apart.

Final state: SHOP-2 `readiness=blocked`, `waiting=none`, with a real remote branch `shop-2`
carrying committed work — **cut from the bootstrap `main`, before the foundation chain has
landed a single file.** When goal-1 link 5 finally completes and viberr "releases" SHOP-2, its
branch is based on a `main` that predates the monorepo skeleton, the shared packages, the
compose stack and the CI the identity service is written against. That is precisely the
collision `blockedBy` exists to prevent, manufactured by the mechanism meant to prevent it.

**Watch item attached.** Whether the operator is also *woken* for a held task — on SHOP-2 four
operator runs fired while it was held, so each hold appears to burn paid operator turns too.

---

## F37-3 · `get_project` hands the controller raw stage ids the board resolves differently, and the controller misreported the instance to its owner — med

**What happened.** In its setup report the controller told the owner:

> "(Their seeded stage ids are `ready`/`impl`, which don't exist here, so Developer is
> effectively unselectable — the six real profiles carry the work.)"

That is **false**, and viberr's own audit trail proves it. On SHOP-1 at stage `design`:

```json
task.operator.agent_selected · SHOP-1
  candidates: [{"profileId":"developer","eligibleForStage":true, …},
               {"profileId":"reviewer","eligibleForStage":false, …}]
```

Developer *was* eligible. Ruling R14-1's `resolveDeclaredStages` remaps a declared id that
is absent from this board onto the board stage filling the same structural role, so
`ready`/`impl` resolve onto real stages here. The Agents page renders exactly that, honestly:
**"2 of 6 stages"**, Design and Review lit, Triage/Build/Verify/Done struck through.

**The mechanism.** Three call sites resolve declared stages against the board —
`agents-page.tsx`, `execution-profile.tsx` and the server's own dispatch gate in
`specialist-run.server.ts`. The controller's read is the one that does not.
`assembleAgentRoster` (`app/features/agents/agents-query.server.ts:529`) returns

```ts
stages: def?.stages ?? template?.stages ?? [],
```

— the raw declaration — and `get_project` (`controller-toolkit.server.ts:1081`) passes it
straight through as `stages`. So the human surface and the agent surface answer the same
question differently, and only the human one is right.

This is sharpened by `get_project`'s own tool description, which promises:

> "deployed agents with their **RESOLVED grants** (every catalogued capability id at the mode
> the runtime applies …)"

Grants are resolved. Stages, sitting in the same payload, are not.

**Why it matters.** The controller is the instance's conversational manager; what it reports
is what a non-technical owner believes. Here viberr's API led its own agent to tell the owner
that two of the nine deployed profiles were dead, when they were live. A controller acting on
that belief would also route work away from perfectly eligible agents.

**Severity: med.** Behaviour is correct; the *reported view* is wrong, and it is wrong in the
surface a human trusts most.

**Fix shape.** `get_project` should report board-resolved eligible stages (and say when a
declaration was remapped), using the same `resolveDeclaredStages` the UI and the dispatch gate
already share. `list_global_agents` is global scope and may keep raw ids.

---

## F37-4 · The MCP write-tool heuristic misses `edit_file` and `move_file` — low

**What happened.** I added a credential-free stdio MCP server in Org settings
(`kb-files` → `npx -y @modelcontextprotocol/server-filesystem /data/kb`). The real handshake
ran on save and discovered 14 tools. Viberr pre-selected the write tools for me and said why:

> Selected because their names hold **create, delete, merge, push, update, write or remove**.
> Review them before you save.

It selected `write_file` and `create_directory`. It did **not** select `edit_file` or
`move_file` — both of which write, one of which can clobber a path. The discovered set was:

```
read_file  read_text_file  read_media_file  read_multiple_files
write_file*  edit_file  create_directory*  list_directory
list_directory_with_sizes  directory_tree  move_file  search_files
get_file_info  list_allowed_directories          (* = preselected)
```

**Why it is only low.** Viberr does not lie about this. The dialog says "Review them before
you save", and the standing caveat under the field says "Viberr makes no claim about the tools
you leave unselected". The heuristic is advertised as a heuristic, and marking the two extras
took one click each. After saving, the row read honestly: "14 tools · checked just now ·
**4 write tools withheld from read-only runs**", and ruling 176's gating worked.

**Why it is still worth fixing.** The default is what most admins will accept, and the two
verbs it misses are the two most common non-`write` spellings for a mutation across real MCP
servers (`edit`, `move`, plus `rename`, `patch`, `append`, `set`, `put`, `insert`, `upsert`,
`drop`, `truncate`, `exec`, `run`). An agent that viberr believes holds no repo write would
keep `edit_file` and `move_file` on an MCP server the admin accepted as-is. The fix is one
word list.

**Where.** `WRITE_VERBS` in `app/shared/mcp-tools.ts` — a seven-word set consumed by
`looksLikeWriteTool`, which `resource-modals.tsx:184` uses to pre-tick the editor:

```ts
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "create", "delete", "merge", "push", "update", "write", "remove",
]);
```

The word-splitting around it is already good (`createOrUpdateFile`, `create_or_update_file`
and `create.or.update.file` all read the same, and `pushed_at` correctly does not match
`push`), so the fix is purely the vocabulary: add at least `edit`, `move`, `rename`, `patch`,
`append`, `put`, `insert`, `upsert`, `replace`, `set`, `drop`, `truncate`. Tests live in
`app/shared/mcp-tools.test.ts`, which already has positive/negative name tables to extend.

---

## F37-5 · `get_task` hands the controller a stage-filtered column without the stage filter — med

**Found by the controller itself**, reading its own board. Asked for a status report, it wrote:

> Its `blockReason` also reads "Required reviewer Code Reviewer (project rule at Review) has
> not approved revision 3aad6ff" on a task sitting in Design, which is a Review-stage message
> leaking onto a pre-Review task.

Verified in the store:

```
SHOP-2 | design | changed | Required reviewer Code Reviewer (project rule at Review) has not
                            approved revision 3aad6ff. Run the review at Review, or an admin
                            can force-accept.
```

SHOP-2 is at **Design**, three stages before Review, and is not up for acceptance at all. The
sentence nonetheless tells the reader to run the review or **force-accept** — an action that
is meaningless at Design.

**The mechanism.** `validation_block_reason` is *documented* as stage-unaware. Its docstring
in `app/server/projections/rebuilder.server.ts` (`acceptanceBlockReason`) says so plainly:

> THREE of its gates stay out: `archived`, the STAGE boundary, and the no-change WORK refusal
> … The first two are per-reader state — **every consumer filters rows on `archived = 0` and
> on the resolved review stage before it ever looks at this column.**

The human surfaces honour that contract. `boardAcceptRefusal`
(`app/features/board/board-page.tsx:1200`) asks the stage question *first* and returns before
`blockReason` is ever reached:

```ts
archivedTaskBlockedReason(task, task.key) ??
closedPrBlockedReason(task, task.key) ??
(task.atAcceptanceBoundary ? null
  : `${task.key} is at ${fromStageName}, not the boundary the workflow puts before ${terminalName}. …`) ??
task.blockReason ?? …
```

The controller's `get_task` (`controller-toolkit.server.ts:1200`) does not. It returns the
whole summary verbatim — `return json({ task: summary, schedules, newestEvents: events })` —
so the raw column reaches the model as if it were the answer. The summary already carries
`atAcceptanceBoundary` (that is the field the board uses), so the information to filter is
right there, unused.

**Why it matters.** Same failure as F37-3, same family: **the agent-facing read skips the
resolution the human-facing read applies.** A controller reporting to an owner, or deciding
what to do next, reads a confident sentence that is wrong about the stage and recommends an
action (`force-accept`) that the server would refuse. Here the controller was sharp enough to
flag it as suspicious rather than repeat it; that is luck, not design.

**Fix shape.** `get_task` should apply the same precedence the board does before emitting
`blockReason` — reuse the shared predicates rather than re-deriving — or omit the field and
emit a resolved `acceptance: { canAccept, reason }` instead. Whichever, one spelling shared
with the board.

---

## F37-6 · The controller cannot see ruling 176's write-tool marking, so it refuses grants it should make — med

**What happened.** I marked 4 of `kb-files`'s 14 tools as write tools in Org settings; the row
then read "14 tools · checked just now · **4 write tools withheld from read-only runs**". I
asked the controller to grant the server to the reviewers. It refused, and its second reason was:

> **I cannot withhold the write tools.** There is no per-tool filter anywhere in my surface:
> `save_global_agent` takes `mcps` as a flat list of grant keys, and the capability catalogue
> (`list_capabilities`) has no MCP-tool-level id. Granting `kb-files` grants all 14 tools,
> including the 4 write ones. Nothing about the marking in Org settings propagates into the
> agent's runtime through any control I hold — **if Viberr enforces that marking, it does so
> somewhere I cannot read, and I won't assert that it does.**

Every clause of that is correct, and the conclusion is the right one to draw from the
evidence available to it. But the premise is false in fact: viberr **does** enforce the
marking, at mount, on both backends (ruling 176 — by name on Claude, as `disabled_tools` on
Codex). The controller simply cannot see it.

**The mechanism.** `list_mcp_servers` (`controller-toolkit.server.ts:663`) emits:

```ts
grantKey, id, name, transport, target, up, tools, hasCredential, lastError
```

`tools` is the raw discovered count/list. There is no `writeTools`, no "N withheld from
read-only runs", and nothing anywhere in the 40-plus tool surface that names ruling 176. The
human sees the enforcement stated on the row; the agent that performs the grant does not.

**Why it matters, and why this one is different.** F37-3 and F37-5 made the controller
*report* something wrong. This one changed what it *did*: it declined a grant that was in fact
safe, and told the owner to go and re-architect the server first. A governance agent that
cannot observe a governance control will always reason to the conservative wrong answer — and
"I won't assert that it does" is exactly the behaviour we want from it, which makes the
missing field, not the caution, the defect.

**The family.** F37-3 (raw stage ids), F37-5 (unfiltered `blockReason`) and F37-6 (absent
write-tool marking) are one root cause: **the controller's read tools return less-resolved
data than the human surfaces render, with no marker saying so.** The fix should be taken as a
family, not three patches: every controller read that mirrors a human surface emits the
resolved value that surface shows.

**Fix shape.** Add `writeTools: string[]` (and a one-line derived note) to `list_mcp_servers`,
and state in the `save_global_agent` / `update_agent_deployment` tool descriptions that
marked write tools are withheld automatically from any run without
`execute-code-or-write-repo` and from every operator run.

---

## Observation (not a defect) · The controller was right about my mount, and about the blast radius

Its first and third reasons for refusing were sound product judgement I had got wrong:

> `/data/kb` is the root of the whole KB store … So a granted agent gets read access to every
> KB in the org regardless of its own grants, and **write access to the files that are
> injected as trusted configuration into the other agents, the operator, and me. A reviewer
> that rewrites the conventions KB changes the standard the next reviewer is judged against.**

That is a real prompt-injection/privilege path and I had not considered it when I chose the
mount. It also corrected my premise: in this project the Code Reviewer deployment holds
`execute-code-or-write-repo: direct` (with `create-task-branch`, `commit-push-branch` and
`open-review-pr` all `off`), so "a reviewer that holds no repo-write grant" did not describe
the reviewer actually running. Both corrections checked out.

---

## F37-7 · The controller can create an MCP server but never govern it — every one it creates is unmarked — med

**What happened.** I told the controller to create the narrowed MCP servers itself rather than
asking me to. It did, correctly and well — then reported:

> **Could not do — no write-tool marking in my surface.** `save_mcp_server` takes only name,
> transport, target and an optional id; there is no parameter for the marking, and
> `list_mcp_servers` still doesn't return it. So `kb-architecture` and `kb-conventions` were
> created **unmarked**.

Verified in the store — the server I made through Org settings against the two it made
through its own tool:

```
kb-files        ->  [{"name":"write_file","gate":"repo-write"},{"name":"create_directory",…},
                     {"name":"edit_file",…},{"name":"move_file",…}]
kb-architecture ->  (null)
kb-conventions  ->  (null)
```

**The mechanism.** `save_mcp_server` (`controller-toolkit.server.ts:682`) accepts exactly four
fields — `id?`, `name`, `transport`, `target` — and calls `saveMcpServer` with no
`writeTools`. The underlying writer *does* take them (`writeTools?: readonly string[]` at
`app/server/org/resources.server.ts:1609`); the tool simply never passes any. Meanwhile the
human path pre-ticks a suggestion from `looksLikeWriteTool` and shows the result on the row.

**Why it matters.** This is the governance hole the read gap (F37-6) implies. An org admin
creating a server through the UI gets a default marking they can review. The same admin
asking the controller to create one — the workflow viberr actively encourages, since the
controller is the instance's manager — gets a server where **every tool, including every
mutation, reaches every run that mounts it**, with nothing on any agent-facing surface to
reveal it. The controller cannot set the marking, cannot read it back, and cannot warn about
it beyond noticing its own blindness.

**Not a silent wipe, at least.** On update the sentinel is honoured —
`input.writeTools === undefined ? undefined : checkedWriteTools(...)` means "leave unchanged" —
so a controller edit to an existing server does not strip a marking a human set. The gap is
creation-only.

**Fix shape.** Give `save_mcp_server` a `writeTools?: string[]` parameter; on create with the
parameter absent, apply the same `looksLikeWriteTool` default the editor pre-ticks (so the
controller's servers are no less governed than a human's), and return the resolved marking in
the tool's reply so the model can state what it just created. Pair with F37-6's
`list_mcp_servers` field.

---

## Observation (by design, handled well) · The controller has no delete, anywhere

> **Could not do — no delete, in any scope.** I create and update; I never destroy.
> `kb-files` is still registered and still mounted at `/data/kb`. It is now granted to
> nobody, so nothing reaches it, but please remove the row yourself.

This looks deliberate and right. Worth recording only because the controller handled the
limitation the way you would want: it neutralised the object it could not remove (revoked
every grant so nothing can reach it), said plainly what it could not do, and named the one
action left for a human. No dead end, no pretending.

Also worth recording as *good*: it granted with `propagate: true` on its own reasoning —
"otherwise the grant would have sat on the templates and done nothing for the agents running
on this board" — and verified the result through `get_project`'s resolved grants rather than
trusting its own write.

---

## F37-8 · An unpushed workspace commit is recorded as repository state, survives the workspace that held it, and is rendered as delivered work — HIGH

**The chain.** SHOP-2's Platform Architect ran (while the task was held — F37-2), did real
work, and committed it in its isolated workspace clone. The commit was never pushed: delivery
is server-owned and happens at the Review transition, which a held task never reached. The
workspace was then cleaned up.

What remains is a canonical record describing a commit that exists nowhere.

**`task.md` — the file that is supposed to be truth:**

```yaml
branch: shop-2
pr: null
github:
  commits:
    - sha: 3aad6ff
      msg: "[SHOP-2] Define identity service architecture slice"
  changed: null
```

**The repository:**

```
$ git log --oneline -1 origin/shop-2
f6166a9 Initialize Shopify Clone Platform          # the bootstrap commit, nothing else

$ git cat-file -t 3aad6ff
fatal: Not a valid object name 3aad6ff
```

**The container:** no workspace directory for SHOP-2 survives, and a sweep of every `.git`
under `/data` finds no object `3aad6ff`. The work is **gone**, not merely unpushed.

**What viberr shows a person.** The GitHub page renders, for SHOP-2:

```
SHOP-2  Identity service: users, sessions, tokens   shop-2   1 commit   no PR   synced
```

"1 commit" is the length of that phantom array. And the task timeline still carries the
agent's report — "Designed and committed the SHOP-2 identity slice: users, rotating
refresh-token families, password resets, transactional outbox, RS256/Argon2id configuration,
endpoint/error semantics…" — with nothing anywhere saying it evaporated.

**Why it matters.** This is both halves of the owner's bar at once: viberr **lost work** and
then **lied about it**. A person reading the board sees a branch with a commit on it and
reasonably concludes the identity design is banked. It is not. Nothing on the board, the task
page or the GitHub page distinguishes "committed in a workspace that no longer exists" from
"pushed to the remote".

**Not merely a consequence of F37-2.** F37-2 is what caused it *here*, but the hole is
general: any run that commits and does not deliver leaves this residue — a run that errors
after committing, an operator that decides not to deliver, a task archived mid-flight.

**Viberr already knows the distinction, in three places, and uses it in none of the three
that matter.**

1. `app/server/tasks/workspace-refresh.server.ts` models it precisely:
   `standing: "unpushed" | "ahead" | "in_sync" | "diverged"`.
2. The operator is *told* about it in prose — SHOP-1 carried the timeline note "Origin's copy
   of `shop-1` (`f6166a9`) is 1 commit behind the workspace head: call `deliver_for_review`
   to push it."
3. **Insights counts it correctly**: the controller read "traceability 1 of 2 delivered tasks
   (50%)", and `insights-query.server.ts` says why — "an unpushed delivery is exactly the
   untraceable one this number is about".

So the concept exists and one analytics surface is honest about it. The canonical record, the
board and the GitHub page are not.

**Fix, and the wrong turn I took getting there.** The entry carries `pushed` — whether the
remote has it — stamped from a **complete** compare, and every surface renders it ("1 commit ·
not pushed"). An absent stamp means no compare could judge it and reads as neither answer.

My first implementation instead **dropped** the entry and announced "**Work lost**". The live
system refuted that within the hour: a reconcile landing between an agent committing in its
workspace and delivery pushing it announced SHOP-7's `522e640` as lost — **seconds before
Viberr pushed it**. The distinguisher I had assumed existed does not: at reconcile time
SHOP-2's abandoned commit and SHOP-7's pending one were identical (neither on the remote,
neither carrying `pushedAt`). So "lost" is a claim this code cannot make, and I replaced it
with one it can. Recorded here because the wrong version would have told people their work was
gone while it sat on the branch — a worse lie than the one this finding is about.

---

## F37-9 · The branch-sync pill goes stale exactly when `main` moves — med

**What happened.** The GitHub page showed SHOP-2's branch as **`synced`** while the
reconciler's own latest measurement said **`behind_main`**, and git agreed with the
reconciler:

```
$ git rev-list --left-right --count origin/main...origin/shop-2
3   0            # main is 3 commits ahead of shop-2
```

**The mechanism.** The sync pill reads the newest `github.reconcile` **provenance** row
(documented in `github-query.server.ts`: "`behind_main` from the REAL compare captured by the
latest `github.reconcile` provenance row"). The reconciler writes that row conditionally
(`github-reconciler.server.ts:1266`):

```ts
if (changed || !ctx.skipUnchangedProvenance) { recordGithubProvenance(db, { … sync, aheadBy, behindBy … }); }
recordAudit(db, { action: "github.reconcile.task", details: { repo, branch, changed, sync } });
```

and `changed` means *"did the task file's `pr`/`github` blocks change"* (line 897):

```ts
const changed = authoredDriftVoidsVerdict ||
  JSON.stringify({ pr: fm.pr, github: fm.github }) !== JSON.stringify({ pr: newPr, github: newGithub });
```

`sync` is **not part of** `fm.pr` or `fm.github`. So when the only thing that changed is that
`main` moved, `changed` is false; the background poller runs with
`skipUnchangedProvenance: true`; no provenance row is written; the pill keeps rendering the
last *changed* verdict. The audit row is written with the fresh value, so viberr records the
truth in a place the UI never reads.

Observed exactly this, from the store:

```
provenance  06:34:16  github.reconcile  {"branch":"shop-2","sync":"synced","aheadBy":0,"behindBy":0,"commits":1}
audit       07:19:16  github.reconcile.task  {"branch":"shop-2","changed":false,"sync":"behind_main"}
```

PR #1 merged at 07:18:12 — i.e. the pill went wrong the moment the merge landed, and stayed
wrong.

**Why it matters.** "Behind main" is only interesting *because* main moved; this is the one
transition the pill cannot see. `unknown`/"not compared" exists in this very module precisely
because someone already reasoned that "we never measured this" must not render as green
(`github-pills.ts`: "UI-05: `unknown` exists because 'we never measured this' is NOT
'synced'"). A stale `synced` is the same error one step later: *we measured this, and the
measurement is out of date.*

**Fix shape.** Either include the compare verdict in the `changed` comparison so a sync flip
persists a provenance row, or have the poller always refresh the sync fields (a bounded
update of one row per task, not an unbounded append — the "grow unboundedly" concern in the
current comment is about appending observation rows, which an update does not do).

---

## F37-10 · A resolved decision packet never updates the task contract, so the human's answer is overruled and re-asked — HIGH

**The loop, from SHOP-7's own timeline.**

```
07:36:48  blocked      Question for a human: Choose SHOP-7 payment provider
07:38:54  transition   Decision: answered with a custom directive. Operator re-engages with it.
                       > Mock-only for now, but build it behind a PaymentProvider port …
07:38:58  blocked      (the agent's Codex session had expired) → recovery packet
07:39:50  transition   Decision: Redirect with sharper guidance  > … Apply Arda's resolved steer …
07:48:54  comment      Updated payment-provider.md to record Arda's resolved choice: mock-only …
07:55:12  comment      Request changes.  (formatting only)
07:59:39  comment      Reformatted …
07:59:39  blocked      Question for a human: Arda: choose the payment provider      ← ASKED AGAIN
08:04:27  comment      Request changes. "incorrectly records mock-only as selected and claims
                       Arda resolved it. The canonical task says the decision is still open
                       and forbids the agent from choosing."
08:05:18  comment      @Platform Architect, revise … Remove every claim that mock-only was
                       selected or that Arda resolved it.                            ← REVERTED
```

I answered. Viberr delivered the answer. The agent acted on it. The required reviewer then
**rejected the work for obeying me**, and the operator is now instructing the agent to erase
my decision — while a second packet asks me the same question over again.

**The mechanism.** The task's `## Goal` is the contract everything re-anchors on, and it still
reads, unchanged, at this moment:

> The agent must not select a provider … Investigate, write the trade-offs down, then stop and
> ask Arda to choose.

Resolving a packet writes a `transition` event and a tagged comment. It does **not** touch the
goal. Every downstream reader re-anchors on the canonical file — the operator's own tool
description tells the reviewer to "Re-anchor on the canonical task file", and the reviewer did
exactly that and found the human's answer contradicting the contract. Between the timeline
(where the decision lives) and the goal (where the contract lives), the goal wins, because the
goal is what a fresh run reads and a timeline entry 20 events back is not.

**Why it is high.** All three of the owner's categories at once:

- *Losing work.* The human's decision is being actively deleted from the deliverable.
- *Blocking a path with no way out.* The cycle is closed: answer → act → reviewer rejects
  against the stale goal → revert → ask again. Answering the second packet identically would
  run the same loop, because nothing in the loop updates the contract. The only exits are
  outside the packet mechanism — a human hand-editing the goal, or archiving the task.
- *Absurd.* Viberr asks a person to decide, then treats their decision as an agent
  overstepping.

**Not the reviewer's fault, and not the operator's.** Both behaved correctly given what they
were handed. The reviewer is *supposed* to enforce the declared contract — that is the whole
point of a required reviewer, and F37-2's sequencing failure is exactly what happens when
nothing does. The defect is that viberr routes a human decision into the conversation and not
into the contract.

**Fix shape.** A resolved packet must be able to amend the task it answers. Concretely: when a
packet is resolved with a directive or a chosen option, the operator's re-engagement turn is
already triggered — it should be *required* to reconcile the goal with the decision via
`set_goal` before dispatching, and the resolution event should record that it did (or say why
it did not). The decision then lives where every re-anchor reads it. A cheaper variant that
would also have prevented this: append the resolved decision to the goal as a dated
"Decisions" section the writers own, so no model judgement is involved at all.

**Also observed in the same loop (smaller), with a correction.** The agent re-opened the *same*
question as a new packet after the first was resolved, so the human was asked twice for one
decision. Viberr *does* refuse a duplicate while one is still OPEN — a third attempt was held
with "**Question held (a decision is already open):** Arda: choose the payment provider" — so
the guard exists; it just keys on "open", not on "already answered". With ruling 189's
amendment in place the re-ask largely stops mattering, because the agent re-anchoring on the
goal now finds the answer there instead of an open question.

**How it ended, live.** The agent's final act on this loop was to "revise
`payment-provider.md` to **restore a neutral, unresolved comparison**", and the operator noted
"the decision remains unresolved and implementation is stopped". The human's answer was
completely erased from the deliverable. Separately and correctly, ruling 160 held throughout:
after I closed PR #2 by hand, viberr refused to route around it — "No pull request was opened
for SHOP-7: PR #2 was closed without merging. A closed pull request is a person's decision
about the task, so Viberr opens no new PR for this branch."

---

## F37-11 · The operator plans a branch update it cannot know is unnecessary — low

**What happened.** Nine of the pass's 156 timeline events (6%) are
"**The operator's plan was not carried out in full.**" Eight of the nine are the same step,
on every delivery, on every task:

```
4 × - `update_branch_from_base` — `shop-7` is already up to date with `main`
2 × - `update_branch_from_base` — `shop-6-efd4` is already up to date with `main`
2 × - `update_branch_from_base` — `shop-1` is already up to date with `main`
1 × - `open_packet` — A decision packet is already open on SHOP-7
```

**The mechanism.** The operator's snapshot (`operator-actions.server.ts`, the `get_task`
payload) carries `branch`, `pr` with `mergeable` and `unpushedRevisionSentence`, `unownedPr`,
`foreignHead`, `notAcceptableReason` — but **nothing about whether the branch is behind
`main`**. The reconciler measures exactly that on every pass and records `behindBy` in its
provenance row (`createReconcileBehindByLookup` exists to read it, and the GitHub page's sync
pill already does). The operator cannot see it, so it plans the update defensively every time,
and the server honestly reports that the step did not apply.

**Correction, after reading the tool description.** This is weaker than I first wrote it, and
the weakening is the interesting part. `update_branch_from_base` tells the operator, in so
many words:

> It is idempotent and cheap: an already-current branch changes nothing and says so, **so call
> it when you are unsure rather than guessing.**

So the redundant call is *deliberate and documented*: viberr prefers a wasted no-op to a
missed update, which is the right trade — a stale base is how a reviewer ends up reading a
diff against a base that no longer exists. The operator is obeying its instructions, and the
"did not apply" note is the honest report of a step working exactly as designed. This is not
viberr getting something wrong.

**What is still worth doing.** The operator has no way to *stop* being unsure, even though the
reconciler measures the answer on every pass and records it where the GitHub page's sync pill
already reads it. Handing it that reading removes 8 of the pass's 9 "plan not carried out"
notes without weakening the posture at all: the tool stays available, and an absent or stale
reading still means "call it". Kept in the ledger as **low**, and fixed, because it is the
same shape as F37-3/5/6 — *a fact the server holds is absent from the agent's read* — and the
fix costs one field.

**Fix.** `baseBehindBy` on the operator's snapshot, read through
`createReconcileBehindByLookup`, the same lookup the sync pill uses; `null` means no pass has
compared this task yet and is explicitly never a reason to skip the call.

**Outcome, measured after the fix shipped — it is INERT, and I am recording that rather than
claiming the win.** The count over the whole pass is 16 of 19 refused plan steps, and the
notes kept arriving after the fix was live (11:34 and 12:02 on SHOP-6, with `behindBy: 0`
sitting in a reconcile row from 11:38 and `baseBehindBy: 0` therefore in the snapshot the
operator read). The tool description says `0` means the call is a no-op — and it also says
"it is idempotent and cheap … call it when you are unsure rather than guessing", which is the
stronger instruction and, on balance, the right one: a stale base is how a reviewer ends up
reading a diff against a base that no longer exists, and the cost of being wrong the other way
is one honest "did not apply" note. So the fact is delivered, the description explains it, and
the model correctly keeps choosing the cheap call. The field stays because it makes the
behaviour a choice instead of a blind spot; the note count is not evidence of anything wrong.

## F37-12 · "Coordination overhead 100%" is arithmetic that cannot be wrong and an answer that cannot be right — med

**What Insights showed.** On the live instance, in the Delivery-oversight band:

> **100%** — Coordination overhead
> *operator and controller runs spent $4.34 of $4.34 reported by cost-reporting runs*

**What the data is.** Every run on the instance, grouped by kind and backend:

```
kind        backend  runs  costed  cost
----------  -------  ----  ------  ------
controller  claude   4     4       4.3373
operator    codex    59    0       0.0
primary     codex    19    0       0.0
reviewer    codex    13    0       0.0
```

Only Claude's result envelope carries a cost. The delivery fleet is Codex (the owner's
model policy: controller on opus high, **everything else** on luna max), so **not one
delivery run reports a cost** — and neither does the operator, the other half of the thing
being measured. The denominator of "coordination / all reported spend" contained nothing
but four controller turns. The quotient was 1 **by construction**: on this instance no
sequence of events could have produced any other number.

**Why it is a finding and not a nitpick.** The card exists (F31-D6, pass 31) to answer
"how much of my spend is coordination?" — a real question with a real action attached:
if coordination is eating the budget, tune the operator and the controller. Here the
question has no answer in the data, and the card answers it anyway, at the maximum. A
supervisor reading 100% concludes that coordination is out of control; the truth is that
coordination cost $4.34 and **delivery's cost is unknown, not zero**. Viberr is stating a
measurement it did not make — the ledger's standing bar for this pass ("viberr lying") —
and it is stating the one that most invites a wrong move.

It is also a defect viberr has *already ruled on, at the other end*. F31-D6's own comment
says: "null when nothing reported a cost (**never a fake 0%**)". The degenerate low end was
guarded because a 0% would claim coordination is free when nothing was seen. The degenerate
high end is the same claim, mirrored, and was unguarded. Nothing in the honest sub-text
rescues the headline: the number is what gets read, and "of $4.34 … of $4.34" is a disclosure
a reader has to *decode* before they can distrust the figure above it.

**Not the same as the operator's $0.** The sub-text credits the $4.34 to "operator and
controller runs" when the operator contributed exactly nothing. That phrasing (D04-U12,
pass 32) is about the union of the two kinds and is not false, so it stays for the normal
case; in the degenerate case the replacement text names only what was actually spent.

**Fix — ruling 190.** Count the cost-reporting **delivery** runs in the same aggregate pass
(`costed_delivery_runs`); when that count is zero the share is `null` — the same answer
F31-D6 already gives for zero reported spend — and the card reads:

> **n/a** — Coordination overhead
> *operator and controller runs spent $4.34; no delivery run reported a cost, so there is
> no share to take*

The test is the **count of runs**, not the dollars: a delivery run that genuinely reported
$0.00 *was* observed, so a 100% earned that way is real and is still shown. Proven red both
ways — drop the guard and the query hands back `1`; hand the card `share ?? 1` and "100%"
comes back on screen.

**Self-review caught a half-fix.** The first version guarded only the delivery side. The
mirror is just as reachable — a Codex operator and controller under a Claude delivery fleet —
and reads **0%**, which claims coordination is free when it merely never reported. Same
defect, opposite sign, and a reader would act on it the same wrong way. The rule is now
symmetric, and it distinguishes *reported nothing* from *never ran*: an instance with no
delivery runs at all genuinely did spend everything on coordination, and 100% there is the
answer rather than a gap.

## F37-13 · Nobody who plans against the shell is told what the shell contains — HIGH

**What the host actually is.** Every agent on this instance runs inside the viberr
container. Its entire toolchain:

```
make             ABSENT
docker           ABSENT
docker-compose   ABSENT
pnpm             ABSENT
yarn             ABSENT
turbo            ABSENT
python3          ABSENT
go               ABSENT
psql             ABSENT
```

`node`, `npm` and `git`. Nothing else.

**What was built on top of it.** The controller chose a **pnpm + turbo** monorepo with a
root **Makefile** and a **Docker Compose** stack, and wrote it into the project's
architecture knowledge base:

> - Local orchestration: Docker Compose, driven by a root `Makefile`.
> - `make up` must: build the workspace, start Postgres + Redis, run every service's
>   migrations…

It then chartered the **Integration Verifier** — a *required* reviewer whose verdict gates
acceptance — with this pass:

> 1. Cold start. Clean checkout of the task branch, `make up`, everything healthy with no
>    manual nudging. […]
> Report `approve` only when the stack came up cold, the journey passed over real HTTP and
> the failure injection behaved.

On this host that reviewer **cannot ever approve anything**.

**What it cost, live.**

- 75 `command not found` lines across the pass: `pnpm`, `corepack`, `make`, `curl`, each
  rediscovered by each agent that reached for it. 841 log lines mention `pnpm`, 272
  mention `turbo`, 118 mention `docker`.
- SHOP-7 — a **document-only** task, one file, owned path `docs/decisions/` — ran **7
  verdict rounds**. The Code Reviewer approved revision `522e640`. The Integration
  Verifier then requested changes on the *same* revision, and on the next one, both times
  for the same reason:

  > Mandatory Step 1 failed: `make up` returned `/bin/bash: line 1: make: command not
  > found` (127), Docker was absent, and `http://localhost:8080/health` returned
  > `ERR_CONNECTION_REFUSED`. Steps 2–5 could not run because the checkout has no services
  > or compose stack.

  The operator's response each time was to send the **deliverer** back to rework the
  document. The document was never the problem.
- The delivered repo carries a `Makefile` whose every target is a stub that exits 1, and a
  `pnpm-lock.yaml` that nothing on this host can install from. The user's "one command to
  bring it up" is, as committed, unreachable.

**The viberr defect, stated precisely.** Viberr *had already measured this*. Ruling 182
exists because G36-2 asked "what an agent's shell would actually find here", and
`toolchain.server.ts` says so in its own header. Two things were wrong with it:

1. **The inventory omitted everything that mattered.** It probed `node`, `npm`, `git`,
   `python3`, `go`. Not `make`. Not `docker`. Not a package manager other than npm. Those
   are precisely the tools an orchestration contract is written around, and there was no
   way to ask about a tool not on the list.
2. **Only the controller could reach it, and only by asking.** The reading is exposed
   through `instance_health` (controller-only, opt-in) and `/resources/health`. It is in
   **no agent prompt at all** — not the deliverer's, not the reviewer's, not the
   operator's. `grep -rn "toolchain" app/server/runtimes/ app/server/tasks/` returned
   nothing before this fix.

I checked whether the controller consulted it: `select count(*) from run_log_lines where
display_json like '%instance_health%'` → **0**. It never asked. That weakens "the
incomplete list misled it" and strengthens the real point: **an inventory you must know to
ask for is not a fact the planner has** — and had it asked, the answer would still not have
mentioned `make` or `docker`, so the architecture would have come out the same.

**Fix — ruling 191.** The probe grows `make`, `docker`, `pnpm`, `yarn`, `curl`. A shared
`shellInventoryPrompt()` renders the present/absent split, and it is injected unasked into
**every specialist run** (deliverers and reviewers), **every operator run** and **every
controller turn**. Three details are deliberate:

- The two failure modes do not read alike: `npx <tool>` genuinely rescues an npm-published
  tool, and `make`/`docker`/`curl` "cannot be installed from here at all".
- The paragraph closes by telling a reviewer that an unrun check is **not a pass** and
  **not the deliverable's fault** — the exact inversion that cost SHOP-7 two rounds.
- The runtimes that spawn the agent (`codexCli`, `claudeAgentSdk`) are excluded from the
  list, with a test pinning that: naming them as shell tools invites an agent to drive its
  own backend.

Proven red four ways — delete the probe entries and the absences stop being named; delete
each of the three injections and that surface's test fails.

## F37-14 · Viberr's turn doctrine has one answer to a request-changes, so a reviewer that cannot pass loops the work forever — HIGH

**What happened.** SHOP-7 is a **document-only** task: one file, `docs/decisions/payment-provider.md`, with `services/**`, `apps/**` and `packages/**` explicitly barred. The Code Reviewer approved revision `522e640`. The **Integration Verifier** — a *required* reviewer, so its verdict gates acceptance — then requested changes on that same revision, and on `fa207b2`, and on `5f1a6d5`:

> The Integration Verifier gate cannot pass: cold start failed at `make up` with exit 127
> (`make` not found); `make test` and `make e2e` failed identically. Docker and the service
> stack are also absent… **This is an environment/repository-baseline blocker, not a
> discovered document-scope defect.**

The reviewer could not have been clearer. The operator's response, every single time, was to send the **deliverer** back to rework the document. By the tenth round its own brief said the quiet part out loud — *"The Integration Verifier requested changes only because `make up`, `make test`…"* — and it re-prompted the architect anyway.

**Why the operator did that.** It is following viberr's written instruction. The turn doctrine (`operator-run.server.ts`) says:

> Work stage where a human steer, rework decision, or **request-changes** arrived AFTER the deliverer's last report: the deliverer owes NEW work — `run_agent` the delivering profile with that steer as its prompt.

Unconditional. There is no arm for "the request-changes names something no revision can fix". The operator is not misbehaving; it is doing what viberr told it.

**The second half: the operator could not see the loop.** `OperatorTaskSnapshot.reviewers[]` carried each reviewer's verdict **on the current revision only**. Nine rounds in, the snapshot looked exactly like round one. The fact that would have told it something was wrong — *this reviewer has now rejected three successive revisions for the same reason* — was in the task file all along (`verdicts[]` keeps every verdict with its `revisionId`) and was never put in front of it.

**Cost, measured.** SHOP-7 burned 10 verdict rounds, 3 of them against a wall no revision could move, on a one-file document. Each round is a deliverer run, a reviewer run and two or three operator runs.

**Related lie, worth its own line.** SHOP-7's *first* Code Reviewer verdict ends: *"Tests, lint, and typecheck passed; validation ran with the locked dependencies via pnpm 9.15.4."* pnpm is not installed on this host (F37-13). That validation did not happen. The second verdict is honest about it (*"pnpm/Corepack and node_modules are unavailable in this checkout"*). Ruling 191's closing clause — never report an unrun check as a pass — is aimed squarely at this.

**Fix — ruling 193.** `consecutiveRequestChanges` per reviewer on the operator's snapshot (counting **revisions**, not verdict rows, so a re-run on one revision is one objection; reset by that reviewer's first approve), plus the missing doctrine arm: at two or more, ask whether the deliverable can satisfy the objection at all, and when the reviewer names something outside the work — a tool the shell inventory says is absent, a baseline the repo does not have, a decision nobody has made — say so in one comment and open a packet naming the three real exits (drop or replace the required reviewer, accept past the gate, fund the baseline as its own task).

## F37-15 · A goal link and its task hold two copies of one contract, and a retry silently ships the stale one — med

**What I verified.** Ruling 155 freezes an **active** link's `title` and `goal` in the goal file. The task's title and goal are frozen by nothing — a decision packet (ruling 189), an operator `set_goal`, or a person edits them freely. So they drift. On this board they drifted into a contradiction:

`goals/goal-2.md`, link 1 (frozen at creation):

> Publish the request/response zod schemas in `packages/contracts/identity.ts` and export them from the package index.
> Owned paths: `services/identity/**`, **`packages/contracts/identity.ts`** and the one export line it needs in `packages/contracts/index.ts`…

`tasks/SHOP-2/task.md` (rewritten when the controller moved contracts ownership to SHOP-9):

> Implement against `packages/contracts/identity.ts` exactly as frozen by SHOP-9 … **this task does not edit `packages/contracts`**.

Both are canonical files. They disagree about who owns a directory.

**Where it bites.** `retry_link` rebuilds the task from `link.goal`. A link fails (its task archived), someone retries it, and the fresh task is created from the **superseded** contract — no warning, no timeline entry, and the correction is simply gone. That is the "losing work" case, and it is the one moment a chain is most likely to be retried.

**What I checked and found NOT to be a problem** (the controller reported both; I disagree with it on the evidence):

- *"The Goals panel still shows each link's original text."* It does not — `controller-page.tsx` renders `l.title`, `l.blockedBy`, `l.taskKey` and `l.note`, never `l.goal`. The stale `goal` reaches the controller through `get_goal`, not a human through the UI.
- *"Removing a pending link renumbers the rest, so `goal-3 link 4` silently means something new."* Not silently: `referencesToLinksFrom` refuses the removal when this goal's own links, a sibling goal's pending links, or any task's `blockedBy` point at or after the removed index, naming the holders. The controller *saw that guard fire* ("the server correctly refused one removal until I repointed goal-7 link 4") and filed it as fragile anyway.

**Fix — ruling 192.** Three arms:

1. A retry carries the failed task's own contract, chain header rebuilt rather than stacked, and the goal's timeline records that it did.
2. `getGoalView` — the detail read, and `get_goal`'s payload — carries `liveGoal` whenever the task's goal has moved past the declared text. The declared text stays beside it: it is what the chain declared and what the history means. Goal only, no title: **a task's title is immutable** — nothing in the product writes one after create, and `update_task` says so ("Never edits the title") — so a `title` half would be a field nothing can ever set.
3. A non-terminal chain can be **renamed** (title and description). `goal-2` still read "Identity and Catalog services" hours after catalog moved to `goal-6`, and the only correction on offer was to cancel the chain and rebuild every link. The rename says what it does not reach: link tasks created before it keep the old name in their chain header, written at create time and never re-read.

**Noted, not filed** (below the bar for this pass): a task's title cannot be changed by anything, ever. That is odd next to a freely editable goal, but a stale title neither loses work nor blocks a path.

## F37-16 · A retry that starts nothing still writes "retried" into the goal's history — med

**Found while proving F37-15's fix**, not by reading code: the ruling-192 test could not get `retry_link` to produce a task at all until the archive's fire-and-forget reconcile was allowed to settle first.

**The mechanism.** `updateGoal(retry_link)` commits the redirect — chain back to `active`, `Link N (title) retried by X` in the goal's timeline — and *then* calls `startLinkTask`. That function re-reads the goal under its own lock and **returns null silently** when the chain is no longer active. `setTaskArchived` fires a reconcile and forgets it, and that reconcile re-parks a chain whose links are all settled — landing squarely in that window. Result: a goal whose history says a link was retried, over a link still marked `failed`, with no task, and the creator never told.

The sibling arm right below it — the one that runs when `startLinkTask` *throws* — has carried exactly this correction since it was written ("flaps it back, re-notifying and recording a retry that never started"). The silent decline had no arm at all.

**Fix — ruling 194.** A declined retry re-parks to `attention`, notes the link ("The retry did not start: the chain was redirected while it ran."), records the decline in the goal's timeline saying to retry again, and notifies the creator. Proven with the product's own `goal-start` lock held open across the window — a deliberate pause where the live system has a race — and red without the arm.

## F37-17 · A task waiting on a human showed "agent working" and sat for 75 minutes, holding ten tasks behind it — HIGH

**How I found it.** The controller told me SHOP-6 gates the whole board and that its open "Lockfile ownership" packet is the only thing stopping it. I checked the board and disbelieved it: `readiness: ready`, `waiting: agent`. Then I checked the runs.

```
runs on SHOP-6 since 09:02 ……… 0          (last: an INTERRUPTED primary at 09:00:25)
runs on SHOP-7 in the same window … 32
audit 09:02:22.212 ……………… run.recovery.reinvoked · SHOP-6 · {"attempt":1}
audit 09:02:22.212 ……………… run.recovery.reinvoked · SHOP-7 · {"attempt":1}
runtime.run.started 09:02:22.401 … SHOP-7 operator          ← the only one
```

Viberr recorded a re-invoke for SHOP-6 and started nothing. Pressing **Run operator** on the task page myself answered why:

> Operator not started · resolve the open decision to continue

**The mechanism.** The packet was opened mid-work by the Platform Architect at 08:55:40. An open packet refuses only the *human-ish* triggers (`manual`, `scheduled`); machine triggers legitimately keep running — ruling 17's `pr-diverged` withdrawal and the `agent-reply` reaction both depend on it. So the operator carried on: moved SHOP-6 to Review at 08:56, back to Build at 09:00, and dispatched the architect again at 09:00:26 — setting `waiting: agent`. At 09:02 my restart killed that run. Boot finalized the orphan and re-invoked the operator with the **`manual`** trigger, which landed in the open-packet refusal:

```ts
// The packet already owns `waiting: "human"`, so there is no settle to do here.
if (PACKET_REFUSED_TRIGGERS.has(input.trigger ?? "manual")) { … return { refused: "open-packet" }; }
```

That comment states an invariant the product does not hold. The closed arm and the blocked-by arm directly above and below it *both* settle, each with a comment explaining that a refusal must leave the waiting state honest. This one asserted it did not need to.

**What the user sees.** A board card saying an agent is working. A task page whose every button refuses. No notification, no timeline note, no decision surfaced. Ten tasks (SHOP-9 through SHOP-14 and the four they gate) held behind a question nobody was shown. It stayed that way until I went looking — and nothing in the product would have ended it, because every path back in is refused and the only signal that a human is needed is the one field that was never corrected.

**Fix — ruling 195.** The packet arm settles like the other two. `settleWaitingAfterOperator` is already a no-op unless the flag is `agent` with nothing live, and `clearWaitingToHuman` settles to `human` — not `none` — precisely because a packet is open. Proven red by deleting the call: `expected 'agent' to be 'human'`.

**Correction to my own notes.** I first recorded "SHOP-6 has no packet" after grepping the task frontmatter for `packet:`. Packets live in a `## Packet` markdown section, not in frontmatter. The controller's report was right and my check was wrong; the finding is what my wrong check led me to.

## F37-18 · The controller refused to edit an agent template, correctly, because viberr would not show it what it was about to overwrite — med

**Reported by the controller itself**, in the last paragraph of a board-wide repair I had asked
for, under a heading it wrote: *"What I did not do"*.

> I deliberately left the **Backend / Frontend / Infrastructure Engineer** templates alone.
> Their one-line summaries still say "Testcontainers", "Docker Compose stack" and "Playwright
> journeys", but `save_global_agent` gives me no way to edit a summary without also supplying a
> persona, and I cannot read the personas I'd be replacing. I would rather flag a stale blurb
> than clobber a prompt unread.

**Half of that is wrong, and the half that is wrong is viberr's fault.** The writer has always
kept a blank persona: `description: persona || existing.description` in `gagents.server.ts`.
Omitting it was safe. Nothing told the caller:

- `save_global_agent`'s description spells the merge rule out for three fields — *"an omitted
  skills/mcps/kbs list leaves the stored grants unchanged, and an empty list clears them"* —
  and says nothing about `persona`, whose parameter description was the bare *"The long
  persona/system-prompt body."* Beside three explicit rules, silence reads as "this one is
  different".
- `list_global_agents` did not return the persona, so the caller could not check. The field is
  right there in `GagentView` (`persona: parsed.description`); the toolkit's `.map` dropped it.

**This is F33-7 repeating.** That finding added the grants to the same list tool for the same
reason, and its comment in the source says so in as many words: *"the model had no way to see
what an edit was about to replace, and the controller (rightly) refused to edit blind."* The
fix covered the three small list fields and skipped the big prose one.

**The cost, concretely.** Three agent templates still advertise a toolchain this host does not
have, to the **operator**, which is the component that picks an agent by reading that summary.
The controller could see the problem, had the authority to fix it, and was correct to stop.

**Fix — ruling 197.** `list_global_agents` returns the persona; `save_global_agent` and
`list_global_agents` both state the rule ("an omitted or empty PERSONA leaves the stored
persona unchanged, so editing a summary alone is safe"). Proven red both ways: drop
`persona: g.persona` from the list mapping and the read is `undefined`; make an omitted persona
write through and a blurb edit flattens the agent's entire system prompt.

## F37-19 · A second stranded task, through the door ruling 195 did not cover — HIGH

**Found by re-reading the review queue** after fixing F37-17, and disbelieving it the same way.
The queue said:

> **Still in review 2** · SHOP-6 … `agent working` · SHOP-7 … `agent working`

SHOP-6 genuinely had a reviewer running. SHOP-7 had not had a run of any kind for **two
hours**:

```
SHOP-7  stage=review  readiness=ready  waiting=agent
last run: run_YHJaUzOn (primary) INTERRUPTED 10:19:50 — by my restart
audit:    run.recovery.reinvoked · SHOP-7 · {"attempt":3}  at 10:15:50
          …and nothing at all after the 10:19 boot
```

**The mechanism.** `RECOVERY_REINVOKE_CAP` is 3 in a 30-minute window (F7-BOOT1, a
boot→orphan→crash-loop guard). My rebuild cadence tripped it honestly: five restarts inside
half an hour while I deployed fixes. The 10:19 boot therefore finalized SHOP-7's orphan and
**skipped** the operator re-invoke — correctly.

What was not correct is everything around that decision:

1. The restart note on the task was written **before** the cap loop ran, and says, on every
   orphaned task: *"…recorded as interrupted by the restart, **and the operator is re-invoked
   to decide what to do next**."* On a capped task that is a promise the code had already
   decided to break. It is in the canonical file, in the timeline a human reads.
2. `waiting: "agent"` was left standing. The board card, the review queue and the "waiting on
   a human" count all took it at face value — so the one surface that could have shown a
   person this task needed them showed the opposite.
3. The only trace of the decision was `logger.warn("recovery re-invoke capped …")` in the
   server's own log, which no product surface reads.

**This is F37-17's defect through a different door**, and it is worth stating that plainly:
ruling 195 fixed a refusal that skipped its settle; this is a *decision not to act* that skips
the same settle and additionally leaves a written promise behind. Two tasks, both gating
work — SHOP-6 held ten tasks, SHOP-7 held its own chain — both stranded, both invisible,
within three hours of each other.

**Fix — ruling 198.** The cap decision moves above the note. A capped task's note says what
Viberr decided and why, and names the way on ("run the operator from this page when you are
ready"); its `waiting` is settled off `agent` through the same `clearWaitingToHuman` ruling 195
uses; and its owner gets a notification. An uncapped task keeps the original sentence, because
a turn really is coming. Proven red both ways — put the promise back and it appears on a task
nothing is coming for; drop the settle and the board keeps claiming an agent.

## F37-20 · Every Codex conversation on the instance was unresumable, and viberr blamed the provider — HIGH

**The symptom, three times.** All three of the pass's run errors — 100% of them — were the
same line:

> The Platform Architect agent run did not complete: **the agent's stored Codex session no
> longer exists**, so its history could not be resumed. No changes were delivered.
> `Error: thread/resume: thread/resume failed: no rollout found for thread id
> 01a099ff-1a74-71d2-90d6-d695d4e8c923 (code -32600)`

I read that as an expired provider session and nearly filed it as an environment fact. Then I
looked for the file:

```
/data/runtimes/users/u_GNlpg-djnF8n/codex-home/sessions/2026/09/13/
  rollout-2026-09-13T09-00-27-01a099ff-1a74-71d2-90d6-d695d4e8c923.jsonl   ← it is right there
```

**The mechanism.** Ruling 181 gives every Codex run a private `CODEX_HOME` at
`codex-home/runs/<runId>/`, with `sessions/` symlinked to the shared directory so transcripts
outlive the run — and `CODEX_SQLITE_HOME` pinned to the shared home so the thread index does
too. Both halves work. What nobody checked is what the CLI *writes into* that index:

```
threads.rollout_path =
  /data/runtimes/users/u_…/codex-home/runs/run_ArTNpQB-_O_w/sessions/2026/09/13/rollout-….jsonl
```

The path it saw — through the symlink, not the symlink's target. Ruling 181 then deletes
`runs/<runId>/` at settle. The file survives; the pointer does not.

**Measured across the whole instance:**

```
threads:                                     137
rollout_path under a per-run home:           137   ← all of them
…those paths that no longer exist:           135   (the 2 left were runs still in flight)
…whose file IS in the shared sessions dir:   135   (every single one)
```

**Every Codex conversation viberr has ever recorded here is unresumable**, and has been since
ruling 181 shipped. The cost is not only the three errored runs: every re-prompt of a Codex
agent silently starts from zero, re-reading the task file instead of continuing its own
reasoning — which is a large part of why ruling 189 (put the human's decision in the goal)
mattered so much on SHOP-7. And twice, the failure escalated into a decision packet putting a
"Work stalled: pick a recovery path" question to a person over a file that was never lost.

**Why viberr's own graceful recovery never fired — the sharpest part.** Viberr already has a
designed answer for a vanished transcript: `resumeRun` calls `probeSessionContinuity` BEFORE
handing the id to the SDK, and on `missing` it recovers in one shot — stamps the dead run,
writes the `continuity` typed event, and re-enters `startRun` with no resume and a
canonical-anchor preamble. No human is asked anything. That path was bypassed every time,
because the probe is *right*:

```ts
function codexSessionDirs(userId, dataRoot) {
  const dir = path.join(userBackendHome(userId, "codex", dataRoot), "sessions");  // the SHARED tree
  return existsSync(dir) ? [dir] : [];
}
```

It looks where the bytes actually are, finds the rollout, and answers `present`. So two halves
of viberr disagree about where a Codex transcript lives — **viberr's probe and exporter say the
shared `sessions/` tree, which is correct; the CLI's resume says `threads.rollout_path`, which
viberr itself invalidated** — and the disagreement converts a case the product handles
gracefully into an errored run and a packet put to a person. The fix makes them agree, which is
why it belongs in the path that broke the agreement rather than in the probe.

**The honesty failure is separable from the bug.** "The agent's stored Codex session no longer
exists" is viberr's sentence, not the provider's, and it is false: the session exists, and
viberr's own probe had just found it. Viberr deleted the directory that made it findable to the
CLI and then reported the consequence as someone else's fault.

**Fix — ruling 199.** The settle re-points that run's threads at the shared path before
removing the directory, and a boot pass repairs the 135 already stranded. Both are fail-soft
against a vendor artefact: the schema is parsed rather than asserted, an unrecognised shape is
skipped whole, a path is only moved onto a file that exists, and a live run keeps its own path.
Proven red both ways — drop the settle call and the recorded path still points into the removed
home; drop the in-flight guard and the sweep re-points a running agent's thread out from under
it.

## F37-21 · Ruling 190 guards the empty case and not the partial one, so the coordination share is a ratio of whatever happened to be visible — med

**Where this came from.** Not from a screen. F37-12 is fixed and the live card is honest
today; I went back to it to check *why* it is honest, and the answer turned out to be an
accident of this instance rather than the rule doing its job.

**The census, now, on the running instance** (`agent_runs`, whole instance):

```
kind        backend  runs  costed  cost      tokens
----------  -------  ----  ------  --------  -----------
operator    codex    137   0       0.0         3,417,466
primary     codex     40   0       0.0        90,476,360
reviewer    codex     32   0       0.0        41,582,318
controller  claude     6   6       13.3783     9,119,280
```

209 of 215 runs — 97% of the runs and 94% of the tokens — report no dollar figure at all.
That is not viberr dropping data: `costUsd` is assigned on the Claude result envelope only
(`wire-format.server.ts:363,372`), and the Codex envelope carries token counts with no price.
**Cost is a Claude-only observation**, and any instance that mixes backends — which is the
configuration viberr is built for — has a partially-observed cost picture by construction.

**What ruling 190 actually tests.** The guard is all-or-nothing per side:

```ts
deliveryRuns > 0 && costedDeliveryRuns === 0        ? "delivery"
: coordinationRuns > 0 && costedCoordinationRuns === 0 ? "coordination"
: null
```

So the share is suppressed when a side reported **nothing**, and printed with full confidence
the moment a single run on each side reports **something**. Today's card is in the first case
only because the delivery fleet is *entirely* Codex. Coordination is already in the second:
142 coordination runs, **6** of them costed, and the card's healthy branch would happily
divide with them.

**The reachable failure.** Put one Claude deliverer on this instance — an ordinary act, no
misconfiguration — and nothing else changes. Say the Claude deliverers report $36 across the
runs they cover. The card computes `13.38 / 49.38` and prints:

> **27%** — Coordination overhead
> *operator and controller runs spent $13.38 of $49.38 reported by cost-reporting runs*

The 137 operator runs are in neither number. At the controller's own observed rate
(~$2.23/run) they would be several hundred dollars, and the true share would be north of 90%.
The card would be telling a supervisor that coordination is a quarter of the bill while it is
in fact most of it — and it would be telling them that in the same confident typography it
uses for a figure it actually measured.

**Why the existing sub-text does not rescue it.** "reported by cost-reporting runs" is a
hedge that names no quantity, so it reads as a synonym for "all runs". It is also the *only*
hedge: the headline is a bare percentage. F37-12's own paragraph on this stands unchanged —
"the number is what gets read".

**Why this is not F37-12 again.** F37-12 was a quotient of 1 that no sequence of events could
have changed. This is a quotient that *varies* with the data and is wrong anyway, which is
worse in one specific way: it cannot be spotted by noticing that the number looks degenerate.
It is also not a bound — with both sides partially observed, unreported delivery spend pushes
the share down and unreported coordination spend pushes it up, so the visible ratio is not
even a floor or a ceiling. It is a ratio of the observed subset, presented as a ratio of the
work.

**Ruling 190 is not being reversed.** Its test — *reported nothing* versus *never ran* — is
right and stays. What it is missing is that "observed" is not binary per side: the population
the share claims to describe and the population it is computed from can differ by 97% without
the rule noticing. The amendment is about that gap, and the fix needs the owner's call on
which of three shapes the card should take (see DECISIONS).

**Viberr already holds the fact it needs to say this well.** `agent_runs.backend` is on every
row, so the card can name the excluded population precisely — "209 Codex runs report no cost"
— rather than gesturing at "cost-reporting runs".

## F37-22 · Viberr called a delivery a refusal to act, told the owner coordination was paused, and kept coordinating 23 seconds later — HIGH

**What the timeline says**, SHOP-10, in the order it happened:

```
14:48:21.046  transition   operator moved SHOP-10 from Design to Build
14:48:56.005  github       Opened PR #8 for review
14:48:56.118  note         **Note:** this stage auto-advances, but the operator held it
                           twice in a row without advancing, dispatching, or opening a
                           packet — treating that as a deliberate hold. Coordination is
                           paused here: run the operator manually when the hold should
                           end, adjust the goal, or loosen the boundary in
                           Policy → Workflow rules.
14:49:19.131  transition   operator moved SHOP-10 from Build to Review
14:49:40.600  comment      @Code Reviewer Review delivered revision PR #8 for SHOP-10…
14:49:45.527  agent        Started a Codex run for the Code Reviewer agent
```

Nobody touched anything between those lines. The last human event on the task was 35 minutes
earlier.

**What the drive it is describing actually did.** `run_qSexX41pVhAb`, 14:48:21 → 14:48:48, one
action, the whole plan:

```json
{"reasoning":"The delivering agent reports a committed, plausible implementation on branch
  shop-10 (fb09eb4). Deliver it for review now.",
 "actions":[{"tool":"deliver_for_review",
   "reason":"Push the committed shop-10 revision and open the review PR."}]}
```

It pushed the branch and opened PR #8. That is the operator's most consequential act short of
accepting a task, and viberr recorded it as "held … without advancing, dispatching, or opening
a packet".

**Two false statements, not one.**

1. *"held it twice in a row without advancing, dispatching, or opening a packet."* The first
   drive **advanced** (Design → Build). The second **delivered**. Neither held.
2. *"Coordination is paused here: run the operator manually."* The next operator drive
   (`run_U1UkQ4yTT5fU`) started at **14:48:56.116** — two milliseconds **before** the note was
   written — and moved the task to Review at 14:49:19. A person who read that note and did
   what it says would have pressed Run operator on a task that was already coordinating.

**Why the rule could not see it.** `maybeResumeStrandedOperator` judges a drive by
`ownRun.movedToStageId`. Of the four things an operator drive can do, three are covered:

| act | how the backstop sees it |
|---|---|
| transition | `ownRun.movedToStageId`, stamped by `transitionStage` |
| dispatch an agent | `settleWaitingAfterOperator` returns early on `inFlightAgentRun` |
| open a packet / recommendation | `operatorLeftTaskStranded` returns false |
| **deliver** | **nothing** |

Delivery is also the one act whose effect can outlive the run row: the drive was marked
`finished` at 14:48:48 and its PR event reached the timeline at 14:48:56, an **eight-second**
window in which the task looked untouched to anything asking "did this drive change
something?".

**Why it is a finding and not a nitpick.** It writes a durable `heldAtStage` marker (V18) that
suppresses the backstop's own nudge at that stage until a human re-litigates it, and it tells
the owner in plain words that the machine has stopped and needs them. Here an unrelated
trigger — the delivery event itself — happened to re-arm coordination, so the lie was visible
within 23 seconds. On a task where the delivery IS the last event, the same note stands with
nothing behind it: no nudge, and a human told to intervene in a pause that the record
manufactured. It is F37-17's mirror — that one showed "agent working" while waiting on a
person; this one shows "paused, act now" while working.

**Fix — ruling 202.** `performDelivery` stamps `ctx.operatorRun.delivered` on ENTRY, before
its first await, and the backstop counts delivery as progress alongside a transition. Stamping
on entry rather than on GitHub's answer is the point: a refused push is still a drive that
acted, and the settle will not wait for the answer. Two canaries proven red — the obvious
wrong version (stamp on the `delivered` return, "record it once GitHub said yes") leaves a
failed push unstamped, and dropping the predicate's new arm puts the note and the marker back.

## F37-23 · Viberr promised a human's comment would reach the agent it named, through a channel that could not carry it — HIGH

**What viberr said.** SHOP-6, 13:21:57.181Z — I posted a correction to the Platform Architect
in the middle of a seven-round review loop. 72 milliseconds later, the policy engine wrote:

> **Not started:** @Platform Architect was mentioned, but its run did not start: This agent
> already has a run in progress on this task — **it will see the comment when it next
> re-anchors**, or mention it again once the run finishes. The comment stays on the record.

The refusal itself is right: one agent, one live run per task, or two processes share a
checkout. What follows it is the problem.

**What the channel actually is.** "Re-anchoring" is `canonicalTaskAnchor`, built by a FRESH
run (`specialist-run.server.ts:1906` — "EVERY fresh run re-anchors"). Its timeline section is

```ts
const ANCHOR_EVENT_COUNT = 5;
const recent = timeline.slice(0, input.events ?? ANCHOR_EVENT_COUNT);
```

— the **five** most recent events, each clamped to `ANCHOR_EVENT_MAX_CHARS`. So the promise
holds only if (a) that agent gets another fresh run on that task, and (b) the comment is still
inside a five-event window when it does. Viberr checks neither, and knows neither.

Compare what the mention normally does: the un-refused path hands the agent the comment as its
**directive** — `directive: input.text.trim(), directiveFrom: commenterName` — the whole
instruction, verbatim, as the reason the run exists. The refused path replaces that with a hope
that a clamped one-line summary is still in a five-slot list.

**What happened.** SHOP-6's timeline after my comment:

```
13:21:57.181  comment   Arda → @Platform Architect   (the instruction)
13:21:57.253  note      "it will see the comment when it next re-anchors"
13:22:01.924  comment   Platform Architect           (its in-flight run finishing, 4s later)
13:22:38.003  github
13:22:42.490  github
13:22:42.565  transition
13:22:42.640  note
13:23:06.294  comment   operator
13:23:12.994  agent     operator → Code Reviewer started
```

Within **75 seconds** my comment was eight events back — three past the window. And the
Platform Architect never had another run on SHOP-6: the task went Review → Verify → Done and
was accepted at 13:51. The agent viberr named as the recipient never received it, and nothing
anywhere says so.

**Why it is a finding and not a nitpick.** It is both halves of the bar at once. Viberr *lies*
— it states a delivery it has no mechanism for — and it *loses work*: a person's typed
instruction, accepted with a 200, rendered on the timeline, addressed to a named agent, and
silently never delivered. The person has no way to know: the note reads as reassurance, and
the failure leaves no trace. The advice it offers instead ("mention it again once the run
finishes") asks a human to poll a run they cannot see the end of.

**Viberr has already solved this exact problem, one layer up.** The operator lease keeps a
queue for precisely this case, and says why:

> a human `@operator …` comment carries a question that exists NOWHERE else in the run's
> input, so human triggers are kept in a queue and drained oldest-first ahead of the machine
> trigger (B-OP2: a transition landing behind a queued question used to overwrite it, and the
> person was never answered).

Specialists got the refusal and the sentence, and never got the queue.

**Fix — ruling 203.** Keep the promise instead of making it. At a specialist run's completion,
`deliverDeferredMention` looks for a human comment addressed to that agent posted after that
run started — which, because the single-flight guard is the only thing that could have refused
it, is by construction an undelivered one — and starts the run for it, carrying the person's
words as the directive, ahead of the operator's own react trigger (a person's instruction goes
first, exactly as B-OP2 ordered it). Nothing is queued in memory: the comment IS the record,
and "undelivered" is derived from it, so a restart cannot drop it. The refusal copy now says
what viberr will do rather than what it hopes the agent will notice. Three canaries proven red,
including the end-to-end one that unwires the completion hook — the helper's own test cannot
prove its caller exists, so it does not claim to.

## F37-24 · The escape hatch for a reviewer that cannot pass is keyed on the one signal that stops moving when the work gets stuck — HIGH

**Provoked, then watched, on SHOP-9.** Its Verify charter requires a cold-started stack;
SHOP-9 owns `packages/contracts/**` and `docs/contracts.md`, and the Makefile and services
belong to SHOP-15 and SHOP-10. So the Integration Verifier's blocker is real and SHOP-9 is not
allowed to fix it:

> request_changes … `make up` exited 2 because [Makefile](Makefile:5) is still a placeholder,
> and only `.gitkeep` exists under services/apps. Consequently migrations, real HTTP journey,
> trace propagation, and failure injection could not run. … **No approval is possible without a
> cold-started stack and integration evidence.**

The deliverer answered honestly and committed nothing:

> Re-anchored on `shop-9`; **no legitimate deficiency remains** within `packages/contracts/**`
> or `docs/contracts.md`, so no new patch was made.

The operator moved the task back to Verify and re-engaged the verifier **on the same
revision**, which blocked again. That is the deadlock ruling 193 exists to escalate.

**What the escalation signal read.** Ruling 193 escalates at `consecutiveRequestChanges ≥ 2`,
and the counter was:

```ts
const revisions = new Set<string>();
for (…) { if (v.result !== "request_changes") break; revisions.add(v.revisionId); }
return revisions.size;
```

Verdicts are **last-write-wins per (profileId, revisionId)** (F10-15), so the second
request_changes *replaced* the first. On the live file, after two objections:

```
verdicts:
  code-reviewer        rev_zBpyBbteAvt1  request_changes
  code-reviewer        rev_fHwMGQOVn_8i  approve
  integration-verifier rev_fHwMGQOVn_8i  request_changes     ← ONE row, two reviews
```

`consecutiveRequestChanges(integration-verifier)` = **1**.

**That is not a near miss; it is structural.** The counter can only exceed 1 when the deliverer
minted a NEW revision — that is, when the work is *moving*. In a genuine deadlock the deliverer
commits nothing, by definition, so no new revision ever appears and the count is pinned at 1
forever. The rule fires in the case where a packet is least warranted (productive rework) and
cannot fire in the case it was written for. My own ruling-193 test asserted this as correct
behaviour — *"counts the REVISIONS, so a re-run on the same revision is still one objection"* —
with a canary defending it.

**What saved it this time was not the mechanism.** The operator opened the packet anyway, on
its own reading:

> **Blocked:** Verify blocked by out-of-scope stack baseline. Opened a decision packet for the
> owner to resolve.

Good judgement, on a good model, on this run. F37-14's original symptom — ten rework rounds on
a one-file document — is what the same board looks like without it. A doctrine whose trigger
cannot see the state it describes is a doctrine that works only when it is not needed.

**Fix — ruling 204.** The verdict row stays last-write-wins (that model is right: a verdict
judges a revision, and the latest judgement binds). What must survive the overwrite is the
count of times this reviewer returned the same result on that revision: `rounds`, incremented
in the upsert, summed across the trailing request_changes streak. A re-review that blocks an
unchanged revision is now the second objection it plainly is; a re-dispatch that records no
verdict still counts for nothing, which is the distinction ruling 193 was reaching for and
missed by using revisions as its proxy. **Ruling 193's revision-counting is reversed, said so
out loud, and re-ruled** — along with the two prose descriptions that taught the reader the old
meaning (`get_task`'s field note and the turn doctrine), because a field whose description and
behaviour disagree is the defect ruling 200(i) was about.

## F37-25 · Ruling 203's own fix dropped the second message of a burst, silently — HIGH (self-review)

Found by testing ruling 203's own claim an hour after writing it. The doc comment said:

> Oldest first, one per completion, which drains a burst in order the way a queued human
> `@operator` trigger does (B-OP2) — **the next one rides the next completion.**

It does not. The window is `occurredAt > runStartedAt`: comments posted after the busy run
started. Deliver the oldest, and the redelivery run starts *now* — so at ITS completion the
window begins after every other comment in the burst, and no later completion can ever see
them again.

```
run R starts            t0
comment C1              t1   (refused: single-flight)
comment C2              t1.5 (refused: single-flight)
R completes             t2   → deliver C1, run R2 starts at t3
R2 completes            t4   → window is "> t3". C1 < t3. C2 < t3. Nothing pending.
                                 C2 is gone.
```

Two messages typed thirty seconds apart, the second one silently discarded — which is the
failure ruling 203 exists to stop, reintroduced by ruling 203's own fix, under a comment
claiming the opposite.

**The first version of the test passed against the broken code.** It posted two short comments
and asserted the run's prompt contained both — and it did, because the canonical anchor quotes
the last five timeline events, so the second comment appeared in the *summary* while never
reaching the *directive*. Rewritten with each comment padded past `ANCHOR_EVENT_MAX_CHARS`
(220) and carrying a unique tail token, the clamp cuts the token off and only the directive can
carry it. Then it failed, for the real reason. Second vacuous test of the pass caught before it
was believed; both were mine.

**Fix — ruling 205.** Every pending comment for that agent goes into ONE directive, not the
oldest into one run. One author's consecutive messages read as one message (which is what the
operator lease already does with a person's burst: one question, not N governed drives);
several authors keep their names inline, because the directive can only tell the agent to tag
one person back (NEW-4) and the others must at least be visible in what it is answering. The
person who has waited longest is the one it is told to tag.

## F37-26 · The anti-noise guardrail is on, configured, counted by Insights — and has never removed one event — med

**What viberr says.** Policy, `compression-threshold`, `on: true`, `value: 40 events`:

> Long timelines compress once routine events pass the threshold; typed events are always kept.

Insights, Delivery oversight: **6 · Long timelines · tasks past their project's compression
threshold**. The card's own code calls them "long-running records the readability machinery is
actively managing".

**What is on disk.** No compaction marker exists on any task in the project:

```
$ grep -l "Compacted" SHOP-*/task.md      →  (nothing)
```

while the six tasks the card counts are at 200, 134, 82, 63, 58 and 40 events against a
threshold of 40. SHOP-7 is five times over.

**Why nothing folds.** `compactTimelineEvents` collapses each run of **CONSECUTIVE** routine
comments outside the newest 24. On viberr's own event stream that run is essentially never
longer than one: a typed `agent`, `quality`, `github` or `transition` event lands between every
pair of agent replies, and the operator's prompt in between is explicitly excluded as a
`toAgent` governance hand-off. Measured on the live board:

| task | events | foldable routine comments (older region) | longest CONSECUTIVE run | their share of timeline bytes |
|---|---|---|---|---|
| SHOP-7 | 200 | 28 | **2** | 29% |
| SHOP-6 | 134 | 18 | **2** | 34% |
| SHOP-15 | 82 | — | **1** | — |
| SHOP-10 | 63 | — | **1** | — |
| SHOP-9 | 58 | — | **1** | — |

A run of two folds nothing either, because the newest agent reply in a run is kept and
`folded.length <= 1` is "no saving". So the guardrail's reachable output on this board is zero,
and that is what it produced.

**It is a documented intent, silently cancelled.** The module's own note says agent replies were
brought INTO the foldable set on purpose: *"Excluding agents outright meant an agent-heavy
timeline — the flood case anti-noise exists for — never compacted at all."* The adjacency
requirement cancels that change on exactly the workload it was written for. (The same note cites
`hasReworkSinceLastRejection` as the reason to keep the newest reply. **No such function
exists** — what reads a previous reply today is `latestAgentReplyText`, and it looks for the
reply before the CURRENT run, which is inside the untouched recent window.)

**Why it matters.** `task.md` is the canonical artifact every agent re-anchors on and every
write re-parses. It grows without bound while the mechanism that exists to bound it reports
itself active. Nothing is lost and no path is blocked — this is not a HIGH — but viberr is
stating something about its own behaviour that is not true, and the PRD names this exact risk.

**Fix — ruling 206.** Fold routine comments wherever they sit in the older region, not only when
adjacent; keep every typed event in place, keep the newest older agent reply verbatim, and put
the single marker in the OLDEST folded event's slot so newest-first ordering is unchanged.
Measured by running the real function over the real files:

```
SHOP-7 : 200 -> 174 events, 69231 -> 50336 text bytes  (27% smaller)
SHOP-6 : 134 -> 118 events, 45737 -> 31123 text bytes  (32% smaller)
SHOP-15:  82 ->  76 events, 22503 -> 17259 text bytes  (23% smaller)
SHOP-10:  63 ->  58 events, 24680 -> 22346 text bytes  ( 9% smaller)
SHOP-9 :  58 ->  55 events, 16266 -> 13138 text bytes  (19% smaller)
SHOP-1 :  40 ->  40 events (at the threshold, not over — untouched, correctly)
```

Every existing compaction test still passes: all of them put the foldable comments next to each
other, which is precisely why the defect was invisible. The new test uses the live shape —
reply, typed, reply, typed — and goes red against the adjacency rule.

## F37-27 · Twelve more claims viberr makes that its own code refuses — a systematic audit

F37-21 through F37-26 all came from one move: read a sentence viberr shows a human, then check
whether the code behind it can keep that promise. That is repeatable, so I ran it as a
14-agent audit — seven claim-emitting surfaces, each candidate handed to a skeptic told to
refute it, default refuted when uncertain. **20 candidates, 13 survived** (two were the same
defect found from two surfaces), and I verified each survivor against the code myself before
touching anything.

The shape recurs: the sentence is confident, the mechanism has a hole, and the hole is usually
in **the state the sentence is most about**.

| # | the claim | what the code does |
|---|---|---|
| a | "Run recovery replays the effects on the next restart" | the SAME write sets `waiting: "human"`; recovery selects `t.waiting = 'agent'` |
| b | "writes to it are refused" (Codex operator) | ruling 185 removed the OS sandbox; every Codex thread is `danger-full-access` |
| c | "Supervised → ONE recommendation card" | the `dispatch-agents` GRANT decides; `direct` is the seeded default and runs it |
| d | "Branch was already gone on GitHub" | every 422 was read that way, including "Reference cannot be deleted" |
| e | tag "@<dispatcher>" "so they are notified" | the dispatcher arrives as an EMAIL; the ladder matches a local part, never an address |
| f | "Viberr … opens the review PR when the task enters Review" | R15-2 deleted that hook in July |
| g | "The thread stays resumable" | a run with no `session_id` is skipped by `latestSessionRun` |
| h | "pick a Codex profile if the work cannot wait" | the hold is scoped to the task OWNER, who may have no Codex account |
| i | "Use **Run operator** on the task page" | `run-agents` is admin/maintainer; a contributor-owner never sees it |
| j | "no longer has a provider transcript (retention sweep or a wiped runtime volume)" | on an owner change the transcript is intact, in the previous owner's home |
| k | "Deliver the branch to push it" on `relation: "unknown"` | `unknown` means the compare could not be READ — the remote may be diverged |
| l | "PR #N is still open on GitHub" | read from a projection cache that ruling 177 bars the poller from refreshing |

**The two worst are (a) and (b).**

(a) is self-defeating in one write: the effects it fails to apply include a required reviewer's
**verdict**, so the acceptance gate stays shut on a review that actually happened and is sitting
readable in the run log — while the note tells the supervisor to wait for a restart that will
never select the task. The more faithfully they follow it, the longer it sits.

(b) is the dangerous direction: it tells a model the machine will refuse an action the machine
now permits. A model that reasons "the sandbox stops this anyway, so trying is harmless" will
try.

**Three of the twelve were caught by tests that had to be updated, not written** — the fixtures
encoded the old claim as correct (152(c)'s owner has only Claude connected, which is exactly
the shape the advice ignored). That is the same pattern as F37-26's compaction fixtures: a test
that agrees with the defect is how a defect survives.

**Fix — ruling 207(a)–(l).** Each part either makes the sentence true or makes the mechanism
keep it, and every one carries a canary. Where the honest answer is "viberr cannot know", it
now says so — (l) reports its own last reading rather than asserting live GitHub state, and (k)
names the uncertainty instead of promising the push will land.

## F37-28 · A decision packet whose options cannot produce the thing it asks for — med

> **CORRECTED, twenty minutes later: I blamed the wrong layer.** I resolved this packet by
> telling the operator to move the task back to Review — and viberr refused the move: *"**No
> allowed transition from Verify to Review.**"* The operator had not failed to offer the
> obvious option; viberr had taken that option away from it. The disease is **F37-29**, and
> the paragraphs below describe its symptom. What stands: the packet's two options could not
> produce the verdict it asked for. What falls: the claim that the operator should have known
> better, and the fix I proposed for it (a doctrine line about writing packets). The fix is
> ruling 208, in the mechanism.

**Live on SHOP-15**, after the Integration Verifier approved revision `b0b3628` at Verify:

> **Required Code Reviewer verdict is missing**
> @Arda, @Integration Verifier reported a fresh approve for revision b0b3628 … The live
> acceptance gate still reports one required reviewer approval missing: code-reviewer remains
> null, **with no live run available at Verify**. …resolve the missing Review-stage verdict
> before acceptance.
>
> 1. **Hold at Verify pending Code Reviewer** — *Keep the task blocked until the required
>    approval is recorded.* (operator pick)
> 2. **Archive without acceptance** — *Close the incomplete task while preserving its remote
>    branch.*

The state is legitimate and viberr's own rules produced it: the Code Reviewer approved
`c97ac22`; the verifier's request-changes produced `b0b3628`; ruling 179 binds verdicts to
revisions, so the older approval no longer counts; and ruling 133 scopes a supporting profile
to its declared stages, so the Code Reviewer cannot run at Verify. Every rule is right.

**What is wrong is the packet.** Option 1 waits for an approval that nothing can produce —
the operator's own sentence says there is no live run available at Verify — and option 2 throws
the work away. The move that resolves it was not offered: **change the stage**. Back to Review,
run the Code Reviewer on `b0b3628`, forward to Verify, where the verifier's approve still
stands. A human can do that from the task page's stage control, and the operator can do it with
`transition_stage`.

So it is not a path with no way out — the way out exists and is one click from the packet — but
a person who reads the two options as the available answers will hold a task forever or bin it,
and the recommended option is the one that holds.

**What I did, and why it is the fix I want tested:** I resolved it with the packet's own
*"Write your own directive"* option, telling the operator exactly that. The record now carries
the correction in my words and the operator re-engaged with it. The durable fix belongs in the
turn doctrine that tells the operator how to write a blocked packet: **when a required reviewer
cannot run at the stage the task is on, the STAGE is the thing to change, and an option that
only holds is not a resolution.** Ruling 208 states it beside ruling 193's arm, which already
handles the other half of this family (a reviewer that cannot pass).

## F37-29 · A task that cannot reach the only stage its missing reviewer can run at — HIGH

**Found by acting on F37-28 and being refused.** I told the operator, through the packet's own
"write your own directive" option, to move SHOP-15 back to Review so the Code Reviewer could
judge the current revision. The operator tried, and viberr answered:

> **Coordination stopped:** the `transition_stage` step failed (**No allowed transition from
> Verify to Review.**). The remaining plan was not executed.

**The state, all of it legitimate.** The board the controller designed declares two required
reviewers at two different stages, and two profiles whose declared stages differ:

| | required at | declared stages |
|---|---|---|
| `code-reviewer` | review | build, review |
| `integration-verifier` | verify | review, verify |

SHOP-15 sat at **Verify** with `validation: changed`: the Integration Verifier had approved
revision `b0b3628`, and the Code Reviewer's approval was on `c97ac22` — stale under ruling 179,
which binds a verdict to the revision it judged. So the acceptance gate correctly reported one
required approval missing, and ruling 133 correctly refused to run the Code Reviewer at Verify,
which is not one of its stages.

**The way out is a backward move, and viberr had closed it.** `verdictStageFor` is the function
that names the stage a task goes back to for a re-verdict, and it decides with:

```ts
const eligibleAt = (stageId) => reviewerSpecs.some((spec) => stageEligible(spec, stageId, …));
if (eligibleAt(fm.stage)) return null;          // "a verdict can be given here"
```

`reviewerSpecs` is **every** required reviewer. The Integration Verifier is eligible at Verify
— so `eligibleAt("verify")` is true, the function returns null, `reworkStages` comes back
empty, and `transitionStage` refuses the backward move as off-graph. The reviewer that could
give a verdict here had already given it. The one the task is waiting on could not be reached.

**What was left.** No operator move. No human move (the stage control offers the same graph).
Acceptance blocked on a gate that is genuinely unmet. The exits were **archive**, or an **admin
force-accept past a legitimately unmet gate** — which is the board lying to itself to get
unstuck. Below admin there was no exit at all. That is the bar's "blocking a path with no way
out", reached without anyone doing anything wrong.

**Why it survived until now.** Every board this codebase had been tested on declares its
required reviewers at ONE stage, where "is any required reviewer eligible here?" and "is the
one we are waiting on eligible here?" are the same question. The shopify-clone board is the
first with two, and the controller built it that way on its own — which is precisely the value
of letting it design its own workflow.

**Fix — ruling 208.** The scan considers only the required reviewers whose approve on the
CURRENT revision is missing. A reviewer that already approved cannot be the reason a re-verdict
is needed, so its eligibility must not answer for one that has not approved. Three cases pinned:
the missing reviewer is elsewhere (move back to its stage), the missing reviewer is eligible
here (no move — the old rule got this right and keeps getting it right), and nobody owes a
verdict (no move). Canary: restore "any required reviewer" and the first goes null.

## F37-30 · Compaction can fold the pointer to a file it does not delete — med

Found by checking ruling 206's first live firing rather than trusting it. SHOP-15 compacted
nine routine comments into one marker; the file came back sound (ordering intact, every typed
event present, every human comment present). Then I looked at what else those comments could
have been carrying.

**Evidence rows.** The `evidence-separation` guardrail takes an agent's raw output OFF the
timeline and onto disk, leaving a reference behind:

```
### 2026-09-13T16:35:27.194Z · comment · agent:codex/infrastructure-engineer (Infrastructure Engineer)
evidence:
- Timed lifecycle acceptance log · 1 attachment: S… · —
- Timed verification log · 1 attachment: S… · —
```

Agent-authored, not `toAgent`, no title — it matches every clause of `isRoutineComment`. It
survived this firing only because it sat inside the untouched recent-24 window.

Folding it would keep a count and drop the pointer: the attachment stays on disk, unreferenced,
and the proof behind a verdict becomes a file nobody can find from the record. Ruling 206 did
not create this — the old adjacency rule folded agent replies too — but it made it reachable on
every long task instead of almost never.

**Fix — ruling 209.** A comment carrying an evidence reference is not disposable prose and is
never folded. One clause, one canary: drop it and the attachment reference disappears into the
marker's count.

## F37-31 · The adversarial self-review of rulings 201–208 — nine defects in my own fixes

Five lenses over `git diff 9a5c9786..HEAD` (rulings 201–208, 51 files, ~2800 added lines),
each candidate handed to a skeptic told to refute it, base commit set correctly this time.
**21 candidates, 13 survived, 9 distinct.** Every one is in code I wrote today.

**The cluster that matters most — ruling 203's deferred @mention, four separate holes:**

| hole | what happens |
|---|---|
| the completion hop sat AFTER the `error` early-return | a busy run that ends in error drops the person's instruction |
| …and after the closed-task return | a task that closed underneath it drops it too |
| the window opened at `started_at` | a mention refused while the run was QUEUED behind a concurrency cap is filtered out |
| a redelivery that cannot start said nothing | the written promise stands on the record, uncontradicted, forever |

Each is the same failure ruling 203 exists to stop, reachable through the fix for it.

**And in the others:**

- **202**: `delivered` stamped on ENTRY to `performDelivery`, so `grant_withheld` / `no_workspace`
  / `bootstrap_failed` — arms where nothing reaches the remote — counted as operator progress.
  A nudged drive whose only action was an impossible delivery then looked like it moved, the
  stranded backstop skipped its durable `heldAtStage` marker, and every later trigger re-armed
  the nudge: F31-11's fourteen-drive loop, reached through the fix for ruling 202.
- **207(a) × 203**: boot recovery replays an old run's effects and handed the redelivery the
  ORIGINAL run's window, so a comment a human already had answered starts a duplicate paid run.
- **209 was incomplete**: `attachments` is a second, separate pointer list on the same event and
  I had excluded only `evidence`.
- **207(e) half-done**: the prompt got the resolved display name; the cc line the pipeline
  appends when the model forgets still carried the raw email — the fallback that exists
  precisely because the model forgot.
- **207(f) overstated**: I wrote "corrected in all six places". Two remained — a specialist
  prompt branch and a seeded skill doc.
- **201's sentence**: the "(N on Codex)" count spans both sides while the clause it rides names
  only delivery.
- **204's JSDoc** still stated the rule ruling 204 reversed, and argued for it.

**And a third vacuous test, mine.** The cross-agent guard test took three versions to actually
reach the guard: v1 named nobody (a different branch), v2 named a real agent but posted through
`appendComment`, which does not set `toAgent` — the flag the redelivery scan filters on — so the
comment was invisible before any profile comparison happened. Only v3, posting through
`commentToAgent` with two busy agents, goes red when the guard is relaxed. The lesson is now
written into the test.

**Fix — ruling 211(a)–(i).** Nine parts, nine canaries.

## F37-32 · A DNS failure told the owner to check their credentials, and the recommended fix was a permanent model change — HIGH

**Two live packets, both from transient host network faults, both wrong in a different way.**

**SHOP-10.** The Codex CLI reported:

> `Reconnecting... 2/5 (stream disconnected before completion: failed to lookup address
> information: Name does not resolve)`

Viberr's packet said:

> The Code Reviewer agent run failed: **Codex run failed: Codex execution failed. Review its
> authentication and runtime configuration.**

and offered exactly one recommendation: **"Redirect with sharper guidance."** The guidance was
never the problem — a name-resolution failure is not fixed by rewriting a directive, and the
credential it points at was never at fault.

Why: `LOCAL_NETWORK_FAILURE_RE` was written against Node's error codes and Node's prose
(`ECONNREFUSED`, `getaddrinfo`, `fetch failed`). The Codex CLI is Rust and says it differently,
so this matched nothing, fell through to `unknown`, and `unknown`'s sentence is the auth one.
Its TLS sibling on SHOP-16 matched only by accident — through `\btls\b` inside a `close_notify`
message.

**SHOP-16.** That one WAS classified correctly as a local network fault… and then recommended:

> **Retry @infrastructure-engineer on Claude now** *(recommended)* — The owner has Claude
> connected; re-run the same agent there on `sonnet` (Claude's default: the profile's
> `gpt-5.6-luna` is a Codex model) and continue. **Later runs on this task stay on Claude until
> another retry moves them.**

Two things wrong with that being the default answer. The fault is **this deployment's own
network path** — the other provider is reached over the same path, so switching is not a remedy.
And it permanently moves the task off the model its profile declares: on this board the owner's
standing policy is luna max for every non-controller agent, and the recommended click would have
migrated the task to `sonnet` silently. The copy is honest about the consequence; the
recommendation ignores it.

**What I did.** Took the non-recommended option on both — `request_edit` ("Retry on Codex now:
this deployment could not reach the provider") on SHOP-16, and "Send back for another attempt"
on SHOP-10 — and said why on each decision, so the record carries the reason and not just the
click. Both tasks were running again inside a minute.

**Fix — ruling 212.**
- The transport patterns learn the Codex CLI's own prose: `failed to lookup address
  information`, `name does not resolve`, `nodename nor servname`, `temporary failure in name
  resolution`, `peer closed connection`, `close_notify`. A DNS failure now reads as one.
- When the fault is local, the other-backend retry is still OFFERED (the owner may want it) but
  is no longer RECOMMENDED, and the option says why in its own text: *"This failure was on this
  deployment's own network path, which the other provider is reached over too, so this is a
  change of model rather than a fix."* The same-backend retry takes the recommendation.

Canaries: strip the new alternatives and the DNS text classifies `unknown` with the auth
sentence; restore `recommended: true` on the cross-backend arm and viberr's default answer to a
local network fault is a model change.

---

## F37-33 · A restart one second after a transition left the board waiting on an agent that no longer existed — HIGH

**Found by watching, not by reading.** SHOP-4 sat at `waiting: agent` with no live run for six
minutes. The board said an agent was on it. Nothing was.

The log puts the container stop at **18:57:35**, one second after the operator's own
`Review -> Build` transition at **18:57:34**. So the operator run had already reached `finished`,
and that is exactly why nothing repaired it:

| boot pass | selects | why it skipped this run |
| --- | --- | --- |
| `finalizeOrphanedRuns` | runs still `running`/`queued` | the run was `finished` |
| `recoverUnreactedAgentRuns` | finished runs with no `task.agent.replied` | it had replied |
| `recoverStrandedOperatorPlans` | plans never executed | it had executed |

The step that died was the one AFTER all of those: the settle that flips `waiting` and backstops
a stranded stage. All three existing passes are keyed on a **run**; this damage is keyed on a
**task**, and nobody was looking at tasks.

What that costs a human: the board makes a factual claim ("waiting on an agent") that is false,
with no run page to open, no failure to retry, and no button that means "there is nobody there."
The only exit is to guess that posting a comment re-wakes the operator. That is the blocking-with-
no-way-out bar, not a cosmetic one.

**Fix (ruling 213).** `reconcileRestartedWork` gains a fourth pass, `settleAbandonedWaits`, asking
the task-keyed question: which live tasks claim an agent while no run of theirs is `running` or
`queued`? Each gets a note in viberr's own words — *"Left waiting on an absent agent … the run
finished just before the stop and the follow-up that would have moved the task went with the
process. Nothing was lost from the record."* — and a fresh operator invocation. If the operator
cannot start (none deployed, a refusal, a throw), the task settles to `waiting: human`, because a
board that cannot name who it is waiting for must not name an agent. It runs last, so a run the
other three can still repair is repaired by its owner.

Canaries (both proved red): flip the `NOT EXISTS` to `EXISTS` — the sweep returns 0 and the board
keeps claiming an agent; rename the note title — the record no longer says why a run started.

---

## F37-34 · Viberr told the operator to ask a question no mechanism can deliver, then called the asking "no progress" — HIGH

**The clearest self-contradiction of the pass, and it cost the whole board.**

SHOP-10 (the service template) is the critical path: SHOP-2, SHOP-3, SHOP-11, SHOP-12 and
SHOP-13 all declare `blockedBy: SHOP-10`. At 19:10 it took its **sixth** consecutive
`request_changes` from the Code Reviewer, which is precisely the shape ruling 210 was written
for. The operator read ruling 210's arm, and did what it says:

> Ask the reviewer which, **in ONE comment**, and require the answer before the next rework:
> "name everything you would still block on across your owned surface, now". Do not send the
> deliverer back into another round until you have it.

**19:11:57 · comment · operator**

> @Code Reviewer, before another rework run, name everything you would still block on across
> your owned surface for the current revision, now. Confirm whether the lockfile/path
> boundary, clean-install dependency build flow, and frozen gateway-header contract are the
> complete blocker set…

A good question, correctly aimed, at an audience that does not exist. `operatorPostComment`
appends a timeline event and returns. It runs no agent, sends no notification, and sets no
`toAgent` flag — the operator's `post_comment` tool takes one parameter, `text`. The Code
Reviewer was never going to read it, because an agent reads only a directive that arrives with
a run.

**19:11:57 · note · system:policy-engine** — the same second:

> this stage auto-advances, but the operator held it twice in a row **without advancing,
> dispatching, or opening a packet** — treating that as a deliberate hold. Coordination is
> paused here.

So the turn doctrine told the operator to take an action, and the stranded backstop scored that
same action as having done nothing. Both are right about their own half: asking WAS the correct
move, and a comment IS no progress. What was wrong is that viberr named the one form of asking
that cannot work.

Viberr knew, too. Six bullets above the arm, in the same turn text:

> `liveRuns` in the snapshot is the ONLY proof of that (`waiting` is a display flag and **a
> directive comment on the timeline is not a running agent**)

Cost: a task at `waiting: human` under a question addressed to a reviewer that will never
answer, five tasks declared blocked behind it, and a remedy line ("run the operator manually,
adjust the goal, or loosen the boundary in Policy → Workflow rules") that does not mention the
actual next move — run the reviewer.

**Fix (ruling 214).** Three parts, because the doctrine and the tool both lied and the record
stayed silent:

1. Ruling 210's arm names `run_agent` on the reviewer with `delivers: false` and the question
   as its prompt, and says in the same breath that `post_comment` reaches no agent. The
   Code Reviewer's declared stages already include `build`, so the dispatch is legal exactly
   where the arm fires.
2. The `post_comment` tool description and the Codex plan schema's `text` description both say
   it is narration the humans read, that it starts no agent, and that an `@name` in it reaches
   nobody.
3. An operator comment that tags an agent **discloses the non-delivery** — "_@X is an agent,
   and an operator comment starts no run; nothing was sent to it. Run the agent to put this to
   it._" This is S5-G3's rule one audience over. That finding said it best: the old behaviour
   was noisy and wrong, and a silent one is worse.

Canaries (both proved red): restore "in ONE comment" and the arm's only named action is one
that reaches nobody; drop the disclosure and the comment reads as a question put to the
reviewer on a timeline where nothing was ever sent to it.

---

## F37-35 · The fix for F37-33 lied on its own first deploy — HIGH, and mine

**Found by reading the notification stream for the deploy I had just made.** Rulings 211-214
went out; twenty seconds later both live tasks reported this:

```
[EVT] SHOP-4  note :: **Restart:** this task was waiting on an agent, and no run was live
                      when the server came back — …
[EVT] SHOP-16 note :: **Restart:** this task was waiting on an agent, and no run was live
                      when the server came back — …
[EVT] SHOP-16 note :: **Restart:** the run `run_xbkO35zoCEAg` (agent) was still running when
                      the server stopped; it is recorded as interrupted by the restart …
[EVT] SHOP-4  note :: **Restart:** the run `run_JFvmbzdPmEZH` (reviewer) was still running
                      when the server stopped; it is recorded as interrupted by the restart …
```

Two notes on each task, one second apart, contradicting each other. A run WAS live. The one
that says otherwise is mine, from ruling 213.

**Why.** The boot chain runs `finalizeOrphanedRuns` first, and its entire job is to move
`running`/`queued` rows to `interrupted`. It does that synchronously and returns promises for
its re-invokes, which the chain awaits at the END. `settleAbandonedWaits` runs at step 4 and
asks "which tasks claim an agent while no run of theirs is running or queued?" — a question
step 1 has already made unanswerable, because it just erased the only evidence that separates
an abandoned wait from an interrupted one. Every genuinely-orphaned task now reads as abandoned.

Cost: a false sentence in the canonical record, sitting next to the true one; and a second
operator drive for a single restart (the lease coalesces them, but both were paid for).

I had verified ruling 213 live and it was a real proof — two tasks stranded for over a minute
with zero live runs, settled correctly. That case was genuine. What I never exercised was the
case where a run IS live at the stop, because the first deploy happened to catch a quiet
board. The second one did not.

**Fix (ruling 215).** `finalizeOrphanedRuns` returns `claimedTasks` — every task it took,
capped ones included, since a capped task is still one that pass decided about — and
`settleAbandonedWaits` withholds them. The ordering does not change and was never the problem:
the sweep runs last precisely because the passes above it may START a run. What it needed was
the one fact it could not read off a board step 1 had already rewritten.

Canaries (both proved red): drop the filter and the sweep settles the orphan sweep's own task,
writing "no run was live" under "was still running when the server stopped"; drop the third
argument at the call site and the wiring test sees `undefined` where the set should be.

---

## F37-36 · The remedy the "coordination is paused" note names first is the one that does not work — MEDIUM

`heldAtStage` is the stranded backstop's durable marker. When the operator holds a stage twice
running, viberr records it and writes:

> **Note:** this stage auto-advances, but the operator held it twice in a row without
> advancing, dispatching, or opening a packet — treating that as a deliberate hold.
> **Coordination is paused here: run the operator manually when the hold should end**, adjust
> the goal, or loosen the boundary in Policy → Workflow rules.

SHOP-10 carried that note, at `waiting: human`, with SHOP-2, SHOP-3, SHOP-11, SHOP-12 and
SHOP-13 declared blocked behind it. I did the first thing on its list: pressed Run operator.

The operator ran and did real work — `update_branch_from_base`, eight commits merged in, pushed
to origin. Afterwards `heldAtStage: build` was still in the frontmatter and the board still read
"Coordination is paused here."

Every other human re-litigation clears that marker: a goal edit (V18's own reasoning — "the hold
was the operator honoring the OLD goal"), a stage transition, a packet resolution, acceptance, a
dependency release. A person pressing the button the note points at did not. And because the
backstop reads the standing marker and returns before it, the drive that person paid for also
got no nudge when it stranded — so a manual run on a held task is quietly weaker than an
ordinary trigger on an unheld one.

**Fix (ruling 216).** The same branch in `runOperator` that already lifts ruling 157's
packet-less hold now lifts this one, using the discriminator it had already computed: a `manual`
trigger carrying an `actor` is a person. A "Hold lifted" note names them and the stage.

A **schedule deliberately does not** lift it. V18 exists because "every external trigger (a
schedule firing hourly, an `@operator` aside) started an unmarked drive, the backstop paid ONE
fresh nudge, and the second stranding appended a byte-identical hold note — two drives and a
duplicate note per trigger, forever." Both halves are tested.

---

## F37-37 · The projection stopped tracking the files, every task page 500ed, and health said `ok` — HIGH

**Cause first, because it was mine.** I had been reading the live `projection.sqlite` from the
macOS host with the `sqlite3` CLI while the container wrote to it over VirtioFS — the dual-writer
hazard this repo already has a memory note about. At 19:36:04 the store returned `disk I/O
error`, and 150ms later `database disk image is malformed`. That part is an environment fact and
an operator error, not a viberr defect.

**What viberr did with it is the finding.** For the next twelve minutes, on a running instance:

```
error  run line persist failed                 database disk image is malformed
error  run divergence marker could not be persisted
error  codex operator completion handling failed   ← the operator's decision, lost mid-execution
warn   clearWaitingToHuman failed                  ← and the fallback behind it
error  projection rebuild failed   sourcePath: projects/…/SHOP-10/task.md
error  watcher rebuild failed      path: /data/projects/…/SHOP-10/task.md
error  request handler error       GET /projects/…/SHOP-10.data   ← a 500 to the human
```

and, the whole time:

```json
{"ok":true,"status":"ok","degraded":[],"projections":{"projects":1,"tasks":16},"watcher":true}
```

`run_Sapz5OGTRDpW` sat `running` for twenty minutes with no process behind it (confirmed by
`ps` inside the container: two codex processes, neither its). The operator turn a human had
paid for was executed and then thrown away, because `fullReplyTextForRun` could not read the
run's own log lines back.

Health was not lying about anything it checked. The damage was in particular btree pages, so
`SELECT COUNT(*)` on `task_projections` still answered 16 — **a count is not a verdict about
whether the mirror still follows the record.** And the one condition the route's contract calls
fatal, "the database cannot be read", was false: it could be read, just not written or rebuilt.

Viberr knew the whole time. `rebuildPath`'s catch wrote the store's own sentence to the log on
every single failure. It had nowhere to put the fact. `boot.server.ts` already names this exact
shape for the one cause it probes for at boot:

> the task stops projecting and its row goes stale, **with nothing on any surface saying why**

**Fix (ruling 217).** That catch sets a process latch (`store-health.server.ts`) holding the
failing file, the store's own message and a failure count; the next rebuild that WRITES clears
it. `healthSnapshot` reports it as `degraded: ["projections"]` with the reading in
`projectionStore`, so `?probe=readiness` answers 503 and the controller's `instance_health` sees
it too. A latch, never a probe — no `PRAGMA integrity_check` on an 87MB file every few seconds,
and no alarm that outlives the fault, which is what ruling 146 refused to let this endpoint do.

Canaries (all three proved red, on a REAL failing rebuild produced by pulling `task_events` out
from under it, not by calling the latch by hand): drop `recordProjectionFault` and the fault
reads null while the rebuild still fails; drop the clear and the instance alarms forever after
one bad write; drop the `degraded.push` and health reports `ok` with the fault standing.

**Recovery, recorded because it is the product's own claim under test.** `sqlite3 .recover`
rebuilt the store: integrity `ok`, 16 tasks, 355 of 367 runs, 245 notifications, 16210 run-log
lines. `audit_events` came back as **0** — its rows had landed in `lost_and_found`, and 2128 of
them were reinserted by matching the `evt_` id prefix against the table's ten columns. The
canonical markdown was untouched throughout, which is the point: the board, the timelines and
every verdict came back exactly as they were.

---

## F37-38 · A projection that failed to rebuild once stays wrong forever, and ruling 217's own latch hid it — HIGH

**Found by disbelieving my own fix, ninety seconds after deploying it.** The board's list view
showed SHOP-4 with the chip **"waiting on you"**. Its file said:

```
SHOP-4   stage=build    waiting=agent   readiness=ready   validation=failing
```

The file had been written at 19:58:57. The board still disagreed with it at 20:00:13. Pressing
**Re-scan** made the chip disappear, which is what proved it was the projection and not the
renderer.

The log named the cause exactly:

```
19:58:57  request handler error         disk I/O error  at recordProvenance
                                                        ← rebuildPath ← reprojectTask ← resolvePacket
19:58:58  projection rebuild failed     disk I/O error  at agentNamesByProfile
                                        sourcePath: projects/…/SHOP-4/task.md
19:58:58  watcher rebuild failed        disk I/O error  at recordProvenance
```

Two defects, and the second one is mine.

**(a) Nothing retries a failed rebuild.** A projection is rebuilt when its file CHANGES. If that
single rebuild fails — a transient I/O error, a locked store, a full disk — the file does not
change again, so the row keeps whatever it held before, indefinitely. "Files are truth" quietly
stops being true for that task, and the only cure is a human happening to press Re-scan on a
board that gives them no reason to.

**(b) Ruling 217's latch held one slot.** So health was back to `ok` with `projectionStore: None`
the whole time SHOP-4's row disagreed with its file — because SHOP-16's file had rebuilt fine in
between and cleared the slot. The fix I shipped two hours earlier reported the instance healthy
over exactly the state it was written to catch.

**Fix (ruling 218).**

1. The watcher's own debounce queue re-arms a failed path on a backoff — 2s, 5s, 15s, 45s, 120s
   — resetting on the first success and giving up after the last step. Past that the fault is
   not transient: it stands in the latch and health reports the instance degraded, which is a
   person's problem and not a timer's. Retries are tracked in the watcher handle and cancelled
   with everything else on stop, so a retired watcher can never rebuild against a retired root.
2. The latch is a map keyed by source path. A success clears only its own file;
   `projectionStore` reports `{files, latest}` so a reader can tell one flaky write from a store
   that stopped accepting them.

Canaries (all proved red): delete `scheduleRetry` and the retry test never converges — the
timeline stays one comment behind its own file, exactly as SHOP-4 did; clear the latch wholesale
instead of per path and one file's success reports a healthy instance over another's stale row.

---

## F37-39 · A projection failure aborted the action that had already written the truth — HIGH

**Found by asking why SHOP-4 had not moved in eleven minutes.** It read `waiting: agent`, the
board said "agent working", and `ps` inside the container showed exactly one codex process — on
SHOP-10. Its last timeline entry was the packet decision at 19:58:57.

The log at 19:58:57:

```
error  request handler error   POST /projects/…/tasks/SHOP-4.data
       disk I/O error
         at recordProvenance
         at rebuildPath
         at reprojectTask
         at resolvePacket
```

`rebuildPath` wraps every rebuild in a try/catch so that one bad file cannot take the process
down. Inside that catch it wrote a provenance row recording the failure — **to the same store
that had just failed.** A throw from inside a catch propagates, so in the one situation the
catch exists for, a broken store, `rebuildPath` raised into its caller anyway.

What that cost: `resolvePacket` had already written SHOP-4's task file. The decision is on the
record, correctly, and always was — the canonical write is not what broke. What died was
everything the resolution still owed after the reproject, the **operator re-invoke** included.
So the task was left claiming an agent, with no agent, and nothing scheduled to notice.

It is the sharpest version of a pattern this pass keeps finding: viberr writes the truth to the
file and then loses the consequence. F37-33 lost it to a restart; this one loses it to a cache
update, which is worse, because the cache is not supposed to be able to stop anything.

**Fix (ruling 219).** The provenance note is attempted inside its own try; a store too broken
to take even that gets one `warn` line. `rebuildPath` returns `{action: "error"}` on every path
and can no longer throw. The caller learns about the failure the way health does — through the
ruling 217/218 latch — instead of by dying.

Canary (proved red): remove the inner try and the test throws `no such table: provenance` out
of `rebuildPath`, which is exactly the line `resolvePacket` died on.

---

## F37-40 · The MCP list is silent about the servers that withhold nothing — MEDIUM

**Found by testing a sentence the controller wrote.** Reading the Controller page, I hit this,
about an MCP server the owner had asked it to grant:

> **I cannot withhold the write tools.** There is no per-tool filter anywhere in my surface …
> Granting `kb-files` grants all 14 tools, including the 4 write ones. Nothing about the
> marking in Org settings propagates into the agent's runtime through any control I hold — **if
> Viberr enforces that marking, it does so somewhere I cannot read, and I won't assert that it
> does.**

I went to check whether viberr keeps that promise. **It does**, on both transports and both
backends: `specialist-mcp.server.ts` computes the denials, Claude gets them as
`disallowedTools` (`mcp__<server>__<tool>`, applied after the auto-approval so the deny wins
even under `bypassPermissions`), Codex gets them as per-server `disabled_tools`, and HTTP servers
additionally carry `permission_policy: "always_deny"`. The controller's caution was right about
its own visibility and wrong about the product — and ruling 188, earlier in this same pass, had
already fixed the read it was missing. That message predates the fix. **Recorded as verified,
not as a finding.**

The finding is what I saw next, in Org settings:

```
kb-files          stdio · …server-filesystem /data/kb
                  14 tools · checked yesterday · stale, retest · 4 write tools withheld from read-only runs
kb-architecture   stdio · …server-filesystem /data/kb/shopify-clone-architecture
                  14 tools · checked yesterday · stale, retest · 3 templates
kb-conventions    stdio · …server-filesystem /data/kb/shopify-clone-conventions
                  14 tools · checked yesterday · stale, retest · 3 templates
```

The gated server announces itself. The two that withhold **nothing** — same stock
`server-filesystem`, same 14 tools, each granted to **three agent templates** — say nothing at
all, because the row renders the write-tool line only when `writeTools.length > 0`.

So the state a reader most needs to see is the one state the list does not show: tools that look
like writes, nobody reviewed them, nothing is withheld. And what those two servers actually hand
out is write access to the knowledge bases viberr injects into every other agent's prompt as
trusted configuration — the exact hazard the controller reasoned about for the third server and
declined. It could not see that it had already granted it twice.

**Fix (ruling 220).** The row states which of the three cases a server is in — gated and how
many, reviewed with nothing withheld, or N write-looking tools with nothing withheld and nobody
having reviewed them. It is the human's half of the sentence ruling 188 gave the controller. A
server whose discovered tool names contain nothing write-shaped stays quiet: there is no
position to state, and a row that alarms on everything is a row nobody reads.

Canary (proved red): render "" for the unreviewed case and the row goes back to saying nothing
about a server three templates can rewrite the knowledge bases with.

---

## F37-41 · A corrupt file on viberr's own disk was reported as a credential problem, with "rewrite the prompt" recommended — HIGH

**Found by reading a recovery packet I had to answer.** SHOP-3's Platform Architect run failed
right after I answered its decision, and viberr opened this:

> **Work stalled: pick a recovery path**
> The Platform Architect agent run failed: Codex run failed: **Codex execution failed. Review
> its authentication and runtime configuration.**
> *Provider said:* `…failed to open thread history database: failed to open thread history DB at
> /data/runtimes/users/<u>/codex-home/thread_history_1.sqlite: error returned from database:
> (code: 26) file is not a database`
> Recommended: **Redirect with sharper guidance** — re-prompt the specialist with a corrected
> directive.

The credential was fine. No directive could have helped. I checked the file: 76MB, and its first
sixteen bytes are a b-tree page header, not `SQLite format 3`. The database's first page is gone.

This is F37-32's lesson for a different surface. That finding taught viberr the Codex CLI's words
for a *network* fault; this is the CLI's own *disk*. The text matched no arm, fell to `unknown`,
and `unknown`'s sentence is the credential one.

**What made it expensive is the part viberr could have got right for free.** Fresh runs kept
working the whole time; only RESUMES failed, because only a resume opens the thread history. That
is exactly the shape `session_missing` already names — "neither a credential problem nor a task
failure; the honest recovery is a fresh run re-anchored on task.md" — and its remedy and packet
options were already correct. Viberr had the right answer one branch away and took the wrong one.

**Fix (ruling 221).** An unreadable store classifies as `session_missing`. The two roads into
that class are then told apart where it matters to a person: a vanished session heals itself on
the next fresh run, while a store that cannot be opened keeps failing **every** resume on this
host until the file is repaired or removed. A single shared marker constant carries the
distinction from the adapter to the remedy layer, so neither side re-parses the provider's prose
twice.

The pattern is anchored on the store's own nouns rather than on "file is not a database" alone,
and that restraint has its own test: the clone this pass is building is SQLite-backed, so an
agent hitting a bad file *in its own work* must not be reported as a session failure.

Canaries (both red): remove the arm and the live text classifies `unknown`, whose sentence is the
credential one; remove the remedy branch and a human reads "the session no longer exists" about a
file that is right there and will break the next resume too.

**Recovery.** I moved the corrupt file aside and answered the packet with what had actually
happened; the CLI recreates it, resumes start fresh, and SHOP-3 resumed on the next run. The
corruption itself is environment — the same host episode as F37-37 — and, as there, the finding
is what viberr said about it.

---

## F37-42 · The agent's question arrived in the inbox under the Operator's name — MEDIUM

**Found by reading the notifications page after answering two packets.** The row for SHOP-18:

> **Operator**·SHOP-18 cannot satisfy its required filter/facet sidebar against the current
> frozen contracts. Please publish the facet endpoint's request/response schemas and gateway
> route…

Those are the **Frontend Engineer's** words. Its question packet says so
(`from: agent:codex/frontend-engineer`, `askedBy: frontend-engineer`), and so does the audit row
for the same event. The inbox says Operator.

`notifyTaskWatchers` ends with `from: notice.from ?? OPERATOR_NOTIFY_FROM`, and the agent's
`ask_human` path passes no `from`. The title it does set — "Frontend Engineer asks: …" — is not
what the row renders; the row renders the chip and the body.

The reason this is worth fixing rather than shrugging at is two calls above it, in the same
function:

```ts
recordAudit(db, {
  action: "task.agent.packet_opened",
  // P11-23: the agent opened this question packet — attribute it to the agent.
  actor: { userId: null, label: encodeActorRef(input.actorRef) },
```

Viberr settled this exact principle for the audit trail and did not carry it to the surface a
person actually reads. And the chip is not decoration here: an inbox exists to say who wants
something from you, and answering "the Operator" when a specialist is blocked on a contract
decision points the reader at the wrong conversation.

**Fix (ruling 222).** The question notification carries the asking agent as its `from`. The
default stays as it is — it is right for the many notices the operator genuinely authors, and
narrowing it further belongs to a surface caught getting it wrong, not to a hunch.

Canary (proved red): drop the `from` and the notification reads
`{ kind: "agent", name: "Operator" }` — the fallback every un-attributed notice lands on.

---

## F37-43 · Viberr merged the revision its reviewer REJECTED and lost the one both reviewers approved — CRITICAL

**The worst thing found in this pass, and it was found by reading one sentence in an acceptance
note.** SHOP-17 (the API gateway) reached Done and merged PR #12. The completion record said:

> Human acceptance recorded. SHOP-17 transitioned to **Done** and the review PR was merged.
>
> Note: PR #12's head could not be verified against the delivered revision before the merge
> (GitHub could not be reached for the check). It was accepted without that containment check.

That note is honest, and it is also the whole story compressed into one sentence nobody would
act on. Checking what actually merged:

| fact | value |
|---|---|
| revision **Code Reviewer approved** | `1f99f68504f3` |
| revision **Integration Verifier approved** | `1f99f68504f3` |
| `workRevision.headSha` in `task.md` | `1f99f68504f3` — and **no `pushedAt`** |
| `pr.headSha` | `9104562baccf` |
| what the Code Reviewer said about `9104562` | **`request_changes`** |
| what merged into `main` | `9104562baccf`, as merge commit `5fd18eb` |
| does `1f99f68` exist on the remote? | `fatal: remote error: upload-pack: not our ref` |
| does the lockfile-repair commit `7d58fb5` exist? | `not our ref` |

So viberr merged the revision its own required reviewer had **rejected**, discarded the revision
both required reviewers had **approved** — it lives nowhere but a disposable workspace — deleted
the remote branch, and marked the task Done.

**Why the guard did not fire.** Ruling 135 built exactly this containment check, and its
reasoning is right: a compare whose base is a never-pushed sha 404s, so one direct commit read
confirms it and the acceptance is refused with *"it cannot be accepted until the PR carries the
reviewed revision."* The confirming read asked `isMissingRefAnswer`, which knows `404` and the
empty-repository `409`. Measured against the live API:

```
GET /repos/akin-ozer/shopify-clone/compare/1f99f68…...9104562…   → 404 Not Found          ✅ matched
GET /repos/akin-ozer/shopify-clone/commits/1f99f68…              → 422 "No commit found
                                                                       for SHA: 1f99f68…"  ❌ not matched
```

`/commits/{sha}` does **not** 404 a well-formed 40-character SHA it cannot find. The probe
confirmed nothing, execution fell through to `unverifiable`, and `unverifiable` is deliberately
allowed through — "the merge's own honesty covers unreachability" (A9). The disclosure a human
reads then blames GitHub reachability for what was actually a classification miss.

**And the test hid it.** Ruling 135's canary stubs the commit read as:

```ts
{ status: 404, body: { message: "No commit found for SHA" } }
```

GitHub's real *sentence* with an invented *status*. The fixture copied the message and guessed
the code, so the canary went red for the right reason on a shape the API never produces, and the
guard has been unreachable since the day it shipped.

**Fix (ruling 223).** The commit read gets its own predicate, `isMissingCommitAnswer` — 404, the
empty-repository 409, or a 422 whose message names a missing commit. Kept separate from
`isMissingRefAnswer` on purpose: 422 is GitHub's generic validation status, and widening the
shared predicate would make unrelated failures on every other endpoint read as "the ref is gone".
The fixture is corrected to the real answer, and GitHub's actual response is pinned in its own
unit test rather than left as a fixture's guess.

Canary (proved red): remove the 422 arm and the acceptance **resolves instead of rejecting** —
`AssertionError: promise resolved … instead of rejecting` — which is precisely the live event:
the task goes Done and the merge lands.

**What is deliberately NOT changed, and is the owner's call.** An `unverifiable` head still
merges with a disclosure. That is A9's documented trade — refusing on every transient GitHub
failure has its own cost — and with the classification fixed, the live failure mode is closed.
But the sentence a human reads in that case is worth re-ruling: it names the check that did not
run and not the consequence, which is that unreviewed or rejected code may now be on `main`.

**Repository state after the finding.** `main` carries the gateway at `9104562`, which is
functional (it is the revision that passed everything except a lockfile repair and the shared
stack-test generalisation) but is NOT the reviewed revision. SHOP-19, which the controller
created to own that generalisation, waits on SHOP-17 and SHOP-3 and can absorb it.

### The surviving half, closed 2026-09-14 (ruling 226, owner's call)

Ruling 223 made the 422 probe reachable, which closed the exact live failure. What it did not
close was the design underneath it — A9's deliberate trade, where a head that could not be
VERIFIED still merged and the note named the check that did not run rather than what that
meant. I put it to the owner with the background and they chose **refuse and ask**.

The load-bearing distinction turned out to be one A9 had stated and then not enforced. Its own
words are *"the merge's own honesty covers unreachability"* — true when GitHub is unreachable,
because then the merge fails too. False in exactly one case, which is the dangerous one: GitHub
**answers** the pull request and refuses only the comparison. Then the repo is reachable, the
merge will land, and the only missing thing is the knowledge of what lands. That case now
refuses; the rest still pass with A9's disclosure.

And a refusal needs an exit, or it is the next finding. The gate records the question on the
task — both shas in it, three real answers — and the override is pinned to one
(PR, revision, live head) triple with the deciding person's name on it. Not force-accept, which
bypasses the verdict gate and has never been able to touch this one.

**Two canaries paid for themselves before the deploy.** The waiver had no line in the frontmatter
key order, so it never reached disk: the gate re-reading it would have refused forever, and the
override would have been a button that did nothing. And A9's own test *described* "GitHub
unreachable" while its fixture answered the pull and failed the compare — this ruling's case,
not A9's. The fixture, not the ruling, was what made the old behaviour look intended. That is
the second time in two days a fixture has been the thing standing between viberr and a real
answer (ruling 223's invented 404 was the first).

---

## F37-44 · When the Codex window went, every option on the packet was wrong — HIGH

**Found by having to answer it.** At 23:28 the owner's Codex account hit its usage limit and
six tasks stalled inside two minutes — SHOP-3, SHOP-11, SHOP-12, SHOP-18, and two more behind
them. Each opened the same packet, and viberr had all the right facts in it:

> **Work stalled: pick a recovery path**
> Codex refused the agent run: Arda's account is over its usage limit…
> *Provider said:* `You've hit your usage limit… or try again at Sep 14th, 2026 2:27 AM.`

It had parsed that instant (`exhausted.resetsAt`), stored it, and rendered it. Then it offered
four ways out, at 23:28, with the window reopening at 02:27:

| option | what it does at 23:28 |
|---|---|
| **Retry on Claude now** *(recommended)* | its own detail: *"Later runs on this task stay on Claude until another retry moves them"* — on `sonnet`, because the profile's `gpt-5.6-luna` is a Codex model. A permanent model-policy change, in one recommended click, on a deployment whose owner set every specialist to one model deliberately. |
| **"The window has reset… send the agent back"** | asks the human to **assert** something the provider had just said would not be true for three hours. |
| Redirect with sharper guidance | re-prompts an agent that cannot run. |
| Hold for runtime debugging | freezes coordination and asks the human to come back. |

And the packet cannot just be left open: an open packet refuses the operator, so nothing moves
until it is answered. The real choices were **change your model policy, say something false, or
be awake at 02:27** — times six tasks.

This is ruling 212's lesson repeating. That one found viberr recommending a permanent model
change as the fix for a DNS failure, and made it offered-but-not-recommended. The same option is
still the recommendation here, for the one failure class where a better answer exists and viberr
already owns the machinery: **a schedule runner that fires an unattended run at an instant.**

**Fix (ruling 224).** A quota refusal whose reset instant is known and still in the future gets
a `wait_for_window` option, and that option takes the recommendation:

- the packet closes and the board settles to `waiting: human` — **not** `waiting: agent`, because
  no agent is coming for hours and claiming one is F37-33's lie by another road;
- a `run-operator` schedule is written for one minute past the provider's own instant (a window
  that reopens "at 02:27" is not open at 02:27:00);
- the **operator**, never a blind re-dispatch of the same agent: hours pass, the board may have
  moved, and every other timed resume viberr has — the dependency release, the restart
  recoveries — re-invokes the operator for exactly that reason;
- a schedule that cannot be written says so on the timeline, names the manual fallback, and
  never un-resolves the decision the human already made.

Nothing is offered when there is no dated reopening, when the window has already reopened, or
for a failure that is not a spent window — waiting fixes nothing about a rejected credential.
All three restraints have their own tests.

Canaries (both proved red): remove the option and the recommendation falls back to the permanent
model change; remove the schedule effect and the decision promises an automatic resume that
nothing performs.

**And the same defect, one builder over.** Deploying the fix and re-triggering the stall proved
it live — and produced the OPERATOR's own quota packet, which is a separate builder
(`operatorOptions`) that the specialist fix never touched. Its recommended option was *"The usage
window has reset… or I switched the Codex account: re-run"*, recommended at 23:43 for a window
the provider had dated 02:27. It now carries the same wait, and the assert-it-reset option keeps
its place but loses the recommendation. Worth recording as its own lesson: the live re-trigger is
what found the second half, because the first fix's tests only ever exercised the builder it
changed.

**And a third half, from re-triggering again.** With both builders fixed, the regenerated packet
STILL carried no wait — because `RunFailureFacts.resetsAt` is populated from a machine
`rate_limit_event` the provider sends *during* a run, and a Codex refusal at spawn time sends
none. On exactly the failure that stalls a board, the facts are silent. Viberr did know the
instant: the quota store had parsed it out of the provider's own sentence and `/resources/health`
was rendering it as `exhausted.resetsAt: 1789352820`. The option now reads that store when the
facts carry nothing, which is also what makes the packet agree with Insights and Profile instead
of inventing a second source of truth.

That is the pass-24 trap — *"several pass-23 silent-drop fixes were INERT (wired to seams that
can't fire)"* — caught this time only because the fix was deployed and re-triggered against the
live stall rather than declared done when its tests went green.

**And a fourth half: answering the decision re-created it.** With the option finally on the
packet, taking it wrote the schedule correctly and then, seven seconds later, opened a brand new
packet asking the same question. Resolving a packet re-queues the operator by default — and that
re-queue was refused by the very quota the decision exists to wait out, whose failure opened a
fresh packet. `wait_for_window` now sits in `NO_REQUEUE` beside `hold_runtime_debug`, for the
same reason: the human asked for no run.

Four passes, green tests after every one of them, and each was still wrong in production. The
only thing that found any of it was deploying and provoking the real failure again.

---

## F37-45 · The board said "waiting on a human" about four tasks waiting on a clock — MEDIUM

**Found by reading viberr's own promise back to it.** Ruling 224's packet copy, which I had
written and shipped four hours earlier, ends:

> Closes this decision and schedules an operator run for just after Sep 14, 2026 · 02:27 UTC…
> **Nothing runs until then and the board says so.**

The board did not say so. With all four schedules written and pending, the cards read:

| task | card tag | what was actually true |
|---|---|---|
| SHOP-11 | waiting on a human | resumes 02:28, unattended |
| SHOP-12 | waiting on a human | resumes 02:28, unattended |
| SHOP-18 | waiting on a human | resumes 02:28, unattended |
| SHOP-3 | waiting on a human | resumes 02:28, unattended |

…under a header counting **"5 waiting on a human in this project"**, of which four were waiting
on nobody. Nothing was asked of any person, and no surface anywhere named the time.

**The cause is older than ruling 224.** `waiting: human` in a task file does not mean "a human
owes something" — it is simply what `clearWaitingToHuman` writes when the last run ends, i.e.
"no agent is working, a human is next". Every waiting-sensitive surface renders that as the
sentence "waiting on a human", which was true for as long as a person really was the only way
forward. Ruling 224 introduced the first state where a task moves on its own, and the sentence
became false the moment it shipped.

**Fixed as ruling 225** — `schedule` as a fourth DERIVED waiting value, on the LV-20 pattern:
the canonical file keeps saying `human`, the projection decides once, and the card, the board
subtitle and filters, the review row and its subline, the task page's "Waiting on" rail and the
controller's own board summary all move together.

**The half that took the thinking** is the limit, not the rule. `decisionsRequiring` reads this
same column, so a careless derivation would not have softened a lie, it would have HIDDEN a
decision — an open packet, a live recommendation, or a completion a human could accept right now
all keep `human`, because a schedule takes none of that off anybody's hands. The predicate is
pinned to the acceptance gate the inbox itself uses, so a clock rest is by construction never a
row that inbox would have counted.

The "no activity" cue needed the same care in the other direction. A clock rest must not light
it — the gap is hours by design — but exempting the state outright would have hidden the one
genuine stall it can have, a schedule that came DUE and never fired. Its idle clock restarts at
the due instant instead: silent until then, quiet on the human threshold after.

### The canary caught something the fix had not planned for

The first green-to-red run failed on `CHECK constraint failed: waiting IN ('human','agent','none')`.
The derivation was correct and the STORE refused it — which arrives as a swallowed "projection
rebuild failed" and a stale row, the exact silent staleness `boot.server.ts` probes the column
next door for (F21-1) and ruling 217 built the health latch for.

Reading that probe is what turned one fix into three. `projectionCheckGaps` covered
`task_projections.validation` and `notifications.kind` — a list of the columns someone had been
bitten by, not of the columns at risk. `waiting` is a CHECK over a TS enum the projector derives
into, exactly like `validation` beside it, and it was missing. So: the baseline CHECK is widened,
`WAITING_VALUES` is pinned to it structurally (the sibling of the F21-1 pin, which needs no
fixture for the next member), and the boot probe reads this column too.

Had the canary not been written first, this would have deployed as four tasks that silently
stopped projecting the moment they started resting on a clock.

---

## F37-46 · A human tagged the operator, viberr said nothing, and nobody came — MEDIUM

**Found by using the product for its own purpose.** The owner chose "rebase and re-review" for
SHOP-2, so I drove it the way a user would: opened the task and wrote

> @operator PR #13 conflicts with main… bring shop-2 up to date with main, re-deliver, and put
> the resulting revision back through both required reviewers.

The comment posted. The mention rendered highlighted, the way a routed mention does. The
composer's own footer says **"Every project member can comment · @mentions route to agents."**
The task then sat there.

The only trace of what actually happened is one line in the container log:

```
{"msg":"operator run refused — a decision packet is open","trigger":"manual",
 "taskKey":"SHOP-2","packet":"Authorize shared stack-test amendment?"}
```

SHOP-2 had an open packet from 23:26, and an open packet refuses the operator. That refusal is
correct. Saying nothing about it is not: the instruction reads as accepted, and the person who
wrote it has no way to learn otherwise short of reading server logs.

**Ruling 141 already fixed this exact shape, one layer over.** Its own words: *"a queued trigger
that is REFUSED when it reaches the front of the lease queue says so on the task — the refusal
used to exist only in the server log while the timeline still said 'Scheduled action starting'."*
That covers a trigger refused at the front of the LEASE QUEUE. All three refusals at the DOOR —
closed, blocked-by, open-packet — write nothing, and the door is where a person's instruction
arrives.

The code comment sitting directly above the silent refusal even names the danger, from a
previous pass: *"a decision nobody was told about: 75 minutes, ten downstream tasks held behind
it, and a board that said an agent was working."* The fix made then was to settle the waiting
flag. Nobody was told then either.

**Fixed as ruling 227** — a `manual` trigger refused at the door gets ruling 141's note, with the
arrival sentence corrected (it never reached a queue) and the consequence stated: "no run was
started, so nothing on this task has been acted on."

**And the two triggers deliberately left out are the interesting half.** `scheduled` is not
added, though ruling 141's reasoning covers it, because the schedule runner already notes and
retires its own fire-time refusals — adding it here would have written the same note twice, and
`schedule.server.test.ts` is what caught the duplicate before it shipped. The machine triggers
stay silent because they fire constantly and refuse routinely; noting each would bury the one
that means something, which is R16-2's failure applied to a timeline.

**Confirmed by the sequel.** Once the packet was resolved, the identical comment on the identical
task triggered an operator run within seconds — and the operator replied to it by name. The
mechanism works. It just had no voice for the case where it declines.

---

## F37-47 · The run the board waited three hours for did nothing, and nothing noticed — MEDIUM

**Found by watching the thing ruling 224 had just fixed.** At `02:28:19` SHOP-3's schedule fired
and the operator ran — the first run after a three-hour quota wait. It produced exactly one
event:

```
02:28:54 · policy · operator
  The operator's plan was not carried out in full. This step was refused by its
  capability policy:
  - `update_branch_from_base` — SHOP-3 is at Verify, the acceptance boundary: the
    branch is brought up to date once, at acceptance time, and merged in the same
    ceremony. Do not refresh it here; recommend or accept the completion instead.
  What it intended:
  > The delivered PR is clean but 3 commits behind main; update the task branch
  > before engaging the required Verify reviewer.
```

Then nothing, until I posted a comment at `02:53:21`. **25 minutes parked**, immediately after
three hours of waiting, and the task page showed "awaiting verdict" with no hint that its run had
achieved nothing.

**The refusal is correct and well written.** It names the step, the reason, and the remedy. The
remedy is addressed to the operator — and the operator's turn had ended before the sentence was
written. Nobody was ever going to read it.

**The backstop that should have caught it asks the wrong question.** `operatorLeftTaskStranded`
ends with:

```ts
return workflow.some((w) => w.from === task.stage && w.boundary === "auto");
```

That is the right question for a drive that CHOSE to stop — at an auto-advance stage, something
should have happened. It is the wrong question for a drive that was STOPPED. SHOP-3 was at
Verify, whose outbound boundary is `human`, so the drive that did nothing at all looked exactly
like a drive correctly waiting for a person.

**Fixed as ruling 228**: a plan refused *in full* is stranded whatever the boundary, and takes
F31-11's single nudge with its own instruction — the idle-stage sentence would be false twice
over (the stage need not be auto-advance, and the run did not end idle by choice). The nudge is
told the refusals are on the timeline with their remedies in them, and forbidden from re-planning
the same refused action. A nudged drive refused in full again records the durable hold and stops,
exactly as F31-11 requires.

**Two things the test fixture taught me**, both of which sharpened the ruling:

1. An **empty or unparseable** plan is already handled — viberr opens a packet titled "Operator
   turn produced no actionable plan". My first fixture tripped that path instead, which is how I
   learned the gap is *specifically* the plan that named real work and was refused every bit of
   it. The ruling says so explicitly now.
2. "In full" has to be exact. `refused` holds one entry per step that did not run, so equality
   with the plan length IS "nothing happened" — and a step that THREW breaks the loop early,
   leaving the counts unequal. That is correct: an abort is narrated on its own terms and must
   not also be nudged.

**Cost of the gap, measured:** ruling 224 bought back three hours of board time at 02:28, and
SHOP-3 handed 25 minutes of it straight back fourteen seconds later.

---

## F37-48 · WITHDRAWN — the specialized path already existed, and everything behaved

> **Withdrawn the same hour it was written, after the owner asked the obvious question I had
> not: "why does it want the whole kb MCP — there were specialized ones, maybe."** Nothing
> wanted it. The answer was in the controller's own first paragraph, which I had read and not
> weighed:
>
> > *The read benefit is zero. `shopify-clone-architecture` and `shopify-clone-conventions` are
> > already native KB grants on exactly the profiles you named… They read that content today.
> > `kb-files` would hand them a second path to the same two files.*
>
> Viberr's specialized mechanism for "let this profile read this knowledge base" is the native
> KB grant, it is per-KB, and it was already granted to every profile in question. `kb-files`
> was a second, broader path to the same content, mounted at the store ROOT, and the controller
> declined it for that reason before it ever reached the write-tool argument.
>
> I also checked the copy I accused of overstating its protection. `writeToolPosture`
> (resource-rows.tsx, ruling 220 — mine, from earlier in this pass) renders
> `· N write tools withheld from read-only runs`. **"Read-only runs" is exactly the binding
> condition**, stated in viberr's own vocabulary. It does not overclaim.
>
> What is left is a design limit, not a defect: an MCP grant has no read-only mode. That limit
> only bites when an admin mounts a broad filesystem server over content the product already
> serves a narrower way — and when that happened, the controller caught it, refused to assert
> an enforcement it could not read, and said so. Recorded in VERIFIED.md instead, where it
> belongs.
>
> The measurements below are kept because they are correct and worth having.

### Original writeup, kept for its measurements

## An MCP server can only be granted whole, and its one safety mark misses the profiles that matter

**Found by the controller, in the course of doing its job, and verified against the files.** The
owner added a credential-free filesystem MCP server (`kb-files`, mounted at `/data/kb`, 14 tools,
4 marked as write tools) and asked the controller to grant it to the profiles that would benefit.
The controller probed it, found it healthy, and **declined to grant it to anyone** — then
explained why, in terms that turn out to be exactly right:

> I cannot withhold the write tools. There is no per-tool filter anywhere in my surface:
> `save_global_agent` takes `mcps` as a flat list of grant keys… Granting `kb-files` grants all
> 14 tools, including the 4 write ones. Nothing about the marking in Org settings propagates
> into the agent's runtime through any control I hold — **if Viberr enforces that marking, it
> does so somewhere I cannot read, and I won't assert that it does.**
>
> The repo-write gate does not cover this. `execute-code-or-write-repo` gates the task repo;
> these tools write to `/data/kb`. And `/data/kb` is the root of the whole KB store… So a
> granted agent gets read access to every KB in the org regardless of its own grants, and write
> access to the files that are injected as trusted configuration into the other agents, the
> operator, and me. **A reviewer that rewrites the conventions KB changes the standard the next
> reviewer is judged against.**

**Both halves check out.**

*The enforcement it could not see exists* — ruling 176, in `specialist-mcp.server.ts`:

```ts
const denied = options.withholdWriteTools ? row.writeTools : [];
```

and viberr does put it on the controller's own surface, as `writeToolsNote`: *"N write tools are
withheld from every run without `execute-code-or-write-repo`, and from every operator run."* The
controller's refusal to assert it was appropriate caution, not ignorance — but the note was there
to read.

*And that note is the finding.* `withholdWriteTools` is driven by whether the run withholds
**repo-write**, and repo-write is about the **task repository**. `/data/kb` is not the task
repository — it is viberr's own configuration store. Verified against this project's
`project.md`:

| profile | `execute-code-or-write-repo` | would `kb-files` write tools mount? |
|---|---|---|
| `code-reviewer` (the deployed reviewer) | **direct** | **yes** |
| `reviewer` (the generic library profile) | off | no |

So the protection binds on the profile nobody was going to grant it to, and misses the deployed
Code Reviewer — the exact profile the owner named. The Org-settings row reads "N write tools
withheld from read-only…", which is true of a narrower set of runs than a reader would take it
to mean.

**There is no way to express the thing that was actually wanted.** "Grant this server read-only"
has no representation: a grant is a server key, and the only modifier is a marking whose binding
condition is a capability about a different filesystem. The controller's choice was grant-all or
grant-none, and it correctly chose none — which means the feature the owner set up is
unreachable as configured.

**Not ruled on** — and then withdrawn, see the note at the top of this entry.
