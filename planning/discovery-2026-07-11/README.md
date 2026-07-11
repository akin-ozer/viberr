# Discovery pass 2 — 2026-07-11 (session 2)

Fresh full-product pass on top of the merged 2026-07-10 pass (see ../discovery-2026-07-10/ for
architecture reference `app-reference.md` + product intent `product-intent.md` — still current).

## Docs in this folder
- **findings-v2.md** — THE consolidated backlog: ~55 deduped findings (A runtime state machine,
  B GitHub, C lifecycle, D role bindings, E store, F adapters, G UI/copy) + 5 owner questions.
  Status column tracks Phase-3 implementation.
- **role-bindings-map.md** — the complete two-system authorization map + rework plan (owner's
  declared next phase).
- **ui-walkthrough-notes.md** — page-by-page live walkthrough notes (this pass).
- **test-plan-v2.md** — 24 live cases for the viberr-on-viberr test project.
- **test-results-v2.md** — (written during Phase 2) evidence per case.

## Method
7 parallel very-thorough code audits (subsystem each) + full UI walkthrough with screenshots +
cross-verification of conflicting claims by direct file reads. Security explicitly deprioritized
by owner (S3 codex confinement stays documented-only).
