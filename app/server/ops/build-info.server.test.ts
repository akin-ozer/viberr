import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { resolveBuildInfo } from "./build-info.server";

/**
 * Gap 18 — the running app had no build identity at all. These pin the two
 * halves of the fix: identity comes from something REAL (env stamp, package
 * version, the checkout's .git), and an unidentified build says so with nulls
 * instead of inventing a placeholder.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

function root(): string {
  return ctx.makeTempDir();
}

describe("resolveBuildInfo (gap 18)", () => {
  it("prefers the env stamp baked at image build", () => {
    const dir = root();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "viberr", version: "9.9.9" }),
    );
    // A readable checkout too, so the stamp has to BEAT git, not fill its gap.
    mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      path.join(dir, ".git", "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );
    const info = resolveBuildInfo(dir, {
      VIBERR_BUILD_VERSION: "1.4.0",
      VIBERR_BUILD_SHA: "abcdef1234567890abcdef1234567890abcdef12",
      VIBERR_BUILD_TIME: "2026-08-08T10:00:00.000Z",
    });
    expect(info).toEqual({
      version: "1.4.0",
      revision: "abcdef123456",
      revisionSource: "env",
      builtAt: "2026-08-08T10:00:00.000Z",
    });
  });

  it("falls back to package.json version and the checkout's git sha", () => {
    const dir = root();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "viberr", version: "0.19.0" }),
    );
    mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      path.join(dir, ".git", "refs", "heads", "main"),
      "0123456789abcdef0123456789abcdef01234567\n",
    );

    const info = resolveBuildInfo(dir, {});
    expect(info.version).toBe("0.19.0");
    expect(info.revision).toBe("0123456789ab");
    expect(info.revisionSource).toBe("git");
    expect(info.builtAt).toBeNull();
  });

  it("reads a sha that only exists in packed-refs (fresh clone)", () => {
    const dir = root();
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      path.join(dir, ".git", "packed-refs"),
      "# pack-refs with: peeled fully-peeled sorted\nfeedfacefeedfacefeedfacefeedfacefeedface refs/heads/main\n",
    );
    expect(resolveBuildInfo(dir, {}).revision).toBe("feedfacefeed");
  });

  it("reports nulls — never a placeholder — when nothing declares an identity", () => {
    const dir = root();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "viberr", private: true }),
    );
    const info = resolveBuildInfo(dir, {});
    expect(info).toEqual({
      version: null,
      revision: null,
      revisionSource: null,
      builtAt: null,
    });
  });

  it("never claims a source it did not read from", () => {
    const dir = root();
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/missing\n");
    const info = resolveBuildInfo(dir, {});
    expect(info.revision).toBeNull();
    expect(info.revisionSource).toBeNull();
  });
});
