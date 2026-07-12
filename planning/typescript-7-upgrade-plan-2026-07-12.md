# TypeScript 7 conversion + dependency upgrade plan

**Date:** 2026-07-12 · **Status:** PLANNED (not started)
**Posture:** Breaking changes welcome. No migration shims, no dual-support windows, no `ignoreDeprecations`. Pre-release product — break it and move forward.

---

## 1. What TypeScript 7 is (research summary, verified 2026-07-12)

- **TS 7.0 went GA on July 8, 2026** (RC June 18). It is the Go-native compiler from Project Corsa ("tsgo"), now published as the **regular `typescript` npm package** — the `tsc` binary in `typescript@7.0.2` *is* the native compiler. There is no separate `tsgo` binary anymore; `@typescript/native-preview` was the preview-era package.
- **Performance:** ~8–12× faster full type-checks (VS Code repo: 125.7s → 10.6s; Sentry: 139.8s → 15.7s), 6–26% less memory, ~13× faster editor error reporting. Parallel by default: `--checkers` (default 4 type-check workers), `--builders` for project references, `--singleThreaded` to disable.
- **Same type system:** the checker was transplanted file-by-file from the JS codebase, not redesigned. Official compatibility statement: *code that compiles cleanly under TS 6.0 (with `stableTypeOrdering`, without `ignoreDeprecations`) compiles identically under 7.0*.
- **The one big hole: TS 7.0 ships NO programmatic compiler API.** A new (different) API arrives in **TS 7.1** (nightlies `7.1.0-dev.*` are already publishing). Tools that `import "typescript"` (typescript-eslint, ts-morph, custom transformers) must keep resolving a TS 6 package until then. Microsoft ships `@typescript/typescript6@6.0.2` (bin: `tsc6`, re-exports the TS6 API) for side-by-side setups.
- **Hard removals in 7.0** (deprecated in 6.0, escape hatch gone): `target: es5`, `downlevelIteration`, `module: amd|umd|systemjs|none`, `outFile`, `moduleResolution: node10|classic`, `baseUrl`, `esModuleInterop`/`allowSyntheticDefaultImports`/`alwaysStrict` forced `true`, `module Foo {}` keyword syntax, import `asserts` (→ `with`).
- **Defaults changed (from 6.0):** `strict: true`, `module: esnext`, floating `target` (currently es2025), `types: []` (no more auto-loading every `@types/*`), `rootDir: "."`, `noUncheckedSideEffectImports: true`, `libReplacement: false`. Running `tsc file.ts` with a tsconfig present is now an error (TS5112).
- **Language-level changes in 7.0:** template-literal type inference splits on Unicode code points (not UTF-16 units); JSDoc-in-JS support reworked (stricter). Neither affects this repo (no `checkJs`, no JS sources, no code-point-sensitive template-literal types found).
- **Watch mode** rebuilt on a Go port of Parcel's watcher. **VS Code** ships/rolls out a native TS7 language server (toggle: "Enable TypeScript 7 Language Server"); note `typescript@7` no longer ships `tsserver` — the editor LS is delivered by VS Code itself.

## 2. Codebase readiness assessment (from full inventory, 2026-07-12)

This repo is unusually well-positioned — most of the classic TS7 migration pain simply doesn't exist here:

| TS7 risk area | Status in viberr |
|---|---|
| `tsc` used for emit | **No** — `noEmit: true`; Vite/esbuild does all emit. `tsc` is a pure typecheck gate (`npm run typecheck` = `react-router typegen && tsc`) |
| Legacy constructs (`namespace`, `enum`, `const enum`, decorators, `/// <reference`, `import=require`, `export=`, `declare module`) | **Zero occurrences** across all 385 source files (~83.4k LOC) |
| CommonJS | **None** — pure ESM (`"type": "module"`, no `require()`, no `.cts/.mts`) |
| Removed tsconfig options (`baseUrl`, `node10`, es5, outFile, AMD…) | **None used.** Config already: `moduleResolution: bundler`, `strict: true`, `verbatimModuleSyntax: true`, explicit `types: ["node", "vite/client"]`, `paths` without `baseUrl` |
| TS compiler API consumers | **None in the repo.** No eslint/typescript-eslint/ts-morph/transformers. React Router's typegen is **Babel-based** (`@babel/preset-typescript`) — verified in `@react-router/dev` dist; the `typescript` peer dep is optional and never imported on our code paths (the only `import('typescript')` in the tree is tsconfck's lazy `parseNative`, which `vite-tsconfig-paths` doesn't use by default) |
| New `types: []` / `rootDir` defaults | Already explicit in tsconfig — no behavior change |
| `@ts-expect-error` flips | 2 sites to watch: `app/features/kb-browser/store-browser.tsx:770`, `app/server/tasks/operator-actions.server.test.ts:860` (an *unused* expect-error is itself an error) |
| `rootDirs` + React Router typegen | **The one flagged unknown.** tsconfig uses `rootDirs: [".", "./.react-router/types"]` for RR's generated `+types/*` modules. Not on any removal list and covered by the 6.0→7.0 compat statement, but it's the first thing Phase 2/4 verifies empirically |

**Toolchain reality check (npm registry, 2026-07-12):** most deps are already at latest (react 19.2.7 ✓, zod 4.4.3 ✓, better-sqlite3 12.11.1 ✓, playwright 1.61.1 ✓, jsdom 29.1.1 ✓, better-auth 1.6.23 = pinned **and already latest**). The real upgrade surface is:

| Package | Current | Latest | Jump |
|---|---|---|---|
| typescript | 5.9.3 | **7.0.2** | 2 majors (via 6.0.3 bridge) |
| react-router + @react-router/{dev,node,serve} | 7.18.1 | **8.2.0** | major |
| vite | 7.3.6 | **8.1.4** | major (Rolldown) |
| vitest | 4.1.9 | 4.1.10 | patch |
| @openai/codex-sdk | 0.142.5 | 0.144.1 | 0.x minor (out of caret range) |
| @anthropic-ai/claude-agent-sdk | 0.3.201 | 0.3.207 | in-range |
| isbot | 5.1.44 | 5.2.0 | minor |
| Node (CI/Docker) | 22 | **24 LTS** | major (RR8 requires ≥22.22.0) |

**Peer-dependency facts that shape the plan (verified against the registry):**
- `@react-router/dev@8.2.0`: peers `vite: ^7.0.0 || ^8.0.0` ✓, `typescript: ^5.1.0 || ^6.0.0` (optional) ✗ **excludes TS7**, engines `node >=22.22.0`.
- `vitest@4.1.10`: peers `vite: ^6 || ^7 || ^8` ✓. `vite-tsconfig-paths`: `vite: *` ✓.
- RR8 breaking changes are tiny for us: `react-router-dom` package removed (**we don't import it — verified**), `meta({ data })` removed in favor of `loaderData` (**2 call sites**: `app/routes/project.task.tsx:476`, `app/routes/project.tsx:28`), Cloudflare/Architect changes (N/A). No `future.v8_*` flags are set in `react-router.config.ts` — we absorb v8 defaults directly in the bump and fix whatever the test suite catches.
- Node floor of the installed tree is already ≈20.19, with kysely (via better-auth) at ≥22; `engines` says `>=20` — currently a lie. Fixed in Phase 1.
- `better-sqlite3` (native) supports Node `20–26.x` → Node 24 is safe; Dockerfile already carries a source-build fallback.

## 3. Target end state

- **TypeScript 7.0.2** as the one and only `typescript` package. `tsc` = native compiler. No TS6 alias kept around (fallback documented below, not installed).
- **Node 24 LTS** everywhere: CI, Dockerfile, `engines: ">=24"`.
- **React Router 8.2 + Vite 8.1 (Rolldown)** runtime stack.
- Modernized tsconfig (see Phase 4) — es2025 lib/target, `module: esnext`, `erasableSyntaxOnly`.
- Every other dep at latest; `package-lock.json` regenerated fresh.

### Final tsconfig.json
```json
{
  "include": ["**/*", "**/.server/**/*", "**/.client/**/*", ".react-router/types/**/*"],
  "exclude": ["data", "docker-data", "build", "node_modules", "e2e/.tmp-data"],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2025"],
    "types": ["node", "vite/client"],
    "target": "ES2025",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "rootDirs": [".", "./.react-router/types"],
    "paths": { "~/*": ["./app/*"] },
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "strict": true
  }
}
```
Notes: `esModuleInterop` deleted (forced `true` in 7). `target`/`lib` → ES2025 (Node 24 covers it; tsc is noEmit so this only affects checking — Vite's own build target is separate). `erasableSyntaxOnly` is free to enable (zero enums/namespaces) and future-proofs for native Node type-stripping.

### Final package.json deltas
```jsonc
{
  "engines": { "node": ">=24" },
  "devDependencies": {
    "typescript": "^7.0.2",          // was ^5.9.3
    "vite": "^8.1.4",                // was ^7.3.6
    "@react-router/dev": "^8.2.0",   // was ^7.18.1
    "vitest": "^4.1.10"
  },
  "dependencies": {
    "react-router": "^8.2.0",
    "@react-router/node": "^8.2.0",
    "@react-router/serve": "^8.2.0",
    "@openai/codex-sdk": "^0.144.1",
    "@anthropic-ai/claude-agent-sdk": "^0.3.207",
    "isbot": "^5.2.0"
  },
  // The one hack, and it's temporary: RR8 peer-declares typescript ^5.1||^6
  // (optional peer, Babel does its transpile — the API is never imported on our paths).
  // Force npm to accept TS7 rather than keeping a vestigial TS6 installed:
  "overrides": { "typescript": "$typescript" }
}
```
Scripts stay identical — `typecheck: react-router typegen && tsc` just becomes native-fast.

## 4. Phased execution

Each phase = one PR, independently green (typecheck + `vitest run` + `npm run build` + e2e), independently revertable. Order chosen so every step is peer-dep-legal: TS6 satisfies both RR7 and RR8 peers; TS7 (needs the override) lands after RR8.

### Phase 0 — Baseline (½ h)
1. On current `main`: `npm run typecheck && npm test && npm run build && npm run e2e` — record pass state and **wall-clock time of `tsc`** (the before-number for the 7.0 speedup).
2. Commit any drift. Note: `.claude/worktrees/*` and `data/projects/*/workspace/*` contain stale repo copies — excluded from tsconfig, ignore throughout; runtime agent workspaces regenerate themselves.

### Phase 1 — Node 24 foundation (1 h)
1. CI `.github/workflows/ci.yml`: `node-version: 22` → `24`.
2. `Dockerfile`: both stages `node:22-slim` → `node:24-slim`. Verify `better-sqlite3` prebuilt binary resolves in the image build (fallback toolchain already present).
3. `package.json` `engines`: `">=20"` → `">=24"` (the `>=20` claim is already false given kysely's `>=22` floor).
4. Local: `nvm use 24` (add `.nvmrc` with `24` so the floor is discoverable), full `npm ci` + all gates + one manual `npm run dev` smoke.

### Phase 2 — TypeScript 6.0.3 bridge (½ day)
Purpose: surface *every* 7.0 removal as a diagnostic while the ecosystem is still peer-legal (`^6` satisfies RR7/RR8), and pre-verify type-identity for 7.
1. `npm i -D typescript@6.0.3`.
2. Add `"stableTypeOrdering": true` to tsconfig (6.0-only migration flag; it forces 7.0's inference ordering, ~25% slower — temporary).
3. Delete `"esModuleInterop": true` from tsconfig (forced on in 6+).
4. `rm -rf .react-router && npm run typecheck`. Expected fallout, in likelihood order:
   - new diagnostics from changed lib.dom/lib.es2025 signatures (config inherits new floating target — pin `target`/`lib` explicitly this phase if the churn is unwanted; final values land in Phase 4 anyway),
   - the two `@ts-expect-error` sites flipping to "unused expect-error",
   - inference-order errors from `stableTypeOrdering` → fix with explicit type arguments/annotations (do NOT suppress),
   - **`rootDirs` + `.react-router/types` resolution — the key empirical check.** If typegen'd `Route.MetaArgs` imports break here, that's a stop-the-line finding to investigate before Phase 4 (this is TS6, so it would be a config problem, not a tsgo one).
5. Confirm zero uses of `ignoreDeprecations` anywhere. Fix every deprecation diagnostic for real.
6. All gates green. Merge.

### Phase 3 — React Router 8.2 + Vite 8.1 (1 day)
One PR, bumped together (RR8 requires Vite ≥7 and supports 8; splitting buys nothing).
1. `npm i react-router@8 @react-router/node@8 @react-router/serve@8 && npm i -D @react-router/dev@8 vite@8 vitest@4.1.10`.
2. Code changes (verified exhaustive for this repo):
   - `app/routes/project.task.tsx:476` and `app/routes/project.tsx:28`: `meta({ data })` → `meta({ loaderData })`.
   - `rm -rf .react-router` (typegen cache is not trustworthy across majors), regenerate via `npm run typecheck`.
3. Vite 8 (Rolldown/Oxc/Lightning CSS) exposure check — expected near-zero here: no `build.rollupOptions`, no `optimizeDeps.esbuildOptions`, no custom plugins beyond `reactRouter()` + `tsconfigPaths()` (peer `vite: *`). Watch two things: CJS-interop strictness on dep imports (Rolldown is stricter; fix imports at call sites rather than reaching for `legacy.inconsistentCjsInterop`) and byte-identical-ish behavior of `app/app.css` (2,981 lines) through Lightning CSS.
4. RR8 behavior deltas (no `future.v8_*` flags were pre-adopted): run the full suite + all 6 e2e specs; pay specific attention to SSE/live-updates routes (D9 SSE work from pass 3) and the resource routes under `app/routes/`.
5. Manual smoke: `npm run dev` (HMR, board page, task detail, live updates), `npm run build && npm run start`.

### Phase 4 — TypeScript 7.0.2 cutover (½ day)
1. `npm i -D typescript@7.0.2`, add `"overrides": { "typescript": "$typescript" }` to package.json (silences RR8's `^5.1||^6` optional-peer range; the API it guards is never imported — Babel does RR's transpile).
2. tsconfig: remove `stableTypeOrdering` (7.0's native behavior), apply the final config from §3 (`target`/`lib` ES2025, `module: ESNext`, `erasableSyntaxOnly: true`).
3. `rm -rf .react-router && npm run typecheck` — per the compat statement this should be **error-identical to Phase 2's end state**. Any divergence (esp. `rootDirs`/`paths` resolution of `+types/*` modules) is a tsgo bug: minimize and report upstream; interim fallback is below.
4. Measure and record the new `tsc` wall-clock vs Phase 0 (~83k LOC — expect the typecheck step to drop to a few seconds; tune `--checkers` in CI only if the default 4 isn't already saturating).
5. Editor notes for the README/CLAUDE.md: use VS Code's built-in TS7 language server ("Enable TypeScript 7 Language Server" during rollout); `typescript@7` ships no `tsserver`, so "use workspace version" no longer applies.
6. **Documented fallback (do not pre-install):** if something unexpectedly needs the TS6 API before TS 7.1, switch to Microsoft's dual layout — `"typescript": "npm:@typescript/typescript6@^6.0.2"` (API + `tsc6` bin, legitimately satisfies all peers) + `"@typescript/native": "npm:typescript@^7.0.2"` (`tsc` bin) — and drop the override. That's the officially sanctioned shape until 7.1 restores an API.

### Phase 5 — Long-tail dependency sweep (½ day)
1. `@openai/codex-sdk` `^0.142.5` → `^0.144.1`. Out-of-caret 0.x bump = semver-breaking by convention. Review the SDK changelog against our Codex runtime adapter call sites; **live verification is blocked** (Codex quota exhausted until ~Aug 2026), so lean on the adapter's unit tests and type errors — flag any API-shape change loudly in the PR.
2. `@anthropic-ai/claude-agent-sdk` → 0.3.207 (in-range), `isbot` → ^5.2.0, `@types/*` refresh within majors (`@types/node` stays on 24 to match the runtime; 26 would type APIs Node 24 doesn't have).
3. `better-auth` stays **pinned at 1.6.23 — it is the current latest**; nothing to do. Standing warning for whenever a newer version appears: bumping it can change the generated `db/migrations/0013_better_auth.sql` (via `scripts/gen-better-auth-schema.ts`) — that's a DB-migration event, not a version swap; regenerate + reconcile deliberately.
4. Fresh lockfile: `rm -rf node_modules package-lock.json && npm i`, then `npm ls --depth 0` clean + full gates. Confirms the override and all peer ranges resolve from scratch (what contributors and CI actually experience).

### Phase 6 — Cleanup & follow-ups (opportunistic)
- **When TS 7.1 ships** (nightlies already flowing): re-check `@react-router/dev`'s typescript peer range; delete the `overrides` entry the moment RR accepts `^7`.
- **Optional — drop `tsx`:** with `erasableSyntaxOnly` and zero non-erasable syntax, Node 24 can run `scripts/*.ts` natively via type stripping. Blocker to verify first: native stripping does not resolve the `~/*` path alias — only viable if `scripts/` imports stay alias-free. Nice-to-have, not part of the main migration.
- Record the before/after typecheck timing in the repo docs; consider a `--checkers` bump in CI if profiling shows headroom.

## 5. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | tsgo mishandles `rootDirs` + RR typegen resolution | Low (not on removal lists; compat statement covers it) | High — typecheck gate dies | Empirically tested twice (Phase 2 under TS6 semantics, Phase 4 under tsgo). Fallback: `tsc6` from the dual layout while reporting upstream |
| 2 | RR8 behavior shifts absorbed without future-flag rehearsal | Medium | Medium | 122 test files + 6 e2e specs + manual SSE/dev/build smoke in Phase 3; single revertable PR |
| 3 | Rolldown CJS-interop strictness breaks a dep import | Low–Medium | Medium | Vite 8 bump isolated in Phase 3; fix call sites; `legacy.inconsistentCjsInterop` exists but is a corner we've chosen not to cut |
| 4 | `overrides` masks a real future TS-API consumer | Low | Medium | Verified zero API imports today; fallback layout documented in Phase 4.6 |
| 5 | codex-sdk 0.x bump breaks the Codex adapter, unverifiable live until ~Aug 2026 | Medium | Low (Codex path already quota-dead) | Unit tests + changelog review; loud PR flag |
| 6 | better-sqlite3 ABI vs Node 24 in Docker | Low | Medium | Engine range includes 24–26; source-build fallback already in Dockerfile |
| 7 | Editor DX during TS7 LS rollout | Low | Low | VS Code built-in TS7 LS; document the toggle |

## 6. Explicitly out of scope
- **ESLint 10 / typescript-eslint:** not installed in this repo (lint is out-of-band via `npx react-doctor`); nothing to migrate, and we're not adding a linter as part of this pass.
- **Tailwind:** not used (plain CSS design system).
- **DB migrations / better-auth bump:** better-auth is already latest; no schema regeneration in this pass.
- **Backwards compatibility of any kind:** no dual-Node CI, no TS6 kept installed, no `legacy.*` Vite flags, no `ignoreDeprecations`.

## 7. Sources
- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) · [Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/)
- [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
- [microsoft/typescript-go](https://github.com/microsoft/typescript-go)
- [typescript-eslint TS7 tracking issue #10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) (context for the no-API caveat)
- [React Router: Updating from v7](https://reactrouter.com/upgrading/v7) · [React Router v8 announcement](https://remix.run/blog/react-router-v8)
- [Vite 8.0 announcement](https://vite.dev/blog/announcing-vite8) · [Vite migration guide](https://vite.dev/guide/migration)
- [Vitest migration guide](https://vitest.dev/guide/migration.html)
- [ESLint v10.0.0 released](https://eslint.org/blog/2026/02/eslint-v10.0.0-released/) (checked; N/A for this repo)
- npm registry version/peer checks performed locally 2026-07-12 (`typescript@7.0.2`, `@typescript/typescript6@6.0.2`, `@react-router/dev@8.2.0` peers/engines, `vitest@4.1.10` peers, `vite-tsconfig-paths` peers)
