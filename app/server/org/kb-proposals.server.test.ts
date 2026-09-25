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
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { resolveStoreTarget, saveKnowledgeBase } from "./resources.server";
import { writeStoreDoc } from "./store-files.server";
import {
  fileKbProposal,
  formatKbProposalEntry,
  KB_PROPOSALS_HEADING,
  kbProposalCountsByProject,
  listKbProposals,
  listProjectKbProposals,
  parseKbProposals,
  resolveKbProposal,
  withKbProposalFiled,
} from "./kb-proposals.server";

/**
 * Ruling 483: a proposed knowledge-base correction lives in the document it
 * corrects, and the document is the record: open while the entry stands under
 * the heading, closed when a person (or the controller for them) promotes or
 * dismisses it.
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

const file = (kb: string, input: Partial<Parameters<typeof fileKbProposal>[1]>) =>
  fileKbProposal(
    store.db,
    {
      kb,
      doc: "facts.md",
      line: null,
      correction: "x",
      evidence: "y",
      taskKey: "VIB-1",
      filedBy: "Platform Engineer",
      actor: actor(),
      ...input,
    },
    { dataRoot: store.dataRoot },
  );

const read = (kb: string, doc = "facts.md") =>
  readFileSync(path.join(store.dataRoot, "kb", kb, doc), "utf8");

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  resetSseBrokerForTests();
});

afterEach(() => {
  resetSseBrokerForTests();
  ctx.cleanup();
});

describe("the proposals section of a document", () => {
  const entry = (correction: string) =>
    formatKbProposalEntry({
      taskKey: "WEB-3",
      filedOn: "2026-09-24",
      filedBy: "Platform Engineer",
      line: "T-013: output in dist/server/",
      correction,
      evidence: "`ls dist` shows dist/client and dist/worker\nexit 0",
    });

  it("is created at the end, then filed into in order, and each entry reads back whole", () => {
    const doc = "# Facts\n\n- T-013: output in dist/server/\n";
    const once = withKbProposalFiled(doc, entry("Output is dist/worker."));
    expect(once.startsWith("# Facts\n\n- T-013: output in dist/server/\n\n")).toBe(true);
    expect(once).toContain(`${KB_PROPOSALS_HEADING}\n\nRaised by agents`);
    const twice = withKbProposalFiled(once, entry("Also dist/client."));
    expect(twice.split(KB_PROPOSALS_HEADING)).toHaveLength(2);
    const parsed = parseKbProposals("dossier", "facts.md", twice);
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
  });

  it("reads ruling 378's section and entries, and renames its heading on the next filing", () => {
    const legacy =
      "# Gates\n\n- Run every gate.\n\n## Proposed (not binding)\n\n" +
      "- **[AX-3, 2026-09-22]** Strike -race.\n  Evidence: exit 127\n\n" +
      "Raised by an operator from evidence on a task. **Nothing here is binding.**\n";
    const [old] = parseKbProposals("rulings", "gates.md", legacy);
    expect(old).toMatchObject({ taskKey: "AX-3", filedBy: null, line: null, correction: "Strike -race.", evidence: "exit 127" });
    const next = withKbProposalFiled(legacy, entry("Output is dist/worker."));
    expect(next).not.toContain("## Proposed (not binding)");
    expect(next.split(KB_PROPOSALS_HEADING)).toHaveLength(2);
    expect(parseKbProposals("rulings", "gates.md", next).map((p) => p.taskKey)).toEqual(["AX-3", "WEB-3"]);
  });

  it("does not take a heading quoted in a fenced block for the section", () => {
    const doc = `# Doc\n\n\`\`\`\n${KB_PROPOSALS_HEADING}\n- **[X-1, d]** not an entry\n\`\`\`\n`;
    expect(parseKbProposals("k", "d.md", doc)).toEqual([]);
  });
});

describe("fileKbProposal", () => {
  it("refuses a document the knowledge base does not hold, naming what it does hold", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n");
    const r = await file(kb, { doc: "fcats.md" });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? "" : r.message).toContain("It holds: facts.md.");
  });

  it("anchors to the settled text: a line only the proposals section quotes is not in the document", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n");
    expect((await file(kb, { line: "T-003: wrangler 4.138.0", correction: "It is wrangler 4.139.0." })).ok).toBe(true);
    // The entry above says "wrangler 4.139.0"; the settled text does not, so a
    // proposal "against" that line would stand beside nothing it corrects.
    // CANARY: match the line against the whole document and this is filed.
    const r = await file(kb, { line: "wrangler 4.139.0", correction: "Something else." });
    expect(r.ok).toBe(false);
  });

  it("files a nested document where it stands", async () => {
    const kb = await seedKb("runbook", "deploy/step-1.md", "# Step 1\n\n- Run `npm run build`.\n");
    const r = await file(kb, { doc: "deploy/step-1.md", line: "Run npm run build", correction: "Run the measured build." });
    expect(r.ok).toBe(true);
    expect(read(kb, "deploy/step-1.md")).toContain("Run the measured build.");
    expect(listKbProposals(store.dataRoot).map((p) => `${p.kb}/${p.doc}`)).toEqual([`${kb}/deploy/step-1.md`]);
  });
});

describe("listProjectKbProposals", () => {
  it("lists the proposals this project's tasks filed, in every knowledge base, and no other project's", async () => {
    seedTask("VIB-1");
    const a = await seedKb("dossier", "facts.md", "# Facts\n\n- A.\n");
    const b = await seedKb("runbook", "facts.md", "# Steps\n\n- B.\n");
    await file(a, { correction: "From VIB-1." });
    await file(b, { correction: "Also from VIB-1." });
    await file(a, { taskKey: "OTHER-9", correction: "From another board." });
    const mine = listProjectKbProposals(store.db, store.slug, store.dataRoot);
    // CANARY: drop the task-key filter and OTHER-9's proposal is listed here.
    expect(mine.map((p) => p.correction).sort()).toEqual(["Also from VIB-1.", "From VIB-1."]);
    expect(kbProposalCountsByProject(store.db, store.dataRoot).get(store.slug)).toBe(2);
  });
});

describe("resolveKbProposal", () => {
  it("promote writes the settled text in place of the passage and removes the entry, taking the empty section with it", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- T-003: wrangler 4.138.0\n- T-013: dist/server/\n");
    const filed = await file(kb, { line: "T-003: wrangler 4.138.0", correction: "It is 4.139.0." });
    if (!filed.ok) throw new Error(filed.message);
    // The entry quotes the passage too; only the settled one may be replaced.
    const r = await resolveKbProposal(
      store.db,
      {
        id: filed.proposal.id,
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
    expect(row?.details).toMatchObject({ id: filed.proposal.id, kb, doc: "facts.md", reason: "Measured on WEB-1." });
  });

  it("refuses a passage the settled text does not hold once, writing nothing", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- one\n- one\n");
    const filed = await file(kb, { line: "one", correction: "Two." });
    if (!filed.ok) throw new Error(filed.message);
    const before = read(kb);
    const twice = await resolveKbProposal(
      store.db,
      { id: filed.proposal.id, action: "promote", replaces: "- one", text: "- two", reason: "r" },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(twice.outcome).toBe("noop");
    expect(twice.message).toContain("stands 2 times");
    expect(read(kb)).toBe(before);
  });

  it("dismiss removes one entry and leaves the settled text and the other entries", async () => {
    const kb = await seedKb("dossier", "facts.md", "# Facts\n\n- A.\n\n## Later\n\nMore.\n");
    const first = await file(kb, { correction: "First." });
    const second = await file(kb, { correction: "Second." });
    if (!first.ok || !second.ok) throw new Error("not filed");
    const r = await resolveKbProposal(
      store.db,
      { id: first.proposal.id, action: "dismiss", reason: "Not true." },
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
      { id: first.proposal.id, action: "dismiss", reason: "again" },
      actor(),
      { dataRoot: store.dataRoot },
    );
    expect(gone.outcome).toBe("noop");
  });
});
