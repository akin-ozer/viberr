import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  deliveringEngagement,
  supportingEngagements,
} from "~/schemas/task-file.schema";
import { readTaskFile, updateTaskFile } from "~/server/files/task-writer.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { taskDir } from "~/server/files/file-store-root.server";
import { logger } from "~/server/logging/logger.server";
import {
  AGENT_GID,
  AGENT_UID_FLOOR,
  resetAgentIsolationForTests,
} from "~/server/runtimes/agent-isolation.server";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { drainRunCompletions, installFakeRuntime, queueFakeRun, startedRunSpecs } from "../../../test-support/fake-runtime";
import { connectFakeBackend } from "../../../test-support/backend-credentials";
import { pollUntil } from "../../../test-support/polling";
import { joinedPrompt } from "~/server/runtimes/prompt-prefix.server";
import { userBackendHome } from "~/server/runtimes/user-homes.server";
import { probeSessionContinuity } from "~/server/runtimes/session-export.server";
import {
  insertRunLine,
  listRunsForTaskRows,
  patchRun,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import {
  agentMentionHandle,
  ambiguousBackendHandle,
  ambiguousBackendHandleNote,
  extractReplyText,
  normalizeWorkspacePaths,
  resumeWorkdir,
  resolveMentionedAgent,
  unreachedAgents,
  unreachedAgentNote,
  runFailureReason,
} from "./agent-reply.server";
import { resolveResumeConfinement, startAgentRun } from "./specialist-run.server";
import { commentToAgent } from "./task-comments.server";
import { deliverDeferredMention } from "./agent-completion.server";
import type { runOperator } from "~/server/runtimes/operator-run.server";
import type { LogLine } from "~/features/runtime/runtime-types";
import { emptyRunFailureFacts } from "~/shared/run-failure";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Agent-mention resolution + comment→resume→reply flow.
 *
 * Provider calls use the injected fake adapter. The reply lands as an
 * agent-authored comment via the completion
 * registry wired in run-service.
 */

let ctx: TestDbContext;
let store: TestStore;

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
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/** Ruling 211(h): a SECOND deployed profile, so a test can mention an agent
 *  that is real and is not the one under test — the state the cross-agent guard
 *  in `deliverDeferredMention` actually exists for. */
function deployReviewerSpecialist(): void {
  const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
  const fm = file.parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      ...fm.agents,
      {
        profileId: "reviewer",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "reviewer",
          role: "reviewer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      },
    ],
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

/**
 * P13-D-2: `resumeRun` probes for the provider transcript behind a stored
 * session id, and the fake runtime mints session ids (`fake-<runId>`) that were
 * never written to disk — so by default the probe finds no store at all and
 * answers `unknown`, which resumes exactly as before. A test that wants a LIVE
 * session materializes its transcript with `writeTranscript`.
 *
 * Ruling 127: the transcript lives in the RUN PRINCIPAL's own runtime home
 * (`<dataRoot>/runtimes/users/<id>/claude-home/projects/`), not in a shared
 * home a `CLAUDE_CONFIG_DIR` env var pointed at — so this writes into arda's
 * home under the test's own data root, which is also what makes the probe
 * hermetic without pinning anything in `process.env`.
 */
function writeTranscript(sessionId: string): void {
  const home = userBackendHome(store.users.arda.id, "claude", store.dataRoot);
  const dir = path.join(home, "projects", "-fake-cwd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

beforeEach(async () => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deployDevSpecialist();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      stage: "impl",
      ownerUserId: store.users.arda.id,
      title: "Attach execution workspace",
      engagements: [
        { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
      ],
    }),
    goal: "Let the operator attach a repo and run the specialist.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  installFakeRuntime();
  // Ruling 127: an agent run bills the TASK OWNER's own accounts, so a run
  // only reaches an adapter when the owner has that backend connected. Arda
  // owns the tasks in this file; connecting both backends for him is the
  // ordinary state of somebody using the product.
  await connectFakeBackend(store.db, store.users.arda.id, "claude");
  await connectFakeBackend(store.db, store.users.arda.id, "codex");
});

afterEach(async () => {
  // Stop any live cadence timers so they never outlive the test.
  for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
    if (run.state === "running" || run.state === "queued") {
      try {
        await interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id, dataRoot: store.dataRoot },
          actorOf(store.users.arda),
        );
      } catch {
        // ignore
      }
    }
  }
  // A resumed run's completion still writes after the assertions; the store
  // must outlive it.
  await drainRunCompletions();
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

  /**
   * B-AG2: a backend handle names a RUNTIME, not an agent. It used to be folded
   * into the same lookup as name/id, so on a project running two claude
   * profiles "@claude please look" deterministically engaged whichever
   * project.md listed first — an arbitrary pick the human could not predict and
   * a profile that may never have been meant for this task.
   */
  it("refuses an AMBIGUOUS backend handle instead of engaging the first-listed profile", () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    const specialist = (
      profileId: string,
      name: string,
    ): AgentDeployment => ({
      profileId,
      capabilities: [],
      extras: [],
      definition: {
        kind: "specialist",
        name,
        role: name,
        backends: ["claude"],
        model: "sonnet",
      },
    });
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        specialist("docs-writer", "Docs Writer"),
        specialist("security-reviewer", "Security Reviewer"),
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // Two claude profiles here → nobody is engaged on a bare backend handle.
    expect(call("@claude please look at this")).toBeNull();
    // …and the caller can say exactly why, naming both candidates.
    const ambiguous = ambiguousBackendHandle(
      { dataRoot: store.dataRoot },
      store.slug,
      "@claude please look at this",
    )!;
    expect(ambiguous.backend).toBe("claude");
    expect(ambiguous.candidates.map((c) => c.profileId)).toEqual([
      "docs-writer",
      "security-reviewer",
    ]);
    const note = ambiguousBackendHandleNote(ambiguous);
    expect(note).toContain("@docs-writer");
    expect(note).toContain("@security-reviewer");
    // F19-12: this note is posted into the task timeline, so it is rendered
    // copy — it must name the SHIPPED role ("delivering agent"), never the
    // retired "primary specialist" (D9/Q17-5). Nothing pinned the tail of this
    // sentence before, which is how the retired phrase survived here.
    expect(note).toContain("@agent for this task's delivering agent");
    expect(note).not.toMatch(/primary specialist/i);

    // Naming one still works, and so does the generic primary handle.
    expect(call("@security-reviewer take a look")).toMatchObject({
      profileId: "security-reviewer",
    });
    expect(
      ambiguousBackendHandle(
        { dataRoot: store.dataRoot },
        store.slug,
        "@security-reviewer take a look",
      ),
    ).toBeNull();
  });

  /**
   * Ruling 262 (pass 37, F37-92): the DISCLOSURE question, not the dispatch
   * question. `resolveMentionedAgent` returns at most one target because a run
   * needs exactly one; ruling 252 reused it as a completeness report, so three
   * more shapes fell through the stamp on top of the operator case.
   */
  describe("unreachedAgents reports every handle that reads nothing", () => {
    function report(text: string, taskKey = "VIB-1") {
      return unreachedAgents({ dataRoot: store.dataRoot }, store.slug, taskKey, text);
    }

    it("names an AMBIGUOUS backend handle and the profiles it covers", () => {
      deployReviewerSpecialist(); // a second claude → `@claude` engages nobody
      const r = report("@claude please look at this");
      expect(r.named).toEqual([]);
      expect(r.ambiguousBackend).toEqual({
        handle: "claude",
        candidates: ["dev", "reviewer"],
      });
      // CANARY: drop the `backendCandidates.length > 1` arm and the comment
      // says nothing at all, on the one case a HUMAN writing the same words
      // gets a policy-engine note for.
      const note = unreachedAgentNote(r, "controller");
      expect(note).toContain("@claude names a runtime, not an agent");
      expect(note).toContain("@dev");
      expect(note).toContain("@reviewer");
    });

    it("names @agent on a task with no delivering engagement", () => {
      writeTask(store.dataRoot, store.slug, {
        frontmatter: baseTaskFrontmatter("VIB-2", {
          stage: "impl",
          ownerUserId: store.users.arda.id,
          title: "Nobody is delivering this yet",
          engagements: [],
        }),
        goal: "No deliverer.",
      });
      rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
      const r = report("@agent status?", "VIB-2");
      expect(r.agentWithNoDeliverer).toBe(true);
      expect(r.named).toEqual([]);
      // CANARY: report `agentWithNoDeliverer: false` and the tag is silent.
      expect(unreachedAgentNote(r, "operator")).toContain(
        "@agent addresses the agent delivering this task",
      );
    });

    it("says nothing when every handle reaches somebody who reads it", () => {
      // A person's @handle is not an agent handle; the operator is excluded by
      // ruling 214 because a controller turn's other writes wake it anyway.
      expect(unreachedAgentNote(report("@operator over to you"), "controller")).toBeNull();
      expect(unreachedAgentNote(report("status published, nothing needed"), "controller")).toBeNull();
      // CANARY: return a sentence for an empty report and every ordinary
      // comment grows a paragraph about an agent it never tagged.
      expect(report("@agent status?").agentWithNoDeliverer).toBe(false);
    });
  });

  it("a backend handle that identifies exactly ONE deployed specialist still resolves", () => {
    // The base fixture deploys a single claude `dev` — unambiguous.
    expect(call("@claude please continue")).toMatchObject({ profileId: "dev" });
    expect(
      ambiguousBackendHandle(
        { dataRoot: store.dataRoot },
        store.slug,
        "@claude please continue",
      ),
    ).toBeNull();
    // A backend nobody is deployed on resolves to nothing here.
    expect(call("@codex please continue")).toBeNull();
  });

  it("resolves the generic @agent to the primary specialist", () => {
    expect(call("@agent status?")).toMatchObject({ profileId: "dev", backend: "claude", isOperator: false });
  });

  // P13-LV-11: the composer inserts the DISPLAY name and the timeline chips it,
  // but the resolver used to parse a single token — so every agent whose name
  // contains a space ("Docs Writer") silently routed nowhere.
  it("resolves a multi-word display name (@Docs Writer)", () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      agents: [
        {
          profileId: "docs-writer",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "Docs Writer",
            role: "Documentation",
            backends: ["claude"],
            model: "claude-sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    expect(call("@Docs Writer can you take another look?")).toMatchObject({
      profileId: "docs-writer",
      name: "Docs Writer",
    });
    // The profile id keeps working, and an unknown handle still resolves to
    // nothing rather than to the wrong agent.
    expect(call("@docs-writer ping")).toMatchObject({ profileId: "docs-writer" });
    expect(call("@Docs Reader ping")).toBeNull();
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
      ],
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

  it("never resumes the DEAD backend's session after a backend switch (P13-RT-12)", () => {
    // The `dev` profile ran on Claude and has a live Claude session…
    upsertRun(store.db, {
      id: "run_claude_old",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "claude-session-1",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    expect(call("@dev please continue")!.session?.session_id).toBe("claude-session-1");

    // …then an admin switches the profile to Codex (quota exhausted, say).
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    const fm = file.parsed.frontmatter;
    writeProject(store.dataRoot, {
      ...fm,
      agents: [
        {
          ...fm.agents[0]!,
          definition: {
            ...fm.agents[0]!.definition,
            backends: ["codex"],
            model: "gpt-5.6-sol",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // BEFORE: latestSessionRun matched on profile + kind only, so this resumed
    // the DEAD Claude session with `model: gpt-5.6-sol` — a (backend, model)
    // pairing that never existed; resolveClaudeModel doesn't recognize it, so
    // the run silently used the subscription default on the backend the admin
    // had just moved away from. The in-code comment already CLAIMED sessions
    // never match across backends; now they don't.
    const switched = call("@dev please continue");
    expect(switched).toMatchObject({ backend: "codex", profileId: "dev" });
    expect(switched!.session).toBeNull();
  });

  it("resumes on the STUCK retry pin, not the live profile backend (F28-P1)", () => {
    // `dev` ran on Claude and has a live Claude session…
    upsertRun(store.db, {
      id: "run_claude_prepin",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "claude-session-prepin",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    expect(call("@dev continue")!.session?.session_id).toBe(
      "claude-session-prepin",
    );

    // …then a "Retry on the other backend" resolution PINS the delivering
    // ENGAGEMENT to Codex (F27-B1) while the PROFILE stays Claude. The pin lives
    // on the engagement, not the profile — a plain profile edit would still win,
    // but a deliberate retry pin must be honored by a later @mention resume the
    // same way `specialist-run`'s resolver (`… ?? pinnedBackend ?? live …`) and
    // a fresh Run do. Before F28-P1 the resolver read only the live profile
    // backend, so `@agent` silently resumed the Claude session the pin escaped.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        title: "Attach execution workspace",
        engagements: [
          {
            profileId: "dev",
            backend: "claude",
            role: "developer",
            delivers: true,
            verdictCapable: false,
            pinnedBackend: "codex",
          },
        ],
      }),
      goal: "Let the operator attach a repo and run the specialist.",
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    // Both the generic `@agent` and the by-name `@dev` follow the pin (Codex),
    // not the live Claude deployment, and find no Codex session — so they start
    // fresh instead of resuming the dead-for-this-backend Claude one.
    for (const mention of ["@agent continue", "@dev continue"]) {
      const resolved = call(mention);
      expect(resolved).toMatchObject({ backend: "codex", profileId: "dev" });
      expect(resolved!.session).toBeNull();
    }
  });

  it("skips a run whose provider session is PROVEN gone (P13-D-2 stranding)", () => {
    // Two Claude sessions for `dev`: an older live one and the newest, whose
    // transcript the provider has since swept.
    const row = (id: string, threadId: string, sessionId: string) => ({
      id,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId,
      role: "developer",
      kind: "primary" as const,
      backend: "claude" as const,
      model: "sonnet",
      sdk: "claude",
      sessionId,
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished" as const,
    });
    upsertRun(store.db, row("run_live", "primary", "claude-session-live"));
    upsertRun(store.db, row("run_dead", "primary-r1", "claude-session-dead"));
    // Newest wins while nothing is known to be dead.
    expect(call("@dev continue")!.session!.id).toBe("run_dead");

    // The continuity probe proved the newest session gone and stamped the run.
    insertRunLine(store.db, {
      runId: "run_dead",
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: {
        t: "00:00:00",
        ev: "err",
        tag: "run·session_missing",
        text: "The Claude Code session claude-session-dead no longer exists on this machine.",
      },
    });

    // BEFORE: `latestSessionRun` had no state filter, so this kept returning
    // run_dead forever — every later @mention resumed the same dead id and the
    // agent was permanently unreachable on this task.
    expect(call("@dev continue")!.session!.id).toBe("run_live");
  });

  it("falls back to a FRESH run when every session of the agent is gone", () => {
    upsertRun(store.db, {
      id: "run_only",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "claude-session-gone",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    insertRunLine(store.db, {
      runId: "run_only",
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      display: { t: "00:00:00", ev: "err", tag: "run·session_missing", text: "gone" },
    });
    expect(call("@dev continue")!.session).toBeNull();
  });

  it("an agent merely PRINTING the marker cannot strand its own session", () => {
    upsertRun(store.db, {
      id: "run_chatty",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "claude-session-fine",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    insertRunLine(store.db, {
      runId: "run_chatty",
      seq: 0,
      occurredAt: new Date().toISOString(),
      raw: "{}",
      // The tag is the channel; the TEXT is agent output and carries no weight.
      display: {
        t: "00:00:00",
        ev: "text",
        tag: "assistant",
        text: "I added a `session_missing` failure kind — see run·session_missing.",
      },
    });
    expect(call("@dev continue")!.session!.id).toBe("run_chatty");
  });

  it("returns the most-recent run WITH a session_id once one exists", async () => {
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // Wait until the run has folded a session id onto its row.
    await pollUntil(() =>
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

/* ------------------------------------------------------- agentMentionHandle */

describe("agentMentionHandle (P14-RT-12)", () => {
  const call = (text: string) =>
    resolveMentionedAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", text);

  /** Re-deploy `dev` with a multi-word ROLE — the shape the two old, divergent
   *  derivations disagreed on. */
  function deployWithRole(role: string): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "dev",
            role,
            backends: ["claude"],
            model: "claude-sonnet",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  it("derives a handle that actually RESOLVES back to the agent", () => {
    deployWithRole("Senior Developer");
    const handle = agentMentionHandle({ profileId: "dev", name: "dev" });
    expect(handle).toBe("dev");
    expect(call(`@${handle} please continue`)).toMatchObject({ profileId: "dev" });
  });

  it("the old ROLE-derived handle resolved to nobody — which is the bug", () => {
    deployWithRole("Senior Developer");
    // `startAgentRun` used to register completion with the role's first word,
    // so the stuck packet's "Agent: @senior" named a handle no reply could use.
    expect(call("@senior please continue")).toBeNull();
  });

  it("prefers the profile id so the bare @word grammar matches it", () => {
    // A multi-word NAME is only resolvable to a reader that already knows the
    // name; the profile id routes for every reader (P14-RT-12).
    expect(
      agentMentionHandle({ profileId: "docs-writer", name: "Docs Writer" }),
    ).toBe("docs-writer");
    // Only a profile id that is not a bare token falls back to the name.
    expect(
      agentMentionHandle({ profileId: "docs writer", name: "Docs Writer" }),
    ).toBe("docs writer");
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

  it("does NOT fall back to the result line — those are runtime STATS (P13-RT-09)", () => {
    // REWRITTEN: this test used to assert the `result`-line fallback, which
    // enshrined the bug. The terminal result line's text is statistics, not
    // prose — "success · 3 turns · 12s · $0.02" on Claude, "in 4.1k (cached
    // 2.0k) · out 0.3k tokens" on Codex (wire-format). A run that only edited
    // files and exited therefore posted `success · 7 turns · 214s · $0.31` to
    // the timeline as the agent's REPORT, fed that string to the prose verdict
    // classifier, and — two such Codex runs can produce byte-identical text —
    // tripped the "verbatim repeat" stuck-loop detector for the wrong reason.
    // A run with no report of its own now honestly has none; the stats stay in
    // the run panel where they belong.
    const claudeStats = [
      line({ ev: "init", tag: "system·init", text: "boot" }),
      line({ ev: "result", tag: "result", text: "success · 3 turns · 12s · $0.02" }),
    ];
    expect(extractReplyText(claudeStats)).toBeNull();

    const codexStats = [
      line({ ev: "init", tag: "thread.started", text: "boot" }),
      line({ ev: "result", tag: "turn.completed", text: "in 4.1k (cached 2.0k) · out 0.3k tokens" }),
    ];
    expect(extractReplyText(codexStats)).toBeNull();

    // A real report still wins, even with a stats line after it.
    const withReport = [
      line({ tag: "agent_message", text: "Split the CLI docs into their own page." }),
      line({ ev: "result", tag: "turn.completed", text: "in 4.1k · out 0.3k tokens" }),
    ];
    expect(extractReplyText(withReport)).toBe(
      "Split the CLI docs into their own page.",
    );
  });

  it("returns null when nothing usable was produced", () => {
    expect(extractReplyText([line({ ev: "tool", tag: "tool_use", text: "ls" })])).toBeNull();
  });

  it("truncates a huge reply but keeps it readable, pointing at the agent logs", () => {
    const big = "x".repeat(5000);
    const out = extractReplyText([line({ tag: "assistant", text: big })])!;
    expect(out.length).toBeLessThan(5000);
    expect(out).toContain("…");
    expect(out.endsWith("_(truncated; full report in the agent logs)_")).toBe(true);
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

  it("P8: a SUPPORTING run's isolated checkout path collapses to the repo-relative path too", () => {
    // The support checkout is one level deeper (workspace/support/<profileId>/<repo>/…),
    // so the `support/<profileId>/` group must be skipped, not folded into `<rest>`.
    expect(
      normalizeWorkspacePaths(
        "/data/tasks/VIB-9/workspace/support/critic/viberr/docs/x.md",
      ),
    ).toBe("docs/x.md");
    expect(
      normalizeWorkspacePaths(
        "See [the file](/Users/akinozer/data/tasks/VIB-2/workspace/support/reviewer/viberr/src/a.ts)",
      ),
    ).toContain("[the file](src/a.ts)");
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
      agentProfileId: "developer",
      backend: "codex",
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

  it("ruling 130(a): the typed `failure` record wins, rides through, and `session limit` prose classifies quota", () => {
    // Canary: remove the `last.failure` read (the facts vanish; the kind
    // still comes from the tag).
    const facts = {
      kind: "quota" as const, resetsAt: "2026-09-06T19:50:00.000Z", window: "five_hour", windowRejected: true,
      apiError: null, apiErrorStatus: 429, terminalReason: "api_error", origin: null,
    };
    const structured = classify([errLine({ tag: "run·error·quota", text: "The Claude account is over its usage quota.", failure: facts })]);
    expect(structured).toMatchObject({ kind: "quota", facts });
    const prose = classify([errLine({ tag: "error", text: "You've hit your session limit for now." })]);
    expect(prose?.kind).toBe("quota");
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

  it("classifies a vanished provider session as session_missing, never auth (P13-D-2)", () => {
    // The tagged channel (the adapter classified it in memory before redaction).
    expect(
      classify([
        errLine({
          tag: "run·error·session_missing",
          text: "The Claude Code session could not be resumed — its transcript no longer exists (provider retention).",
        }),
      ]),
    ).toMatchObject({ kind: "session_missing" });

    // The marker `resumeRun` stamps on the dead run when its probe catches it.
    expect(
      classify([
        errLine({
          tag: "run·session_missing",
          text: "The Codex session 019a no longer exists on this machine — its provider transcript is gone.",
        }),
      ]),
    ).toMatchObject({ kind: "session_missing" });

    // Untagged prose: BEFORE, "No conversation found with session ID …" hit no
    // regex and landed as `unknown`, which the escalation narrates as "review
    // its authentication and runtime configuration" — pointing the human at the
    // one thing that is definitely fine.
    expect(
      classify([
        errLine({
          tag: "run·error",
          text: "No conversation found with session ID 8a1f-…",
        }),
      ]),
    ).toMatchObject({ kind: "session_missing" });
  });

  it("ruling 175: a spending-cap cut-off is its own kind, by record or by tag", () => {
    expect(
      classify([
        errLine({
          tag: "run·error·max_budget",
          text: "The run reached its $0.50 spending cap after spending $0.52 and was cut off.",
        }),
      ]),
    ).toMatchObject({ kind: "max_budget" });
  });

  it("ruling 599: the completion compaction's lines are never the run's failure", () => {
    // Live on AWSC-60 a usage-limit refusal was followed by the compaction's
    // "did not happen" line, and the stall packet named that line as the
    // failure: kind unknown, no reset instant, no option to wait for it.
    // CANARY: drop the `run·compact` skip and this reads unknown.
    const facts = emptyRunFailureFacts("quota");
    expect(
      classify([
        errLine({ tag: "error·quota", text: "Codex usage limit was reached.", failure: facts }),
        {
          t: "", ev: "meta", tag: "run·compaction·failed",
          text: "compaction at the end of the run did not happen: the app-server did not report a compaction within 300s",
        },
      ]),
    ).toMatchObject({ kind: "quota", text: "Codex usage limit was reached.", facts });
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
  it("falls back inside the workspace so the Git ceiling is a strict ancestor", async () => {
    const fallback = resumeWorkdir(
      store.slug,
      "VIB-1",
      null,
      store.dataRoot,
    );
    const confinement = await resolveResumeConfinement(
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

  it("ruling 495(a): a workspace the resume makes is handed to the agents' group before anything is made in it", () => {
    // CANARY: drop the hand-over and a resumed agent's workspace is the
    // server's alone (0775 in the server's group, no setgid): its person
    // writes nothing there, and cannot remove the supporting folder the
    // server made in it when the task's workspace is reclaimed. Make
    // `support/<profileId>` before the hand-over and, in the image, it keeps
    // the server's group and no setgid, for the same reason.
    resetAgentIsolationForTests({ status: "on", uidFloor: AGENT_UID_FLOOR, reason: null });
    const workspace = path.join(taskDir(store.slug, "VIB-1", store.dataRoot), "workspace");
    const support = path.join(workspace, "support");
    // Whether `support/` was there each time the hand-over was refused.
    const supportAtRefusal: boolean[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation((msg, fields) => {
      if (msg === "a directory could not be shared with the agent group" && fields?.dir === workspace) {
        supportAtRefusal.push(existsSync(support));
      }
    });
    try {
      expect(existsSync(support)).toBe(false);
      const dir = resumeWorkdir(store.slug, "VIB-1", null, store.dataRoot, { profileId: "reviewer" });

      expect(dir).toBe(path.join(support, "reviewer"));
      expect(existsSync(dir)).toBe(true);
      const st = statSync(workspace);
      if (st.gid === AGENT_GID && (st.mode & 0o7777) === 0o2770) {
        // In the image the hand-over lands (2770 in the agents' group), and
        // what is made after it inherits that group and the setgid bit.
        const made = statSync(support);
        expect(made.gid).toBe(AGENT_GID);
        expect(made.mode & 0o2000).toBe(0o2000);
      } else {
        // The suite is not in the agents' group: the hand-over is refused and
        // logged the moment it runs, when nothing may be in the workspace yet.
        expect(supportAtRefusal).toEqual([false]);
      }
    } finally {
      warn.mockRestore();
      resetAgentIsolationForTests();
    }
  });

  it("stamps the unified delivery git identity into the resume env (F24)", async () => {
    const confinement = await resolveResumeConfinement(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev" },
    );
    // Every commit a resumed agent makes must use <profileId>@viberr.local, the
    // same author as its fresh-run commits — never the host's git identity.
    expect(confinement.env.GIT_AUTHOR_NAME).toBe("dev");
    expect(confinement.env.GIT_AUTHOR_EMAIL).toBe("dev@viberr.local");
    expect(confinement.env.GIT_COMMITTER_NAME).toBe("dev");
    expect(confinement.env.GIT_COMMITTER_EMAIL).toBe("dev@viberr.local");
  });
});

/* ------------------------------------------------------------ commentToAgent */

describe("ruling 133: the @mention resume door is stage-gated like every other door", () => {
  /** Redeploy with `dev` (delivers) and `rev` (supporting) both scoped to review only. */
  function scopeBothToReview(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        { profileId: "dev", capabilities: [], extras: [], definition: { kind: "specialist", name: "dev", role: "developer", backends: ["claude"], model: "claude-sonnet", stages: ["review"] } },
        { profileId: "rev", capabilities: [], extras: [], definition: { kind: "specialist", name: "rev", role: "reviewer", backends: ["claude"], model: "claude-sonnet", stages: ["review"] } },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }
  const sessionRow = (id: string, profileId: string, kind: "primary" | "reviewer") =>
    upsertRun(store.db, {
      id,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: `${profileId}-thread`,
      role: profileId === "dev" ? "developer" : "reviewer",
      kind,
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: `${id}-session`,
      agentName: profileId,
      agentProfileId: profileId,
      state: "finished",
    });

  it("an @mention of a SUPPORTING agent at an undeclared stage posts the comment and refuses the run with the dispatcher's sentence", async () => {
    // Canary: remove the `assertResumeEligible` call from commentToAgent.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
          { profileId: "rev", backend: "claude", role: "reviewer", delivers: false, verdictCapable: true },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_rev_old", "rev", "reviewer");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@rev please re-check" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.agent?.profileId).toBe("rev");
    expect(result.triggered).toBeNull();
    expect(result.runNotStarted).toMatch(/rev is not eligible for the In Progress stage/);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.some((e) => e.type === "comment" && e.actor.kind === "human")).toBe(true);
  });

  it("ruling 562: the answer to an agent that cannot run at the task's stage now goes to the operator, and says so", async () => {
    // Live on AWSC-6 the task had moved on to Estimate while the Cloud
    // Solutions Architect's mapping question was open, and the answer was
    // posted to it as "Continue from where you stopped" before its run was
    // refused. CANARY: drop the eligibility check from `answerAskingAgent` and
    // the hand-back is posted to an agent that never runs; restore the fixed
    // sentence and the record promises an operator summon nobody made.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
          { profileId: "rev", backend: "claude", role: "reviewer", delivers: false, verdictCapable: true },
        ],
      }),
      packet: {
        id: "pkt_562",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/rev (reviewer)",
        askedBy: "rev",
        title: "Keep the proposed defaults?",
        body: "The mapping applies defaults for the gaps.",
        observations: [],
        options: [
          { kind: "custom", t: "Keep the defaults", d: "", rec: true },
          { kind: "custom", t: "Send corrections", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_rev_562", "rev", "reviewer");
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    const texts = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!.parsed.timeline.map(
      (e) => e.text,
    );
    expect(texts.some((t) => t.includes("has been answered by a human"))).toBe(false);
    expect(texts).toContain(
      "The answer went to the operator, not back to rev, who asked: rev is not eligible for the In Progress stage; its profile is scoped to Review.",
    );
    expect(texts).toContain("**Decision:** Keep the defaults.");
    expect(listRunsForTaskRows(store.db, store.slug, "VIB-1").filter((r) => r.agent_profile_id === "rev")).toHaveLength(1);
  });

  it("ruling 565: the answer to an agent still running on the task waits for that run, and says so", async () => {
    // Live on AWSC-5 the Cloud Solutions Architect raised its packet and kept
    // working; the answer was refused by the single-flight guard, fell through
    // to the operator with no note, and the operator wrote that it had gone
    // "straight to" the architect. The completion delivers it (ruling 203), so
    // it is owed, not lost. CANARY: return `result.triggered !== null` alone
    // and the operator is handed the answer and nothing says it waits.
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        { profileId: "rev", capabilities: [], extras: [], definition: { kind: "specialist", name: "rev", role: "reviewer", backends: ["claude"], model: "claude-sonnet" } },
        { profileId: "operator", capabilities: [], extras: [], definition: { kind: "operator", name: "Operator", backends: ["claude"], model: "sonnet", autonomy: "supervised" } },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "rev", backend: "claude", role: "reviewer", delivers: false, verdictCapable: false },
        ],
      }),
      packet: {
        id: "pkt_565",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/rev (reviewer)",
        askedBy: "rev",
        title: "Which instance class?",
        body: "The mapping keeps the default until you answer.",
        observations: [],
        options: [
          { kind: "custom", t: "Keep the default", d: "", rec: true },
          { kind: "custom", t: "Take the cheaper one", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    upsertRun(store.db, {
      id: "run_rev_live",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "rev-thread",
      role: "reviewer",
      kind: "reviewer",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "run_rev_live-session",
      agentName: "rev",
      agentProfileId: "rev",
      state: "running",
      startedAt,
    });
    const runOp = vi.fn<typeof runOperator>(async () => ({
      runId: null,
      queued: true,
      backend: "claude" as const,
      autonomy: "supervised" as const,
    }));
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot, deps: { runOperator: runOp } },
    );
    const texts = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
      .parsed.timeline.map((e) => e.text);
    expect(texts.some((t) => t.startsWith("@rev Your question") && t.includes("has been answered by a human"))).toBe(true);
    expect(texts).toContain(
      "The answer waits for rev, who asked: its run on this task is still going, and Viberr starts it on the answer as soon as that run finishes.",
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(runOp).not.toHaveBeenCalled();
    // The live run's completion owes it exactly this comment.
    const owed = await deliverDeferredMention(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "rev", runStartedAt: startedAt },
    );
    expect(owed.pending).toBe(1);
  });

  it("F37-62: the RESUME door refuses a CLOSED task, like every other dispatch door", async () => {
    // Ruling 177: "a closed task refuses every coordination door". The
    // Run-an-agent control on the same page refuses a Done task by name because
    // `startAgentRun` gates on `taskClosure` — but an @mention RESUMES an
    // existing provider session without going through it, so the same person on
    // the same page could spend a paid run on a shipped task.
    // CANARY: delete the closure block from `assertResumeEligible`.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "done",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_dev_closed", "dev", "primary");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBeNull();
    expect(result.runNotStarted).toMatch(/VIB-1 is closed/);
    expect(result.runNotStarted).toMatch(/resuming an agent on it/);
    // The comment still lands: refusing the RUN never discards what a person wrote.
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.some((e) => e.type === "comment" && e.actor.kind === "human")).toBe(true);
  });

  it("F37-62: the RESUME door refuses a HELD task, like every other dispatch door", async () => {
    // Ruling 186's comment claims "Every dispatch door lands here, so every one
    // of them refuses" — this door does not land in `startAgentRun` at all.
    // Same hole ruling 240 closed on the delivery path.
    // CANARY: delete the hold block from `assertResumeEligible`.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        blockedBy: ["VIB-2"],
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_dev_held", "dev", "primary");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev carry on" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBeNull();
    expect(result.runNotStarted).toMatch(/waits on VIB-2/);
    expect(result.runNotStarted).toMatch(/resuming an agent on it is refused/);
  });

  it("an @mention of the DELIVERING agent resumes it at a stage its profile does not declare", async () => {
    // Canary: drop the `delivers` arm from `runEligibilityFor`.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_dev_old", "dev", "primary");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev please continue" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");
    expect(result.runNotStarted).toBeNull();
  });

  it("ruling 544: a resumed agent's run records what is delivered when the resume is dispatched", async () => {
    // CANARY: drop `resume.reviewSubject` in commentToAgent and the resumed
    // row says nothing, so a verdict it returns binds to whatever is delivered
    // when it finishes.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        deliveredAt: "2026-09-28T08:37:02.629Z",
        engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_dev_old", "dev", "primary");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev check the estimate again" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");
    const resumed = listRunsForTaskRows(store.db, store.slug, "VIB-1").find((r) => r.id !== "run_dev_old");
    expect(resumed?.review_subject).toBe("files:2026-09-28T08:37:02.629Z");
  });

  it("ruling 544: a resumed agent judging a commit records the revision its checkout was pinned to", async () => {
    // A resume re-pins nothing, so the checkout still holds the revision the
    // run it resumes was dispatched on. CANARY: record the task's current
    // subject on every resume and this claims rev_2, which the checkout does
    // not hold.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        branch: "vib-1",
        workRevision: {
          id: "rev_2",
          headSha: "b".repeat(40),
          treeSha: "c".repeat(40),
          branch: "vib-1",
          createdAt: "2026-09-28T10:00:00.000Z",
          sourceProfileId: "dev",
        },
        engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    upsertRun(store.db, {
      id: "run_dev_pinned",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "dev-thread",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "run_dev_pinned-session",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
      reviewSubject: "rev_1",
    });
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev look again" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");
    const resumed = listRunsForTaskRows(store.db, store.slug, "VIB-1").find((r) => r.id !== "run_dev_pinned");
    expect(resumed?.review_subject).toBe("rev_1");
  });

  it("an @mention of a RELEASED profile (session survives, no engagement) at an undeclared stage is refused", async () => {
    // Canary: return ok for an unengaged profile in `assertResumeEligible`.
    scopeBothToReview();
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [{ profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false }],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    sessionRow("run_rev_released", "rev", "reviewer");
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@rev one more look?" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBeNull();
    expect(result.runNotStarted).toMatch(/rev is not eligible for the In Progress stage/);
  });
});

/**
 * Ruling 157 (pass 35, F35-8): the hold lift belongs to every door that starts
 * work. `commentToAgent` has TWO run-start branches, and only the fresh one
 * goes through `dispatchAgentRun`, where the sibling lift sits — the RESUME
 * branch calls `resumeRun` directly. KNC-25 is that branch: the hold exists
 * because an agent's run failed, so the agent HAS a prior session, so a
 * person's "@dev try again" resumes it.
 */
describe("ruling 157: an @mention that RESUMES a session lifts a packet-less hold", () => {
  it("readiness returns to ready with a 'Hold lifted' note and task.hold.lifted", async () => {
    // Canary: remove the `liftHoldForRun` call from the `triggered ===
    // "resumed"` branch in commentToAgent.
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        // The hold shape: stored `blocked`, no packet, no dependency list.
        readiness: "blocked",
        waiting: "human",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    upsertRun(store.db, {
      id: "run_dev_failed",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "dev-thread",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "run_dev_failed-session",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });

    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev try again" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.frontmatter.readiness).toBe("ready");
    const note = file.parsed.timeline.find((e) => e.title === "Hold lifted")!;
    expect(note).toBeDefined();
    expect(note.text).toBe(
      "**Hold lifted:** dev was dispatched, so VIB-1 is no longer held. The run's outcome decides what happens next.",
    );
    const rows = listAuditEvents(store.db, { action: "task.hold.lifted" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ cause: "dispatch", profileId: "dev", previous: "blocked" });
  });
});

/**
 * Ruling 152(c) (pass 35, G35-4), cluster review: a RESUME is a dispatch. The
 * hold lived in `dispatchAgentRun` only, so the most common repeat — an
 * @mention of the agent that is already working the task — walked past it,
 * spent the MCP pre-flight and the skill re-mount of
 * `resolveResumeConfinement`, and paid a refused provider run on a window the
 * instance already knew was spent. That is exactly what G35-4 exists to stop,
 * and both `task-lifecycle.md` and `agents-and-runtime.md` already say every
 * door is held.
 */
describe("ruling 152(c): an @mention that RESUMES a session is held like any other dispatch", () => {
  it("starts no run, records the hold and its retry, and returns the hold sentence", async () => {
    // Canary: remove the `assertDispatchNotHeld` call from commentToAgent's
    // resume branch — the mention resumes and `triggered` reads "resumed".
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    upsertRun(store.db, {
      id: "run_dev_failed",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "dev-thread",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "run_dev_failed-session",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    const { recordBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    recordBackendQuotaExhaustion(store.db, "claude", {
      credentialUserId: store.users.arda.id,
      credentialLabel: "Arda",
      resetsAt,
      resetsAtPrecision: "clock",
      providerText: "5-hour limit reached",
      runId: "run_dev_failed",
      observedAt: new Date().toISOString(),
    });

    const before = startedRunSpecs().length;
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev try again" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBeNull();
    expect(result.runNotStarted).toMatch(
      /^Held: Claude is out of quota until .* UTC; dev's run is scheduled for then\.$/,
    );
    // Nothing reached the provider, and the finished run was not resumed.
    expect(startedRunSpecs()).toHaveLength(before);
    const rows = listRunsForTaskRows(store.db, store.slug, "VIB-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("finished");
    // The hold's own record, made by the same helper every other door uses.
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.find((e) => e.title === "Dispatch held")).toBeDefined();
    const pending = file.parsed.frontmatter.schedules.filter((x) => x.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      action: "run-agent",
      profileId: "dev",
      prompt: "@dev try again",
    });
    expect(listAuditEvents(store.db, { action: "task.agent.run_held" })).toHaveLength(1);
    // The comment itself is still on the record (the A8 partial success).
    expect(file.parsed.timeline.some((e) => e.type === "comment")).toBe(true);
  });

  it("a hold on the OTHER backend does not touch this resume: the hold is per backend", async () => {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
        engagements: [
          { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
        ],
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    upsertRun(store.db, {
      id: "run_dev_done",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "dev-thread",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: "run_dev_done-session",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    const { recordBackendQuotaExhaustion } = await import(
      "~/server/runtimes/backend-quota.server"
    );
    recordBackendQuotaExhaustion(store.db, "codex", {
      credentialUserId: store.users.arda.id,
      credentialLabel: "Arda",
      resetsAt: Math.round(Date.now() / 1000) + 3600,
      resetsAtPrecision: "clock",
      providerText: "You've hit your usage limit.",
      runId: "run_other",
      observedAt: new Date().toISOString(),
    });
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev try again" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");
  });
});

describe("commentToAgent", () => {
  it("records a plain comment with no agent (superset of appendComment)", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "looks good to me" },
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started");

    // The reply lands as an agent-authored comment once the run finishes. The
    // fresh fallback reuses startSpecialistRun's realistic-cadence analyze
    // stream (~7 lines at 1–3.2s each), so allow generous headroom.
    const posted = await pollUntil(() => {
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

  /**
   * Ruling 203 (F37-23, live on SHOP-6). A8's refusal used to end with a
   * promise — "it will see the comment when it next re-anchors" — that nothing
   * kept. The anchor holds the last five timeline events, clamped, and only a
   * FRESH run builds one, so the comment survived only if that agent happened
   * to run again on that task before five more events landed. Live, an owner's
   * correction was eight events back within 75 seconds and the agent it named
   * never ran on that task again.
   */
  it("ruling 203: the @mention refused while the agent was busy is delivered when that run finishes", async () => {
    deployDevSpecialist();
    const startedAt = "2026-09-13T10:00:00.000Z";
    upsertRun(store.db, {
      id: "run_live_primary",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: null,
      agentName: "dev",
      agentProfileId: "dev",
      state: "running",
      startedAt,
    });

    const refused = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev stop patching symptoms — fix the class" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(refused.triggered).toBeNull();
    // A8: the call does not throw; it names the agent and says why no run
    // started (the live same-profile guard's own copy).
    expect(refused.agent).toMatchObject({ profileId: "dev" });
    expect(refused.runNotStarted).toContain("already has a run in progress on this task");
    // The refusal now states what viberr will DO, not what it hopes the agent
    // will notice. CANARY: put the old sentence back and this fails.
    expect(refused.runNotStarted).toContain(
      "Viberr starts it on this comment as soon as that run finishes",
    );

    // The busy run ends. This is the hop `applyAgentCompletionEffects` makes.
    patchRun(store.db, "run_live_primary", { state: "finished" });
    const delivered = await deliverDeferredMention(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev", runStartedAt: startedAt },
    );
    expect(delivered).toMatchObject({ started: true });

    // A run for THAT agent, carrying the person's words — not a re-anchor and a
    // hope. CANARY: make `deliverDeferredMention` stop at the resolve (return
    // false without calling `commentToAgent`) and no second run for `dev`
    // exists. The WIRING — that a real completion calls this at all — is proved
    // by the end-to-end test below, because a test that calls the helper itself
    // cannot prove the caller does.
    const runs = listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
      (r) => r.agent_profile_id === "dev" && r.id !== "run_live_primary",
    );
    expect(runs).toHaveLength(1);

    // And the comment is on the timeline exactly ONCE — the redelivery is the
    // same comment being acted on, not a new one. CANARY: drop the
    // `redelivered` branch around `appendComment` and this reads 2.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    expect(
      file.parsed.timeline.filter((e) => e.text.includes("fix the class")),
    ).toHaveLength(1);
  }, 30_000);

  it("ruling 203, end to end: a real run's completion delivers the mention it was too busy to take", async () => {
    deployDevSpecialist();
    // A run that stays live, so the mention below meets the single-flight guard
    // the way a person's comment meets it on a working board.
    queueFakeRun({ lines: [], keepRunning: true });
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await pollUntil(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.agent_profile_id === "dev" && r.state === "running",
      ),
    );
    const live = listRunsForTaskRows(store.db, store.slug, "VIB-1").find(
      (r) => r.agent_profile_id === "dev" && r.state === "running",
    )!;
    const before = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;

    const refused = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing before you finish" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(refused.triggered).toBeNull();

    // The run ends. Nothing else happens: no second comment, no operator, no
    // person. CANARY: delete the `deliverDeferredMention` call from
    // `applyAgentCompletionEffects` and this poll times out — which is the
    // state the promise shipped in.
    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: live.id, dataRoot: store.dataRoot },
      actorOf(store.users.arda),
    );
    await pollUntil(
      () => listRunsForTaskRows(store.db, store.slug, "VIB-1").length > before,
    );
    const started = startedRunSpecs().at(-1)!;
    expect(started.prompt).toContain("one more thing before you finish");
  }, 30_000);

  /**
   * Ruling 203's own claim, tested: "Oldest first, one per completion, which
   * drains a burst in order — the next one rides the next completion." It does
   * not. The window is `occurredAt > runStartedAt`, so once the FIRST comment
   * starts a redelivery run, the second comment is older than that run's start
   * and the next completion cannot see it. A burst of two loses the second,
   * silently — the exact failure ruling 203 exists to stop, reintroduced by its
   * own fix.
   */
  it("ruling 205: a BURST posted while the agent was busy is delivered whole, not just its first", async () => {
    deployDevSpecialist();
    const startedAt = "2026-09-13T10:00:00.000Z";
    upsertRun(store.db, {
      id: "run_live_primary",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "primary",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sdk: "claude",
      sessionId: null,
      agentName: "dev",
      agentProfileId: "dev",
      state: "running",
      startedAt,
    });

    // Each comment is longer than ANCHOR_EVENT_MAX_CHARS (220) and carries a
    // unique tail token, so the canonical anchor's clamped timeline summary
    // CANNOT be what puts the token in the prompt. Only the directive can. The
    // first draft of this test asserted on short strings and passed against the
    // broken code, because the anchor happened to quote both comments.
    const pad = "x".repeat(240);
    for (const text of [
      `@dev first: stop patching symptoms ${pad} TAIL-FIRST-INSTRUCTION`,
      `@dev second: and add the regression test ${pad} TAIL-SECOND-INSTRUCTION`,
    ]) {
      const refused = await commentToAgent(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", text },
        actorOf(store.users.arda),
        { dataRoot: store.dataRoot },
      );
      expect(refused.triggered).toBeNull();
    }

    patchRun(store.db, "run_live_primary", { state: "finished" });
    const delivered = await deliverDeferredMention(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev", runStartedAt: startedAt },
    );
    expect(delivered).toMatchObject({ started: true });

    // CANARY: return after the first match (ruling 203's first implementation)
    // and the second instruction never reaches the agent — there is no later
    // completion whose window can still see it.
    const started = startedRunSpecs().at(-1)!;
    expect(started.prompt).toContain("TAIL-FIRST-INSTRUCTION");
    expect(started.prompt).toContain("TAIL-SECOND-INSTRUCTION");

    // One run, not two: a person's consecutive messages are one question, the
    // way a queued human `@operator` burst is (B-OP2).
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
        (r) => r.agent_profile_id === "dev" && r.id !== "run_live_primary",
      ),
    ).toHaveLength(1);
  }, 30_000);

  /**
   * Ruling 211(h): this test's first two versions never reached the guard they
   * claimed to pin. v1 posted a comment naming NOBODY (resolves to null, a
   * different branch); v2 named a real agent but posted it with `appendComment`,
   * which does not set `toAgent` — and the redelivery scan filters on exactly
   * that flag, so the comment was invisible before any profile comparison
   * happened. The real path is `commentToAgent`, which sets `forceToAgent` when
   * it resolves a named agent, so the fixture has to go through the same door a
   * person does.
   */
  it("ruling 203: a comment addressed to a DIFFERENT agent is not delivered to this one", async () => {
    deployDevSpecialist();
    deployReviewerSpecialist();
    const startedAt = "2026-09-13T10:00:00.000Z";
    for (const [id, profile, thread] of [
      ["run_live_dev", "dev", "primary"],
      ["run_live_rev", "reviewer", "support"],
    ] as const) {
      upsertRun(store.db, {
        id,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        threadId: thread,
        role: profile,
        kind: profile === "dev" ? "primary" : "reviewer",
        backend: "claude",
        model: "sonnet",
        sdk: "claude",
        sessionId: null,
        agentName: profile,
        agentProfileId: profile,
        state: "running",
        startedAt,
      });
    }

    // A person mentions the REVIEWER while both agents are busy. Single-flight
    // refuses it, so it becomes a deferred delivery owed to `reviewer`.
    const refused = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@reviewer please re-check the migration" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(refused.agent).toMatchObject({ profileId: "reviewer" });
    expect(refused.triggered).toBeNull();

    // DEV's run finishes first. Its completion must not take the reviewer's mail.
    patchRun(store.db, "run_live_dev", { state: "finished" });
    // CANARY: relax the guard to `target !== null` and dev's completion picks up
    // a question addressed to the reviewer.
    const delivered = await deliverDeferredMention(
      store.db,
      { dataRoot: store.dataRoot },
      { projectSlug: store.slug, taskKey: "VIB-1", profileId: "dev", runStartedAt: startedAt },
    );
    expect(delivered).toMatchObject({ started: false, pending: 0 });
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
        (r) => r.agent_profile_id === "dev" && r.id !== "run_live_dev",
      ),
    ).toHaveLength(0);
  });

  it("RESUMES the agent's existing session (reusing its session_id) on a later comment", async () => {
    // First run establishes a session.
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await pollUntil(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.kind !== "operator" && !!r.session_id,
      ),
    );
    // F10-05 single-flights the delivering slot: a resume must not race a still-
    // running delivering run. End the first run first (the realistic flow is
    // run-ends → comment → resume its persisted session), then resume it.
    for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
      if (
        run.kind !== "operator" &&
        (run.state === "running" || run.state === "queued")
      ) {
        await interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id, dataRoot: store.dataRoot },
          actorOf(store.users.arda),
        );
      }
    }
    const priorRuns = listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
      (r) => r.kind !== "operator" && r.session_id,
    );
    const priorSessionId = priorRuns[priorRuns.length - 1]!.session_id!;
    const priorCount = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
    // P13-D-2: this test's precondition is a LIVE session — give it a real
    // transcript so the resume-time continuity probe reports `present` and the
    // resume happens for the reason the test claims. Asserted, not assumed:
    // written to the wrong home (ruling 127 moved it into the OWNER's) the
    // probe would answer `unknown` and the resume below would pass for the
    // wrong reason.
    writeTranscript(priorSessionId);
    expect(
      probeSessionContinuity(
        "claude",
        store.users.arda.id,
        priorSessionId,
        store.dataRoot,
      ),
    ).toBe("present");

    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing please" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    // A NEW run row was created that shares the prior session id.
    const after = listRunsForTaskRows(store.db, store.slug, "VIB-1");
    expect(after.length).toBe(priorCount + 1);
    const resumed = after[after.length - 1]!;
    expect(resumed.session_id).toBe(priorSessionId);

    // …and the reply still lands as an agent comment.
    const posted = await pollUntil(() => {
      const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
      return file.parsed.timeline.some(
        (e) => e.type === "comment" && e.actor.kind === "agent",
      );
    });
    expect(posted).toBe(true);
  });

  /**
   * R15-14. `ask_human` ends the run by contract, and the answer used to travel
   * only through the operator — which decides for itself whether to resume the
   * specialist or start it cold. A cold start discards the reasoning that
   * produced the question, so the run that receives the answer is not the run
   * that asked it. The owner's call: the answer goes back to the ASKER.
   */
  it("R15-14: resolving an agent's question RESUMES that agent's own session with the decision", async () => {
    // A SETTLED prior session for `dev` — the realistic shape, since the asking
    // run has already finished by the time a human answers. Inserted directly
    // rather than by running an agent: a real run's async completion handler
    // rewrites task.md, and it raced this test's packet away.
    const priorSessionId = "sess_r1514_dev";
    upsertRun(store.db, {
      id: "run_r1514_prior",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t_r1514",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sessionId: priorSessionId,
      sdk: "test",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    writeTranscript(priorSessionId);
    const priorCount = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;

    // The question `dev` left behind, stamped with WHO asked it.
    const existing = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    writeTask(store.dataRoot, store.slug, {
      ...existing.parsed,
      packet: {
        id: "pkt_r1514",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/dev (developer)",
        askedBy: "dev",
        title: "Which config should I target?",
        body: "Ambiguous scope.",
        observations: [],
        options: [
          { kind: "custom", t: "Target the staging config", d: "", rec: true },
          { kind: "custom", t: "Target production", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        note: "staging only, production needs sign-off",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    // The ASKER was resumed — a new run row carrying its prior session id.
    // Canary: delete the `askedBy` routing in resolvePacket and only the
    // operator is invoked, so no run ever shares this session.
    const resumedAsker = await pollUntil(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.session_id === priorSessionId && r.id !== "run_r1514_prior",
      ),
    );
    expect(resumedAsker).toBe(true);
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").length,
    ).toBeGreaterThan(priorCount);

    // …and it was told the decision AND the human's free-text qualifier, which
    // is the part an operator-mediated cold restart most often loses. The
    // asker's spec is the one resuming its session: the operator's own turn
    // may start after it.
    await pollUntil(() => startedRunSpecs().some((s) => s.resumeSessionId === priorSessionId));
    const spec = startedRunSpecs().find((s) => s.resumeSessionId === priorSessionId);
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const relayed = file.parsed.timeline.find(
      (e) => e.type === "comment" && e.text.includes("has been answered by a human"),
    );
    expect(relayed, "the decision must be visible on the timeline").toBeTruthy();
    expect(relayed!.text).toContain("Target the staging config");
    expect(relayed!.text).toContain("staging only, production needs sign-off");
    expect(relayed!.text).toContain("do not re-open the same question");
    expect(spec?.prompt).toContain("Target the staging config");
  }, 30_000);

  /**
   * Ruling 447 (O39-a), live on ax-clone three of three: an answer that routed
   * the work to ANOTHER actor summoned the asking agent, which then did the
   * other agent's edits itself (AX-22) or spent a run finding it had no tool
   * for them (AX-20, AX-27).
   */
  it("ruling 447: an answer names another actor exactly when it routes the work", async () => {
    const { answerNamesAnotherActor } = await import("./task-comments.server");
    const agents = [
      { id: "developer", name: "Developer", handle: "developer" },
      { id: "surface-developer", name: "Surface Developer", handle: "surface-developer" },
      { id: "reviewer", name: "Review & validation", handle: "reviewer" },
    ];
    // AX-22: the chosen option hands the work to someone else.
    expect(answerNamesAnotherActor("Hand off to Surface Developer (Recommended)", "developer", agents)).toBe(
      "Surface Developer",
    );
    // AX-20: the note addresses the operator.
    expect(
      answerNamesAnotherActor("Operator: move AX-20 back to Verify, then update_branch_from_base.", "developer", agents),
    ).toBe("the operator");
    // AX-27: the note names the Developer, and the asker's own name is not a
    // mention of it.
    expect(
      answerNamesAnotherActor(
        "Coordinate core status work\nOffer me a create_task option for the Developer (the core owner).",
        "surface-developer",
        agents,
      ),
    ).toBe("Developer");
    expect(answerNamesAnotherActor("Surface Developer finishes it on this branch.", "surface-developer", agents)).toBeNull();
    expect(answerNamesAnotherActor("Ask @reviewer to look again.", "developer", agents)).toBe("Review & validation");
    // An answer for the asker names nobody else, and a word inside a word is
    // not a name.
    expect(answerNamesAnotherActor("Target the staging config\nstaging only", "developer", agents)).toBeNull();
    expect(answerNamesAnotherActor("Use the cooperator pattern.", "developer", agents)).toBeNull();
  });

  it("ruling 447: an answer that names the operator goes to the operator, and the asker is not resumed", async () => {
    const priorSessionId = "sess_r447_dev";
    upsertRun(store.db, {
      id: "run_r447_prior",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t_r447",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sessionId: priorSessionId,
      sdk: "test",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    writeTranscript(priorSessionId);
    const existing = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    writeTask(store.dataRoot, store.slug, {
      ...existing.parsed,
      packet: {
        id: "pkt_r447",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/dev (developer)",
        askedBy: "dev",
        title: "Synchronize VIB-1 with current main?",
        body: "The branch is behind.",
        observations: [],
        options: [
          { kind: "custom", t: "Synchronize now", d: "", rec: true },
          { kind: "custom", t: "Leave it", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        note: "Operator: bring the branch up to date with main first.",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: drop the `routedTo` branch and the developer is resumed with an
    // instruction only the operator can carry out.
    const resumed = listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
      (r) => r.session_id === priorSessionId && r.id !== "run_r447_prior",
    );
    expect(resumed).toBe(false);
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.map((e) => e.text)).toContain(
      "The answer names the operator, so it went to the operator to route, not back to dev, who asked.",
    );
    expect(file.parsed.timeline.some((e) => e.text.includes("has been answered by a human"))).toBe(false);
  });

  /**
   * The option's DESCRIPTION is the asker's own text, and it narrates what
   * happens next as often as it names who acts. A person who picks it names
   * nobody, so the answer goes back to the agent that asked.
   */
  it("ruling 447: an option whose description mentions the operator still answers the asker", async () => {
    const priorSessionId = "sess_r447_desc";
    upsertRun(store.db, {
      id: "run_r447_desc",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      threadId: "t_r447_desc",
      role: "developer",
      kind: "primary",
      backend: "claude",
      model: "sonnet",
      sessionId: priorSessionId,
      sdk: "test",
      agentName: "dev",
      agentProfileId: "dev",
      state: "finished",
    });
    writeTranscript(priorSessionId);
    const existing = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    writeTask(store.dataRoot, store.slug, {
      ...existing.parsed,
      packet: {
        id: "pkt_r447_desc",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/dev (developer)",
        askedBy: "dev",
        title: "Keep the retry loop?",
        body: "It doubles the test time.",
        observations: [],
        options: [
          {
            kind: "custom",
            t: "Keep it",
            d: "I finish the loop here and the operator then moves the task to Verify.",
            rec: true,
          },
          { kind: "custom", t: "Drop it", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", optionIndex: 0 },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    // CANARY: scan `option.d` again and the answer is routed to the operator.
    const file = readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!;
    expect(file.parsed.timeline.some((e) => e.text.startsWith("The answer names"))).toBe(false);
    expect(
      await pollUntil(
        () =>
          listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
            (r) => r.session_id === priorSessionId && r.id !== "run_r447_desc",
          ),
        10_000,
      ),
    ).toBe(true);
  });

  // P14-RT-02 / LV-04: the WIRING, not just the prompt builder. `commentToAgent`
  // threaded the human's words into the RESUMED path and the operator-prompt
  // path but neither FRESH branch, so a first-ever @mention started a run that
  // never saw the question. Live, the agent then read the TASK GOAL as its
  // instruction, called it a prompt-injection attempt, and tagged nobody — the
  // asker was never notified (NEW-4). Deleting `directive`/`directiveFrom` from
  // either fresh branch must fail HERE; the builder-level test cannot see it.
  it("P14-RT-02: a FIRST-EVER @mention sends the human's words and name to the run", async () => {
    const question = "does the health endpoint still return 200 on a cold start?";
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: `@dev ${question}` },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started"); // the fresh branch, not a resume

    expect(await pollUntil(() => startedRunSpecs().length > 0, 10_000)).toBe(true);
    const spec = startedRunSpecs().at(-1)!;
    expect(spec.prompt).toContain(question);
    // …and it knows WHO asked, which is what makes the reply tag a real person.
    expect(spec.prompt).toContain(store.users.arda.name);
  });

  it("returns the grouped Agent-logs id (logThreadId) for the reply run (BUG 3)", async () => {
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev kick things off" },
      actorOf(store.users.arda),
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(plain.logThreadId).toBeNull();
  });

  /**
   * B-AG2, the other half: the REFUSAL shipped without the reply. An ambiguous
   * `@claude` resolved to nobody and `commentToAgent` returned on the spot — no
   * run, no note, not even the routed tint — while the composer kept offering
   * the handle. Loudly wrong became quietly nothing, which is harder to notice.
   */
  it("an AMBIGUOUS backend handle posts the policy note naming the candidates and starts NO run (B-AG2)", async () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    const specialist = (
      profileId: string,
      name: string,
    ): AgentDeployment => ({
      profileId,
      capabilities: [],
      extras: [],
      definition: {
        kind: "specialist",
        name,
        role: name,
        backends: ["claude"],
        model: "claude-sonnet",
      },
    });
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        specialist("docs-writer", "Docs Writer"),
        specialist("security-reviewer", "Security Reviewer"),
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const before = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@claude please look at this" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.agent).toBeNull();
    expect(result.triggered).toBeNull();
    expect(listRunsForTaskRows(store.db, store.slug, "VIB-1").length).toBe(before);

    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    const note = timeline.find(
      (e) => e.type === "note" && e.actor.kind === "system",
    );
    expect(note, "the refusal must say so on the timeline").toBeTruthy();
    expect(note!.text).toContain("@docs-writer");
    expect(note!.text).toContain("@security-reviewer");
    expect(
      listAuditEvents(store.db, { action: "task.comment.unrouted" }).length,
    ).toBe(1);

    // Naming one profile still engages it — the refusal is scoped to the
    // ambiguity, not to backend handles as a class.
    const named = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@security-reviewer take a look" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(named.agent).toMatchObject({ profileId: "security-reviewer" });
    expect(named.triggered).toBe("started");
  });

  it("records a contributor or viewer @mention but does NOT trigger a run (RBAC)", async () => {
    for (const user of [store.users.selin, store.users.elif]) {
      const before = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
      const result = await commentToAgent(
        store.db,
        { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev can you look?" },
        actorOf(user),
        { dataRoot: store.dataRoot },
      );
      expect(result.runtimeDenied).toBe(true);
      expect(result.triggered).toBeNull();
      expect(result.agent).toMatchObject({ profileId: "dev" });
      // Comment recorded; no new run.
      const after = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
      expect(after).toBe(before);
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
        { profileId: "dev", capabilities: [], extras: [], definition: { kind: "specialist", name: "dev", role: "developer", backends: ["claude"], model: "claude-sonnet" } },
        { profileId: "analyst", capabilities: [], extras: [], definition: { kind: "specialist", name: "analyst", role: "reviewer", backends: ["claude"], model: "claude-sonnet" } },
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
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await pollUntil(() =>
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
      actorOf(store.users.arda),
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

describe("a resumed @mention keeps the run's natively-mounted skills (pass-18)", () => {
  const exec = promisify(execFile);

  it("re-arms the SDK skills filter on the resumed RunSpec", async () => {
    // The glue between `resolveResumeConfinement` (which re-mounts) and
    // `resumeRun` (which forwards): without it a resumed agent enables NO skill
    // while its persona — built by that same call — already left the body out
    // for native delivery, so its granted craft vanishes mid-thread.
    //
    // Canary: drop the `skills: confinement.skills` spread from
    // `commentToAgent`'s resume branch (task-actions.server) and this fails.
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    writeProject(store.dataRoot, {
      ...fm,
      repo: "acme/widgets",
      agents: [
        {
          profileId: "dev",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist", name: "dev", role: "developer",
            backends: ["claude"], model: "claude-sonnet",
            resources: { skills: ["conventional-commits"], mcps: [], kb: [] },
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    mkdirSync(path.join(store.dataRoot, "skills", "conventional-commits"), {
      recursive: true,
    });
    writeFileSync(
      path.join(store.dataRoot, "skills", "conventional-commits", "SKILL.md"),
      "# Commits\n\nSENTINEL-SKILL-BODY",
    );
    // The workspace the earlier run left behind — the mount target on resume.
    const ws = path.join(
      store.dataRoot, "projects", store.slug, "tasks", "VIB-1", "workspace", "widgets",
    );
    mkdirSync(ws, { recursive: true });
    await exec("git", ["-C", ws, "init", "-q"]);
    // A finished run with a live transcript ⇒ the @mention RESUMES it.
    upsertRun(store.db, {
      id: "run_prior", projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary",
      role: "developer", kind: "primary", backend: "claude", model: "sonnet",
      sdk: "claude", sessionId: "claude-session-skills", agentName: "dev",
      agentProfileId: "dev", state: "finished",
    });
    writeTranscript("claude-session-skills");

    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing please" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    const specs = startedRunSpecs();
    const resumed = specs[specs.length - 1]!;
    expect(resumed.skills).toEqual(["conventional-commits"]);
    expect(resumed.systemPrompt ?? "").not.toContain("SENTINEL-SKILL-BODY");
    // Ruling 180: the resumed run's skills ride its own plugin beside the
    // checkout, never inside it (the plugin dir itself is gone once the fake
    // run settles — that removal is the ruling's cleanup, not a defect).
    expect(resumed.skillPlugin?.name).toBe("viberr");
    expect(path.dirname(resumed.skillPlugin?.path ?? "")).toBe(
      path.join(path.dirname(ws), ".viberr-plugins"),
    );
    expect(existsSync(path.join(ws, ".claude"))).toBe(false);
  });
});

describe("a resumed @mention keeps the project's rulings (ruling 239)", () => {
  it("hands the resumed run the rulings index, which its profile never granted", async () => {
    // The resume builds its own knowledge list (R18-1 parity), and ruling 239
    // shipped without it: a reviewer resumed mid-thread silently lost the
    // project's rulings between turns. `dev` grants no knowledge base, so the
    // index can only arrive through the resume's own `withProjectRulings`.
    // CANARY: unwrap that call in `resolveResumeConfinement` and the heading
    // is gone.
    mkdirSync(path.join(store.dataRoot, "kb", "project-rulings"), { recursive: true });
    writeFileSync(path.join(store.dataRoot, "kb", "project-rulings", "rulings.md"), "# Rulings\n\nbody");
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!.parsed.frontmatter;
    writeProject(store.dataRoot, { ...fm, rulingsKb: "project-rulings" });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
    // A finished run with a live transcript ⇒ the @mention RESUMES it.
    upsertRun(store.db, {
      id: "run_prior", projectSlug: store.slug, taskKey: "VIB-1", threadId: "primary",
      role: "developer", kind: "primary", backend: "claude", model: "sonnet",
      sdk: "claude", sessionId: "claude-session-rulings", agentName: "dev",
      agentProfileId: "dev", state: "finished",
    });
    writeTranscript("claude-session-rulings");

    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev one more thing please" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");
    const specs = startedRunSpecs();
    expect(joinedPrompt(specs[specs.length - 1]?.systemPrompt ?? "")).toContain(
      "# project-rulings (knowledge base)",
    );
  });
});

/* ------------------------- UC-09: the agent side vs the human side of a @tag */

/**
 * One comment box addresses two populations, and the routing decision is made
 * from the handle alone. Both directions are load-bearing and neither is
 * self-evident from the other:
 *
 *  · an AGENT handle (`@operator`, `@codex`/`@claude`, a profile handle) engages
 *    that agent — and `@operator` engages the OPERATOR, never the task's primary
 *    specialist, which is the distinction R15-14's fallback also leans on;
 *  · a TEAMMATE handle engages nobody. It is the half nothing else pins: a
 *    resolver that fell through to "the primary specialist" for any unmatched
 *    handle would still notify the human correctly, so the only visible symptom
 *    is a provider run — and a bill — for saying "@selin what do you think?".
 */
describe("comment routing: agent handles engage agents, teammate handles never do (UC-09)", () => {
  /** Deploy the operator alongside the fixture's `dev` specialist. */
  function deployOperatorToo(): void {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
      repo: null,
      agents: [
        {
          profileId: "operator",
          capabilities: [{ capabilityId: "append-typed-events", mode: "direct" }],
          extras: [],
          definition: {
            kind: "operator",
            name: "Operator",
            backends: ["claude"],
            model: "sonnet",
          },
        },
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
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  async function clearOperatorLeases(): Promise<void> {
    const { resetOperatorLeasesForTests } = await import(
      "~/server/runtimes/operator-run.server"
    );
    resetOperatorLeasesForTests();
  }

  const runs = () => listRunsForTaskRows(store.db, store.slug, "VIB-1");
  // SAFETY: the row type is the SELECT list itself — `user_id`, `kind` and
  // `text` are all TEXT NOT NULL in 0001_baseline, so every row carries the
  // three strings and nothing else.
  const notifications = () =>
    store.db
      .prepare(`SELECT user_id, kind, text FROM notifications`)
      .all() as { user_id: string; kind: string; text: string }[];

  /**
   * A backend handle names a RUNTIME, so it must name the RIGHT one. Both
   * directions in one test: the claude fixture agent does not answer to
   * `@codex`, and a deployed codex agent does — otherwise "one deployed
   * specialist of that backend" could be read as "the only deployed specialist".
   */
  it("@codex reaches the codex specialist and @claude the claude one — backends never cross", () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    writeProject(store.dataRoot, {
      ...file.parsed.frontmatter,
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
        },
        {
          profileId: "analyst",
          capabilities: [],
          extras: [],
          definition: {
            kind: "specialist",
            name: "analyst",
            role: "analysis",
            backends: ["codex"],
            model: "gpt-5.6-sol",
          },
        },
      ],
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const call = (text: string) =>
      resolveMentionedAgent(store.db, { dataRoot: store.dataRoot }, store.slug, "VIB-1", text);
    expect(call("@codex please take a look")).toMatchObject({
      profileId: "analyst",
      backend: "codex",
      isOperator: false,
    });
    expect(call("@claude please take a look")).toMatchObject({
      profileId: "dev",
      backend: "claude",
    });
  });

  it("a TEAMMATE @mention notifies the person and starts no run — a human tag never buys a provider call", async () => {
    const before = runs().length;
    const specsBefore = startedRunSpecs().length;
    // Arda is a project ADMIN: if this handle resolved to an agent, the RBAC
    // gate would not stop the run — the resolution is the only thing that does.
    const handle = store.users.selin.email.split("@")[0]!;
    const result = await commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: `@${handle} can you take acceptance once the dev is done?`,
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(result.agent).toBeNull();
    expect(result.triggered).toBeNull();
    expect(result.logThreadId).toBeNull();
    expect(result.runtimeDenied).toBe(false);
    // Not tinted as routed-to-agent either — the timeline says who it is for.
    expect(result.toAgent).toBe(false);
    // No run, and nothing was ever handed to a provider adapter.
    expect(runs().length).toBe(before);
    expect(startedRunSpecs().length).toBe(specsBefore);
    // …and the human half DID happen: the teammate is in their inbox.
    expect(result.mentionedUserIds).toEqual([store.users.selin.id]);
    const rows = notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: store.users.selin.id, kind: "mention" });
  });

  it("@operator engages the OPERATOR — a governed run, not the task's primary specialist", async () => {
    deployOperatorToo();
    await clearOperatorLeases();
    const before = runs().length;

    const result = await commentToAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: "@operator what is holding this up?",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    expect(result.agent).toMatchObject({ profileId: "operator" });
    expect(result.triggered).toBe("started");
    const after = runs();
    expect(after.length).toBeGreaterThan(before);
    // The OPERATOR ran…
    expect(after.some((r) => r.kind === "operator")).toBe(true);
    // …and `dev` — the task's delivering specialist, and what a resolver that
    // treats every reserved handle as "the agent" would have picked — did not.
    expect(after.some((r) => r.kind !== "operator")).toBe(false);
    // The human's words reach the operator's turn, not just the timeline.
    const spec = startedRunSpecs().at(-1);
    expect(spec?.prompt ?? "").toContain("what is holding this up?");
  });

  /**
   * R15-14, the fallback half. Routing an answered question back to its ASKER is
   * an optimization; the guarantee underneath it is that the decision reaches
   * SOMEONE. When the asker cannot be reached — undeployed profile, dead
   * session, a packet the operator itself raised — the operator hand-off that
   * has always run here must still fire, or a human's decision is recorded on
   * the timeline and acted on by nobody.
   */
  it("a question whose asker is no longer deployed still hands the decision to the operator", async () => {
    deployOperatorToo();
    await clearOperatorLeases();
    const existing = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    writeTask(store.dataRoot, store.slug, {
      ...existing.parsed,
      packet: {
        id: "pkt_gone",
        type: "input",
        kind: "Agent question",
        from: "agent:claude/ghost-writer (documentation)",
        // The profile that asked has since been removed from the project.
        askedBy: "ghost-writer",
        title: "Which config should I target?",
        body: "Ambiguous scope.",
        observations: [],
        options: [
          { kind: "custom", t: "Target the staging config", d: "", rec: true },
          { kind: "custom", t: "Target production", d: "", rec: false },
        ],
      },
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const { resolvePacket } = await import("./task-actions.server");
    await resolvePacket(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        optionIndex: 0,
        note: "staging only, production needs sign-off",
      },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    // The decision was handed to the operator instead of being swallowed.
    const handedOff = await pollUntil(() => runs().some((r) => r.kind === "operator"));
    expect(handedOff).toBe(true);
    // Nothing was relayed to a specialist — there was nobody to relay it to.
    expect(runs().some((r) => r.kind !== "operator")).toBe(false);
    const timeline = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!.parsed.timeline;
    expect(
      timeline.some((e) => e.text.includes("has been answered by a human")),
    ).toBe(false);
  });
});

/**
 * F37-66 (pass 37): ruling 211(b)'s withdrawal note is written AFTER three
 * early returns, and two of them are the very reasons it exists.
 *
 * Ruling 211(b): `commentToAgent`'s single-flight refusal writes "Viberr starts
 * it on this comment as soon as that run finishes" onto the canonical record,
 * and when the completion hop cannot keep that promise the person is owed the
 * correction in the same place they were given it. Its own doc names the causes:
 * "the task closed underneath it, the stage stopped admitting the profile, a
 * credential went away."
 *
 * Ruling 211(b) moved the delivery ATTEMPT above the error branch's return and
 * the closed-task branch's return, for exactly this reason. The withdrawal was
 * left below all of them — so on a task that closed underneath the run, the
 * attempt runs, fails, reports `owed`, and the function returns before anything
 * writes it down. The person's promise stands uncontradicted on the timeline
 * they are reading.
 */
describe("F37-66 — the undelivered-mention withdrawal survives the early returns", () => {
  it("a task that CLOSED under the run still withdraws the promise it cannot keep", async () => {
    queueFakeRun({ lines: [], keepRunning: true });
    await startAgentRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    await pollUntil(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.agent_profile_id === "dev" && r.state === "running",
      ),
    );
    const live = listRunsForTaskRows(store.db, store.slug, "VIB-1").find(
      (r) => r.agent_profile_id === "dev" && r.state === "running",
    )!;

    // The person's instruction meets the single-flight guard and is promised.
    const refused = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@dev also drop the dead flag" },
      actorOf(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(refused.triggered).toBeNull();
    expect(refused.runNotStarted).toContain("as soon as that run finishes");

    // …and the task is archived while the run is still going: the ordinary way
    // a board closes work out from under a live agent.
    await updateTaskFile(
      { projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot },
      (parsed) => {
        parsed.frontmatter.archived = true;
      },
    );
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    await interruptRun(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", runId: live.id, dataRoot: store.dataRoot },
      actorOf(store.users.arda),
    );

    const timeline = () =>
      readTaskFile({ projectSlug: store.slug, taskKey: "VIB-1", dataRoot: store.dataRoot })!
        .parsed.timeline;
    // Ruling 177's note proves we really took the closed-task branch — the
    // early return under test. Without this the test could pass on a task that
    // never closed at all.
    const closedNoted = await pollUntil(() =>
      timeline().some((e) => e.title === "Completed after the task closed"),
    );
    expect(closedNoted).toBe(true);
    // No run was started for the mention, so the promise was not kept.
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").filter(
        (r) => r.agent_profile_id === "dev",
      ).length,
    ).toBe(1);

    // CANARY: put `appendUndeliveredMentionNote` back below the closed-task
    // return and this is the state that ships — a promise on the record with
    // nothing anywhere contradicting it.
    const withdrawn = await pollUntil(() =>
      timeline().some((e) => e.title === "Mention still not delivered"),
    );
    expect(withdrawn).toBe(true);
    const note = timeline().find((e) => e.title === "Mention still not delivered")!;
    expect(note.text).toContain("a comment");
    expect(note.text).toContain("@dev");
  }, 30_000);
});
