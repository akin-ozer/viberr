# S6-ux handbacks (pass 15)

Two items reached files outside this stream's ownership. Everything else in the
S6 brief landed; see the stream report for the full ledger.

---

## HB-1 (R15-4 residue, MEDIUM) — the members-only refusal is loader-only

**What landed (S6):** `app/routes/project.tsx` is now the chokepoint. Its loader
throws the *unknown-slug* 404 (`No project at projects/<slug>.`, byte-identical
copy) for any viewer who is neither a project member nor an org admin. Because
board, task detail and the six config views are all children of that layout,
every project READ surface refuses. Proven by
`app/features/shell/workspace-routes.server.test.ts` → describe `R15-4
members-only` (member sees / non-member 404 with identical copy / task-detail
URL refused / org-admin keeps access + override pill).

**What is still open:** loaders are not the only entry point. A child route's
ACTION runs without the parent loader, and two RBAC actions are still declared
app-wide by FR4:

- `app/shared/rbac.ts:48-49` — `view` and `comment` carry `appWide: true`, and
  the module header states their "server enforcement is `authenticated`, not
  `member of this project`". R15-4 narrows FR4 to "within projects the user can
  see", so both should become member-scoped (org-admin override intact).
- `app/routes/project.task.tsx` — the comment/mention action path is the live
  consumer. A non-member who knows a task URL can still POST a comment; the
  loader 404 hides the task but does not refuse the write.
- `app/features/task-detail/task-detail-route.server.test.ts:255` — the test
  `"non-members may comment app-wide and project as guests"` pins the OLD rule
  and will need inverting when the above changes.
- `app/features/policy/policy-page.tsx:185-190` renders the `appWide` rows with
  their own styling/copy; that copy becomes wrong once the flag goes.

Both files are wave-1 / policy-stream territory, so nothing was touched here.

**Suggested shape:** drop `appWide` from `RBAC_DEFINITIONS`, let `comment` and
`view` resolve through `assertProjectAction` like every other action (org-admin
override already handled by `resolveProjectAuthority`), then invert the
task-detail test and re-word the policy table's app-wide note.

---

## HB-2 (F15-08 note, LOW) — the log clock is re-anchored client-side, not carried

**What landed (S6):** `app/features/runtime/log-clock.ts` +
`log-clock.test.ts`, consumed by one line in
`app/features/runtime/runs-panels.tsx`. A console line's `t` is a UTC wall clock
baked server-side (`app/server/runtimes/wire-format.server.ts` → `clockOf`,
`iso.slice(11,19)`), and the line carries no ISO of its own, so the local clock
is reconstructed by anchoring that wall clock to the run's `startedAt` day and
snapping to whichever calendar day puts it within 12h of the anchor.

**Why it is a note:** the honest fix is to carry the instant, not reconstruct
it — `/resources/run-log` already returns `occurredAt` per line
(`app/routes/resources.run-log.ts` docblock), it is simply dropped when
`StreamedLine` is built. Adding an optional `at?: string` to `LogLine`
(`app/features/runtime/runtime-types.ts`), populating it in
`wire-format.server.ts` / `run-projection.server.ts`, and preferring it in
`localLogClock` would remove the anchoring heuristic entirely. Those are
`app/server/runtimes/**` files, outside this stream.

**Residual risk if left as is:** a single run that spans a DST transition can
render one block of lines an hour off. No other case is affected.
