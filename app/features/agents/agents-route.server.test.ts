import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
import { listAuditEvents } from "../../../test-support/audit-log";
import type { GrantCouplingNotice } from "~/shared/capabilities";
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

/**
 * The seeded accounts every case below acts as: arda is project admin, selin
 * project reviewer, deniz a registered user who is NOT a member of viberr-core.
 */
let ids: SeedUserIds;

/** Ruling 127: what the loader answers about backends. `backendHealth` is the
 *  ONE answer: the VIEWER's own connection (which the roster badge and the
 *  profile editor's advisory note read) plus the project-scoped count the
 *  roster line states. Authoring a profile is never gated on it, so there is no
 *  second `backendAvailable` pair to drift from it. */
interface BackendConnectionSummaryData {
  backend: "codex" | "claude";
  viewerConnected: boolean;
  membersConnected: number;
  membersTotal: number;
}

type LoaderData = {
  profiles: AgentProfileView[];
  library: LibraryProfileView[];
  deployments: AgentDeploymentView[];
  stages: { id: string; name: string; color: string }[];
  projectName: string;
  backendHealth: Record<"codex" | "claude", BackendConnectionSummaryData>;
  /** Ruling 156 (owner, Q35-8): who may copy a template's grants here. */
  viewerIsOrgAdmin: boolean;
};

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;

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
  });
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
  });
});
afterAll(() => app.cleanup());

async function runLoader(userId?: string): Promise<LoaderData> {
  const { loader } = await import("~/routes/project.agents");
  const cookie = userId ? (await app.cookieFor(userId)).cookie : undefined;
  // SAFETY: the loader reads `request` and `params` and never touches the
  // router `context`, so this stub carries everything the call executes; the
  // generated `Route.LoaderArgs` cannot be built outside a real router.
  return loader({
    request: app.request(
      "/projects/viberr-core/agents",
      cookie ? { cookie } : {},
    ),
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

/**
 * B5 (pass 34, U34-3): the fingerprint the agents LOADER ships for a
 * deployment — what the editor submits back, so a save composed against a
 * record a concurrent write replaced is refused instead of reverting it. Read
 * the same way the loader reads it, so no case pins a value the page could not
 * produce.
 */
/** The one field this harness reads out of an editor payload; `.loose()` keeps
 *  every other key so re-serializing preserves the case's own form. */
const editorPayloadSchema = z.object({ fingerprint: z.string().optional() }).loose();

async function currentFingerprint(profileId: string): Promise<string> {
  const { readProjectFile } = await import("~/server/files/project-writer.server");
  const { deploymentFingerprint } = await import(
    "~/features/agents/agent-profile-actions.server"
  );
  const deployment = readProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot })!
    .parsed.frontmatter.agents.find((a) => a.profileId === profileId)!;
  return deploymentFingerprint(deployment);
}

async function postAction(userId: string, fields: Record<string, string>) {
  const { action } = await import("~/routes/project.agents");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  // The real editor always carries the record it was opened on (B5). A case
  // that means to send a STALE one sets `fingerprint` in its own payload.
  if (fields.intent === "update-profile" && fields.profileId && fields.payload) {
    const parsed = editorPayloadSchema.parse(JSON.parse(fields.payload));
    if (parsed.fingerprint === undefined) {
      fields = {
        ...fields,
        payload: JSON.stringify({
          ...parsed,
          fingerprint: await currentFingerprint(fields.profileId),
        }),
      };
    }
  }
  const body = new URLSearchParams({ ...fields, _csrf: csrf });
  const request = app.request("/projects/viberr-core/agents", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  // SAFETY: as above — the action reads `request` and `params` only.
  return action({ request, params: { slug: "viberr-core" }, context: {} } as never);
}

/** Both answers the agents action can give, off its one return type. */
type AgentsActionReply = Awaited<
  ReturnType<typeof import("~/routes/project.agents").action>
>;

/** The payload a successful profile mutation answers with. `project.agents.tsx`
 *  keeps its own `ProfileMutationSuccess` private, so the fields these cases
 *  read are written down here. Both notices are OMITTED unless the save
 *  produced one — the page keys its extra toasts on the key being there. */
interface ProfileMutationReply {
  ok: true;
  toast: string;
  profileId: string;
  notices?: GrantCouplingNotice[];
  governanceNotice?: { message: string };
}

/** The success half of a reply. A refusal answers `{}`, so a case that expected
 *  a save and got a refusal reads `undefined` — the same failure the shape it
 *  replaces produced — rather than a type error. */
function saved(reply: AgentsActionReply): Partial<ProfileMutationReply> {
  return "ok" in reply ? reply : {};
}

/** …and the refusal half: `data({ ok: false, error }, { status })`. Both read
 *  `undefined` on a success, which is what the assertions want. */
function refusalStatus(reply: AgentsActionReply): number | undefined {
  return "ok" in reply ? undefined : reply.init?.status;
}
function refusalError(reply: AgentsActionReply): string | undefined {
  return "ok" in reply ? undefined : reply.data.error;
}

/** What a route THROWS to refuse a non-member: `data(message, { status })` —
 *  React Router's `DataWithResponseInit`, carrying the status and the body. */
interface ThrownRouteRefusal {
  init?: { status?: number };
  data?: unknown;
}

/** The refusal a guarded entry point threw. The rejection handler names the
 *  contract (`requireProjectMember` / `requireVisibleProject` throw `data(…)`)
 *  and the resolve branch answers an EMPTY refusal, so a call that unexpectedly
 *  succeeds reads `undefined` and fails its case instead of passing it. */
function refusalThrownBy<T>(call: Promise<T>): Promise<ThrownRouteRefusal> {
  return call.then(
    (): ThrownRouteRefusal => ({}),
    (rejection: ThrownRouteRefusal) => rejection,
  );
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
    // The signed-out guard refuses with a redirect Response, not a `data(…)`
    // refusal — the `toBeInstanceOf` below is what pins that apart.
    const thrown = await runLoader().then(
      () => null,
      (rejection: Response) => rejection,
    );
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown?.status).toBe(302);
  });

  it("answers a non-member as an unknown slug, never 403 (F19-28)", async () => {
    // deniz is a registered user but NOT a member of viberr-core. This used to
    // assert 403 ("Only project members can view this project's agents") — a
    // project-existence ORACLE, since an unknown slug 404s. R15-4 makes
    // projects members-only, so the two answers must be indistinguishable: the
    // loader runs ALONE under single fetch's `?_routes=` filter, so the
    // layout's 404 chokepoint is not a substitute for this gate.
    const thrown = await refusalThrownBy(runLoader(ids.deniz));
    expect(thrown.init?.status).toBe(404);
    expect(String(thrown.data)).toBe("No project at projects/viberr-core.");
    expect(String(thrown.data)).not.toMatch(/member/i);
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
    // Operator action-bucket sizes: the 4 seeded direct grants (dynamic-dispatch
    // rework — `dispatch-agents` + the two coordination caps + R15-2's delivery)
    // + A1's materialized `use-web-search-fetch` AND pass-24 A-1's materialized
    // `update-task-branch` — the seeded operator omits both grants but the
    // runtime keeps web egress ON (absent⇒kept) and updateBranchGate resolves an
    // absent branch-update through the delivery gate (here `direct`, an
    // auto-advance project). => 6 direct / 2 recommend / 3 forbidden. Every
    // governance-derived grant is shown at its runtime mode.
    expect(operator.actions.direct).toHaveLength(6);
    expect(operator.actions.recommend).toHaveLength(2);
    expect(operator.actions.forbidden).toHaveLength(3);
    // A1: the operator's absent web-egress renders Allowed (matches the runtime).
    expect(operator.actions.direct).toContain("Search & fetch from the web");
    // A-1 (pass 24): the absent branch-update grant renders at the delivery-gate
    // mode (Allowed on this auto project), not omitted, not a flat catalog direct.
    expect(operator.actions.direct).toContain("Bring the task branch up to date");
    // Dynamic-dispatch rework (2026-08-29): the retired assign/summon slot pair
    // collapsed into ONE `dispatch-agents` grant, labelled "Select & run agents".
    // Neither retired vocabulary may resurface in the rendered bucket.
    expect(operator.actions.direct).toContain("Select & run agents");
    expect(operator.actions.direct.join(" ")).not.toMatch(/primary specialist/i);
    expect(operator.actions.direct.join(" ")).not.toMatch(/summon|delivering agent/i);
    expect(operator.actions.direct).toContain("Deliver the branch & open the review PR");
    expect(operator.actions.direct).not.toContain("Compress long-running timelines");

    // The label/id split has a trap: the seed (agent-catalog.server.ts) spells
    // the operator's grants as catalog LABELS and resolves them through
    // `capabilityByLabel`. A label that drifts from that literal does NOT error
    // — the grant silently falls through to a display-only `extra`, which lands
    // in the very same `actions.direct` bucket, so the assertion above would
    // still pass while the operator held no runtime authority at all. Pin the
    // resolution, not just the rendered string.
    expect(
      operator.capabilities.find((c) => c.capabilityId === "dispatch-agents")?.mode,
    ).toBe("direct");
    expect(operator.extras.map((e) => e.label)).not.toContain("Select & run agents");
    expect(operator.extras.map((e) => e.label).join(" ")).not.toMatch(/primary specialist|summon/i);

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
    // F34-5: the status is read from each engagement's own run row. The
    // primary and the r0 reviewer have running rows (beforeAll) and say so; the
    // operator has none, so it is "on call" even though the task is
    // agent-waiting.
    expect(vib151.map((d) => [d.profileId, d.engagement, d.status])).toEqual([
      ["operator", "operator", "on call"],
      ["developer", "primary", "working"],
      ["reviewer", "reviewer", "working"],
    ]);
    // The running claude primary + codex r0 reviewer inserted in beforeAll.
    expect(vib151.find((d) => d.engagement === "primary")!.running).toBe(true);
    expect(vib151.find((d) => d.engagement === "reviewer")!.running).toBe(true);
    expect(vib151.find((d) => d.engagement === "operator")!.running).toBe(false);

    // Done tasks contribute nothing; triage tasks have no operator.
    expect(data.deployments.some((d) => d.taskKey === "VIB-139")).toBe(false);
    expect(data.deployments.some((d) => d.taskKey === "VIB-166")).toBe(false);

    // VIB-142 (review · waiting human, no runs): packet open / waiting on
    // human for every engagement kind — the reviewer reads by the same rule.
    const vib142 = data.deployments.filter((d) => d.taskKey === "VIB-142");
    expect(vib142.map((d) => d.status)).toEqual([
      "packet open",
      "waiting on human",
      "waiting on human",
    ]);
  });

  /**
   * Ruling 127 — this page used to ask the deployment "is Codex configured?".
   * There is no such fact: a run bills a PERSON. The loader answers two
   * person-shaped questions instead, and the second one is scoped to THIS
   * project's members, because a member of another project connecting Codex
   * changes nothing about what can run here.
   */
  describe("backend connections (ruling 127)", () => {
    const memberCount = async (): Promise<number> => {
      const { listProjectMembers } = await import(
        "~/server/projections/board-query.server"
      );
      return listProjectMembers(app.db, "viberr-core").length;
    };

    it("nobody connected: zero for everyone, and no second availability pair", async () => {
      const total = await memberCount();
      expect(total).toBeGreaterThan(0);
      const data = await runLoader(ids.arda);
      expect(data.backendHealth).toEqual({
        claude: {
          backend: "claude",
          viewerConnected: false,
          membersConnected: 0,
          membersTotal: total,
        },
        codex: {
          backend: "codex",
          viewerConnected: false,
          membersConnected: 0,
          membersTotal: total,
        },
      });
      // Ruling 127: the page answers backends ONCE. A fresh instance where
      // nobody has connected anything must still be able to author profiles
      // (runs bill the task owner, not the author), so the loader ships no
      // second boolean pair for a form gate to read.
      expect("backendAvailable" in data).toBe(false);
    });

    it("counts MEMBERS who connected, tells each viewer about their own account, and ignores outsiders", async () => {
      const { connectFakeBackend, disconnectFakeBackend } = await import(
        "../../../test-support/backend-credentials"
      );
      const total = await memberCount();
      // Arda is a member of viberr-core; Deniz is a registered user who is not.
      await connectFakeBackend(app.db, ids.arda, "claude");
      await connectFakeBackend(app.db, ids.deniz, "codex");
      try {
        const mine = await runLoader(ids.arda);
        expect(mine.backendHealth.claude).toEqual({
          backend: "claude",
          viewerConnected: true,
          membersConnected: 1,
          membersTotal: total,
        });

        // Selin sees the same COUNT (a project fact) and a different answer
        // about herself (a personal one).
        const theirs = await runLoader(ids.selin);
        expect(theirs.backendHealth.claude.membersConnected).toBe(1);
        expect(theirs.backendHealth.claude.viewerConnected).toBe(false);

        // Deniz connected Codex but is not a member here: the count stays 0.
        expect(mine.backendHealth.codex.membersConnected).toBe(0);
        expect(theirs.backendHealth.codex.membersConnected).toBe(0);
      } finally {
        await disconnectFakeBackend(app.db, ids.arda, "claude");
        await disconnectFakeBackend(app.db, ids.deniz, "codex");
      }
    });
  });
});

describe("action RBAC (profile CRUD is admin-only)", () => {
  it("rejects a reviewer from creating a profile", async () => {
    const result = await postAction(ids.selin, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    });
    expect(refusalStatus(result)).toBe(403);
  });

  it("answers a non-member as an unknown slug, never 403 (E2)", async () => {
    // Was 403 — a reply that confirms the project exists. The project is
    // invisible to a non-member (R15-4), so the action refuses before it ever
    // reaches the `manage-agents` tier check. The member-below-tier case above
    // still gets the honest 403.
    const thrown = await refusalThrownBy(
      postAction(ids.deniz, {
        intent: "delete-profile",
        profileId: "reviewer",
      }),
    );
    expect(thrown.init?.status).toBe(404);
    expect(String(thrown.data)).toMatch(/^No project at projects\//);
  });

  it("rejects deleting the operator even for an admin (server invariant)", async () => {
    const result = await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "operator",
    });
    expect(refusalStatus(result)).toBe(403);
    expect(refusalError(result)).toContain("system profile");
  });

  it("rejects unknown intents", async () => {
    const result = await postAction(ids.arda, { intent: "frobnicate" });
    expect(refusalStatus(result)).toBe(400);
  });
});

/**
 * Ruling 156 (pass 35, F35-7): "Use the template's grants" on the Agents page
 * rewrites this project's copy of a template's grants. Org admins only (owner,
 * Q35-8): a project admin who is not one sees the marker and asks. The button
 * carries the record the page rendered (B5), so a stale one is refused.
 */
describe("sync-profile-resources (ruling 156)", () => {
  const PROFILE = "sync-probe";

  async function saveTemplate(mcps: string[], create = false) {
    const { saveGlobalAgentProfile } = await import("~/server/org/gagents.server");
    await saveGlobalAgentProfile(
      app.db,
      {
        id: create ? null : PROFILE,
        name: "Sync Probe",
        backend: "claude",
        summary: "Probes the grant propagation.",
        persona: "",
        stages: ["impl"],
        mcps,
      },
      { userId: ids.arda, label: "Arda" },
      { dataRoot: app.dataRoot },
    );
  }

  async function copyMcps(): Promise<string[] | undefined> {
    const { readProjectFile } = await import("~/server/files/project-writer.server");
    return readProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot })!
      .parsed.frontmatter.agents.find((a) => a.profileId === PROFILE)!.definition
      ?.resources?.mcps;
  }

  it("an org admin rewrites the copy and the audit row lands; a reviewer answers 403; a stale fingerprint is refused", async () => {
    // A fresh template, deployed from the library (the deploy writes the copy),
    // then granted on the template so the copy drifts.
    await saveTemplate([], true);
    const deployed = saved(
      await postAction(ids.arda, { intent: "deploy-profile", profileId: PROFILE }),
    );
    expect(deployed.ok).toBe(true);
    await saveTemplate(["github"]);
    expect(await copyMcps()).toEqual([]);
    const loaded = await runLoader(ids.arda);
    const drifted = loaded.profiles.find((p) => p.id === PROFILE)!;
    expect(drifted.templateDrift).toMatchObject({ missing: { mcps: ["github"] } });
    expect(loaded.viewerIsOrgAdmin).toBe(true);
    expect((await runLoader(ids.selin)).viewerIsOrgAdmin).toBe(false);

    // A reviewer is refused at the project's own gate.
    const denied = await postAction(ids.selin, {
      intent: "sync-profile-resources",
      profileId: PROFILE,
      fingerprint: drifted.fingerprint,
    });
    expect(refusalStatus(denied)).toBe(403);

    // A stale record is refused with the editor's own sentence, nothing written.
    const stale = await postAction(ids.arda, {
      intent: "sync-profile-resources",
      profileId: PROFILE,
      fingerprint: "stale",
    });
    expect(refusalError(stale)).toContain("changed while the editor was open");
    expect(await copyMcps()).toEqual([]);

    // Canary: drop the `sync-profile-resources` arm and this reads the
    // "Unknown action." 400.
    const synced = saved(
      await postAction(ids.arda, {
        intent: "sync-profile-resources",
        profileId: PROFILE,
        fingerprint: drifted.fingerprint,
      }),
    );
    // Ruling 479(d): the reply names what the press added (and, below, what
    // it removed), as ruling 156 says it does.
    expect(synced.toast).toBe(
      '"Sync Probe" now carries the template\'s grants · added MCP server github · changes apply from the next run',
    );
    expect(await copyMcps()).toEqual(["github"]);
    expect(
      (await runLoader(ids.arda)).profiles.find((p) => p.id === PROFILE)!.templateDrift,
    ).toBeNull();
    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.resources_synced",
    });
    expect(audit[0]).toMatchObject({
      projectSlug: "viberr-core",
      subjectId: PROFILE,
      details: { templateId: PROFILE, mcps: ["github"] },
    });

    // Ruling 479(d): the template drops the grant, so the copy now holds one
    // the template does not; the press takes it off and the toast says so.
    // Canary: drop the `removed` clause from the route's toast.
    await saveTemplate([]);
    const extra = (await runLoader(ids.arda)).profiles.find((p) => p.id === PROFILE)!;
    const dropped = saved(
      await postAction(ids.arda, {
        intent: "sync-profile-resources",
        profileId: PROFILE,
        fingerprint: extra.fingerprint,
      }),
    );
    expect(dropped.toast).toBe(
      '"Sync Probe" now carries the template\'s grants · removed MCP server github · changes apply from the next run',
    );
    expect(await copyMcps()).toEqual([]);

    // Leave the store as the seed shipped it for the cases that follow: the
    // deployment goes, then the template file.
    expect(
      saved(await postAction(ids.arda, { intent: "delete-profile", profileId: PROFILE })).ok,
    ).toBe(true);
    rmSync(path.join(app.dataRoot, "agents", "profiles", `${PROFILE}.md`), { force: true });
  });
});

describe("profile CRUD round trip (project.md writers + audit)", () => {
  it("create → deployment entry with inline definition; server-generated slug id", async () => {
    const result = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    }));
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
      // No picked model in FORM → per-backend catalog default. F20-33 made the
      // codex default Terra (Sol 400s on a ChatGPT-plan account).
      model: "gpt-5.6-terra",
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
    const result = saved(await postAction(ids.arda, {
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
    }));
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
    const result = saved(await postAction(ids.arda, {
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
    }));
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
    const result = saved(await postAction(ids.arda, {
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
    }));
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
   * (`specialistGrantModes`), which honors the `off`. An admin who deliberately withheld
   * repo writes got them back on the next save.
   */
  it("an EXPLICIT headline `off` survives the save, and the contradiction is recorded (B-AG1)", async () => {
    const result = saved(await postAction(ids.arda, {
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
    }));
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
    expect(audit.details?.deliveryGrants).toBe("withheld");
    expect(audit.details?.deliveryNote).toContain("cannot deliver");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "withheld-dev",
    });
  });

  /**
   * B-AG1's other half: the notice reached the AUDIT LOG only. The route dropped
   * `result.notice` and answered with the plain success toast, so the single
   * outcome a live admin can produce from the editor (`withheld` — the modal
   * materializes every capability id, so the headline is never merely absent)
   * was silent non-repair: the profile saves, cannot deliver, and says nothing.
   */
  it("the action result carries the delivery notice so the save is not silently non-repairing (B-AG1)", async () => {
    const contradictory = (name: string) => ({
      name,
      role: "No repo writes",
      backend: "claude",
      stages: ["impl"],
      definition: "Headline explicitly off; scoped delivery left on.",
      caps: {
        "execute-code-or-write-repo": "off",
        "commit-push-branch": "direct",
      },
      resources: { skills: [], mcps: [], kb: [] },
    });
    const created = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(contradictory("Silent Dev")),
    }));
    expect(created.ok).toBe(true);
    expect(created.notices?.[0]?.kind).toBe("withheld");
    expect(created.notices?.[0]?.message).toContain("cannot deliver");

    // Editing it (the real path an admin walks into a legacy VIB-1 profile on)
    // reports the same thing rather than a bare "updated" tick.
    const updated = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "silent-dev",
      payload: JSON.stringify(contradictory("Silent Dev")),
    }));
    expect(updated.ok).toBe(true);
    expect(updated.notices?.[0]?.kind).toBe("withheld");
    expect(updated.notices?.[0]?.message).toContain("Commit");

    // A profile with nothing to decide carries no notice at all.
    const clean = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        ...contradictory("Plain Dev"),
        caps: { "execute-code-or-write-repo": "direct" },
      }),
    }));
    expect(clean.notices).toBeUndefined();

    for (const profileId of ["silent-dev", "plain-dev"]) {
      await postAction(ids.arda, { intent: "delete-profile", profileId });
    }
  });

  /**
   * Owner ruling 2026-08-20 — browser→egress coupling, end to end. The live
   * failure shape: an admin grants "Drive a live web browser", leaves "Search &
   * fetch from the web" off, and every run honestly reports "browser not
   * mounted" against a matrix that says Allowed (`resolveBrowserMcp` refuses
   * the pair in disagreement). The save layer now repairs the pair — the
   * browser grant carries egress with it — and the decision is disclosed on
   * the result AND the audit row, never silent.
   */
  it("a granted browser carries web egress with it, disclosed as a notice", async () => {
    const payload = (name: string) => ({
      name,
      role: "Screenshots",
      backend: "claude",
      stages: ["impl"],
      definition: "Browser granted; egress explicitly off.",
      caps: {
        "use-browser": "direct",
        "use-web-search-fetch": "off",
      },
      resources: { skills: [], mcps: [], kb: [] },
    });
    const created = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(payload("Browser Dev")),
    }));
    expect(created.ok).toBe(true);
    const notice = created.notices?.find((n) => n.rule === "browser-egress");
    expect(notice?.kind).toBe("repaired");
    expect(notice?.message).toContain("web egress");

    // The STORED grant is the repaired one — the runtime mount gate and the
    // matrix now agree (canonical file truth, same idiom as the create test
    // above: each capability row's mode is the line after its id).
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    const deployment = file.slice(file.indexOf("profileId: browser-dev"));
    for (const id of ["use-browser", "use-web-search-fetch"]) {
      const row = deployment.indexOf(id);
      expect(row, `${id} row must be stored`).toBeGreaterThan(0);
      expect(deployment.slice(row, row + id.length + 30)).toContain(
        "mode: direct",
      );
    }

    // The audit row carries the decision under its own keys.
    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.created",
    }).find((e) => e.subjectId === "browser-dev")!;
    expect(audit.details).toMatchObject({ browserEgress: "repaired" });

    // Editing the profile back into the contradiction repairs it again.
    const updated = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "browser-dev",
      payload: JSON.stringify(payload("Browser Dev")),
    }));
    expect(updated.ok).toBe(true);
    expect(
      updated.notices?.find((n) => n.rule === "browser-egress")?.kind,
    ).toBe("repaired");

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "browser-dev",
    });
  });

  it("R20-6/F20-21 — a stray specialist `recommend` normalizes to `off` (withheld) on create", async () => {
    // The specialist picker no longer offers `recommend`, but a hostile/legacy
    // form might still submit it. R20-6: a specialist has no `recommend`, so a
    // stray one normalizes DOWN to `off` (withheld, the SAFE direction) — never
    // up to `direct` (the old F7-CAP1 widening, which F20-21 removed because it
    // made a stored `recommend` render/count/enforce as `direct`); `human`/`off`
    // pass through unchanged.
    const result = saved(await postAction(ids.arda, {
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
    }));
    expect(result.ok).toBe(true);

    const created = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "recommender",
    )!;
    const mode = (id: string) =>
      created.capabilities.find((c) => c.capabilityId === id)?.mode;
    // Both submitted `recommend` grants normalized to `off` (withheld).
    expect(mode("open-review-pr")).toBe("off");
    expect(mode("commit-push-branch")).toBe("off");
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

  it("R20-6/F20-21 — editing a specialist normalizes a submitted `recommend` to `off` (grantsFor path)", async () => {
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
    const upd = saved(await postAction(ids.arda, {
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
    }));
    expect(upd.ok).toBe(true);

    const edited = (await runLoader(ids.arda)).profiles.find(
      (p) => p.id === "editable-dev",
    )!;
    const mode = (id: string) =>
      edited.capabilities.find((c) => c.capabilityId === id)?.mode;
    expect(mode("open-review-pr")).toBe("off");
    expect(mode("commit-push-branch")).toBe("off");
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
    const upd = saved(await postAction(ids.arda, {
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
    }));
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
    const result = saved(await postAction(ids.arda, {
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
    }));
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
    const result = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify(FORM),
    }));
    expect(result.ok).toBe(true);
    expect(result.profileId).toBe("migrations-2");
  });

  it("edit stores the operator's backend/model/autonomy + governs its caps", async () => {
    const result = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: JSON.stringify({
        name: "Operator",
        role: "Task coordinator",
        backend: "codex",
        stages: ["triage", "ready", "impl", "review", "done"],
        definition: "Updated operator definition.",
        autonomy: "full",
        caps: { "dispatch-agents": "recommend", "stage-transitions": "direct" },
        resources: { skills: ["viberr-app-expertise"], mcps: ["viberr"], kb: ["architecture-notes"] },
      }),
    }));
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
    // Operator RBAC modes are editable (dispatch → recommend, transitions → direct).
    const modeOf = (id: string) =>
      operator.capabilities.find((c) => c.capabilityId === id)?.mode;
    expect(modeOf("dispatch-agents")).toBe("recommend");
    expect(modeOf("stage-transitions")).toBe("direct");
  });

  it("delete removes the deployment; the org template file survives", async () => {
    for (const profileId of ["migrations", "migrations-2"]) {
      const result = saved(await postAction(ids.arda, {
        intent: "delete-profile",
        profileId,
      }));
      expect(result.ok).toBe(true);
    }
    const data = await runLoader(ids.arda);
    // Back to the base roster: operator + developer + reviewer.
    expect(data.profiles).toHaveLength(3);

    // Deleting a TEMPLATE-deployed profile also only removes the deployment.
    const del = saved(await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: "reviewer",
    }));
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
    const result = saved(await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "reviewer",
    }));
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

  /**
   * B-AG1's shape, one call site over: the library deploy ran the grants through
   * `normalizeDeliveryGrants`, which throws the notice away. A template whose
   * scoped delivery is on while the headline is explicitly off deploys as a
   * profile that CANNOT deliver, and nothing — toast or audit — said so.
   */
  it("deploy-profile reports a contradictory template's delivery withholding (B-AG1 shape)", async () => {
    const templateId = "withheld-template";
    const templatePath = path.join(
      app.dataRoot,
      "agents",
      "profiles",
      `${templateId}.md`,
    );
    const { serializeAgentProfile } = await import(
      "~/server/files/agent-profile-file.server"
    );
    writeFileSync(
      templatePath,
      serializeAgentProfile({
        frontmatter: {
          id: templateId,
          kind: "specialist",
          name: "Withheld Template",
          role: "Probe",
          desc: "Scoped delivery on, headline off.",
          icon: "cpu",
          backends: ["claude"],
          model: "",
          scope: "Global base",
          stages: ["impl"],
          spanAll: false,
          capabilities: [
            { capabilityId: "execute-code-or-write-repo", mode: "off" },
            { capabilityId: "commit-push-branch", mode: "direct" },
          ],
          extras: [],
          resources: { skills: [], mcps: [], kb: [] },
        },
        description: "Probe persona.",
      }),
      "utf8",
    );

    const result = saved(await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: templateId,
    }));
    expect(result.ok).toBe(true);
    expect(result.notices?.[0]?.kind).toBe("withheld");
    expect(result.notices?.[0]?.message).toContain("cannot deliver");

    const audit = listAuditEvents(app.db, {
      action: "project.agent_profile.deployed",
    }).find((e) => e.subjectId === templateId)!;
    expect(audit.details).toMatchObject({ deliveryGrants: "withheld" });

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: templateId,
    });
    rmSync(templatePath, { force: true });
  });

  it("refuses a duplicate deploy, an unknown id, and a non-admin", async () => {
    const dup = await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "reviewer",
    });
    expect(refusalStatus(dup)).toBe(409);
    expect(refusalError(dup)).toContain("already deployed");

    const unknown = await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "no-such-template",
    });
    expect(refusalStatus(unknown)).toBe(404);

    // The operator template is a system profile — never library material,
    // rejected on its kind before any duplicate check.
    const operator = await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: "operator",
    });
    expect(refusalStatus(operator)).toBe(400);
    expect(refusalError(operator)).toContain("not a specialist template");

    const denied = await postAction(ids.selin, {
      intent: "deploy-profile",
      profileId: "reviewer",
    });
    expect(refusalStatus(denied)).toBe(403);
  });

  it("AP-11 sibling: a traversing profileId is rejected, not path.join'd into the store", async () => {
    // `agentProfileFilePath` joins its argument straight into the store (the
    // containment guard skills/KB got in F10-18 was never added to it), and
    // this id arrives from a form field — so the segment is validated here.
    for (const evil of ["../../project", "..", "a/b", "with\\sep"]) {
      const result = await postAction(ids.arda, {
        intent: "deploy-profile",
        profileId: evil,
      });
      expect(refusalStatus(result), evil).toBe(400);
      expect(refusalError(result), evil).toContain("not a valid profile id");
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
      saved(
        await postAction(ids.arda, {
          intent: "deploy-profile",
          profileId: templateId,
        }),
      ).ok,
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
    await saveGlobalAgentProfile(
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
    const deployed = saved(await postAction(ids.arda, {
      intent: "deploy-profile",
      profileId: orgProfileId,
    }));
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
    // Quoted, so a YAML 1.1 reader does not take it for `false`.
    expect(template).toMatch(/capabilityId: approve-review\n\s+mode: "off"/);
    expect(template).toMatch(/capabilityId: request-changes\n\s+mode: "off"/);

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

/**
 * F20-20: raising the operator to FULL autonomy (and/or granting it "Accept
 * completion into Done") lets it close tasks with no human — a governance
 * decision that used to be audited as a generic "project.agent_profile.updated"
 * row and never surfaced to the admin. It now writes an explicit
 * `project.operator.autonomy_changed` event AND rides a governance notice.
 */
describe("F20-20 — an operator autonomy elevation is audited + surfaced, not generic", () => {
  it("elevating supervised → full with direct-accept records a dedicated event and a notice", async () => {
    const operatorForm = (
      autonomy: "supervised" | "full",
      accept: "recommend" | "direct",
    ) =>
      JSON.stringify({
        name: "Operator",
        role: "Task coordinator",
        backend: "claude",
        stages: ["triage", "ready", "impl", "review", "done"],
        definition: "Operator.",
        autonomy,
        caps: { "completion-for-acceptance": accept },
        resources: { skills: [], mcps: [], kb: [] },
      });

    // Baseline the operator to supervised (self-contained regardless of the
    // order earlier tests left it in) — this is NOT an elevation, so no notice.
    const baseline = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: operatorForm("supervised", "recommend"),
    }));
    expect(baseline.ok).toBe(true);
    expect(baseline.governanceNotice).toBeUndefined();

    // Now elevate to full + direct accept-completion: the exception goes live.
    const elevated = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: operatorForm("full", "direct"),
    }));
    expect(elevated.ok).toBe(true);
    expect(elevated.governanceNotice?.message).toContain("full autonomy");
    expect(elevated.governanceNotice?.message).toContain("without a human");

    // A dedicated, greppable audit event — not just the generic updated row.
    // (`listAuditEvents` is newest-first, and an earlier test also elevates the
    // operator, so match on the row's own shape rather than by position.)
    const govRows = listAuditEvents(app.db, {
      action: "project.operator.autonomy_changed",
    }).filter((e) => e.subjectId === "operator");
    expect(
      govRows.some(
        (e) =>
          e.details?.from === "supervised" &&
          e.details.to === "full" &&
          e.details.directDoneLive === true,
      ),
      "an autonomy_changed event records supervised→full with the exception live",
    ).toBe(true);

    // …and the generic update row now carries the explicit autonomy fact too.
    const updated = listAuditEvents(app.db, {
      action: "project.agent_profile.updated",
    }).filter((e) => e.subjectId === "operator");
    expect(
      updated.some(
        (e) => e.details?.operatorAutonomy === "full",
      ),
    ).toBe(true);

    // Restore supervised so later tests see the seeded posture.
    await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "operator",
      payload: operatorForm("supervised", "recommend"),
    });
  });
});

/**
 * F21-13 — the backend and the model must agree AT SAVE TIME.
 *
 * Live repro: editing a Codex profile, clicking "Claude", and hitting Save
 * WHILE the model select still read "loading available models…". The dialog let
 * the save race the reload, and project.md ended up with `backends: [claude]`
 * next to `model: gpt-5.6-terra`. Nothing rejected the pair, and the next run
 * silently executed on Claude's default model — the agents page named Terra, the
 * provider ran Sonnet, and no surface said so.
 *
 * The client half (disable Save while the model list reloads) belongs to the
 * dialog; this is the server invariant under it, which holds however the request
 * was produced — an older client, a replayed form, a direct POST.
 */
describe("F21-13 — a model foreign to the chosen backend is refused", () => {
  it("refuses a Codex model on a Claude profile, naming both backends", async () => {
    const reply = await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        ...FORM,
        name: "Crossed Wires",
        backend: "claude",
        model: "gpt-5.6-terra",
      }),
    });
    expect(refusalStatus(reply)).toBe(400);
    const error = refusalError(reply)!;
    expect(error).toContain("GPT-5.6 Terra");
    expect(error).toContain("Codex");
    expect(error).toContain("Claude");

    // …and nothing was written: the incoherent pair never reaches project.md.
    const file = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(file).not.toContain("gpt-5.6-terra");
  });

  it("refuses a Claude model on a Codex profile (the mirror direction)", async () => {
    const reply = await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        ...FORM,
        name: "Crossed Back",
        backend: "codex",
        model: "claude-sonnet-4-5",
      }),
    });
    expect(refusalStatus(reply)).toBe(400);
    expect(refusalError(reply)).toContain("Claude");
  });

  it("refuses the same pair on UPDATE, not only on create", async () => {
    const created = saved(
      await postAction(ids.arda, {
        intent: "create-profile",
        payload: JSON.stringify({ ...FORM, name: "Switcher", backend: "codex" }),
      }),
    );
    expect(created.ok).toBe(true);

    const reply = await postAction(ids.arda, {
      intent: "update-profile",
      profileId: created.profileId!,
      payload: JSON.stringify({
        ...FORM,
        name: "Switcher",
        backend: "claude",
        model: "gpt-5.6-terra",
      }),
    });
    expect(refusalStatus(reply)).toBe(400);

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: created.profileId!,
    });
  });

  it("accepts a model the chosen backend DOES know — including a live-only dated id", async () => {
    // The Claude catalog is OPEN (the live `supportedModels()` list, dated ids,
    // and a cold cache all reach here), so the guard must reject "belongs to the
    // other backend", never "not in the curated three".
    const result = saved(
      await postAction(ids.arda, {
        intent: "create-profile",
        payload: JSON.stringify({
          ...FORM,
          name: "Dated",
          backend: "claude",
          model: "claude-sonnet-4-5",
        }),
      }),
    );
    expect(result.ok).toBe(true);

    const data = await runLoader(ids.arda);
    expect(data.profiles.find((p) => p.id === result.profileId)).toMatchObject({
      backends: ["claude"],
      model: "claude-sonnet-4-5",
    });

    await postAction(ids.arda, {
      intent: "delete-profile",
      profileId: result.profileId!,
    });
  });
});

/**
 * Ruling 139 (pass 34, G34-1): the profile editor refuses a CHANGED effort
 * tier the backend does not offer, by name; an UNCHANGED stale tier a
 * deployment legitimately stores (Codex `minimal`, accepted but not offered)
 * still saves an unrelated field.
 */
describe("effort tiers on the editor path (ruling 139)", () => {
  it("refuses a CHANGED out-of-list tier and names the valid ones", async () => {
    // Canary: make `assertEffortForBackend` a no-op — "ultra" lands in project.md.
    const result = await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "developer",
      payload: JSON.stringify({
        name: "Developer",
        role: "Implementation",
        backend: "claude",
        stages: ["impl"],
        definition: "",
        model: "sonnet",
        effort: "ultra",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    });
    expect(refusalStatus(result)).toBe(400);
    expect(refusalError(result)).toContain('"ultra" is not an effort tier Claude offers. Claude takes: low, medium, high, xhigh, max.');
    expect(readFileSync(path.join(app.dataRoot, "projects/viberr-core/project.md"), "utf8")).not.toContain("effort: ultra");
  });

  it("an UNCHANGED stale tier still saves an unrelated field", async () => {
    // Canary: refuse unconditionally in the writer — the preserved `minimal`
    // makes the form unsaveable.
    const { updateProjectFile } = await import("~/server/files/project-writer.server");
    await updateProjectFile({ projectSlug: "viberr-core", dataRoot: app.dataRoot }, (p) => {
      const dep = p.frontmatter.agents.find((a) => a.profileId === "developer")!;
      dep.definition = { ...dep.definition!, backends: ["codex"], model: "gpt-5.5", effort: "minimal" };
    });
    const result = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "developer",
      payload: JSON.stringify({
        name: "Developer (renamed)",
        role: "Implementation",
        backend: "codex",
        stages: ["impl"],
        definition: "",
        model: "gpt-5.5",
        effort: "minimal",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    }));
    expect(result.ok).toBe(true);
    const file = readFileSync(path.join(app.dataRoot, "projects/viberr-core/project.md"), "utf8");
    expect(file).toContain("Developer (renamed)");
    expect(file).toContain("effort: minimal");
  });
});

/**
 * B5 (pass 34, U34-3): a profile save cannot silently revert a write it never
 * saw. `updateAgentProfile` rebuilds the whole governed grant set from the
 * SUBMITTED form, and the modal seeds that form once, at open time — so a
 * modal opened before a concurrent write and saved after it reverted every
 * grant that write changed, reported success and audited it.
 */
describe("B5: a stale editor cannot revert a concurrent write", () => {
  const editorPayload = (fingerprint: string, caps: Record<string, string>) =>
    JSON.stringify({
      name: "Developer",
      role: "Implementation",
      backend: "claude",
      stages: ["impl"],
      definition: "",
      model: "sonnet",
      effort: "high",
      fingerprint,
      caps,
      resources: { skills: [], mcps: [], kb: [] },
    });

  it("a save carrying a STALE fingerprint is refused, and the concurrent write survives", async () => {
    // Canary: skip the comparison and write anyway — the case then finds the
    // concurrent grant reverted, which is exactly what shipped.
    const opened = await currentFingerprint("developer");

    // A second actor lands a write between the editor's read and its save.
    const concurrent = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "developer",
      payload: editorPayload(opened, { "use-browser": "direct" }),
    }));
    expect(concurrent.ok).toBe(true);
    const afterConcurrent = readFileSync(
      path.join(app.dataRoot, "projects/viberr-core/project.md"),
      "utf8",
    );
    expect(afterConcurrent).toContain("use-browser");

    // The stale editor saves the form it opened BEFORE that write.
    const stale = await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "developer",
      payload: editorPayload(opened, { "use-browser": "off" }),
    });
    expect(refusalStatus(stale)).toBe(409);
    expect(refusalError(stale)).toBe(
      "This profile changed while the editor was open. Reopen it to see the current grants, then save again.",
    );
    // Byte for byte: the refused save wrote nothing at all.
    expect(
      readFileSync(path.join(app.dataRoot, "projects/viberr-core/project.md"), "utf8"),
    ).toBe(afterConcurrent);
  });

  it("a save carrying the CURRENT fingerprint applies, and a create needs none", async () => {
    // Canary: require the field on `create-profile` too.
    const fresh = saved(await postAction(ids.arda, {
      intent: "update-profile",
      profileId: "developer",
      payload: editorPayload(await currentFingerprint("developer"), { "use-browser": "off" }),
    }));
    expect(fresh.ok).toBe(true);

    const created = saved(await postAction(ids.arda, {
      intent: "create-profile",
      payload: JSON.stringify({
        name: "No Fingerprint Needed",
        role: "Probe",
        backend: "claude",
        stages: ["impl"],
        definition: "A create has no prior record.",
        model: "sonnet",
        effort: "high",
        caps: {},
        resources: { skills: [], mcps: [], kb: [] },
      }),
    }));
    expect(created.ok).toBe(true);
  });
});
