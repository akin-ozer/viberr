import type { DatabaseSync } from "node:sqlite";
import type {
  ResCatalogGroup,
  ResItemWarning,
} from "~/features/agents/capability-catalog";
import { kbRootDir, skillsRootDir } from "~/server/files/file-store-root.server";
import { isReservedMcpName } from "~/shared/mcp-reserved";
import {
  listMcpServers,
  listSkills,
  type McpView,
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
 *  - MCP servers: the org MCP registry (never the in-process `viberr` server —
 *    see below).
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
export function buildResourceCatalog(
  db: DatabaseSync,
  dataRoot?: string,
): ResCatalogGroup[] {
  const skillIds = new Set<string>(subDirNames(skillsRootDir(dataRoot)));
  for (const s of safe(() => listSkills(db))) skillIds.add(s.name);

  const kbIds = new Set<string>(subDirNames(kbRootDir(dataRoot)));
  const kbNames = new Map<string, string>();
  // SAFETY: `dir` is TEXT NOT NULL UNIQUE on `org_knowledge_bases`
  // (0001_baseline.sql), so every row of this one-column SELECT carries a string.
  for (const row of safe(() =>
    db.prepare(`SELECT dir, name FROM org_knowledge_bases`).all() as {
      dir: string;
      name: string;
    }[],
  )) {
    kbIds.add(row.dir);
    // U33-7: the store keeps a display name beside the directory; carry it so
    // the project editor can read like the other two editors. A KB folder with
    // no row (E7: a directory nobody registered) keeps its dir as its name.
    if (row.name.trim()) kbNames.set(row.dir, row.name.trim());
  }

  // P14-KM-14: the registry only, for BOTH profile kinds. `viberr` used to be
  // offered to the operator as a real-looking toggle over a decision the product
  // had already made: `buildOperatorToolkit` mounts the in-process server
  // unconditionally and `resolveSpecialistMcpServers` skips the reserved name,
  // so granting or revoking it changed nothing in either direction.
  const mcpIds = new Set<string>();
  const mcpWarnings = new Map<string, ResItemWarning>();
  for (const m of safe(() => listMcpServers(db))) {
    if (isReservedMcpName(m.name)) {
      continue; // never let a real org row shadow Viberr's own in-process tools
    }
    mcpIds.add(m.name);
    const warning = mcpRunWarning(m);
    if (warning) mcpWarnings.set(m.name, warning);
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
      items: [...mcpIds].sort().map((id) => {
        const warning = mcpWarnings.get(id);
        if (warning) return { id, def: false, warning };
        return { id, def: false };
      }),
    },
    {
      group: "Knowledge bases",
      key: "kb",
      mono: false,
      items: [...kbIds].sort().map((id) => {
        const label = kbNames.get(id);
        // Statements, not a conditional spread — the anti-slop rule.
        if (label && label !== id) return { id, def: false, label };
        return { id, def: false };
      }),
    },
  ];
}

/**
 * Ruling 479(b): why a run of any profile granting this server gets none of its
 * tools, read from the registry row the Settings list renders (no secret box
 * is opened here). The order is the run resolver's
 * (`resolveSpecialistMcpServersDetailed`): an unreadable credential and a
 * sign-in the server lacks both keep it off the run; a row whose last check
 * failed is mounted and flagged down, so the agent is told it may get nothing.
 * Live: the Platform Engineer's `cloudflare-api` chip read like its two healthy
 * neighbours while every run's record said "isn't mounted on this run … needs
 * sign-in", and the one remedy was named on another page.
 */
function mcpRunWarning(m: McpView): ResItemWarning | null {
  if (m.credUnreadable) {
    return {
      note: "credential unreadable",
      title: `Runs do not mount ${m.name}: its stored credential can't be opened. An org admin re-enters it in Instance settings → Agent resources.`,
    };
  }
  // Ruling 469: a pasted credential wins over a sign-in, and `mapMcp` reports
  // no sign-in status for such a row, so `oauth` here is the one that decides.
  if (m.oauth && m.oauth.status !== "signed_in") {
    const expired = m.oauth.status === "expired";
    return {
      note: expired ? "sign-in expired" : "needs sign-in",
      title: `Runs do not mount ${m.name} until an org admin signs it in${expired ? " again" : ""} (Instance settings → Agent resources).`,
    };
  }
  if (m.up === false) {
    return {
      note: "unreachable",
      title: `The last check could not reach ${m.name}, so a run may get none of its tools. An org admin retests it in Instance settings → Agent resources.`,
    };
  }
  return null;
}

function safe<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
