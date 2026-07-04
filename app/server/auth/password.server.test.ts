import { describe, expect, it } from "vitest";
import {
  generateTempPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  verifyPassword,
} from "./password.server";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a password", () => {
    const stored = hashPassword("viberr-dev-2828");
    expect(verifyPassword("viberr-dev-2828", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery");
    expect(verifyPassword("correct horse battery!", stored)).toBe(false);
    expect(verifyPassword("", stored)).toBe(false);
  });

  it("stores the documented self-describing format", () => {
    const stored = hashPassword("some-password");
    const parts = stored.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBe(SCRYPT_N);
    expect(Number(parts[2])).toBe(SCRYPT_R);
    expect(Number(parts[3])).toBe(SCRYPT_P);
    expect(Buffer.from(parts[4]!, "base64").byteLength).toBe(32); // salt
    expect(Buffer.from(parts[5]!, "base64").byteLength).toBe(64); // key
  });

  it("uses a fresh salt per hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects legacy / malformed stored formats without throwing", () => {
    for (const legacy of [
      null,
      undefined,
      "",
      "plaintext-password",
      "$2b$10$abcdefghijklmnopqrstuvwx", // bcrypt-ish
      "sha256$deadbeef",
      "scrypt$16384$8$1$notbase64!!$AAAA", // invalid base64 salt
      "scrypt$16384$8$1$" + "A".repeat(44), // missing hash part
      "scrypt$999$8$1$QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=$QUFBQQ==", // N not a power of two
      "scrypt$16384$8$1$c2hvcnQ=$c2hvcnQ=", // salt/key too short
    ]) {
      expect(verifyPassword("whatever", legacy)).toBe(false);
    }
  });

  it("verifies hashes with different (sane) stored parameters", () => {
    // Simulate an old hash created with N=4096.
    const stored = hashPassword("migrate-me").replace("16384", "4096");
    // Different N means different derived key → must be false, not a crash.
    expect(verifyPassword("migrate-me", stored)).toBe(false);
  });

  it("generates temp passwords satisfying the policy", () => {
    const pw = generateTempPassword();
    expect(pw.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });
});
