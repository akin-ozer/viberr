# session-b/ — Session B's pass-19 ledger (dialect map)

These are the documents authored by **Session B** on `pass19/product-fixes`, relocated here intact
during the merge of the two concurrent pass-19 sessions so neither ledger is lost or interleaved
(see `../RECONCILE.md` §4). They use B's own numbering. **Do not read B's IDs as A's.** Contents:
`NOTES.md`, `USE-CASES.md`, `ROADMAP.md`, `spec-*.md` (5), `gap-analysis-result.json`,
`ux-audit-result.json`.

**1. Finding-ID dialect.** IDs **≤ F19-21** are the one shared ledger — the same finding in both
sessions. IDs **≥ F19-22** are per-session dialects that collide by number only: B's F19-22/23/26/27
are NOT A's F19-22/23/26/27. Always qualify a ≥22 ID with its session when citing across ledgers.

**2. Ruling-tag map** (B's local tag → merged `decisions.md` ruling number, and the tag the code
now carries):
- B **`R19-1`** = merged **ruling 62** (code retagged to **`R19-8`**).
- B **`R19-4`** = merged **ruling 55** (code retagged to **`R19-1`**).
- B **`R19-2`** / **`R19-3`** = merged **56 / 57** — unchanged, same tags.
- B **`R19-A`** / **`R19-B`** = merged **rulings 67 / 68**.

**3. B's open F19-26 is CLOSED.** B left F19-26 (org-admin can audit any member) as an open
question; A answered it — the action is audited, with a 60-second dedup window. Treat F19-26 as
resolved, not pending.

**4. B's MCP-probe live evidence is preserved here.** The UC-14 end-to-end proof — a real
`pass19-probe` stdio MCP server registered through the UI, granted to Claude, its run returning the
exact canary **`MCP-CANARY-PASS19-4417`** — lives in `NOTES.md` (row UC-14). It was carried over by
the move, never line-merged into A's NOTES.

> Note: any "assign this the next number 59" / "this is ruling 59" instruction inside B's
> `spec-*.md` is **void** — the git-stderr-surfacing reversal is owner-confirmed (2026-08-08)
> as **ruling 69 / R19-13**, not 59 (59 is R19-5). See RECONCILE §4.

**Owner-confirmed at merge close (2026-08-08):** the three rulings this merge surfaced for the
owner were all kept — R19-A (ruling 67, autonomy ceiling), R19-B (ruling 68, human GitHub
approval = verdict), and the git-stderr surfacing (ruling 69 / R19-13).
