import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalOrigin,
  gitOut,
  type LocalOrigin,
  withLocalGithub,
} from "../../../test-support/git-origin";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { READ_PAGE_BYTES } from "~/server/runtimes/read-page-budget.server";
import {
  defaultBranchPageNote,
  pageOfText,
  readDefaultBranchFile,
  readProjectDefaultBranchFile,
} from "./operator-repo-read.server";
import { cloneWorkspaceRepo } from "./repo-mirror.server";

/** A Go-shaped file of `lines` lines, each about 30 characters. */
function goLines(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `\tresult${i} := step(ctx, ${i})`).join("\n") + "\n";
}

describe("ruling 219(c): a default-branch read comes in pages the CLI will carry", () => {
  /**
   * Live on ax-clone at 02:08: the controller asked for
   * `internal/runtime/executor.go` (57,835 characters) and got "result (57,835
   * characters across 1,930 lines) exceeds maximum allowed tokens. Output has
   * been saved to …". Viberr's cap was 60,000, the CLI's MCP limit is 25,000
   * tokens, and the controller has no Read tool for the saved file.
   */
  it("gives a small file back verbatim, cuts an overlong line, and refuses past the end", () => {
    expect(pageOfText("the guide\n")).toEqual({
      ok: true, text: "the guide\n", fromLine: 1, toLine: 1, totalLines: 1, more: false, lineCut: false,
    });
    const long = pageOfText(`${"x".repeat(READ_PAGE_BYTES + 5)}\nnext\n`);
    expect(long.ok && long.lineCut && long.more && long.text.length).toBe(READ_PAGE_BYTES);
    expect(pageOfText("a\nb\n", 3)).toEqual({ ok: false, totalLines: 2 });
    expect(pageOfText("", 1)).toMatchObject({ ok: true, totalLines: 0, more: false });
  });

  it("a page names its lines and the fromLine that continues it", () => {
    // CANARY: drop the "read on with fromLine" sentence.
    const page = pageOfText(goLines(1_930));
    if (!page.ok) throw new Error("unreachable");
    const note = defaultBranchPageNote({ kind: "found", refreshed: true, ...page });
    expect(note.range).toBe(`, lines 1-${page.toLine} of 1930`);
    expect(note.note).toBe(`\n\n[The file continues: read on with fromLine: ${page.toLine + 1}.]`);
    // A file that fits says nothing about pages.
    const whole = pageOfText("the guide\n");
    if (!whole.ok) throw new Error("unreachable");
    expect(defaultBranchPageNote({ kind: "found", refreshed: true, ...whole })).toEqual({ range: "", note: "" });
  });
});

/**
 * F21-21 — the operator's anchored "what is on the default branch?" read.
 *
 * The residual defect this file pins: the read used to keep its answer fresh by
 * running `git fetch --depth 1` INSIDE the shared task workspace. That marks a
 * full clone SHALLOW, and the workspace is the delivering agent's own tree — so
 * an operator asking a read-only question quietly broke the merge-base the diff
 * and verdict machinery runs on. The answer now comes from the project MIRROR
 * (bare, per-project, refreshed on every workspace clone); the checkout is only
 * ever read, and only when there is no mirror at all.
 *
 * Real git throughout, against a local origin (test-support/git-origin.ts):
 * `GIT_ALLOW_PROTOCOL=file` plus a `url.<local>.insteadOf` entry in a temp
 * `GIT_CONFIG_GLOBAL` point `https://github.com/` at a directory, so nothing
 * here touches the network.
 */
describe("readDefaultBranchFile", () => {
  const SLUG = "viberr-core";
  const REPO = "acme/widgets";
  const TASK_BRANCH = "vib-1";

  let ctx: TestDbContext;
  let db: DatabaseSync;
  let dataRoot: string;
  let origins: string;
  let origin: LocalOrigin;
  let checkout: string;

  /**
   * The workspace as a run leaves it: cut from the project's mirror (so the
   * project HAS a mirror, as every real task does), then standing on the TASK
   * branch with the deliverer's commit — the live shape of VIB-7.
   */
  async function makeCheckout(): Promise<void> {
    await withLocalGithub(origins, () =>
      cloneWorkspaceRepo({
        projectSlug: SLUG,
        repo: REPO,
        destination: checkout,
        dataRoot,
      }),
    );
    await gitOut(checkout, ["config", "user.email", "t@t.dev"]);
    await gitOut(checkout, ["config", "user.name", "T"]);
    await gitOut(checkout, ["checkout", "-qb", TASK_BRANCH]);
    writeFileSync(
      path.join(checkout, "docs", "guide.md"),
      "the guide\nthe governed row\n",
    );
    writeFileSync(path.join(checkout, "docs", "new.md"), "brand new\n");
    await gitOut(checkout, ["add", "-A"]);
    await gitOut(checkout, ["commit", "-qm", "the deliverer's work"]);
  }

  const read = (repoPath: string) =>
    withLocalGithub(origins, () =>
      readDefaultBranchFile(db, {
        projectSlug: SLUG,
        dir: checkout,
        defaultBranch: "main",
        path: repoPath,
        dataRoot,
      }),
    );

  beforeEach(async () => {
    ctx = createTestDbContext();
    db = ctx.makeDb();
    dataRoot = ctx.makeTempDir();
    origins = ctx.makeTempDir();
    mkdirSync(path.join(dataRoot, "projects", SLUG), { recursive: true });
    checkout = path.join(dataRoot, "workspace", "widgets");
    // A local bare origin for `acme/widgets` with `docs/guide.md` on `main`.
    origin = await createLocalOrigin(origins, {
      repo: REPO,
      files: { "docs/guide.md": "the guide\n" },
    });
    await makeCheckout();
  });

  afterEach(() => ctx.cleanup());

  it("answers from the default branch while the tree stands on the task branch", async () => {
    // The false-positive input: the deliverer's row IS in the working tree.
    expect(readFileSync(path.join(checkout, "docs", "guide.md"), "utf8")).toContain(
      "the governed row",
    );

    const changed = await read("docs/guide.md");
    const added = await read("docs/new.md");

    expect(changed.kind).toBe("found");
    expect(changed.kind === "found" && changed.text).toContain("the guide");
    expect(changed.kind === "found" && changed.text).not.toContain("the governed row");
    // A file only the task branch has is ABSENT from the default branch — the
    // clean NO that stops the out-of-band accusation.
    expect(added.kind).toBe("absent");
  });

  it("leaves the delivering agent's checkout UNSHALLOWED and its merge-base intact", async () => {
    // The residual defect, exactly. Canary: put the old
    // `git fetch --depth 1 origin +refs/heads/main:refs/remotes/origin/main`
    // back into the read (against `input.dir`) and both assertions fail — the
    // checkout flips to shallow and the merge-base stops resolving.
    expect(await gitOut(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    const base = await gitOut(checkout, ["merge-base", "origin/main", TASK_BRANCH]);

    await read("docs/guide.md");

    expect(await gitOut(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(await gitOut(checkout, ["merge-base", "origin/main", TASK_BRANCH])).toBe(base);
    // Nothing was written into the workspace at all: the tree is still the
    // deliverer's, on its own branch, with its own commit at the tip.
    expect(await gitOut(checkout, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(TASK_BRANCH);
    expect(await gitOut(checkout, ["status", "--porcelain"])).toBe("");
  });

  it("reads what the default branch has NOW — the mirror is refreshed for the read", async () => {
    // Freshness is why the old code fetched at all. The mirror supplies it
    // without touching the checkout, whose `origin/main` is frozen at clone time.
    // (`advance` writes its message plus a newline into the file.)
    await origin.advance({ file: "docs/guide.md", message: "the guide\nthe rewritten section" });

    const after = await read("docs/guide.md");

    expect(after.kind).toBe("found");
    expect(after.kind === "found" && after.refreshed).toBe(true);
    expect(after.kind === "found" && after.text).toContain("the rewritten section");
    // …and the checkout's own remote-tracking ref never moved.
    expect(await gitOut(checkout, ["show", "origin/main:docs/guide.md"])).toBe("the guide");
  });

  it("degrades to the checkout's CLONE-TIME ref when the project has no mirror", async () => {
    // No mirror ⇒ no network, no fetch, and an honest `refreshed: false` for the
    // tool's prose to report. Canary: pass `create: true` from the read and this
    // recreates the mirror instead of degrading.
    rmSync(path.join(dataRoot, "projects", SLUG, ".repo-mirror", "acme__widgets.git"), {
      recursive: true,
      force: true,
    });
    await origin.advance({ file: "docs/guide.md", message: "the guide\nthe rewritten section" });

    const fallback = await read("docs/guide.md");

    expect(fallback.kind).toBe("found");
    expect(fallback.kind === "found" && fallback.refreshed).toBe(false);
    // The clone-time answer, not the working tree's, and not the newer remote's.
    expect(fallback.kind === "found" && fallback.text).toBe("the guide\n");
    expect(await gitOut(checkout, ["rev-parse", "--is-shallow-repository"])).toBe("false");
  });

  it("refuses a path that is not a repository-relative file path", async () => {
    // A ref-ish argument would let the read escape the default branch — the one
    // thing this tool exists to pin down.
    for (const bad of ["vib-1:docs/guide.md", "/etc/passwd", "../secrets", "-C"]) {
      const result = await read(bad);
      expect(result.kind).toBe("unavailable");
    }
  });
});

/**
 * Ruling 265 (pass 37, F37-134): the CONTROLLER reads the default branch too.
 *
 * `read_default_branch_file` was mounted on the operator and nowhere else. The
 * controller writes the architecture, the knowledge bases and the goals every
 * agent is measured against, and reviews the packets those agents raise, and it
 * could not open a file in the repository all of that is about. It found the
 * gap inside a live security-scoped decision whose central factual claim it had
 * to take second-hand, and named the cost exactly: "verify the claim against
 * the repository yourself is the most-repeated rule in this project's own
 * rulings, and I am structurally unable to follow it."
 */
describe("readProjectDefaultBranchFile (ruling 265)", () => {
  const SLUG = "viberr-core";
  const REPO = "acme/widgets";

  let ctx: TestDbContext;
  let db: DatabaseSync;
  let dataRoot: string;
  let origins: string;

  const readIt = (repoPath: string, repo = REPO) =>
    withLocalGithub(origins, () =>
      readProjectDefaultBranchFile(db, {
        projectSlug: SLUG,
        repo,
        defaultBranch: "main",
        path: repoPath,
        dataRoot,
      }),
    );

  beforeEach(async () => {
    ctx = createTestDbContext();
    db = ctx.makeDb();
    dataRoot = ctx.makeTempDir();
    origins = ctx.makeTempDir();
    await createLocalOrigin(origins, {
      repo: REPO,
      files: {
        "services/catalog.ts": "nine routes live here\n",
        // Ruling 219(c): past the old 240,000-byte buffer, which made git's overflow
        // read as "unavailable".
        "internal/runtime/executor.go": goLines(10_000),
      },
    });
  });
  afterEach(() => {
    rmSync(path.join(dataRoot, "projects", SLUG, ".repo-mirror", "acme__widgets.git"), { recursive: true, force: true });
    ctx.cleanup();
  });

  it("reads the branch with NO checkout anywhere, building the mirror itself", async () => {
    // CANARY: require a workspace dir and the controller is back to
    // second-hand claims about the tree.
    const read = await readIt("services/catalog.ts");
    expect(read.kind).toBe("found");
    expect(read.kind === "found" && read.text).toContain("nine routes live here");
  });

  it("ruling 219(c): a file far past one page is read to its end, page by page", async () => {
    // CANARY: put the buffer back at four pages, and the first read is "unavailable".
    const whole = goLines(10_000);
    const seen: string[] = [];
    let fromLine: number | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const request: Parameters<typeof readProjectDefaultBranchFile>[1] = {
        projectSlug: SLUG,
        repo: REPO,
        defaultBranch: "main",
        path: "internal/runtime/executor.go",
        dataRoot,
      };
      if (fromLine) request.fromLine = fromLine;
      const read = await withLocalGithub(origins, () => readProjectDefaultBranchFile(db, request));
      if (read.kind !== "found") throw new Error(`read ${read.kind}`);
      // CANARY: take every line from fromLine on, uncapped.
      expect(read.text.length).toBeLessThanOrEqual(READ_PAGE_BYTES);
      expect(read.totalLines).toBe(10_000);
      seen.push(read.text.replace(/\n$/, ""));
      if (!read.more) break;
      fromLine = read.toLine + 1;
    }
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.join("\n") + "\n").toBe(whole);
  });

  it("a path that is not on the branch is ABSENT, which is an answer", async () => {
    const read = await readIt("services/never-written.ts");
    // Ruling 260: existence before type. "Not there" must not arrive as a
    // failure the caller reports as "I could not check".
    expect(read.kind).toBe("absent");
  });

  it("refuses a path that is not a repository-relative path, naming the shape it wanted", async () => {
    for (const bad of ["/etc/passwd", "../outside.md", "main:docs/guide.md"]) {
      const read = await readIt(bad);
      expect(read.kind, bad).toBe("unavailable");
      expect(read.kind === "unavailable" && read.reason).toContain("repository-relative");
    }
  });

  it("says WHICH branch it could not reach when no mirror can be built, and never answers from elsewhere", async () => {
    const read = await readIt("services/catalog.ts", "acme/does-not-exist");
    expect(read.kind).toBe("unavailable");
    // CANARY: fall back to some other tree. There is no checkout to fall back
    // to here, and inventing one is the error this module exists to stop.
    expect(read.kind === "unavailable" && read.reason).toMatch(/mirror|could not/i);
  });
});
