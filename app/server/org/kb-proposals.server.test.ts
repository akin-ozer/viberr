import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  withLegacyProposals,
  type LegacyProposalInput,
} from "../../../test-support/kb-legacy-proposals";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resolveStoreTarget, saveKnowledgeBase } from "./resources.server";
import { writeStoreDoc } from "./store-files.server";
import {
  kbProposalCountsByProject,
  legacyProposalsSpan,
  listKbProposals,
  listProjectKbProposals,
  parseKbProposals,
  resolveKbProposal,
} from "./kb-proposals.server";

/**
 * Rulings 378 and 483: a proposed knowledge-base correction lives in the
 * document it corrects, and the document is the record: open while the entry
 * stands under the heading, closed when a person (or the controller for them)
 * promotes or dismisses it. Ruling 498 ended the filing, so these documents are
 * built as the filing left them (`test-support/kb-legacy-proposals.ts`).
 */

let ctx: TestDbContext;
let store: TestStore;
const actor = () => ({ userId: store.users.arda.id, label: "arda" });

async function seedKb(name: string, doc: string, body: string): Promise<string> {
  const { kb } = await saveKnowledgeBase(
    store.db,
    { name, refresh: "on change" },
    actor(),
    { dataRoot: store.dataRoot },
  );
  const target = resolveStoreTarget(store.db, "kb", kb.id, { dataRoot: store.dataRoot })!;
  const parts = doc.split("/");
  const file = parts.pop()!;
  writeStoreDoc(store.db, target, parts, file, body, actor());
  return kb.dir;
}

function seedTask(key: string): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter(key, { stage: "impl", title: key }),
    goal: "Work.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

const entry = (input: Partial<LegacyProposalInput>): LegacyProposalInput => ({
  taskKey: "VIB-1",
  correction: "x",
  evidence: "y",
  ...input,
});

/** A knowledge base whose document holds `settled` and these proposals. */
const seedWithProposals = (name: string, settled: string, entries: Partial<LegacyProposalInput>[], doc = "facts.md") =>
  seedKb(name, doc, withLegacyProposals(settled, entries.map(entry)));

const read = (kb: string, doc = "facts.md") =>
  readFileSync(path.join(store.dataRoot, "kb", kb, doc), "utf8");

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

describe("the proposals section of a document", () => {
  it("reads each entry whole and in order, with an id of its own", () => {
    const doc = withLegacyProposals("# Facts\n\n- T-013: output in dist/server/\n", [
      {
        taskKey: "WEB-3",
        filedOn: "2026-09-24",
        filedBy: "Platform Engineer",
        line: "T-013: output in dist/server/",
        correction: "Output is dist/worker.",
        evidence: "`ls dist` shows dist/client and dist/worker\nexit 0",
      },
      { taskKey: "WEB-3", filedOn: "2026-09-24", correction: "Also dist/client.", evidence: "ls" },
    ]);
    const parsed = parseKbProposals("dossier", "facts.md", doc);
    expect(parsed.map((p) => p.correction)).toEqual(["Output is dist/worker.", "Also dist/client."]);
    expect(parsed[0]).toMatchObject({
      kb: "dossier",
      doc: "facts.md",
      taskKey: "WEB-3",
      filedOn: "2026-09-24",
      filedBy: "Platform Engineer",
      line: "T-013: output in dist/server/",
      // A multi-line value keeps its lines, indented under the entry.
      evidence: "`ls dist` shows dist/client and dist/worker\nexit 0",
    });
    expect(parsed[0]!.id).toMatch(/^kp-[0-9a-f]{10}$/);
    expect(parsed[0]!.id).not.toBe(parsed[1]!.id);
    // Ruling 498 corrects around the section: it starts at its heading.
    expect(doc.slice(legacyProposalsSpan(doc)!.start)).toMatch(/^## Proposed corrections \(not binding\)\n/);
  });

  it("reads ruling 378's section and entries", () => {
    const legacy =
      "# Gates\n\n- Run every gate.\n\n## Proposed (not binding)\n\n" +
      "- **[AX-3, 2026-09-22]** Strike -race.\n  Evidence: exit 127\n\n" +
      "Raised by an operator from evidence on a task. **Nothing here is binding.**\n";
    const [old] = parseKbProposals("rulings", "gates.md", legacy);
    expect(old).toMatchObject({ taskKey: "AX-3", filedBy: null, line: null, correction: "Strike -race.", evidence: "exit 127" });
  });

  it("does not take a heading quoted in a fenced block for the section", () => {
    const doc = "# Doc\n\n```\n## Proposed corrections (not binding)\n- **[X-1, d]** not an entry\n```\n";
    expect(parseKbProposals("k", "d.md", doc)).toEqual([]);
    expect(legacyProposalsSpan(doc)).toBeNull();
  });

  it("reads a nested document where it stands", async () => {
    const kb = await seedWithProposals(
      "runbook",
      "# Step 1\n\n- Run `npm run build`.\n",
      [{ line: "Run npm run build", correction: "Run the measured build." }],
      "deploy/step-1.md",
    );
    expect(listKbProposals(store.dataRoot).map((p) => `${p.kb}/${p.doc}`)).toEqual([`${kb}/deploy/step-1.md`]);
  });
});

describe("listProjectKbProposals", () => {
  it("lists the proposals this project's tasks filed, in every knowledge base, and no other project's", async () => {
    seedTask("VIB-1");
    await seedWithProposals("dossier", "# Facts\n\n- A.\n", [
      { correction: "From VIB-1." },
      { taskKey: "OTHER-9", correction: "From another board." },
    ]);
    await seedWithProposals("runbook", "# Steps\n\n- B.\n", [{ correction: "Also from VIB-1." }]);
    const mine = listProjectKbProposals(store.db, store.slug, store.dataRoot);
    // CANARY: drop the task-key filter and OTHER-9's proposal is listed here.
    expect(mine.map((p) => p.correction).sort()).toEqual(["Also from VIB-1.", "From VIB-1."]);
    expect(kbProposalCountsByProject(store.db, store.dataRoot).get(store.slug)).toBe(2);
  });
});

describe("resolveKbProposal", () => {
  const idOf = (kb: string, index = 0, doc = "facts.md") =>
    parseKbProposals(kb, doc, read(kb, doc))[index]!.id;

  it("promote writes the settled text in place of the passage and removes the entry, taking the empty section with it", async () => {
    const kb = await seedWithProposals("dossier", "# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/\n", [
      { line: "T-003: wrangler 4.138.0", correction: "It is 4.139.0." },
    ]);
    const id = idOf(kb);
    // The entry quotes the passage too; only the settled one may be replaced.
    const r = await resolveKbProposal(
      store.db,
      {
        id,
        action: "promote",
        replaces: "- T-003: wrangler 4.138.0",
        text: "- T-003: wrangler 4.139.0",
        reason: "Measured on WEB-1.",
      },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(r.outcome).toBe("done");
    expect(read(kb)).toBe("# Facts\n\n- T-003: wrangler 4.139.0\n- T-013: dist/server/\n");
    expect(listKbProposals(store.dataRoot)).toEqual([]);
    const row = listAuditEvents(store.db, { action: "org.kb.proposal_promoted" })[0];
    expect(row?.details).toMatchObject({ id, kb, doc: "facts.md", reason: "Measured on WEB-1." });
  });

  it("refuses a passage the settled text does not hold once, writing nothing", async () => {
    const kb = await seedWithProposals("dossier", "# Facts\n\n- one\n- one\n", [{ line: "one", correction: "Two." }]);
    const before = read(kb);
    const twice = await resolveKbProposal(
      store.db,
      { id: idOf(kb), action: "promote", replaces: "- one", text: "- two", reason: "r" },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(twice.outcome).toBe("noop");
    expect(twice.message).toContain("stands 2 times");
    expect(read(kb)).toBe(before);
  });

  it("dismiss removes one entry and leaves the settled text and the other entries", async () => {
    const kb = await seedKb(
      "dossier",
      "facts.md",
      withLegacyProposals("# Facts\n\n- A.\n", [entry({ correction: "First." }), entry({ correction: "Second." })]) +
        "\n## Later\n\nMore.\n",
    );
    const first = idOf(kb);
    const r = await resolveKbProposal(
      store.db,
      { id: first, action: "dismiss", reason: "Not true." },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(r.outcome).toBe("done");
    const body = read(kb);
    expect(body).toContain("# Facts\n\n- A.\n");
    expect(body).toContain("## Later\n\nMore.\n");
    expect(body).not.toContain("First.");
    expect(listKbProposals(store.dataRoot).map((p) => p.correction)).toEqual(["Second."]);
    const gone = await resolveKbProposal(
      store.db,
      { id: first, action: "dismiss", reason: "again" },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(gone.outcome).toBe("noop");
  });
});
