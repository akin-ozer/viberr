import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
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

  it("blocks a non-member from the agents config surface (view-side RBAC)", async () => {
    // deniz is a registered user but NOT a member of viberr-core. The agent
    // capability config is a config surface (not board/tasks), so it is
    // member-only — a non-member gets a clean 403, not the roster.
    const thrown = await runLoader(ids.deniz).catch((e) => e);
    // requireProjectMember throws react-router `data(msg, { status: 403 })`.
    expect((thrown as { init?: { status?: number } }).init?.status).toBe(403);
  });

  it("assembles the seeded roster: operator first, template fields + id-based actions", async () => {
    const data = await runLoader(ids.arda);
    expect(data.projectName).toBe("Viberr Core");
    expect(data.profiles.map((p) => p.id)).toEqual([
      "operator",
      "developer",
      "reviewer",
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

    // The Reviewer's push restriction is now a REAL enforced grant (D4): it uses
    // the exact catalog label "Commit & push to the branch" so it maps to the
    // `commit-push-branch` capability and the tool policy actually denies push +
    // commit — no longer a decorative extra.
    const reviewer = data.profiles.find((p) => p.id === "reviewer")!;
    expect(reviewer.actions.forbidden).toContain("Commit & push to the branch");
    expect(reviewer.extras.map((e) => e.label)).not.toContain(
      "Push commits to the branch",
    );

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
      ["reviewer", "reviewer", "anchored · on call"],
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
      profileId: "reviewer",
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
      model: "gpt-5.5",
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

    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.created",
    });
    expect(audit[0]).toMatchObject({
      subjectId: "migrations",
      projectSlug: "viberr-core",
      actorUserId: ids.arda,
    });
  });

  it("coerces always-human capabilities to human even when the form asks for direct", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Overreach",
        role: "Tries to self-govern",
        backend: "claude",
        stages: ["impl"],
        definition: "Attempts to grant itself governance powers.",
        // A malformed/hostile form asking for actionable modes on human-only caps.
        caps: {
          "merge-pull-request": "direct",
          "transition-to-done": "direct",
          "change-project-policy": "recommend",
          "commit-push-branch": "direct",
        },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "overreach",
    )!;
    const mode = (id: string) =>
      created.capabilities.find((c) => c.capabilityId === id)?.mode;
    // The three always-human capabilities are forced to human by grantsFor…
    expect(mode("merge-pull-request")).toBe("human");
    expect(mode("transition-to-done")).toBe("human");
    expect(mode("change-project-policy")).toBe("human");
    // …but an ordinary repo capability keeps the requested actionable mode.
    expect(mode("commit-push-branch")).toBe("direct");

    await postAction(ids.arda, { intent: "delete-profile", profileId: "overreach" });
  });

  it("persists an explicitly withheld (off) capability so runtime enforcement can see it", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Locked Dev",
        role: "Implementation, PR withheld",
        backend: "claude",
        stages: ["impl"],
        definition: "A developer whose PR-opening is explicitly withheld.",
        caps: { "open-review-pr": "off" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "locked-dev",
    )!;
    const grant = created.capabilities.find(
      (c) => c.capabilityId === "open-review-pr",
    );
    // Previously `off` grants were dropped at persist, making the runtime deny a
    // silent no-op. They must now round-trip so specialist-tool-policy denies.
    expect(grant?.mode).toBe("off");

    await postAction(ids.arda, { intent: "delete-profile", profileId: "locked-dev" });
  });

  it("persists EXACTLY the submitted governed caps — no permissive defaults merged (#37)", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Minimal Dev",
        role: "Read and comment only",
        backend: "claude",
        stages: ["impl"],
        definition: "Only two caps submitted; nothing else should be granted.",
        // Only two governed caps submitted, as a partial/older client would.
        caps: { "read-task-repo": "direct", "comment-on-task": "direct" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "minimal-dev",
    )!;
    // The persisted cap set equals exactly what the form submitted (no
    // coercions apply here). Previously the create path merged the permissive
    // catalog defaults, so 2 submitted caps persisted as ~12.
    const persisted = created.capabilities
      .map((c) => [c.capabilityId, c.mode])
      .sort();
    expect(persisted).toEqual([
      ["comment-on-task", "direct"],
      ["read-task-repo", "direct"],
    ]);
    // Repo-mutating powers the creator never chose are ABSENT (not `direct`).
    const capIds = created.capabilities.map((c) => c.capabilityId);
    expect(capIds).not.toContain("create-task-branch");
    expect(capIds).not.toContain("commit-push-branch");
    expect(capIds).not.toContain("open-review-pr");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "minimal-dev",
    });
  });

  it("update with an empty definition keeps existing prose — no placeholder shadow (#28)", async () => {
    // Create with real prose.
    await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Prose Keeper",
        role: "Implementation",
        backend: "claude",
        stages: ["impl"],
        definition: "Owns the checkout pipeline and its integration tests.",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    });
    // Update the SAME profile with an EMPTY (whitespace) definition. The old
    // generated placeholder ("Prose Keeper — a implementation specialist.")
    // must never be persisted; the prior prose is left untouched.
    const upd = (await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "prose-keeper",
      payload: JSON.stringify({
        name: "Prose Keeper",
        role: "Implementation",
        backend: "claude",
        stages: ["impl"],
        definition: "   ",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(upd.ok).toBe(true);

    const updated = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "prose-keeper",
    )!;
    expect(updated.desc).toBe(
      "Owns the checkout pipeline and its integration tests.",
    );
    // The ungrammatical placeholder is never persisted.
    expect(updated.desc).not.toContain("specialist.");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "prose-keeper",
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

  it("edit stores the operator's backend/model/autonomy + governs its caps", async () => {
    const result = (await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: JSON.stringify({
        name: "Operator",
        role: "Task coordinator",
        backend: "codex",
        stages: ["triage", "ready", "impl", "review", "done"],
        definition: "Updated operator definition.",
        autonomy: "full",
        caps: { "assign-primary-specialist": "recommend", "stage-transitions": "direct" },
        resources: { skills: ["viberr-app-expertise"], mcps: ["viberr"], kb: ["architecture-notes"] },
      }),
    })) as { ok: boolean; toast: string };
    expect(result.ok).toBe(true);

    const data = await runLoader(ids.arda);
    const operator = data.profiles.find((p) => p.id === "operator")!;
    expect(operator.kind).toBe("operator");
    // The operator now runs on a real backend + model (not a placeholder).
    expect(operator.backends).toContain("codex");
    expect(operator.model).not.toBe("orchestration runtime");
    // Autonomy is stored on the deployment.
    expect(operator.autonomy).toBe("full");
    expect(operator.spanAll).toBe(true); // preserved
    expect(operator.desc).toBe("Updated operator definition.");
    // Operator RBAC modes are editable (assign → recommend, transitions → direct).
    const modeOf = (id: string) =>
      operator.capabilities.find((c) => c.capabilityId === id)?.mode;
    expect(modeOf("assign-primary-specialist")).toBe("recommend");
    expect(modeOf("stage-transitions")).toBe("direct");
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
    // Back to the base roster: operator + developer + reviewer.
    expect(data.profiles).toHaveLength(3);

    // Deleting a TEMPLATE-deployed profile also only removes the deployment.
    const del = (await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "reviewer",
    })) as { ok: boolean; toast: string };
    expect(del.ok).toBe(true);
    expect(del.toast).toContain('"Reviewer" deleted');
    const after = await runLoader(ids.arda);
    expect(after.profiles.map((p) => p.id)).not.toContain("reviewer");
    // "The global base definition is unaffected."
    const template = readFileSync(
      path.join(app.dataRoot, "agents/profiles/reviewer.md"),
      "utf8",
    );
    expect(template).toContain("name: Reviewer");
  });
});
