import { describe, expect, it } from "vitest";
import { insecureAuthOriginWarning, parseEnv } from "./env.server";

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

  it("accepts a Codex ChatGPT-workspace access token", () => {
    const env = parseEnv({
      ...REQUIRED_ENV,
      CODEX_ACCESS_TOKEN: "cat-subscription-test",
    });
    expect(env.CODEX_ACCESS_TOKEN).toBe("cat-subscription-test");
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
      if (!(error instanceof Error)) throw error;
      const message = error.message;
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

/**
 * U8 — `BETTER_AUTH_URL=http://…` silently downgrades the session cookie.
 *
 * Viberr sets no cookie security flag of its own: better-auth derives
 * `__Secure-` from this URL alone, so an `http://` value in production issues
 * session cookies with no Secure attribute — and simultaneously removes the
 * accidental `__Secure-` login loop that `docs/operations/deployment.md`
 * documents as the symptom of a missing TLS proxy. Silent in both directions,
 * against NFR6. The boot warning is the remedy; this is the rule it asks.
 */
describe("insecureAuthOriginWarning (U8)", () => {
  const at = (NODE_ENV: string, BETTER_AUTH_URL?: string) => {
    // Omitting the variable has to mean UNSET, not an empty string (parseEnv
    // treats those alike, but the absence is what the last case is about).
    const base = { ...REQUIRED_ENV, NODE_ENV };
    return insecureAuthOriginWarning(
      parseEnv(BETTER_AUTH_URL ? { ...base, BETTER_AUTH_URL } : base),
    );
  };

  it("warns for an http:// production origin, naming the value and the consequence", () => {
    const warning = at("production", "http://viberr.internal");
    expect(warning).toContain("http://viberr.internal");
    expect(warning).toContain("Secure");
    expect(warning).toContain("cleartext");
    // It has to say what to DO, not only what is wrong.
    expect(warning).toContain("https://");
  });

  it("says nothing about an https:// origin — the correct configuration", () => {
    expect(at("production", "https://viberr.example.com")).toBeNull();
  });

  it("says nothing in development, where http:// is the normal case", () => {
    expect(at("development", "http://localhost:5173")).toBeNull();
    expect(at("test", "http://viberr.internal")).toBeNull();
  });

  it("says nothing for a loopback host — a production build run locally", () => {
    for (const url of [
      "http://localhost:5173",
      "http://app.localhost:5173",
      "http://127.0.0.1:5173",
    ]) {
      expect({ url, warning: at("production", url) }).toEqual({
        url,
        warning: null,
      });
    }
  });

  it("says nothing when the variable is unset (better-auth infers the origin)", () => {
    // The UNSET case has its own boot warning (OAuth + no BETTER_AUTH_URL);
    // this rule must not double up on it.
    expect(at("production")).toBeNull();
  });
});
