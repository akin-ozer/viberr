import type { CompletionView } from "~/server/tasks/completion-packet.server";
import { COMPLETION_NOTES } from "~/shared/completion-packet";
import type { CompletionDiff, CompletionResult } from "./completion-packet";

/**
 * What the completion packet reads off its props before it draws (ruling
 * 695(e), the split of `completion-packet.tsx` along the task-page recipe):
 * the revision it speaks of, the attachments it may link, the verdicts and
 * notes it lists, and which of its sections stand. A pure function of the
 * props, no React; `CompletionPacket` calls it once per render.
 */

/** One of Operator's notes that has something to say (ruling 668). */
interface CompletionNote {
  key: string;
  label: string;
  text: string;
}

export interface CompletionCard {
  /** The delivered revision, or the files when the delivery is files. */
  subject: string;
  shots: NonNullable<CompletionView["packet"]>["screenshots"];
  files: NonNullable<CompletionView["packet"]>["files"];
  small: boolean;
  verdicts: CompletionView["verdicts"];
  notes: CompletionNote[];
  hiddenFiles: number;
  hiddenScreenshots: number;
  /** Whether the Reviewers heading stands. */
  reviewersHeaded: boolean;
  /** Whether the Changes section stands. */
  changesShown: boolean;
}

export function completionCard(
  view: CompletionView,
  attachmentsBase: string | null,
  verdictSatisfiedBy: string | null,
  diff: CompletionDiff | null,
  result: CompletionResult | null,
): CompletionCard {
  const { packet, change, paths } = view;
  // On an accepted task nobody is still owed a verdict.
  const verdicts = result ? view.verdicts.filter((v) => v.result !== "pending") : view.verdicts;
  return {
    subject: view.subjectSha ?? "the delivered files",
    shots: attachmentsBase && packet ? packet.screenshots : [],
    files: attachmentsBase && packet ? packet.files : [],
    small: change?.small ?? false,
    verdicts,
    notes: packet
      ? COMPLETION_NOTES.flatMap(({ key, label }) => {
          const text = packet[key];
          return text ? [{ key, label, text }] : [];
        })
      : [],
    hiddenFiles: packet ? packet.hiddenFiles : 0,
    hiddenScreenshots: packet ? packet.hiddenScreenshots : 0,
    reviewersHeaded: !(result && verdicts.length === 0 && !verdictSatisfiedBy),
    changesShown: Boolean(change || diff || (result && (result.pr || paths))),
  };
}
