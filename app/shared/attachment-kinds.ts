/**
 * What a task attachment IS, as data: which extensions render inline, which read
 * back as text, and how much a person may upload. Client-safe and free of any
 * server import, because the composers refuse an oversized pick before the
 * request with the server's own numbers — a value import of a `.server`
 * module is a build failure ("Server-only module referenced by client").
 *
 * Ruling 574: a person may attach a file of ANY kind. What keeps a stored
 * page from running on the app origin is `INLINE_TYPES` below, which the
 * serving route alone reads (everything else is an `application/octet-stream`
 * download under `nosniff` and a sandbox CSP), never a list of what may be
 * stored; and the agents a file is for read it from the task's attachments
 * folder whatever its name.
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

/** Extensions a reader always takes as text: `readTaskAttachment` never
 *  treats one as binary (ruling 574 sniffs only the others), and
 *  `savedFilesText` reads only these into a run's citation corpus. The inline
 *  set above is about what a BROWSER may render on the app origin, a
 *  different question. */
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

/** Kinds no reader opens as text: bytes with no text to show, decided by the
 *  name (ruling 363, the task page's viewer; ruling 574, the coordinators'
 *  readers), before the bytes' own NUL test gets its say. Bare extensions,
 *  without the dot. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // documents the route serves inline (PDF) or as downloads
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  // archives
  "zip", "gz", "tgz", "tar", "bz2", "xz", "zst", "7z", "rar", "jar", "war",
  // executables, libraries, compiled objects, images of systems
  "exe", "dll", "so", "dylib", "bin", "dmg", "iso", "pkg", "deb", "rpm", "wasm", "class", "pyc", "o", "a",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // media
  "mp3", "mp4", "m4a", "mov", "avi", "mkv", "webm", "ogg", "wav", "flac",
  // raster images the lightbox does not show, and image editors' files
  "ico", "bmp", "tif", "tiff", "psd", "heic", "avif",
  // databases
  "sqlite", "sqlite3", "db",
]);

/** One attachment's byte ceiling: evidence, not a payload. Ruling 574: with
 *  any kind storable, the size is what bounds an upload. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Ruling 533: how many files one task may be filed with, and their total
 *  size. A task's input, not a folder of them; the rest attach from the task
 *  page. Ruling 573: one comment or one controller message carries the same
 *  batch. */
export const ATTACHMENT_BATCH_MAX = 10;
export const ATTACHMENT_BATCH_MAX_BYTES = 25 * 1024 * 1024;

/** Ruling 573: how a batch names its own limits in a refusal, on the client
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

/** Ruling 573: a comment or a controller message carrying files. */
export const MESSAGE_BATCH: AttachmentBatchWording = {
  holds: "A message can carry",
  rest: "Send the rest in another message.",
};
