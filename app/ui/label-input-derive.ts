import { MAX_LABEL_LENGTH, MAX_TASK_LABELS } from "~/schemas/task-file.schema";

/**
 * What the label field reads off its value, its suggestions and the typed text
 * (ruling 695(e), the split of `label-input.tsx`): the normal form of a label,
 * the rows the open list offers, and how a batch of typed labels folds into the
 * set. Pure functions, no React; `LabelInput` calls each at most once per
 * render or per edit.
 */

export type LabelRow =
  | { kind: "selected"; value: string }
  | { kind: "suggest"; value: string }
  | { kind: "create"; value: string };

/** Trimmed, whitespace-collapsed and capped to the server's length, so the UI
 *  never builds a label `normalizeTaskLabels` would silently change. */
export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LENGTH);
}

/** The set already holds `label`, compared case-insensitively. */
export function hasLabel(value: readonly string[], label: string): boolean {
  return value.some((l) => l.toLowerCase() === label.toLowerCase());
}

/**
 * Rows offered right now: the chosen labels pinned to the top (always shown, so
 * any of them can be unchecked), then the project's other labels filtered by
 * the query, then a "Create" row for genuinely-new typed text. Nothing can be
 * ADDED once the set is full (`room` false), but the chosen rows stay so labels
 * can be removed.
 */
export function labelRows(
  value: readonly string[],
  suggestions: readonly string[],
  query: string,
  room: boolean,
): LabelRow[] {
  const q = query.toLowerCase();
  const suggestRows: LabelRow[] = room
    ? suggestions
        .filter((s) => !hasLabel(value, s) && (q === "" || s.toLowerCase().includes(q)))
        .map((s): LabelRow => ({ kind: "suggest", value: s }))
    : [];
  const canCreate =
    room &&
    query !== "" &&
    !hasLabel(value, query) &&
    !suggestions.some((s) => s.toLowerCase() === q);
  const rows: LabelRow[] = value.map((v): LabelRow => ({ kind: "selected", value: v }));
  rows.push(...suggestRows);
  if (canCreate) rows.push({ kind: "create", value: query });
  return rows;
}

/** One or more raw strings folded into the set, as ONE next value: how many
 *  were added, whether one was already there, and the raw strings the cap
 *  refused (from the first refused one on). */
export interface LabelFold {
  next: string[];
  added: number;
  dup: boolean;
  refused: string[];
}

export function foldLabels(value: string[], raws: readonly string[]): LabelFold {
  let next = value;
  let added = 0;
  let dup = false;
  let refused: string[] = [];
  for (const [i, raw] of raws.entries()) {
    const label = normalizeLabel(raw);
    if (!label) continue;
    if (next.length >= MAX_TASK_LABELS) {
      refused = raws.slice(i);
      break;
    }
    if (hasLabel(next, label)) {
      dup = true;
      continue;
    }
    next = [...next, label];
    added += 1;
  }
  return { next, added, dup, refused };
}
