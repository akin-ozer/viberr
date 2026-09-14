# Pass 37 — areas probed and found correct

Recording what held up, so the fix pass does not disturb it and the next reader knows it
was actually tested rather than assumed.

## RBAC across all four project roles + a real non-member — CORRECT

Five accounts, each signed in over HTTP with its own session (`__Secure-` cookie, real CSRF
token from the root loader, same-origin headers), probed against SHOP-5:

| probe (form intent) | maya `admin` | luca `maintainer` | noor `contributor` | sam `viewer` | zoe **non-member** | contract |
|---|---|---|---|---|---|---|
| `comment` | 200 | 200 | 200 | 200 | **404** | A M C V |
| `set-task-metadata` | 200 | 200 | 200 | **403** | **404** | A M C |
| `transition` (`to=design`) | 200 | 200 | **403** | **403** | **404** | A M |
| `run-agent` | 400† | 400† | **403** | **403** | **404** | A M |
| `accept-completion` | 400† | 400† | **403** | **403** | **404** | A M |
| `force-accept` | 400† | **403** | **403** | **403** | **404** | A only |

† passed the RBAC gate and was stopped by a *downstream* gate — the acceptance ceremony
("Accepting SHOP-5 needs the confirmation dialog: this request carried no record of what was
shown…") or profile validation. That is the correct ordering, and the contrast is the proof:
on `force-accept` the admin reaches the ceremony check (400) while the maintainer is stopped
at the role check (403).

Every refusal names the role and the action in the person's own terms, e.g.

- "Your project role (viewer) cannot accept completion into Done."
- "Your project role (maintainer) cannot force-accept past the review gate."
- "Your project role (contributor) cannot change the task stage."

The non-member gets **404 on every door**, never 403 — "not yours" and "never existed" look
identical, which is the intended posture.

Two smaller things confirmed in passing:

- **Toast honesty (F32-10) works.** Moving SHOP-5 to Design when it was already there
  answered "SHOP-5 is already at Design · nothing changed" rather than claiming a move.
- **CSRF is genuinely closed.** A POST carrying a valid session and a valid token but no
  `Origin` / `Sec-Fetch-Site` / `Referer` is refused 403. The concession for curl-shaped
  callers really is gone.

## Empty-repository bootstrap — CORRECT

`akin-ozer/shopify-clone` had no commits and no default branch when the controller attached
it. Viberr created `main` with an initial commit (`f6166a9`) before cutting the first task
branch, and recorded it as a typed timeline event on SHOP-1:

> Bootstrapped the repository: `akin-ozer/shopify-clone` had no branches, so Viberr created
> **main** with an initial commit `f6166a9` (a README naming the project) before cutting this
> branch.

## Stage-eligibility remap across differing boards (ruling R14-1) — CORRECT

A profile declaring stage ids this board does not have (`ready`, `impl`) is remapped by
structural role rather than silently disabled, and the Agents page renders the resolved truth
("2 of 6 stages", with the non-matching chips struck through). See F37-3 for the one surface
that does *not* resolve it.

## Branch collision against a pre-existing ref (ruling 122) — CORRECT

Before SHOP-6 existed I planted a decoy on GitHub by hand: branch `shop-6` off `main` with a
commit (`03260d9 scratch: abandoned work on shop-6`), to look like abandoned work from a
previous attempt.

When goal-1 link 2 materialised as SHOP-6 and delivery went to cut its task-key branch,
viberr detected the collision, allocated a suffixed name, and wrote the reason and the ruling
into the task timeline:

> Branch `shop-6-efd4` allocated: `shop-6` is already spoken for on GitHub (a ref or a past
> pull request), ruling 122.

It did not silently reuse the stranger's branch, did not fail the dispatch, and did not
leave the person guessing why the branch name differs from the task key.

## Cycle 1 end to end — CORRECT

SHOP-1 ran a full governed cycle with no human help beyond the final accept:

1. Operator selected Infrastructure Engineer and dispatched (Codex / `gpt-5.6-luna` / `max`).
2. Agent built the monorepo skeleton, pushed `shop-1`, viberr opened **PR #1**.
3. Code Reviewer (required at Review) returned **request-changes** on `de2c195`, naming two
   real defects — `--passWithNoTests` meaning the suite asserts nothing, and a root export
   pointing at `src/index.ts` that Node 22 cannot load. Validation flipped to **failing**.
4. Operator moved Review → Build; the engineer added 5 regression tests and pushed `68807cf`
   to the same PR.
5. Code Reviewer **approved** `68807cf`; operator moved Review → Verify.
6. Integration Verifier (required at Verify) **approved** `68807cf` after really running
   Node 22.14.0 + pnpm 9.15.4 frozen install, recursive lint and build.
7. Acceptance gate opened only then. Before both verdicts it read, precisely:
   "Not acceptable yet. Waiting on 1 required reviewer approval of the current revision."
8. The accept dialog disclosed merge target (PR #1 → `main`), branch behaviour, revision
   `68807cf4cfd2` and verdict, and warned merging is one-way.
9. Accepting merged PR #1 (`a27cda7f`), deleted `shop-1`, moved SHOP-1 to Done, and wrote
   `github`, `completion` and `transition` timeline events.

Verdicts are genuinely revision-bound on disk — `request_changes` carries
`headSha: de2c195…`, the approvals carry `headSha: 68807cf…`. A stale approval cannot be
reused for a new revision.

## Recommendations — EXERCISED

Once both verdicts landed, the operator wrote a recommendation rather than acting:
"**Recommendation:** Accept completion and move SHOP-1 to Done. The review is clean and the
work meets the goal." `completion-for-acceptance` is `recommend` in this deployment, and the
operator respected it even at `autonomy: full`.

## Audit export, and the secrets invariant — CORRECT

`GET /org/settings/audit-export?format=csv|json` answers 200 for the org admin and **403**
for an org member who is not an admin (probed as maya). CSV carries the documented header
`id,occurredAt,actorUserId,actorLabel,action,subjectKind,subjectId,projectSlug,taskKey,details`.

Grepped the whole export (64 KB CSV / 122 KB JSON) for every secret in play — the GitHub PAT
body, `ghp_`/`sk-ant` prefixes, `CLAUDE_CODE_OAUTH_TOKEN`, the seed admin password and all
five probe passwords: **zero hits**. The only near-misses are deliberate and harmless:
`k3ui` is the four-character display *suffix* viberr shows as `····k3ui`, and `github_pat` is
the literal `subjectKind` of a PAT audit row. The longest opaque strings in the file are git
SHAs.

## The reconciler — RUNNING

Observed unprompted in the audit log:

```
github.reconcile.task · SHOP-2 · {"repo":"akin-ozer/shopify-clone","branch":"shop-2",
                                  "changed":false,"sync":"behind_main"}
```

It correctly classified SHOP-2's branch as `behind_main` — which is true, and is a
consequence of F37-2 having let that branch be cut before the foundation landed.

## Decision packets, end to end — CORRECT

Provoked deliberately: I had the controller create SHOP-7, a task whose goal says the choice
of payment provider is the owner's and the agent must not make it.

**1. The agent asked instead of choosing.** It researched (using `use-web-search-fetch` —
`web_search · site:docs.adyen.com …` is in its run log), wrote
`docs/decisions/payment-provider.md`, touched nothing else, opened no PR, and raised a
`blocked` packet. Its report was precise about its own limits: "No services, apps, packages,
SDKs, adapters, schemas, migrations, or webhook handlers were touched… The Prettier check
could not run because pnpm is unavailable in the workspace."

**2. The packet was well-formed**: three substantive options (Stripe *recommended*, Adyen,
Mock-only), each naming what it commits the schema, PCI posture, webhook surface and
commercial position to; plus a free-text arm and an optional operator note.

**3. The free-text arm works.** I answered with my own directive (mock-only behind a
`PaymentProvider` port). Viberr recorded "**Decision:** answered with a custom directive.
Operator re-engages with it." and tagged the asking agent with the answer verbatim.

**4. A real failure was handled honestly.** Re-engaging meant resuming the agent's Codex
session, which had expired. Viberr did not pretend otherwise:

> The Platform Architect agent run did not complete: the agent's stored Codex session no
> longer exists, so its history could not be resumed. **No changes were delivered.** Re-prompt
> the agent: it will start a fresh run and re-anchor on this task file. Provider transcripts
> expire, and wiping the data root removes them too.
>
> What the provider reported:
> `Error: thread/resume: thread/resume failed: no rollout found for thread id 01a099a4-… (code -32600)`

Verbatim provider error, plain-language cause, honest consequence, concrete remedy.

**5. It opened a recovery packet** with three options (`redirect` *recommended*,
`request_edit`, `hold_runtime_debug`). I resolved it with the redirect plus an operator note;
the operator re-engaged. The human's original directive survives in the timeline, so the
fresh run re-anchors on it — nothing was lost to the expired session but time.

Packet kinds exercised this pass: `blocked` (agent question), `blocked` (run failure
recovery), with option kinds `redirect`, `request_edit`, `hold_runtime_debug` offered and a
custom directive resolved.

## Attachments and the evidence-separation guardrail — CORRECT

Agents write raw validation output to `attachments/`, not the timeline — the
`evidence-separation` guardrail working without being asked. SHOP-1 alone carries six real
logs (`…-install.log`, `…-typecheck.log`, `…-lint.log`, `…-test.log`, `…-structure.log`,
`SHOP-1-validation.log`), and the content is genuine (`$ npx --yes pnpm@9.15.4 install
--frozen-lockfile --offline …`).

The raw-bytes route (R19-19) is gated exactly as specified — member-only, not role-graded:

| caller | result |
|---|---|
| arda (project admin) | 200, 3992 bytes, `text/plain` |
| sam (project **viewer**) | 200 — a member may read evidence |
| zoe (**non-member**) | **404** |
| unauthenticated | 302 → `/login` |
| `…/attachments/..%2f..%2f..%2ftask.md` | **404** — traversal refused |

## Schedules, and ruling 131(d)'s working half — CORRECT

Scheduled an operator re-run one minute out on SHOP-5, a **held** task. The record, in order:

```
08:18:58  Scheduled: an operator re-run for SHOP-5 at 08:19:58 — "Scheduled probe: report
          status." It runs on the profile deployed when it fires.
08:20:09  Scheduled action starting: running the scheduled operator re-run for SHOP-5 …
08:20:09  Scheduled action skipped: SHOP-5 waits on other work (goal-3 link 6) — no operator
          run was started; Viberr releases the task when every entry is done.
```

Runs started on SHOP-5: **0**. So `HELD_TRIGGERS`' `scheduled` arm really does refuse, and
says so rather than failing quietly. This is worth recording precisely because it bounds
F37-2: ruling 131(d) was doing its job for the three operator triggers it covers, and the
hole was only the *specialist dispatch*, which ruling 186 now closes.

## Ruling 160 — a person's PR close is respected — CORRECT

I closed PR #2 by hand on GitHub, without merging, to reject SHOP-7 deliberately. The
reconciler caught it and viberr refused to route around it:

> **Divergence:** PR #2 was closed on GitHub without merging, but SHOP-7 is still active.
> Decide whether to rework and reopen, or archive the task.

and, when the operator next tried to deliver:

> No pull request was opened for SHOP-7: PR #2 was closed without merging. A closed pull
> request is a person's decision about the task, so Viberr opens no new PR for this branch.

## Scope violations — CAUGHT, by the mechanism the controller designed

The Code Reviewer rejected SHOP-6's delivery with, among other findings:

> 1. `pnpm-lock.yaml` is outside the declared owned paths. Remove it or explicitly expand task
>    ownership.

The path-set ownership the controller invented in its conventions KB is being enforced by the
required reviewer it deployed, against a real diff.

## Boot recovery — CORRECT

Recreating the container while an agent run was live:

> **Restart:** the run `run_19PtdepIDG3L` (agent) was still running when the server stopped;
> it is recorded as interrupted by the restart, and the operator is re-invoked.

## "Files are truth" — re-tested at the end of day two: 98 comparisons, 0 mismatches

After a day of churn — a board re-plan that rewrote nine goals, six new tasks, two resolved
packets, a hand-wiped `pr:` block and four image rebuilds — I re-ran the projection-versus-file
comparison across all 14 tasks: `stage`, `readiness`, `waiting`, `branch`, `title`, `archived`
and the whole `blockedBy` list. **98 comparisons, 0 mismatches.**

**A tooling error worth recording, because it looked exactly like a finding.** My first run
reported 10 mismatches — every held task's `readiness`, file `input_required`/`ready` against
db `blocked`. That was my bug, not viberr's: `task_projections` carries BOTH `readiness` (the
derived, display value) and `stored_readiness` (what the file says), and I compared the file
to the derived column. The derivation is documented at length in `task.server.ts` and exists
so a card never says "blocked" and "agent working" at once. Comparing against
`stored_readiness` gives zero. Third time this pass my own instrumentation has manufactured a
false finding; the discipline that catches it every time is checking the product's own
definition of the field before believing the diff.

## "Files are truth" — tested three ways, not assumed

The owner's ask was literal: *files-are-truth means the record is testable, so test it.* Three
legs, run against the live store after the ruling-187 fix.

**1. SQLite projection vs the canonical markdown.** Every task, six fields each
(`stage`, `waiting`, `archived`, `branch`, `pr.number`, `blockedBy`), read independently from
`task_projections` and from `task.md`'s frontmatter:

```
42 comparisons across 7 tasks — MISMATCHES: 0
```

**2. The record vs GitHub.** Every `github.commits[]` entry, every branch, every PR state
checked against the real repository:

```
SHOP-1  de2c195   reachable from origin/main, origin/shop-1, pr/1   ok
SHOP-1  68807cf   reachable from origin/main, pr/1                  ok
SHOP-6  15d4c0a   reachable from origin/shop-6-efd4, pr/3           ok
SHOP-7  f104c66   reachable from origin/shop-7, pr/2                ok
SHOP-7  b92d818   reachable from origin/shop-7, pr/2                ok
SHOP-7  9467d83   reachable from origin/shop-7, pr/2                ok
SHOP-7  f01c963   reachable from origin/shop-7                      ok

GENUINE PHANTOMS: 0
```

Branch and PR states agree too (`pr #1 merged` ↔ GitHub `closed`+merged, `#2 closed` ↔
`closed`, `#3 review` ↔ `open`). Before ruling 187 this leg had one real phantom — `3aad6ff`
on `shop-2`, an object that existed in no repository and no workspace. It is gone, and the
loss is on the timeline in words.

**A method note, because I got it wrong first.** My initial version compared recorded commits
against branch *heads* and PR head SHAs, and flagged three "phantoms" that were simply
ancestors of a head. Ancestry is the test (`git for-each-ref --contains <sha>`), not equality.
Anyone repeating this check should start there — a head-only comparison manufactures findings.

## What was NOT exercised, and why

Recorded honestly rather than claimed:

- **Browser capability.** Granted to all eight specialist profiles and enforced at mount, but
  no agent has used it: there is no storefront to drive yet (that is goal-4, still blocked
  behind the foundation chain). Tool census across the pass: 733 `exec`, **26 `web_search`**
  (so `use-web-search-fetch` *is* in real use — the Platform Architect researched Stripe and
  Adyen docs), 12 `ToolSearch`, and the controller's own tools. Zero browser calls.
- **Guardrails — UPDATED, two of four now observed.** `meaningful-comment`,
  `no-duplicate-summary`, `compression-threshold` and `evidence-separation` are all on.
  `evidence-separation` fires routinely (agents write validation output to `attachments/`
  rather than the timeline). `no-duplicate-summary` fired for the first time on SHOP-5 at
  11:34, during the board-wide re-plan, and the refusal is exactly the right shape — it
  names the rule, says nothing was written, and rides the same "plan was not carried out in
  full" note every other refused step uses:

  > `post_comment` — NOT posted — identical to your previous comment
  > (no-duplicate-summary guardrail). Nothing was added to the timeline.

  `meaningful-comment` and `compression-threshold` still have zero firings across the pass.
  No agent has produced chatter and no timeline has crossed the compression threshold —
  which is a fact about this workload, not evidence about those two rules.
- **Force-accept.** No task has reached the acceptance boundary with a failing or missing
  verdict, which is the only state where force-accept means anything. The RBAC probe did
  confirm the door is admin-only (maintainer → 403 "Your project role (maintainer) cannot
  force-accept past the review gate", admin → reaches the acceptance ceremony).

### CORRECTION, 2026-09-14 08:00 UTC — three of those four are now exercised

The list above was true when written and is no longer. Left in place rather than edited, because
what was believed at the time is part of the record, but a fresh-context reader must not act on
it. Re-measured today:

- **Browser capability — USED.** The storefront exists now (SHOP-4 merged, SHOP-18 delivered), so
  there is something to drive. Across the run logs: **543 lines carrying `browser_`**, 84 carrying
  `viberr_browser`, 284 carrying `playwright`. The tool names in those lines are real MCP calls
  (`viberr_browser`, `browser_tabs`), not prose. Heaviest users: SHOP-4's Frontend Engineer (30
  lines in one run), SHOP-18's Frontend Engineer, SHOP-4's Code Reviewer and Platform Architect,
  and the controller itself. "Zero browser calls" is dead.
- **`compression-threshold` — FIRED, on six tasks.** Ruling 206 made the folding
  non-adjacency-based, and the live board now carries markers naming what they replaced:

  ```
  SHOP-2   2 markers    SHOP-3   3    SHOP-10  1
  SHOP-11  3 markers    SHOP-12  2    SHOP-18  1
  ```

  SHOP-6 (134 events) and SHOP-7 (200) carry none, and that is correct rather than a gap: both are
  merged and done, compaction only runs on a write, and nothing re-anchors on a closed task's file.
- **Force-accept — EXERCISED**, both the door and the act. See "Force-accept — the ACT, end to end"
  further down this file; the RBAC matrix covers the door.
- **`meaningful-comment`** remains the one guardrail with zero firings, and that is still a fact
  about this workload rather than evidence about the rule.

## Environment fact for the next pass — pnpm is not on an agent workspace's PATH

> **CORRECTED LATER THE SAME DAY — I got this call wrong.** I wrote "not a finding" below and
> filed it as an environment quirk that cost one review round. It was the visible edge of
> **F37-13**, which cost the pass far more than a round: 75 `command not found` lines, a root
> `Makefile` whose every target exits 127, an architecture built on a Docker Compose stack that
> cannot come up, and a REQUIRED reviewer chartered to `make up` that could therefore never
> approve anything — ten rework rounds on a one-file document, and a Code Reviewer verdict
> that claimed a pnpm validation run which never happened. What I missed was not the symptom
> but the three things around it: viberr's own toolchain probe (ruling 182, built to answer
> "what would an agent's shell actually find here") did not probe `make`, `docker` or any
> package manager but npm; the reading was reachable only through the controller's opt-in
> `instance_health`, which it never called; and no agent prompt carried it at all. Rulings 191
> and 196 are the fix. The paragraphs below stand as written — they are what I actually
> observed — and the judgment attached to them does not.

Not a finding; worth writing down because it cost this pass a review round. The clone is a
pnpm monorepo, and agent workspaces have `node` and `npm` but no `pnpm` binary. Agents have to
reach it through `npx --yes pnpm@9.15.4 …`, which needs npm-registry egress and sometimes an
`--offline` fallback once the store is warm.

All four roles hit it at some point (Infrastructure Engineer, Platform Architect, Code
Reviewer, Integration Verifier), so it is **not** a viberr-imposed asymmetry between
delivering and supporting runs — I checked that specifically, because the deliverer once
reported "the Prettier check could not run because pnpm is unavailable in the workspace" while
the verifier had just run `npx --yes pnpm@9.15.4 install --frozen-lockfile --offline`
successfully. Same capability, same backend; the difference was whether that particular run
reached for npx.

The visible cost: SHOP-7 spent a review round on a Prettier formatting failure the delivering
agent could not check for itself before delivering.

## Work-revision drift after review — CORRECT

Deliberately diverged, as the owner asked: after the Code Reviewer had recorded a verdict on
SHOP-6, I pushed a commit to `shop-6-efd4` **by hand**, as a human hotfixing a reviewed
branch would.

Viberr caught it on the next reconcile and said exactly what it meant:

> **Revision moved after review (ruling 179):** PR #3's head is now `d84a354`, **1 authored
> commit since review merges unreviewed**. The verdict on `5729a38` no longer binds: the new
> head is the revision under review and needs a fresh verdict before SHOP-6 can be accepted.

The record carries the structured form, and crucially distinguishes the two ways a head can
move:

```yaml
pr:
  headSha: d84a35429538bf4f272c200f6eb678525c0186ef
  revisionDrift:
    headSha: d84a35429538bf4f272c200f6eb678525c0186ef
    authored: 1          # a commit somebody wrote — merges unreviewed
    baseRefresh: null    # not a base merge, which would be innocuous
```

So an approval cannot be laundered onto code nobody reviewed by pushing after the verdict, and
a routine base refresh is not mistaken for smuggled work. This was the one part of the GitHub
pipeline I most expected to find soft, and it is not.

## The audit trail against its own effects — CORRECT, 5 families, 0 unbacked claims

The technique that found F37-19 was: *the audit says it re-invoked the operator — did a run
start?* It didn't. So I ran that question over every audit family that CLAIMS an effect, on the
whole pass's trail.

| audit action | claimed | effect checked | unbacked |
|---|---|---|---|
| `runtime.run.started` | 155 | a row in `agent_runs` with that id | **0** |
| `task.agent.run_started` | 48 | `details.runId` names a real run | **0** |
| `task.transition` | 39 | a `**Transition:**` timeline event | **0** |
| `task.goal.updated` | 15 | a "goal / acceptance criteria were edited" note | **0** |
| `github.delivery.operator` | 18 | a push, a PR open, or a stated refusal | **0** |

Two of those needed the comparison sharpened before they meant anything, and both sharpenings
are the point:

- **`task.transition`** looked short by 6 events until I noticed that a packet resolution also
  writes a `transition`-TYPE timeline event ("**Decision:** answered with a custom directive.
  Operator re-engages with it.") without being a stage move. Counting only entries that start
  `**Transition:**` makes SHOP-6 read 14/14 and SHOP-7 15/15. The one genuine difference is
  SHOP-1's move to Done, which is audited as `{"to":"done","via":"accept_completion"}` and
  recorded in the timeline as something better than a transition note: *"Human acceptance
  recorded. SHOP-1 transitioned to **Done** and the review PR was merged."*, beside "Merged
  **PR #1** into `main`" and "Deleted branch `shop-1`".
- **`github.delivery.operator`** looked short by 5 until I stopped assuming every delivery is a
  push: 13 `Pushed …`, 4 `Opened **PR #n** for review`, and one honest refusal — *"No pull
  request was opened for SHOP-7: PR #2 was closed without merging"*. 18 for 18.

Also visible in that scan, and left there deliberately: the two `**Work lost:**` events written
by the WRONG first version of ruling 187, before I reverted it. They are part of this record
now, and `VALIDATION.md` says whose fault they are.

## Engagements and secondary assignments — CORRECT

Not a probe; this is what the board did on its own, read back off the canonical files:

```
SHOP-1  platform: infrastructure-engineer (delivers) + code-reviewer + integration-verifier
SHOP-2  platform-architect (delivers)
SHOP-6  platform-architect (delivers) + code-reviewer
SHOP-7  platform-architect (delivers) + code-reviewer + integration-verifier
```

One delivering engagement per task and up to two SUPPORTING ones beside it, each
verdict-capable, each engaged by the operator when its stage called for it and none of them
displacing the deliverer. The deliverer runs at every stage (ruling 133) — SHOP-7's architect
was re-prompted at Review and at Build without being re-engaged — while a supporting
engagement never delivers: across the pass, every branch on GitHub belongs to a delivering
profile and no reviewer has pushed a commit, which is F10-12's prompt branch holding in
practice rather than only in its test.

## PR adoption (R16-1) — CORRECT

The one GitHub path still unexercised at the end of the first day, probed deliberately.
Adoption exists for exactly one case — *Viberr lost track of a PR it had opened* — so I
produced that case: SHOP-7 had a delivered revision `8a437ec` and PR #5 at the same head, and
I wiped its `pr:` block out of `task.md` by hand, which is the scenario the rule names.

The reconciler's next pass (≈2 minutes; it polls every 5) restored it, and said what it was
doing and why:

> Adopted **PR #5** (head `8a437ec`, the delivered revision) as SHOP-7's review PR. **Viberr
> did not open it**; it was found on branch `shop-7` with this task's delivered head.

The record came back complete (number, state, title, mergeable, headSha) and the audit row
carries the provenance rather than implying viberr had opened it all along:

```json
{"repo":"akin-ozer/shopify-clone","branch":"shop-7","prNumber":5,
 "previousPrNumber":null,"previousState":null,
 "headSha":"8a437ec567a94b1d9b253c455e1ab8616be57922","source":"reconciler"}
```

That is the identity rule working: it adopted a PR whose head **is** the delivered revision.
I did not force the refusal arms live — a merged or head-mismatched PR must be reported as a
branch COLLISION rather than adopted (the H8 live bug: a fresh VIB-4 adopted a week-old merged
PR #113 and wore a green "merged" badge for work never delivered). Those arms are covered by
`pr-adoption.server.test.ts` and by the recorded history that produced the rule; forcing them
here would have meant corrupting a live task's `workRevision`, which buys less than it costs.

## Archive and restore — CORRECT

Probed on a throwaway task (SHOP-8) so the real build was not disturbed.

| step | result |
|---|---|
| archive as **viewer** | **403** "Your project role (viewer) cannot archive this task." |
| archive as admin | 200 "SHOP-8 archived. Find it under Archived on the board." |
| projection | `archived=1` |
| the open decision packet | **withdrawn** — "the open 'Archive throwaway task SHOP-8' decision was withdrawn" |
| dispatch an agent on it | **400** "SHOP-8 is archived — restore it before running an agent on it." (ruling 177's closure gate, the same sentence ruling 186 was modelled on) |
| restore | 200 "SHOP-8 restored to Triage." · `archived=0` |

The archive note states the consequences rather than gesturing at them: it leaves the board
and the review queue, the record is kept, and it is reversible.

Incidentally this also showed the operator behaving sensibly on a task it could see no point
in: its first act was to open a decision packet titled "Archive throwaway task SHOP-8" rather
than invent work for it.

## Force-accept — the door, not the act

No task reached the acceptance boundary with a failing verdict during the pass, so the act
itself is unexercised (recorded honestly above). The **door** is verified by the RBAC matrix:
`admin` reaches the acceptance ceremony (400, "needs the confirmation dialog"), while
`maintainer`, `contributor` and `viewer` are each stopped at the role check with their own
role named — "Your project role (maintainer) cannot force-accept past the review gate."
That contrast is the proof the gate is a role gate and not an accident of ordering.

## Ruling 201 on screen, and ruling 199 proven a second time by a live restart

Deployed mid-pass at 15:24Z with three agent runs in flight, which made the restart its own
test.

**Boot recovery.** `finalized non-terminal runs at boot: 3` — SHOP-10's deliverer, SHOP-9's
Integration Verifier and SHOP-15's Code Reviewer. Each got an honest note naming its own run
id ("was still running when the server stopped; it is recorded as interrupted by the restart,
and the operator is re-invoked to decide what to do next"), each task's operator was
re-invoked within 400ms, and all three reviewers were re-engaged on the same revisions without
a person touching anything. `skipped the boot workspace reclaim: runs are in flight,
activeRuns: 3` reads like a contradiction of the line above it and is not: those three are the
re-invoked operators, started 0.2–0.4s earlier. I checked the run rows rather than assuming.

**Ruling 199** re-pointed the rollout paths for all three interrupted runs on this boot
(`codex rollout paths re-pointed at the shared home … threads: 1` ×3), which is the fix doing
its job on the exact shape it was written for.

**Ruling 201, live** on `/insights`:

> **n/a** — Coordination overhead
> *operator and controller runs reported $13.38; no delivery run reported a cost (242 on
> Codex), so there is no share to take*

> **7%** — Coordination tokens
> *13.1M of 176.7M tokens processed; tokens, not dollars · 20 of 248 runs report no provider
> total*

The "(242 on Codex)" clause is read off the rows, not written into the source. The instance is
now 248 runs, 6 of them cost-reporting: exactly the shape that made ruling 190's guard
insufficient, and the first card that has ever said so out loud.

## Force-accept — the ACT, end to end (the pass's last unexercised surface)

Recorded earlier as "the door, not the act": no task had reached the acceptance boundary with
a failing verdict. SHOP-9 produced one for real, and the whole ceremony ran.

**The dilemma was genuine, not manufactured.** SHOP-9 (contract freeze) owns
`packages/contracts/**` and `docs/contracts.md`. Its Verify charter demands a cold-started
stack, which SHOP-15 and SHOP-10 own. Code Reviewer approved revision `53b37f1`; the
Integration Verifier blocked it twice on `make up`. The operator opened a `blocked` packet
with two options — hold for the baseline (its own pick) or an admin override — and put it to
the owner.

**The confirmation dialog says what it is about to do**, which is the part that matters:

| field | what it showed |
|---|---|
| DECISION | Admin override: accept current revision |
| MERGES | **PR #7 · in review** into main |
| BRANCH | `shop-9` is brought up to date with main first. If the base has moved, that merge commit is pushed to the branch and becomes the merge head. |
| REVISION | 53b37f1a610b |
| VERDICT | validation failing |
| BYPASSING | This task's latest review requests changes on the current revision. Rework and re-review before accepting. |

with "Admin override. The bypassed gate is recorded to the audit log." beside **Not yet** /
**Force-accept SHOP-9**. The Confirm button's accessible name tracks the selected option
("Confirm decision: Admin override: accept current revision"), so the button cannot promise one
thing while the radio says another.

**What actually happened, in order** (15:58:52 → 15:59:00):

```
transition  Decision: Admin override: accept current revision. + my note, verbatim
github      Merged PR #7 into `main`.
github      Deleted branch `shop-9` from GitHub. Its head was `53b37f1a610b`.
completion  Human acceptance recorded. SHOP-9 → Done and the review PR was merged.
            Bypassed: This task's latest review requests changes on the current revision;
            Required reviewer Integration Verifier (project rule at Verify) has not approved
            revision 53b37f1
```

`gh` agrees: PR #7 `MERGED`, merge commit `f0b6d909`, at 15:58:57Z. **Four merged PRs.**

**The audit trail keeps the dialog's promise**, and names BOTH bypassed gates separately
rather than summarising them:

```
task.acceptance.forced   {"bypassed":"This task's latest review requests changes on the
  current revision. Rework and re-review before accepting. | Required reviewer Integration
  Verifier (project rule at Verify) has not approved revision 53b37f1…","bypassedGates":[…]}
task.transition          {"to":"done","boundary":"human","via":"accept_completion"}
github.pr.merged         {"repo":"akin-ozer/shopify-clone","prNumber":7,"sha":"f0b6d909…"}
github.branch.deleted    {"repo":"akin-ozer/shopify-clone","branch":"shop-9","sha":"53b37f1…"}
github.branch_update.acceptance {"status":"already_current"}
```

**And the board widened on its own.** Within seconds SHOP-4 released itself:

> Released: everything this task waited on is done (SHOP-9). The task can move again; the base
> branch has changed since the hold, so the work re-reads it before continuing.

— then Triage → Design with the Platform Architect engaged. The dependency engine did what the
acceptance implied, with no human step in between.

## A host-level crash nobody planned, and the two recoveries it exercised

At 16:11:58 the container process exited — cleanly (`exit=0`, `oom=false`, `RestartCount=1`),
with no shutdown log, mid-request. Not viberr: there is no `process.exit(0)` anywhere in
`app/` (only `exit(1)` on a boot refusal), and at that moment this host was running a 14-agent
workflow beside a full `npm test`. The same pressure shows up inside the app a moment later as
`Codex Exec exited with signal SIGBUS`. Recorded as an ENVIRONMENT event, not a finding — but it
made two recovery paths run for real, unplanned, which is better evidence than a probe.

**Boot recovery, second time today.** Three in-flight runs (SHOP-4 primary, SHOP-15 reviewer,
SHOP-10 primary) were finalized as interrupted, each with its own note naming its own run id,
and each task's operator was re-invoked. The stale writer lock was taken over with the previous
holder's identity logged rather than silently stolen:

```
warn  taking over a stale data-root writer lock  holder={pid:7,bootId:bd6ab826…,startedAt:15:24:09}  force:false
info  data-root writer lock acquired             bootId=38021821…
```

**The failure packet, and `block_on_policy` end to end.** SHOP-4's re-invoked operator hit the
SIGBUS and viberr opened a blocked packet that says what happened, what it did NOT do, and what
each option will do:

> The operator run did not complete: Codex execution failed. … **No coordination was
> performed.** Re-run it; if it fails the same way, read the run's console for the cause.
> *What the provider reported:* `Codex Exec exited with signal SIGBUS:`

with the provider's line also carried as a typed observation (`k: Provider said`, `code: true`),
and three options: **Re-run the operator now** (recommended — "Closes this decision and starts a
fresh operator run. If it fails again you get a new decision packet"), Redirect with new
guidance, Hold.

I picked the recommendation on the task page. The record then read:

> **Decision:** re-run the operator. No policy or credential was changed.

and a fresh operator run started. That is ruling 200(h) working on a live task: `block_on_policy`
is a RECOVERY choice, so it is in `PROCESS_ONLY_OPTION_KINDS` and wrote no contract amendment —
the task's goal is untouched, because "I fixed the environment, carry on" is not a change to what
the work is.

**A number I checked instead of trusting.** The board badge in a 0.7-scale screenshot read as
"34" against 15 task files. Read from the DOM it is `Board14`: 15 rows in `task_projections`, one
archived, 14 active. The projection and the files agree; the screenshot did not.

**And the record survived it.** Re-ran the files-are-truth comparison immediately after the
crash — the strongest moment to run it, because a process that dies mid-write is exactly what
atomic writes exist for. Every task's `title`, `stage`, `readiness` (against `stored_readiness`,
not the derived column — the comparison that manufactured a false finding earlier today),
`waiting`, `validation`, `branch` and `archived`, file against projection:

```
comparisons: 105   mismatches: 0
```

## A branch-update claim, checked against the remote

The most precise sentence viberr wrote today, on SHOP-10 after SHOP-9's merge moved `main`:

> Brought `shop-10` up to date with `main` (3 commits merged in, merge commit `08ffb11`; the
> push published it, so origin now carries the workspace head, **including the 1 workspace
> commit origin was missing**). Drift re-measured: base refreshed · 1 merge commit · 3 base
> commits · 0 authored commits since review.

Every clause is checkable, so I checked it:

```
$ gh api .../branches/shop-10 --jq .commit.sha
08ffb11667d3bedd346c7e5319cbe19d6b62545e          ← origin's head IS the merge commit

$ gh api .../commits/08ffb11
msg:     "[SHOP-10] merge main into shop-10"
parents: ecda31ce…  (the workspace head)
         f0b6d909…  (main's tip — the merge commit of PR #7, SHOP-9)
```

The merge commit's two parents are exactly the two things the sentence names, origin carries
it, and the drift line's "0 authored commits since review" matches a rework that had just been
reviewed. Contrast F37-9, where the same pill went stale precisely when `main` moved — this is
that path working after the fix, on the first real base move the board has had.

## Ruling 208, proven on the task it was found on — the same move, ten minutes apart

**17:00:36Z, before the fix.** The operator, acting on my directive:

> **Coordination stopped:** the `transition_stage` step failed (**No allowed transition from
> Verify to Review.**). The remaining plan was not executed.

**17:10:04Z, after deploying ruling 208**, same task, same stage, same directive:

> **Transition:** operator moved SHOP-15 from Verify to Review.

Nothing else changed: same board, same two required reviewers, same revision, same missing
Code Reviewer verdict. `verdictStageFor` stopped letting the reviewer that had already approved
answer for the one that had not, `reworkStages` offered Review, and the move the graph had
refused went through on the operator's own authority — no human transition, no force-accept.

The task is back at Review with the Code Reviewer running on the delivered revision, which is
where it needed to be an hour ago.

## Ruling 206, fired live — the project's first compaction marker

Deployed at 17:08Z; SHOP-15's next write compacted it. The first `Compacted` marker this
project has ever carried:

> _9 earlier routine comments compacted to keep the task readable — human comments are never
> compacted._

Checked the file it rewrote, not just the marker:

| | |
|---|---|
| events | 89, newest-first ordering **intact** |
| typed events | all present: 14 transition, 11 github, 10 note, 7 quality, 1 blocked, 1 policy, 1 assign |
| human comments | still on the record, every one |
| agent replies | the newest older one kept verbatim, the tail behind it folded |

Nine routine comments became one marker in a single write, on a task that had been over its
40-event threshold for hours without the old adjacency rule ever folding a thing.

## The model policy, read back off the record

The owner's rule for this pass was: *"The controller runs on opus high; every other agent —
operator, reviewers, every delivery specialist — runs on luna max."* Every surface let me set
it, so there was no finding there; what is worth recording is that the RECORD agrees, checked
at 322 runs:

```
kind        backend  model           runs
----------  -------  --------------  ----
operator    codex    gpt-5.6-luna     205
primary     codex    gpt-5.6-luna      60
reviewer    codex    gpt-5.6-luna      51
controller  claude   opus[1m]           6
```

No run on any other model, in either direction, across the whole pass. The specialist
definitions carry `effort: max` (nine profiles); the controller's own settings carry opus at
high. The policy was configured once, through the controller's own agent editor, and has held
without a single exception since.

## "Files are truth" — re-tested after a corrupt store, a `.recover`, and six restarts — CORRECT

The strongest version of this test the pass has had, because of what the projection had been
through: `SQLITE_CORRUPT` under a live process (F37-37), a rebuild with `sqlite3 .recover`, 2128
audit rows reinserted by hand out of `lost_and_found`, a transient `disk I/O error` that left one
row stale (F37-38), and a `resolvePacket` that died inside a catch (F37-39).

Viberr's own scoped rescan reprojects every canonical file in a project and reports what changed.
If the mirror already matches the files, nothing changes:

```
project projection rescan complete
  slug: shopify-clone-platform
  projects: 1  tasks: 16  changed: 0  unchanged: 24  removed: 0  errors: 0  durationMs: 14
```

**24 files, 0 changed, 0 errors.** Every task row, the project row and all seven goal rows already
agreed with the markdown they are derived from. The board, the timelines, every verdict and every
`rounds` count came back exactly as the files hold them — which is the whole reason the canonical
record is markdown and SQLite is only a mirror.

The one row that had NOT matched was SHOP-4's, twenty minutes earlier, and that was found by the
same method: read the file, read the board, compare, then press Re-scan and watch the chip
disappear. It is now rulings 218 and 219.

## Ruling 176's write-tool marking is really enforced, on both transports and both backends — CORRECT

The controller declined a grant because it could not verify this, and said so honestly rather
than asserting it ("if Viberr enforces that marking, it does so somewhere I cannot read, and I
won't assert that it does"). Traced end to end:

| step | where |
|---|---|
| the marks are stored per server | `tool_policy_json`, `resources.server.ts` |
| they bind only on a run withholding repo write (and every operator run) | `specialist-mcp.server.ts` — `options.withholdWriteTools ? row.writeTools : []` |
| Claude: denied by name, after auto-approval, so the deny wins under `bypassPermissions` | `run-service.server.ts` — `disallowedTools += mcp__<server>__<tool>` |
| Codex: per-server `disabled_tools`, stdio and HTTP alike | `codex-runtime.server.ts` |
| HTTP additionally | `permission_policy: "always_deny"` |
| the agent is told what was removed, by tool and by server | `specialist-run.server.ts` system prompt |

Both stdio and HTTP are covered, which matters here because every MCP server on this instance is
stdio. The denial list is also filtered to servers the run actually mounts, so a stale mark names
nothing.

What was NOT true is the list the admin reads, which stated the position only for a gated server
— that is F37-40 / ruling 220.

## The dependency release, fired for five tasks at once — CORRECT

SHOP-10 (the service template) was the pass's critical path: six tasks declared `blockedBy:
SHOP-10`. It took **eight** rounds of `request_changes` before ruling 214 let the operator ask
the reviewer for a complete list, got one, had it fixed in a single round, and both required
reviewers approved. On acceptance, PR #8 merged and viberr released everything behind it in one
move:

```
SHOP-2  Released: everything this task waited on is done (SHOP-9, SHOP-10, goal-1 link 3).
SHOP-3  Released: everything this task waited on is done (SHOP-9, SHOP-10, goal-1 link 3).
SHOP-11 Released: everything this task waited on is done (SHOP-9, SHOP-10, goal-1 link 3).
SHOP-12 Released: everything this task waited on is done (SHOP-9, SHOP-10, goal-1 link 3).
SHOP-17 Released: everything this task waited on is done (SHOP-10).
```

Each note names **which** entries cleared, not just "unblocked", and each adds the fact the
released work actually needs: *"the base branch has changed since the hold, so the work re-reads
it before continuing."* Five operator drives started on the same second, each on its own task.

The promise being kept here was written on those tasks the moment they were created, hours
earlier: *"Created waiting on SHOP-10. Held until every entry is done; Viberr releases it then."*
It is the `dependencies-released` trigger (ruling 131(e)), and the turn it produces is a distinct
one — the operator is told what cleared and that the base moved, rather than being dropped into a
generic re-read.

## The coordination test, and what actually collided — CORRECT, after the controller was told

This is the part of the goal that could only be answered by running it: *"A monorepo of many
services is a coordination test too — several agents in one repo at once — let the controller
sequence that, and watch what collides."*

**What the controller got right up front.** It invented an anti-collision design of its own —
four named hot spots made *additive* so two agents never edit the same line — and it worked.
Six service tasks ran concurrently in one repository, each with its own branch, its own
workspace and its own PR, and none of the four collided.

**What collided instead were the files it could not see when it wrote the plan.** Two of them,
and both had the same shape: a root artifact every service task must change and no task owns.

| surface | how it surfaced |
|---|---|
| `scripts/stack.test.mjs` | hard-codes the two fixture services, so every task that adds a service to the default stack breaks it. **Five tasks** stopped and asked a human the same question: SHOP-3, SHOP-16, SHOP-17, SHOP-12, and a sixth via SHOP-19. |
| `pnpm-lock.yaml` | every new service adds an importer, and a peer-qualified snapshot fails the frozen install. **Four tasks took the identical `request_changes` inside forty minutes** — SHOP-3, SHOP-11, SHOP-12, SHOP-17 — then each regenerated the same root file on its own branch. |

Neither is a viberr defect: the ownership map is the controller's to write, and viberr surfaced
every collision honestly — the reviewers caught each one as a boundary violation, and the
`request_changes` verdicts named the file every time.

**What the controller did when told.** I gave it the two facts and asked for the *rule* rather
than another patch. Inside one turn it:

- posted an explicit **merge order** on both colliding branches ("SHOP-3 merges first, SHOP-17
  second") and on the reviewers, because SHOP-17's architect had already written an equivalent
  fix rather than wait;
- added the missing `blockedBy` edge to SHOP-19 so the next task cannot repeat it, with its own
  reasoning on the record: *"two branches must not edit that file at once — the very failure it
  exists to end"*;
- narrowed owned paths on four pending goal links from directory globs to named files, flagging
  where two tasks could still meet;
- reconciled a downstream link to the scope decision taken on SHOP-18;
- created **SHOP-20**, held on all five in-flight service tasks, to make `.env.example` DERIVED
  from the stack manifests and split the root `Makefile` into includes — the next two surfaces
  of the same shape, *before* either had broken. Its words: "`.env.example` and the root
  `Makefile` have exactly the same shape and have not broken yet."
- and refused one question rather than answering it for me: whether a `packages/contracts`
  amendment gets a standing owner or a fresh task each time, "because its shape depends on a
  call that is yours."

The honest reading is that the controller sequences well and generalises well **once a pattern
is named**, and that naming the pattern took a human watching five identical packets go by. What
it could not do was see the hot spot before it had a victim — which is exactly what the goal
asked to find out.

---

## Files are truth — re-tested after the night's churn, 2026-09-14 03:12 UTC

The claim is only worth something if it survives activity, so it was re-tested at the busiest
point of the pass: five concurrent agent runs, four tasks that had just resumed from a
three-hour quota wait, two branches refreshed from `main`, three review verdicts recorded, and
one deliberately conflicted branch rebased and re-delivered — all since the last check.

Viberr's own **Re-scan** ("Reconcile the board with the file-native store"):

```
project projection rescan complete
  slug=shopify-clone-platform projects=1 tasks=20
  changed=0 unchanged=28 removed=0 errors=0 durationMs=12
```

**28 files, 0 changed, 0 errors.** Every projected row already matched the markdown it was built
from; the rescan had nothing to correct. That is the testable form of "the markdown IS the
record" — not an assertion in a doc, a number the product produces about itself on demand.

Worth noting what makes the number meaningful: `changed=0` is only interesting because the same
command DID report changes after the projection store was corrupted earlier in this pass, and
reported `errors=1` while a rebuild was failing (F37-37). It distinguishes states, so a zero is
evidence rather than a default.

## The outer RBAC boundary, re-probed the same night

The four-role matrix and the non-member (zoe) are recorded above. The anonymous case — the
strongest non-member there is — re-probed at 03:10 UTC:

| door | no session |
|---|---|
| `/` | 302 → `/login` |
| `/projects/shopify-clone-platform/board` | 302 → `/login?returnTo=…` |
| `/projects/shopify-clone-platform/tasks/SHOP-2` | 302 → `/login?returnTo=…` |
| `/org/settings` | 302 → `/login` |
| `/insights` | 302 → `/login` |
| `/resources/controller` | 302 → `/login` |

The `.data` route a real client actually fetches answers the same way — a `SingleFetchRedirect`
to `/login`, carrying nothing about the task in the body. No door leaks the existence of
anything to an unauthenticated caller beyond the path the caller already typed.

## Every open PR's head, checked against GitHub — 5 of 5 MATCH

F37-43 was a task whose record said one revision and whose merge carried another, and ruling 226
now refuses a merge whose head cannot be checked. That makes the standing question worth asking
directly rather than trusting the new gate: **does what viberr records about each PR match what
GitHub actually holds?**

Asked of every open PR at 03:14 UTC, comparing three independently-written facts — the `pr.headSha`
viberr cached from its last reconcile, the head GitHub reports live, and the `workRevision.headSha`
the delivering agent reported:

| task | PR | recorded | live (GitHub) | delivered revision | |
|---|---|---|---|---|---|
| SHOP-2 | #13 | `b7651c5` | `b7651c5` | `b7651c5` | match |
| SHOP-3 | #11 | `605f6f6` | `605f6f6` | `605f6f6` | match |
| SHOP-11 | #15 | `291c43d` | `291c43d` | `291c43d` | match |
| SHOP-12 | #14 | `ac62466` | `ac62466` | `ac62466` | match |
| SHOP-18 | #16 | `8ef0a2e` | `8ef0a2e` | `8ef0a2e` | match |

All three agree on all five, including SHOP-2 — the branch that was deliberately allowed to
diverge, conflicted with `main`, and was then rebased and re-delivered through viberr's own
recovery path within the hour.

This is the check F37-43 would have failed: SHOP-17's reviewers were pinned to `1f99f68`, which
was never on the remote at all, while PR #12's head was `9104562`. Three columns, and the first
would not have matched the second.

## The controller declined a grant it could not make safe — CORRECT

The owner added a credential-free filesystem MCP server (`kb-files`, `npx -y
@modelcontextprotocol/server-filesystem /data/kb`, 14 tools, 4 marked as write) and asked the
controller which profiles to grant it to. It granted it to none, and the reasoning is the
behaviour worth recording:

1. **It probed before deciding** — `kb-files healthy: 14 tools · 1212ms, stdio, no credential` —
   rather than reasoning about a server it had not touched.
2. **It found the grant redundant.** `shopify-clone-architecture` and `shopify-clone-conventions`
   are native KB grants already held by every profile named. Viberr's per-KB mechanism is the
   specialized path, and it was already in place; the MCP server was a second, broader route to
   the same two files.
3. **It refused to assert an enforcement it could not verify**: *"if Viberr enforces that
   marking, it does so somewhere I cannot read, and I won't assert that it does."* The
   enforcement does exist (ruling 176), and viberr does surface it to the controller as
   `writeToolsNote`. Declining to claim it anyway is the right posture, not a gap.
4. **It named the real risk in one sentence**: `/data/kb` is the root of the KB store, which
   holds `controller-handbook` as well — content injected as trusted configuration into the
   other agents, the operator and the controller itself. *"A reviewer that rewrites the
   conventions KB changes the standard the next reviewer is judged against."*
5. **It corrected the owner's premise from the files**, not from memory: this project's deployed
   `code-reviewer` holds `execute-code-or-write-repo: direct` (verified in `project.md`), so it
   is the generic `reviewer` profile, not the deployed one, that ruling 176's withholding would
   have covered.

The residual design limit — an MCP grant has no read-only mode, so a broad mount is grant-all or
grant-none — is real but narrow, and it is reachable only by mounting a server over content the
product already serves a narrower way. The system's answer in that situation was to notice and
stop, which is the answer you want.

I briefly filed this as a finding (F37-48) and withdrew it the same hour: the owner asked why
anything wanted the whole KB server, and the answer — nothing did — was already in the
controller's first paragraph.

## A guardrail's promise, checked against the mechanism — KEPT

Most of this pass's findings came from one move: read a sentence viberr shows a human, then test
whether the mechanism can keep it. It is only honest to record the times it can.

SHOP-3's operator planned an `update_branch_from_base` at Verify and was refused:

> `update_branch_from_base` — SHOP-3 is at Verify, the acceptance boundary: **the branch is
> brought up to date once, at acceptance time, and merged in the same ceremony.** Do not refresh
> it here; recommend or accept the completion instead.

That sentence makes a promise about a different code path than the one refusing. If acceptance
did not in fact refresh, every task would merge stale and the refusal would be talking about
something that does not happen — the pass-24 shape, "wired to a seam that cannot fire".

It does happen. `refreshBranchForAcceptance` (task-actions.server.ts) reads the task's PR and
branch, refuses to act without an open PR in `review`/`accepted`, and calls
`updateWorkspaceBranchFromBase` — and it is called from inside `attemptAcceptanceMerge`,
immediately before `mergeTaskPr`, with the caller's identity re-check running on BOTH sides of
it:

```
beforeMerge?.();
const refresh = await refreshBranchForAcceptance(db, ctx, projectSlug, taskKey, actor);
if (refresh) return refresh;
beforeMerge?.();
const result = await mergeTaskPr(…)
```

The double re-check is itself deliberate (P14-GV-05 applied to the refresh): the refresh is an
external, irreversible publish — a workspace merge pushed to origin — so a packet replaced or a
verdict flipped during the await must refuse BEFORE the push, not after it.

Promise made at Verify, kept at acceptance, on the one path that merges. No finding.

## The coordination test: what actually collided, and what caught it

The goal called a monorepo of many services "a coordination test too — let the controller
sequence that, and watch what collides." Here is what collided on the night of the 13th–14th,
with five service branches open at once.

### Collision 1 — the shared lockfile, which cannot be made additive

`pnpm-lock.yaml` is generated from the whole workspace at once, so every new service touches it
and no discipline about owned paths can prevent that. Twelve of the twenty tasks reference it.
Five branches took a request-changes for the same root cause: a new service importer against a
peer-qualified eslint snapshot, so `--frozen-lockfile` failed cold. Live at 03:41, SHOP-2's
Integration Verifier failed `make up` with `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` on the exact
revision its Code Reviewer had approved twenty minutes earlier.

**The controller had already diagnosed it.** I put the sequencing question to it as a fresh
observation, and found its own creation note for SHOP-20 in the agent log, dated the 13th:

> *`pnpm-lock.yaml` is the hardest shared surface in this repository — every service task must
> change it, its content is generated from the whole workspace at once, and it therefore cannot
> be made additive the way the route table, the stack manifests and the CI matrix were… One
> cause, five rework rounds, and a guaranteed conflict on every merge after the first. **This
> task stops that recurring for the services that have not been built yet.***

Which explains the dependency direction I had gone to question it about. SHOP-20 is blocked by
the five in-flight services deliberately: it can only declare every workspace once those have
settled their own `package.json`, and its purpose is the services still to come, not the five
already paying. The sequencing is reasoned, and it is right.

### Collision 2 — a shared placeholder each service got wrong separately

`stack/gateway.json` on `main` sends a gateway secret; each service branch adds its own
`stack/<service>.json` that must match it. SHOP-2 and SHOP-3 independently wrote
`replace-with-local-secret` against the gateway's `replace-with-a-local-gateway-secret`. Neither
could see the other's branch.

**Both were caught by a required reviewer before merge**, within an hour of each other, each with
the file and line named. That is the mechanism working as designed: parallel branches cannot see
each other, so the thing that catches cross-branch drift is the review gate, and it did — twice,
independently, on two different services.

### What this says

Two collisions, two different answers, neither of them a defect. The one that could be
engineered away (manifests, route table, CI matrix) was made additive by design. The one that
cannot be (a lockfile generated from the whole workspace) was given its own serialized task, with
its dependency direction chosen on purpose. The rest is caught at review. That is what a working
coordination model looks like under five concurrent branches.

## The record is testable — viberr's own controller reconstructed F37-43 from it

The goal asks to check that what viberr *shows* matches what *happened*, on the grounds that
"files-are-truth means the record is testable". The strongest available test of that is not one I
can run: it is whether a reader who was not there can recover the truth from the files alone.

At 03:49 UTC the controller did, unprompted. I had asked it a narrow sequencing question about
SHOP-20 and the lockfile. It went to the record, and posted this on **SHOP-17's closed task**:

> Recording a discrepancy on this closed task, for the trail.
>
> Both required reviewers approved revision `1f99f68504f3`. PR #12 merged at head `9104562baccf`,
> and the acceptance record states: *"PR #12's head could not be verified against the delivered
> revision before the merge… It was accepted without that containment check."* Branch `shop-17`
> was then deleted at `9104562baccf`.
>
> **If that is accurate, what merged is not what was verified**, and two commits' content did not
> reach `main`: `7d58fb58` (the peer-qualified eslint lockfile repair) and `1f99f685` (the
> manifest-derived `scripts/stack.test.mjs`). Downstream behaviour matches — SHOP-2's cold
> `make up` failed on the same eslint frozen-install error hours later, and SHOP-2 was separately
> authorized to write its own manifest-derived stack test, **which would be the fifth**.
>
> The gateway deliverable itself is not in question… This is about the two shared-surface fixes
> riding on the same branch.
>
> **SHOP-21** now owns re-landing both on `main`, and **its first step is to verify this premise
> rather than assume it** — if `main` turns out to carry them after all, it stops and says so.

That is F37-43, rediscovered independently, from the verdicts, the acceptance note and the PR
record — plus two things my own writeup did not have: the identity of the two lost commits, and
the downstream signature that confirms the loss (an eslint frozen-install failure recurring on
a later branch). It then created an unblocked task to repair it, and instructed that task to
falsify the premise first.

**It also caught a mistake of mine.** Earlier the same night I authorized SHOP-2 to generalize
`scripts/stack.test.mjs` from the manifests. That work already existed — in `1f99f685`, one of
the commits PR #12 did not carry. My authorization was a fifth re-implementation of a fix that
had been written and lost, and I made it without checking whether `main` carried it. The
controller saw the pattern from the record; I had the finding in my own ledger and did not
connect it.

**And it is ruling 226's case, made by someone else.** The controller quotes the A9 disclosure
verbatim and then states the consequence A9's wording leaves out: *what merged is not what was
verified*. The owner's decision to refuse that merge rather than disclose it was reached
independently, from the same sentence, by viberr's own controller — hours later and without
being asked.

### Collision 3 — a template placeholder nobody could see was wrong

Three services took a request-changes for the same gateway-secret mismatch within ninety minutes:
SHOP-2 (`stack/identity.json:16`), SHOP-3 (`stack/inventory.json:16`), SHOP-12
(`stack/catalog.json:16`). Three different services, three different reviewers, the same line
number — which is what made it worth looking past coincidence.

Measured on `main`:

| file | line 16 |
|---|---|
| `services/_template/stack/template.json` | `"GATEWAY_SECRET": "replace-with-local-secret"` |
| `stack/gateway.json` | `"GATEWAY_SECRET": "replace-with-a-local-gateway-secret"` |

Every service scaffolded from SHOP-10's template inherits the wrong placeholder, fails the same
check, and repairs it privately on its own branch. Three so far; orders and admin would make five.

Unlike the lockfile, this one **can** be fixed once and additively — it is a single line in a
single file, generated from nothing. Handed to the controller with the measurement rather than
fixed by me: the clone is its to build.

It created **SHOP-22** (unblocked, high) within minutes, carried the measurement into the goal
with an instruction not to re-derive it, and — the part worth keeping — wrote the task's own
limits into it:

> **`services/_template` is copy-time. Be clear about what this task can and cannot do.** Fixing
> the template does NOT reach identity, inventory, catalog or cart, which are already scaffolded
> and have each already corrected their own manifest on their own branch. This task prevents the
> next two occurrences and ends the drift at its source; **it does not retroactively repair
> anything.**

A task that states what it cannot do is worth more than one that overclaims, and nothing in the
product forced it to write that sentence.

**What the review gate is actually worth here.** Nothing escaped. Three independent reviewers
caught three instances of a defect none of their branches could see the origin of, each naming
the file and line. The cost is one rework round per service, and the cause sat in a file no
service task owns.

## Every run that failed produced a decision a human can see — CORRECT

"Losing work" is on this pass's bug bar, and the sharpest version of it is a run that dies with
nobody told. Measured at 04:06 UTC, with 648 runs on the instance:

| Insights | |
|---|---|
| runs in `error` | **22** |
| runs `stopped` | 55 (all 55 by a restart, and each one noted on its task) |

| this project's task files | |
|---|---|
| `blocked` events reading "Operator run failed: pick a recovery path" | 12 |
| `blocked` events reading "Work stalled: pick a recovery path" | 10 |
| **total run-failure packets** | **22** |

Twenty-two failures, twenty-two decision packets, each naming the provider's own sentence and
offering resolvable options. No task carries an agent run with an unexplained gap after it.

**The honest caveat:** Insights counts runs across the whole INSTANCE — this project plus the
controller's own conversation runs — and does not break errors down by project, so the exact
correspondence is a count match rather than a per-run trace. It would be consistent with (say)
one controller error and one un-narrated task error cancelling out. What the count does establish
is that the failure-narration machinery is not systematically dropping anything: at 22-for-22 on
a board that has been running twelve hours, a silent-drop class would have to be both rare and
exactly offset to hide here.

The `stopped` column is the stronger evidence in one way — all 55 are restart casualties, and
every restart in this session wrote its own note on every affected task, which I watched happen
three times (03:30 unplanned, 03:32 and 04:03 deploys; 5, 5 and 7 runs respectively).

## Ruling 206 works on the running board (checked 2026-09-14, pass 37)

Ruling 206 made routine-comment folding non-adjacency-based after finding that "a guardrail that
is on, configured, and counted by Insights had never removed a single event". Checked against the
live files, counting markers by their exact `title: Compacted`:

```
SHOP-2   96 events   2 markers      SHOP-11   91 events   3 markers
SHOP-3  122 events   3 markers      SHOP-12  104 events   2 markers
SHOP-10 148 events   1 marker       SHOP-18   88 events   1 marker
```

Every task that has been written to since the ruling deployed now carries markers, each naming
how many it replaced ("5 earlier routine comments compacted to keep the task readable").

SHOP-6 (134 events) and SHOP-7 (200 events) carry none, and that is correct rather than a gap:
both are merged and done, compaction only runs on a write, and nothing re-anchors on a closed
task's file. Folding them would be churn with no reader.

## Three surfaces read against the files, and all three held (2026-09-14, pass 37)

Checked during the quota stall, when nothing could move underneath the reading.

**Attachments (R19-19).** The panel says "90 files" for SHOP-15 and the directory holds exactly
90, each row naming its author, time and size. The raw-bytes route refuses everything it should:

```
SHOP-15-final-down.txt            200   the file
does-not-exist.txt                404   "Not found"
..%2F..%2F..%2Fproject.md         404   "Not found"
..%2f..%2ftask.md                 404   "Not found"
%2e%2e%2f%2e%2e%2fproject.md      404   "Not found"
....//....//project.md            404   router 404
SHOP-15-final-down.txt%00.png     404   "Not found"
```

No bytes leaked by any encoding of a traversal, and a missing file is a plain 404 rather than a
stack trace.

**The review queue's count and its stage claims.** "6 in review" against six tasks carrying an
open PR, while only two sit in the Review STAGE — and every row discloses where it actually is
rather than implying the stage: SHOP-18's reads "Review in progress at **Build**". The trailing
"Review" on each row looked at first like a stage label contradicting that; it is
`<span class="rq-go" aria-hidden="true">` — the go affordance with its chevron, hidden from
assistive tech so it is not read as a second stage.

**Revision-bound verdicts, and drift (the goal's named surface).** The queue tells three tasks
"Waiting on 1 required reviewer approval of the current revision." Against the files:

| task | current revision | verdicts ON it | required at stage | missing |
|---|---|---|---|---|
| SHOP-22 | `rev_N45Gv…` / `ec5c6aa1` | code-reviewer approve | integration-verifier | yes |
| SHOP-2 | `rev_k4CCK…` / `ea5f2ffd` | code-reviewer approve | integration-verifier | yes |
| SHOP-3 | `rev_t_209…` / `6a635c46` | code-reviewer approve | integration-verifier | yes |

The subtle half is the one that matters. SHOP-2's `integration-verifier` DID speak — a
`request_changes` on `rev_uFvlCQ75CU2F`, and SHOP-3's on `rev_8I3noZbnIf1L`. Both are previous
revisions, and neither is credited in either direction: the rejection does not block the new
revision and the absence is reported as "waiting", not as "changes requested". That is exactly
what a revision-bound verdict is for, working on real drift rather than a fixture.

**SHOP-11's page, on a task with `waiting: none` at a non-terminal stage.** Header reads Review /
blocked / validation failing, names all three blockers as chips, and the page carries the copy
that says the hold ends by itself ("Held until…", "Viberr releases it…"). The "Blocked decision"
pill that looked like current state sits inside `.timeline` — history, correctly placed.

## The concurrency collision, and four wrong findings caught before filing (2026-09-14, pass 37)

The 07:29Z window ran six specialists at once in one repo, which is what the goal asked for
("several agents in one repo at once... watch what collides"). It collided, and the machinery
handled it correctly.

**The collision.** SHOP-21's Infrastructure Engineer could not run `make stack-test` because
ports 4101, 4102 and 8080 were held by SHOP-12's and SHOP-2's stacks. It refused to kill another
task's processes and opened an `input` packet asking a human. The inbox's demand lane showed it as
**1 decision** with the full body, even though the task itself read `waiting: agent` - the packet
drives the demand independently of the task's waiting state, which is the honest arrangement.
Meanwhile the operator advanced what it could (Build to Review, PR #18) and posted *"@Arda Your
open question from @Infrastructure Engineer still stands and is yours to answer - I can't withdraw
an agent's packet"*. Question kept alive, progress not blocked on it.

**It was not a process leak, though it looked exactly like one.** One port-holder read
`ppid 1` - reparented to init, the classic orphan signature - and I was one step from filing
"viberr leaks the processes its agents spawn". A second measurement minutes later showed ports
4101/4102/8080 free and the only `PPid 1` process being viberr's own server. The reparenting was
transient teardown, not a leak. Answered the packet with that fact rather than the guess.

**Four wrong findings caught before filing, in one session.** Worth recording as a group, because
the pattern is the same each time: a measurement whose method could not see what it claimed to.

| nearly filed | what was actually wrong |
|---|---|
| "viberr says *mentioned you* about comments that mention someone else" | the notification stores a 240-char CLIP; my regex searched the clip, not the comment |
| "the operator claims it opened a packet but no packet exists" | the packet lives in a `## Packet` section; my `awk` read only the YAML frontmatter |
| "viberr leaks agent-spawned processes" | `ppid 1` was transient teardown; a second reading showed the ports free |
| "Accept silently does nothing" | the refusal toast DOES render; I sampled `body.innerText` at 4s and 6s, after it had gone |

Each was caught by checking the mechanism rather than trusting the first measurement, and the
fourth only because the network log showed a 409 the page had already stopped displaying.

**The acceptance head check, live.** SHOP-2's reviewers approved `ea5f2ffd7493`, but PR #13's head
was `913ce9d`: the reviewed revision had never been pushed. The Integration Verifier even said so
in its own approval ("Reviewed HEAD `ea5f2ffd7493` with `913ce9d` as its ancestor"). Acceptance
refused with a 409 and this toast:

> SHOP-2's delivered revision `ea5f2ff` is not on GitHub: PR #13's head is `913ce9d`. Deliver the
> branch to push it; it cannot be accepted until the PR carries the reviewed revision.

Exact, names both shas, and states the remedy. A reviewer approving a revision the PR does not
carry is precisely the drift this gate exists for, and it caught it on real work.

## Files are truth, tested on the DERIVED columns while the board churned (2026-09-14 08:10 UTC)

The earlier files-are-truth passes compared copied fields. This one targets the columns the
rebuilder DERIVES, which is where the stale-row bug of this pass actually lived (ruling 225 shipped
three times while the content-hash short-circuit kept the old rows, until
`PROJECTION_DERIVATION_VERSION` was bumped). Run against all 23 tasks with five specialists mid-run:

```
tasks compared:     23
field families:     stage, readiness, validation, branch, archived, event_count
real mismatches:    0
```

`event_count` matched the literal `### <iso>` entry count on every task, which is the field most
likely to drift silently.

Six tasks reported a `readiness` difference and every one is the derivation working as ruled:
SHOP-11, 13, 14, 18, 19 and 20 all carry a non-empty `blockedBy`, and ruling 131's dependency
floor pins them to `blocked` while the file keeps whatever it last stored. That is deliberate and
documented in `readiness-policy.server.ts` ("THE readiness derivation - the only place readiness is
derived"), the floor can only WORSEN a stored value, and the projection keeps `stored_readiness`
beside `readiness` so both are recoverable.

The question that follows - whether an agent re-anchoring on the task sees `ready` on a blocked
task - has the right answer too: `get_task` builds from the projection, not from the raw
frontmatter, so the agent is handed the derived `blocked`. The stored value never reaches it.

## The Policy page's exception to its own table — CORRECT (2026-09-14)

The RBAC matrix probe earlier in this pass tested the TABLE. The Policy page also prints an
exception to it, in prose under "Rules that reach beyond project roles":

> Contributors and above may take or release their own task ownership (viewers are read + comment
> only). The owner is the task's human reviewer and acceptance authority, scoped to that task: a
> contributor who owns a task **may accept its completion, and may resolve the non-acceptance
> options on a decision packet** the operator raises on that task, **even though the table reserves
> those columns for maintainers**.

A page that contradicts its own table in prose is exactly the shape a lie takes, so it is worth
checking rather than reading. It holds, and the implementation is careful about the edges the
prose implies:

- `ownerException` requires a live match AND `roleCan(role, "own-task")`, whose role set is
  `[admin, maintainer, contributor]` - so a demoted VIEWER who still holds a stale `ownerUserId`
  is excluded, which the code comments call out by name.
- `requireAcceptCompletion` puts `requireProjectMutable` FIRST, before the exception, with the
  reason stated: *"Owning a task on an archived board is not a licence to close it: acceptance
  attempts a real merge on a project the product calls read-only."* The exception short-circuits
  `requireAction`, which is the one chokepoint enforcing R6-3, so the ordering is load-bearing.
- Packet resolution carries the same exception but routes `accept_completion` past it deliberately,
  so a contributor-owner is not blocked by the maintainer gate before the owner check runs.

And it is covered by tests, including the negative case: *"R15-3 does not widen the outer gate: a
contributor who does NOT own the task still cannot apply"*, alongside *"the contributor OWNER may
apply an accept_completion recommendation"* and the dismissal equivalent. The exception was itself
found as a live defect once (F15-12: a contributor-owner was shown Apply and then refused).

## The evidence chain, and where its backing actually lives — CORRECT (2026-09-14)

Agents attach evidence rows that viberr renders as fact ("Storefront Vitest suite · 32 passed ·
0 failed"), so the obvious question is whether the claim survives contact with the log.

**Spot check, exact.** SHOP-18's row claimed `32 passed · 0 failed`; its attachment
`SHOP-18-storefront-test.txt` ends `Test Files 7 passed (7) / Tests 32 passed (32)`. The
typecheck/lint row claimed `2 passed · 0 failed`; both attachments show the commands running clean.
An adjacent row on the same event reads `Root stack-test diagnostic · 5 passed · 1 root failure` -
the agent recording its own failure inside its own evidence rather than rounding it away.

**Then a systematic sweep that produced a false alarm, worth recording.** Checking all 14 numeric
evidence rows against their task's attachments left 5 "uncorroborated", including SHOP-18 claiming
`28 passed` when the attachment now says 32. The obvious reading was that a later run had
overwritten the older run's proof - viberr hands agents a WRITABLE attachments directory
(`attachmentsWritableDir`) and does not mediate filenames, so same-name overwrites are real.

That reading was wrong, and the schema says so outright. An `EvidenceRow` is
`{ label, add, del }` - three strings - documented as **"A REFERENCE, never a dump"**, and the
`evidence-separation` guardrail it complements "trims raw fenced output out of the prose and
**points at the run logs**". Viberr never made an attachment link, so no link broke. The backing
store is `run_log_lines`, kept 30 days, and it still holds the claim:

```
SHOP-18 runs whose retained log contains "28 passed":  5
total run-log lines retained for SHOP-18:              2613
```

So the older claim is as substantiated today as when it was written. The attachment set is a
convenience drop the agent curates, not the citation's backing - and conflating the two is what
made this look like a defect.

**Fifth near-miss of the pass, same shape as the other four**: assume a mechanism, measure against
the assumption, get a signal. The check that settled it was reading the schema's own sentence about
what the row IS.

## Run recovery under 63 real interruptions — CORRECT (2026-09-14)

Not a fixture: this session deployed repeatedly while the board was busy, killing live agent and
reviewer runs mid-flight without warning, plus the host-level crash recorded earlier in this file.
That produced the best dataset in the pass for the one failure mode the bug bar calls losing work.

```
run states across the pass     651 finished   63 interrupted   28 error   2 running
interrupted runs                63
  followed by a later run       63
  never followed (lost work)     0
run.recovery.reinvoked rows     63          <- exactly one per interruption
```

**And the sharper test, which "a later run exists" does not answer**: is any task CLAIMING an agent
that is not there? That is the ghost signature - the board reads "agent working", the human waits,
and nothing is running.

```
tasks whose board state says an agent is working:  2
  with a live run:                                 2
  with no live run:                                0
```

Zero. Every recovery also announced itself on the task rather than healing quietly: *"the run
`run_mLuoQlsR09Fy` (agent) was still running when the server stopped; it is recorded as interrupted
by the restart, and the operator is re-invoked"*, and the re-dispatch says what it is - *"SECOND
RESEND of the SHOP-5 rework directive. Your last two runs were both interrupted mid-flight"*, and
for a reviewer, *"your previous review run was interrupted by a server restart before it produced a
verdict, so no verdict was recorded. Please review again"*. A resend is labelled a resend and not
passed off as new scope.

**Method note on the cost I was imposing.** These interruptions were mine. Viberr absorbed them
correctly every time, but the churn is real - SHOP-5's Infrastructure Engineer was cut off twice in
a row - and the right response was to stop deploying while the board is busy rather than to keep
proving the recovery works.
