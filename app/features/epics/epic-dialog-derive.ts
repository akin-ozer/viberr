import type { EpicColor, EpicStatus } from "~/schemas/epic-file.schema";
import type { EpicSummary } from "~/server/projections/epic-query.server";
import type { EpicActionResult } from "./epic-parts";

/**
 * What the epic dialog reads off its draft (ruling 696(e), the large-component
 * split of `EpicDialog` in `epic-parts.tsx`): the fields a create or an edit
 * posts, whether its dates run backwards, the server's refusal, and the
 * sentence its foot says. Pure functions, no React; the dialog calls each at
 * most once per render.
 */

/** The epic fields a create or an edit posts. */
export interface EpicDraft {
  title: string;
  description: string;
  status: EpicStatus;
  color: EpicColor | "";
  leadUserId: string;
  startDate: string;
  targetDate: string;
}

/** Sets one field of the draft. */
export type SetEpicDraft = <K extends keyof EpicDraft>(key: K, value: EpicDraft[K]) => void;

export function draftOf(epic: EpicSummary | null): EpicDraft {
  return {
    title: epic?.title ?? "",
    description: epic?.description ?? "",
    status: epic?.status ?? "planned",
    // A new epic takes the next colour in the sequence unless one is picked.
    color: epic?.color ?? "",
    leadUserId: epic?.leadUserId ?? "",
    startDate: epic?.startDate ?? "",
    targetDate: epic?.targetDate ?? "",
  };
}

/** A target date before the start date; with either unset, never. */
export function datesReversed(draft: EpicDraft): boolean {
  return draft.startDate !== "" && draft.targetDate !== "" && draft.targetDate < draft.startDate;
}

/** The refusal an answer carries, if it is one. */
export function refusalOf(data: EpicActionResult | undefined): string | null {
  return data && !data.ok ? (data.error ?? null) : null;
}

/** The foot's sentence: what keeps the submit back, else the server's
 *  refusal, else what a save or a create does. */
export function epicDialogHint({
  titleError,
  reversed,
  serverError,
  editing,
}: {
  titleError: boolean;
  reversed: boolean;
  serverError: string | null;
  editing: boolean;
}): string {
  return titleError
    ? "An epic needs a name."
    : reversed
      ? "The target date is before the start date."
      : serverError
        ? serverError
        : editing
          ? "Changes are recorded on the epic's history."
          : "The epic id is assigned automatically.";
}
