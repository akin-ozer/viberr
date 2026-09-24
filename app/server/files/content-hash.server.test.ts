import { describe, expect, it } from "vitest";
import { sha256Hex } from "./content-hash.server";

describe("sha256Hex", () => {
  it("answers the published SHA-256 vectors in lowercase hex", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes a string as its UTF-8 bytes", () => {
    const text = "café · naïve — 你好";
    expect(sha256Hex(text)).toBe(sha256Hex(Buffer.from(text, "utf8")));
  });
});
