Done — all five items. Board now stands at **27 tasks**, 26 of them open and every one moving with an agent.

**1) Throughput**
- Created 22 new tasks, KNC-6 … KNC-27, all independent of unfinished chain work: README (KNC-6), CONTRIBUTING (KNC-7), code of conduct/community (KNC-8), LICENSE + notices (KNC-9), issue/PR templates (KNC-10), golangci-lint + lint job (KNC-11), CI build/test matrix (KNC-12), goreleaser (KNC-13), Dependabot (KNC-14), Makefile (KNC-15), test scaffolding (KNC-16), golden-file TUI harness (KNC-17), keybinding docs (KNC-18), config schema docs (KNC-19), SECURITY.md (KNC-20), govulncheck/gosec (KNC-21), install script + Homebrew draft (KNC-22), terminal compatibility matrix (KNC-23), benchmark harness (KNC-24), logging & crash safety (KNC-25), kind cluster scripts (KNC-26), plus the browser task KNC-27.
- Loosened four waits I judged not to be real dependencies, and said why on each run directive: KNC-2 no longer waits on goal-1 link 8 (the parser is self-contained), KNC-3 no longer waits on goal-2 link 6 (log streaming does not need drill-down nav), KNC-4 no longer waits on goal-2 link 3 (a test suite does not need workload coverage), and goal-4 link 5 (Documentation set) no longer waits on goal-3 link 6. I kept goal-4 link 7 → goal-3 link 7: the v0.1.0 release genuinely depends on the feature set landing.
- Started operator runs on KNC-2, KNC-3, KNC-4, KNC-6, KNC-11, KNC-16 and KNC-27; each came back "the operator is already working <key>; your directive was queued for it", so the directives are queued, not new runs. KNC-5 untouched. Current spread: Triage 14, Design 9, Impl 2, Validation 1 (KNC-5), Done 1.

**2) Browser capability** — `use-browser` is now **direct** on the Docs & Release Engineer deployment (verified in `get_project`); it is the only deployment on this project with it. KNC-27 ("Verify README rendering on github.com with a browser screenshot") requires a full-page screenshot of the rendered README at github.com/akin-ozer/k9s-clone saved as evidence on the task, plus a per-defect timeline entry or an explicit "renders correctly" verdict.

**3) People** — created as org members and seated:
- Maya Chen · maya@viberr.dev · project **maintainer** · temp password `InFyZa4ETxNL`
- Omar Reyes · omar@viberr.dev · project **contributor** · temp password `mKdVWV-gQXuK`
- Lena Fischer · lena@viberr.dev · project **viewer** · temp password `Po22yaQchkO3`
- Noah Park · noah@viberr.dev · org member, **not** a member of k9c · temp password `ypzUe7xZ-zKF`

Each password is single-use and forces a new one at first sign in.

**4) MCP** — registered **context7** (HTTP, `https://mcp.context7.com/mcp`, id `mcp_0qtTrzZapZCJ`, no credential). Test: "context7 healthy: 2 tools · 1205ms". Granted to the **Kubernetes Platform Engineer** template, the agent that most needs current client-go / tview / cobra API docs; its skill and knowledge-base grants were left unchanged.

**Deviations worth your eye:** all new tasks are owned by you (I did not reassign any to Maya or Omar — say the word and I will re-seat); KNC-11, KNC-12 and KNC-21 touch CI while KNC-5 is in flight on the build pipeline, so I told the operator to keep the lint and scan jobs in separate workflow files rather than blocking them. No refusals — every call succeeded.
