import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { beforeEach, describe, expect, it } from "vitest";
import {
  isBackendAvailable,
  resetRegistryForTests,
} from "./runtime-registry.server";

/**
 * Guards the hermeticity of the SUITE itself (F10-10): test-support/setup-env.ts
 * must make every real-backend credential unreadable before any app module
 * loads, or an ordinary `npm test` can construct a real adapter and bill a
 * provider call from a developer's `.env`.
 *
 * The leak is subtle enough to be re-introduced by a "cleanup": env.server.ts
 * calls `loadEnvFile()` at module scope — i.e. AFTER the setup file — and
 * loadEnvFile refills every key that is not already present. Scrubbing with
 * `delete` therefore hands the `.env` value straight back; scrubbing with `""`
 * (present, but read as absent by hasCredential/parseEnv) survives. Importing
 * the registry above already ran that real module-scope loadEnvFile.
 */

/** Mirrors the scrub list in test-support/setup-env.ts. */
const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "VIBERR_CLAUDE_USE_CLI_AUTH",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "VIBERR_CODEX_USE_CLI_AUTH",
] as const;

describe("test-harness hermeticity", () => {
  // No explicit setBackendAvailability override in play: these tests assert the
  // DETECTION result, which is what an unsuspecting test would hit.
  beforeEach(() => {
    resetRegistryForTests();
  });

  it("scrubs every credential to empty rather than deleting it", () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(process.env[key]).toBe("");
    }
  });

  it("reports both backends unavailable with no override set", () => {
    expect(isBackendAvailable("claude")).toBe(false);
    expect(isBackendAvailable("codex")).toBe(false);
  });

  it("points CODEX_HOME at a real directory that holds no auth.json", () => {
    // P13-D-2: CODEX_HOME used to be blanked with the credentials above. The
    // continuity probe needs a real transcript store to answer
    // present/missing/unknown deterministically, so the harness now pins it to
    // an empty temp dir instead. That keeps `codexCliAuthUsable()` false for the
    // reason that actually matters — no auth.json — rather than by erasing the
    // path, which is the stronger invariant to assert.
    const home = process.env.CODEX_HOME;
    expect(home).toBeTruthy();
    expect(existsSync(home!)).toBe(true);
    expect(existsSync(path.join(home!, "auth.json"))).toBe(false);
  });

  it("a .env credential cannot be reloaded into the process", () => {
    // Reproduces the module-scope `loadEnvFile()` in env.server.ts against a
    // .env that DOES carry every credential, so the assertion holds identically
    // on a developer machine and on a fresh CI clone with no .env at all.
    const dir = mkdtempSync(path.join(tmpdir(), "viberr-env-leak-"));
    try {
      const envFile = path.join(dir, ".env");
      writeFileSync(
        envFile,
        `${CREDENTIAL_KEYS.map((key) => `${key}=leaked-from-dot-env`).join("\n")}\n`,
      );
      loadEnvFile(envFile);
      for (const key of CREDENTIAL_KEYS) {
        expect(process.env[key]).toBe("");
      }
      expect(isBackendAvailable("claude")).toBe(false);
      expect(isBackendAvailable("codex")).toBe(false);
    } finally {
      // Restore the harness invariant even if an assertion above blew up.
      for (const key of CREDENTIAL_KEYS) process.env[key] = "";
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
