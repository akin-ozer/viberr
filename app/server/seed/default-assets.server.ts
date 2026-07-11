import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// Bundle the shipped default agent assets INTO the server build (Vite `?raw`),
// so they are available in every environment (dev, container, tests) without a
// runtime dependency on the store/`data/` dir. These files under `assets/` are
// the shipped-by-default SOURCE OF TRUTH (tracked in git; `data/` is generated
// and gitignored). Editing them updates what ships; the boot step writes them
// into the store's `skills/` + `agents/definitions/` on first run.
import viberrSkillMd from "./assets/viberr-app-expertise.skill.md?raw";
import developerSkillMd from "./assets/developer-expertise.skill.md?raw";
import reviewerSkillMd from "./assets/reviewer-expertise.skill.md?raw";
import operatorDefinitionMd from "./assets/operator.definition.md?raw";
import developerDefinitionMd from "./assets/developer.definition.md?raw";
import reviewerDefinitionMd from "./assets/reviewer.definition.md?raw";
import operatorProfileMd from "./assets/operator.profile.md?raw";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { serializeAgentProfile } from "~/server/files/agent-profile-file.server";
import { logger } from "~/server/logging/logger.server";
import { SEED_AGENT_PROFILES } from "./demo-data.server";

/**
 * Ships Viberr's DEFAULT agent assets — the operator PLUS the base specialists
 * (Developer, Reviewer) — into the live store: each agent's expertise
 * skill, its detailed definition (persona), and its profile template. Writes
 * each into `${VIBERR_DATA_ROOT}` the first time a store lacks it, so the agent
 * runtimes can load them from the store (file-native, so a user can then edit
 * them). Only writes when the destination is missing — never clobbers edits.
 *
 * Every agent run has a baked-in fallback persona, so a store without these
 * assets still works; this makes the richer, editable, skill-backed versions
 * available so the built-in agents are usable across every board.
 */

/** The base specialist profile ids shipped into every store (built-in agents). */
const DEFAULT_SPECIALIST_IDS = ["developer", "reviewer"] as const;

/** Static prose assets bundled from `assets/` (skills + definitions + operator
 *  profile template). */
const STATIC_ASSETS: { rel: string; content: string }[] = [
  // Skills — one operating manual per agent role.
  { rel: path.join("skills", "viberr-app-expertise", "SKILL.md"), content: viberrSkillMd },
  { rel: path.join("skills", "developer-expertise", "SKILL.md"), content: developerSkillMd },
  { rel: path.join("skills", "reviewer-expertise", "SKILL.md"), content: reviewerSkillMd },
  // Definitions — the detailed persona + personality each run loads.
  { rel: path.join("agents", "definitions", "operator.md"), content: operatorDefinitionMd },
  { rel: path.join("agents", "definitions", "developer.md"), content: developerDefinitionMd },
  { rel: path.join("agents", "definitions", "reviewer.md"), content: reviewerDefinitionMd },
  // The operator PROFILE template — so an operator deployment resolves (kind,
  // backends, capabilities) in a store that was never demo-seeded, which is what
  // makes the operator preinstalled everywhere.
  { rel: path.join("agents", "profiles", "operator.md"), content: operatorProfileMd },
];

/**
 * The base specialist profile templates, generated from SEED_AGENT_PROFILES so
 * a deployment resolves (kind, backends, capabilities, resources) in a store
 * that was never demo-seeded — the counterpart of the operator profile template
 * that makes Developer/Reviewer preinstalled everywhere.
 */
function specialistProfileAssets(): { rel: string; content: string }[] {
  return SEED_AGENT_PROFILES.filter((p) =>
    (DEFAULT_SPECIALIST_IDS as readonly string[]).includes(p.frontmatter.id),
  ).map((p) => ({
    rel: path.join("agents", "profiles", `${p.frontmatter.id}.md`),
    content: serializeAgentProfile({
      frontmatter: p.frontmatter,
      description: p.description,
    }),
  }));
}

/** Write the default agent assets into the store if absent. Never throws. */
export function seedDefaultAgentAssets(dataRoot?: string): void {
  const store = getDataRoot(dataRoot);
  const assets = [...STATIC_ASSETS, ...specialistProfileAssets()];
  for (const asset of assets) {
    try {
      const dest = path.join(store, asset.rel);
      if (existsSync(dest)) continue;
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, asset.content, "utf8");
      logger.info("seeded default agent asset", { asset: asset.rel });
    } catch (error) {
      logger.error("failed seeding default agent asset", {
        asset: asset.rel,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
