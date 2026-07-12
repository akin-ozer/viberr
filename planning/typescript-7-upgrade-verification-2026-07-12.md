# TS7/RR8/Vite8/Node26 migration — verification evidence

**Date:** 2026-07-12 · **Branch:** `ts7-stack-upgrade` (9 commits on top of `main`; Node landed as 24 first, then moved to 26 — see §7)
**Plan:** `planning/typescript-7-upgrade-plan-2026-07-12.md` — executed in full, no deviations besides those noted in §4.

## 1. What changed

| Component | Before | After |
|---|---|---|
| TypeScript | 5.9.3 (JS compiler) | **7.0.2** (native Go compiler, via 6.0.3 bridge) |
| React Router (4 pkgs) | 7.18.1 | **8.2.0** |
| Vite | 7.3.6 (esbuild+Rollup) | **8.1.4** (Rolldown/Oxc) |
| Vitest | 4.1.9 | 4.1.10 |
| Node (CI/Docker/engines) | 22 / 22 / >=20 | **24 / 24 / >=24** (+ .nvmrc) |
| vite-tsconfig-paths | 6.1.1 | **removed** (Vite 8 native `resolve.tsconfigPaths`) |
| @openai/codex-sdk | 0.142.5 | 0.144.1 |
| @anthropic-ai/claude-agent-sdk | 0.3.201 | 0.3.207 |
| isbot | 5.1.44 | 5.2.0 |
| package-lock.json | v7-era tree | regenerated from scratch; `npm ci` verified from empty node_modules |

tsconfig: `target`/`lib` ES2022→ES2025, `module` ES2022→ESNext, +`erasableSyntaxOnly`, −`esModuleInterop` (forced true in TS6+), `overrides {"typescript":"$typescript"}` added (RR8 still peer-declares `^5.1||^6`; its typegen is Babel-based and never imports the TS API — remove the override when RR accepts ^7).

Code changes required by the entire two-major-version jump — **4 files**:
- `app/entry.server.tsx` — `AppLoadContext` → `RouterContextProvider` (type-only; v8 middleware-context default)
- `app/routes/project.tsx` — `meta({data})` → `meta({loaderData})`; `UIMatch.data` → `UIMatch.loaderData`
- `app/routes/project.task.tsx` — `meta({data})` → `meta({loaderData})`
- `app/shared/workflow/stage-roles.ts` — TS6's new TS2871 check correctly flagged `(x ?? null) ?? y`: the inner `?? null` was dead code; removed (verified semantics-identical; 6/6 unit tests)

## 2. Gate evidence (before → after, same machine, Node 24.14.1)

| Gate | Baseline (main) | After (ts7-stack-upgrade) |
|---|---|---|
| `npm run typecheck` (typegen + tsc) | 4.2s | **0.87s** |
| `tsc` alone | ~3.5s | **0.49s** (473% CPU — parallel checkers) |
| Unit/integration tests | 1156/1156, 122 files | **1156/1156, 122 files** |
| Production build | ✓ | ✓ |
| Playwright e2e (13 specs incl. auth, packet resolution, operator reaction, streaming run logs, notifications, theme persistence, StoreBrowser dialog) | 13/13 | **13/13** (three separate green runs) |
| Docker image (node:24-slim, better-sqlite3 native rebuild) | n/a (was node:22) | **builds clean** (exit 0) |
| `npm ci` from empty node_modules | ✓ | ✓ (overrides resolve cleanly) |

## 3. UI evidence (dev server, seeded data, authenticated session)

Same three surfaces screenshotted before and after — rendering is identical:
1. **Home** — greeting, 4 project cards, run counts ("3 runs active … 16 decisions"), pinned section. Zero browser-console errors after migration.
2. **Board (viberr-core)** — all 5 stage columns, 10 task cards, filters, sidebar counts identical.
3. **Task detail (VIB-151)** — live-run strip with ticking ELAPSED clock (07:19 baseline → 08:14 after; same seeded run still counting = timer logic alive), execution profile, permissions panel. The tab title `VIB-151 · Compress long-running task timelines` is produced by the migrated `meta({loaderData})` code.

Runtime behaviors verified directly on the new stack:
- **SSE live updates:** `EventSource("/resources/events?scope=project:viberr-core&scope=user")` opens and holds (onopen fired, no error); e2e specs 03/04 exercise the full SSE-revalidation loop and pass.
- **Module graph:** dev server serves `~/*`-aliased modules through Vite 8's native `resolve.tsconfigPaths` (plugin removed); `react-router/dom` chunk loads (v8 package layout).
- **Production server:** `react-router-serve ./build/server/index.js` on the Rolldown build → `/login` 200, `/` unauth → 302, `/resources/health` → `{"ok":true,"projections":{"projects":4,"tasks":41},"watcher":true,"backends":{"claude":"real","codex":"real"}}` — DB+migrations open, file watcher alive, and **both agent-SDK dynamic imports load at runtime** (validates the codex-sdk 0.144.1 bump beyond types; live Codex runs remain unverifiable until the quota resets ~Aug 2026).
- **codex-sdk 0.144.1 contract diff:** every symbol the adapter consumes verified present in the shipped d.ts (`Codex({apiKey,env})`, `startThread`/`resumeThread` incl. all 5 option keys, `runStreamed({signal,outputSchema})`, event names `thread.started`/`turn.completed`/`turn.failed`/`item.*`/`cached_input_tokens`).

## 4. Findings, deviations, and honest notes

1. **TS 6.0/7.0 surfaced exactly one code diagnostic** in ~83k LOC (the `?? null` dead code above) — a correct new check, fixed properly, no suppressions anywhere. `ignoreDeprecations` was never used.
2. **`rootDirs` + React Router typegen under tsgo** (the plan's #1 risk): works — verified empirically under both 6.0.3 and 7.0.2. Typecheck output error-identical across the bridge and the cutover, as the compat statement promises.
3. **Intermittent React hydration warning** (`06:47` vs `06:48` on the run-stats elapsed cell) observed in dev-mode e2e webserver logs on some runs. Root-caused to **pre-existing** code: `useElapsed` (app/features/runtime/runs-helpers.ts:64) seeds `useState(() => Date.now())`, so SSR and hydration inherently race across second boundaries. react/react-dom are unchanged (19.2.7) and the file is untouched by this branch; the warning is probabilistic and the affected e2e spec passes. Filed as a separate follow-up task (fix with a hydration-safe initial render).
4. **npm quirk:** the coordinated RR7→RR8 bump was impossible in-place (arborist anchored the installed v7 tree, ERESOLVE) — resolved by regenerating the lockfile from scratch, which the plan required anyway.
5. **e2e flakes under load:** running vitest+build+e2e concurrently in one shell produced 1–3 Playwright retries; isolated re-runs are consistently 13/13 in ~13s. Same behavior class as the pre-existing F8 flake fix in `main`'s history.
6. **README** stack/requirements lines updated (React Router 8, Node >= 24, TS 7).
7. **Not done, deliberately:** live Codex run (quota), TS 7.1 API adoption (not shipped), removing the typescript override (blocked on RR peer range), the optional tsx→native-type-stripping experiment (deferred; scripts import `~/*`-style paths via tsconfig paths which native stripping doesn't resolve).

## 5. Adversarial review

A 5-lens multi-agent review (RR8 completeness, Vite8/Rolldown deltas, TS7 config semantics, line-by-line diff correctness, infra coherence) with 3-vote adversarial verification per finding ran over the full branch. Results: see §6.

## 6. Adversarial review results

23 agents (5 finder lenses × 3-vote adversarial verification per finding; 1.1M tokens, ~11 min). Findings that survived ≥2 non-refuted votes:

### CONFIRMED HIGH — fixed on this branch
**`loginRedirect` built `returnTo` from the raw v8 pass-through `request.url`.** React Router 8 removed `future.v8_passThroughRequests`: loaders now always receive the RAW request, so on single-fetch client navigations `request.url` is the wire address (`/projects/x/board.data?_routes=…`). An expired-session client navigation therefore produced `/login?returnTo=%2F…%2Fboard.data%3F_routes%3D…`, `safeReturnTo` accepted it, and the re-authenticated user landed on the `.data` URL (client-router 404 or raw turbo-stream payload as the page). In v7 the framework rebuilt the request from the normalized path before calling loaders — this was a true migration regression, empirically reproduced by verifiers against the installed RR 8.2.0, and invisible to the e2e suite (which only reaches the login redirect via document requests).
**Fix:** `loginRedirect` now mirrors react-router's own `getNormalizedPath` (strip `/_.data`/`.data` pathname suffix, drop `_routes` param) — `app/server/auth/require-user.server.ts`. Covered by 4 new regression tests in `require-user.server.test.ts` (wire URL, wire URL + real params, root `/_.data`, untouched document URL) and proven live: unauthenticated `GET /projects/viberr-core/board.data` now returns a turbo-stream `SingleFetchRedirect` with `returnTo=%2Fprojects%2Fviberr-core%2Fboard`.

### CONFIRMED LOW — accepted / addressed
- **The `overrides: {"typescript":"$typescript"}` entry permanently silences the RR peer-range mismatch** (`^5.1||^6` vs 7.0.2), so a future RR upgrade that genuinely needs TS≤6 would fail as an opaque typegen error rather than an installer warning. Accepted as a documented risk (this doc + the plan); the override must be deleted as soon as RR peer-accepts ^7. Verifiers confirmed all supporting claims: exactly one `typescript` (7.0.2) in the lockfile, no non-erasable syntax anywhere, no ES2025-runtime-API gaps on Node 24, `types` array complete, module settings coherent.
- **README stated Node >= 20 / React Router 7** — fixed on this branch (lines 23/30). Historical `docs/build/` planning records intentionally left untouched.

### Refuted (examples)
_(see below — §7 records the post-review Node 26 addendum)_
- "`resolve.tsconfigPaths` is experimental and now the sole alias mechanism" — refuted: behavior verified equivalent for this repo's single `~/*` alias across dev/build/vitest; scripts/ and db/ don't use the alias.
- A duplicate of the typescript-override finding from a second lens.
- The diff-correctness lens confirmed the `stage-roles.ts` rewrite is semantically identical for all inputs (schema guarantees non-empty `from`), and both `@ts-expect-error` sites remain live and correct under TS7.

## 7. Addendum: Node 26 + the cold-start reload root-cause (same day, post-review)

At the owner's request the branch moved Node 24 → **26** (current line; LTS in Oct 2026): CI/Dockerfile/.nvmrc/engines/`@types/node@^26`/README. All floors permit it (better-sqlite3 ships 26.x prebuilds — native module verified loading on v26.4/26.5). Full gates re-ran green on Node 26; Docker builds on `node:26-slim`. Dev machines must switch defaults too (`nvm alias default 26`) — a mismatched Node loads an ABI-incompatible better-sqlite3 binary and the server fails loudly at boot.

**Cold-start e2e failure, root-caused (this was the earlier "contention flake" — that theory was wrong).** On the first run after any fresh `npm install`, e2e 02-packet + its downstream 05 spec failed deterministically. Playwright trace forensics: Vite discovered the server-side CJS deps (claude-agent-sdk, better-auth, better-sqlite3, dotenv, yaml) only at first render, pushed `optimized dependencies changed. reloading`, and the mid-test document reload aborted the manifest/SSE fetches and wiped the packet dialog's radio selection — the form then submitted the DEFAULT option (`accept_completion`), wrongly moving VIB-142 to Done. Two config attempts (`optimizeDeps.include`, `ssr.optimizeDeps.include`) did NOT fix it; React Router's supported `future.unstable_optimizeDeps` flag did — zero re-optimize on a fully cold cache, 13/13 e2e on two consecutive cold runs. The behavior class predates the migration (the same flag exists for RR7); the branch's reinstalls exposed it. Side benefit: no more random mid-session reloads during development.

## 8. Addendum: post-merge red CI on main — root-caused and fixed (68d238c)

After the fast-forward merge, CI failed on the F8 test (`agent-completion.server.test.ts`, "watchers are notified of the run failure: expected 0 to be greater than 0"). **This was not a migration regression: the base commit `5bb921f` (the PR #14 merge) already failed CI with the identical assertion hours before this branch existed.** Root cause: the failed-run branch of `applyAgentCompletionEffects` called `notifyTaskWatchers` without `ctx` — the only one of five call sites to omit it — so recipient resolution read the DEFAULT data root (`./data`). On dev machines that store exists (the test silently read the developer's real data and passed); in CI it doesn't, `loadProjectContext` threw `Project viberr-core not found`, and zero notifications were written. This was a real product bug, not just a test problem: failed-run owner/supervisor notifications were never delivered in any deployment whose data root isn't `./data`. Reproduced locally with `VIBERR_DATA_ROOT=<empty dir>` (fails exactly like CI), fixed by threading `ctx`, re-verified 6/6 + full suite 1160/1160 under the same hermetic root — no other test carries a hidden `./data` dependency.
