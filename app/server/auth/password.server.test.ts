import { describe, expect, it } from "vitest";
import {
  generateTempPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
} from "./password.server";

describe("password helpers", () => {
  it("uses Better Auth hashes", async () => {
    const stored = await hashPassword("viberr-dev-2828");
    await expect(verifyPassword("viberr-dev-2828", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
  });

  it("rejects missing or malformed hashes", async () => {
    await expect(verifyPassword("password", null)).resolves.toBe(false);
    await expect(verifyPassword("password", "not-a-hash")).resolves.toBe(false);
  });

  it("generates a compliant temporary password", () => {
    expect(generateTempPassword().length).toBeGreaterThanOrEqual(
      MIN_PASSWORD_LENGTH,
    );
  });
});
