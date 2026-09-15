import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listAuditEvents } from "../../../test-support/audit-log";
import { toolLoading } from "../../../test-support/mcp-tool-meta";
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
    // Ruling 153 (pass 35, G35-1): the wall-clock half of setting a project
    // up. Canary: remove either `add(` registration.
    expect(names).toContain("schedule_task_action");
    expect(names).toContain("cancel_task_schedule");
  });

  it("stays deferred behind ToolSearch: loading 40+ tools up front costs more than the hop (Option D PR 4(a))", async () => {
    // Measured 2026-09-11 on the pinned SDK: alwaysLoad saved the controller a
    // turn but tripled turn 1's prompt and quadrupled a cold turn's cost.
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
      projectSlug: SLUG,
    });
    const loading = toolLoading(toolkit.mcpServers.viberr_controller);
    expect(loading.loaded).toEqual([]);
    expect(loading.deferred).toHaveLength(toolkit.tools.length);
  });
});

/**
 * Ruling 251 (pass 37, F37-80): the human-decision boundary stays, and stops
 * being a dead end.
 *
 * Live, the owner told the controller "I want to lean on you to finish this
 * clone rather than clicking through task pages myself". It answered, twice and
 * correctly, that it could do nothing: "Resolving it is yours on the task page
 * — I have no tool for packet resolution", and "I tried to withdraw it; it was
 * raised by the policy engine, so only you can close it." Both true, neither
 * actionable — nothing let it even SEE what was waiting without calling
 * `get_task` on a task someone already suspected.
 */
describe("list_decisions briefs the person and decides nothing (ruling 251)", () => {
  const PACKET_TASK = "VIB-142";

  async function openPacketOn(taskKey: string): Promise<void> {
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    await updateTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot }, (f) => {
      f.packet = {
        id: "pkt_test_001",
        type: "input",
        kind: "Decision required",
        from: "policy-engine",
        title: "Code Reviewer has requested changes 2 times running",
        body: "Two rounds is where another rework stops being the obvious move.",
        observations: [],
        options: [
          {
            kind: "question_reviewer",
            t: "Ask Code Reviewer what else it would block on",
            d: "One question, no rework behind it.",
            rec: true,
            profileId: "reviewer",
          },
          {
            kind: "custom",
            t: "Let the rework continue",
            d: "Hands the task back to the operator.",
            rec: false,
          },
        ],
      };
    });
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
  }

  async function clearPacket(taskKey: string): Promise<void> {
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    await updateTaskFile({ projectSlug: SLUG, taskKey, dataRoot: app.dataRoot }, (f) => {
      f.packet = null;
    });
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
  }

  it("still has no tool that ANSWERS a decision", async () => {
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
      projectSlug: SLUG,
    });
    const names = toolkit.tools.map((t) => t.name);
    // The owner's call (2026-09-15): brief and link, never decide. `list_` is
    // the whole permitted verb here.
    expect(names).toContain("list_decisions");
    expect(names.filter((n) => /resolve_packet|answer_packet|decide/.test(n))).toEqual([]);
  });

  it("reads the packet's own options and hands over the link", async () => {
    await openPacketOn(PACKET_TASK);
    try {
      const out = JSON.parse(await call(ids.orgAdmin, "list_decisions"));
      const row = out.forYou.find(
        (d: { task: string; kind: string }) => d.task === PACKET_TASK && d.kind === "packet",
      );
      // CANARY: drop the `packet` block and the controller can say a decision
      // exists but not what it asks or what the choices are — which is the
      // state this ruling exists to end.
      expect(row).toBeTruthy();
      expect(row.packet.id).toBe("pkt_test_001");
      expect(row.packet.title).toContain("requested changes 2 times running");
      expect(row.packet.options).toEqual([
        {
          n: 1,
          kind: "question_reviewer",
          title: "Ask Code Reviewer what else it would block on",
          detail: "One question, no rework behind it.",
          recommended: true,
        },
        {
          n: 2,
          kind: "custom",
          title: "Let the rework continue",
          detail: "Hands the task back to the operator.",
          recommended: false,
        },
      ]);
      // The one thing the tool exists to give a person.
      expect(row.answerAt).toBe(`projects/${SLUG}/tasks/${PACKET_TASK}`);
      expect(out.howToAnswer).toContain("answerAt");
    } finally {
      await clearPacket(PACKET_TASK);
    }
  });

  /**
   * Ruling 271 (pass 37, F37-103): the card ALWAYS offers one more answer than
   * the packet stores — a free-text directive, composed with the fixed choices
   * as their last choice. This tool listed the stored options and nothing
   * else, so the one tool whose job is to "brief the person fully" left out
   * the only answer that is always available. Live, the controller read a
   * packet whose recommended option said "You create the task — no option here
   * can", found (correctly) that a manual operator run is refused while a
   * packet is open, and reported a deadlock: "there is no way to say 'these
   * options are wrong' except to pick one of them." There was; it was the
   * choice under the ones it could see.
   */
  it("briefs the free-text answer the card always offers (ruling 271)", async () => {
    await openPacketOn(PACKET_TASK);
    try {
      const out = JSON.parse(await call(ids.orgAdmin, "list_decisions"));
      const row = out.forYou.find(
        (d: { task: string; kind: string }) => d.task === PACKET_TASK && d.kind === "packet",
      );
      // CANARY: drop `ownWords` and a person told "these are your options" is
      // told something untrue about the card in front of them.
      expect(row.packet.ownWords).toMatchObject({
        // Numbered where the card puts it: after the stored options, because
        // the reader has to find the same choice there.
        n: row.packet.options.length + 1,
        title: "Write your own directive",
      });
      expect(row.packet.ownWords.detail).toContain("instead of picking an option");
      expect(row.packet.ownWords.detail).toContain("options are wrong");
      // It is NOT a stored option kind and must never be relayed as one.
      expect(row.packet.options.map((o: { kind: string }) => o.kind)).not.toContain("own_words");
      expect(row.packet.ownWords.kind).toBeUndefined();
    } finally {
      await clearPacket(PACKET_TASK);
    }
  });

  it("a viewer is told nothing is theirs, rather than shown someone else's inbox", async () => {
    await openPacketOn(PACKET_TASK);
    try {
      const out = JSON.parse(await call(ids.viewer, "list_decisions"));
      // CANARY: read the packets straight off the projection instead of
      // through `decisionsRequiring` and a viewer sees the whole board's
      // decisions listed as waiting on them.
      expect(out.forYou).toEqual([]);
      expect(out.onlyViaOrgAdminOverride).toEqual([]);
      expect(out.howToAnswer).toContain("Nothing is waiting");
    } finally {
      await clearPacket(PACKET_TASK);
    }
  });

  it("an org admin outside the project gets it as OVERRIDE reach, never as their inbox", async () => {
    await openPacketOn(PACKET_TASK);
    try {
      const out = JSON.parse(await call(ids.orgAdminOutsider, "list_decisions"));
      // `decisionsRequiring` draws this line and the tool must not blur it:
      // reach as an org admin is not a personal inbox. CANARY: merge
      // `overrideEligible` into `forYou`.
      expect(out.forYou).toEqual([]);
      expect(
        out.onlyViaOrgAdminOverride.map((d: { task: string }) => d.task),
      ).toContain(PACKET_TASK);
    } finally {
      await clearPacket(PACKET_TASK);
    }
  });

  it("a non-member is refused without learning the project exists", async () => {
    await expect(
      call(ids.nonMember, "list_decisions", { projectSlug: SLUG }, null),
    ).resolves.toMatch(/\[denied\]/);
  });

  /**
   * Ruling 256 (pass 37, F37-86): the anchor belongs to the project it was
   * anchored IN.
   *
   * A conversation anchored to a task, asked about a DIFFERENT project, filtered
   * that project's decisions by a task key it does not contain and answered
   * "Nothing is waiting on a person here" — a false all-clear, from the one tool
   * whose entire job is to say what is waiting.
   */
  it("ruling 256: an anchored task never filters another project's decisions", async () => {
    await openPacketOn(PACKET_TASK);
    try {
      const { buildControllerToolkit } = await import("./controller-toolkit.server");
      const { findUserById } = await import("~/server/auth/user-store.server");
      const user = findUserById(app.db, ids.orgAdmin)!;
      const read = async (
        bound: { projectSlug: string | null; taskKey: string | null },
        args: Record<string, JsonValue>,
      ) => {
        const toolkit = buildControllerToolkit({
          db: app.db,
          ctx: { dataRoot: app.dataRoot },
          user: { id: user.id, email: user.email, name: user.name },
          projectSlug: bound.projectSlug,
          taskKey: bound.taskKey,
        });
        const tool = toolkit.tools.find((t) => t.name === "list_decisions")!;
        // SAFETY: every toolkit handler returns the `textResult` shape.
        const result = (await tool.handler(args, {})) as { content: { text: string }[] };
        return JSON.parse(result.content[0]!.text);
      };

      // Anchored to VIB-1 in THIS project: the anchor applies, and VIB-142's
      // packet is correctly filtered out.
      const anchored = await read({ projectSlug: SLUG, taskKey: "VIB-1" }, {});
      expect(anchored.forYou).toEqual([]);
      expect(anchored.howToAnswer).toContain("Nothing is waiting");

      // Same conversation, asked about a project it is NOT anchored in. The
      // anchor belongs to the project it was anchored in, so it must not filter
      // here — and VIB-142's packet is waiting.
      //
      // CANARY: drop the `explicit === boundSlug` guard and this reads
      // "Nothing is waiting on a person here": a false all-clear from the one
      // tool whose entire job is to say what is waiting.
      const elsewhere = await read(
        { projectSlug: "some-other-board", taskKey: "VIB-1" },
        { projectSlug: SLUG },
      );
      expect(elsewhere.forYou.map((d: { task: string }) => d.task)).toContain(PACKET_TASK);
      expect(elsewhere.howToAnswer).toContain("answerAt");
    } finally {
      await clearPacket(PACKET_TASK);
    }
  });

  /**
   * Ruling 256 (F37-85): `get_project` reads leases the way the GATES read them.
   *
   * Ruling 247 made a lease whose holder has finished bind nobody, and wired it
   * into the push and the canonical anchor — not into the read the controller
   * uses. Live, the controller said so itself: "I cannot tell you from a direct
   * read whether SHOP-11's lease had already self-released when it merged."
   */
  it("ruling 256: get_project resolves leases and names the spent ones apart", async () => {
    const { updateProjectFile, readProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { rebuildProject } = await import("~/server/projections/rebuilder.server");
    const before = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
      .parsed.frontmatter.fileLeases;
    await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
      p.frontmatter.fileLeases = [
        { paths: ["pnpm-lock.yaml"], taskKey: "VIB-142", reason: "still working" },
        { paths: ["Makefile"], taskKey: "VIB-404", reason: "holder does not exist" },
      ];
    });
    rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    try {
      const view = JSON.parse(await call(ids.orgAdmin, "get_project"));
      // CANARY: return `fm.fileLeases` raw and BOTH rows appear as binding,
      // which is what made the controller unable to tell live leases from spent
      // ones.
      expect(view.fileLeases.map((l: { taskKey: string }) => l.taskKey)).toEqual(["VIB-142"]);
      expect(view.spentFileLeases.map((l: { taskKey: string }) => l.taskKey)).toEqual(["VIB-404"]);
    } finally {
      await updateProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot }, (p) => {
        p.frontmatter.fileLeases = before ?? [];
      });
      rebuildProject(app.db, SLUG, { dataRoot: app.dataRoot });
    }
  });
});

/**
 * Ruling 153 (pass 35, G35-1): the controller had no schedule tool at all, so
 * the one agent meant to set a project up could not do the wall-clock half of
 * it ("There is no scheduling tool in my set"). Both tools take the tier the
 * task page's schedule form needs (`run-agents`, maintainer+).
 */
describe("schedule_task_action and cancel_task_schedule (ruling 153)", () => {
  interface TaskRead {
    schedules: { id: string; action: string; status: string; profileId: string | null }[];
  }

  it("a maintainer schedules an operator re-run; the entry is on task.md with the controller label; a viewer is refused", async () => {
    const denied = await call(ids.viewer, "schedule_task_action", {
      taskKey: "VIB-142",
      agent: "operator",
      delayMinutes: 5,
    });
    expect(denied).toBe(
      "[denied] Scheduling a run needs the maintainer role (or project admin) in this project.",
    );

    const reply = await call(ids.maintainer, "schedule_task_action", {
      taskKey: "VIB-142",
      agent: "operator",
      delayMinutes: 5,
      prompt: "Re-check the review.",
    });
    expect(reply).toMatch(
      // The id's alphabet is base64url (`newId`), so `-` and `_` are legal.
      /^\[done\] Scheduled: an operator re-run on VIB-142 at \d{4}-\d{2}-\d{2}T[^ ]+ \(sch_[A-Za-z0-9_-]+\)\. It runs on the profile deployed when it fires\.$/,
    );
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const file = readTaskFile({ projectSlug: SLUG, taskKey: "VIB-142", dataRoot: app.dataRoot })!;
    const entry = file.parsed.frontmatter.schedules.find((s) => s.status === "pending")!;
    expect(entry).toMatchObject({
      action: "run-operator",
      status: "pending",
      profileId: null,
      prompt: "Re-check the review.",
    });
    expect(entry.createdByLabel).toContain("via controller");
    const audit = listAuditEvents(app.db, { action: "task.schedule.created" })[0]!;
    expect(audit).toMatchObject({ taskKey: "VIB-142", details: { scheduleId: entry.id } });
    expect(audit.actorLabel).toContain("via controller");

    // get_task lists the pending entry (ruling 153).
    // SAFETY: the tool answers the JSON it built; `schedules` is its own field.
    const read = JSON.parse(await call(ids.maintainer, "get_task", { taskKey: "VIB-142" })) as TaskRead;
    expect(read.schedules.map((s) => s.id)).toContain(entry.id);

    // Cancel: done once, noop after.
    expect(
      await call(ids.maintainer, "cancel_task_schedule", { taskKey: "VIB-142", scheduleId: entry.id }),
    ).toBe(`[done] Schedule ${entry.id} on VIB-142 cancelled.`);
    expect(
      await call(ids.maintainer, "cancel_task_schedule", { taskKey: "VIB-142", scheduleId: entry.id }),
    ).toBe(`[noop] ${entry.id} is not pending on VIB-142.`);
    expect(listAuditEvents(app.db, { action: "task.schedule.cancelled" })[0]).toMatchObject({
      taskKey: "VIB-142",
      details: { scheduleId: entry.id },
    });
    // SAFETY: the same tool, the same `schedules` field it built.
    const after = JSON.parse(await call(ids.maintainer, "get_task", { taskKey: "VIB-142" })) as TaskRead;
    expect(after.schedules.map((s) => s.id)).not.toContain(entry.id);
  });

  it("keeps the task page's bounds and schedules a deployed agent by name", async () => {
    expect(
      await call(ids.maintainer, "schedule_task_action", { taskKey: "VIB-142", agent: "operator" }),
    ).toBe("[error] Schedule between 1 minute and 28 days out.");
    expect(
      await call(ids.maintainer, "schedule_task_action", {
        taskKey: "VIB-142",
        agent: "operator",
        delayMinutes: 1e15,
      }),
    ).toBe("[error] Schedule between 1 minute and 28 days out.");
    expect(
      await call(ids.maintainer, "schedule_task_action", {
        taskKey: "VIB-142",
        agent: "operator",
        dueAt: new Date(Date.now() + 2 * 60_000).toISOString(),
        prompt: "x".repeat(4001),
      }),
    ).toBe("[error] Keep the run prompt under 4000 characters.");
    const agent = await call(ids.maintainer, "schedule_task_action", {
      taskKey: "VIB-142",
      agent: "developer",
      dueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      prompt: "Implement the change.",
    });
    expect(agent).toMatch(/^\[done\] Scheduled: a Developer run on VIB-142 at /);
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const file = readTaskFile({ projectSlug: SLUG, taskKey: "VIB-142", dataRoot: app.dataRoot })!;
    const entry = file.parsed.frontmatter.schedules.find(
      (s) => s.status === "pending" && s.action === "run-agent",
    )!;
    expect(entry.profileId).toBe("developer");
    await call(ids.maintainer, "cancel_task_schedule", { taskKey: "VIB-142", scheduleId: entry.id });
    // A profile nobody deployed is refused by the writer's own sentence.
    expect(
      await call(ids.maintainer, "schedule_task_action", {
        taskKey: "VIB-142",
        agent: "ghost-profile",
        delayMinutes: 5,
      }),
    ).toContain('"ghost-profile" is not deployed on this project.');
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

  /**
   * Ruling 252 (pass 37, F37-81). Ruling 214 gave the OPERATOR this sentence
   * after it put a completeness question to "@Code Reviewer" in a comment that
   * no reviewer ever read, and the stranded backstop paused a task five others
   * were waiting behind. The controller had the identical hazard and none of
   * the disclosure — live on SHOP-26 it wrote "@operator @platform-architect
   * The funded amendment now exists as a task", then "Two standing facts for
   * the implementation run", and closed with nothing but "Posted by the
   * controller for Arda". The same words typed by that person on the task page
   * DO reach the agent.
   */
  it("comment_on_task: an @tagged AGENT is disclosed as unreached (ruling 252)", async () => {
    await call(ids.projectAdmin, "comment_on_task", {
      taskKey: "VIB-142",
      text: "@reviewer Two standing facts for your next pass on this task.",
    });
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: drop the `unreachedAgentNote` arm from `postAgentComment` and the
    // tag goes nowhere in silence, which is the live shape.
    expect(top.text).toContain("is an agent, and a controller comment starts no run");
    expect(top.text).toContain("nothing was sent to it");
    // Named as the controller's OWN tool, so the sentence is actionable by the
    // reader it is addressed to rather than a generic instruction.
    expect(top.text).toContain("run_agent_on_task");
  });

  /**
   * Ruling 262 (pass 37, F37-92). This is the LIVE text from SHOP-26 that
   * motivated ruling 252 — and under ruling 252 alone it still carried no
   * stamp. `resolveMentionedAgent` answers "which ONE agent would a run go
   * to", and `@operator` is precedence 1, so it returned the operator, the
   * stamp was skipped for being the operator, and @platform-architect was
   * never mentioned. A ruling has to fix the case it was written for.
   */
  it("comment_on_task: @operator alongside an agent still discloses the agent (ruling 262)", async () => {
    await call(ids.projectAdmin, "comment_on_task", {
      taskKey: "VIB-142",
      text: "@operator @reviewer The funded amendment now exists as a task.",
    });
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: resolve the stamp through `resolveMentionedAgent` again and this
    // goes back to silence, which is the shape that shipped live.
    expect(top.text).toContain("@reviewer is an agent");
    expect(top.text).toContain("nothing was sent to it");
    // The operator is still excluded by name (ruling 214): a controller turn's
    // other writes wake it on their own.
    expect(top.text).not.toContain("@operator is an agent");
  });

  it("comment_on_task: EVERY tagged agent is named, not the first (ruling 262)", async () => {
    await call(ids.projectAdmin, "comment_on_task", {
      taskKey: "VIB-142",
      text: "@reviewer @developer both of you should see the amendment.",
    });
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: swap `specialists.filter` back to `.find` in `unreachedAgents`
    // and the second agent drops out of a sentence that claims to list them.
    expect(top.text).toContain("@reviewer, @developer are agents");
    expect(top.text).toContain("nothing was sent to them");
  });

  it("comment_on_task: a comment that tags only PEOPLE carries no such note", async () => {
    await call(ids.projectAdmin, "comment_on_task", {
      taskKey: "VIB-142",
      text: "@Arda status published, nothing needed from an agent here.",
    });
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: stamp the note unconditionally and every ordinary status comment
    // grows a paragraph telling a person an agent was not reached, on a
    // comment that named no agent.
    expect(top.text).not.toContain("starts no run");
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

  /**
   * Ruling 263 (pass 37, F37-93). The tool's own description promises it
   * "reports honestly whether a run started", and it answered `[done] … run
   * started on VIB-142 (codex)` for a dispatch that started nothing: the task
   * owner has no Codex account, so ruling 127 turns the dispatch into a run ROW
   * recording the refusal and no process at all. The person reading the
   * controller was told work had begun; the board showed an errored run.
   */
  it("run_agent_on_task: a refused run is reported as refused, with the reason (ruling 263)", async () => {
    const reply = await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "developer",
      prompt: "Pick this up and report what you find.",
    });
    // CANARY: return `[done] … run started` unconditionally again (drop the
    // `outcome` arms) and this reads as work that began.
    expect(reply).toContain("[refused]");
    expect(reply).not.toContain("run started");
    // The reason is the run's own sentence, not a restatement: the owner has no
    // Codex account and this task's runs bill the owner (ruling 127).
    expect(reply).toContain("the task owner");
    expect(reply).toContain("Run it again once that is resolved.");
  });

  /**
   * Ruling 263's second half: R21-9's law on the one dispatch door that skipped
   * it. The task page writes `@<agent> <prompt>` after the start and the
   * operator's `run_agent` writes one before it; through the controller the
   * directive went into the agent's prompt and nowhere else, so the timeline
   * showed a run appearing for no stated reason.
   */
  it("run_agent_on_task: the directive is recorded on the timeline (ruling 263)", async () => {
    await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "developer",
      prompt: "Pick this up and report what you find.",
    });
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const top = readTaskFile({
      projectSlug: SLUG,
      taskKey: "VIB-142",
      dataRoot: app.dataRoot,
    })!.parsed.timeline[0]!;
    // CANARY: drop the `appendComment` call and the directive exists only
    // inside the agent's prompt, where supervision cannot read it.
    expect(top.type).toBe("comment");
    expect(top.text).toBe("@Developer Pick this up and report what you find.");
    // Addressed to the agent (the routed tint), and authored by the PERSON
    // whose directive it is — the controller relayed it, it did not write it.
    expect(top.toAgent).toBe(true);
    expect(top.actor).toMatchObject({ kind: "human", userId: ids.maintainer });
  });

  /**
   * Ruling 272 (pass 37, F37-105): ruling 263 put R21-9's law on the SPECIALIST
   * arm of `run_agent_on_task` and returned above it for the operator, so the
   * one dispatch door still sending a human's words off the record was the
   * operator half of the door ruling 263 had just fixed. The controller caught
   * it three minutes after the deploy by counting the task's own comments
   * across two reads: "my directive is nowhere in the +1".
   */
  it("run_agent_on_task: an OPERATOR directive is recorded too, not just a specialist's (ruling 272)", async () => {
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const handOffs = (key: string): string[] =>
      readTaskFile({ projectSlug: SLUG, taskKey: key, dataRoot: app.dataRoot })!
        .parsed.timeline.filter(
          (e) => e.type === "comment" && e.text.trim().startsWith("@operator"),
        )
        .map((e) => e.text);
    // VIB-148 carries no decision packet, so the operator run is not refused.
    const before = handOffs("VIB-148").length;
    await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-148",
      agent: "operator",
      prompt: "Check in on this task and say what is blocking it.",
    });
    const after = handOffs("VIB-148");
    // CANARY: return above the appendComment for the operator arm again (as
    // ruling 263 shipped) and the directive exists only inside the operator's
    // prompt, where nobody watching the task can read it.
    expect(after.length).toBe(before + 1);
    expect(after[0]).toBe("@operator Check in on this task and say what is blocking it.");

    // …and a REFUSED run strands no comment: VIB-142 has an open packet, so
    // the operator is not run and there is nothing for a directive to address.
    // Two things hold this: the refusal arms return before the write, and the
    // write's own `!result.refused` guard. Either alone is enough today, which
    // is why this pins the OUTCOME rather than one mechanism — remove both and
    // a refused dispatch leaves an "@operator …" hand-off with no run behind
    // it, the orphaned hand-off `operatorPromptAgent` learned to avoid.
    const refusedBefore = handOffs("VIB-142").length;
    const denied = await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "operator",
      prompt: "This one cannot start.",
    });
    expect(denied).toContain("[denied]");
    expect(handOffs("VIB-142").length).toBe(refusedBefore);
  });

  it("run_agent_on_task: a dispatch with no directive writes no hand-off comment", async () => {
    const { readTaskFile } = await import("~/server/files/task-writer.server");
    const handOffsNow = (): unknown[] =>
      readTaskFile({
        projectSlug: SLUG,
        taskKey: "VIB-142",
        dataRoot: app.dataRoot,
      })!.parsed.timeline.filter(
        (e) => e.type === "comment" && e.text.trim().startsWith("@Developer"),
      );
    // Sibling tests in this describe share the task, so measure the DELTA.
    const before = handOffsNow().length;
    await call(ids.maintainer, "run_agent_on_task", {
      taskKey: "VIB-142",
      agent: "developer",
    });
    // CANARY: append the comment unconditionally and a bare re-run grows an
    // empty "@Developer" line addressed to nobody about nothing. (The refused
    // run writes its OWN lines here, so this counts hand-off comments rather
    // than events.)
    expect(handOffsNow().length).toBe(before);
  });

  /**
   * Ruling 266 (pass 37, F37-96). Asked to say whether three open PRs should
   * merge, the controller had `get_task`'s filename list and
   * `changed: {files: 4, add: 1528, del: 67}` and nothing else, and said so:
   * "my judgement on PR #32 rests on a four-line filename list… I can
   * commission a review; I cannot check one."
   */
  it("read_pull_request: membership gated, and a task with no PR says so rather than erroring", async () => {
    const denied = await call(ids.nonMember, "read_pull_request", { taskKey: "VIB-142" });
    // The members-only posture (R15-4): a non-member must not learn the
    // project exists, so the gate answers before the task is resolved.
    expect(denied).toContain("is visible to you");
    // CANARY: drop the `revisionLeftWorkspace` arm and a task with no PR
    // reaches GitHub with a bogus number and comes back as an [error] about a
    // request nobody should have made. VIB-148 has none.
    const none = await call(ids.projectAdmin, "read_pull_request", { taskKey: "VIB-148" });
    expect(none).toContain("[noop]");
    expect(none).toContain("has no pull request to read");
    expect(none).toContain("prNumber");
    // VIB-142 carries PR #318, so the resolution reaches GitHub and stops on
    // the fixture's real obstacle — named, with the PR it resolved, rather
    // than a bare failure. (This project has no credential configured.)
    const configured = await call(ids.projectAdmin, "read_pull_request", { taskKey: "VIB-142" });
    expect(configured).toContain("VIB-142 (#318)");
    expect(configured).toContain("no GitHub credential is configured");
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
      persona: string;
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

  /**
   * Ruling 264 (pass 37, F37-94): the deploy reply says which delivery posture
   * it stored, because since ruling 156 the deploy COPIES the template's own
   * grants. Live, the shipped `developer` template carries
   * `execute-code-or-write-repo: direct`, so every deploy of it produced a
   * profile that can push to the repo under a reply promising the opposite.
   */
  it("ruling 264: deploy_agent reports the delivery the template actually carries", async () => {
    // A template with repo write. `save_global_agent` has no capability field,
    // so the grants have to be written the way a shipped template carries them.
    writeFileSync(
      path.join(app.dataRoot, "agents", "profiles", "delivery-probe.md"),
      [
        "---",
        "id: delivery-probe",
        "kind: specialist",
        "name: Delivery Probe",
        "role: Implementation",
        "backends:",
        "  - claude",
        "model: sonnet",
        "stages:",
        "  - impl",
        "resources:",
        "  skills: []",
        "  mcps: []",
        "  kb: []",
        "capabilities:",
        "  - capabilityId: execute-code-or-write-repo",
        "    mode: direct",
        "---",
        "",
        "A probe.",
        "",
      ].join("\n"),
      "utf8",
    );
    const deployed = await call(ids.projectAdmin, "deploy_agent", {
      profileId: "delivery-probe",
    });
    // CANARY: restore the unconditional "Delivery starts withheld" tail and
    // this reads as a profile that cannot touch the repo, on one that can.
    expect(deployed).toContain("[done] Delivery Probe deployed");
    expect(deployed).toContain("It carries repo write from the template");
    expect(deployed).not.toContain("Delivery starts withheld");
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

  /**
   * Ruling 153 (pass 35, G35-2): the template's default model and effort are
   * settable here, checked by name (ruling 139), and the reply states what a
   * deploy will take. U35-1: the name is stored as the person meant it.
   * Canary: drop `model`/`effort` from the `SaveGagentInput` the tool builds.
   */
  it("ruling 153 / U35-1: sets the template's model and effort by name, and decodes the name", async () => {
    const created = await call(ids.orgAdmin, "save_global_agent", {
      name: "Test &amp; CI Engineer",
      backend: "codex",
      summary: "Runs the suite on Astra.",
      stages: ["impl"],
      model: "gpt-6-astra",
      effort: "medium",
    });
    expect(created).toContain("[done] Test & CI Engineer created.");
    expect(created).toContain("Template defaults: Codex, model gpt-6-astra, effort medium.");
    const rows = await listJson<{ id: string; name: string; model: string; effort: string }>(
      "list_global_agents",
    );
    expect(rows.find((r) => r.id === "test-ci-engineer")).toMatchObject({
      name: "Test & CI Engineer",
      model: "gpt-6-astra",
      effort: "medium",
    });
    const refused = await call(ids.orgAdmin, "save_global_agent", {
      id: "test-ci-engineer",
      name: "Test & CI Engineer",
      backend: "codex",
      summary: "Runs the suite on Astra.",
      stages: ["impl"],
      effort: "ultra",
    });
    expect(refused).toContain('[error] "ultra" is not an effort tier Codex offers');
    expect(
      await call(ids.orgAdmin, "save_global_agent", {
        name: "<b>Bold</b>",
        backend: "codex",
        summary: "s",
        stages: ["impl"],
      }),
    ).toBe("[error] Names cannot contain < or > or control characters.");
  });

  /**
   * Ruling 156 (pass 35, F35-7): a library deploy COPIES the template's grants
   * onto `project.md` and a run mounts that copy, so a template grant never
   * reached a deployed project and the tool answered a bare `[done]`. The reply
   * is built from the result now: it names every copy that differs, what it
   * lacks, and the two doors. Canary: return the bare toast from the tool.
   */
  it("ruling 156: names the diverged copy and how to update it, then copies the grants with propagate: true", async () => {
    interface ProjectRead {
      agents: {
        profileId: string;
        resources: { skills: string[]; mcps: string[]; kb: string[] };
        templateDrift: { missing: { mcps: string[] } } | null;
      }[];
    }
    const deployed = await call(ids.projectAdmin, "deploy_agent", { profileId: AGENT_ID });
    expect(deployed).toContain("[done] Grant Probe Writer deployed");
    const base = {
      id: AGENT_ID,
      name: "Grant Probe Writer",
      backend: "claude",
      summary: "Writes and edits documentation files only.",
      stages: ["impl"],
    };
    const edited = await call(ids.orgAdmin, "save_global_agent", { ...base, mcps: [catalog.mcp.key] });
    expect(edited).toMatch(
      /^\[done\] Grant Probe Writer updated\. 1 project copy does not carry this change: viberr-core is missing MCP server grant-probe-server\. Call save_global_agent again with propagate: true/,
    );
    expect(edited).toContain("an org admin takes the template's grants on that project's Agents page");
    // SAFETY: the tool answers the JSON it built; the fields asserted are its own.
    const before = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    const copyBefore = before.agents.find((a) => a.profileId === AGENT_ID)!;
    expect(copyBefore.resources.mcps).toEqual([]);
    expect(copyBefore.templateDrift).toMatchObject({ missing: { mcps: ["grant-probe-server"] } });
    const listed = await listJson<{ id: string; copiesDiffering: string[] }>("list_global_agents");
    expect(listed.find((r) => r.id === AGENT_ID)?.copiesDiffering).toEqual(["viberr-core"]);

    const propagated = await call(ids.orgAdmin, "save_global_agent", {
      ...base,
      mcps: [catalog.mcp.key],
      propagate: true,
    });
    expect(propagated).toContain(
      "Grants copied to 1 project: viberr-core (added MCP server grant-probe-server).",
    );
    // SAFETY: the same tool answer, read after the propagation.
    const after = JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
    const copyAfter = after.agents.find((a) => a.profileId === AGENT_ID)!;
    expect(copyAfter.resources.mcps).toEqual(["grant-probe-server"]);
    expect(copyAfter.templateDrift).toBeNull();
    const listedAfter = await listJson<{ id: string; copiesDiffering: string[] }>("list_global_agents");
    expect(listedAfter.find((r) => r.id === AGENT_ID)?.copiesDiffering).toEqual([]);
    expect(await call(ids.orgAdmin, "save_global_agent", base)).toContain(
      "Every project copy carries the template's grants.",
    );
    const audit = listAuditEvents(app.db, { action: "project.agent_profile.resources_synced" })[0]!;
    expect(audit).toMatchObject({ projectSlug: SLUG, subjectId: AGENT_ID });
    expect(audit.actorLabel).toContain("via controller");
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
    expect(set).toMatch(new RegExp(`effort (\\S+|\\(none\\)) → ${top}`));
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
    expect(switched).toContain(`backend ${label[current]} → ${label[other]}`);
    expect(switched).toContain(`effort ${top} → ${otherDefault} (${label[other]} default: none given)`);
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

  // Ruling 153 (pass 35, G35-2): an omitted `effort` takes the TEMPLATE's tier,
  // not the backend default. The description is this door's only contract for
  // the model calling it, so it has to say the shipped rule.
  it("deploy_agent takes the template's own effort when none is given, and says so", async () => {
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const { findUserById } = await import("~/server/auth/user-store.server");
    const admin = findUserById(app.db, ids.projectAdmin)!;
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: admin.id, email: admin.email, name: admin.name },
      projectSlug: SLUG,
    });
    const def = toolkit.tools.find((t) => t.name === "deploy_agent")!;
    expect(def.description).not.toContain("the backend's default effort");
    expect(def.description).toContain("keep the template's own model and effort");

    const minted = await call(ids.orgAdmin, "save_global_agent", {
      name: "Tier Probe",
      backend: "claude",
      summary: "Carries a default effort of its own.",
      stages: ["impl"],
      effort: "max",
    });
    expect(minted).toContain("[done]");
    const deployed = await call(ids.projectAdmin, "deploy_agent", { profileId: "tier-probe" });
    expect(deployed).toContain("at effort max.");
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

/**
 * Ruling 183 (pass 36, F36-2): the controller's `save_skill` is one of the
 * SKILL.md writers `assertSkillBodyWellFormed` guards. Live, the model sent
 * the body JSON-escaped twice and the tool answered "[done] … SKILL.md
 * written." for a one-line file of literal `\n`.
 */
describe("save_skill refuses a body that is not a skill (ruling 183)", () => {
  it("an escaped body is refused by name and no skill lands", async () => {
    // Canary: drop the assert from saveSkill.
    const reply = await call(ids.orgAdmin, "save_skill", {
      name: "escaped-probe",
      summary: "A probe the escaped-body test sends.",
      body: "---\\nname: escaped-probe\\ndescription: Escaped.\\n---\\n# Escaped\\n- one",
    });
    expect(reply.startsWith("[error] ")).toBe(true);
    expect(reply).toContain("JSON-escaped");
    expect(reply).toContain("real newlines");
    // SAFETY: list_skills answers `json()` over rows carrying `name`.
    const skills = JSON.parse(await call(ids.orgAdmin, "list_skills")) as { name: string }[];
    expect(skills.map((s) => s.name)).not.toContain("escaped-probe");
  });

  it("a create with no body is refused instead of writing an empty SKILL.md", async () => {
    const reply = await call(ids.orgAdmin, "save_skill", {
      name: "bodiless-probe",
      summary: "A probe with no body at all.",
    });
    expect(reply.startsWith("[error] ")).toBe(true);
    expect(reply).toContain("empty");
  });
});

/**
 * U36-4 (pass 36): the create reply named the folder and hid the id, so the
 * controller guessed `disk:<dir>` — the one shape a folder with a row no
 * longer answered to — and was refused "already exists".
 */
describe("save_knowledge_base's reply carries the id the next call needs (U36-4)", () => {
  it("the create reply names the KB id and grant key, and both id shapes re-enter as an update", async () => {
    // Canary: render `saved.toast` alone again.
    const created = await call(ids.orgAdmin, "save_knowledge_base", { name: "Reply Probe Spec" });
    expect(created).toContain("[done]");
    const id = /id (kb_[A-Za-z0-9_-]+)/.exec(created)?.[1];
    expect(id, created).toBeDefined();
    expect(created).toContain("grantKey reply-probe-spec");
    const byId = await call(ids.orgAdmin, "save_knowledge_base", {
      id: id!,
      name: "Reply Probe Spec",
      refresh: "manual",
    });
    expect(byId).toContain("[done] Reply Probe Spec updated");
    expect(byId).toContain(`id ${id}`);
    // The shape shipped KBs carry, on a folder that already has a row.
    const byDisk = await call(ids.orgAdmin, "save_knowledge_base", {
      id: "disk:reply-probe-spec",
      name: "Reply Probe Spec",
      refresh: "on change",
    });
    expect(byDisk).toContain("[done] Reply Probe Spec updated");
    expect(byDisk).toContain(`id ${id}`);
    // SAFETY: list_knowledge_bases answers `json()` over rows carrying `id`,
    // `dir` and `refresh`.
    const kbs = JSON.parse(await call(ids.orgAdmin, "list_knowledge_bases")) as {
      id: string;
      dir: string;
      refresh: string;
    }[];
    const rows = kbs.filter((k) => k.dir === "reply-probe-spec");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, refresh: "on change" });
  });

  /**
   * Ruling 257 (pass 37, F37-88): a `doc` write REPLACES a whole file, so it
   * says so and refuses a silent clobber.
   *
   * `overwrite: true` was hardcoded, so `writeStoreDoc`'s own collision guard
   * could never fire and its `replaced` flag was discarded — the reply read
   * "Document conventions.md written" whether it created a file or destroyed
   * one. The HUMAN door for the same write refuses the collision unless a
   * replace confirmation says otherwise, and its toast says "replaced" or
   * "saved" from that same flag. Live, this is the ONLY way into an existing KB
   * (a no-id create is refused once the folder has a metadata row), and the
   * shopify-clone board's rulings KB — injected into every run on the project —
   * was one call away from erasure by a model writing the obvious filename.
   */
  it("ruling 257: a doc that would overwrite is refused, names itself, and says REPLACED when told to", async () => {
    const created = await call(ids.orgAdmin, "save_knowledge_base", {
      name: "Clobber Probe",
      doc: { path: "conventions.md", content: "ORIGINAL RULES, 20 bytes+" },
    });
    expect(created).toContain("saved (");
    expect(created).not.toContain("REPLACED");
    const id = /id (kb_[A-Za-z0-9_-]+)/.exec(created)![1]!;

    // The model can SEE the collision coming: names, not just a count.
    // CANARY: drop `documents` from list_knowledge_bases and the model has no
    // way to know the name it is about to write is taken.
    // SAFETY: `list_knowledge_bases` answers `json()` over rows that always
    // carry `id` and, since ruling 257, `documents`.
    const kbs = JSON.parse(await call(ids.orgAdmin, "list_knowledge_bases")) as {
      id: string;
      documents: string[];
    }[];
    expect(kbs.find((k) => k.id === id)!.documents).toContain("conventions.md");

    // …and it can read it, so a write can carry the text forward.
    // SAFETY: `read_knowledge_base_doc` answers `json()` over an object that
    // always carries `text` when it does not return a `[denied]` string, and the
    // document was just written by the call above.
    const read = JSON.parse(
      await call(ids.orgAdmin, "read_knowledge_base_doc", { id, path: "conventions.md" }),
    ) as { text: string };
    expect(read.text).toBe("ORIGINAL RULES, 20 bytes+");

    // Writing the same name WITHOUT `replace` is refused by the writer's own
    // sentence, and the original survives.
    // CANARY: restore `overwrite: true` and this call reports "[done] … written"
    // while the original is gone.
    const refused = await call(ids.orgAdmin, "save_knowledge_base", {
      id,
      name: "Clobber Probe",
      doc: { path: "conventions.md", content: "the model's new note" },
    });
    expect(refused).toContain("already exists");
    // SAFETY: same reader, same document, and the refusal above means it is
    // still there.
    const after = JSON.parse(
      await call(ids.orgAdmin, "read_knowledge_base_doc", { id, path: "conventions.md" }),
    ) as { text: string };
    expect(after.text).toBe("ORIGINAL RULES, 20 bytes+");

    // Told to replace, it does — and says what it destroyed.
    const replaced = await call(ids.orgAdmin, "save_knowledge_base", {
      id,
      name: "Clobber Probe",
      doc: { path: "conventions.md", content: "ORIGINAL RULES, 20 bytes+\n\nand the new note", replace: true },
    });
    expect(replaced).toContain("REPLACED");
    expect(replaced).toContain("previous 25 bytes are gone");
  });

  it("save_skill's reply carries the skill id and grant key the same way", async () => {
    const created = await call(ids.orgAdmin, "save_skill", {
      name: "reply-probe-craft",
      summary: "A probe the reply test creates.",
      body: "# Craft\n\nBody.",
    });
    expect(created).toContain("[done]");
    expect(created).toMatch(/id sk_[A-Za-z0-9_-]+/);
    expect(created).toContain("grantKey reply-probe-craft");
  });
});

/**
 * U36-3 (pass 36): one call switched backend, model, effort, stages and grants
 * and answered "Effort is now max." — the reply and the audit row under-reported
 * what changed. The reply lists every changed field old → new, and the
 * `project.agent_profile.updated` row carries model + effort (ruling 139 parity
 * with `deployed`).
 */
describe("update_agent_deployment reports every field it changed, old → new (U36-3)", () => {
  interface ProjectRead {
    stages: { id: string }[];
    agents: {
      profileId: string;
      backends: string[];
      model: string;
      effort: string;
      stages: string[];
    }[];
  }
  async function read(): Promise<ProjectRead> {
    // SAFETY: the tool answers the JSON it built; the fields asserted are its own.
    return JSON.parse(await call(ids.projectAdmin, "get_project")) as ProjectRead;
  }

  it("names backend, model, effort, stages and each capability with the value it replaced; the audit row carries model and effort", async () => {
    // Canary: answer `[done] ${name} updated on ${slug}.` again.
    const { defaultModelFor } = await import("~/server/runtimes/model-catalog.server");
    const snapshot = await read();
    const before = snapshot.agents.find((a) => a.profileId === "developer")!;
    const stageIds = snapshot.stages.map((s) => s.id);
    // A known starting point, whichever earlier case left the developer on.
    const first = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      backend: "claude",
      model: "sonnet",
      effort: "high",
      stages: [stageIds[0]!],
      capabilities: [{ capabilityId: "comment-on-task", mode: "off" }],
    });
    expect(first).toContain("[done]");
    const codexModel = defaultModelFor("codex");
    const reply = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      backend: "codex",
      effort: "max",
      stages: [stageIds[0]!, stageIds[1]!],
      capabilities: [{ capabilityId: "comment-on-task", mode: "direct" }],
    });
    expect(reply).toContain("[done] Developer updated on viberr-core");
    expect(reply).toContain("backend Claude → Codex");
    expect(reply).toContain(`model sonnet → ${codexModel}`);
    expect(reply).toContain("effort high → max");
    expect(reply).toContain(`stages ${stageIds[0]} → ${stageIds[0]}, ${stageIds[1]}`);
    expect(reply).toContain("comment-on-task off → direct");
    const row = listAuditEvents(app.db, { action: "project.agent_profile.updated" })[0]!;
    expect(row.details).toMatchObject({
      name: "Developer",
      backend: "codex",
      model: codexModel,
      effort: "max",
    });
    // The same call again changes nothing, and says so instead of restating
    // the request.
    const again = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      backend: "codex",
      effort: "max",
      capabilities: [{ capabilityId: "comment-on-task", mode: "direct" }],
    });
    expect(again).toContain("[done]");
    expect(again).toContain("No field changed");
    expect(again).not.toContain("→");
    // Restore the fixture for the cases after this one.
    await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: "developer",
      backend: before.backends[0] === "codex" ? "codex" : "claude",
      model: before.model,
      effort: before.effort || "high",
      stages: before.stages,
    });
  });
});

/**
 * U36-5 (pass 36): three descriptions said Codex effort is `low|medium|high|xhigh`
 * while the catalog offers `max`; the write succeeded and the controller told
 * the owner it could not confirm `max` is real. The tiers are read from the
 * catalog now.
 */
describe("the effort descriptions are generated from the catalog (U36-5)", () => {
  it("every tier each backend offers appears in save_global_agent, deploy_agent and update_agent_deployment", async () => {
    // Canary: type the Codex list by hand again.
    const { effortsFor } = await import("~/server/runtimes/model-catalog.server");
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: ids.orgAdmin, email: "arda@viberr.dev", name: "Arda" },
      projectSlug: SLUG,
    });
    for (const name of ["save_global_agent", "deploy_agent", "update_agent_deployment"]) {
      const def = toolkit.tools.find((t) => t.name === name)!;
      // SAFETY: `tool()` keeps the raw zod shape it was given, and `effort` is
      // the `z.string().optional().describe(…)` field each of the three declares.
      const declared = def.inputSchema as Record<string, { description?: string }>;
      const description = declared.effort?.description ?? "";
      for (const backend of ["claude", "codex"] as const) {
        const label = backend === "codex" ? "Codex" : "Claude";
        expect(description, `${name}.effort names the ${label} tiers`).toContain(
          `${label} ${effortsFor(backend).join("|")}`,
        );
      }
    }
  });
});

/**
 * G36-1 (pass 36, owner Q36-7): the Agents page grants context resources to
 * every kind, the operator included; the controller could not ("it's a system
 * profile I can't give resources to"). `update_agent_deployment` takes
 * `skills` / `mcps` / `kbs` with `save_global_agent`'s semantics for every kind.
 */
describe("update_agent_deployment grants resources to every kind, the operator included (G36-1)", () => {
  interface Resources {
    skills: string[];
    mcps: string[];
    kb: string[];
  }
  interface RosterRead {
    agents: { profileId: string; kind: string; resources: Resources }[];
  }
  let operatorId = "";
  let before: Resources = { skills: [], mcps: [], kb: [] };

  /** The reply's rendering of one list: the keys, or "(none)". */
  const listed = (keys: string[]) => (keys.length ? keys.join(", ") : "(none)");

  async function operatorResources(): Promise<Resources> {
    // SAFETY: the tool answers the JSON it built; the fields asserted are its own.
    const read = JSON.parse(await call(ids.projectAdmin, "get_project")) as RosterRead;
    return read.agents.find((a) => a.profileId === operatorId)!.resources;
  }

  beforeAll(async () => {
    // SAFETY: as above.
    const read = JSON.parse(await call(ids.projectAdmin, "get_project")) as RosterRead;
    const operator = read.agents.find((a) => a.kind === "operator")!;
    operatorId = operator.profileId;
    before = operator.resources;
    await call(ids.orgAdmin, "save_knowledge_base", { name: "Operator Grant Handbook" });
    await call(ids.orgAdmin, "save_skill", {
      name: "operator-grant-craft",
      summary: "A probe skill the operator grant test grants.",
      body: "# Craft\n\nBody.",
    });
  });

  afterAll(async () => {
    await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: operatorId,
      skills: before.skills,
      mcps: before.mcps,
      kbs: before.kb,
    });
  });

  it("grants by grantKey land on the operator's deployment, the reply names them old → new, an omitted list is left alone and [] clears", async () => {
    // Canary: drop `skills`/`mcps`/`kbs` from the tool (the handler ignores them).
    const granted = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: operatorId,
      kbs: ["operator-grant-handbook"],
      skills: ["operator-grant-craft"],
    });
    expect(granted).toContain("[done]");
    expect(granted).toContain(`kb ${listed(before.kb)} → operator-grant-handbook`);
    expect(granted).toContain(`skills ${listed(before.skills)} → operator-grant-craft`);
    expect(await operatorResources()).toMatchObject({
      kb: ["operator-grant-handbook"],
      skills: ["operator-grant-craft"],
      mcps: before.mcps,
    });
    // project.md carries the copy a run mounts (ruling 156), on the operator.
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    const stored = readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === operatorId)!.definition?.resources;
    expect(stored).toMatchObject({ kb: ["operator-grant-handbook"], skills: ["operator-grant-craft"] });
    // An unrelated patch leaves every list alone.
    const unrelated = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: operatorId,
      mcps: before.mcps,
    });
    expect(unrelated).toContain("[done]");
    expect(await operatorResources()).toMatchObject({
      kb: ["operator-grant-handbook"],
      skills: ["operator-grant-craft"],
    });
    const cleared = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: operatorId,
      kbs: [],
    });
    expect(cleared).toContain("kb operator-grant-handbook → (none)");
    expect(await operatorResources()).toMatchObject({ kb: [], skills: ["operator-grant-craft"] });
  });

  it("an unknown key is refused by name and nothing is written", async () => {
    // Canary: skip resolveResourceGrants and merge the raw list.
    const { resolveProjectFilePath } = await import("~/server/files/project-writer.server");
    const file = resolveProjectFilePath({ projectSlug: SLUG, dataRoot: app.dataRoot });
    const was = readFileSync(file, "utf8");
    const reply = await call(ids.projectAdmin, "update_agent_deployment", {
      profileId: operatorId,
      kbs: ["no-such-handbook"],
    });
    expect(reply.startsWith("[error] ")).toBe(true);
    expect(reply).toContain('Nothing in the store answers to knowledge base "no-such-handbook"');
    expect(readFileSync(file, "utf8")).toBe(was);
  });
});

/**
 * Ruling 178 (pass 36, G36-3): the controller could not declare a REQUIRED
 * reviewer — it could only state the rule in prompts. `set_required_reviewers`
 * replaces the project's whole list through the same writer the Settings form
 * uses, and `get_project` reports it beside the stages it names.
 */
describe("set_required_reviewers (ruling 178)", () => {
  async function rulesInFile() {
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    return readProjectFile({ projectSlug: SLUG, dataRoot: app.dataRoot })!.parsed.frontmatter.requiredReviewers;
  }
  afterAll(async () => {
    await call(ids.projectAdmin, "set_required_reviewers", { rules: [] });
  });

  it("round-trips the list into project.md, get_project lists it, and [] clears it", async () => {
    // Canary: remove the `add(` registration.
    const reply = await call(ids.projectAdmin, "set_required_reviewers", {
      rules: [{ stageId: "review", profileId: "reviewer" }],
    });
    expect(reply).toBe("[done] Required reviewers saved: Reviewer at Review.");
    expect(await rulesInFile()).toEqual([{ stageId: "review", profileId: "reviewer" }]);
    // SAFETY: `get_project` answers `json(...)` of an object literal that
    // always carries `requiredReviewers`; the member is typed unknown and
    // compared structurally below.
    const project = JSON.parse(await call(ids.projectAdmin, "get_project")) as {
      requiredReviewers: unknown;
    };
    expect(project.requiredReviewers).toEqual([
      { stageId: "review", stageName: "Review", profileId: "reviewer", agentName: "Reviewer" },
    ]);
    // Unchanged is said, not claimed as a write.
    expect(
      await call(ids.projectAdmin, "set_required_reviewers", {
        rules: [{ stageId: "review", profileId: "reviewer" }],
      }),
    ).toContain("[noop]");
    expect(await call(ids.projectAdmin, "set_required_reviewers", { rules: [] })).toBe(
      "[done] Required reviewers cleared.",
    );
    expect(await rulesInFile()).toEqual([]);
  });

  it("refuses an unknown stage or profile by name with nothing written", async () => {
    const { resolveProjectFilePath } = await import("~/server/files/project-writer.server");
    const path = resolveProjectFilePath({ projectSlug: SLUG, dataRoot: app.dataRoot });
    const before = readFileSync(path, "utf8");
    const audits = listAuditEvents(app.db, { action: "project.required_reviewers.updated" }).length;
    const stage = await call(ids.projectAdmin, "set_required_reviewers", {
      rules: [{ stageId: "qa", profileId: "reviewer" }],
    });
    expect(stage).toContain('[error] "qa" is not a stage of viberr-core. Nothing was written.');
    const profile = await call(ids.projectAdmin, "set_required_reviewers", {
      rules: [{ stageId: "review", profileId: "ghost" }],
    });
    expect(profile).toContain('[error] No agent "ghost" is deployed on viberr-core. Nothing was written.');
    expect(profile).toContain("Verdict-capable agents here: Reviewer (reviewer)");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(listAuditEvents(app.db, { action: "project.required_reviewers.updated" })).toHaveLength(audits);
  });

  it("is edit-policy tier: MAINTAINER refused, project ADMIN granted, and the audit row discloses the instrument", async () => {
    const denied = await call(ids.maintainer, "set_required_reviewers", {
      rules: [{ stageId: "review", profileId: "reviewer" }],
    });
    expect(denied).toContain("[denied]");
    const granted = await call(ids.projectAdmin, "set_required_reviewers", {
      rules: [{ stageId: "review", profileId: "reviewer" }],
    });
    expect(granted).toContain("[done]");
    const { listAuditLog } = await import("~/server/projections/activity-feed.server");
    const row = listAuditLog(app.db, SLUG, { limit: 20 }).find((r) =>
      r.text.includes("required reviewers"),
    );
    expect(row?.kind).toBe("change");
    expect(row?.text).toContain("(via the controller) set the required reviewers to **Reviewer at Review**.");
  });
});

/**
 * Ruling 188 (pass 37): a controller read returns what the equivalent HUMAN
 * surface renders. Three reads returned less-resolved data than the UI with no
 * marker saying so, and live in pass 37 each one changed what the controller
 * said or did: it told its owner two live profiles were "effectively
 * unselectable" (F37-3), it repeated a Review-stage acceptance sentence about a
 * Design-stage task (F37-5), and it refused an MCP grant that was in fact safe
 * because it could not observe ruling 176's marking (F37-6/F37-7).
 */
describe("ruling 188: the controller reads what the human surfaces render", () => {
  interface AgentRow {
    profileId: string;
    stages: string[];
    declaredStages: string[];
  }
  interface ProjectRead {
    agents: AgentRow[];
  }

  it("F37-3: get_project resolves declared stages onto THIS board, and keeps the raw declaration beside them", async () => {
    // `billing-service` is the demo's CUSTOM 3-stage board (todo / doing /
    // done) carrying the stock deployments, whose declared stages come from the
    // governed-5 template — `impl` and `review`, NEITHER of which exists there.
    // This is the exact shape pass 37 met live: a project whose stages were
    // changed after the stock profiles were seeded. Ruling R14-1 remaps by
    // structural role rather than disabling the profile, and the Agents page
    // renders the resolved list; this read used to hand the model the raw ids,
    // and the controller duly reported to its owner that the profile was
    // "effectively unselectable" while the audit trail showed it being selected.
    // SAFETY: `get_project` always answers `json(...)` and its `agents` array
    // is built from the roster with these exact keys; a shape change breaks the
    // assertions below rather than passing silently.
    const read = JSON.parse(
      await call(ids.orgAdminOutsider, "get_project", {}, "billing-service"),
    ) as ProjectRead;
    const row = read.agents.find((a) => a.profileId === "reviewer")!;
    // The raw declaration is preserved, so a remap is visible rather than silent.
    expect(row.declaredStages).toEqual(["impl", "review"]);
    // …and the resolved list is this board's own ids, never the template's.
    expect(row.stages).not.toContain("impl");
    expect(row.stages).not.toContain("review");
    for (const id of row.stages) expect(["todo", "doing", "done"]).toContain(id);
    expect(row.stages.length).toBeGreaterThan(0);
  });

  it("F37-5: get_task answers the acceptance gate's own verdict, not the stage-unaware column", async () => {
    // SAFETY: `get_task` always answers `json({ task, schedules, newestEvents })`;
    // the two property assertions below are the whole point of the test, so a
    // shape change fails here rather than passing.
    const read = JSON.parse(
      await call(ids.projectAdmin, "get_task", { taskKey: "VIB-142" }),
    ) as { task: { notAcceptableReason?: string | null; blockReason?: unknown } };
    // The projected `validation_block_reason` is documented as stage-unaware —
    // "every consumer filters rows on `archived = 0` and on the resolved review
    // stage before it ever looks at this column" — so it must not reach a model
    // raw. `notAcceptableReason` carries every gate, the stage one included.
    expect(read.task).not.toHaveProperty("blockReason");
    expect(read.task).toHaveProperty("notAcceptableReason");
  });

  it("F37-6: list_mcp_servers reports ruling 176's marking and what it means", async () => {
    await call(ids.orgAdminOutsider, "save_mcp_server", {
      name: "policy-probe",
      transport: "HTTP",
      target: "https://mcp.invalid/sse",
      writeTools: ["write_file", "edit_file"],
    });
    // SAFETY: `list_mcp_servers` answers a JSON array of the row shape mapped
    // immediately above it in the toolkit; the row is asserted to exist below.
    const listed = JSON.parse(
      await call(ids.orgAdminOutsider, "list_mcp_servers"),
    ) as { name: string; writeTools: string[]; writeToolsNote: string }[];
    const row = listed.find((m) => m.name === "policy-probe")!;
    expect(row.writeTools).toEqual(["write_file", "edit_file"]);
    expect(row.writeToolsNote).toContain("withheld");
    expect(row.writeToolsNote).toContain("ruling 176");
  });

  it("F37-7: save_mcp_server can mark write tools, and says which marking landed", async () => {
    const reply = await call(ids.orgAdminOutsider, "save_mcp_server", {
      name: "marked-probe",
      transport: "HTTP",
      target: "https://mcp.invalid/sse",
      writeTools: ["create_directory"],
    });
    expect(reply).toContain("[done]");
    // The reply states the marking that actually landed, so a model never has
    // to assert an enforcement it cannot observe.
    expect(reply).toContain("create_directory");
    expect(reply).toContain("withheld from every run without execute-code-or-write-repo");
    expect(reply).toContain("ruling 176");
  });
});

/**
 * Ruling 197 (F37-18, live): F33-7 put the GRANTS into `list_global_agents`
 * because "the model had no way to see what an edit was about to replace, and
 * the controller (rightly) refused to edit blind" — and left out the biggest
 * field of all. Pass 37 the controller needed to correct three stale template
 * summaries (they advertised Testcontainers, a Docker Compose stack and
 * Playwright journeys on a host with none of those, to the operator, which
 * selects agents by that text) and refused, for the same reason, two rulings
 * later: "`save_global_agent` gives me no way to edit a summary without also
 * supplying a persona, and I cannot read the personas I'd be replacing."
 *
 * The writer was innocent — a blank persona has always kept the stored one —
 * but nothing said so while the same paragraph spelled the rule out for three
 * other fields, and nothing let the caller check. Both halves are fixed here.
 */
describe("ruling 197: a template's persona is readable, and a summary-only edit keeps it", () => {
  it("returns the persona from list_global_agents and keeps it across a summary edit", async () => {
    await call(ids.orgAdmin, "save_global_agent", {
      name: "Persona Probe",
      backend: "codex",
      summary: "Verifies with Testcontainers and a Docker Compose stack.",
      persona: "PERSONA-MARKER-11: you are the probe. Do the probing.",
      stages: ["impl"],
    });

    const listed = async () => {
      const text = await call(ids.orgAdmin, "list_global_agents");
      // SAFETY: `list_global_agents` answers through the toolkit's `json()`
      // over the object literal its `.map` builds; these are its fields.
      const rows = JSON.parse(text) as {
        id: string;
        name: string;
        summary: string;
        persona: string;
      }[];
      return rows.find((r) => r.name === "Persona Probe");
    };

    // CANARY: drop `persona: g.persona` from the list mapping and this is
    // undefined — which is the state that made the controller refuse.
    expect((await listed())?.persona).toContain("PERSONA-MARKER-11");

    // The whole point: correct the stale blurb WITHOUT restating the persona.
    const existingId = (await listed())!.id;
    await call(ids.orgAdmin, "save_global_agent", {
      id: existingId,
      name: "Persona Probe",
      backend: "codex",
      summary: "Verifies real processes over real TCP. No containers on this host.",
      stages: ["impl"],
    });

    const after = await listed();
    expect(after?.summary).toContain("real processes over real TCP");
    // CANARY: make an omitted persona write "" through and this is empty — an
    // agent whose entire system prompt was flattened by a blurb edit.
    expect(after?.persona).toContain("PERSONA-MARKER-11");
  });

  // The description is this door's only contract for the model calling it, and
  // the silence beside three spelled-out merge rules is what made a careful
  // caller refuse the edit entirely.
  it("says the merge rule in the tool's own description, beside the grants' rule", async () => {
    const { buildControllerToolkit } = await import("./controller-toolkit.server");
    const { findUserById } = await import("~/server/auth/user-store.server");
    const admin = findUserById(app.db, ids.orgAdmin)!;
    const toolkit = buildControllerToolkit({
      db: app.db,
      ctx: { dataRoot: app.dataRoot },
      user: { id: admin.id, email: admin.email, name: admin.name },
      projectSlug: SLUG,
    });
    const save = toolkit.tools.find((t) => t.name === "save_global_agent")!;
    expect(save.description).toContain(
      "an omitted or empty PERSONA leaves the stored persona unchanged",
    );
    const list = toolkit.tools.find((t) => t.name === "list_global_agents")!;
    expect(list.description).toContain("its full persona");
  });
});
