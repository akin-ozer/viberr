# Discovery pass 7 — 2026-07-16 (second /goal session of the day)

Working base: **main @ 8d285bc** (pass-6 implementation PR #27, migration squash, react-doctor
PR #28 all merged). Data root was emptied after pass 6 and re-seeded by boot; the owner then
hand-created the `viberr` project (bound to akin-ozer/viberr), attached a real PAT connection
(`akin-ozer`, all scopes), and ran task VIB-1 end-to-end this morning (Codex developer →
Claude reviewer → accept → real merge, PR #26). That live state is the starting point.

Read order for subagents:

| Doc | What it is | Trust |
| --- | --- | --- |
| `../discovery-2026-07-16/canon.md` | Product canon + rulings ledger through pass 6 | High |
| `../discovery-2026-07-16/architecture.md` | Code map @ 81dafe3 — **read with `drift-since-pass6.md`** | High w/ drift |
| `drift-since-pass6.md` | Verified delta main 81dafe3 → 8d285bc (boot, migrations, delivery chain, docker) | High (code-cited, this pass) |
| `rbac-inventory.md` | COMPLETE role-bindings inventory + 12 rework seams | High (code-cited, this pass) |
| `mock-sweep.md` | Fresh mock/unwired sweep — what remains | High (this pass) |
| `findings.md` | THE pass-7 ledger — every defect/question, statuses live | Living doc |
| `test-catalog.md` | Phase-2 live test cases + results | Living doc (phase 2) |
| `owner-rulings.md` | R7-x rulings from this session | Binding once written |

House rules (owner's goal statement, same as pass 6):
- No security focus; **role bindings WILL be reworked** (scope: owner Q&A pending → owner-rulings.md).
- Live testing on the existing `viberr` project (akin-ozer/viberr) for anything PR-shaped; other
  projects may be created for non-PR scenarios. `gh` may merge/reject PRs; merged files stay tiny.
- Implementation: no deferrals, breaking allowed, tests may be rewritten; validate by code + UI
  screenshots + browser; every ledger item closed or explicitly ruled.
