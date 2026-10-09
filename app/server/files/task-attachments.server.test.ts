import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_UPLOAD_BYTES,
  attachmentClaimsInFlight,
  attachmentNamesSince,
  countTaskAttachments,
  isBrowserWorkingArtifact,
  listTaskAttachments,
  pruneBrowserWorkingArtifacts,
  readTaskAttachment,
  resolveTaskAttachment,
  savedFilesText,
  servedFileResponse,
  withAttachmentClaims,
  writeTaskAttachment,
} from "./task-attachments.server";

/** R19-19 — the attachments read side: directory-is-truth listing, traversal
 *  containment, and the inline whitelist that keeps stored HTML inert. */

let root: string;

/** What every serving route answers for a stored file of this name: its type,
 *  and whether a browser renders it on the app origin or saves it. */
function served(name: string) {
  const res = servedFileResponse(new Request("http://viberr.test/f"), name, new Uint8Array());
  return {
    type: res.headers.get("content-type"),
    inline: res.headers.get("content-disposition")!.startsWith("inline"),
  };
}

function seed(files: Record<string, { at: number }>): void {
  const dir = path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments");
  mkdirSync(dir, { recursive: true });
  for (const [name, meta] of Object.entries(files)) {
    const p = path.join(dir, name);
    writeFileSync(p, `content of ${name}`);
    utimesSync(p, new Date(meta.at), new Date(meta.at));
  }
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("listTaskAttachments", () => {
  it("returns [] when the task has no attachments dir (the common case)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(listTaskAttachments("p1", "VIB-1", root)).toEqual([]);
  });

  it("lists files newest-first, skipping dotfiles and directories", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "old-shot.png": { at: 1_000_000_000_000 },
      "new-shot.png": { at: 2_000_000_000_000 },
      ".DS_Store": { at: 3_000_000_000_000 },
    });
    mkdirSync(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "sub"),
    );
    const names = listTaskAttachments("p1", "VIB-1", root).map((a) => a.name);
    expect(names).toEqual(["new-shot.png", "old-shot.png"]);
    const first = listTaskAttachments("p1", "VIB-1", root)[0]!;
    expect(first.size).toBeGreaterThan(0);
    expect(first.modifiedAt).toContain("2033");
  });
});

// C8: listTaskAttachments caps its return at LIST_CAP (100) with nothing
// telling a caller the store holds more. countTaskAttachments is the
// sibling that answers the true count, cheaply (dirent type check, no
// per-file stat) — kept separate so listTaskAttachments's shape (and every
// existing caller) stays untouched.
describe("countTaskAttachments", () => {
  it("returns 0 when the task has no attachments dir (the common case)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("counts files, skipping dotfiles and directories, matching the list length under the cap", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "old-shot.png": { at: 1_000_000_000_000 },
      "new-shot.png": { at: 2_000_000_000_000 },
      ".DS_Store": { at: 3_000_000_000_000 },
    });
    mkdirSync(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "sub"),
    );
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(2);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(
      listTaskAttachments("p1", "VIB-1", root).length,
    );
  });

  it("keeps counting past LIST_CAP, unlike listTaskAttachments's capped return", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const files: Record<string, { at: number }> = {};
    for (let i = 0; i < 110; i++) {
      files[`shot-${i}.png`] = { at: 1_000_000_000_000 + i };
    }
    seed(files);
    expect(listTaskAttachments("p1", "VIB-1", root)).toHaveLength(100);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(110);
  });
});

describe("resolveTaskAttachment", () => {
  it("resolves a plain name inside the attachments dir", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const abs = resolveTaskAttachment("p1", "VIB-1", "shot.png", root);
    expect(abs).toBe(
      path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments", "shot.png"),
    );
  });

  it("REFUSES traversal — separators, dot-segments, absolute paths", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    for (const bad of ["../task.md", "..", "a/b.png", "a\\b.png", "/etc/passwd", ""]) {
      expect(() => resolveTaskAttachment("p1", "VIB-1", bad, root)).toThrow();
    }
  });
});

describe("what the serving routes answer (servedFileResponse)", () => {
  it("whitelists images/pdf/text inline", () => {
    expect(served("shot.png")).toEqual({
      type: "image/png",
      inline: true,
    });
    expect(served("Report.PDF").inline).toBe(true);
    expect(served("notes.txt").type).toContain("text/plain");
  });

  it("NEVER renders html/svg/unknown inline — stored pages must not execute on the app origin", () => {
    for (const name of ["page.html", "logo.svg", "payload.xhtml", "run.bin", "noext"]) {
      const { type, inline } = served(name);
      expect(inline).toBe(false);
      expect(type).toBe("application/octet-stream");
    }
  });
});

describe("attachmentNamesSince (P21 — a run's own files)", () => {
  it("names files written at-or-after the run start, newest first", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({
      "before-run.png": { at: Date.parse("2026-08-20T01:00:00.000Z") },
      "during-1.png": { at: Date.parse("2026-08-20T02:00:00.000Z") },
      "during-2.yml": { at: Date.parse("2026-08-20T02:30:00.000Z") },
    });
    expect(
      attachmentNamesSince("p1", "VIB-1", "2026-08-20T01:30:00.000Z", root),
    ).toEqual(["during-2.yml", "during-1.png"]);
  });

  it("claims nothing on an unparseable window start", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({ "shot.png": { at: Date.parse("2026-08-20T02:00:00.000Z") } });
    expect(attachmentNamesSince("p1", "VIB-1", "not-a-date", root)).toEqual([]);
  });

  it("returns [] when the task has no attachments dir", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    expect(
      attachmentNamesSince("p1", "VIB-1", "2026-08-20T00:00:00.000Z", root),
    ).toEqual([]);
  });
});

// Ruling 78 (owner ask 2026-08-31): the browser MCP's machine-stamped working
// files (page-*.yml aria snapshots, console-*.log dumps) land in the store
// because --output-dir IS the store. They are pruned at run completion unless
// the run cited the exact filename; visual evidence always stays.
describe("browser working artifacts (ruling 78)", () => {
  it("classifies machine-stamped non-visual outputs, and nothing else", () => {
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-03-204Z.yml")).toBe(true);
    expect(isBrowserWorkingArtifact("console-2026-08-31T15-05-03-056Z.log")).toBe(true);
    // Visual evidence never counts, however the tool named it.
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-18-081Z.png")).toBe(false);
    expect(isBrowserWorkingArtifact("element-2026-08-31T15-06-38-205Z.png")).toBe(false);
    expect(isBrowserWorkingArtifact("page-2026-08-31T15-05-18-081Z.pdf")).toBe(false);
    // Deliberately named files never match the machine stamp.
    expect(isBrowserWorkingArtifact("review-notes.yml")).toBe(false);
    expect(isBrowserWorkingArtifact("notes.txt")).toBe(false);
    // Review: the stamp itself classifies, not a prefix allowlist — a future
    // MCP tool's sibling artifact must not start drowning the panel again.
    expect(isBrowserWorkingArtifact("snapshot-2026-08-31T15-05-03-204Z.yml")).toBe(true);
    expect(isBrowserWorkingArtifact("trace-2026-08-31T15-05-03-204Z.zip")).toBe(true);
  });

  it("a name already gone from disk counts as pruned, never as kept (honesty)", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    seed({ "console-2026-08-31T15-05-03-056Z.log": { at: 2_000_000_000_000 } });
    const ghost = "console-2026-08-31T15-06-00-000Z.log"; // in names, not on disk
    const result = pruneBrowserWorkingArtifacts(
      "p1",
      "VIB-1",
      ["console-2026-08-31T15-05-03-056Z.log", ghost],
      "",
      root,
    );
    // Both end up pruned: one really deleted, the ghost acknowledged as gone —
    // the producing event must never claim a file the directory does not hold.
    expect(result.pruned).toEqual([
      "console-2026-08-31T15-05-03-056Z.log",
      ghost,
    ]);
    expect(result.kept).toEqual([]);
  });

  it("the run window is UNCAPPED — the display cap must not starve the prune", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const files: Record<string, { at: number }> = {};
    for (let i = 0; i < 105; i++) {
      files[`console-2026-08-31T15-05-03-${String(i).padStart(3, "0")}Z.log`] = {
        at: 2_000_000_000_000 + i * 1000,
      };
    }
    seed(files);
    const names = attachmentNamesSince(
      "p1",
      "VIB-1",
      new Date(1_999_999_999_999).toISOString(),
      root,
    );
    expect(names).toHaveLength(105);
  });

  it("prunes uncited artifacts from disk, keeps cited ones and everything else", () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const cited = "page-2026-08-31T15-05-03-204Z.yml";
    const uncited = "console-2026-08-31T15-05-03-056Z.log";
    const shot = "page-2026-08-31T15-05-18-081Z.png";
    seed({
      [cited]: { at: 2_000_000_000_000 },
      [uncited]: { at: 2_000_000_000_000 },
      [shot]: { at: 2_000_000_000_000 },
      "notes.txt": { at: 2_000_000_000_000 },
    });
    const result = pruneBrowserWorkingArtifacts(
      "p1",
      "VIB-1",
      [cited, uncited, shot, "notes.txt"],
      "Verified in the browser. The aria tree is in `" + cited + "`.",
      root,
    );
    expect(result.pruned).toEqual([uncited]);
    expect(result.kept).toEqual([cited, shot, "notes.txt"]);
    const left = listTaskAttachments("p1", "VIB-1", root).map((a) => a.name);
    expect(left).not.toContain(uncited);
    expect(left).toContain(cited);
    expect(left).toContain(shot);
  });

  it("yaml/csv serve as inert text for the read-only viewer, never renderable", () => {
    expect(served("page-snap.yml").type).toContain("text/plain");
    expect(served("page-snap.yml").inline).toBe(true);
    expect(served("data.csv").type).toContain("text/plain");
  });
});

/**
 * F39-6 (pass 39): the human writer. The directory had three readers and no way
 * for a PERSON to put a file in it — viberr's own controller planned around a
 * human attaching an authoritative fixture, and the only route was writing into
 * the data volume by hand.
 */
describe("writeTaskAttachment", () => {
  const setRoot = () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    mkdirSync(path.join(root, "projects", "p1", "tasks", "VIB-1"), {
      recursive: true,
    });
    return root;
  };
  const write = (name: string, body = "kind: Task\n") =>
    writeTaskAttachment("p1", "VIB-1", name, new TextEncoder().encode(body), root);

  it("writes the file, creates the directory, and reports a replace", () => {
    setRoot();
    const first = write("fixture.yaml");
    expect(first).toEqual({ name: "fixture.yaml", bytes: 11, replaced: false });
    expect(listTaskAttachments("p1", "VIB-1", root).map((a) => a.name)).toEqual([
      "fixture.yaml",
    ]);
    // The read side must be able to serve exactly what the write side accepted.
    expect(served("fixture.yaml").inline).toBe(true);
    const again = write("fixture.yaml", "kind: Workspace\n");
    expect(again.replaced).toBe(true);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(1);
  });

  it("refuses a traversing or separator-bearing name", () => {
    setRoot();
    for (const bad of ["../escape.txt", "sub/dir.txt", "..", "a/../../b.txt"]) {
      // CANARY: write to `path.join(dir, name)` instead of through
      // `resolveStoreSegment` and these land outside the task directory.
      expect(() => write(bad), bad).toThrow();
    }
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("refuses a dot-prefixed name, which the scanner would then hide", () => {
    setRoot();
    expect(() => write(".hidden.txt")).toThrow(/cannot start with a dot/);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("ruling 76: stores a file of any kind, and serves one a browser could run only as a download", () => {
    setRoot();
    // CANARY: put an extension check back in `checkAttachmentUpload` and a
    // person's `.tf` or `.docx` is refused before any agent could read it.
    const kinds = ["main.tf", "report.docx", "page.html", "icon.svg", "run.js", "tool.sh", "blob.bin", "Dockerfile"];
    for (const name of kinds) write(name);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(kinds.length);
    // What keeps a stored page from running is the serving route's inline
    // list, never the store's: every kind a browser would execute downloads.
    for (const name of ["page.html", "icon.svg", "run.js"]) {
      expect(served(name), name).toEqual({ type: "application/octet-stream", inline: false });
    }
  });

  it("refuses a file over the size cap", () => {
    setRoot();
    const tooBig = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    // Named by the reason a reader can act on, not by the extension check.
    expect(() =>
      writeTaskAttachment("p1", "VIB-1", "big.txt", tooBig, root),
    ).toThrow(/may be up to/);
    expect(countTaskAttachments("p1", "VIB-1", root)).toBe(0);
  });

  it("refuses an empty name", () => {
    setRoot();
    expect(() => write("   ")).toThrow(/Give the file a name/);
  });
});

/**
 * Ruling 19: every agent in the group can write a task's attachments folder
 * (ruling 15), so a name in it can be a link an agent planted to a file only
 * the server may read (another person's credentials, the store's state). No
 * reader of an attachment follows one, and no writer writes through one.
 */
describe("ruling 76: an attachment's name across Unicode forms", () => {
  const composed = "İçerik ve Eğitim Üretim Teklifi.txt";
  const decomposed = composed.normalize("NFD");
  const text = (value: string) => new TextEncoder().encode(value);

  it("stores an upload under the composed name, whatever form the browser sent", () => {
    // CANARY: drop `storedFileName` from `checkAttachmentUpload` and the file
    // keeps the decomposed name a Mac sent, which no agent's typed path opens.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-675-"));
    try {
      const written = writeTaskAttachment("p1", "VIB-1", decomposed, text("the estate"), root);
      expect(written.name).toBe(composed);
      expect(readdirSync(path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments"))).toEqual([composed]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a file stored decomposed by the composed name, and an upload of that name replaces it", () => {
    // CANARY: resolve attachments with `resolveStoreSegment` again and the
    // composed name reads nothing on a disk that keeps names byte for byte,
    // and the upload lands beside the old file as a second one named alike.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-675-"));
    try {
      const dir = path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, decomposed), "stored before the ruling");
      expect(path.basename(resolveTaskAttachment("p1", "VIB-1", composed, root))).toBe(decomposed);
      expect(readTaskAttachment("p1", "VIB-1", composed, root)).toMatchObject({
        kind: "text",
        text: "stored before the ruling",
      });
      const again = writeTaskAttachment("p1", "VIB-1", composed, text("replaced"), root);
      expect(again).toEqual({ name: decomposed, bytes: 8, replaced: true });
      expect(readdirSync(dir)).toEqual([decomposed]);
      expect(readFileSync(path.join(dir, decomposed), "utf8")).toBe("replaced");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ruling 19: a link in the attachments folder is never followed", () => {
  function plant() {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    const dir = path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments");
    mkdirSync(dir, { recursive: true });
    const secret = path.join(root, "state-secret.json");
    writeFileSync(secret, '{"token":"server-only"}');
    symlinkSync(secret, path.join(dir, "notes.md"));
    return { dir, secret };
  }

  it("reads nothing through a link, for a reader or a citation", () => {
    // CANARY: read with readFileSync(abs) again and the server-only bytes
    // come back as the attachment's text.
    plant();
    expect(readTaskAttachment("p1", "VIB-1", "notes.md", root)).toBeNull();
    expect(savedFilesText("p1", "VIB-1", ["notes.md"], root)).toBe("");
  });

  it("replaces a link at the name it writes, and leaves the file it pointed at alone", () => {
    // CANARY: write with writeFileSync(abs, data) again and the secret file
    // is overwritten with the attachment's bytes.
    const { dir, secret } = plant();
    writeTaskAttachment("p1", "VIB-1", "notes.md", new TextEncoder().encode("# notes\n"), root);
    expect(readFileSync(secret, "utf8")).toBe('{"token":"server-only"}');
    expect(readFileSync(path.join(dir, "notes.md"), "utf8")).toBe("# notes\n");
  });
});

/**
 * Ruling 77: a person's upload, a relay and a take put a file on a task for
 * someone other than a run. The name is held until the entry that claims it is
 * written, and the file lands with that claim or not at all: a file left on
 * the task unclaimed is the next completion's to credit to its run.
 */
describe("ruling 77: a file put down for someone else", () => {
  const dir = () => path.join(root, "projects", "p1", "tasks", "VIB-1", "attachments");
  const bytes = (body: string) => new TextEncoder().encode(body);
  const setRoot = () => {
    root = mkdtempSync(path.join(tmpdir(), "viberr-attach-"));
    mkdirSync(path.join(root, "projects", "p1", "tasks", "VIB-1"), { recursive: true });
  };
  /** A writer's claim still to come: `open` lets it be written. */
  const pending = () => {
    let open!: () => void;
    const written = new Promise<void>((resolve) => (open = resolve));
    return { open, written };
  };

  it("is taken back up when its claim cannot be written: a new file removed, a replaced one put back", async () => {
    // CANARY: drop the take-back and `sample.csv` stays on the task with no
    // claim, and `notes.md` keeps the bytes nobody claimed.
    setRoot();
    writeTaskAttachment("p1", "VIB-1", "notes.md", bytes("# mine\n"), root);
    await expect(
      withAttachmentClaims(
        "p1",
        "VIB-1",
        ["sample.csv", "notes.md"],
        async (put) => {
          put("sample.csv", bytes("vm,cpu\n"));
          put("notes.md", bytes("# theirs\n"));
          throw new Error("the claim could not be written");
        },
        root,
      ),
    ).rejects.toThrow("the claim could not be written");
    expect(readdirSync(dir())).toEqual(["notes.md"]);
    expect(readFileSync(path.join(dir(), "notes.md"), "utf8")).toBe("# mine\n");
    expect(attachmentClaimsInFlight("p1", "VIB-1").size).toBe(0);
  });

  it("stays once its claim is written, and nothing set aside is left behind", async () => {
    // CANARY: skip `keep` and every replace leaves a `.viberr-prev-` file.
    setRoot();
    writeTaskAttachment("p1", "VIB-1", "notes.md", bytes("# mine\n"), root);
    await withAttachmentClaims("p1", "VIB-1", ["notes.md"], async (put) => {
      expect(put("notes.md", bytes("# theirs\n")).replaced).toBe(true);
    }, root);
    expect(readdirSync(dir())).toEqual(["notes.md"]);
    expect(readFileSync(path.join(dir(), "notes.md"), "utf8")).toBe("# theirs\n");
  });

  it("stays held for its writer when another writer on the task finishes first", async () => {
    // A relay of text alone holds no name, and it found the entry a person's
    // upload made. The upload finished and its entry went; the operator's
    // take made a fresh one. The relay, finishing, must not drop the take's.
    // CANARY: delete the task's entry whenever the finishing writer's own map
    // is empty, and `b.xlsx` is released while the take is still writing it.
    setRoot();
    const upload = pending();
    const relay = pending();
    const take = pending();
    const uploading = withAttachmentClaims("p1", "VIB-1", ["a.csv"], () => upload.written, root);
    const relaying = withAttachmentClaims("p1", "VIB-1", [], () => relay.written, root);
    upload.open();
    await uploading;
    const taking = withAttachmentClaims("p1", "VIB-1", ["b.xlsx"], () => take.written, root);
    relay.open();
    await relaying;
    expect(attachmentClaimsInFlight("p1", "VIB-1")).toEqual(new Set(["b.xlsx"]));
    take.open();
    await taking;
    expect(attachmentClaimsInFlight("p1", "VIB-1").size).toBe(0);
  });
});

/**
 * Ruling 79: a reader takes a file by its bytes, not its name. Any file whose
 * head holds no NUL byte (git's own `-text` test) reads as text, and a binary
 * one is named, with what the reader takes instead.
 */
describe("ruling 79: readTaskAttachment reads any text file", () => {
  it("reads a text file of any name, and names a binary one rather than guessing", () => {
    // CANARY: gate the text read on `READABLE_TEXT_EXTENSIONS` again and the
    // `.tf` is refused as an unknown kind.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-574-"));
    try {
      const put = (name: string, bytes: Uint8Array) => writeTaskAttachment("p1", "VIB-1", name, bytes, root);
      put("main.tf", new TextEncoder().encode('resource "aws_instance" "web" {}\n'));
      put("report.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
      const tf = readTaskAttachment("p1", "VIB-1", "main.tf", root);
      expect(tf).toMatchObject({ kind: "text", text: 'resource "aws_instance" "web" {}\n' });
      const docx = readTaskAttachment("p1", "VIB-1", "report.docx", root);
      expect(docx).toEqual({
        unreadable: expect.stringContaining("`report.docx` is a binary .docx file (6 bytes): its bytes are not text."),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ruling 79: a text file's embedded files are named, not spelled out", () => {
  it("reads a self-contained page as its markup, with each embedded image left out by its length", () => {
    // CANARY: read the bytes as text without `withoutEmbeddedFiles` and the
    // first page is base64 from its first line to its last, as it was for the
    // controller on AWSC-117's report, and `nextOffset` sends the reader on
    // through seventeen more pages of it.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-676-"));
    try {
      const image = "iVBORw0KGgo".repeat(6_000);
      const dot = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      const page =
        `<style>@page{background-image:url(data:image/png;base64,${image})}</style>\n` +
        `<img class="logo" src="data:image/jpeg;base64,${image}==">\n` +
        `<img class="dot" src="data:image/gif;base64,${dot}">\n` +
        "<h1>1. Amaç ve Kapsam</h1>\n";
      writeTaskAttachment("p1", "VIB-1", "report.html", new TextEncoder().encode(page), root);
      const read = readTaskAttachment("p1", "VIB-1", "report.html", root);
      expect(read).toEqual({
        kind: "text",
        name: "report.html",
        bytes: new TextEncoder().encode(page).byteLength,
        truncated: false,
        text:
          "<style>@page{background-image:url(data:image/png;base64,[66,000 base64 characters left out])}</style>\n" +
          '<img class="logo" src="data:image/jpeg;base64,[66,002 base64 characters left out]">\n' +
          `<img class="dot" src="data:image/gif;base64,${dot}">\n` +
          "<h1>1. Amaç ve Kapsam</h1>\n",
        leftOut:
          "2 embedded files are left out of this text (132,002 base64 characters in all), each marked where it stands. " +
          "Offsets count the text as it is returned here; the file on disk is whole.",
      });
      // The file itself keeps every byte.
      expect(readFileSync(resolveTaskAttachment("p1", "VIB-1", "report.html", root), "utf8")).toBe(page);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a page with one very large embedded file, and pages the text that is left by its own offsets", () => {
    // CANARY: match the payload as one `{256,}` run and a 6-million-character
    // picture overflows the engine's stack: the file reads as an error at
    // every offset, where it paged before this ruling.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-676-"));
    try {
      const picture = "QUJD".repeat(1_500_000);
      const rows = Array.from({ length: 4_000 }, (_, i) => `<tr><td>row ${i}</td></tr>`).join("\n");
      const page = `<img src="data:image/png;base64,${picture}">\n${rows}\n`;
      writeTaskAttachment("p1", "VIB-1", "big.html", new TextEncoder().encode(page), root);
      const whole = `<img src="data:image/png;base64,[6,000,000 base64 characters left out]">\n${rows}\n`;
      const first = readTaskAttachment("p1", "VIB-1", "big.html", root);
      if (!first || !("kind" in first) || first.kind !== "text") throw new Error("expected text");
      expect(first.truncated).toBe(true);
      expect(first.text).toBe(whole.slice(0, first.nextOffset));
      // CANARY: page the file's own text and offer an offset into the text
      // returned, and the second page starts inside the picture.
      const second = readTaskAttachment("p1", "VIB-1", "big.html", root, first.nextOffset);
      if (!second || !("kind" in second) || second.kind !== "text") throw new Error("expected text");
      expect(second.offset).toBe(first.nextOffset);
      expect(second.text).toBe(whole.slice(first.nextOffset!, second.nextOffset ?? whole.length));
      expect(second.leftOut).toBe(first.leftOut);
      // Past the end of the text as it is returned, not of the file.
      expect(readTaskAttachment("p1", "VIB-1", "big.html", root, whole.length)).toEqual({
        unreadable: `\`big.html\` reads as ${whole.length.toLocaleString("en-US")} characters; offset ${whole.length.toLocaleString("en-US")} is past its end.`,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says nothing was left out of a file that embeds nothing", () => {
    // CANARY: set `leftOut` on every text read and a plain file claims a cut
    // it never had.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-676-"));
    try {
      writeTaskAttachment("p1", "VIB-1", "notes.md", new TextEncoder().encode("base64 is an encoding\n"), root);
      expect(readTaskAttachment("p1", "VIB-1", "notes.md", root)).toEqual({
        kind: "text",
        name: "notes.md",
        bytes: 22,
        truncated: false,
        text: "base64 is an encoding\n",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A one-page PDF drawing `lines` in Helvetica, with a correct cross-reference
 *  table, so `pdftotext` reads it as it reads a calculator export. No lines
 *  makes a page with no text layer. */
function onePagePdf(lines: readonly string[]): Uint8Array {
  const draw = lines.map((line, i) => `${i ? "0 -16 Td " : ""}(${line}) Tj`).join(" ");
  const stream = lines.length ? `BT /F1 12 Tf 72 720 Td ${draw} ET` : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/** The image installs poppler (ruling 42); a host without it skips these. */
const hasPdftotext = spawnSync("pdftotext", ["-v"]).error === undefined;

describe("ruling 214: a PDF attachment reads as its text", () => {
  it.skipIf(!hasPdftotext)("reads a calculator export's lines, and names a PDF with no text layer", () => {
    // Live on AWSC-85 the Estimate Judge reviewed a delivery whose PDF export
    // it could not open: "the attachment reader does not parse its binary
    // contents". CANARY: drop the PDF branch from the reader and the export is
    // refused as a binary .pdf.
    const root = mkdtempSync(path.join(tmpdir(), "viberr-629-"));
    try {
      const put = (name: string, bytes: Uint8Array) => writeTaskAttachment("p1", "VIB-1", name, bytes, root);
      put("My-Estimate.pdf", onePagePdf(["Amazon EC2   73.58 USD", "Total monthly   1,704.11 USD"]));
      put("scan.pdf", onePagePdf([]));
      const pdf = readTaskAttachment("p1", "VIB-1", "My-Estimate.pdf", root);
      expect(pdf).toMatchObject({ kind: "text", name: "My-Estimate.pdf", truncated: false });
      const text = pdf && "text" in pdf ? pdf.text : "";
      expect(text).toContain("Amazon EC2");
      expect(text).toContain("1,704.11 USD");
      expect(readTaskAttachment("p1", "VIB-1", "scan.pdf", root)).toEqual({
        unreadable: expect.stringMatching(/^`scan\.pdf` is a PDF with no text layer .*`pdftoppm`/),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
