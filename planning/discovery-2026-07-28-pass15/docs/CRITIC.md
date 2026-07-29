# Completeness critique of the pass-15 code maps

Critic pass, 2026-07-28. All seven docs read in full; claims below verified against the
source tree (`ls app/server app/features app/shared`, `app/routes.ts`, plus spot-reads of
the named modules). Three sections: (1) coverage gaps, (2) doc-vs-doc contradictions,
(3) the Suspect-area entries that matter most for a product-quality pass.

## 1. Subsystems no doc covers

Route coverage is complete — every entry in `app/routes.ts` appears in ui-routes.md's
table. The gaps are all in the server/shared layers.

### Entirely unmapped (no doc mentions the module)

- **`app/server/interpretation/` — the readiness derivation layer.** The biggest gap.
  `readiness-policy.server.ts` declares itself "THE readiness derivation — the only place
  readiness is derived" (cited by `docs/architecture/decisions.md`), with the
  diagnostics→readiness floor model in `diagnostics-policy.server.ts` (info/warning/error/
  hardStop → ready/input_required/inconsistency_risk_detected/blocked; derivation only ever
  worsens, never improves) and `freshness-policy.server.ts` (the staleness rules behind the
  GitHub reconcile chip and MCP health dot, backed by `app/shared/freshness.ts`). Every doc
  uses the readiness enum; none explains where readiness values come from or that
  "accepted" is a display-only state added by the mapping layer. A quality pass that sees a
  wrong readiness pill has no map to the code that computed it.
- **The run-log pipeline: `app/server/runtimes/run-sink.server.ts`, `run-events.server.ts`,
  `run-projection.server.ts`, `run-store.server.ts`, `wire-format.server.ts`.** The path
  from adapter callback → secret redaction (P13-U-1) → canonical `.jsonl` → `run_log_lines`
  display projection → `run.log-appended` SSE is unmapped. agents-runtimes.md covers the
  adapters and ui-routes.md covers the consumer (`use-run-log-stream`, `/resources/run-log`),
  but the middle — where redaction, durable truth, and usage-fact extraction live — appears
  in no doc. Log honesty is a recurring pass theme; this is its engine room.
- **Query-side projections: `app/server/projections/decisions.server.ts`,
  `review-queue.server.ts`, `activity-feed.server.ts`, `policy-violations.server.ts`,
  `board-query.server.ts`, `task-query.server.ts`, `single-flight.server.ts`.**
  foundation.md maps the rebuild machinery only. `decisions.server.ts` is self-described as
  "THE single source of which open decisions require a given user's action" (R8-3 — Home,
  project cards, notifications, board chip, review queue all consult it); no doc records its
  definition of an open decision or its member-scoping rules. The review-queue and
  activity-feed semantics are likewise only visible through their route consumers.
- **`app/server/tasks/comment-guardrails.server.ts`** — the REAL enforcement of the
  anti-noise guardrails (owner ruling Q3): `meaningful-comment` silently DROPS trivial
  chatter before it reaches the timeline, `operator-brevity` hard-caps operator narration,
  `evidence-separation` replaces long fenced dumps with a head + reference.
  product-intent.md mentions the U-2 "guardrails stay invisible" ruling but no doc says
  which guardrails are enforced or how. A user whose comment silently vanishes is a
  first-order product-quality scenario, and no map explains it.
- **`app/server/tasks/timeline-compaction.server.ts`** — FR17 compaction (collapses old
  routine comments into a "Compacted" marker, preserves every typed governance event).
  foundation.md gives it four words ("optional timeline compaction on threshold");
  thresholds, marker semantics, and what is preserved are unmapped.
- **`app/server/audit/audit-recorder.server.ts` + `app/server/db/retention.server.ts`.**
  Audits are cited dozens of times across all seven docs, but the audit subsystem itself —
  actor model (`SYSTEM_ACTOR`, operator actor), the secret-free `details` rule, the
  record-never-throws swallow, the `audit-coverage` test, and the F10-29 retention windows
  (which tables, which ages, the "only rebuildable tables" contract) — has no map.
- **`app/server/provenance/`** (recorder + query) — the append-only "what the server saw in
  a store file, and when" record (`projected|removed|error|rescan|github.reconcile|github.merge`),
  never pruned by retention. Mentioned once in passing in github-credentials.md.
- **`app/server/tasks/workspace-retention.server.ts`** — task workspace clone reclamation
  (each task holds an 11-16 MB git clone; this is the only deleter). Unmapped; foundation's
  boot sequence says just "retention", which actually names the *other* module.
- **`app/server/tasks/mention-suggestions.server.ts`** — the @-autocomplete directory
  (agents/users/reserved handles, canonical handle = email local-part). Directly relevant to
  foundation.md's "first-name mention fan-out is ambiguous" suspect — the composer already
  has a canonical-handle answer to that ambiguity, and the suspect was written without it.
- **`app/server/tasks/model-prose.server.ts`** — the literal-`\n` repair heuristic at the
  model→store boundary for operator plan/tool-call prose, with documented blind spots.
  Timeline rendering quality depends on it; unmapped.
- **`app/server/logging/`** (logger + request-context) and **`app/server/errors/`**
  (`AppError`, `error-codes.ts`) — the error taxonomy that every "typed AppError" claim in
  the other docs leans on is itself unmapped.
- **`app/server/org/gagents.server.ts`** (global agent-template CRUD backing the
  org-settings "Agent templates" panel), **`resource-catalog.server.ts`**, and
  **`resource-references.server.ts`** (referential integrity when resources are
  renamed/deleted — agents-runtimes.md cites the P14-KM-01 rename rewrite in one line but
  the module's delete/orphan behavior is unmapped, which is exactly the pass-13
  "silent-resource class" territory).
- **`app/shared/mapping/`** (actor/notification/project/task/user projection→DTO mapping —
  including the "accepted" display-state derivation that readiness-policy defers to),
  **`app/shared/dates`, `app/shared/ids`, `app/shared/auth/password-policy.ts`**.
- **`app/server/prefs/user-prefs.server.ts`, `app/server/theme/theme-cookie.server.ts`,
  `app/features/profile/notification-prefs.ts`** — the preference shapes (notification
  routing, timeline default, theme) appear only as consumers in other docs.
- **`app/server/config/env.server.ts`** — the env validation surface (what is required vs
  defaulted, what fails boot). Only `VIBERR_DATA_ROOT`'s default is ever cited, despite two
  suspects (dual-writer, stale-doctrine) hinging on env/data-root configuration.

### Thin (mentioned, but behavior not mapped)

- **`app/server/runtimes/run-recovery.server.ts`** — operator.md cites the boot
  orphan-finalize trigger in one row; the recovery criteria/caps are unmapped despite the
  restart-recovery chain being a P14-RT-09 sequencing fix.
- **`app/features/review/`** — the review-queue page internals (grouping, ready-list
  computation feeding `waitingOnMe`) are covered only as a route row.
- **`app/server/files/file-mutex.server.ts` / `atomic-file.server.ts`** — the lock/atomic
  primitives every "file lock → atomic write" claim depends on; named, never described
  (lock scope? cross-process?  — relevant to the dual-writer suspect).

## 2. Where the docs contradict each other

1. **Is `agents/definitions/` dead or load-bearing?** agents-runtimes.md (§10 and Suspect 5)
   states the `agents/definitions/<id>.md` persona override "is REMOVED" (F10-30) and calls
   the interface comment claiming otherwise stale. operator.md's very first section says the
   operator persona is read at runtime from `<dataRoot>/agents/definitions/operator.md`
   (`readOperatorDefinition`), and builds its top suspect (stale doctrine) on that fact.
   Both are true in code (the removal was specialist-side only), but as written the two docs
   flatly disagree about whether that directory is a live persona source — a reader acting
   on agents-runtimes.md could "clean up" the directory and lobotomize the operator.
2. **The archived-project chokepoint.** workflow-core.md ("Projects" section): archived
   projects are read-only "via the single `requireProjectMutable` chokepoint inside
   `requireAction`". foundation.md (RBAC/Archive and Comments sections): the comment path is
   NOT gated by `requireAction` and calls `requireProjectMutable` explicitly
   (task-actions.server.ts:681-684), as does `assertProjectAction`. Verified in source —
   `appendComment` carries its own explicit guard. workflow-core's "single chokepoint" claim
   is false and would mislead anyone auditing archive coverage of a new mutation.
3. **"SQLite is a projection" vs "SQLite is PRIMARY storage".** workflow-core.md's header
   says "Files are canonical; SQLite is a projection." foundation.md is careful:
   users/sessions/PATs/audit/notifications live ONLY in SQLite and are not rebuildable
   (the docker-data incident proved what deleting it costs). workflow-core's framing is
   correct for its own scope (tasks) but as a headline rule it contradicts foundation and
   invites "safe to wipe" reasoning about `projection.sqlite`.
4. **Which grant gates packet resolution.** ui-routes.md documents the task-detail UI as
   `canResolvePacket = run-agents ∨ owner` (task-detail-page.tsx:1361-1385); workflow-core.md
   and operator.md document the server as owner OR `resolve-packet`. Both `run-agents` and
   `resolve-packet` resolve to admin|maintainer in `app/shared/rbac.ts:53,56` today, so
   behavior agrees — but the docs name different actions without noting the proxy, and the
   equivalence is one rbac.ts edit away from breaking (UI shows resolve options the server
   would 403, the exact bug class the same file's comment warns about for owners).
5. **Minor, worth a line each:**
   - workflow-core.md's reorder suspect ends "whether any real role tier splits these is
     worth confirming against ACTION_ROLES" — answerable now: `reorder-board` and
     `approve-transition` are both [admin, maintainer] (rbac.ts:52,57), so no live split;
     the suspect's premise is currently defused (drift hazard only).
   - ui-routes.md's design-language section ("tokens are NOT `--viberr-*`") contradicts the
     persistent memory/design-language notes rather than a sibling doc — it is the doc that
     is right; the memory should be corrected, and ui-routes.md correctly flags this.
   - operator.md's Suspect 3 (newest-wins queue swallows a human question) directly
     undermines workflow-core.md's neutral restatement of the lease rationale ("the operator
     re-reads the full task anyway") — not a factual contradiction, but the two docs assign
     opposite confidence to the same design.

## 3. Suspect areas most load-bearing for a product-quality pass

Ranked by (blast radius during live use) × (probability a ≥20-use-case pass hits it):

1. **workflow-core: direct `acceptCompletion` has no in-lock refusal re-check.** The race
   sits at the product's most sensitive gate (Done + real merge); the packet path got this
   exact fix (P14-GV-05) and the direct path did not — a known-bug shape, half-fixed.
2. **workflow-core: `block_on_policy` writes `validation: "failing"` directly, and the
   hold kinds never clear the packet.** Breaks the stated single-writer invariant, gets
   silently reverted by the next `deriveValidation`, and leaves a hold with no un-hold
   affordance — governance pills lying plus a dead-end decision flow, both trivially
   reachable from any policy-hold use case.
3. **agents-runtimes: save-time `normalizeDeliveryGrants` flips an explicit headline `off`
   to `direct`.** Silent authority escalation with no audit trail, in the exact
   grant-normalization territory where pass-14's RV-01 regression lived; enforcement and
   save layers deliberately disagree on polarity.
4. **operator: newest-wins lease queue can swallow a human's `@operator` question.** A
   human asks and is never answered — a direct violation of the NEW-4 "agents answer and
   tag the asking human" product convention, and invisible in any code-level test that
   fires triggers one at a time.
5. **operator: stale live-store doctrine (`data/agents/definitions/operator.md` holds the
   pre-rewrite SOP naming dead tools).** The operator's entire quality is downstream of this
   one file; compounded by foundation's suspects that `.env` and launch.json point at
   different data roots, so which doctrine runs depends on how the app was started.
6. **github-credentials: "Rotate credential" silently rebinds to the org DEFAULT
   connection** (and the CASCADE on connection delete unbinding projects, open question 6).
   In any multi-owner org this breaks delivery with a wrong-owner PAT and no warning —
   delivery is the spine of the product.
7. **github-credentials: non-fast-forward delivery push dead-ends with copy blaming
   credentials.** Reused/rebased workspaces are routine in live use; the failure mode
   mis-directs the user's recovery entirely.
8. **ui-routes Suspect 7 + foundation Suspect 1 (same defect, two views): app-wide
   board/task readability vs WI-13 secrecy guards and the SSE membership filter.** An
   inconsistent exposure model (board leaks what review/activity 403s protect) plus a
   permanently "paused" live chip for legitimate FR4 viewers — both halves surface in any
   non-member walkthrough.
9. **agents-runtimes: `@claude`/`@codex` engages the first deployed specialist of that
   backend.** Wrong-agent engagement on any multi-specialist project; cheap to hit in live
   use, confusing to diagnose from the timeline.
10. **foundation: no single-writer guard on the data root.** Lower probability during a
    disciplined pass, but it has already destroyed data once and every other finding's
    evidence (PATs, run logs, notifications) lives in the file it eats.

### Blind spot the Suspect sections share

Every doc's suspects concentrate on the write/governance paths its own map covers. Because
the unmapped subsystems in §1 (readiness derivation, comment guardrails, decisions
projection, run-log sink) have no map, they also produced zero suspects — yet they are the
layers that decide what a user *sees* (pills, counts, timelines, logs). A product-quality
pass should treat the absence of suspects in those areas as unexamined, not clean.
