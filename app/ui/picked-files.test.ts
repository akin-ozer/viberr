import { describe, expect, it } from "vitest";
import { ATTACHMENT_BATCH_MAX, MAX_UPLOAD_BYTES, MESSAGE_BATCH } from "~/shared/attachment-kinds";
import { addPickedFiles, filesFromPaste } from "./picked-files";

/**
 * Rulings 76 and 319: the decisions a composer makes about files before the
 * server sees anything, for the New task dialog and every chat alike: which
 * picks it keeps, and whether a paste is text or a file.
 */

function file(name: string, bytes = 4, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("addPickedFiles", () => {
  it("keeps a file of any kind, and names the first one the server would refuse", () => {
    // CANARY: drop the size check and `memory.dmp` is kept, to be refused by
    // the server after the person pressed Send. Ruling 76: `main.tf` and
    // `report.docx` are kept whatever their kind.
    const { files, problem } = addPickedFiles(
      [],
      [file("main.tf"), file("memory.dmp", MAX_UPLOAD_BYTES + 1), file("report.docx")],
      MESSAGE_BATCH,
    );
    expect(files.map((f) => f.name)).toEqual(["main.tf", "report.docx"]);
    expect(problem).toContain("“memory.dmp”");
  });

  it("replaces a file picked again under the same name, and stops at the count", () => {
    const again = addPickedFiles([file("inventory.csv", 4)], [file("Inventory.csv", 9)], MESSAGE_BATCH);
    expect(again.files.map((f) => [f.name, f.size])).toEqual([["Inventory.csv", 9]]);
    const many = Array.from({ length: ATTACHMENT_BATCH_MAX + 1 }, (_, i) => file(`vm-${i}.csv`));
    const capped = addPickedFiles([], many, MESSAGE_BATCH);
    expect(capped.files).toHaveLength(ATTACHMENT_BATCH_MAX);
    expect(capped.problem).toBe(
      `A message can carry up to ${ATTACHMENT_BATCH_MAX} files. Send the rest in another message.`,
    );
  });
});

describe("filesFromPaste", () => {
  const clipboard = (files: File[], types: string[]) => ({ files, types });

  it("leaves copied cells in a text field as text, and files a bare screenshot as one", () => {
    // A spreadsheet's copied cells carry their text AND a picture of them.
    // CANARY: drop the text check and pasting cells into a message attaches a
    // PNG instead of the numbers.
    const cells = clipboard([file("image.png", 4, "image/png")], ["text/plain", "text/html", "Files"]);
    expect(filesFromPaste(cells, true, [])).toBeNull();
    const shot = clipboard([file("image.png", 4, "image/png")], ["Files"]);
    expect(filesFromPaste(shot, true, [])?.map((f) => f.name)).toEqual(["screenshot.png"]);
    // Outside a text field even the cells' picture is filed.
    expect(filesFromPaste(cells, false, [])?.map((f) => f.name)).toEqual(["screenshot.png"]);
  });

  it("numbers a second screenshot instead of replacing the first", () => {
    const shot = clipboard([file("image.png", 4, "image/png")], ["Files"]);
    expect(filesFromPaste(shot, false, [file("screenshot.png")])?.map((f) => f.name)).toEqual([
      "screenshot-2.png",
    ]);
    expect(filesFromPaste(clipboard([], ["text/plain"]), false, [])).toBeNull();
  });
});
