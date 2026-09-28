import {
  ATTACHMENT_BATCH_MAX,
  ATTACHMENT_BATCH_MAX_BYTES,
  type AttachmentBatchWording,
  MAX_UPLOAD_BYTES,
} from "~/shared/attachment-kinds";
import { prettySize } from "~/shared/text/byte-size";

/**
 * Ruling 573: what a composer decides about files before the server sees
 * anything: which picks it keeps, and whether a paste is text or a file. The
 * rules alone, apart from the tray that draws them (`attach-files.tsx`), so a
 * form that draws its own (the New task dialog, ruling 533) ships none of it.
 * A refusal here is the one the server would give, said before the request.
 */

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** A name not yet taken in `taken` (case-folded, as a disk may fold it):
 *  `screenshot.png`, then `screenshot-2.png`, `screenshot-3.png`. */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** The files a batch keeps, and the first one it refused, said as a reason. */
export interface PickedFiles {
  files: File[];
  problem: string | null;
}

/**
 * Add `incoming` to `current`, refusing what the server would refuse. Returns
 * the files that fit and the first refusal, if any. A file picked again under
 * the same name replaces the earlier pick rather than doubling it.
 */
export function addPickedFiles(
  current: readonly File[],
  incoming: readonly File[],
  wording: AttachmentBatchWording,
): PickedFiles {
  let files = [...current];
  let problem: string | null = null;
  for (const file of incoming) {
    if (file.size > MAX_UPLOAD_BYTES) {
      problem ??= `“${file.name}” is ${prettySize(file.size)}; a file may be up to ${prettySize(MAX_UPLOAD_BYTES)}.`;
      continue;
    }
    const same = files.findIndex((f) => f.name.toLowerCase() === file.name.toLowerCase());
    const next = same >= 0 ? files.map((f, i) => (i === same ? file : f)) : [...files, file];
    if (next.length > ATTACHMENT_BATCH_MAX) {
      problem ??= `${wording.holds} up to ${ATTACHMENT_BATCH_MAX} files. ${wording.rest}`;
      continue;
    }
    const total = next.reduce((sum, f) => sum + f.size, 0);
    if (total > ATTACHMENT_BATCH_MAX_BYTES) {
      problem ??= `${wording.holds} up to ${prettySize(ATTACHMENT_BATCH_MAX_BYTES)} of files. ${wording.rest}`;
      continue;
    }
    files = next;
  }
  return { files, problem };
}

/**
 * The files a paste carries, or null when the paste is text and belongs to
 * the field it landed in. A spreadsheet's copied cells carry their text AND a
 * picture of the cells: pasted into a text field that is text. A screenshot
 * carries only the picture, which no text field can take, so it is filed.
 * Browsers name a pasted bitmap `image.png`; it is filed as `screenshot.png`.
 */
export function filesFromPaste(
  clipboard: { files: ArrayLike<File>; types: readonly string[] },
  intoTextField: boolean,
  current: readonly File[],
): File[] | null {
  const pasted = Array.from(clipboard.files);
  if (pasted.length === 0) return null;
  if (intoTextField && clipboard.types.includes("text/plain")) return null;
  const taken = new Set(current.map((f) => f.name.toLowerCase()));
  return pasted.map((file) => {
    const generic = /^image\.[a-z0-9]+$/i.test(file.name);
    const name = freeName(generic ? `screenshot${extensionOf(file.name)}` : file.name, taken);
    taken.add(name.toLowerCase());
    return name === file.name ? file : new File([file], name, { type: file.type });
  });
}

/** The kinds a composer and a transcript show as their own picture. */
export const PICTURE_RE = /\.(png|jpe?g|webp|gif)$/i;
