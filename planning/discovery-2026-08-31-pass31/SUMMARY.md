# Pass 31 — Discovery + live-use summary (2026-08-31)

## What this pass did
Fresh docker-data instance (owner re-baselined 11:06). Restored the GitHub connection from
the previous root (documented preserve-copy recipe; same encryption key via shared .env).
Built fixtures from zero through the UI: 4 users (admin/maintainer/contributor/viewer),
KB `pass31-qa-conventions` (with a marker rule to prove KB loading), stdio MCP `qa-echo`,
Codex profile `Docs Writer`, 2 projects (Viberr Platform → akin-ozer/viberr, Balanced;
Release Ops → containerless, Autonomous). Then 30+ live use cases (NOTES.md ledger),
4 real PRs driven through the app, 81 agent runs, $11.99.

## Deliverables in this folder
- docs/00..06: seven reference docs (intent, server core, agent runtime, operator +
  controller, UI surfaces, RBAC/auth/GitHub, testing) — the implementation-phase context.
- NOTES.md: use-case ledger (UC-1..35 with outcomes) + fixtures + quirks.
- IMPROVEMENTS.md: findings F1..F11, docs-drift A1..A7, gate gaps B, hardening C, polish D,
  owner questions E.
- TESTPLAN.md: T1..T19 concrete test specs to build.

## Headline results
GOOD (the product held up impressively):
- Full governed loop, end to end, autonomously: triage packet → directive → dispatch →
  KB-conformant work → delivery → PR → reviewer request-changes (caught a seeded
  deviation with cited evidence) → rework → re-approve → human acceptance disclosure →
  merge → after-merge branch cleanup. (VIB-1 #249)
- Contributor-owner acceptance exception works (VIB-2 #251, accepted by contributor).
- Outside-world honesty: outside push → "merges unreviewed" disclosure row; outside PR
  close → divergence note + moot-recommendation withdrawal + combined recovery packet;
  outside merge → verdict gate holds, acceptance adapts ("Nothing merges"). (VIB-3, VIB-4)
- Branch-collision protections: policy note at engage, non-fast-forward refusal at
  delivery, collision packet with delete-and-redeliver pick.
- Chained goals: controller-planned 2-link chain ran fully autonomously on the
  Autonomous project, "completed with no changes" acceptance, goal completed. (REL)
- RBAC exact: role matrix enforced with named refusal reasons; members-only 404
  byte-identical to nonexistent; controller relays [denied] under asker's authority.
- Resource mounting exact: granted skills only, KB injection proven by marker, MCP tool
  call proven in transcript, per-role tool denials (reviewer loses branch/push git verbs).
- Ops honesty: concurrency cap queues + drains; interrupt attributes + recovers;
  projection rebuild preserves users/PATs/runs; force-accept ceremony states more, not
  less, and persists acceptance: forced; insights match DB to the cent.

BUGS (implementation queue, ranked):
1. F11 operator self-react loop: reworded status comments defeat the byte-level
   no-progress compare; guard pauses at 8 runs then loop re-arms (14 runs/$1.24 on a
   no-op task). Also operator confabulates its trigger ("this scheduled run").
2. F6 packet-option kind mismatch: operator authored a remote-branch-deletion promise on
   a `discard_branch` option whose ceremony/semantics are local-only discard; missing
   first-class remote-collision resolution verb; no coherence validation at packet-open.
3. F1 delivery-stats provenance: stale remote branch's file/± stats flow into
   github.changed + agent evidence lines while commits list is local.
4. F3 packet copy overclaims ("KB doesn't exist" when it exists at instance level but
   is not granted to any deployed profile).
5. A1 lint gate broken on main (25 errors) while four docs promise exit-0.
6. Assorted: A2/A3 canon drift, B1 unlocked radius/spacing scales, C1 outcome_key bypass,
   C2 grant-polarity trap, C3 env schema gaps, C9 load-bearing English string,
   D1 insights title, D2 toast naming, D5 quota card blind to quota errors, T13 dup
   failure notifications.

## External constraints hit
- Codex quota exhausted until Sep 18 (provider-side): Codex live parity limited to
  config/mount validation (which passed); sticky Retry-on-Claude validated instead.
- GitHub blocks self-approval: R19-B GitHub-approval-as-verdict path needs a second
  GitHub account to test live.

## Owner questions (non-blocking; defaults chosen for implementation)
1. F6 fix shape: add `resolve_remote_collision` packet action (delete stale remote
   branch + close unowned PR + auto-redeliver, admin/maintainer ceremony)? DEFAULT: yes.
2. A1: fix the 25 lint errors rather than amend docs? DEFAULT: fix code.
3. A-docs: correct decisions.md ruling 35, file-formats accept marker, UX-spec stale
   superseding notes per ruling 44? DEFAULT: yes, docs follow the app.
4. E1-E5 (see IMPROVEMENTS): controller transcript visibility for org admins, Codex
   sandbox posture, FR rewrite policy, browser support matrix, audit retention. DEFAULT:
   leave behavior, document honestly.
