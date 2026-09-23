import { z } from "zod";

/**
 * U39-9 (pass 39): a run's live step as a person reads it. The run row stores
 * the tool's own id and its input. Live on ax-clone the controller's working
 * row read "composing · mcp__viberr_controller__read_default_branch_file ·
 * internal/client/client.go answered". U39-26: the Live run strip above the
 * conversation printed the same raw text, so it reads it this way too. The
 * stored text stays in each surface's `title`, and the Agent logs console is
 * the technical record.
 *
 * A tool id loses its server prefix and its underscores, and a flat JSON input
 * is read as its values (`{"taskKey":"SHOP-31"}` is `SHOP-31`). Anything else,
 * including a JSON payload the 120-character cap cut short, is left exactly
 * as stored.
 */
export function readableStep(detail: string): string {
  return detail
    // U39-28: the SDK loads a run's deferred tools through `ToolSearch`, and
    // the first step of nearly every controller turn read "ToolSearch · query:
    // select:mcp__viberr_controller__get_task,mcp__viberr_controller__list_…".
    // It is the run loading its tools, so it says that, with the tools' names.
    .replace(/\bToolSearch · query: select:(\S+)/g, (_m, list: string) =>
      `loading tools · ${list.split(",").filter(Boolean).join(", ")}`,
    )
    .replace(/\bToolSearch · query: /g, "looking up tools · ")
    .replace(/\bmcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*__([A-Za-z0-9_]+)/g, (_m, tool: string) =>
      tool.replace(/_/g, " "),
    )
    // A tool id the 120-character cap cut before its name ("mcp__viberr_
    // controller_…", live on the second tool of a loading step) names nothing
    // a person can read, so only the ellipsis stays.
    .replace(/\bmcp__[A-Za-z0-9_-]*…/g, "…")
    .replace(/\{[^{}]*\}/g, (json) => flatValues(json) ?? json);
}

/** A tool input as the step stores it: one object of named arguments. */
const StepInput = z.record(z.string(), z.unknown());
/** The arguments a person can read inline; nested ones are left out. */
const StepScalar = z.union([z.string(), z.number(), z.boolean()]);

function flatValues(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const input = StepInput.safeParse(parsed);
  if (!input.success) return null;
  const values = Object.values(input.data).flatMap((v) => {
    const scalar = StepScalar.safeParse(v);
    if (!scalar.success) return [];
    const text = String(scalar.data);
    return text.trim() === "" ? [] : [text];
  });
  return values.length > 0 ? values.join(", ") : null;
}
