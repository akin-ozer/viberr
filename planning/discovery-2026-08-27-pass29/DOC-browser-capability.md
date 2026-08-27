# Browser capability (`use-browser`) — deep reference

Owner ruling **R19-19** (`docs/architecture/decisions.md`, ruling 75), shipped 2026-08-14. A
generic agent profile can be granted a real headless Chromium, driven through a viberr-owned
Playwright MCP server, per run. Screenshots/PDFs land in the task's `attachments/` directory,
are served through a member-only route, and are linkified as evidence in the timeline.

This doc is a file:line map of the whole subsystem, current as of this worktree
(`fix/pass28-findings`, 2026-08-27).

---

## 1. End-to-end flow

```
profile grants use-browser=direct + use-web-search-fetch=direct
        │
        ▼
runSpecialist() [specialist-run.server.ts:1425-1436]
  taskAttachmentsDir(slug, key, dataRoot)      → file-store-root.server.ts:87-93
  resolveBrowserMcp({grants, attachmentsDir, backend})  → specialist-browser-mcp.server.ts:101-150
        │  (gate 1: use-browser direct?  gate 2: use-web-search-fetch direct?
        │   gate 3: @playwright/mcp cli.js resolvable?)
        ▼
  { server: {command: process.execPath, args: [cli, "--headless", "--isolated",
             "--output-dir", attachmentsDir, ...codex-only/executable flags]} }
        │
        ▼
persona gets browserPersonaSection(attachmentsRel, backend)  → specialist-run.server.ts:2152-2153
  (specialist-browser-mcp.server.ts:181-219 — "take screenshots WITHOUT filename")
        │
        ▼
grantedMcpServers[BROWSER_MCP_NAME] = browser.server   → specialist-run.server.ts:1677
mergedMcpServers passed as runInput.mcpServers          → specialist-run.server.ts:1718-1719
        │
        ▼
startRun() spawns the real backend (Claude Agent SDK / Codex SDK) with this MCP
server in its stdio config — SAME config shape on both backends (no `env`, portable
through codex's --config argv serialization)
        │
        ▼
Agent calls Playwright MCP tools (browser_navigate, browser_take_screenshot, ...)
  - default-named screenshot  → written straight into attachmentsDir (--output-dir)
  - filename:-named screenshot → written into the run's OWN cwd instead (workspace-local,
    no human ever sees it) — this is why the persona insists on "no filename")
        │
        ▼
Run finishes → finishRunAndReport() [task-actions.server.ts:2928-2943]
  attachmentNamesSince(slug, key, run.started_at, dataRoot)
     → task-attachments.server.ts:102-112 (mtime window from run start)
  runAttachments stamped onto the producing timeline event (`event.attachments = [...]`)
     → task-actions.server.ts:1956 / 2654 / 3100 / 3176
        │
        ▼
Timeline renders the event: attachment names → thumbnails/links
  (timeline.tsx:288-323), AND any `evidence[].label` token that matches a real
  attachment filename is linkified via EvidenceLabel() → timeline.tsx:126-174
        │
        ▼
GET /projects/:slug/tasks/:key/attachments/:file  → routes/task-attachment.ts
  requireUser + requireProjectMember (member-only, org-admin override audited)
  whitelisted extensions render inline (sandboxed CSP); everything else downloads
        │
        ▼
AttachmentsPanel (attachments-panel.tsx) + inline thumbnails in the timeline both
render from the same directory listing (task-attachments.server.ts:37-65)
```

Live proof this whole chain works end-to-end: pass-28 extended-coverage validation
(`planning/discovery-2026-08-26-pass28/EXTENDED-COVERAGE.md:39-60`) — granted the browser to a
"Developer" profile, task VQT-5 ("navigate to example.com, screenshot it, attach as evidence,
report the H1"), and got a real 1280×720 PNG in `tasks/VQT-5/attachments/`, served 200
`image/png` with the correct PNG magic bytes, rendered inline in the Attachments panel.

---

## 2. Capability definition & gating

**Capability id**: `use-browser`, exact string, `BROWSER_CAP_ID` export
(`app/shared/capabilities.ts:503`).

**Catalog declaration** (`app/shared/capabilities.ts:111`):
```ts
cap("use-browser", "Drive a live web browser", ["agent"], "Collaboration", "off"),
```
- `kinds: ["agent"]` — **the operator never gets a browser**, only generic agent profiles.
- `group: "Collaboration"` — rendered in the profile editor's Collaboration accordion.
- `defaultMode: "off"` — **default OFF**. A freshly created profile does not have it; an
  absent grant is withholding (P14-LV-01 polarity), not permission — same polarity as
  `report-validation-verdict`.

**Enforcement classification**: `capabilityEnforcement("use-browser")` returns `"both"`
(`app/shared/capabilities.ts:288-296`) via membership in `ENFORCED_CAPABILITY_IDS`
(`:254-257`). It is the **strongest enforcement shape the runtime has**: there is no deny-rule
for it (unlike e.g. `execute-code-or-write-repo`'s tool denylist) — withheld simply means the
MCP server is never attached, on either backend, so the tool surface *does not exist* for the
run. `app/shared/capabilities.test.ts:99-102` pins this.

**Effective-mode resolution**: `effectiveCollabMode(grants, "use-browser")`
(`app/server/tasks/agent-outcome.server.ts:381-400`) — an explicit grant's mode wins
(`recommend` falls through to the catalog default, i.e. off — "no specialist recommend",
F20-21/R20-6), an absent grant falls to the catalog default (`off`). Only an explicit
`direct` counts as granted.

**Mount gate — `resolveBrowserMcp`** (`app/server/tasks/specialist-browser-mcp.server.ts:101-150`),
in order:
1. `effectiveCollabMode(grants, "use-browser") !== "direct"` → `{server: null, refused: null}`
   (line 107) — an ungranted browser is not a miss, no disclosure needed.
2. `effectiveCollabMode(grants, "use-web-search-fetch") !== "direct"` → refused, with a
   human-readable reason (`:116-122`). **The browser IS network egress** — a profile whose web
   egress was revoked cannot silently reacquire it through the browser. This is a genuine
   *refusal*, not a silent resolve in either direction (`UnresolvedMcpGrant`, the same
   disclosure pipe as an unhealthy org-registry MCP, P14-LV-09).
3. `@playwright/mcp/package.json` must resolve via `createRequire` + exports-map lookup
   (`playwrightMcpCliPath()`, `:77-88`) and `cli.js` must exist on disk — refused otherwise
   ("the @playwright/mcp package is not installed in this deployment", `:126-128`).
4. `mkdirSync(attachmentsDir, {recursive:true})` (`:131`) — the attachments dir is created
   *at mount time*, only when actually mounting.

**Same-run save-time coupling** (belt to this gate's brace): granting the browser without
egress is also **repaired at save time**, not just refused at mount time —
`repairBrowserEgressGrants` (`app/shared/capabilities.ts:525-556`): whenever a saved profile
has `use-browser: direct` and `use-web-search-fetch` is anything but `direct`, the save layer
force-sets egress to `direct` and returns a `GrantCouplingNotice` (`kind: "repaired"`) so the
admin sees why. This deliberately diverges from the sibling delivery-headline coupling
(`repairDeliveryGrants`), which *respects* an explicit `off` — here an explicit off on egress
under a granted browser expresses no real policy (the mount fails closed regardless), so
"respecting" it would only preserve a trap. `applyGrantCouplings` (`:560-571`) runs both
couplings on every save.

**Reserved MCP name**: `viberr_browser` (`BROWSER_MCP_NAME`, `:51`) joins
`RESERVED_MCP_NAMES` in `app/server/tasks/specialist-mcp.server.ts:85-90` (also `viberr`,
`viberr_agent`, and hyphen variants). An org-registry MCP row cannot be named this — refused
at save (P13-KM-12) — so a registry row can never shadow the real browser server on one
backend but not the other (P14-KM-15). In the run assembly, the browser is layered in
*between* the profile's declared registry MCPs and the collaboration toolkit
(`app/server/tasks/specialist-run.server.ts:1673-1678`): `grantedMcpServers[BROWSER_MCP_NAME] =
browser.server` after the registry servers, before the toolkit servers are spread in.

### Per-backend mount

The `BrowserMcpServer` config (`{command, args}`, no `env`) is **identical in shape** for
both backends — deliberately, because it must survive Codex's `--config` argv
serialization (no env vars can ride that channel; comment at
`specialist-browser-mcp.server.ts:53-58, 147-148`). The one flag that differs by backend:

```ts
...(input.backend === "codex" ? ["--image-responses", "omit"] : []),
```
(`:140`) — on Codex the Playwright MCP is told never to return screenshot image content
blocks to the model (unproven on the codex CLI, and a mid-tool-call crash is worse than a
screenshot the agent can't see). On Claude, images DO return to the model — the agent can
visually inspect what it captured. The file lands in `attachments/` either way; only the
*model's own view* of it differs. The persona text is branched to match
(`browserPersonaSection`, `:181-219`, `codexScreenshotNote` at `:189-195`): a Codex agent is
explicitly told not to claim it visually inspected a screenshot it cannot see, and to judge
pages from the accessibility tree/text tools instead. This asymmetry is also now disclosed on
the capability-matrix modal (`app/features/agents/capability-matrix-modal.tsx:280-283`) — a
gap flagged in pass 25 (`planning/discovery-2026-08-23-pass25/PARITY-CAPABILITY-AUDIT.md:260-298`)
that has since been closed (both the persona branch and the matrix-modal bullet exist in this
codebase state).

Both backends' `resolveDeployedSpecialist(...).capabilities` view exposes a plain
`browser: boolean` field, computed the exact same way the mount is gated:
`effectiveCollabMode(grants, "use-browser") === "direct"`
(`app/server/tasks/specialist-run.server.ts:3277`). This is what drives the UI's
`browserExpected` flag (§4).

---

## 3. Chromium provisioning

**Dockerfile layer** (`Dockerfile:60-73`):
```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium
```
- Debian's `chromium` package (~700MB installed with its dependency closure — an accepted
  weight tradeoff over a sidecar container, per the comment).
- `fonts-liberation` rides along (rendering fidelity for captured pages).
- Deliberately **not** `npx playwright install chromium` — the image bakes a pinned binary,
  never a first-run download (same rationale as the `uv` binary copy a few lines below it).
- `VIBERR_BROWSER_EXECUTABLE=/usr/bin/chromium` is how `resolveBrowserMcp` finds the binary
  (`specialist-browser-mcp.server.ts:133`); when set, the mount builder ALSO adds
  `--executable-path <path> --no-sandbox` (`:141-145`) — chromium's user-namespace sandbox
  cannot start under docker's default seccomp profile as the non-root `node` user the
  container runs as (`USER node`, `Dockerfile:126`).

**Env var** (`app/server/config/env.server.ts:89-96`): `VIBERR_BROWSER_EXECUTABLE` is an
optional string. Unset (e.g. bare `npm run dev` on a host, no container) → Playwright's own
browser resolution applies, which may require `npx playwright install chromium` for the pinned
`@playwright/mcp` version, or pointing the var at a local Chrome build manually.

**Package pin**: `@playwright/mcp` is a **production dependency**
(`package.json:35`, version `0.0.79`) — not a dev-only tool, so it ships in the `prod-deps`
image layer (`Dockerfile:17-29`) and is available at runtime without a rebuild-of-node_modules
step. `playwrightMcpCliPath()` resolves its `cli.js` via the package's own exports map
(`specialist-browser-mcp.server.ts:77-88`) rather than a hardcoded path, so it survives a
version bump that reshuffles the package layout, as long as `bin: {"playwright-mcp": "cli.js"}`
stays true.

**"chromium pending" degraded state**: there is **no first-class app-reported state** for
"container is up but chromium isn't installed yet." What exists is an operational timing
gotcha, documented in `planning/discovery-2026-08-19-pass21/reference/AGENTS-RUNTIME.md:350`
and `planning/discovery-2026-08-14-pass20/reference/AGENTS-RUNTIME.md:802`: at the time the
R19-19 commit (`308cbc3`) landed, the Dockerfile layer existed but the running container had
not yet been rebuilt with it, so `VIBERR_BROWSER_EXECUTABLE` was set in the image spec but the
binary wasn't actually on disk in the container that was up. `docker compose up -d --build`
resolves it. Pass 28's extended-coverage note confirms this was fully resolved by a later
owner rebuild (`planning/discovery-2026-08-26-pass28/EXTENDED-COVERAGE.md:41-43`: "the
container has `/usr/bin/chromium` and `playwright-mcp` installed... The 'chromium layer
pending' caveat from the R19-19 pass has since been resolved").

If the executable genuinely isn't there at mount time, the failure mode is NOT a nice degraded
banner — Playwright's own binary resolution inside the spawned MCP child would fail at
first-tool-call time, deep inside the run, not at `resolveBrowserMcp` (which only checks that
`@playwright/mcp`'s **CLI script** exists, not that the chromium **binary** it will try to
drive exists — see §7 Suspected Issues).

---

## 4. Screenshot → attachment mechanics

**Directory**: `taskAttachmentsDir(slug, key, dataRoot)` = `<task dir>/attachments`
(`app/server/files/file-store-root.server.ts:87-93`). Lives *inside* the task's own directory
so archive/delete flows that move the task move its attachments with it — "no retention
machinery" is a deliberate simplicity choice (comment at `task-attachments.server.ts:8-25`).

**Default-name vs explicit-filename behavior** (verified live against `@playwright/mcp` 0.0.79,
per the comment at `specialist-browser-mcp.server.ts:40-45`):
- `browser_take_screenshot` called **without** a `filename` argument → Playwright MCP applies
  its own default naming and saves into `--output-dir` (the task's `attachments/`).
- `browser_take_screenshot` called **with** an explicit `filename:` → resolves against the
  **child process's own cwd** (the run workspace) instead, because the SDK's stdio server
  config carries no `cwd` override for this server. That file is invisible to any human on the
  task page.
- The persona is written to steer the agent explicitly toward the default-naming path:
  *"call `browser_take_screenshot` WITHOUT a `filename` argument... A screenshot you NAME
  yourself saves into your working directory instead and no human will see it."*
  (`browserPersonaSection`, `specialist-browser-mcp.server.ts:211-217`).

**Store (read side)**, `app/server/files/task-attachments.server.ts`:
- No projection table, no upload path — **the directory is the source of truth**
  (`:8-25`).
- `listTaskAttachments(slug, key, dataRoot)` (`:37-65`): `readdirSync`, skip dotfiles,
  `statSync` each, sort newest-mtime-first, cap at `LIST_CAP = 100` (`:35`).
- `countTaskAttachments` (`:78-91`): a cheap Dirent-only count (no per-file stat) so the panel
  can show "showing the most recent 100 of N" instead of silently truncating (C8 fix,
  `attachments-panel.tsx:76-93`).
- `attachmentNamesSince(slug, key, sinceIso, dataRoot)` (`:102-112`): names of files with
  mtime ≥ a run's `started_at` — this is how a finished run's own contribution is isolated from
  everything an earlier run already dropped there. A file re-saved under the same name by a
  later run re-attributes to the later run (honest: its content IS the later run's).
- `resolveTaskAttachment(slug, key, name, dataRoot)` (`:116-123`) goes through
  `resolveStoreSegment` (traversal-refusing; throws on a bad name, caller maps that to 404).
- `attachmentContentType(name)` (`:125-149`): an **inline-render whitelist**
  (png/jpg/jpeg/webp/gif/pdf/txt/log/md/json) — everything else, notably HTML/SVG/JS, is
  served as `application/octet-stream` with `content-disposition: attachment`, never inline.
  A browsing agent that saved an actual HTML/SVG page into attachments can never get it to
  execute on the viberr origin.

**Serving route**: `GET /projects/:slug/tasks/:key/attachments/:file`
(`app/routes/task-attachment.ts`):
- `requireUser` + `requireProjectMember(request, slug, "view task attachments")` — **member-only**,
  same authorization bar as `/resources/run-log`; an org-admin override exists but is audited
  through the same guard path (`:14-18`).
- 50MB serve cap (`MAX_ATTACHMENT_BYTES`, `:29`) → 413 above that.
- Every response carries `x-content-type-options: nosniff` and
  `content-security-policy: sandbox; default-src 'none'` (`:63-67`) — even the inline-whitelisted
  types render inert (no scripts, no plugin execution, no reach-back to the app origin). A
  browser that refuses to show a sandboxed PDF inline just downloads it instead (acceptable
  per the comment).
- Filename is sanitized for the `Content-Disposition` header (`:56`, strips `"`/`\`) but the
  path itself was already validated by `resolveTaskAttachment`'s traversal guard.

**Completion pipeline stamping** (`app/server/tasks/task-actions.server.ts`):
- `finishRunAndReport` (context around `:2900-2943`): computes `thisRunStartedAt` from the
  run row, then `runAttachments = attachmentNamesSince(...)` for that window — "without a
  recorded start there is no honest window, so nothing is claimed" (`:2929-2932`).
- The names are stamped onto the **producing timeline event** (`event.attachments = names`,
  e.g. `:1956`, `:2654`), and if there is no natural reply/verdict event to carry them, a
  synthetic one is created with body text `"Saved N file(s) to this task's attachments during
  the run."` (`:1950-1952`, `:2646-2649`).
- `sanitizeEventAttachmentNames` (`:1900`, `:2454`) filters the raw names before they're
  trusted onto a timeline event.

**Evidence linkify in the timeline** (`app/features/task-detail/timeline.tsx`):
- `EvidenceLabel` (`:133-174`): an agent's `report_outcome` / envelope `evidence[].label` is
  free text the agent wrote (e.g. *"page-…-842Z.png shows the H1"*). This component
  tokenizes the label on whitespace, strips surrounding punctuation/quotes/backticks from each
  token, and checks it against the **real** attachment name set for the task
  (`attachmentNames`, a `Set<string>` built once per render, `:383-385`). Only a token that
  matches an *actual file* becomes a link — "no guessing" (`:127-131`). Matched image
  filenames open the in-app lightbox on click; non-images and modified clicks fall through to
  a plain new-tab link (`:157-164`).
- Attachments the *run itself* saved (not cited in a text label, just recorded on the event via
  the completion-pipeline stamping above) render directly as thumbnails/links in the timeline
  card (`:288-323`): images via `AttachmentThumb` opening the lightbox, non-images as plain
  download anchors.
- `AttachmentsPanel` (`app/features/task-detail/attachments-panel.tsx`) is the same directory
  listing rendered as a standalone panel: image grid with previews (`IMAGE_RE`, `:25`) +
  plain-file list, each row optionally annotated "added by `<actor>` · `<time>`" from a
  `producers` map the loader builds by matching filenames to the timeline event that first
  claimed them.
- **Empty-state disclosure** (D8 fix, `:57-71`): when there are zero attachments, the panel
  renders **nothing** unless `browserExpected` is true (some deployed specialist on the task
  holds `use-browser`), in which case it renders an explicit "No attachments yet... they appear
  the next time such an agent runs" message instead of silence. `browserExpected` is computed
  in `task-detail-page.tsx:848-850` as `deployedSpecialists.some(s => s.capabilities?.browser)`.

---

## 5. Config surfaces

| Surface | Default | Where |
|---|---|---|
| `use-browser` capability | **off** | Per-agent-profile, Collaboration group in the profile editor. Catalog default `capabilities.ts:111`. |
| `use-web-search-fetch` capability | **direct (on)** | Coupled to the browser at save time (`repairBrowserEgressGrants`) and at mount time (`resolveBrowserMcp` gate 2). |
| `VIBERR_BROWSER_EXECUTABLE` | unset on a bare host; `/usr/bin/chromium` in the Docker image | `env.server.ts:89-96`, `Dockerfile:73`. |
| `@playwright/mcp` version | pinned `0.0.79` | `package.json:35`. |
| compose | no browser-specific compose keys; `init: true` (`compose.yml:17`) is there so PID-1 reaps orphaned chromium/crashpad zombies left by an aborted run (F20-2). | `compose.yml:11-17`. |
| `.env.example` | no browser-specific vars present (grep found none) — the executable path is baked into the image, not left to `.env`. | — |

There is **no global on/off switch** for the browser capability at the deployment level — it
is purely a per-profile grant, default off, coupled to per-profile egress. The only
deployment-level lever is whether chromium is actually installed and `VIBERR_BROWSER_EXECUTABLE`
resolves (the Docker image always has both; a bare-host dev run may not).

---

## 6. TEST PLAN HINTS

**Setup**
1. Confirm the container was built/rebuilt from a Dockerfile that includes the chromium layer
   (`docker compose up -d --build`) — a stale container from before that layer will silently
   fall through to Playwright's own resolution and likely fail deep inside the first tool call,
   not at profile-save or run-start time.
2. Create or edit an agent profile → Collaboration group → grant **"Drive a live web browser."**
   Confirm the save layer auto-grants **"Search & fetch from the web"** alongside it if it
   wasn't already on (the `GrantCouplingNotice` should be visible/toasted — this is the
   `repairBrowserEgressGrants` behavior, §2).
3. Deploy that profile to a project.

**Exercise**
4. Create a task whose goal explicitly asks for a screenshot as evidence, e.g. (the exact
   phrasing pass-28 used and verified): *"navigate to https://example.com, screenshot it,
   attach as evidence, report the H1 — do not touch any repository files."* A goal that
   explicitly forbids repo changes is a good way to also exercise the **supporting-agent**
   engagement path (no branch/PR expected) rather than the delivering path.
5. Run it. Watch for:
   - The Attachments panel showing a real PNG (inline thumbnail), or the D8 empty-state
     message if `browserExpected` is true but nothing has landed yet.
   - The timeline's producing comment carrying the attachment as a thumbnail/link.
   - If the agent's `evidence[]` cites the filename in its label text, confirm it renders as a
     live link (`EvidenceLabel`) rather than plain text — that's the "cite the exact filename"
     contract actually working.
   - Click the served attachment URL directly
     (`/projects/<slug>/tasks/<KEY>/attachments/<file>`) as a **non-member** and confirm 403/redirect
     (member-only enforcement), then as a member and confirm 200 with the right content-type.
6. Try the **egress-withheld contradiction** directly: grant `use-browser: direct` but hand-set
   `use-web-search-fetch: off` via a raw project.md edit (bypassing the editor's auto-couple),
   then run. Expect: no browser tools mounted, and a "grant did NOT reach this run" disclosure
   in the run's member-only console/agent-logs (the `Run inputs` line,
   `runs-panels.tsx` + `specialist-run.server.ts:1489`) naming `viberr_browser (use-browser)`
   and the egress contradiction as the reason.
7. Try a **Codex-backed** profile with the browser granted. Confirm the run's persona explicitly
   tells it screenshots don't return as images to it (the Codex-specific note), and that it
   doesn't claim to have "seen" the screenshot in its final report. Cross-check the capability
   matrix modal shows this asymmetry bullet.
8. Try a **filename-specified** screenshot (if you can steer the agent to attempt it, e.g. via a
   task goal that says "save the screenshot as `myshot.png`") and confirm it does NOT appear in
   the Attachments panel — it lands in the run workspace instead, per the documented behavior.
   This is a good adversarial check that the persona's guidance is actually load-bearing and
   not merely decorative.
9. Check the `attachmentsBase`/panel `total` truncation UI on a task with >100 attachment files,
   if you can generate that many, to exercise the C8 "showing the most recent 100 of N" note.

**Known gotchas (not app bugs)**
- The Browser pane (Claude's own preview tooling, not the app) can go non-compositing and fail
  to produce screenshots client-side — that's a client/tooling quirk unrelated to viberr's own
  browser capability; text-based tools and ref-clicks still work in that state (pass-27 memory
  note).
- A synthetic `Escape` keypress does not equal a real dialog cancel in some Browser-pane
  contexts — use a backdrop click if a dialog needs dismissing during manual QA.
- If testing on a freshly-rebuilt container, give it a moment — the chromium apt layer plus
  fonts is the heaviest layer in the image; a "browser not mounted" symptom right after a
  rebuild may just mean the build hasn't finished, not a real regression.

---

## 7. Suspected issues

1. **No pre-flight check that the chromium *binary* exists, only that the MCP *CLI script*
   exists.** `resolveBrowserMcp` (`specialist-browser-mcp.server.ts:124-129`) calls
   `playwrightMcpCliPath()`, which verifies `@playwright/mcp`'s `cli.js` is on disk — it does
   **not** check that `VIBERR_BROWSER_EXECUTABLE` (when set) actually points at a real,
   executable file. If chromium's apt layer failed or was skipped in a given image build, the
   mount would still succeed at `resolveBrowserMcp` time (server config returned, no refusal
   surfaced, no disclosure to the human) and only fail deep inside the run at the first real
   browser tool call — a failure mode with much worse legibility than the clean `refused`
   channel this subsystem otherwise uses everywhere else. This is exactly the "chromium
   pending" timing gap that was previously worked around by luck (nobody hit it) rather than by
   design.

2. **No app-level health/status signal for "browser capability infrastructure is degraded."**
   Every other cross-cutting infra dependency in this codebase (Codex auth availability,
   model-availability, org-MCP health) has a first-class "unavailable/degraded" state surfaced
   to a human before a run is spent (see `modelUnavailable` on `DeployedSpecialistView`,
   `specialist-run.server.ts:3286-3289`, and the Codex-unavailable boot report). The browser has
   no equivalent — a deployment with a broken/missing chromium looks identical, in the UI, to
   one that's perfectly healthy, until an actual run is spent and fails.

3. **No e2e/integration test drives an actual Playwright MCP child process.** Coverage is
   thorough at the unit level (`specialist-browser-mcp.server.test.ts` — 6 cases covering
   gating, mount shape, egress refusal, codex `--image-responses`, executable/sandbox flags)
   and at the capability-catalog level (`capabilities.test.ts`, `capability-catalog.test.ts`),
   but nothing in the repo's automated suite actually spawns `cli.js` and drives a real (or even
   fake) browser end-to-end — the only end-to-end validation on record is the pass-28 manual
   live run against a real owner container (`EXTENDED-COVERAGE.md`), which is not repeatable in
   CI. A regression in the actual runtime behavior of `@playwright/mcp` 0.0.79 (e.g. the
   default-name-vs-filename output-dir behavior the whole persona strategy depends on) would
   not be caught by any automated gate.

4. **The default-vs-filename output-dir behavior is externally-verified folklore, not
   contractually pinned.** The comment at `specialist-browser-mcp.server.ts:40-45` explicitly
   says this was "verified behavior (0.0.79, live)" — i.e. discovered by observation of the
   third-party MCP server's actual behavior, not documented upstream API contract. A
   `@playwright/mcp` version bump could silently change this behavior (e.g. always honor
   `--output-dir` regardless of `filename:`, or vice versa) and nothing in this codebase would
   detect it — the persona's entire "never pass `filename`" instruction is downstream of an
   assumption that isn't tested against the real package.

5. **`attachments/` has literally no retention or size governance.** By explicit design
   (`task-attachments.server.ts:8-25`) there is no projection table, no upload cap beyond the
   50MB single-file serve limit, and no total-directory-size limit — an agent with the browser
   granted could, over many runs, accumulate an unbounded number of screenshots/PDFs on disk
   with nothing but the 100-item *display* cap (`LIST_CAP`) hiding the growth from the UI. This
   is a deliberate simplicity tradeoff per the code comments, but it is worth flagging as a
   disk-growth vector worth testing against (many runs, many screenshots) since nothing will
   warn an operator before the data root fills up.

6. **The Codex screenshot-invisibility asymmetry is now disclosed, but only in two places** —
   the capability-matrix modal and the branched persona text. It is not surfaced anywhere in
   the **profile editor** itself at the moment the admin actually ticks "Drive a live web
   browser" for a Codex-pinned profile — an admin who never opens the "what differs" modal (or
   isn't shown it in that flow) could still be surprised the first time a Codex agent's final
   report claims — or explicitly disclaims — having "seen" a screenshot.
