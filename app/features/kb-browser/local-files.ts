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

function hasDotSegment(relPath: string): boolean {
  return relPath.split("/").some((p) => p.startsWith("."));
}

/** Plain file picker / `webkitdirectory` folder picker. */
export function entriesFromFileList(files: FileList | File[]): UploadEntry[] {
  const out: UploadEntry[] = [];
  for (const file of Array.from(files)) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    if (!rel || hasDotSegment(rel)) continue;
    out.push({ file, relPath: rel });
  }
  return out;
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
): Promise<void> {
  const name = entry.name ?? "";
  if (!name || name.startsWith(".")) return Promise.resolve();
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
          (p, child) => p.then(() => walkEntry(child, `${prefix}${name}/`, out)),
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
): Promise<UploadEntry[]> {
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
      const collected = await Promise.all(
        entries.map(async (entry) => {
          const acc: UploadEntry[] = [];
          await walkEntry(entry, "", acc);
          return acc;
        }),
      );
      return collected.flat();
    } catch {
      // fall through to the flat list
    }
  }
  return entriesFromFileList(dt.files ?? []);
}
