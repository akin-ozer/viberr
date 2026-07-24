# Pass 13 — implementation plan

Branch: `pass13/product-fixes` off `main` @ c7abebf.
Gates that must be green before the PR: `npm run typecheck` (tsc — **build ≠ typecheck**),
`npm run test`, `npm run build`, plus live re-verification in the browser for every
user-visible fix.

## Owner rulings (2026-07-24, AskUserQuestion)

1. **Global agent profiles → a real template library.** Keep the org-level editor, and give
   the project Agents page an explicit **"Add from library"** action that copies a template
   into the project; project creation may pick which templates to seed. No silent
   auto-deployment. (`AP-05`, `AP-02`, `AP-09`)
2. **Drop the "Lightweight · 3 stages" template.** Remove it from the create-project modal
   and the template catalog rather than remapping its stage ids. Custom boards remain
   possible through project settings, so stage-grant integrity still has to be *honest*
   (validate on save, surface stale/unknown grants) — but the shipped 3-stage preset goes.
   (`LV-01`, `AP-04`, `LV-02`)
3. **Add in-app KB authoring.** New file / edit / rename / delete inside the KB store
   browser, using the same writer path the skill editor uses. (`LV-06`)
4. **Model network egress as a capability, granted by default.** New capability covering
   `WebSearch`/`WebFetch`, enforced with real tool denial on Claude and prompt-level on
   Codex, visible in the capability matrix and revocable per profile. (`LV-18`)

## Workstreams

Ordering is by blast radius: shared contracts first, then subsystem work, then UI honesty.

### W0 — shared contracts (main context, first)
- Capability catalog change for the network capability (W6 depends on it).
- Event-type split for `policy` vs neutral notes (`LV-03`) — touched by many emitters.
- Canonical agent handle (`LV-11`) — touched by resolver, directory, composer, renderer.

### W1 — knowledge bases & MCP (the owner's focus; main context)
`KM-01..20`, `LV-06`, `LV-10`, `LV-17`, `LV-19`.
Key work: one KB identifier (dir) everywhere; injection that reports what it loaded and
warns when a grant resolves to nothing; operator MCP grants actually mounted; MCP tools
inside the capability policy; reference integrity on rename/delete; honest HTTP MCP health
with a real tools/list handshake; in-app KB file authoring.

### W2 — agent profiles & templates
`AP-01..12`, ruling 1 (template library), ruling 2 (drop Lightweight), `AP-06`
(empty grants ≠ full power), `AP-03` (`npm run seed` must not downgrade personas).

### W3 — runtime parity & isolation
`RT-01..14`, `LV-13`, `LV-14`, `LV-15`, `LV-16`.
Key work: notify @tagged humans from the *completed-run* reply path; isolate the Codex run
from the host's skills/MCP/AGENTS.md; use the read-only sandbox to enforce a withheld
repo-write grant; surface denied Codex operator actions.

### W4 — routes & UI honesty
`UI-01..58`, `LV-02`, `LV-03`, `LV-04`, `LV-05`, `LV-07`, `LV-08`, `LV-09`, `LV-12`,
`LV-20`. Largest by count, mostly independent files → good subagent territory once W0 lands.

### W5 — verification
Every fix needs: a test that fails before / passes after, a `typecheck` + full-suite run,
and — for anything user-visible — a live browser check with a screenshot, plus a live agent
run for anything that changes what a run receives.

## Rules for this pass

- No migrations, no back-compat shims: the schema and the store format may change.
- Tests may be rewritten where they enshrine the bug (several do — noted per finding).
- Nothing is closed as "deferred". Each ledger row ends as **DONE** (fixed + verified) or
  **RULED** (deliberate, with the rationale written into `FINDINGS.md`).
