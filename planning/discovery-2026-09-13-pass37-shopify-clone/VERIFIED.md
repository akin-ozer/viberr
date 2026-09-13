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
