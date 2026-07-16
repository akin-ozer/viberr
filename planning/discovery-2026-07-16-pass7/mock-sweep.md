# Fresh mock/unwired/placeholder sweep — main @ 8d285bc (2026-07-16)

Bottom line: unusually clean. Most `mock`/`hardcoded`/`placeholder` hits are comments
documenting a removal. No dead buttons, no `href="#"`, no empty onClick, no toast-only handlers,
no fabricated display numbers, no dead notification kinds, no write-only prefs, no canned
loaders. Every traced UI control POSTs to a real action.

## Findings (ranked)

1. **Simulated reviewer runs write an UNMARKED "Review passed / validation healthy" governance
   record.** `applyAgentCompletionEffects`: workspace reconcile gated `!finished.simulated`
   (task-actions.server.ts:1683) and error path gated (:1629), but the reviewer-verdict path
   (:1700-1708) is NOT — a simulated reviewer's canned reply runs `classifyReviewerVerdict` →
   `recordReviewerVerdict` (:1438-1510) writing `validation: healthy`, a quality event titled
   "Review passed", an audit row, and notifications — none marked simulated (the sibling reply
   comment IS marked, :1169). In a keyless deploy the acceptance gate opens off fabricated
   review evidence. Simulated writes governance state in: (a) reply comment (marked), (b)
   reviewer verdict + validation + audit (UNMARKED), (c) operator react loop advancing stages
   off simulated replies (:1731-1788). → pass-5 D12 territory; needs ruling or fix.

2. **specialist-mcp.server.ts is half-wired**: resolves org MCP registry into runtime
   `mcpServers` shapes but drops `secret://` cred refs (docstring :17-22 is honest). Org MCP
   panel probes ARE real (stdio JSON-RPC handshake + HTTP reachability,
   org/resources.server.ts). A credentialed MCP shows discovered tools but won't authenticate
   inside a real run. → pass-4 ruling 8 (WIRE IT) still unimplemented on main.

3. **Demo fixtures correctly isolated**: `runDemoSeed` (demo-seed.server.ts:267-290) hardcodes
   the sv_seed_vib142_pr_write violation + Arda's pins — only via `npm run seed`, never boot.
   Boot runs only seedDefaultAgentAssets (real assets) + seedInitialAdmin. Harmless.

4. **seed-resumer.server.ts still wired** from routes/project.task.tsx:93
   (`resumeSeededRunningRuns`) though boot finalization retires seeded runs → effectively
   unreachable post-boot. boot.server.ts:131 comment says the finalizer "REPLACES the old
   seed-resumer" — misleading re: the loader-path resumer. Cleanup candidate.

## Verified clean (checked, not findings)

Re-scan buttons → real rescanProjections (gated). Rebuild projections, StoreBrowser (real fs),
GitHub connections (real PAT validator), MCP probe (real handshake, counts never fabricated).
All 5 notification kinds emitted. All prefs read somewhere (motion root.tsx:49; tlDefault
project.task.tsx:87; notif prefs notifications.server.ts:60). Capability catalog honest
(enforced vs advisory, matrix badges). Home org counts real. All routes reachable. No
webhook/poll half-wiring (GitHub sync is on-demand reconcile). Only documented env kill-switch
is VIBERR_FORCE_SIMULATED_RUNTIME (e2e).
