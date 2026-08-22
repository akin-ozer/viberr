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
