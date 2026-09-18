# Pass 38 — candidates, with what was measured and what killed the dead ones

Every candidate gets: the observation, the measurement of how often it has ALREADY been
wrong on the live board, the refutation attempt, and a verdict. Confirmed ones move to
FINDINGS.md with a number.

| # | observation | measured | verdict |
|---|---|---|---|
| C1 | The controller's first two `ToolSearch` calls of a session use bare names (`select:whoami,…`) and get "No matching deferred tools found"; it then retries with the `mcp__viberr_controller__` prefix. | 8 of 40 controller runs that used ToolSearch hit the miss (14 lines); 2 of 12 reviewer runs. Cost: 2 wasted turns, ~3 s each, per affected run. | **confirmed → F38-1 (ruling 347)**: the manifest itself said `select:<name>` and listed bare names. |
| C2 | The Live-run header shows "Working · `<last tool call>`" for as long as the model THINKS after that tool answered (list_mcp_servers answered 02:02:38; header still named it at 02:03:20 while the console logged thinking lines). | 76 stretches > 20 s on 26 of the last 40 controller turns, 53 min in all, longest 138 s. | **confirmed → F38-2 (ruling 348)**. |
| L2-C1 | Lens-2: a queued run reads "agent working" on the board/hero/rail while the console says queued. | 129 queued-run timeline events on 33 tasks. | **confirmed → F38-3 (ruling 349)**. |
| L2-C2/C3/C4 | Lens-2: the Agent-logs footer disagrees with its own pill (kind-gated class arm; no arm for four classes; "stays resumable" for every person-interrupt). | 1 live operator `unavailable`; 2 of 2 person-interrupts were closures; cut-off classes 0 so far. | **confirmed → F38-4 (ruling 350)**. |
| L2-C6 | Lens-2: `create_project` stores any string as a stage colour; `slate`/`amber` draw nothing. | verified live: 2 of the shopify board's 6 dots are transparent. | **confirmed → F38-6 (ruling 352)**, LOW. |
| L1-#14 | Lens-1: the controller guide's "push a task forward with an @operator comment" starts nothing (ruling 252). | 4 of 21 controller comments on the shopify board followed it. | **confirmed → F38-5 (ruling 351)**, LOW. |
| L1-#15 | Lens-1: file leases gate the push delta only; a leased path pushed before the lease still merges. | 0 live refusals; reachable on this board (leases declared mid-flight). | **confirmed → F38-7 (ruling 353)**, LOW-MEDIUM. |
| L1-#2 | Lens-1: `retry_other_backend` / `resolve_remote_collision` consume the packet, then meet the hold. | 0 live blockedBy cases; 1 quota-hold case that scheduled the run. | **confirmed → F38-8 (ruling 354)**, LOW-MEDIUM. |
| L2-C5 | Lens-2: `holdRefusal` promises "Viberr releases it when every entry is done" beside a note saying the entry can never complete. | 0 dead entries so far; reachable on chained boards. | **confirmed → F38-9 (ruling 355)**, LOW-MEDIUM. |

## Dispositions of the sweep candidates not taken up (yet)

| # | candidate | measured | disposition |
|---|---|---|---|
| L1-#6 | A DELIVERING run whose `commit-push-branch` is withheld is told "the operator's delivery decision (or a human) publishes them"; `resolveDeliveryPushGrant` answers `grant_withheld` and a dirty tree is a delivery failure, so nothing publishes. | No deployment on this instance has ever engaged a deliverer without `commit-push-branch` (the stock reviewer profile carries `human`, but reviewers do not deliver); the sentence has not been rendered live. | OPEN — a real false sentence, latent. The honest fix is a design question for the owner: what does `commit-push-branch: human` MEAN for a deliverer (agent commits, human pushes? or nothing publishes)? Filed under questions. |
| L1-#1 / #4 | The hold gates dispatch and delivery, not stage moves (`move_task`, `move_stage`, the board) nor `update_branch_from_base`. | Not claimed as refused by any prompt; 0 live incidents. | REFUTED as a finding: no surface lies. Filed under questions (should "the words on the board become true" cover stage moves?). |
| L1-#8/#11/#21/#25 | Wording drift: MCP write tools named natively while Claude denies the mangled id; the operator definition calls a Codex-writable tree "read-only"; "treated as guidance" while the directive reaches the agent; "tools will not take" secrets is true of declared fields only. | — | LOW wording; not taken up this pass. |
| L1-#17 | "refused however it is wrapped" overclaims; bash-policy calls itself coverage, not containment. | The credential-less workspace is the fence; no live breach. | REFUTED as a lie about outcomes (the push cannot succeed); wording only. |
| L1-#16 | Declared path sets have no gate. | No prompt claims one; the controller's own text says the reviewer enforces them "as a real finding" — and on BNB-1 the reviewer did check them. | REFUTED: advisory by design and described as such. |
| L2-C7 | Bell badge count vs popover count. | Not measured. | LOW; not taken up. |
| L2-C8 | Quota display grace vs dispatch hold. | By design per the sweep. | REFUTED. |
| L2-C9 | `list_runs` omits the interrupt reason and failure class. | — | LOW; not taken up. |
| C1 (connection card) | "3 public repos" beside a private-repo token: the number is the ACCOUNT's public-repo count, not the token's reach. | 1 card. | LOW cosmetic; not taken up. |
| L2-C7 (live) | Bell badge vs popover count. | Checked live at 03:00Z: bell "40 unread", popover header "40 unread". | REFUTED live. |
| L2-C9 (measured) | `list_runs` rows carry `state` only; the console carries the failure class and the interrupt actor/reason. | 21 of the 53 errored runs on this instance carry a class (quota 8, auth 11, unavailable 2) the reply omits; 254 of 256 interrupts are restarts. | OPEN, LOW: an omission (the controller reads the log for the reason), not a false sentence. Not taken up. |
| C3 (live) | After the Integration Verifier approved BNB-1 (03:11:14Z), no operator drive ran and no acceptance recommendation was filed: the react-chain depth cap (4) was reached, ruling 258 correctly skipped the stuck packet ("the task is acceptable, so the chain reached a boundary") — and nothing else runs until ruling 330's 15-minute sweep. | 1 occurrence since the container's boot (1 of 1 depth-capped skips). The page offered "Accept completion → Done" and the review queue lists the task, so nothing was hidden or lost. | OPEN, LOW: the owner learns of an acceptable task from the "Review passed" notification and the queue, not from the operator's recommendation; the sweep files it ~15 min later. Fix shape if wanted: on the acceptable branch, file the acceptance recommendation directly (the operator's own act, without a drive) instead of waiting for the sweep. |
