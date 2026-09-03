import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { isAppError } from "~/server/errors/app-error.server";
import {
  assertPathSafeUserId,
  claudeLoginCredentialPath,
  codexLoginCredentialPath,
  ensureUserBackendHome,
  listUserRuntimeRoots,
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
