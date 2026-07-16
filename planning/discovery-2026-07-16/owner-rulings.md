# Owner rulings — pass 6 (2026-07-16)

Numbered R6-x to avoid colliding with prior passes' D/H/R series. Each is an explicit
AskUserQuestion answer from the owner in this session.

- **R6-1 · Base branch: STAY ON MAIN.** `codex/e2e-product-hardening-2026-07-13` (and its
  parent `codex/full-pass-2026-07-13`, PR #23) are reference-only; their work is re-done
  selectively on main when a finding calls for it. The dev DB was restored to the
  pre-baseline snapshot accordingly.

- **R6-2 · Accept-completion tier: owner-exception (confirms pass-5 D1).**
  Maintainer+ always may accept; ADDITIONALLY the task's human owner may accept its
  completion even when they are only a Contributor. Implementation: call-site owner
  exception on `accept-completion` (mirror the existing `resolve-packet` owner exception;
  ACTION_ROLES row itself stays maintainer+, Policy page must render the exception rule
  honestly like it does for ownership).

- **R6-3 · Archive: READ-ONLY ENFORCED (adopts pass-5 D6, supersedes pass-3 hide-only).**
  Archived projects must block mutations server-side (tasks, comments, agent runs, policy,
  settings except restore) and the UI shows an archived state; restore stays admin-gated.
  Supersedes the pass-3 "hide-only" decision D.

- **R6-4 · Done boundary: DRAG = ACCEPTANCE (confirms pass-4 H4, rejects pass-5 D7/D11).**
  A permitted human dragging Review→Done performs the same acceptance path (merge attempt /
  merge-pending + audit) as the Review queue Accept button — one semantic, two surfaces.

- **R6-5 · Seeded demo runs: REMOVE from rollups AND stop re-animating at boot.**
  Drop the boot seed-resumer behavior (`registerSeededLiveFromData`) that drips seeded
  "running" runs; simulated runs must not count in "runs active", Live-tab rollups, or
  decision counters. Viberr Core goes quiet unless real agents run. (Aligns with pass-5 D12's
  spirit: simulated evidence must not masquerade as real governance state.)
