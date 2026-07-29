# G-A-agents — adversarial verification (pass 15 gap repairs)

Branch `pass15/product-fixes`, dirty tree, sibling streams editing concurrently.
Only this stream's files were judged. Every canary was produced by REVERTING the
repair in the working tree, running the named test, then restoring the file from
a byte-identical copy (`git diff --stat` re-checked after each restore — all 18
files match their pre-verification line counts exactly).

## Gates

- `npm run typecheck` — **clean** (`react-router typegen && tsc`, no output).
- Stream test files (8 files: `agent-reply`, `agent-completion`,
  `mention-suggestions`, `agent-toolkit`, `operator-actions`, `task-actions`,
  `agents-route`, `agents-page`) — **219 passed / 219**.
- Full suite `npx vitest run` — **Test Files 206 passed (206), Tests 2410 passed
  (2410)**. No sibling-stream breakage attributable to these files.

## Per-claim verdicts

### S2-1 — ambiguous backend handle no longer a silent drop — **CONFIRMED**

Diff does what is claimed: `task-actions.server.ts:985-1022` posts a
`policy-engine` note built from `ambiguousBackendHandleNote`, reprojects, and
records `task.comment.unrouted`. The resolver half was already in HEAD
(`agent-reply.server.ts:182-217`, commit 5e8b000) — consistent with the claim
that `agent-reply.server.ts` needed no change.

Canary (block removed, `if (!target) {` restored to a bare early return):

```
FAIL app/server/tasks/agent-reply.server.test.ts > commentToAgent > an AMBIGUOUS backend handle posts the policy note naming the candidates and starts NO run (B-AG2)
AssertionError: the refusal must say so on the timeline: expected undefined to be truthy
```

Composer half canary (`mention-suggestions.server.ts:174` reverted to a fixed
4-entry RESERVED):

```
FAIL ... > does NOT offer a backend handle that covers more than one deployed specialist
AssertionError: expected [ 'operator', 'agent', 'claude', …(1) ] to deeply equal [ 'operator', 'agent', 'codex' ]
FAIL ... > returns the reserved role handles, and names the profile each backend handle reaches
```

Both match the claimed output. Side benefit verified: `reserved` also feeds the
timeline's honest-highlight list (`app/features/task-detail/timeline.tsx:82-88`),
so a stale `@claude` stops rendering as a routing mention.

Not a break, but see gap **G-2** below — the zero-deployment case is untouched.

### S2-3 — R15-7 completion path — **CONFIRMED**

`task-actions.server.ts:2147-2160` starts from `withheldAgentGrants()`, matching
the run layer (`specialist-run.server.ts:750-752`). `resolveAgentCollab` then
gates `question` (`:2232`) and agent-asserted `evidence` (`:2239`).

Canary (`withheldAgentGrants()` → `[]`):

```
FAIL app/server/tasks/agent-completion.server.test.ts > R15-7: an UNRESOLVABLE profile's finished run opens no question packet and asserts no evidence
AssertionError: a ghost profile must not open a decision: expected { id: 'pkt_udR490xOwgxP', …(7) } to be null
```

Ruling check (R15-8 list, §D): R15-7 says "no comments/ask-human/evidence".
ask-human and evidence are enforced here; `collab.comment` is computed and never
read at completion (the run's final REPORT still posts — `reply.text` is asserted
by the test). That is a defensible reading (the mid-run comment TOOL is withheld
at the run layer) but it is an interpretation, not a proof, of "no comments".
Verdicts deliberately still come from the engage-time `verdictCapable` snapshot
(`:2173-2179`, F10-15), so an undeployed-but-engaged reviewer can still record a
verdict — unchanged by this repair and outside R15-7's wording.

### S2-2 — B-AG1 notice reaches the admin — **CONFIRMED**

`project.agents.tsx:106-147` spreads `result.notice` on all three save intents;
`agents-page.tsx:861-868, 987-992` renders it as a second, `error`-toned toast
(`useToast` signature `(text, kind?)` — `app/ui/toast.tsx:159` — so the call is
real, not a silent no-op).

Canary (all three spreads removed):

```
FAIL app/features/agents/agents-route.server.test.ts > the action result carries the delivery notice so the save is not silently non-repairing (B-AG1)
AssertionError: expected undefined to be 'withheld' // Object.is equality
```

Caveat (not a break): the notice's only surface is an auto-dismissing toast.
`project.agent_profile.created/updated/deployed` ARE in the activity-feed
whitelist but `auditText` (`activity-feed.server.ts:216-223`) never renders
`deliveryNote`, and `agents-page.test.tsx` has zero assertions on `notice` — the
UI half of B-AG1 is proven only at the route boundary.

### S5-G3 — ambiguity visible for machine callers — **CONFIRMED** (5 sites)

Canaries, each reverting only the named site:

```
task-actions.server.ts:1383 (prepareAgentReplyEvent)
  FAIL task-actions.server.test.ts > an agent reply whose @tag is ambiguous discloses the non-delivery in the reply
  AssertionError: expected '@arda the review is clean — over to y…' to contain 'nobody was notified'

task-actions.server.ts:2585-2589 (operatorPromptAgent posted comment)
  FAIL task-actions.server.test.ts > discloses an ambiguous @tag on the posted directive without notifying anyone
  AssertionError: expected '@dev Implement the fix and coordinate…' to contain 'nobody was notified'

task-actions.server.ts:715-732 (appendComment / H3)
  FAIL task-actions.server.test.ts > a HUMAN comment whose @handle matches two people carries the non-delivery note
  AssertionError: the dropped mention must be visible: expected undefined to be truthy

operator-actions.server.ts:327 (writeOperatorComment)
  FAIL operator-actions.server.test.ts > an AMBIGUOUS @tag in an operator comment discloses the non-delivery instead of dropping it (S5-G3)
  AssertionError: expected '@arda the reviewer approved — accepta…' to contain 'nobody was notified'

agent-toolkit.server.ts:96-99 (postAgentComment)
  FAIL agent-toolkit.server.test.ts > an AMBIGUOUS @tag in a mid-run agent comment is disclosed on the comment (S5-G3)
  AssertionError: expected '@arda the migration needs your call b…' to contain 'nobody was notified'
```

All five match the claimed output. Coverage of the fan-out ladder is complete:
every `notifyMentionedUsers` call site outside the pure helper
(`agent-toolkit:128`, `task-actions:763/1458/1944/2606`,
`operator-actions:377/469`) now receives disclosed text.

Correctness checks that PASSED adversarial probing:

- `resolveMentionTargets` (`mention-notify.server.ts:101-116`) skips handles that
  match NOBODY (`if (!tier) continue`), so a typo'd `@nobody` never produces a
  false "matches more than one person" note.
- Ordering in `writeOperatorComment` is right: brevity → disclosure → dedupe, and
  the dedupe compares the DISCLOSED new text against the DISCLOSED stored text
  (`operator-actions.server.ts:320-350`), so `no-duplicate-summary` still fires
  for a re-stated narration.
- `addRecommendation` dedupes on frontmatter `(kind, profileId, toStageId)`, not
  on text, so the disclosure cannot defeat it. (It is, however, the one
  disclosure site with NO test.)
- Deviation 3 (`task.comment.unrouted`) genuinely avoids double-counting: the
  action is absent from `AUDIT_ACTION_KINDS`, so it adds a DB trace and nothing
  else — the human-visible signal is the timeline note, which does render
  (`system:policy-engine` is an established actor, `actor-ref.server.ts:9/48`).

Deviation 6 (self-declared) is **real and understated** — see gap **G-1**.

### Lesser: advisory line keeps the mode — **CONFIRMED**

`agents-page.tsx:507-521, 599-607`. Modes come from stored grants through
`capabilitiesToActionLabels` (`agents-query.server.ts:98-127`), so the displayed
mode is honest, not a catalog default.

```
FAIL app/features/agents/agents-page.test.tsx > the advisory line keeps each label's mode instead of flattening them
AssertionError: expected 'Advisory guidance, not policy: Read t…' to contain 'Read the repository & diff (acts dire…'
```

Note: the advisory line is built from `direct + recommend + forbidden` only, so
an advisory capability stored `off` still renders nowhere on that line.

### Lesser: library-deploy reports the withholding — **CONFIRMED**, behavior-safe

`agent-profile-actions.server.ts:415-431, 464, 479-495`.
`normalizeDeliveryGrants(x) === repairDeliveryGrants(x).grants`
(`app/shared/capabilities.ts:370-374`), so the PERSISTED grants are byte-identical
to before — this is purely additive reporting (audit `deliveryGrants` +
`deliveryNote`, plus the returned notice).

```
FAIL app/features/agents/agents-route.server.test.ts > deploy-profile reports a contradictory template's delivery withholding (B-AG1 shape)
AssertionError: expected undefined to be 'withheld' // Object.is equality
```

### Lesser: stale comments (comment-only, no test) — **CONFIRMED**

- `agents-query.server.ts:290-292` — the `agents/definitions/<id>.md` override is
  genuinely gone (`specialist-run.server.ts:1061-1068`, F10-30). True as written.
- `capability-catalog.ts:118-131` — the "same partition" correction is accurate:
  `GOVERNED_CAP_LABELS` is the union over both kinds while the matrix's `known`
  set is the agent editor catalog alone.
- `mention-suggestions.server.ts:15-29` header now matches the derived reserved
  group.
- Residual (same class, not claimed): `app/features/agents/agent-types.ts:61`
  still says "agents/definitions/<id>.md overrides it".

### NOT-DONE items — **accurate scoping**

`FINDINGS.md` §B still shows B-AG1/B-AG2/B-AG4 as OPEN (planning doc),
`specialist-tool-policy.test.ts` is S5's, and `agent-catalog.server.ts:188`
(`normalizeDeliveryGrants` on seed deployments, notice dropped) is under
`app/server/seed/**`. All three are genuinely outside the listed ownership.

## The 3 most dangerous remaining gaps

**G-1 (HIGH) — the no-progress / stuck-loop detector fails OPEN for any reply
carrying an ambiguity disclosure.**
`prepareAgentReplyEvent` stores `withAmbiguityDisclosure(db, separated)`
(`task-actions.server.ts:1383`), but `prevReply` is read back from that STORED
comment (`:1505`, via `latestAgentReplyText` at `:2118`) and compared against the
RAW `replyText` (`:2433-2441`, `operatorShouldReactToReply` at `:140`). The two
sides are no longer the same form, so a verbatim-repeating agent whose report
tags an ambiguous name never trips `noProgress`: the operator reacts again (a
costed operator run + a costed agent run per cycle) until
`OPERATOR_REACT_DEPTH_CAP`, and the stuck packet that finally opens states the
wrong reason ("hit its depth cap", not "repeated its report verbatim"). The
stream's own note calls this "the same asymmetry the evidence-separation
guardrail already has" — but evidence-separation is a per-project TOGGLE, while
this disclosure is unconditional, and it fires precisely on the repeated text.
`writeOperatorComment` shows the correct pattern (disclose BEFORE comparing);
the fix is to compare disclosed-vs-disclosed (or store the raw text for
comparison).

**G-2 (MEDIUM) — the composer still offers a backend handle that reaches NOBODY,
and a test now enshrines it.**
`backendHandles` (`mention-suggestions.server.ts:88-98`) skips only
`covered.length > 1`; with `covered.length === 0` it still emits
`{handle:"codex", label:"Codex specialist"}`. On a project with two Claude
profiles and no Codex profile the reserved group is `["operator","agent","codex"]`
— asserted verbatim by the new test at `mention-suggestions.server.test.ts:139`,
and by the older `expect(call().reserved).toHaveLength(4)` at `:155`. Tagging
that suggestion produces: `resolveMentionedAgent` → null (`agent-reply.server.ts:390-417`,
the primary fallback only fires when the primary's own backend matches),
`ambiguousBackendHandle` → null (`candidates.length < 2`), so **no note, no
audit, no run** — while `AGENT_HANDLE_RE` (`task-actions.server.ts:656`) still
paints the comment with the routed-to-agent tint. That is the exact B-AG2 silent
drop S2-1 closed, surviving on the zero-coverage branch and now made suggestible
by the composer's own list.

**G-3 (MEDIUM) — `withAmbiguityDisclosure` is not idempotent, and the completion
path swallows resolve failures silently.**
(a) The appended note itself contains the ambiguous `@handle`, so re-disclosing an
already-disclosed string appends a SECOND note (`mention-notify.server.ts:161-174`
— the "Idempotent" claim in that docstring is about routing, not re-append). The
operator's snapshot shows STORED comment text, so an operator that echoes a prior
comment verbatim posts `prose + note + note` — which also no longer equals the
stored `prose + note`, so `no-duplicate-summary`
(`operator-actions.server.ts:342-350`) fails to suppress that duplicate. No test
covers a second pass over disclosed text, and neither new export has a unit test
in `mention-notify.server.test.ts` (unmodified).
(b) `task-actions.server.ts:2157-2159` catches EVERY error from
`resolveDeployedSpecialist` with an empty body and no log line. R15-7 targets
ghost/undeployed profiles, but a transient failure (unreadable/locked project
file, parse error) now silently withholds a live agent's question packet and
evidence rows instead of falling through to defaults — a signal loss with no
trace. The run layer's twin at least warns.

Lesser follow-ups: the B-AG1 toast is the only human-visible surface and has no
UI test (`agents-page.test.tsx` has no `notice` assertion); the ambiguous-backend
note has no dedupe or compaction in its own write
(`task-actions.server.ts:992-1005`), so N ambiguous comments leave N notes; and
`agent-types.ts:61` keeps the stale definitions-override sentence.
