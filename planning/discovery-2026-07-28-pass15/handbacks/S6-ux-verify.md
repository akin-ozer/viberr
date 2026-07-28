# S6-ux — adversarial verification

Branch `pass15/product-fixes`, verified 2026-07-29 against the working tree (73 files /
5002 insertions — the tree was restored byte-for-byte after every revert experiment).

## Gates

| gate | result |
|---|---|
| `npm run typecheck` (`react-router typegen && tsc`) | clean, no output |
| `npx vitest run` (whole repo, all streams) | **205 files / 2369 tests passed** |
| S6-owned test files run in isolation (13 files) | 180 tests passed |

## Method

For every claim with a source-side fix, the source file was reverted to `HEAD` with the
NEW test left in place, the suite re-run, and the file restored from a byte-copy. A claim
is CONFIRMED only when the named test actually fails against the old code.

## Per-claim verdicts

### R15-4 members-only projects — **CONFIRMED (fix), ruling NOT fully met**

`app/routes/project.tsx:62-76` gates on `raw.members.find(...)` before any viewer-scoped
projection work and throws the byte-identical `No project at projects/${slug}.` 404.
Revert experiment: `workspace-routes.server.test.ts` → 2 failures
(`a non-member org member gets the unknown-slug 404, not a 403`,
`the task-detail surface is refused too`). Org-admin override preserved
(`orgAdminOverride`, `myRole: "admin"`).

Residue is real and is the ruling itself. Ruling D/R15-4 reads "FR4's app-wide commenting
applies **within projects the user can see**". `app/shared/rbac.ts:48-49` still marks
`view`/`comment` `appWide: true`; `app/routes/project.task.tsx:298` routes `comment` →
`commentToAgent` with no membership check, and
`app/features/task-detail/task-detail-route.server.test.ts:255`
(`non-members may comment app-wide and project as guests`) still passes green, i.e. the
OLD rule is pinned by a green test. A non-member who learns a task URL can still write
into a project whose existence R15-4 says must be secret. HB-1 is accurate; the ledger row
should read PARTIAL, not DONE.

Adjacent surfaces were checked and are already gated:
`resources.run-log.ts:69`, `resources.session-export.ts:44` (`requireProjectMember`),
`resources.events.ts:114-134` (membership-filtered scopes). No new leak there.

### R15-5 global ⌘K palette — **CONFIRMED**

`command-search.server.ts` scopes through `listHomeProjectsForUser`
(`home-query.server.ts:97-131`, membership filter + org-admin passthrough); the non-member
assertions in `command-search.server.test.ts:93-107` are real (`[]` for both a task key
and a project name). LIKE escaping is correct (`likeTerm` + `ESCAPE '\'`).
`command-palette.test.tsx` drives grouping / ArrowDown / Enter through a real
`createRoutesStub` navigation. Revert experiments: `shell-components.test.tsx` and
`home-page.test.tsx` R15-5 blocks fail on the old topbar/home.

Two nits: the ledger claims `%`/`_` are covered — only `%` is asserted
(`command-search.server.test.ts:118`). And `command-palette.tsx:52` compares
`payload.q === query.trim().slice(0,120)` while `resources.search.ts:20` echoes the
**unsliced** `q`, so a >120-char query renders permanently empty. Cosmetic.

### F15-04 land in the new project — **CONFIRMED**
`home-page.tsx:729-736`. Revert → `navigates to the new project's board instead of the
home grid` fails.

### F15-18 mobile rail — **CONFIRMED (unit), e2e UNPROVEN here**
`project.tsx:156-190` + `topbar.tsx:80-92` + `app.css:2534-2578`. Unit revert →
`reports the rail's open state to assistive tech` fails. The Playwright assertions
(off-canvas box, `scrollWidth − clientWidth ≤ 1`) were not executed in this pass (no
server); `.board` carries its own `overflow-x: auto` (`app.css:564`) and `.app` drops to
one column, so the no-sideways-scroll claim is plausible but unverified.

### F15-08 one timezone story — **UNPROVEN**
Two independent problems, both worse than HB-2 states. See gap 2 below.

### F15-09 duplicate agent badge — **CONFIRMED**
`board-page.tsx:182-190` / `438-444`. Revert → 2 failures.

### F15-16 residue — **CONFIRMED**
`board-filters.ts:93-116` (`profileId` joins the haystack, `normalizeIdentity` folds
`-`/`_`); `AgentRender.profileId` is genuinely populated
(`app/shared/mapping/task.server.ts:63-69,194-203`), so the fix works at runtime, not just
in the type. Revert → `matches an assigned/engaged agent by its profile name` and
`renders a board-scoped field that writes ?q=` fail. Note the match key is the deployment
**id**, not the display name — a profile whose id is unrelated to its name still won't
match. Harmless now that the placeholder says `Filter this board…`.

### B-FD4 home Settings tiles — **CONFIRMED**
`_index.tsx:61` (`storeRoot` null for non-admins — loader-side, and it is the only
consumer) + `home-page.tsx:1251-1281` (`OrgTile`). Revert → 2 failures.

### UC-13 engagement label — **CONFIRMED**
`execution-profile.tsx:50-65` — only downgrades on `capabilities?.verdict === false`, so
missing data keeps the review framing. Revert → all 4 label tests fail.

### Stage editor name-first — **CONFIRMED**
`settings-actions.server.ts:408-427` (trimmed name, `AppError.validation` on empty) +
`project.settings.tsx:83-89`. Revert → 2 action tests + 4 route tests fail.

### Copy nits — **CONFIRMED**
`resources-panel.tsx:914-935`, `org-settings-page.tsx:37-51`. Revert → 3 failures.

---

## The 3 most dangerous gaps

### 1. R15-4 is half-enforced: a non-member can still write into a secret project
The loader refuses reads, but React Router runs a child route's **action** without its
parent's loader — so `POST /projects/<slug>/tasks/<key>` with `intent=comment` reaches
`commentToAgent` for any authenticated user
(`app/routes/project.task.tsx:298`; `app/shared/rbac.ts:48-49`). The ruling explicitly
scopes app-wide commenting to "projects the user can see", so this is ruling
non-compliance, not polish — and worse than a plain leak, because a comment can
`@mention` an agent and (for the right role) trigger a run inside a project the actor is
not supposed to know exists. `task-detail-route.server.test.ts:255` currently *pins the
old rule green*, so nothing on the branch will ever flag it. Fix must land with that test
inverted.

### 2. F15-08's only test is vacuous in CI, and the wiring has zero coverage
Proven twice:
- Stubbing `localLogClock` to `return t` (the exact old behavior) and running
  `TZ=UTC npx vitest run app/features/runtime/log-clock.test.ts` → **4/4 pass**. The same
  no-op under `TZ=Europe/Istanbul` → 3 failures. `.github/workflows/ci.yml` sets no `TZ`,
  and GitHub runners are UTC, so this suite green-lights a no-op in CI forever.
- Reverting the wiring (`runs-panels.tsx:583-587`, the one line that actually renders the
  fix) and running all of `app/features/runtime/` → **7 files / 55 tests still pass**.
  Nothing binds the component to the helper.

Also, the anchoring heuristic is more fragile than HB-2 admits: any line logged more than
12 h after `startedAt` snaps to the wrong calendar day
(`localLogClock("17:00:00", "2026-07-28T02:00:00Z")` anchors to 2026-07-27). The rendered
`HH:MM:SS` only diverges across a DST edge, so the user-visible blast radius stays what
HB-2 says — but it widens the DST window to any long run. Needs: a `TZ`-pinned test (or a
fixed non-UTC zone in the vitest config), one render assertion in `runs-panels.test.tsx`,
and HB-2 restated to include the >12 h case.

### 3. On Home the palette has no pointer affordance below 1080px — and none at all below 900px
R15-5 made Home's shortcut chip the *only* clickable way in
(`home-page.tsx:913-925`, `onOpenPalette` is wired to nothing else). But
`app.css:2514` sets `.kbd { display: none; }` at `max-width: 1080px`, and
`app.css:3248` sets `.home-top .top-search { display: none; }` at `max-width: 900px`.
So: 901–1080px → Home shows the finder box with the palette button hidden; ≤900px → the
whole box, finder included, is gone. Combined with F15-18's mobile work (which correctly
keeps the workspace `.top-search` button visible at 375px), the result is that a phone or
tablet user on Home has **no way to reach the global search at all** — ⌘K is the only
route and touch devices have no ⌘K. This one is undisclosed; it lands squarely between
the two S6 claims and should not ship as-is.

## Lesser notes
- `e2e/08-palette-mobile.spec.ts:63-76` admits its R15-4 case drives a nonexistent slug
  because the e2e session is an org admin. It proves the copy, not the non-member refusal;
  the real proof is the vitest case.
- `.rail-scrim` is a `<button aria-hidden="true" tabIndex={-1}>` (`project.tsx:180-188`) —
  functional, but a `div` with a click handler or an explicit dismiss label would survive
  an a11y lint pass better.
- `searchWorkspace` calls `listDeployedSpecialists` (a project.md read) once per visible
  project per debounced keystroke; for an org admin with many projects that is a disk read
  fan-out on the search path. No correctness impact.
