import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  actorOf,
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  drainRunCompletions,
  installFakeRuntime,
  queueFakeRun,
  startedRunSpecs,
} from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { reconfigureProject } from "../../../test-support/projected-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { startRun } from "~/server/runtimes/run-service.server";
import {
  resetOperatorLeasesForTests,
  type RunOperatorInput,
} from "~/server/runtimes/operator-run.server";
import type { ProjectFrontmatter } from "~/schemas/project-file.schema";
import type { TaskFileEvent } from "~/schemas/task-file.schema";
import { stageOutcome } from "./agent-outcome.server";
import { operatorSnapshot } from "./operator-snapshot.server";
import { resolveOperatorAuthority } from "./operator-authority.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
import { applyAgentCompletionEffects } from "./agent-completion.server";
import type { TaskActionContext } from "./task-action-core.server";

/**
 * Ruling 488 (F40-67): work on one task reaches another task in the same
 * project, on the record. Live on WEB-9 a goal told the task to post its
 * deployed CPU numbers on WEB-8; nothing that works a task could write on
 * another one, so the Platform Engineer wrote two attachments "for WEB-8" and
 * a person pasted 5,117 characters over by hand.
 *
 * The operator's `relay_to_task` is driven through the real toolkit, and a
 * specialist's `relay` entries through the real completion pipeline.
 */

let ctx: TestDbContext;
let store: TestStore;

const dctx = () => ({ dataRoot: store.dataRoot });
const timeline = (key: string, slug = store.slug): TaskFileEvent[] =>
  readTaskFile({ projectSlug: slug, taskKey: key, dataRoot: store.dataRoot })!.parsed.timeline;
const replyText = z
  .object({ content: z.array(z.object({ text: z.string() })).min(1) })
  .transform((r) => r.content[0]!.text);

/** A `runOperator` stand-in that records what woke whom. */
const runOperatorStub = () =>
  vi.fn((_db: DatabaseSync, _input: RunOperatorInput) =>
    Promise.resolve({ runId: "run_x", queued: false, backend: "claude" as const, autonomy: "supervised" as const }),
  );

type Deployment = ProjectFrontmatter["agents"][number];

const OPERATOR: Deployment = {
  profileId: "operator",
  capabilities: [
    { capabilityId: "generate-packets", mode: "direct" },
    { capabilityId: "append-typed-events", mode: "direct" },
  ],
  extras: [],
  definition: {
    kind: "operator",
    backends: ["claude"],
    model: "sonnet",
    autonomy: "supervised",
  },
};

/** The WEB-9 shape: a Platform Engineer that comments and cites evidence,
 *  with no verdict of its own. */
const PLATFORM_ENGINEER: Deployment = {
  profileId: "platform-engineer",
  capabilities: [
    { capabilityId: "comment-on-task", mode: "direct" },
    { capabilityId: "attach-evidence-references", mode: "direct" },
    { capabilityId: "report-validation-verdict", mode: "off" },
  ],
  extras: [],
  definition: {
    kind: "specialist",
    name: "Platform Engineer",
    role: "Platform Engineer",
    backends: ["claude"],
    model: "sonnet",
  },
};

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  const project = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    repo: null,
    agents: [OPERATOR, PLATFORM_ENGINEER],
  });
  // Another project, whose task a relay must never reach.
  writeProject(store.dataRoot, {
    ...project.parsed.frontmatter,
    name: "Shop",
    slug: "shop",
    taskPrefix: "SHOP",
    repo: null,
    agents: [OPERATOR],
  });
  const open = { stage: "impl", readiness: "ready" as const, ownerUserId: store.users.arda.id };
  for (const key of ["VIB-1", "VIB-2", "VIB-5", "VIB-6"]) {
    writeTask(store.dataRoot, store.slug, { frontmatter: baseTaskFrontmatter(key, open) });
  }
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-3", { ...open, stage: "done" }),
  });
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-4", { ...open, archived: true }),
  });
  writeTask(store.dataRoot, "shop", { frontmatter: baseTaskFrontmatter("SHOP-1", open) });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
});

afterEach(async () => {
  await drainRunCompletions();
  resetOperatorLeasesForTests();
  ctx.cleanup();
});

/** Call the operator's `relay_to_task` on `from`, as the real toolkit builds it. */
async function relay(
  toTaskKey: string,
  text: string,
  over: { from?: string; runOperator?: ReturnType<typeof runOperatorStub>; files?: string[] } = {},
): Promise<string> {
  const toolCtx = over.runOperator
    ? { dataRoot: store.dataRoot, deps: { runOperator: over.runOperator } }
    : dctx();
  const toolkit = buildOperatorToolkit({
    db: store.db,
    ctx: toolCtx,
    projectSlug: store.slug,
    taskKey: over.from ?? "VIB-1",
    authority: resolveOperatorAuthority(dctx(), store.slug),
    orgMcpServers: {},
  });
  const def = toolkit.tools.find((t) => t.name === "relay_to_task");
  if (!def) throw new Error("relay_to_task is not built for this operator");
  const args = over.files ? { taskKey: toTaskKey, text, files: over.files } : { taskKey: toTaskKey, text };
  return replyText.parse(await def.handler(args, {}));
}

const eventually = (assertion: () => void, ms = 8_000) => vi.waitFor(assertion, { timeout: ms, interval: 20 });

const NUMBERS =
  "Deployed cron CPU: 5 ms and 6 ms of the 10 ms limit, 3/50 subrequests.\n\n" +
  "| run | cpu |\n|---|---|\n| 11:17Z | 5 ms |\n| 12:17Z | 6 ms |";

describe("ruling 488: the operator's relay_to_task", () => {
  it("posts on the target as the operator's comment with the source named, audits the relay, and writes one line on the source", async () => {
    // Canaries: drop the `task.relayed` audit row; drop the source task's
    // line; write the target's comment without the "From <task>" header.
    const reply = await relay("VIB-2", NUMBERS, { runOperator: runOperatorStub() });
    expect(reply).toMatch(/^\[done\] Relayed to VIB-2: it is on VIB-2's timeline as your comment/);

    const posted = timeline("VIB-2")[0]!;
    expect(posted).toMatchObject({ type: "comment", actor: { kind: "operator" }, toAgent: true });
    expect(posted.text).toBe(`**From VIB-1 (operator):**\n\n${NUMBERS}`);

    const rows = listAuditEvents(store.db, { action: "task.relayed" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorLabel: "operator",
      projectSlug: store.slug,
      taskKey: "VIB-2",
    });
    expect(rows[0]!.details).toEqual({ from: "VIB-1", to: "VIB-2" });

    const line = timeline("VIB-1")[0]!;
    expect(line).toMatchObject({ type: "note", actor: { kind: "operator" } });
    expect(line.text).toBe(
      "Relayed to VIB-2: Deployed cron CPU: 5 ms and 6 ms of the 10 ms limit, 3/50 subrequests.…",
    );
  });

  it("wakes the target's operator with the relay trigger, the source and the text", async () => {
    // Canary: drop the wake (`autoInvokeOperator(..., "relayed", { relay })`).
    const runOperator = runOperatorStub();
    await relay("VIB-2", NUMBERS, { runOperator });
    await eventually(() => {
      expect(runOperator).toHaveBeenCalledTimes(1);
    });
    const input = runOperator.mock.calls[0]![1];
    expect(input).toMatchObject({
      projectSlug: store.slug,
      taskKey: "VIB-2",
      trigger: "relayed",
      relay: {
        fromTaskKey: "VIB-1",
        by: "operator",
        text: NUMBERS,
        occurredAt: timeline("VIB-2")[0]!.occurredAt,
      },
    });
  });

  it("the woken operator's turn quotes what arrived and says nobody carries it by hand", async () => {
    // Canary: return the relay branch's instruction empty (`relayInstruction`),
    // or drop the `relay` payload at either prompt builder's call site.
    await relay("VIB-2", NUMBERS);
    await eventually(() => {
      expect(startedRunSpecs().some((s) => s.kind === "operator" && s.taskKey === "VIB-2")).toBe(true);
    });
    const prompt = startedRunSpecs().find((s) => s.kind === "operator" && s.taskKey === "VIB-2")!.prompt;
    expect(prompt).toContain('VIB-1 relayed this to you (ruling 488): the operator there posted it on this task\'s timeline as a comment headed "From VIB-1 (operator)"');
    expect(prompt).toContain(NUMBERS);
    expect(prompt).toContain("never ask a person to copy it here or to confirm it arrived");
  });

  it("refuses another project, the source itself, a missing task and a closed one, and writes nothing", async () => {
    // Canaries: drop the other-project lookup (the refusal stops naming the
    // project); drop the self check; drop the closure check (Done and archived
    // are posted on).
    const runOperator = runOperatorStub();
    const before = (key: string, slug?: string) => timeline(key, slug).length;
    const counts = {
      shop: before("SHOP-1", "shop"),
      self: before("VIB-1"),
      done: before("VIB-3"),
      archived: before("VIB-4"),
    };

    expect(await relay("SHOP-1", NUMBERS, { runOperator })).toBe(
      "[denied] SHOP-1 is a task in project shop, not in viberr-core. A relay reaches only tasks in the same project.",
    );
    expect(await relay("VIB-1", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-1 is the task you are on. A relay reaches ANOTHER task in this project; write on this one as usual.",
    );
    expect(await relay("VIB-99", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-99 is not a task in this project, so nothing was relayed. `read_board` lists the project's tasks.",
    );
    expect(await relay("VIB-3", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-3 is closed (Done is the terminal stage). Move it back to an open stage before relaying to it. " +
        "Nothing was relayed: a closed task's operator starts no run, so the text would reach nobody.",
    );
    expect(await relay("VIB-4", NUMBERS, { runOperator })).toBe(
      "[noop] VIB-4 is archived. Restore it before relaying to it. " +
        "Nothing was relayed: a closed task's operator starts no run, so the text would reach nobody.",
    );

    expect(timeline("SHOP-1", "shop")).toHaveLength(counts.shop);
    expect(timeline("VIB-1")).toHaveLength(counts.self);
    expect(timeline("VIB-3")).toHaveLength(counts.done);
    expect(timeline("VIB-4")).toHaveLength(counts.archived);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toEqual([]);
    expect(runOperator).not.toHaveBeenCalled();
  });
});

/**
 * Ruling 538: a relay carries files. Live on the AWS calculator board the
 * benchmark tasks were planned to work from inventories saved on another
 * task (a spreadsheet, a screenshot), and nothing could put a file on another
 * task: the relay carried text, and each agent reads only its own task's
 * attachments.
 */
describe("ruling 538: a relay carries files", () => {
  const attachmentsOf = (key: string) => path.join(store.dataRoot, "projects", store.slug, "tasks", key, "attachments");
  function save(key: string, name: string, body: string): void {
    mkdirSync(attachmentsOf(key), { recursive: true });
    writeFileSync(path.join(attachmentsOf(key), name), body);
  }

  it("puts the named files on the target, claimed and named by the relay comment", async () => {
    // CANARY: drop the files from `relayToTask` and VIB-2 receives the text
    // with nothing to work from.
    save("VIB-1", "sample-01-input.csv", "vm,cpu,ram\nweb01,4,16\n");
    save("VIB-1", "sample-04-input.png", "\x89PNG fake bytes");
    const reply = await relay("VIB-2", "Benchmark input for sample 01.", {
      runOperator: runOperatorStub(),
      files: ["sample-01-input.csv", "sample-04-input.png"],
    });
    expect(reply).toContain("With the files `sample-01-input.csv` and `sample-04-input.png`");
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), "sample-01-input.csv"), "utf8")).toBe("vm,cpu,ram\nweb01,4,16\n");
    const posted = timeline("VIB-2")[0]!;
    expect(posted.attachments).toEqual(["sample-01-input.csv", "sample-04-input.png"]);
    expect(posted.text).toContain("now on this task's attachments");
    expect(timeline("VIB-1")[0]!.text).toMatch(/With 2 files\.$/);
    expect(listAuditEvents(store.db, { action: "task.relayed" })[0]!.details).toEqual({
      from: "VIB-1",
      to: "VIB-2",
      files: ["sample-01-input.csv", "sample-04-input.png"],
    });
  });

  it("never overwrites: the same bytes stay, other bytes land under the next free name", async () => {
    save("VIB-1", "inventory.csv", "vm\nweb01\n");
    save("VIB-2", "inventory.csv", "vm\nweb01\n");
    await relay("VIB-2", "Same file again.", { runOperator: runOperatorStub(), files: ["inventory.csv"] });
    expect(timeline("VIB-2")[0]!.attachments).toEqual(["inventory.csv"]);
    save("VIB-1", "inventory.csv", "vm\ndb01\n");
    const reply = await relay("VIB-2", "A newer inventory.", { runOperator: runOperatorStub(), files: ["inventory.csv"] });
    expect(reply).toContain("`inventory.csv` (here as `inventory-2.csv`");
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), "inventory.csv"), "utf8")).toBe("vm\nweb01\n");
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), "inventory-2.csv"), "utf8")).toBe("vm\ndb01\n");
  });

  it("refuses the whole relay for a file the source does not hold or the target could not read, and writes nothing", async () => {
    save("VIB-1", "inventory.csv", "vm\n");
    save("VIB-1", "dump.log", "x".repeat(10 * 1024 * 1024 + 1));
    const before = timeline("VIB-2").length;
    expect(await relay("VIB-2", "Inputs.", { files: ["inventory.csv", "missing.csv"] })).toMatch(
      /^\[noop\] Nothing was relayed to VIB-2: VIB-1 has no attachment `missing.csv`\. It holds: /,
    );
    expect(await relay("VIB-2", "Inputs.", { files: ["inventory.csv", "dump.log"] })).toMatch(
      /^\[noop\] Nothing was relayed to VIB-2: /,
    );
    expect(timeline("VIB-2")).toHaveLength(before);
    expect(existsSync(path.join(attachmentsOf("VIB-2"), "inventory.csv"))).toBe(false);
  });
});

/**
 * Ruling 557: the relay's other direction. Live when AWSC-3 (the benchmark
 * design) was accepted, its operator had relayed nothing, a closed task's
 * operator starts no run, and AWSC-4 to AWSC-7 each asked the owner to attach
 * its input by hand.
 */
describe("ruling 557: a task takes the files it works from", () => {
  const attachmentsOf = (key: string) => path.join(store.dataRoot, "projects", store.slug, "tasks", key, "attachments");
  function save(key: string, name: string, body: string): void {
    mkdirSync(attachmentsOf(key), { recursive: true });
    writeFileSync(path.join(attachmentsOf(key), name), body);
  }
  /** Call the operator's `take_from_task` on `on`, as the real toolkit builds it. */
  async function take(on: string, from: string, files: string[], text = "The benchmark input."): Promise<string> {
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: dctx(),
      projectSlug: store.slug,
      taskKey: on,
      authority: resolveOperatorAuthority(dctx(), store.slug),
      orgMcpServers: {},
    });
    const def = toolkit.tools.find((t) => t.name === "take_from_task");
    if (!def) throw new Error("take_from_task is not built for this operator");
    return replyText.parse(await def.handler({ taskKey: from, files, text }, {}));
  }

  it("puts the named files of a Done task on this one, claimed as carried, and the source records the take", async () => {
    // VIB-3 is Done: the task that made the input has closed, which is the
    // case the relay could not reach. CANARY: refuse a closed source (as the
    // relay refuses a closed target) and VIB-2 never gets its input.
    save("VIB-3", "sample-01-input.csv", "vm,cpu\nweb01,4\n");
    save("VIB-3", "golden-files.md", "the answers");
    const reply = await take("VIB-2", "VIB-3", ["sample-01-input.csv"]);
    expect(reply).toMatch(/^\[done\] Took 1 file from VIB-3/);
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), "sample-01-input.csv"), "utf8")).toBe("vm,cpu\nweb01,4\n");
    // Only what was named: the answer key stays where it is.
    expect(existsSync(path.join(attachmentsOf("VIB-2"), "golden-files.md"))).toBe(false);
    const claim = timeline("VIB-2")[0]!;
    expect(claim.attachments).toEqual(["sample-01-input.csv"]);
    expect(claim.text.split("\n", 1)[0]).toBe("**From VIB-3 (operator):**");
    // A relay's own header, so completion never credits a run on VIB-2 with
    // the file (ruling 538). CANARY: head it otherwise and a deliverer finishing
    // meanwhile claims the input as its delivery.
    const { isRelayComment } = await import("./task-relay.server");
    expect(isRelayComment(claim)).toBe(true);
    expect(timeline("VIB-3")[0]!.text).toBe("Taken by VIB-2: `sample-01-input.csv`.");
    expect(listAuditEvents(store.db, { action: "task.files.taken" })[0]!.details).toEqual({
      from: "VIB-3",
      to: "VIB-2",
      files: ["sample-01-input.csv"],
    });
  });

  /**
   * Ruling 675: the owner's AWSC-117 input, uploaded from a Mac, was stored
   * with its name decomposed, and a rule that had each task take it would have
   * been refused on every task: "has no attachment X. It holds: X."
   */
  it("ruling 675: takes a file stored decomposed by its composed name, and it lands and is claimed composed", async () => {
    const composed = "Aidea _ İçerik ve Eğitim _ AWS Maliyet Teklifi.pdf";
    save("VIB-3", composed.normalize("NFD"), "the proposal");
    // CANARY: resolve the source byte for byte and this take is refused with
    // two names no reader can tell apart.
    expect(await take("VIB-2", "VIB-3", [composed])).toMatch(/^\[done\] Took 1 file from VIB-3/);
    expect(readdirSync(attachmentsOf("VIB-2"))).toEqual([composed]);
    expect(timeline("VIB-2")[0]!.attachments).toEqual([composed]);
    // CANARY: land it under the name as typed and a name typed decomposed is
    // claimed under one form and stored under the other, so a run finishing
    // meanwhile takes the file as its own (ruling 538).
    save("VIB-3", "Çıktı.md".normalize("NFD"), "the output");
    expect(await take("VIB-2", "VIB-3", ["Çıktı.md".normalize("NFD")])).toMatch(/^\[done\] Took 1 file from VIB-3/);
    expect(readdirSync(attachmentsOf("VIB-2")).sort()).toEqual([composed, "Çıktı.md"].sort());
    expect(timeline("VIB-2")[0]!.attachments).toEqual(["Çıktı.md"]);
  });

  it("ruling 675: never overwrites a file this task holds under the same name in the other Unicode form", async () => {
    // CANARY: fold the target's names by case alone and a take by the
    // composed name skips the next-free-name branch, resolves to the
    // decomposed file already here and replaces it (ruling 538: never).
    const decomposed = "Müşteri Envanteri.csv".normalize("NFD");
    save("VIB-2", decomposed, "this task's own inventory");
    save("VIB-3", "Müşteri Envanteri.csv", "another task's inventory");
    expect(await take("VIB-2", "VIB-3", ["Müşteri Envanteri.csv"])).toMatch(/^\[done\] Took 1 file from VIB-3/);
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), decomposed), "utf8")).toBe("this task's own inventory");
    expect(readFileSync(path.join(attachmentsOf("VIB-2"), "Müşteri Envanteri-2.csv"), "utf8")).toBe("another task's inventory");
    expect(timeline("VIB-2")[0]!.attachments).toEqual(["Müşteri Envanteri-2.csv"]);
  });

  it("refuses this task, another project's task, a missing task, an archived task and a missing file, and writes nothing", async () => {
    // CANARY: drop the archived-source refusal and VIB-4's file lands on VIB-2
    // while VIB-4, whose work was withdrawn, gets a "Taken by" line.
    save("VIB-1", "inventory.csv", "vm\n");
    save("VIB-4", "inventory.csv", "vm\n");
    const before = timeline("VIB-2").length;
    const archivedBefore = timeline("VIB-4").length;
    expect(await take("VIB-2", "VIB-2", ["inventory.csv"])).toMatch(/is the task you are on/);
    expect(await take("VIB-2", "SHOP-1", ["inventory.csv"])).toMatch(/^\[denied\] SHOP-1 is a task in project shop/);
    expect(await take("VIB-2", "VIB-99", ["inventory.csv"])).toMatch(/VIB-99 is not a task in this project/);
    expect(await take("VIB-2", "VIB-4", ["inventory.csv"])).toBe(
      "[noop] VIB-4 is archived. Restore it before taking files from it. Nothing was taken.",
    );
    expect(await take("VIB-2", "VIB-1", ["inventory.csv", "missing.csv"])).toMatch(
      /^\[noop\] Nothing was taken from VIB-1: VIB-1 has no attachment `missing.csv`/,
    );
    expect(timeline("VIB-2")).toHaveLength(before);
    expect(timeline("VIB-4")).toHaveLength(archivedBefore);
    expect(existsSync(path.join(attachmentsOf("VIB-2"), "inventory.csv"))).toBe(false);
  });

  it("says on its comment when a tag in its line reaches nobody, as a relay does", async () => {
    // A machine-authored comment cannot be retagged, so the comment is where
    // its author learns the tag notified nobody. CANARY: write the claim
    // without `withAmbiguityDisclosure` and the dropped tag goes unsaid.
    save("VIB-3", "sample-01-input.csv", "vm\n");
    const deniz = store.users.deniz.email.split("@")[0]!;
    await take("VIB-2", "VIB-3", ["sample-01-input.csv"], `@${deniz} the benchmark input.`);
    expect(timeline("VIB-2")[0]!.text).toContain(`@${deniz} is not a member of this project`);
  });

  it("gives its files when the source cannot take its line, and says which", async () => {
    // The files and their claim are down and audited before the source's
    // line is written. CANARY: let the line's failure throw and the take
    // reads as failed after its files landed, so the operator takes again;
    // or reply that the line is there and the operator trusts a record that
    // is not.
    save("VIB-3", "sample-01-input.csv", "vm\n");
    writeFileSync(
      path.join(store.dataRoot, "projects", store.slug, "tasks", "VIB-3", "task.md"),
      "---\nkey: VIB-3\ntitle: Truncated by an editor\nstage: done\n",
    );
    const reply = await take("VIB-2", "VIB-3", ["sample-01-input.csv"]);
    expect(reply).toMatch(/^\[done\] Took 1 file from VIB-3/);
    expect(reply).toContain("VIB-3's timeline could not take its line about the take");
    expect(timeline("VIB-2")[0]!.attachments).toEqual(["sample-01-input.csv"]);
    expect(listAuditEvents(store.db, { action: "task.files.taken" })).toHaveLength(1);
  });

  it("is withheld with the comment grant, as the relay is", () => {
    reconfigureProject(store, {
      agents: [{ ...OPERATOR, capabilities: [{ capabilityId: "append-typed-events", mode: "off" }] }, PLATFORM_ENGINEER],
    });
    const toolkit = buildOperatorToolkit({
      db: store.db,
      ctx: dctx(),
      projectSlug: store.slug,
      taskKey: "VIB-2",
      authority: resolveOperatorAuthority(dctx(), store.slug),
      orgMcpServers: {},
    });
    // CANARY: build the tool outside the comment grant's block and an operator
    // that may not post on its own task writes a claim comment anyway.
    expect(toolkit.tools.some((t) => t.name === "take_from_task")).toBe(false);
  });
});

describe("ruling 488: a specialist's relay entries", () => {
  let runSeq = 0;
  /** A finished Platform Engineer run on VIB-1 whose outcome carries `relay`. */
  async function completeWithRelays(
    relayEntries: { taskKey: string; text: string }[],
    runOperator: ReturnType<typeof runOperatorStub>,
  ): Promise<void> {
    runSeq += 1;
    queueFakeRun({
      lines: [
        { t: "", ev: "init", tag: "system·init", text: "test session" },
        { t: "", ev: "text", tag: "assistant", text: "Read both deployed cron runs." },
        { t: "", ev: "result", tag: "result", text: "done" },
      ],
      occurredAt: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
      sessionId: `relay-${runSeq}`,
    });
    const started = await startRun(store.db, {
      projectSlug: store.slug,
      taskKey: "VIB-1",
      kind: "primary",
      role: "Platform Engineer",
      agentProfileId: "platform-engineer",
      credentialUserId: store.users.arda.id,
      backend: "claude",
      model: "sonnet",
      prompt: "read the cron runs",
      workdir: store.dataRoot,
      autonomous: true,
      dataRoot: store.dataRoot,
      actor: actorOf(store.users.arda),
      threadId: `relay-th-${runSeq}`,
    });
    await eventually(() => {
      // SAFETY: the SELECT list is the single column `state`, TEXT NOT NULL on
      // `agent_runs` (0001_baseline); `undefined` when no row matches.
      const row = store.db
        .prepare(`SELECT state FROM agent_runs WHERE id = ?`)
        .get(started.runId) as { state: string } | undefined;
      expect(row?.state).toBe("finished");
    });
    const outcomeKey = `oc-${started.runId}`;
    stageOutcome(store.db, outcomeKey, { summary: "Read both deployed cron runs.", relay: relayEntries });
    // The relay's wake reads the stand-in off the context it is handed.
    const completionCtx: TaskActionContext = { dataRoot: store.dataRoot, deps: { runOperator } };
    await applyAgentCompletionEffects(
      store.db,
      completionCtx,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        backend: "claude",
        profileId: "platform-engineer",
        role: "Platform Engineer",
        delivers: false,
        workdir: null,
        agentHandle: "platform-engineer",
        outcomeKey,
      },
      { id: started.runId, state: "finished" },
    );
  }

  const agentRef = {
    kind: "agent",
    backend: "claude",
    profileId: "platform-engineer",
    roleHint: "Platform Engineer",
  };

  it("posts each entry on its task after completion, as the agent, and the operator's snapshot shows it went out", async () => {
    // Canary: drop the completion pipeline's `postOutcomeRelays` call.
    const runOperator = runOperatorStub();
    await completeWithRelays([{ taskKey: "VIB-2", text: NUMBERS }], runOperator);

    const posted = timeline("VIB-2")[0]!;
    expect(posted).toMatchObject({ type: "comment", actor: agentRef, toAgent: true });
    expect(posted.text).toBe(`**From VIB-1 (Platform Engineer):**\n\n${NUMBERS}`);
    expect(listAuditEvents(store.db, { action: "task.relayed" })[0]).toMatchObject({
      actorLabel: "agent:claude/platform-engineer (Platform Engineer)",
      taskKey: "VIB-2",
      details: { from: "VIB-1", to: "VIB-2" },
    });

    // The source's line, AFTER the report, which is what the operator reads.
    const source = timeline("VIB-1");
    expect(source[0]).toMatchObject({ type: "note", actor: agentRef });
    expect(source[0]!.text).toMatch(/^Relayed to VIB-2: Deployed cron CPU/);
    const snapshot = operatorSnapshot(
      store.db,
      dctx(),
      store.slug,
      "VIB-1",
      resolveOperatorAuthority(dctx(), store.slug),
      6,
    );
    expect(snapshot.recentTimeline.some((row) => row.text.startsWith("Relayed to VIB-2: Deployed cron CPU"))).toBe(true);

    await eventually(() => {
      expect(runOperator.mock.calls.some((c) => c[1].taskKey === "VIB-2" && c[1].trigger === "relayed")).toBe(true);
    });
    const wake = runOperator.mock.calls.find((c) => c[1].taskKey === "VIB-2")![1];
    expect(wake.relay).toMatchObject({ fromTaskKey: "VIB-1", by: "Platform Engineer", text: NUMBERS });
  });

  it("posts at most two, and names the rest on the source task", async () => {
    // Canary: drop the cap in `postOutcomeRelays` (VIB-6 is posted on).
    await completeWithRelays(
      [
        { taskKey: "VIB-2", text: "First." },
        { taskKey: "VIB-5", text: "Second." },
        { taskKey: "VIB-6", text: "Third." },
      ],
      runOperatorStub(),
    );
    expect(timeline("VIB-2")[0]!.text).toBe("**From VIB-1 (Platform Engineer):**\n\nFirst.");
    expect(timeline("VIB-5")[0]!.text).toBe("**From VIB-1 (Platform Engineer):**\n\nSecond.");
    expect(timeline("VIB-6")).toEqual([]);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toHaveLength(2);
    const note = timeline("VIB-1").find((e) => e.title === "Not relayed")!;
    expect(note.text).toContain("- VIB-6: past the limit of 2 relays in one report.");
    expect(note.text).toContain("nobody is to copy it by hand");
  });

  it("reaches only tasks in the same project", async () => {
    // Canary: drop the other-project lookup (the note no longer names shop).
    const before = timeline("SHOP-1", "shop").length;
    await completeWithRelays([{ taskKey: "SHOP-1", text: NUMBERS }], runOperatorStub());
    expect(timeline("SHOP-1", "shop")).toHaveLength(before);
    expect(listAuditEvents(store.db, { action: "task.relayed" })).toEqual([]);
    const note = timeline("VIB-1").find((e) => e.title === "Not relayed")!;
    expect(note.text).toContain(
      "- SHOP-1: SHOP-1 is a task in project shop, not in viberr-core. A relay reaches only tasks in the same project.",
    );
  });
});
