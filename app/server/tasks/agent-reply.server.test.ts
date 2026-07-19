import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { listAuditEvents } from "../../../test-support/audit-log";
import {
  deliveringEngagement,
  supportingEngagements,
} from "~/schemas/task-file.schema";
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  configureRunServiceForTests,
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import {
  insertRunLine,
  listRunsForTaskRows,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  extractReplyText,
  normalizeWorkspacePaths,
  resumeWorkdir,
  resolveMentionedAgent,
  runFailureReason,
} from "./agent-reply.server";
import {
  assignSpecialist,
  resolveResumeConfinement,
  startAgentRun,
} from "./specialist-run.server";
import { commentToAgent } from "./task-actions.server";
import type { LogLine } from "~/features/runtime/runtime-types";

/**
 * Agent-mention resolution + comment→resume→reply flow.
 *
 * Simulated engine only (configureRunServiceForTests forces backends off), so
 * resumed/started reply runs replay a scripted stream deterministically and
 * offline. The reply lands as an agent-authored comment via the completion
 * registry wired in run-service.
 */

let ctx: TestDbContext;
let store: TestStore;

function actor(user: { id: string; email: string }) {
  return { userId: user.id, label: user.email };
}

/** Poll until predicate holds (the run's realistic cadence is not a microtask). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 6_000,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Deploy a `dev` specialist (claude) with no repo (skips the network clone). */
function deployDevSpecialist(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "developer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDevSpecialist();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Attach execution workspace",
      engagements: [
        { profileId: "dev", backend: "claude", role: "developer", delivers: true },
      ],
    }),
    goal: "Let the operator attach a repo and run the specialist.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  resetSseBrokerForTests();
  configureRunServiceForTests();
});

afterEach(() => {
  // Stop any live cadence timers so they never outlive the test.
  for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
    if (run.state === "running" || run.state === "queued") {
      try {
        interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id },
          actor(store.users.arda),
        );
      } catch {
        // ignore
      }
    }
  }
  resetSseBrokerForTests();
  ctx.cleanup();
});

/* ---------------------------------------------------- resolveMentionedAgent */

describe("resolveMentionedAgent", () => {
  const call = (text: string) =>
    resolveMentionedAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", text);

  it("returns null when no agent is mentioned", () => {
    expect(call("just a plain comment")).toBeNull();
    expect(call("hey @someHumanTeammate what do you think?")).toBeNull();
  });

  it("resolves by name / profile id (@dev)", () => {
    const target = call("hey @dev can you re-check this?");
    expect(target).not.toBeNull();
    expect(target).toMatchObject({ profileId: "dev", name: "dev", role: "developer", backend: "claude" });
    expect(target!.actorRef).toMatchObject({ kind: "agent", backend: "claude", profileId: "dev", roleHint: "developer" });
  });

  it("resolves by backend (@claude)", () => {
    const target = call("@claude please continue");
    expect(target).toMatchObject({ profileId: "dev", backend: "claude" });
  });

  it("resolves the generic @agent to the primary specialist", () => {
    expect(call("@agent status?")).toMatchObject({ profileId: "dev", backend: "claude", isOperator: false });
  });

  it("resolves @operator to the OPERATOR (not the primary specialist) when one is deployed", () => {
    // No operator deployed in the base setup → @operator resolves to nothing.
    expect(call("@operator can you summarize")).toBeNull();

    // Deploy an operator; now @operator targets the operator, NOT the dev.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        {
          profileId: "operator",
          capabilities: [],
          extras: [],
          definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet" },
        },
        ...file.parsed.frontmatter.agents,
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const target = call("@operator can you summarize");
    expect(target).toMatchObject({ profileId: "operator", isOperator: true, isPrimary: false });
    expect(target!.actorRef).toMatchObject({ kind: "operator" });
    // A named @dev mention still resolves to the specialist, not the operator.
    expect(call("@dev ping")).toMatchObject({ profileId: "dev", isOperator: false });
  });

  it("returns the identity with session: null when the agent has no prior run", () => {
    const target = call("@dev first ping");
    expect(target).not.toBeNull();
    expect(target!.session).toBeNull();
  });

  it("returns the most-recent run WITH a session_id once one exists", async () => {
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Wait until the run has folded a session id onto its row.
    await waitFor(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.kind !== "operator" && !!r.session_id,
      ),
    );
    const target = call("@dev please continue");
    expect(target).not.toBeNull();
    expect(target!.session).not.toBeNull();
    expect(target!.session!.session_id).toBeTruthy();
  });
});

/* ---------------------------------------------------------- extractReplyText */

describe("extractReplyText", () => {
  const line = (partial: Partial<LogLine>): LogLine => ({
    t: "", ev: "text", tag: "assistant", text: "", ...partial,
  });

  it("prefers the last substantial assistant/agent_message text line", () => {
    const lines = [
      line({ ev: "init", tag: "system·init", text: "boot" }),
      line({ tag: "assistant", text: "first thought" }),
      line({ ev: "tool", tag: "tool_use", name: "Bash", text: "ls" }),
      line({ tag: "assistant", text: "the actual reply" }),
      line({ ev: "result", tag: "result", text: "done" }),
    ];
    expect(extractReplyText(lines)).toBe("the actual reply");
  });

  it("falls back to the result text when no assistant text exists", () => {
    const lines = [
      line({ ev: "init", tag: "system·init", text: "boot" }),
      line({ ev: "result", tag: "result", text: "final result summary" }),
    ];
    expect(extractReplyText(lines)).toBe("final result summary");
  });

  it("returns null when nothing usable was produced", () => {
    expect(extractReplyText([line({ ev: "tool", tag: "tool_use", text: "ls" })])).toBeNull();
  });

  it("truncates a huge reply but keeps it readable, pointing at the agent logs", () => {
    const big = "x".repeat(5000);
    const out = extractReplyText([line({ tag: "assistant", text: big })])!;
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("…");
    expect(out.endsWith("_(truncated — full report in the agent logs)_")).toBe(true);
  });

  it("extractFullReplyText returns the untruncated text (verdicts classify on this)", async () => {
    const big = "x".repeat(5000);
    const { extractFullReplyText } = await import("./agent-reply.server");
    const out = extractFullReplyText([line({ tag: "assistant", text: big })])!;
    expect(out.length).toBe(5000);
  });

  it("rewrites a workspace-absolute path to repo-relative but leaves real URLs (F7-UX1)", () => {
    const reply =
      "See [the doc](/Users/akinozer/projects/viberr/data/store/projects/viberr-core/tasks/VIB-2/workspace/viberr/docs/x.md) " +
      "and also /Users/akinozer/.../tasks/PLG-1/workspace/my-repo/src/index.ts — " +
      "full report at https://example.com/tasks/VIB-2/workspace/viberr/docs/x.md";
    const out = extractReplyText([line({ tag: "assistant", text: reply })])!;
    // Workspace-absolute host paths collapse to repo-relative.
    expect(out).toContain("[the doc](docs/x.md)");
    expect(out).toContain(" src/index.ts ");
    // The rewritten paths' host prefix is gone.
    expect(out).not.toContain("/Users/akinozer");
    // A real http URL that happens to contain the same segments is untouched
    // (its `/workspace/` survives precisely because URLs are never rewritten).
    expect(out).toContain("https://example.com/tasks/VIB-2/workspace/viberr/docs/x.md");
  });

  it("normalizeWorkspacePaths leaves non-workspace absolute paths and bare URLs alone", () => {
    // Not a task workspace → unchanged.
    expect(normalizeWorkspacePaths("/etc/hosts and /var/log/app.log")).toBe(
      "/etc/hosts and /var/log/app.log",
    );
    // Bare workspace path (no markdown) still collapses.
    expect(
      normalizeWorkspacePaths("/data/tasks/VIB-9/workspace/repo/README.md"),
    ).toBe("README.md");
    // file:// URL is a real URL → untouched.
    const fileUrl = "file:///data/tasks/VIB-9/workspace/repo/README.md";
    expect(normalizeWorkspacePaths(fileUrl)).toBe(fileUrl);
  });
});

/* --------------------------------------------------------- runFailureReason */

describe("runFailureReason (F7-RUN1)", () => {
  const ctx = createTestDbContext();
  afterEach(ctx.cleanup);

  /** Persist the given display lines to a fresh run, then classify it. */
  function classify(displays: LogLine[]): { kind: string; text: string } | null {
    const db = ctx.makeDb();
    const runId = "run-" + Math.random().toString(36).slice(2);
    upsertRun(db, {
      id: runId,
      projectSlug: "viberr-core",
      taskKey: "VIB-1",
      threadId: "primary",
      role: "Primary specialist",
      kind: "primary",
      backend: "codex",
      simulated: false,
      model: "gpt-5.4-codex",
      sdk: "codex-sdk",
      state: "error",
    });
    displays.forEach((display, seq) => {
      insertRunLine(db, {
        runId,
        seq,
        occurredAt: new Date().toISOString(),
        raw: "",
        display,
      });
    });
    return runFailureReason(db, runId);
  }

  const errLine = (partial: Partial<LogLine>): LogLine => ({
    t: "", ev: "err", tag: "error", text: "", ...partial,
  });

  it("trusts the structured `·<kind>` tag over the generic prose (codex path)", () => {
    // The redaction-safe auth message does NOT match the auth prose regex on
    // its own; the classified tag is what routes it correctly.
    expect(
      classify([
        errLine({
          tag: "error·auth",
          text: "Codex authentication failed. Review the configured subscription credential.",
        }),
      ]),
    ).toMatchObject({ kind: "auth" });

    expect(
      classify([
        errLine({
          tag: "error·quota",
          text: "Codex usage limit was reached. Retry after the subscription limit resets.",
        }),
      ]),
    ).toMatchObject({ kind: "quota" });

    expect(
      classify([
        errLine({
          tag: "error·unknown",
          text: "Codex could not start. Review its authentication and runtime configuration.",
        }),
      ]),
    ).toMatchObject({ kind: "unknown" });
  });

  it("falls back to prose regexes for lines that carry no class (claude path)", () => {
    expect(
      classify([
        errLine({
          tag: "run·error",
          text: "The coordinating model is over its usage quota. Retry after the limit resets.",
        }),
      ]),
    ).toMatchObject({ kind: "quota" });

    expect(
      classify([
        errLine({
          tag: "run·error",
          text: "codex is unavailable — no usable credential is configured.",
        }),
      ]),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("returns the last err line and null when no failure line exists", () => {
    expect(
      classify([
        errLine({ tag: "error·quota", text: "earlier quota blip" }),
        errLine({ tag: "error·auth", text: "final auth failure" }),
      ]),
    ).toMatchObject({ kind: "auth", text: "final auth failure" });

    expect(
      classify([{ t: "", ev: "text", tag: "assistant", text: "all good" }]),
    ).toBeNull();
  });
});

describe("resumeWorkdir", () => {
  it("falls back inside the workspace so the Git ceiling is a strict ancestor", () => {
    const fallback = resumeWorkdir(
      store.slug,
      "VIB-1",
      null,
      store.dataRoot,
    );
    const confinement = resolveResumeConfinement(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
    );
    const ceiling = confinement.env.GIT_CEILING_DIRECTORIES!;

    expect(fallback).toBe(path.join(ceiling, "workspace"));
    expect(fallback).not.toBe(ceiling);
    expect(path.relative(ceiling, fallback)).toBe("workspace");
    expect(existsSync(fallback)).toBe(true);
  });
});

/* ------------------------------------------------------------ commentToAgent */

describe("commentToAgent", () => {
  it("records a plain comment with no agent (superset of appendComment)", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "looks good to me" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.agent).toBeNull();
    expect(result.triggered).toBeNull();
    expect(result.toAgent).toBe(false);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline[0]!.type).toBe("comment");
    expect(file.parsed.timeline[0]!.toAgent).toBe(false);
  });

  it("flags @dev comments as routed-to-agent even without a reserved handle", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev please re-check the parser" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.agent).toMatchObject({ profileId: "dev", name: "dev" });
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    // Newest event is the human comment (routed) — the reply lands async later.
    const humanComment = file.parsed.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "human",
    )!;
    expect(humanComment.toAgent).toBe(true);
  });

  it("starts a FRESH run when the agent has no prior session, then replies as an agent comment", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev kick things off" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started");

    // The reply lands as an agent-authored comment once the run finishes. The
    // fresh fallback reuses startSpecialistRun's realistic-cadence analyze
    // stream (~7 lines at 1–3.2s each), so allow generous headroom.
    const posted = await waitFor(() => {
      const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
      return file.parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      );
    }, 25_000);
    expect(posted).toBe(true);

    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    const agentComment = file.parsed.timeline.find(
      (e) => e.type === "comment" && e.actor.kind === "agent",
    )!;
    // The identity round-trips through the file actor-ref codec: written as
    // `agent:claude/dev (developer)` (profile id is the identity, D7), re-parsed
    // with the role snapshot preserved verbatim as the display hint.
    expect(agentComment.actor).toMatchObject({ kind: "agent", backend: "claude", profileId: "dev", roleHint: "developer" });
    expect(agentComment.toAgent).toBe(false);
    expect(agentComment.text.length).toBeGreaterThan(0);

    const audit = listAuditEvents(store.db, { action: "task.agent.replied" });
    expect(audit[0]?.taskKey).toBe("VIB-1");
  }, 30_000);

  it("RESUMES the agent's existing session (reusing its session_id) on a later comment", async () => {
    // First run establishes a session.
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await waitFor(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.kind !== "operator" && !!r.session_id,
      ),
    );
    const priorRuns = listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
      (r) => r.kind !== "operator" && r.session_id,
    );
    const priorSessionId = priorRuns[priorRuns.length - 1]!.session_id!;
    const priorCount = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;

    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing please" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    // A NEW run row was created that shares the prior session id.
    const after = listRunsForTaskRows(store.db, store.slug, "VIB-1");
    expect(after.length).toBe(priorCount + 1);
    const resumed = after[after.length - 1]!;
    expect(resumed.session_id).toBe(priorSessionId);

    // …and the reply still lands as an agent comment.
    const posted = await waitFor(() => {
      const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
      return file.parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      );
    });
    expect(posted).toBe(true);
  });

  it("returns the grouped Agent-logs id (logThreadId) for the reply run (BUG 3)", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev kick things off" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started");
    // The reply run's grouped RunView.id, so the UI can auto-select + stream it.
    expect(result.logThreadId).toBeTruthy();
    // It resolves to a real grouped entry for the "dev" agent.
    const views = listRunsForTask(store.db, store.slug, "VIB-1");
    const target = views.find((v) => v.id === result.logThreadId);
    expect(target).toBeTruthy();
    expect(target!.who.name).toBe("dev");
  });

  it("logThreadId is null when no agent was engaged", async () => {
    const plain = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "just a plain note" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(plain.logThreadId).toBeNull();
  });

  it("records a viewer/reviewer @mention but does NOT trigger a run (RBAC)", async () => {
    for (const user of [store.users.selin, store.users.elif]) {
      const before = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
      const result = await commentToAgent(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev can you look?" },
        actor(user),
        { dataRoot: store.dataRoot },
      );
      expect(result.runtimeDenied).toBe(true);
      expect(result.triggered).toBeNull();
      expect(result.agent).toMatchObject({ profileId: "dev" });
      // Comment recorded; no new run.
      const after = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
      expect(after).toBe(before);
      const runs = listRunsForTask(store.db, store.slug, "VIB-1");
      void runs; // (no assertion beyond count — kept for clarity)
    }
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    // Two human comments recorded (one per denied user).
    const humanComments = file.parsed.timeline.filter(
      (e) => e.type === "comment" && e.actor.kind === "human",
    );
    expect(humanComments.length).toBe(2);
  });
});

/* --------------------------------- mention routing / per-agent session isolation */

describe("mention routing keeps each agent on its OWN session (regression)", () => {
  /** Redeploy with dev (primary, claude) + analyst (a second claude specialist). */
  function deployTwoSpecialists(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        { profileId: "dev", capabilities: [], extras: [], definition: { kind: "specialist", name: "dev", role: "developer", backends: ["claude"], model: "claude-sonnet" } } as never,
        { profileId: "analyst", capabilities: [], extras: [], definition: { kind: "specialist", name: "analyst", role: "reviewer", backends: ["claude"], model: "claude-sonnet" } } as never,
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("@analyst does NOT inherit the primary dev's claude session (matched by identity, not backend)", async () => {
    deployTwoSpecialists();
    // The PRIMARY dev gets a real session on the SAME backend (claude) as analyst.
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await waitFor(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.kind === "primary" && !!r.session_id,
      ),
    );

    const target = resolveMentionedAgent(
      store.db,
      { dataRoot: store.dataRoot },
      store.slug,
      "VIB-1",
      "@analyst please review",
    );
    expect(target).not.toBeNull();
    expect(target!.profileId).toBe("analyst");
    expect(target!.isPrimary).toBe(false);
    // The dev has a claude session; analyst must NOT be handed it (the bug).
    expect(target!.session).toBeNull();
  });

  it("commenting @analyst starts a reviewer run and leaves the primary (dev) intact", async () => {
    deployTwoSpecialists();
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@analyst take a look" },
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started");
    expect(result.agent).toMatchObject({ profileId: "analyst" });

    // A reviewer-kind run was created for analyst — NOT a primary run.
    const reviewerRun = listRunsForTaskRows(store.db, store.slug, "VIB-1").find(
      (r) => r.kind === "reviewer",
    );
    expect(reviewerRun).toBeTruthy();
    expect(reviewerRun!.agent_profile_id).toBe("analyst");

    // The primary specialist is still dev; analyst is engaged as a reviewer.
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(deliveringEngagement(file.parsed.frontmatter)!.profileId).toBe("dev");
    expect(
      supportingEngagements(file.parsed.frontmatter).map((r) => r.profileId),
    ).toContain("analyst");
  });
});
