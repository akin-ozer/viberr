# Pass 25 — Codex/Claude parity & capability display-vs-runtime coherence audit

Baseline: main `7cf113a` (PR #200 merged, pass-24 complete). Worktree branch `fix/pass25-discovery`.

Scope: THEME 1 (backend parity — does one backend silently do/omit something the other doesn't, in
a way that misleads the admin or changes governance behavior) and THEME 2 (capability display-vs-
runtime coherence — does a display surface assert a mode the runtime doesn't apply, per backend).

Read first (per instructions), not re-reported: `planning/discovery-2026-08-22-pass24/FINDINGS-MASTER.md`
(A-1/A-2 materialization fix, B-1..B-6 parity fixes — all verified fixed in current code, see "Verified
still fixed" section below) and `planning/discovery-2026-08-21-pass23/AREAS-TO-IMPROVE.md` (A1, B1, B2).
Also excluded per explicit instruction: `capability-matrix-modal.tsx:272-276` stale "Codex operator
cannot reach web" footnote.

Severity: **HIGH** = admin misled about a security/governance boundary, or governance differs by
backend; **MEDIUM** = confusing/inert grant w/ workaround; **LOW** = polish.

## Summary

**5 HIGH, 5 MEDIUM, 1 LOW.** Headline: **Finding 8** — a Codex-backend reviewer whose
`execute-code-or-write-repo` is withheld can still write into the task's shared workspace clone (no OS
sandbox since R22), and the server's own delivery finalization (`git add -A` + auto-commit) ships
whatever is in that shared tree regardless of which engagement wrote it — the disclosed R22 mitigation
("the server-owned delivery gate is the real boundary") does not actually check for this, so an agent an
admin explicitly configured read-only can have its edits merged into the reviewed PR, Codex-only.

- **F1 [HIGH]** Profile-detail page (`agents-page.tsx` `CapColumn`) shows every capability grant with
  zero Codex-enforcement-scope caveat — the matrix and editor both have it, the detail page (the surface
  most admins land on) doesn't.
- **F2 [MEDIUM]** Policy page's per-profile "N direct" counts are backend-blind by construction
  (`MatrixProfile` type drops `backends` even though the full roster data is loaded).
- **F3 [HIGH]** MCP "auth: configured" status and the credential-entry note are backend-blind: true for
  Claude-consuming runs only, silently unauthenticated for Codex-consuming runs, disclosed nowhere at
  config/list/grant time (only in generic matrix prose).
- **F4 [MEDIUM]** Browser-capability persona text ("take screenshots") is backend-identical even though
  Codex tool results never carry the screenshot image back to the model — the one asymmetry the matrix's
  "what differs" list omits.
- **F5 [HIGH]** The Codex operator's default-branch read never refreshes and carries no staleness
  caveat, while the Claude operator's re-fetches every call and self-discloses staleness — undermines the
  exact VIB-7/F21-21 mechanism this tool exists for, asymmetrically by backend.
- **F6 [MEDIUM]** `flag_context_conflict` (the R19-2 KB-vs-repo governance signal) exists only on the
  Claude operator toolkit; a Codex operator holding the identical `append-typed-events` grant has no
  equivalent action.
- **F7 [MEDIUM]** A denied/no-op operator turn is unconditionally narrated on the timeline on Codex
  (`narrateRefusedActions`) but only narrated on Claude if the model itself chooses to comment — same
  policy config, structurally different transparency by backend.
- **F8 [HIGH]** (headline, see above) Shared-workspace cross-engagement contamination: a Codex reviewer's
  writes can ship through server-side delivery finalization despite a withheld repo-write grant.
- **F9 [HIGH]** Codex's credential-less MCP pre-flight (pass-24 B-4) writes back to the single,
  backend-agnostic `org_mcp_servers.up` row — a stdio server that requires its credential just to start
  gets flipped to globally "down" by the first Codex run against it, corrupting the health Claude runs
  and the org Settings page report for a server that works fine on Claude.
- **F10 [MEDIUM]** The per-run "Run inputs" console line ("denied by its capability grants: …") is
  identical regardless of backend, so a Codex run's own audit trail claims tool-layer enforcement that
  never actually happened on that backend.
- **F11 [LOW]** Codex final-reply JSON-envelope detection (`parseAgentOutcomeJson`) runs unconditionally
  on every finished Codex run, not gated on whether an envelope was ever requested for that
  engagement — a plain developer's prose reply that happens to be a bare JSON object with a
  `summary`-shaped field gets silently truncated to just that field. No Claude equivalent (replies are
  never regex/JSON-reinterpreted there).

---

## Verified still fixed (sanity-checked before hunting for new gaps — not findings)

- A-1/A-2 (`app/features/agents/agents-query.server.ts:277-379`, `effectiveProfileView`): every catalog
  capability of a profile's kind is now materialized at its runtime-effective absent mode (operator
  coordination caps → `off`; `deliver-review-pr`/`update-task-branch` → the delivery-gate mode; specialist
  grant-required caps → `off`, else catalog default). Confirmed the matrix, profile detail, and policy
  counts all read through this one function — no drift found in this pass.
- B-1 (pass 23's B1, the EDITOR's missing enforcement-scope tag): now present —
  `create-profile-modal.tsx:765` (`capabilityEnforcement(capDef.id) === "claude-only"`) tags rows
  "advisory on Codex" / "inert on Codex" (read-github-api) when the profile's pinned backend is Codex.
- Pass-24 B-1..B-6 (Codex operator scratch-dir, web-grant honoring, `read_default_branch_file`
  genericization, stdio-MCP credential preflight, unauthorized-verdict logging, null plan-step
  narration): spot-checked each in `operator-run.server.ts` / `codex-runtime.server.ts` /
  `specialist-mcp.server.ts` — all present in current code.

---

## FINDING 1 [HIGH] Profile-detail page shows capability grants with zero Codex-enforcement-scope disclosure — the one surface that DOES have it (matrix) is a separate click away

**Where:** `app/features/agents/agents-page.tsx` — `ProfileDetail` (function starts `:601`), the
"Capability policy" panel `:762-825`, rendered through `CapColumn` (`:233-257`).

**Symptom:** `CapColumn` renders each governed capability as a bare label:
```tsx
// agents-page.tsx:247-253
<div className="cap-list">
  {items.map((x) => (
    <div className="cap-item" key={x}>
      <Icon name={m.icon} />
      <span>{x}</span>
    </div>
  ))}
</div>
```
No per-row scope indicator of any kind — contrast with the capability MATRIX
(`capability-matrix-modal.tsx:155-171`), which tags every `capabilityEnforcement(id) === "claude-only"`
row with a "Claude-enforced … advisory on Codex" pill, and the EDITOR (`create-profile-modal.tsx:762-782`),
which tags the same rows "advisory on Codex" / "inert on Codex" when the profile is Codex-pinned.
`ProfileDetail` receives the full `AgentProfileView` (including `backends`, used two panels below for the
"Execution backend" chips at `:855-882`) but never cross-references it against the capability columns.

**Root cause:** `capabilityEnforcement` (the single source of truth for which grants are claude-only —
`app/shared/capabilities.ts:270-296`) was wired into the matrix and the editor (post pass-23 B1 fix) but
never into `ProfileDetail`/`CapColumn`. This is the third of the four canonical display surfaces named in
this pass's mandate, and it is the one a reader lands on FIRST after clicking a profile — the matrix is a
separate modal reached by an extra click ("Capability matrix" button, `agents-page.tsx:1438` or the
Policy page's own button).

**Failure scenario:** A Developer profile is pinned to Codex (`backends: ["codex"]`) with
`execute-code-or-write-repo`, `create-task-branch`, `commit-push-branch`, `open-review-pr` all withheld
(`off`) — the admin's intent: "this Codex-backed agent must be read-only." They open Agents → the
profile → the Capability policy panel and see these four rows correctly under the "forbidden"/"off"
side, with no caveat. Per `app/shared/capabilities.ts:260-283` (`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`,
R22) and `app/server/tasks/specialist-tool-policy.ts:20-27`, tool-denial for these caps binds on Claude
via the SDK's deny rules but is **advisory only on Codex** (no OS sandbox since R22; "the server-owned
delivery gate is the real boundary" — which blocks the PUSH/PR, not local file writes or shell commands).
The admin reading the profile-detail page has no way to learn that the withholding they just verified does
not actually confine the Codex run at the tool layer — they would have to separately open the matrix (a
different surface, reached by a button click most admins auditing "what can THIS agent do" won't take)
to see the same information. This is exactly the recurring F15-20/BUG-1/pass-24-A1 class the mandate
names, on the one surface pass 24 didn't touch.

**Fix direction:** In `CapColumn` (or `ProfileDetail`, which already has `a.backends`), thread
`capabilityEnforcement(capId)` + the profile's primary backend through, and render the same
"advisory on Codex" / "inert on Codex" pill next to any governed row that is claude-only AND the
profile's primary backend is Codex — reusing the editor's exact tag/title copy so the three surfaces
never drift in wording.

---

## FINDING 2 [MEDIUM] Policy page's per-profile capability counts are backend-blind by construction — the type feeding it drops `backends` even though the full data is loaded

**Where:** `app/features/policy/policy-page.tsx` — `AgentCapability` (`:267-388`), consuming
`PcapProfile = MatrixProfile & { role: string }` (`:18`); `MatrixProfile` is defined at
`app/features/agents/agent-types.ts:155-158`:
```ts
export type MatrixProfile = Pick<
  AgentProfileView,
  "id" | "kind" | "name" | "icon" | "actions"
>;
```

**Symptom:** The Policy page's "Agent capability" panel renders, per profile, only aggregate
`N direct / N recommend / N human` counts (`policy-page.tsx:305-378`) with no backend badge and no
enforcement-scope note anywhere in the row. `grep` confirms zero references to `capabilityEnforcement`,
`claude-only`, or `backend` in the whole file.

**Root cause:** Not a data-availability gap — `policy-query.server.ts:103` already loads
`assembleAgentRoster(...)`, the FULL `AgentProfileView[]` (with `backends`), for `PolicyViewData.profiles`.
The `Pick<...>` in `MatrixProfile` is what discards `backends` before the component ever sees it; the
matrix modal (which reuses `MatrixProfile` too) sidesteps this because its "Claude-enforced" tag is
rendered per-ROW (capability), not per-profile, so it never needed the field. The Policy panel's counts
are per-PROFILE, so the same trick doesn't apply — it would need to actually know each profile's backend.

**Failure scenario:** An admin comparing two identically-configured Developer profiles on the Policy
page — one pinned to Claude, one to Codex — sees the same "N direct" count for both, with nothing to
tell them that some of the "direct" grants making up that count (the repo-write family) bind on one and
are advisory on the other. Unlike Finding 1, there's a mitigating path: the same panel's "Capability
matrix" button (`:377`) opens the modal, which DOES disclose this — so an attentive admin can find the
truth one click away, same as the profile-detail gap but with a lower-stakes aggregate (a count, not a
specific "acts directly"/"forbidden" claim).

**Fix direction:** Either (a) widen `MatrixProfile` (or add a policy-specific type) to carry `backends`
and show a small backend chip + "N advisory on Codex" sub-count per profile row, or (b) at minimum split
the count into governed-and-both-enforced vs governed-but-claude-only so the two Developer profiles in
the scenario above render visibly different numbers. Cheapest fix: reuse `capabilityEnforcement` per
grant when building `direct`/`recommend`/`human` server-side (or client-side, since the labels are
already resolved to display strings and would need id-mapping back — consider computing the split in
`effectiveProfileView` alongside `actions` so policy-page.tsx stays a pure renderer).

---

## FINDING 3 [HIGH] MCP "auth: configured" and the credential-entry disclosure are backend-blind: true for Claude-consuming runs only, silently unauthenticated for Codex-consuming runs, with no caveat anywhere an admin actually configures or grants the server

**Where:**
- Runtime truth: `app/server/runtimes/codex-runtime.server.ts:158-171` (`codexMcpServers`) —
  ```ts
  // F7-MCP1 credential scope: resolveSpecialistMcpServers injects the decrypted
  // token as `headers.Authorization` (HTTP) / `env.MCP_CREDENTIAL` (stdio).
  // Those are DELIBERATELY NOT carried onto Codex: the codex SDK passes this
  // config to the CLI as `--config key=value` argv, so a literal secret here
  // would be visible in `ps auxww` ... So a credentialed org MCP authenticates
  // on Claude runs only; on Codex it connects unauthenticated.
  ```
- Config-time display: `app/features/org-settings/resource-modals.tsx:335-341` — the credential
  field's only disclosure is "Encrypted at rest and injected only into the agent run (Authorization
  header or MCP_CREDENTIAL env). Never shown again, and never in task timelines, comments, or audit
  records." — stated as a universal fact about "the agent run," no backend qualifier.
- List-time display: `app/features/org-settings/resource-rows.tsx:247-251` — a credentialed, healthy
  server's row reads `· auth: configured` unconditionally:
  ```tsx
  {m.hasCred
    ? m.credUnreadable
      ? " · auth: unreadable (rotate the encryption key or re-enter the credential)"
      : " · auth: configured"
    : ""}
  ```
- Grant-time display: `app/features/agents/create-profile-modal.tsx:920-956` (the MCP resource picker
  in the profile editor) — each server is a bare chip (`{it.id}`), no credential/backend metadata at all,
  even though this is the exact moment an admin decides to grant this specific server to a
  Codex-pinned or Claude-pinned profile.

**Symptom:** The literal string "auth: configured" appears on the org resources list for ANY
credentialed, healthy MCP server, regardless of which backend will ultimately consume it — but per
the code comment above, that claim is true only for the Claude-backend consumers of the server; every
Codex-backend run connects to the same server **unauthenticated**, silently (the server itself may
reject unauthenticated calls, or — if it permits partial anonymous access — may hand back
data/behavior the admin did not intend to expose without a credential).

**Root cause:** The credential-required/backend-asymmetry is disclosed exactly ONCE in the whole
product: the capability matrix's generic "what differs between the two runtimes" prose
(`capability-matrix-modal.tsx:237-240`), which is not tied to any specific server, not shown at the
point of typing the credential, not shown at the point of listing configured servers, and not shown at
the point of granting the server to a profile. This is the same class of bug the codebase already fixed
once in this exact file for a different failure mode — the comment immediately above the "auth:
configured" line (`resource-rows.tsx:239-245`, A9/F17) explains that a credential that silently failed
to DECRYPT used to read "auth: configured" too, and was fixed to say "auth: unreadable" instead. The
Codex-argv-drop case is the same dishonesty, just caused by which BACKEND consumes it instead of a
decrypt failure, and it's unconditional (100% of Codex runs against this server) rather than an edge case.

**Failure scenario:** An admin configures a credentialed MCP server (e.g., an internal API), sees "auth:
configured" on the org Resources page, and grants it to a Codex-pinned specialist expecting authenticated
access — reasonably, since nothing on the config screen, the list row, or the grant screen mentions a
backend distinction (only the browser MCP get a per-backend note anywhere near it, and this isn't it).
Every tool call that profile makes against the server on Codex runs unauthenticated. Best case the
server 401s and the run reports confusing tool failures attributed to something else; worst case the
server permits some unauthenticated operations and the admin has unknowingly given a Codex agent
whatever an anonymous caller can reach — the opposite of what "auth: configured" told them.

**Fix direction:** (1) In `resource-rows.tsx`, when a credentialed server has been deployed to (or is
deployable by) any Codex-pinned profile, append the same honest caveat the matrix already has:
"auth: configured · Claude runs only — Codex mounts this server unauthenticated." (2) In
`resource-modals.tsx`'s credential note, add one sentence: "On a Codex-backend agent this credential
never reaches the server — Codex mounts it unauthenticated." (3) In the profile editor's MCP resource
chips (`create-profile-modal.tsx`), when `backend === "codex"` and the chip's server `hasCred`, tag it
the same way the capability rows already are (`codexAdvisory`/`codexInert` pattern at
`create-profile-modal.tsx:762-780` is the template to follow) — the editor already has both the
per-server `hasCred` data (via `resCatalog`) and the pinned backend in scope.

---

## FINDING 4 [MEDIUM] Browser-capability persona text is backend-identical ("take screenshots") even though Codex tool results never carry the image back to the model — the one Claude/Codex behavioral asymmetry the matrix's "what differs" list does NOT mention

**Where:**
- Runtime: `app/server/tasks/specialist-browser-mcp.server.ts:100-117` (`resolveBrowserMcp`) —
  ```ts
  /**
   * ... `backend` decides whether screenshots also flow back to the MODEL as
   * image tool-results — Claude's SDK renders them (the agent can see the
   * page); on Codex they are omitted, because image content blocks in MCP
   * tool results are unproven on the codex CLI ... The file lands in
   * `attachments/` either way.
   */
  ...
  ...(input.backend === "codex" ? ["--image-responses", "omit"] : []),
  ```
- Prompt: `browserPersonaSection` (`specialist-browser-mcp.server.ts:180-199`), appended identically for
  both backends (`specialist-run.server.ts:2067`) — tells the agent "Use it to view pages, exercise a
  running app, and take screenshots" and instructs it to cite the screenshot filename "when a screenshot
  backs a claim," with no backend branch anywhere in the function.
- Disclosure: the capability matrix's own "What differs between the two runtimes" list
  (`capability-matrix-modal.tsx:195-277`) enumerates skill-injection budget, mid-run comments, ask-human
  timing, MCP credential scope, MCP tool naming, and MCP-tools-ungated-by-matrix — six items — but never
  mentions the browser/screenshot asymmetry, even though `use-browser` is a real, both-backend-ENFORCED
  capability (`ENFORCED_CAPABILITY_IDS` in `app/shared/capabilities.ts:254-257`) that a Codex profile can
  hold today.

**Symptom:** A Codex-pinned profile granted "Drive a live web browser" is told, in its own run prompt,
to take screenshots and cite them "when a screenshot backs a claim" — implying it can see and reason
about what it captured. In fact its `browser_take_screenshot` tool calls never return image content to
the model on this backend (`--image-responses omit`); the PNG lands in `attachments/` for a HUMAN to view
on the task page, but the agent itself gets no visual signal from that call (it can still reason from the
Playwright accessibility-tree/text tools, but not from the pixels it just captured).

**Root cause:** The image-suppression is a deliberate, code-commented Codex-CLI compatibility decision
("image content blocks in MCP tool results are unproven on the codex CLI") — reasonable — but unlike
every other backend asymmetry this codebase has accumulated (skill budget, comment channel, ask-human
timing, MCP credentials, MCP naming), it was never added to the one place the product collects and
discloses these differences, and the prompt text that tells the agent HOW to use the tool was never
branched to match.

**Failure scenario:** An admin creates a Codex-pinned "Visual QA" profile, grants `use-browser` (which
correctly implies granting `use-web-search-fetch` per the browser↔egress coupling), and expects the same
visual-verification behavior the matrix's own copy for OTHER capabilities leads them to expect from a
disclosed-differences product. The Codex agent screenshots the page, cannot see it, and either
hallucinates a visual judgment from the accessibility tree alone while claiming it inspected the
screenshot, or reports it "cannot view images" — a limitation nothing in the product told the admin to
expect, and the matrix modal — the surface built specifically to carry this class of caveat — is silent
about this one.

**Fix direction:** (1) Add a bullet to the capability matrix's "what differs" list, matching the existing
tone: "A Codex agent's screenshots save for humans on the task page but never return to the model —
Codex can drive and read the page's text/accessibility tree, not see it visually; Claude can." (2) Branch
`browserPersonaSection` (or its caller) on `backend` so a Codex agent's prompt says screenshots are for
the human record, not for its own visual judgment, and stops implying otherwise.

---

## FINDING 5 [HIGH] The Codex operator's "what's on the default branch" answer never refreshes and carries no staleness caveat; the Claude operator's does both

**Where:**
- Codex instruction: `app/server/runtimes/operator-run.server.ts:2686-2691` — the operator system prompt
  tells a Codex (isolated-writable-root) operator to `git -C ${workspace.dir} show
  origin/${workspace.defaultBranch}:<path>` "it reads the tracked ref directly (**no fetch, no
  network**)."
- Claude tool: `app/server/tasks/operator-repo-read.server.ts:1-45` (`readDefaultBranchFile`, module
  docblock) — served from the PROJECT MIRROR, refreshed via `refreshProjectMirror` (credentialed) on
  every call; when the mirror is unusable it "degrades to the checkout's CLONE-TIME `origin/<default>`
  ref — read-only, no fetch — and reports `refreshed: false` so the tool's prose can say the answer may
  be slightly stale" (and the tool result text says so explicitly, `operator-toolkit.server.ts:319-321`).

**Symptom:** Pass-24 B-3 gave the Codex operator an anchored way to ask "is X on the default branch,"
closing the tool-existence gap. But the two backends' answers are not equivalent: Claude's re-fetches
from the credentialed mirror on every single call and self-reports when it had to fall back to a stale
ref; Codex's is pinned to whatever `origin/<default>` was at CLONE TIME, for the life of the task
checkout, with **no fetch ever** and no staleness caveat in the prompt or anywhere else. No other code
path fetches into this checkout in the interim (checked `repo-mirror.server.ts`,
`update-branch-operator.server.ts` — neither refreshes the operator's own tree's `origin/*` refs).

**Root cause:** The mechanism (`read_default_branch_file` / the git-show instruction) exists specifically
to stop an operator from misjudging "is this on the default branch?" from a working-tree read (F21-21,
live bug VIB-7 — a false out-of-band-merge blocking packet against a healthy flow). Pass-24 B-3 gave
Codex a mechanically-different but not behaviorally-equivalent substitute: a raw, never-refreshed local
ref read, framed with the SAME confidence ("Never claim a file, line or change is (or is not) on the
default branch from a Read/Grep/Glob of the checkout" — implying the alternative instructed above IS
reliable) as Claude's actually-fresh tool call.

**Failure scenario:** A multi-day task on a Codex-pinned operator project: day 1, the operator's task
checkout clones with `origin/main` at commit A. By day 4, `main` has advanced to commit C (other work
merged). The operator, asked to judge whether some content is "already on the default branch," runs
`git show origin/main:<path>` against its own checkout — silently reading commit A's tree, not C's — and
states an answer with the same unqualified confidence the prompt gives Claude's genuinely-fresh read. A
file added to `main` on day 2 reads as absent; a file removed on day 3 still reads as present. This is
exactly the VIB-7 failure class the whole mechanism was built to prevent, reintroduced asymmetrically:
Claude is protected, Codex is not, and nothing in the admin-facing product discloses the difference.

**Fix direction:** Either (a) have the Codex instruction also route through a fetch — e.g. `git -C
${workspace.dir} fetch origin ${workspace.defaultBranch} --quiet && git show
FETCH_HEAD:<path>` (the checkout is read-only to the AGENT, but the server already treats this tree as
long-lived and network-reachable for other purposes) so it earns the same freshness as the Claude tool,
or (b) if a no-network read is intentional for Codex, add the same staleness caveat Claude's tool carries
("this ref may be several days old; treat a stale-looking absence/presence with caution") to the prompt
text at `operator-run.server.ts:2686-2691`.

---

## FINDING 6 [MEDIUM] `flag_context_conflict` — the R19-2 "knowledge base disagrees with the repository" governance signal — exists only on Claude; a Codex operator holding the identical `append-typed-events` grant has no equivalent action

**Where:**
- Claude tool: `app/server/tasks/operator-toolkit.server.ts:374-409` (`flag_context_conflict`, gated on
  `append-typed-events`) → `operatorFlagContextConflict` (`app/server/tasks/operator-actions.server.ts:1707-1767`),
  which writes a distinct typed `quality` timeline event (`contextConflictEvent`, title "Knowledge base
  disagrees with the repository") AND fires a dedicated `notifyTaskWatchers(..., kind: "quality", ...)`
  per ruling R19-2.
- Codex plan tools: `app/server/runtimes/operator-run.server.ts:1395-1420` (`OPERATOR_PLAN_TOOLS` — the
  complete Codex structured-plan action set: `post_comment`, `open_packet`, `resolve_packet`, `set_goal`,
  `engage_agent`, `run_agent`, `prompt_agent`, `transition_stage`, `deliver_for_review`,
  `update_branch_from_base`, `accept_completion`) has no `flag_context_conflict` entry, and no other
  entry reaches `operatorFlagContextConflict`.

**Symptom:** The exact live scenario the code itself documents (`operator-actions.server.ts:1697-1702`)
— a KB-granted agent follows the knowledge base's convention where it disagrees with the repository's own
— can be raised by a Claude operator as a structured, notified `quality` flag. A Codex operator holding
the SAME `append-typed-events: direct` grant on the SAME project has no such action; its only fallback is
a generic `post_comment`, a different event kind that skips the dedicated `quality` UI treatment,
the notification, and the `task.operator.context_conflict` audit action.

**Root cause:** `append-typed-events` is a single capability grant (both-backend ENFORCED per
`app/shared/capabilities.ts:223-258`) but the CONCRETE SET of "typed events" it actually unlocks differs
per backend — Claude's toolkit and Codex's plan-tool set were built as two independently-maintained
lists, and this one action was added to one and not the other.

**Failure scenario:** An admin grants `append-typed-events` to a Codex-pinned operator, sees it render as
"Acts directly" on every display surface (matrix/detail/policy — no backend caveat exists for this
capability since it's correctly both-ENFORCED, not claude-only), and reasonably expects the same
governance behaviors that capability implies elsewhere in the product (its label is generic: "Append
typed important events"). The specific KB-vs-repo conflict signal — the one this pass's own docs cite as
a real live scenario — is simply unavailable to that operator, with no disclosure anywhere that the
capability's Codex surface is a strict subset of its Claude surface.

**Fix direction:** Add a `flag_context_conflict`-equivalent entry to `OPERATOR_PLAN_SCHEMA`/
`OPERATOR_PLAN_TOOLS` and `executeCodexPlan`'s switch, calling the same `operatorFlagContextConflict`
action Claude uses (the action function itself is already backend-agnostic — it's only the two toolkits'
exposed action lists that diverge).

---

## FINDING 7 [MEDIUM] A denied/no-op operator turn is unconditionally narrated on the timeline on Codex, but on Claude it is only narrated if the model itself chooses to say so

**Where:**
- Codex: `app/server/runtimes/operator-run.server.ts:2173` calls `narrateRefusedActions` (defined
  `:2202-2259`) unconditionally at the end of every `executeCodexPlan` run when any plan action came
  back `denied`/`noop` — it writes a `policy`/`note` timeline event naming exactly what was refused and
  why, regardless of what the model said in its own reasoning/comments.
- Claude: `app/server/tasks/operator-toolkit.server.ts:118-127` (`resultText`) returns a denied/no-op
  tool result as plain text INSIDE THE MODEL'S OWN TRANSCRIPT — `[${r.outcome}] ${r.message}` — which
  never reaches the task timeline unless the model itself decides to call `post_comment` about it. No
  Claude-side equivalent of `narrateRefusedActions` exists (confirmed: no second call site).

**Symptom:** Identical operator policy configuration (e.g., an operator with `stage-transitions: off`,
`generate-packets: off`, only `append-typed-events: direct`) produces structurally different
transparency depending on backend alone: Codex is GUARANTEED a "The operator's plan was not carried out
in full" note naming every refused step; Claude produces nothing on the timeline unless the model happens
to narrate its own refusal in prose (via `post_comment`, itself a granted-and-withholdable capability).

**Failure scenario:** An admin narrows an operator's policy down (withholding several coordination caps
for a supervised, low-autonomy project) and later asks "why did the operator do nothing this turn?" On
Codex the timeline already explains it. On Claude, if the model's turn produced no proactive commentary
about the refusal, the board just reads `waiting: agent → human` (via `settleWaitingAfterOperator`'s
stage-boundary fallback, `operator-run.server.ts:622-635`) with zero trace of what was attempted or
denied — the exact "user actively misled" pattern this pass is hunting for, except here it's an omission
that differs by backend rather than an assertion that differs.

**Fix direction:** Give the Claude path the same backstop: after a Claude operator turn ends, diff the
tool calls it attempted against what actually succeeded (the toolkit already returns `denied`/`noop`
outcomes per call) and post the same `narrateRefusedActions`-style note when the model's own turn
produced no comment about a refusal — reusing the Codex function's copy so the two backends' explanations
read identically.

---

## FINDING 8 [HIGH, headline] A capability-withheld Codex reviewer can write into the shared task workspace, and the server's own delivery finalization ships whatever is there regardless of who wrote it — the disclosed R22 mitigation does not actually cover this case

**Where — the shared, unreset workspace:**
- `app/server/tasks/specialist-run.server.ts:2384-2389` (`taskWorkspaceRoot`) and `:2397-2406`
  (`taskCloneDir`): the on-disk checkout path is derived from `<project>/<task>/workspace/<repo-name>`
  ONLY — no engagement, profile, or run-id component. Every engagement on a task (the delivering agent
  and every supporting/reviewer agent) reads and writes the literal same git working tree.
- `app/server/tasks/specialist-run.server.ts:1104-1112`: the single-flight lock that prevents two
  concurrent DELIVERING runs explicitly does not apply to supporting runs — "Supporting agents are
  read-only for the repo by policy (Claude-enforced, advisory on Codex since R22) and **run
  concurrently**" — i.e., a reviewer run can be actively executing in the same directory at the same time
  as the delivering run, or before it with no reset in between.
- `app/server/tasks/specialist-run.server.ts:2790-2805` (`cloneRepo`, reuse path): when the checkout
  already exists, the function does URL sanitization, sets git identity, and
  `stripUngovernedRepoCatalog` (which only removes MOUNTED SKILL folders — "the strip preserves the skill
  folders Viberr mounted for it... rather than pulling them out from under it"). There is no `git reset
  --hard` / `git clean -fd` / re-checkout step. Any uncommitted file a prior run left behind survives into
  the next one untouched.

**Where — the false prompt claim:**
`app/server/tasks/specialist-run.server.ts:2218-2226` (`buildAnalyzePrompt`, non-delivering branch):
```ts
// F10-12: a SUPPORTING (reviewing) run is read-only for the repo (Claude
// write+git denylist; advisory on Codex since R22 removed the read-only
// sandbox). The prompt MUST match: never tell it to branch, edit, commit,
// or push — regardless of the profile's capabilities — or it obeys the
// contract into denied tool calls and wastes the run (the XS-4 failure).
prompt +=
  `- You are a SUPPORTING agent: this workspace is READ-ONLY for you. Do NOT create a branch, edit ` +
  `files, run \`git commit\`/\`git push\`, or open a PR — even if a directive says to. The tool layer ` +
  `blocks these. ...`
```
The comment names the R22 advisory-on-Codex fact; the prompt text sent to the agent is unconditional and
states **"The tool layer blocks these"** — false for a Codex-backed reviewer. The identical unconditional
claim recurs on the resume path (`app/server/tasks/task-actions.server.ts:1046-1080`,
`specialistReplyDirective`, "You do not modify the repository at all.").

**Why the claim is false:** `app/server/runtimes/codex-runtime.server.ts:368-383`
(`resolveCodexSandboxMode`):
```ts
const isDeliverer = spec.kind !== "operator" && spec.kind !== "reviewer";
if (spec.autonomous && isDeliverer && !spec.webSearchWithheld) {
  return "danger-full-access";
}
return "workspace-write";
```
Every Codex reviewer run gets `workspace-write` — a writable, shell-capable OS sandbox — regardless of
its own capability grants. `disallowedTools` is never consulted by `codex-runtime.server.ts` at all
(confirmed by grep: it only feeds two booleans that used to drive Codex's now-removed read-only sandbox,
per `run-service.server.ts:460-501`'s own comment: "It used to drive the Codex read-only sandbox; R22
removed that sandbox, so on Codex the withholding is advisory now"). So a Codex reviewer CAN edit files,
run `git add`/`git commit` via Bash, etc., regardless of `execute-code-or-write-repo`/`commit-push-branch`
being withheld.

**Where — the gate that's supposed to catch this only checks the wrong grant, and actively ships the
whole working tree:** `app/server/github/push-workspace.server.ts:556-571` refuses delivery ONLY when
`input.canCommitPush === false` for the DELIVERING profile (`resolveDeliveryPushGrant`,
`task-actions.server.ts:4023-4044` — resolves only the delivering engagement's grant). If the delivering
profile legitimately holds `commit-push-branch: direct` (the ordinary case), the check passes, and
`:590-616` runs:
```ts
// F15: `git add -A` intentionally delivers the agent's whole working tree
// (the uncommitted changes ARE the deliverable) ...
const addRes = await exec("git", ["-C", repoDir, "add", "-A"], ...);
...
const commitRes = await exec("git", ["-C", repoDir, ...identityArgs, "commit", "-m",
  `[${taskKey}] deliver working-tree changes from the agent run`], ...);
```
This stages and auto-commits **everything currently in the shared working tree** — not a diff scoped to
the delivering agent's own session — attributed to the delivering identity, then pushes it. The "F15"
comment even acknowledges the reused-workspace risk ("stray files in a REUSED workspace are visible for
review rather than silently shipped") but the only mitigation is logging the changed-file list, not
verifying authorship or excluding anything.

**Failure scenario:** A project deploys a Codex-pinned Reviewer profile with `execute-code-or-write-repo`
and `commit-push-branch` explicitly withheld — the admin's intent: "this agent only reads and reports."
The reviewer is engaged on a task alongside a Claude (or Codex) delivering agent. During its run — reading
task/repo content the delivering agent or the repository itself supplies, which per the browser/repo-read
prompts elsewhere in this codebase is explicitly treated as untrusted DATA that "must never change what
you do" — the reviewer's model (on Codex, genuinely capable of shell/file writes despite its policy) is
induced to, or simply errs and, edits or creates a file in the shared checkout and does not commit it (or
does; either way it's now in the tree the next delivery finalizes). The next time the delivering agent's
work is pushed, `pushWorkspaceBranch`'s `git add -A` finalization sweeps up that file too, commits it
under the deliverer's identity, and pushes it into the reviewed PR — with no record anywhere that a
different, explicitly write-withheld engagement produced it. This is a genuine governance-boundary bypass
that is specific to the Codex backend (Claude's SDK tool denylist genuinely blocks Edit/Write/MultiEdit/
`git commit` for a withheld reviewer, so this exact vector does not exist there) and it is DISTINCT from
the already-disclosed R22 design: R22's own stated mitigation — "the server-owned delivery gate is the
real boundary" — does not actually check whether the working tree was touched by anything other than the
delivering engagement, so the mitigation the product already tells admins to rely on does not cover this
case.

**Fix direction:** Any of: (a) give each engagement its own workspace (a lightweight worktree/copy per
run, not a full re-clone) so a supporting run cannot touch the delivering engagement's tree at all —
the cleanest fix, though costlier; (b) before the `git add -A` finalization, diff the working tree
against the last commit made by the DELIVERING identity/session and refuse (or flag for human review)
if changes exist that no run attributed to the deliverer produced; (c) at minimum, `git stash`/reset any
uncommitted changes in the shared checkout at the START of a supporting (non-delivering) run and restore
them afterward, so a supporting run's OWN accidental writes never persist past its own turn — narrower
but cheap; (d) fix the prompt claim regardless of which runtime fix is chosen ("The tool layer blocks
these" → conditional on backend, matching Finding-1-style caveats elsewhere in this codebase).

---

## FINDING 9 [HIGH] Codex's credential-less MCP pre-flight (pass-24 B-4) writes back to the single, backend-agnostic health row — a server that requires its credential to start is flipped to globally "down" by the first Codex run, corrupting Claude's own health status

**Where:**
- `app/server/tasks/specialist-mcp.server.ts:265-296` (`verifyStdioMcpMountsForRun`) — the pass-24 B-4
  fix: pre-flights a stdio mount WITHOUT its credential when `options.backend === "codex"` (correctly
  matching what the Codex run itself receives — `codex-runtime.server.ts` drops `MCP_CREDENTIAL` to avoid
  an argv leak). On failure it calls `markMcpServerUnreachableFromRun(db, name, disc.reason)`.
- `app/server/org/resources.server.ts` (`markMcpServerUnreachableFromRun`):
  ```ts
  export function markMcpServerUnreachableFromRun(db, name, reason) {
    db.prepare(
      `UPDATE org_mcp_servers SET up = 0, tools_count = NULL, last_checked_at = ?, last_error = ?, updated_at = ? WHERE name = ?`,
    ).run(now, reason, now, name);
  }
  ```
- `db/migrations/0001_baseline.sql:297-305` — `org_mcp_servers` has one `up`/`last_error`/
  `tools_count` per server `name`. There is no per-backend row or column; the schema cannot represent
  "up for Claude, down for Codex."

**Symptom:** Any stdio MCP server whose command requires its credential just to START (a common pattern —
a CLI wrapper that reads a required env var and exits if it's absent) will ALWAYS fail this Codex
pre-flight, because B-4 deliberately withholds the credential to match the run. The very first Codex run
against such a server calls `markMcpServerUnreachableFromRun`, flipping the ONE shared `up` column to
`false` with a Codex-specific error string — even though the exact same server is completely healthy for
Claude-backed profiles (which do receive the credential).

**Root cause:** Pass-24 B-4 correctly fixed the pre-flight to match what Codex actually receives, but
didn't account for the write-back target being shared, backend-agnostic state. The fix makes the
Codex-side check honest about Codex while making its FAILURE dishonest about Claude.

**Failure scenario:** After that first Codex run: (1) the org Settings page (`listMcpServers`) now shows
this server as globally down, with a Codex-flavored `last_error`, even though it works perfectly for
Claude. (2) The next CLAUDE run's own resolution (`resolveSpecialistMcpServersDetailed`,
`specialist-mcp.server.ts:213-217`) reads `row.up === false` and appends an "its last connection check
failed — it may expose no tools" entry to THAT Claude run's disclosure and persona — a false warning about
a server that is, in that very run, about to work fine. (3) There is no auto-heal on success — a healthy
mount is left untouched (per the existing test "a healthy stdio mount and a clean disclosure are left
untouched") — so the corrupted status persists until a human manually re-tests the server in Settings.

**Fix direction:** Either (a) don't let a Codex-only pre-flight failure write the shared row at all when
the failure reason is specifically "the server needs a credential Codex never receives" (detectable: retry
the probe WITH the credential before writing `up=0`, and only downgrade the row if it ALSO fails with the
credential) or (b) add a backend dimension to the health row (`up_claude`/`up_codex`, or a
`codex_unavailable_reason` column separate from the shared `up`) so Codex's own pre-flight failure records
"unavailable on Codex specifically" without corrupting Claude's status — the second is more correct and
matches the CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS precedent of tracking per-backend truth explicitly rather
than flattening it into one field.

---

## FINDING 10 [MEDIUM] The per-run "Run inputs" console asserts tool-layer denial identically regardless of backend — a Codex run's own audit trail claims enforcement that never happened

**Where:** `app/features/runtime/runs-helpers.ts:217-227`:
```ts
rows.push({
  tag: "tools",
  text: [
    inputs.tools.toolkit.length ? `viberr tools: ${inputs.tools.toolkit.join(", ")}` : "viberr tools: none",
    inputs.tools.denied.length
      ? `denied by its capability grants: ${inputs.tools.denied.join(", ")}`
      : "no built-in tools denied",
  ].join(" · "),
});
```
`inputs.tools.denied` is populated from `resolveSpecialistDisallowedTools`/`resolveUndeployedDisallowedTools`
(`specialist-run.server.ts`, `deniedTools: disallowedTools`) — the identical list
(`Edit`, `MultiEdit`, `Write`, `NotebookEdit`, `Bash(git commit:*)`, …) regardless of which backend the run
targets, even though on Codex none of it is enforced at the tool layer (`CLAUDE_ONLY_ENFORCED_CAPABILITY_IDS`;
`codex-runtime.server.ts` never reads `disallowedTools`).

**Symptom:** This is the one disclosure surface tied to a SPECIFIC, already-happened run rather than a
profile's general policy — the "Run inputs" console exists precisely so a human can audit what one run
actually got (P19-G8/G11). Reading a Codex run's own console line, "denied by its capability grants: Edit,
MultiEdit, Write, NotebookEdit, Bash(git commit:*)" reads as a factual record of what happened in THAT
run — and is false: none of it bound.

**Failure scenario:** An admin investigating "did this Codex reviewer actually touch the repo" (e.g. after
suspecting the Finding-8 class of contamination) opens its Run Inputs console expecting an authoritative
answer and reads a list of denied tools that were, on this backend, never actually denied — the one
surface built to answer exactly this question gives the wrong answer.

**Fix direction:** Thread the run's backend into `runs-helpers.ts` and append the same
claude-only/advisory caveat the matrix and (post-B1) editor already use when the run's backend is Codex
and any denied tool is claude-only-enforced — e.g. "denied by its capability grants (Claude only —
advisory on this Codex run): Edit, MultiEdit, …".

---

## FINDING 11 [LOW] Codex JSON-envelope re-parsing runs unconditionally on every finished run, not gated on whether an envelope was ever requested for that engagement

**Where:** `app/server/tasks/task-actions.server.ts:2769-2778`:
```ts
let outcome = input.outcomeKey ? takeStagedOutcome(db, input.outcomeKey) : null;
let replyText = fullText;
if (!outcome && input.backend === "codex" && fullText) {
  const parsedEnvelope = parseAgentOutcomeJson(fullText);
  if (parsedEnvelope) {
    outcome = parsedEnvelope;
    replyText = parsedEnvelope.summary ?? null;   // full text discarded
  }
}
```
This runs for every finished Codex run, not only ones where `useEnvelopeSchema` was actually set for that
engagement (verdict/ask/evidence-granted profiles, per `specialist-run.server.ts`'s own gating logic).
`parseAgentOutcomeJson` treats any final reply that is (or fences) a bare JSON object as a candidate
envelope; if a plain, non-collaboration Codex developer's entire final message happens to be a JSON object
with a `summary`-shaped string field, its full reply text is silently replaced by just that field. No
Claude equivalent exists — Claude replies are never regex/JSON-reinterpreted post hoc. Narrow trigger
condition (the whole final message must be bare JSON), flagged for awareness rather than as a priority
item.

**Fix direction:** Gate the re-parse on whether this specific engagement had `useEnvelopeSchema` set
(the same condition `specialist-run.server.ts` used to decide whether to even tell the agent to reply in
that shape), so a plain developer's prose reply is never reinterpreted.

---

## Notes on scope

Two parallel research passes were run to cross-check for parity gaps beyond the direct-read findings:
one over `operator-run.server.ts` / `codex-runtime.server.ts` / `run-service.server.ts` /
`operator-toolkit.server.ts` / `operator-actions.server.ts` (Theme 1, operator side — Findings 5-7), one
over `specialist-run.server.ts` / `specialist-mcp.server.ts` / `specialist-browser-mcp.server.ts` /
`agent-reply.server.ts` (Theme 1, specialist side — Findings 8-11). Every finding from both passes was
independently re-verified in this file's own review before being written up here — call sites, tool-list
membership, schema definitions, and the absence of counterpart logic on the other backend were all
confirmed by direct code reads, not taken on either sub-agent's word alone. Findings 1-4 are this
session's own direct-read findings. All eleven are code-verified (exact file:line, traced call paths, not
inferred from comments alone) and are believed net-new relative to pass-24's FINDINGS-MASTER.md and
pass-23's AREAS-TO-IMPROVE.md.
