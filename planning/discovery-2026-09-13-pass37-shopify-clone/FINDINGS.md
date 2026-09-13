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
