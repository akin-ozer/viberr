# Phase 9 fan-out plan (orchestrator note)

Launch AFTER Phase 8 lands+commits (Phase 8 owns seed.ts + migration 0006). Three parallel agents, disjoint files. Each verifies against its OWN temp data root + ephemeral PORT (never shared ./data or :5173 concurrently). Unit tests already use temp roots.

Phase-4 already created registered placeholder routes for review/agents/policy/activity/settings and overlay routes for profile/notifications, and phase-7 replaced github. So 9A/9C only REPLACE existing route-file contents — no routes.ts edit. Only 9B adds a new route (org.settings, replacing temp org.users) → 9B is the sole routes.ts editor. Only 9B edits seed.ts (org resources). Migration numbers pre-assigned. Shared CredentialCard already exists at app/features/github/credential-card.tsx (warnActions slot) — import read-only, don't edit.

## Agent 9A — Governance (agents + policy + project-settings)
Owns: app/features/agents/, app/features/policy/, app/features/project-settings/ (or settings/), route contents of project.agents.tsx / project.policy.tsx / project.settings.tsx. Migration **0007_agent_policy.sql** if needed. Builds the shared CapabilityMatrixModal INTERNALLY (used by both agents + policy). Specs: agents.md, policy.md, project-settings.md, contracts §3.2 (RBAC table), §2.5 (boundaries). Stage editor writes project.md via phase-3 writers; membership CRUD (settings) vs roles (policy) split per specs; grant-scope card reuses phase-7 CredentialCard + revalidateProjectCredential. RBAC enforce server-side.

## Agent 9B — Org admin (org-settings + kb-browser)
Owns: app/features/org-settings/, app/features/kb-browser/ (StoreBrowser), NEW app/routes/org.settings.tsx, routes.ts (add org.settings, remove/redirect org.users temp), scripts/seed.ts (org resources ONLY: KBs, MCP servers, skills, global agent-profile templates, whitelist users/domains, connections). Migration **0008_org_resources.sql**. Consumes phase-2 user-admin API (createUser/resetPassword/disable), phase-7 pat-store API (connections add/replace/default/remove) + CredentialCard. kb-browser ops are REAL fs mutations under data-root + rescan. Specs: org-settings.md, kb-browser.md.

## Agent 9C — Feeds & personal (review-queue + activity + notifications page + profile)
Owns: app/features/review/, app/features/activity/, app/features/notifications/ (extend phase-4 file with the full PAGE; bell popover already built), app/features/profile/, route contents of project.review.tsx, project.activity.tsx, and the notifications + profile routes. Migration **0009_*.sql** only if needed (notifications rows seeded in phase-3; prefs table 0004 exists). Read-mostly. RichA renderer exists (app/ui/rich-text.tsx) — reuse. Activity audit panel is minimal here; Phase 10 extends it. Specs: review-queue.md, activity.md, notifications.md, profile.md. SSE: rows/badges update live (phase-6 useLiveUpdates already in shell).

## Coordination rules for all three (put in each brief)
- Do NOT edit files outside your ownership list. routes.ts + seed.ts: only 9B.
- Migrations: use ONLY your assigned number.
- Live verify: `VIBERR_DATA_ROOT=$(mktemp -d) PORT=<pick 5200+> npm run dev` after seeding that temp root; never touch shared ./data or :5173.
- Full `npm test` on the shared tree is fine (isolated temp DBs). If another agent's in-flight file transiently breaks the suite, note it, don't fix it.
- No git commits. Write docs/build/reports/phase-9<letter>.md + one STATE.md line (STATE.md append is low-conflict; if it collides, re-append).

## After all three land
Orchestrator: run full gate (typecheck/test/build) on merged tree, resolve any STATE.md/routes.ts overlap, `npm run seed -- --reset` once centrally, live smoke each new surface, commit as "Phase 9".
