/**
 * Ruling 313: a reviewer's verdict on the timeline, as its writer records it
 * (`recordAgentCompletion`) and as the timeline reads it back.
 *
 * The note's words stay the record, because agents and task.md read them:
 * "**Validation:** failing. Reviewer requested changes on `a91f7c200000`."
 * under its title. The timeline draws the verdict as a card whose head says
 * the title and the revision, so it reads those two back here and prints only
 * what the note says beyond them. Ruling 313 reads a gate run's note the same
 * way (`gateNoteView`).
 */

const CHANGES_REQUESTED = "Changes requested";

/**
 * The titles a verdict's note carries. An approval that does not clear the
 * work yet adds why after a comma ("Approval noted, waiting on Security").
 *
 * Ruling 83: a request for changes that sent nothing back adds why too,
 * because what a task took counts the notes titled `changesRequested` alone
 * (`what-it-took.server.ts`). `changesNotCounted` is an objection that bound
 * to no delivery: nothing was delivered yet or the reviewer made the delivery
 * itself (ruling 245), or the delivery moved while it read (ruling 84). `changesOnUnchangedWork` is the same reviewer objecting again
 * to a delivery nobody has reworked since its last objection (ruling 92): it
 * binds, and it fought no round.
 */
export const VERDICT_NOTE_TITLE = {
  changesRequested: CHANGES_REQUESTED,
  changesNotCounted: `${CHANGES_REQUESTED}, not counted`,
  changesOnUnchangedWork: `${CHANGES_REQUESTED}, on unchanged work`,
  passed: "Review passed",
  noted: "Approval noted",
} as const;

/** The note's text: the validation it left, then the summary. */
export function verdictNoteText(validation: string, summary: string): string {
  return `**Validation:** ${validation}. ${summary}`;
}

/** A verdict's note, read back. */
export interface VerdictNoteView {
  /** The reviewer's own verdict, whether or not it cleared the work. */
  result: "approve" | "request_changes";
  /** The revision it judged, short, when the note names one. */
  sha: string | null;
  /** What the note says beyond its title and revision, or null. */
  detail: string | null;
}

const LEAD_RE = /^\*\*Validation:\*\* [a-z_]+\.\s*/;
/** The summary's plain opening, "<name> requested changes on `<sha>`." or
 *  "<name> approved the work on `<sha>`.", which the card's head says. */
const OPENING_RE = /^[^`]+? (?:requested changes|approved(?: the work)?)(?: on `([0-9a-f]{7,40})`)?\.(?:\s+|$)/;
const REVISION_RE = / on `([0-9a-f]{7,40})`/;

/**
 * The verdict a `quality` note records, or null for any other note (a
 * knowledge-base conflict, an older quality flag), which renders as the note
 * it is.
 */
export function verdictNoteView(note: {
  type: string;
  title: string | null;
  text: string;
}): VerdictNoteView | null {
  if (note.type !== "quality" || !note.title) return null;
  // Every request for changes reads as one here, counted or not: the card
  // draws the reviewer's own verdict (ruling 313).
  const result =
    note.title.startsWith(VERDICT_NOTE_TITLE.changesRequested)
      ? "request_changes"
      : note.title === VERDICT_NOTE_TITLE.passed || note.title.startsWith(VERDICT_NOTE_TITLE.noted)
        ? "approve"
        : null;
  if (!result) return null;
  const summary = note.text.replace(LEAD_RE, "").trim();
  const opening = OPENING_RE.exec(summary);
  const sha = opening?.[1] ?? REVISION_RE.exec(summary)?.[1] ?? null;
  const detail = (opening ? summary.slice(opening[0].length) : summary).trim();
  return { result, sha: sha ? sha.slice(0, 7) : null, detail: detail || null };
}
