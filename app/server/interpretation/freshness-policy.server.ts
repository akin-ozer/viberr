/**
 * Freshness policy (P13-D-32) — the `server/interpretation/` door onto the
 * app's staleness rules, alongside readiness and diagnostics.
 *
 * `architecture.md` assigns freshness to this layer, and forbids UI components
 * from carrying interpretation logic. Two rules were violating both: the
 * GitHub reconcile chip in `features/github/github-query.server.ts` and the MCP
 * health dot, now in `features/org-settings/resource-rows.tsx`, each with its
 * own private 1-hour constant.
 *
 * The thresholds and predicates themselves live in `~/shared/freshness` — NOT
 * because this module is decorative, but because the MCP rule is evaluated in a
 * client component and `.server.ts` modules are stripped from the client
 * bundle. One definition, imported through the layer that owns it on the server
 * and directly from `shared/` in the browser. Add server-only freshness rules
 * here; add anything the UI also needs to `~/shared/freshness`.
 */

export {
  isMcpHealthStale,
  isReconcileStale,
  isStale,
  STALE_AFTER_MS,
} from "~/shared/freshness";
