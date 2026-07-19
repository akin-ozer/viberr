# Evidence manifest

Audit date: 2026-07-19  
Audited revision: `afb22fe2cbab79169778db01d48fa4d92f519188`  
Scope: read-only evidence inventory; no product, canonical data, GitHub, or UI mutation

This manifest records what can be verified from the local evidence as it exists. There are 44 files in
`screenshots/`: 40 retained captures and four excluded artifacts. Nine additional screenshot names are referenced by
the dossier but are absent on disk.

For screenshot rows, byte size is the payload size in decimal bytes and SHA-256 is calculated over the file bytes.
The payload header of every file identifies it as JPEG even though every filename ends in `.png`. Claims are limited
to visible content. No secret, unmasked credential, or full provider session ID is reproduced here; where the UI
shows a masked credential or truncated session identifier, this manifest describes only the affordance.

## Retained screenshot evidence

| File | Actual MIME | Pixels | Bytes | SHA-256 | Capture type / route | Supported claim |
|---|---:|---:|---:|---|---|---|
| [01-login.png](screenshots/01-login.png) | `image/jpeg` | 1270×741 | 26835 | `0c5a57d322a1aabb94561b5467eac28f10dbdebcac07b6ec3028e9348ef42ec9` | Page · `/login` | Local login, unconfigured OAuth, empty desktop pane. |
| [02-home.png](screenshots/02-home.png) | `image/jpeg` | 1270×964 | 74816 | `c25a09f211af54541468f81c9cea1e0a907f9226666af012e030f8f97d58f73a` | Page · `/` | Baseline three-project Home and counters. |
| [03-new-project-modal.png](screenshots/03-new-project-modal.png) | `image/jpeg` | 1280×964 | 69220 | `f297f3855bbb9bcd9ccf7c6efb11b5a51b7b229f1d6d85f0f90db1638fa2b815` | Modal · `/` | New-project fields, presets, repository requirement, authorization copy. |
| [04-board.png](screenshots/04-board.png) | `image/jpeg` | 1280×720 | 61553 | `0b67ad0c518dc7188e18eedd630327fd70c9df63e07096998265b3b04f717189` | Page · `/projects/viberr/board` | 34 tasks and 30 waiting on a human decision. |
| [05-review-queue.png](screenshots/05-review-queue.png) | `image/jpeg` | 1280×720 | 79076 | `8ca8fc27d54a85c3cf604dbfc35cf95ab861aaa8e7aeace183a1986c76544965` | Page · `/projects/viberr/review` | Blocked/failing cards appear in the acceptance queue. |
| [06-agents.png](screenshots/06-agents.png) | `image/jpeg` | 1280×720 | 57064 | `0870f0a6304835e9015f4296ee099f55c4c31b2212b6c479b086217bc8f9f31d` | Page · `/projects/viberr/agents` | Agents summary and Operator profile surface. |
| [07-agent-developer.png](screenshots/07-agent-developer.png) | `image/jpeg` | 1280×720 | 86147 | `ea3c96345e7a3b72d1e8426fa1b0b6995009f8a08142d41092d972dee4d32129` | Page · `/projects/viberr/agents` | Developer stages, resources, deployment, capability summary. |
| [08-agent-edit-modal.png](screenshots/08-agent-edit-modal.png) | `image/jpeg` | 1280×720 | 72146 | `0af9ed7d471104ee963638491fba1981712b62b5d74456138006f0b839840a4d` | Modal · `/projects/viberr/agents` | Rendered Developer editor capability inputs. |
| [09-agent-new-profile-modal.png](screenshots/09-agent-new-profile-modal.png) | `image/jpeg` | 1280×720 | 71468 | `6721e3d629bedc479162fc8f865dad9131b830ac3bda8dc3cdaba4464f0afd6c` | Modal · `/projects/viberr/agents` | New-profile defaults and governed inputs. |
| [10-capability-matrix.png](screenshots/10-capability-matrix.png) | `image/jpeg` | 1280×720 | 69579 | `79c6e47b71a2f28a766da765ec15acaa5a73ef9c60d5e3baa47b86deeff37ed7` | Modal · `/projects/viberr/agents` | Capability assignments and enforced/advisory labels. |
| [11-agents-live-viewport.png](screenshots/11-agents-live-viewport.png) | `image/jpeg` | 1280×720 | 82668 | `15c2b7c7b3317254524f8de9ea1ee26b29e3684196bfc64c93e478d5acdcc205` | Viewport · `/projects/viberr/agents` | Legible live-runs table with role-like Agent values. |
| [12a-policy-top.png](screenshots/12a-policy-top.png) | `image/jpeg` | 1280×720 | 99103 | `144e2ebaaf521c60914ce26be8585863f22eefa65322f6d8af64b479bd78b689` | Viewport · `/projects/viberr/policy` | Human RBAC and agent-capability summaries. |
| [12b-policy-rbac-matrix.png](screenshots/12b-policy-rbac-matrix.png) | `image/jpeg` | 1280×720 | 47151 | `39ec60f1449e60fa5fbbd536cad0e2a58b77a8819f85ce6bda54840cf6cc71c5` | Viewport · `/projects/viberr/policy` | Middle of the RBAC action matrix. |
| [12c-policy-agents-workflow.png](screenshots/12c-policy-agents-workflow.png) | `image/jpeg` | 1280×720 | 88218 | `fd877d78214b478f52657371461859d2d4bb87a813db4deb44aa5fd70c280c16` | Viewport · `/projects/viberr/policy` | App-wide access explanation and workflow rules. |
| [13-github.png](screenshots/13-github.png) | `image/jpeg` | 1280×720 | 85213 | `dfdaecc6e02a93b4f3d4afb0a708a5c54bfc4729b15684ce18c9efe969ec11b5` | Page · `/projects/viberr/github` | Connected repository, masked credential, scopes, PR list, reconcile control. |
| [14-activity.png](screenshots/14-activity.png) | `image/jpeg` | 1280×720 | 131057 | `4170b884341e18232648f8552bc49aeafe047803ae5b7abc8086cd1bb011ceab` | Page · `/projects/viberr/activity` | Full reports dominate the activity stream. |
| [15-project-settings.png](screenshots/15-project-settings.png) | `image/jpeg` | 1280×720 | 70037 | `f6ac9f468eb7e92b699c8c734cf659c4036cbb55a425b54b749fd464bc930e0a` | Page · `/projects/viberr/settings` | Project configuration and stage-removal affordances. |
| [16-task-vib-30.png](screenshots/16-task-vib-30.png) | `image/jpeg` | 1280×720 | 87215 | `da1a3f54d54249ca40b20028009594413dea49614d460ea91e94ad4422166913` | Page · `/projects/viberr/tasks/VIB-30` | Review-stage VIB-30 state and recommendation. |
| [16b-task-execution-profile.png](screenshots/16b-task-execution-profile.png) | `image/jpeg` | 1280×720 | 82416 | `f3de6e74827f6bd018ac767db2a1fd181cf423895c6b4bb30a79bd806b55a96d` | Viewport · `/projects/viberr/tasks/VIB-30` | Execution roles and agent-log panel. |
| [16c-task-timeline.png](screenshots/16c-task-timeline.png) | `image/jpeg` | 1280×720 | 83839 | `86907eb1931da10e6e03f78cc5e43a0e2cd6a78d109381d5491b1a7de91c1a1f` | Viewport · `/projects/viberr/tasks/VIB-30` | Mixed operator, agent, and human timeline. |
| [17-org-general.png](screenshots/17-org-general.png) | `image/jpeg` | 1280×720 | 38959 | `559556ea865a3ff534b6167cce114e0ba5aef82a416a4281352c14b4acf7677f` | Page · `/org/settings?tab=connections` | Organization GitHub connections. |
| [18-org-users.png](screenshots/18-org-users.png) | `image/jpeg` | 1280×720 | 50932 | `48755c853ff419294f7a1f4f1595e3ac75443845aab4ec1764c6a7003f27a317` | Page · `/org/settings?tab=users` | Organization users and access roles. |
| [19-org-resources.png](screenshots/19-org-resources.png) | `image/jpeg` | 1270×714 | 72108 | `12985e307c7d4b00cc3985df1718b1e4dd53ffe3fe2e0b28121fd16db210d2ae` | Page · `/org/settings?tab=resources` | KBs, MCPs, skills, and visible global profiles. |
| [20-profile.png](screenshots/20-profile.png) | `image/jpeg` | 1280×720 | 67635 | `f97411a7d63b467cfa7768038c2fd5d61a4a7671a352b6bdd0cbd846a7a463fa` | Overlay · `/profile` | Identity, membership/access, preferences, routing. |
| [21-notifications.png](screenshots/21-notifications.png) | `image/jpeg` | 1280×720 | 95095 | `093112d32fef027a9b131d2453febf59710ef69df11ad98de1bda6ffee6bda1a` | Overlay · `/notifications` | Notification groups, counts, truncated cards. |
| [30-pass10-agent-roster.png](screenshots/30-pass10-agent-roster.png) | `image/jpeg` | 1062×869 | 79253 | `c0dff747622dea268fcf8d072a07bb177dff9d3fc4fcf8ab78c3383e87fbd3b1` | Viewport · `/projects/viberr-pass-10-lab/agents` | Nine-profile Pass-10 roster and selected Docs Writer. |
| [31-mcp-healthy.png](screenshots/31-mcp-healthy.png) | `image/jpeg` | 1052×861 | 83170 | `1c190cb17ceda39e5af4c23cc6df511bc89725b67a0530a6afca8d0c0569d14c` | Viewport · `/org/settings?tab=resources` | `notes-fixture` healthy, one tool, 34 ms in this probe. |
| [34-delivery-contract-conflict.png](screenshots/34-delivery-contract-conflict.png) | `image/jpeg` | 1280×720 | 134051 | `dde1db8c471f6df29b6d2e841eecb78a216802c16bf34e1bf2216cbc344cf9b0` | Page · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Delivery-contract conflict and human-decision state. |
| [35-review-recommendation.png](screenshots/35-review-recommendation.png) | `image/jpeg` | 1280×720 | 118063 | `c04b4742a17bd9588aff13c0630cdba615ef1acd8ef407aa81fb7169ae44438c` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Move-to-Review recommendation. |
| [36-style-reviewer-selected.png](screenshots/36-style-reviewer-selected.png) | `image/jpeg` | 1280×720 | 92788 | `e82ae40322c3c9e503e3ca6dfd7393dccd34cc5f79f499b2b0905a4b3a5b52cc` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Style Reviewer engaged during Review. |
| [37-healthy-review-completion-recommendation.png](screenshots/37-healthy-review-completion-recommendation.png) | `image/jpeg` | 1280×720 | 99295 | `d1326ff47c39fc513eb849e6a67901245344c28d20eede9b40bfbcfc2c9501c6` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | Healthy review and accept-completion recommendation. |
| [38-pr76-merged-done.png](screenshots/38-pr76-merged-done.png) | `image/jpeg` | 860×869 | 86261 | `8871b434fd6fc246d1364a9918bf5d89249eafbbc7f80f2ff23e5e31ef649416` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` | PXL-1 execution profile marked task closed. |
| [39-cleanup-task-form.png](screenshots/39-cleanup-task-form.png) | `image/jpeg` | 426×869 | 33221 | `fe24a5e5c5837af8dc227bcf9656b4c03dc202e998ec0d9a7bf79da9b71a0015` | Narrow modal · `/projects/viberr-pass-10-lab/board` | Cleanup task title and deletion goal. |
| [41-cleanup-completion-recommendation.png](screenshots/41-cleanup-completion-recommendation.png) | `image/jpeg` | 1062×869 | 74116 | `f2517776054cd161d9fc0f68c6c4d947a668a4bd674660d5f4c6fb7021b09eb6` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-2` | Complete PXL-2 acceptance recommendation. |
| [42-pr77-merged-tree-restored.png](screenshots/42-pr77-merged-tree-restored.png) | `image/jpeg` | 1062×869 | 94963 | `a1ac9ed7c68449c50d7c2efac40f7ed74706cc7666cf8437a405b78cb8fe84c4` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-2` | Done, merged, healthy, task-closed UI state; not tree proof alone. |
| [43-viewer-settings-danger-buttons.png](screenshots/43-viewer-settings-danger-buttons.png) | `image/jpeg` | 1062×869 | 54249 | `1c3834b8e3eb0ecdf5767852367b66c5587f1b0bb048b74a1bf13ecb2783191e` | Viewport · `/projects/viberr/settings` · viewer | Viewer can render Settings and workflow-stage rows; danger area is not captured. |
| [44-viewer-task-session-export.png](screenshots/44-viewer-task-session-export.png) | `image/jpeg` | 1062×869 | 106554 | `10e86fad0a4e8c2234e76b2dc2c820fd45bcf23391dc569581cf63d83043829b` | Viewport · `/projects/viberr/tasks/VIB-25` · viewer | Viewer sees agent logs and Export affordance; completion is not proven. |
| [45-nonmember-task-session-access.png](screenshots/45-nonmember-task-session-access.png) | `image/jpeg` | 1062×869 | 111291 | `76edf219e7085388b16ba5e1ccbd73a2de360d7863709f9f5cc4fe6b7d9f82f1` | Viewport · `/projects/viberr-pass-10-lab/tasks/PXL-1` · non-member viewer | Non-member sees task, agent logs, and Export affordance. |
| [47-home-lab-complete.png](screenshots/47-home-lab-complete.png) | `image/jpeg` | 1052×861 | 60245 | `949eefccdcb4cc4c9f2bc34eb6b75fc7fee80bcb953b8dcd1e0edaf7db2ffc82` | Viewport · `/` | Home shows Pass-10 Lab with both tasks Done. |
| [48-pass10-github-final.png](screenshots/48-pass10-github-final.png) | `image/jpeg` | 1062×869 | 74698 | `406b644e8f2129839f4b35e19c7a265e5bec45d4bbf98544856963329d9fbff4` | Viewport · `/projects/viberr-pass-10-lab/github` | Healthy connection and PR #76/#77 both listed merged. |

## Excluded screenshot artifacts

These files exist and are hashed for inventory integrity, but are not retained as evidence.

| File | Actual MIME | Pixels | Bytes | SHA-256 | Exclusion reason |
|---|---:|---:|---:|---|---|
| `11-agents-live.png` | `image/jpeg` | 1280×720 | 5942 | `b9f69a86c53cceccea2e3db47127b90885b684418b587398591c98362088f1f9` | Near-blank internal-scroll capture. |
| `12-policy.png` | `image/jpeg` | 1280×720 | 71160 | `56347ee34646e2c4ce97d8abbc51dddd76c934529892f40fad2efc8288d017e5` | Horizontally cropped and incomplete. |
| `12d-policy-agent-capabilities.png` | `image/jpeg` | 1280×720 | 74304 | `2b8301d092aa006f6d02246d4117b443dd66b5352b6d0521736d580c3732c31e` | Mislabeled/redundant; does not show the named agent-capability section. |
| `40-cleanup-review-recommendation.png` | `image/jpeg` | 426×869 | 40200 | `8754977e545f7352b1fd4376822dc8548507d241e29b1bae4673b40b8629dfef` | Severe horizontal clipping makes the recommendation incomplete. |

## Referenced-but-missing captures

No file exists for any of these dossier references, so none has MIME, dimensions, size, or digest:

| Missing filename | Reference status |
|---|---|
| `22-pass10-project-form.png` | Referenced by `TEST-LOG.md` and the prior screenshot index. |
| `23-pass10-project-created.png` | Referenced by `TEST-LOG.md` and the prior screenshot index. |
| `24-create-docs-profile.png` | Referenced by `TEST-LOG.md` and the prior screenshot index. |
| `25-create-code-analyst.png` | Referenced by the prior screenshot index and implied by the `24`–`30` range in `TEST-LOG.md`. |
| `26-create-security-reviewer.png` | Referenced by the prior screenshot index and implied by the `24`–`30` range in `TEST-LOG.md`. |
| `27-create-style-reviewer.png` | Referenced by the prior screenshot index and implied by the `24`–`30` range in `TEST-LOG.md`. |
| `28-create-test-designer.png` | Referenced by the prior screenshot index and implied by the `24`–`30` range in `TEST-LOG.md`. |
| `29-create-mcp-researcher.png` | Referenced by the prior screenshot index and implied by the `24`–`30` range in `TEST-LOG.md`. |
| `32-pass10-github-empty.png` | Referenced by `TEST-LOG.md` and the prior screenshot index. |

## Non-image evidence

### Revision and canonical task records

| Evidence | Integrity / location | Verified content | Limits |
|---|---|---|---|
| Audited revision | Current `git rev-parse HEAD`; [README.md](README.md); [TEST-LOG.md](TEST-LOG.md) | All three identify `afb22fe2cbab79169778db01d48fa4d92f519188`; current commit subject is “Merge pull request #75 from akin-ozer/test/pass9-usecase-suite.” | Screenshots do not embed the Git revision; the association is dossier-level. |
| PXL-1 canonical task | [PXL-1 `task.md`](../../data/projects/viberr-pass-10-lab/tasks/PXL-1/task.md) · 18453 bytes · SHA-256 `8cf09caedbf37032c51416fc124b33eef4c22244777d62133bc76fe8dbe8d339` | `done`, validation `healthy`, branch `pxl-1`, short commit `4658214`, PR #76 `merged`; timeline records human acceptance and merge. | The task file contains more raw identifiers than repeated here; consult it under normal data-access controls. |
| PXL-2 canonical task | [PXL-2 `task.md`](../../data/projects/viberr-pass-10-lab/tasks/PXL-2/task.md) · 7820 bytes · SHA-256 `33ceb3122fd683be3ee50216b61b1bc539c5756c7ce6ef125c796b468faba12a` | `done`, validation `healthy`, branch `pxl-2`, short commit `78e6369`, PR #77 `merged`; timeline records human acceptance and merge. | The task file contains more raw identifiers than repeated here; consult it under normal data-access controls. |
| Commit `4658214` | PXL-1 frontmatter/timeline and agent/reviewer reports | Recorded as a one-file addition of `planning/audit-fixtures/PXL-1-resource-contract.md`. | The commit object is not present in this checkout’s Git object database, so its object/type/diff was not independently re-read here. |
| Commit `78e6369` | PXL-2 frontmatter/timeline and agent/reviewer reports | Recorded as the one-file deletion of the same fixture. | The commit object is not present in this checkout’s Git object database, so its object/type/diff was not independently re-read here. |
| PR #76 | PXL-1 task record; [48-pass10-github-final.png](screenshots/48-pass10-github-final.png) | Canonical task state and final GitHub UI both record PR #76 as merged. | No independent GitHub API/browser query was performed for this documentation-only inventory. |
| PR #77 | PXL-2 task record; [48-pass10-github-final.png](screenshots/48-pass10-github-final.png) | Canonical task state and final GitHub UI both record PR #77 as merged. | No independent GitHub API/browser query was performed for this documentation-only inventory. |
| Fixture final-state check | Local filesystem and `git ls-files` at the audited revision | `planning/audit-fixtures/PXL-1-resource-contract.md` is absent and is not tracked in the current checkout. | This is consistent with cleanup but cannot independently prove the two remote PR diffs or their merge order. |

### Recorded mechanical validation

These are the results recorded in [TEST-LOG.md](TEST-LOG.md); they were not rerun while producing this
documentation-only manifest.

| Check | Recorded result | Evidence boundary |
|---|---|---|
| `npm run typecheck` | Pass. | B04 in `TEST-LOG.md`. |
| `npm run build` | Pass; bundler warned that `operator-run.server.ts` is both statically and dynamically imported, so the dynamic import does not split a chunk. | B05 in `TEST-LOG.md`. |
| `npm test` | Partial failure: 137/138 test files pass; 1,399/1,403 tests pass; four file-watcher tests fail with repeated `EMFILE`. | B06 in `TEST-LOG.md`; do not summarize this as a green suite. |
| `npx vitest run app/server/files/file-watch.service.server.test.ts --maxWorkers=1` | 3/7 pass; the same four watcher tests fail. | B07 in `TEST-LOG.md`; the log records a host soft file limit of 256 as an environment caveat. |
| Credential-scrubbed governance regression set | 18/18 files and 275/275 tests pass in 30.73 s. | B08 in `TEST-LOG.md`; provider/CLI authorization variables and `CODEX_HOME` were removed from the process. |
| Credential-scrubbed safe suite excluding the isolated watcher file | 1,396 tests pass. | B09 in `TEST-LOG.md`; paired with B06/B07 rather than presented as the complete suite. |
| Development-server observation during PXL workspaces | Fail: nested workspace files triggered Vite reloads and nested-`tsconfig` cache resets; active elapsed text produced a React hydration mismatch (`00:55` server versus `00:56` client). | B10 in `TEST-LOG.md` plus `vite.config.ts`, `app/features/runtime/runs-helpers.ts`, and `runs-panels.tsx`. The raw terminal stream was observed during the audit but is not retained as a standalone file, so this row is not a byte-hashed console artifact. |
| PXL-1 task-scoped review | Reviewer record says only the fixture was added and its required format/markers were checked. | Canonical PXL-1 timeline; documentation review, not a full product build/test run. |
| PXL-2 task-scoped review | Deliverer/reviewer records say the one-file deletion was clean and `git diff --check` passed. | Canonical PXL-2 timeline; cleanup validation, not a full product build/test run. |

## Interpretation cautions

- `31-mcp-healthy.png` reports 34 ms while `TEST-LOG.md` reports 35 ms; these are compatible repeated probes, not
  one byte-identical measurement.
- `42-pr77-merged-tree-restored.png` has an overbroad filename. It proves the visible Done/merged/healthy state;
  repository-tree restoration is supported only by the paired canonical task records plus the final-state absence
  check, and the unavailable commit objects prevent an independent local diff reconstruction.
- `43-viewer-settings-danger-buttons.png` does not contain the lower danger area. It is retained only for viewer
  rendering of Settings and workflow-stage controls.
- An Export button in captures 44 or 45 proves an exposed affordance and visible task-log access, not a successful
  transcript download.
