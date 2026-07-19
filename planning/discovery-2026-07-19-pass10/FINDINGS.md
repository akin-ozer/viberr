# Findings register

Status labels:

- **Confirmed** — reproduced in the browser, automated checks, current canonical data, or a direct implementation trace.
- **Code-confirmed** — implementation path is unambiguous; live exploitation is intentionally not attempted.
- **Hypothesis** — credible from source or UI but still needs a controlled oracle.
- **Decision** — behavior cannot be classified until the owner chooses the intended model.

Priority meanings: P0 blocks safe production use or invalidates a core governance claim; P1 can corrupt work, leak sensitive data, or silently change authority; P2 materially harms correctness/operability/UX; P3 polish or longer-term resilience.

## P0 — critical trust and governance failures

### F10-01 — specialist processes are not a security boundary

Status: **Code-confirmed**.

Claude specialists run with `bypassPermissions`; Codex specialists run with `danger-full-access`. Both execute as the same operating-system user as the Viberr web process. The task workspace and `GIT_CEILING_DIRECTORIES` limit normal Git discovery but do not prevent access to application source, canonical data, SQLite, other task workspaces, provider transcript/config roots, or other same-user-readable paths.

Evidence:

- `app/server/runtimes/claude-runtime.server.ts`
- `app/server/runtimes/codex-runtime.server.ts`
- `app/server/tasks/specialist-run.server.ts`
- `Dockerfile`

Impact: a prompt-injected, compromised, or simply mistaken agent can cross project/task boundaries or mutate/read Viberr itself. This blocks destructive security canaries on the current live data root.

Required direction: isolate every specialist run in a disposable OS/container sandbox with an allowlisted workspace mount, filtered environment, explicit network policy, resource/time limits, and no provider/server data mounts.

### F10-02 — Claude receives the full Viberr server environment

Status: **Code-confirmed**.

`createAdapters()` builds Claude's environment by spreading all of `process.env`, then passes it into the autonomous SDK. Codex has a dedicated secret-filtering function; Claude does not.

Evidence: `app/server/runtimes/runtime-registry.server.ts` and `app/server/runtimes/claude-runtime.server.ts`.

Potential exposure includes session-signing and encryption secrets, OAuth credentials, provider credentials, GitHub/runtime settings, database URLs, and unrelated deployment secrets. Do not prove this by asking the current live Claude process to print secrets. Use a disposable deployment with fake sentinels after isolation is implemented.

### F10-03 — repository capability policy is not enforceable as presented

Status: **Code-confirmed** and **browser-confirmed** for presentation.

- Claude's denylist removes Edit/Write tools and a few exact Git/GitHub command patterns, but shell redirection, scripting, `sed -i`, alternate binaries, and other mutation paths remain.
- Codex ignores the specialist `disallowedTools` list and receives full access.
- On the non-default task-branch delivery path, Review entry stages and commits the entire dirty task workspace, then pushes it, even when the profile's repository-write grant was withheld.
- The capability matrix does admit some Codex controls are advisory, but the surrounding product still presents stored grants as actual governance.

Evidence:

- `app/server/tasks/specialist-tool-policy.ts`
- `app/server/runtimes/codex-runtime.server.ts`
- `app/server/github/push-workspace.server.ts`
- [capability matrix screenshot](screenshots/10-capability-matrix.png)

Impact: a “read-only” or review profile can change repository contents and have those changes committed/pushed by Viberr. Capability-bearing profiles cannot be treated as a reliable least-privilege boundary.

## P1 — high correctness, privacy, and authority risks

### F10-04 — concurrent engagements share one mutable task workspace

Status: **Code-confirmed**.

Every real engagement for a task resolves to the same reusable Git checkout. Supporting runs are allowed concurrently and are not filesystem-read-only. Delivering and supporting agents can therefore edit one working tree and Git index at the same time, producing mixed commits, checkout conflicts, lost changes, or attribution errors.

The UI simultaneously disables all run buttons whenever any run is active, even though the server allows supporting concurrency. The product model, server behavior, and UI affordance disagree.

### F10-05 — delivering single-flight has a check/insert race

Status: **Code-confirmed**.

The service checks for an active delivering run, awaits profile/resource/MCP/workspace setup, and only later inserts the new run. SQLite has no unique invariant for one queued/running delivering run per task. Two simultaneous requests can both pass the check and launch into the shared workspace.

### F10-06 — raw logs and full provider transcripts inherit overly broad read access

Status: **Code-confirmed and browser-confirmed**; product scope is a **Decision**.

Any authenticated user can fetch `/resources/run-log` for a known run ID and can download `/resources/session-export` for a known resumable run ID. Neither route checks project membership or a transcript-specific permission. Provider sessions may contain code, tool outputs, repository metadata, agent prompts, or secrets.

This cannot be justified solely by the existing rule that authenticated users may view/comment on app-wide task surfaces. Transcript export is a materially more sensitive capability.

Related inconsistency: direct project/task pages permit app-wide reads, while Home, Review/configuration pages, and project/task SSE topics apply membership gates. Navigation, discoverability, live updates, and direct access therefore reveal different privacy models.

Pass-10 live evidence: a seeded viewer who was not a member of `Viberr Pass 10 Lab` received 403 from lab Settings and could not discover the lab from Home, but a direct PXL-1 task URL loaded its full task history, raw operator narrative, run/session controls, and export link. The same non-member could post a plain comment, labeled “app user · not in project.”

### F10-07 — editing a legacy profile can silently expand verdict authority

Status: **Code-confirmed and browser-observed**; no profile was saved.

The current Developer profile stores legacy `recommend` verdict behavior. Runtime compatibility treats that value as off for a delivering engagement. Agent query/UI coercion displays it as allowed/direct, and the editor persists governed capability inputs. Saving an unrelated description/model change can therefore turn an inert legacy verdict into a real direct grant.

There is a second mismatch around absent `execute-code-or-write-repo`: the editor can display Off, runtime leaves unspecified access available, and save-time normalization may promote it to direct because scoped delivery grants are active.

Evidence:

- `app/server/tasks/agent-outcome.server.ts`
- `app/features/agents/agents-query.server.ts`
- `app/features/agents/create-profile-modal.tsx`
- [edit profile screenshot](screenshots/08-agent-edit-modal.png)
- [capability screenshot](screenshots/10-capability-matrix.png)

Required direction: a one-time explicit migration plus a lossless editor. Reads and unrelated writes must never change authority.

### F10-08 — file-watcher retry survives failure and can poison the process

Status: **Confirmed in tests/environment**.

The full suite and an isolated watcher-file rerun both fail the same four watcher tests under repeated `EMFILE`. Retry removes the watcher from the cache and schedules re-arm work that teardown cannot reliably cancel. The process repeatedly logs re-arm/failure messages against transient or deleted roots, projection updates time out, and watcher health remains false.

The current Mac launchd soft file limit is 256, so the immediate trigger is environment-sensitive. The untracked retry lifecycle and failure behavior are still product defects.

### F10-09 — packet resolution can apply an old choice to a replacement packet

Status: **Code-confirmed**.

Packet identity and option are read before the canonical writer lock; acceptance may await a remote merge. The locked update checks only that some packet exists, not that it is the same packet with the same options. A concurrent replacement can be cleared or stamped by the stale action.

### F10-10 — tests do not fail closed against ambient real backend credentials

Status: **Confirmed by audit**.

Test setup uses `??=` for selected values but does not blank Claude/Codex credentials and CLI-auth flags. Plain `npm test` detected real backends in logs. No paid request was proven, but a unit/integration process must never inherit authority to make a real provider call unless a live-test flag is explicit.

### F10-31 — operator instructions can contradict the server-owned delivery contract

Status: **Confirmed in a bounded live Claude delivery**.

PXL-1's structural specialist prompt correctly said not to push or open a PR because Viberr delivers on human Review entry. The operator nevertheless instructed the specialist at initial assignment to commit, push, and open the PR, then asserted on a second run that Viberr had no repository delivery capability and pressured the specialist to push the existing commit. The specialist treated this as an authority/prompt-injection conflict, refused, and opened an `ask_human` packet. After the human reaffirmed the structural contract, the same operator acknowledged server-owned delivery and the flow succeeded.

Evidence: PXL-1 timeline, commit `46582143dbed29c366b69eefe838ed3870ba21cf`, PR [#76](https://github.com/akin-ozer/viberr/pull/76), and screenshots 34–38.

Impact: generated coordination text can falsely expand an agent's authority, create avoidable runs/packets, and train specialists to distrust the operator. In a less cautious model, it could bypass a legitimate safety refusal.

Required direction: generate delivery instructions from a typed, server-owned contract; reject operator actions/prompts that ask specialists to push/open/merge; show the authority source in run evidence; add both Claude and Codex conformance tests.

### F10-32 — “rework” can be satisfied without a revision

Status: **Code-confirmed**.

`hasReworkSinceLastRejection()` considers either any newer stage-transition event or a newer delivering-agent comment to be rework. A stage bounce or a comment saying no change was made can therefore allow a later approval to clear `validation: failing`, even when the reviewed commit/tree is unchanged and the original defect remains.

Evidence: `app/server/tasks/task-actions.server.ts`, especially `hasReworkSinceLastRejection()` and approval resolution.

Required direction: bind every verdict to an immutable review subject (commit SHA plus diff/tree identity); clear a rejection only after the subject changes and the required reviewer set approves the new subject.

### F10-33 — project discovery and sensitive task detail use different authorization models

Status: **Browser-confirmed**; overlaps F10-06 but changes the threat model.

The non-member viewer could not discover the lab project on Home and received 403 from its Settings route, yet a direct task URL exposed the full PXL-1 timeline, raw operator conflict, agent output, session identifier/control, and export affordance. Obscuring a project in navigation while accepting direct sensitive routes creates an object-reference disclosure pattern, even if broad task commenting was a deliberate V1 rule.

Required direction: decide task-summary, comments, run-log, and transcript policies separately. At minimum, raw logs/session export should require project membership plus a dedicated permission and every run lookup must authorize through its project/task.

## P2 — product correctness, resilience, and UX gaps

### F10-11 — review queue calls blocked or unvalidated work “waiting on acceptance”

Status: **Code-confirmed and browser-confirmed**.

The four-card queue includes failing/blocked items and a PR-less task with no validation. “Waiting on your acceptance” implies a decision is currently valid and actionable when several cards require rework, a verdict, or delivery evidence first.

Evidence: [review screenshot](screenshots/05-review-queue.png).

### F10-12 — a supporting review agent delivered repository work without task delivery linkage

Status: **Confirmed in existing pass-8 fixture; fresh reproduction intentionally not run**.

VIB-30 has no delivering engagement, branch, or PR in canonical task metadata, yet its supporting Style Reviewer report says it wrote documentation, committed/pushed `vib-30`, and opened PR #53. The operator later recommended acceptance. This is consistent with the runtime/capability weaknesses. A fresh reproduction was deliberately skipped because the pass-10 project does not provide OS/filesystem isolation and the existing fixture already proves user-visible harm.

Evidence: [task screenshot](screenshots/16-task-vib-30.png) and VIB-30 canonical task file/run report.

### F10-13 — reviewer and owner pickers offer server-invalid choices

Status: **Code-confirmed**; browser reproduction pending.

- Reviewer choices exclude already-engaged reviewing profiles but not the current delivering profile. Submission then fails as already engaged with misleading reviewer copy.
- Owner choices include viewers, while the server requires contributor-or-higher.

The UI should not offer choices it knows the server will reject; server enforcement must remain.

### F10-14 — verdict authority is implicit and poorly disclosed

Status: **Code-confirmed**; intended behavior is a **Decision**.

A non-delivering engagement with no explicit verdict grant defaults to direct verdict authority for compatibility. A generic “supporting” assignment can therefore gain acceptance veto without the profile or picker clearly saying so. This contradicts the simpler principle that verdict power is capability-granted.

### F10-15 — multi-reviewer aggregation is not specified as a durable model

Status: **Decision**.

Earlier intent favors all current reviewers approving; current storage exposes one scalar validation state with sticky failure. Required rules are missing for per-agent verdict state, new-commit invalidation, rework, disengagement, failed-then-approved ordering, and whether one later approval can clear another profile's failure.

### F10-16 — scheduled actions can be lost after being marked fired

Status: **Code-confirmed**.

A due schedule is marked fired in canonical state before detached operator enqueue/run creation. A crash or enqueue failure in between permanently loses the action. There is no claimed/started/failed/retry state.

### F10-17 — rolling session renewal headers appear to be discarded

Status: **Code-confirmed against installed auth behavior**; long-duration browser proof pending.

Better Auth is configured for rolling sessions, but the session lookup path does not request/return refresh headers. Root header propagation claims to forward headers that its loader does not supply. The database expiry may slide while the browser cookie does not.

### F10-18 — declared skill/KB identifiers can escape their roots

Status: **Code-confirmed**; exploitation intentionally deferred.

Profile resource strings are joined to skill/KB roots without containment or realpath validation. A hand-edited canonical file or crafted admin action can use traversal; recursive KB reading also needs symlink-cycle rules. Because injected content is marked trusted persona material, this crosses a prompt trust boundary.

### F10-19 — activity feed is not scannable at real history volume

Status: **Browser-confirmed**.

Full agent reports render inline in a 200-event stream. The result is extremely long, repetitive, and difficult to scan; meaningful decisions and transitions disappear among full transcripts. Reports should be summarized/collapsed with explicit expansion and stable deep links to runs.

Evidence: [activity screenshot](screenshots/14-activity.png).

### F10-20 — live-run table shows role text as “Agent” identity

Status: **Browser-confirmed**.

The first column header says Agent, but rows show role labels such as Documentation, Implementation, and Docs style review. Internal `primary`/`reviewer` labels also remain. Profile identity, task role, engagement type, and backend need distinct columns/labels.

Evidence: [live-runs screenshot](screenshots/11-agents-live-viewport.png).

### F10-21 — organization resource counts and contents are misleading

Status: **Browser-confirmed**.

Home says four global agents while Organization Resources visibly lists three because Home includes the special Operator and the Resources catalog lists specialist profiles only. Both counts are internally explainable but their labels do not disclose the different populations. A registered `notes-fixture` MCP points at an ephemeral `/private/tmp/claude-...` script. A pass-10 retest proved it healthy (one tool, 35 ms), so the issue is portability/lifecycle rather than present availability: restart or temp cleanup can silently invalidate an otherwise shared resource.

Evidence: [resources screenshot](screenshots/19-org-resources.png).

### F10-22 — fixed-stage destructive controls appear enabled

Status: **Browser-confirmed affordance; server outcome pending**.

Project Settings renders enabled Remove controls for Triage and Done even though entry/terminal stages are required/locked by the model. The server may reject the action, but a known-invalid destructive control should be disabled with the reason.

Evidence: [settings screenshot](screenshots/15-project-settings.png).

### F10-23 — documentation promises a production simulation that was removed

Status: **Confirmed**.

Root README and `.env.example` claim an automatic/built-in simulated fallback, seeded live run history, and health states that current runtime/seed no longer provide. README also points to stale file-format canon and documents incorrect OAuth callback paths. `planning/README.md` still identifies July 16 as current.

### F10-24 — project creation copy contradicts current autonomy implementation

Status: **Decision**.

New Project says completion remains human-authorized for every preset. Autonomous preset code grants the narrow operator acceptance exception, and Policy copy discloses it. See Q10-01.

### F10-25 — board movement has no keyboard-equivalent workflow

Status: **Code-confirmed accessibility gap**.

Stage movement uses drag-and-drop; List mode is read-only. Custom menu widgets also appear to lack Arrow/Home/End and roving-focus behavior. Dialog focus, mention autocomplete, reduced motion, contrast, zoom, and mobile layout still need browser/a11y validation.

### F10-26 — stale Playwright ownership assertion and no E2E CI gate

Status: **Code-confirmed**.

One E2E assertion expects an ownership action to schedule/operator-copy behavior that later implementation intentionally removed. CI runs typecheck, Vitest, and build, but not Playwright, accessibility, visual regression, lint, or coverage thresholds.

### F10-34 — viewers are shown enabled archive/delete controls

Status: **Browser-confirmed affordance; destructive actions not submitted**.

On a project where the signed-in user has viewer role, ordinary Settings fields and workflow controls are disabled, but the Archive project and Delete project buttons remain enabled and visually actionable. Server-side authorization may reject them, but destructive affordances should be hidden or disabled with the required role before confirmation UI is opened.

Evidence: direct viewer-session browser inspection. [Capture 43](screenshots/43-viewer-settings-danger-buttons.png) proves the viewer could render Settings and its workflow controls, but the lower danger area was not retained in-frame; do not use the filename as visual proof of the buttons.

### F10-35 — agent selection is not sufficiently explainable or deterministic

Status: **Confirmed as an observability gap; routing correctness remains partly a Decision**.

The operator selected the purpose-specific P10 Docs Writer for the creation task and the purpose-specific P10 Style Reviewer for review, which was correct. For the exact cleanup task it selected the generic Developer and generic Reviewer instead of the custom documentation profiles. That may be a sensible semantic distinction—deletion implementation is not prose authoring—but the product records no scored candidates, excluded profiles, workload/cost input, or stable rationale that lets an owner tell deliberate routing from fallback.

Required direction: define routing inputs and tie-breaking, record a concise selection trace, and distinguish “best semantic match” from availability/backend/cost fallback.

### F10-36 — the development server watches cloned task workspaces as application source

Status: **Confirmed in dev-server logs and code**.

The default development data root is `./data`, beneath the Vite project root, and `vite.config.ts` has no watch exclusion for it. When PXL task workspaces cloned the Viberr repository under `data/projects/.../workspace/viberr`, Vite emitted page reloads for files throughout the nested clone, detected its nested `tsconfig.json`, cleared its TypeScript cache, and forced full reloads. Viberr's own projection watcher correctly prunes `workspace/`; the separate Vite watcher does not.

Impact: normal agent checkout/work can reload the product while it is being used, invalidate development caches, multiply file watching/descriptor pressure, and make browser evidence or local debugging unstable. It likely amplifies the same low-file-limit environment that exposes F10-08, although it is not the sole proven cause of those watcher tests.

Required direction: keep runtime data/workspaces outside the application root in development and add an explicit Vite ignore for the resolved data root/task workspaces as defense in depth. Add a regression fixture proving mass workspace creation and nested `tsconfig` changes do not trigger app HMR or cache resets.

### F10-37 — the live elapsed timer is not hydration-stable

Status: **Confirmed in the browser/dev-server log and code**.

`useElapsed()` initializes React state with `Date.now()` during both server rendering and client hydration. During PXL-1, the server rendered `00:55` while the client rendered `00:56`; React reported a hydration mismatch and regenerated the subtree on the client.

Evidence: `app/features/runtime/runs-helpers.ts` and `app/features/runtime/runs-panels.tsx`.

Impact: active-run pages can flash/re-render, lose transient focus/state, pollute error monitoring, and mask other real hydration defects.

Required direction: make the initial SSR/client value deterministic—using a loader-provided render timestamp or a stable placeholder—and begin client ticking only after hydration. Test a second-boundary crossing with SSR plus hydration, not component render alone.

## P3 — clarity and longer-term operations

### F10-27 — login composition leaves most of the viewport empty

Status: **Browser-confirmed**, design intent unknown.

The login card occupies a narrow left column with a large unused right pane. This may be an intentionally restrained mock carryover, but no value or visual balance is provided at desktop width.

### F10-28 — GitHub state freshness is manual-only and weakly communicated

Status: **Confirmed and partly deliberate**.

Manual reconciliation is an explicit V1 choice, but stale cached PR state can appear current indefinitely. The UI needs a prominent last-reconciled timestamp and stale/degraded state rather than silently presenting old state.

### F10-29 — audit/run/notification retention is unbounded or capped without policy

Status: **Code/documentation-confirmed**.

Audit, provenance, and run logs lack a retention/compaction policy; notifications are capped. Operational backup requires the entire data directory plus encryption key. These are acceptable V1 constraints only if documented as explicit deployment limits.

### F10-30 — uniform generic profiles still have a parallel built-in persona source

Status: **Confirmed**.

The July 19 design says non-operator profiles should be uniform data, yet built-in definition files still override profile body/persona. This creates two authoring sources and makes a built-in profile behave differently from an equivalent custom profile.

## Current product questions

1. Keep or remove full-autonomy operator acceptance?
2. Make verdict authority explicit-only, or implicit for every supporting engagement?
3. What exact per-reviewer aggregation and invalidation rules apply?
4. Which surfaces are app-wide readable: task summary, comments, run logs, provider transcripts, SSE, review queue?
5. Should supporting agents be physically read-only, or may selected supporting profiles deliberately modify/deliver work?
6. Are workload, cost, and selection rationale still operator-routing requirements?
7. Should repository be mandatory for every new project, or may users create a non-delivery planning project like the existing Playground?
8. Must a rejected review be bound to a changed commit/diff before re-approval, and which reviewer set must approve that revision?
9. Should remote task branches be deleted after merge, retained for audit, or controlled by a project policy?
