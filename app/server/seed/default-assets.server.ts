import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// Bundle the shipped default operator assets INTO the server build (Vite
// `?raw`), so they are available in every environment (dev, container, tests)
// without a runtime dependency on the store/`data/` dir. These two files under
// `assets/` are the shipped-by-default SOURCE OF TRUTH (tracked in git; `data/`
// is generated and gitignored). Editing them updates what ships; the boot step
// writes them into the store's `skills/` + `agents/definitions/` on first run.
import viberrSkillMd from "./assets/viberr-app-expertise.skill.md?raw";
import operatorDefinitionMd from "./assets/operator.definition.md?raw";
import operatorProfileMd from "./assets/operator.profile.md?raw";
import { getDataRoot } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";

/**
 * Ships Viberr's DEFAULT operator assets — the `viberr-app-expertise` skill and
 * the operator agent definition — into the live store. Writes each into
 * `${VIBERR_DATA_ROOT}` the first time a store lacks it, so the operator
 * runtime can load them from the store (file-native, so a user can then edit
 * them). Only writes when the destination is missing — never clobbers edits.
 *
 * The operator run has a baked-in fallback persona, so a store without these
 * assets still works; this just makes the richer, editable versions available.
 */

const DEFAULT_ASSETS: { rel: string; content: string }[] = [
  {
    rel: path.join("skills", "viberr-app-expertise", "SKILL.md"),
    content: viberrSkillMd,
  },
  {
    rel: path.join("agents", "definitions", "operator.md"),
    content: operatorDefinitionMd,
  },
  // The operator PROFILE template — so an operator deployment resolves (kind,
  // backends, capabilities) in a store that was never demo-seeded, which is
  // what makes the operator preinstalled everywhere.
  {
    rel: path.join("agents", "profiles", "operator.md"),
    content: operatorProfileMd,
  },
];

/** Write the default operator assets into the store if absent. Never throws. */
export function seedDefaultOperatorAssets(dataRoot?: string): void {
  const store = getDataRoot(dataRoot);
  for (const asset of DEFAULT_ASSETS) {
    try {
      const dest = path.join(store, asset.rel);
      if (existsSync(dest)) continue;
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, asset.content, "utf8");
      logger.info("seeded default operator asset", { asset: asset.rel });
    } catch (error) {
      logger.error("failed seeding default operator asset", {
        asset: asset.rel,
        err: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
}
