# Pass 17 — holistic UX / coherence review

The goal named this the priority: "how UX is going on for the end users (I want you
to focus on this), is UI/UX holistic and coherent overall". This is the dedicated
review — assessed live across **every surface, both themes, desktop + mobile**, on
the pass-17 branch (dev server on the real `docker-data` store). Screenshots were
captured for home, task-detail, GitHub, Policy (light), and board (mobile).

## Verdict: strongly coherent

Viberr reads as ONE product built on ONE design system, not a set of screens that
happen to share a stylesheet. A first-time end user is carried by consistent
patterns rather than having to relearn each page. The governance model — the thing
that could most easily read as intimidating — is instead the source of the app's
clearest, most honest copy. Pass 17's own changes reinforced that (divergence,
no-change, collision, credential-health copy).

## What holds it together (the coherence strengths)

1. **One shell, everywhere.** Left rail = project switcher + workspace nav (Board /
   Review queue / Agents / Policy / GitHub / Activity / Settings); top bar =
   breadcrumb + ⌘K search + notifications + account. Identical on every project
   surface; the instance-settings surface swaps the rail for a settings sub-nav but
   keeps the same top bar. Mobile collapses the rail to a hamburger and the search
   to a magnifier — a real responsive adaptation, not a broken desktop layout.

2. **One pill vocabulary.** Stage dots (colored per stage), readiness pills, the
   ValidationPill ("awaiting verdict" / "validation healthy" / "no validation"), PR
   state (review / merged / closed / accepted), CI checks, review, and now the
   conflict pill (F17-L6) and the divergence warn-row (R17-1) — all draw from the
   same `Pill` component and the same kind→tone map. A user learns "amber = needs
   you, rose = risk/blocked, green = ready, neutral = informational" ONCE.

3. **One card/observation grammar.** The `.obs` key→value rows in decision packets,
   the accept/force dialogs, and the recovery packets are the same primitive; the
   `.kv-row` in Current-state matches. The GitHub page's Repository / Pull-requests /
   Execution-branches panels share the panel-head + right-count header. Dialogs
   share `modal-head` (glyph + title + sub + close), body, and footer-hint + actions.

4. **Empty states have a voice.** "No tasks yet — create one to start the flow",
   "Nothing waits on you", "No review work in flight", "No MCP servers yet" — quiet,
   guiding, never a bare blank. The home 1-2-3 onboarding ("Connect a repository →
   Define workflow stages → Put agents under policy") sets the mental model up front.

5. **Attention is consistent and honest.** The amber "N waiting on you" chip is the
   same on Home cards, the board header, the review queue, and notifications, and it
   counts the SAME predicate. "Blocked or waiting" (R16-2) reads the same predicate
   everywhere. The two-meanings-of-Done (R16-6) is surfaced honestly ("accepted,
   merge pending" vs "merged").

6. **Governance-as-clarity.** The Policy page's two-surface split (Human access RBAC
   | Agent capability) with the "ALWAYS RESERVED FOR HUMANS" band, the capability
   matrix's per-backend enforcement notes, and the honest "unproven — verified on
   first use" scope copy make a genuinely complex model legible.

7. **Both themes, both viewports.** Light mode renders cleanly (no dark-only
   contrast bugs — pass-16 had caught one in org settings; none remained here).
   Mobile adapts (kanban goes horizontal-scroll, expected).

## Net-new UX observations — asked, RULED, and implemented

The goal said to ASK when unsure about a product-design choice rather than change it.
Both questions were put to the owner with background; both answers landed this pass:

- **UX-1 — Login OAuth prominence → RULED (R17-4): local form leads when OAuth is
  off.** On a local-only deployment, the two *disabled* "GitHub — not configured" /
  "Google — not configured" buttons were the most prominent elements on the sign-in
  card, above the local-account form that actually works. Owner: when NEITHER
  provider is configured, the disabled buttons are not rendered — the local form
  leads and SSO shrinks to a one-line footnote. With at least one provider
  configured, SSO-first stands (incl. the D12 disabled button for the other).
  Implemented in `app/routes/login.tsx` + `app/routes/login.test.tsx`.

- **UX-3 — "Not yet synced" read as an error → RULED (R17-5): split never-synced
  (neutral) from stale cache (warn).** A GitHub surface that had never reconciled
  showed the same red ⚠ as a >1h-stale cache — a brand-new project's first
  impression was a warning about nothing being wrong. Owner: never-synced reads
  neutral ("Not synced yet", clock icon, title nudging that Update status runs the
  first sync); only a genuinely old cache keeps the alert tone. Uses the
  distinction `reconcile.at: null` already carried; matches the MCP-health
  precedent ("never checked" = unknown, not stale). Implemented in
  `app/features/github/github-view.tsx` + chip-tone tests.

- **UX-4 — Mobile kanban density.** The board on mobile is horizontal-scroll (correct
  for kanban), but empty columns take a full viewport width each, so an empty board
  reads as "Triage 0 … Ready 0" with large gaps and the populated columns off-screen
  right. By-design for kanban; flag only if mobile board use is a priority (a
  column-picker or a default to List view on narrow viewports would tighten it).

## What pass 17 already improved for coherence

The eight implementation clusters were net-positive for coherence, not just
correctness: the operator now renders as itself (not a phantom ex-member); the
accept dialogs stopped hiding what actually merges; the collision copy stopped
conflating two different hazards; a broken credential stopped lying "configured";
seeded resources stopped reading "updated never". Each removed a small dishonesty
that would have eroded a user's trust in the surface.

## Verified end-to-end this pass (the "does the machinery actually work" checks)

Operator dispatch + role-correct specialist selection; Claude vs Codex parity from
Viberr's eye (both deliver server-owned, both gated identically; Codex tool-id
underscoring + mid-run-comment absence surfaced honestly); MCP mount on Claude runs
(init tool list) with the everything-http server; KB grounding (PISTACHIO canary);
skills load per grant (Docs Writer granted 0 skills → loaded none; operator uses
viberr-app-expertise); stage transitions, reviewer engagement (secondary
assignment), verdict gating, comment + @mention routing, RBAC by role, the full
packet/recovery/collision/divergence/no-change/force-accept lifecycle. See
`LIVE-TESTING-NOTES.md` and `FINDINGS.md`.
