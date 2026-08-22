# Pass 23 — findings

## BUG-1 (HIGH, security-disclosure) — web egress shows "Off" in the editor but is ENABLED at runtime

**Live-proven on merged main.** During VIB-1's review, the Reviewer specialist
invoked the built-in `WebFetch` tool against `https://api.github.com/repos/akin-ozer/viberr/pulls?...`
and it **executed** (returned "not reachable", i.e. ran unauthenticated — it was
NOT denied). The Reviewer profile does not hold the web capability, yet WebFetch worked.

### Root cause (verified in code)
- `use-web-search-fetch` ("Search & fetch from the web") has catalog **defaultMode
  `"direct"`** (`app/shared/capabilities.ts` — `cap("use-web-search-fetch", …)` passes
  no mode, and `cap()` defaults to `"direct"`).
- The seeded **Developer** and **Reviewer** profiles do NOT declare this capability
  (`app/server/seed/agent-catalog.server.ts` action-specs omit "Search & fetch from
  the web"), confirmed in the persisted file `/data/agents/profiles/reviewer.md` —
  the grant is **absent**.
- Enforcement `resolveSpecialistDisallowedTools` → `isWithheld` (`app/server/tasks/
  specialist-tool-policy.ts`): for an **absent** grant it returns
  `GRANT_REQUIRED_CAPABILITY_IDS.has("use-web-search-fetch")` = **false** (web-fetch
  is not grant-required), so WebFetch/WebSearch are **NOT** added to `disallowedTools`.
  Its own test asserts `resolveSpecialistDisallowedTools([]).not.toContain("WebFetch")`.
- The Edit-profile modal renders the absent grant as **"Off"** (observed live on the
  Developer editor: "Search & fetch from the web · Off" while the catalog default is
  `direct`). The read-only profile detail simply OMITS the capability, so the editor's
  "Off" is the only state an admin ever sees — and it is wrong on both counts (it
  contradicts the `direct` default AND the actual runtime, which leaves egress ON).

### Impact
The shipped default specialist agents (Developer, Reviewer) run with **arbitrary-URL
web egress enabled** (WebFetch + WebSearch). An admin inspecting the profile editor
sees "Search & fetch from the web: Off" and reasonably concludes the agent cannot
reach the network — but it can. Web egress is a real exfiltration surface (the whole
point of the R19-19 browser-capability / P14 egress-gating work was to CONTROL it),
and `capabilities.ts` itself documents this capability as "Enforced on BOTH backends:
tool denial on Claude (WebFetch/WebSearch removed)" — which does not hold for an
absent grant.

### The design question (for the owner — see QUESTIONS.md Q1)
Two coherent fixes, opposite defaults:
- **(a) Safe-by-default egress**: make absent `use-web-search-fetch` mean *withheld*
  (add it to the grant-required set OR flip catalog default to `off` and deny on
  absent). Matches the editor's "Off" display and the egress-gating intent; but
  removes web access from default agents (may affect flows that fetch docs/APIs).
- **(b) Honest display**: keep egress on by default, but make the editor + profile
  detail show the TRUE effective state ("Allowed") instead of "Off".
The security-conscious reading favors (a). Needs an owner ruling because it changes
whether agents can reach the network out of the box.

### Second manifestation — save silently flips web egress on→off
The editor (`app/features/agents/create-profile-modal.tsx:152-153`) initializes EVERY
catalog capability to `"off"`, then overrides with the profile's actual grants:
```
const caps = {}; for (const id of Object.keys(defaults)) caps[id] = "off";
```
It ignores each capability's catalog `defaultMode`. On save it persists all of them
explicitly. Live-proven: editing the Developer ONLY to add `read-github-api` persisted
`use-web-search-fetch: off` into `/data/projects/viberr/project.md` — so the forked
Developer's web egress silently went from ON (absent → permissive) to OFF (explicit →
denied). Editing a profile for an unrelated reason changes its network egress without
the admin touching that toggle. (`use-browser`, `report-validation-verdict`,
`attach-evidence-references` are likewise materialized — harmless where their catalog
default is already `off`, but `use-web-search-fetch` defaults to `direct`, so only it flips.)

### Fix shape (depends on Q1)
- If egress OFF by default: add `use-web-search-fetch` to `GRANT_REQUIRED_CAPABILITY_IDS`
  (or set its catalog `defaultMode` to `off`) so an absent grant withholds WebFetch/
  WebSearch — runtime then matches the editor's "Off". Editor still fine.
- If egress ON by default: initialize the editor toggles from each capability's catalog
  `defaultMode` (not hardcoded `"off"`) so `use-web-search-fetch` shows "Allowed", and
  don't silently persist an off it never had. Runtime already leaves it on.
Either way the display and the runtime must agree, and a save must not change a toggle
the admin didn't touch.

### Repro
1. Fresh instance, seeded Developer/Reviewer. Open Agents → Reviewer → Edit profile →
   COLLABORATION: "Search & fetch from the web" shows **Off**.
2. Run any task to Review; the Reviewer can call `WebFetch <any url>` and it executes.
   (Or unit: `resolveSpecialistDisallowedTools(reviewerGrants)` contains no "WebFetch".)
3. Edit any profile (change anything) and save → its persisted grants now include
   `use-web-search-fetch: off`; its runtime WebFetch is now denied. The admin never
   touched that toggle.

---

## BUG-1 — FIX IMPLEMENTED (branch `fix/pass23-web-egress-editor`)

Owner ruling (2026-08-22): **web egress ON by default**. Runtime unchanged; the
editor was fixed to show the true state and stop the silent on→off flip.

Changes:
1. `app/shared/capabilities.ts` — export `GRANT_REQUIRED_CAPABILITY_IDS` as the
   single source of truth for "safe-by-default withheld" (moved out of
   specialist-tool-policy.ts, which now imports it). Server enforcement and the
   editor now read the same set.
2. `app/server/tasks/specialist-tool-policy.ts` — import the shared set (removed
   the local duplicate). No behaviour change.
3. `app/features/agents/create-profile-modal.tsx` — `seedCaps` now seeds each
   ABSENT toggle to the mode the runtime uses for a missing grant:
   `GRANT_REQUIRED_CAPABILITY_IDS.has(id) ? "off" : defaults[id]` (the catalog
   default) instead of hardcoded `"off"`. This exactly matches
   `effectiveCollabMode`/`isWithheld`: web egress (catalog `direct`) now shows
   **Allowed**, grant-required caps and verdict still show **Off** (F10-07/F10-14
   preserved). A save therefore persists the true state — no silent egress flip.

Validation:
- `tsc --noEmit` clean.
- Full suite **268 files / 4218 tests green** (+1 new).
- New test `agents-page.test.tsx › "edit mode: an absent web-egress grant seeds
  Allowed, not Off"` renders the real `CreateProfileModal` and asserts web egress
  = Allowed while the (grant-required) verdict row = Off. This is component-level
  UI validation of the exact render.
- BEFORE evidence: the live container's Developer editor showed "Search & fetch
  from the web · Off" (captured while adding read-github-api). AFTER: the
  component test asserts Allowed. (A live project-editor screenshot needs a
  PAT-connected project; the org-level editor exposes no capability toggles.)
