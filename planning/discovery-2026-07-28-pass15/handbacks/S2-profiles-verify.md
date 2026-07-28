# S2-profiles — adversarial verification (pass 15)

Branch `pass15/product-fixes`, verified 2026-07-29 against the working tree.
Method: read every S2-owned diff hunk; for each claim, reverted ONLY the source
file(s) to `HEAD` and re-ran the named proving test to see it fail; restored the
tree byte-for-byte afterwards (`git diff --stat` matches the pre-verification
stat exactly). Sibling-stream files were not judged.

## Gates

| gate | result |
|------|--------|
| `npm run typecheck` (`react-router typegen && tsc`) | **clean**, no output |
| S2 test files (`capabilities.test.ts`, `agents-query.server.test.ts`, `agents-page.test.tsx`, `agents-route.server.test.ts`, `capability-catalog.test.ts`, `capability-denylist-markers.test.ts`) | **6 files / 93 tests passed** |
| S2 test files (`specialist-run.server.test.ts`, `agent-reply.server.test.ts`, `org-settings-page.test.tsx`) | **3 files / 120 tests passed** |
| whole suite (collateral check) | **205 files / 2369 tests passed** |

## Per-claim verdict

### F15-05 + F15-06 — **CONFIRMED** (with one scope caveat)

*Old-code failure proved.* With `agents-query.server.ts` + `agents-page.tsx`
reverted to HEAD:

```
× never lists approve/request-changes as granted without verdict authority
  AssertionError: expected [ 'Approve the review', …(3) ] to not include 'Approve the review'
× a fresh minimal profile claims no verdict authority and no skills
  AssertionError: expected 'Acts directlyRead the repository & di…' not to contain 'Read the repository & diff'
```

With `capabilities.ts` + `agent-profile-actions.server.ts` reverted:

```
× org-created → library-deployed: no verdict outcomes, no unasked resources
  AssertionError: Approve the review: expected [ 'Post mid-run comments', …(13) ] to not include 'Approve the review'
```

*The diff does what it claims.* The gate is one function
([capabilities.ts:263](app/shared/capabilities.ts:263)) applied inside the ONE
derivation ([agents-query.server.ts:119](app/features/agents/agents-query.server.ts:119)),
and the matrix reads the same `profile.actions.*`
([capability-matrix-modal.tsx:26-31](app/features/agents/capability-matrix-modal.tsx:26)) —
so panel, matrix and policy counts cannot disagree again. Polarity is safe:
only an explicit `direct` verdict carries the outcomes, an explicit `human` on
an outcome survives (`g.mode !== "human"`,
[capabilities.ts:273](app/shared/capabilities.ts:273)), and the gate never
reaches a writer — `updateAgentProfile` preserves the raw ungoverned grants
([agent-profile-actions.server.ts:511](app/features/agents/agent-profile-actions.server.ts:511))
and `seedCaps` seeds the editor from raw stored grants
([create-profile-modal.tsx:106-124](app/features/agents/create-profile-modal.tsx:106)).
No admin decision is overridden: verdict outcomes carry no editor toggle
(`group: null`), so nobody can have *set* them.

*Deviation 1 (the "not a code defect" ruling on `reviewer-expertise`) holds.*
Independently re-derived: `docker-data/agents/profiles/docs-writer.md:61-63` and
`developer-claude.md:62-64` really do store `skills: [reviewer-expertise]`; the
org create path writes `input.skills` verbatim with no default
([gagents.server.ts:213](app/server/org/gagents.server.ts:213), create branch
[:271-296](app/server/org/gagents.server.ts:271)); `AgentModal` seeds `selSkills = []`
for `initial === null` ([resources-panel.tsx:586](app/features/org-settings/resources-panel.tsx:586))
and is `key`-ed `modal.item?.id ?? "new"` ([resources-panel.tsx:1416](app/features/org-settings/resources-panel.tsx:1416)),
so no edit state can bleed into a New; the project modal seeds `{skills:[],mcps:[],kb:[]}`
([create-profile-modal.tsx:905-916](app/features/agents/create-profile-modal.tsx:905));
the org count is a plain sum of stored arrays
([resources-panel.tsx:1215](app/features/org-settings/resources-panel.tsx:1215)).
Verdict: no reachable code path injects the grant. Guard tests are the right call.

*Caveat (not a break):* the two org-settings tests are guards, not proofs — they
pass on old code. The ledger header says "all fail against pre-change behavior";
that is untrue for `"a profile with no granted resources reads '0 context
resources'"` (annotated `(guard)`, so disclosed) and for
`"keeps them for a profile that explicitly holds the verdict"`.

### B-AG1 — **CONFIRMED as a code change, BROKEN as a shipped fix**

*Old-code failure proved.* With `capabilities.ts` + `agent-profile-actions.server.ts`
reverted:

```
× an EXPLICIT headline `off` survives the save, and the contradiction is recorded (B-AG1)
  AssertionError: expected 'direct' to be 'off'
```

The escalation is gone, the explicit `off`/`human` stands, the audit row carries
`deliveryGrants` + `deliveryNote`, and enforcement (`isWithheld`,
[specialist-tool-policy.ts:137-145](app/server/tasks/specialist-tool-policy.ts:137))
now agrees with the save layer. Deviation 4's reasoning is sound — and I verified
the create path does **not** regress VIB-1, because `execute-code-or-write-repo`
defaults to `direct` in the catalog
([capabilities.ts:60](app/shared/capabilities.ts:60)) and the create modal seeds
`{...CAP_MODAL_DEFAULTS}` ([create-profile-modal.tsx:104](app/features/agents/create-profile-modal.tsx:104)),
so a default create still holds the headline.

**But the fix is half-landed and the missing half is the user-facing one.** See
gap #2 below: `ProfileSaveResult.notice` is dropped on the floor at
[project.agents.tsx:105-109](app/routes/project.agents.tsx:105) and
[:136-140](app/routes/project.agents.tsx:136), and — because `seedCaps`
materializes every modal id — the `repaired` branch is *unreachable from the real
UI*, so the only outcome a live admin can produce is `withheld` + silence.

### R15-7 — **CONFIRMED PARTIAL** (matches the stream's own PARTIAL claim)

*Old-code failure proved.* With `specialist-run.server.ts` reverted:

```
× R15-7: mounts NO collaboration channel and promises none in the prompt
  AssertionError: expected [ 'viberr_agent' ] to not include 'viberr_agent'
```

Run side is correct and complete for its layer; I checked the sibling fallback on
the same line range and it is **not** a hole:
`resolveDeliveryPermissions(resolved?.capabilities ?? [])`
([specialist-run.server.ts:798](app/server/tasks/specialist-run.server.ts:798))
is conservative for `[]` because delivery ids are in
`GRANT_REQUIRED_CAPABILITY_IDS` ([specialist-tool-policy.ts:143](app/server/tasks/specialist-tool-policy.ts:143)).
The completion-side hole the handback describes is real and still open —
`let grants … = []` at [task-actions.server.ts:2071](app/server/tasks/task-actions.server.ts:2071)
with `catch { /* undeployed — defaults apply */ }` at :2080, feeding
`resolveAgentCollab(grants)` at :2083. Ruling R15-7 is therefore **not yet met**.

### B-AG2 — **CONFIRMED as a refusal, BROKEN as a shipped behavior**

*Old-code failure proved.* Reverting `agent-reply.server.ts` (with two no-op
stub exports appended so the test file could import):

```
× refuses an AMBIGUOUS backend handle instead of engaging the first-listed profile
  AssertionError: expected { profileId: 'docs-writer', …(9) } to be null
```

— i.e. old code really did engage the first-listed profile. The new resolution
order is correct and the `if (backendCandidates.length > 1) return null` guard at
[agent-reply.server.ts:387-390](app/server/tasks/agent-reply.server.ts:387) is
correctly placed *before* the primary fallback (otherwise it would re-introduce
the arbitrary pick). `@agent`, `@operator` and named handles are unaffected.

**But the refusal shipped without its reply.** See gap #1 — this is the most
dangerous item in the stream.

### B-AG6 — **CONFIRMED as done, ledger claim overstated**

The 5 cases in `app/server/tasks/capability-denylist-markers.test.ts` genuinely
tie `CAP_DENY_RULES` output to the two Codex detectors, including the scoped-only
negative. But neither `specialist-tool-policy.ts` nor `run-service.server.ts` is
modified in this branch, so **this test passes on pre-change code by
construction** — it is a pin, not a proof. The ledger's blanket "all fail against
pre-change behavior" is wrong for this row.

### B-AG3 — **CONFIRMED**

```
× B-AG3: an evidence-only Codex profile is TOLD about the envelope it is constrained to
  AssertionError: expected 'You are the developer specialist on t…' to contain '## Collaboration'
```

The prompt condition now matches `useEnvelopeSchema`'s own grant set
([specialist-run.server.ts:849-866](app/server/tasks/specialist-run.server.ts:849)),
and the note offers nothing ungranted (the test asserts absence of `"verdict"`
and `"question"`), so there is no offer the server would refuse.

### B-AG5 — **CONFIRMED, but incompletely applied**

`F10-30` really did remove the override
([specialist-run.server.ts:1061-1068](app/server/tasks/specialist-run.server.ts:1061)),
so the new comment is true. **The identical stale claim survives in an S2-owned
file**: [agents-query.server.ts:290](app/features/agents/agents-query.server.ts:290)
still says "startAgentRun feeds it to the run when no `agents/definitions/<id>.md`
override ships". Same defect class, same stream, one line away from the fix.

---

## The 3 most dangerous gaps

**1. B-AG2's refusal shipped without the reply — a live silent-drop regression,
reproducible on the owner's own instance.** `resolveMentionedAgent` now returns
`null` for an ambiguous `@claude`, and `commentToAgent`'s `!target` branch
([task-actions.server.ts:960-962](app/server/tasks/task-actions.server.ts:960))
returns immediately: no note, no policy event, no run — and because `forceToAgent`
is only set when `target` is truthy ([:951](app/server/tasks/task-actions.server.ts:951)),
the comment isn't even tinted as routed-to-agent. Meanwhile the composer's
autocomplete still offers `@claude → "Claude specialist"` and `@codex → "Codex
specialist"` as agent targets
([mention-suggestions.server.ts:59-61](app/server/tasks/mention-suggestions.server.ts:59)),
whose header doc still describes the old semantics ("the resolver matches on name
/ id / backend", [:16-18](app/server/tasks/mention-suggestions.server.ts:16)).
The live store has two claude profiles (`docs-writer`, `developer-claude`), so on
that project every `@claude` mention is now a suggested handle that does nothing
and says nothing. Before this branch it did the wrong thing loudly; now it does
nothing quietly, which is harder to notice. Land handback #1 (or gate the reserved
handles in the composer) before this ships.

**2. B-AG1's `withheld` notice reaches only the audit log, and the old auto-repair
is gone — a success toast over a profile that cannot deliver.** The route drops
`result.notice` ([project.agents.tsx:105](app/routes/project.agents.tsx:105),
[:136](app/routes/project.agents.tsx:136)) and returns
`Profile "X" updated — changes apply to future assignments`. Worse, the *only*
reachable outcome from the real editor is `withheld`: `seedCaps` materializes
every modal capability id ([create-profile-modal.tsx:104-124](app/features/agents/create-profile-modal.tsx:104)),
so the headline is never absent and the `repaired` branch cannot fire from the UI.
Net effect for an admin who opens a legacy contradictory profile (headline `off`,
`commit-push-branch` on — exactly the VIB-1 store shape) and clicks Save: it used
to be silently fixed, now it is silently *not* fixed. Correct policy, invisible
consequence. Handback #3 is not optional polish; it is the other half of the fix.

**3. R15-7 is recorded as an owner ruling but is enforced on only one of the two
layers.** `applyAgentCompletionEffects` still resolves collaboration gates from
`[]` for an unresolvable profile
([task-actions.server.ts:2071-2083](app/server/tasks/task-actions.server.ts:2071)),
which `resolveAgentCollab` reads as comment/ask/evidence GRANTED — so a ghost
profile's finished run can still post its reply, open a question packet and assert
evidence rows in a vanished profile's name, which is precisely what the ruling
forbids. The run-side fix makes this *less* likely to be noticed (no toolkit
mid-run), not less possible at completion.

### Lesser, worth fixing before the ledger is called done

- **The ledger was not updated.** `FINDINGS.md` still shows `F15-05`, `F15-06`,
  `B-AG1`…`B-AG6` (and `B-AG4`, the R15-7 item) as **OPEN**, while the S4 stream
  updated its own rows in the same file. Status truth lives in the ledger, not in
  a stream report.
- **The advisory line drops the mode.** `ProfileDetail` concatenates the
  non-governed labels from `direct` + `recommend` + `forbidden` into one sentence
  ([agents-page.tsx:504-509](app/features/agents/agents-page.tsx:504)), so an
  advisory capability an admin explicitly set to `human` now reads identically to
  one at `direct`. The matrix still distinguishes them. Same disagreement class
  F15-05 was filed for, one level quieter.
- **"the same partition" is not literally true.** `GOVERNED_CAP_LABELS` is the
  union of both kinds' editor catalogs
  ([capability-catalog.ts:126](app/features/agents/capability-catalog.ts:126))
  while the matrix's `known` set is agent-only
  ([capability-matrix-modal.tsx:52-54](app/features/agents/capability-matrix-modal.tsx:52)),
  so operator capabilities sit in the panel's columns but under the matrix's
  "Other actions". The deviation is disclosed in the stream report; the code
  comment claiming both surfaces "read one policy the same way" is not.
- **`normalizeDeliveryGrants` still silently drops the notice** at the
  library-deploy call site
  ([agent-profile-actions.server.ts:449](app/features/agents/agent-profile-actions.server.ts:449))
  and in the seed path ([agent-catalog.server.ts:188](app/server/seed/agent-catalog.server.ts:188)).
  Harmless today (both feed conservative/complete grants), but it is the same
  no-audit shape B-AG1 was filed against.
- **Stale comments in `specialist-tool-policy.test.ts`** (S5's file) at
  [:80-83](app/server/tasks/specialist-tool-policy.test.ts:80) and
  [:100-102](app/server/tasks/specialist-tool-policy.test.ts:100) still describe
  `normalizeDeliveryGrants` as rewriting an explicit `off` at save time. That is
  now false and should be handed back to S5.
