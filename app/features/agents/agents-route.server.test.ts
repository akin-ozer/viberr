import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { AgentProfileView, AgentDeploymentView } from "./agent-types";

/**
 * Route-level tests for /projects/:slug/agents: roster assembly from the
 * seeded store (org templates ⊕ project.md deployments), the live
 * deployment projection incl. VIB-151's running runs, profile CRUD round
 * trips through real Requests (project.md writers + audit), and the RBAC
 * denials (profile CRUD is admin-only).
 */

let app: AppTestContext;
let ids: { arda: string; selin: string; deniz: string };

type LoaderData = {
  profiles: AgentProfileView[];
  deployments: AgentDeploymentView[];
  stages: { id: string; name: string; color: string }[];
  projectName: string;
};

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // project reviewer
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // NOT a member
  };
});
afterAll(() => app.cleanup());

async function runLoader(userId?: string): Promise<LoaderData> {
  const { loader } = await import("~/routes/project.agents");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  return (await loader({
    request: app.request(
      "/projects/viberr-core/agents",
      cookie ? { cookie } : {},
    ),
    params: { slug: "viberr-core" },
    context: {},
  } as never)) as LoaderData;
}

async function postAction(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.agents");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request("/projects/viberr-core/agents", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return action({ request, params: { slug: "viberr-core" }, context: {} } as never);
}

const FORM = {
  name: "Migrations",
  role: "Schema changes",
  backend: "codex",
  stages: ["ready", "impl"],
  definition: "Owns database schema changes.",
  caps: { "merge-pull-request": "human" },
  resources: { skills: ["repo-write"], mcps: ["github"], kb: [] },
};

describe("loader", () => {
  it("redirects signed-out users to /login", async () => {
    const thrown = await runLoader().catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("assembles the seeded roster: operator first, template fields + id-based actions", async () => {
    const data = await runLoader(ids.arda);
    expect(data.projectName).toBe("Viberr Core");
    expect(data.profiles.map((p) => p.id)).toEqual([
      "operator",
      "developer",
      "reviewer",
      "tester",
      "consultant",
    ]);

    const operator = data.profiles[0]!;
    expect(operator.kind).toBe("operator");
    expect(operator.spanAll).toBe(true);
    expect(operator.model).toBe("orchestration runtime");
    // Mock action-bucket sizes (policy spec §3.2): operator 5/3/3.
    expect(operator.actions.direct).toHaveLength(5);
    expect(operator.actions.recommend).toHaveLength(3);
    expect(operator.actions.forbidden).toHaveLength(3);
    expect(operator.actions.direct).toContain("Assign the primary specialist");

    // Near-miss labels stay display-only extras (contracts §7 #7).
    const tester = data.profiles.find((p) => p.id === "tester")!;
    expect(tester.actions.direct).toContain("Run the validation suite");
    expect(tester.extras.map((e) => e.label)).toContain(
      "Run the validation suite",
    );
    const reviewer = data.profiles.find((p) => p.id === "reviewer")!;
    expect(reviewer.actions.forbidden).toContain("Push commits to the branch");

    expect(data.stages.map((s) => s.id)).toEqual([
      "triage",
      "ready",
      "impl",
      "review",
      "done",
    ]);
  });

  it("derives live deployments from the seed — VIB-151 crew incl. its running runs", async () => {
    const data = await runLoader(ids.arda);
    const vib151 = data.deployments.filter((d) => d.taskKey === "VIB-151");
    expect(vib151.map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["developer", "primary", "working"],
      ["consultant", "reviewer", "anchored · on call"],
    ]);
    // Phase-8 seeds VIB-151 with a running claude primary + codex c0.
    expect(vib151.find((d) => d.engagement === "primary")!.running).toBe(true);
    expect(vib151.find((d) => d.engagement === "reviewer")!.running).toBe(true);

    // Done tasks contribute nothing; triage tasks have no operator.
    expect(data.deployments.some((d) => d.taskKey === "VIB-139")).toBe(false);
    expect(data.deployments.some((d) => d.taskKey === "VIB-166")).toBe(false);

    // VIB-142 (review · waiting human): packet open / waiting on human.
    const vib142 = data.deployments.filter((d) => d.taskKey === "VIB-142");
    expect(vib142.map((d) => d.status)).toEqual([
      "packet open",
      "waiting on human",
      "anchored · on call",
    ]);
  });
});

describe("action RBAC (profile CRUD is admin-only)", () => {
  it("rejects a reviewer from creating a profile", async () => {
    const result = (await postAction(ids.selin, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });

  it("rejects a non-member from deleting a profile", async () => {
    const result = (await postAction(ids.deniz, {
      intent: "delete-profile",
      profileId: "tester",
    })) as { init?: { status?: number } };
    expect(result.init?.status).toBe(403);
  });

  it("rejects deleting the operator even for an admin (server invariant)", async () => {
    const result = (await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "operator",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(result.init?.status).toBe(403);
    expect(result.data?.error).toContain("system profile");
  });

  it("rejects unknown intents", async () => {
    const result = (await postAction(ids.arda, { intent: "frobnicate" })) as {
      init?: { status?: number };
    };
    expect(result.init?.status).toBe(400);
  });
});

describe("profile CRUD round trip (project.md writers + audit)", () => {
  it("create → deployment entry with inline definition; server-generated slug id", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    })) as { ok: boolean; toast: string; profileId: string };
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("migrations");
    expect(result.toast).toContain('"Migrations" created');

    const data = await runLoader(ids.arda);
    expect(data.profiles.map((p) => p.id)).toContain("migrations");
    const created = data.profiles.find((p) => p.id === "migrations")!;
    expect(created).toMatchObject({
      kind: "specialist",
      name: "Migrations",
      role: "Schema changes",
      icon: "agents",
      backends: ["codex"],
      // No picked model in FORM → per-backend catalog default (no more the
      // old invalid hardcoded id).
      model: "gpt-5-codex",
      effort: "medium",
      scope: "Created in Viberr Core",
      stages: ["ready", "impl"],
      source: "project",
    });
    // The explicit human grant + catalog defaults are id-based grants.
    expect(
      created.capabilities.find((c) => c.capabilityId === "merge-pull-request"),
    ).toEqual({ capabilityId: "merge-pull-request", mode: "human" });

    // project.md carries the deployment (canonical file truth).
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).toContain("profileId: migrations");
    expect(file).toContain("Owns database schema changes.");

    const { listAuditEvents } = await import(
      "~/server/audit/audit-recorder.server"
    );
    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.created",
    });
    expect(audit[0]).toMatchObject({
      subjectId: "migrations",
      projectSlug: "viberr-core",
      actorUserId: ids.arda,
    });
  });

  it("stores the picked model + effort on the deployment definition", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Reasoner",
        role: "Deep analysis",
        backend: "claude",
        stages: ["impl"],
        definition: "Thinks hard.",
        model: "opus",
        effort: "xhigh",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean; profileId: string };
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("reasoner");

    const data = await runLoader(ids.arda);
    const created = data.profiles.find((p) => p.id === "reasoner")!;
    expect(created.model).toBe("opus");
    expect(created.effort).toBe("xhigh");

    // project.md carries the picked model + effort (canonical file truth).
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).toContain("model: opus");
    expect(file).toContain("effort: xhigh");

    // Clean up so later count-sensitive tests are unaffected.
    await postAction(ids.arda, { intent: "delete-profile", profileId: "reasoner" });
  });

  it("a second profile with the same name gets a uniquified id", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    })) as { ok: boolean; profileId: string };
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("migrations-2");
  });

  it("edit preserves non-modal grants + extras and the operator's model/spanAll", async () => {
    const result = (await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: JSON.stringify({
        name: "Operator",
        role: "Task coordinator",
        backend: "claude",
        stages: ["triage", "ready", "impl", "review", "done"],
        definition: "Updated operator definition.",
        caps: {},
        resources: { skills: ["packet-authoring"], mcps: ["viberr-task-store"], kb: [] },
      }),
    })) as { ok: boolean; toast: string };
    expect(result.ok).toBe(true);

    const data = await runLoader(ids.arda);
    const operator = data.profiles.find((p) => p.id === "operator")!;
    expect(operator.kind).toBe("operator");
    expect(operator.model).toBe("orchestration runtime"); // preserved
    expect(operator.spanAll).toBe(true); // preserved (mock wart fixed)
    expect(operator.desc).toBe("Updated operator definition.");
    // Operator coordination grants live OUTSIDE the modal catalog — kept.
    expect(operator.actions.direct).toContain("Assign the primary specialist");
    expect(operator.capabilities.map((c) => c.capabilityId)).toContain(
      "compress-timelines",
    );
  });

  it("delete removes the deployment; the org template file survives", async () => {
    for (const profileId of ["migrations", "migrations-2"]) {
      const result = (await postAction(ids.arda, {
        intent: "delete-profile",
        profileId,
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
    }
    const data = await runLoader(ids.arda);
    expect(data.profiles).toHaveLength(5);

    // Deleting a TEMPLATE-deployed profile also only removes the deployment.
    const del = (await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "tester",
    })) as { ok: boolean; toast: string };
    expect(del.ok).toBe(true);
    expect(del.toast).toContain('"Tester" deleted');
    const after = await runLoader(ids.arda);
    expect(after.profiles.map((p) => p.id)).not.toContain("tester");
    // "The global base definition is unaffected."
    const template = readFileSync(
      path.join(app.dataRoot, "agents/profiles/tester.md"),
      "utf8",
    );
    expect(template).toContain("name: Tester");
  });
});
