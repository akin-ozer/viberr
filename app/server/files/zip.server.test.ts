import { describe, expect, it } from "vitest";
import { readZip, writeZip, type ZipFileInput } from "./zip.server";

/**
 * Ruling 653: the zip a board file travels in is read from an upload, so the
 * reader is a trust boundary. These pin what it refuses; the board suites
 * (`board-import.server.test.ts`) pin that a real zip, Finder's, reads.
 */

const LIMITS = { maxEntries: 10, maxTotalBytes: 10_000 };
const AT = new Date("2026-10-04T12:00:00.000Z");

/** Where entry `index`'s central header starts in `zip`. */
function centralHeader(zip: Buffer, index: number): number {
  const end = zip.length - 22;
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < index; i += 1) {
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return at;
}

/** A one-file zip with a patch applied to that file's central header. */
function patched(file: ZipFileInput, patch: (zip: Buffer, header: number) => void): Buffer {
  const zip = writeZip([file], AT);
  patch(zip, centralHeader(zip, 0));
  return zip;
}

const TEXT: ZipFileInput = { path: "board/board.md", data: Buffer.from("a".repeat(400)) };

describe("ruling 653: readZip", () => {
  it("reads back what writeZip wrote: UTF-8 names, empty files and binary bytes", () => {
    // CANARY: drop the UTF-8 flag or the STORE path and a Turkish file name,
    // an empty file or a PDF comes back changed.
    const files: ZipFileInput[] = [
      { path: "kb/notlar/çalışma planı.md", data: Buffer.from("# Plan\n") },
      { path: "kb/notlar/empty.md", data: Buffer.alloc(0) },
      { path: "kb/notlar/scan.pdf", data: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]) },
    ];
    expect(readZip(writeZip(files, AT), LIMITS)).toEqual(
      files.map((f) => ({ path: f.path, data: Buffer.from(f.data) })),
    );
  });

  it.each([
    ["anything that is not a zip", Buffer.from("PK? not really"), /not a zip archive/],
    ["a path that climbs out of its folder", writeZip([{ path: "board/../../escape.md", data: Buffer.from("x") }], AT), /leaves its own folder/],
    ["an absolute path", writeZip([{ path: "/etc/cron.d/job", data: Buffer.from("x") }], AT), /absolute path/],
    ["a drive-letter path", writeZip([{ path: "C:/Windows/x.md", data: Buffer.from("x") }], AT), /absolute path/],
    ["the same path twice", writeZip([TEXT, TEXT], AT), /holds board\/board\.md twice/],
    ["more entries than the limit", writeZip(Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, data: Buffer.from("x") })), AT), /holds 11 entries/],
    ["more declared bytes than the limit", writeZip([{ path: "big", data: Buffer.alloc(10_001) }], AT), /unpacks to more than/],
    [
      "a symbolic link",
      patched(TEXT, (zip, at) => zip.writeUInt32LE((0o120777 << 16) >>> 0, at + 38)),
      /board\/board\.md is a symbolic link/,
    ],
    ["an encrypted entry", patched(TEXT, (zip, at) => zip.writeUInt16LE(zip.readUInt16LE(at + 8) | 1, at + 8)), /is encrypted/],
    ["a compression method it does not read", patched(TEXT, (zip, at) => zip.writeUInt16LE(12, at + 10)), /method Viberr does not read/],
    [
      "an entry that inflates past its declared size",
      patched(TEXT, (zip, at) => zip.writeUInt32LE(10, at + 24)),
      /could not be inflated/,
    ],
    ["an entry whose bytes do not match its checksum", patched(TEXT, (zip, at) => zip.writeUInt32LE(0xdeadbeef, at + 16)), /does not match its checksum/],
  ])("refuses %s", (_case, zip, reason) => {
    // CANARY: drop any one check in `readZip` and its row reads the zip.
    expect(() => readZip(zip, LIMITS)).toThrow(reason);
  });
});
