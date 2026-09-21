import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CapabilityMode } from "~/schemas/project-file.schema";
import type { OperatorAuthority } from "~/server/tasks/operator-actions.server";
import {
  buildSpecialistPromptPrefix,
  type SpecialistPersonaInput,
} from "~/server/tasks/specialist-run.server";
import {
  buildOperatorSystemPrompt,
  type OperatorMcpResolution,
  type OperatorWorkspaceView,
} from "./operator-run.server";
import { joinedPrompt } from "./prompt-prefix.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

/**
 * Ruling 370: a profile's STATIC block is byte-identical across the tasks it
 * runs on, whatever order its grants were stored in, and nothing in it names a
 * task, a run or a path. The dynamic tail differs only where the task differs.
 * Two builders, the same two proofs each; the controller's is in
 * `controller-run.server.test.ts`, beside its app harness.
 */

/** A data root with two knowledge bases, so the static block has real bodies. */
function dataRootWithKbs(): string {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-prefix-"));
  for (const [kb, doc] of [
    ["house-style", "# Style\n\nKB-STYLE-MARKER"],
    ["architecture", "# Architecture\n\nKB-ARCH-MARKER"],
  ]) {
    const dir = path.join(dataRoot, "kb", kb!);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "overview.md"), doc!, "utf8");
  }
  return dataRoot;
}

const TASK_A = "/data/projects/acme/tasks/ACME-1/attachments";
const TASK_B = "/data/projects/acme/tasks/ACME-2/attachments";

describe("ruling 370: the specialist prefix", () => {
  const base = (dataRoot: string, task: string): SpecialistPersonaInput => ({
    profileId: "dev",
    backend: "claude",
    definition: "You are the Developer.",
    skills: ["zeta-skill", "alpha-skill"],
    nativeSkills: ["zeta-skill", "alpha-skill"],
    kb: ["house-style", "architecture"],
    mcps: ["zulu", "alpha"],
    unhealthyMcps: ["zulu"],
    unresolvedMcps: [{ name: "omega", reason: "not registered" }],
    mcpWriteToolsDenied: [{ server: "alpha", tools: ["write_b", "write_a"] }],
    browser: { attachmentsDir: task },
    attachmentsDrop: { attachmentsDir: task },
    githubRead: { repo: "acme/app" },
    dataRoot,
  });

  it("two tasks of one profile share a byte-identical static block, and the tail differs only by the task", () => {
    const dataRoot = dataRootWithKbs();
    const a = buildSpecialistPromptPrefix(base(dataRoot, TASK_A));
    const b = buildSpecialistPromptPrefix(base(dataRoot, TASK_B));
    expect(a.static.join("")).toBe(b.static.join(""));
    expect(a.dynamic.join("")).not.toBe(b.dynamic.join(""));
    expect(a.dynamic.join("").replaceAll("ACME-1", "ACME-2")).toBe(b.dynamic.join(""));
    // Nothing per-task in the static block: no path, no task key.
    const statics = a.static.join("");
    expect(statics).not.toContain("/data/projects");
    expect(statics).not.toContain("ACME-1");
    // Ruling 283: the index names the document and its headings, not its text.
    expect(statics).toContain("house-style (knowledge base)");
    expect(statics).toContain("# Style");
    expect(statics).not.toContain("KB-STYLE-MARKER");
    expect(statics).toContain("You are the Developer.");
    // The per-run notices are the tail.
    const tail = a.dynamic.join("");
    expect(tail).toContain("MCP servers that may be unavailable");
    expect(tail).toContain("Unavailable MCP servers");
    expect(tail).toContain(TASK_A);
  });

  it("shuffled grants render the same bytes, and every list reads sorted", () => {
    const dataRoot = dataRootWithKbs();
    const ordered = buildSpecialistPromptPrefix({
      ...base(dataRoot, TASK_A),
      skills: ["alpha-skill", "zeta-skill"],
      nativeSkills: ["alpha-skill", "zeta-skill"],
      kb: ["architecture", "house-style"],
      mcps: ["alpha", "zulu"],
      mcpWriteToolsDenied: [{ server: "alpha", tools: ["write_a", "write_b"] }],
    });
    const shuffled = buildSpecialistPromptPrefix(base(dataRoot, TASK_A));
    expect(joinedPrompt(ordered)).toBe(joinedPrompt(shuffled));
    const text = joinedPrompt(shuffled);
    expect(text).toContain("attached them to this run for you: alpha-skill, zeta-skill");
    expect(text.indexOf("architecture (knowledge base)")).toBeLessThan(text.indexOf("house-style (knowledge base)"));
    expect(text).toContain("write_a, write_b (on alpha)");
  });
});

describe("ruling 370: the operator prefix", () => {
  function authority(overrides: Partial<OperatorAuthority> = {}): OperatorAuthority {
    const policy = new Map<string, CapabilityMode>([
      ["transition-to-done", "human"],
      ["accept-completion", "recommend"],
    ]);
    return {
      policy,
      autonomy: "supervised",
      backend: "claude",
      model: "sonnet",
      effort: "",
      name: "Operator",
      skills: [],
      kb: ["house-style", "architecture"],
      mcps: [],
      persona: null,
      deployed: true,
      humanGatedBeforeWork: false,
      ...overrides,
    };
  }
  const mcp: OperatorMcpResolution = {
    servers: {},
    mounted: ["zulu", "alpha"],
    unresolved: [{ name: "omega", reason: "not registered" }],
    unhealthy: ["zulu"],
    toolDenials: [{ server: "alpha", tools: ["write_b", "write_a"] }],
  };
  const checkout = (key: string): OperatorWorkspaceView => ({
    kind: "checkout",
    repo: "acme/app",
    dir: `/data/projects/acme/tasks/${key}/workspace/app`,
    relativeDir: "workspace/app",
    defaultBranch: "main",
  });

  it("two tasks share the static block; the workspace and the MCP notices are the tail", () => {
    const dataRoot = dataRootWithKbs();
    const a = buildOperatorSystemPrompt(authority(), dataRoot, mcp, checkout("ACME-1"), true, ["get_task"]);
    const b = buildOperatorSystemPrompt(authority(), dataRoot, mcp, checkout("ACME-2"), true, ["get_task"]);
    expect(a.prefix.static.join("")).toBe(b.prefix.static.join(""));
    expect(a.prefix.dynamic.join("")).not.toBe(b.prefix.dynamic.join(""));
    const statics = a.prefix.static.join("");
    expect(statics).not.toContain("# Your workspace");
    expect(statics).not.toContain("/data/projects");
    expect(statics).toContain("# Non-negotiable rules");
    expect(statics).toContain("# Live authority");
    const tail = a.prefix.dynamic.join("");
    expect(tail).toContain("# Your workspace");
    expect(tail).toContain("MCP tools are governed too");
    expect(tail).toContain("MCP write tools withheld");
    expect(tail).toContain("MCP servers that may be unavailable");
    expect(tail).toContain("Unavailable MCP servers");
    // The joined document is the same text in the same order (Codex).
    expect(a.prompt).toBe(joinedPrompt(a.prefix));
    expect(a.prompt.indexOf("# Non-negotiable rules")).toBeLessThan(a.prompt.indexOf("# Your workspace"));
  });

  it("shuffled grants and policy rows render the same bytes", () => {
    const dataRoot = dataRootWithKbs();
    const reversedPolicy = new Map<string, CapabilityMode>([
      ["accept-completion", "recommend"],
      ["transition-to-done", "human"],
    ]);
    const a = buildOperatorSystemPrompt(authority(), dataRoot, mcp, { kind: "none" }, false, ["get_task"]);
    const b = buildOperatorSystemPrompt(
      authority({ kb: ["architecture", "house-style"], policy: reversedPolicy }),
      dataRoot,
      { ...mcp, mounted: ["alpha", "zulu"], toolDenials: [{ server: "alpha", tools: ["write_a", "write_b"] }] },
      { kind: "none" },
      false,
      ["get_task"],
    );
    expect(a.prompt).toBe(b.prompt);
    expect(a.prompt).toContain("- accept-completion: recommend\n- transition-to-done: human");
    expect(a.prompt).toContain("Attached MCP servers: alpha, zulu.");
    // The disclosure lists the same sorted names.
    expect(a.inputs.knowledge).toEqual(["architecture", "house-style"]);
    expect(a.inputs.mcp.mounted).toEqual(["alpha", "zulu"]);
  });
});
