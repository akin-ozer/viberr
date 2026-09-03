import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_KEYS, insecureAuthOriginWarning, parseEnv } from "./env.server";

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

  /**
   * Ruling 121: agent backends authenticate PER PERSON. The nine
   * deployment-wide credential variables are gone from the schema, and this
   * gate is what stops one creeping back in — a declared key would be an
   * instance credential every run could bill to whoever owns it, which is the
   * whole thing the ruling forbids. An ambient value must be ignored, not
   * carried through.
   */
  it("declares no deployment-wide agent-backend credential (ruling 121)", () => {
    const removed = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "VIBERR_CLAUDE_USE_CLI_AUTH",
      "CLAUDE_CONFIG_DIR",
      "CODEX_ACCESS_TOKEN",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "VIBERR_CODEX_USE_CLI_AUTH",
    ];
    expect(ENV_KEYS.filter((key) => removed.includes(key))).toEqual([]);
    const env = parseEnv({
      ...REQUIRED_ENV,
      ...Object.fromEntries(removed.map((key) => [key, "ambient-value"])),
    });
    expect(Object.keys(env).filter((key) => removed.includes(key))).toEqual([]);
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

  /**
   * C3 (pass 31): three knobs the app has always honoured were read straight
   * off `process.env` and declared nowhere, so the validated surface — the one
   * an operator (and `.env.example`) treats as the list of what is
   * configurable — denied they existed. They carry through as raw strings; the
   * call sites keep their own coercion and defaults.
   */
  it("carries the runtime tuning knobs through as raw strings", () => {
    const env = parseEnv({
      ...REQUIRED_ENV,
      VIBERR_GIT_CLONE_TIMEOUT_MS: "1800000",
      VIBERR_TRANSCRIPT_RETENTION_DAYS: "7",
      VIBERR_SESSION_HOME_RETENTION_DAYS: "0",
    });
    expect(env.VIBERR_GIT_CLONE_TIMEOUT_MS).toBe("1800000");
    expect(env.VIBERR_TRANSCRIPT_RETENTION_DAYS).toBe("7");
    // "0" is a real setting (keep forever), not an absent one — so the schema
    // must not coerce, and the empty-string-is-missing rule must not eat it.
    expect(env.VIBERR_SESSION_HOME_RETENTION_DAYS).toBe("0");

    const bare = parseEnv(REQUIRED_ENV);
    expect(bare.VIBERR_GIT_CLONE_TIMEOUT_MS).toBeUndefined();
    expect(bare.VIBERR_TRANSCRIPT_RETENTION_DAYS).toBeUndefined();
    expect(bare.VIBERR_SESSION_HOME_RETENTION_DAYS).toBeUndefined();
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

/**
 * C3 (pass 31) / C01-A6 (pass 32): the schema and `.env.example` are the two
 * places an operator looks for "what can I configure". Twice now a knob shipped
 * that both denied existed — read straight off `process.env` in a module far
 * from here. This gate walks every non-test source file for a raw
 * `process.env.VIBERR_*` read and insists the name is declared in BOTH places.
 * Test-only hooks are the sole allowlist, named here so an addition is a
 * reviewed decision, not a silent one.
 */
describe("no undeclared VIBERR_* env reads (C01-A6)", () => {
  const TEST_ONLY_HOOKS = new Set([
    "VIBERR_CATALOG_PROBE_MARKER",
    "VIBERR_CLAUDE_TEST_MARKER",
    "VIBERR_CODEX_TEST_MARKER",
  ]);

  function rawReads(): Map<string, string[]> {
    const root = join(process.cwd(), "app");
    const found = new Map<string, string[]>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/process\.env\.(VIBERR_[A-Z0-9_]+)/g)) {
          const name = m[1]!;
          const list = found.get(name) ?? [];
          list.push(full.slice(process.cwd().length + 1));
          found.set(name, list);
        }
      }
    };
    walk(root);
    return found;
  }

  it("declares every raw process.env.VIBERR_* read in the schema", async () => {
    const { ENV_KEYS } = await import("./env.server");
    const declared = new Set(ENV_KEYS);
    const undeclared = [...rawReads()]
      .filter(([name]) => !declared.has(name) && !TEST_ONLY_HOOKS.has(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(undeclared).toEqual([]);
  });

  it("documents every raw process.env.VIBERR_* read in .env.example", () => {
    const example = readFileSync(`${process.cwd()}/.env.example`, "utf8");
    // Documented only in the secret-key rotation runbook, on purpose: it is a
    // one-shot migration variable, not a knob to leave in a template.
    const RUNBOOK_ONLY = new Set(["VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS"]);
    const missing = [...rawReads().keys()].filter(
      (name) =>
        !TEST_ONLY_HOOKS.has(name) &&
        !RUNBOOK_ONLY.has(name) &&
        !new RegExp(`^#?${name}=`, "m").test(example),
    );
    expect(missing).toEqual([]);
  });
});
