import { mkdirSync, readFileSync, readdirSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { PAGE_CAPTURE_MAX_PAGES } from "~/shared/page-capture";
import { taskDir } from "./file-store-root.server";
import {
  KEPT_BUILD_FILE_MAX_BYTES,
  builtPagesAmong,
  keepBuild,
  keptBuildDir,
  keptBuildFiles,
  plainPagesDir,
  projectPagesDir,
  sitePath,
} from "./kept-builds.server";

/**
 * Ruling 86: the pages a delivered revision builds are kept as built. The
 * folder kept is one a gate wrote as the task owner's agent user, in a
 * checkout an agent's commit filled, so these are about what the server reads
 * there (nothing through a link, no tool's own folder) and what it keeps.
 */

let ctx: TestDbContext;
let store: TestStore;
/** A checkout, and the folder of it the gates built the site into. */
let checkout: string;
let built: string;

const put = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
};
const keep = (revisionId: string, folder = "dist") =>
  keepBuild(store.slug, "VIB-1", revisionId, checkout, folder, store.dataRoot);
const kept = (revisionId: string) => keptBuildDir(store.slug, "VIB-1", revisionId, store.dataRoot);
const buildsOnTask = () => readdirSync(path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "builds")).sort();

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  checkout = ctx.makeTempDir("viberr-checkout-");
  built = path.join(checkout, "dist");
  put(built, {
    "index.html": "<h1>home</h1>",
    "assets/site.css": "body { margin: 0 }",
    "guide/index.html": "<p>the guide</p>",
  });
});

afterEach(() => {
  ctx.cleanup();
});

describe("a revision's built pages are kept as a tree (ruling 86)", () => {
  it("copies the folder with its folders, and nothing a tool left in it or a link leads to", async () => {
    const elsewhere = ctx.makeTempDir("viberr-elsewhere-");
    put(elsewhere, { "secret.html": "<p>not the site's</p>", "inside/also.html": "<p>nor this</p>" });
    put(built, {
      ".astro/cache.json": "{}",
      ".nojekyll": "",
      "node_modules/pkg/index.html": "<p>a dependency's page</p>",
    });
    symlinkSync(path.join(elsewhere, "secret.html"), path.join(built, "leak.html"));
    symlinkSync(path.join(elsewhere, "inside"), path.join(built, "linked"));

    const result = await keep("rev_1");

    // CANARY: copy with a call that follows links (`cpSync` with
    // `dereference`, or `statSync` in place of the listing's own entry kind)
    // and `leak.html` and `linked/also.html` are kept with the bytes of files
    // outside the checkout, which the renderer then serves to an agent.
    expect(keptBuildFiles(kept("rev_1"))).toEqual(["assets/site.css", "guide/index.html", "index.html"]);
    expect(result).toEqual({ files: 3, bytes: 13 + 18 + 16, leftOut: 0 });
    expect(readFileSync(path.join(kept("rev_1")!, "guide/index.html"), "utf8")).toBe("<p>the guide</p>");
  });

  it("keeps nothing of a folder that is a link, is reached through one, or is not there", async () => {
    const elsewhere = ctx.makeTempDir("viberr-elsewhere-");
    put(elsewhere, { "index.html": "<p>not the site's</p>", "site/index.html": "<p>nor this</p>" });
    symlinkSync(elsewhere, path.join(checkout, "out"));
    const nothing = { files: 0, bytes: 0, leftOut: 0 };
    // CANARY: list the folder with `readdirSync` alone, which follows a link
    // at the folder itself, and the page behind it is kept.
    expect(await keep("rev_1", "out")).toEqual(nothing);
    // CANARY: check only the last level (`lstat` follows every folder before
    // it) and `out/site` is kept from outside the checkout.
    expect(await keep("rev_1", "out/site")).toEqual(nothing);
    expect(await keep("rev_1", "no-such-folder")).toEqual(nothing);
    expect(keptBuildFiles(kept("rev_1"))).toEqual([]);
  });

  it("leaves out a file past what a kept build holds, and counts it", async () => {
    writeFileSync(path.join(built, "film.html"), "");
    truncateSync(path.join(built, "film.html"), KEPT_BUILD_FILE_MAX_BYTES + 1);
    const result = await keep("rev_1");
    expect(result.leftOut).toBe(1);
    expect(keptBuildFiles(kept("rev_1"))).not.toContain("film.html");
    expect(result.files).toBe(3);
  });

  it("replaces the build kept for the same revision, and keeps only the two newest revisions' builds", async () => {
    await keep("rev_1");
    put(built, { "new.html": "<p>added</p>" });
    writeFileSync(path.join(built, "index.html"), "<h1>home, again</h1>");
    await keep("rev_1");
    // The same revision built again holds what the gates built last, whole.
    expect(keptBuildFiles(kept("rev_1"))).toEqual(["assets/site.css", "guide/index.html", "index.html", "new.html"]);
    expect(readFileSync(path.join(kept("rev_1")!, "index.html"), "utf8")).toBe("<h1>home, again</h1>");

    // Each build older than the last, by the clock the folders carry.
    const at = (revisionId: string, seconds: number): void => {
      const when = new Date(Date.UTC(2026, 9, 10, 12, 0, seconds));
      utimesSync(kept(revisionId)!, when, when);
    };
    at("rev_1", 1);
    await keep("rev_2");
    at("rev_2", 2);
    await keep("rev_3");
    // CANARY: drop the removal at the end of `keepBuild` and every
    // revision's site stays on the task for good.
    expect(buildsOnTask()).toEqual(["rev_2", "rev_3"]);
  });

  it("refuses a revision id that is no folder name", async () => {
    for (const id of ["../rev_1", "rev/1", "", ".", "a".repeat(81)]) {
      expect(kept(id), id).toBeNull();
      await expect(keep(id), id).rejects.toThrow("is not a revision's id");
    }
    expect(keptBuildFiles(null)).toEqual([]);
  });
});

describe("where a project's gates build its pages (ruling 86)", () => {
  it("is the folder the first gate that names a plain one says", () => {
    expect(projectPagesDir(undefined)).toBeNull();
    expect(projectPagesDir([{ name: "install", command: "npm ci" }])).toBeNull();
    expect(
      projectPagesDir([
        { name: "install", command: "npm ci" },
        { name: "build", command: "npm run build", pages: "site/dist/" },
        { name: "docs", command: "npm run docs", pages: "docs-out" },
      ]),
    ).toBe("site/dist");
    // A value that is no string names nothing.
    expect(projectPagesDir([{ name: "build", command: "x", pages: 7 }])).toBeNull();
  });

  it("is never a path that leaves the checkout or names a tool's folder", () => {
    // CANARY: accept any string and `pages: "../../../attachments"` has the
    // gates' checkout answer for another task's files.
    for (const named of ["../out", "/var/www", "a/../b", ".git", "dist/.cache", "a//b", "a\\b", "", " ", "x".repeat(201)]) {
      expect(plainPagesDir(named), named).toBeNull();
      expect(projectPagesDir([{ name: "build", command: "x", pages: named }]), named).toBeNull();
    }
    expect(plainPagesDir("dist")).toBe("dist");
    expect(plainPagesDir(" build/site ")).toBe("build/site");
  });
});

describe("the pages of a built site (ruling 86)", () => {
  it("are its HTML files, the front page first, then the shallowest, then by path, to the cap", () => {
    const files = ["zebra.html", "assets/site.css", "guide/deep/index.html", "guide/index.html", "about.htm", "index.html", "notes.md"];
    expect(builtPagesAmong(files)).toEqual({
      pages: ["index.html", "about.htm", "zebra.html", "guide/index.html", "guide/deep/index.html"],
      extra: [],
    });
    const many = Array.from({ length: PAGE_CAPTURE_MAX_PAGES + 3 }, (_, i) => `p${String(i).padStart(2, "0")}.html`);
    const cut = builtPagesAmong(many);
    expect(cut.pages).toEqual(many.slice(0, PAGE_CAPTURE_MAX_PAGES));
    expect(cut.extra).toEqual(many.slice(PAGE_CAPTURE_MAX_PAGES));
  });

  it("are named by a path from the site's root, and a folder's path names its index.html", () => {
    expect(sitePath("index.html")).toBe("index.html");
    expect(sitePath("/")).toBe("index.html");
    expect(sitePath("")).toBe("index.html");
    expect(sitePath("guide/")).toBe("guide/index.html");
    expect(sitePath("/guide/index.html")).toBe("guide/index.html");
    // CANARY: let a dotted or empty segment through and a path climbs out of
    // the kept build.
    for (const asked of ["../index.html", "guide/../../x.html", ".well-known/x.html", "a//b.html", "a\\b.html"]) {
      expect(sitePath(asked), asked).toBeNull();
    }
  });
});
