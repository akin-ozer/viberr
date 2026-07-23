import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
} from "../../../test-support/test-store";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { postAgentComment, openAgentQuestionPacket } from "./agent-toolkit.server";
import type { FileActorRef } from "~/server/files/actor-ref.server";

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
