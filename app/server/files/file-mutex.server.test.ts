import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-mutex.server";

describe("withFileLock", () => {
  it("releases the native lock after a synchronous failure", async () => {
    const key = `test-${crypto.randomUUID()}`;
    await expect(
      withFileLock(key, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withFileLock(key, () => "released")).resolves.toBe("released");
  });
});
