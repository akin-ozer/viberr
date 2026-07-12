# Pass 3 — discovery → live testing → implementation (2026-07-12)

Third full-product pass. Scope differs from passes 1–2: **the deferred role-bindings rework is now
in scope** (D2/D5 matrix-as-runtime-source, guard consolidation, deep capability prune, full D9 SSE
membership, Q5 ruling), plus fresh discovery findings and a new 20+ case live test sweep.
Security remains explicitly out of scope by owner instruction (S3 asked about separately).

Base: `main` at the PR #7 merge (`7c064cd`), 1130 tests green, data root reset to pristine seed.

## Docs in this folder
- **`role-bindings-current-state.md`** — the verified (2026-07-12, vs main) enforcement table,
  guard-helper locations, capability-catalog truth, SSE gap. THE implementation input.
- **`findings-v3.md`** — new findings from this pass (code verification agents + UI walkthrough +
  live testing), each with severity, anchor, and fix; status tracked to closure.
- **`test-plan-v3.md`** — the live test-case catalog for phase 2 (project: selftest-4 on
  akin-ozer/viberr) and results.
- **`owner-rulings.md`** — questions asked this pass and the owner's decisions.

## Prior-pass canon (still authoritative unless contradicted here)
- `../discovery-2026-07-10/app-reference.md` — architecture/data model/routes (drift corrections in
  findings-v3 F-D1..F-D6).
- `../discovery-2026-07-10/product-intent.md` — invariants + all resolved product decisions.
- `../discovery-2026-07-11/role-bindings-map.md` — superseded by role-bindings-current-state.md.
