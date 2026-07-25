/**
 * Client-side file collection for StoreBrowser uploads: turns picker
 * FileLists and drag&drop DataTransfers into `{ file, relPath }` entries
 * with structure preserved. Dot-prefixed segments (.DS_Store, .git/…) are
 * skipped here AND re-checked server-side (never trust the client).
 */

export interface UploadEntry {
  file: File;
  /** Relative path inside the upload target ("a/b/file.md" or "file.md"). */
  relPath: string;
}

/**
 * P13-UI-08 residual: the collectors used to return the surviving entries only,
 * so a selection of nothing BUT dot-files came back empty and the caller's
 * `if (entries.length === 0) return;` made the whole upload a silent no-op — no
 * request, no toast, no error, indistinguishable from a successful drop. The
 * count of what the filter removed travels with the selection so the browser
 * can say what happened.
 */
export interface UploadSelection {
  entries: UploadEntry[];
  /** Files skipped because a path segment starts with "." (never uploaded). */
  skipped: number;
}

function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((p) => p.startsWith("."));
}

/** Plain file picker / `webkitdirectory` folder picker. */
export function entriesFromFileList(files: FileList | File[]): UploadSelection {
  const out: UploadEntry[] = [];
  let skipped = 0;
  for (const file of Array.from(files)) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (!rel || hasDotSegment(rel)) {
      skipped += 1;
      continue;
    }
    out.push({ file, relPath: rel });
  }
  return { entries: out, skipped };
}

interface FileSystemEntryLike {
  name?: string;
  isFile?: boolean;
  isDirectory?: boolean;
  file?: (ok: (f: File) => void, err: () => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (batch: FileSystemEntryLike[]) => void,
      err: () => void,
    ) => void;
  };
}

function walkEntry(
  entry: FileSystemEntryLike,
  prefix: string,
  out: UploadEntry[],
  skipped: { n: number },
): Promise<void> {
  const name = entry.name ?? "";
  if (!name) return Promise.resolve();
  if (name.startsWith(".")) {
    // A skipped DIRECTORY counts once: the browser never reads inside it, so
    // the honest number is "one hidden thing", not a file count we don't have.
    skipped.n += 1;
    return Promise.resolve();
  }
  if (entry.isFile && entry.file) {
    return new Promise((res) => {
      entry.file!(
        (f) => {
          out.push({ file: f, relPath: prefix + name });
          res();
        },
        () => res(),
      );
    });
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const readAll = (acc: FileSystemEntryLike[]): Promise<FileSystemEntryLike[]> =>
      new Promise((res) =>
        reader.readEntries(
          (batch) =>
            batch.length ? res(readAll([...acc, ...batch])) : res(acc),
          () => res(acc),
        ),
      );
    return readAll([]).then((children) =>
      children
        .reduce(
          (p, child) =>
            p.then(() => walkEntry(child, `${prefix}${name}/`, out, skipped)),
          Promise.resolve(),
        )
        .then(() => undefined),
    );
  }
  return Promise.resolve();
}

/** Drag&drop: walks whole dropped folders via webkitGetAsEntry; falls back
 * to the flat file list (mock semantics). */
export async function entriesFromDataTransfer(
  dt: DataTransfer,
): Promise<UploadSelection> {
  const items = Array.from(dt.items ?? []);
  const entries: FileSystemEntryLike[] = [];
  for (const item of items) {
    const getEntry = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => FileSystemEntryLike | null;
      }
    ).webkitGetAsEntry;
    if (typeof getEntry !== "function") continue;
    const entry = getEntry.call(item) as FileSystemEntryLike | null;
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) {
    try {
      const skipped = { n: 0 };
      const collected = await Promise.all(
        entries.map(async (entry) => {
          const acc: UploadEntry[] = [];
          await walkEntry(entry, "", acc, skipped);
          return acc;
        }),
      );
      return { entries: collected.flat(), skipped: skipped.n };
    } catch {
      // fall through to the flat list
    }
  }
  return entriesFromFileList(dt.files ?? []);
}
