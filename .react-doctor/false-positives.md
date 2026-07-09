# react-doctor false positives & deliberate suppressions

Consumed by the /doctor triage loop (step 2): diagnostics matching a pattern here are
dropped before fixing. Patterns that say "verify" require an actual Read/grep of the
flagged site before suppressing — never suppress on filename alone.

Scope note: `**/design/**` is excluded at the scanner level via react-doctor.config.json
(standalone mockup bundle with a `new Function()` module loader — not shipped app code).

## Verified false positives

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
  agents-page/create-profile-modal chip rows) and module-init constants built once
  (capability-catalog.ts). Verify the array is stages or a hardcoded catalog.

- `react-doctor/async-await-in-loop` — loops whose iterations are ordered, dependent
  mutations: the operator decision-plan executor (operator-run.server.ts — the plan
  schema says actions run in order) and scope-violation resolution
  (pat-validator.server.ts — read-modify-write of the same task.md across
  iterations). Verify the dependency before suppressing; independent loops should
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
