# Whole-repo inspection — final state

206-agent adversarial inspection, 2026-09-05/06. **42 confirmed, 12 refuted** by the fleet.

After my own verification and the owner's four decisions:

| Outcome | Count |
|---|---|
| Fixed and canaried | 39 |
| Refuted on verification (a passing test pinned the opposite) | 2 |
| Over-claimed — real mechanism, harm did not reproduce as described | 1 (see below) |
| Owner decisions taken | 4 (one became **ruling 146**) |

Every fix was canaried: the fix reverted, its test confirmed failing, then restored.
Gates: lint, typecheck, ~5800 unit tests, build, and `npm run e2e` (70/70, production image
in Docker).


## Owner decisions taken (2026-09-06)

| # | Decision |
|---|---|
| **#6** | A per-person backend refusal is **not an instance fault**. Recorded as **ruling 146**; the `credential:` / `quota:` entries are out of `degraded`, the readings stay in the health body and on Insights/Profile. Two tests that pinned the old F32-4/F32-9 behaviour were updated to the ruling. |
| **#27** | Exclude the **all-projects firehose** only. `run.log-appended` no longer reaches Home (one event per console line); project- and task-scoped delivery is untouched, as its test pins. New `skipFirehose` route flag. |
| **#5 / #18** | Do it properly. Wired better-auth's `session.create.after` (the per-sign-in seam that was missing) plus `updateUserInfoOnLink`, so a linked GitHub account records its handle — which is what `pr-human-approval` matches R19-B approvals on — and every sign-in stamps `last_login_at` and audits. Verified with `npm run e2e`, 70/70. |
| **#15** | Make the check work, refuse if it cannot. The ruling-17 remote check now carries the project PAT, drops `--exit-code` so "absent" and "could not ask" stop being the same answer, and refuses the discard when the question goes unanswered. A clone with no `origin` is still a definite answer, not a failure. |

## Refuted during implementation — do not re-raise

- **#19** controller bypasses the self-demote guards — `user-admin.server.test.ts:187` pins
  that an admin MAY demote themselves once a second admin exists (a legitimate "stepping
  down"). The server allows it deliberately; the route check is a UI guard against an
  accidental click. I built the chokepoint guard, it broke two pinned tests, I reverted it.
- **#27** `run.log-appended` reaching project scopes — `run-events.server.test.ts:139` asserts
  the opposite as intent: "a project-scoped subscriber (the board) is a legitimate recipient
  … by design." Reverted. Its one unpinned half (the all-projects firehose) WAS fixed, by the
  owner's decision.

# The one finding left open

## [31] MEDIUM — `app/routes/resources.events.ts:129`

**The `projects` firehose is frozen into a slug list at connect, so an event for a project the viewer just gained access to is dropped and Home never shows it**

### Verified verdict (mine, 2026-09-06)

Real, but **much narrower than the finding claims**, and deliberately not fixed.

`resolveScopes()` in `app/routes/resources.events.ts` is handed to the broker as the
connection's `reauthorize` hook, and `applyReauthorization` (sse-broker.server.ts:355) calls
it on **every heartbeat** — `HEARTBEAT_INTERVAL_MS = 25_000`. It recomputes `memberProjectSlugs`
fresh each time, so a project the viewer just gained access to enters their scope set within
25 seconds on its own.

So the claim "the event is dropped and Home never shows it" is wrong. What is true: an event
published for a newly-granted project **inside that ≤25s window** is not delivered to that
connection, and nothing replays it — Home stays stale until the next event for that project
or a reload.

**Why I did not fix it.** The two available fixes are both disproportionate to a 25-second,
self-healing gap:

1. Stop flattening `projects` into a slug snapshot for non-admins and check membership per
   delivery instead — that is a database read on every event, for every connection.
2. Have every membership write reach into the SSE broker to force a re-authorization of that
   user's live connections — a new cross-module hook from `settings-actions.server.ts` into
   `sse-broker.server.ts`, for one window.

If you want it closed anyway, (2) is the better shape: add a `reauthorizeUser(userId)` to the
broker and call it from `inviteMember` / role changes. Say the word and I will.

