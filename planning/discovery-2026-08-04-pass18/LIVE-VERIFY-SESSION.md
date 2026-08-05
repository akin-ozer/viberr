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

## UX observations (running log)
- **UXO-1** An **archived** task still shows its pre-archive status pills ("In Progress · ready · awaiting verdict") next to the "archived" pill on the task hero. Reads slightly noisy — a reader must infer these are the frozen last-state, not live. Minor; candidate for a muted "was: …" treatment. (LAB-1)
- **UXO-2 — INVESTIGATED, NOT A BUG.** FV-2's Done hero shows "validation healthy" and I suspected a faked-healthy after force-accept. Checked the canonical `task.md`: it carries a REAL reviewer approve verdict (`result: approve`, `revisionId: rev_ESoWbwrOwiDU` == current rev `625773ae`, with concrete verification text — "local HEAD on fv-2 equals the pinned review revision; diff against main touches exactly one file"). `deriveValidation` → "healthy" is therefore correct. What happened: after the out-of-band merge + "Move to Review", the operator auto-engaged the reviewer (Balanced: summon=direct); it approved; my force-accept was redundant with a verdict landing ~concurrently. The only *light* residue: the force-accept DIALOG read "Verdict: awaiting verdict" a beat before the verdict propagated to the acceptability check — a timing snapshot, not a false state. Disposition: consistent.
- **UXO-3** Board with a single Done task shows "1 task" in the header while the three visible columns (Triage/Ready/In Progress) all read "No tasks" — Done/Review are off-screen right (horizontal scroll). Momentary "where's my task?" for a narrow viewport. Minor.
- **Positives (coherence holds):** Policy page cleanly separates "Human access · RBAC" from "agent capability … two surfaces, managed separately" (sanctioned copy, no "govern"); accept & force-accept dialogs state exactly what will happen (PR # → main, revision, verdict, one-way); operator narration is honest on out-of-band merges; per-agent MCP scoping is correct.
