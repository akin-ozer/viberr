# Pass 23 — questions for the owner

## Q1 — web-egress default (from BUG-1)
The seeded Developer & Reviewer ship with `use-web-search-fetch` **absent**, which the
runtime treats as web egress **ON** (WebFetch/WebSearch usable — live-proven), while the
profile editor shows it **"Off"**. Which is the intended default?
- **(a)** Web egress OFF by default (safe-by-default): absent = withheld; deny WebFetch/
  WebSearch unless a profile explicitly grants it. Editor "Off" becomes truthful.
- **(b)** Web egress ON by default (current runtime): fix only the editor to show
  "Allowed" instead of "Off".
Recommendation: (a) — matches the egress-gating intent and the editor's current display;
the security-conscious default. Confirm before I implement.

**ANSWERED (2026-08-22): ON by default.** Runtime stays (absent web-fetch = WebFetch on).
Fix = editor-side only: show the true effective state ("Allowed") and stop the silent
on→off flip. Implementation: seed each absent capability to its EFFECTIVE default
(`grant-required ? off : catalog default`) instead of hardcoded "off".

---

## Product-design questions surfaced during pass-23 testing (for owner input)

### Q2 — KB/MCP delete-confirm counts only ORG-TEMPLATE grants
When deleting an org KB/MCP, the confirm says "No agent template grants it" — but it
counts only ORG TEMPLATES (`gagents`), not PROJECT-DEPLOYED agents that grant it and are
silently repointed/dropped by `updateResourceReferences` (documented deliberate,
`resources-panel.tsx` grantTail/usedBy, P14-KM-09). Live: deleting the "API Standards"
KB dropped the Viberr developer's grant while the confirm implied nothing used it.
**Question:** should the delete-confirm ALSO surface "N project agent grant(s) will be
dropped", or is the org-template-only count intended? (Data integrity is fine either way;
this is a disclosure-completeness call.) Leaning: surface project grants for honesty.

### Q3 — first-task-per-project "Preparing workspace" has no progress
The first task on a project clones the full repo into a bare mirror (took ~2 min for
akin-ozer/viberr, 129 MB history) and shows "Preparing workspace" for the whole time with
no progress/ETA — looks stalled. Subsequent tasks reuse the mirror (fast).
**Question:** worth a progress/"cloning NN MB" indicator or a first-clone note, or leave
as-is? (Purely UX; the clone itself is correct.)

### Q1 — web-egress default — ANSWERED (ON by default). Fixed editor → PR #194.
