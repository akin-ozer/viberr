import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { AppError } from "~/server/errors/app-error.server";

/**
 * Ruling 653: the ZIP container a board file travels in, read and written
 * with `node:zlib` alone (the S3 export's SigV4 PUT is the same choice: a
 * small, owned protocol rather than a dependency).
 *
 * The WRITER emits plain PKZIP 2.0: one local header per file, DEFLATE when it
 * shrinks the bytes and STORE when it does not, UTF-8 names (flag bit 11), a
 * central directory and its end record. The same input and the same clock
 * always give the same bytes.
 *
 * The READER takes what a person's own zip tool makes of an extracted board
 * folder (Finder's Compress, `zip -r`, Windows' Send to): it trusts the
 * central directory, never a local header's sizes (Finder writes data
 * descriptors), and it refuses rather than guesses. Every refusal is a
 * sentence the import shows as it is:
 *
 * - a path that leaves the archive (`..`, absolute, a drive letter) or names
 *   the same file twice;
 * - a symbolic link, an encrypted entry, a method other than STORE and
 *   DEFLATE, a ZIP64 or multi-disk archive;
 * - more entries or more bytes than the caller's limits, judged on the sizes
 *   the directory declares BEFORE anything is inflated, and again while
 *   inflating (`maxOutputLength`), so a lying size cannot inflate past them;
 * - an entry whose checksum does not match its bytes.
 */

/** One file to write. Directories are implied by the paths. */
export interface ZipFileInput {
  /** Forward-slash path inside the archive, no leading slash. */
  path: string;
  data: Uint8Array;
}

/** One file read back, its path normalized to forward slashes. */
export interface ZipFile {
  path: string;
  data: Buffer;
}

/** How much one archive may hold, in entries and in inflated bytes. */
export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_OF_CENTRAL_BYTES = 22;
/** The end record sits in the last 22 bytes plus a comment of at most 64 KB. */
const END_SEARCH_BYTES = END_OF_CENTRAL_BYTES + 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
/** PKZIP 2.0: the version that reads DEFLATE. */
const VERSION_20 = 20;
/** "Made by" Unix (3) with spec 2.0, so the external attributes carry a mode. */
const MADE_BY_UNIX = (3 << 8) | VERSION_20;
const UNIX_HOST = 3;
const MODE_TYPE_MASK = 0o170000;
const MODE_SYMLINK = 0o120000;
/** A regular file, rw-r--r--, in the high half of the external attributes. */
const REGULAR_FILE_ATTRS = (0o100644 << 16) >>> 0;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

function refuse(reason: string): AppError {
  return AppError.validation(reason);
}

/** A moment as a zip header stores it: MS-DOS date and time fields. */
interface DosStamp {
  date: number;
  time: number;
}

/** MS-DOS date and time fields of a moment, read in UTC so the bytes do not
 *  depend on the server's zone. DOS time counts seconds in pairs. */
function dosDateTime(at: Date): DosStamp {
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
  };
}

/**
 * Pack `files` into one archive. Throws a validation refusal when the archive
 * would need ZIP64 (more than 65,535 entries or 4 GB), which a board file's
 * own limits keep far away.
 */
export function writeZip(files: readonly ZipFileInput[], modified: Date): Buffer {
  if (files.length > MAX_U16) {
    throw refuse(`A zip without ZIP64 holds at most ${MAX_U16} files; this one would hold ${files.length}.`);
  }
  const { date, time } = dosDateTime(modified);
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    if (name.length > MAX_U16) throw refuse(`The path ${file.path.slice(0, 80)}… is too long for a zip.`);
    const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    const checksum = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const deflate = deflated.length < data.length;
    const payload = deflate ? deflated : data;
    const method = deflate ? METHOD_DEFLATE : METHOD_STORE;

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION_20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
    header.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    header.writeUInt16LE(MADE_BY_UNIX, 4);
    header.writeUInt16LE(VERSION_20, 6);
    header.writeUInt16LE(FLAG_UTF8, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk number and internal attributes stay 0.
    header.writeUInt32LE(REGULAR_FILE_ATTRS, 38);
    header.writeUInt32LE(offset, 42);

    chunks.push(local, name, payload);
    central.push(header, name);
    offset += local.length + name.length + payload.length;
    if (offset > MAX_U32) throw refuse("A zip without ZIP64 holds at most 4 GB.");
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(END_OF_CENTRAL_BYTES);
  end.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/** Where the end-of-central-directory record starts, or -1. */
function findEndRecord(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - END_SEARCH_BYTES);
  for (let i = bytes.length - END_OF_CENTRAL_BYTES; i >= floor; i -= 1) {
    if (bytes.readUInt32LE(i) === END_OF_CENTRAL_SIG) return i;
  }
  return -1;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const LATIN1 = new TextDecoder("latin1");

/** A name as its writer meant it: UTF-8 when it says so or decodes as UTF-8
 *  (macOS writes UTF-8 without the flag), else the byte-per-character page
 *  old Windows tools wrote. */
function decodeName(raw: Buffer, flags: number): string {
  if (flags & FLAG_UTF8) return raw.toString("utf8");
  try {
    return STRICT_UTF8.decode(raw);
  } catch {
    return LATIN1.decode(raw);
  }
}

/**
 * The archive path as forward-slash segments, or a refusal. A backslash is
 * read as the separator old Windows tools wrote it as; anything that could
 * land outside the folder it is unpacked into is refused outright.
 */
function safeEntryPath(name: string): string {
  const unified = name.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[A-Za-z]:/.test(unified)) {
    throw refuse(`The zip names ${JSON.stringify(name)}, an absolute path. A board file holds relative paths only.`);
  }
  const segments = unified.split("/");
  const trailing = segments.at(-1) === "";
  const parts = trailing ? segments.slice(0, -1) : segments;
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.includes("\0")) {
      throw refuse(`The zip names ${JSON.stringify(name)}, a path that leaves its own folder. Nothing was imported.`);
    }
  }
  return parts.join("/") + (trailing ? "/" : "");
}

/**
 * Unpack an archive's files (directory entries are dropped: a path implies
 * its folders). Refuses, with the reason, anything listed in the module
 * header; nothing is returned unless every entry is sound.
 */
export function readZip(input: Uint8Array, limits: ZipLimits): ZipFile[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < END_OF_CENTRAL_BYTES) throw refuse("This file is not a zip archive.");
  const endAt = findEndRecord(bytes);
  if (endAt < 0) throw refuse("This file is not a zip archive.");
  const diskNumber = bytes.readUInt16LE(endAt + 4);
  const directoryDisk = bytes.readUInt16LE(endAt + 6);
  const entriesHere = bytes.readUInt16LE(endAt + 8);
  const entryCount = bytes.readUInt16LE(endAt + 10);
  const directorySize = bytes.readUInt32LE(endAt + 12);
  const directoryAt = bytes.readUInt32LE(endAt + 16);
  if (entryCount === MAX_U16 || directorySize === MAX_U32 || directoryAt === MAX_U32) {
    throw refuse("This zip uses ZIP64, which a board file never needs. Zip the board folder again with a standard zip tool.");
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesHere !== entryCount) {
    throw refuse("This zip is split across several files. Join it into one archive first.");
  }
  if (entryCount > limits.maxEntries) {
    throw refuse(`This zip holds ${entryCount} entries; a board file holds at most ${limits.maxEntries}.`);
  }
  if (directoryAt + directorySize > endAt) throw refuse("This zip is damaged: its directory runs past its end.");

  const files: ZipFile[] = [];
  const seen = new Set<string>();
  let declaredTotal = 0;
  let cursor = directoryAt;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > endAt || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
      throw refuse("This zip is damaged: its directory is incomplete.");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const packedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttrs = bytes.readUInt32LE(cursor + 38);
    const localAt = bytes.readUInt32LE(cursor + 42);
    const nameEnd = cursor + CENTRAL_HEADER_BYTES + nameLength;
    if (nameEnd > endAt) throw refuse("This zip is damaged: an entry's name runs past the directory.");
    const name = decodeName(bytes.subarray(cursor + CENTRAL_HEADER_BYTES, nameEnd), flags);
    cursor = nameEnd + extraLength + commentLength;

    const entryPath = safeEntryPath(name);
    if (entryPath.endsWith("/")) continue;
    if (packedSize === MAX_U32 || size === MAX_U32 || localAt === MAX_U32) {
      throw refuse("This zip uses ZIP64, which a board file never needs. Zip the board folder again with a standard zip tool.");
    }
    if (madeBy >> 8 === UNIX_HOST && ((externalAttrs >>> 16) & MODE_TYPE_MASK) === MODE_SYMLINK) {
      throw refuse(`${entryPath} is a symbolic link. A board file holds plain files only.`);
    }
    if (flags & FLAG_ENCRYPTED) throw refuse(`${entryPath} is encrypted. Zip the board folder again without a password.`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      throw refuse(`${entryPath} is compressed with a method Viberr does not read. Zip the board folder again with a standard zip tool.`);
    }
    if (seen.has(entryPath)) throw refuse(`The zip holds ${entryPath} twice.`);
    seen.add(entryPath);
    declaredTotal += size;
    if (declaredTotal > limits.maxTotalBytes) {
      throw refuse(`This zip unpacks to more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB; a board file holds at most that.`);
    }

    if (localAt + LOCAL_HEADER_BYTES > directoryAt || bytes.readUInt32LE(localAt) !== LOCAL_HEADER_SIG) {
      throw refuse(`This zip is damaged: ${entryPath} has no header where the directory says.`);
    }
    const dataAt = localAt + LOCAL_HEADER_BYTES + bytes.readUInt16LE(localAt + 26) + bytes.readUInt16LE(localAt + 28);
    if (dataAt + packedSize > directoryAt) {
      throw refuse(`This zip is damaged: ${entryPath} runs past the end of its data.`);
    }
    const packed = bytes.subarray(dataAt, dataAt + packedSize);
    let data: Buffer;
    if (method === METHOD_STORE) {
      if (packedSize !== size) throw refuse(`This zip is damaged: ${entryPath} declares two sizes.`);
      data = Buffer.from(packed);
    } else {
      try {
        // One byte of headroom over the declared size: an entry that inflates
        // past it is refused at that byte instead of filling memory.
        data = inflateRawSync(packed, { maxOutputLength: size + 1 });
      } catch {
        throw refuse(`This zip is damaged: ${entryPath} could not be inflated.`);
      }
      if (data.length !== size) throw refuse(`This zip is damaged: ${entryPath} is not the size its directory declares.`);
    }
    if (crc32(data) !== checksum) throw refuse(`This zip is damaged: ${entryPath} does not match its checksum.`);
    files.push({ path: entryPath, data });
  }
  return files;
}
