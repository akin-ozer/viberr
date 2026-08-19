import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KB_INJECTION_BUDGET,
  STORE_TEXT_EXTENSIONS,
  isInjectableKbDoc,
  readKbBodies,
  readKbBody,
  readKbBodyDetailed,
} from "./kb-injection.server";

function freshKb(dir = "notes") {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-kb-"));
  const kbDir = path.join(dataRoot, "kb", dir);
  mkdirSync(kbDir, { recursive: true });
  return { dataRoot, kbDir };
}

describe("readKbBody — recursive, multi-format KB injection", () => {
  it("reads a top-level .md doc (the previously-working seed shape)", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "overview.md"), "# Top\nMARKER-TOP", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-TOP");
    expect(body).toContain("### overview.md");
  });

  it("reads NESTED docs — the GitHub-import / folder-upload bug (was silently dropped)", () => {
    const { dataRoot, kbDir } = freshKb();
    // importGithubSnapshot always nests under <folder>/… — reproduce that shape.
    const nested = path.join(kbDir, "my-repo", "docs");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "guide.md"), "# Guide\nMARKER-NESTED-DEEP", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-NESTED-DEEP");
    // heading carries the store-relative path so the agent can cite it
    expect(body).toContain("### my-repo/docs/guide.md");
  });

  it("reads non-.md text docs (.txt/.mdx/.rst/.markdown), not only .md", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "a.txt"), "MARKER-TXT", "utf8");
    writeFileSync(path.join(kbDir, "b.mdx"), "MARKER-MDX", "utf8");
    writeFileSync(path.join(kbDir, "c.rst"), "MARKER-RST", "utf8");
    writeFileSync(path.join(kbDir, "d.markdown"), "MARKER-MARKDOWN", "utf8");
    const body = readKbBody("notes", dataRoot);
    for (const m of ["MARKER-TXT", "MARKER-MDX", "MARKER-RST", "MARKER-MARKDOWN"]) {
      expect(body).toContain(m);
    }
  });

  it("ignores non-text binary-ish extensions", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "keep.md"), "MARKER-KEEP", "utf8");
    writeFileSync(path.join(kbDir, "skip.png"), "not-text", "utf8");
    writeFileSync(path.join(kbDir, "skip.pdf"), "%PDF", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-KEEP");
    expect(body).not.toContain("skip.png");
    expect(body).not.toContain("skip.pdf");
  });

  /**
   * C5/pass-16 — this test previously asserted the OPPOSITE (`skip.json` must
   * not inject). The in-app "New document" editor has always been able to
   * author `.json`/`.yaml`/`.yml` into a KB (`EDITABLE_EXTENSIONS`), and the
   * store browser listed the result — while the injector's extension set
   * excluded them, so the doc a human wrote in the product was invisible to
   * every run and nothing said so. The authoring surface must not offer a
   * dead-end format; structured docs inject.
   */
  it("injects the structured formats the in-app editor can author (.json/.yaml/.yml)", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "contract.json"), '{"MARKER":"JSON"}', "utf8");
    writeFileSync(path.join(kbDir, "config.yaml"), "marker: YAML", "utf8");
    writeFileSync(path.join(kbDir, "other.yml"), "marker: YML", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain('{"MARKER":"JSON"}');
    expect(body).toContain("marker: YAML");
    expect(body).toContain("marker: YML");
  });

  it("skips dotfiles and dot-directories", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, ".hidden.md"), "MARKER-HIDDEN", "utf8");
    const dotDir = path.join(kbDir, ".git");
    mkdirSync(dotDir, { recursive: true });
    writeFileSync(path.join(dotDir, "config.md"), "MARKER-GIT", "utf8");
    writeFileSync(path.join(kbDir, "real.md"), "MARKER-REAL", "utf8");
    const body = readKbBody("notes", dataRoot);
    expect(body).toContain("MARKER-REAL");
    expect(body).not.toContain("MARKER-HIDDEN");
    expect(body).not.toContain("MARKER-GIT");
  });

  it("returns '' for an absent KB folder (no throw)", () => {
    const { dataRoot } = freshKb();
    expect(readKbBody("does-not-exist", dataRoot)).toBe("");
  });

  it("bounds total injected text at the budget and appends an honest truncation marker", () => {
    const { dataRoot, kbDir } = freshKb();
    // two docs that together blow a tiny budget — order is by relative path
    writeFileSync(path.join(kbDir, "a.md"), "A".repeat(50), "utf8");
    writeFileSync(path.join(kbDir, "b.md"), "B".repeat(50), "utf8");
    const body = readKbBody("notes", dataRoot, 40);
    expect(body.length).toBeLessThan(50 + 50 + 200); // clipped, not full
    expect(body).toContain("knowledge base truncated");
  });

  it("exposes a sane default budget", () => {
    expect(KB_INJECTION_BUDGET).toBe(24_000);
  });

  it("P14-KM-05: a KB that fits NOTHING still says so instead of vanishing", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "a.md"), "A".repeat(500), "utf8");
    writeFileSync(path.join(kbDir, "b.md"), "B".repeat(500), "utf8");
    // The shared 24k budget is spent by the KBs ahead of this one, so the
    // caller passes what's left. The old `parts.length > 0` guard suppressed
    // both the marker AND the warn in exactly this branch, so the KB was
    // dropped with zero signal anywhere.
    const body = readKbBody("notes", dataRoot, 5);
    expect(body).toContain("omitted entirely");
    expect(body).toContain("2 docs dropped");
    expect(body).not.toContain("AAAA");
  });

  it("an exhausted budget (0 chars left) is reported, not silently skipped", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "a.md"), "A".repeat(50), "utf8");
    expect(readKbBody("notes", dataRoot, 0)).toContain("omitted entirely");
  });

  it("a KB whose docs are all EMPTY injects nothing and claims no budget drop", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "blank.md"), "   \n\n", "utf8");
    expect(readKbBody("notes", dataRoot)).toBe("");
  });

  it("isInjectableKbDoc is the predicate the org doc count shares", () => {
    for (const name of ["a.md", "b.MDX", "c.txt", "d.rst", "e.json", "f.yaml", "g.yml"]) {
      expect(isInjectableKbDoc(name)).toBe(true);
    }
    for (const name of ["contract.pdf", "diagram.png", ".hidden.md"]) {
      expect(isInjectableKbDoc(name)).toBe(false);
    }
  });

  /**
   * C5/pass-16 containment. `collectKbDocs` realpath's the ROOT and then checks
   * every visited dir against it — so when the KB folder is ITSELF a symlink,
   * containment was measured against the link's TARGET and the whole target
   * tree was injected as trusted agent context. Every other store path refuses
   * to follow a link out of the store (P14-RV-02, assertInsideRoot).
   */
  it("refuses a KB folder that is a symlink out of the store", () => {
    const { dataRoot } = freshKb();
    const outside = mkdtempSync(path.join(tmpdir(), "viberr-outside-"));
    writeFileSync(path.join(outside, "secret.md"), "MARKER-OUTSIDE", "utf8");
    symlinkSync(outside, path.join(dataRoot, "kb", "linked"));
    const detailed = readKbBodyDetailed("linked", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved?.reason).toContain("symlink");
    expect(readKbBody("linked", dataRoot)).not.toContain("MARKER-OUTSIDE");
  });
});

/**
 * C1/pass-16 — a KB grant that resolves to nothing must reach the RUN, not only
 * a server log. The MCP leg has reported structured misses since P14-LV-09;
 * this is the KB half of the same honesty rule.
 */
describe("readKbBodyDetailed / readKbBodies — structured misses (C1)", () => {
  it("reports a missing KB folder as a structured unresolved grant", () => {
    const { dataRoot } = freshKb();
    const detailed = readKbBodyDetailed("renamed-away", dataRoot);
    expect(detailed.body).toBe("");
    expect(detailed.unresolved).toEqual({
      name: "renamed-away",
      reason: "no knowledge-base folder by that name in the store",
    });
  });

  it("reports an EMPTY KB folder (the grant is attached, the content is not)", () => {
    const { dataRoot } = freshKb("hollow");
    expect(readKbBodyDetailed("hollow", dataRoot).unresolved?.name).toBe("hollow");
  });

  it("a resolvable KB carries NO unresolved row", () => {
    const { dataRoot, kbDir } = freshKb();
    writeFileSync(path.join(kbDir, "a.md"), "MARKER", "utf8");
    expect(readKbBodyDetailed("notes", dataRoot).unresolved).toBeUndefined();
  });

  it("readKbBodies spends ONE shared budget and collects every miss", () => {
    const { dataRoot, kbDir } = freshKb("first");
    writeFileSync(path.join(kbDir, "a.md"), "A".repeat(300), "utf8");
    const second = path.join(dataRoot, "kb", "second");
    mkdirSync(second, { recursive: true });
    writeFileSync(path.join(second, "b.md"), "B".repeat(300), "utf8");

    const set = readKbBodies(["first", "second", "ghost"], dataRoot, 320);
    // The first KB spends the shared budget; the second announces itself.
    expect(set.parts[0]!.name).toBe("first");
    expect(set.parts[1]!.body).toContain("omitted entirely");
    expect(set.unresolved.map((u) => u.name)).toEqual(["second", "ghost"]);
  });
});

/* ------------- C5-followup: one list, three places that need it ----------- */

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

  it("the three consumers all resolve to the same set", async () => {
    // Imported, not re-parsed: the point is that these are the SAME object now.
    const shared = await import("~/shared/text/store-extensions");
    const editor = await import("~/server/org/store-files.server");
    expect(STORE_TEXT_EXTENSIONS).toBe(shared.STORE_TEXT_EXTENSIONS);
    expect(new Set(shared.STORE_TEXT_EXTENSION_LIST)).toEqual(
      new Set(STORE_TEXT_EXTENSIONS),
    );
    // `store-files.server` no longer exports a list of its own to compare —
    // that IS the fix — so assert the module simply loads against the shared
    // set without redeclaring one (the scan above proves the negative).
    expect(editor.readStoreDoc).toBeTypeOf("function");
  });
});
