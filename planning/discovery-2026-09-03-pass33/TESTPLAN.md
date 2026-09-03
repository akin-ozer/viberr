# Pass 33 — validation plan

Every fix is re-proven the way its defect was found: in the running app, not only in vitest.
`live` steps run against the host dev server on `docker-data` (port 5173) with the real
`akin-ozer/viberr` repository. `unit` steps are the canaried tests that ship with the change.

## Band A — owner-ruled behaviour

| # | proves | how | expected |
|---|---|---|---|
| V1 | ruling 122: a taken name is never taken again | unit — `branch-sync.server.test.ts` | canonical free ⇒ `vib-N`; a past PR on it ⇒ `vib-N-<4 hex>`; an existing ref ⇒ suffixed; a 403 on the PR probe ⇒ `repo` scope violation |
| V2 | ruling 122 live | live — create a task whose key already has a merged PR on GitHub (`VIB-5`; `vib-5` is the deliberate collision fixture, ruling 110) | the task takes a suffixed branch, delivers, opens a PR, and **no collision packet is ever raised** |
| V3 | ruling 122(c): both dispatch paths allocate | live — dispatch a delivering agent BY HAND (`run-agent`) on a fresh task, never letting the operator dispatch it | `task.md` `branch:` is recorded before the agent's first commit |
| V4 | ruling 123: archive is irreducible | unit + live — archive a task, press Force accept | the affordance is ABSENT; a direct POST 409s with "Restore it before accepting" |
| V5 | ruling 124: no standing force offer | unit + live — open a task created seconds ago | no Force accept in the GitHub card; a task with a branch still shows it; a blocked-packet task with no branch still shows it |

## Band B — correctness

| # | proves | how | expected |
|---|---|---|---|
| V6 | F33-8: controller grants resolve | live — ask the controller to create a template granted a skill, an MCP server and a KB | the stored `resources` hold the skill folder, the MCP name and the KB dir; the template editor shows the three real chips ON and **no** dangling chips. Re-check the `Docs Writer` fixture left in the store |
| V7 | F33-7: a partial update does not erase | live — ask the controller to change only that template's summary | persona and all three grant lists survive byte-for-byte |
| V8 | F33-9: mentions stay in-project | live — mention a non-member on a task | the picker does not offer them; no notification row; the author is told the mention reached nobody |
| V9 | F33-10: closed seats are frozen | live — release a supporting engagement on a Done task | refused; `validation` unchanged; the ✕ is absent |
| V10 | F33-3: a linked PR clears the collision | live — raise a collision on a pre-ruling-122 task, then deliver | `unownedPr` cleared, the packet withdrawn |
| V11 | F33-2: no past-tense claim | live — confirm a collision remedy that will refuse | the timeline holds the decision and the refusal, and no sentence claiming the effect happened |
| V12 | F33-4: the refusal does not strand | same run as V11 | the task carries a packet or a recommendation afterward |

## Band C — UI and contract

| # | proves | how |
|---|---|---|
| V13 | U33-1 | live — create a task, open it during the clone: the timeline says the loop has started |
| V14 | U33-2 | live — the Sandbox project (bad repo) shows the unreachable-repo signal on its board and home card |
| V15 | U33-3 | live — the store browser destination names the KB folder, not "store root" |
| V16 | D33-2 | `grep -c data-screen-label` on every dialog; the §4 list matches the tree |
| V17 | U33-7 | live — the project profile editor lists KBs by display name, like the other two editors |
| V18 | U33-8 | live — `/controller` with no `?c=` opens the newest thread of its scope |
| V19 | U33-4 / ruling 125 | live — as `vera@viberr.dev` (viewer) the Policy page shows values, no disabled buttons |
| V20 | U33-5 | live — click a roster profile then Edit immediately; the editor opens that profile |
| V21 | U33-9 | live — edit the project name, click away: nothing saves until Save is pressed |

## Gates

`npm run lint` (0 errors) · `npx tsc --noEmit -p .` · `npm test` (whole suite) · `npm run build`.
`npm run e2e` needs Docker and the container must not be running against `docker-data` at the
same time as the host dev server — stop one before the other (the writer lock refuses anyway).

## Canary rule

Every test added this pass must be shown red without its fix. A test that cannot go red is not
a gate — ruling 65's lesson, and pass 32's ("a test that reads `git show HEAD:<file>` goes
vacuous once the change is committed; assert the MECHANISM").
