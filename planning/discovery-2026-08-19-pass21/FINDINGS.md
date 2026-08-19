# Pass 21 — consolidated findings ledger (2026-08-19)

Source docs: NOTES.md (running log), PRD-ALIGNMENT.md (U*/G*), reference/* (doc-agent audits), USE-CASES.md (live outcomes). This file is the implementation-phase input: every row gets a disposition and, when fixed, a validation record. Owner rulings this pass: R21-1..R21-4 (NOTES.md).

Severity: H (breaks a flow / lies to the user / data corruption), M (wrong behavior, bounded), L (polish/copy), D (docs/canon).

| id | sev | area | finding (short) | source | disposition |
|---|---|---|---|---|---|
| F21-1 | H | projections | validation CHECK misses 'bypassed' → force-accept breaks reprojection (repro'd vs baseline SQL) | doc-agent + planned UC-11 live repro | fix: widen CHECK, re-baseline, real-write test |
| F21-7 | H | github | drifted check-runs → false green "N checks passing" persisted to task.md | lint audit | fix: per-entry tolerance w/ unknown-marker, guard in mapPrChecks, drifted-payload test |
| U3 | H | server | transition/accept stage check runs OUTSIDE the file lock → double-submit writes 2 events/2 audits | PRD agent | fix: re-check inside lock (pattern at task-actions:4143) |
| U1 | H/D | canon | linter exists vs architecture.md "no linter, by decision" ×2; lint red (26) & not in CI | PRD agent + owner R21-3 | ADOPT: fix 26, amend canon w/ ruling, CI gate |
| F21-11 | M/H | github | drifted PAT permissions block silently upgrades to status "valid" | catch audit | fix: per-field catches like settings-actions.server.ts:53 |
| F21-2 | M/H | governance | acceptance ceremony client-only; direct POST accepts w/o disclosure; R20-9 prompt-only | agents doc | fix: server-side acceptance disclosure invariant (+ delegated-ask disclosure check?) — needs design |
| F21-9 | M | github | github-client throws on strict schemas ("never throws" contract broken); Reconcile can 500; PR-open orphan window | lint audit | fix: catch-at-request + tolerant strict fields |
| F21-8 | M | github | one malformed commit empties whole commit list (divergence w/o commits, footprint loss) | lint audit | fix: per-entry catch + drop-count surfacing |
| F21-16 | M | operator | get_task policy map unlabeled → operator attributed ITS OWN egress row to specialist ("grant did not take effect" packet) | live UC-2 | fix: label policy scope in get_task + manual note; consider exposing specialist grants |
| F21-17 | M | operator | PR-closed recovery packet omits known branch drift; "last verdict approve (clean)" stale | live UC-14/16 | fix: fold branch-sync drift fact into pr-closed packet |
| F21-14 | M | operator | full-autonomy operator narrated "I can't accept" then accepted 60s later (policy-map explanation gap) | live UC-8 | fix: manual/policy-map states acceptance exception; maybe suppress contradictory narration |
| F21-13 | M | agents UI | profile editor: Save allowed while backend-switch model list loading → cross-backend model persisted (runtime silently subs claude-sonnet-5) | live | fix: disable Save during model reload; server rejects foreign model id; surface substitution |
| F21-5 | M | rbac | project Viewer still sees credential card on /settings (label+tail+scopes); test pins it | UI doc + live (Selin) | fix: role-gate CredentialCard on settings; fix test |
| G5/R21-4 | M | runtime UX | FR28 onPhase dead — Live-run rows blank; pre-run clone invisible (OBS-8) | PRD agent + live | fix: wire onPhase + "preparing workspace" phase (owner R21-4) |
| OBS-9/R21-4 | M | runtime | every task workspace re-clones 113M+ repo | live | fix: per-project mirror/reference cache (owner R21-4) |
| U5/G4 | M | product | "triage quality gate" promised in New-task placeholder; unimplemented on every path | PRD agent | fix per design: implement gate or fix copy — ask owner in impl if needed |
| U4 | M/D | canon | R20-9 cited in prompt+test but absent from decisions.md (ends at 83) | PRD agent | fix: append ruling 84 (R20-9) + R21-1..4 |
| F21-3 | M | operator | operator MCP mounts not pre-flighted (TODO operator-run:2268); dup denylists unpinned | agents doc | fix: reuse F20-10 pre-flight; single denylist const + test |
| U8 | M | auth | BETTER_AUTH_URL=http:// silently downgrades session cookie | PRD agent | fix: warn/refuse insecure origin outside dev |
| U11 | M | capabilities | attach-evidence grants nothing on Claude without verdict grant (Codex got P13-D-26 fix) | PRD agent | fix: mirror asymmetry |
| F21-6 | L | copy | "Engaged … as a reviewer" for verdict-incapable supporting agents | live | fix: branch copy on verdictCapable |
| OBS-4 | L | copy | operator card/help "supervised recommends at approval boundaries" vs auto-boundaries + row-customization semantics (OBS-12) | live | fix: copy nuance ("gated boundaries", rows override) |
| R21-2 | L/M | operator | capability-gap packets should point at the config remedy (Agent resources) | live + owner ruling | fix: packet fact/option copy in triage gate prompt |
| OBS-1 | — | operator | (superseded by R21-2) | | |
| OBS-2/Q-5 | L | task UI | Force-accept affordance shown at Triage w/ no work next to "Not acceptable yet" | live | owner leaning guarded-visible; still fix F21-1 first; consider stage-aware copy |
| OBS-11 | L | github | no-changes acceptance leaves empty task branch on GitHub (vib-3); merged branches auto-delete | live | fix: delete empty branch at no-changes acceptance (respect setting) |
| F21-10 | L | misc | wire-format kind .catch("update"); takeStagedOutcome throw-past-DELETE; rolesForAction bare Error; storeIcon proto-chain | lint audit | fix batch |
| F21-12 | L | misc | store-files import whole-listing drop + wrong msg; codex features .catch({}) (seam-only); resource-references lost isArray guard | catch audit | fix batch |
| U7 | L | a11y | D2 order:-1 leaves SR/focus order inverted (comment cites the spec it contradicts) | PRD agent | fix: DOM order |
| U6 | L/D | testing | Safari/Firefox declared, never run (chromium-only) | PRD agent | fix: honest docs or add projects |
| U12 | L | copy | two "specialist" strings vs vocabulary ruling | PRD agent | fix |
| F21-4 | L | tests | test-store.ts:27 stale comment (selin→reviewer vs contributor) | doc agent | fix |
| F21-18 | L | css | task-key chip wraps mid-key at 390px | live | fix: white-space nowrap |
| OBS-6 | L | client | stale-session SSE retries 401 forever (~2s cadence) | live | fix: back off / redirect on 401 |
| OBS-7 | L | agents UI | forked profile still labeled "Global base" (Web Verifier shows "Created in viberr") | live | verify scope semantics; fix label |
| F21-21 | M/H | operator | operator reads the SHARED task workspace (on task branch post-commit) as "the default branch" → FALSE out-of-band-merge accusation blocks healthy flow | live VIB-7 | fix: anchor operator repo reads to origin/main (separate ref or git show origin/main:…), prompt wording |
| F21-22 | L | logging | push log "commits: null" on operator-deliver path (agent path logs a count) | live VIB-4/7 | fix: count in both paths or drop field |
| U2 | — | (clean) | lint-commit governance boundaries audit — explicitly clean; do NOT re-open | audits | record only |

## Live-validated behaviors this pass (do not regress)
Browser capability e2e (Claude+Codex TBD-VIB-6); blocked-capability disclosure packet; R20-3 provider-said + retry-sticks; R17-1 drift line in ceremony ("N commits added since review; merges unreviewed"); PR-closed recovery packet w/ archive+deleteBranch real deletion; R20-1 packet-confirm re-queue; empty-branch re-check copy at acceptance ("The completion did not claim this; the server verified it"); members-only 404; viewer server-side deny; temp-password one-time flow; MCP save handshake (16 tools) + <8 refusal + scrub-by-absence; KB live read + rename…(not retested); skills isolation both profiles; search across entities; store re-scan.
