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
   * Ruling 127: agent backends authenticate PER PERSON. The nine
   * deployment-wide credential variables are gone from the schema, and this
   * gate is what stops one creeping back in — a declared key would be an
   * instance credential every run could bill to whoever owns it, which is the
   * whole thing the ruling forbids. An ambient value must be ignored, not
   * carried through.
   */
  it("declares no deployment-wide agent-backend credential (ruling 127)", () => {
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

});

/**
 * C3 (pass 31) declared the runtime tuning knobs, which the app has always
 * honoured, so the validated surface stopped denying they existed. Ruling
 * 458(j): the schema also parses them, as 458(c) does for the C01-A6 knobs, so
 * a value their call sites used to replace with the default in silence fails
 * boot instead.
 */
describe("the runtime tuning knobs (ruling 458(j))", () => {
  it("applies the documented defaults when unset or empty", () => {
    const keys = [
      "VIBERR_CLAUDE_MAX_TURNS",
      "VIBERR_CLAUDE_IDLE_TIMEOUT_MS",
      "VIBERR_CODEX_IDLE_TIMEOUT_MS",
      "VIBERR_GIT_CLONE_TIMEOUT_MS",
      "VIBERR_TRANSCRIPT_RETENTION_DAYS",
      "VIBERR_SESSION_HOME_RETENTION_DAYS",
    ];
    for (const env of [
      parseEnv(REQUIRED_ENV),
      parseEnv({
        ...REQUIRED_ENV,
        ...Object.fromEntries(keys.map((key) => [key, ""])),
      }),
    ]) {
      expect(env.VIBERR_CLAUDE_MAX_TURNS).toBe(2000);
      expect(env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
      expect(env.VIBERR_CODEX_IDLE_TIMEOUT_MS).toBe(15 * 60_000);
      expect(env.VIBERR_GIT_CLONE_TIMEOUT_MS).toBe(15 * 60_000);
      expect(env.VIBERR_TRANSCRIPT_RETENTION_DAYS).toBe(30);
      expect(env.VIBERR_SESSION_HOME_RETENTION_DAYS).toBe(30);
    }
  });

  it("coerces a set value the way the call sites did", () => {
    const env = parseEnv({
      ...REQUIRED_ENV,
      VIBERR_CLAUDE_MAX_TURNS: "500.9",
      VIBERR_CLAUDE_IDLE_TIMEOUT_MS: "10",
      VIBERR_CODEX_IDLE_TIMEOUT_MS: " 1e3 ",
      VIBERR_GIT_CLONE_TIMEOUT_MS: "1800000",
      VIBERR_TRANSCRIPT_RETENTION_DAYS: "7",
      VIBERR_SESSION_HOME_RETENTION_DAYS: "0",
    });
    // Rounded down, as `resolveMaxTurns` did.
    expect(env.VIBERR_CLAUDE_MAX_TURNS).toBe(500);
    expect(env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS).toBe(10);
    expect(env.VIBERR_CODEX_IDLE_TIMEOUT_MS).toBe(1_000);
    expect(env.VIBERR_GIT_CLONE_TIMEOUT_MS).toBe(1_800_000);
    expect(env.VIBERR_TRANSCRIPT_RETENTION_DAYS).toBe(7);
    // "0" is a real setting (keep forever), not an absent one: the
    // empty-string-is-missing rule must not eat it, and it must not fail.
    expect(env.VIBERR_SESSION_HOME_RETENTION_DAYS).toBe(0);
  });

  it("fails boot on a value the call sites used to replace with the default", () => {
    const refused: [string, string[], string][] = [
      // 0.5 used to round down to a cap of 0 turns.
      ["VIBERR_CLAUDE_MAX_TURNS", ["many", "0", "-1", "0.5", "Infinity"], "must be a number of turns, 1 or more"],
      ["VIBERR_CLAUDE_IDLE_TIMEOUT_MS", ["soon", "0", "-5", "Infinity"], "must be a positive number of ms"],
      ["VIBERR_CODEX_IDLE_TIMEOUT_MS", ["soon", "0", "-5", "Infinity"], "must be a positive number of ms"],
      ["VIBERR_GIT_CLONE_TIMEOUT_MS", ["soon", "0", "-5", "900000abc"], "must be a positive number of ms"],
      ["VIBERR_TRANSCRIPT_RETENTION_DAYS", ["forever", "-1", "Infinity"], "must be a number of days, 0 or more"],
      ["VIBERR_SESSION_HOME_RETENTION_DAYS", ["forever", "-1", "Infinity"], "must be a number of days, 0 or more"],
    ];
    for (const [key, values, message] of refused) {
      for (const value of values) {
        expect(
          () => parseEnv({ ...REQUIRED_ENV, [key]: value }),
          `${key}=${value}`,
        ).toThrowError(
          new RegExp(`^Invalid environment configuration:[\\s\\S]*${key}: ${message}`),
        );
      }
    }
  });
});

/**
 * Ruling 458(c): the C01-A6 knobs are the schema's to parse. Their modules used
 * to read `process.env` and run the default for a value that did not parse, so
 * a mistyped threshold or interval was silently ignored. The schema now applies
 * the same `Number()` coercion and the same defaults, and a value outside what
 * the modules accepted fails boot with the rest of the invalid variables.
 * Ruling 458(i): the two periods are set in seconds, at most a day, and the
 * `_MS` names they replace are refused with the new name.
 */
describe("the C01-A6 knobs (rulings 458(c) and 458(i))", () => {
  const PERIODS = [
    "VIBERR_MAINTENANCE_INTERVAL_SECONDS",
    "VIBERR_DISK_CHECK_INTERVAL_SECONDS",
  ] as const;
  const THRESHOLDS = [
    "VIBERR_DISK_LOW_FREE_MB",
    "VIBERR_DISK_CRITICAL_FREE_MB",
  ] as const;

  it("applies the documented defaults when unset or empty", () => {
    for (const env of [
      parseEnv(REQUIRED_ENV),
      parseEnv({
        ...REQUIRED_ENV,
        ...Object.fromEntries(
          [...PERIODS, ...THRESHOLDS, "VIBERR_GITHUB_WRITE_PROBE"].map((key) => [
            key,
            "",
          ]),
        ),
      }),
    ]) {
      expect(env.VIBERR_MAINTENANCE_INTERVAL_SECONDS).toBe(21_600);
      expect(env.VIBERR_DISK_CHECK_INTERVAL_SECONDS).toBe(300);
      expect(env.VIBERR_DISK_LOW_FREE_MB).toBe(2048);
      expect(env.VIBERR_DISK_CRITICAL_FREE_MB).toBe(512);
      expect(env.VIBERR_GITHUB_WRITE_PROBE).toBe(false);
    }
  });

  it("coerces a positive number the way the modules did", () => {
    const env = parseEnv({
      ...REQUIRED_ENV,
      VIBERR_MAINTENANCE_INTERVAL_SECONDS: "60",
      VIBERR_DISK_CHECK_INTERVAL_SECONDS: " 1e1 ",
      VIBERR_DISK_LOW_FREE_MB: "10",
      VIBERR_DISK_CRITICAL_FREE_MB: "1.5",
    });
    expect(env.VIBERR_MAINTENANCE_INTERVAL_SECONDS).toBe(60);
    expect(env.VIBERR_DISK_CHECK_INTERVAL_SECONDS).toBe(10);
    expect(env.VIBERR_DISK_LOW_FREE_MB).toBe(10);
    expect(env.VIBERR_DISK_CRITICAL_FREE_MB).toBe(1.5);
  });

  it("takes a period of exactly a day and refuses a longer one", () => {
    for (const key of PERIODS) {
      expect(parseEnv({ ...REQUIRED_ENV, [key]: "86400" })[key]).toBe(86_400);
      expect(() => parseEnv({ ...REQUIRED_ENV, [key]: "86401" })).toThrowError(
        new RegExp(
          `${key}: must be a number of seconds above 0 and at most 86400 \\(24 hours\\)`,
        ),
      );
    }
  });

  it("fails boot on a value the modules used to replace with the default", () => {
    const refused: [readonly string[], string][] = [
      [PERIODS, "must be a number of seconds above 0"],
      [THRESHOLDS, "must be a positive number of"],
    ];
    for (const [keys, message] of refused) {
      for (const key of keys) {
        for (const value of ["not-a-number", "0", "-5", "Infinity"]) {
          expect(
            () => parseEnv({ ...REQUIRED_ENV, [key]: value }),
            `${key}=${value}`,
          ).toThrowError(
            new RegExp(
              `^Invalid environment configuration:[\\s\\S]*${key}: ${message}`,
            ),
          );
        }
      }
    }
  });

  it("refuses the retired _MS period names, naming the replacement", () => {
    for (const [retired, replacement] of [
      ["VIBERR_MAINTENANCE_INTERVAL_MS", "VIBERR_MAINTENANCE_INTERVAL_SECONDS"],
      ["VIBERR_DISK_CHECK_INTERVAL_MS", "VIBERR_DISK_CHECK_INTERVAL_SECONDS"],
    ] as const) {
      // Even a value the old name would have taken: the app no longer reads it.
      expect(() => parseEnv({ ...REQUIRED_ENV, [retired]: "60000" })).toThrowError(
        new RegExp(
          `^Invalid environment configuration:[\\s\\S]*${retired}: retired; set ${replacement} instead`,
        ),
      );
    }
    // Listed with the schema's own problems, not instead of them.
    expect(() =>
      parseEnv({
        ...REQUIRED_ENV,
        PORT: "not-a-port",
        VIBERR_MAINTENANCE_INTERVAL_MS: "60000",
      }),
    ).toThrowError(/PORT[\s\S]*VIBERR_MAINTENANCE_INTERVAL_MS: retired/);
  });

  it("reads the write probe's spellings: 1/true/yes on, 0/false/no off", () => {
    const probe = (value: string) =>
      parseEnv({ ...REQUIRED_ENV, VIBERR_GITHUB_WRITE_PROBE: value })
        .VIBERR_GITHUB_WRITE_PROBE;
    for (const on of ["1", "true", "yes"]) expect(probe(on)).toBe(true);
    for (const off of ["0", "false", "no"]) expect(probe(off)).toBe(false);
  });

  it("fails boot on a write-probe spelling it does not know", () => {
    // `TRUE` and `on` used to read as OFF without a word; now the operator hears.
    for (const value of ["TRUE", "on", "enabled"]) {
      expect(() =>
        parseEnv({ ...REQUIRED_ENV, VIBERR_GITHUB_WRITE_PROBE: value }),
      ).toThrowError(/VIBERR_GITHUB_WRITE_PROBE: must be 1, true or yes/);
    }
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

  // Ruling 458(c) moved the five C01-A6 knobs off raw reads and onto
  // `getEnv()`, so the declared keys are held to `.env.example` too: a knob the
  // schema parses must stay documented once no raw read names it any more.
  it("documents every declared key and every raw process.env.VIBERR_* read in .env.example", () => {
    const example = readFileSync(`${process.cwd()}/.env.example`, "utf8");
    // Documented only in the secret-key rotation runbook, on purpose: it is a
    // one-shot migration variable, not a knob to leave in a template.
    const RUNBOOK_ONLY = new Set(["VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS"]);
    const missing = [...new Set([...ENV_KEYS, ...rawReads().keys()])].filter(
      (name) =>
        !TEST_ONLY_HOOKS.has(name) &&
        !RUNBOOK_ONLY.has(name) &&
        !new RegExp(`^#?${name}=`, "m").test(example),
    );
    expect(missing).toEqual([]);
  });
});
