import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { xlsxToText } from "./xlsx-text.server";

/**
 * Ruling 117: an inventory is a spreadsheet more often than anything else, and
 * viberr stores only what it can read back (ruling 76). The fixture is a real
 * workbook written by openpyxl (shared strings, numbers, a boolean, an empty
 * cell mid-row, a gap before a far cell, a second sheet), shaped like the
 * RVTools export people hand an AWS estimate board.
 */
const FIXTURE = path.join(import.meta.dirname, "../../../test-support/fixtures/rvtools-sample.xlsx");
/** Excel's own layout, written by XlsxWriter: every string in the shared
 *  table, one of them rich text in two runs, and a formula with its cached
 *  value. Excel, LibreOffice and Google Sheets all write strings this way. */
const EXCEL_FIXTURE = path.join(import.meta.dirname, "../../../test-support/fixtures/azure-export-sample.xlsx");

describe("xlsxToText", () => {
  it("reads Excel's shared strings, rich text and a formula's cached value", () => {
    // CANARY: read cell values without the shared-string table and every
    // text cell comes back as its index ("0", "1", ...).
    expect(xlsxToText(readFileSync(EXCEL_FIXTURE), 40_000)).toEqual({
      truncated: false,
      text: [
        "## Sheet: Resources",
        "Name,Type,Location,Size,Monthly cost",
        "vm-app-01,Microsoft.Compute/virtualMachines,westeurope,Standard_D4s_v5,141.62",
        "sql-prod,Microsoft.Sql/servers/databases,westeurope,GP_Gen5_4,736.4",
        "Total,,,,878.02",
        "",
      ].join("\n"),
    });
  });

  it("reads every sheet's cells as CSV, in the workbook's order", () => {
    const read = xlsxToText(readFileSync(FIXTURE), 40_000);
    expect(read).toEqual({
      truncated: false,
      text: [
        "## Sheet: vInfo",
        "VM,Powerstate,CPUs,Memory MB,OS according to the VMware Tools,Notes",
        'web-01,poweredOn,4,16384,Microsoft Windows Server 2019 (64-bit),"front end, ""blue"" pool"',
        "db-01,poweredOn,8,65536,Red Hat Enterprise Linux 8 (64-bit)",
        "old-02,poweredOff,2,4096,,retire?",
        "## Sheet: vHost",
        "Host,Cores,HT Active",
        "esx-01,32,TRUE",
        ",,,,sparse",
        "",
      ].join("\n"),
    });
  });

  it("stops at the budget and says so, and names bytes that are not a workbook", () => {
    const clipped = xlsxToText(readFileSync(FIXTURE), 80);
    expect(clipped).toMatchObject({ truncated: true });
    expect("text" in clipped ? clipped.text.length : Infinity).toBeLessThanOrEqual(80);
    expect(xlsxToText(Buffer.from("vm,cpu\nweb01,4\n"), 1000)).toEqual({
      unreadable: "is not a readable .xlsx workbook (no zip directory).",
    });
  });
});

/**
 * A workbook's parts, stored uncompressed in a zip the reader parses the way
 * it parses any other: local headers, the central directory and its end
 * record. Enough to hand the reader a hostile part without a spreadsheet tool.
 */
function storedWorkbook(parts: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function oneSheet(sheetXml: string): Buffer {
  return storedWorkbook({
    "xl/workbook.xml": '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": sheetXml,
  });
}

/**
 * Ruling 117's reader takes bytes a person or an agent chose, and the
 * coordinators read attachments at triage, so a hostile workbook reaches it by
 * being filed. Each case once crashed or stalled the server process.
 */
describe("xlsxToText against a hostile workbook", () => {
  it("skips a cell past Excel's last column instead of padding the row out to it", () => {
    // CANARY: drop the COLUMN_MAX check in columnIndex and this pads a row to
    // ~2e11 cells, which ends the process out of heap.
    const read = xlsxToText(
      oneSheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>web01</t></is></c><c r="ZZZZZZZZ1"><v>1</v></c></row></sheetData>'),
      40_000,
    );
    expect(read).toEqual({ truncated: false, text: "## Sheet: S\nweb01\n" });
  });

  it("reads a flood of unclosed rows in linear time", () => {
    // CANARY: find rows with a lazy `<row>...</row>` pattern again and each
    // unclosed tag re-reads the rest of the part: minutes, not milliseconds.
    const flood = "<row>".repeat(200_000);
    const started = performance.now();
    const read = xlsxToText(oneSheet(`<sheetData>${flood}</sheetData>`), 40_000);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(read).toEqual({ truncated: false, text: "## Sheet: S\n" });
  });

  it("keeps a character reference outside Unicode as it was written", () => {
    // CANARY: drop the range check and String.fromCodePoint throws.
    const read = xlsxToText(
      oneSheet('<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a&#x110000;b</t></is></c></row></sheetData>'),
      40_000,
    );
    expect(read).toEqual({ truncated: false, text: "## Sheet: S\na&#x110000;b\n" });
  });
});
