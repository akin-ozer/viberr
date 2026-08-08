import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { saveMcpServer } from "~/server/org/resources.server";
import { buildOperatorToolkit } from "./operator-toolkit.server";
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
 * N19-9 — nothing in the product could bring a task branch up to date with its
 * base. The owner ruled it operator-decided, in the R15-2 shape: a capability
 * gates the tool, the server does the git, a conflict goes to a human.
 */
describe("buildOperatorToolkit — update_branch_from_base (N19-9)", () => {
  const build = (auth: OperatorAuthority) =>
    buildOperatorToolkit({
      db: ctxDb.makeDb(),
      ctx: { dataRoot: ctxDb.makeTempDir() },
      projectSlug: "p",
      taskKey: "P-1",
      authority: auth,
    });

  it("builds the tool with the grant ABSENT (it postdates every deployment; it follows the delivery gate)", () => {
    expect(build(authority([])).allowedTools).toContain(
      "mcp__viberr__update_branch_from_base",
    );
  });

  it("withholds the tool when update-task-branch is explicitly off", () => {
    const auth = authority([]);
    auth.policy.set("update-task-branch", "off");
    expect(build(auth).allowedTools).not.toContain(
      "mcp__viberr__update_branch_from_base",
    );
  });

  it("withholds it when DELIVERY is withheld — it is the smaller act on the same branch", () => {
    const auth = authority([]);
    auth.policy.set("deliver-review-pr", "off");
    expect(build(auth).allowedTools).not.toContain(
      "mcp__viberr__update_branch_from_base",
    );
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
    // R19-4: the read-only repository view is part of the READ-ONLY floor — an
    // operator with no deployment may still look at the repo it is asked to
    // reason about. What "read-only" excludes is every WRITE, and that is what
    // this asserts: the floor is exactly the three reads, and nothing that
    // changes state is reachable.
    expect(toolkit.allowedTools).toEqual([
      "mcp__viberr__get_task",
      "mcp__viberr__list_repo_files",
      "mcp__viberr__read_repo_file",
    ]);
    for (const write of [
      "mcp__viberr__deliver_for_review",
      "mcp__viberr__transition_stage",
      "mcp__viberr__open_decision_packet",
      "mcp__viberr__prompt_agent",
      "mcp__viberr__post_comment",
    ]) {
      expect(toolkit.allowedTools).not.toContain(write);
    }
  });
});
