import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { taskAttachmentsDir } from "./file-store-root.server";
import { keepDelivery, keptDeliveryChanges } from "./kept-deliveries.server";
import { writeTaskAttachment } from "./task-attachments.server";

/**
 * Ruling 703: what a rework changed, read from the deliveries Viberr kept
 * (ruling 597). The reviewer sent to judge the rework is told this, so the
 * answer has to be the bytes' own.
 */

const FIRST = "2026-10-08T15:03:04.630Z";
const SECOND = "2026-10-08T15:32:35.992Z";

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => ctx.cleanup());

const text = (value: string) => new TextEncoder().encode(value);

function save(name: string, value: string): void {
  writeTaskAttachment(store.slug, "VIB-1", name, text(value), store.dataRoot);
}

function keep(stamp: string, names: string[]): void {
  expect(keepDelivery(store.slug, "VIB-1", stamp, names, store.dataRoot)).toEqual([...names].sort());
}

const changes = (from = FIRST, to = SECOND) =>
  keptDeliveryChanges(store.slug, "VIB-1", from, to, store.dataRoot);

describe("ruling 703: two kept deliveries set against each other", () => {
  it("sorts every file into changed, new, gone or unchanged, by its bytes", () => {
    // BLOG-8's shape: a label changed in the drawing and its alt text in the
    // piece, the cover was not touched, one file was dropped, one was added.
    // Canary: compare names alone, or sizes alone.
    save("post.md", "The copy tool asks whether the file's text holds a placeholder.");
    save("diagram.svg", "<svg><text>the file's text</text></svg>");
    save("cover.png", "cover bytes");
    save("draft.md", "an early draft");
    // Same length as its rework below: the size says nothing here.
    save("notes.md", "words: 629");
    keep(FIRST, ["post.md", "diagram.svg", "cover.png", "draft.md", "notes.md"]);

    save("post.md", "The copy tool asks whether the template's text holds a placeholder.");
    save("diagram.svg", "<svg><text>the template's text</text></svg>");
    save("notes.md", "words: 630");
    save("sources.md", "S1");
    keep(SECOND, ["post.md", "diagram.svg", "cover.png", "notes.md", "sources.md"]);

    expect(changes()).toEqual({
      changed: ["diagram.svg", "notes.md", "post.md"],
      added: ["sources.md"],
      removed: ["draft.md"],
      same: ["cover.png"],
    });
  });

  it("leaves out the pictures Viberr makes of a delivered page, and keeps an agent's own file of that ending", () => {
    // `post.md.capture-phone.png` pictures a page in the folder: Viberr's
    // own, remade at every delivery. `landing.capture-phone.png` pictures
    // nothing the folder holds: an agent's screenshot, a delivered file.
    // Canary: list every name, or drop every name with that ending.
    save("post.md", "one");
    save("post.md.capture-phone.png", "picture of one");
    save("landing.capture-phone.png", "a screenshot");
    keep(FIRST, ["post.md", "post.md.capture-phone.png", "landing.capture-phone.png"]);
    save("post.md", "two");
    save("post.md.capture-phone.png", "picture of two");
    keep(SECOND, ["post.md", "post.md.capture-phone.png", "landing.capture-phone.png"]);
    expect(changes()).toEqual({
      changed: ["post.md"],
      added: [],
      removed: [],
      same: ["landing.capture-phone.png"],
    });
  });

  it("answers null when either delivery was not kept, or a stamp cannot be one", () => {
    // A task delivered before ruling 597 has no folder for its first delivery.
    // Canary: answer an empty comparison instead, and a reviewer is told
    // nothing changed.
    save("post.md", "one");
    keep(SECOND, ["post.md"]);
    expect(changes(FIRST, SECOND)).toBeNull();
    expect(changes(SECOND, FIRST)).toBeNull();
    expect(changes("yesterday", SECOND)).toBeNull();
    expect(changes(SECOND, "")).toBeNull();
    expect(changes(SECOND, SECOND)).toEqual({ changed: [], added: [], removed: [], same: ["post.md"] });
  });

  it("reads the kept copies, not the attachments folder as it stands now", () => {
    // Canary: compare against the live attachments instead of the kept folder.
    save("post.md", "one");
    keep(FIRST, ["post.md"]);
    save("post.md", "two");
    keep(SECOND, ["post.md"]);
    writeFileSync(path.join(taskAttachmentsDir(store.slug, "VIB-1", store.dataRoot), "post.md"), "one");
    expect(changes()?.changed).toEqual(["post.md"]);
  });
});
