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
