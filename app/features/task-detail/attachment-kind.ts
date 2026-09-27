/**
 * Ruling 363: what the attachment card can show for a file, decided from the
 * name — and, for the text reader, confirmed by the bytes.
 *
 * The card used to decide "text" by a six-extension whitelist mirrored from
 * the serving route's inline set, so an agent's `.mjs`, `.sh`, `.svg` or
 * `Dockerfile` evidence — bytes the route serves fine, as a download — opened
 * on a "no in-app preview" card with nothing to do but save it. The route's
 * whitelist answers a different question (what the browser may RENDER on this
 * origin); whether the popup can READ a file is answered here:
 *  - images and the known binary kinds (archives, media, fonts, office and
 *    PDF documents, executables, databases) are decided by name and never
 *    enter the reader;
 *  - everything else is read as text, unless its head carries a NUL byte —
 *    git's own `-text` test — in which case it was binary after all and gets
 *    the same no-preview card.
 * The grammar is the reader's business (`~/ui/code-language`); an unknown
 * extension still reads, unhighlighted.
 */

import { languageForName, PLAIN_LANGUAGE } from "~/ui/code-language";

/** Image-typed attachment names — thumbnail previews + the image lightbox. */
export const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

/** Kinds the reader never opens: bytes with no text to show. */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
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

export type AttachmentKind = "image" | "binary" | "text";

/** The lowercased extension after the last dot, "" when there is none. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The family a timeline file tile is tinted by (a pill tone in app.css). */
export type FileFamily = "docs" | "data" | "log" | "code" | "plain";

const FAMILY_OF_LANGUAGE: ReadonlyMap<string, FileFamily> = new Map([
  ["markdown", "docs"], ["mdx", "docs"], ["latex", "docs"],
  ["json", "data"], ["jsonc", "data"], ["json5", "data"], ["jsonl", "data"], ["yaml", "data"],
  ["toml", "data"], ["ini", "data"], ["properties", "data"], ["dotenv", "data"], ["xml", "data"],
  ["csv", "data"], ["tsv", "data"],
  ["log", "log"],
]);

/** Read off the reader's own name → grammar table, so a name it learns is
 *  tinted with no second list: a name it does not know is plain, a grammar
 *  this map does not name is code. */
export function fileFamily(name: string): FileFamily {
  const language = languageForName(name);
  if (language === PLAIN_LANGUAGE) return "plain";
  return FAMILY_OF_LANGUAGE.get(language) ?? "code";
}

/** By name alone: `text` means "try the reader" (the bytes get the last word). */
export function attachmentKind(name: string): AttachmentKind {
  if (IMAGE_RE.test(name)) return "image";
  return BINARY_EXTENSIONS.has(fileExtension(name)) ? "binary" : "text";
}

/** How much of the head the NUL test reads — git's own window. */
const BINARY_SNIFF_CHARS = 8_000;

/** A NUL in the decoded head means the bytes were never text (a UTF-8 text
 *  file cannot contain U+0000 by accident; a binary almost always does). */
export function looksBinary(decodedHead: string): boolean {
  return decodedHead.slice(0, BINARY_SNIFF_CHARS).includes("\0");
}
