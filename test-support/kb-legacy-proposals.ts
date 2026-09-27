/**
 * Knowledge-base documents as rulings 378 and 483 left them: settled text, then
 * a "## Proposed corrections (not binding)" section of agents' proposals
 * (docs/architecture/file-formats.md §7). Ruling 498 ended the filing; stores
 * still hold such sections until someone closes them, so the reader, the
 * Controller page and the controller's tools are tested against documents
 * built here, byte for byte the way the filing wrote them.
 */

export interface LegacyProposalInput {
  taskKey: string;
  /** `YYYY-MM-DD`; 2026-09-25 when omitted. */
  filedOn?: string;
  /** The filer; null writes ruling 378's stamp, which named none. */
  filedBy?: string | null;
  /** The settled line it corrects; omitted when it added something. */
  line?: string | null;
  correction: string;
  evidence: string;
}

/** The sentence ruling 483 wrote under a new heading. */
const LEGACY_INTRO =
  "Raised by agents from evidence on a task. **Nothing here is binding.** A person, or the " +
  "controller when a person asks it, promotes an entry into the settled text above or " +
  "dismisses it.";

/** A value on the entry's own indented lines, blank lines dropped. */
function indented(value: string): string {
  return value
    .split("\n")
    .filter((l) => l.trim() !== "")
    .join("\n  ");
}

/** One entry, as the filing wrote it. */
function legacyProposalEntry(input: LegacyProposalInput): string {
  const filedBy = input.filedBy === undefined ? "Platform Engineer" : input.filedBy;
  const stamp = [input.taskKey, input.filedOn ?? "2026-09-25", ...(filedBy ? [filedBy] : [])].join(
    ", ",
  );
  return (
    `- **[${stamp}]** ${indented(input.correction)}` +
    (input.line ? `\n  Line: ${indented(input.line)}` : "") +
    `\n  Evidence: ${indented(input.evidence)}`
  );
}

/** `settled` followed by a proposals section holding `entries`, in order. */
export function withLegacyProposals(
  settled: string,
  entries: readonly LegacyProposalInput[],
): string {
  return (
    `${settled.trimEnd()}\n\n## Proposed corrections (not binding)\n\n${LEGACY_INTRO}\n\n` +
    `${entries.map(legacyProposalEntry).join("\n\n")}\n`
  );
}
