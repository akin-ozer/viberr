import type { EvidenceRowRender } from "~/shared/mapping/task-event.server";

// Lives apart from evidence-list.tsx so that file exports only components
// (Fast Refresh boundary, as app/ui/initials.ts is for avatar.tsx).

/** A label token that names one of the task's files: the token less the
 *  quotes, brackets and trailing punctuation a sentence puts around it. */
export function citedName(token: string, attachments: ReadonlySet<string>): string | null {
  const clean = token.replace(/^[`"'([]+|[`"'),.;:\]]+$/g, "");
  return clean && attachments.has(clean) ? clean : null;
}

/** The task's files the rows' labels name, so the event's own strip does not
 *  show a second copy of one a row already opens. */
export function citedFiles(
  rows: readonly EvidenceRowRender[],
  attachments: ReadonlySet<string>,
): Set<string> {
  const cited = new Set<string>();
  for (const row of rows) {
    for (const token of row.label.split(/\s+/)) {
      const name = citedName(token, attachments);
      if (name) cited.add(name);
    }
  }
  return cited;
}
