import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { saveMcpServer } from "~/server/org/resources.server";
import {
  buildOperatorToolkit,
  OPERATOR_TOOLKIT_INSTRUCTIONS,
} from "./operator-toolkit.server";
import type { OperatorAuthority } from "./operator-actions.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctxDb = createTestDbContext();
afterEach(() => ctxDb.cleanup());

const ACTOR = { userId: "u_t", label: "t@test" };

function authority(mcps: string[]): OperatorAuthority {
  return {
    policy: new Map([
      ["assign-primary-specialist", "direct"],
      ["summon-reviewers", "direct"],
      ["generate-packets", "direct"],
      ["append-typed-events", "direct"],
      ["stage-transitions", "recommend"],
      ["completion-for-acceptance", "recommend"],
    ]),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb: [],
    mcps,
    persona: null,
    deployed: true,
    humanGatedBeforeWork: false,
  };
}

/**
 * P13-KM-03 — the operator's DECLARED org MCP servers now actually mount.
 * Live evidence for the bug: a project granted the operator `everything-mcp`
 * and the operator reported "MCP servers/tools I can call: none … No
 * `everything-mcp` tools are registered for me", while the grant UI showed it
 * attached. `OperatorAuthority` carried skills + kb only.
 */
describe("buildOperatorToolkit — org MCP grants", () => {
  const build = (db: ReturnType<typeof ctxDb.makeDb>, mcps: string[]) =>
    buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority(mcps),
    });

  it("mounts a granted org MCP server alongside the in-process viberr toolkit", async () => {
    const db = ctxDb.makeDb();
    await saveMcpServer(
      db,
      { name: "everything-mcp", transport: "stdio", target: "/bin/echo hi", cred: "" },
      ACTOR,
      { spawnImpl: () => { throw new Error("no spawn in test"); } },
    );

    const toolkit = build(db, ["everything-mcp"]);
    expect(Object.keys(toolkit.mcpServers).sort()).toEqual([
      "everything-mcp",
      "viberr",
    ]);
    // `allowedTools` CONFINES an operator run, so mounting without allowing
    // would leave the grant decorative in a different way.
    expect(toolkit.allowedTools).toContain("mcp__everything-mcp");
    expect(toolkit.allowedTools).toContain("mcp__viberr__get_task");
  });

  it("mounts nothing extra when the operator declares no MCP servers", () => {
    const db = ctxDb.makeDb();
    const toolkit = build(db, []);
    expect(Object.keys(toolkit.mcpServers)).toEqual(["viberr"]);
  });

  it("never lets a declared name shadow the reserved in-process viberr server", async () => {
    const db = ctxDb.makeDb();
    const toolkit = build(db, ["viberr"]);
    expect(Object.keys(toolkit.mcpServers)).toEqual(["viberr"]);
    // The reserved name resolves to the in-process governance server, not to a
    // row a user could add under the same name.
    expect(toolkit.allowedTools).toContain("mcp__viberr__get_task");
    expect(toolkit.allowedTools).not.toContain("mcp__viberr");
  });
});

describe("buildOperatorToolkit — deliver_for_review (R15-2)", () => {
  it("builds the tool with the grant ABSENT (absent = granted — pre-R15-2 deployments keep delivering)", () => {
    // Fails on main: the tool did not exist.
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    expect(toolkit.allowedTools).toContain("mcp__viberr__deliver_for_review");
  });

  it("withholds the tool when deliver-review-pr is explicitly off", () => {
    const db = ctxDb.makeDb();
    const auth = authority([]);
    auth.policy.set("deliver-review-pr", "off");
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });
    expect(toolkit.allowedTools).not.toContain("mcp__viberr__deliver_for_review");
  });
});

/**
 * A4 — with NO operator deployed, `resolveOperatorAuthority` returns an empty
 * policy and `deployed: false`. Every gate then denies, so the toolkit is
 * read-only. The bug: `deliverGate`'s absent-means-granted polarity fired for
 * the empty policy too, so this authority built `get_task` +
 * `deliver_for_review` — a run that could push a branch and open a PR with no
 * operator configured anywhere in the project.
 */
describe("buildOperatorToolkit — no operator deployed (A4)", () => {
  const undeployed = (): OperatorAuthority => ({
    ...authority([]),
    policy: new Map(),
    deployed: false,
    // A non-strict board: the shape whose absent grant resolved to `direct`.
    humanGatedBeforeWork: false,
  });

  it("builds a READ-ONLY toolkit — no delivery, no packets, no transitions", () => {
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: undeployed(),
    });
    expect(toolkit.allowedTools).toEqual(["mcp__viberr__get_task"]);
    expect(toolkit.allowedTools).not.toContain("mcp__viberr__deliver_for_review");
  });
});

/**
 * R19-1 — the toolkit's own instructions block is a SECOND channel into the
 * same model, and it used to contradict the first.
 *
 * The operator now runs with a read-only checkout of the project repository
 * under its cwd and a system prompt requiring every packet that reasons about
 * repository contents to be grounded in it. The instructions still said "never
 * write code or touch the repository" — written when the operator had no
 * working tree at all. A model told to read the repo by one channel and never
 * to touch it by another can resolve that either way, and the way that loses is
 * exactly F19-4: describing the empty task folder as "the repo".
 */
describe("OPERATOR_TOOLKIT_INSTRUCTIONS — reading is expected, writing is not (R19-1)", () => {
  it("states the write prohibition precisely and stops forbidding reads", () => {
    // Canary: restore the "never write code or touch the repository" sentence
    // and every half fails.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toContain("never write code");
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(/cannot edit, create or commit files/);
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toContain("READING the task's repository checkout");
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).not.toMatch(/touch the repository/);
    // The claim-grounding rule the packets depend on, restated where the tools
    // that WRITE those packets are described.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(
      /claim you make about the repository must come from reading it/,
    );
  });

  it("does NOT claim the operator cannot push — delivery is its decision (R15-2)", () => {
    // The over-correction that would break the product: `deliver_for_review`
    // pushes the deliverer's committed branch, and both the operator definition
    // and the tool description tell the model delivery is its call. A blanket
    // "you cannot push the repository" here is a third channel contradicting
    // them, and the careful resolution is an operator that stops delivering.
    // Canary: put "or push the repository" back into the constant and this
    // fails.
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).not.toMatch(/or push the repository/);
    expect(OPERATOR_TOOLKIT_INSTRUCTIONS).toMatch(
      /delivery is a decision you make and the server executes/,
    );
  });

  it("is the string the viberr MCP server actually carries", () => {
    // Pins the WIRING, not just the constant: a run reads the server's
    // instructions, not this module's exports. (Reaches into the SDK server's
    // private field — if the SDK moves it, this fails loudly rather than
    // passing while the operator reads something else.)
    const db = ctxDb.makeDb();
    const toolkit = buildOperatorToolkit({
      db,
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: authority([]),
    });
    const wired = (
      toolkit.mcpServers.viberr as unknown as {
        instance: { server: { _instructions?: string } };
      }
    ).instance.server._instructions;
    expect(wired).toBe(OPERATOR_TOOLKIT_INSTRUCTIONS);
  });
});
