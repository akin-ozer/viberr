import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Whether the disk the tests run on treats the two Unicode forms of a name as
 * one file (ruling 675). APFS does: writing `é` composed and then decomposed
 * leaves one entry. The disk production runs on does not, so a folder there
 * can hold both as two files, and a test about that pair has nothing to stand
 * on here. Such a test is skipped with `it.skipIf(diskFoldsUnicodeForms)`
 * rather than left to pass without its fixture.
 */
export const diskFoldsUnicodeForms: boolean = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-forms-"));
  try {
    writeFileSync(path.join(dir, "é"), "");
    writeFileSync(path.join(dir, "é"), "");
    return readdirSync(dir).length < 2;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
