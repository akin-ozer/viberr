/**
 * What a task attachment IS, as data: which extensions render inline, which read
 * back as text, and which a person may upload. Client-safe and free of any
 * server import, because the attachments panel builds its file picker's
 * `accept` from the upload list — a value import of a `.server` module is a
 * build failure ("Server-only module referenced by client"), and a hand-copied
 * second list is how the picker starts offering a file the writer refuses.
 */

/** Types the serving route may render INLINE on the app origin. Deliberately
 *  without `.html`, `.svg` and `.js`: a stored page served here is stored XSS. */
export const INLINE_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
  [".txt", "text/plain; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/plain; charset=utf-8"],
  [".json", "application/json"],
  // Ruling 105: yaml/csv join the inert-text set so the in-app read-only
  // viewer can fetch them. Plain text on purpose — never a renderable type.
  [".yml", "text/plain; charset=utf-8"],
  [".yaml", "text/plain; charset=utf-8"],
  [".csv", "text/plain; charset=utf-8"],
]);

/** Extensions `readTaskAttachmentText` returns as text. The inline set above
 *  is about what a BROWSER may render on the app origin, a different
 *  question. */
export const READABLE_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".csv",
  ".diff",
  ".patch",
]);

/**
 * What a PERSON may attach (F39-6, ruling 379). Exactly the extensions this
 * product can either render inline or read back as text. A file viberr can
 * neither show nor read is not evidence, it is a blob, and storing it would
 * make the panel a file manager.
 */
export const UPLOADABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...INLINE_TYPES.keys(),
  ...READABLE_TEXT_EXTENSIONS,
  // Ruling 533: a spreadsheet reads back as its sheets in CSV, and an
  // inventory arrives as one far more often than as anything else.
  ".xlsx",
]);

/** One attachment's byte ceiling: evidence, not a payload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Ruling 533: how many files one task may be filed with, and their total
 *  size. A task's input, not a folder of them; the rest attach from the task
 *  page. Ruling 565: one comment or one controller message carries the same
 *  batch. */
export const ATTACHMENT_BATCH_MAX = 10;
export const ATTACHMENT_BATCH_MAX_BYTES = 25 * 1024 * 1024;

/** Ruling 565: how a batch names its own limits in a refusal, on the client
 *  and the server alike: "A task can be filed with" or "A message can
 *  carry", then where the rest go. */
export interface AttachmentBatchWording {
  holds: string;
  rest: string;
}

/** Ruling 533: a task filed with its input. */
export const FILING_BATCH: AttachmentBatchWording = {
  holds: "A task can be filed with",
  rest: "Attach the rest from the task page.",
};

/** Ruling 565: a comment or a controller message carrying files. */
export const MESSAGE_BATCH: AttachmentBatchWording = {
  holds: "A message can carry",
  rest: "Send the rest in another message.",
};
