# Decisions and owner questions

No owner answer is inferred from silence. D1–D3 below are explicit owner answers. D4–D15 are labelled
working rulings: they made the implementation internally coherent and remain replaceable by an
explicit owner direction without being misrepresented as owner quotations.

## Asked during this pass

### D1 — task ownership and acceptance

Current enforcement requires maintainer+ for completion acceptance, while multiple UI surfaces say
the task owner is its human reviewer and acceptance authority. Decide whether a contributor owner
may accept that owned task or whether ownership copy must stop promising acceptance.

Decision: a contributor who owns the task may accept completion for that task. This is a
task-scoped authority, not a general contributor permission. UI, policy copy, action guards, packet
resolution, board/review personalization, and audit must all reflect it. The owner and enabled-user
binding is re-read at the acceptance/merge commit boundary; a loader-time grant cannot survive a
later ownership change, demotion, disable or deletion.

Status: answered by owner on 2026-07-13.

### D2 — organization admin project authority

Org admins see all projects and SSE scopes but cannot mutate a project without an explicit project
role. Decide whether this separation is intentional or whether org admins need emergency
project-admin authority.

Decision: organization admins have emergency project-admin power. They do not need an explicit
project membership to perform project-admin actions. The bypass must be visible and audited as
organization-admin authority, and loaders/controls/SSE/actions must agree. The current Better Auth
organization role is re-read at the canonical or irreversible mutation boundary, and audit records
`org_admin_override` only when that is the grant which actually committed the action.

Status: answered by owner on 2026-07-13.

### D3 — operator agent ranking

When multiple profiles match a stage, current routing mainly uses role/stage eligibility and a
Developer preference. Decide the ordering among skill, KB, MCP fit, backend availability, workload,
cost, and deterministic tie-breaks.

Decision: the intelligent operator makes the final selection. Viberr must provide it with candidate
context covering skill, knowledge-base, and MCP fit; backend availability; current workload; and
cost. Hard stage/capability eligibility still prefilters impossible candidates. Tests should verify
the operator receives accurate context and makes explainable choices, not impose a simplistic
static ordering.

Implemented scope: hard eligibility and candidate resource/backend facts remain project-specific;
current workload and observed-cost context are aggregated across the organization so the operator
does not overload an agent profile merely because its other work belongs to another project.

Durability consequence: the operator's choice receives an exact routing intent id. That same id
must bind the assignment or recommendation, persisted rationale, reviewer/primary purpose and any
launched run `sourceIntentId`. Recovery may converge a choice only from objective evidence for that
intent and task incarnation; a later unrelated run or a human fallback is not retroactive routing
proof.

Status: answered by owner on 2026-07-13.

## Working rulings applied during implementation

These choices were needed to keep the end-to-end implementation coherent. They remain explicit here
so the owner can replace one without reverse-engineering code; silence is not presented as a separate
owner answer.

### D4 — MCP credential schema

Working ruling: credentials are encrypted organization secrets referenced by explicit mappings.
HTTP uses `Header-Name=secret://org/name`; stdio uses `ENV_NAME=secret://org/name`. Connection tests
perform initialize and tools/list, so authentication/protocol failure is not called reachability.

### D5 — Claude ambient resources

Working ruling: Viberr supplies empty settings/skills/plugins/agents plus the declared MCP set. If
Claude still reports ambient skills/plugins in its init envelope, the run fails closed without
persisting their names. It does not warn-and-continue under a false isolation claim.

### D6 — archive semantics

Working ruling: an archived project is inactive, read-only history. Direct routes remain readable;
mutations and new runs are rejected, active runs stop, and Settings exposes Restore only.

### D7 — manual terminal jump

Working ruling: there is no arbitrary maintainer jump to Done. Completion is accepted only from the
governed Review stage under the terminal contract.

### D8 — project deletion identity

Working ruling: deletion purges all project-keyed operational state (runs/logs, credential bindings,
violations, notifications, provenance, old project audit, pending triggers/effects, completion and
acceptance, merge/PR-open/routing, lifecycle, and ownership-cleanup intents) so a recreated slug
starts clean. A deletion tombstone preserves the original actor/authority until purge and the stable
organization-wide deletion audit converge.

### D9 — referenced resources

Working ruling: rename/delete is blocked while a KB, skill, or MCP is referenced. The error names all
global-template, template-backed, and project-inline consumers; no silent broken deployment or
implicit cascade is allowed.

### D10 — custom stage graph

Working ruling: ordered stages and workflow edges are one atomic contract. Add/reorder/remove rewires
a deterministic adjacent-edge graph, preserves destination governance where possible, and keeps the
terminal edge locked human.

### D11 — repository terminal contract

Working ruling: a repository-backed task requires exactly healthy validation, every current reviewer
approval, a linked review PR, and a real merge before Done. Acceptance without a reachable/successful
merge records `pr.state=accepted` and stays Review/merge-pending. A healthy repo-less task may finish
directly.

Durability consequence: PR open, pinned merge and terminal completion are distinct exact intents.
Each binds the task `createdAt` incarnation and full GitHub identity; acceptance additionally binds
the immutable evidence fingerprint and original accepter/authority. Retry/boot converges an already
crossed boundary without repeating GitHub work or crediting the retrier. A repo-less full-autonomy
operator completion is recorded as explicit non-human authority rather than borrowing a user.

### D12 — simulated governance

Working ruling: simulated runs demonstrate UI/runtime flow but do not produce reviewer governance
evidence. A simulated verdict cannot satisfy required review or drive acceptance.

### D13 — organization-wide visibility

Working ruling: authenticated app users may still read boards/tasks and comment across the
organization. Protected project surfaces and governed mutations remain membership-bound, with D2's
visible org-admin emergency exception.

### D14 — seeded running sessions

Working ruling: seeded sessions may remain as labelled demo history, but live workload and active-run
counts use real non-simulated running rows only. Demo theater must not appear as current work.

### D15 — multiple reviewer contract

Working ruling: reviewers use isolated stable workspaces and exactly one structured verdict marker.
Ordinary prose and simulated results never count. Any request-changes returns to implementation; a
new evidence round invalidates old verdicts, and every currently assigned reviewer must approve.
