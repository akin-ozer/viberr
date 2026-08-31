import type { DatabaseSync } from "node:sqlite";
import type { ResCatalogGroup } from "~/features/agents/capability-catalog";
import { kbRootDir, skillsRootDir } from "~/server/files/file-store-root.server";
import {
  isReservedMcpName,
  listMcpServers,
  listSkills,
  // The ONE store-folder lister. The private copy here used `statSync`, which
  // DEREFERENCES, so a symlinked `data/kb/<dir>` was offered in the profile
  // picker while org settings hid it and every run refused to read it — a
  // grant that resolves to nothing (P14-RV-02 / C5). Sharing the helper is
  // what keeps the picker and the settings list from disagreeing again.
  subDirNames,
} from "./resources.server";

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
 * The MCP set is the org REGISTRY, the same for every profile kind. The
 * in-process `viberr` toolkit is never listed (P14-KM-14): the operator toolkit
 * mounts it unconditionally and the specialist resolver skips it, so offering it
 * as a grant was a toggle over a decision the product had already made. The
 * former `profileKind` option existed only to scope that one name and went with
 * it (F7-RES3 superseded).
 */
export const RESERVED_OPERATOR_MCP = "viberr";


export function buildResourceCatalog(
  db: DatabaseSync,
  dataRoot?: string,
): ResCatalogGroup[] {
  const skillIds = new Set<string>(subDirNames(skillsRootDir(dataRoot)));
  for (const s of safe(() => listSkills(db))) skillIds.add(s.name);

  const kbIds = new Set<string>(subDirNames(kbRootDir(dataRoot)));
  // SAFETY: `dir` is TEXT NOT NULL UNIQUE on `org_knowledge_bases`
  // (0001_baseline.sql), so every row of this one-column SELECT carries a string.
  for (const row of safe(() =>
    db.prepare(`SELECT dir FROM org_knowledge_bases`).all() as { dir: string }[],
  )) {
    kbIds.add(row.dir);
  }

  // P14-KM-14: the registry only, for BOTH profile kinds. `viberr` used to be
  // offered to the operator as a real-looking toggle over a decision the product
  // had already made: `buildOperatorToolkit` mounts the in-process server
  // unconditionally and `resolveSpecialistMcpServers` skips the reserved name,
  // so granting or revoking it changed nothing in either direction.
  const mcpIds = new Set<string>();
  for (const m of safe(() => listMcpServers(db))) {
    if (isReservedMcpName(m.name)) {
      continue; // never let a real org row shadow Viberr's own in-process tools
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

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
