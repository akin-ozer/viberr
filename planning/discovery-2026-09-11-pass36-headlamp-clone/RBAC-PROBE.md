# Pass 36 RBAC probe (four project roles + a non-member)

Instance http://localhost:5173 (container viberr-app-1). Probe windows 14:37-14:39Z. Script: scratchpad rbac.mjs (Playwright, one storage state per identity; CSRF token read from the React Router context). Identities: arda (org admin + project admin, the observer), maya maintainer, omar contributor, lena viewer, noah org member with no seat. Expected column = app/shared/rbac.ts. Every result matched; no RBAC finding. Omar's create-task probe created HLC-9, which became the packet/archive/schedule/force-accept fixture (NOTES).

## First run (viewer, contributor, non-member) 14:37Z


## lena (lena@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET / | 200 | Home · project selection / Good afternoon, Lena / Skip to main content V Viberr ⌘K LF Good afternoon, Lena Your agents kept working: 4 runs active across 1 project, 0 decisions waiting on you across all your pr |
| GET /projects/headlamp-clone/board | 200 | Board / Board / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/tasks/HLC-1 | 200 | Task HLC-1 / Scaffold monorepo, tooling and runtime inventory / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/review | 200 | Review queue / Review queue / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/agents | 200 | Agents / Agents / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/policy | 200 | Policy / Policy / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/github | 200 | GitHub / GitHub / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/activity | 200 | Activity / Activity / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/settings | 200 | Settings / Headlamp Clone · settings / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/controller | 200 | Controller / Controller / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /notifications | 200 | Notifications · overlay / Notifications / Notifications Everything routed to you, across all projects · all caught up All Unread Waiting on you 0 decisions Nothing is waiting on you. Everything else You |
| GET /insights | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /org/settings | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /projects/headlamp-clone/policy.data?_routes=routes/project.policy | 200 |  /  / [{"_1":2},"routes/project.policy",{"_3":4},"data",{"_5":6},"view",{"_7":8,"_9":10,"_11":12,"_13":14,"_15":16,"_17":18,"_19":20},"projectName","Headlamp Clone"," |
| POST …/tasks/HLC-1 comment | 403 | HTML page|
| POST …/tasks/HLC-1 set-task-metadata | 403 | HTML page|
| POST …/tasks/HLC-1 update-goal | 403 | HTML page|
| POST …/tasks/HLC-1 transition | 403 | HTML page|
| POST …/tasks/HLC-1 run-operator | 403 | HTML page|
| POST …/tasks/HLC-1 archive-task | 403 | HTML page|
| POST …/tasks/HLC-1 force-accept | 403 | HTML page|
| POST …/tasks/HLC-1 owner-take | 403 | HTML page|
| POST …/board create-task | 403 | HTML page|
| POST …/board rescan | 403 | HTML page|
| POST …/settings invite | 403 | HTML page|
| POST …/policy set-role | 403 | HTML page|
| POST …/policy set-guardrail | 403 | HTML page|

## omar (omar@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET / | 200 | Home · project selection / Good afternoon, Omar / Skip to main content V Viberr ⌘K OH Good afternoon, Omar Your agents kept working: 4 runs active across 1 project, 0 decisions waiting on you across all your pr |
| GET /projects/headlamp-clone/board | 200 | Board / Board / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/tasks/HLC-1 | 200 | Task HLC-1 / Scaffold monorepo, tooling and runtime inventory / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/review | 200 | Review queue / Review queue / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/agents | 200 | Agents / Agents / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/policy | 200 | Policy / Policy / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/github | 200 | GitHub / GitHub / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/activity | 200 | Activity / Activity / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/settings | 200 | Settings / Headlamp Clone · settings / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/controller | 200 | Controller / Controller / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 8 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /notifications | 200 | Notifications · overlay / Notifications / Notifications Everything routed to you, across all projects · all caught up All Unread Waiting on you 0 decisions Nothing is waiting on you. Everything else You |
| GET /insights | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /org/settings | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /projects/headlamp-clone/policy.data?_routes=routes/project.policy | 200 |  /  / [{"_1":2},"routes/project.policy",{"_3":4},"data",{"_5":6},"view",{"_7":8,"_9":10,"_11":12,"_13":14,"_15":16,"_17":18,"_19":20},"projectName","Headlamp Clone"," |
| POST …/tasks/HLC-1 comment | 200 | HTML page|
| POST …/tasks/HLC-1 set-task-metadata | 200 | HTML page|
| POST …/tasks/HLC-1 update-goal | 403 | HTML page|
| POST …/tasks/HLC-1 transition | 403 | HTML page|
| POST …/tasks/HLC-1 run-operator | 403 | HTML page|
| POST …/tasks/HLC-1 archive-task | 403 | HTML page|
| POST …/tasks/HLC-1 force-accept | 403 | HTML page|
| POST …/tasks/HLC-1 owner-take | 403 | HTML page|
| POST …/board create-task | 200 | HTML page|
| POST …/board rescan | 403 | HTML page|
| POST …/settings invite | 403 | HTML page|
| POST …/policy set-role | 403 | HTML page|
| POST …/policy set-guardrail | 403 | HTML page|

## noah (noah@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET / | 200 | Home · project selection / Good afternoon, Noah / Skip to main content V Viberr ⌘K NP Good afternoon, Noah No projects yet. Create your first project below. Create your first project A project is one board, one |
| GET /projects/headlamp-clone/board | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/tasks/HLC-1 | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/review | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/agents | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/policy | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/github | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/activity | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/settings | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /projects/headlamp-clone/controller | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| GET /notifications | 200 | Notifications · overlay / Notifications / Notifications Everything routed to you, across all projects · all caught up All Unread Waiting on you 0 decisions Nothing is waiting on you. Everything else You |
| GET /insights | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /org/settings | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /projects/headlamp-clone/policy.data?_routes=routes/project.policy | 404 |  /  / [{"_1":2},"routes/project.policy",{"_3":4},"error",["ErrorResponse",5,6,7],"No project at projects/headlamp-clone.",404,"Internal Server Error"]  |
| POST …/tasks/HLC-1 comment | 403 | HTML page|
| POST …/tasks/HLC-1 set-task-metadata | 403 | HTML page|
| POST …/tasks/HLC-1 update-goal | 403 | HTML page|
| POST …/tasks/HLC-1 transition | 403 | HTML page|
| POST …/tasks/HLC-1 run-operator | 403 | HTML page|
| POST …/tasks/HLC-1 archive-task | 403 | HTML page|
| POST …/tasks/HLC-1 force-accept | 403 | HTML page|
| POST …/tasks/HLC-1 owner-take | 403 | HTML page|
| POST …/board create-task | 403 | HTML page|
| POST …/board rescan | 403 | HTML page|
| POST …/settings invite | 403 | HTML page|
| POST …/policy set-role | 403 | HTML page|
| POST …/policy set-guardrail | 403 | HTML page|

## Second run (viewer, non-member) 14:38Z, with the error text


## lena (lena@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET /projects/headlamp-clone/tasks/HLC-1 | 200 | Task HLC-1 / Scaffold monorepo, tooling and runtime inventory / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| POST …/tasks/HLC-1 comment | 200 | HTML:  HLC-1 · Scaffold monorepo, tooling and runtime inventory · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board HLC-1 Searc |
| POST …/tasks/HLC-1 update-goal | 403 | HTML:  HLC-1 · Scaffold monorepo, tooling and runtime inventory · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board HLC-1 Searc |
| POST …/board create-task | 403 | HTML:  Board · headlamp-clone · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board Search… ⌘K LF Board 9 tasks · 1 waiting on a  |

## noah (noah@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET /projects/headlamp-clone/tasks/HLC-1 | 404 |  /  / Page not found error No project at projects/headlamp-clone. Back to home |
| POST …/tasks/HLC-1 comment | 404 | HTML: Page not found error No project at projects/headlamp-clone. Back to home  |
| POST …/tasks/HLC-1 update-goal | 404 | HTML: Page not found error No project at projects/headlamp-clone. Back to home  |
| POST …/board create-task | 404 | HTML: Page not found error No project at projects/headlamp-clone. Back to home  |

## Maintainer run 14:39Z


## maya (maya@viberr.dev)
| probe | status | screen / h1 / body head |
|---|---|---|
| GET / | 200 | Home · project selection / Good afternoon, Maya / Skip to main content V Viberr ⌘K 1 ML Good afternoon, Maya Your agents kept working: 4 runs active across 1 project, 1 decision waiting on you across all your p |
| GET /projects/headlamp-clone/board | 200 | Board / Board / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/tasks/HLC-1 | 200 | Task HLC-1 / Scaffold monorepo, tooling and runtime inventory / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/review | 200 | Review queue / Review queue / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/agents | 200 | Agents / Agents / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/policy | 200 | Policy / Policy / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/github | 200 | GitHub / GitHub / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/activity | 200 | Activity / Activity / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/settings | 200 | Settings / Headlamp Clone · settings / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /projects/headlamp-clone/controller | 200 | Controller / Controller / Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headl |
| GET /notifications | 200 | Notifications · overlay / Notifications / Notifications Everything routed to you, across all projects · 1 unread All Unread Mark all read Waiting on you 1 decision Blocked, decision needed: Operator run |
| GET /insights | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /org/settings | 403 |  /  / Error 403 error This area requires the admin role. Back to home |
| GET /projects/headlamp-clone/policy.data?_routes=routes/project.policy | 200 |  /  / [{"_1":2},"routes/project.policy",{"_3":4},"data",{"_5":6},"view",{"_7":8,"_9":10,"_11":12,"_13":14,"_15":16,"_17":18,"_19":20},"projectName","Headlamp Clone"," |
| POST …/tasks/HLC-1 comment | 200 | HTML:  HLC-1 · Scaffold monorepo, tooling and runtime inventory · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board HLC-1 Searc |
| POST …/tasks/HLC-1 set-task-metadata | 200 | HTML:  HLC-1 · Scaffold monorepo, tooling and runtime inventory · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board HLC-1 Searc |
| POST …/tasks/HLC-1 force-accept | 403 | HTML:  HLC-1 · Scaffold monorepo, tooling and runtime inventory · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board HLC-1 Searc |
| POST …/board rescan | 200 | HTML:  Board · headlamp-clone · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Board Search… ⌘K 1 ML Board 9 tasks · 1 waiting on  |
| POST …/settings invite | 403 | HTML:  Settings · headlamp-clone · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Settings Search… ⌘K 1 ML Headlamp Clone · settin |
| POST …/policy set-role | 403 | HTML:  Policy · headlamp-clone · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Policy Search… ⌘K 1 ML Policy Human access and age |
| POST …/policy set-guardrail | 403 | HTML:  Policy · headlamp-clone · Viberr Skip to main content Headlamp Clone akin-ozer/headlamp-clone · 4 members Board 9 Review queue 0 Controller Agents Policy GitHub Activity Settings V Viberr Headlamp Clone Policy Search… ⌘K 1 ML Policy Human access and age |
