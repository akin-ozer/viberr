import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCacheForTests } from "~/server/config/env.server";
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
  interruptRun,
  listRunsForTask,
} from "~/server/runtimes/run-service.server";
import { installFakeRuntime, startedRunSpecs } from "../../../test-support/fake-runtime";
import {
  insertRunLine,
  listRunsForTaskRows,
  upsertRun,
} from "~/server/runtimes/run-store.server";
import { resetSseBrokerForTests } from "~/server/events/sse-broker.server";
import {
  agentMentionHandle,
  ambiguousBackendHandle,
  ambiguousBackendHandleNote,
  extractReplyText,
  normalizeWorkspacePaths,
  resumeWorkdir,
  resolveMentionedAgent,
  runFailureReason,
} from "./agent-reply.server";
import { resolveResumeConfinement, startAgentRun } from "./specialist-run.server";
import { commentToAgent } from "./task-actions.server";
import type { LogLine } from "~/features/runtime/runtime-types";
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

/**
 * P13-D-2: `resumeRun` now probes for the provider transcript behind a stored
 * session id, and the fake runtime mints session ids (`fake-<runId>`) that were
 * never written to disk. Pin CLAUDE_CONFIG_DIR at an EMPTY dir so the probe is
 * inconclusive ("unknown" → resume exactly as before) on every machine: without
 * it, `resolveClaudeConfigDir()` falls back to the ambient data root, whose
 * `claude-home/projects` exists on a developer's machine but not on CI — so the
 * suite would take a different path locally than it does in CI. Tests that
 * WANT a live session materialize its transcript here (see `writeTranscript`).
 */
let claudeHome: string;
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

/** Materialize a provider transcript so the continuity probe reports present. */
function writeTranscript(sessionId: string): void {
  const dir = path.join(claudeHome, "projects", "-fake-cwd");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), "{}\n");
}

beforeEach(() => {
  claudeHome = mkdtempSync(path.join(tmpdir(), "viberr-agent-reply-"));
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  resetEnvCacheForTests();
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
  resetSseBrokerForTests();
  installFakeRuntime();
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
  rmSync(claudeHome, { recursive: true, force: true });
  if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
  resetEnvCacheForTests();
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

  /**
   * B-AG2: a backend handle names a RUNTIME, not an agent. It used to be folded
   * into the same lookup as name/id, so on a project running two claude
   * profiles "@claude please look" deterministically engaged whichever
   * project.md listed first — an arbitrary pick the human could not predict and
   * a profile that may never have been meant for this task.
   */
  it("refuses an AMBIGUOUS backend handle instead of engaging the first-listed profile", () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    const specialist = (profileId: string, name: string) => ({
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
      ] as never,
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
        } as never,
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
            ...(fm.agents[0]! as { definition: Record<string, unknown> }).definition,
            backends: ["codex"],
            model: "gpt-5.6-sol",
          },
        },
      ] as never,
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
        } as never,
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
    // F10-05 single-flights the delivering slot: a resume must not race a still-
    // running delivering run. End the first run first (the realistic flow is
    // run-ends → comment → resume its persisted session), then resume it.
    for (const run of listRunsForTaskRows(store.db, store.slug, "VIB-1")) {
      if (
        run.kind !== "operator" &&
        (run.state === "running" || run.state === "queued")
      ) {
        interruptRun(
          store.db,
          { projectSlug: store.slug, taskKey: "VIB-1", runId: run.id },
          actor(store.users.arda),
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
    // resume happens for the reason the test claims.
    writeTranscript(priorSessionId);

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
  }, 20_000);

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
    } as never);
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
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );

    // The ASKER was resumed — a new run row carrying its prior session id.
    // Canary: delete the `askedBy` routing in resolvePacket and only the
    // operator is invoked, so no run ever shares this session.
    const resumedAsker = await waitFor(() =>
      listRunsForTaskRows(store.db, store.slug, "VIB-1").some(
        (r) => r.session_id === priorSessionId && r.id !== "run_r1514_prior",
      ),
    );
    expect(resumedAsker).toBe(true);
    expect(
      listRunsForTaskRows(store.db, store.slug, "VIB-1").length,
    ).toBeGreaterThan(priorCount);

    // …and it was told the decision AND the human's free-text qualifier, which
    // is the part an operator-mediated cold restart most often loses.
    const spec = startedRunSpecs().at(-1);
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
    if (spec) expect(spec.prompt).toContain("Target the staging config");
  }, 30_000);

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
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("started"); // the fresh branch, not a resume

    expect(await waitFor(() => startedRunSpecs().length > 0, 10_000)).toBe(true);
    const spec = startedRunSpecs().at(-1)!;
    expect(spec.prompt).toContain(question);
    // …and it knows WHO asked, which is what makes the reply tag a real person.
    expect(spec.prompt).toContain(store.users.arda.name);
  }, 20_000);

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

  /**
   * B-AG2, the other half: the REFUSAL shipped without the reply. An ambiguous
   * `@claude` resolved to nobody and `commentToAgent` returned on the spot — no
   * run, no note, not even the routed tint — while the composer kept offering
   * the handle. Loudly wrong became quietly nothing, which is harder to notice.
   */
  it("an AMBIGUOUS backend handle posts the policy note naming the candidates and starts NO run (B-AG2)", async () => {
    const file = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!;
    const specialist = (profileId: string, name: string) => ({
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
      ] as never,
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });

    const before = listRunsForTaskRows(store.db, store.slug, "VIB-1").length;
    const result = await commentToAgent(
      store.db,
      { projectSlug: store.slug, taskKey: "VIB-1", text: "@claude please look at this" },
      actor(store.users.arda),
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
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(named.agent).toMatchObject({ profileId: "security-reviewer" });
    expect(named.triggered).toBe("started");
  }, 20_000);

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
        } as never,
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
      actor(store.users.arda),
      { dataRoot: store.dataRoot },
    );
    expect(result.triggered).toBe("resumed");

    const specs = startedRunSpecs();
    const resumed = specs[specs.length - 1]!;
    expect(resumed.skills).toEqual(["conventional-commits"]);
    expect(resumed.systemPrompt ?? "").not.toContain("SENTINEL-SKILL-BODY");
    expect(existsSync(path.join(ws, ".claude", "skills", "conventional-commits"))).toBe(
      true,
    );
  }, 20_000);
});
