import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  isInjectableKbDoc,
  isPrivateKbFolder,
  kbSizeClass,
  readKbDocForRun,
  readKbIndexDetailed,
  readKbIndexes,
} from "./kb-injection.server";
import { createTempDirs } from "../../../test-support/temp-dirs";
import { READ_PAGE_BYTES } from "~/server/runtimes/read-page-budget.server";

const temp = createTempDirs();
afterAll(temp.cleanup);

function freshKb(dir = "notes") {
  const dataRoot = temp.make("viberr-kb-");
  const kbDir = path.join(dataRoot, "kb", dir);
  mkdirSync(kbDir, { recursive: true });
  return { dataRoot, kbDir };
}

describe("readKbIndexDetailed — the index a run receives (ruling 283)", () => {
  it("names a top-level doc with its size and its sections", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(
      path.join(kbDir, "overview.md"),
      "# Top\n\nprose\n\n## Deploying\n\nmore",
      "utf8",
    );
    const body = readKbIndexDetailed("notes", dataRoot).body;
    expect(body).toContain("`overview.md` · under 1k chars");
    expect(body).toContain("# Top");
    expect(body).toContain("## Deploying");
    // The TEXT is not in the index — that is the whole change.
    expect(body).not.toContain("prose");
  });

  it("indexes NESTED docs — the GitHub-import / folder-upload shape", () => {
    const { dataRoot, kbDir } = freshKb();
    mkdirSync(path.join(kbDir, "repo", "docs"), { recursive: true });
    writeFileSync(path.join(kbDir, "repo", "docs", "api.md"), "# API", "utf8");
    expect(readKbIndexDetailed("notes", dataRoot).body).toContain("`repo/docs/api.md`");
  });

  it("indexes non-.md text docs, which have no headings to outline", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "hosts.txt"), "a\nb\nc", "utf8");
    writeFileSync(path.join(kbDir, "ports.json"), '{"gateway":4000}', "utf8");
    const body = readKbIndexDetailed("notes", dataRoot).body;
    expect(body).toContain("`hosts.txt`");
    expect(body).toContain("`ports.json`");
  });

  it("counts only text files as documents, and ignores dotfiles", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "real.md"), "# Real", "utf8");
    writeFileSync(path.join(kbDir, "contract.pdf"), "%PDF-1.4", "utf8");
    writeFileSync(path.join(kbDir, ".secret.md"), "# Secret", "utf8");
    mkdirSync(path.join(kbDir, ".git"), { recursive: true });
    writeFileSync(path.join(kbDir, ".git", "config.md"), "# Git", "utf8");
    const body = readKbIndexDetailed("notes", dataRoot).body;
    expect(body).toMatch(/^Folder `[^`]+`\. 1 document:\n\n- `real\.md`/);
    expect(body).not.toContain("secret");
    expect(body).not.toContain(".git");
  });

  /**
   * Ruling 678: a knowledge base's folder also holds what a board's work must
   * follow (a report template, a sample, a logo). The index said nothing of a
   * file that is not a document, so a run learned of one only from a rule that
   * spelled out its path.
   */
  it("ruling 678: names the folder's other files apart from its documents, with where a run opens them", () => {
    // CANARY: drop `otherFilesNote` from the body and a template copied into
    // the rulings knowledge base reaches no run's prompt.
    const { dataRoot, kbDir } = freshKb("rulings");
    writeFileSync(path.join(kbDir, "rulings.md"), "# Rulings\n", "utf8");
    writeFileSync(path.join(kbDir, "proposal-template.html"), "<h1>1. Amaç</h1>", "utf8");
    mkdirSync(path.join(kbDir, "brand"), { recursive: true });
    writeFileSync(path.join(kbDir, "brand", "logo.png"), Buffer.alloc(200 * 1024));
    writeFileSync(path.join(kbDir, ".DS_Store"), "x", "utf8");
    expect(readKbIndexDetailed("rulings", dataRoot).body).toBe(
      `Folder \`${kbDir}\`. 1 document:\n\n` +
        "- `rulings.md` · under 1k chars\n  # Rulings\n\n" +
        "2 other files here are not documents (a template, a sample, an image): `read_knowledge_doc` does not read them, " +
        "so open one from your shell in the folder above:\n\n" +
        "- `brand/logo.png` · 100 KB to 1 MB\n" +
        "- `proposal-template.html` · under 10 KB",
    );
  });

  it("ruling 678: a folder that holds only such files is still given, as the list of them", () => {
    // CANARY: answer "holds no documents" for it and a knowledge base made
    // for a board's templates reaches no run, while the copy that filled it
    // said every run given it would see the files.
    const { dataRoot, kbDir } = freshKb("templates");
    writeFileSync(path.join(kbDir, "proposal-template.pdf"), "%PDF-1.4", "utf8");
    const given = readKbIndexDetailed("templates", dataRoot);
    expect(given.unresolved).toBeUndefined();
    expect(given.body).toBe(
      `Folder \`${kbDir}\`. No documents.\n\n` +
        "1 other file here is not a document (a template, a sample, an image): `read_knowledge_doc` does not read them, " +
        "so open one from your shell in the folder above:\n\n- `proposal-template.pdf` · under 10 KB",
    );
    // CANARY: give a private one the same index and a run is sent to a
    // folder its shell is refused, for files no tool of its own reads.
    chmodSync(kbDir, 0o700);
    expect(readKbIndexDetailed("templates", dataRoot, { hasKnowledgeTool: true })).toEqual({
      body: "",
      unresolved: {
        name: "templates",
        reason: "its store folder holds no documents, and it is private (ruling 578), so no run can open the files it does hold",
      },
    });
  });

  it("ruling 678: says nothing about other files when the folder holds only documents", () => {
    // CANARY: print the note for an empty list and every index on the
    // instance gains a line, which moves every cached prompt.
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "real.md"), "# Real", "utf8");
    expect(readKbIndexDetailed("notes", dataRoot).body).toBe(
      `Folder \`${kbDir}\`. 1 document:\n\n- \`real.md\` · under 1k chars\n  # Real`,
    );
  });

  /**
   * THE motivating case, at the live sizes.
   *
   * On the shopify-clone board `conventions.md` was 20,632 chars and took the
   * whole 15,817 that the shared budget had left, cut itself mid-sentence in
   * its own §9, and left ZERO for `published-history.md` (185) and
   * `standing-corrections.md` (281). A task goal on that board says "See
   * published-history.md in the project's rulings knowledge base" — a document
   * no run on it could receive. Alphabetical order decided which rules an agent
   * was allowed to know.
   */
  it("a huge first doc does not starve the small docs behind it", () => {
    const { dataRoot, kbDir } = freshKb("rulings");
    writeFileSync(
      path.join(kbDir, "conventions.md"),
      `# Conventions\n\n${"x".repeat(20_000)}\n\n## Boundaries\n\ntail`,
      "utf8",
    );
    writeFileSync(path.join(kbDir, "published-history.md"), "# History\n\nnever rebase", "utf8");
    writeFileSync(
      path.join(kbDir, "standing-corrections.md"),
      "# Corrections\n\nthree rules",
      "utf8",
    );
    const index = readKbIndexDetailed("rulings", dataRoot);
    // Every document is named, whatever the one ahead of it weighs.
    expect(index.body).toContain("`conventions.md`");
    expect(index.body).toContain("`published-history.md`");
    expect(index.body).toContain("`standing-corrections.md`");
    // And nothing was clipped, so nothing is reported as lost.
    expect(index.unresolved).toBeUndefined();
    expect(index.body).not.toMatch(/truncat|omitted|budget/i);
  });

  it("the outline budget clips OUTLINES, never the list of documents", () => {
    const { dataRoot, kbDir } = freshKb();
    // Enough headings to spend the outline budget several times over, spread so
    // the LAST documents are reached with nothing left. Each must still be
    // NAMED: the name is the only thing a run needs in order to ask for the
    // document, so the budget may cost an outline and never a document.
    for (let i = 0; i < 150; i += 1) {
      const key = String(i).padStart(3, "0");
      writeFileSync(
        path.join(kbDir, `doc-${key}.md`),
        `# Document ${key} ${"y".repeat(60)}\n\nbody`,
        "utf8",
      );
    }
    const body = readKbIndexDetailed("notes", dataRoot).body;
    expect(body).toContain("`doc-000.md`");
    // The last doc is reached with the outline budget spent: named, no outline.
    expect(body).toContain("`doc-149.md`");
    expect(body).not.toContain("# Document 149");
    // ...while an early one kept its heading, so the budget really did apply
    // rather than outlines being off altogether.
    expect(body).toContain("# Document 000");
  });

  it("does not read a fenced code block's comments as sections", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(
      path.join(kbDir, "shell.md"),
      "# Real heading\n\n```sh\n# not a heading\nmake up\n```\n",
      "utf8",
    );
    const body = readKbIndexDetailed("notes", dataRoot).body;
    expect(body).toContain("# Real heading");
    expect(body).not.toContain("not a heading");
  });

  it("reports a missing KB folder as a structured unresolved grant", () => {
    const { dataRoot } = freshKb();
    const detailed = readKbIndexDetailed("renamed-away", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved).toEqual({
      name: "renamed-away",
      reason: "no knowledge-base folder by that name in the store",
    });
  });

  it("reports an EMPTY KB folder (the grant is attached, the content is not)", () => {
    const { dataRoot } = freshKb("hollow");
    expect(readKbIndexDetailed("hollow", dataRoot).unresolved?.name).toBe("hollow");
  });

  /**
   * C5/pass-16 containment. `collectKbDocs` realpath's the ROOT and then checks
   * every visited dir against it — so when the KB folder is ITSELF a symlink,
   * containment was measured against the link's TARGET and the whole target
   * tree was indexed as trusted agent context.
   */
  it("refuses a KB folder that is a symlink out of the store", () => {
    const { dataRoot } = freshKb();
    const outside = temp.make("viberr-outside-");
    writeFileSync(path.join(outside, "secret.md"), "MARKER-OUTSIDE", "utf8");
    symlinkSync(outside, path.join(dataRoot, "kb", "linked"));
    const detailed = readKbIndexDetailed("linked", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved?.reason).toContain("symlink");
    expect(detailed.body).not.toContain("secret.md");
  });

  it("isInjectableKbDoc is the predicate the org doc count shares", () => {
    for (const name of ["a.md", "b.MDX", "c.txt", "d.rst", "e.json", "f.yaml", "g.yml"]) {
      expect(isInjectableKbDoc(name)).toBe(true);
    }
    for (const name of ["contract.pdf", "diagram.png", ".hidden.md"]) {
      expect(isInjectableKbDoc(name)).toBe(false);
    }
  });
});

/**
 * Ruling 506: the index sits in the static prefix of every run its knowledge
 * base is attached to (ruling 370), and ruling 498 writes agents' corrections
 * straight into the documents, so an edit is routine. The exact byte count the
 * index printed moved on every edit, and each one cost every run on the
 * project its cached prefix. A size class moves only when a document crosses
 * a step.
 */
describe("the index survives an edit inside a document (ruling 506)", () => {
  it("prints each size as a 1-2-5 class, exact at every step", () => {
    const cases: [number, string][] = [
      [0, "under 1k chars"],
      [999, "under 1k chars"],
      [1_000, "1k to 2k chars"],
      [1_999, "1k to 2k chars"],
      [2_000, "2k to 5k chars"],
      [5_000, "5k to 10k chars"],
      [10_000, "10k to 20k chars"],
      [20_632, "20k to 50k chars"],
      [49_999, "20k to 50k chars"],
      [50_000, "50k to 100k chars"],
      [100_000, "100k to 200k chars"],
      [200_000, "200k to 500k chars"],
      [500_000, "500k to 1M chars"],
      [999_999, "500k to 1M chars"],
      [1_000_000, "1M chars or more"],
      [40_000_000, "1M chars or more"],
    ];
    expect(cases.map(([size]) => [size, kbSizeClass(size)])).toEqual(cases);
  });

  it("a correction to a document's body leaves the index byte-identical", () => {
    const { dataRoot, kbDir } = freshKb("rulings");
    const doc = path.join(kbDir, "conventions.md");
    // The live size ruling 283 was written about, and a one-line correction
    // of the kind `correct_knowledge_doc` appends.
    const text = `# Conventions\n\n${"x".repeat(20_600)}\n\n## Boundaries\n\ntail`;
    writeFileSync(doc, text, "utf8");
    const before = readKbIndexDetailed("rulings", dataRoot).body;
    expect(before).toContain("`conventions.md` · 20k to 50k chars");
    writeFileSync(doc, `${text}\n\nCorrected 2026-09-26: never rebase a shared branch.`, "utf8");
    expect(readKbIndexDetailed("rulings", dataRoot).body).toBe(before);
    // What the index SAYS still moves it: a new section, and a document that
    // crosses a step.
    writeFileSync(doc, `${text}\n\n## Rebasing\n\nnever`, "utf8");
    expect(readKbIndexDetailed("rulings", dataRoot).body).toContain("## Rebasing");
    writeFileSync(doc, `# Conventions\n\n${"x".repeat(60_000)}`, "utf8");
    expect(readKbIndexDetailed("rulings", dataRoot).body).toContain(
      "`conventions.md` · 50k to 100k chars",
    );
  });

  it("lists documents in code-point order, whatever the process locale", () => {
    // `localeCompare` put `api.md` before `README.md` under an English locale
    // and may not under another; two servers that order one index differently
    // do not share a prefix. Code-point order is the one every other list in a
    // cached prefix already uses (ruling 370's `sortedNames`).
    const { dataRoot, kbDir } = freshKb();
    for (const name of ["beta.md", "README.md", "api.md", "Zeta.md"]) {
      writeFileSync(path.join(kbDir, name), `# ${name}`, "utf8");
    }
    const body = readKbIndexDetailed("notes", dataRoot).body;
    const order = ["README.md", "Zeta.md", "api.md", "beta.md"].map((name) =>
      body.indexOf(`\`${name}\``),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("readKbIndexes — every declared KB, no shared budget (ruling 283)", () => {
  it("indexes every KB and collects only the real misses", () => {
    const { dataRoot, kbDir } = freshKb("first");
    writeFileSync(path.join(kbDir, "a.md"), `# First\n\n${"x".repeat(30_000)}`, "utf8");
    const second = path.join(dataRoot, "kb", "second");
    mkdirSync(second, { recursive: true });
    writeFileSync(path.join(second, "b.md"), "# Second", "utf8");
    const set = readKbIndexes(["first", "second", "gone"], dataRoot);
    // The 30k first KB does not cost the second one anything — the failure the
    // shared budget made structural, and the reason there is no budget now.
    expect(set.parts.map((p) => p.name)).toEqual(["first", "second"]);
    expect(set.parts[1]?.body).toContain("`b.md`");
    expect(set.unresolved.map((u) => u.name)).toEqual(["gone"]);
  });
});

/**
 * Ruling 578: every agent of a person runs as that person's uid and can read
 * `kb/` (ruling 460(d)), so a grant decided what a run is given and nothing
 * kept a benchmark's answer key from the shells of the agents it scores. A
 * private folder (0700, the server's alone) is closed to every shell; the runs
 * it is granted to read it through their knowledge tool.
 */
describe("a private knowledge base (ruling 578)", () => {
  it("is the folder's own mode: 0700 is private, anything the group or others may read is not", () => {
    const { kbDir } = freshKb("keys");
    expect(isPrivateKbFolder(kbDir)).toBe(false);
    chmodSync(kbDir, 0o700);
    expect(isPrivateKbFolder(kbDir)).toBe(true);
    chmodSync(kbDir, 0o750);
    expect(isPrivateKbFolder(kbDir)).toBe(false);
    expect(isPrivateKbFolder(path.join(kbDir, "missing"))).toBe(false);
  });

  it("sends a run with a knowledge tool to read_knowledge_doc, and tells a run without one it cannot reach it", () => {
    // CANARIES: drop the private sentence and the index sends the run to a
    // folder its shell cannot open; drop the `hasKnowledgeTool === false`
    // miss and a Codex run is handed an index it has no way to use.
    const { dataRoot, kbDir } = freshKb("keys");
    writeFileSync(path.join(kbDir, "sample-01.md"), "# Sample 01\n\nEXPECTED-TOTAL", "utf8");
    chmodSync(kbDir, 0o700);
    const tooled = readKbIndexDetailed("keys", dataRoot, { hasKnowledgeTool: true });
    expect(tooled.body).toContain("is private (ruling 578): no shell on this run can open it, so read each document with `read_knowledge_doc`.");
    expect(tooled.body).toContain("`sample-01.md`");
    expect(tooled.body).not.toContain("EXPECTED-TOTAL");
    const bare = readKbIndexes(["keys"], dataRoot, { hasKnowledgeTool: false });
    expect(bare.parts).toEqual([]);
    expect(bare.unresolved).toEqual([
      {
        name: "keys",
        reason:
          "it is private (ruling 578): its folder is closed to every shell, and this run has no knowledge tool to read it",
      },
    ]);
    // Ruling 678: a file that is not a document is closed to every run there,
    // and the index says so instead of sending one to its shell.
    // CANARY: print the open folder's sentence for a private one and a run is
    // told to open a file its shell is refused.
    writeFileSync(path.join(kbDir, "answer-sheet.xlsx"), "PK", "utf8");
    expect(readKbIndexDetailed("keys", dataRoot, { hasKnowledgeTool: true }).body).toContain(
      "1 other file here is not a document, and no run can open them: the folder is closed to every shell and " +
        "`read_knowledge_doc` reads documents only:\n\n- `answer-sheet.xlsx` · under 10 KB",
    );
    // An open folder reads as it always did, on either backend.
    chmodSync(kbDir, 0o755);
    expect(readKbIndexes(["keys"], dataRoot, { hasKnowledgeTool: false }).parts[0]?.body).toMatch(/^Folder `[^`]+`\. 1 document/);
  });
});

describe("readKbDocForRun — the pull half of ruling 283", () => {
  it("returns the document whole", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "conventions.md"), "# C\n\nMARKER-BODY", "utf8");
    expect(readKbDocForRun(["notes"], "notes", "conventions.md", dataRoot)).toContain(
      "MARKER-BODY",
    );
  });

  it("reads a NESTED document by the path the index printed", () => {
    const { dataRoot, kbDir } = freshKb();
    mkdirSync(path.join(kbDir, "repo"), { recursive: true });
    writeFileSync(path.join(kbDir, "repo", "api.md"), "MARKER-NESTED", "utf8");
    expect(readKbDocForRun(["notes"], "notes", "repo/api.md", dataRoot)).toContain(
      "MARKER-NESTED",
    );
  });

  /** A run may read the knowledge bases attached to IT. The org's others are
   *  not context this run was granted just because it can spell their names. */
  it("refuses a knowledge base this run does not hold", () => {
    const { dataRoot } = freshKb("other-teams-kb");
    writeFileSync(
      path.join(dataRoot, "kb", "other-teams-kb", "secret.md"),
      "MARKER-UNGRANTED",
      "utf8",
    );
    const out = readKbDocForRun(["mine"], "other-teams-kb", "secret.md", dataRoot);
    expect(out).not.toContain("MARKER-UNGRANTED");
    expect(out).toContain("[noop]");
    expect(out).toContain("`mine`");
  });

  it("refuses a path that climbs out of the knowledge base", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "in.md"), "inside", "utf8");
    const sibling = path.join(dataRoot, "kb", "sibling");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, "out.md"), "MARKER-ESCAPED", "utf8");
    const out = readKbDocForRun(["notes"], "notes", "../sibling/out.md", dataRoot);
    expect(out).not.toContain("MARKER-ESCAPED");
    expect(out).toContain("[noop]");
  });

  it("refuses a symlinked document pointing out of the store", () => {
    const { dataRoot, kbDir } = freshKb();
    const outside = temp.make("viberr-outside-");
    writeFileSync(path.join(outside, "secret.md"), "MARKER-LINKED", "utf8");
    symlinkSync(path.join(outside, "secret.md"), path.join(kbDir, "linked.md"));
    expect(readKbDocForRun(["notes"], "notes", "linked.md", dataRoot)).not.toContain(
      "MARKER-LINKED",
    );
  });

  it("refuses a non-text file even inside the folder", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "contract.pdf"), "%PDF-MARKER", "utf8");
    expect(readKbDocForRun(["notes"], "notes", "contract.pdf", dataRoot)).not.toContain(
      "%PDF-MARKER",
    );
  });

  /** A miss hands back the index, so the next call is a real path rather than
   *  a second guess at the same one. */
  it("a wrong path answers with the knowledge base's index", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "conventions.md"), "# C", "utf8");
    const out = readKbDocForRun(["notes"], "notes", "convntions.md", dataRoot);
    expect(out).toContain("[noop]");
    expect(out).toContain("`conventions.md`");
  });

  it("says plainly when a document was cut, rather than reading as complete", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "big.md"), "z".repeat(READ_PAGE_BYTES + 500), "utf8");
    const out = readKbDocForRun(["notes"], "notes", "big.md", dataRoot);
    expect(out).toContain("not the whole document");
  });

  it("ruling 580: a long document is read in pages, each saying where it stands and where to read on", () => {
    // Live on the AWS calculator board the controller could not take in a
    // 94 KB document whole, and agents read past 48,000 characters from disk,
    // which a private knowledge base (ruling 578) closes. CANARY: ignore
    // `offset` and every page is the opening again.
    const { dataRoot, kbDir } = freshKb();
    const size = READ_PAGE_BYTES * 2 + 1_000;
    writeFileSync(path.join(kbDir, "big.md"), "a".repeat(READ_PAGE_BYTES) + "b".repeat(READ_PAGE_BYTES) + "c".repeat(1_000), "utf8");
    const first = readKbDocForRun(["notes"], "notes", "big.md", dataRoot);
    expect(first.startsWith("a")).toBe(true);
    expect(first).toContain(`characters 0 to 32,000 of ${size.toLocaleString("en-US")} in \`big.md\``);
    expect(first).toContain(`read on with offset ${READ_PAGE_BYTES}`);
    const second = readKbDocForRun(["notes"], "notes", "big.md", dataRoot, READ_PAGE_BYTES);
    expect(second.startsWith("b")).toBe(true);
    expect(second).toContain(`read on with offset ${READ_PAGE_BYTES * 2}`);
    const last = readKbDocForRun(["notes"], "notes", "big.md", dataRoot, READ_PAGE_BYTES * 2);
    expect(last.startsWith("c")).toBe(true);
    expect(last).toContain("the end of the document");
    expect(readKbDocForRun(["notes"], "notes", "big.md", dataRoot, size + 5)).toContain("is past its end");
  });
});

describe("STORE_TEXT_EXTENSIONS is the ONLY store text-doc list", () => {
  /** Every app source file, so the assertion cannot be scoped away. */
  function appSources(dir: URL, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) appSources(child, out);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(fileURLToPath(child));
      }
    }
    return out;
  }

  // The editable and injectable lists diverged once already (.json/.yaml/.yml
  // were authorable in-app and invisible to every run), and the first fix left
  // three copies "separate but equal" — which is the same defect wearing a
  // test. There is one set now, in an isomorphic module the browser can import,
  // and the invariant worth pinning is that nobody re-declares it: a second
  // literal list is how the divergence starts, not how it is caught.
  it("no source file declares its own copy of the extension list", () => {
    const offenders: string[] = [];
    for (const file of appSources(new URL("../../../app/", import.meta.url))) {
      const source = readFileSync(file, "utf8");
      // A literal list is only a copy if it holds the two extensions the
      // divergence turned on — ".md" alone appears in plenty of honest places.
      if (
        source.includes('".markdown"') &&
        source.includes('".mdx"') &&
        !file.endsWith("shared/text/store-extensions.ts")
      ) {
        offenders.push(file.slice(file.indexOf("/app/") + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
