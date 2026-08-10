# Pass-19 live use-case campaign (executed)

App under test: dev server on the pass-19 worktree, data root `docker-data`, signed in as
Arda (org admin). Two projects: **Viberr Core** (VC, repo `akin-ozer/viberr`, Balanced preset —
the PR-bearing project) and **Ops Sandbox** (OS, Strict preset — the non-PR sandbox).

Status: ✓ pass · ✗ finding filed · ◐ partial · ○ pending

| UC | Scenario | Status | Evidence |
|----|----------|--------|----------|
| UC-01 | Create a project (Strict preset, auto task key, live store-path preview) | ✓ | "Ops Sandbox"/OS created; key auto-derived; footer previewed `docker-data/projects/ops-sandbox/`; landed on its board |
| UC-02 | Invalid repo at creation → is the app honest afterwards? | ✓ | Creation accepts any string (**N19-1 confirmed**), but the GitHub page runs a live probe and shows a red **"repo not found"** pill + "scopes not yet verified". Honest post-hoc → N19-1 downgraded to a nice-to-have (fail fast at creation), not a defect |
| UC-03 | Create a task; operator auto-triggers on creation | ✓ | OS-1 created → operator ran unprompted (P11-70 create trigger) |
| UC-04 | Triage quality gate on an underspecified goal (FR15) | ✓ | Operator refused to advance, set `input_required`, opened a 4-option packet (3 × `edit_goal`, 1 × `block_on_policy`) with a 3-row observation grid |
| UC-04b | **R19-1 operator repo clone — live proof** | ✓ | The packet says: *"The repository checkout is unavailable this run (clone failed: repository not found), so I cannot read config/IaC to disambiguate."* Pre-R19-1 the operator described its own empty workspace as "the repo" (F19-4). It now knows what it can and cannot see, and says so |
| UC-04c | **F19-6 clone diagnostics reach a human** | ✓ | Observation row: "unavailable this run — clone failed with 'repository not found' for akin-ozer/no-such-repo-xyz" |
| UC-05 | Resolve a packet with a NON-recommended option + steer note | ✓ | Chose "Ops-only" over the operator's recommended "Repo-scoped"; note recorded verbatim; honest copy: "Waiting for the edited goal — the packet clears as soon as it lands" (`edit_goal` is fulfilled by the human's edit, by design — no operator round-trip) |
| UC-06 | Goal edit clears the packet | ○ | Blocked: signed out mid-flow (see below) |
| UC-07 | **R19-5 honest force-accept label, off-boundary** | ✓ | On OS-1 at Triage the button reads "Force accept (skips the remaining stages and the review gate)" and the refusal names the real gate: "OS-1 is at Triage, not Review — a completion can only be accepted from the boundary the workflow puts before Done" |
| UC-08 | **F19-42 found: that label overflows its panel** | ✗→FIXED | `white-space: nowrap` + `scrollWidth 351` vs `clientWidth 299` → the label painted 52px outside the GitHub card. Fixed by letting container-sized (`.btn.full`) buttons wrap; gated by a new `app.css.test.ts` assertion + canary |

## Findings from this campaign

### F19-42 — MED · UI · `app/app.css` · FIXED
A full-width button inherits `.btn`'s `white-space: nowrap`, but its width comes from its
CONTAINER, not its content — so R19-5's deliberately honest force-accept label painted outside
the button and its card. Governance affordances are precisely the ones whose labels must state
the whole consequence, so `.btn.full` now wraps. **Class: a copy change that is correct in
isolation can break the layout that has to carry it — a rendered-copy ruling needs a layout check.**

### F19-43 — LOW · `app/server/tasks/task-actions.server.ts:4630-4641` · OPEN
The B-WF2 comment block is duplicated verbatim (two identical 4-line comments back to back).
Cosmetic, but it is the kind of artifact that makes a reader doubt which one is authoritative.

## Blocker

The browser session was lost mid-campaign (`/projects/...` now 302s to `/login`). Re-authenticating
means entering a password, which I do not do — the owner needs to sign in so the UI campaign can
continue. Everything not requiring a session continues meanwhile.
