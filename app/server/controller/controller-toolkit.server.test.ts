import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
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
    after = JSON.parse(await call(ids.maintainer, "get_goal", { goalId })) as { links: { blockedBy: string[] }[] };
    expect(after.links[1]!.blockedBy).toEqual([]);
    // SAFETY: `list_goals` maps every link to `{index, title, status, taskKey, blockedBy}`.
    const listed = JSON.parse(await call(ids.maintainer, "list_goals", {})) as { id: string; links: { blockedBy: string[] }[] }[];
    expect(listed.find((g) => g.id === goalId)!.links.map((l) => l.blockedBy)).toEqual([[], []]);
    // add_link with a wait.
    expect(await call(ids.maintainer, "update_goal", { goalId, op: "add_link", title: "Third", goal: "Third thing.", blockedBy: ["VIB-148"] })).toContain("[done] Link 3 added.");
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
