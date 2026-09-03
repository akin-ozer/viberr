import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CodexClient, CodexFactory } from "./codex-runtime.server";
import type { ClaudeQuery } from "./claude-runtime.server";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { RunSpec } from "./adapter.server";
import {
  CREDENTIAL_ENV_RE,
  createAdapters,
  filteredSpawnEnv,
} from "./runtime-registry.server";
import { runCredentialFor } from "./backend-credentials.server";
import { insertUser } from "~/server/auth/user-store.server";
import { createTestDbContext } from "../../../test-support/test-db";
import { connectFakeBackend } from "../../../test-support/backend-credentials";

/**
 * Guards the hermeticity of the SUITE itself (F10-10): test-support/setup-env.ts
 * must make every real-backend credential unreadable before any app module
 * loads, or an ordinary `npm test` can build a child env carrying a developer's
 * own provider key and bill a real call from `npm test`.
 *
 * The leak is subtle enough to be re-introduced by a "cleanup": env.server.ts
 * calls `loadEnvFile()` at module scope — i.e. AFTER the setup file — and
 * loadEnvFile refills every key that is not already present. Scrubbing with
 * `delete` therefore hands the `.env` value straight back; scrubbing with `""`
 * survives. Importing the registry above already ran that real module-scope
 * loadEnvFile.
 *
 * Ruling 127 changed WHAT is guarded, not why. There is no instance credential
 * to detect any more, so the invariant is stated where it now lives: the base
 * spawn env both adapters are built on must carry nothing credential-shaped,
 * and a run's child env must carry exactly ONE credential — the one belonging
 * to the person that run bills.
 */

/** Mirrors the scrub list in test-support/setup-env.ts. */
const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
] as const;

/**
 * Run `body` with both vendor home variables set on the SERVER's process, then
 * put the environment back exactly as it was (absent stays absent). The whole
 * point of these assertions is what happens when a deployment HAS one.
 */
async function withAmbientHomes<T>(body: () => T | Promise<T>): Promise<T> {
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.CLAUDE_CONFIG_DIR = "/data/runtimes/claude-home";
  process.env.CODEX_HOME = "/data/runtimes/codex-home";
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A Claude SDK query as the adapter consumes it. */
function fakeClaudeQuery(...messages: unknown[]): ClaudeQuery {
  const gen = (async function* (): AsyncGenerator<unknown, void> {
    for (const message of messages) yield message;
  })();
  return Object.assign(gen, { interrupt: async () => {} });
}

describe("test-harness hermeticity", () => {
  it("scrubs every credential to empty rather than deleting it", () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(process.env[key]).toBe("");
    }
  });

  it("the base spawn env both adapters are built on carries no credential", () => {
    // Ruling 127: this is what makes per-person credentials safe. A run's
    // child env is `filteredSpawnEnv()` plus exactly one principal's
    // credential, so anything credential-shaped surviving the filter would be
    // seen by every run, whoever it bills.
    const env = filteredSpawnEnv();
    for (const key of CREDENTIAL_KEYS) {
      expect({ key, value: env[key] }).toEqual({ key, value: undefined });
    }
  });

  it("the base spawn env carries neither vendor HOME", async () => {
    // Ruling 127: `CLAUDE_CONFIG_DIR` / `CODEX_HOME` are not credential-SHAPED,
    // so `CREDENTIAL_ENV_RE` lets both through — but a home is where a vendor
    // binary keeps its credential. An ambient one (a deployment upgrading onto
    // this branch with its old `.env`, which compose still injects) would ride
    // into every child, and one `codex exec` from inside a run billed to Alice
    // would authenticate against whatever sign-in file that directory holds.
    await withAmbientHomes(() => {
      const env = filteredSpawnEnv();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
    });
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
      const env = filteredSpawnEnv();
      for (const key of CREDENTIAL_KEYS) {
        expect({ key, value: env[key] }).toEqual({ key, value: undefined });
      }
    } finally {
      // Restore the harness invariant even if an assertion above blew up.
      for (const key of CREDENTIAL_KEYS) process.env[key] = "";
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Ruling 127, the input-side invariant end to end: the process a run spawns
 * sees the credential of the ONE person that run bills, and no other.
 *
 * Driven through the REAL pieces — a migrated database, the real credential
 * store (sealed with the suite's own encryption key), `runCredentialFor`, and
 * the production `createAdapters` factory with the two provider SDKs faked so
 * nothing bills. What is asserted is the env each SDK was actually handed.
 */
describe("a run's child env carries exactly its principal's credential", () => {
  const ctx = createTestDbContext();
  afterEach(() => ctx.cleanup());

  interface Captured {
    claude: Record<string, string> | undefined;
    codex: Record<string, string> | undefined;
  }

  async function startWithEnv(env: Record<string, string>): Promise<Captured> {
    const captured: Captured = { claude: undefined, codex: undefined };
    const codexFactory: CodexFactory = (options) => {
      captured.codex = options?.env;
      const thread: ReturnType<CodexClient["startThread"]> = {
        id: "thread-principal",
        async runStreamed() {
          const events = (async function* (): AsyncGenerator<ThreadEvent> {
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 1,
                reasoning_output_tokens: 0,
              },
            };
          })();
          return { events };
        },
      };
      return { startThread: () => thread, resumeThread: () => thread };
    };
    const adapters = createAdapters({
      claudeQueryFn: (params) => {
        captured.claude = params.options?.env;
        return fakeClaudeQuery({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 1,
          usage: {},
        });
      },
      codexFactory,
    });
    const spec: RunSpec = {
      runId: "run_principal",
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      role: "Primary specialist",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      prompt: "hello",
      workdir: "/tmp",
      autonomous: true,
      env,
    };
    const sink = { onLine: () => {}, onExit: () => {} };
    adapters.claude.start(spec, sink);
    adapters.codex.start({ ...spec, backend: "codex" }, sink);
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    return captured;
  }

  it("carries the principal's key and its home, and nothing else credential-shaped", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    insertUser(db, {
      id: "u_owner",
      email: "owner@viberr.test",
      name: "Owner",
      role: "member",
    });
    await connectFakeBackend(db, "u_owner", "claude");

    const credential = runCredentialFor(db, "u_owner", "claude", dataRoot);
    // What `startRun` assembles: the credential env is the base, a caller
    // overlay (workspace confinement) goes on top.
    const captured = await startWithEnv({
      ...credential.env,
      GIT_CEILING_DIRECTORIES: "/data/projects/viberr-core/tasks/VIB-1",
    });

    const child = captured.claude;
    expect(child).toBeTruthy();
    // The principal's own key, and their own home — nobody else's.
    expect(child?.ANTHROPIC_API_KEY).toBe(credential.secrets[0]);
    expect(child?.CLAUDE_CONFIG_DIR).toBe(credential.homeDir);
    expect(child?.CLAUDE_CONFIG_DIR).toContain(path.join("users", "u_owner"));
    // Ordinary runtime settings survive; the workspace overlay lands.
    expect(child?.PATH).toBeTruthy();
    expect(child?.GIT_CEILING_DIRECTORIES).toBe(
      "/data/projects/viberr-core/tasks/VIB-1",
    );
    // EXACTLY one credential-shaped variable reaches the child.
    const credentialKeys = Object.keys(child ?? {}).filter((key) =>
      CREDENTIAL_ENV_RE.test(key),
    );
    expect(credentialKeys).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("an ambient vendor home on the SERVER never reaches a run's child", async () => {
    // The cross-vendor half of the same trap. `CODEX_HOME` is not
    // credential-shaped, so it used to survive `filteredSpawnEnv()` untouched
    // while `runCredentialFor` set only the principal's own vendor variable: a
    // Claude run billed to this person spawned carrying a leftover shared
    // codex home, and one `codex exec` from inside it would have billed
    // whatever account that directory's `auth.json` names.
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    insertUser(db, {
      id: "u_ambient",
      email: "ambient@viberr.test",
      name: "Ambient",
      role: "member",
    });
    await connectFakeBackend(db, "u_ambient", "claude");
    await connectFakeBackend(db, "u_ambient", "codex");

    const claudeCredential = runCredentialFor(db, "u_ambient", "claude", dataRoot);
    const claudeRun = await withAmbientHomes(() =>
      startWithEnv(claudeCredential.env),
    );
    expect(claudeRun.claude?.CLAUDE_CONFIG_DIR).toBe(claudeCredential.homeDir);
    expect(claudeRun.claude?.CODEX_HOME).toBeUndefined();

    const codexCredential = runCredentialFor(db, "u_ambient", "codex", dataRoot);
    const codexRun = await withAmbientHomes(() =>
      startWithEnv(codexCredential.env),
    );
    expect(codexRun.codex?.CODEX_HOME).toBe(codexCredential.homeDir);
    expect(codexRun.codex?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("a codex Platform key never rides beside OPENAI_API_KEY", async () => {
    // The billing trap ruling 127 closes by construction: a person's pasted
    // Platform key arrives as CODEX_API_KEY, and OPENAI_API_KEY — which the
    // CLI would prefer, on a different account — is stripped by the filter and
    // never re-added.
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    insertUser(db, {
      id: "u_codex",
      email: "codex@viberr.test",
      name: "Codex Owner",
      role: "member",
    });
    await connectFakeBackend(db, "u_codex", "codex");
    const credential = runCredentialFor(db, "u_codex", "codex", dataRoot);
    const captured = await startWithEnv(credential.env);

    const child = captured.codex;
    expect(child?.CODEX_API_KEY).toBe(credential.secrets[0]);
    expect(child?.CODEX_HOME).toBe(credential.homeDir);
    expect(child?.OPENAI_API_KEY).toBeUndefined();
    expect(child?.CODEX_ACCESS_TOKEN).toBeUndefined();
    const credentialKeys = Object.keys(child ?? {}).filter((key) =>
      CREDENTIAL_ENV_RE.test(key),
    );
    expect(credentialKeys).toEqual(["CODEX_API_KEY"]);
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
  /** Only the two declaration maps this scan reads; the rest of package.json is
   *  none of its business. */
  const packageManifest = z.object({
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  });

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
    const manifest = packageManifest.parse(
      JSON.parse(readFileSync("package.json", "utf8")),
    );
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
