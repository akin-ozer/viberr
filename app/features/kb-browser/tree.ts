/**
 * StoreBrowser tree contract (kb-browser spec §3.1) — pure, client-safe.
 *
 * The mock stored display strings ("4.2 KB", "Mar 30") on nodes; the real
 * projection carries `sizeBytes` + `mtime` (ISO) and formats at render
 * time (spec §7). Trees are scanned from the REAL store directory server-
 * side (app/server/org/store-files.server.ts) — dirs first, then files.
 *
 * Exported for org-settings rows per the spec: countKbFiles, prettySize
 * (the folder glyph is `Icon`'s `folder`, ruling 458(f)).
 */

export type StoreNode =
  | { type: "dir"; name: string; children: StoreNode[] }
  | { type: "file"; name: string; sizeBytes: number; mtime: string };

/** Recursive file count (dirs contribute their descendants). */
export function countKbFiles(nodes: StoreNode[] | undefined): number {
  return (nodes ?? []).reduce(
    (a, n) => a + (n.type === "dir" ? countKbFiles(n.children) : 1),
    0,
  );
}

/** Recursive dir count (footer stats). */
export function countKbDirs(nodes: StoreNode[] | undefined): number {
  return (nodes ?? []).reduce(
    (a, n) => a + (n.type === "dir" ? 1 + countKbDirs(n.children) : 0),
    0,
  );
}

/** bytes → "512 B" | "1.5 KB" | "2.0 MB" (mock prettySize, verbatim). */
export function prettySize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FlatRow {
  node: StoreNode;
  /** Parent path (dir names). */
  path: string[];
  depth: number;
  /** Slash-joined own path — expansion key. */
  key: string;
  open?: boolean;
}

/** Visible rows: dirs first then files at each level; recurses only into
 * expanded dirs (mock flatten, verbatim semantics). */
export function flatten(
  nodes: StoreNode[] | undefined,
  path: string[],
  depth: number,
  expanded: ReadonlySet<string>,
  out: FlatRow[],
): FlatRow[] {
  const dirs = (nodes ?? []).filter((n) => n.type === "dir");
  const files = (nodes ?? []).filter((n) => n.type !== "dir");
  for (const n of dirs) {
    const p = [...path, n.name];
    const key = p.join("/");
    out.push({ node: n, path, depth, key, open: expanded.has(key) });
    if (expanded.has(key) && n.type === "dir") {
      flatten(n.children, p, depth + 1, expanded, out);
    }
  }
  for (const n of files) {
    out.push({ node: n, path, depth, key: [...path, n.name].join("/") });
  }
  return out;
}
