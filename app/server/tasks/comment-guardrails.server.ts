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
  let head = text.slice(0, maxChars - 1).trimEnd();
  // If the truncation cut through an open ``` fence (odd number of fences),
  // close it so the appended marker + rest of the timeline don't render as code
  // (adversarial-review #12 — markdown-aware truncation).
  const fenceCount = (head.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) head += "\n```";
  return (
    head +
    "\n\n_(trimmed by the operator-brevity guardrail — the full narration is in the agent logs)_"
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
  // Anchor BOTH fences to line starts (adversarial-review #12) so an inline
  // ``` inside the body (e.g. prose about backticks) isn't mistaken for the
  // closing fence, which would truncate at the wrong place and corrupt the doc.
  return text.replace(
    /^```([^\n]*)\n([\s\S]*?)^```/gm,
    (whole, lang: string, body: string) => {
      const lines = body.replace(/\n$/, "").split("\n");
      if (lines.length <= maxLines) return whole;
      const head = lines.slice(0, 3).join("\n");
      const omitted = lines.length - 3;
      return `\`\`\`${lang}\n${head}\n\`\`\`\n_(evidence trimmed by the evidence-separation guardrail — ${omitted} more lines in the agent logs)_`;
    },
  );
}

// ------------------------------------------------ honest guardrail outcomes

/** Why a comment never reached the timeline. */
export type CommentDropReason = "meaningless" | "duplicate";

/** Guardrails that rewrote the text rather than dropping it. */
export type CommentTrim = "evidence-separation" | "operator-brevity";

export interface CommentGuardrailResult {
  /** What to write, or null when the comment was dropped. */
  text: string | null;
  dropped: CommentDropReason | null;
  trimmedBy: CommentTrim[];
}

/**
 * B-FD8: run the write-time guardrails and REPORT what they did.
 *
 * Every caller used to inline this sequence and then report success
 * unconditionally, so a dropped or deduped comment came back to the model as
 * "Comment posted to the timeline." — the model then reasoned as if narration
 * existed that no human would ever see, and the no-duplicate drop left no log
 * line, no audit row and no notification at all. The order is the one the
 * operator path has always used: a meaningless comment is dropped before
 * anything is spent on it, the surviving text is trimmed, and the duplicate
 * check compares what would actually be written.
 *
 * `text` is the POST-trim text to persist; callers keep the caller's original
 * for the @mention fan-out, which must run on the PRE-trim text so a handle
 * sitting past the brevity cap still notifies (B-FD8b).
 */
export function applyCommentGuardrails(input: {
  text: string;
  /** The previous comment by the same author, for the no-duplicate check. */
  previousText?: string | null;
  meaningful?: boolean;
  evidence?: boolean;
  brevity?: boolean;
  noDuplicate?: boolean;
  /** Project-configured brevity cap; falls back to the default. */
  brevityMax?: number | null;
}): CommentGuardrailResult {
  if (input.meaningful && isMeaninglessComment(input.text)) {
    return { text: null, dropped: "meaningless", trimmedBy: [] };
  }

  let text = input.text;
  const trimmedBy: CommentTrim[] = [];
  if (input.evidence) {
    const separated = separateEvidence(text);
    if (separated !== text) trimmedBy.push("evidence-separation");
    text = separated;
  }
  if (input.brevity) {
    const brief = enforceOperatorBrevity(
      text,
      input.brevityMax ?? OPERATOR_BREVITY_MAX_CHARS,
    );
    if (brief !== text) trimmedBy.push("operator-brevity");
    text = brief;
  }

  if (
    input.noDuplicate &&
    input.previousText != null &&
    input.previousText.trim() === text.trim()
  ) {
    return { text: null, dropped: "duplicate", trimmedBy };
  }
  return { text, dropped: null, trimmedBy };
}

/**
 * What the agent/operator TOOL result says. A model that is told its comment
 * was dropped can rephrase; a model told "posted" cannot, and will build on a
 * message nobody received.
 */
export function commentOutcomeMessage(result: CommentGuardrailResult): string {
  if (result.dropped === "meaningless") {
    return "NOT posted — the meaningful-comment guardrail dropped it as status chatter. Nothing was added to the timeline; say something substantive or stay silent.";
  }
  if (result.dropped === "duplicate") {
    return "NOT posted — identical to your previous comment (no-duplicate-summary guardrail). Nothing was added to the timeline.";
  }
  if (result.trimmedBy.length > 0) {
    return `Comment posted to the timeline, TRIMMED by ${result.trimmedBy.join(" + ")} — the full text is only in the agent logs.`;
  }
  return "Comment posted to the timeline.";
}

/**
 * Audit action for a guardrail drop. The agent-reply path already records one
 * (`task.agent.replied` with `droppedByGuardrail`); the operator/mid-run paths
 * left no trace at all, so a maintainer asking "why is there no narration for
 * this turn?" had nothing to read. Same action for every silent drop, with the
 * reason in the details.
 */
export const COMMENT_DROPPED_AUDIT_ACTION = "task.comment.dropped";

/** Is the given guardrail toggled ON for the project? */
export function guardrailOn(
  ctx: TaskMutationContext,
  projectSlug: string,
  id: string,
): boolean {
  const project = readProjectFile({
    projectSlug,
    dataRoot: ctx.dataRoot,
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
    dataRoot: ctx.dataRoot,
  });
  const g = project?.parsed.frontmatter.guardrails?.find(
    (x) => x.id === id && x.on === true,
  );
  return typeof g?.value === "number" && g.value > 0 ? g.value : null;
}
