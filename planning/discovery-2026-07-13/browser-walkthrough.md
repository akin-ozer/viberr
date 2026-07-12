# Browser and Docker walkthrough

## Pre-fix runtime baseline

This section is preserved as dated diagnostic evidence from the first campaign. It does not describe
the corrected build.

- Production image built and started with Docker Compose from the then-current main.
- URL: http://127.0.0.1:5173
- Health at that time: ok; 4 projects; 14 tasks; watcher alive; Claude/Codex labelled `real` from
  credential presence. The corrected health model reports configured plus recent
  unknown/verified/degraded evidence instead.
- Existing data: Viberr Core, Deploy Pipeline, Billing Service, Viberr Live Six.
- No org GitHub connections and no MCP servers.

## Final post-fix walkthrough

The final Docker Compose image was exercised in the in-app browser at desktop and 390×844 phone
sizes. Health stayed green with 5 projects, 38 tasks, watcher active, and projection integrity
healthy. Browser logs after `2026-07-12T23:39:27Z` contained zero warning/error entries; final
Compose logs also contained no warning/error.

### Page and behavior results

1. Home reports 5 projects and uses actual non-simulated running work. The VDV card contains 24
   cases without turning project-wide decisions into a personalized count for Arda.
2. Board labels human work truthfully (`waiting on a human` versus `waiting on you`) and exposes a
   visible `org admin override` chip for Arda, who is intentionally not a VDV member.
3. Review describes the terminal contract accurately: exactly healthy validation plus all current
   reviewer approvals; repo-less work may finish, while repository work reaches Done only after a
   real merged PR.
4. VDV-8 renders the current reviewer-cycle/fingerprint state. The strict verdict and stale-cycle
   rules are validated by the focused terminal/reviewer suites, not inferred from old model prose.
5. VDV-11 shows Murat as Contributor owner with task-scoped completion authority. Selin's Viewer
   view does not gain those controls; Arda's view clearly attributes emergency org-admin authority.
6. Agents selection is URL-addressable and browser Back/Forward is covered by Playwright. Live
   roster language distinguishes running, awaiting-agent, and engaged/configured state.
7. Policy and Settings expose role-appropriate controls. Murat is also captured as Viberr Core
   Maintainer, proving permissions remain tied to the selected project rather than the highest role
   from another project.
8. Org Users/Resources/Connections, Profile, and Notifications all hydrate cleanly. The DeepWiki
   resource re-test is healthy with three tools in 1,477 ms, declares Claude+Codex support, and is
   attached to API Specialist.
9. GitHub accurately displays no bound credential. Linked PR state in Viberr remained stale; the
   external CLI matrix is the source of live remote truth and the page is not presented as a
   successful reconcile.
10. Viberr Live Six was archived through the UI. Board and Settings remained readable, mutation
    surfaces became inert/Restore-only, and Restore returned it to active state.
11. The responsive project shell works at 390×844: Board, task detail, and open navigation drawer
    were captured without the former fixed desktop rail problem.

### Final screenshot index

All paths are relative to this discovery folder under `screenshots/post-fix/`.

| Surface or state | Final evidence |
| --- | --- |
| Home | `final-home-desktop.png` |
| VDV Board | `final-board-desktop.png` |
| Review | `final-review-desktop.png` |
| Agents | `final-agents-desktop.png` |
| API Specialist + MCP | `final-agent-api-specialist-mcp-desktop.png` |
| Policy | `final-policy-desktop.png` |
| GitHub offline/no credential | `final-github-desktop.png` |
| Activity | `final-activity-desktop.png` |
| Project Settings | `final-settings-desktop.png` |
| Notifications and Profile | `final-notifications-desktop.png`, `final-profile-desktop.png` |
| Org Users, Resources, Connections | `final-org-users-desktop.png`, `final-org-resources-desktop.png`, `final-org-connections-desktop.png` |
| Real MCP probe | `final-org-resources-mcp-viewport.png` (clearest), `final-org-resources-mcp-connected-desktop.png` |
| VDV-8 review cycle | `final-task-vdv8-review-cycle-desktop.png` |
| VDV-11 contributor owner | `final-task-vdv11-contributor-owner.png` |
| VDV-11 org-admin override | `final-task-vdv11-org-admin-desktop.png` |
| VDV-11 Viewer | `final-task-vdv11-viewer.png` |
| VDV-13 stale cached merge view | `final-task-vdv13-merged-cache-desktop.png` |
| Role variants | `final-policy-project-admin-retry.png`, `final-settings-project-admin-retry.png`, `final-policy-viewer.png`, `final-policy-viberr-core-maintainer.png` |
| Archived read-only Board/Settings | `final-archive-board-readonly.png`, `final-archive-settings-readonly.png` |
| Phone Board/task/drawer | `final-board-phone-390x844.png`, `final-task-vdv11-phone-390x844.png`, `final-board-phone-nav-open.png` |
| Additional uncropped/earlier final-state variants | `final-agent-api-specialist-mcp.png`, `final-org-resources-mcp-connected.png`, `final-policy-project-admin.png`, `final-task-vdv-8-desktop.png`, `final-task-vdv-11-desktop.png`, `final-task-vdv-13-desktop.png` |

Files without the `final-` prefix and the earlier `vdv-*` names in the same directory are retained
as intermediate/baseline captures; they are not the final UI proof.

## Pre-fix captured page inventory

Screenshots were captured through the in-app browser for:

- Login.
- Home/project grid.
- Notifications overlay and Profile overlay.
- Org settings: GitHub connections, Users & access, Agent resources.
- Viberr Core: Board, VIB-142 task detail, Review queue, Agents, Policy, GitHub, Activity,
  Project settings.
- Viberr Deep Validation: New project, member roster, custom agent roster, 24-task board, VDV-2
  task/live run, and interrupt feedback.

Those first-campaign images are diagnostic evidence, not golden snapshots. Use the `final-*` index
above for the corrected build.

## High-signal pre-fix observations

These observations motivated F08–F41. Their current implementation status is tracked in the ledger;
they are not claims about the rebuilt app.

1. /notifications direct navigation produces React hydration error #418 in production. Docker UTC
   and browser Europe/Istanbul render different local clock strings. The dialog DOM remains open,
   but the captured overlay becomes blank after hydration.
2. Home reports 3 active runs and 5 decisions waiting on you. The three runs are seeded stale rows;
   the decision count is not recipient-personalized.
3. Board Waiting on me shows every human-waiting task, not tasks actionable by the current user.
4. Review says VIB-142 is waiting on your acceptance and that acceptance merges the PR. The same
   project reports no GitHub credential; the accurate product contract is accepted, merge pending.
5. Policy says task owners are acceptance authorities while its RBAC table reserves acceptance for
   maintainer+.
6. GitHub correctly presents the no-credential degraded state and accurately explains merge-pending.
7. Agents is visually rich and operational, but Profiles/Live/profile selection is local state and
   cannot be shared or restored by URL.
8. Org resources contains real KB/skill file browsing and editable profiles, but no MCP server and
   no route to deploy an existing global profile into a project.
9. Project Settings exposes stage add/reorder, while code inspection shows the workflow graph does
   not follow those changes.
10. The login layout intentionally resembles the mock but leaves most of a desktop viewport empty;
    no change is proposed until core behavior and responsive layout are evaluated together.
11. The fresh project deployed four real users and seven profiles, then accepted all 24 distinct
    task cases. New-project canonical capabilities already diverged from the current catalog (F34).
12. Creating the tasks launched 24 real Triage operator runs without a separate run action or
    visible batching guard (F35).
13. VDV-2's operator described an input-required recommendation, directly advanced two stages,
    selected an API profile for a generic Claude case, and asked it to invent work (F36/F37).
14. The VDV-2 specialist entered an empty workspace after private clone failure and spent 33 turns
    rediscovering the missing credential/tool environment (F38).
15. VDV-2 showed `operator active` after the operator run finished. Interrupt ultimately persisted,
    but its success toast preceded visible live-state convergence (F39/F40).

## Evidence boundary

The logged-in host GitHub credential was intentionally not imported into Viberr without explicit
owner confirmation. Therefore the browser walkthrough proves honest offline/degraded behavior, role
gating, terminal copy, and stale-state disclosure, but not a live in-app authenticated
checkout/reconcile/push/merge. Unit/integration tests prove that implementation contract and GitHub
CLI independently proves the remote PR states. Likewise, the baseline VDV model runs are not reused
as final provider proof: final health reported Claude and Codex configured but `unknown`, with no
recent run signal.
