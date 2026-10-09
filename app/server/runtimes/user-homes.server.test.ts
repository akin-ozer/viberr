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
import { DatabaseSync } from "node:sqlite";
import { logger } from "~/server/logging/logger.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { isAppError } from "~/server/errors/app-error.server";
import {
  backendAccountHome,
  claudeLoginCredentialPath,
  codexCompactionHomeId,
  codexLoginCredentialPath,
  codexRunHomeDir,
  ensureBackendAccountHome,
  ensureUserBackendHome,
  finishCodexRunHome,
  listUserRuntimeRoots,
  prepareCodexRunHome,
  repairCodexRolloutPaths,
  userBackendHome,
  userRuntimeRoot,
} from "./user-homes.server";
import { newId } from "~/shared/ids/new-id.server";

/**
 * Ruling 137: one resolver for the per-person runtime homes. The failure this
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
      path.join(root, "runtimes", "users", "u_arda"),
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

describe("a user id is refused unless it is a path segment", () => {
  it("accepts the ids Viberr actually mints", () => {
    const root = ctx.makeTempDir();
    const id = newId("u");
    expect(path.basename(userRuntimeRoot(id, root))).toBe(id);
    expect(path.basename(userRuntimeRoot("u_arda1", root))).toBe("u_arda1");
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
    const root = ctx.makeTempDir();
    const thrown = (() => {
      try {
        userRuntimeRoot(userId, root);
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
    const usersDir = path.join(root, "runtimes", "users");
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

/**
 * Ruling 138: every account connected since the ruling keeps its vendor
 * sign-in in a home of its own inside the backend home, so switching accounts
 * moves no file; what must stay one per person is shared by link.
 */
describe("per-account homes (ruling 138)", () => {
  it("puts an account's home under the backend home, and a legacy account's IN it", () => {
    const root = ctx.makeTempDir();
    const backendHome = userBackendHome("u_arda", "claude", root);
    expect(backendAccountHome("u_arda", "claude", { id: "ubc_work", legacyHome: false }, root)).toBe(
      path.join(backendHome, "accounts", "ubc_work"),
    );
    expect(backendAccountHome("u_arda", "claude", { id: "ubc_old", legacyHome: true }, root)).toBe(
      backendHome,
    );
    // Two accounts of one person never share a sign-in file.
    expect(backendAccountHome("u_arda", "codex", { id: "ubc_a", legacyHome: false }, root)).not.toBe(
      backendAccountHome("u_arda", "codex", { id: "ubc_b", legacyHome: false }, root),
    );
  });

  it("refuses an account id that is not a path segment", () => {
    const root = ctx.makeTempDir();
    const refused = (id: string): boolean => {
      try {
        backendAccountHome("u_arda", "claude", { id, legacyHome: false }, root);
        return false;
      } catch (error) {
        return isAppError(error);
      }
    };
    for (const id of ["../escape", "", "a/b", "x".repeat(65)]) {
      expect(refused(id), id).toBe(true);
    }
  });

  it("links a Claude account's transcripts to the backend home's, and names what the launch must own", () => {
    const root = ctx.makeTempDir();
    const backendHome = userBackendHome("u_arda", "claude", root);
    const ensured = ensureBackendAccountHome("u_arda", "claude", { id: "ubc_work", legacyHome: false }, root);
    const link = path.join(ensured.home, "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(path.join(backendHome, "projects")));
    expect(statSync(ensured.home).mode & 0o777).toBe(0o700);
    expect(ensured.ownDirs).toEqual([ensured.home, path.join(backendHome, "projects")]);
    // A transcript the CLI writes through the link is the backend home's —
    // where resume, the exporter and the retention sweep look.
    mkdirSync(path.join(link, "-tmp-work"), { recursive: true });
    writeFileSync(path.join(link, "-tmp-work", "sess.jsonl"), "{}\n");
    expect(existsSync(path.join(backendHome, "projects", "-tmp-work", "sess.jsonl"))).toBe(true);
    // Idempotent: the link is made once and left alone after.
    expect(ensureBackendAccountHome("u_arda", "claude", { id: "ubc_work", legacyHome: false }, root)).toEqual(
      ensured,
    );
  });

  it("gives a Codex account a bare home: its runs fork from the backend home and only take its sign-in", () => {
    const root = ctx.makeTempDir();
    const ensured = ensureBackendAccountHome("u_arda", "codex", { id: "ubc_chatgpt", legacyHome: false }, root);
    expect(ensured.ownDirs).toEqual([ensured.home]);
    expect(existsSync(path.join(ensured.home, "sessions"))).toBe(false);
  });

  it("changes nothing for a legacy account: its home is the backend home", () => {
    const root = ctx.makeTempDir();
    const ensured = ensureBackendAccountHome("u_arda", "claude", { id: "ubc_old", legacyHome: true }, root);
    expect(ensured).toEqual({ home: userBackendHome("u_arda", "claude", root), ownDirs: [] });
    expect(existsSync(path.join(ensured.home, "accounts"))).toBe(false);
  });

  it("leaves a real directory where a link belongs alone, and says so", () => {
    const root = ctx.makeTempDir();
    const home = backendAccountHome("u_arda", "claude", { id: "ubc_odd", legacyHome: false }, root);
    mkdirSync(path.join(home, "projects", "-kept"), { recursive: true });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      ensureBackendAccountHome("u_arda", "claude", { id: "ubc_odd", legacyHome: false }, root);
      expect(lstatSync(path.join(home, "projects")).isSymbolicLink()).toBe(false);
      expect(existsSync(path.join(home, "projects", "-kept"))).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        "an account home holds its own copy of a directory it should share",
        expect.objectContaining({ accountId: "ubc_odd", name: "projects" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("per-run Codex homes (ruling 145)", () => {
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
    for (const name of ["sessions", "skills", "memories"]) {
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
    // Ruling 145: the compaction's own fork has a path-safe id beside the run's.
    expect(codexRunHomeDir(shared, codexCompactionHomeId("run_ok-1"))).toBe(
      path.join(shared, "runs", "run_ok-1-compaction"),
    );
  });

  it("takes the sign-in from the billed account's home and hands it back there (ruling 138)", () => {
    const root = ctx.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", root);
    writeFileSync(path.join(shared, "auth.json"), '{"tokens":"legacy-account"}');
    writeFileSync(path.join(shared, "config.toml"), 'model = "x"\n');
    const { home: accountHome } = ensureBackendAccountHome(
      "u_arda",
      "codex",
      { id: "ubc_billed", legacyHome: false },
      root,
    );
    writeFileSync(path.join(accountHome, "auth.json"), '{"tokens":"billed"}');

    const run = prepareCodexRunHome(shared, "run_acct", undefined, accountHome);
    expect(run.authHome).toBe(accountHome);
    // The account's sign-in; the shared config.
    expect(readFileSync(path.join(run.dir, "auth.json"), "utf8")).toBe('{"tokens":"billed"}');
    expect(readFileSync(path.join(run.dir, "config.toml"), "utf8")).toBe('model = "x"\n');
    writeFileSync(path.join(run.dir, "auth.json"), '{"tokens":"billed-refreshed"}');
    finishCodexRunHome(run);
    expect(readFileSync(path.join(accountHome, "auth.json"), "utf8")).toBe('{"tokens":"billed-refreshed"}');
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe('{"tokens":"legacy-account"}');
  });

  it("never hands back a copy the CLI did not refresh over one another run refreshed (ruling 145)", () => {
    // Two runs of one account: A refreshes (the provider rotates the refresh
    // token) and settles first; B's copy is still the seed when it settles.
    // Comparing B's copy with the account's file would call it "changed" and
    // put the rotated-away token back. Canary: drop the seed digest.
    const shared = sharedCodexHome();
    const auth = path.join(shared, "auth.json");
    writeFileSync(auth, '{"tokens":"seed"}');
    const a = prepareCodexRunHome(shared, "run_first");
    const b = prepareCodexRunHome(shared, "run_second");
    writeFileSync(path.join(a.dir, "auth.json"), '{"tokens":"rotated"}');
    finishCodexRunHome(a);
    expect(readFileSync(auth, "utf8")).toBe('{"tokens":"rotated"}');
    finishCodexRunHome(b);
    expect(readFileSync(auth, "utf8")).toBe('{"tokens":"rotated"}');
    expect(existsSync(b.dir)).toBe(false);
  });

  it("hands nothing back to an account removed while the run was live (ruling 138)", () => {
    const root = ctx.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", root);
    const { home: accountHome } = ensureBackendAccountHome(
      "u_arda",
      "codex",
      { id: "ubc_gone", legacyHome: false },
      root,
    );
    writeFileSync(path.join(accountHome, "auth.json"), '{"tokens":"before"}');
    const run = prepareCodexRunHome(shared, "run_gone", undefined, accountHome);
    // Disconnecting the account removes its whole home mid-run.
    rmSync(accountHome, { recursive: true, force: true });
    writeFileSync(path.join(run.dir, "auth.json"), '{"tokens":"refreshed"}');
    finishCodexRunHome(run);
    expect(existsSync(accountHome)).toBe(false);
    expect(existsSync(run.dir)).toBe(false);
  });
});

/**
 * Ruling 145 (F37-20, live): the Codex CLI writes its rollout THROUGH the run
 * home's `sessions` symlink — so the bytes land in the shared home and survive —
 * but it records the path it SAW, `…/runs/<runId>/sessions/…`, in its own thread
 * index. Ruling 145 removes that directory when the run settles, so every later
 * `thread/resume` answers "no rollout found for thread id", and Viberr reported
 * that to a human as "the agent's stored Codex session no longer exists" while
 * the transcript sat one path segment away.
 *
 * Measured on the live instance before the fix: 137 of 137 threads recorded
 * under a per-run home, 135 of those paths gone, and 135 of 135 of their files
 * present at the shared path.
 */
describe("ruling 145: a settled run's rollout paths are re-pointed at the shared home", () => {
  function seedThread(
    sharedHome: string,
    id: string,
    rolloutPath: string,
  ): void {
    const db = new DatabaseSync(path.join(sharedHome, "state_5.sqlite"));
    db.exec(
      `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)`,
    );
    db.prepare(`INSERT OR REPLACE INTO threads (id, rollout_path, cwd) VALUES (?, ?, ?)`).run(
      id,
      rolloutPath,
      "/workspace",
    );
    db.close();
  }

  function threadPath(sharedHome: string, id: string): string | null {
    const db = new DatabaseSync(path.join(sharedHome, "state_5.sqlite"), { readOnly: true });
    try {
      const row = db.prepare(`SELECT rollout_path FROM threads WHERE id = ?`).get(id);
      // SAFETY: the column is declared TEXT by `seedThread` above and every row
      // this test writes sets it, so the value is a string when the row exists.
      return row ? (row as { rollout_path: string }).rollout_path : null;
    } finally {
      db.close();
    }
  }

  /** A rollout written the way the CLI writes one: through the run home's link,
   *  so the bytes land in the shared `sessions/` tree. */
  function writeRollout(home: { dir: string }, name: string): string {
    const dir = path.join(home.dir, "sessions", "2026", "09", "13");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, '{"type":"session_meta"}\n');
    return file;
  }

  it("moves the recorded path onto the file the symlink actually wrote", () => {
    const shared = ensureUserBackendHome("u_arda", "codex", ctx.makeTempDir());
    const home = prepareCodexRunHome(shared, "run_settling");
    const recorded = writeRollout(home, "rollout-01a0-abc.jsonl");
    seedThread(shared, "01a0-abc", recorded);
    // The bytes are in the SHARED tree even now, because `sessions` is a link.
    const sharedFile = path.join(shared, "sessions", "2026", "09", "13", "rollout-01a0-abc.jsonl");
    expect(existsSync(sharedFile)).toBe(true);

    finishCodexRunHome(home);

    // CANARY: drop the `repointRunRollouts` call and this still reads the
    // removed run-home path — which is what "no rollout found" means.
    expect(threadPath(shared, "01a0-abc")).toBe(sharedFile);
    expect(existsSync(sharedFile)).toBe(true);
    expect(existsSync(home.dir)).toBe(false);
  });

  it("leaves a thread alone when the shared copy is not there", () => {
    const shared = ensureUserBackendHome("u_arda", "codex", ctx.makeTempDir());
    const home = prepareCodexRunHome(shared, "run_nofile");
    const phantom = path.join(home.dir, "sessions", "2026", "09", "13", "rollout-gone.jsonl");
    seedThread(shared, "gone", phantom);
    finishCodexRunHome(home);
    // A wrong path is worse than a stale one: nothing was written, so nothing
    // is claimed.
    expect(threadPath(shared, "gone")).toBe(phantom);
  });

  it("repairs the threads left behind before the settle learned to, and is idempotent", () => {
    const dataRoot = ctx.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", dataRoot);
    // Two threads recorded under run homes that are long gone, their files
    // sitting in the shared tree — the live shape, 135 times over.
    const dir = path.join(shared, "sessions", "2026", "09", "13");
    mkdirSync(dir, { recursive: true });
    for (const id of ["old-1", "old-2"]) {
      const file = path.join(dir, `rollout-${id}.jsonl`);
      writeFileSync(file, "{}\n");
      seedThread(shared, id, path.join(shared, "runs", `run_${id}`, "sessions", "2026", "09", "13", `rollout-${id}.jsonl`));
    }
    // …and one whose run is still in flight: its path exists, so it is not this
    // sweep's business until its own settle.
    const live = prepareCodexRunHome(shared, "run_live");
    const liveFile = writeRollout(live, "rollout-live.jsonl");
    seedThread(shared, "live", liveFile);

    expect(repairCodexRolloutPaths(dataRoot)).toBe(2);
    expect(threadPath(shared, "old-1")).toBe(path.join(dir, "rollout-old-1.jsonl"));
    expect(threadPath(shared, "old-2")).toBe(path.join(dir, "rollout-old-2.jsonl"));
    expect(threadPath(shared, "live")).toBe(liveFile);
    // CANARY: drop the `existsSync(row.rollout_path)` guard and the live run's
    // thread is re-pointed out from under it.
    expect(repairCodexRolloutPaths(dataRoot)).toBe(0);
  });

  /**
   * The self-review caught this one as VACUOUS in its first form: it asserted
   * only `=== 0`, which is what an unrecognised schema returns with the guard
   * deleted too (the row parse fails and the loop `continue`s anyway). The
   * assertion that can actually go red is the one that says a repair silently
   * stopped happening — which is the whole point of the guard, and which the
   * first version of the code did not emit at all despite its own comment
   * promising "skipped with a log line".
   */
  it("skips a state database whose shape it does not recognise, and SAYS it skipped", () => {
    const dataRoot = ctx.makeTempDir();
    const shared = ensureUserBackendHome("u_arda", "codex", dataRoot);
    const db = new DatabaseSync(path.join(shared, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, some_other_column TEXT)`);
    db.prepare(`INSERT INTO threads (id, some_other_column) VALUES ('x', 'y')`).run();
    db.close();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(repairCodexRolloutPaths(dataRoot)).toBe(0);
      // CANARY: drop the `logger.warn` and this is empty — a vendor schema
      // change disables the repair and nobody ever hears about it.
      expect(warn.mock.calls.map(([msg]) => String(msg)).join("\n")).toContain(
        "codex rollout paths NOT repaired at boot",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the SETTLE half says so too when the schema is unrecognised", () => {
    const shared = ensureUserBackendHome("u_arda", "codex", ctx.makeTempDir());
    const db = new DatabaseSync(path.join(shared, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, some_other_column TEXT)`);
    db.close();
    const home = prepareCodexRunHome(shared, "run_unknown_schema");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      finishCodexRunHome(home);
      expect(warn.mock.calls.map(([msg]) => String(msg)).join("\n")).toContain(
        "codex rollout paths NOT re-pointed",
      );
    } finally {
      warn.mockRestore();
    }
  });
});
