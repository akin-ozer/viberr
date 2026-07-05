/**
 * The mock's slugify (org-settings.jsx, verbatim semantics): lowercase,
 * non-alphanumerics collapse to "-", trim leading/trailing "-". Used for
 * connection ids (owner), KB dirs, MCP/skill names and agent-profile ids.
 * Client-safe (no .server suffix) — shared by the org-settings UI and the
 * app/server/org helpers so both sides mint identical ids.
 */
export function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
