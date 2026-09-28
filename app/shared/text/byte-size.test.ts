import { describe, expect, it } from "vitest";
import { prettySize } from "./byte-size";

describe("prettySize", () => {
  it("prints a size the way the store browser, the attachments and the file trays show it", () => {
    // CANARY: switch the KB step to 1000 and a 1,536-byte file reads "1.5 KB"
    // nowhere; the store browser's mock display forms are the contract.
    expect(prettySize(512)).toBe("512 B");
    expect(prettySize(0)).toBe("0 B");
    expect(prettySize(1536)).toBe("1.5 KB");
    expect(prettySize(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(prettySize(null)).toBe("");
  });
});
