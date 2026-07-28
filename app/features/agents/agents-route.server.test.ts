import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { listAuditEvents } from "../../../test-support/audit-log";
import type {
  AgentProfileView,
  AgentDeploymentView,
  LibraryProfileView,
} from "./agent-types";

/**
 * Route-level tests for /projects/:slug/agents: roster assembly from the
 * seeded store (org templates ⊕ project.md deployments), the live
 * deployment projection incl. VIB-151's running runs, profile CRUD round
 * trips through real Requests (project.md writers + audit), and the RBAC
 * denials (profile CRUD is admin-only).
 *
 * R7-2: the demo seed ships ZERO run history, so the VIB-151 running runs
 * the deployment projection joins against are inserted here directly.
 */

let app: AppTestContext;
let ids: { arda: string; selin: string; deniz: string };

type LoaderData = {
  profiles: AgentProfileView[];
  library: LibraryProfileView[];
  deployments: AgentDeploymentView[];
  stages: { id: string; name: string; color: string }[];
  projectName: string;
};

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id, // project admin
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // project reviewer
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // NOT a member
  };

  // VIB-151's live crew: a running claude primary + a running codex reviewer
  // (thread r0 → reviewers[0]). The seed no longer fabricates these (R7-2);
  // insert the run rows this projection test needs directly.
  const { upsertRun } = await import("~/server/runtimes/run-store.server");
  const startedAt = new Date().toISOString();
  upsertRun(app.db, {
    id: "run_test_vib151_primary",
    projectSlug: "viberr-core",
    taskKey: "VIB-151",
    threadId: "primary",
    role: "Primary specialist",
    kind: "primary",
    agentProfileId: "developer",
    backend: "claude",
    model: "claude-sonnet-4-5",
    sdk: "Claude Agent SDK",
    state: "running",
    startedAt,
  } as Parameters<typeof upsertRun>[1]);
  upsertRun(app.db, {
    id: "run_test_vib151_reviewer",
    projectSlug: "viberr-core",
    taskKey: "VIB-151",
    threadId: "r0",
    role: "Reviewer",
    kind: "reviewer",
    agentProfileId: "reviewer",
    backend: "codex",
    model: "gpt-5.4-codex",
    sdk: "Codex SDK",
    state: "running",
    startedAt,
  } as Parameters<typeof upsertRun>[1]);
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
    // Operator action-bucket sizes after the role-bindings prune (removed the
    // never-gated `compress-timelines` from direct and `owner-reassignment` from
    // recommend), plus R15-2's `deliver-review-pr` (direct in the shipped
    // template): 5 direct / 2 recommend / 3 forbidden.
    expect(operator.actions.direct).toHaveLength(5);
    expect(operator.actions.recommend).toHaveLength(2);
    expect(operator.actions.forbidden).toHaveLength(3);
    expect(operator.actions.direct).toContain("Assign the primary specialist");
    expect(operator.actions.direct).toContain("Deliver the branch & open the review PR");
    expect(operator.actions.direct).not.toContain("Compress long-running timelines");

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

  it("derives live deployments — VIB-151 crew incl. its running runs (inserted above, not seeded)", async () => {
    const data = await runLoader(ids.arda);
    const vib151 = data.deployments.filter((d) => d.taskKey === "VIB-151");
    expect(vib151.map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "coordinating"],
      ["developer", "primary", "working"],
      ["reviewer", "reviewer", "anchored · on call"],
    ]);
    // The running claude primary + codex r0 reviewer inserted in beforeAll.
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
      model: "gpt-5.6-sol",
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

  // REWRITTEN for P13-AP-06. This used to assert that a capability the form
  // omitted stays ABSENT from the stored grants ("no blanket default merge",
  // #37). The intent was right — an omitted cap must NOT be granted — but the
  // implementation enshrined the bug: the tool-policy polarity denies only on
  // an explicit `human`/`off`, so an absent id reads back as *unspecified* and
  // is therefore ALLOWED. The #37 protection (never merge the permissive
  // catalog defaults) is what this asserts now, with "not granted" written down
  // as an explicit `off` instead of an absence that silently means the opposite.
  it("persists the submitted governed caps and an explicit `off` for the rest — no permissive defaults merged, F14 headline repair still applies (#37 / AP-06)", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Minimal Dev",
        role: "Branch only",
        backend: "claude",
        stages: ["impl"],
        definition: "Only two caps submitted; nothing else should be granted.",
        // Two scoped-delivery caps submitted, as a partial/older client would —
        // the rest of the catalog must NOT be merged in.
        caps: { "create-task-branch": "direct", "open-review-pr": "direct" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "minimal-dev",
    )!;
    const mode = (id: string) =>
      created.capabilities.find((c) => c.capabilityId === id)?.mode;
    // F14: granting scoped delivery (create-task-branch/open-review-pr) is a
    // deliverer, so the headline `execute-code-or-write-repo` (the master gate)
    // is repaired to `direct` — otherwise the chosen delivery caps would be
    // silently vetoed by the tool policy (the VIB-1 "no commits" class).
    expect(mode("create-task-branch")).toBe("direct");
    expect(mode("open-review-pr")).toBe("direct");
    expect(mode("execute-code-or-write-repo")).toBe("direct");
    // Powers the creator never chose are NOT granted — and that is now written
    // down (`off`) rather than left absent, because absent means "unspecified"
    // and unspecified means allowed at the tool layer (AP-06). No blanket
    // permissive default merge either: nothing extra became `direct`.
    expect(mode("commit-push-branch")).toBe("off");
    expect(mode("comment-on-task")).toBe("off");
    expect(mode("report-validation-verdict")).toBe("off");
    // Always-human ids stay the structural lock.
    expect(mode("merge-pull-request")).toBe("human");
    expect(
      created.capabilities.filter((c) => c.mode === "direct").map((c) => c.capabilityId).sort(),
    ).toEqual([
      "create-task-branch",
      "execute-code-or-write-repo",
      "open-review-pr",
    ]);

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "minimal-dev",
    });
  });

  /**
   * B-AG1: save-time normalization used to rewrite an EXPLICIT headline `off`
   * to `direct` whenever any scoped delivery grant was actionable — silently,
   * with no audit row, and in the opposite direction from the enforcement layer
   * (`grantModes`), which honors the `off`. An admin who deliberately withheld
   * repo writes got them back on the next save.
   */
  it("an EXPLICIT headline `off` survives the save, and the contradiction is recorded (B-AG1)", async () => {
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Withheld Dev",
        role: "No repo writes",
        backend: "claude",
        stages: ["impl"],
        definition: "Headline explicitly off; scoped delivery left on.",
        caps: {
          "execute-code-or-write-repo": "off",
          "create-task-branch": "direct",
          "commit-push-branch": "direct",
        },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "withheld-dev",
    )!;
    const mode = (id: string) =>
      created.capabilities.find((c) => c.capabilityId === id)?.mode;
    expect(mode("execute-code-or-write-repo")).toBe("off");
    // The scoped grants the admin left on are untouched — the contradiction is
    // reported, not resolved behind their back in either direction.
    expect(mode("create-task-branch")).toBe("direct");

    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.created",
    }).find((e) => e.subjectId === "withheld-dev")!;
    const details = (audit.details ?? {}) as {
      deliveryGrants?: string;
      deliveryNote?: string;
    };
    expect(details.deliveryGrants).toBe("withheld");
    expect(details.deliveryNote).toContain("cannot deliver");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "withheld-dev",
    });
  });

  it("R7-5 — a specialist `recommend` grant coerces to `direct` ('Allowed') on create", async () => {
    // The specialist picker no longer offers `recommend`, but a hostile/legacy
    // form might still submit it. `recommend` is operator-only (runtime-
    // identical to `direct` for a specialist; F7-CAP1), so it must persist as
    // `direct`; `human`/`off` pass through unchanged.
    const result = (await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Recommender",
        role: "Submits a stale recommend mode",
        backend: "claude",
        stages: ["impl"],
        definition: "Submitted open-review-pr as recommend from an old client.",
        caps: {
          "open-review-pr": "recommend",
          "commit-push-branch": "recommend",
          "create-task-branch": "off",
          "execute-code-or-write-repo": "human",
        },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "recommender",
    )!;
    const mode = (id: string) =>
      created.capabilities.find((c) => c.capabilityId === id)?.mode;
    // Both submitted `recommend` grants coerced to `direct`.
    expect(mode("open-review-pr")).toBe("direct");
    expect(mode("commit-push-branch")).toBe("direct");
    // No specialist cap is ever stored/read as `recommend`.
    expect(created.capabilities.map((c) => c.mode)).not.toContain("recommend");
    // Non-recommend modes are untouched.
    expect(mode("create-task-branch")).toBe("off");
    expect(mode("execute-code-or-write-repo")).toBe("human");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "recommender",
    });
  });

  it("R7-5 — editing a specialist coerces a submitted `recommend` to `direct` (grantsFor path)", async () => {
    await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "Editable Dev",
        role: "Implementation",
        backend: "claude",
        stages: ["impl"],
        definition: "Created allowed, then edited with a stale recommend mode.",
        caps: { "open-review-pr": "direct" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    });
    const upd = (await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "editable-dev",
      payload: JSON.stringify({
        name: "Editable Dev",
        role: "Implementation",
        backend: "claude",
        stages: ["impl"],
        definition: "Created allowed, then edited with a stale recommend mode.",
        caps: { "open-review-pr": "recommend", "commit-push-branch": "recommend" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    })) as { ok: boolean };
    expect(upd.ok).toBe(true);

    const edited = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "editable-dev",
    )!;
    const mode = (id: string) =>
      edited.capabilities.find((c) => c.capabilityId === id)?.mode;
    expect(mode("open-review-pr")).toBe("direct");
    expect(mode("commit-push-branch")).toBe("direct");
    expect(edited.capabilities.map((c) => c.mode)).not.toContain("recommend");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "editable-dev",
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

describe("AP-05 / owner ruling 1 — the global library is deployable", () => {
  /**
   * Before this, NO code path added an org template to a project's `agents:`
   * list: a profile created in Settings → Global agent profiles could never be
   * deployed, run or selected (live-confirmed — "Org Docs Writer" was absent
   * from a project created after it). The project Agents page now has an
   * explicit "Add from library" action that copies one in.
   *
   * NB: the previous describe block deletes `reviewer`'s DEPLOYMENT while its
   * template file survives — exactly the state the library picker is for.
   */
  it("offers the undeployed org templates, and hides the ones already deployed", async () => {
    const data = await runLoader(ids.arda);
    const libraryIds = data.library.map((t) => t.id);
    // `reviewer` was un-deployed above; its template is still on disk.
    expect(libraryIds).toContain("reviewer");
    // Still-deployed templates and the system operator are never offered.
    expect(libraryIds).not.toContain("developer");
    expect(libraryIds).not.toContain("operator");

    const reviewer = data.library.find((t) => t.id === "reviewer")!;
    expect(reviewer.name).toBe("Reviewer");
    // Scannable copy, not the whole persona body.
    expect(reviewer.desc.length).toBeGreaterThan(0);
    expect(reviewer.desc.length).toBeLessThanOrEqual(241);
    expect(reviewer.stages).toEqual(["impl", "review"]);
  });

  it("deploy-profile copies the template into project.md with a full definition + EXPLICIT grants", async () => {
    const result = (await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "reviewer",
    })) as { ok: boolean; toast: string; profileId: string };
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("reviewer");
    expect(result.toast).toContain("added from the global library");

    const data = await runLoader(ids.arda);
    const deployed = data.profiles.find((p) => p.id === "reviewer")!;
    expect(deployed.kind).toBe("specialist");
    expect(deployed.name).toBe("Reviewer");
    expect(deployed.stages).toEqual(["impl", "review"]);
    // AP-06: never `capabilities: []` — an empty grant list is "unspecified",
    // and unspecified means FULL repo-write power at the tool layer.
    expect(deployed.capabilities.length).toBeGreaterThan(0);
    expect(
      deployed.capabilities.find((c) => c.capabilityId === "merge-pull-request")
        ?.mode,
    ).toBe("human");
    // The template's own grants win over the catalog defaults where present:
    // the seeded Reviewer must NOT commit/push.
    expect(
      deployed.capabilities.find((c) => c.capabilityId === "commit-push-branch")
        ?.mode,
    ).toBe("human");

    // It is gone from the library now that it is deployed.
    expect(data.library.map((t) => t.id)).not.toContain("reviewer");

    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).toContain("profileId: reviewer");

    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.deployed",
    });
    expect(audit[0]).toMatchObject({
      subjectId: "reviewer",
      projectSlug: "viberr-core",
      actorUserId: ids.arda,
    });
  });

  it("refuses a duplicate deploy, an unknown id, and a non-admin", async () => {
    const dup = (await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "reviewer",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(dup.init?.status).toBe(409);
    expect(dup.data?.error).toContain("already deployed");

    const unknown = (await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "no-such-template",
    })) as { init?: { status?: number } };
    expect(unknown.init?.status).toBe(404);

    // The operator template is a system profile — never library material,
    // rejected on its kind before any duplicate check.
    const operator = (await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "operator",
    })) as { init?: { status?: number }; data?: { error?: string } };
    expect(operator.init?.status).toBe(400);
    expect(operator.data?.error).toContain("not a specialist template");

    const denied = (await postAction(ids.selin, {
      intent: "deploy-profile",
      profileId: "reviewer",
    })) as { init?: { status?: number } };
    expect(denied.init?.status).toBe(403);
  });

  it("AP-11 sibling: a traversing profileId is rejected, not path.join'd into the store", async () => {
    // `agentProfileFilePath` joins its argument straight into the store (the
    // containment guard skills/KB got in F10-18 was never added to it), and
    // this id arrives from a form field — so the segment is validated here.
    for (const evil of ["../../project", "..", "a/b", "with\\sep"]) {
      const result = (await postAction(ids.arda, {
        intent: "deploy-profile",
        profileId: evil,
      })) as { init?: { status?: number }; data?: { error?: string } };
      expect(result.init?.status, evil).toBe(400);
      expect(result.data?.error, evil).toContain("not a valid profile id");
    }
  });
});

describe("AP-07 — a project-level edit FORKS the profile (the modal now says so)", () => {
  /**
   * `updateAgentProfile` always writes a COMPLETE definition snapshot onto the
   * deployment, and every field of it wins over the org template in
   * `effectiveProfileView`. So the first edit detaches this project: later
   * org-level edits never reach it. That is the deliberate model (a project
   * owns its copy); what was wrong was the COPY — the org modal promised
   * "used in N projects — changes apply on next run" and the project modal
   * "changes apply to future assignments". This pins the BEHAVIOUR half of the
   * pair; the copy half is asserted in agents-page.test.tsx (AP-07).
   */
  const templateId = "fork-probe";
  const templatePath = () =>
    path.join(app.dataRoot, "agents", "profiles", `${templateId}.md`);

  async function writeTemplate(name: string, desc: string, stages: string[]) {
    const { serializeAgentProfile } = await import(
      "~/server/files/agent-profile-file.server"
    );
    writeFileSync(
      templatePath(),
      serializeAgentProfile({
        frontmatter: {
          id: templateId,
          kind: "specialist",
          name,
          role: "Probe",
          desc,
          icon: "cpu",
          backends: ["claude"],
          model: "",
          scope: "Global base",
          stages,
          spanAll: false,
          capabilities: [{ capabilityId: "comment-on-task", mode: "direct" }],
          extras: [],
          resources: { skills: [], mcps: [], kb: [] },
        },
        description: "Original persona.",
      }),
      "utf8",
    );
  }

  it("after an edit here, later org-template changes no longer reach this project", async () => {
    await writeTemplate("Fork Probe", "Original desc.", ["impl"]);

    // Deploy it, then confirm it still tracks the template.
    expect(
      ((await postAction(ids.arda, {
        intent: "deploy-profile",
        profileId: templateId,
      })) as { ok: boolean }).ok,
    ).toBe(true);

    // Edit the project's copy — this is the fork point.
    await postAction(ids.arda, {
      intent: "update-profile",
      profileId: templateId,
      payload: JSON.stringify({
        name: "Fork Probe",
        role: "Probe",
        backend: "claude",
        stages: ["impl"],
        definition: "Project-owned desc.",
        caps: { "comment-on-task": "direct" },
        resources: { skills: [], mcps: [], kb: [] },
      }),
    });

    // The org template changes underneath it.
    await writeTemplate("Renamed Globally", "Changed globally.", ["review"]);

    const forked = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === templateId,
    )!;
    // None of the org-level changes reach the project — the snapshot wins.
    expect(forked.name).toBe("Fork Probe");
    expect(forked.desc).toBe("Project-owned desc.");
    expect(forked.stages).toEqual(["impl"]);

    // Cleanup: drop the deployment and the probe template.
    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: templateId,
    });
    rmSync(templatePath(), { force: true });
  });
});

/**
 * F15-05/F15-06 (live, 2026-07-28): a profile created in org settings — the one
 * surface with NO capability UI — and then added to a project rendered on the
 * project Agents page holding "Approve the review", "Request changes" and
 * "Post quality-flag events" under ACTS DIRECTLY, because the conservative
 * defaults granted every advisory catalog id at its `direct` default while
 * `report-validation-verdict` stayed `off`. An admin reading that panel was told
 * a docs writer could approve reviews.
 */
describe("F15-05/06 — a brand-new profile claims no verdict authority", () => {
  const orgProfileId = "org-docs-writer";

  it("org-created → library-deployed: no verdict outcomes, no unasked resources", async () => {
    const { saveGlobalAgentProfile } = await import("~/server/org/gagents.server");
    saveGlobalAgentProfile(
      app.db,
      {
        name: "Org docs writer",
        backend: "codex",
        summary: "Writes documentation only.",
        persona: "You improve documentation.",
        stages: ["impl"],
        skills: [],
        mcps: [],
        kbs: [],
      },
      { userId: ids.arda, label: "Arda" },
      { dataRoot: app.dataRoot },
    );
    const deployed = (await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: orgProfileId,
    })) as { ok: boolean };
    expect(deployed.ok).toBe(true);

    const view = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === orgProfileId,
    )!;
    for (const label of [
      "Approve the review",
      "Request changes",
      "Post quality-flag events",
    ]) {
      expect(view.actions.direct, label).not.toContain(label);
      expect(view.actions.recommend, label).not.toContain(label);
    }
    // Delivery stays withheld too (the pre-existing conservative posture).
    expect(view.actions.direct).not.toContain("Execute code or write to the repo");
    expect(view.actions.direct).not.toContain("Commit & push to the branch");
    // Verdict authority is explicit-only, and it was never granted.
    expect(view.actions.direct).not.toContain("Report a validation verdict");
    // Nothing chose a context resource for it.
    expect(view.resources).toEqual({ skills: [], mcps: [], kb: [] });

    // The stored template is honest at rest as well — the outcomes are `off`,
    // not `direct`-with-a-withheld-verdict.
    const template = readFileSync(
      path.join(app.dataRoot, "agents", "profiles", `${orgProfileId}.md`),
      "utf8",
    );
    expect(template).toMatch(/capabilityId: approve-review\n\s+mode: off/);
    expect(template).toMatch(/capabilityId: request-changes\n\s+mode: off/);

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: orgProfileId,
    });
    rmSync(
      path.join(app.dataRoot, "agents", "profiles", `${orgProfileId}.md`),
      { force: true },
    );
  });
});
