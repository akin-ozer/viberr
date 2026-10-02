import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Ruling 629: a PDF attachment reads as its text.
 *
 * calculator.aws exports an estimate as a PDF, and the board's rulings ask the
 * Estimate Judge to check every delivered export. Ruling 566 put poppler in the
 * image so a run's shell could render one, but `read_task_attachment` still
 * named a .pdf as binary and refused it: live on AWSC-85 the Judge wrote that
 * "the attachment reader does not parse its binary contents". `pdftotext
 * -layout` keeps a priced table's columns on their lines, and a form feed
 * separates the pages.
 */

/** A calculator export reads in well under a second; a PDF that takes longer
 *  than this is not one a reader should wait on. The read is synchronous, as
 *  the workbook read beside it is. */
const PDF_TEXT_TIMEOUT_MS = 10_000;

/** Room for the text of the largest PDF the reader takes (16 MB). */
const PDF_TEXT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The text of a PDF, cut to `maxChars`, or a sentence saying why there is none:
 * no `pdftotext` on this host, a file it cannot read, or pages with no text
 * layer (a scan), which a run looks at as pictures with `pdftoppm` instead.
 * The sentence follows the file's name.
 */
export function pdfToText(
  bytes: Buffer,
  maxChars: number,
): { text: string; truncated: boolean } | { unreadable: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "viberr-pdf-"));
  try {
    const file = path.join(dir, "attachment.pdf");
    writeFileSync(file, bytes);
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], {
        encoding: "utf8",
        timeout: PDF_TEXT_TIMEOUT_MS,
        maxBuffer: PDF_TEXT_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // SAFETY: execFileSync throws only Error objects: a spawn failure carries
      // `code` (ENOENT when the binary is missing), and a failed or timed-out
      // run carries the child's `stderr`, which this reads as an optional string.
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") {
        return { unreadable: "is a PDF, and this host has no `pdftotext` to read it with (poppler-utils, ruling 566)." };
      }
      const reason =
        String(failure.stderr || failure.message)
          .split("\n")
          .find((line) => line.trim())
          ?.trim()
          .slice(0, 200) ?? "it stopped";
      return { unreadable: `is a PDF that \`pdftotext\` could not read: ${reason}.` };
    }
    if (!/\S/.test(text)) {
      return {
        unreadable:
          "is a PDF with no text layer (scanned or drawn pages). Render its pages to images with `pdftoppm` in your shell to look at them.",
      };
    }
    return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
