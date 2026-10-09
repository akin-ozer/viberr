/**
 * The product's name for each agent backend, as every human-facing string
 * spells it: toasts, refusals, pickers, run and timeline copy, the controller's
 * replies and the model's own prompt.
 *
 * Ruling 298 (R21-9, owner 2026-08-21): the claude backend is "Claude", never
 * "Claude Code". A sentence about the actual Claude Code product (the CLI
 * login, transcript retention, the coding harness) names that product itself
 * and does not read this map.
 *
 * No imports and no `.server` suffix: the runtime, the mapping layer and the
 * file-store codec all read it without closing an import cycle, and a browser
 * module can import it too.
 *
 * Ruling 11 keeps the task page and the controller page off it. This module
 * ships as its own chunk, and importing it from a module those pages load adds
 * ~70 B gzip to two budgets that have no room. So the run console
 * (`runs-panels.tsx`, `runs-panels-derive.ts`) spells the two labels itself,
 * and the task page's run controls (`execution-profile.tsx`,
 * `agent-select.tsx`, `continuity-loss.ts`) read them through
 * `run-principal-view.ts`'s `backendLabelOf`, the task page's one copy.
 */
export const BACKEND_LABEL = { claude: "Claude", codex: "Codex" } as const;
