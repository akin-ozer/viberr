# Pass 24 — owner questions

Only the genuine design calls are here. The other ~18 confirmed findings (FINDINGS-MASTER.md) are
clear bugs with obvious fixes — no input needed.

## Q1 (B-1, HIGH) — how to constrain the Codex operator's write access to governance state

**Fact.** The Claude operator run has Bash/Edit/Write/MultiEdit/NotebookEdit DENIED — it physically
cannot write `task.md` or run a shell. The Codex operator run, since R22 removed the read-only sandbox,
runs `workspace-write` (writable + shell, `approvalPolicy:"never"`) with its cwd defaulting to the TASK
GOVERNANCE directory (`projects/<slug>/tasks/<KEY>/`, which holds `task.md`). So a Codex operator can,
mid-turn, `sed -i ./task.md` (flip validation, delete an open packet, rewrite a reviewer verdict) or
`git commit` inside `./workspace/<repo>` (the shared deliverer clone → a later delivery ships
operator-authored code). No server gate mediates a direct task.md write; the watcher reprojects it as
canonical truth. The shared system prompt even asserts "you cannot edit… the file-writing and shell
tools are withheld" and "You have no shell" — both FALSE on Codex.

R22 ("viberr is the sandbox") accepted advisory file/command limits with the server-owned DELIVERY gate
as the boundary — but it addressed repo delivery, not direct governance-file mutation. (R22 also removed
the read-only sandbox mode, so I can't simply make the operator read-only.)

**Options** (I can still control the WRITABLE ROOT even though read-only mode is gone — workspace-write
restricts WRITES to cwd+/tmp+additionalDirs while READS stay broad):
- (a) Root the Codex operator's writable cwd at a dedicated empty scratch dir, so `task.md` and the
  shared clone are READ-only to it (outside the writable root). Closest to the Claude operator's
  read-but-not-write posture. Needs the workspace prompt paths adjusted. **[my recommendation]**
- (b) Root it at the workspace clone dir (like specialists) — protects task.md, but the operator can
  still commit into the shared clone.
- (c) Accept as within R22 — no change; Codex operator file limits stay advisory like specialists.

## Q2 (B-2, MEDIUM) — web egress granted to a Codex operator is inert

**Fact.** `use-web-search-fetch` is operator-grantable (default direct) and in the ENFORCED "both
backends" set; the matrix shows the operator's web-egress cell green ("Acts directly"). The Claude
operator honors the grant (WebFetch/WebSearch available unless withheld). The Codex adapter
unconditionally disables network + web search for EVERY operator run, ignoring the grant. So a granted
Codex operator silently cannot reach the web while Claude can — a parity gap.

**Options:**
- (a) Honor the grant on Codex: enable web search when the operator holds `use-web-search-fetch`
  (keep sandbox network off; that's not the egress this capability governs), matching Claude. **[my
  recommendation — matches your "codex and claude behave the same from viberr's eye" goal]**
- (b) Keep operators web-less on BOTH backends (withhold from the Claude operator too) and stop
  rendering the row green for operators — if operators are intentionally web-less.
- (c) Keep Codex-off but tag the editor/matrix row "advisory/inert on Codex" so only the display is honest.

## RULINGS (owner, 2026-08-22)
- **Q1 (B-1) = Scratch-dir cwd.** Root the Codex operator's writable cwd at a dedicated empty scratch
  dir so task.md and the shared clone are READABLE but NOT writable (outside the workspace-write
  writable root). Closest to the Claude operator's read-but-not-write posture.
- **Q2 (B-2) = Honor grant on Codex.** Enable Codex operator web search when the operator holds
  `use-web-search-fetch` (sandbox network stays off), matching Claude.

## Answered / defaulted
- Everything else in FINDINGS-MASTER.md → implement the stated fix direction.
