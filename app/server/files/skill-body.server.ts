import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { skillDirPath } from "~/server/files/file-store-root.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";

/** Read one skill's body (its SKILL.md, frontmatter stripped) from the store,
 * or "" when absent/unreadable. Shared by the agent runtimes so the operator
 * and specialists resolve declared skills identically. */
export function readSkillBody(name: string, dataRoot?: string): string {
  try {
    const file = path.join(skillDirPath(name, dataRoot), "SKILL.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      return body.trim();
    }
    // F12: a declared skill that resolves to no file on disk (typo / deleted
    // folder) was silently dropped, so the agent ran without craft it was
    // configured to have and nobody noticed. Flag it — the run still proceeds.
    logger.warn("declared agent skill not found on disk — run proceeds WITHOUT it", {
      skill: name,
    });
  } catch (error) {
    logger.warn("declared agent skill unreadable — run proceeds WITHOUT it", {
      skill: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
  }
  return "";
}
