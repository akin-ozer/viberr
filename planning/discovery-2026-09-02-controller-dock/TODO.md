# Implementation checklist (every box is closed only after code + test + browser proof)

## A. Data and conversations
- [x] A1 `db/migrations/0001_baseline.sql`: `controller_conversations.task_key` + CHECK; `controller_messages.surface`; index `(user_id, project_slug, task_key, last_message_at)`
- [x] A2 `controller-conversations.server.ts`: `taskKey` on the row type, `createConversation`, `listConversations` filter, `appendMessage({ surface })`, `ControllerMessage.surface`
- [x] A3 tests for A1/A2

## B. Context read and turn
- [x] B1 `controller-context.server.ts`: `gatherControllerContext` (task / board / instance), budgets, the timeline prefix cut, the surface hint
- [x] B2 `controller-run.server.ts`: `surface` input, context block prepended to the turn prompt, task binding in the system prompt, `taskKey` through `buildControllerMounts`
- [x] B3 tests for B1/B2

## C. Toolkit and doctrine
- [x] C1 `controller-toolkit.server.ts`: `taskKey` binding, `keyOf`, optional `taskKey` on the task tools, `update_task`, `whoami.conversationTask`, instructions text
- [x] C2 `controller.definition.md` + `controller-guide.skill.md`: context paragraph, `list_projects` → `whoami`, comment wording; `PRIOR_SHIPPED_HASHES` outgoing hashes
- [x] C3 tests for C1/C2

## D. Resource route and page routes
- [x] D1 `routes/resources.controller.ts` + `routes.ts` entry; view builder `controller-dock-query.server.ts`
- [x] D2 `routes/controller.tsx`, `routes/project.controller.tsx`: `csrfError` mapping, `surface` pass-through, task threads listed, `projectName` in the view
- [x] D3 tests for D1/D2

## E. The dock
- [x] E1 `features/controller/controller-dock-context.ts` (pure: matches → scope, hidden, surface)
- [x] E2 `features/controller/controller-dock.tsx` (trigger, panel, threads, composer, live child, session persistence, Escape/focus)
- [x] E3 `root.tsx` mount (signed-in only)
- [x] E4 `app.css` appended section (tokens and scales only; reduced motion; mobile sheet)
- [x] E5 tests for E1/E2 and the CSS pins

## F. Full page polish
- [x] F1 project name in the header, autofocus, task chip in the list, surface chip on messages
- [x] F2 Controller settings tab: one sentence about the dock
- [x] F3 `controller-page.test.tsx`

## G. Docs
- [x] G1 `decisions.md` ruling 121 + route map
- [x] G2 `controller-and-goals.md` §2, §3, §4, §9
- [x] G3 `surfaces.md` route table, §2 shell, §4 screen labels
- [x] G4 `data-model.md`, `codebase-map.md`, `glossary.md`, `requirements-status.md`, `README.md`

## H. Gates and proof
- [x] H1 `npm run lint && npm run typecheck && npm test && npm run build`
- [x] H2 browser validation matrix in `TESTPLAN.md` with screenshots saved under `screenshots/`
- [x] H3 `e2e/08-controller-dock.spec.ts` and `npm run e2e` (Docker)
- [x] H4 canary every new test once (revert the fix, see red)
