import { describe, expect, it } from "vitest";
import { checkEnv } from "./env-check";

const SESSION_SECRET = "session-secret-value";
const ENCRYPTION_KEY = "encryption-key-value";
const VALID_ENV = {
  VIBERR_SESSION_SECRET: SESSION_SECRET,
  VIBERR_SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
};

describe("checkEnv", () => {
  it("reports success when both required variables are present", () => {
    expect(checkEnv(VALID_ENV)).toEqual({
      missing: [],
      exitCode: 0,
      stdout: "env ok",
    });
  });

  it("reports the missing variable when one is empty", () => {
    const result = checkEnv({
      ...VALID_ENV,
      VIBERR_SESSION_SECRET: "",
    });

    expect(result.missing).toEqual(["VIBERR_SESSION_SECRET"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("VIBERR_SESSION_SECRET");
  });

  it("reports both variables when both are missing", () => {
    const result = checkEnv({});

    expect(result.missing).toEqual([
      "VIBERR_SESSION_SECRET",
      "VIBERR_SECRET_ENCRYPTION_KEY",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("VIBERR_SESSION_SECRET");
    expect(result.stderr).toContain("VIBERR_SECRET_ENCRYPTION_KEY");
  });

  it("never includes secret values in output", () => {
    const output = JSON.stringify(checkEnv(VALID_ENV));

    expect(output).not.toContain(SESSION_SECRET);
    expect(output).not.toContain(ENCRYPTION_KEY);
  });
});
