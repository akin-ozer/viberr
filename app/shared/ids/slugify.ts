/**
 * The mock's slugify (org-settings.jsx, verbatim semantics): lowercase,
 * non-alphanumerics collapse to "-", trim leading/trailing "-". Used for
 * connection ids (owner), KB dirs, MCP/skill names, agent-profile ids, project
 * slugs and custom stage ids (project-create.server.ts), and the new-project
 * modal's repo default. Client-safe (no .server suffix) — shared by the UI
 * (org settings, the new-project modal) and the server helpers so both sides
 * mint identical ids.
 */
export function slugify(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
