# UI/UX coherence review — live pass on the running app (2026-08-21)

A critical, page-by-page browse of the running instance (container, MAIN code) with screenshots. Goal: "is UI/UX holistic and coherent overall" + "take notes whenever you find areas to improve." Surfaces reviewed: Home/dashboard, Project board, Task detail, Policy, Agents + profile editor, GitHub, Activity, Instance settings (Users / Resources), decision-packet UI, attachment lightbox.

## Overall: strongly coherent
- One consistent design language everywhere — dark theme, unpref­ixed tokens, card chrome, typography, status chips, backend glyphs (Codex vs Claude). No visual drift between surfaces.
- Clear information architecture: the project workspace nav (Board / Review queue / Agents / Policy / GitHub / Activity / Settings) is identical across every project surface; the instance settings (GitHub / Users / SSO / Agent resources) are cleanly separated from project scope.
- The governance model is surfaced honestly and legibly: Policy splits **Human access (RBAC)** and **Agent capability** into two side-by-side surfaces with a "managed separately" subtitle; the org→project relationship is spelled out ("shared base definitions… each project's policy decides which are eligible… without changing the global").
- The system tells the truth about its own state: MCP "stale, retest", credential "pull_request:write unproven (verified on first use)", "checked N ago", project cards "quiet". Nothing over-claims.
- The Activity stream + Audit logs are rich, filterable, and correctly attributed (Operator / Policy engine / Delivery / Developer / human), and reconcile reality (PR #190 shows **closed** on GitHub + Activity minutes after `gh pr close`).

## Genuine findings (areas to improve — ranked)

1. **The board trails GitHub's PR-close by one reconcile-poll interval (verified: lag, not a persistent bug).** Right after `gh pr close 190`, the **Activity** feed already showed the operator's recovery packet ("PR #190 closed without merging — choose recovery path") + a Policy-engine divergence note, but the **board card for VIB-7 still showed "ready"** for a few seconds — while VIB-3 (rejected #188) showed "closed". I verified the DB afterward: **both** tasks then converged to the identical state (`impl / waiting=human / recovery-packet-open / pr=closed`), so it self-corrects within the reconcile window. The honest finding is a brief **staleness window** where the board lags the Activity/GitHub truth after an external PR close — not a coherence *bug*, but a place where a faster/optimistic board update (or a subtle "reconciling…" hint) would avoid a momentarily-misleading chip. Low severity.

2. **"closed" + "awaiting verdict" can co-render during that window.** VIB-3's card paired a red "closed" PR chip with "awaiting verdict" before the recovery packet propagated to the board. Once a PR is closed-unmerged and a recovery decision is open, "awaiting verdict" is the wrong residual chip — the recovery/decision state should win. Same root as #1 (chip derivation trailing the reconcile). Low severity.

3. **"quiet · N waiting on you" on project cards is mildly self-contradictory.** "quiet" (no active runs) next to "5 waiting on you" (open decisions) can read as conflicting signals. Consider "no runs · 5 decisions" or a single combined status so the two halves don't fight.

4. **Task-key branch reuse can collide (surfaced, not prevented).** The Policy engine honestly flagged "GitHub already has PR #172 on branch vib-7, but it's NOT VIB-7's review PR" — the reused-key / stale-branch hazard (the F22-10 family). The honest surfacing is good; consider proactively namespacing execution branches (e.g. include a run/revision suffix) so a reused task key can't alias a prior closed PR's branch.

5. **MCP staleness is passive.** The everything server showed "stale, retest" (last checked 7h). A light background re-probe, or a clearer "last verified vs stale" threshold, would keep the health signal fresher without a manual retest.

## Notes
- Findings 1–2 (board chip vs the true rejection/recovery state) are the only ones that touch correctness/coherence rather than copy; the rest are polish. None block use.
- Several batch-2 items already improve adjacent UI (the #176 egress reason, #177 broken-tile fallback) but are on PR #189, not yet in the MAIN build this review browsed.
- This review is additive to the UI inventory captured in `reference/UI-INVENTORY.md` during discovery; it focuses on *coherence + improvement candidates* rather than cataloguing.
