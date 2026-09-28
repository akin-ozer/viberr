import { describe, expect, it } from "vitest";
import { FILED_ATTACHMENTS_MAX, MAX_UPLOAD_BYTES } from "~/shared/attachment-kinds";
import { addFiledFiles, filesFromPaste } from "./filed-files";

/**
 * Ruling 533: the New task dialog files a task with its input. These are the
 * two decisions the dialog makes before the server sees anything: which picks
 * it keeps, and whether a paste is text or a file.
 */

function file(name: string, bytes = 4, type = ""): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("addFiledFiles", () => {
  it("keeps what the server stores and names the first file it would refuse", () => {
    // CANARY: drop the extension check and `page.html` is kept, to be refused
    // by the server after the person pressed Create.
    const { files, problem } = addFiledFiles([], [file("inventory.csv"), file("page.html"), file("portal.png")]);
    expect(files.map((f) => f.name)).toEqual(["inventory.csv", "portal.png"]);
    expect(problem).toContain("“page.html”");
  });

  it("replaces a file picked again under the same name, and stops at the count", () => {
    const again = addFiledFiles([file("inventory.csv", 4)], [file("Inventory.csv", 9)]);
    expect(again.files.map((f) => [f.name, f.size])).toEqual([["Inventory.csv", 9]]);
    const many = Array.from({ length: FILED_ATTACHMENTS_MAX + 1 }, (_, i) => file(`vm-${i}.csv`));
    const capped = addFiledFiles([], many);
    expect(capped.files).toHaveLength(FILED_ATTACHMENTS_MAX);
    expect(capped.problem).toContain(`up to ${FILED_ATTACHMENTS_MAX} files`);
    expect(addFiledFiles([], [file("huge.csv", MAX_UPLOAD_BYTES + 1)]).files).toEqual([]);
  });
});

describe("filesFromPaste", () => {
  const clipboard = (files: File[], types: string[]) => ({ files, types });

  it("leaves copied cells in a text field as text, and files a bare screenshot as one", () => {
    // A spreadsheet's copied cells carry their text AND a picture of them.
    // CANARY: drop the text check and pasting cells into the goal attaches a
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
