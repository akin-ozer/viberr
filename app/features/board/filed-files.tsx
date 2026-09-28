import { prettySize } from "~/features/kb-browser/tree";
import {
  FILED_ATTACHMENTS_MAX,
  FILED_ATTACHMENTS_MAX_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOADABLE_EXTENSIONS,
} from "~/shared/attachment-kinds";
import { Icon } from "~/ui/icon";

/**
 * Ruling 533: a task is filed WITH its input. On a board that delivers
 * results, the thing a person hands over (an inventory, a spreadsheet, a
 * screenshot of a portal) is the task, and it used to reach the task only
 * after the operator had already triaged a goal that could not show it.
 *
 * The picker offers exactly what the server stores (`accept` is built from
 * its own list), so a refusal here is the same one the server would give,
 * said before the request instead of after.
 */

const ACCEPT = [...UPLOADABLE_EXTENSIONS].sort().join(",");

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

/** The files a filing keeps, and the first one it refused, said as a reason. */
export interface FiledFilesUpdate {
  files: File[];
  problem: string | null;
}

/**
 * Add `incoming` to `current`, refusing what the server would refuse. Returns
 * the files that fit and the first refusal, if any. A file picked again under
 * the same name replaces the earlier pick rather than doubling it.
 */
export function addFiledFiles(current: readonly File[], incoming: readonly File[]): FiledFilesUpdate {
  let files = [...current];
  let problem: string | null = null;
  for (const file of incoming) {
    const ext = extensionOf(file.name);
    if (!UPLOADABLE_EXTENSIONS.has(ext)) {
      problem ??= `Viberr can't store “${file.name}”. It takes ${[...UPLOADABLE_EXTENSIONS].sort().join(", ")}.`;
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      problem ??= `“${file.name}” is ${prettySize(file.size)}; a file may be up to ${prettySize(MAX_UPLOAD_BYTES)}.`;
      continue;
    }
    const same = files.findIndex((f) => f.name.toLowerCase() === file.name.toLowerCase());
    const next = same >= 0 ? files.map((f, i) => (i === same ? file : f)) : [...files, file];
    if (next.length > FILED_ATTACHMENTS_MAX) {
      problem ??= `A task can be filed with up to ${FILED_ATTACHMENTS_MAX} files. Attach the rest from the task page.`;
      continue;
    }
    const total = next.reduce((sum, f) => sum + f.size, 0);
    if (total > FILED_ATTACHMENTS_MAX_BYTES) {
      problem ??= `A task can be filed with up to ${prettySize(FILED_ATTACHMENTS_MAX_BYTES)} of files. Attach the rest from the task page.`;
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

export function FiledFiles({
  files,
  problem,
  onAdd,
  onRemove,
}: {
  files: readonly File[];
  problem: string | null;
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div
      className="field"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        onAdd(Array.from(e.dataTransfer.files));
      }}
    >
      <span className="flabel">
        Files
        <span className="fhint">optional · the input the agents work from</span>
      </span>
      <div className="attach-add">
        <label className="btn ghost sm">
          <Icon name="file" />
          Attach files
          <input
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => {
              const picked = Array.from(e.currentTarget.files ?? []);
              // Let the same file be picked again after it was removed.
              e.currentTarget.value = "";
              if (picked.length > 0) onAdd(picked);
            }}
          />
        </label>
        <span className="fine sm">or drop them here, or paste a screenshot</span>
      </div>
      {files.length > 0 && (
        <ul className="attach-list" aria-label="Files the task is filed with">
          {files.map((file) => (
            <li key={file.name} className="filed-file">
              <Icon name="file" />
              <span className="attach-name">{file.name}</span>
              <span className="attach-size">{prettySize(file.size)}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemove(file.name)}
              >
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && (
        <p className="form-err" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
