/**
 * The product's name for each agent backend, as every human-facing string
 * spells it: toasts, refusals, pickers, run and timeline copy, the controller's
 * replies and the model's own prompt.
 *
 * Ruling 92 (R21-9, owner 2026-08-21): the claude backend is "Claude", never
 * "Claude Code". A sentence about the actual Claude Code product (the CLI
 * login, transcript retention, the coding harness) names that product itself
 * and does not read this map.
 *
 * No imports and no `.server` suffix: the runtime, the mapping layer and the
 * file-store codec all read it without closing an import cycle, and a browser
 * module can import it too.
 */
export const BACKEND_LABEL = { claude: "Claude", codex: "Codex" } as const;
