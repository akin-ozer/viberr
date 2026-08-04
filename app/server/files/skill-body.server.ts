import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  skillDirPath,
  skillsRootDir,
} from "~/server/files/file-store-root.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { logger } from "~/server/logging/logger.server";

/**
 * Shared skill → agent-context reader. The operator and every specialist resolve
 * declared skills through here, so there is ONE containment rule, ONE budget and
 * ONE honesty rule.
 *
 * BUDGET (P14-KM-03, then C2/pass-16). Knowledge bases have been budgeted since
 * F9; skills first got a cap in P14-KM-03 — but a PER-SKILL one, applied fresh
 * on every `readSkillBody` call inside the caller's loop. N skills × 24 k is
 * unbounded, which is precisely the failure the KB budget exists to prevent, so
 * {@link readSkillBodies} spends ONE shared budget across the whole declared
 * list exactly as the KB leg does — including the "omitted entirely" marker for
 * a skill that no longer fits, so a squeezed-out skill announces itself instead
 * of vanishing from the prompt.
 *
 * CONTAINMENT (A5/pass-16). A skill body is injected as TRUSTED persona material
 * — the run is explicitly told to treat it as authoritative operating context,
 * not as untrusted input. `readKbBody` has refused to follow symlinks out of the
 * store since F9, and every other store path agreed with it after P14-RV-02 —
 * except this reader, which dereferenced a symlinked `SKILL.md` (or a symlinked
 * skill FOLDER) and handed the target's content to the model as trusted
 * instructions. The store is a real directory that humans, uploads, imports and
 * agents all write into, so that is a reachable trust-boundary crossing.
 * Symlinks are refused here exactly the way `collectKbDocs` refuses them.
 */

/** Shared character budget across ALL of an agent's declared skills. */
export const SKILL_INJECTION_BUDGET = 24_000;

/** A declared skill that reached the run with less (or none) of its content. */
export interface UnresolvedSkillGrant {
  name: string;
  /** Why it produced nothing usable, in words a human can act on. */
  reason: string;
}

export interface SkillInjection {
  /** The text to inject ("" when nothing of this skill reached the run). */
  body: string;
  /** Present when the grant did not deliver what every UI says it delivers. */
  unresolved?: UnresolvedSkillGrant;
}

function lstatOr(target: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(target);
  } catch {
    return null;
  }
}

function realpathOr(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * Resolve a skill's `SKILL.md` with store containment.
 *
 * Returns the absolute file path, or the reason it produced nothing. Every step
 * refuses a symlink outright (`lstatSync` does NOT dereference) and the resolved
 * file is then re-checked against the realpath'd skills root, so neither a
 * linked folder, nor a linked file, nor a linked ancestor can escape the store.
 *
 * Exported so the org-settings skill editor (`resources.server.ts`) asks the
 * SAME question this injector does — A5-followup/pass-16. Its own reader
 * dereferenced links, so the editor showed a linked target's content as if it
 * were store content the runs would see (they refuse it), and its
 * `writeFileSync` followed the link straight back out of the store.
 */
export function resolveContainedSkillFile(
  name: string,
  dataRoot?: string,
): { file: string } | { reason: string } {
  const root = realpathOr(skillsRootDir(dataRoot));
  const dir = skillDirPath(name, dataRoot);
  const dirStat = lstatOr(dir);
  if (!dirStat) {
    // F12: a declared skill that resolves to no folder on disk (typo / deleted
    // folder) used to be silently dropped, so the agent ran without craft it was
    // configured to have and nobody noticed.
    return { reason: "no skill folder by that name in the store" };
  }
  if (dirStat.isSymbolicLink()) {
    return {
      reason:
        "its store folder is a symlink — Viberr does not follow links out of the store",
    };
  }
  if (!dirStat.isDirectory()) {
    return { reason: "its store entry is not a folder" };
  }
  const file = path.join(dir, "SKILL.md");
  const fileStat = lstatOr(file);
  if (!fileStat) return { reason: "its folder holds no SKILL.md" };
  if (fileStat.isSymbolicLink()) {
    return {
      reason:
        "its SKILL.md is a symlink — Viberr does not follow links out of the store",
    };
  }
  if (!fileStat.isFile()) return { reason: "its SKILL.md is not a file" };
  // Defense in depth: prove the resolved file really sits under the skills root
  // (catches a symlinked ancestor above the skill folder itself).
  const real = realpathOr(file);
  if (root === null || real === null || !real.startsWith(root + path.sep)) {
    return {
      reason:
        "its SKILL.md resolves outside the skills store — Viberr does not follow links out of the store",
    };
  }
  return { file };
}

/**
 * Read ONE skill's body (its SKILL.md, frontmatter stripped) under the store
 * containment rules above, bounded by `budgetChars`. A clipped body carries a
 * visible marker; a skill that could not be read at all reports WHY, so the
 * caller can put it in the run's prompt instead of only in a log line.
 */
export function readSkillBodyDetailed(
  name: string,
  dataRoot?: string,
  budgetChars: number = SKILL_INJECTION_BUDGET,
): SkillInjection {
  let resolved: ReturnType<typeof resolveContainedSkillFile>;
  try {
    resolved = resolveContainedSkillFile(name, dataRoot);
  } catch (error) {
    // `skillDirPath` throws on a traversal-shaped name (resolveStoreSegment).
    logger.warn("declared agent skill name is unsafe — run proceeds WITHOUT it", {
      skill: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return {
      body: "",
      unresolved: { name, reason: "its store name is not a valid folder name" },
    };
  }
  if ("reason" in resolved) {
    logger.warn("declared agent skill did not resolve — run proceeds WITHOUT it", {
      skill: name,
      reason: resolved.reason,
    });
    return { body: "", unresolved: { name, reason: resolved.reason } };
  }
  let trimmed: string;
  try {
    const { body } = splitFrontmatter(readFileSync(resolved.file, "utf8"));
    trimmed = body.trim();
  } catch (error) {
    logger.warn("declared agent skill unreadable — run proceeds WITHOUT it", {
      skill: name,
      err: error instanceof Error ? error : new Error(String(error)),
    });
    return {
      body: "",
      unresolved: { name, reason: "its SKILL.md could not be read" },
    };
  }
  if (!trimmed) {
    return { body: "", unresolved: { name, reason: "its SKILL.md is empty" } };
  }
  if (trimmed.length <= budgetChars) return { body: trimmed };
  if (budgetChars <= 0) {
    // The shared budget is already spent. Say so in the prompt rather than let
    // the skill disappear — the KB leg's P14-KM-05 rule, now on this leg too.
    logger.warn(
      "declared agent skill did not fit the run's injection budget — NOTHING of it reached the run",
      { skill: name, chars: trimmed.length },
    );
    return {
      body: `_(skill omitted entirely — SKILL.md is ${trimmed.length} chars and none of the shared skill budget was left)_`,
      unresolved: {
        name,
        reason: `it did not fit the shared ${SKILL_INJECTION_BUDGET}-char skill budget — none of its content reached this run`,
      },
    };
  }
  logger.warn("declared agent skill exceeds the injection budget — clipped", {
    skill: name,
    chars: trimmed.length,
    budgetChars,
  });
  return {
    body: `${trimmed.slice(0, budgetChars)}\n\n_(skill truncated — SKILL.md is ${trimmed.length} chars and exceeds the ${budgetChars}-char injection budget)_`,
  };
}

/** Read one skill's body, or "" when absent/unreadable/uncontained. Thin
 *  wrapper over {@link readSkillBodyDetailed} for callers that only inject. */
export function readSkillBody(
  name: string,
  dataRoot?: string,
  budgetChars: number = SKILL_INJECTION_BUDGET,
): string {
  return readSkillBodyDetailed(name, dataRoot, budgetChars).body;
}

export interface SkillInjectionSet {
  /** The skills that contributed text, in declaration order. */
  parts: { name: string; body: string }[];
  /** Grants that delivered nothing (C1) — the caller owes the run these. */
  unresolved: UnresolvedSkillGrant[];
}

/**
 * Read EVERY declared skill under ONE shared budget (C2), mirroring the KB leg.
 * Each skill draws from what the ones before it left, so a profile with many
 * skills can no longer contribute N × {@link SKILL_INJECTION_BUDGET} characters
 * to the prompt.
 */
export function readSkillBodies(
  names: readonly string[],
  dataRoot?: string,
  budgetChars: number = SKILL_INJECTION_BUDGET,
): SkillInjectionSet {
  const parts: { name: string; body: string }[] = [];
  const unresolved: UnresolvedSkillGrant[] = [];
  let budget = budgetChars;
  for (const name of names) {
    const injection = readSkillBodyDetailed(name, dataRoot, Math.max(0, budget));
    if (injection.unresolved) unresolved.push(injection.unresolved);
    if (injection.body) {
      parts.push({ name, body: injection.body });
      budget -= injection.body.length;
    }
  }
  return { parts, unresolved };
}
