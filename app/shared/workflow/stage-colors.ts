import { z } from "zod";

/**
 * Ruling 279: a stage's colour is one of twenty named presets — nothing else.
 *
 * The colour used to be a free string, hex or `var(--*)` (ruling 47), that
 * fifteen surfaces handed to CSS as it was. The shopify board was created with
 * `slate` and `amber`; neither is a CSS colour, so its Triage and Review drew
 * NOTHING on the home meter and on every dot while `project.md` said
 * otherwise. Ruling 279 barred the door and left the stored values, so the gap
 * stayed. Now the NAME is the value: `project.md` stores `amber`, the markup
 * carries `data-stage-color="amber"`, and `app.css` is the one place a name
 * becomes paint — per theme, from the `--stage-amber` tokens. A name is what
 * an agent or a person can read, pick and compare; a hex is not.
 */
export const STAGE_COLORS = [
  "slate",
  "gray",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;

export type StageColor = (typeof STAGE_COLORS)[number];

export const stageColorSchema = z.enum(STAGE_COLORS);

const STAGE_COLOR_SET: ReadonlySet<string> = new Set(STAGE_COLORS);

export function isStageColor(value: string): value is StageColor {
  return STAGE_COLOR_SET.has(value);
}

/** For refusals and tool descriptions: the presets, in palette order. */
export const STAGE_COLOR_LIST = STAGE_COLORS.join(", ");

/**
 * The walk a board takes when nobody picked: hues far apart, so neighbouring
 * lanes never rhyme, opening on the neutral an intake lane wants and keeping
 * green for the terminal lane (`TERMINAL_STAGE_COLOR`).
 */
const DEFAULT_SEQUENCE: readonly StageColor[] = [
  "slate",
  "violet",
  "blue",
  "amber",
  "teal",
  "rose",
  "indigo",
  "orange",
  "emerald",
  "pink",
  "sky",
  "lime",
  "purple",
  "cyan",
  "red",
  "fuchsia",
  "yellow",
  "stone",
  "gray",
  "green",
];

/** The terminal lane's colour on a board built without colours. */
export const TERMINAL_STAGE_COLOR: StageColor = "green";

/** The n-th default: the sequence, wrapping. */
export function stageColorAt(index: number): StageColor {
  return DEFAULT_SEQUENCE[index % DEFAULT_SEQUENCE.length]!;
}

/** The first default no sibling already wears — a stage added to a board
 *  takes a colour of its own until all twenty are taken, then wraps. */
export function nextStageColor(taken: readonly string[]): StageColor {
  const used = new Set(taken);
  return DEFAULT_SEQUENCE.find((color) => !used.has(color)) ?? stageColorAt(taken.length);
}
