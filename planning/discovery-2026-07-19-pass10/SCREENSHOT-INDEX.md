# Browser screenshot index

This index was rebuilt from the files that actually exist in `screenshots/`. It intentionally excludes blank,
materially clipped, redundant/mislabeled, and referenced-but-missing captures. The audited checkout is revision
`afb22fe2cbab79169778db01d48fa4d92f519188`. Unless a row says otherwise, the capture shows the seeded
organization-admin session.

Every retained file has a `.png` filename but an actual `image/jpeg` payload. Pixel dimensions, byte sizes, and
SHA-256 digests are recorded in [EVIDENCE-MANIFEST.md](EVIDENCE-MANIFEST.md). A screenshot supports only the
visible UI claim in its row; stronger lifecycle claims are cross-checked against the canonical task files in the
manifest.

## Retained captures

| File | Capture / route | Supported visible claim |
|---|---|---|
| [01-login.png](screenshots/01-login.png) | Browser page · `/login` | Local sign-in form is present, OAuth providers are not configured, and the desktop composition leaves a large empty pane. |
| [02-home.png](screenshots/02-home.png) | Browser page · `/` | Baseline Home shows three project cards, organization/personal settings, and project counters. |
| [03-new-project-modal.png](screenshots/03-new-project-modal.png) | Browser modal · `/` | New-project inputs, workflow presets, agent-policy presets, repository requirement, and human-authorization copy are visible. |
| [04-board.png](screenshots/04-board.png) | Browser page · `/projects/viberr/board` | Board shows 34 tasks and 30 waiting on a human decision; the first columns are visible in the internal scrolling surface. |
| [05-review-queue.png](screenshots/05-review-queue.png) | Browser page · `/projects/viberr/review` | Four cards appear under “Waiting on your acceptance,” including visibly blocked/failing states. |
| [06-agents.png](screenshots/06-agents.png) | Browser page · `/projects/viberr/agents` | Agents summary and Operator profile/deployment surface are visible. |
| [07-agent-developer.png](screenshots/07-agent-developer.png) | Browser page · `/projects/viberr/agents` | Developer profile detail exposes eligible stages, resources, deployment, and capability-policy summaries. |
| [08-agent-edit-modal.png](screenshots/08-agent-edit-modal.png) | Browser modal · `/projects/viberr/agents` | The rendered Developer editor exposes backend/model, stages, and governed capability inputs; it does not by itself prove stored/runtime coercion. |
| [09-agent-new-profile-modal.png](screenshots/09-agent-new-profile-modal.png) | Browser modal · `/projects/viberr/agents` | New-profile defaults and capability inputs are visible. |
| [10-capability-matrix.png](screenshots/10-capability-matrix.png) | Browser modal · `/projects/viberr/agents` | Capability matrix distinguishes enforced and advisory controls and shows profile/action assignments. |
| [11-agents-live-viewport.png](screenshots/11-agents-live-viewport.png) | Browser viewport · `/projects/viberr/agents` | Live-runs table is legible; role-like strings appear under the “Agent” column. |
| [12a-policy-top.png](screenshots/12a-policy-top.png) | Browser viewport · `/projects/viberr/policy` | Human RBAC and agent-capability summary panels are visible together. |
| [12b-policy-rbac-matrix.png](screenshots/12b-policy-rbac-matrix.png) | Browser viewport · `/projects/viberr/policy` | Middle rows of the human RBAC action matrix are visible. |
| [12c-policy-agents-workflow.png](screenshots/12c-policy-agents-workflow.png) | Browser viewport · `/projects/viberr/policy` | App-wide human-access explanation and workflow transition rules are visible. |
| [13-github.png](screenshots/13-github.png) | Browser page · `/projects/viberr/github` | Repository connection, masked credential, scope state, linked pull requests, and manual reconcile control are visible. |
| [14-activity.png](screenshots/14-activity.png) | Browser page · `/projects/viberr/activity` | Long agent reports render inline in the activity stream and dominate the visible page. |
| [15-project-settings.png](screenshots/15-project-settings.png) | Browser page · `/projects/viberr/settings` | Project identity, workflow-stage controls, members, repository/credential settings, and stage-removal affordances are visible. |
| [16-task-vib-30.png](screenshots/16-task-vib-30.png) | Browser page · `/projects/viberr/tasks/VIB-30` | VIB-30 summary shows Review stage, operator recommendation, and current-state/permission panels. |
| [16b-task-execution-profile.png](screenshots/16b-task-execution-profile.png) | Browser viewport · `/projects/viberr/tasks/VIB-30` | Execution profile distinguishes Operator, reviewing agent, human owner, and agent logs. |
| [16c-task-timeline.png](screenshots/16c-task-timeline.png) | Browser viewport · `/projects/viberr/tasks/VIB-30` | Task timeline includes operator, agent, and human events plus the composer. |
| [17-org-general.png](screenshots/17-org-general.png) | Browser page · `/org/settings?tab=connections` | Organization GitHub-connections panel is visible. |
| [18-org-users.png](screenshots/18-org-users.png) | Browser page · `/org/settings?tab=users` | Organization users, access roles, and account actions are visible. |
| [19-org-resources.png](screenshots/19-org-resources.png) | Browser page · `/org/settings?tab=resources` | Knowledge bases, MCP servers, skills, and visible global-agent profiles are shown. |
| [20-profile.png](screenshots/20-profile.png) | Browser overlay · `/profile` | Profile identity, membership/access, preferences, and notification routing are visible. |
| [21-notifications.png](screenshots/21-notifications.png) | Browser overlay · `/notifications` | Notification groups, unread count, decisions count, and truncated notification cards are visible. |
| [30-pass10-agent-roster.png](screenshots/30-pass10-agent-roster.png) | Browser viewport · `/projects/viberr-pass-10-lab/agents` | Pass-10 project shows nine profiles and the selected P10 Docs Writer profile. |
| [31-mcp-healthy.png](screenshots/31-mcp-healthy.png) | Browser viewport · `/org/settings?tab=resources` | `notes-fixture` is visibly healthy with one tool; this probe’s toast reports 34 ms. |
| [34-delivery-contract-conflict.png](screenshots/34-delivery-contract-conflict.png) | Browser page · `/projects/viberr-pass-10-lab/tasks/PXL-1` | PXL-1 shows an in-conversation delivery-contract conflict and an open human-decision state. |
| [35-review-recommendation.png](screenshots/35-review-recommendation.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Operator recommendation to move PXL-1 to Review is visible. |
| [36-style-reviewer-selected.png](screenshots/36-style-reviewer-selected.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | P10 Style Reviewer is engaged while PXL-1 is in Review. |
| [37-healthy-review-completion-recommendation.png](screenshots/37-healthy-review-completion-recommendation.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Healthy review state and operator recommendation to accept completion are visible. |
| [38-pr76-merged-done.png](screenshots/38-pr76-merged-done.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | PXL-1 execution profile is marked task closed; PR number/merge proof comes from the task file and capture 48, not this crop alone. |
| [39-cleanup-task-form.png](screenshots/39-cleanup-task-form.png) | Narrow browser modal · `/projects/viberr-pass-10-lab/board` | New-task form visibly contains the P10 cleanup title and deletion goal. |
| [41-cleanup-completion-recommendation.png](screenshots/41-cleanup-completion-recommendation.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-2` | Operator recommendation to accept PXL-2 completion is fully legible. |
| [42-pr77-merged-tree-restored.png](screenshots/42-pr77-merged-tree-restored.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-2` | PXL-2 is visibly Done, merged, validation healthy, and task closed. The image does not independently prove repository-tree restoration. |
| [43-viewer-settings-danger-buttons.png](screenshots/43-viewer-settings-danger-buttons.png) | Browser viewport · `/projects/viberr/settings` · viewer session | A viewer can render project Settings and the workflow-stage rows. The capture does not show the lower danger-area buttons named by the file. |
| [44-viewer-task-session-export.png](screenshots/44-viewer-task-session-export.png) | Browser viewport · `/projects/viberr/tasks/VIB-25` · viewer session | Viewer sees task agent-log contents and an Export affordance; the screenshot does not prove that an export request completed. |
| [45-nonmember-task-session-access.png](screenshots/45-nonmember-task-session-access.png) | Browser viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` · non-member viewer session | Direct task access exposes PXL-1 execution profile, agent-log contents, and Export affordance to the signed-in non-member. |
| [47-home-lab-complete.png](screenshots/47-home-lab-complete.png) | Browser viewport · `/` | Home shows the Pass-10 Lab project after both test tasks reached Done. |
| [48-pass10-github-final.png](screenshots/48-pass10-github-final.png) | Browser viewport · `/projects/viberr-pass-10-lab/github` | Final GitHub surface lists PR #76 and PR #77 as merged and reports the repository connection as healthy/scoped. |

## Excluded files present on disk

These files are deliberately not evidence links in the retained index:

| File | Why excluded |
|---|---|
| `11-agents-live.png` | Near-blank capture caused by the page/internal-scroll interaction; use `11-agents-live-viewport.png`. |
| `12-policy.png` | Materially cropped horizontally and incomplete; the useful policy evidence is in `12a`–`12c`. |
| `12d-policy-agent-capabilities.png` | Mislabeled and redundant: it shows the bottom of the human-RBAC explanation and only the workflow header, not an agent-capability section. |
| `40-cleanup-review-recommendation.png` | Narrow capture is severely clipped horizontally; it does not preserve the full recommendation. Use `41-cleanup-completion-recommendation.png` for the later complete recommendation state. |

## Referenced but missing

The prior index and/or [TEST-LOG.md](TEST-LOG.md) refer to the following names, but no corresponding file exists in
`screenshots/`; they are not evidence and their described state must not be inferred:

- `22-pass10-project-form.png`
- `23-pass10-project-created.png`
- `24-create-docs-profile.png`
- `25-create-code-analyst.png`
- `26-create-security-reviewer.png`
- `27-create-style-reviewer.png`
- `28-create-test-designer.png`
- `29-create-mcp-researcher.png`
- `32-pass10-github-empty.png`

Sequence gaps such as 33 and 46 are not listed as missing because no dossier file references captures with those
numbers.
