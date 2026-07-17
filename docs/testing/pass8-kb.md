> Scope: summary of org testing-conventions KB rules
# Testing conventions KB summary
- Unit tests: `*.test.ts` beside sources; run via `npm test`; hermetic via temp `VIBERR_DATA_ROOT`.
- Form POST tests must include a `_csrf` field.
- E2E (`npm run e2e`) runs Playwright with an isolated data root/runtime; spends no real tokens.
Last reviewed: 2026-07-18
