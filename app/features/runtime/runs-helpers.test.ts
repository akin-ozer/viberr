import { describe, expect, it } from "vitest";
import {
  agentMessageProse,
  argumentRows,
  consoleCodeBlock,
  diffLineKind,
  fileChangeChips,
  fmtClock,
  fmtTok,
  commandNote,
  HEARTBEAT_NOTE,
  heartbeatLabel,
  filePathOf,
  hiddenArguments,
  roleShort,
  runInputRows,
  runLabel,
  runStatePill,
  RUN_STATE,
  thoughtLabel,
  toolChip,
  waitCountTitle,
  waitText,
} from "./runs-helpers";
import {
  TOOL_PROGRESS_TAG,
  waitClock,
  type LogLine,
  type RunInputs,
  type RunView,
} from "./runtime-types";
import { NO_RUN_CACHE } from "./runtime-types";

const base: RunView = {
  id: "primary", serverRunId: "run_1", role: "Primary specialist", kind: "primary",
  profileId: "developer",
  who: { kind: "agent", backend: "codex", name: "Codex", role: "Developer" },
  backend: "codex", sdk: "Codex SDK", model: "gpt-5.4-codex", sid: "0199", exportable: false,
  state: "running", lifecycle: "running", interruptedBy: null, phase: null, step: null,
  startedAt: null, finished: null, turns: 0, tokens: 0, tokensEstimated: false, cache: NO_RUN_CACHE, lines: [], raw: [], lineCount: 0,
  logWindow: { totalLines: 0, hasMore: false, runIds: ["run_1"], oldest: null, headSeq: -1 },
};

describe("fmtClock boundaries (runs.md §7)", () => {
  it("402 → 06:42, 5462 → 1:31:02 (hours unpadded)", () => {
    expect(fmtClock(402)).toBe("06:42");
    expect(fmtClock(5462)).toBe("1:31:02");
    expect(fmtClock(0)).toBe("00:00");
  });
});

describe("fmtTok boundaries (runs.md §7)", () => {
  it("999→999, 1000→1.0k, 99999→100.0k, 100000→100k, 128442→128k", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1000)).toBe("1.0k");
    expect(fmtTok(38400)).toBe("38.4k");
    expect(fmtTok(99999)).toBe("100.0k");
    expect(fmtTok(100000)).toBe("100k");
    expect(fmtTok(128442)).toBe("128k");
    // The whole-prompt count of a long run crosses a million.
    expect(fmtTok(1_000_000)).toBe("1.0M");
    expect(fmtTok(4_526_112)).toBe("4.5M");
  });
});

describe("runLabel / roleShort", () => {
  it("runLabel = who.name (+ role)", () => {
    expect(runLabel(base)).toBe("Codex · Developer");
    expect(runLabel({ ...base, op: true, who: { kind: "agent", name: "Operator" } })).toBe("Operator");
  });
  it("roleShort speaks engagement vocabulary: operator / delivering / supporting", () => {
    // UXV19-3: the run picker printed the internal RunKind literal "primary"
    // for the delivering run — a third name for the agent the Execution
    // profile on the SAME page calls "Delivering agent" and the Agents roster
    // calls "delivering" (F10-20's mapping). The kind literals stay on the row.
    // Canary: restore `kind === "primary" ? "primary" : "reviewer"` and both
    // halves below fail.
    expect(roleShort({ ...base, op: true })).toBe("operator");
    expect(roleShort(base)).toBe("delivering");
    // `kind: "reviewer"` is what EVERY non-delivering run is written with
    // (specialist-run.server.ts), so the label is the honest superset.
    expect(roleShort({ ...base, kind: "reviewer" })).toBe("supporting");
    // Kind is data on the run row — the role label is free-form (live
    // engagement role), so roleShort keys on kind, never the label.
    expect(roleShort({ ...base, kind: "reviewer", role: "Anything" })).toBe("supporting");
  });

  it("ruling 419(d): a controller turn has no engagement, so it prints no role", () => {
    // Live on the ax-clone controller page the console read "Controller ·
    // supporting". Canary: drop the `kind === "controller"` return.
    expect(roleShort({ ...base, kind: "controller", role: "Controller" })).toBeNull();
  });
});

describe("runStatePill (ruling 11 lifecycle mapping)", () => {
  it("running/idle/done/error use RUN_STATE", () => {
    expect(runStatePill({ ...base, state: "done", lifecycle: "finished" }).label).toBe(RUN_STATE.done.label);
    expect(runStatePill({ ...base, state: "error", lifecycle: "error" }).label).toBe("continuity error");
  });
  it("queued → neutral 'queued'", () => {
    expect(runStatePill({ ...base, state: "idle", lifecycle: "queued" })).toEqual({ kind: "neutral", label: "queued" });
  });
  it("a classified provider overload → blocked 'provider overloaded', not 'continuity error' (ruling 130(a) reader)", () => {
    expect(runStatePill({ ...base, state: "error", lifecycle: "error", failureKind: "overloaded" })).toEqual({
      kind: "blocked",
      label: "provider overloaded",
    });
  });
  it("ruling 175: a run the spending cap stopped reads 'cut off · spending cap', not 'continuity error'", () => {
    expect(runStatePill({ ...base, state: "error", lifecycle: "error", failureKind: "max_budget" })).toEqual({
      kind: "blocked",
      label: "cut off · spending cap",
    });
  });
  it("U35-11: an overload whose origin is this deployment's network reads 'provider unreachable', never 'provider overloaded'", () => {
    expect(runStatePill({ ...base, state: "error", lifecycle: "error", failureKind: "overloaded", failureOrigin: "local" })).toEqual({
      kind: "blocked",
      label: "provider unreachable",
    });
  });
  it("interrupted → neutral 'interrupted · by <actor>'", () => {
    const p = runStatePill({ ...base, state: "idle", lifecycle: "interrupted", interruptedBy: { userId: "u1", label: "Arda Kaya" } });
    expect(p.kind).toBe("neutral");
    expect(p.label).toBe("interrupted · by Arda");
  });
  it("pass 35 U35-7: interrupted by a restart → neutral 'interrupted · by a restart', never a continuity error", () => {
    const p = runStatePill({ ...base, state: "idle", lifecycle: "interrupted", interruptedReason: "restart" });
    expect(p.kind).toBe("neutral");
    expect(p.label).toBe("interrupted · by a restart");
    // A stored row with neither a person nor a reason still reads as interrupted.
    expect(runStatePill({ ...base, state: "idle", lifecycle: "interrupted" }).label).toBe("interrupted");
  });
});

// ------------------------------------------------------------------- P19-G11

const emptyInputs: RunInputs = {
  cwd: "/data/projects/p/tasks/VIB-1/workspace/widgets",
  repo: "acme/widgets",
  cloned: true,
  delivers: true,
  personaChars: 0,
  promptChars: 4200,
  anchor: null,
  skills: { granted: [], native: [], injected: [] },
  knowledge: [],
  mcp: { mounted: [], unresolved: [], unhealthy: [] },
  unresolvedResources: [],
  tools: { denied: [], toolkit: [] },
  directive: null,
};

describe("runInputRows (P19-G11)", () => {
  it("states an EMPTY grant explicitly rather than dropping the row", () => {
    // The whole point is to make an absence visible: a knowledge base that
    // reached no run is exactly what this surface exists to catch, and a row
    // that vanishes when it has nothing to say cannot report one.
    // Canary: skip the empty rows and the two assertions below fail.
    const rows = runInputRows(emptyInputs);
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.text]));
    expect(byTag.knowledge).toBe("none granted");
    expect(byTag.skills).toBe("none granted");
    expect(byTag.anchor).toContain("No canonical task state was sent");
    expect(byTag.persona).toContain("no persona was sent");
  });

  /**
   * Ruling 346 (pass 37, F37-182): two of these rows describe an ABSENCE, and
   * ruling 344 gave that absence two new meanings the same day.
   *
   * The operator and the controller both legitimately record `cwd: null` and
   * `anchor: null` — neither has a checkout, and neither is handed a canonical
   * task block. The stand-in sentences were written when every caller was a
   * specialist, so on the first coordinator run to reach this surface they
   * would have said "no repository attached to this project" about a
   * repo-backed project, and "It saw the goal and its directive only" about a
   * drive whose first act is `get_task`. Pass 24's shape: a fix wired into a
   * surface whose prose assumed the old set of callers.
   */
  it("ruling 346: a coordinator's missing workspace and anchor are described as what they are", () => {
    // CANARY: drop the `kind` argument from `runInputRows` and both of these
    // fall back to the specialist sentences, which are false here.
    const drive = Object.fromEntries(
      runInputRows(emptyInputs, "codex", "operator").map((r) => [r.tag, r.text]),
    );
    expect(drive.workspace).toContain("No workspace of its own");
    expect(drive.workspace).not.toContain("no repository attached");
    expect(drive.anchor).toContain("get_task");
    expect(drive.anchor).not.toContain("goal and its directive only");

    const turn = Object.fromEntries(
      runInputRows(emptyInputs, "claude", "controller").map((r) => [r.tag, r.text]),
    );
    expect(turn.workspace).toContain("never a checkout");
    expect(turn.anchor).toContain("not bound to one task");

    // A specialist keeps the reading those sentences were written for, and so
    // does a stored line from before the kind was passed — the rows are
    // rendered from history, not only from live runs.
    for (const rows of [
      runInputRows(emptyInputs, "claude", "primary"),
      runInputRows(emptyInputs, "claude"),
    ]) {
      const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.text]));
      expect(byTag.anchor).toContain("No canonical task state was sent");
      // The fixture IS a specialist's: a checkout of a real repo, which is what
      // the coordinator rows must never be described as.
      expect(byTag.workspace).toContain("checkout of acme/widgets");
    }

    // And a real anchor still prints verbatim whatever the kind — the absence
    // is the only thing this ruling touches.
    const anchored = runInputRows(
      { ...emptyInputs, anchor: "## Canonical task state\nstage: Build" },
      "claude",
      "operator",
    ).find((r) => r.tag === "anchor")!;
    expect(anchored.text).toContain("stage: Build");
    expect(anchored.pre).toBe(true);
  });

  it("ruling 185: no sandbox row on either backend — Viberr confines neither", () => {
    // The row existed for the Codex OS sandbox; the sandbox is gone (F36-1 and
    // F36-11 cost more than it bought), so a run that claims one would be a
    // claim about nothing. Canary: re-add a `sandbox` row to `runInputRows`.
    expect(runInputRows(emptyInputs, "codex").some((r) => r.tag === "sandbox")).toBe(false);
    expect(runInputRows(emptyInputs, "claude").some((r) => r.tag === "sandbox")).toBe(false);
    // What DOES disclose the confinement is the denied-tool list, on both.
    const denied = runInputRows(
      { ...emptyInputs, tools: { denied: ["Edit", "Write"], toolkit: [] } },
      "codex",
    );
    expect(denied.find((r) => r.tag === "tools")?.text).toContain("Edit");
  });

  it("ruling 185: a Codex run's denied-tool list names the web-search toggle as the one binding entry", () => {
    // The sentence used to credit a sandbox with the repo-write family ("bind
    // via sandbox and search toggles"); that sandbox is gone, so on Codex a
    // withheld Edit/Write or `git push` is advisory and only the CLI's web
    // search is actually switched off. Canary: restore the old sentence in
    // `runInputRows` and the exact match below fails.
    const tools = (backend: "claude" | "codex") =>
      runInputRows(
        {
          ...emptyInputs,
          tools: { denied: ["Edit", "Bash(git push:*)", "WebSearch"], toolkit: [] },
        },
        backend,
      ).find((r) => r.tag === "tools")!.text;
    expect(tools("codex")).toBe(
      "viberr tools: none · capability grants deny (on this Codex run only a withheld web " +
        "search binds, through the CLI's search toggle; the repo-write and command-level " +
        "entries are advisory, and the server-owned delivery gate is the boundary): " +
        "Edit, Bash(git push:*), WebSearch",
    );
    expect(tools("codex")).not.toContain("sandbox");
    // Claude's denylist binds every entry, so its row stays a flat "denied".
    expect(tools("claude")).toBe(
      "viberr tools: none · denied by its capability grants: Edit, Bash(git push:*), WebSearch",
    );
  });

  it("ruling 175: states the spending cap, honest that Codex has no budget option, and 'none' when unset", () => {
    const spend = (inputs: RunInputs, backend: "claude" | "codex") =>
      runInputRows(inputs, backend).find((r) => r.tag === "spend")?.text;
    expect(spend({ ...emptyInputs, spendCapUsd: 2.5 }, "claude")).toBe(
      "capped at $2.50: the run stops when it has spent that much",
    );
    expect(spend({ ...emptyInputs, spendCapUsd: 2.5 }, "codex")).toBe(
      "the instance caps a Claude run at $2.50, but Codex has no budget option: this run is bounded by its idle timer only",
    );
    expect(spend({ ...emptyInputs, spendCapUsd: null }, "claude")).toBe(
      "no spending cap (Instance settings → Max spend per Claude run)",
    );
    // A line written before the ruling says nothing it cannot know.
    expect(spend(emptyInputs, "claude")).toBeUndefined();
  });

  it("carries the canonical anchor verbatim, with its line breaks intact", () => {
    const anchor = "## Canonical task state\n\n### Goal (canonical)\nShip the CURRENT goal.";
    const rows = runInputRows({ ...emptyInputs, anchor });
    const row = rows.find((r) => r.tag === "anchor")!;
    expect(row.text).toBe(anchor);
    expect(row.pre).toBe(true);
  });

  it("separates a skill that MOUNTED from one that rode the prompt", () => {
    const rows = runInputRows({
      ...emptyInputs,
      skills: {
        granted: ["commits", "review-craft"],
        native: ["commits"],
        injected: ["review-craft"],
      },
    });
    const text = rows.find((r) => r.tag === "skills")!.text;
    expect(text).toContain("mounted into the workspace: commits");
    expect(text).toContain("carried as prompt text instead: review-craft");
  });

  it("names an MCP grant that resolved to nothing and one whose probe failed", () => {
    const rows = runInputRows({
      ...emptyInputs,
      mcp: { mounted: ["github"], unresolved: ["vm-memory"], unhealthy: ["broken-mcp"] },
      unresolvedResources: [{ name: "house-style", reason: "no such knowledge base" }],
    });
    const byTag = Object.fromEntries(rows.map((r) => [r.tag, r.text]));
    // Ruling 310: the strip names the miss and asserts no cause — the record keeps
    // names only, and "(no such server)" was the invented cause the prompts lost.
    expect(byTag.mcp).toContain("granted but NOT mounted: vm-memory");
    expect(byTag.mcp).not.toContain("no such server");
    expect(byTag.mcp).toContain("last connection check failed: broken-mcp");
    expect(byTag.missing).toContain("house-style (no such knowledge base)");
  });

  it("ruling 176: names the org servers' write tools the run withheld", () => {
    const rows = runInputRows({
      ...emptyInputs,
      mcp: {
        mounted: ["github", "docs"],
        unresolved: [],
        unhealthy: [],
        writeToolsDenied: [
          { server: "github", tools: ["create_pull_request", "merge_pull_request"] },
        ],
      },
    });
    const mcp = rows.find((r) => r.tag === "mcp")!.text;
    expect(mcp).toContain(
      "write tools withheld (repo write is withheld): github (create_pull_request, merge_pull_request)",
    );
    // A line written before the ruling carries no field and says nothing.
    const old = runInputRows({ ...emptyInputs, mcp: { mounted: ["github"], unresolved: [], unhealthy: [] } });
    expect(old.find((r) => r.tag === "mcp")!.text).not.toContain("write tools withheld");
  });
});


/* ------------------------------------------------------------------ P19-RC1
 *
 * The console projected `think` / `tool` / `out` / `diff` and painted them all
 * as the same flat row. These fold that structure back out — and every one of
 * them must be a NO-OP under `raw`, whose contract is "what the provider sent".
 */

const L = (over: Partial<LogLine> = {}): LogLine => ({
  t: "10:00:00",
  ev: "text",
  tag: "agent_message",
  text: "hello",
  ...over,
});
const R = (display: LogLine, raw = "{}") => ({ display, raw });

describe("thoughtLabel (P19-RC1)", () => {
  it("MEASURES the span from the stored clocks", () => {
    expect(
      thoughtLabel([R(L({ t: "10:00:01" })), R(L({ t: "10:00:05" }))]),
    ).toBe("Thought for 4s · 2 steps");
  });

  it("omits a duration it cannot measure rather than inventing one", () => {
    // Same second, unreadable clock, or a midnight wrap: say the step count and
    // stop. A fabricated "4s" because it reads better is the exact
    // invented-signal failure this codebase keeps ruling out.
    expect(thoughtLabel([R(L({ t: "10:00:02" })), R(L({ t: "10:00:02" }))])).toBe(
      "Thought · 2 steps",
    );
    expect(thoughtLabel([R(L({ t: "nope" })), R(L({ t: "10:00:05" }))])).toBe(
      "Thought · 2 steps",
    );
    expect(thoughtLabel([R(L({ t: "23:59:59" })), R(L({ t: "00:00:03" }))])).toBe(
      "Thought · 2 steps",
    );
  });
});

describe("toolChip (P19-RC1)", () => {
  it("promotes the tool's own name and target", () => {
    expect(toolChip(L({ ev: "tool", name: "Bash", text: "npm run build" }))).toEqual({
      who: { kind: "builtin", name: "Bash", server: null, tool: "Bash", label: "Bash" },
      detail: "npm run build",
    });
  });

  it("knows whose tool it is (ruling 366): the product's own get the mark, the prefix goes", () => {
    const chip = toolChip(L({ ev: "tool", name: "mcp__viberr__deliver_for_review", text: "reason: rework landed" }))!;
    expect(chip.who).toMatchObject({ kind: "viberr", label: "deliver_for_review" });
    expect(chip.detail).toBe("reason: rework landed");
    expect(toolChip(L({ ev: "tool", name: "everything-http.echo", text: "ping" }))!.who.label).toBe(
      "everything-http · echo",
    );
  });

  it("declines anything that is not a named tool call", () => {
    // No name = nothing the provider actually reported; a chip labelled with a
    // guess is worse than the plain row.
    expect(toolChip(L({ ev: "tool", text: "no name" }))).toBeNull();
    expect(toolChip(L({ ev: "text", name: "Bash" }))).toBeNull();
  });
});

describe("fileChangeChips (P19-RC1)", () => {
  it("reports the path and the KIND the envelope recorded", () => {
    const chips = fileChangeChips(
      L({
        ev: "diff",
        changes: [
          { path: "app/a.ts", kind: "add" },
          { path: "app/b.ts", kind: "delete" },
        ],
      }),
    );
    expect(chips).toEqual([
      { path: "app/a.ts", kind: "add" },
      { path: "app/b.ts", kind: "delete" },
    ]);
    // Deliberately no line counts: `changes` carries a path and a kind, so a
    // "+74 −41" beside it would be invented.
    expect(JSON.stringify(chips)).not.toMatch(/[+-]\d/);
  });

  it("is null when the line recorded no changes", () => {
    expect(fileChangeChips(L({ ev: "diff" }))).toBeNull();
    expect(fileChangeChips(L({ ev: "diff", changes: [] }))).toBeNull();
  });
});

describe("consoleCodeBlock (P19-RC1)", () => {
  it("lifts MULTI-line output and diffs out of the row", () => {
    expect(consoleCodeBlock(L({ ev: "out", text: "a\nb" }))).toEqual({
      code: "a\nb",
      diff: false,
    });
    expect(consoleCodeBlock(L({ ev: "diff", text: "+a\n-b" }))).toEqual({
      code: "+a\n-b",
      diff: true,
    });
  });

  it("leaves a single line inline, and other kinds alone", () => {
    expect(consoleCodeBlock(L({ ev: "out", text: "built in 1.2s" }))).toBeNull();
    expect(consoleCodeBlock(L({ ev: "text", text: "a\nb" }))).toBeNull();
  });

  it("never truncates — the whole output is the block's content", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    expect(consoleCodeBlock(L({ ev: "out", text: long }))!.code).toBe(long);
  });
});

describe("diffLineKind (P19-RC1)", () => {
  it("marks adds and removals, and spares the file headers", () => {
    expect(diffLineKind("+ added")).toBe("add");
    expect(diffLineKind("- removed")).toBe("del");
    expect(diffLineKind(" context")).toBeNull();
    // `+++ b/file` / `--- a/file` are headers, not content.
    expect(diffLineKind("+++ b/app/a.ts")).toBeNull();
    expect(diffLineKind("--- a/app/a.ts")).toBeNull();
  });
});

describe("agentMessageProse (N20-18)", () => {
  it("folds a Codex outcome envelope to its summary prose", () => {
    const envelope = JSON.stringify({
      evidence: null,
      summary: "Implemented the parser and added tests.",
      verdict: null,
      question: null,
    });
    expect(agentMessageProse(L({ tag: "agent_message", text: envelope }))).toBe(
      "Implemented the parser and added tests.",
    );
  });

  it("appends a raised question — title, body, and options — after the summary", () => {
    const envelope = JSON.stringify({
      evidence: null,
      summary: "Blocked on a colour choice.",
      verdict: null,
      question: {
        title: "Amber or cobalt?",
        body: "The mock shows both.",
        options: [{ title: "amber" }, { title: "cobalt" }],
      },
    });
    expect(agentMessageProse(L({ tag: "agent_message", text: envelope }))).toBe(
      "Blocked on a colour choice.\n\n" +
        "Question: Amber or cobalt? · The mock shows both. · Options: amber · cobalt",
    );
  });

  it("renders a question-only envelope (summary null) as the question", () => {
    const envelope = JSON.stringify({
      evidence: null,
      summary: null,
      verdict: null,
      question: { title: "Which target?" },
    });
    expect(agentMessageProse(L({ tag: "agent_message", text: envelope }))).toBe(
      "Question: Which target?",
    );
  });

  it("leaves a plain-prose agent_message alone (not every Codex reply is an envelope)", () => {
    expect(agentMessageProse(L({ tag: "agent_message", text: "Done — all green." }))).toBeNull();
  });

  it("ignores non-envelope JSON and every non-agent_message line", () => {
    // A bare JSON object the agent authored itself is not the outcome envelope.
    expect(agentMessageProse(L({ tag: "agent_message", text: '{"foo":1}' }))).toBeNull();
    // Claude's own prose event, and other event kinds, are untouched.
    expect(agentMessageProse(L({ tag: "assistant", text: "hi" }))).toBeNull();
    expect(agentMessageProse(L({ ev: "tool", tag: "command_execution", text: "ls" }))).toBeNull();
  });
});

/**
 * Ruling 366: a call's heartbeats are ONE wait row (folded by console-fold.ts),
 * in the tense its liveness sets.
 */
describe("waitText (ruling 366)", () => {
  const beat = (call: string, elapsed: number | null, t = "10:00:30"): LogLine =>
    L({
      t,
      ev: "meta",
      tag: TOOL_PROGRESS_TAG,
      name: "mcp__viberr__run_agent",
      text: "mcp__viberr__run_agent still running",
      progress: { call, elapsed, heartbeat: true, at: "2026-09-20T10:00:30.000Z" },
    });

  it("prints the provider's LAST figure, in the tense the row's liveness sets", () => {
    const lines = [R(beat("a", 30)), R(beat("a", 150, "10:02:30"))];
    expect(waitText(lines, true)).toBe("still running · 2m 30s");
    // Ended: all the record supports is that the call was still open AT the
    // figure — never a total the heartbeats cannot give.
    expect(waitText(lines, false)).toBe("ran past 2m 30s");
    expect(waitText([R(beat("a", null))], true)).toBe("still running");
    expect(waitText([R(beat("a", null))], false)).toBe("was still running");
    // 366(e): the live count's tooltip says where its figure comes from.
    expect(waitCountTitle(lines, "13:02:30")).toBe(
      "Counting on from the runtime's last heartbeat: 2m 30s at 13:02:30. " +
        "A heartbeat lands about every 30 s and resets the count.",
    );
  });

  it("discloses each folded heartbeat by number and figure, under a note that says what one is (366(d))", () => {
    expect(heartbeatLabel(beat("a", 30), 1)).toBe("heartbeat 1 · 30s in");
    expect(heartbeatLabel(beat("a", 90), 3)).toBe("heartbeat 3 · 1m 30s in");
    expect(heartbeatLabel(beat("a", null), 2)).toBe("heartbeat 2");
    expect(HEARTBEAT_NOTE).toBe(
      "A heartbeat is the runtime saying the call is still open: about one every 30 s, " +
        "carrying no output. Nothing here changed the run.",
    );
  });

  it("waitClock keeps whole units and never goes negative", () => {
    expect([29, 60, 150, 3600, 6039, 7200, -5].map(waitClock)).toEqual([
      "29s", "1m", "2m 30s", "1h", "1h 40m", "2h", "0s",
    ]);
  });
});

/**
 * Ruling 366(d): a tool row links to what its one-line summary CUT, named,
 * and to nothing else. Canary: count every omitted key and the Bash case
 * below grows a link for its `timeout`; drop the clip check and a clipped
 * prompt reads as shown.
 */
describe("filePathOf (ruling 499)", () => {
  it("names the file a row's whole summary is, and nothing inside a command", () => {
    const row = (name: string, text: string, input: LogLine["input"]) => L({ ev: "tool", tag: "tool_use", name, text, input });
    expect(filePathOf(row("Read", "/w/a.md", { file_path: "/w/a.md", limit: 5 }))).toBe("/w/a.md");
    expect(filePathOf(row("Bash", "cat /w/a.md", { command: "cat /w/a.md" }))).toBeNull();
    expect(filePathOf(row("Grep", "TODO /w", { pattern: "TODO", path: "/w" }))).toBeNull();
    expect(filePathOf(L({ ev: "out", text: "/w/a.md", input: { file_path: "/w/a.md" } }))).toBeNull();
  });
});

describe("hiddenArguments + argumentRows + commandNote (ruling 366(d))", () => {
  const tool = (name: string, text: string, input: LogLine["input"] = null) => L({ ev: "tool", tag: "tool_use", name, text, input });

  it("names a clipped string, a collection by its size, and a long omitted string", () => {
    const long = "y".repeat(200);
    const clippedText = `profileId: developer · prompt: ${long.slice(0, 159)}…`;
    expect(hiddenArguments(tool("mcp__viberr__run_agent", clippedText, { profileId: "developer", prompt: long }))).toEqual({
      keys: ["prompt"],
      label: "+ full prompt",
    });
    expect(
      hiddenArguments(tool("mcp__viberr_agent__report_outcome", "summary: done · evidence: [3 items] · verdict: {2 fields}", {
        summary: "done", evidence: [1, 2, 3], verdict: { a: 1, b: 2 },
      })),
    ).toEqual({ keys: ["evidence", "verdict"], label: "+ evidence (3 items), verdict (2 fields)" });
    expect(
      hiddenArguments(tool("Edit", "app/a.ts", { file_path: "app/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 2;\nconst b = 3;" })),
    ).toEqual({ keys: ["old_string", "new_string"], label: "+ old_string, new_string" });
    // Past three, a count — the row is not the place for a key list.
    expect(hiddenArguments(tool("TodoWrite", "", { a: [1], b: [1], c: [1], d: [1] }))!.label).toBe("+ 4 arguments");
  });

  it("offers nothing for trivia: numbers, booleans, empty collections, short omitted strings, Bash's own description", () => {
    expect(hiddenArguments(tool("Bash", "npm test", { command: "npm test", description: "Run the suite", timeout: 60000, run_in_background: false }))).toBeNull();
    expect(hiddenArguments(tool("Read", "app/a.ts", { file_path: "app/a.ts", offset: 10, limit: 50 }))).toBeNull();
    expect(hiddenArguments(tool("Grep", "TODO app", { pattern: "TODO", path: "app", output_mode: "content", glob: "**/*.ts", "-i": true }))).toBeNull();
    expect(hiddenArguments(tool("mcp__viberr__read_default_branch_file", "a/b.ts", { path: "a/b.ts" }))).toBeNull();
    expect(hiddenArguments(tool("mcp__viberr__get_task", "", { events: [], meta: {}, n: null }))).toBeNull();
    expect(hiddenArguments(tool("exec", "ls"))).toBeNull();
    expect(hiddenArguments(L({ ev: "out", text: "x", input: { a: "z".repeat(80) } }))).toBeNull();
  });

  it("prints Bash's description beside its command, and nothing for other tools", () => {
    expect(commandNote(tool("Bash", "npm test", { command: "npm test", description: "  Run the suite " }))).toBe("Run the suite");
    expect(commandNote(tool("Bash", "npm test", { command: "npm test" }))).toBeNull();
    expect(commandNote(tool("Bash", "npm test", { command: "npm test", description: "   " }))).toBeNull();
    expect(commandNote(tool("mcp__viberr__run_agent", "x", { description: "not a shell" }))).toBeNull();
  });

  it("ruling 499: names nothing the row already draws in full (an edit's diff, a to-do list)", () => {
    const edit = tool("Edit", "app/a.ts", { file_path: "app/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 2;\nconst b = 3;" });
    expect(hiddenArguments(edit, ["old_string", "new_string"])).toBeNull();
    // Only what is drawn drops out: another cut argument keeps its link.
    expect(hiddenArguments(tool("X", "", { edits: [1, 2], note: "n".repeat(80) }), ["edits"])).toEqual({
      keys: ["note"],
      label: "+ note",
    });
  });

  it("discloses only the named keys, in full, in the link's order", () => {
    expect(argumentRows({ command: "npm test", tags: ["a", "b"], timeout: 60000 }, ["tags", "command", "missing"])).toEqual([
      { key: "tags", text: '[\n  "a",\n  "b"\n]' },
      { key: "command", text: "npm test" },
    ]);
  });
});
