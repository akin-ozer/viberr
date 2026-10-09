import { inflateRawSync } from "node:zlib";

/**
 * Ruling 79: a spreadsheet read back as text, each sheet as CSV.
 *
 * The inventories people hand a board that delivers results are spreadsheets
 * far more often than anything else (an RVTools export, an Azure Migrate
 * assessment, a CMDB dump), and viberr stores only what it can show or read
 * back (ruling 76). An `.xlsx` is a zip of XML parts, and reading its cell
 * values needs nothing beyond the zip container and those parts: the shared
 * string table, the workbook's sheet list and each sheet's cells. Formatting,
 * formulas and charts are not read; a formula's cached value is.
 *
 * Bounded, because the bytes come from a person (or an agent): the workbook's
 * parts share one inflate budget, so a zip bomb, or many sheets naming one
 * huge part, stops there; elements are found by a forward scan whose cost is
 * linear in the part, never by a pattern that re-reads the rest of the part
 * for every unclosed tag; a cell past Excel's last column is not read; and the
 * text stops at the reader's character budget with `truncated` set.
 */

/** The most one part may inflate to. */
const PART_MAX_BYTES = 64 * 1024 * 1024;
/** The most every part of one workbook may inflate to, together. */
const WORKBOOK_MAX_BYTES = 128 * 1024 * 1024;
/** Excel's last column is XFD, the 16,384th. */
const COLUMN_MAX = 16_384;
/** The most sheets one workbook is read for. */
const SHEETS_MAX = 256;

interface ZipEntry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** The zip's central directory, by part name. Null when this is not a zip. */
function zipEntries(buf: Buffer): Map<string, ZipEntry> | null {
  // The end-of-central-directory record is the last 22 bytes plus a comment
  // of up to 64 KB; scan back for its signature.
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(at + 10);
    const compressedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** What is left of a workbook's inflate budget. */
interface InflateBudget {
  bytes: number;
}

/** One part's bytes as text, or null when the part is absent or unreadable, or
 *  would take the workbook past its inflate budget. */
function readPart(
  buf: Buffer,
  entries: Map<string, ZipEntry>,
  name: string,
  budget: InflateBudget,
): string | null {
  const entry = entries.get(name);
  if (!entry) return null;
  const at = entry.localOffset;
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  const ceiling = Math.min(PART_MAX_BYTES, budget.bytes);
  let bytes: Buffer;
  if (entry.method === 0) {
    if (data.length > ceiling) return null;
    bytes = data;
  } else if (entry.method === 8) {
    try {
      bytes = inflateRawSync(data, { maxOutputLength: ceiling });
    } catch {
      return null;
    }
  } else {
    return null;
  }
  budget.bytes -= bytes.length;
  return bytes.toString("utf8");
}

/**
 * Every `<tag ...>body</tag>` (or self-closed `<tag .../>`) in `xml`, in order,
 * found by a forward scan: each search starts where the last one ended, so an
 * unclosed tag ends the scan instead of making every later start re-read the
 * rest of the part. The tags read here never nest in themselves.
 */
function* elements(xml: string, tag: string): Generator<{ open: string; body: string }> {
  const opener = `<${tag}`;
  const closer = `</${tag}>`;
  let from = 0;
  while (from < xml.length) {
    const at = xml.indexOf(opener, from);
    if (at < 0) return;
    const next = xml.charAt(at + opener.length);
    // `<c` must not match `<col` or `<cfRule`.
    if (next !== ">" && next !== "/" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
      from = at + opener.length;
      continue;
    }
    const openEnd = xml.indexOf(">", at);
    if (openEnd < 0) return;
    const open = xml.slice(at, openEnd + 1);
    if (open.endsWith("/>")) {
      yield { open, body: "" };
      from = openEnd + 1;
      continue;
    }
    const close = xml.indexOf(closer, openEnd + 1);
    if (close < 0) return;
    yield { open, body: xml.slice(openEnd + 1, close) };
    from = close + closer.length;
  }
}

/** The body of the first `<tag>` in `xml`, or undefined. */
function firstBody(xml: string, tag: string): string | undefined {
  for (const element of elements(xml, tag)) return element.body;
  return undefined;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, entity: string) => {
    const e = entity.toLowerCase();
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e.startsWith("#x") ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    // A code point outside Unicode, or a lone surrogate, stays as written.
    const valid = Number.isInteger(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

/** The text of every `<t>` in a fragment: a plain string, or a rich one split
 *  into runs. Phonetic hints (`<rPh>`) are not part of the value. */
function runText(fragment: string): string {
  let plain = "";
  let from = 0;
  for (const phonetic of elements(fragment, "rPh")) {
    const at = fragment.indexOf(phonetic.open, from);
    plain += fragment.slice(from, at);
    from = at + phonetic.open.length + phonetic.body.length + (phonetic.open.endsWith("/>") ? 0 : "</rPh>".length);
  }
  plain += fragment.slice(from);
  let out = "";
  for (const t of elements(plain, "t")) out += decodeXml(t.body);
  return out;
}

/** "A" → 0, "Z" → 25, "AA" → 26; null past Excel's last column (XFD). */
function columnIndex(ref: string): number | null {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
    if (n > COLUMN_MAX) return null;
  }
  return n - 1;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : null;
}

/** The workbook's sheets in order, each with the part that holds its cells. */
function sheetParts(
  buf: Buffer,
  entries: Map<string, ZipEntry>,
  budget: InflateBudget,
): { name: string; part: string }[] {
  const workbook = readPart(buf, entries, "xl/workbook.xml", budget) ?? "";
  const rels = readPart(buf, entries, "xl/_rels/workbook.xml.rels", budget) ?? "";
  const targets = new Map<string, string>();
  for (const relationship of elements(rels, "Relationship")) {
    const id = attr(relationship.open, "Id");
    const target = attr(relationship.open, "Target");
    if (id && target) {
      targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
    }
  }
  const sheets: { name: string; part: string }[] = [];
  const seen = new Set<string>();
  for (const sheet of elements(workbook, "sheet")) {
    if (sheets.length >= SHEETS_MAX) break;
    const name = attr(sheet.open, "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(sheet.open, "r:id");
    const part = rid ? targets.get(rid) : undefined;
    // A part two sheets name is read once: it is one sheet's cells.
    if (part && !seen.has(part)) {
      seen.add(part);
      sheets.push({ name, part });
    }
  }
  return sheets;
}

/**
 * The workbook as text: each sheet under a `## Sheet: <name>` line, its rows
 * as CSV. `unreadable` says why, in words, when the bytes are not a workbook.
 */
export function xlsxToText(
  buf: Buffer,
  maxChars: number,
): { text: string; truncated: boolean } | { unreadable: string } {
  const entries = zipEntries(buf);
  if (!entries) return { unreadable: "is not a readable .xlsx workbook (no zip directory)." };
  const budget: InflateBudget = { bytes: WORKBOOK_MAX_BYTES };
  const sheets = sheetParts(buf, entries, budget);
  if (sheets.length === 0) return { unreadable: "is a zip with no worksheets in it." };
  const shared: string[] = [];
  const sst = readPart(buf, entries, "xl/sharedStrings.xml", budget) ?? "";
  for (const si of elements(sst, "si")) shared.push(runText(si.body));
  let text = "";
  let truncated = false;
  const append = (line: string): boolean => {
    if (text.length + line.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    text += `${line}\n`;
    return true;
  };
  for (const sheet of sheets) {
    const xml = readPart(buf, entries, sheet.part, budget);
    if (!append(`## Sheet: ${sheet.name}${xml === null ? " (unreadable)" : ""}`)) break;
    if (xml === null) continue;
    for (const row of elements(xml, "row")) {
      const cells: string[] = [];
      for (const cell of elements(row.body, "c")) {
        const ref = attr(cell.open, "r");
        const index = ref ? columnIndex(ref) : cells.length < COLUMN_MAX ? cells.length : null;
        // Past Excel's last column is not a cell a workbook can hold.
        if (index === null || index < 0) continue;
        const type = attr(cell.open, "t");
        const v = firstBody(cell.body, "v");
        let value: string;
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = runText(firstBody(cell.body, "is") ?? "");
        else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else value = v === undefined ? "" : decodeXml(v);
        while (cells.length < index) cells.push("");
        cells[index] = value;
      }
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      if (cells.length === 0) continue;
      if (!append(cells.map(csvField).join(","))) break;
    }
    if (truncated) break;
  }
  return { text, truncated };
}
