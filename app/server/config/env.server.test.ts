import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.server";

const VALID_SESSION_SECRET = "s".repeat(32);
// base64 of exactly 32 bytes
const VALID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const REQUIRED_ENV = {
  VIBERR_SESSION_SECRET: VALID_SESSION_SECRET,
  VIBERR_SECRET_ENCRYPTION_KEY: VALID_ENCRYPTION_KEY,
};

describe("parseEnv", () => {
  it("accepts a minimal valid env and applies defaults", () => {
    const env = parseEnv(REQUIRED_ENV);
    expect(env.VIBERR_SESSION_SECRET).toBe(VALID_SESSION_SECRET);
    expect(env.VIBERR_SECRET_ENCRYPTION_KEY).toBeInstanceOf(Buffer);
    expect(env.VIBERR_SECRET_ENCRYPTION_KEY.byteLength).toBe(32);
    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(5173);
    expect(env.VIBERR_DATA_ROOT).toBe("./data");
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VIBERR_SEED_ADMIN_EMAIL).toBeUndefined();
  });

  it("parses explicit values", () => {
    const env = parseEnv({
      ...REQUIRED_ENV,
      NODE_ENV: "production",
      PORT: "8080",
      VIBERR_DATA_ROOT: "/srv/viberr-data",
      GITHUB_OAUTH_CLIENT_ID: "gh-id",
      GITHUB_OAUTH_CLIENT_SECRET: "gh-secret",
      VIBERR_SEED_ADMIN_EMAIL: "admin@example.com",
      VIBERR_SEED_ADMIN_PASSWORD: "super-secret-pw",
    });
    expect(env.NODE_ENV).toBe("production");
    expect(env.PORT).toBe(8080);
    expect(env.VIBERR_DATA_ROOT).toBe("/srv/viberr-data");
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBe("gh-id");
    expect(env.VIBERR_SEED_ADMIN_EMAIL).toBe("admin@example.com");
  });

  it("decodes the encryption key into the exact bytes", () => {
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const env = parseEnv({
      ...REQUIRED_ENV,
      VIBERR_SECRET_ENCRYPTION_KEY: bytes.toString("base64"),
    });
    expect(env.VIBERR_SECRET_ENCRYPTION_KEY.equals(bytes)).toBe(true);
  });

  it("lists every missing required var in one error", () => {
    expect(() => parseEnv({})).toThrowError(
      /Invalid environment configuration:/,
    );
    try {
      parseEnv({});
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("VIBERR_SESSION_SECRET");
      expect(message).toContain("VIBERR_SECRET_ENCRYPTION_KEY");
    }
  });

  it("rejects a session secret shorter than 32 chars", () => {
    expect(() =>
      parseEnv({ ...REQUIRED_ENV, VIBERR_SESSION_SECRET: "too-short" }),
    ).toThrowError(/VIBERR_SESSION_SECRET.*32/);
  });

  it("rejects an encryption key that is not valid base64", () => {
    expect(() =>
      parseEnv({
        ...REQUIRED_ENV,
        VIBERR_SECRET_ENCRYPTION_KEY: "!!! not base64 !!!",
      }),
    ).toThrowError(/VIBERR_SECRET_ENCRYPTION_KEY.*base64/);
  });

  it("rejects an encryption key that decodes to the wrong length", () => {
    const sixteenBytes = Buffer.alloc(16, 1).toString("base64");
    expect(() =>
      parseEnv({
        ...REQUIRED_ENV,
        VIBERR_SECRET_ENCRYPTION_KEY: sixteenBytes,
      }),
    ).toThrowError(/32 bytes.*got 16/);
  });

  it("treats empty strings as missing", () => {
    expect(() =>
      parseEnv({
        VIBERR_SESSION_SECRET: "",
        VIBERR_SECRET_ENCRYPTION_KEY: "",
      }),
    ).toThrowError(/VIBERR_SESSION_SECRET/);

    // empty optional/defaulted vars fall back instead of failing
    const env = parseEnv({
      ...REQUIRED_ENV,
      VIBERR_DATA_ROOT: "",
      PORT: "",
      GITHUB_OAUTH_CLIENT_ID: "",
    });
    expect(env.VIBERR_DATA_ROOT).toBe("./data");
    expect(env.PORT).toBe(5173);
    expect(env.GITHUB_OAUTH_CLIENT_ID).toBeUndefined();
  });

  it("rejects a non-numeric PORT", () => {
    expect(() =>
      parseEnv({ ...REQUIRED_ENV, PORT: "not-a-port" }),
    ).toThrowError(/PORT/);
  });

  it("rejects an invalid seed admin email", () => {
    expect(() =>
      parseEnv({ ...REQUIRED_ENV, VIBERR_SEED_ADMIN_EMAIL: "not-an-email" }),
    ).toThrowError(/VIBERR_SEED_ADMIN_EMAIL/);
  });
});
