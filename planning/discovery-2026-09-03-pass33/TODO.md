# Pass 33 — implementation plan

Every item is a committed todo for this pass. Nothing is deferred. Each names the finding
it closes, the files it touches, and the check that proves it.

## Band A — owner-ruled behaviour changes

### A1 · Unique task-branch names (closes F33-1, F33-5; owner answer to Q33-1)
> *"if branch previously exists, viberr creates a new one with a unique suffix"*

- Branch allocation becomes a step, not a pure function. On the first write that needs a
  branch (`ensureTaskBranch`, and the delivery path as the backstop), probe the remote for
  the canonical `taskBranchName(key)`; if the name is taken by anything that is not this
  task's own branch — an existing ref, or any PR ever opened on it — allocate
  `<key>-<n>` and persist it to `task.md` `branch:`.
- Every reader already prefers `fm.branch` (`pr-open.server.ts:390`,
  `push-workspace.server.ts:324`, `branch-sync.server.ts:274`), so the allocated name flows
  through delivery, reconcile and cleanup unchanged.
- The collision packet and `resolve_remote_collision` stay for the genuinely unowned-PR
  case; the common path stops reaching them.
- Drop the "or give this task a different branch" clause from `prAdoptionRefusalNote`
  (`pr-adoption.server.ts:118`) — it advertises an affordance that will now be automatic.
- Tests: allocation picks a free suffix; the allocated name is persisted and reused;
  delivery on an allocated branch opens a PR; a genuinely unowned OPEN PR still collides.

### A2 · Archive is irreducible for force-accept (closes F33-6; owner answer to Q33-4)
- `forceIrreducibleRefusal` gains the archived-task refusal beside the closed-PR one, so
  `acceptCompletion(force)` refuses it on every caller.
- `resolveAcceptanceAffordance` reports `terminallyBlocked: true` for an archived task, so
  the button is **withdrawn** (ruling 37's precedent), not disabled.
- Tests: force on an archived task 409s; the affordance is absent; restoring then forcing
  still works.

### A3 · Force-accept is withheld until a task has work (owner answer to Q33-2)
- The offer renders only once the task has something to accept: a run, a branch, or an
  engagement. `task-side-panels.tsx` `forceAcceptRow`.
- Tests: a brand-new triage task shows no force-accept; a task with a branch does.

## Band B — correctness defects

### B1 · Controller grants must resolve (closes F33-8)
- `save_global_agent`'s `skills` / `mcps` / `kbs` take store keys (skill folder, MCP
  registry name, KB dir) and say so; the server normalizes a recognised id instead of
  storing it, and refuses one it cannot resolve.
- `list_skills` / `list_mcp_servers` / `list_knowledge_bases` lead with the grant key.
- Fixture: the `Docs Writer` template left in the store carries three dangling grants —
  the fix must repair or reject them.
- Tests: a grant made through the tool resolves at mount time; an unknown key is refused.

### B2 · `save_global_agent` merges (closes F33-7)
- Omitted `skills` / `mcps` / `kbs` leave the stored values unchanged, matching the
  sibling `update_agent_deployment` ("only the fields you pass change").
- `list_global_agents` returns the template's current grants so an update is not blind.
- Tests: a summary-only update keeps grants and persona.

### B3 · Mentions stay inside the project (closes F33-9)
- `getMentionables` offers project members only.
- The fan-out resolves against members, and a handle that resolves to a non-member is a
  visible non-delivery for the author, reusing `ambiguousMentionNote`'s shape.
- Tests: a non-member is not offered, not notified, and the author is told.

### B4 · A closed task's engagement seats are frozen (closes F33-10)
- `removeReviewer` refuses on a terminal or archived task, the way ruling 118 froze the
  owner seat; the ✕ is withheld there.
- Tests: release on a Done task 409s; `validation` is unchanged; an open task still allows it.

### B5 · A delivery that links a PR clears the collision (closes F33-3)
- `performDelivery` / `reconcileWorkspaceDelivery` clear `github.unownedPr` and withdraw an
  open collision packet once a PR is linked on the branch, exactly as a stale push-conflict
  packet is withdrawn.
- Tests: collision packet + successful delivery ⇒ no packet, no `unownedPr`.

### B6 · A decision event states the decision, not its outcome (closes F33-2)
- `resolve_remote_collision` and `discard_branch` stop asserting the effect in the past
  tense before it is attempted; the outcome note carries the result.
- Tests: a refused remedy leaves no sentence claiming it happened.

### B7 · The refusing arm of a collision remedy does not strand (closes F33-4)
- When `resolve_remote_collision` refuses, record the same follow-up the success arm does
  (or leave `waiting` off the human).
- Tests: after a refusal the task carries a packet or a recommendation.

## Band C — UI, copy and contract

- **C1** Timeline empty state must not deny a live run (U33-1).
- **C2** A project whose repository probe fails says so where the work is — board banner and
  home card, not only the GitHub page (U33-2).
- **C3** Store-browser destination names the resource root, not "store root" (U33-3).
- **C4** `ConfirmDialog` takes and renders a `data-screen-label`; every call site names one;
  `capability-matrix-modal` and `create-profile-modal` too; `docs/ui/surfaces.md §4` lists
  them (U33-6, D33-2).
- **C5** One KB vocabulary across the three editors (U33-7).
- **C6** `InsightsPage` gets a `data-screen-label`, and §4 lists it (D33-3).
- **C7** The full controller page opens the newest thread of its scope, like the dock (U33-8).
- **C8** Project name and task prefix get an explicit save (U33-9).
- **C9** Policy page renders read-only values for roles that cannot edit (U33-4, pending Q33-3).
- **C10** Agents page: selecting a profile and pressing Edit cannot open the previous one (U33-5).

## Band D — canon and tests

- **D1** Ruling 117: ask the owner whether one was lost, then either restore it or record the
  gap in `decisions.md` so the numbering is honest (D33-1).
- **D2** Promote this pass's owner answers as rulings 122-125.
- **D3** Close the coverage gaps the inventory names, at minimum the ones this pass's defects
  sit on: `controller-dock-query.server.ts` (zero references), `get_github_state`,
  `startScheduleRunner` / `startGoalRunner` / `reconcileAllGoals` /
  `maybeReconcileGoalForTask`, `canAccessConversation` / `canReadControllerRunLog`,
  `app/shared/rbac.ts`, `requireProjectMember`, `task-mutation.server.ts`
  `notifyTaskWatchers`, `run-events.server.ts`, `claude-config.server.ts`,
  `resolveBrowserMcp` refusals on Codex, and the `noChangeWorkRefusal` branch.
- **D4** Update every `docs/` page this pass changes, in the same change.
