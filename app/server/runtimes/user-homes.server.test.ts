import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { isAppError } from "~/server/errors/app-error.server";
import {
  assertPathSafeUserId,
  claudeLoginCredentialPath,
  codexLoginCredentialPath,
  codexRunHomeDir,
  CODEX_HOME_SHARED_DIRS,
  ensureUserBackendHome,
  finishCodexRunHome,
  listUserRuntimeRoots,
  prepareCodexRunHome,
  USER_RUNTIMES_DIR,
  userBackendHome,
  userRuntimeRoot,
} from "./user-homes.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Ruling 127: one resolver for the per-person runtime homes. The failure this
 * guards against is the shared-home era's — two resolvers disagreeing, so the
 * credential the run reads and the transcript the exporter looks for live in
 * different directories.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("path resolution", () => {
  it("puts each person's backend homes under runtimes/users/<id>", () => {
    const root = ctx.makeTempDir();
    expect(userRuntimeRoot("u_arda", root)).toBe(
      path.join(root, "runtimes", USER_RUNTIMES_DIR, "u_arda"),
    );
    expect(userBackendHome("u_arda", "claude", root)).toBe(
      path.join(root, "runtimes", "users", "u_arda", "claude-home"),
    );
    expect(userBackendHome("u_arda", "codex", root)).toBe(
      path.join(root, "runtimes", "users", "u_arda", "codex-home"),
    );
    // Two people never share a home — the whole point of the ruling.
    expect(userBackendHome("u_arda", "claude", root)).not.toBe(
      userBackendHome("u_murat", "claude", root),
    );
  });

  it("names the vendor-owned credential files inside a home", () => {
    const root = ctx.makeTempDir();
    const claude = userBackendHome("u_arda", "claude", root);
    const codex = userBackendHome("u_arda", "codex", root);
    expect(claudeLoginCredentialPath(claude)).toBe(
      path.join(claude, ".credentials.json"),
    );
    expect(codexLoginCredentialPath(codex)).toBe(path.join(codex, "auth.json"));
  });
});

describe("assertPathSafeUserId", () => {
  it("accepts the ids Viberr actually mints", () => {
    const id = newId("u");
    expect(assertPathSafeUserId(id)).toBe(id);
    expect(assertPathSafeUserId("u_arda1")).toBe("u_arda1");
  });

  it.each([
    ["empty", ""],
    ["traversal", ".."],
    ["a path", "u_arda/../../etc"],
    ["a separator", "u/arda"],
    ["percent-encoded traversal", "u_arda%2e%2e"],
    ["too long", "u".repeat(65)],
    ["a space", "u arda"],
  ])("refuses %s", (_name, userId) => {
    const thrown = (() => {
      try {
        assertPathSafeUserId(userId);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(isAppError(thrown)).toBe(true);
    // Never echoes the offending value into a message a UI may render.
    if (isAppError(thrown) && userId) {
      expect(thrown.userMessage).not.toContain(userId);
    }
  });

  it("refuses to derive a path from an unsafe id", () => {
    const root = ctx.makeTempDir();
    expect(() => userBackendHome("../../etc", "claude", root)).toThrow();
    expect(() => userRuntimeRoot("u_arda/..", root)).toThrow();
  });
});

describe("ensureUserBackendHome", () => {
  it("creates the home private to the server user, and is idempotent", () => {
    const root = ctx.makeTempDir();
    const home = ensureUserBackendHome("u_arda", "codex", root);
    expect(home).toBe(userBackendHome("u_arda", "codex", root));
    // 0o700: a login credential file lands in here, so no other account on the
    // host may read one person's sign-in.
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // The parent chain is created too, and a second call is a no-op.
    expect(ensureUserBackendHome("u_arda", "codex", root)).toBe(home);
    expect(statSync(userRuntimeRoot("u_arda", root)).isDirectory()).toBe(true);
  });
});

describe("listUserRuntimeRoots", () => {
  it("is empty before anyone has connected anything", () => {
    expect(listUserRuntimeRoots(ctx.makeTempDir())).toEqual([]);
  });

  it("lists one entry per person, skipping what it did not create", () => {
    const root = ctx.makeTempDir();
    ensureUserBackendHome("u_arda", "claude", root);
    ensureUserBackendHome("u_murat", "codex", root);
    const usersDir = path.join(root, "runtimes", USER_RUNTIMES_DIR);
    // A stray file and a directory whose name is not a usable id: a sweep that
    // walked these would be deleting inside something Viberr never wrote.
    writeFileSync(path.join(usersDir, "README.txt"), "not a home");
    mkdirSync(path.join(usersDir, "not a user id"), { recursive: true });

    const roots = listUserRuntimeRoots(root);
    expect(roots.map((entry) => entry.userId).sort()).toEqual([
      "u_arda",
      "u_murat",
    ]);
    expect(roots.find((entry) => entry.userId === "u_arda")?.root).toBe(
      userRuntimeRoot("u_arda", root),
    );
  });
});

describe("per-run Codex homes (ruling 181)", () => {
  function sharedCodexHome(): string {
    return ensureUserBackendHome("u_arda", "codex", ctx.makeTempDir());
  }

  it("gives two runs of one person private homes that never share the CLI's helper directory", () => {
    // F36-3: the Codex CLI keeps ONE exec-helper directory per CODEX_HOME
    // (`tmp/arg0/codex-arg0XXXXXX/`, holding codex-linux-sandbox and friends)
    // and every new process of the same home replaces it, so concurrent
    // sandboxed runs of one person deleted each other's helper mid-run.
    // Canary: point both runs at the shared home and `tmp/` is one directory.
    const shared = sharedCodexHome();
    const a = prepareCodexRunHome(shared, "run_a");
    const b = prepareCodexRunHome(shared, "run_b");
    expect(a.dir).toBe(path.join(shared, "runs", "run_a"));
    expect(b.dir).toBe(path.join(shared, "runs", "run_b"));
    expect(a.sharedHome).toBe(shared);
    // The CLI creates `tmp/` inside whatever CODEX_HOME it is handed: a helper
    // extracted by run A is invisible to run B and to the shared home.
    mkdirSync(path.join(a.dir, "tmp", "arg0", "codex-arg0AAAAAA"), { recursive: true });
    expect(existsSync(path.join(b.dir, "tmp"))).toBe(false);
    expect(existsSync(path.join(shared, "tmp"))).toBe(false);
    expect(lstatSync(a.dir).isSymbolicLink()).toBe(false);
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
  });

  it("seeds the run home with COPIES of auth.json and config.toml and LINKS the shared state dirs", () => {
    const shared = sharedCodexHome();
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"before"}', { mode: 0o600 });
    writeFileSync(path.join(shared, "config.toml"), 'model = "x"\n');
    const home = prepareCodexRunHome(shared, "run_seed");
    // Copies, not links: the CLI's token refresh lands in the run home and is
    // carried back deliberately (below), never written into the shared file
    // by two runs at once.
    expect(readFileSync(path.join(home.dir, "auth.json"), "utf8")).toBe('{"tokens":"before"}');
    expect(lstatSync(path.join(home.dir, "auth.json")).isSymbolicLink()).toBe(false);
    expect(statSync(path.join(home.dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(home.dir, "config.toml"), "utf8")).toBe('model = "x"\n');
    // Links, so a rollout the CLI writes through `sessions/` is the shared
    // home's — where `probeSessionContinuity` and the exporter look.
    expect([...CODEX_HOME_SHARED_DIRS]).toEqual(["sessions", "skills", "memories"]);
    for (const name of CODEX_HOME_SHARED_DIRS) {
      const link = path.join(home.dir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(path.join(shared, name)));
    }
    const day = path.join("sessions", "2026", "09", "11");
    mkdirSync(path.join(home.dir, day), { recursive: true });
    writeFileSync(path.join(home.dir, day, "rollout-x.jsonl"), "{}\n");
    expect(existsSync(path.join(shared, day, "rollout-x.jsonl"))).toBe(true);
  });

  it("a home with no sign-in file yet seeds nothing and still links the shared dirs", () => {
    const shared = sharedCodexHome();
    const home = prepareCodexRunHome(shared, "run_bare");
    expect(existsSync(path.join(home.dir, "auth.json"))).toBe(false);
    expect(existsSync(path.join(home.dir, "config.toml"))).toBe(false);
    expect(lstatSync(path.join(home.dir, "sessions")).isSymbolicLink()).toBe(true);
  });

  it("copies auth.json back only when the run changed it, and deletes the run home either way", () => {
    const shared = sharedCodexHome();
    const sharedAuth = path.join(shared, "auth.json");
    writeFileSync(sharedAuth, '{"tokens":"before"}', { mode: 0o600 });
    // An old mtime: a rewrite of identical bytes would bump it.
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(sharedAuth, old, old);

    const unchanged = prepareCodexRunHome(shared, "run_same");
    finishCodexRunHome(unchanged);
    expect(existsSync(unchanged.dir)).toBe(false);
    expect(statSync(sharedAuth).mtimeMs).toBe(old.getTime());
    expect(readFileSync(sharedAuth, "utf8")).toBe('{"tokens":"before"}');

    const refreshed = prepareCodexRunHome(shared, "run_refresh");
    // The CLI refreshed the token inside the run home.
    writeFileSync(path.join(refreshed.dir, "auth.json"), '{"tokens":"after"}');
    finishCodexRunHome(refreshed);
    expect(existsSync(refreshed.dir)).toBe(false);
    expect(readFileSync(sharedAuth, "utf8")).toBe('{"tokens":"after"}');
    expect(statSync(sharedAuth).mode & 0o777).toBe(0o600);
    // Removing the run home unlinks the links; it never reaches through them.
    expect(existsSync(path.join(shared, "sessions"))).toBe(true);
    expect(existsSync(path.join(shared, "runs"))).toBe(true);
  });

  it("does not resurrect a sign-in the person removed while the run was live", () => {
    const shared = sharedCodexHome();
    const sharedAuth = path.join(shared, "auth.json");
    writeFileSync(sharedAuth, '{"tokens":"before"}');
    const home = prepareCodexRunHome(shared, "run_disc");
    // Disconnect on Profile → Agent accounts deletes the shared file mid-run.
    rmSync(sharedAuth);
    writeFileSync(path.join(home.dir, "auth.json"), '{"tokens":"refreshed"}');
    finishCodexRunHome(home);
    expect(existsSync(sharedAuth)).toBe(false);
    expect(existsSync(home.dir)).toBe(false);
  });

  it("replaces a leftover run home of the same id and tolerates a second finish", () => {
    const shared = sharedCodexHome();
    const stale = prepareCodexRunHome(shared, "run_again");
    writeFileSync(path.join(stale.dir, "leftover.txt"), "from a crashed process");
    const fresh = prepareCodexRunHome(shared, "run_again");
    expect(existsSync(path.join(fresh.dir, "leftover.txt"))).toBe(false);
    finishCodexRunHome(fresh);
    expect(() => finishCodexRunHome(fresh)).not.toThrow();
  });

  it("refuses a run id that is not a path segment", () => {
    const shared = sharedCodexHome();
    expect(() => codexRunHomeDir(shared, "../escape")).toThrow();
    expect(() => prepareCodexRunHome(shared, "")).toThrow();
    expect(codexRunHomeDir(shared, "run_ok-1")).toBe(path.join(shared, "runs", "run_ok-1"));
  });
});
