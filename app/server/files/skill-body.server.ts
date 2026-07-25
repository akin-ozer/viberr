import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { skillDirPath } from "~/server/files/file-store-root.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";

/**
 * Per-skill character budget for prompt injection (P14-KM-03).
 *
 * Knowledge bases have been budgeted since F9 (KB_INJECTION_BUDGET); skills had
 * NO cap at all, so whatever SKILL.md happened to be on disk — an upload, a
 * GitHub import, anything up to the editor's 256 KB read cap — landed verbatim
 * in every operator and specialist system prompt. Same size as the KB budget so
 * one oversized resource can't crowd out the run's actual instructions.
 */
export const SKILL_INJECTION_BUDGET = 24_000;

/** Read one skill's body (its SKILL.md, frontmatter stripped) from the store,
 * or "" when absent/unreadable. Shared by the agent runtimes so the operator
 * and specialists resolve declared skills identically. Bounded by
 * {@link SKILL_INJECTION_BUDGET}; a clipped body carries a visible marker, the
 * same honesty rule the KB reader follows. */
export function readSkillBody(
  name: string,
  dataRoot?: string,
  budgetChars: number = SKILL_INJECTION_BUDGET,
): string {
  try {
    const file = path.join(skillDirPath(name, dataRoot), "SKILL.md");
    if (existsSync(file)) {
      const { body } = splitFrontmatter(readFileSync(file, "utf8"));
      const trimmed = body.trim();
      if (trimmed.length <= budgetChars) return trimmed;
      logger.warn("declared agent skill exceeds the injection budget — clipped", {
        skill: name,
        chars: trimmed.length,
        budgetChars,
      });
      return `${trimmed.slice(0, budgetChars)}\n\n_(skill truncated — SKILL.md is ${trimmed.length} chars and exceeds the ${budgetChars}-char injection budget)_`;
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
