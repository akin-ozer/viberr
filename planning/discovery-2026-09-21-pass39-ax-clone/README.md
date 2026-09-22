# Pass 39 — ax clone (2026-09-21)

Viberr drives its own controller to build a Go clone of `google/ax` in
`akin-ozer/ax-clone`. The observer (this pass) never writes clone code.

- `FINDINGS.md` — what is still OPEN (nitpicks noted, not worked) and the controller assessment. Solved findings were cleared; each lives in its ruling (377-418) in `docs/architecture/decisions.md`, mapped in `PLAN.md`.
- `TIMELINE.md` — what happened, in order, with timestamps.
- `PROMPTS.md` — exactly what the controller was told.

Rules for the pass: the controller runs Claude **Opus 5.5 / high**; every other agent
(operator, reviewers, delivery specialists) runs Codex **gpt-6-luna / max** (owner's change on
2026-09-23; until then Opus 5 and gpt-5.6-luna, which the pinned SDKs could not go past).
Gates for the clone are `gofmt`, `go vet`, `golangci-lint`, `go test ./...`.
