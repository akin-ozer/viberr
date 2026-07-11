import { readProjectFile } from "~/server/files/project-writer.server";
import type { TaskMutationContext } from "./task-actions.server";

/**
 * REAL enforcement for the anti-noise guardrails (owner ruling Q3, 2026-07-11).
 * These shipped ON in every project but three of the five were decorative —
 * rendered in settings with zero enforcement code. The PRD names timeline noise
 * the #1 adoption risk, so the guardrails act on the CANONICAL record (task.md
 * is what every future agent prompt re-anchors on), not just the view:
 *
 * - `meaningful-comment`  → {@link isMeaninglessComment}: trivial status
 *   chatter ("ok", "done", "working on it") is dropped before it reaches the
 *   timeline.
 * - `operator-brevity`    → {@link enforceOperatorBrevity}: an operator
 *   narration comment is hard-capped; the overflow is trimmed with an explicit
 *   marker (operators narrate decisions — reports belong to agents).
 * - `evidence-separation` → {@link separateEvidence}: raw output dumps (long
 *   fenced blocks) are replaced by a head + truthful reference — the full
 *   output remains in the run's agent logs, which is where evidence lives.
 *
 * All pure; guardrail lookups are separate so callers wire them per project.
 */

/** Trivial status chatter that adds no information to the record. */
const CHATTER_RE =
  /^(?:ok(?:ay)?|done|ack(?:nowledged)?|got it|on it|will do|working(?: on it)?|no update(?:s)?|still working|in progress|thanks?|noted|👍|\+1)[.!\s]*$/i;

export function isMeaninglessComment(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  if (t.length > 60) return false; // real content is never this shape
  return CHATTER_RE.test(t);
}

/** Operator narration cap: decisions read in seconds, reports live in logs. */
export const OPERATOR_BREVITY_MAX_CHARS = 1000;

export function enforceOperatorBrevity(
  text: string,
  maxChars: number = OPERATOR_BREVITY_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars - 1).trimEnd() +
    "…\n\n_(trimmed by the operator-brevity guardrail — the full narration is in the agent logs)_"
  );
}

/** A fenced block longer than this many lines is an evidence dump, not prose. */
export const EVIDENCE_MAX_FENCE_LINES = 12;

/**
 * Replace long fenced code blocks with their head + a truthful reference. The
 * canonical record keeps enough to identify the evidence; the full output stays
 * in the run transcript (agent logs).
 */
export function separateEvidence(
  text: string,
  maxLines: number = EVIDENCE_MAX_FENCE_LINES,
): string {
  return text.replace(
    /```([^\n]*)\n([\s\S]*?)```/g,
    (whole, lang: string, body: string) => {
      const lines = body.replace(/\n$/, "").split("\n");
      if (lines.length <= maxLines) return whole;
      const head = lines.slice(0, 3).join("\n");
      const omitted = lines.length - 3;
      return `\`\`\`${lang}\n${head}\n\`\`\`\n_(evidence trimmed by the evidence-separation guardrail — ${omitted} more lines in the agent logs)_`;
    },
  );
}

/** Is the given guardrail toggled ON for the project? */
export function guardrailOn(
  ctx: TaskMutationContext,
  projectSlug: string,
  id: string,
): boolean {
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  return (
    project?.parsed.frontmatter.guardrails?.some(
      (g) => g.id === id && g.on === true,
    ) ?? false
  );
}

/** The guardrail's configured numeric value (e.g. compression threshold). */
export function guardrailValue(
  ctx: TaskMutationContext,
  projectSlug: string,
  id: string,
): number | null {
  const project = readProjectFile({
    projectSlug,
    ...(ctx.dataRoot !== undefined ? { dataRoot: ctx.dataRoot } : {}),
  });
  const g = project?.parsed.frontmatter.guardrails?.find(
    (x) => x.id === id && x.on === true,
  );
  return typeof g?.value === "number" && g.value > 0 ? g.value : null;
}
