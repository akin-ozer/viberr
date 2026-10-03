import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import { withLegacyProposals } from "../../../test-support/kb-legacy-proposals";
import { resolveStoreTarget, saveKnowledgeBase } from "./resources.server";
import { writeStoreDoc } from "./store-files.server";
import { listKbProposals } from "./kb-proposals.server";
import {
  KB_CORRECTION_MAX_BYTES,
  KB_CORRECTION_MERGED_ACTION,
  KB_CORRECTION_UNDONE_ACTION,
  editKbPassage,
  listKbCorrections,
  mergeKbCorrection,
  undoKbCorrection,
  type MergeKbCorrectionInput,
} from "./kb-corrections.server";

/**
 * Ruling 498: an agent's knowledge-base correction is written into the
 * document as it is made, the record keeps what it replaced, and a person's
 * undo puts that back. The owner: "No human can approve all of these while
 * inspecting them thoroughly."
 */

let ctx: TestDbContext;
let store: TestStore;
const person = () => ({ userId: store.users.arda.id, label: "arda" });

async function seedKb(name: string, doc: string, body: string): Promise<string> {
  const { kb } = await saveKnowledgeBase(
    store.db,
    { name, refresh: "on change" },
    person(),
    { dataRoot: store.dataRoot },
  );
  const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
  const parts = doc.split("/");
  const file = parts.pop()!;
  writeStoreDoc(store.db, target, parts, file, body, person());
  return kb.dir;
}

const merge = (kb: string, input: Partial<MergeKbCorrectionInput>) =>
  mergeKbCorrection(
    store.db,
    {
      kb,
      doc: "facts.md",
      replaces: null,
      text: "x",
      evidence: "npx wrangler --version printed 4.139.0",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      filedBy: "Platform Engineer",
      actorRef: "agent:claude:platform-engineer",
      rulings: false,
      actor: { userId: null, label: "agent:claude:platform-engineer" },
      ...input,
    },
    { dataRoot: store.dataRoot },
  );

const undo = (id: string, reason: string | null = "Not what we run.", projectSlug = store.slug) =>
  undoKbCorrection(
    store.db,
    { id, projectSlug, reason, byName: "Arda Kaya" },
    person(),
    { dataRoot: store.dataRoot },
  );

const read = (kb: string, doc = "facts.md") =>
  readFileSync(path.join(store.dataRoot, "kb", kb, doc), "utf8");

const merged = async (kb: string, input: Partial<MergeKbCorrectionInput>) => {
  const r = await merge(kb, input);
  if (!r.ok) throw new Error(r.message);
  return r.correction;
};

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

describe("mergeKbCorrection", () => {
  it("writes the text in place of the exact passage, and the record keeps both for its board", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/\n");
    const c = await merged(kb, {
      replaces: "- T-003: wrangler 4.138.0",
      text: "- T-003: wrangler 4.139.0\n",
      rulings: true,
    });
    // A model's trailing newline is not part of the passage.
    expect(read(kb)).toBe("# Facts\n\n- T-003: wrangler 4.139.0\n- T-013: dist/server/\n");
    expect(c.id).toMatch(/^kc-[0-9a-f]{10}$/);
    const [row] = listAuditEvents(store.db, { action: KB_CORRECTION_MERGED_ACTION });
    expect(row).toMatchObject({ projectSlug: store.slug, taskKey: "VIB-1", subjectKind: "task" });
    expect(row?.details).toMatchObject({
      id: c.id,
      kb,
      doc: "facts.md",
      rulings: true,
      replaced: "- T-003: wrangler 4.138.0",
      text: "- T-003: wrangler 4.139.0",
      filedBy: "Platform Engineer",
      actorRef: "agent:claude:platform-engineer",
      // Ruling 466: UTF-8 bytes of what was written.
      bytes: 25,
    });
    expect(listKbCorrections(store.db, { projectSlug: store.slug })).toEqual([
      expect.objectContaining({ id: c.id, taskKey: "VIB-1", undone: null, evidence: "npx wrangler --version printed 4.139.0" }),
    ]);
    // CANARY: drop the project filter and another board lists this one.
    expect(listKbCorrections(store.db, { projectSlug: "another-board" })).toEqual([]);
  });

  it("adds text at the end of the settled text, before a proposals section the document still holds", async () => {
    const kb = await seedKb(
      "rulings",
      "conventions.md",
      withLegacyProposals("# Conventions\n\n- Quote every path.\n", [{ taskKey: "VIB-2", correction: "Old one.", evidence: "e" }]),
    );
    await merged(kb, { doc: "conventions.md", text: "- Pass `--` before any argument a person supplies." });
    const body = read(kb, "conventions.md");
    expect(body.startsWith(
      "# Conventions\n\n- Quote every path.\n\n- Pass `--` before any argument a person supplies.\n\n## Proposed corrections (not binding)\n",
    )).toBe(true);
    // The unmerged proposal still reads back whole.
    expect(listKbProposals(store.dataRoot).map((p) => p.correction)).toEqual(["Old one."]);
  });

  it("refuses a passage that is not in the document exactly as sent, handing back its closest line, and writes nothing", async () => {
    const kb = await seedKb("runbook", "facts.md", "# Step 1\n\n5. **Non-production branch builds:** on\n6. Deploy.\n");
    const before = read(kb);
    const r = await merge(kb, { replaces: "Non-production branch builds: on", text: "5. **Non-production branch builds:** off" });
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : r.message;
    expect(message).toContain("is not in");
    expect(message).toContain("Nothing was written.");
    // The document's own line, fenced, for the agent to copy.
    expect(message).toContain("````\n5. **Non-production branch builds:** on\n````");
    expect(read(kb)).toBe(before);
    expect(listAuditEvents(store.db, { action: KB_CORRECTION_MERGED_ACTION })).toEqual([]);
  });

  it("counts only the settled text: a passage a proposal entry quotes is not in the document", async () => {
    const kb = await seedKb(
      "dossier",
      "facts.md",
      withLegacyProposals("# Facts\n\n- T-003: wrangler 4.138.0\n", [
        { taskKey: "VIB-1", line: "T-003: wrangler 4.138.0", correction: "It is wrangler 4.139.0.", evidence: "e" },
      ]),
    );
    // CANARY: search the whole document and this replaces the entry's words.
    const r = await merge(kb, { replaces: "It is wrangler 4.139.0.", text: "It is 4.140.0." });
    expect(r.ok).toBe(false);
    // The settled line itself is replaced, and the entry quoting it is left be.
    await merged(kb, { replaces: "- T-003: wrangler 4.138.0", text: "- T-003: wrangler 4.139.0" });
    expect(read(kb)).toContain("# Facts\n\n- T-003: wrangler 4.139.0\n\n## Proposed corrections");
    expect(read(kb)).toContain("  Line: T-003: wrangler 4.138.0");
  });

  it("refuses a passage that stands twice", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- node 22\n- node 22\n- bun 1.2\n");
    const twice = await merge(kb, { replaces: "- node 22", text: "- node 26" });
    expect(twice.ok ? "" : twice.message).toContain("stands 2 times");
    expect(read(kb)).toBe("# Facts\n\n- node 22\n- node 22\n- bun 1.2\n");
  });

  /**
   * Ruling 581: an undo finds a correction by the text it wrote, which used to
   * refuse any corrected text the document already held. Live on AWSC-18 a
   * Researcher's `live forms` would have stood 4 times in the calculator
   * research. The record now names the lines around it instead.
   */
  it("ruling 581: text another line repeats is written, and the record names the lines that make it stand once", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- node 22\n- node 22\n- bun 1.2\n");
    const c = await merged(kb, { replaces: "- bun 1.2", text: "- node 22" });
    expect(read(kb)).toBe("# Facts\n\n- node 22\n- node 22\n- node 22\n");
    // CANARY: count matches with a split, which misses overlapping ones, and
    // the record stops at two lines that stand twice: the undo then puts
    // `- bun 1.2` back in the middle.
    expect(c).toMatchObject({ replaced: "- node 22\n- node 22\n- bun 1.2\n", text: "- node 22\n- node 22\n- node 22\n" });
    expect((await undo(c.id)).outcome).toBe("done");
    expect(read(kb)).toBe("# Facts\n\n- node 22\n- node 22\n- bun 1.2\n");
  });

  /**
   * Ruling 581: a correction deletes a passage with an empty `text`. Live on
   * AWSC-18, 39 of the 138 corrections a Researcher applied were deletions,
   * and the tool refused every empty `text`.
   */
  it("ruling 581: an empty text deletes the passage, a retry finds its record, and an undo puts it back for good", async () => {
    const body = "# Rules\n\n- R1: price the ALB. Evidence: AWSC-6 summary.md.\n- R2: one AZ. Evidence: AWSC-5 mapping.md.\n";
    const kb = await seedKb("research", "calculator.md", body);
    const deletion = { doc: "calculator.md", replaces: " Evidence: AWSC-6 summary.md.", text: "" };
    const c = await merged(kb, deletion);
    expect(read(kb, "calculator.md")).toBe("# Rules\n\n- R1: price the ALB.\n- R2: one AZ. Evidence: AWSC-5 mapping.md.\n");
    // CANARY: record the bare `text` and it is empty, which an undo cannot find.
    expect(c).toMatchObject({
      replaced: "- R1: price the ALB. Evidence: AWSC-6 summary.md.\n",
      text: "- R1: price the ALB.\n",
    });
    // CANARY: judge a retry by the text alone and an empty one finds nothing.
    const retry = await merge(kb, deletion);
    expect(retry.ok ? "" : retry.message).toContain(`${c.id} made this correction of ${kb}/calculator.md`);
    expect((await undo(c.id, "We keep the evidence.")).outcome).toBe("done");
    expect(read(kb, "calculator.md")).toBe(body);
    // CANARY: check an undone correction by the bare `text` alone and the
    // deletion a person undid is written again.
    const again = await merge(kb, deletion);
    expect(again.ok ? "" : again.message).toContain('Arda Kaya undid this same correction');
    expect(read(kb, "calculator.md")).toBe(body);
  });

  it("refuses a document the knowledge base does not hold, naming what it does hold", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n");
    const r = await merge(kb, { doc: "fcats.md", text: "Something." });
    expect(r.ok ? "" : r.message).toContain("It holds: facts.md.");
  });

  it("needs nothing when the document already says it", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.139.0\n");
    const added = await merge(kb, { text: "- T-003: wrangler 4.139.0" });
    expect(added.ok ? "" : added.message).toContain("already says that");
  });

  /**
   * Ruling 581: text standing in the document does not prove a correction is
   * in. " Evidence:" stood 56 times in the calculator research when a
   * Researcher's passage was one character off.
   */
  it("ruling 581: a passage that is not there is not taken for a made correction because its text stands", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.139.0. Evidence: run 1.\n- T-004: pnpm 9. Evidence: run 2.\n");
    const r = await merge(kb, { replaces: "- T-005: bun 1.2. Evidence: run 3.", text: " Evidence:" });
    const message = r.ok ? "" : r.message;
    // CANARY: answer "already reads as your `text`" and the filer stops with
    // the wrong passage still in the document.
    expect(message).not.toContain("Nothing needed writing");
    expect(message).toContain("is not in");
    expect(message).toContain("Your `text` stands there 2 times already");
  });

  it("keeps `$&` and `$$` literal, and matches and writes in the document's own line endings", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\r\n\r\n- Build: make all\r\n- Keep.\r\n");
    await merged(kb, { replaces: "- Build: make all", text: "- Build: make all PREFIX=$$HOME\n  (quote $& too)" });
    expect(read(kb)).toBe("# Facts\r\n\r\n- Build: make all PREFIX=$$HOME\r\n  (quote $& too)\r\n- Keep.\r\n");
  });

  it("adds to an empty document without leading blank lines, and an undo leaves it empty again", async () => {
    const kb = await seedKb("rulings", "new.md", "");
    const c = await merged(kb, { doc: "new.md", text: "- The first convention." });
    expect(read(kb, "new.md")).toBe("- The first convention.\n");
    expect((await undo(c.id)).outcome).toBe("done");
    expect(read(kb, "new.md")).toBe("");
  });

  it("refuses a NUL character, which could reach into a masked proposals section", async () => {
    const kb = await seedKb(
      "dossier",
      "facts.md",
      withLegacyProposals("# Facts\n\n- A.\n", [{ taskKey: "VIB-1", correction: "B.", evidence: "e" }]),
    );
    const before = read(kb);
    const r = await merge(kb, { replaces: "\u0000\u0000\u0000", text: "gone" });
    expect(r.ok ? "" : r.message).toContain("cannot hold a NUL character");
    expect(read(kb)).toBe(before);
  });

  it("refuses a side over the cap, since the record carries both", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- A.\n");
    const r = await merge(kb, { replaces: "- A.", text: "é".repeat(KB_CORRECTION_MAX_BYTES / 2 + 1) });
    expect(r.ok ? "" : r.message).toContain("at most 8192 bytes");
    expect(read(kb)).toBe("# Facts\n\n- A.\n");
  });

  it("writes into a nested document where it stands", async () => {
    const kb = await seedKb("runbook", "deploy/step-1.md", "# Step 1\n\n- Run `npm run build`.\n");
    const c = await merged(kb, { doc: "deploy/step-1.md", replaces: "- Run `npm run build`.", text: "- Run `npm run build:worker`." });
    expect(c.doc).toBe("deploy/step-1.md");
    expect(read(kb, "deploy/step-1.md")).toBe("# Step 1\n\n- Run `npm run build:worker`.\n");
  });
});

describe("undoKbCorrection", () => {
  it("puts back what a correction replaced, records who and why, and refuses a second undo", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/\n");
    const c = await merged(kb, { replaces: "- T-003: wrangler 4.138.0", text: "- T-003: wrangler 4.139.0" });
    const r = await undo(c.id);
    expect(r.outcome).toBe("done");
    expect(read(kb)).toBe("# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/\n");
    const [row] = listAuditEvents(store.db, { action: KB_CORRECTION_UNDONE_ACTION });
    expect(row).toMatchObject({ actorUserId: store.users.arda.id, projectSlug: store.slug, taskKey: "VIB-1" });
    expect(row?.details).toMatchObject({ id: c.id, reason: "Not what we run.", byName: "Arda Kaya" });
    expect(listKbCorrections(store.db, { projectSlug: store.slug })[0]!.undone).toMatchObject({
      by: "Arda Kaya",
      reason: "Not what we run.",
    });
    const again = await undo(c.id);
    expect(again.outcome).toBe("noop");
    expect(again.message).toContain("already undone by Arda Kaya");
  });

  it("takes an addition away with the blank line that set it apart", async () => {
    const kb = await seedKb("rulings", "conventions.md", "# Conventions\n\n- Quote every path.\n");
    const c = await merged(kb, { doc: "conventions.md", text: "- Pass `--` first." });
    expect(read(kb, "conventions.md")).toBe("# Conventions\n\n- Quote every path.\n\n- Pass `--` first.\n");
    expect((await undo(c.id)).outcome).toBe("done");
    expect(read(kb, "conventions.md")).toBe("# Conventions\n\n- Quote every path.\n");
  });

  it("refuses a document edited since, writing nothing", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n");
    const c = await merged(kb, { replaces: "- T-003: wrangler 4.138.0", text: "- T-003: wrangler 4.139.0" });
    const edited = "# Facts\n\n- T-003: wrangler 4.140.0 (edited by hand)\n";
    writeFileSync(path.join(store.dataRoot, "kb", kb, "facts.md"), edited, "utf8");
    // CANARY: undo without the count and a stale passage overwrites the edit.
    const r = await undo(c.id);
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain("was edited since");
    expect(read(kb)).toBe(edited);
    expect(listAuditEvents(store.db, { action: KB_CORRECTION_UNDONE_ACTION })).toEqual([]);
  });

  it("finds a correction only on its own board", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- A.\n");
    const c = await merged(kb, { replaces: "- A.", text: "- B." });
    const r = await undo(c.id, null, "another-board");
    expect(r.outcome).toBe("noop");
    expect(r.message).toContain(`No knowledge-base correction ${c.id} is on record for another-board.`);
    expect(read(kb)).toBe("# Facts\n\n- B.\n");
  });

  it("refuses to write back a correction a person undid, naming them and their reason", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n");
    const c = await merged(kb, { replaces: "- T-003: wrangler 4.138.0", text: "- T-003: wrangler 4.139.0" });
    await undo(c.id, "We pin 4.138.0 on purpose.");
    // CANARY: drop the guard and the agent re-files the edit the person undid.
    const r = await merge(kb, { replaces: "- T-003: wrangler 4.138.0", text: "- T-003: Wrangler 4.139.0" });
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : r.message;
    expect(message).toContain("Arda Kaya undid this same correction");
    expect(message).toContain('"We pin 4.138.0 on purpose."');
    expect(read(kb)).toBe("# Facts\n\n- T-003: wrangler 4.138.0\n");
  });
});

describe("editKbPassage (ruling 637)", () => {
  const edit = (kb: string, was: string, now: string) =>
    editKbPassage(store.db, { kb, doc: "facts.md", was, now, actor: person() }, { dataRoot: store.dataRoot });

  it("replaces the one passage, writes nothing else, and the write's audit row names the edit", async () => {
    // Live, three sentences into a 104 KB document were a replace that cut it
    // to 19,587 bytes and eight appends that typed the rest back in.
    // CANARY: write `now` as the whole document and the lines around it are
    // gone; drop `edit` from the write and the audit row says only "replaced".
    const before = "# Facts\n\n- RDS: OnDemand only.\n- Aurora: OnDemand or Reserved.\n";
    const kb = await seedKb("edit-facts", "facts.md", before);

    const result = await edit(kb, "- RDS: OnDemand only.", "- RDS: OnDemand or Reserved, by instance class.");

    expect(result).toEqual({ ok: true, bytes: expect.any(Number), previousBytes: Buffer.byteLength(before) });
    expect(read(kb)).toBe("# Facts\n\n- RDS: OnDemand or Reserved, by instance class.\n- Aurora: OnDemand or Reserved.\n");
    // Newest first: the edit's write, then the seed's.
    const row = listAuditEvents(store.db, { action: "org.store.doc_written" })[0];
    expect(row?.details).toMatchObject({
      replaced: true,
      edited: { replaced: "- RDS: OnDemand only.", text: "- RDS: OnDemand or Reserved, by instance class." },
    });
  });

  it("refuses a passage that is not there or stands twice, writing nothing, and an empty `now` deletes", async () => {
    // A passage one character off is not edited somewhere near it, and one
    // that stands twice is not edited at its first.
    // CANARY: drop the count of occurrences and the repeated note is edited at
    // its first; take any match instead of exactly one and both refusals write.
    const before = "# Facts\n\n- RDS: OnDemand only.\n- Note: as above.\n- Note: as above.\n";
    const kb = await seedKb("edit-refusals", "facts.md", before);

    const missing = await edit(kb, "- RDS: OnDemand only!", "- RDS: Reserved.");
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.message).toContain("is not in edit-refusals/facts.md exactly as you sent it");
    expect(!missing.ok && missing.message).toContain("- RDS: OnDemand only.");
    const twice = await edit(kb, "- Note: as above.", "- Note: see above.");
    expect(!twice.ok && twice.message).toContain("stands 2 times");
    expect(read(kb)).toBe(before);

    expect((await edit(kb, "- RDS: OnDemand only.\n", "")).ok).toBe(true);
    expect(read(kb)).toBe("# Facts\n\n\n- Note: as above.\n- Note: as above.\n");
  });
});

