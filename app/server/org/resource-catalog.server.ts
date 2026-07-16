import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { ResCatalogGroup } from "~/features/agents/capability-catalog";
import { kbRootDir, skillsRootDir } from "~/server/files/file-store-root.server";
import { listMcpServers, listSkills } from "./resources.server";

/**
 * Build the LIVE agent resource catalog (F6 / item-2): the real skills, MCP
 * servers, and knowledge bases available in this store, for the create/edit
 * agent-profile picker. This replaces the hardcoded mock `RES_CATALOG`, whose
 * items (`repo-write`, `http-fetch`, "Coding standards"…) resolved to nothing —
 * so a resource created in org settings could never be granted to an agent.
 *
 * Sources, merged + de-duped:
 *  - Skills: every on-disk `data/skills/<name>/` folder (the shipped expertise
 *    skills the built-in agents actually load) ∪ org-managed `org_skills` rows.
 *  - MCP servers: the in-process `viberr` governance server ∪ org MCP registry.
 *  - Knowledge bases: every on-disk `data/kb/<dir>/` folder (what runs inject)
 *    ∪ org-managed `org_knowledge_bases` rows (E7: a KB row whose folder
 *    vanished stays grantable/visible, consistent with org-settings).
 *
 * `id` is the reference the run layer resolves (skill name, MCP name, KB dir),
 * so a grant made here actually reaches the agent's context.
 *
 * `profileKind` scopes the MCP set (F7-RES3): the in-process `viberr` toolkit is
 * the OPERATOR's own coordination server and is never resolvable through a
 * specialist's `resources.mcps` (specialist-mcp.server.ts skips it), so it must
 * not be offered as a specialist-attachable MCP. It stays in the general/operator
 * catalog (the default) so existing operator surfaces are unchanged.
 */
export const RESERVED_OPERATOR_MCP = "viberr";

export function buildResourceCatalog(
  db: Database.Database,
  dataRoot?: string,
  opts: { profileKind?: "operator" | "specialist" } = {},
): ResCatalogGroup[] {
  const skillIds = new Set<string>(dirNames(skillsRootDir(dataRoot)));
  for (const s of safe(() => listSkills(db))) skillIds.add(s.name);

  const kbIds = new Set<string>(dirNames(kbRootDir(dataRoot)));
  for (const row of safe(() =>
    db.prepare(`SELECT dir FROM org_knowledge_bases`).all() as { dir: string }[],
  )) {
    kbIds.add(row.dir);
  }

  const mcpIds =
    opts.profileKind === "specialist"
      ? new Set<string>()
      : new Set<string>([RESERVED_OPERATOR_MCP]);
  for (const m of safe(() => listMcpServers(db))) {
    if (opts.profileKind === "specialist" && m.name === RESERVED_OPERATOR_MCP) {
      continue; // never let a real org row shadow the reserved operator toolkit
    }
    mcpIds.add(m.name);
  }

  return [
    {
      group: "Skills",
      key: "skills",
      mono: true,
      items: [...skillIds].sort().map((id) => ({ id, def: false })),
    },
    {
      group: "MCP servers",
      key: "mcps",
      mono: true,
      items: [...mcpIds].sort().map((id) => ({ id, def: false })),
    },
    {
      group: "Knowledge bases",
      key: "kb",
      mono: false,
      items: [...kbIds].sort().map((id) => ({ id, def: false })),
    },
  ];
}

/** Immediate sub-directory names of a store root ([] when absent). */
function dirNames(root: string): string[] {
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((entry) => {
      try {
        return statSync(path.join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
