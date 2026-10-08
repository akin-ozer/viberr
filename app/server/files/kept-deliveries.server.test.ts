import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { taskAttachmentsDir } from "./file-store-root.server";
import { changesSinceKeptDelivery, keepDelivery } from "./kept-deliveries.server";
import { listTaskAttachmentNames, writeTaskAttachment } from "./task-attachments.server";

/**
 * Ruling 703: how the task's files stand against the delivery a reviewer
 * judged, read from the copy Viberr kept of it (ruling 597). The reviewer
 * sent to judge again is told this, so the answer has to be the bytes' own,
 * and about the folder the reviewer will open.
 */

const JUDGED = "2026-10-08T15:03:04.630Z";
const LATER = "2026-10-08T15:32:35.992Z";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => ctx.cleanup());

const text = (value: string) => new TextEncoder().encode(value);

function saveBytes(name: string, bytes: Uint8Array): void {
  writeTaskAttachment(store.slug, "VIB-1", name, bytes, store.dataRoot);
}

function save(name: string, value: string): void {
  saveBytes(name, text(value));
}

function keep(stamp: string, names: string[]): void {
  expect(keepDelivery(store.slug, "VIB-1", stamp, names, store.dataRoot)).toEqual([...names].sort());
}

const onTask = () => listTaskAttachmentNames(store.slug, "VIB-1", store.dataRoot);
const nothing = () => false;

const changes = (judged = JUDGED, now = onTask(), leftOut: (name: string) => boolean = nothing) =>
  changesSinceKeptDelivery(store.slug, "VIB-1", judged, now, leftOut, store.dataRoot);

describe("ruling 703: the task's files set against the delivery a reviewer judged", () => {
  it("sorts every file into changed, new, gone or unchanged, by its bytes", () => {
    // BLOG-8's shape: a label changed in the drawing and its alt text in the
    // piece, the cover was not touched, one file was dropped, one was added.
    // Canary: compare names alone, or sizes alone.
    save("post.md", "The copy tool asks whether the file's text holds a placeholder.");
    save("diagram.svg", "<svg><text>the file's text</text></svg>");
    save("cover.png", "cover bytes");
    save("draft.md", "an early draft");
    save("aside.md", "a second file that will go");
    // Same length as its rework below: the size says nothing here.
    save("notes.md", "words: 629");
    keep(JUDGED, ["post.md", "diagram.svg", "cover.png", "draft.md", "aside.md", "notes.md"]);

    save("post.md", "The copy tool asks whether the template's text holds a placeholder.");
    save("diagram.svg", "<svg><text>the template's text</text></svg>");
    save("notes.md", "words: 630");
    save("sources.md", "S1");

    expect(changes(JUDGED, ["post.md", "diagram.svg", "cover.png", "notes.md", "sources.md"])).toEqual({
      changed: ["diagram.svg", "notes.md", "post.md"],
      added: ["sources.md"],
      removed: ["aside.md", "draft.md"],
      same: ["cover.png"],
    });
  });

  it("reads the folder as it stands, not the kept copy of a later delivery", () => {
    // A file can change on the task without the delivery moving: a supporting
    // agent's first save of a name, a person's upload or removal. The copy
    // kept at the later stamp still holds the old cover; the reviewer opens
    // the folder. Canary: compare the two kept copies.
    save("post.md", "one");
    save("cover.png", "the cover");
    keep(JUDGED, ["post.md", "cover.png"]);
    save("post.md", "two");
    keep(LATER, ["post.md", "cover.png"]);
    save("cover.png", "A DIFFERENT COVER");
    save("request-path.png", "a second picture");
    expect(changes()).toEqual({
      changed: ["cover.png", "post.md"],
      added: ["request-path.png"],
      removed: [],
      same: [],
    });
  });

  it("leaves out of the kept side the pictures Viberr made of a page, and what the caller leaves out", () => {
    // `post.md.capture-phone.png` pictures a page in the kept folder: Viberr's
    // own. `landing.capture-phone.png` pictures nothing the folder holds: an
    // agent's screenshot, a delivered file. `review-notes.md` is the caller's
    // to leave out (a reviewer's own file).
    // Canary: list every kept name, or drop every name with that ending.
    save("post.md", "one");
    save("post.md.capture-phone.png", "picture of one");
    save("landing.capture-phone.png", "a screenshot");
    save("review-notes.md", "what the reviewer checked");
    keep(JUDGED, ["post.md", "post.md.capture-phone.png", "landing.capture-phone.png", "review-notes.md"]);
    expect(changes(JUDGED, ["post.md", "landing.capture-phone.png"], (name) => name === "review-notes.md")).toEqual({
      changed: [],
      added: [],
      removed: [],
      same: ["landing.capture-phone.png", "post.md"],
    });
    // Without the caller's rule the reviewer's file is a file like any other.
    expect(changes(JUDGED, ["post.md", "landing.capture-phone.png"])?.removed).toEqual(["review-notes.md"]);
  });

  it("one file under two Unicode forms of its name is one file, named as the folder has it now", () => {
    // Ruling 675: the store may hold a name decomposed, and a later save may
    // compose it. Canary: pair the names exactly, and the file is told as
    // both gone and new.
    const composed = "İçerik-teklifi.md";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const attachments = taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot);
    save("placeholder.md", "makes the folder");
    writeFileSync(path.join(attachments, decomposed), "the offer");
    keep(JUDGED, [decomposed]);
    expect(changes(JUDGED, [composed])).toEqual({ changed: [], added: [], removed: [], same: [composed] });
    // A folder that holds both forms as two files keeps them apart: the kept
    // file answers for one of them, and the other is a file it does not hold.
    // Canary: let two names claim the one kept file, and three names in come
    // out as two.
    expect(changes(JUDGED, [composed, decomposed, "other.md"])).toEqual({
      changed: [],
      // Code-unit order: the composed capital sorts after every ASCII name.
      added: ["other.md", composed],
      removed: [],
      same: [decomposed],
    });
  });

  it("compares files larger than one read in pieces, to the last byte", () => {
    // Canary: compare the first piece only.
    const big = new Uint8Array(64 * 1024 * 2 + 10).fill(7);
    saveBytes("render.bin", big);
    saveBytes("other.bin", big);
    keep(JUDGED, ["render.bin", "other.bin"]);
    const last = big.slice();
    last[last.length - 1] = 8;
    saveBytes("render.bin", last);
    expect(changes()).toEqual({ changed: ["render.bin"], added: [], removed: [], same: ["other.bin"] });
  });

  it("answers null when the judged delivery was not kept, or its stamp cannot be one", () => {
    // A task delivered before ruling 597 has no folder for that delivery.
    // Canary: answer a comparison with an empty kept side, and a reviewer is
    // told every file is new.
    save("post.md", "one");
    keep(LATER, ["post.md"]);
    expect(changes(JUDGED)).toBeNull();
    expect(changes("yesterday")).toBeNull();
    expect(changes("")).toBeNull();
    expect(changes(LATER)).toEqual({ changed: [], added: [], removed: [], same: ["post.md"] });
  });
});
