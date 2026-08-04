import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * C6/pass-16 — PHANTOM DEPENDENCIES.
 *
 * `@lexical/utils` was imported by the comment composer and absent from
 * package.json: it resolved only because npm hoisted it as a transitive
 * dependency of `@lexical/react`. That works until the transitive graph
 * changes, and then the build breaks with an error that points at a file
 * nobody edited. This guard lives beside the harness-hermeticity checks because
 * it is the same category — an invariant about the REPOSITORY, not a feature.
 */
describe("dependency hygiene: every imported package is declared (C6)", () => {
  /** Statement-position module specifiers only — never a quoted string that
   *  happens to sit in prose or a comment. */
  const IMPORT_RE =
    /^\s*(?:import\b[^\n]*?\bfrom|}\s*from|export\b[^\n]*?\bfrom|import)\s+["']([^"']+)["']\s*;?\s*$|\bimport\(\s*["']([^"']+)["']\s*\)/;

  /** The package name a specifier resolves to ("@scope/pkg" or "pkg"), or null
   *  for anything relative / aliased / a node builtin. */
  function packageOf(specifier: string): string | null {
    if (
      specifier.startsWith(".") ||
      specifier.startsWith("~") ||
      specifier.startsWith("/") ||
      specifier.startsWith("node:")
    ) {
      return null;
    }
    const parts = specifier.split("/");
    return specifier.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : (parts[0] ?? null);
  }

  function collectImports(dir: string, out: Map<string, string>): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectImports(full, out);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      for (const line of readFileSync(full, "utf8").split("\n")) {
        const match = line.match(IMPORT_RE);
        const specifier = match?.[1] ?? match?.[2];
        if (!specifier) continue;
        const pkg = packageOf(specifier);
        if (pkg && !out.has(pkg)) out.set(pkg, full);
      }
    }
  }

  it("no app import resolves only through npm hoisting", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    const imported = new Map<string, string>();
    collectImports("app", imported);
    // Sanity: the scan actually found imports (a broken regex must not pass).
    expect(imported.size).toBeGreaterThan(10);

    const phantom = [...imported]
      .filter(([pkg]) => !declared.has(pkg))
      .map(([pkg, file]) => `${pkg} (first seen in ${file})`);
    expect(phantom).toEqual([]);
  });
});
