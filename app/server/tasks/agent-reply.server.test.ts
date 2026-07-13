import { existsSync, mkdirSync, rmSync } from "node:fs";
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
import { readTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  configureRunServiceForTests,
  interruptRun,
  listRunsForTask,
  startRun,
} from "~/server/runtimes/run-service.server";
import { getRun, listRunsForTaskRows } from "~/server/runtimes/run-store.server";
import {
  advanceRunCompletionPhase,
  RUN_COMPLETION_PHASE,
} from "~/server/runtimes/run-completion-state.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import { setBackendAvailability } from "~/server/runtimes/runtime-registry.server";
import type {
  RunCallbacks,
  RunHandle,
  RunSpec,
  RuntimeAdapter,
} from "~/server/runtimes/adapter.server";
import { defaultModelFor } from "~/server/runtimes/model-catalog.server";
import { projectDir, taskDir } from "~/server/files/file-store-root.server";
import {
  extractReplyText,
  resumeWorkdir,
  resolveMentionedAgent,
} from "./agent-reply.server";
import {
  assignSpecialist,
  resolveResumeConfinement,
  startSpecialistRun,
} from "./specialist-run.server";
import { commentToAgent } from "./task-actions.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { repositoryWorkspaceKey } from "./specialist-preflight.server";
import { purgeProjectOperationalState } from "~/server/projects/project-operational-state.server";
import {
  deleteProject,
  setProjectArchived,
} from "~/features/project-settings/settings-actions.server";

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
function deployDevSpecialist(
  backends: ("claude" | "codex")[] = ["claude"],
  model = backends[0] === "codex" ? "gpt-5.4-codex" : "claude-sonnet",
): void {
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
          backends,
          model,
        },
      } as never,
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

async function establishInstantDevSession(): Promise<string> {
  const started = await startRun(store.db, {
    projectSlug: store.slug,
    taskKey: "VIB-1",
    threadId: `prior-dev-${Date.now()}`,
    role: "Primary specialist",
    kind: "primary",
    backend: "claude",
    model: "claude-sonnet",
    agentName: "dev",
    agentProfileId: "dev",
    runPurpose: "conversation",
    prompt: "Establish a provider session for resume-race coverage.",
    script: {
      lines: [],
      sessionId: "session-resume-race",
      backend: "claude",
      model: "claude-sonnet",
      op: false,
      instant: true,
    },
    dataRoot: store.dataRoot,
  });
  const settled = await waitFor(
    () => {
      const run = getRun(store.db, started.runId);
      return (
        run?.session_id === "session-resume-race" &&
        run.state !== "queued" &&
        run.state !== "running"
      );
    },
  );
  if (!settled) throw new Error("Prior dev session did not settle.");
  // This helper represents a fully delivered prior conversation. Raw
  // startRun has no specialist attachment callback to advance the checkpoint.
  advanceRunCompletionPhase(
    store.db,
    started.runId,
    RUN_COMPLETION_PHASE.complete,
  );
  return started.runId;
}

function replaceProjectAtMentionBoundary(): {
  hook: () => void;
  replacementRun: () => ReturnType<typeof startRun> | null;
} {
  const original = readProjectFile({
    projectSlug: store.slug,
    dataRoot: store.dataRoot,
  })!;
  let control: ReturnType<typeof startRun> | null = null;
  return {
    hook: () => {
      rmSync(projectDir(store.slug, store.dataRoot), {
        recursive: true,
        force: true,
      });
      purgeProjectOperationalState(store.db, store.slug, store.dataRoot);
      writeProject(store.dataRoot, original.parsed.frontmatter);
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-1", {
          stage: "impl",
          ownerUserId: store.users.arda.id,
          title: "Replacement mention lifecycle",
          specialist: null,
          reviewers: [],
          waiting: "human",
          createdAt: "2026-07-13T14:00:00.000Z",
          updatedAt: "2026-07-13T14:00:00.000Z",
        }),
        goal: "Old mention work must not cross into this replacement.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      control = startRun(store.db, {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: "replacement-mention-control",
        role: "Replacement control",
        kind: "primary",
        backend: "claude",
        model: "claude-sonnet",
        prompt: "Keep the replacement lifecycle visible.",
        script: {
          lines: [],
          sessionId: "replacement-control",
          backend: "claude",
          model: "claude-sonnet",
          op: false,
          keepRunning: true,
        },
        dataRoot: store.dataRoot,
      });
    },
    replacementRun: () => control,
  };
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
      specialist: { profileId: "dev", backend: "claude", role: "developer" },
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
    expect(target!.actorRef).toMatchObject({ kind: "agent", backend: "claude", role: "developer" });
  });

  it("resolves by backend (@claude)", () => {
    const target = call("@claude please continue");
    expect(target).toMatchObject({ profileId: "dev", backend: "claude" });
  });

  it("resolves the generic @agent to the primary specialist", () => {
    expect(call("@agent status?")).toMatchObject({ profileId: "dev", backend: "claude", isOperator: false });
  });

  it("uses the persisted assignment backend for named and generic mentions", () => {
    deployDevSpecialist(["claude", "codex"], "claude-sonnet");
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        specialist: {
          profileId: "dev",
          backend: "codex",
          role: "developer",
        },
      }),
      goal: "Let the operator attach a repo and run the specialist.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    for (const mention of ["@dev continue", "@agent continue"]) {
      expect(call(mention)).toMatchObject({
        profileId: "dev",
        backend: "codex",
        model: defaultModelFor("codex"),
        isPrimary: true,
      });
    }
  });

  it("treats a declared backend handle as an explicit fresh-run choice", () => {
    deployDevSpecialist(["claude", "codex"], "claude-sonnet");
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        specialist: null,
      }),
      goal: "Let the operator attach a repo and run the specialist.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect(call("@codex take this task")).toMatchObject({
      profileId: "dev",
      backend: "codex",
      model: defaultModelFor("codex"),
      session: null,
    });
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
    await establishInstantDevSession();
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
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        profileId: "dev",
        backend: "claude",
      },
    );
    const ceiling = confinement.env.GIT_CEILING_DIRECTORIES!;

    expect(fallback).toBe(path.join(ceiling, "workspace"));
    expect(fallback).not.toBe(ceiling);
    expect(path.relative(ceiling, fallback)).toBe("workspace");
    expect(existsSync(fallback)).toBe(true);
  });

  it("reuses only the checkout keyed by full repository identity", () => {
    const expected = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      repositoryWorkspaceKey("acme/web"),
    );
    const unrelated = path.join(
      taskDir(store.slug, "VIB-1", store.dataRoot),
      "workspace",
      repositoryWorkspaceKey("fork/web"),
    );
    mkdirSync(path.join(expected, ".git"), { recursive: true });
    mkdirSync(path.join(unrelated, ".git"), { recursive: true });
    expect(
      resumeWorkdir(
        store.slug,
        "VIB-1",
        "acme/web",
        store.dataRoot,
      ),
    ).toBe(expected);
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
    // The role round-trips through the file actor-ref codec: written as the
    // slug `claude/developer`, re-parsed as the title-cased display "Developer".
    expect(agentComment.actor).toMatchObject({ kind: "agent", backend: "claude", role: "Developer" });
    expect(agentComment.toAgent).toBe(false);
    expect(agentComment.text.length).toBeGreaterThan(0);

    const audit = listAuditEvents(store.db, { action: "task.agent.replied" });
    expect(audit[0]?.taskKey).toBe("VIB-1");
  }, 30_000);

  it("RESUMES the agent's existing session (reusing its session_id) on a later comment", async () => {
    // First run establishes a session.
    await establishInstantDevSession();
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

  it("rechecks a mentioner's live role after workspace preparation before resume", async () => {
    await establishInstantDevSession();
    const beforeCount = listRunsForTaskRows(
      store.db,
      store.slug,
      "VIB-1",
    ).length;
    const setMuratRole = (role: "maintainer" | "viewer") => {
      const project = readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!;
      writeProject(store.dataRoot, {
        ...project.parsed.frontmatter,
        members: project.parsed.frontmatter.members.map((member) =>
          member.userId === store.users.murat.id ? { ...member, role } : member,
        ),
      });
    };

    await expect(
      commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@dev continue after checking the workspace",
        },
        actor(store.users.murat),
        {
          dataRoot: store.dataRoot,
          runtimeLaunchAuthorizationHookForTests: ({ kind }) => {
            if (kind === "resume") setMuratRole("viewer");
          },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1"),
    ).toHaveLength(beforeCount);
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(
      task.timeline.some(
        (event) =>
          event.type === "comment" &&
          event.actor.kind === "human" &&
          event.text.includes("continue after checking the workspace"),
      ),
    ).toBe(true);

    // The denied resume never transferred the workspace lease to a provider.
    setMuratRole("maintainer");
    const retry = await commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@dev retry after authority is restored",
      },
      actor(store.users.murat),
      { dataRoot: store.dataRoot },
    );
    expect(retry.triggered).toBe("resumed");
  });

  it("stops a resumed mention before waiting/callback attachment when archive wins the post-resume boundary", async () => {
    await establishInstantDevSession();
    let archive: Promise<unknown> | null = null;
    let resumedRunId: string | null = null;

    const request = commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@dev answer before archive",
      },
      actor(store.users.arda),
      {
        dataRoot: store.dataRoot,
        launchAttachmentHookForTests: ({ runId, resumed }) => {
          if (!resumed) return;
          resumedRunId = runId;
          archive = setProjectArchived(
            store.db,
            { projectSlug: store.slug, archived: true },
            actor(store.users.arda),
            { dataRoot: store.dataRoot },
          );
        },
      },
    );

    await expect(request).rejects.toMatchObject({ code: "conflict", status: 409 });
    if (!archive || !resumedRunId) throw new Error("Resume archive race did not execute.");
    await archive;
    expect(getRun(store.db, resumedRunId)?.state).toBe("interrupted");
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.waiting).toBe("human");
    expect(
      task.timeline.some(
        (event) => event.type === "comment" && event.actor.kind === "agent",
      ),
    ).toBe(false);
  });

  it("keeps a resumed mention workspace leased after attachment failure until provider exit", async () => {
    await establishInstantDevSession();
    const pending: Array<{ spec: RunSpec; callbacks: RunCallbacks }> = [];
    let acknowledgeInterrupt = false;
    const held: RuntimeAdapter = {
      backend: "claude",
      start(spec: RunSpec, callbacks: RunCallbacks): RunHandle {
        pending.push({ spec, callbacks });
        return {
          runId: spec.runId,
          interrupt() {
            if (acknowledgeInterrupt) {
              callbacks.onExit({
                outcome: "interrupted",
                effectiveBackend: "claude",
                simulated: false,
                sessionId: null,
              });
            }
          },
        };
      },
    };
    configureRunServiceForTests({
      claude: held,
      codex: held,
      simulated: held,
    });
    setBackendAvailability("claude", true);

    try {
      await expect(
        commentToAgent(
          store.db,
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            text: "@dev fail during attachment",
          },
          actor(store.users.arda),
          {
            dataRoot: store.dataRoot,
            launchAttachmentHookForTests: ({ resumed }) => {
              if (resumed) throw new Error("injected mention attachment failure");
            },
          },
        ),
      ).rejects.toThrow("injected mention attachment failure");
      expect(pending).toHaveLength(1);

      await expect(
        commentToAgent(
          store.db,
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            text: "@dev do not reuse the workspace yet",
          },
          actor(store.users.arda),
          { dataRoot: store.dataRoot },
        ),
      ).rejects.toThrow(/already has a run in progress/i);

      pending[0]!.callbacks.onExit({
        outcome: "interrupted",
        effectiveBackend: "claude",
        simulated: false,
        sessionId: null,
      });
      const successor = await commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@dev continue after provider exit",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(successor.triggered).toBe("resumed");
      acknowledgeInterrupt = true;
    } finally {
      setBackendAvailability("claude", false);
    }
  });

  it("stops a resumed mention and lets delete drain before canonical removal", async () => {
    await establishInstantDevSession();
    let deletion: Promise<unknown> | null = null;
    let resumedRunId: string | null = null;

    const request = commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@dev answer before deletion",
      },
      actor(store.users.arda),
      {
        dataRoot: store.dataRoot,
        launchAttachmentHookForTests: ({ runId, resumed }) => {
          if (!resumed) return;
          resumedRunId = runId;
          deletion = deleteProject(
            store.db,
            { projectSlug: store.slug, confirmName: "Viberr Core" },
            actor(store.users.arda),
            { dataRoot: store.dataRoot },
          );
        },
      },
    );

    await expect(request).rejects.toMatchObject({ code: "conflict", status: 409 });
    if (!deletion || !resumedRunId) throw new Error("Resume delete race did not execute.");
    await deletion;
    expect(getRun(store.db, resumedRunId)).toBeNull();
    expect(
      readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot }),
    ).toBeNull();
  });

  it("never attaches a resumed mention to a same-slug replacement", async () => {
    await establishInstantDevSession();
    const replacement = replaceProjectAtMentionBoundary();

    await expect(
      commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@dev answer only on the original task",
        },
        actor(store.users.arda),
        {
          dataRoot: store.dataRoot,
          launchAttachmentHookForTests: ({ resumed }) => {
            if (resumed) replacement.hook();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    const replacementStart = replacement.replacementRun();
    if (!replacementStart) throw new Error("Resume replacement race did not execute.");
    const control = await replacementStart;
    expect(getRun(store.db, control.runId)?.state).toBe("running");
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.waiting).toBe("human");
    expect(task.frontmatter.specialist).toBeNull();
    expect(task.timeline).toHaveLength(0);
  });

  it("does not assign or start fresh mention work on a replacement resolved after the original comment", async () => {
    const replacement = replaceProjectAtMentionBoundary();

    await expect(
      commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@dev start only for the original task",
        },
        actor(store.users.arda),
        {
          dataRoot: store.dataRoot,
          mentionEngagementHookForTests: replacement.hook,
        },
      ),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });

    const replacementStart = replacement.replacementRun();
    if (!replacementStart) throw new Error("Fresh replacement race did not execute.");
    const control = await replacementStart;
    expect(getRun(store.db, control.runId)?.state).toBe("running");
    const task = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed;
    expect(task.frontmatter.specialist).toBeNull();
    expect(task.frontmatter.reviewers).toEqual([]);
    expect(task.frontmatter.waiting).toBe("human");
    expect(task.timeline).toHaveLength(0);
  });

  it("resumes a real repo-less mention in a task-scoped non-Git workdir", async () => {
    await establishInstantDevSession();

    setBackendAvailability("claude", true);
    try {
      const result = await commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@dev explain the result without repository work",
        },
        actor(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(result.triggered).toBe("resumed");
      const resumed = listRunsForTaskRows(
        store.db,
        store.slug,
        "VIB-1",
      ).at(-1)!;
      expect(resumed.simulated).toBe(0);
      expect(resumed.run_purpose).toBe("conversation");
      expect(resumed.review_evidence_fingerprint).toBeNull();
      const workdir = path.join(
        taskDir(store.slug, "VIB-1", store.dataRoot),
        "workspace",
        "repo-less",
      );
      expect(existsSync(workdir)).toBe(true);
      expect(existsSync(path.join(workdir, ".git"))).toBe(false);
      interruptRun(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", runId: resumed.id },
        actor(store.users.arda),
      );
    } finally {
      setBackendAvailability("claude", false);
    }
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

  it("does not retarget an @operator comment when its task is replaced after the comment write", async () => {
    const project = readProjectFile({
      projectSlug: store.slug,
      dataRoot: store.dataRoot,
    })!;
    writeProject(store.dataRoot, {
      ...project.parsed.frontmatter,
      agents: [
        ...project.parsed.frontmatter.agents,
        {
          profileId: "operator",
          capabilities: [],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "claude-sonnet",
          },
        } as never,
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const replacementCreatedAt = "2026-07-13T15:00:00.000Z";
    await expect(
      commentToAgent(
        store.db,
        {
          projectSlug: store.slug,
          taskKey: "VIB-1",
          text: "@operator coordinate only the task I am commenting on",
        },
        actor(store.users.arda),
        {
          dataRoot: store.dataRoot,
          mentionEngagementHookForTests: () => {
            writeTask(store.dataRoot, store.slug, {
              frontmatter: baseTaskFrontmatter("VIB-1", {
                stage: "impl",
                readiness: "ready",
                waiting: "none",
                ownerUserId: store.users.arda.id,
                title: "Same-key replacement",
                createdAt: replacementCreatedAt,
                updatedAt: replacementCreatedAt,
              }),
              goal: "This replacement must not inherit the old comment intent.",
            });
            rebuildAll(store.db, {
              dataRoot: store.dataRoot,
              force: true,
            });
          },
        },
      ),
    ).rejects.toThrow(/no longer active/);

    expect(
      readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })?.parsed.frontmatter.createdAt,
    ).toBe(replacementCreatedAt);
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
        (run) => run.kind === "operator",
      ),
    ).toHaveLength(0);
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
    await establishInstantDevSession();

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
    expect(file.parsed.frontmatter.specialist!.profileId).toBe("dev");
    expect(file.parsed.frontmatter.reviewers.map((r) => r.profileId)).toContain("analyst");
  });
});
