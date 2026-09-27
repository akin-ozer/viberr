import { describe, expect, it } from "vitest";
import { attachmentKind, fileFamily, looksBinary } from "./attachment-kind";

const NUL = String.fromCharCode(0);

describe("fileFamily", () => {
  it("tints by the reader's grammar table: docs, data, log, any other grammar code, no grammar plain", () => {
    expect(fileFamily("README.md")).toBe("docs");
    expect(fileFamily("capture.yml")).toBe("data");
    expect(fileFamily("results.csv")).toBe("data");
    expect(fileFamily("console-1.log")).toBe("log");
    expect(fileFamily("journey-script.mjs")).toBe("code");
    expect(fileFamily("Dockerfile")).toBe("code");
    expect(fileFamily("notes.txt")).toBe("plain");
    expect(fileFamily("report.pdf")).toBe("plain");
  });
});

/* Ruling 363: what the card can show, decided from the name and then the bytes. */
describe("attachmentKind (ruling 363)", () => {
  it("names decide images and the known binary kinds; everything else tries the reader", () => {
    expect(attachmentKind("shot.PNG")).toBe("image");
    expect(attachmentKind("bundle.zip")).toBe("binary");
    expect(attachmentKind("report.pdf")).toBe("binary");
    expect(attachmentKind("font.woff2")).toBe("binary");
    // The file the owner was shown "no in-app preview" for.
    expect(attachmentKind("shop-65-journey-script.mjs")).toBe("text");
    expect(attachmentKind("Dockerfile")).toBe("text");
    expect(attachmentKind("capture.yml")).toBe("text");
    expect(attachmentKind("icon.svg")).toBe("text");
    // Unknown is not binary: the bytes decide.
    expect(attachmentKind("weird.dat")).toBe("text");
  });

  it("a NUL in the head is binary; UTF-8 text with odd characters is not", () => {
    expect(looksBinary("PK" + String.fromCharCode(3, 4) + NUL + NUL)).toBe(true);
    expect(looksBinary("héllo — 日本語 " + String.fromCharCode(9, 13, 10))).toBe(false);
    expect(looksBinary("")).toBe(false);
    // The window is the head, git's 8,000 — a NUL past it is not what a
    // reader sees first, and the card already says the file is shown in part.
    expect(looksBinary("a".repeat(8_000) + NUL)).toBe(false);
    expect(looksBinary("a".repeat(8_000 - 1) + NUL)).toBe(true);
  });
});
