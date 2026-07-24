import { describe, expect, it } from "vitest";
import type { EmittedLine, RunExit, RunSpec } from "./adapter.server";
import {
  createClaudeAdapter,
  resolveClaudeEffort,
  resolveClaudeModel,
  type ClaudeQuery,
} from "./claude-runtime.server";

describe("resolveClaudeModel", () => {
  it("maps friendly family labels to CLI aliases", () => {
    expect(resolveClaudeModel("claude-sonnet")).toBe("sonnet");
    expect(resolveClaudeModel("claude-opus")).toBe("opus");
    expect(resolveClaudeModel("claude-haiku")).toBe("haiku");
  });
  it("passes real dated ids through unchanged", () => {
    expect(resolveClaudeModel("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });
  it("returns undefined for unknown/empty so the SDK uses its default", () => {
    expect(resolveClaudeModel("")).toBeUndefined();
    expect(resolveClaudeModel(undefined)).toBeUndefined();
    expect(resolveClaudeModel("codex-large")).toBeUndefined();
  });
});

/** A fake Query: yields the given messages, records interrupt() calls. */
function fakeQuery(messages: unknown[], opts: { throwAfter?: number } = {}) {
  let interrupted = false;
  const gen = (async function* () {
    let i = 0;
    for (const m of messages) {
      if (interrupted) return;
      if (opts.throwAfter !== undefined && i === opts.throwAfter) {
        throw new Error("stream error");
      }
      yield m;
      i += 1;
    }
  })();
  const q = gen as unknown as ClaudeQuery;
  (q as { interrupt: () => Promise<void> }).interrupt = async () => {
    interrupted = true;
  };
  return { q, wasInterrupted: () => interrupted };
}

const SPEC: RunSpec = {
  runId: "r1",
  projectSlug: "viberr-core",
  taskKey: "VIB-1",
  threadId: "primary",
  role: "Primary specialist",
  kind: "primary",
  backend: "claude",
  model: "claude-sonnet-4-5",
  prompt: "do the thing",
  workdir: "/tmp/x",
  autonomous: true,
};

async function drain(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("claude adapter (SDK, injected fake query)", () => {
  it("streams every SDK message → EmittedLine and finishes on a success result", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-5", tools: ["Bash"], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.05 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();

    expect(lines).toHaveLength(3);
    // raw_json is the exact stringified SDK message.
    expect(JSON.parse(lines[0]!.raw).type).toBe("system");
    expect(lines[0]!.facts.sessionId).toBe("sess-1");
    expect(exit).toMatchObject({ outcome: "finished", effectiveBackend: "claude", sessionId: "sess-1" });
  });

  it("accumulates live usage + turns from assistant messages so the counter grows during the run", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "s", model: "claude-sonnet-4-5", tools: [], mcp_servers: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "step 1" }], usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0 } } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }], usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 200 } } },
      { type: "result", subtype: "success", is_error: false, num_turns: 2, usage: { input_tokens: 1500, output_tokens: 150 }, total_cost_usd: 0.05 },
    ];
    const { q } = fakeQuery(messages);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();

    // System init: no usage yet.
    expect(lines[0]!.facts.usage).toBeUndefined();
    // 1st assistant: cumulative usage appears (turn 1).
    expect(lines[1]!.facts.usage).toEqual({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100 });
    expect(lines[1]!.facts.turns).toBe(1);
    // 2nd assistant (a tool_use): input grows (max 1500), output SUMS (150),
    // cached grows (200), turn 2 — so the live counter climbs.
    expect(lines[2]!.facts.usage).toEqual({ input_tokens: 1500, cached_input_tokens: 200, output_tokens: 150 });
    expect(lines[2]!.facts.turns).toBe(2);
    // Result: authoritative totals (untouched by the live accumulator).
    expect(lines[3]!.facts.usage).toEqual({ input_tokens: 1500, cached_input_tokens: 0, output_tokens: 150 });
    expect(lines[3]!.facts.turns).toBe(2);
  });

  it("errors when the result envelope is is_error", async () => {
    const { q } = fakeQuery([
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 50, usage: {} },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("a turn-capped run emits a classified run·error·max_turns reason line (cut off ≠ failed)", async () => {
    const { q } = fakeQuery([
      { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 51, usage: {} },
    ]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const reason = lines.find((l) => l.display?.tag === "run·error·max_turns");
    expect(reason).toBeTruthy();
    const display = reason!.display!;
    expect(display.ev).toBe("err");
    expect(display.text).toContain("turn cap");
    expect(display.text).toContain("VIBERR_CLAUDE_MAX_TURNS");
  });

  it("classifies a swept transcript as run·error·session_missing, not auth (P13-D-2)", async () => {
    // What `claude --resume <id>` prints once the provider has swept the
    // transcript (~30-day retention) — the exact string the export installer
    // warns about. BEFORE it hit no regex and landed as `unknown`, which the
    // escalation narrates as "review the runtime configuration".
    const q = (async function* () {
      throw new Error("No conversation found with session ID 8a1f-dead-beef");
    })() as unknown as ClaudeQuery;
    (q as { interrupt: () => Promise<void> }).interrupt = async () => {};
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(
      { ...SPEC, resumeSessionId: "8a1f-dead-beef" },
      { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) },
    );
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const reason = lines.find(
      (l) => l.display?.tag === "run·error·session_missing",
    );
    expect(reason).toBeTruthy();
    expect(reason!.display!.text).toContain("transcript no longer exists");
    expect(reason!.display!.text).not.toMatch(/credential was rejected/i);
    // Redaction invariant: the raw error text never reaches the console.
    expect(reason!.display!.text).not.toContain("8a1f-dead-beef");
  });

  it("errors when the stream ends with no result envelope (aborted)", async () => {
    const { q } = fakeQuery([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }]);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
  });

  it("a spawn-time crash emits a redaction-safe 'could not start' err line (A3)", async () => {
    // The queryFn itself throws with an fd-exhaustion code — the exact
    // spawn-EBADF class that killed runs silently before A3.
    const boom = () => {
      const e = new Error("spawn EBADF") as Error & { code: string };
      e.code = "EBADF";
      throw e;
    };
    const adapter = createClaudeAdapter({ queryFn: boom as never });
    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: (e) => (exit = e) });
    await drain();
    expect(exit).toMatchObject({ outcome: "error" });
    const errLine = lines.find((l) => l.display?.ev === "err");
    expect(errLine?.display?.text).toContain("could not be started");
    // The raw error text (which can echo argv/creds) is NEVER surfaced.
    expect(errLine?.display?.text).not.toContain("EBADF");
  });

  it("classifies a quota failure into a redaction-safe reason line (A3)", async () => {
    const boom = () => {
      throw new Error("429 usage limit reached for this org");
    };
    const adapter = createClaudeAdapter({ queryFn: boom as never });
    const lines: EmittedLine[] = [];
    adapter.start(SPEC, { onLine: (l) => lines.push(l), onExit: () => {} });
    await drain();
    const errLine = lines.find((l) => l.display?.ev === "err");
    expect(errLine?.display?.text).toContain("usage quota");
  });

  it("threads spec.effort into options.effort (and omits it when absent)", async () => {
    const result = [
      { type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} },
    ];
    let captured: { model?: string; effort?: string } | undefined;
    const queryFn = (params: { options?: { model?: string; effort?: string } }) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };

    // With effort set.
    createClaudeAdapter({ queryFn: queryFn as never }).start(
      { ...SPEC, model: "sonnet", effort: "xhigh" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(captured?.effort).toBe("xhigh");
    expect(captured?.model).toBe("sonnet");

    // Without effort → options.effort is absent (SDK default applies).
    createClaudeAdapter({ queryFn: queryFn as never }).start(
      { ...SPEC, model: "sonnet" },
      { onLine: () => {}, onExit: () => {} },
    );
    await drain();
    expect(captured?.effort).toBeUndefined();
  });

  it("isolates every run from the host ~/.claude (settingSources + skills empty)", async () => {
    const result = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    let captured: { settingSources?: string[]; skills?: string[] } | undefined;
    const queryFn = (params: { options?: { settingSources?: string[]; skills?: string[] } }) => {
      captured = params.options;
      const { q } = fakeQuery(result);
      return q;
    };
    createClaudeAdapter({ queryFn: queryFn as never }).start(SPEC, { onLine: () => {}, onExit: () => {} });
    await drain();
    // Empty settingSources = no host settings tiers; empty skills = the model
    // sees NONE of the operator-user's personal Claude Code skills/plugins.
    expect(captured?.settingSources).toEqual([]);
    expect(captured?.skills).toEqual([]);
  });

  it("denies the SDK bundled parity/governance tools on every run (keeps ToolSearch + coding tools), plus repo-mutation for operators", async () => {
    const result = [{ type: "result", subtype: "success", is_error: false, num_turns: 1, usage: {} }];
    // Capture each run's options by index (no reassignment → clean typing).
    const seen: ({ disallowedTools?: string[] } | undefined)[] = [];
    const queryFn = (params: { options?: { disallowedTools?: string[] } }) => {
      seen.push(params.options);
      const { q } = fakeQuery(result);
      return q;
    };
    const run = async (spec: RunSpec) => {
      createClaudeAdapter({ queryFn: queryFn as never }).start(spec, { onLine: () => {}, onExit: () => {} });
      await drain();
      return seen[seen.length - 1];
    };

    // EVERY run denies the SDK-bundled tools that break Codex/Claude parity or
    // bypass viberr governance (docker-verified they load despite skills:[]):
    // Skill, Task (subagents), Workflow, Cron*, ScheduleWakeup, RemoteTrigger,
    // Monitor, Push/SendMessage, DesignSync, Enter/ExitWorktree.
    const primaryDenied = (await run({ ...SPEC, kind: "primary" }))?.disallowedTools ?? [];
    expect(primaryDenied).toEqual(
      expect.arrayContaining([
        "Skill",
        // The whole subagent-spawn family — sync `Task` AND the async
        // `TaskCreate`/`TaskGet`/… variants (both leak past the SDK in the
        // production docker init; either can spawn an unrestricted subagent).
        "Task",
        "TaskCreate",
        "TaskGet",
        "TaskList",
        "TaskOutput",
        "TaskStop",
        "TaskUpdate",
        "Workflow",
        "CronCreate",
        "ScheduleWakeup",
        "Monitor",
        "PushNotification",
        "EnterWorktree",
      ]),
    );
    // But NOT ToolSearch (the operator loads its deferred mcp__viberr__* tools
    // through it), and NOT the coding/web toolset — specialists do real work.
    expect(primaryDenied).not.toContain("ToolSearch");
    expect(primaryDenied).not.toContain("Bash");
    expect(primaryDenied).not.toContain("WebFetch");

    // Operator ADDS the repo-mutation built-ins on top of the base list, but must
    // keep ToolSearch (it can't reach its mcp__viberr__* governance tools without it).
    const opDenied = (await run({ ...SPEC, kind: "operator" }))?.disallowedTools ?? [];
    expect(opDenied).toEqual(
      expect.arrayContaining(["Skill", "Task", "Bash", "Edit", "Write", "NotebookEdit"]),
    );
    expect(opDenied).not.toContain("ToolSearch");

    // A specialist WITH withheld caps gets the base list PLUS those.
    const withheld =
      (await run({ ...SPEC, kind: "primary", disallowedTools: ["Bash(git push:*)"] }))
        ?.disallowedTools ?? [];
    expect(withheld).toContain("Bash(git push:*)");
    expect(withheld).toContain("Skill");

    // F10-12/F10-04: a SUPPORTING/reviewing run (kind: "reviewer") is read-only
    // for the repo — the file-write built-ins and every git/gh mutation command
    // are denied, so a reviewer physically cannot commit, push, or open a PR
    // (the VIB-30 class). Read/Grep/Bash-for-validation stay available.
    const reviewerDenied = (await run({ ...SPEC, kind: "reviewer" }))?.disallowedTools ?? [];
    expect(reviewerDenied).toEqual(
      expect.arrayContaining([
        "Edit",
        "MultiEdit",
        "Write",
        "NotebookEdit",
        "Bash(git commit:*)",
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
      ]),
    );
    // A delivering (primary) run is NOT read-only — it must be able to write.
    expect(primaryDenied).not.toContain("Write");
    expect(primaryDenied).not.toContain("Bash(git commit:*)");
  });

  it("interrupt() calls the SDK interrupt and ends interrupted (no result line)", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ type: "assistant", message: { content: [{ type: "text", text: "line " + i }] } }));
    const { q, wasInterrupted } = fakeQuery(many);
    const adapter = createClaudeAdapter({ queryFn: () => q });
    let exit: RunExit | null = null;
    const handle = adapter.start(SPEC, { onLine: () => {}, onExit: (e) => (exit = e) });
    handle.interrupt();
    await drain();
    expect(wasInterrupted()).toBe(true);
    expect(exit).toMatchObject({ outcome: "interrupted" });
  });
});

describe("resolveClaudeEffort (P13-RT-08)", () => {
  it("accepts only the tiers the Claude SDK's effort union allows", () => {
    expect(resolveClaudeEffort("low")).toBe("low");
    expect(resolveClaudeEffort("max")).toBe("max");
    expect(resolveClaudeEffort("xhigh")).toBe("xhigh");
    // "minimal" is a CODEX tier. A profile created on Codex and later switched
    // to Claude keeps its stored effort (the modal only refetches the catalog on
    // backend change), so this value really does reach the adapter.
    expect(resolveClaudeEffort("minimal")).toBeUndefined();
    expect(resolveClaudeEffort("")).toBeUndefined();
    expect(resolveClaudeEffort(undefined)).toBeUndefined();
  });

  it("drops an out-of-union effort instead of forwarding it to the SDK", async () => {
    const seen: { effort?: string }[] = [];
    const adapter = createClaudeAdapter({
      queryFn: ({ options }) => {
        seen.push({ ...(options?.effort ? { effort: options.effort } : {}) });
        return fakeQuery([{ type: "result", subtype: "success", is_error: false }]).q;
      },
    });
    adapter.start({ ...SPEC, effort: "minimal" }, { onLine: () => {}, onExit: () => {} });
    await drain();
    expect(seen.at(-1)?.effort).toBeUndefined();

    adapter.start({ ...SPEC, effort: "xhigh" }, { onLine: () => {}, onExit: () => {} });
    await drain();
    expect(seen.at(-1)?.effort).toBe("xhigh");
  });
});

describe("claude idle hang guard (P13-RT-11)", () => {
  /**
   * BEFORE: the Claude adapter had NO timer of any kind. `maxTurns` bounds
   * turns, not wall-clock or idle time, and a `for await` over a stalled SDK
   * stream never settles — so a hung stdio MCP or a mid-tool-call network
   * partition left the run `running` forever, the task `waiting: agent`, the
   * delivering single-flight refusing every later delivering run on that task,
   * and the board showing "agent working" until the next process restart.
   */
  it("settles a stalled stream as `error` with a classified reason line", async () => {
    process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS = "10";
    let interrupted = false;
    const stalled = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s-1" };
      // Never yields again; only interrupt() ends it.
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (interrupted) {
            clearInterval(timer);
            resolve();
          }
        }, 1);
      });
    })() as unknown as ClaudeQuery;
    (stalled as { interrupt: () => Promise<void> }).interrupt = async () => {
      interrupted = true;
    };

    const lines: EmittedLine[] = [];
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => stalled }).start(SPEC, {
      onLine: (l) => lines.push(l),
      onExit: (e) => (exit = e),
    });
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 2));

    expect(interrupted).toBe(true);
    expect(exit).toMatchObject({ outcome: "error", effectiveBackend: "claude" });
    // Distinct from a task failure: the copy has to say "hung", and the tag has
    // to carry a class `runFailureReason` can route on.
    expect(lines.at(-1)?.display?.tag).toBe("run·error·idle_timeout");
    expect(lines.at(-1)?.display?.text).toContain("no output");
    delete process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
  });

  it("a normal run never trips the guard", async () => {
    process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS = "200";
    const { q } = fakeQuery([
      { type: "system", subtype: "init", session_id: "s-2" },
      { type: "result", subtype: "success", is_error: false },
    ]);
    let exit: RunExit | null = null;
    createClaudeAdapter({ queryFn: () => q }).start(SPEC, {
      onLine: () => {},
      onExit: (e) => (exit = e),
    });
    await drain();
    expect(exit).toMatchObject({ outcome: "finished" });
    delete process.env.VIBERR_CLAUDE_IDLE_TIMEOUT_MS;
  });
});
