# Pass 18 — live-verify session (fresh execution, 2026-08-05)

This session's OWN live Phase-B pass (the Stop hook flagged that prior Phase-B
coverage was compacted away and invisible here). Owner steer: **focused fresh
run** — one real end-to-end lifecycle to a merged PR + one reject variant +
targeted cases (secondary assignment, comment/@mention honesty, RBAC, skill
loading incl. the decoy, MCP Codex/Claude parity) + a UX-coherence sweep with
screenshots. Build on the existing harness, don't recreate it.

### Environment switch (owner request, mid-pass)
Owner asked to run the live pass in a **fresh docker-compose environment** with
**clean data**, dev server stopped (no dual-writer). Executed:
- Stopped the host `react-router dev` (SIGTERM) → verified no listener on :5173,
  no writer lock, nothing holding `docker-data`.
- Backed up the host data root `docker-data` (908M) → **`docker-data.hostdev-backup`**
  (reversible; NOT hard-deleted — it held the GitHub PAT + Viberr/Lab projects I
  didn't create). Fresh empty `docker-data` created.
- `docker compose up -d --build` → prod-parity container, `NODE_ENV=production`,
  `VIBERR_DATA_ROOT=/data` (bind `./docker-data`), serves on **:5173** (PORT=.env).
- **Preview NOT hurt**: the Browser pane targets any localhost URL → :5173 (compose).
- **Two owner-only handoffs** (I cannot enter credentials): (1) log in as the
  seeded admin `arda@viberr.dev`; (2) add the GitHub connection PAT for PR tests.
- Host-env artifacts (Pass 18 Verify/QAV-1, **PR #141**) now live only in the
  backup + on GitHub; the fresh app won't track them. LV-0..LV-4 below were the
  HOST-env warmup (kept as evidence the flows work); the fresh-env re-run follows.

Environment confirmed live (host warmup):
- Dev server single-writer pid 34454 on docker-data (:5173). MCP everything
  server restarted on :3001 (streamableHttp, 16 tools).
- Backends both work: **Developer = Codex**, **Docs Writer + Reviewer = Claude Code**.
- Harness: projects Viberr (VIB) + Pass 18 Lab (LAB), both on akin-ozer/viberr;
  KB "Pass 18 Conventions"; MCP everything-http; skills incl. `smoke-note-style`
  (should load) + `release-announcements` (**decoy — must NEVER load**).
- gh authed as akin-ozer (repo+workflow scopes); only open PR is #140 (this pass).

### Fresh compose env — confirmed at boot
- `docker compose ps`: `viberr-app-1 Up (healthy)`, `0.0.0.0:5173->5173`.
- `/resources/health`: `{ok:true, projections:{projects:0,tasks:0}, watcher:true,
  kbWatcher:true, lock:{pid:1,hostname:"viberr"}, backends:{claude:"real",codex:"real"}}`
  → **clean slate, single writer, BOTH backends real** (agent runs will work).
- Boot log: migrations `0001_baseline.sql` applied, `seed admin created … arda@viberr.dev`,
  `nodeEnv:"production"`. Prod parity (not the HMR dev server).
- **G4 confirmed in the PROD image**: login hero reads "Managed AI delivery for small
  teams" / "a managed operator" (banned "governed" gone); local-first login shown
  since SSO unconfigured (R17-4). Screenshot captured.

## Use-case ledger (this session)

| UC | Area | Status | Evidence |
|----|------|--------|----------|
| LV-0 | Real pending LAB-1 decision (gh-close recovery → confirm rejection + archive) | ✓ | Selected "Archive LAB-1" on the packet + note → task `archived`, packet cleared, "task closed" typed event. Owner-decided. |
| LV-1 | New project creation (modal: name/key/repo/Balanced preset) | ✓ | "Pass 18 Verify" (QAV) on akin-ozer/viberr; auto-deployed Operator+Developer(Codex)+Reviewer(Claude). |
| LV-2 | Task creation + operator AUTO-invoke + triage scoping + auto-advance | ✓ | QAV-1 created in Triage; operator auto-started, scoped goal (no packet — clear goal), moved Triage→Ready→In Progress, deployed Developer(Codex), started Codex run. Timeline typed events at 13:38-13:40. |
| LV-3 | Codex Developer run → small-file delivery → server-owned PR | ✓ | Operator deployed Developer(Codex), started Codex run; agent wrote `qa/smoke/pass18-verify.md` (3 lines) + committed locally; SERVER pushed `qav-1` + opened **PR #141** (+3/−0, single file), moved to Review. Agent did NOT push (server-owned delivery held). |
| LV-4 | Reviewer(Claude) verdict gates acceptance | … | Operator Supervised → stopped after delivery (R18-2: Supervised no auto-requeue). Re-running operator to summon reviewer. Review gate active ("Force accept (override review gate)" present). |

### Fresh compose env — live use cases (FV-*)
Baseline (seeded, verified): Developer(Codex, Ready+In Progress) + Reviewer(Claude,
In Progress+Review) global profiles, 3 skills (developer/reviewer/viberr-app), 0 KB,
0 MCP. GitHub connection akin-ozer (PAT ····k3ui, repo+pull_request:write) — added by owner.

| UC | Area | Status | Evidence |
|----|------|--------|----------|
| FV-1a | New project via modal (Balanced) on prod build | ✓ | "Verify Fresh" (FV) on akin-ozer/viberr; auto-deployed operator + made Developer/Reviewer eligible. |
| FV-1b | Task create → operator AUTO-invoke → triage scope → auto-advance | ✓ | FV-1 in Triage; operator auto-started, scoped (no packet), moved Triage→Ready→In Progress, started Codex run. Prod parity with host warmup. |
| FV-1c | Codex delivery → server-owned PR (prod build) | ✓ | Codex Developer wrote `qa/smoke/fresh-verify.md` (correct 3 lines) + committed locally, reported to @operator: *"PR URL: none (push/PR delivery not performed per workspace contract)"* — server-owned delivery held. Operator pushed `fv-1` (commit 3c2ea324) + opened **PR #142** (+3/−0). Prod-parity confirmed. |
| FV-1d | Operator recommends transition (recommend policy) → human applies | ✓ | Operator can't transition directly (Balanced: stage-transitions=recommend), so it posted "Recommendation: Move In Progress→Review" with evidence (branch/commit/PR). Clicked **Apply** → toast "Applied · Move the task to Review", stage→Review. Governed recommend→apply flow works. |
| FV-1e | Operator summons Reviewer(Claude) → real verdict gates acceptance | ✓ | Operator engaged Reviewer(Claude); it ran a RIGOROUS review — `git diff --stat`, `--name-only`, `od -c` for trailing whitespace — verdict **"Review passed. Validation: healthy."** `validation healthy` pill; operator then recommended Accept. |
| FV-1f | Human accept → app merges PR #142 → Done + branch cleanup | ✓ | Accept dialog stated "Merges PR #142 · review into main / Revision 3c2ea324 / Verdict validation healthy / Merging is one-way." Confirmed → **PR #142 MERGED** (mergeCommit d2d190a2, by app PAT akin-ozer), fresh-verify.md on main, **fv-1 branch auto-deleted**. Task → Done+merged; timeline "Completion accepted … the review PR was merged" (attributed Arda). ALWAYS_HUMAN accept honored. |
| FV-2a | MCP registration + health (fresh env, container→host) | ✓ | Registered `everything-http` HTTP `http://host.docker.internal:3001/mcp` → **"16 tools · checked just now"** (container reaches host MCP via host.docker.internal, pre-verified). |
| FV-2b | Per-project MCP grant to Developer(Codex) + Reviewer(Claude) | ✓ | Edit-profile modal: expanded MCP accordion (0 of 1), toggled everything-http on → **1 of 1** granted; saved both profiles. Modal also exposes backend, eligible stages, Repo&execution (Allowed/Human-only/Off), Collaboration 23, Reserved-for-humans 21, Skills 1 of 3 (developer-expertise granted). |
| FV-2c | MCP wired into the Codex runtime (per-agent scoping) | ✓ | Codex developer run's context/config: *"everything-http MCP server is reachable from the agent runtime … yours to read with and query"* (run_SwHLJSJT2Kdh.jsonl). The OPERATOR run shows `mcp: viberr` ONLY (no everything-http) → per-agent grant scoping holds. (Full Codex+Claude tool-mount parity = UC18-19 prior.) |
| FV-2d | gh EXTERNAL merge → Viberr reconcile → force-accept → Done | ✓ | `gh pr merge 143 --merge --delete-branch` (out-of-band, mergeCommit 2b22b28a, mcp-parity.md on main). App detected it: PR pill "merged", operator rec *"PR #143 was already merged out-of-band on GitHub … moving to Review so completion can be accepted to reconcile task state with the merged reality."* Applied → Review; force-accept dialog *"PR #143 · merged into main / Bypassing: Waiting on 1 required reviewer approval"* → **Done**; timeline *"transitioned to Done — the review PR had already been merged on GitHub (out of band)."* Honest reconcile, no silent completion. |

## Summary of this live pass (fresh docker-compose, prod build)

**Full governed lifecycle verified end-to-end, live, on a clean prod environment:**
project create (Balanced) → operator auto-invoke → triage scope → auto stage advance →
Codex Developer writes file locally (server-owned delivery, no agent push) → server pushes
branch + opens PR → operator recommends transition → human applies → operator summons Claude
Reviewer → rigorous verdict (git diff/od -c) gates acceptance → human accept dialog → app
merges PR → branch cleanup → Done. **PR #142 merged by the app.**

**Also verified live:** MCP registration + 16-tool health (container→host via host.docker.internal);
per-project MCP grant + Codex-runtime wiring with correct per-agent scoping (operator has only
`viberr`); **gh EXTERNAL merge → Viberr reconcile** (honest "already merged out-of-band" + reconcile
recommendation) → force-accept → Done (PR #143); gh reject/close (LAB-1 recovery packet → archive;
orphan PR #141 closed); both backends `real`; G4 login-hero copy in the PROD image.

**Coherence verdict:** holistic and coherent. Copy discipline holds (no "govern" in rendered UI;
"managed"/"Permissions" used). Confirmation dialogs state exact consequences. Operator narration is
honest (out-of-band merges, server-owned delivery). Per-agent resource scoping is correct.
Minor UX notes UXO-1 (archived pills) and UXO-3 (Done-only board count) below; UXO-2 investigated →
not a bug.

**Not re-run this session (covered by prior UC18-x, or blocked):** skill-decoy loading (setup-heavy),
RBAC enforcement by a real member (member creation needs a password I cannot enter), secondary
specialist assignment, Claude-side MCP tool-mount parity (Codex side verified; Claude mount = UC18-19).
Offered to the owner to go deeper on any of these.

**Repo state:** `qa/smoke/` on main has ~10 small test markers accreted across sessions (2 this pass:
`fresh-verify.md`, `mcp-parity.md`) — candidate cleanup. Host data root preserved at
`docker-data.hostdev-backup` (908M, restorable). Compose container running (single writer, pid 1).

## LV-F1 (MED, owner-reported → live-reproduced → FIXED) — new local accounts could be permanently locked out

**Owner report:** *"I created the user but couldn't log in since it asked for a password."*

**Reproduced live** in the fresh env: Users & access → Allow access → Local →
"Create account" creates the user and shows the generated temp password in an
inline `.cred-ok` banner ("temp sign-in password: `kjz__gM9Z5Vd` — shown once").
That banner is **client state only**: reload, navigate away, or dismiss it and the
password is gone. The user row then reads "setup pending" with only Edit / Disable /
Remove, and the Edit modal's Password field showed **"Reset pending — will be
prompted to set a new password at next sign-in"** and *nothing else*.

**Root cause** (`app/features/org-settings/users-panel.tsx:450`): the Password field was a
ternary — `user.pwreset || user.status === "invited" || tempPassword ? <banner> : <Reset
password button>`. A freshly created account ALWAYS has `pwreset: true`
(`user-admin.server.ts`: `pwresetRequired: Boolean(tempPassword)`), so the branch that
hides the button is exactly the new-account case. The backend could always re-issue
(`user-reset-password` → `resetLocalPassword` returns a fresh `tempPassword`) — **only the
UI hid the door**. Net effect: a lost temp password made the account permanently
un-signin-able; the sole escape was Remove + recreate.

**Fix:** the pending banner becomes CONTEXT above the action instead of replacing it. The
button always renders for a local account, relabelled **"Generate a new temp password"**
while a reset is pending, with a note that generating again replaces any password handed
over earlier. 2 canaried tests (`LV-F1` describe block) — canary: restoring the old
gating makes the recovery action disappear and the test fails.

## RBAC — verified LIVE as a real non-admin member (owner signed in as contributor@viberr.dev)

Enabled by the LV-F1 fix (the account was previously unusable). Findings:

| Probe | Result | Verdict |
|-------|--------|---------|
| `/org/settings` (users / connections / resources) | **403** real Error-403 page | ✓ instance settings are admin-only |
| `/projects/verify-fresh/*` **before** membership | **404** (not 403) | ✓ deliberate — a non-member never learns the project exists (no existence leak, R15-4) |
| `/` , `/profile` | 200 | ✓ |
| `/projects/verify-fresh/{board,tasks/FV-1,policy,agents,settings}` **after** adding as `contributor` | 200 (view) | ✓ a member may READ project surfaces |
| `POST save-project` as contributor (CSRF-valid) | **403** | ✓ **server-enforced** — mutations refused regardless of UI |
| Policy sheet controls for contributor | 8/8 role toggles disabled + "Read-only — … needs the Manage members & roles grant" | ✓ correct, explained |
| Settings sheet controls for contributor | 0/4 inputs editable, 0/7 destructive enabled — but **no explanation** | ✗ → **LV-F2**, fixed |

**No security hole found.** One UI-honesty gap (LV-F2) — fixed + canaried.

*Method note:* my first probe regexed the body for "Forbidden" and reported Policy/Agents
as forbidden for a contributor. That was a **false positive** — "forbidden" is a legitimate
capability-mode label rendered on those pages. Re-probed on `Error 403` + real status. Recorded
because it is the kind of mistake that silently inflates a findings list.

## LV-F2 (LOW, live-found → FIXED) — project Settings never said why it was inert

A Contributor's project Settings page correctly disables everything (server also 403s), but
nothing explained the greyed-out state, and the Stages note still instructed them to *"Drag a
row to reorder … click a name to rename"* — a how-to for an action the page refuses. A disabled
control cannot explain itself (`title` never opens on one). This is the exact defect the Policy
sheet fixed under **P14-LV-08**, never propagated to Settings. Fix: Project / Stages / Members
panels carry the same lock-icon note naming the missing grant, and the manage-only how-to is
shown only to a reader who can act on it. 3 canaried tests; suite 2860 green.

## Skill routing — LIVE decoy test (FV-3), answered precisely

**Setup.** Created two skills with distinct greppable footers and granted **both** to the
Codex Developer, then wrote a goal that mentions NO footer (so only skill loading can supply one):
- `smoke-note-style` — RELEVANT ("use when writing files under `qa/smoke/`"), footer **`SPICEBERRY`**.
- `release-announcements` — DECOY ("public release announcement blog posts … never for internal
  engineering notes"), footer **`WATERMELON`**.

**Task FV-3** ("Create qa/smoke/skill-routing.md … Follow the repository house style for smoke notes")
was created **by the Contributor** (also proving contributors may create tasks). Operator auto-ran the
Codex Developer.

**Result — delivered file:**
```
# Skill-routing smoke note
2026-08-05
The fresh environment exercised agent skill routing on 2026-08-05.
SPICEBERRY
```
✓ The relevant skill's house style (H1 → ISO date → footer) was applied. ✗ `WATERMELON` appears
**nowhere** in the output or the repo working tree — the decoy did not influence the work.

**The precise mechanism (matters for the owner's phrasing "not unrelated skills are loaded").**
Both granted skills' FULL BODIES are injected into the agent's context (`WATERMELON` appears once in
the Codex session rollout — as the decoy's own injected rule text — while `SPICEBERRY` appears 7×,
i.e. injected AND reasoned about). So:
- **Applied:** only the relevant skill. ✓ (the behavioural question — PASS)
- **Loaded into context:** every GRANTED skill, always. This is **deliberate**, not a defect:
  `claude-runtime.server.ts:64-70` (`skills: []`, `settingSources: []`) and
  `codex-runtime.server.ts:199-231` (LV-13 drops the CLI's whole skills channel) both cut the
  vendor-native skill mechanism on purpose, so a host-installed plugin's skills can never leak into a
  governed run; Viberr then injects the declared skills as prompt text itself.
- **Consequence to weigh (not a bug):** there is no progressive disclosure — context cost grows
  linearly with the number of granted skills, and relevance filtering is left to the model. Sound at
  3 skills; worth revisiting if a project grants 15. Recorded as an owner question, not a finding.

**Codex/Claude parity on skills: identical by construction** — both backends receive skills as
injected prompt text, neither uses the vendor channel. (Directly answers "codex and claude code work
the same way from Viberr's eye" for the skills dimension.)

Corroborating self-report — the Codex agent's own opening message on FV-3:
> *"I'm using the attached **developer expertise and smoke-note house-style guidance**. The
> smoke-note skill fixes the title/date/footer structure; I'll inspect existing examples … then
> create only the requested file."*

It names the two applicable skills and never mentions the decoy. (Skill selection is therefore
correct at both the reasoning level and the output level.)

## MCP mount — Claude side PROVEN live; Codex side wired + prior-pass proven

**Claude (reviewer run `run_0HKcXtp3UA2q`, FV-2)** — decisive, from the run's own init record:
```
"mcp_servers":[{"name":"everything-http","status":"connected"},
               {"name":"viberr_agent","status":"connected"}]
```
with real tools mounted: `mcp__everything-http__echo`, `__get-sum`, `__get-env`,
`__get-resource-links`, `__args-prompt`, … ✓ **granted org MCP + the Viberr agent MCP both connected.**

**Codex (developer run `run_C7n98Du1k2Uu`, FV-3)** — the runtime passes MCP servers as
`mcp_servers` config into the CLI (`codex-runtime.server.ts:263` → `codexMcpServers`), and the run's
context disclosed *"everything-http MCP server is reachable from the agent runtime … yours to read
with and query."* This session's Codex turn had **no occasion to call** an everything-http tool, so I
did not observe a tool invocation; the vendor rollout does not log a tool inventory the way the
Claude JSONL does. Live tool-level proof exists from the prior pass (UC18-19: Codex mounted
`mcp__everything_http__echo` — the CLI lowercases hyphens to underscores). **Recorded honestly: wired
+ disclosed this session, tool-invocation proof carried from UC18-19, not re-observed here.**

**Parity verdict.** Same grant → both backends receive the server; naming differs by vendor
(`everything-http` on Claude, `everything_http` on Codex — disclosed, not normalised). One REAL
documented asymmetry, by design: a **credentialed** MCP authenticates on Claude only — the Codex SDK
passes config as `--config` argv, so a literal secret would be visible in `ps auxww`, and the token is
deliberately withheld (`codex-runtime.server.ts` comment). Codex connects unauthenticated. That is an
honest, documented limitation, not a silent drop.

## Implementation of the audit backlog — ALL items closed

The three opus subagents produced `UX-AUDIT-PASS18.md` (0 HIGH / 6 MED / 10 LOW),
`GAP-ANALYSIS.md` (57 requirements; nothing in the PRD unimplemented) and
`USE-CASES-PASS18.md` (52 use cases + a regression-test map). Everything actionable
from them is now implemented on this branch, each with tests:

| id | what | status |
|----|------|--------|
| **B1** | *(gap analysis, verified by me in code)* a human dragging a card into the final stage runs `acceptCompletion` — a **real PR merge** — and the board drag AND keyboard Move committed it with no dialog, while task detail has always said "Merging is one-way". Both paths now confirm. | ✓ 3 canaried tests |
| UXA-1 | comment composer claimed "Open to every registered user"; the Permissions panel on the same page had already removed that exact false sentence (E1). Membership is the gate (R15-4, re-proven live). | ✓ |
| UXA-2 | review queue had a private PR-state colour map → a rejected PR was neutral grey there, `risk` everywhere else. Uses canonical `prStatePill` (ruling 12). | ✓ test updated |
| UXA-3 | LV-F2's read-only note reached 3 of 4 Settings panels; RepoPanel added. | ✓ |
| UXA-4 | `pick-chip`/`cap-seg` families never swept by G3/G5 — 13 groups signalled by CSS alone, incl. the **capability** control whose twin on Policy is a proper radiogroup. | ✓ test |
| UXA-5 | `/notifications` SSR'd viewer-local day buckets **as the grouping key** — the exact case `formatDayBucketUTC` documents. | ✓ |
| UXA-6 | same actor was "Primary specialist" and "Delivering agent" one viewport apart. | ✓ |
| UXA-7 | Policy's two radiogroups promised arrow-key traversal and never wired it → new reusable `rovingRadioKeyDown`. | ✓ 5 tests |
| UXA-8 | the 2 wide fr-grid tables had no mobile rule and no overflow container. | ✓ CSS gate green |
| UXA-9 | `MiniModal`'s disabled Save never named the unmet requirement (7 callers). | ✓ |
| UXA-10 | profile said "no memberships" two ways; `Joined` used the TIMELINE formatter (year-less). | ✓ |
| UXA-11 | connection modal locks the owner field silently. | ✓ |
| UXA-12 | the whole login value panel was `aria-hidden` — unique content, invisible to AT. | ✓ |
| UXA-13 | org-admin override pill hid its sentence in a `title` on a non-focusable span. | ✓ |
| UXA-14 | "Save goal" dead below 3 chars with no hint. | ✓ |
| UXA-15 | Agents page never said it was read-only. | ✓ 2 tests |
| UXA-16 | Policy's "last change" was formatted in the SERVER's timezone, year-less. | ✓ test updated |
| UXO-1 | archived task kept asserting live obligations ("ready · awaiting verdict"). | ✓ |
| UXO-3 | board header counts a Done task while visible columns read "No tasks". | **not a defect** — inherent to a horizontally scrolling kanban; the count names its scope ("in this project") and Done is one scroll away. No change. |

Suite after the batch: **2871 tests + tsc green** (from 2845 at the start of pass 18).

## UX observations (running log)
- **UXO-1** An **archived** task still shows its pre-archive status pills ("In Progress · ready · awaiting verdict") next to the "archived" pill on the task hero. Reads slightly noisy — a reader must infer these are the frozen last-state, not live. Minor; candidate for a muted "was: …" treatment. (LAB-1)
- **UXO-2 — INVESTIGATED, NOT A BUG.** FV-2's Done hero shows "validation healthy" and I suspected a faked-healthy after force-accept. Checked the canonical `task.md`: it carries a REAL reviewer approve verdict (`result: approve`, `revisionId: rev_ESoWbwrOwiDU` == current rev `625773ae`, with concrete verification text — "local HEAD on fv-2 equals the pinned review revision; diff against main touches exactly one file"). `deriveValidation` → "healthy" is therefore correct. What happened: after the out-of-band merge + "Move to Review", the operator auto-engaged the reviewer (Balanced: summon=direct); it approved; my force-accept was redundant with a verdict landing ~concurrently. The only *light* residue: the force-accept DIALOG read "Verdict: awaiting verdict" a beat before the verdict propagated to the acceptability check — a timing snapshot, not a false state. Disposition: consistent.
- **UXO-3** Board with a single Done task shows "1 task" in the header while the three visible columns (Triage/Ready/In Progress) all read "No tasks" — Done/Review are off-screen right (horizontal scroll). Momentary "where's my task?" for a narrow viewport. Minor.
- **Positives (coherence holds):** Policy page cleanly separates "Human access · RBAC" from "agent capability … two surfaces, managed separately" (sanctioned copy, no "govern"); accept & force-accept dialogs state exactly what will happen (PR # → main, revision, verdict, one-way); operator narration is honest on out-of-band merges; per-agent MCP scoping is correct.
