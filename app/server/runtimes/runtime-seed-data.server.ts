import type { LogLine, RunKind } from "~/features/runtime/runtime-types";

/**
 * The RUNTIME dataset, ported VERBATIM from design/html-app/app/data.js
 * (the `cc.*`/`cx.*` builders + the per-task run arrays). These builders
 * produce the DISPLAY LogLine model; the simulated adapter feeds each line
 * through `rawLineFromDisplay` (wire-format.server) so the persisted
 * raw_json is authentic Claude/Codex wire JSON and display_json is its
 * projection — raw mode is uniform across real + simulated runs.
 *
 * 18 runs across 8 tasks (VIB-142, VIB-151, VIB-153, VIB-160, VIB-145,
 * VIB-148, VIB-139, VIB-141). Triage VIB-166/168 get none.
 *
 * Copy is verbatim from the mock (curly quotes, U+00B7 middots, U+2212
 * minus). Order within each task is preserved — it defines the dropdown
 * order and default logs selection (runs.md §3.3).
 */

// ---------------------------------------------------------- builders (cc/cx)

const cc = {
  init: (t: string, s: string): LogLine => ({ t, ev: "init", tag: "system·init", text: s }),
  text: (t: string, s: string): LogLine => ({ t, ev: "text", tag: "assistant", text: s }),
  tool: (t: string, n: string, s: string, input?: Record<string, unknown>): LogLine => ({
    t,
    ev: "tool",
    tag: "tool_use",
    name: n,
    text: s,
    input: input || null,
  }),
  out: (t: string, s: string): LogLine => ({ t, ev: "out", tag: "tool_result", text: s }),
  err: (t: string, s: string): LogLine => ({ t, ev: "err", tag: "tool_result", text: s }),
  res: (t: string, s: string, stats: LogLine["stats"]): LogLine => ({
    t,
    ev: "result",
    tag: "result",
    text: s,
    stats: stats || null,
  }),
};

const cx = {
  start: (t: string, s: string): LogLine => ({ t, ev: "init", tag: "thread.started", text: s }),
  turn: (t: string, s: string): LogLine => ({ t, ev: "meta", tag: "turn.started", text: s }),
  think: (t: string, s: string): LogLine => ({ t, ev: "think", tag: "reasoning", text: s }),
  exec: (t: string, s: string): LogLine => ({ t, ev: "tool", tag: "command_execution", name: "exec", text: s }),
  out: (t: string, s: string, exit?: number): LogLine => ({
    t,
    ev: exit ? "err" : "out",
    tag: "aggregated_output",
    text: s,
    exit: exit || 0,
  }),
  msg: (t: string, s: string): LogLine => ({ t, ev: "text", tag: "agent_message", text: s }),
  diff: (t: string, s: string, changes: LogLine["changes"]): LogLine => ({
    t,
    ev: "diff",
    tag: "file_change",
    text: s,
    changes: changes || null,
  }),
  done: (t: string, s: string, usage: LogLine["usage"]): LogLine => ({
    t,
    ev: "result",
    tag: "turn.completed",
    text: s,
    usage: usage || null,
  }),
};

// ---------------------------------------------------------- run definitions

/** One seeded run definition (a projection of the mock run object). */
export interface SeedRun {
  /** Thread id within the task ("op" | "primary" | "c0"). */
  id: string;
  role: string;
  kind: RunKind;
  /** Requested backend (kept for glyph fidelity). */
  backend: "claude" | "codex";
  sdk: string;
  model: string;
  /** Provider session/thread id. */
  sid: string;
  /** Mock render state → mapped to a real lifecycle by the seed. */
  state: "running" | "idle" | "done" | "error";
  phase?: string;
  step?: string;
  /** Mock `started` (HH:MM display) — the seed back-dates a real ISO. */
  startedDisplay?: string;
  /** Running-only: base elapsed seconds from the mock — the seed sets
   *  started_at = now − this so the strip ticks a realistic value (avoids
   *  the near-future wall-clock seed quirk). */
  elapsedSeconds?: number;
  finished?: string;
  /** The already-persisted lines. */
  lines: LogLine[];
  /** Running-only: lines that "arrive" live after the first subscribe. */
  live?: LogLine[];
}

const OP_SDK = "Claude Agent SDK";
const CODEX_SDK = "Codex SDK";
const CLAUDE_SDK = "Claude Agent SDK";

export const RUNTIME_SEED: Record<string, SeedRun[]> = {
  "VIB-142": [
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "e4b8a1c2-0142-4d6f-9a3b-7c5e8f01d442",
      state: "idle",
      phase: "Waiting on human acceptance",
      lines: [
        cc.init("08:02:11", "session e4b8a1c2 · claude-sonnet-4-5 · 9 tools · mcp: viberr-task-store · cwd /work/viberr"),
        cc.text("09:02:20", "Transition request raised: In Progress → Review, evidence attached."),
        cc.text("09:41:12", "Completion report received from the Developer. Packet raised for human acceptance."),
        cc.text("09:58:30", "Arda's guidance noted — PAT-scope preference recorded against the open decision."),
      ],
    },
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a1f3-4c02-7d31-8b6e-2f41aa90c4d7",
      state: "done",
      finished: "9:41",
      lines: [
        cx.start("08:12:04", "thread 0199a1f3-4c02… resumed · gpt-5.4-codex"),
        cx.turn("08:12:05", "turn 9"),
        cx.exec("08:12:31", "npm test -- --filter=pr-sync"),
        cx.out("08:13:02", "integration/pr_sync: 38 passed · 0 failed"),
        cx.diff("09:12:40", "9 files · +412 −87 · policy gate, branch reconciler, task projection", [
          { path: "src/github/policy_gate.ts", kind: "update" },
          { path: "src/github/reconciler.ts", kind: "add" },
          { path: "src/task/projection.ts", kind: "update" },
        ]),
        cx.exec("09:39:12", "gh pr create --title 'Attach execution workspace' --base main"),
        cx.out("09:39:15", "PR #318 created · vib-142-attach-workspace → main"),
        cx.msg("09:40:58", "Completion report drafted with validation evidence — handing back to the operator."),
        cx.done("09:41:02", "turn 9 · in 128k (cached 96k) · out 6.2k tokens · 92m", { input_tokens: 128034, cached_input_tokens: 96410, output_tokens: 6188 }),
      ],
    },
    {
      id: "c0",
      kind: "reviewer",
      role: "Reviewer",
      backend: "claude",
      sdk: CLAUDE_SDK,
      model: "claude-sonnet-4-5",
      sid: "a91f7c2e-8b4d-4e0a-b6c1-3d5f9e214298",
      state: "done",
      finished: "9:20",
      lines: [
        cc.init("08:30:02", "session a91f7c2e resumed · claude-sonnet-4-5 · re-anchored on task.md"),
        cc.tool("08:31:10", "Bash", "gh pr diff 318 --stat"),
        cc.out("08:31:14", "9 files changed, 412 insertions(+), 87 deletions(-)"),
        cc.tool("09:18:40", "Bash", "npm run snapshot:verify"),
        cc.err("09:19:02", "task_projection.json changed — compact shape not confirmed"),
        cc.text("09:20:11", "Raising a quality flag: confirm the new compact shape is intended before review."),
        cc.res("09:20:15", "success · 4 turns · 2m 12s api · $0.31", { dur: 132400, api: 98120, turns: 4, cost: 0.31, in: 812, cached: 38210, out: 2140 }),
      ],
    },
  ],
  "VIB-151": [
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "claude",
      sdk: CLAUDE_SDK,
      model: "claude-sonnet-4-5",
      sid: "51d8f0e2-3a7b-4c1b-9e0a-6f4d2b8c7151",
      state: "running",
      phase: "Running validation sweep",
      step: "Bash · npm test -- --filter=long-fixture",
      startedDisplay: "10:18",
      elapsedSeconds: 402,
      lines: [
        cc.init("10:18:02", "session 51d8f0e2 · claude-sonnet-4-5 · 9 tools · mcp: github, filesystem · cwd /work/viberr"),
        cc.text("10:18:09", "Re-anchoring on the canonical task file before continuing stage work."),
        cc.tool("10:18:11", "Read", ".viberr/tasks/VIB-151/task.md", { file_path: ".viberr/tasks/VIB-151/task.md" }),
        cc.out("10:18:12", "412 lines · anchor ok · last typed event: reviewer re-engaged 9:47"),
        cc.tool("10:18:20", "Grep", "COMPRESS_THRESHOLD src/", { pattern: "COMPRESS_THRESHOLD", path: "src/" }),
        cc.out("10:18:21", "3 matches · timeline/compress.ts:41,88 · config/defaults.ts:12"),
        cc.tool("10:18:44", "Edit", "timeline/compress.ts — always keep typed events above threshold", { file_path: "src/timeline/compress.ts" }),
        cc.out("10:18:45", "ok · +18 −6"),
        cc.tool("10:19:03", "Bash", "npm test -- --filter=compression"),
        cc.out("10:19:31", "40-event fixture: 12 passed · snapshot compaction_map updated"),
        cc.text("10:19:40", "Typed events survive every pass. Running the long-fixture sweep next."),
        cc.tool("10:19:46", "Bash", "npm test -- --filter=long-fixture"),
      ],
      live: [
        cc.out("10:24:12", "400-event fixture: compaction 6.2:1 · continuity anchors kept"),
        cc.text("10:24:20", "Threshold 40 holds. Checking the re-anchor read path against compressed history."),
        cc.tool("10:24:24", "Read", "timeline/reanchor.ts", { file_path: "src/timeline/reanchor.ts" }),
        cc.out("10:24:25", "202 lines"),
        cc.tool("10:24:58", "Edit", "timeline/reanchor.ts — read compressed spans lazily", { file_path: "src/timeline/reanchor.ts" }),
        cc.out("10:24:59", "ok · +9 −2"),
        cc.tool("10:25:07", "Bash", "npm test -- --filter=reanchor"),
        cc.out("10:25:19", "8 passed · 0 failed (4.1s)"),
        cc.text("10:25:26", "Green. Committing the compaction map and lazy reads."),
        cc.tool("10:25:31", "Bash", "git commit -m '[VIB-151] compaction map + lazy compressed reads'"),
        cc.out("10:25:33", "2 files changed · +27 −8 · vib-151-timeline-compression"),
      ],
    },
    {
      id: "c0",
      kind: "reviewer",
      role: "Reviewer",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a2c4-7b31-7802-9f4e-51cb22ee8f21",
      state: "running",
      phase: "Advisory pass on threshold defaults",
      step: "exec · rg 'compression-threshold' .viberr/policy/",
      startedDisplay: "10:29",
      elapsedSeconds: 74,
      lines: [
        cx.start("10:29:41", "thread 0199a2c4-7b31… resumed · gpt-5.4-codex"),
        cx.turn("10:29:42", "turn 3"),
        cx.think("10:29:48", "Compare threshold defaults against long-task readability before advising."),
        cx.exec("10:29:55", "git diff main...vib-151-timeline-compression --stat"),
        cx.out("10:29:57", "7 files changed · +214 −41"),
      ],
      live: [
        cx.exec("10:30:14", "rg 'compression-threshold' .viberr/policy/"),
        cx.out("10:30:15", "guardrails.yml:12 · value: 40 · typed events always kept"),
        cx.think("10:30:24", "Policy already owns the value — the constant in defaults.ts should defer to it."),
        cx.msg("10:30:33", "Recommend reading the threshold from project guardrails with 40 as fallback. Posting advisory to the task timeline."),
        cx.done("10:30:36", "turn 3 · in 51.2k (cached 38.9k) · out 1.9k tokens", { input_tokens: 51234, cached_input_tokens: 38912, output_tokens: 1954 }),
        cx.turn("10:30:41", "turn 4"),
        cx.exec("10:30:49", "rg 'COMPRESS_THRESHOLD' src/config/"),
        cx.out("10:30:50", "defaults.ts:12 · fallback candidate confirmed"),
      ],
    },
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "b7e2c9a4-1151-4f8d-a0b3-5c6d7e8f9151",
      state: "idle",
      phase: "Supervising — next boundary: Review",
      lines: [
        cc.init("09:47:00", "session b7e2c9a4 · operator runtime · anchored .viberr/tasks/VIB-151/task.md"),
        cc.text("09:47:05", "Re-engaged the Codex reviewer for a second opinion on threshold defaults."),
        cc.text("10:18:00", "Primary specialist resumed for the validation sweep. Watching for the review boundary."),
      ],
    },
  ],
  "VIB-153": [
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a0b8-53c9-7f10-a2d4-8e7b3c150953",
      state: "running",
      phase: "Implementing brevity guardrail",
      step: "exec · npm test -- --filter=brevity",
      startedDisplay: "8:58",
      elapsedSeconds: 5462,
      lines: [
        cx.start("08:58:31", "thread 0199a0b8-53c9… started · gpt-5.4-codex"),
        cx.turn("08:58:32", "turn 1"),
        cx.think("08:58:40", "Draft a linter that enforces the packet length budget with a bounce-back diff."),
        cx.exec("08:59:02", "rg 'packet' src/operator/ --files-with-matches"),
        cx.out("08:59:03", "4 files · authoring.ts, budget.ts, packet.ts, verbosity.ts"),
        cx.diff("09:58:12", "src/operator/brevity.ts (+64) · budget wired to observed → changed → recommended → decision", [
          { path: "src/operator/brevity.ts", kind: "add" },
        ]),
        cx.msg("10:02:19", "Linter drafted — over-budget packets bounce back with a diff of what to cut."),
      ],
      live: [
        cx.turn("10:26:02", "turn 6"),
        cx.exec("10:26:11", "npm test -- --filter=brevity"),
        cx.out("10:26:29", "6 passed · 0 failed (3.2s)"),
        cx.think("10:26:40", "Wire the reject path into packet authoring so violations never reach the timeline."),
        cx.exec("10:27:04", "git commit -m '[VIB-153] brevity linter + bounce-back diff'"),
        cx.out("10:27:06", "2 files changed · +71 −3 · vib-153-operator-brevity"),
        cx.msg("10:27:18", "Reject path wired. Starting duplicate-summary detection next."),
      ],
    },
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "c8f3d0b5-2153-4a9e-b1c4-6d7e8f0a1153",
      state: "idle",
      phase: "Supervising — validation healthy",
      lines: [
        cc.init("08:58:12", "session c8f3d0b5 · operator runtime · anchored .viberr/tasks/VIB-153/task.md"),
        cc.text("08:58:20", "Assigned Codex as primary specialist — branch vib-153-operator-brevity created."),
      ],
    },
  ],
  "VIB-160": [
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "claude",
      sdk: CLAUDE_SDK,
      model: "claude-sonnet-4-5",
      sid: "d9a4e1c6-3160-4b0f-92d5-7e8f9a0b2160",
      state: "error",
      finished: "10:31",
      lines: [
        cc.init("10:04:41", "resume claude-dev-160 — provider session lookup"),
        cc.err("10:04:44", "provider session 404 · runtime history unavailable"),
        cc.init("10:05:02", "rehydrated from .viberr/tasks/VIB-160/task.md · continuity warning recorded"),
        cc.text("10:05:20", "Continuing from canonical state — earlier direction may be stale, verifying."),
        cc.tool("10:09:33", "Bash", "npm test -- --filter=rehydrate"),
        cc.err("10:10:04", "2 failed · evidence refs dropped before the continuity break"),
        cc.res("10:31:00", "halted · operator raised a blocked decision packet", { subtype: "error_during_execution", dur: 1579000, api: 402000, turns: 5, cost: 0.87, in: 1424, cached: 51200, out: 3810 }),
      ],
    },
    {
      id: "c0",
      kind: "reviewer",
      role: "Reviewer",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a29d-60aa-7433-b1c8-4d92e07f6a60",
      state: "done",
      finished: "10:18",
      lines: [
        cx.start("10:12:20", "thread 0199a29d-60aa… resumed · gpt-5.4-codex"),
        cx.exec("10:15:40", "git log --oneline vib-160-rehydrate ^main"),
        cx.out("10:15:41", "2 commits · recovery shim, continuity marker"),
        cx.msg("10:18:09", "Quality flag: the rehydrate path drops evidence references recorded before the break."),
        cx.done("10:18:12", "turn 2 · in 22.4k (cached 18.2k) · out 0.8k tokens", { input_tokens: 22391, cached_input_tokens: 18240, output_tokens: 812 }),
      ],
    },
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "e0b5f2d7-4160-4c1a-83e6-8f9a0b1c3160",
      state: "idle",
      phase: "Blocked — waiting on human decision",
      lines: [
        cc.init("10:05:00", "session e0b5f2d7 · operator runtime · anchored .viberr/tasks/VIB-160/task.md"),
        cc.text("10:05:08", "Continuity warning recorded — specialist re-anchored on the canonical file."),
        cc.text("10:31:02", "Blocked decision packet raised — waiting on a human recovery path."),
      ],
    },
  ],
  "VIB-145": [
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a145-9e77-7b05-8c3a-6f2d81b4e145",
      state: "running",
      phase: "Standing by on review thread",
      step: "exec · rg 'revalidate' src/board/ -n",
      startedDisplay: "9:14",
      elapsedSeconds: 4820,
      lines: [
        cx.start("09:14:02", "thread 0199a145-9e77… resumed · gpt-5.4-codex"),
        cx.turn("09:14:03", "turn 11"),
        cx.exec("09:14:30", "npm run e2e -- --browsers=chromium,firefox,webkit"),
        cx.out("09:16:22", "3/3 browser targets green · fan-out latency p95 3.8s"),
        cx.msg("09:17:04", "Review build green. Holding the thread open for reviewer questions."),
      ],
      live: [
        cx.turn("10:32:40", "turn 12"),
        cx.exec("10:32:51", "rg 'revalidate' src/board/ -n"),
        cx.out("10:32:52", "6 matches · sse.ts, cache.ts"),
        cx.msg("10:33:20", "Prefetching answers for the review thread — no new commits planned."),
      ],
    },
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "f1c6a3e8-5145-4d2b-94f7-9a0b1c2d4145",
      state: "idle",
      phase: "Transition request pending approval",
      lines: [
        cc.init("09:10:44", "session f1c6a3e8 · operator runtime · anchored .viberr/tasks/VIB-145/task.md"),
        cc.text("09:12:10", "Transition request raised: In Progress → Review — SSE fan-out demo recorded."),
      ],
    },
  ],
  "VIB-148": [
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "a2d7e4f1-0148-4b3c-85a9-1c2d3e4f5148",
      state: "idle",
      phase: "Waiting on a human owner",
      lines: [
        cc.init("08:24:30", "session a2d7e4f1 · operator runtime · anchored .viberr/tasks/VIB-148/task.md"),
        cc.tool("08:35:52", "Read", ".viberr/tasks/VIB-148/task.md", { file_path: ".viberr/tasks/VIB-148/task.md" }),
        cc.out("08:35:53", "96 lines · goal + scope present · no owner on the acceptance boundary"),
        cc.text("08:36:04", "Quality gate passed: goal and scope are executable."),
        cc.text("08:36:10", "Waiting on a human owner for the acceptance boundary before scheduling execution."),
      ],
    },
  ],
  "VIB-139": [
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "b3c8f5a2-0139-4c4d-96b0-2d3e4f5a6139",
      state: "done",
      finished: "Mar 30 · 17:26",
      lines: [
        cc.init("16:58:00", "session b3c8f5a2 · operator runtime · anchored .viberr/tasks/VIB-139/task.md"),
        cc.text("17:10:12", "Transition request raised: Review → Done — both policy surfaces validated."),
        cc.text("17:26:31", "Human acceptance recorded by Elif — PR #298 merged. Closing operator session."),
        cc.res("17:26:40", "success · 9 turns · session closed on completion", { dur: 2412000, api: 186000, turns: 9, cost: 0.42, in: 1120, cached: 42800, out: 2960 }),
      ],
    },
  ],
  "VIB-141": [
    {
      id: "primary",
      kind: "primary",
      role: "Primary specialist",
      backend: "codex",
      sdk: CODEX_SDK,
      model: "gpt-5.4-codex",
      sid: "0199a141-77e2-7c08-b5d6-9a0b1c2d3141",
      state: "done",
      finished: "Mar 30 · 14:52",
      lines: [
        cx.start("13:40:11", "thread 0199a141-77e2… started · gpt-5.4-codex"),
        cx.turn("13:40:12", "turn 7"),
        cx.exec("14:31:20", "npm test -- --filter=typed-events"),
        cx.out("14:31:44", "21 passed · 0 failed (6.8s)"),
        cx.diff("14:40:02", "src/events/schema.ts (+120) · src/events/types.ts · five typed events as first-class records", [
          { path: "src/events/schema.ts", kind: "add" },
          { path: "src/events/types.ts", kind: "update" },
        ]),
        cx.msg("14:51:38", "Typed important-event schema complete — payloads carry actor identity and task references."),
        cx.done("14:52:01", "turn 7 · in 74.2k (cached 60.1k) · out 3.4k tokens", { input_tokens: 74212, cached_input_tokens: 60110, output_tokens: 3421 }),
      ],
    },
    {
      id: "c0",
      kind: "reviewer",
      role: "Reviewer",
      backend: "claude",
      sdk: CLAUDE_SDK,
      model: "claude-sonnet-4-5",
      sid: "d5e0b7c4-1141-4e6f-b8d2-4f5a6b7c8141",
      state: "done",
      finished: "Mar 30 · 14:31",
      lines: [
        cc.init("14:12:08", "session d5e0b7c4 resumed · claude-sonnet-4-5 · re-anchored on task.md"),
        cc.tool("14:20:15", "Bash", "npm run schema:lint"),
        cc.out("14:20:19", "clean · 0 warnings"),
        cc.text("14:31:02", "Quality flag resolved — typed payloads carry actor identity and task references."),
        cc.res("14:31:10", "success · 3 turns · 1m 41s api · $0.19", { dur: 98400, api: 101000, turns: 3, cost: 0.19, in: 640, cached: 26100, out: 1480 }),
      ],
    },
    {
      id: "op",
      kind: "operator",
      role: "Operator",
      backend: "claude",
      sdk: OP_SDK,
      model: "claude-sonnet-4-5",
      sid: "c4d9a6b3-0141-4d5e-a7c1-3e4f5a6b7141",
      state: "done",
      finished: "Mar 30 · 15:02",
      lines: [
        cc.init("13:38:50", "session c4d9a6b3 · operator runtime · anchored .viberr/tasks/VIB-141/task.md"),
        cc.text("13:40:05", "Assigned Codex as primary specialist — branch vib-141-typed-events created."),
        cc.text("15:02:12", "Completion accepted — Murat merged PR #287. Closing operator session."),
        cc.res("15:02:20", "success · 8 turns · session closed on completion", { dur: 5010000, api: 154000, turns: 8, cost: 0.36, in: 980, cached: 38400, out: 2410 }),
      ],
    },
  ],
};
