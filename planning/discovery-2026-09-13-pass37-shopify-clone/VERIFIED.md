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
