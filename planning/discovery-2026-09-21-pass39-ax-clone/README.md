# Pass 39 — ax clone (2026-09-21)

Viberr drives its own controller to build a Go clone of `google/ax` in
`akin-ozer/ax-clone`. The observer (this pass) never writes clone code.

- `FINDINGS.md` — numbered findings (F39-N), each with evidence and a proposed fix.
- `TIMELINE.md` — what happened, in order, with timestamps.
- `PROMPTS.md` — exactly what the controller was told.

Rules for the pass: the controller runs Claude **opus / high**; every other agent
(operator, reviewers, delivery specialists) runs Codex **gpt-5.6-luna / max**.
Gates for the clone are `gofmt`, `go vet`, `golangci-lint`, `go test ./...`.
