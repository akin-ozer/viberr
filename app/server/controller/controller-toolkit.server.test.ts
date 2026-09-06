import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { readFileSync } from "node:fs";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { JsonValue } from "~/features/runtime/runtime-types";

/**
 * Ruling 99 — the controller's permission matrix, driven arm by arm.
 *
 * The contract under test: the controller holds NO authority of its own.
 * Every tool call runs under the ASKING USER's live permissions — org role for
 * instance tools, the project RBAC matrix for board tools — and a lower tier
 * is REFUSED (out loud, with the reason) exactly where a higher tier is
 * granted. The always-human decisions have no tool at all, nothing deletes,
 * and the members-only 404 posture holds (a non-member cannot learn that a
 * project exists).
 *
 * Fixture roles on viberr-core (demo seed): elif = project admin (org member),
 * arda = project admin + ORG admin, murat = maintainer, selin = contributor,
 * deniz = org member and a member of NOTHING. A viewer and an org-admin
 * non-member are added in setup.
 */

let app: AppTestContext;
const SLUG = "viberr-core";

interface Actors {
  orgAdmin: string; // arda — org admin + project admin
  projectAdmin: string; // elif
  maintainer: string; // murat
  contributor: string; // selin
  nonMember: string; // deniz
  viewer: string; // added in setup
  orgAdminOutsider: string; // org admin, member of nothing
}
let ids: Actors;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedDefaultAgentAssets } = await import(
    "~/server/seed/default-assets.server"
  );
  seedDefaultAgentAssets(app.dataRoot);
  const { findUserByEmail, insertUser } = await import(
    "~/server/auth/user-store.server"
  );
  const viewer = insertUser(app.db, {
    id: "u_ctl_viewer",
    email: "viewer@viberr.test",
    name: "View Only",
    role: "member",
  });
  const outsider = insertUser(app.db, {
    id: "u_ctl_orgadmin",
    email: "org-admin-outsider@viberr.test",
    name: "Org Admin Outsider",
    role: "admin",
  });
  const { updateProjectFile } = await import(
    "~/server/files/project-writer.server"
  );
  await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
    p.frontmatter.members.push({ userId: viewer.id, role: "viewer" });
  });
  const { rebuildProject } = await import("~/server/projections/rebuilder.server");
  rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
  ids = {
    orgAdmin: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    projectAdmin: findUserByEmail(app.db, "elif@viberr.dev")!.id,
    maintainer: findUserByEmail(app.db, "murat@viberr.dev")!.id,
    contributor: findUserByEmail(app.db, "selin@viberr.dev")!.id,
    nonMember: findUserByEmail(app.db, "deniz@viberr.dev")!.id,
    viewer: viewer.id,
    orgAdminOutsider: outsider.id,
  };
});
afterAll(() => app.cleanup());

/** Build the toolkit AS one user and call one tool; returns the text reply. */
async function call(
  userId: string,
  toolName: string,
  args: Record<string, JsonValue> = {},
  projectSlug: string | null = SLUG,
): Promise<string> {
  const { buildControllerToolkit } = await import("./controller-toolkit.server");
  const { findUserById } = await import("~/server/auth/user-store.server");
  const user = findUserById(app.db, userId)!;
  const toolkit = buildControllerToolkit({
    db: app.db,
    ctx: { dataRoot: app.dataRoot },
    user: { id: user.id, email: user.email, name: user.name },
    projectSlug,
  });
  const tool = toolkit.tools.find((t) => t.name === toolName);
  expect(tool, `tool ${toolName} must exist`).toBeTruthy();
  // SAFETY: every toolkit handler is wrapped by `run`, which always returns
  // the `textResult` shape: { content: [{ type: "text", text }] }.
  const result = (await tool!.handler(args, {})) as {
    content: { text: string }[];
  };
  return result.content[0]!.text;
}

// ------------------------------------------------------------ tool surface

describe("the tool surface itself encodes the invariants", () => {
  it("has NO tool for the always-human decisions and NO delete anywhere", async () => {
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
      projectSlug: SLUG,
    });
    const names = toolkit.tools.map((t) => t.name);
    for (const banned of [
      "merge",
      "accept",
      "force",
      "resolve_packet",
      "delete",
    ]) {
      expect(
        names.filter((n) => n.includes(banned)),
        `no tool may carry "${banned}"`,
      ).toEqual([]);
    }
    // The whole surface is enumerated so a new tool is a deliberate decision.
    expect(names.length).toBeGreaterThanOrEqual(25);
  });
});

// -------------------------------------------------------- instance scope

describe("instance scope: org-role gate on every management tool", () => {
  const adminOnly: { tool: string; args?: Record<string, JsonValue> }[] = [
    { tool: "list_users" },
    { tool: "list_knowledge_bases" },
    { tool: "list_skills" },
    { tool: "list_mcp_servers" },
    { tool: "list_global_agents" },
    { tool: "inspect_audit_log" },
    { tool: "inspect_run_analytics" },
    {
      tool: "create_user",
      args: { name: "X", email: "x@viberr.test", role: "member" },
    },
    { tool: "update_user", args: { userId: "whoever" } },
    { tool: "set_user_org_role", args: { userId: "whoever", role: "member" } },
    { tool: "save_knowledge_base", args: { name: "denied-probe" } },
    {
      tool: "save_skill",
      args: { name: "denied-probe", summary: "denied probe" },
    },
    {
      tool: "save_mcp_server",
      args: { name: "denied-probe", transport: "HTTP", target: "https://x.test" },
    },
    { tool: "test_mcp_server", args: { id: "whatever" } },
    {
      tool: "save_global_agent",
      args: {
        name: "Denied Probe",
        backend: "claude",
        summary: "denied probe",
        stages: ["impl"],
      },
    },
  ];

  for (const probe of adminOnly) {
    it(`${probe.tool}: an org MEMBER is refused with the reason; an org ADMIN passes the gate`, async () => {
      const denied = await call(ids.contributor, probe.tool, probe.args ?? {});
      expect(denied).toContain("[denied]");
      expect(denied).toContain("org admin");
      const granted = await call(ids.orgAdmin, probe.tool, probe.args ?? {});
      // The admin may still hit a VALIDATION on probe args ("No such user") —
      // what must never appear is the org-role refusal.
      expect(granted).not.toContain("Only org admins");
    });
  }

  it("a refused instance attempt leaves an audit row (P13-D-8 parity)", async () => {
    await call(ids.viewer, "list_users");
    const rows = listAuditEvents(app.db, {
      action: "controller.authority.denied",
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.actorUserId === ids.viewer)).toBe(true);
  });

  it("user administration works end to end for an org admin, and the temp password is relayed once", async () => {
    const created = await call(ids.orgAdmin, "create_user", {
      name: "Made By Controller",
      email: "made-by-controller@viberr.test",
      role: "member",
    });
    expect(created).toContain("[done]");
    expect(created).toContain("Temporary password");
    const listed = await call(ids.orgAdmin, "list_users");
    expect(listed).toContain("made-by-controller@viberr.test");
    const { findUserByEmail } = await import("~/server/auth/user-store.server");
    const madeId = findUserByEmail(app.db, "made-by-controller@viberr.test")!.id;
    const promoted = await call(ids.orgAdmin, "set_user_org_role", {
      userId: madeId,
      role: "admin",
    });
    expect(promoted).toContain("org admin");
    const disabled = await call(ids.orgAdmin, "update_user", {
      userId: madeId,
      access: "disable",
    });
    expect(disabled).toContain("account disabled");
  });

  it("resource management works for an org admin: KB with a document, skill, MCP without a credential", async () => {
    const kb = await call(ids.orgAdmin, "save_knowledge_base", {
      name: "Controller Made KB",
      doc: { path: "notes.md", content: "# Notes\n\nMade by the controller." },
    });
    expect(kb).toContain("[done]");
    expect(kb).toContain("notes.md");
    const skill = await call(ids.orgAdmin, "save_skill", {
      name: "controller-made-skill",
      summary: "A probe skill the matrix test writes.",
      body: "# Skill\n\nBody.",
    });
    expect(skill).toContain("[done]");
    const mcp = await call(ids.orgAdmin, "save_mcp_server", {
      name: "probe-server",
      transport: "HTTP",
      target: "https://mcp.example.test/v1",
    });
    expect(mcp).toContain("[done]");
    // Secrets never travel through chat — the reply says where they go.
    expect(mcp).toContain("Org settings");
    const agents = await call(ids.orgAdmin, "save_global_agent", {
      name: "Docs Writer Probe",
      backend: "claude",
      summary: "Writes docs. Never touches app code.",
      stages: ["impl"],
    });
    expect(agents).toContain("[done]");
  });

  it("create_project is open to a plain org member (FR5 parity): the gate passed and only the GitHub-connection validation refused", async () => {
    const reply = await call(ids.contributor, "create_project", {
      name: "Member Made",
      key: "MM",
      owner: "nobody",
      repoName: "nothing",
      policy: "balanced",
    });
    // No org-role refusal — the failure is the connection requirement.
    expect(reply).not.toContain("org admin");
    expect(reply).toContain("GitHub");
  });
});

// --------------------------------------------------------- project scope

describe("project scope: the asking user's project role decides, arm by arm", () => {
  it("reads are members-only with the unknown-slug posture: a NON-member gets the same sentence a missing project gets", async () => {
    const nonMember = await call(ids.nonMember, "get_project");
    expect(nonMember).toContain(`No project "${SLUG}" is visible to you`);
    const missing = await call(
      ids.nonMember,
      "get_project",
      { projectSlug: "no-such-project" },
      null,
    );
    expect(missing).toContain('No project "no-such-project" is visible to you');
    // Byte-identical apart from the slug — no existence oracle.
    expect(nonMember.replace(SLUG, "X")).toBe(
      missing.replace("no-such-project", "X"),
    );
  });

  /**
   * The WRITE tools must hold the same posture as the reads. `createTask` and
   * `createGoal` gate themselves on `create-task`, whose refusal names the
   * project and the role — so a non-member probing a slug they should not know
   * exists got a different sentence for a real project than for an invented
   * one. That difference is the existence oracle R15-4 closes.
   */
  it("create_task and create_goal keep the not-visible posture for a non-member", async () => {
    const probes: { tool: string; args: Record<string, JsonValue> }[] = [
      { tool: "create_task", args: { title: "Should not land", goal: "Nor this." } },
      {
        tool: "create_goal",
        args: {
          title: "Should not land",
          links: [{ title: "One", goal: "Nor this." }],
        },
      },
    ];
    for (const { tool, args } of probes) {
      const real = await call(ids.nonMember, tool, args);
      const invented = await call(
        ids.nonMember,
        tool,
        { ...args, projectSlug: "no-such-project" },
        null,
      );
      expect(real).toContain(`No project "${SLUG}" is visible to you`);
      expect(invented).toContain('No project "no-such-project" is visible to you');
      expect(real.replace(SLUG, "X")).toBe(
        invented.replace("no-such-project", "X"),
      );
    }
  });

  it("a VIEWER reads the project, its tasks and one task", async () => {
    const project = await call(ids.viewer, "get_project");
    expect(project).toContain('"slug"');
    const tasks = await call(ids.viewer, "list_tasks");
    expect(tasks).toContain("VIB-142");
    const task = await call(ids.viewer, "get_task", { taskKey: "VIB-142" });
    expect(task).toContain("newestEvents");
  });

  it("an ORG-ADMIN non-member passes reads through the audited override", async () => {
    const reply = await call(ids.orgAdminOutsider, "get_project");
    expect(reply).toContain('"slug"');
    const rows = listAuditEvents(app.db, {
      action: "project.org_admin.override",
    });
    expect(rows.some((r) => r.actorUserId === ids.orgAdminOutsider)).toBe(true);
  });

  it("create_task: a viewer is refused with their role named; a contributor creates", async () => {
    const denied = await call(ids.viewer, "create_task", { title: "Nope" });
    expect(denied).toContain("[denied]");
    expect(denied).toContain("viewer");
    const done = await call(ids.contributor, "create_task", {
      title: "Made by the controller matrix test",
      goal: "Prove the create arm. Done when this task exists.",
    });
    expect(done).toContain("[done]");
    expect(done).toMatch(/VIB-\d+/);
  });

  it("move_task: an off-graph move needs the transition tier (maintainer+), and the terminal stage is refused for EVERYONE with the ceremony pointer", async () => {
    // VIB-142 sits in review; review→impl is off-graph (backward) → manual.
    const denied = await call(ids.contributor, "move_task", {
      taskKey: "VIB-142",
      toStageId: "impl",
    });
    expect(denied).toContain("[denied]");
    const moved = await call(ids.maintainer, "move_task", {
      taskKey: "VIB-142",
      toStageId: "impl",
    });
    expect(moved).toContain("[done]");
    // Restore for later arms.
    const restored = await call(ids.maintainer, "move_task", {
      taskKey: "VIB-142",
      toStageId: "review",
    });
    expect(restored).toContain("[done]");
    // Done is not reachable here, even for the project admin.
    const terminal = await call(ids.projectAdmin, "move_task", {
      taskKey: "VIB-142",
      toStageId: "done",
    });
    expect(terminal).toContain("[denied]");
    expect(terminal).toContain("task page");
  });

  /**
   * The board and the task dropdown both send `manual: true`, so EVERY human
   * stage move is gated on `approve-transition` (maintainer+) whatever
   * boundary it crosses — `transitionStage`'s any-member `auto` branch carries
   * a comment saying it is unreachable from the UI. A controller that omitted
   * the flag on declared edges would reopen that branch and let a VIEWER cross
   * triage -> ready, an action the same person cannot perform on the board.
   * The controller is the human's instrument: it must knock on the same door.
   */
  it("move_task: an ON-GRAPH auto boundary still needs the transition tier", async () => {
    const created = await call(ids.maintainer, "create_task", {
      title: "Auto boundary probe",
      goal: "Sits in triage so the first declared edge can be probed.",
    });
    const key = /VIB-\d+/.exec(created)![0];

    const denied = await call(ids.viewer, "move_task", {
      taskKey: key,
      toStageId: "ready",
    });
    expect(denied).toContain("[denied]");
    const stillContributor = await call(ids.contributor, "move_task", {
      taskKey: key,
      toStageId: "ready",
    });
    expect(stillContributor).toContain("[denied]");

    const moved = await call(ids.maintainer, "move_task", {
      taskKey: key,
      toStageId: "ready",
    });
    expect(moved).toContain("[done]");
  });

  /**
   * An archived project is read-only (R6-3). `requireAction` is the chokepoint
   * that enforces that, and commenting names no RbacAction, so it never passes
   * through it — the human comment path guards it by hand. `requireVisible`
   * deliberately allows archived projects so reads keep working, which left
   * the controller as the one door that could write into a frozen timeline.
   */
  it("an archived project refuses controller writes while still answering reads", async () => {
    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { rebuildProject } = await import(
      "~/server/projections/rebuilder.server"
    );
    const setArchived = async (archived: boolean) => {
      await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
        p.frontmatter.archived = archived;
      });
      rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    };

    await setArchived(true);
    try {
      const commented = await call(ids.projectAdmin, "comment_on_task", {
        taskKey: "VIB-142",
        text: "Should not land on a frozen timeline.",
      });
      expect(commented).toContain("archived");
      const { readTaskFile } = await import("~/server/files/task-writer.server");
      const file = readTaskFile({
        projectSlug: SLUG,
        taskKey: "VIB-142",
        dataRoot: app.dataRoot,
      })!;
      expect(file.parsed.timeline[0]!.text).not.toContain("frozen timeline");

      // Reading an archived project still works — this is a freeze, not a
      // disappearance.
      const read = await call(ids.projectAdmin, "get_task", { taskKey: "VIB-142" });
      expect(read).not.toContain("[denied]");
    } finally {
      await setArchived(false);
    }
  });

  it("comment_on_task: any member may publish; the comment lands as the controller with the asker disclosed", async () => {
    const reply = await call(ids.viewer, "comment_on_task", {
      taskKey: "VIB-142",
      text: "Status note published through the controller.",
    });
    expect(reply).toContain("[done]");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const file = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!;
    const top = file.parsed.timeline[0]!;
    expect(top.actor).toEqual({ kind: "controller" });
    expect(top.text).toContain("Status note published");
    expect(top.text).toContain("Posted by the controller for");
    // C03-OC1 (pass 32): the audit row names the asking human, like every
    // other controller tool — it used to read `userId: null · controller`.
    // Canary: drop `auditActor` from the comment_on_task call.
    const audit = listAuditEvents(app.db, { action: "task.agent.commented" })[0]!;
    expect(audit.actorUserId).toBe(ids.viewer);
    expect(audit.actorLabel).toContain("via controller");
    const denied = await call(ids.nonMember, "comment_on_task", {
      taskKey: "VIB-142",
      text: "Should not land.",
    });
    expect(denied).toContain("is visible to you");
  });

  it("set_task_owner: a viewer is refused; a contributor takes an unowned seat", async () => {
    // A fresh, UNOWNED task: VIB-142 ships owned, and taking an occupied seat
    // is a different (acceptance-tier) authority than self-assigning.
    const created = await call(ids.contributor, "create_task", {
      title: "Ownership arm probe",
    });
    const key = /VIB-\d+/.exec(created)![0];
    const denied = await call(ids.viewer, "set_task_owner", {
      taskKey: key,
      owner: "me",
    });
    expect(denied).toContain("[denied]");
    const done = await call(ids.contributor, "set_task_owner", {
      taskKey: key,
      owner: "me",
    });
    expect(done).toContain("[done]");
  });

  it("run_agent_on_task: a contributor is refused; a maintainer reaches the runtime", async () => {
    const denied = await call(ids.contributor, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "operator",
      prompt: "Check in on this task.",
    });
    expect(denied).toContain("[denied]");
    expect(denied).toContain("maintainer");
    const reply = await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "operator",
      prompt: "Check in on this task.",
    });
    // The fake runtime answers; what matters is the RBAC gate passed and the
    // reply reports the real outcome, never a permission refusal.
    expect(reply).not.toContain("maintainer role");
    expect(reply).toMatch(/\[(done|denied|error)\]/);
  });

  it("project settings, stages, boundaries, members, deployments: MAINTAINER refused, project ADMIN granted", async () => {
    const arms: { tool: string; args: Record<string, JsonValue> }[] = [
      {
        tool: "update_project_settings",
        args: { description: "Managed through the controller." },
      },
      {
        tool: "update_stages",
        args: { op: "rename", stageId: "impl", name: "In Progress" },
      },
      {
        tool: "set_transition_boundary",
        args: { from: "triage", to: "ready", boundary: "approval" },
      },
      {
        tool: "invite_member",
        args: { name: "Invited Probe", email: "invited-probe@viberr.test" },
      },
      { tool: "deploy_agent", args: { profileId: "no-such-template" } },
      {
        tool: "update_agent_deployment",
        args: {
          profileId: "developer",
          capabilities: [{ capabilityId: "comment-on-task", mode: "off" }],
        },
      },
    ];
    for (const arm of arms) {
      const denied = await call(ids.maintainer, arm.tool, arm.args);
      expect(denied, `${arm.tool} must refuse a maintainer`).toContain("[denied]");
    }
    for (const arm of arms) {
      const reply = await call(ids.projectAdmin, arm.tool, arm.args);
      // Admin passes the GATE; a probe arg may still hit validation (the bogus
      // deploy id), which proves gate passage just as well.
      expect(
        reply,
        `${arm.tool} must not role-refuse the project admin`,
      ).not.toContain("Only project admins");
      expect(reply).not.toContain("cannot");
    }
    // set_member_role rides on the invite above.
    const roleDenied = await call(ids.maintainer, "set_member_role", {
      email: "invited-probe@viberr.test",
      role: "viewer",
    });
    expect(roleDenied).toContain("[denied]");
    const roleSet = await call(ids.projectAdmin, "set_member_role", {
      email: "invited-probe@viberr.test",
      role: "viewer",
    });
    expect(roleSet).toContain("[done]");
  });

  it("the terminal boundary cannot be loosened, even by the project admin", async () => {
    const reply = await call(ids.projectAdmin, "set_transition_boundary", {
      from: "review",
      to: "done",
      boundary: "auto",
    });
    expect(reply).toContain("[denied]");
  });

  it("goals: a viewer cannot define a chain; a contributor can; redirecting needs the creator or a maintainer", async () => {
    const denied = await call(ids.viewer, "create_goal", {
      title: "Viewer chain",
      links: [{ title: "One", goal: "Do one thing. Done when it exists." }],
    });
    expect(denied).toContain("[denied]");

    const created = await call(ids.contributor, "create_goal", {
      title: "Matrix probe chain",
      description: "Two links, advanced by the server.",
      links: [
        { title: "First link", goal: "Do the first thing. Done when done." },
        { title: "Second link", goal: "Do the second thing. Done when done." },
      ],
    });
    expect(created).toContain("[done]");
    expect(created).toContain("goal-1");

    const listed = await call(ids.viewer, "list_goals");
    expect(listed).toContain("Matrix probe chain");
    const goal = await call(ids.viewer, "get_goal", { goalId: "goal-1" });
    expect(goal).toContain("First link");

    // The invited member is a plain viewer now and NOT the creator: refused.
    const { findUserByEmail } = await import("~/server/auth/user-store.server");
    const invited = findUserByEmail(app.db, "invited-probe@viberr.test")!.id;
    const redirectDenied = await call(invited, "update_goal", {
      goalId: "goal-1",
      op: "pause",
    });
    expect(redirectDenied).toContain("[denied]");

    // The creator pauses their own chain; a maintainer resumes it.
    const paused = await call(ids.contributor, "update_goal", {
      goalId: "goal-1",
      op: "pause",
    });
    expect(paused).toContain("[done]");
    const resumed = await call(ids.maintainer, "update_goal", {
      goalId: "goal-1",
      op: "resume",
    });
    expect(resumed).toContain("[done]");
  });
});

// ------------------------------------------------------------ ruling 121

/** Build the toolkit AS one user with a task anchor and call one tool. */
async function callAnchored(
  userId: string,
  toolName: string,
  args: Record<string, JsonValue> = {},
  taskKey: string | null = "VIB-142",
): Promise<string> {
  const { buildControllerToolkit } = await import("./controller-toolkit.server");
  const { findUserById } = await import("~/server/auth/user-store.server");
  const user = findUserById(app.db, userId)!;
  const toolkit = buildControllerToolkit({
    db: app.db,
    ctx: { dataRoot: app.dataRoot },
    user: { id: user.id, email: user.email, name: user.name },
    projectSlug: SLUG,
    taskKey,
  });
  const tool = toolkit.tools.find((t) => t.name === toolName);
  expect(tool, `tool ${toolName} must exist`).toBeTruthy();
  // SAFETY: every toolkit handler is wrapped by `run`, which always returns
  // the `textResult` shape: { content: [{ type: "text", text }] }.
  const result = (await tool!.handler(args, {})) as {
    content: { text: string }[];
  };
  return result.content[0]!.text;
}

describe("task anchoring (ruling 121)", () => {
  it("defaults every task tool's key to the anchored task, and asks for one when there is none", async () => {
    expect(await call(ids.maintainer, "get_task", {})).toContain(
      "[error] Name the task (this conversation is not anchored to one).",
    );
    const anchored = await callAnchored(ids.maintainer, "get_task", {});
    expect(anchored).toContain('"key": "VIB-142"');
    // An explicit key still wins over the anchor.
    const explicit = await callAnchored(ids.maintainer, "get_task", { taskKey: "VIB-148" });
    expect(explicit).toContain('"key": "VIB-148"');
    expect(explicit).not.toContain('"key": "VIB-142"');
  });

  it("whoami reports the anchored task beside the project binding", async () => {
    const text = await callAnchored(ids.contributor, "whoami", {});
    expect(text).toContain(`"conversationProject": "${SLUG}"`);
    expect(text).toContain('"conversationTask": "VIB-142"');
    expect(await call(ids.contributor, "whoami", {})).toContain('"conversationTask": null');
  });

  it("update_task edits the goal under update-goal and the metadata under edit-task-meta, each on its own", async () => {
    const { getTaskSummary } = await import("~/server/projections/task-query.server");
    // Nothing to do is an error, not a silent no-op.
    expect(await callAnchored(ids.maintainer, "update_task", {}, "VIB-148")).toContain(
      "[error] Pass a goal and/or at least one metadata field",
    );
    // A viewer edits nothing.
    expect(
      await callAnchored(ids.viewer, "update_task", { labels: ["x"] }, "VIB-148"),
    ).toMatch(/^\[denied\]/);
    // A contributor holds edit-task-meta but not update-goal: the metadata
    // lands, the goal refusal is reported beside it, nothing is hidden.
    const partial = await callAnchored(
      ids.contributor,
      "update_task",
      { goal: "A goal the contributor may not set.", labels: ["triaged"], priority: "high" },
      "VIB-148",
    );
    expect(partial).toContain("[done] VIB-148 updated: priority, labels.");
    expect(partial).toContain("Not applied: goal:");
    let after = getTaskSummary(app.db, SLUG, "VIB-148")!;
    expect(after.labels).toEqual(["triaged"]);
    expect(after.priority).toBe("high");
    expect(after.goal).not.toContain("the contributor may not set");
    // A maintainer sets both; metadata is a full replace of what is passed.
    const full = await callAnchored(
      ids.maintainer,
      "update_task",
      { goal: "Deliver the widget with a passing e2e run.", labels: [], dueDate: "2026-12-31" },
      "VIB-148",
    );
    expect(full).toBe("[done] VIB-148 updated: goal, labels, due date.");
    after = getTaskSummary(app.db, SLUG, "VIB-148")!;
    expect(after.goal).toBe("Deliver the widget with a passing e2e run.");
    expect(after.labels).toEqual([]);
    expect(after.dueDate).toBe("2026-12-31");
    // Clearing the date is "" and a bad value throws before any write.
    expect(
      await callAnchored(ids.maintainer, "update_task", { dueDate: "" }, "VIB-148"),
    ).toBe("[done] VIB-148 updated: due date.");
    expect(getTaskSummary(app.db, SLUG, "VIB-148")!.dueDate).toBeNull();
    expect(
      await callAnchored(ids.maintainer, "update_task", { dueDate: "not-a-date" }, "VIB-148"),
    ).toMatch(/^\[error\]/);
  });

  /**
   * Review finding 4: the anchor belongs to ITS OWN project. A call that
   * overrides projectSlug and omits taskKey used to inherit the anchored key
   * and act on a same-named task in the other project — a write nobody named.
   */
  it("refuses to carry the anchored task key into another project", async () => {
    const text = await callAnchored(
      ids.orgAdmin,
      "get_task",
      { projectSlug: "deploy-pipeline" },
      "VIB-142",
    );
    expect(text).toContain("[error] This conversation is anchored to VIB-142 in viberr-core");
    expect(text).toContain("name the task in deploy-pipeline");
    // Naming the task explicitly still works across projects.
    const named = await callAnchored(
      ids.orgAdmin,
      "get_task",
      { projectSlug: "deploy-pipeline", taskKey: "DEP-2" },
      "VIB-142",
    );
    expect(named).not.toContain("[error] This conversation is anchored");
  });

  /**
   * Review finding 14: both writers short-circuit when the value is already
   * what was asked for — no file write, no timeline note, no audit row — and
   * the tool reported "[done] updated" anyway.
   */
  it("says nothing was written when the value was already set", async () => {
    const { getTaskSummary } = await import("~/server/projections/task-query.server");
    await callAnchored(ids.maintainer, "update_task", { priority: "high" }, "VIB-151");
    expect(getTaskSummary(app.db, SLUG, "VIB-151")!.priority).toBe("high");

    const again = await callAnchored(
      ids.maintainer,
      "update_task",
      { priority: "high" },
      "VIB-151",
    );
    expect(again).toBe(
      "[noop] VIB-151: priority already had that value; nothing was written.",
    );

    // A mixed call reports each half honestly.
    const mixed = await callAnchored(
      ids.maintainer,
      "update_task",
      { priority: "high", labels: ["fresh-label"] },
      "VIB-151",
    );
    expect(mixed).toContain("[done] VIB-151 updated: labels.");
    expect(mixed).toContain("Already set, nothing written: priority.");
  });

  it("ruling 131: create_task and update_task set the wait; [noop] on an unchanged list; refusal by name; [] clears and releases; a viewer is refused", async () => {
    // Canary: drop `blockedBy` from the empty-call guard (the wait-only
    // update answers "[error] Pass a goal…").
    const { getTaskSummary } = await import("~/server/projections/task-query.server");
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const created = await call(ids.contributor, "create_task", {
      title: "Waits on the credential attach",
      blockedBy: ["VIB-142"],
    });
    expect(created).toMatch(/^\[done\] VIB-\d+ created in Triage: Waits on the credential attach\. Waits on VIB-142; held until every entry is done\.$/);
    const key = /VIB-\d+/.exec(created)![0];
    let summary = getTaskSummary(app.db, SLUG, key)!;
    expect(summary.blockedBy.map((e) => e.ref)).toEqual(["VIB-142"]);
    expect(summary.waiting).toBe("none");
    expect(summary.readiness).toBe("blocked");

    // A bad reference refuses by name and burns no key: the next create lands on the next number.
    expect(await call(ids.contributor, "create_task", { title: "Bad wait", blockedBy: ["VIB-9999"] })).toContain(
      "[error] VIB-9999 is not a task in this project.",
    );

    expect(await callAnchored(ids.contributor, "update_task", { blockedBy: ["vib-142"] }, key)).toContain(
      `[noop] ${key}: blocked by already had that value; nothing was written.`,
    );
    expect(await callAnchored(ids.contributor, "update_task", { blockedBy: ["VIB-142", "VIB-148"], priority: "high" }, key)).toContain(
      `[done] ${key} updated: priority, blocked by (VIB-142, VIB-148).`,
    );
    const selfWait = await callAnchored(ids.contributor, "update_task", { blockedBy: [key] }, key);
    expect(selfWait).toContain(`[error] ${key}: a task cannot wait on itself.`);
    expect(await callAnchored(ids.viewer, "update_task", { blockedBy: [] }, key)).toMatch(/^\[denied\]/);
    // A person emptying the list is the release itself.
    expect(await callAnchored(ids.contributor, "update_task", { blockedBy: [] }, key)).toContain(
      `[done] ${key} updated: blocked by (cleared: the task is released).`,
    );
    summary = getTaskSummary(app.db, SLUG, key)!;
    expect(summary.blockedBy).toEqual([]);
    const file = readTaskFile({ projectSlug: SLUG, taskKey: key, dataRoot: app.dataRoot })!.parsed;
    expect(file.timeline.some((e) => e.title === "Dependencies released")).toBe(true);
    // The reads expose the wait.
    // SAFETY: `list_tasks` answers `json(rows.map(...))` with exactly these
    // two fields on every row (the tool's own mapping above).
    const listed = JSON.parse(await call(ids.contributor, "list_tasks", {})) as { key: string; waitsOn: string[] }[];
    expect(listed.find((t) => t.key === key)!.waitsOn).toEqual([]);
    await callAnchored(ids.contributor, "update_task", { blockedBy: ["VIB-142"] }, key);
    // SAFETY: same mapping as above.
    const listedAgain = JSON.parse(await call(ids.contributor, "list_tasks", {})) as { key: string; waitsOn: string[] }[];
    expect(listedAgain.find((t) => t.key === key)!.waitsOn).toEqual(["VIB-142 (open)"]);
  });

  it("ruling 131(c): create_goal links declare a wait, update_goal edit_link leaves it when absent and clears it with [], and list_goals/get_goal expose it", async () => {
    // Canary: drop `blockedBy` from the `edit_link` op mapping (the [] clear
    // is silently ignored).
    const created = await call(ids.maintainer, "create_goal", {
      title: "Chain with a declared wait",
      links: [
        { title: "First", goal: "Do the first thing. Done when merged." },
        { title: "Second", goal: "Do the second thing. Done when merged.", blockedBy: ["VIB-142"] },
      ],
    });
    expect(created).toMatch(/^\[done\] Goal goal-\d+ created with 2 links; link 1 is VIB-\d+\.$/);
    const goalId = /goal-\d+/.exec(created)![0];
    // SAFETY: `get_goal` answers `json(goalView)`, whose `links` are the
    // schema-parsed GoalLink[] (index and blockedBy always present).
    const goal = JSON.parse(await call(ids.maintainer, "get_goal", { goalId })) as { links: { index: number; blockedBy: string[] }[] };
    expect(goal.links.map((l) => l.blockedBy)).toEqual([[], ["VIB-142"]]);
    // A title-only edit leaves the wait alone.
    await call(ids.maintainer, "update_goal", { goalId, op: "edit_link", index: 2, title: "Second, renamed" });
    // SAFETY: same shape as above.
    let after = JSON.parse(await call(ids.maintainer, "get_goal", { goalId })) as { links: { blockedBy: string[] }[] };
    expect(after.links[1]!.blockedBy).toEqual(["VIB-142"]);
    // A declared cycle is refused at declaration time.
    expect(await call(ids.maintainer, "update_goal", { goalId, op: "edit_link", index: 2, blockedBy: [`${goalId} link 2`] })).toContain(
      `[error] ${goalId} link 2: a link cannot wait on itself.`,
    );
    // [] clears.
    expect(await call(ids.maintainer, "update_goal", { goalId, op: "edit_link", index: 2, blockedBy: [] })).toContain("waits on nothing");
    // SAFETY: same shape as above.
    after = JSON.parse(await call(ids.maintainer, "get_goal", { goalId })) as { links: { blockedBy: string[] }[] };
    expect(after.links[1]!.blockedBy).toEqual([]);
    // SAFETY: `list_goals` maps every link to `{index, title, status, taskKey, blockedBy}`.
    const listed = JSON.parse(await call(ids.maintainer, "list_goals", {})) as { id: string; links: { blockedBy: string[] }[] }[];
    expect(listed.find((g) => g.id === goalId)!.links.map((l) => l.blockedBy)).toEqual([[], []]);
    // add_link with a wait.
    expect(await call(ids.maintainer, "update_goal", { goalId, op: "add_link", title: "Third", goal: "Third thing.", blockedBy: ["VIB-148"] })).toContain("[done] Link 3 added.");
    // SAFETY: same shape as above.
    after = JSON.parse(await call(ids.maintainer, "get_goal", { goalId })) as { links: { blockedBy: string[] }[] };
    expect(after.links[2]!.blockedBy).toEqual(["VIB-148"]);
  });

  it("update_task is a write tool, so the always-human and no-delete invariants still hold", async () => {
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
      projectSlug: SLUG,
      taskKey: "VIB-142",
    });
    const names = toolkit.tools.map((t) => t.name);
    expect(names).toContain("update_task");
    expect(names.some((n) => /delete|remove_task|merge|accept|force|resolve_packet/.test(n))).toBe(false);
  });
});

// ------------------------------------------ global agent template grants

/**
 * F33-8 / F33-7 (pass 33, found live): the template tool's resource grants.
 *
 * A grant is resolved at RUN time by the store key — the skill folder name, the
 * MCP registry name (`byName.get(name)` drops an unmatched one), the KB store
 * directory — but the controller's reads hand back catalog IDS, and every grant
 * it made was stored verbatim: three red missing chips in the editor, a roster
 * row counting "3 context resources", and a run that mounted none of them.
 * And because `save_global_agent` rewrote all three lists on every call while
 * `list_global_agents` showed none of them, a summary-only edit silently
 * emptied the grants the template held.
 */
describe("save_global_agent: grants are store keys, and an omitted list is left alone", () => {
  const AGENT_ID = "grant-probe-writer";
  const catalog = {
    kb: { id: "", key: "" },
    skill: { id: "", key: "" },
    mcp: { id: "", key: "" },
  };

  /** One list tool's answer, decoded. */
  async function listJson<T>(toolName: string): Promise<T[]> {
    const text = await call(ids.orgAdmin, toolName);
    // SAFETY: every list tool answers through the toolkit's `json()`, i.e.
    // `JSON.stringify` over an array of the object literal its `.map` builds;
    // the shapes named here are fields of that literal.
    return JSON.parse(text) as T[];
  }

  interface CatalogRow {
    grantKey: string;
    id: string;
    name: string;
  }

  /** The named template as `list_global_agents` reports it (undefined = absent). */
  async function listedAgent() {
    const rows = await listJson<{
      id: string;
      summary: string;
      skills: string[];
      mcps: string[];
      kbs: string[];
    }>("list_global_agents");
    return rows.find((r) => r.id === AGENT_ID);
  }

  beforeAll(async () => {
    await call(ids.orgAdmin, "save_knowledge_base", { name: "Grant Probe Handbook" });
    await call(ids.orgAdmin, "save_skill", {
      name: "grant-probe-expertise",
      summary: "A probe skill the grant test grants.",
      body: "# Skill\n\nBody.",
    });
    await call(ids.orgAdmin, "save_mcp_server", {
      name: "grant-probe-server",
      transport: "HTTP",
      target: "https://mcp.example.test/v1",
    });
    const kbs = await listJson<CatalogRow>("list_knowledge_bases");
    const skills = await listJson<CatalogRow>("list_skills");
    const mcps = await listJson<CatalogRow>("list_mcp_servers");
    const kb = kbs.find((k) => k.name === "Grant Probe Handbook")!;
    const skill = skills.find((s) => s.name === "grant-probe-expertise")!;
    const mcp = mcps.find((m) => m.name === "grant-probe-server")!;
    catalog.kb = { id: kb.id, key: kb.grantKey };
    catalog.skill = { id: skill.id, key: skill.grantKey };
    catalog.mcp = { id: mcp.id, key: mcp.grantKey };
  });

  it("each resource list carries the grantKey the runtime mounts by, next to the id", () => {
    // The KB's key is its FOLDER, never the `kb_…` handle the editor tools take.
    expect(catalog.kb.key).toBe("grant-probe-handbook");
    expect(catalog.kb.key).not.toBe(catalog.kb.id);
    expect(catalog.skill.key).toBe("grant-probe-expertise");
    expect(catalog.skill.key).not.toBe(catalog.skill.id);
    expect(catalog.mcp.key).toBe("grant-probe-server");
  });

  it("granting by the id a read tool returned stores the KEY, not the id", async () => {
    const created = await call(ids.orgAdmin, "save_global_agent", {
      name: "Grant Probe Writer",
      backend: "claude",
      summary: "Writes docs. Never touches app code.",
      persona: "You are the Grant Probe Writer.",
      stages: ["impl"],
      skills: [catalog.skill.id],
      mcps: [catalog.mcp.id],
      kbs: [catalog.kb.id],
    });
    expect(created).toContain("[done]");
    // What landed is what a run resolves by — the fixture that shipped this
    // finding held `disk:…`, `mcp_…` and `kb_…` here and mounted nothing.
    expect(await listedAgent()).toMatchObject({
      skills: ["grant-probe-expertise"],
      mcps: ["grant-probe-server"],
      kbs: ["grant-probe-handbook"],
    });
  });

  it("a grant nothing in the store answers to is refused by name, and nothing is written", async () => {
    const refused = await call(ids.orgAdmin, "save_global_agent", {
      id: AGENT_ID,
      name: "Grant Probe Writer",
      backend: "claude",
      summary: "Writes docs. Never touches app code.",
      stages: ["impl"],
      skills: ["ghost-skill"],
    });
    expect(refused).toContain("[error]");
    expect(refused).toContain('skill "ghost-skill"');
    expect(refused).toContain("folder name");
    // The refusal is total: the grants it already holds are untouched.
    expect(await listedAgent()).toMatchObject({
      skills: ["grant-probe-expertise"],
      mcps: ["grant-probe-server"],
      kbs: ["grant-probe-handbook"],
    });
  });

  it("an edit that names no grant list keeps all three; an empty list clears just that one", async () => {
    const edited = await call(ids.orgAdmin, "save_global_agent", {
      id: AGENT_ID,
      name: "Grant Probe Writer",
      backend: "claude",
      summary: "Writes and edits documentation files only.",
      stages: ["impl"],
    });
    expect(edited).toContain("[done]");
    expect(await listedAgent()).toMatchObject({
      summary: "Writes and edits documentation files only.",
      skills: ["grant-probe-expertise"],
      mcps: ["grant-probe-server"],
      kbs: ["grant-probe-handbook"],
    });

    const cleared = await call(ids.orgAdmin, "save_global_agent", {
      id: AGENT_ID,
      name: "Grant Probe Writer",
      backend: "claude",
      summary: "Writes and edits documentation files only.",
      stages: ["impl"],
      mcps: [],
    });
    expect(cleared).toContain("[done]");
    expect(await listedAgent()).toMatchObject({
      skills: ["grant-probe-expertise"],
      mcps: [],
      kbs: ["grant-probe-handbook"],
    });
  });
});

/**
 * Ruling 139 (pass 34, F34-2): `update_agent_deployment` reads first and
 * refuses a catalogued value it cannot store BY NAME, with nothing written —
 * it used to answer `[done]` twelve times for capability ids that do not exist.
 */
describe("update_agent_deployment refuses catalogued values by name (ruling 139)", () => {
  async function projectMd(): Promise<string> {
    const { resolveProjectFilePath } = await import("~/server/files/project-writer.server");
    return readFileSync(resolveProjectFilePath({ projectSlug: SLUG, dataRoot: app.dataRoot }), "utf8");
  }
  async function refused(args: Record<string, JsonValue>): Promise<string> {
    const before = await projectMd();
    const audits = listAuditEvents(app.db).length;
    const reply = await call(ids.projectAdmin, "update_agent_deployment", args);
    expect(reply.startsWith("[error] ")).toBe(true);
    expect(reply).toContain("Nothing was written");
    expect(await projectMd()).toBe(before);
    expect(listAuditEvents(app.db)).toHaveLength(audits);
    return reply;
  }

  it("an unknown id is refused by name with the valid ids, and nothing is written", async () => {
    // Canary: make `capabilityPatchRefusal` return null.
    const reply = await refused({
      profileId: "developer",
      capabilities: [{ capabilityId: "write-code", mode: "direct" }],
    });
    expect(reply).toContain('No capability answers to "write-code"');
    expect(reply).toContain("execute-code-or-write-repo");
    expect(reply).toContain("list_capabilities");
  });

  it("a specialist recommend, a non-human mode on an always-human id, and an operator id on a specialist are refused", async () => {
    // Canary: validate against the union of both kinds.
    expect(
      await refused({ profileId: "developer", capabilities: [{ capabilityId: "comment-on-task", mode: "recommend" }] }),
    ).toContain("cannot be set to recommend on a specialist");
    expect(
      await refused({ profileId: "developer", capabilities: [{ capabilityId: "merge-pull-request", mode: "direct" }] }),
    ).toContain("reserved for humans");
    expect(
      await refused({ profileId: "developer", capabilities: [{ capabilityId: "dispatch-agents", mode: "direct" }] }),
    ).toContain('"dispatch-agents" is an operator capability and cannot be set on a specialist');
  });

  it("the operator arm resolves the operator from project.md and refuses a specialist id on it", async () => {
    // The KIND lives on the resolved profile, not the stored deployment row,
    // so the operator is found the way the roster finds it.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { effectiveProfileView, VIEW_WITHOUT_POLICY } = await import("~/features/agents/agents-query.server");
    const deployments = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!.parsed.frontmatter.agents;
    const operator = deployments.find(
      (a) => effectiveProfileView(a, app.dataRoot, VIEW_WITHOUT_POLICY).kind === "operator",
    );
    expect(operator).toBeDefined();
    const reply = await refused({
      profileId: operator!.profileId,
      capabilities: [{ capabilityId: "use-browser", mode: "direct" }],
    });
    expect(reply).toContain('"use-browser" is a specialist capability and cannot be set on the operator');
  });

  it("`report-validation-verdict` at human is refused", async () => {
    // Canary: delete branch (e) — project.md stores `off` and the call answers `[done]`.
    expect(
      await refused({ profileId: "developer", capabilities: [{ capabilityId: "report-validation-verdict", mode: "human" }] }),
    ).toContain("takes only direct or off");
  });

  it("an advisory id is refused as matrix-only, never as 'no such id'", async () => {
    // Canary: fold it into branch (a).
    const reply = await refused({ profileId: "developer", capabilities: [{ capabilityId: "read-repo-diff", mode: "off" }] });
    expect(reply).toContain('"read-repo-diff" is a matrix-only capability with no toggle');
    expect(reply).not.toContain("No capability answers to");
  });

  it("an unknown stage id is refused with the project's stage ids", async () => {
    // Canary: drop the stage check (the write lands and the agent is eligible nowhere).
    const reply = await refused({ profileId: "developer", stages: ["implementation"] });
    expect(reply).toContain('"implementation" is not a stage of viberr-core');
    expect(reply).toMatch(/stage ids are: .*impl/);
  });

  it("a legal patch still writes (the refusal is by name, not blanket)", async () => {
    const reply = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      capabilities: [{ capabilityId: "comment-on-task", mode: "off" }],
    });
    expect(reply).toContain("[done]");
  });
});

/**
 * Ruling 139 (pass 34, F34-2, the read half): `get_project` reports each
 * deployment's RESOLVED grants at the mode the roster renders, and
 * `list_capabilities` publishes the catalogue with the absent-grant rule.
 */
describe("get_project and list_capabilities read the catalogue (ruling 139)", () => {
  interface ProjectRead {
    agents: {
      profileId: string;
      kind: string;
      model: string;
      effort: string;
      autonomy?: string;
      capabilities: { capabilityId: string; mode: string; label: string }[];
    }[];
  }
  interface CatalogueRead {
    kinds: Record<
      "operator" | "agent",
      { modes: string[]; capabilities: { id: string; whenUngranted: string; alwaysHuman: boolean }[] }
    >;
    alwaysHuman: string[];
  }
  const modeOf = (row: ProjectRead["agents"][number], id: string) =>
    row.capabilities.find((c) => c.capabilityId === id)?.mode;

  it("get_project reports resolved grants, model, effort and autonomy at the mode the roster renders", async () => {
    // Canary: revert the agents map to the five-field literal.
    // Canary 2 (policy): read `effectiveProfileView(a, dataRoot, VIEW_WITHOUT_POLICY)`
    // instead of the roster — the operator's ABSENT deliver-review-pr reads `direct`.
    const { updateProjectFile, readProjectFile } = await import("~/server/files/project-writer.server");
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    // A fixture that can move: strip the operator's stored deliver-review-pr
    // grant and human-gate the pre-work boundary, so the absent mode resolves
    // to `recommend` (ruling 28).
    await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
      for (const a of p.frontmatter.agents) {
        a.capabilities = a.capabilities.filter((g) => g.capabilityId !== "deliver-review-pr");
      }
    });
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    // `humanGatesPreWorkAdvance` holds only when EVERY pre-terminal boundary
    // is human-gated, so gate each one the project declares.
    const fm = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!.parsed.frontmatter;
    const terminalId = fm.stages[fm.stages.length - 1]!.id;
    for (const edge of fm.workflow.filter((b) => b.to !== terminalId)) {
      const gated = await call(ids.projectAdmin, "set_transition_boundary", { from: edge.from, to: edge.to, boundary: "approval" });
      expect(gated).toContain("[done]");
    }

    // SAFETY: the tool answers the JSON it built; the fields asserted below are its own.
    const read = JSON.parse(await call(ids.viewer, "get_project")) as ProjectRead;
    const operator = read.agents.find((a) => a.kind === "operator")!;
    expect(["supervised", "full"]).toContain(operator.autonomy);
    expect(modeOf(operator, "deliver-review-pr")).toBe("recommend");
    const developer = read.agents.find((a) => a.profileId === "developer")!;
    expect(developer.model.length).toBeGreaterThan(0);
    expect(developer).toHaveProperty("effort");
    expect(developer.autonomy).toBeUndefined();
    // Anchored to project.md, not to the function the tool calls: the
    // developer's create-task-branch mode equals what the FILE stores, `off`
    // when the grant is absent (the grant-required family).
    const stored =
      readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
        .parsed.frontmatter.agents.find((a) => a.profileId === "developer")!
        .capabilities.find((g) => g.capabilityId === "create-task-branch")?.mode ?? "off";
    expect(modeOf(developer, "create-task-branch")).toBe(stored);
    expect(developer.capabilities.every((c) => c.label.length > 0)).toBe(true);
  });

  it("list_capabilities lists every governed id per kind with whenUngranted, for any signed-in person", async () => {
    // Canary: return the union of kinds (`c.kinds.includes(kind)` → true).
    // SAFETY: the tool answers the JSON it built; the fields asserted below are its own.
    const read = JSON.parse(await call(ids.nonMember, "list_capabilities", {}, null)) as CatalogueRead;
    const operatorIds = read.kinds.operator.capabilities.map((c) => c.id);
    const agentIds = read.kinds.agent.capabilities.map((c) => c.id);
    expect(operatorIds).toContain("dispatch-agents");
    expect(operatorIds).not.toContain("use-browser");
    expect(agentIds).toContain("use-browser");
    expect(agentIds).not.toContain("dispatch-agents");
    expect(agentIds).not.toContain("read-repo-diff"); // matrix-only: no toggle
    expect(read.kinds.operator.modes).toEqual(["direct", "recommend", "human", "off"]);
    expect(read.kinds.agent.modes).toEqual(["direct", "human", "off"]);
    const when = (kind: "operator" | "agent", id: string) =>
      read.kinds[kind].capabilities.find((c) => c.id === id)?.whenUngranted;
    // The ABSENT-grant mode, not the create-seed default.
    expect(when("agent", "create-task-branch")).toBe("off");
    expect(when("agent", "comment-on-task")).toBe("direct");
    expect(when("operator", "dispatch-agents")).toBe("direct");
    expect(when("operator", "generate-packets")).toBe("off");
    expect(when("operator", "deliver-review-pr")).toBe("project policy (see get_project)");
    expect(when("agent", "merge-pull-request")).toBe("human");
    expect(read.alwaysHuman).toEqual(["merge-pull-request", "transition-to-done", "change-project-policy"]);
  });

  it("a write then a read in one session reports the new grant", async () => {
    // Canary: drop the reproject in updateAgentProfile — the roster reads the
    // projection and would report the OLD mode.
    const set = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      capabilities: [{ capabilityId: "comment-on-task", mode: "off" }],
    });
    expect(set).toContain("[done]");
    // SAFETY: the tool answers the JSON it built; the fields asserted below are its own.
    let read = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    expect(modeOf(read.agents.find((a) => a.profileId === "developer")!, "comment-on-task")).toBe("off");
    await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      capabilities: [{ capabilityId: "comment-on-task", mode: "direct" }],
    });
    // SAFETY: as above.
    read = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    expect(modeOf(read.agents.find((a) => a.profileId === "developer")!, "comment-on-task")).toBe("direct");
  });
});

/**
 * Ruling 139 (pass 34, G34-1): effort is settable wherever model is, judged
 * by name against the backend at save time, never clamped at run time.
 */
describe("effort and model at deploy are settable and refused by name (ruling 139)", () => {
  interface ProjectRead {
    agents: { profileId: string; backends: string[]; model: string; effort: string }[];
  }
  async function developer(): Promise<ProjectRead["agents"][number]> {
    // SAFETY: the tool answers the JSON it built; the fields asserted are its own.
    const read = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    return read.agents.find((a) => a.profileId === "developer")!;
  }

  it("update_agent_deployment sets effort, refuses a tier the backend does not offer by name, and resets on a backend switch", async () => {
    // Canary: remove `effort` from the schema, or drop the assert on the write surface.
    // Backend-agnostic: earlier cases in this sequential store may have
    // switched the developer, so every tier is chosen for the CURRENT backend.
    const before = await developer();
    const current = before.backends[0] === "codex" ? "codex" : "claude";
    const other = current === "claude" ? "codex" : "claude";
    const label = { claude: "Claude", codex: "Codex" } as const;
    // Both backends offer `max` since Codex CLI 0.153 (SDK 0.153.4); `ultra` is
    // Codex-only in the SDK union and deliberately unoffered on either.
    const tiers = { claude: "low, medium, high, xhigh, max", codex: "low, medium, high, xhigh, max" } as const;
    const top = "max";
    const set = await call(ids.projectAdmin, "update_agent_deployment", { profileId: "developer", effort: top });
    expect(set).toContain("[done]");
    expect(set).toContain(`Effort is now ${top}`);
    expect((await developer()).effort).toBe(top);

    const refused = await call(ids.projectAdmin, "update_agent_deployment", { profileId: "developer", effort: "ultra" });
    expect(refused).toContain(`[error] "ultra" is not an effort tier ${label[current]} offers. ${label[current]} takes: ${tiers[current]}.`);
    expect((await developer()).effort).toBe(top); // nothing written

    // A tier the OTHER backend does not list, sent with the switch: refused, nothing written.
    // (Codex accepts `minimal` at run time but never offers it; Claude has no such tier.)
    const foreignTier = "minimal";
    const wrongBackend = await call(ids.projectAdmin, "update_agent_deployment", { profileId: "developer", backend: other, effort: foreignTier });
    expect(wrongBackend).toContain(`[error] "${foreignTier}" is not an effort tier ${label[other]} offers`);
    expect((await developer()).backends).toEqual(before.backends);

    const otherDefault = other === "codex" ? "medium" : "high";
    const switched = await call(ids.projectAdmin, "update_agent_deployment", { profileId: "developer", backend: other });
    expect(switched).toContain(`Backend switched to ${label[other]}: effort reset to its default (${otherDefault})`);
    const after = await developer();
    expect(after.backends).toEqual([other]);
    expect(after.effort).toBe(otherDefault);
    // Restore the fixture for the other cases.
    await call(ids.projectAdmin, "update_agent_deployment", { profileId: "developer", backend: current, model: before.model, effort: before.effort || top });
  });

  it("deploy_agent pins model and effort, audits them, and refuses an unknown tier before the write", async () => {
    // Canary: keep `defaultEffortFor(backend)` at the deploy write (the override is ignored).
    const minted = await call(ids.orgAdmin, "save_global_agent", {
      name: "Effort Probe",
      backend: "claude",
      summary: "Probes the deploy overrides.",
      stages: ["impl"],
    });
    expect(minted).toContain("[done]");
    const refused = await call(ids.projectAdmin, "deploy_agent", { profileId: "effort-probe", effort: "ultra" });
    expect(refused).toContain('[error] "ultra" is not an effort tier Claude offers');
    const deployed = await call(ids.projectAdmin, "deploy_agent", { profileId: "effort-probe", model: "opus", effort: "max" });
    expect(deployed).toContain("[done] Effort Probe deployed");
    expect(deployed).toContain("Runs on Claude with model opus at effort max.");
    // SAFETY: the tool answers the JSON it built; the fields asserted are its own.
    const read = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    const probe = read.agents.find((a) => a.profileId === "effort-probe")!;
    expect(probe.model).toBe("opus");
    expect(probe.effort).toBe("max");
    const row = listAuditEvents(app.db, { action: "project.agent_profile.deployed" })[0]!;
    expect(row.details).toMatchObject({ name: "Effort Probe", model: "opus", effort: "max" });
  });
});

/**
 * Ruling 140(a) (pass 34, G34-3): `create_task` takes `owner` and `dueDate`;
 * a named owner is seated before the first operator run; the release word is
 * refused by name at creation.
 */
describe("create_task seats a named owner and takes dueDate (ruling 140)", () => {
  it("seats the named owner in the creating write, records dueDate, derives urgent from priority", async () => {
    // Canary: drop the owner pass-through (the seat becomes the caller); drop
    // the dueDate pass-through.
    const reply = await call(ids.contributor, "create_task", {
      title: "Seated for the maintainer",
      goal: "Prove the seat. Done when Murat owns it from birth.",
      owner: "murat@viberr.dev",
      dueDate: "2026-09-30",
      priority: "urgent",
    });
    expect(reply).toContain("[done]");
    expect(reply).toContain("Owner: murat@viberr.dev, seated before the first operator run.");
    const key = /VIB-\d+/.exec(reply)![0];
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const fm = readTaskFile({ projectSlug: SLUG, taskKey: key, dataRoot: app.dataRoot })!
      .parsed.frontmatter;
    expect(fm.ownerUserId).toBe(ids.maintainer);
    expect(fm.dueDate).toBe("2026-09-30");
    expect(fm.priority).toBe("urgent");
    expect(fm.urgent).toBe(true);
    expect(
      listAuditEvents(app.db, { action: "task.created" })[0]!.details,
    ).toMatchObject({ ownerUserId: ids.maintainer, seat: "named" });
  });

  it("the release word is refused by name; an unknown email is named; a viewer cannot be seated", async () => {
    const none = await call(ids.contributor, "create_task", { title: "Nobody owns this", owner: "none" });
    expect(none).toContain(
      "[error] A new task is created with an owner; use `set_task_owner` to release the seat afterwards.",
    );
    const ghost = await call(ids.contributor, "create_task", { title: "Ghost owns this", owner: "ghost@viberr.dev" });
    expect(ghost).toContain("[error] No Viberr user with the email ghost@viberr.dev.");
    const viewer = await call(ids.contributor, "create_task", { title: "Viewer owns this", owner: "viewer@viberr.test" });
    expect(viewer).toContain(
      "Ownership can only be handed to a project member who can own tasks (contributor or above).",
    );
  });
});

/**
 * B5 (pass 34, U34-3): the controller's own read-modify-write inside one turn
 * is never refused by its own fingerprint; a hand-save landing between its
 * read and its write IS.
 */
describe("update_agent_deployment carries the record it read (B5)", () => {
  it("its own read-modify-write applies, and a save landing in between is refused", async () => {
    // Canary: have the tool send a constant fingerprint — its own writes then
    // fail, and a stale one succeeds.
    const own = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      capabilities: [{ capabilityId: "comment-on-task", mode: "direct" }],
    });
    expect(own).toContain("[done]");

    // A hand-save lands between a read and a write the tool performs. The tool
    // reads the record at call time, so simulate the race by writing the file
    // out from under an already-composed form.
    const { updateAgentProfile, deploymentFingerprint } = await import(
      "~/features/agents/agent-profile-actions.server"
    );
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const deployment = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === "developer")!;
    const staleForm = {
      name: "Developer",
      role: "Implementation",
      backend: "claude" as const,
      stages: ["impl"],
      definition: "",
      model: "sonnet",
      effort: "high",
      fingerprint: deploymentFingerprint(deployment),
      caps: { "comment-on-task": "off" },
      resources: { skills: [], mcps: [], kb: [] },
    };
    // The concurrent write.
    await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      capabilities: [{ capabilityId: "ask-human", mode: "off" }],
    });
    const actor = { userId: ids.projectAdmin, label: "elif@viberr.dev" };
    await expect(
      updateAgentProfile(
        app.db,
        { projectSlug: SLUG, profileId: "developer", form: staleForm },
        actor,
        { dataRoot: app.dataRoot },
      ),
    ).rejects.toThrow("This profile changed while the editor was open.");
  });
});

/**
 * C4 (pass 34, U34-5): `invite_member` told the truth and took a role. It said
 * "new members join as contributor" while the writer pushed viewer, so live
 * three invites landed as Viewer and were repaired with `set_member_role` —
 * two writes and two audit rows per person.
 */
describe("invite_member seats the role it is given (C4)", () => {
  async function projectMd(): Promise<string> {
    const { resolveProjectFilePath } = await import("~/server/files/project-writer.server");
    const { readFileSync } = await import("node:fs");
    return readFileSync(resolveProjectFilePath({ projectSlug: SLUG, dataRoot: app.dataRoot }), "utf8");
  }

  it("seats the role in ONE write with one audit row and no role change", async () => {
    // Canary: hardcode `viewer` in the writer again.
    const before = listAuditEvents(app.db, { action: "project.member.role_changed" }).length;
    const reply = await call(ids.projectAdmin, "invite_member", {
      name: "Seated Contributor",
      email: "seated-contributor@viberr.test",
      role: "contributor",
    });
    expect(reply).toContain("[done]");
    expect(reply).toContain("joins as Contributor");
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const { findUserByEmail } = await import("~/server/auth/user-store.server");
    const seated = findUserByEmail(app.db, "seated-contributor@viberr.test")!;
    const member = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
      .parsed.frontmatter.members.find((m) => m.userId === seated.id)!;
    expect(member.role).toBe("contributor");
    const invited = listAuditEvents(app.db, { action: "project.member.invited" })[0]!;
    expect(invited.details).toMatchObject({ email: "seated-contributor@viberr.test", role: "contributor" });
    expect(listAuditEvents(app.db, { action: "project.member.role_changed" })).toHaveLength(before);
  });

  it("no role lands as viewer, and the description no longer promises contributor", async () => {
    const reply = await call(ids.projectAdmin, "invite_member", {
      name: "Unstated Seat",
      email: "unstated-seat@viberr.test",
    });
    expect(reply).toContain("joins as Viewer");
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const { findUserById } = await import("~/server/auth/user-store.server");
    const user = findUserById(app.db, ids.projectAdmin)!;
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: user.id, email: user.email, name: user.name },
      projectSlug: SLUG,
    });
    const def = toolkit.tools.find((t) => t.name === "invite_member")!;
    expect(def.description).not.toContain("join as contributor");
    expect(def.description).toContain("members join as viewer unless you give one");
  });

  it("an unknown role is refused by name, with project.md byte-identical", async () => {
    // Canary: drop the `z.enum` parse in inviteMember — the call answers
    // [done] and project.md carries an `owner` member row the tolerant parse
    // then drops silently.
    const before = await projectMd();
    const reply = await call(ids.projectAdmin, "invite_member", {
      name: "Impossible Seat",
      email: "impossible-seat@viberr.test",
      role: "owner",
    });
    expect(reply).toContain("[error] Unknown project role.");
    expect(await projectMd()).toBe(before);
  });
});

/**
 * C5 (pass 34, U34-4): a write the controller made for a person reads, on the
 * Activity audit column, as that person via the controller — the disclosure
 * ruling 99(b) requires, which this column used to drop.
 */
describe("a controller write discloses its instrument on Activity (C5)", () => {
  it("renders the person, named, with the instrument", async () => {
    // Canary: revert the audit column to `row.actor_name ?? …`.
    const reply = await call(ids.projectAdmin, "update_project_settings", {
      description: "Set through the controller for the instrument case.",
    });
    expect(reply).toContain("[done]");
    const { listAuditLog } = await import("~/server/projections/activity-feed.server");
    const rows = listAuditLog(app.db, SLUG, { limit: 20 });
    const instrumented = rows.filter((r) => r.text.includes("(via the controller)"));
    expect(instrumented.length).toBeGreaterThan(0);
    const { findUserById } = await import("~/server/auth/user-store.server");
    const elif = findUserById(app.db, ids.projectAdmin)!;
    expect(instrumented[0]!.text).toContain(`${elif.name} (via the controller)`);
  });
});

/**
 * Pass 34 review (ruling 139, the read/write pairing): `update_agent_deployment`
 * used to seed its form from the RAW stored grants, so `grantsFor` materialised
 * every ABSENT id at its CATALOG default — an unrelated patch armed capabilities
 * the deployment had withheld. Live in the review: `comment-on-task: off` on the
 * seeded Reviewer stored `execute-code-or-write-repo`, `create-task-branch` and
 * `open-review-pr` as `direct`.
 */
describe("update_agent_deployment never arms a capability it was not asked to", () => {
  it("an unrelated patch leaves every withheld write grant withheld", async () => {
    // Canary: seed `caps` from `deployment.capabilities` again.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const stored = () =>
      readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
        .parsed.frontmatter.agents.find((a) => a.profileId === "reviewer")!.capabilities;
    const modeOf = (id: string) => stored().find((g) => g.capabilityId === id)?.mode ?? "absent";
    // The seeded Reviewer stores none of the three write grants.
    for (const id of ["execute-code-or-write-repo", "create-task-branch", "open-review-pr"]) {
      expect(modeOf(id)).toBe("absent");
    }
    const reply = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "reviewer",
      capabilities: [{ capabilityId: "comment-on-task", mode: "off" }],
    });
    expect(reply).toContain("[done]");
    expect(modeOf("comment-on-task")).toBe("off");
    // The point: none of the three became actionable.
    for (const id of ["execute-code-or-write-repo", "create-task-branch", "open-review-pr"]) {
      expect(modeOf(id), `${id} must not be armed by an unrelated patch`).toBe("off");
    }
  });
});

/**
 * Pass 34 review, the same class as ruling 139's refusals: a setting the write
 * cannot keep is refused by name instead of answering `[done]`.
 */
describe("update_agent_deployment refuses a setting the deployment cannot hold", () => {
  it("autonomy on a SPECIALIST is refused, and nothing is written", async () => {
    // Canary: drop the kind check — the call answers [done] for a value
    // `updateAgentProfile` writes only for the operator.
    const { resolveProjectFilePath } = await import("~/server/files/project-writer.server");
    const { readFileSync } = await import("node:fs");
    const path = resolveProjectFilePath({ projectSlug: SLUG, dataRoot: app.dataRoot });
    const before = readFileSync(path, "utf8");
    const reply = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      autonomy: "full",
    });
    expect(reply).toContain("[error] autonomy is an operator setting");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
