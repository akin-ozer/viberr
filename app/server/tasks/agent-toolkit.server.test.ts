import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { insertUser } from "~/server/auth/user-store.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { listNotifications } from "~/server/projections/notifications.server";
import {
  buildAgentToolkit,
  postAgentComment,
  openAgentQuestionPacket,
} from "./agent-toolkit.server";
import { takeStagedOutcome } from "./agent-outcome.server";
import type { FileActorRef } from "~/schemas/task-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const AGENT_REF: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "security-reviewer",
  roleHint: "Security review",
};

describe("agent-toolkit audit attribution (P11-23)", () => {
  it("attributes an agent comment audit to the AGENT, not the operator", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await postAgentComment(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", actorRef: AGENT_REF, text: "Looks safe." },
    );

    const row = listAuditEvents(store.db, { action: "task.agent.commented" })[0];
    expect(row).toBeTruthy();
    // The actor label is the agent ref, not "operator".
    expect(row.actorLabel).toBe("agent:claude/security-reviewer (Security review)");
    expect(row.actorLabel).not.toBe("operator");
  });

  /**
   * S5-G3: a mid-run agent comment tags the human it answers (NEW-4). When the
   * handle matches two people the ladder routes nowhere, and this writer dropped
   * the ambiguity on the floor — the agent cannot retag itself, so its comment
   * is the only place a human would ever learn the ping never happened.
   */
  it("an AMBIGUOUS @tag in a mid-run agent comment is disclosed on the comment (S5-G3)", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const firstName = store.users.arda.name.split(" ")[0]!.toLowerCase();

    await postAgentComment(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-3",
        actorRef: AGENT_REF,
        text: `@${firstName} the migration needs your call before I continue.`,
      },
    );

    const posted = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-3",
      dataRoot: store.dataRoot,
    })!.parsed.timeline[0]!;
    expect(posted.type).toBe("comment");
    expect(posted.text).toContain("the migration needs your call");
    expect(posted.text).toContain("nobody was notified");
    expect(
      listNotifications(store.db, store.users.arda.id).filter(
        (n) => n.kind === "mention",
      ),
    ).toHaveLength(0);
  });

  it("attributes an agent-opened question packet audit to the AGENT", async () => {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const opened = await openAgentQuestionPacket(
      store.db,
      { dataRoot: store.dataRoot },
      {
        projectSlug: store.slug,
        taskKey: "VIB-2",
        actorRef: AGENT_REF,
        title: "Which config should I target?",
        body: "Ambiguous scope.",
      },
    );
    expect(opened).toBe(true);
    const row = listAuditEvents(store.db, { action: "task.agent.packet_opened" })[0];
    expect(row.actorLabel).toBe("agent:claude/security-reviewer (Security review)");
  });
});

/**
 * P13-D-26 — `report_outcome` is the agent's channel for evidence REFERENCES,
 * so the reviewer profile's advertised "Attach evidence references" grant stops
 * being a matrix-only label. Gated exactly like its sibling tools: an agent
 * without the grant never even sees the field.
 */
describe("report_outcome's evidence field (P13-D-26)", () => {
  interface RegisteredTool {
    handler: (args: unknown, extra?: unknown) => Promise<{ content: unknown[] }>;
    inputSchema: { shape?: Record<string, unknown> } | Record<string, unknown>;
  }

  function toolkitTools(
    collab: { comment: boolean; ask: boolean; verdict: boolean; evidence: boolean },
    outcomeKey: string,
  ): Record<string, RegisteredTool> {
    const store = setupTestStore(ctx);
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-3", { stage: "review" }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const built = buildAgentToolkit({
      db: store.db,
      ctx: { dataRoot: store.dataRoot },
      projectSlug: store.slug,
      taskKey: "VIB-3",
      actorRef: AGENT_REF,
      outcomeKey,
      collab,
    })!;
    lastStore = store;
    const server = built.mcpServers.viberr_agent as {
      instance: { _registeredTools: Record<string, RegisteredTool> };
    };
    return server.instance._registeredTools;
  }

  let lastStore: ReturnType<typeof setupTestStore>;

  const BASE = { comment: false, ask: false, verdict: true };

  it("declares `evidence` only when the profile holds attach-evidence-references", () => {
    const granted = toolkitTools({ ...BASE, evidence: true }, "oc_a").report_outcome!;
    const withheld = toolkitTools({ ...BASE, evidence: false }, "oc_b").report_outcome!;
    const keys = (t: RegisteredTool) =>
      Object.keys(
        (t.inputSchema as { shape?: Record<string, unknown> }).shape ?? t.inputSchema,
      );
    expect(keys(granted)).toContain("evidence");
    expect(keys(withheld)).not.toContain("evidence");
    // The rest of the envelope is unchanged either way.
    expect(keys(withheld)).toEqual(expect.arrayContaining(["verdict", "summary"]));
  });

  it("stages NORMALIZED rows with the verdict", async () => {
    const tools = toolkitTools({ ...BASE, evidence: true }, "oc_c");
    await tools.report_outcome!.handler(
      {
        verdict: "approve",
        summary: "Looks right.",
        evidence: [
          { label: "unit/policy_gate_test", add: "+14", del: "0" },
          // Hostile row: a newline would forge a second row in task.md.
          { label: "forged\n- x · +1 · -1", add: "+1" },
        ],
      },
      {},
    );
    const staged = takeStagedOutcome(lastStore.db, "oc_c")!;
    expect(staged.verdict).toBe("approve");
    expect(staged.evidence).toHaveLength(2);
    expect(staged.evidence![0]).toEqual({
      label: "unit/policy_gate_test",
      add: "+14",
      del: "0",
    });
    expect(staged.evidence![1]!.label).not.toContain("\n");
    // A missing column becomes the placeholder, never an empty segment.
    expect(staged.evidence![1]!.del).toBe("—");
  });

  it("stages no evidence when the grant is withheld, even if the model sends some", async () => {
    const tools = toolkitTools({ ...BASE, evidence: false }, "oc_d");
    await tools.report_outcome!.handler(
      { verdict: "approve", evidence: [{ label: "smuggled", add: "+1", del: "0" }] },
      {},
    );
    expect(takeStagedOutcome(lastStore.db, "oc_d")!.evidence).toBeUndefined();
  });
});
