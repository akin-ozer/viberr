# react-doctor false positives & deliberate suppressions

Consumed by the /doctor triage loop (step 2): diagnostics matching a pattern here are
dropped before fixing. Patterns that say "verify" require an actual Read/grep of the
flagged site before suppressing — never suppress on filename alone.

Scope note: `doctor.config.ts` excludes `**/design/**`, `**/.claude/**`, `**/data/**`, and
`**/*.server.test.ts` at the scanner level — none of them are shipped app code. `design/`
is the standalone mockup bundle (static HTML/JSX prototypes the app never bundles); the
other three are checkouts or fixtures of this same repo (agent worktrees, the gitignored
VIBERR_DATA_ROOT, server-only test files). Scanning them double-counts every finding
against stale copies — `design/support.js` alone accounted for 45 phantom
`postmessage-origin-risk` hits before it was scoped out.

## Verified false positives

- `anti-slop(*)` (require-safety-comment-for-type-assertion / no-runtime-typeof /
  no-unknown-parameters / no-unsafe-dictionary-type / no-known-value-widening /
  no-conditional-empty-object-spread / no-chained-type-assertions) — react-doctor bundles
  an `anti-slop` plugin that DUPLICATES the repo's own `tools/oxlint/anti-slop` rules, so
  its hits on `app/` code are the SAME accepted `npm run lint` baseline (oxlint-25),
  triaged there, not here. The recurring shapes are all correct: `self-heal.server.ts`
  narrows a caught `unknown` throwable (`typeof`/`instanceof` is the only guard a thrown
  value allows) and copies dynamic `SELECT *` rows (`Record<string, unknown>` is the honest
  shape, guarded by a SAFETY comment); `boot.server.ts` / `specialist-run.server.ts`
  conditionally spread an optional log-context / view prop; `pr-open.server.ts` /
  `self-heal.server.ts` annotate an explicit anonymous return type. Do NOT contort correct
  error-handling / dynamic-row / logging code to satisfy a second ruleset — keep the oxlint
  count at its baseline instead. The `tools/oxlint/**` source that IMPLEMENTS these rules is
  scoped out in doctor.config.ts (its AST visitors must use `unknown` params + runtime `typeof`).

- `deslop/unused-export` — `DEFAULT_NUDGE` / `PROFILE_NUDGE_HOURS` in
  app/features/profile/notification-prefs.ts — schema-only exports kept by ruling 13
  for the future "re-ping unanswered decisions" feature. Verify the ruling-13 comment
  is still attached before suppressing.

- `react-doctor/no-derived-useState` — `useState(prop)` initializers in a component
  whose render site keys it on those same props (reset-by-remount pattern), e.g.
  ProjectPanel in app/features/project-settings/settings-page.tsx. Verify the `key=`
  exists at the render site; the rule cannot see it.

- `react-doctor/no-derived-useState` — capture-once optimistic/uncontrolled state:
  a local copy seeded from a prop that the user then mutates ahead of the server
  (profile-page.tsx notification/theme toggles `ntf`/`tl`/`mo`; timeline.tsx
  `tlDefault` filter tabs). Deriving from the prop would lag the UI a round-trip.

- `react-doctor/no-derived-state` — state seeded from loader props but appended to by
  a second setter with data that exists only client-side (use-run-log-stream.ts
  `linesByThread`, fed by SSE tail fetches), or an intentional
  reset-on-external-URL-change synchronizer that must tolerate in-flight keystrokes
  (topbar.tsx `query`). Verify the second setter callsite exists.

- `react-doctor/no-adjust-state-on-prop-change` / `no-event-handler` /
  `no-cascading-set-state` / `no-chain-state-updates` — effects that sync with an
  async react-router **fetcher** result (`fetcher.state === "idle" && fetcher.data`):
  the success signal only exists after the round-trip, so no click handler can host
  the work (agents-page.tsx handled-result effect; profile-page.tsx password-form
  post-success reset; timeline.tsx `setDraft("")` after submit; create-profile-modal
  catalog load/defaults). Verify the effect is guarded on fetcher lifecycle, not on a
  plain prop.

- `react-doctor/no-adjust-state-on-prop-change` — timeline.tsx `ask` prop: an
  imperative event counter from the parent (bump → prefill + focus, guarded
  once-per-bump via ref). Not duplicated prop state.

- `react-doctor/no-array-index-as-key` — rows with no per-item identity that never
  reorder or filter: append-only log consoles (runs-panels StreamedLine), immutable
  packet observation/evidence lists (decision-packet, timeline evidence). For
  decision-packet options, index-based selection is documented design (ruling 7) and
  `kind` is non-unique. Verify the list is append-only or fixed-per-mount.

- `react-doctor/js-set-map-lookups` / `js-combine-iterations` — `.includes()` or
  chained passes over bounded tiny arrays: project workflow stages (3–5 items,
  agents-page/create-profile-modal chip rows), module-init constants built once
  (capability-catalog.ts), and the per-reviewer-row `activeReviewerIds.includes()` in
  execution-profile.tsx (bounded by reviewers actively running on ONE task — well under
  the rule's ~10-item threshold). Verify the array is stages, a hardcoded catalog, or the
  active-runs list for a single task.

- `react-doctor/js-index-maps` — `array.find()` inside a loop where the array is re-read
  fresh each iteration so no pre-built index can be reused: `schedules.find(x => x.id …)`
  inside the per-occurrence `updateTaskFile` callbacks in schedule.server.ts. The array is
  also tiny (a task's schedule occurrences). Verify the `.find()` receiver is re-derived
  per iteration (e.g. from `parsed.frontmatter` inside an update callback), not a stable
  outer array.

- `react-doctor/js-tosorted-immutable` — `[...set].sort()` in resource-catalog.server.ts
  (`[...skillIds]`/`[...mcpIds]`/`[...kbIds]`): the spread converts a `Set` to an array —
  it is NOT a defensive copy of an existing array, and `Set` has no `.toSorted()`, so the
  suggested rewrite doesn't type-check. Verify the spread target is a `Set`/`Map`, not an
  `Array` (a `[...arr].sort()` over a real array IS fixable and should not be suppressed).

- `react-doctor/async-await-in-loop` — loops whose iterations are ordered, dependent
  mutations: the operator decision-plan executor (operator-run.server.ts — the plan
  schema says actions run in order), scope-violation resolution (pat-validator.server.ts
  — read-modify-write of the same task.md across iterations), boot orphan-run recovery
  (run-recovery.server.ts — serial `applyAgentCompletionEffects` / operator re-invokes,
  deliberately avoiding an operator stampede at startup), and the schedule-tick claim/
  finalize loops (schedule.server.ts — each occurrence read-modify-writes its task.md via
  `updateTaskFile`). Verify the dependency before suppressing; independent loops should
  still be parallelized.

- `react-doctor/no-secrets-in-client-code` — fabricated test-fixture PATs in
  server-only test files. Verify the path matches `*.server.test.ts` and the value is
  synthetic (e.g. `github_pat_11FINE…`).

- `react-doctor/clickjacking-redirect-risk` — login.tsx `returnTo`: validated by
  `safeReturnTo()` (same-origin relative path) before `redirect()`. Verify the helper
  is still applied.

- `react-doctor/git-provider-url-injection-risk` — specialist-run.server.ts: internal
  owner/repo slug from project frontmatter interpolated into agent prompt text, not an
  outgoing request URL.

- `react-doctor/no-autofocus` — `autoFocus` on the first field of a just-opened
  modal/dialog (resources-panel KB/MCP/Skill/Agent modals). Deliberate, correct dialog
  focus management. Page-load autofocus is NOT covered by this pattern — fix those.

- `react-doctor/effect-needs-cleanup` — the two SSE hooks (use-live-updates.ts,
  use-run-log-stream.ts). The rule fires because the effect calls `.addEventListener` and
  its matcher looks for a matching `removeEventListener`, but the listeners sit on an
  EFFECT-LOCAL `new EventSource(...)` whose returned cleanup calls `source.close()` —
  which tears down the connection and all its listeners at once (rule validation prompt
  condition 2: "a returned cleanup DOES release this resource even if the matcher missed
  it"). Both are ERRORS and will re-fire every scan. Verify the `addEventListener` target
  is an EventSource/WebSocket created inside the same effect and `.close()` is in the
  returned cleanup; a listener on a PERSISTENT target (window/document) still needs an
  explicit `removeEventListener` and must not be suppressed.
  use-live-updates.ts fires a THIRD `effect-needs-cleanup` (0.9.12) on its `setTimeout`s:
  they live in the `scheduleRevalidate` helper and the `source.onerror` closure, and the
  effect's returned teardown captures the mutable `timer` / `reopen` ids and `clearTimeout`s
  both — but the matcher only scans the effect's top-level statements, so it misses the
  nested-helper allocations (same validation-prompt condition 2 miss). Verify the returned
  cleanup clears every `timer`/`reopen` id set anywhere in the effect before suppressing a
  `setTimeout` case; a bare `setTimeout` in the effect body with no matching clear is real.

- `react-doctor/no-pass-live-state-to-parent` — store-browser.tsx GitHub-import effect:
  `dispatchGh({ type: "err", err: d.error })`. `dispatchGh` is a `useReducer` dispatch
  surfaced through the `useStoreOps` hook (NOT a parent callback prop), and its argument
  `d.error` is `ghFetcher.data` (a fetcher result), NOT this component's own state — so
  the rule's "lift state up" refactor is inapplicable. Guarded once-per-result by
  `useFetcherResult(ghFetcher, …)`, the shared form of the fetcher-result idiom above.
  Verify the called function is a reducer dispatch / hook setter and the argument is
  fetcher data, not local `useState`.

- `react-doctor/no-unsafe-json-parse` — `JSON.parse(row.*_json)` / `JSON.parse(
  project.*_json)` read straight off the app's OWN SQLite projection columns
  (rebuilder.server.ts `stages_json`, task.server.ts `reviewers_json`, and siblings).
  These columns are written by this app's projector from already-Zod-validated task files,
  so the rule's untrusted/malformed-input premise doesn't hold; a throw here would mean
  the local projection DB is itself corrupt (fail-loud is acceptable, and a rescan
  rebuilds it). Verify the parsed string is a `*_json` projection/cache COLUMN, not a
  request body, external API response, or file the user can hand-edit — those must be
  wrapped and shape-checked.

## Deliberate deferrals (real findings, suppressed by product/design decision)

The canonical UI design is frozen; a11y fixes must be markup-additive. These need a
design-system or cross-file decision — revisit deliberately, not per lint run.

- `react-doctor/label-has-associated-control` — create-profile-modal `<label>`s that
  caption button-chip groups (backend / autonomy / stages / capability / resources):
  no labelable form control exists; the proper fix replaces the `<label>` element
  with a `role="group"` wrapper (markup restructure).

- `react-doctor/no-tiny-text` — timeline.tsx 0.72rem stamp: fix is a visible
  font-size change; needs a design-language decision.

- `react-doctor/no-reset-all-state-on-prop-change` / `no-adjust-state-on-prop-change`
  — profile-page password form post-success reset: cleared controlled inputs are not
  derivable and no loader-data discriminator exists for a key-remount without
  route-layer changes. Mitigated to a single reducer dispatch.

- `react-doctor/no-pass-data-to-parent` — timeline.tsx comment-posted callback: the
  canonical fix lifts the fetcher to the parent route (cross-file data-flow change);
  current callback is a once-per-success event notification.
