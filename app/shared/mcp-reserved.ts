/**
 * Every MCP server name Viberr's own in-process tooling owns.
 *
 * `viberr` is the operator's server, `viberr_agent` the specialist toolkit,
 * `viberr_browser` the R19-19 browser server, `viberr_controller` the
 * controller's toolkit (ruling 99), `viberr_ops` its built-in diagnostics
 * (ruling 107) and `viberr_knowledge` the knowledge server Viberr's gateway
 * answers for a Codex run (ruling 585). Each is listed in BOTH spellings,
 * because a Codex run sees the hyphen form of a name the Claude side writes
 * with an underscore.
 *
 * ONE list, because three layers act on it and they used to disagree:
 *
 *  - the WRITER (`saveMcpServer`) refuses these names, so no org row can be
 *    created under one (P13-KM-12);
 *  - the PICKER (`buildResourceCatalog`) never offers a row that already
 *    carries one, so a grant cannot be made to something no run will mount
 *    (P14-KM-14);
 *  - the RESOLVER (`resolveSpecialistMcpServersDetailed`) never resolves one
 *    from the registry, because these servers are built in-process, not
 *    granted (P14-KM-15).
 *
 * The resolver kept a private copy of this list and it fell two rulings behind:
 * it knew nothing of `viberr_controller` or `viberr_ops`, so a row carrying one
 * — written straight into SQLite, restored from a backup, or created back when
 * the writer still allowed the name — resolved normally and, because org
 * servers mount LAST, REPLACED the instance's own in-process server under its
 * own mount key. The refusal at save only ever governed new rows; the layer
 * that decides what a run actually mounts is the one that has to hold.
 */
export const RESERVED_MCP_NAMES: ReadonlySet<string> = new Set([
  "viberr",
  "viberr_agent",
  "viberr-agent",
  "viberr_browser",
  "viberr-browser",
  "viberr_controller",
  "viberr-controller",
  "viberr_knowledge",
  "viberr-knowledge",
  "viberr_ops",
  "viberr-ops",
]);

/** Is this a name Viberr's own in-process tooling owns? */
export function isReservedMcpName(name: string): boolean {
  return RESERVED_MCP_NAMES.has(name);
}
