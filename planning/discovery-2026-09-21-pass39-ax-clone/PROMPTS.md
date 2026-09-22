# What the controller was told

## 1. Opening brief (dock, instance scope) — 2026-09-21

> Build me a working Go clone of Google's `ax` (github.com/google/ax), their declarative
> orchestration runtime for agent workloads. The repo already exists and is empty:
> `akin-ozer/ax-clone` under the `akin-ozer` GitHub connection.
>
> What it has to be when it is done — I will run it:
> - `ax apply -f task.yaml` applies declarative manifests over four kinds: Task, Workspace,
>   Gateway, Model.
> - A control plane that reconciles those objects towards their declared state.
> - `ax get`, `ax watch`, `ax logs`, `ax ssh`, `ax suspend`, `ax resume` work against a live task.
> - State survives a restart of the control plane.
> Not a toy, not a stub: 25+ tasks of real work, delivered over at least 8 cycles, ending in
> merged pull requests on that repo.
>
> The layout, the storage, the protocols, the sandboxing and the test strategy are YOUR call,
> not mine. Go is the language; everything else you decide.
>
> Constraints I do set:
> - Gates for this project are Go gates: `gofmt`, `go vet`, `golangci-lint`, `go test ./...`.
>   This deployment has only ever run npm projects. Check what this host can actually run
>   before you promise a gate, and set the project up so every agent knows the gate commands.
> - MODELS: you (the controller) run on Claude Opus, effort high — already set, leave it.
>   EVERY other agent on this instance — the operator, every reviewer, every delivery
>   specialist — runs on the Codex backend, model `gpt-5.6-luna`, effort `max`. Put them
>   there before any work starts, and keep any agent you create later on the same setting.
> - Delivery is through Viberr: real branches, real PRs on `akin-ozer/ax-clone`. Nothing is
>   written to that repo by hand.
>
> You own the setup end to end: the project and its workflow stages and boundaries, the agent
> profiles and their capability grants, knowledge bases, skills, MCP servers, the repo attach,
> required reviewers, schedules and chained goals. I have pre-built none of it on purpose.
>
> Start by telling me the shape you intend (stages, agents, how you will slice 25+ tasks, the
> gates and how you verified this host can run them), then set it up and start work. If a
> surface will not let you do something you need, say so plainly rather than working around it
> — that is exactly what I want to learn.
