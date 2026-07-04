# Sprint Change Proposal

**Date:** 2026-04-02
**Project:** viberr
**Trigger:** Implementation readiness assessment found blocking planning defects in Epic 1, Epic 2, and cross-document UX/PRD alignment.
**Mode Assumed:** Batch
**Recommended Scope Classification:** Moderate

## 1. Issue Summary

The implementation readiness review found a planning set that is close to usable but not clean enough to move into sprint planning unchanged.

The trigger issues are:
- Epic 2 is not fully independent because task-detail packet prioritization is promised before packet generation is actually introduced.
- Epic 1 has a foundational starter story with semantically weak FR ownership.
- The architecture's early bootstrap expectations for typed environment handling and baseline CI validation are not explicitly owned by the story set.
- The PRD and UX specification still disagree with the approved architecture on accessibility baseline, responsive narrow-screen scope, and readiness-state terminology.

Evidence source:
- [implementation-readiness-report-2026-04-01.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/implementation-readiness-report-2026-04-01.md)

## 2. Impact Analysis

### Epic Impact

- **Epic 1** needs a cleanup of Story 1.1 so it is treated as a true foundational prerequisite and absorbs the missing typed-environment and baseline-CI bootstrap work.
- **Epic 2** must stop claiming the packet-first part of FR32 before packet generation exists.
- **Epic 3** should explicitly own the packet-first task-detail behavior because that is where decision packets are actually introduced.
- **Epics 4 and 5** are structurally unaffected and do not require scope changes.

### Story Impact

- **Story 1.1** requires traceability and scope adjustment.
- **Story 2.4** requires scope tightening and FR reassignment.
- **Story 3.2** requires expanded FR ownership and one explicit packet-prioritization acceptance criterion.

### Artifact Conflicts

- [prd.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md) conflicts with the approved direction on:
  - accessibility baseline
  - review-first narrow-screen support
  - legacy `drifted` wording
- [ux-design-specification.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md) conflicts with the approved direction on:
  - `certainty restoration` framing
  - legacy state semantics such as `healthy`, `drifted`, and `review-ready` as if they were canonical readiness states
  - contradictory accessibility wording inside the same document
- [architecture.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/architecture.md) does not need a substantive change. It already reflects the chosen direction.

### Technical Impact

- No rollback of planning work is needed.
- No MVP reduction is needed.
- No code or deployment artifact changes are required yet.
- Sprint planning should wait until the planning artifacts are normalized and the readiness check is rerun.

## 3. Recommended Approach

### Chosen Path

**Hybrid of Option 1 and targeted artifact normalization**

- **Option 1: Direct Adjustment** is viable.
- **Option 2: Rollback** is not justified.
- **Option 3: PRD MVP Review** is unnecessary because the MVP remains intact.

### Rationale

This is a cleanup problem, not a product-redefinition problem. The scope and architecture are already coherent. The defects are concentrated in story ownership, story sequencing, and terminology drift across documents.

This path preserves momentum while removing the specific issues that would otherwise create implementation churn.

### Effort and Risk

- **Effort:** Medium
- **Risk:** Low to Medium
- **Timeline Impact:** Short delay before sprint planning, with lower downstream ambiguity

## 4. Detailed Change Proposals

### 4.1 Epics: Reframe Story 1.1 as Foundational Setup and Absorb Missing Bootstrap Work

**Artifact:** [epics.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/epics.md)

**Story:** `Story 1.1`

**OLD**

```md
### Story 1.1: Initialize Viberr from the Approved Starter Template

As a developer,
I want Viberr scaffolded from the approved React Router starter template,
So that the team can build on the validated runtime and project baseline.

**FRs implemented:** FR6, FR38
```

**NEW**

```md
### Story 1.1: Initialize Viberr Baseline Runtime, Environment, and CI Scaffold

As a developer,
I want Viberr scaffolded from the approved React Router starter and wired with typed environment handling plus baseline CI validation,
So that the team starts from the approved runtime and operational foundation before feature work begins.

**FRs implemented:** None (foundational prerequisite for Epic 1)
```

**Add / replace acceptance criteria with:**

```md
**Given** the implementation repo is being initialized
**When** the approved starter command is run
**Then** Viberr is scaffolded from `npx create-react-router@latest --template remix-run/react-router-templates/default`
**And** the resulting project uses the validated React Router Node.js baseline.

**Given** the starter project has been created
**When** baseline configuration is added
**Then** required environment variables are defined through a typed environment module
**And** the app fails clearly when required configuration is missing or invalid.

**Given** the baseline project is initialized
**When** the repository automation baseline is added
**Then** a GitHub Actions workflow validates install and build success on the default branch
**And** the workflow remains minimal enough to support later stories without prebuilding business features.

**Given** the baseline scaffold is complete
**When** the app is run and built
**Then** local startup and production build both succeed
**And** the project is ready for the remaining Epic 1 stories.
```

**Rationale**

- Removes semantically weak FR ownership from a technical prerequisite story.
- Fixes the missing bootstrap/CI gap without adding another planning-only story.
- Keeps Epic 1's technical exception contained to one explicit foundation story.

### 4.2 Epics: Move Packet-First Task Detail Ownership from Epic 2 to Epic 3

**Artifact:** [epics.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/epics.md)

**Epic coverage change**

**OLD**

```md
Epic 2 FRs covered: FR4, FR5, FR12, FR13, FR14, FR15, FR16, FR19, FR20, FR21, FR30, FR31, FR32, FR36, FR37
Epic 3 FRs covered: FR17, FR18, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR33, FR34, FR35
```

**NEW**

```md
Epic 2 FRs covered: FR4, FR5, FR12, FR13, FR14, FR15, FR16, FR19, FR20, FR21, FR30, FR31, FR36, FR37
Epic 3 FRs covered: FR17, FR18, FR22, FR23, FR24, FR25, FR26, FR27, FR28, FR29, FR32, FR33, FR34, FR35
```

**Story 2.4 OLD**

```md
**FRs implemented:** FR21, FR32, FR37

**Given** a task detail view opens
**When** the page loads
**Then** current state, execution profile slot, readiness and waiting signals, latest summary or packet region, and decision-relevant execution truth appear before deeper history and evidence areas
**And** the page prioritizes current understanding over raw chronology.

**Given** the task detail follows the active design set
**When** it renders
**Then** it uses the operator-first hierarchy from the Task Detail Decision Packet and Diagnostic Console surfaces
**And** keeps current truth above deeper context.
```

**Story 2.4 NEW**

```md
**FRs implemented:** FR21, FR37

**Given** a task detail view opens
**When** the page loads
**Then** current state, execution profile slot, readiness and waiting signals, latest summary or current intervention status, and decision-relevant execution truth appear before deeper history and evidence areas
**And** the page prioritizes current understanding over raw chronology.

**Given** the task detail follows the active design set
**When** it renders
**Then** it uses the operator-first hierarchy from the current-state and diagnostic task surfaces
**And** keeps current truth above deeper context even before packet-specific behavior is available.

**Given** normal operating conditions
**When** a task detail page loads
**Then** the initial response includes current state, latest summary context, and a bounded recent chronology slice within the defined performance target for at least 95 percent of requests
**And** older history remains available through progressive disclosure.
```

**Story 3.2 OLD**

```md
**FRs implemented:** FR18, FR24, FR33
```

**Story 3.2 NEW**

```md
**FRs implemented:** FR18, FR24, FR32, FR33
```

**Add acceptance criterion to Story 3.2**

```md
**Given** a task has an active blocking or decision packet
**When** task detail renders
**Then** the packet appears above the ongoing chronology and supporting evidence
**And** it becomes the primary intervention surface for the current task state.
```

**Rationale**

- Removes the only critical epic dependency found by readiness review.
- Keeps Epic 2 independently valuable before agent-packet behavior exists.
- Places FR32 where packet-first task-detail behavior is actually introduced.

### 4.3 PRD: Normalize Accessibility, Responsive Scope, and Legacy State Wording

**Artifact:** [prd.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md)

**Section:** technical and MVP wording

**OLD**

```md
- Tablet and narrow-screen behavior may remain functional where practical, but mobile-first layout strategy is not required.
- Formal accessibility compliance is not a primary V1 requirement.
- The interface should still avoid obviously unusable patterns for core workflows, but deeper accessibility investment can be planned later.
- Primary user intervenes on blocked or drifted tasks through operator-generated decision packets
```

**NEW**

```md
- Viberr remains desktop-first for V1. Tablet and narrow-screen layouts should support review-first access to current state, latest packet or intervention context, ownership and waiting status, and safe lightweight actions, but mobile is not a full-supervision target.
- Core workflows should meet a WCAG 2.2 AA baseline in V1. Broader accessibility work outside core workflows may still be phased later.
- Primary user intervenes on blocked or inconsistency-risk tasks through operator-generated decision packets
```

**Rationale**

- Aligns the PRD with the architecture and approved epics instead of letting accessibility and responsive behavior drift.
- Removes legacy `drifted` wording that no longer matches the chosen readiness model.

### 4.4 UX Spec: Replace Legacy State Language and `certainty restoration` Framing

**Artifact:** [ux-design-specification.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md)

**Sections requiring edits**

- Accessibility Considerations
- exception/recovery narrative using `drifted`
- Component Strategy state lists
- UX Consistency Patterns / State Semantics
- Responsive and implementation guidance sections using `certainty restoration`

**Representative OLD**

```md
Although formal accessibility compliance is not the primary V1 focus, Viberr should still define accessibility-aware visual rules because they directly support trust, readability, and operational speed.

- expresses waiting-on-human, waiting-on-agent, healthy, drifted, blocked, and review-ready states

- reinforce certainty restoration rather than adding commentary noise

A key design rule is that every custom component must improve certainty restoration.

- healthy: work is progressing normally and does not currently require intervention
- drifted: the task or branch reality has diverged from the expected governed path, but recovery is still possible
- blocked but recoverable: the system cannot safely proceed until a defined recovery decision or action is taken
- review-ready: the task has reached a state prepared for human review
- done: the task has been explicitly accepted and completed through the governed flow
```

**Representative NEW**

```md
Core workflows should meet a WCAG 2.2 AA baseline in V1 because consequential state, recovery guidance, and governance actions are part of product correctness.

- expresses waiting-on-human, waiting-on-agent, ready, input-required, inconsistency-risk, and blocked states

- reinforce operational legibility rather than adding commentary noise

A key design rule is that every custom component must improve operational legibility.

- ready: the task can safely progress under current governed conditions
- input required: the task cannot safely progress until a human provides missing or clarifying information
- inconsistency risk detected: the task, repository state, or runtime references disagree in a way that requires review before safe continuation
- blocked: the system cannot safely proceed until a defined action or decision is taken
- waiting on human and waiting on agent are secondary execution signals, not canonical readiness states
- review-ready and done remain workflow or outcome labels rather than canonical readiness states
```

**Specific UX change rules**

- Replace `drifted` with `inconsistency-risk` or `inconsistency risk detected` wherever the text is describing canonical task readiness.
- Replace `certainty restoration` with `operational legibility` or `task clarity` depending on sentence context.
- Keep `degraded continuity` as a diagnostic or execution-truth condition, not as a canonical readiness state.
- Keep review-first narrow-screen behavior, but describe it as a lower-capability responsive mode rather than a contradiction to the PRD's desktop-first stance.
- Update component state lists so Task Status Card and related semantic patterns reflect the canonical readiness model plus waiting signals.

**Rationale**

- Aligns UX language with the chosen architecture instead of preserving earlier exploration terminology.
- Prevents story, UI copy, and implementation drift around the meaning of task state.

### 4.5 Architecture: No Substantive Change Required

**Artifact:** [architecture.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/architecture.md)

**Proposal**

- No architecture rewrite is recommended.
- The architecture already reflects the approved state model, file-authoritative approach, and desktop-first/review-first responsive stance.
- The corrective work should align PRD, UX, and epics to the architecture rather than reopen architectural decisions.

## 5. Implementation Handoff

### Scope Classification

**Moderate**

This is not a feature replan, but it does require backlog and artifact correction before implementation sequencing begins.

### Handoff Recipients

- **Product Owner / Scrum Master**
  - apply the epic and story corrections in [epics.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/epics.md)
  - preserve FR coverage while cleaning story ownership
- **Product Manager / UX**
  - normalize [prd.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md) and [ux-design-specification.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md) terminology to the approved model
- **Architecture**
  - no decision changes required; only confirm the planning artifacts remain aligned after edits

### Success Criteria

- The Story 2.4 / Story 3.2 dependency is removed.
- Story 1.1 clearly owns foundational setup without muddy FR attribution.
- Typed environment setup and baseline CI validation are explicitly planned before feature stories.
- PRD, UX, and epics use the same accessibility baseline and the same readiness-state model.
- A rerun of implementation readiness no longer reports the current critical issue.

## 6. Checklist Status Summary

- **1. Understand the Trigger and Context**: [x] Done
- **2. Epic Impact Assessment**: [x] Done
- **3. Artifact Conflict and Impact Analysis**: [x] Done
- **4. Path Forward Evaluation**: [x] Done
- **5. Sprint Change Proposal Components**: [x] Done
- **6. Final Review and Handoff**: [!] Action-needed after user approval and artifact updates

## 7. Next Step

Approve this proposal, then apply the edits to:
- [epics.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/epics.md)
- [prd.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/prd.md)
- [ux-design-specification.md](/Users/akinozer/projects/viberr/_bmad-output/planning-artifacts/ux-design-specification.md)

After those edits, rerun implementation readiness before starting sprint planning.
