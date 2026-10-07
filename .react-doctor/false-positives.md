# react-doctor false positives & deliberate suppressions

Read when triaging a react-doctor scan (`npx react-doctor`, configured by
`doctor.config.ts`): diagnostics matching a pattern here are dropped before fixing. Patterns that say "verify" require an actual Read/grep of the
flagged site before suppressing — never suppress on filename alone. Each rule's page at
`https://react.doctor/docs/rules/react-doctor/<rule>` (ask for `Accept: text/markdown`)
carries the validation prompt that decides confirm vs. reject; read it first. Every entry
below was re-verified against react-doctor 0.9.17; line numbers drift, the shapes do not.

Scope note: `doctor.config.ts` excludes `**/.claude/**`, `**/data/**`,
`**/*.server.test.ts`, `**/tools/oxlint/**` and `**/test-support/**` at the scanner level —
none of them are shipped app code. The first three are checkouts or fixtures of this same
repo (agent worktrees, the gitignored VIBERR_DATA_ROOT, server-only test files), and
scanning them double-counts every finding against stale copies. Because of the first, a
scan run from inside an agent worktree under `.claude/` sees no files at all.

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

### State, effects and refs

- `react-doctor/no-derived-useState` — `useState(prop)` initializers in a component
  whose render site keys it on those same props (reset-by-remount pattern), e.g.
  ProjectPanel in app/features/project-settings/settings-page.tsx. Verify the `key=`
  exists at the render site; the rule cannot see it.

- `react-doctor/no-derived-useState` — editor drafts that mount once per open: task-details
  -panel.tsx LabelsEditor and WaitEditor render inside PropRow's `{open && … editor(done)}`,
  and ControllerAdminPanel (`model` / `effort` / `definition`) only under
  `tab === "controller"` in org-settings-page.tsx. Re-syncing mid-edit would overwrite the
  typing; after Save the revalidated prop equals the draft. Verify the conditional mount at
  the render site and that the state is a draft posted on Save.

- `react-doctor/no-derived-useState` — capture-once optimistic/uncontrolled state:
  a local copy seeded from a prop that the user then mutates ahead of the server
  (profile-page.tsx notification/theme toggles `ntf`/`tl`/`mo`; timeline-actions.ts
  `useTimelineTab`'s `tlDefault` filter tabs). Deriving from the prop would lag the UI a
  round-trip.

- `react-doctor/no-derived-state` — state seeded from loader props but appended to by
  a second setter with data that exists only client-side (use-run-log-stream.ts
  `linesByThread`, fed by SSE tail fetches), or an intentional
  reset-on-external-URL-change synchronizer that must tolerate in-flight keystrokes
  (topbar.tsx `query`). Verify the second setter callsite exists. Also transcript-follow.ts
  `said`: the last announcement, kept across renders that say nothing new and set on the
  `working` false→true edge a ref tracks; a `role=status` sentence must persist, so it
  cannot be computed from the current inputs. Verify the setter does not run on every
  input change.

- `react-doctor/no-adjust-state-on-prop-change` / `no-event-handler` /
  `no-cascading-set-state` / `no-chain-state-updates` / `no-pass-data-to-parent` /
  `no-pass-live-state-to-parent` — effects that sync with an
  async react-router **fetcher** result (`fetcher.state === "idle" && fetcher.data`):
  the success signal only exists after the round-trip, so no click handler can host
  the work (agents-page.tsx handled-result effect; profile-page.tsx password-form
  post-success reset; timeline-actions.ts draft reset after submit; create-profile-modal
  catalog load/defaults). The same shape arrives three other ways: a hook handed the
  caller's OWN setters that seeds defaults when its fetcher answers (create-profile-modal
  `useModelCatalog(backend, model, setModel, effort, setEffort)`, which also fires the two
  pass-to-parent rules), fetcher data passed down as a prop and settled once by a ref,
  only for a change the panel itself sent (settings-page.tsx
  `changeResult={repoFetcher.data}`), and fetcher data read in place
  (controller-dock.tsx `staleSelection` off the dock-view fetcher). Verify the trigger is
  `fetcher.data` or a value computed from it, not a plain loader prop.

- `react-doctor/no-adjust-state-on-prop-change` — imperative event counters from the
  parent, applied once per bump through a "seen" ref: timeline-actions.ts `ask`
  (`useCommentPost`: bump → prefill + focus) and task-main-sections.tsx `editGoalSignal`
  (`seenEditGoal`). Not duplicated prop state. Verify the once-per-bump ref. The same
  shape keyed on the navigation: timeline-actions.ts's ruling 497 step (`useTimelineTab`'s
  `steppedFor`, the `location.key` of the link that named an event) opens All once when
  the tab hides the event. Verify `steppedFor` is set whenever the target is found, not
  only when the step changes the tab (the "all" row of timeline-target.test.tsx).

- `react-doctor/no-reset-all-state-on-prop-change` / `no-adjust-state-on-prop-change` —
  decision-packet-actions.ts `usePacketChoice` (DecisionPacket's choice, ruling 689(e))
  `seededFrom`: when a replacement packet arrives with a new `id` (F10-09), the card re-seeds its own choice, note, repository answer, directive,
  refusal count and open ask-first step during render, guarded on `p.id !== seededFrom`,
  through the same `initialChoice` / `initialRepository` helpers its useState calls use.
  The rule's fix, `key={packet.id}` at the render site, is wrong here: the card renders the
  page's `completion` slot (CompletionPacket → the inline ChangesPanel → ChangesBody) inside
  its own subtree, so a remount would discard the reader's unsent line notes and open
  draft, close the reader and read GitHub again (rulings 484(b), 521(d)), and unmount the
  control that held focus. A packet written before ids has none and never re-seeds. Verify
  `{completion}` still renders inside the card, the re-seed is still guarded on the id, and
  the F10-09 rows in task-disposition.test.tsx still cover each re-seeded field.

- `react-doctor/no-adjust-state-on-prop-change` — toast.tsx `regionReady`: a deliberate
  two-commit live region (UI-34) that joins the top layer empty and fills in a second
  commit so screen readers announce it, paired with `showPopover`/`hidePopover`. Verify the
  ToastHost comment still requires the empty region to commit first.

- `react-doctor/no-effect-chain` — stage-menu.tsx: the layout effect measures the menu the
  same commit mounted (`offsetHeight`, in a portal) to choose a side before paint, which no
  click handler can do; the effect after it moves focus. Verify the first effect reads the
  layout of a node mounted in the same commit.

- `react-doctor/rerender-functional-setstate` — stage-menu.tsx `setPos({ ...pos, … })`
  directly in a `useLayoutEffect` that lists `pos`: it runs right after the commit that
  produced this `pos`, one branch per run, so an updater would read the same value.
  Verify the call is in the effect body (not a callback or timer) and the state is a dep.

- `react-doctor/rerender-state-only-in-handlers` — resources-panel-actions.ts
  `pendingSkillBrowse` / `pendingKbBrowse`: "pending until the revalidated list has it"
  state that sits in an effect's dependency array (`[skills, pendingSkillBrowse]`), so
  setting it is what wakes the effect; a ref would not. Verify the dependency array.

- `react-doctor/rerender-lazy-ref-init` — use-live-updates.ts `useRef(Symbol("live-stream"))`:
  a constant-cost identity token, the rule's own cheap-call exception. Verify the argument
  is not a construction whose cost grows with its input.

- `react-doctor/exhaustive-deps` — use-run-log-stream.ts lists `streamKey`, the primitive
  spelling of every `RunLogSource` field `frameFor` reads, instead of `source`, which both
  callers pass as a fresh literal (listing it would resubscribe every render). Verify the
  key still encodes every field the effect reads.

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

- `react-doctor/effect-needs-cleanup` — registrations inside a handler or helper the effect
  defines (validation-prompt conditions 1 and 2; all three are ERRORS):
  attention-watcher.tsx (the `schedule()` helper's timer lives in a mutable `timer` the
  teardown clears, and `stopped` blocks a reschedule), use-sheet-drag.ts (pointer
  listeners added in the `pointerdown` handler and released by `detach.current`, which the
  teardown and the close layout effect call) and label-input.tsx (press-end listeners
  added in the `mousedown` handler that remove themselves on the first press end; they
  deliberately outlive a `shifts` flip so the held height is let go). Verify the
  registration is inside a nested function AND either the teardown releases it (directly
  or through a ref'd detach/clear) or it removes itself on its first fire.

- `react-doctor/no-unguarded-browser-global-in-render-or-hook-init` — root.tsx `htmlTheme`
  and use-dialog.ts `opener` read `document` in a `useState` initializer behind
  `"document" in globalThis` (the repo bans `typeof` guards; the rule only recognises
  `typeof` or effect placement). All three are ERRORS. Verify the `in` test guards the same
  expression that reads `document`.

### Lists and keys

- `react-doctor/no-array-index-as-key` — rows with no per-item identity that never
  reorder or filter: append-only log consoles (runs-panels StreamedLine), immutable
  packet observation/evidence lists (decision-packet, timeline evidence, evidence-list
  rows of one event in a deterministic status sort), and console-blocks TodoCard (an immutable snapshot per console line; Codex's `todo_list` is
  projected only when completed). For decision-packet options, index-based selection is
  documented design: the decision records `decided.optionIndex` (ruling 138), and `kind`
  (ruling 7) is non-unique. Verify the list is append-only or fixed-per-mount.

- `react-doctor/no-array-index-as-key` — positional parts of ONE immutable value, where
  position is the identity and parts repeat: tokens of a `.split()` or capturing regex
  (evidence-list EvidenceLabel / Result, task-side-panels `holdSentenceKeepingLabels`),
  path segments (store-browser breadcrumb), the rows of one parsed diff (changes-panel
  DiffLines: notes anchor on `start.row`/`end.row`; console-blocks EditDiffBlock, shown as
  a prefix `slice(0, shown)` with `unfolded` keyed by the same index), and the cells of a
  fixed column schema (insights cache table `<th>`/`<td>`, hook-free). Verify the array is
  computed from one string/patch/column list (or a prefix slice of it) and any per-row
  state is keyed by that same index.

### Performance

- `react-doctor/js-set-map-lookups` / `js-combine-iterations` — `.includes()` or
  chained passes over bounded tiny arrays: project workflow stages (3–5 items,
  agents-page/create-profile-modal chip rows, controller-toolkit, operator-moves stage
  walk, settings-actions per-rule lookups), module-init constants built
  once (capability-catalog.ts), the per-reviewer-row `activeReviewerIds.includes()` in
  execution-profile.tsx and agent-select.tsx (bounded by reviewers actively running on ONE
  task — well under the rule's ~10-item threshold), and lists capped by a constant: one
  message's or comment's files (ATTACHMENT_BATCH_MAX = 10: controller-dock,
  controller-page, timeline-actions), event attachments (EVENT_ATTACHMENTS_MAX = 20,
  task-file.schema.ts), one MCP server's saved write tools (MCP_WRITE_TOOLS_MAX = 200:
  resources.server.ts `sameNameSet`, both sides saved or checked), the `Fact` union (5
  members, revalidation-policy `overlaps`), `codexVendor().pathDirs` (0 or 1), and
  order-keeping de-duplication of one profile's grant list (`kbDirsOf`, `resolveOne`,
  `nextList`, `difference`). Two more are small in practice, not by a constant. The MCP
  editor's write-tool chips (mcp-modal-fields `marked.includes(tool)` in each chip's class
  and `aria-pressed`) scan one server's own tools: the discovered `tools/list` names (no
  cap), the saved write tools and names typed in. `marked` starts as the discovery
  suggestion on a server nobody has reviewed, and MCP_WRITE_TOOLS_MAX caps it only on
  save (`checkedWriteTools`, whose own de-duplication runs before that check, over the
  admin's submission for that one server). Two scans per chip cost less than rendering
  the chips; if revisited, one `new Set(marked)` above the map, and only with a
  measurement. The org's GitHub connections, one chip per owner (boards-panel `owners`):
  each is a PAT an admin pasted, checked against GitHub behind the per-actor
  `patValidationThrottle` (connections.server.ts); no constant caps them, but they stay
  a handful, on a settings panel. Verify the array is stages, a hardcoded catalog, one
  task's/run's/profile's/MCP server's own list, the org's GitHub connections, or capped
  by a named constant.

- `react-doctor/js-set-map-lookups` — the live ledger's settle filter
  (revalidation-policy.ts `!due.includes(o)` in `flushLive`): both lists are the data
  events of one 300 ms debounce window (console lines record none) and `prune()` drops
  covered obligations at every flush. The ledger is in the root route's closure, and a
  `Set` there cost 4 gzip bytes on every route against the bundle ratchet (ruling 457)
  for no measurable gain.

- `react-doctor/js-set-map-lookups` — not an array scan at all: the receiver is a string
  (`.includes` is a substring search; kb-corrections.server.ts `looseText()` /
  `asDocText()`), a fresh array built from the loop variable with one lookup per
  iteration (gagents `deployedProfileIds(row.…)`, resource-references per-profile
  `resources[kind]`, mention-notify `fullNameKeys(u.name)`, operator-moves
  `o.newTask?.blockedBy`), or code that runs once despite sitting in the loop's source (a
  `.find()` as the `for…of` iterable, agents-page `resourceCatalog?.find(...)`; an
  `.includes()` in a per-chip `onClick` updater, mcp-modal-fields). Verify the receiver's
  type, or that it is the loop variable's own, or where the call actually runs.

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

- `react-doctor/js-hoist-intl` — time-zone.ts `normalizeTimeZone`: constructing
  `Intl.DateTimeFormat` with the caller's `timeZone` IS the validation (it throws on an
  unknown zone), so it cannot be hoisted. Verify the varying option is the argument being
  checked and the result is read inside a try/catch.

- `react-doctor/async-await-in-loop` / `server-sequential-independent-await` /
  `async-parallel` — the governed writers do no async I/O: `withFileLock`
  (file-mutex.server.ts) is `navigator.locks.request(key, () => Promise.resolve().then(fn))`
  and `fn` in `updateTaskFile` / `updateProjectFile` / `updateEpicFile` /
  `appendTimelineEvent` is synchronous fs plus `node:sqlite`. A loop whose awaits bottom
  out there (or in the `append*` / `resolveScopeViolationWithEvent` wrappers over them)
  overlaps nothing under `Promise.all` and only reorders audit, timeline and notification
  rows. Verify no `fetch`, `exec` or spawn anywhere in the iteration. The same holds for
  repository-ask.server.ts's `resolvePacket` loop after a repository is connected: with
  `fanOutOrigin` set, the connect_repository arm returns (or refuses) before
  `changeProjectRepo`, its only GitHub call; the kind is in `NO_REQUEUE`, so no operator
  is re-invoked; and the fan-out is suppressed. The loop's in-order `answered` list feeds
  `carryOnAfterConnection` after it. Verify the arm still stops before
  `changeProjectRepo` when `fanOutOrigin` is set.

- `react-doctor/async-await-in-loop` — loops whose iterations are ordered, dependent
  mutations: the operator decision-plan executors (operator-run.server.ts and
  operator-codex-plan.server.ts — the plan schema says actions run in order, ruling 430
  `pausedBy`), scope-violation resolution (pat-validator.server.ts,
  github-reconciler.server.ts, task-delivery.server.ts — read-modify-write of the same
  task.md across iterations), boot orphan-run recovery
  (run-recovery.server.ts — serial `applyAgentCompletionEffects` / operator re-invokes,
  deliberately avoiding an operator stampede at startup), and the schedule-tick claim/
  finalize loops (schedule.server.ts — each occurrence read-modify-writes its task.md via
  `updateTaskFile`). The same holds for stop-at-first-failure
  contracts (board-import `step()`, epic-archive's `try/finally`, template-propagation's
  stale-fingerprint throw), one-shot boot migrations (goal-epic-conversion,
  evidence-result-restore, review-entry-conversion), and GitHub per-token or poller-tick
  loops (connections.server.ts per ruling 540, reconcile-poller's per-project budget,
  repo-health, github-reconciler's sibling PRs, pr-review-relay). Verify the dependency
  before suppressing; independent loops should still be parallelized.

- `react-doctor/async-await-in-loop` — loops of agent, operator or controller starts
  (`startAgentRun`, `releaseTask`, `autoInvokeOperator`, and controller-continuation.server.ts
  `maybeContinueController`, whose follow-ups each start a turn, write an audit row and may
  note the same task.md, one failure never holding back the next by ruling 685), kept serial. Not for the concurrent-run cap:
  `reserveRun` / `admitRun` (run-service.server.ts) check and take or park a slot with no
  await between, and a start resolves once its run is launched or parked, so a serial loop
  neither enforces the cap nor bounds the turns that then run. Nor for ruling 241: its
  drain-then-operator order lives inside one release (`announceRelease`). What each start
  does await is its setup: the workspace clone, whose mirror work already queues on the
  project's mirror lock, and the stdio-MCP pre-flight (`verifyStdioMcpMountsForRun`),
  which spawns each mounted stdio server and, on a failure, writes the shared health row
  and drops the server from the run. Parallel starts would probe the same org stdio
  servers at once (every operator in a project mounts the same ones; reviewers do when
  granted the same), the contention ruling 689(b) bounds within one run to two
  handshakes at a time. Per loop: dependencies.server.ts `drainQueuedQuestions` must stay serial regardless.
  Queued questions can name the same reviewer twice; a supporting run's `cloneRepo`
  removes and re-clones its `workspace/support/<profileId>` checkout; `dispatchAgentRun`'s
  same-engagement check reads run rows before its awaits; and
  `idx_agent_runs__one_live_per_support` refuses only at a row write, which `reserveRun`
  skips when the cap is full. A parallel duplicate would re-clone under the first run
  before `startRun` refuses it, where serially the check refuses it first ("Queued
  question not put"). `releaseDependents` and the dependency runner's per-project tick
  (`releaseDueDependents`): each release awaits its operator's start. The tick is ruling
  131(e)'s once-a-minute backstop, never overlapped (`running`); the task-write hooks
  (`maybeReleaseDependents`) are the live release path, and `releaseTask` re-checks the
  wait under the lock, so a late sweep loses nothing. One project's slow start (a first
  clone can take minutes) holds later projects' backstop releases for as long as it
  runs, not one tick. stranded-sweep.server.ts: a background pass on the schedule tick,
  and its note-first idempotence key is per task, so order changes nothing.
  task-acceptance.server.ts `refreshAndReview`: the reviewers are distinct profiles, so
  single-flight never orders them, but the person's click waits through each start in
  turn (one per reviewer with a standing verdict, unmeasured); revisit with the
  pre-flight's concurrency bound. Verify each loop body still awaits a start, and for
  `drainQueuedQuestions` that queued questions are still not de-duplicated by profile.

- `react-doctor/server-sequential-independent-await` / `async-parallel` — awaits of cached
  dynamic `import("~/…")` that break import cycles (controller-toolkit, run-recovery,
  dependencies, schedule, specialist-run, reconcile-poller): the modules are already
  loaded, so there is nothing to overlap. Verify every flagged await is an `import()`.

### Security

- `react-doctor/no-secrets-in-client-code` — fabricated test-fixture PATs in
  server-only test files. Verify the path matches `*.server.test.ts` and the value is
  synthetic (e.g. `github_pat_11FINE…`).

- `react-doctor/clickjacking-redirect-risk` — login.tsx `returnTo`: validated by
  `safeReturnTo()` (same-origin relative path; strips tab/CR/LF, refuses `//` and `/\`)
  before `redirect()`. Verify the helper is still applied.

- `react-doctor/git-provider-url-injection-risk` — specialist-run.server.ts and
  specialist-prompt.server.ts (`buildAnalyzePrompt`'s clone line): internal owner/repo slug
  from project frontmatter interpolated into agent prompt text, not an outgoing request
  URL. Verify the template is prompt prose, not a `fetch`/`git` argument the server runs.

- `react-doctor/request-body-mass-assignment` — mcp-proxy/gateway.server.ts
  `{ ...request.params, _meta: upstreamMeta(...) }`: the `tools/call` pass-through of ruling
  461(d). The SDK has already parsed `request.params` with `CallToolRequestSchema` (unknown
  keys stripped), the one server-set field `_meta` comes after the spread, the withheld
  check and write audit key on the same `params.name`, and the upstream credential rides
  the transport, never the params. Verify all four; a request body spread into a DB row or
  a governed file is NOT covered.

- `react-doctor/path-traversal-risk` — specialist-browser-mcp.server.ts: `req` is
  `createRequire(import.meta.url)`, not an HTTP request, and its argument is a literal
  module specifier. Verify the binding.

- `react-doctor/tenant-static-proxy-risk` — operator-run.server.ts: a `path.join` that only
  formats an error sentence, beside a `workspace` that is the server's own
  `{ projectSlug, taskKey, dataRoot }` from a `TaskFileRef`. Nothing is fetched or served.

- `react-doctor/no-unsafe-json-parse` — `JSON.parse(row.*_json)` / `JSON.parse(
  project.*_json)` read straight off the app's OWN SQLite projection columns
  (rebuilder.server.ts `stages_json`, task.server.ts `reviewers_json`, and siblings),
  or JSON SQLite computes in the same SELECT over an app-owned NOT NULL column
  (rebuilder.server.ts `json_group_array(user_id) AS member_ids`).
  These columns are written by this app's projector from already-Zod-validated task files,
  so the rule's untrusted/malformed-input premise doesn't hold; a throw here would mean
  the local projection DB is itself corrupt (fail-loud is acceptable, and a rescan
  rebuilds it). Verify the parsed string is a `*_json` projection/cache COLUMN or a
  `json_*` expression in the same query, not a request body, external API response, or
  file the user can hand-edit — those must be wrapped and shape-checked.

### Accessibility

- `react-doctor/no-autofocus` — `autoFocus` on the first field of a just-opened
  modal/dialog (resources-panel KB/MCP/Skill/Agent modals; sso-panel ProviderModal inside
  `MiniModal`, a `useDialog` `<dialog>` the detector cannot see through). Deliberate,
  correct dialog focus management (ruling 455(e)). Page-load autofocus is NOT covered by
  this pattern — fix those.

- `react-doctor/role-has-required-aria-props` — comment-composer-slot.tsx stand-in
  `role="combobox"` without `aria-controls` (an ERROR): it mirrors the real editor, which
  sets `aria-controls` only while its mention menu is open (that menu renders nothing
  closed, and its id is random per mount, so a server-rendered stand-in cannot know it).
  axe exempts a closed combobox. Verify `aria-expanded` is literally `false` and the editor
  still renders `aria-controls={menu.open ? … : undefined}`; a combobox that can expand
  without it is real.

- `react-doctor/click-events-have-key-events` / `no-static-element-interactions` —
  notifications-page.tsx stream row: its click is a mouse shortcut for the row's own
  "Mark read" `<button>` (same `n.unread` condition, same `onRead(n.id)`); UI-54 removed
  `role="button"` because it nested real buttons. Verify the inner button is still there.

- `react-doctor/no-static-element-interactions` — the `.label-input` chip-field wrapper
  (label-input.tsx, dependency-picker.tsx) whose `onMouseDown` only sends a press on a chip
  or the gap to the inner combobox input. Verify the handler only prevents default and
  focuses the input (keyboard users Tab to the input; its `onFocus` opens the list).

- `react-doctor/prefer-html-dialog` — the controller dock panel: non-modal by ruling 121.
  Verify `aria-modal="false"` and no scrim, focus trap or scroll lock.

- `react-doctor/no-img-without-dimensions` (`react-doctor design`) — thumbnails filling a
  CSS-fixed box: `.attach-thumb img` (100% × 120px), `.tl-attach-thumb img` (100% × 150px),
  `.att-chip-media img` (24 × 24, `overflow: hidden`). Verify the class rule fixes both
  dimensions; an image with `height: auto` in a flexible box is real.

## True to the letter, no change (no user-visible effect)

- `react-doctor/only-export-components` — a component file whose non-component export IS
  the module's reason to exist, where moving it costs more than a dev-only full reload:
  app/ui/icon.tsx `storeIcon` (checks `name in ICON_PATHS`, the private table that
  `app.css.test.ts` reads from this file's source and `vite-config.test.ts` pins into the
  shell chunk), app/ui/pill.tsx `readinessLabel` / `validationLabel` / `validationQuiet`
  (lookups into ruling 1's one vocabulary table, `READINESS_BY_VALUE` /
  `VALIDATION_BY_VALUE`, that the pills render from), app/ui/markdown.tsx
  `sameMarkdownProps` (`Markdown`'s own `memo` comparator, measured by
  `markdown.perf.test.ts`), and controller/controller-examples.tsx (rulings 419(g) and 516
  keep the examples and `ControllerExampleList` in one module). Every other flagged export
  lives in a sibling `.ts` module (the `initials.ts` / `avatar.tsx` pattern). Verify each
  still reads the private table or is still that `memo`'s comparator.

- `react-doctor/rerender-memo-with-default-value` — `= []`/`= {}` prop defaults, each for
  its own reason. task-detail-page.tsx: the one route always supplies a never-`undefined`
  loader field, so the default fires only in bare test renders, and every memoised
  consumer stabilises the value by content first (`useStableValue`, ruling 457(c)) because
  each revalidation decodes new objects anyway; verify the route's prop and that consumers
  stabilise before memo/deps. board-page.tsx `epics`: the one route passes
  `loaderData.epics` (`listEpicChips`, a parsed array, never `undefined`), so the default
  fires only in bare test renders; the one memo, `openEpics`, keys on the loader's
  identity, which holds between revalidations and is new on each one regardless, and
  FilterBar and NewTaskModal are not memoised. Verify the route still passes the loader
  field and no other memo, deps array or `memo()` consumer of `epics` has appeared.
  controller-page.tsx `examples`: `Transcript` is private and not memoised. Its
  open-conversation call site passes no `examples`, so the default fires there, but
  only the `!view.conversation` empty state reads it; the empty-transcript call site
  passes a fresh `controllerExamples(...)` array every render anyway, to
  `ControllerExampleList`, which is not memoised either, so nothing compares its
  identity. Verify both components are still unmemoised and `examples` is in no deps
  array.

- `react-doctor/no-array-index-as-key` — settings-page.tsx draft rows (required reviewers,
  file leases, gates): every control is controlled from `draft[i]` and `remove(i)` filters
  by the same index, rows have no identity of their own (two new rows are equal), and a
  minted key would move focus from the pressed Remove to `<body>`.

- `react-doctor/prefer-tag-over-role` — `role="list"` kept where a native list would be
  worse: lists with no markers (insights `.daily-chart`, console TodoCard; WebKit/VoiceOver
  drop `<ul>` semantics without them), lists whose role is set only when they hold items
  and that hold non-item children (board `.col-body`, `.board-list`, D19), and lists inside
  phrasing-only content (the console `.lx` span). A `div role="separator"` in a
  `role="menu"` (`.menu-sep`) is the same markup as the user menu's Radix separator.

- `react-doctor/design-no-vague-button-label` — "Done" closing a view whose actions save
  as they happen (the store browser footer; the "Other accounts" section, ruling 616(b)'s
  own word). An open draft is NOT saved by it. Done, like the header X, unmounts the store
  browser with its open document, and a save still in flight then lands with nothing to
  show its result; Escape and the card's Cancel drop the document too. The accounts
  section's Done drops an open rename, and because the card keeps one `renaming` id it
  also closes a rename open on the account in use above the section. Whether any exit
  should ask before discarding a draft is the owner's call (none in the app does), and
  another label would change neither. Verify the button only closes the view.

- `react-doctor/js-hoist-intl` — `Intl.ListFormat` built once per request on cold paths
  (settings-actions remove-repo, board-import toast). If revisited, one shared `LIST_AND`
  should replace the per-file copies rather than adding another.

- `react-doctor/no-fetch-in-effect` — attention-watcher.tsx (a mount-once poll and
  subscription whose responses drive desktop-alert bookkeeping, serialised by
  `running`/`again`, dropped after unmount by `stopped`) and attachment-lightbox.tsx (a
  one-shot status probe guarded by `cancelled`, body cancelled at headers). The repo has
  no data-fetching library to move them to.

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

- `react-doctor/no-pass-data-to-parent` — timeline-actions.ts comment-posted callback
  (`useCommentPost`'s `onAgentLog`): the canonical fix lifts the fetcher to the parent
  route (cross-file data-flow change); the callback is a once-per-success event
  notification after the fetcher settles.

- `react-doctor/async-await-in-loop` — backend-credentials.server.ts `retireUserBackends`,
  run when an admin removes a person (`deleteOrgUser`): each account retires in turn, and
  each retirement is process I/O, the vendor logout (`execFile` as the person, up to
  LOGOUT_TIMEOUT_MS = 20 s) and the `removeAgentTree` steps. It is NOT a governed-writer
  loop (it fails that entry's no-exec check). A person with k login accounts waits up to
  k × 20 s when a vendor hangs. Nothing orders the accounts: each retires only its own
  files (ruling 507), the logout → files → row order stays inside `retireAccount`, and
  `activeAccountChanged` runs after the loop. Kept serial for the owner's call: a rare
  admin action over at most 2 × MAX_ACCOUNTS_PER_BACKEND rows, and concurrent vendor
  logouts sharing the person's agent `$HOME` and the launcher's backend-home hand-back
  are unmeasured. If parallelised, `Promise.all` over the per-account body, with the
  after-loop work unchanged.

- `react-doctor/js-index-maps` — board-import.server.ts: a `.find()` per row over lists
  read from the uploaded board.md (each required-reviewer rule's stage in `checkBoard`;
  each knowledge base's and skill's own row, by dir or name, in `planBoardImport`). Real
  O(n·m) shapes: on this path nothing caps those rows (CUSTOM_STAGE_MAX is the create
  path's, and BOARD_FILE_LIMITS bounds zip entries and bytes, not YAML rows), and the
  plan runs synchronously on every `board-import-preview`, so an admin previewing a
  crafted file blocks the event loop for seconds to minutes. A first-wins `Map` per site
  is not worth it alone: the same file reaches other quadratic passes
  (`realignChainToStages`' stages × workflow, the preview's `stageName`, `NameClaims`
  walking colliding names), and parsing a board.md near the size limits already takes
  minutes. What would close it is a row or byte cap on board.md, a format change to
  ruling 653's limits and file-formats.md §9 that needs the owner's ruling, starting
  with whether a hostile board file is in the threat model. Exports carry a handful of
  each.

- `react-doctor/no-high-complexity-react-function` / `no-giant-component` — the large
  surfaces (SettingsPage, DecisionPacket, Timeline, the agents and
  org-settings modals, and their siblings). Splitting them is a structural refactor per
  surface, best done with the e2e suite and the bundle ratchet beside it, not as a lint
  sweep. Ruling 689(d) piloted the recipe on TaskDetailPage, which no longer carries
  either finding: its posts became hooks that each own their fetcher, toast and confirm
  (`task-detail-actions.tsx`), what it reads off its props became pure functions
  (`task-detail-derive.ts`), and its regions became hook-free components that each take
  one slot of its markup (`task-detail-regions.tsx`, `task-main-column.tsx`), with the
  DOM, the hydration ids and the memoised children's props unchanged. Ruling 689(e) split
  BoardPage the same way (`board-page-actions.tsx`, `board-page-derive.ts`,
  `board-accept-confirm.tsx`, and the hook-free EmptyLane, NewTaskFoot and EpicFilter),
  and it no longer carries either finding. The rest wait on
  the owner's sign-off on that recipe.
