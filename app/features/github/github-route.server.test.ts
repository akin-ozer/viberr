import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import { fakeGithubFetch } from "../../../test-support/fake-github";

/**
 * Route-level tests for /projects/:slug/github: loader shape from the
 * seeded store, action RBAC + degraded no-PAT results end-to-end, and the
 * grant-scope / reconcile flows against the canned GitHub transport
 * (fetchImpl injection via the feature action wrappers — the route module
 * itself has no transport hook by design).
 */

let app: AppTestContext;
let ids: { arda: string; murat: string; selin: string; deniz: string };

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("~/server/seed/demo-seed.server");
  runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ids = {
    arda: findUserByEmail(app.db, "arda@viberr.dev")!.id,
    murat: findUserByEmail(app.db, "murat@viberr.dev")!.id, // project maintainer
    selin: findUserByEmail(app.db, "selin@viberr.dev")!.id, // project contributor
    deniz: findUserByEmail(app.db, "deniz@viberr.dev")!.id, // NOT a member
  };
});
afterAll(() => app.cleanup());

async function loaderArgs(
  url: string,
  params: Record<string, string>,
  cookie?: string,
) {
  return {
    request: app.request(url, cookie ? { cookie } : {}),
    params,
    context: {},
  };
}

async function postAction(userId: string, intent: string) {
  const { action } = await import("~/routes/project.github");
  const { cookie, sessionId } = await app.cookieFor(userId);
  const csrf = await app.csrfFor(sessionId);
  const body = new URLSearchParams({ intent, _csrf: csrf });
  const request = app.request("/projects/viberr-core/github", {
    method: "POST",
    cookie,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return action({
    request,
    params: { slug: "viberr-core" },
    context: {},
  } as never);
}

describe("loader", () => {
  it("redirects signed-out users to /login", async () => {
    const { loader } = await import("~/routes/project.github");
    const thrown = await loader(
      (await loaderArgs("/projects/viberr-core/github", {
        slug: "viberr-core",
      })) as never,
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
  });

  it("404s for an unknown project", async () => {
    const { loader } = await import("~/routes/project.github");
    const { cookie } = await app.cookieFor(ids.arda);
    const thrown = await loader(
      (await loaderArgs("/projects/nope/github", { slug: "nope" }, cookie)) as never,
    ).catch((e) => e as { init?: { status?: number }; status?: number });
    expect(
      (thrown as { init?: { status?: number } }).init?.status ??
        (thrown as { status?: number }).status,
    ).toBe(404);
  });

  it("returns the seeded GithubViewData: repo panel, credential health, PR + branch rows", async () => {
    const { loader } = await import("~/routes/project.github");
    const { cookie } = await app.cookieFor(ids.arda);
    const { view } = (await loader(
      (await loaderArgs("/projects/viberr-core/github", {
        slug: "viberr-core",
      }, cookie)) as never,
    )) as { view: import("./github-query.server").GithubViewData };

    // Repo + connection: no PAT bound → honest degraded state, no network.
    expect(view.project).toEqual({
      slug: "viberr-core",
      name: "Viberr Core",
      repo: "akin-ozer/viberr",
      defaultBranch: "main",
    });
    expect(view.connection).toEqual({
      status: "no_pat_configured",
      repo: "akin-ozer/viberr",
    });

    // Credential health (honest empty slate): the seeded Viberr Core project
    // declares a credentialPolicy (requiredScopes) but binds NO PAT, so the
    // health is source 'none' — no fabricated label/masked token — while the
    // seeded VIB-142 pull_request:write violation still surfaces.
    expect(view.credential.configured).toBe(false);
    expect(view.credential.source).toBe("none");
    expect(view.credential.label).toBeNull();
    expect(view.credential.masked).toBeNull();
    expect(view.credential.requiredScopes).toEqual([
      "repo",
      "workflow",
      "read:org",
      "pull_request:write",
    ]);
    const missing = view.credential.scopes.find((s) => !s.ok);
    expect(missing).toMatchObject({
      id: "pull_request:write",
      source: "violation",
      flaggedTaskKey: "VIB-142",
    });
    expect(view.credential.openViolations.length).toBe(1);

    // PR list: newest PR first (spec §7.11 deterministic order).
    expect(view.prs.map((p) => p.number)).toEqual([318, 311, 298, 287]);
    expect(view.prs[0]).toEqual({
      taskKey: "VIB-142",
      number: 318,
      state: "review",
      title: "Attach execution workspace",
      branch: "vib-142-attach-workspace",
    });
    expect(view.prs.map((p) => p.state)).toEqual([
      "review",
      "review",
      "merged",
      "merged",
    ]);

    // Branch table: every task with a branch, numeric key order.
    expect(view.branches.map((b) => b.taskKey)).toEqual([
      "VIB-139",
      "VIB-141",
      "VIB-142",
      "VIB-145",
      "VIB-151",
      "VIB-153",
      "VIB-160",
    ]);
    const byKey = Object.fromEntries(view.branches.map((b) => [b.taskKey, b]));
    // Ruling 12: merged wins from the pr cache…
    expect(byKey["VIB-139"]!.sync).toBe("merged");
    expect(byKey["VIB-141"]!.sync).toBe("merged");
    // …and with no real compare data yet, everything else is honestly
    // synced — incl. VIB-160 (the mock derived "behind main" from
    // validation:failing; that conflation is deleted per spec §7.3).
    expect(byKey["VIB-142"]!.sync).toBe("synced");
    expect(byKey["VIB-160"]!.sync).toBe("synced");
    // Commit association from the github cache (VIB-142 seeds 3 commits).
    expect(byKey["VIB-142"]!.commitCount).toBe(3);
    expect(byKey["VIB-142"]!.pr).toEqual({ number: 318, state: "review" });
    expect(byKey["VIB-151"]!.pr).toBeNull();
  });
});

describe("action RBAC + degraded no-PAT results", () => {
  it("rejects non-members and viewers from reconcile", async () => {
    const result = (await postAction(ids.deniz, "reconcile")) as {
      init?: { status?: number };
      data?: { ok: boolean };
    };
    expect(result.init?.status).toBe(403);
  });

  it("rejects a reviewer from grant-scope (admin|maintainer only)", async () => {
    const result = (await postAction(ids.selin, "grant-scope")) as {
      init?: { status?: number };
    };
    expect(result.init?.status).toBe(403);
  });

  it("rejects a contributor from reconcile (R8-4: maintainer+, aligned with rescan)", async () => {
    const result = (await postAction(ids.selin, "reconcile")) as {
      init?: { status?: number };
    };
    expect(result.init?.status).toBe(403);
  });

  it("allows a maintainer to reconcile", async () => {
    const result = (await postAction(ids.murat, "reconcile")) as {
      ok: boolean;
      toast: string;
      result: string;
    };
    expect(result.ok).toBe(true);
    expect(result.result).toBe("no_pat_configured");
  });

  it("reconcile with no PAT → typed result + honest toast, not a crash", async () => {
    const result = (await postAction(ids.arda, "reconcile")) as {
      ok: boolean;
      toast: string;
      result: string;
    };
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured — connect a PAT to reconcile branches and PRs.",
      result: "no_pat_configured",
    });
  });

  it("grant-scope with no PAT → typed no_pat_configured copy, not a crash", async () => {
    const result = (await postAction(ids.arda, "grant-scope")) as {
      ok: boolean;
      toast: string;
      result: string;
    };
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured — connect a PAT before re-checking scopes.",
      result: "no_pat_configured",
    });
  });

  it("rejects unknown intents", async () => {
    const result = (await postAction(ids.arda, "frobnicate")) as {
      init?: { status?: number };
    };
    expect(result.init?.status).toBe(400);
  });
});

describe("grant-scope + reconcile against the canned GitHub transport", () => {
  const REPO = "akin-ozer/viberr";

  it("grant-scope with a widened classic PAT resolves the VIB-142 violation and writes the typed policy event", async () => {
    const { createPat, setProjectCredential, getProjectCredentialHealth } =
      await import("~/server/secrets/pat-store.server");
    const { runGrantScope } = await import("./github-actions.server");
    const { countOpenPolicyViolations, listScopeViolations } = await import(
      "~/server/projections/policy-violations.server"
    );
    const { getTaskDetail } = await import(
      "~/server/projections/task-query.server"
    );

    const actor = { userId: ids.arda, label: "arda@viberr.dev" };
    const pat = createPat(
      app.db,
      { userId: ids.arda, label: "viberr-bot", token: "ghp_testtoken42af" },
      actor,
    );
    setProjectCredential(app.db, { projectSlug: "viberr-core", patId: pat.id }, actor);

    // Classic token: x-oauth-scopes is authoritative; `repo` implies
    // pull_request:write → the violation's scope is now granted.
    const gh = fakeGithubFetch({
      "GET /user": {
        status: 200,
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, workflow, read:org" },
      },
      [`GET /repos/${REPO}`]: {
        status: 200,
        body: { full_name: REPO, private: true, default_branch: "main" },
      },
    });

    expect(countOpenPolicyViolations(app.db, "viberr-core")).toBe(1);
    const outcome = await runGrantScope(app.db, "viberr-core", actor, {
      dataRoot: app.dataRoot,
      fetchImpl: gh.fetchImpl,
    });
    expect(outcome).toEqual({
      ok: true,
      toast: "Scope granted · VIB-142 policy flag resolved",
      result: "resolved",
    });

    // Violation row resolved → rail badge source drops to 0.
    expect(countOpenPolicyViolations(app.db, "viberr-core")).toBe(0);
    expect(
      listScopeViolations(app.db, "viberr-core", { status: "open" }).length,
    ).toBe(0);

    // Credential health now reports every chip ok (banner → cred-ok).
    const health = getProjectCredentialHealth(app.db, "viberr-core");
    expect(health.configured).toBe(true);
    expect(health.scopes.every((s) => s.ok)).toBe(true);

    // The typed policy event landed on VIB-142's OWN timeline — file…
    const file = readFileSync(
      path.join(
        app.dataRoot,
        "projects/viberr-core/tasks/VIB-142/task.md",
      ),
      "utf8",
    );
    expect(file).toContain(
      "**Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved — operations needing `pull_request:write` will work now.",
    );
    // …and projection (newest-first timeline).
    const detail = getTaskDetail(app.db, "viberr-core", "VIB-142")!;
    expect(detail.timeline[0]!.type).toBe("policy");
    expect(detail.timeline[0]!.text).toContain("**Policy update:**");
  });

  it("a second grant-scope run is idempotent (nothing to resolve, all-clear toast)", async () => {
    const { runGrantScope } = await import("./github-actions.server");
    const gh = fakeGithubFetch({
      "GET /user": {
        status: 200,
        body: { login: "viberr-bot" },
        headers: { "x-oauth-scopes": "repo, workflow, read:org" },
      },
      [`GET /repos/${REPO}`]: {
        status: 200,
        body: { full_name: REPO, private: true, default_branch: "main" },
      },
    });
    const outcome = await runGrantScope(
      app.db,
      "viberr-core",
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(outcome.result).toBe("revalidated");
    expect(outcome.toast).toBe("Scopes re-checked — all required scopes granted.");
  });

  it("grant-scope while offline → network_unavailable copy, violation state untouched", async () => {
    const { runGrantScope } = await import("./github-actions.server");
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const outcome = await runGrantScope(
      app.db,
      "viberr-core",
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot, fetchImpl: offline },
    );
    expect(outcome.result).toBe("network_unavailable");
    expect(outcome.toast).toBe(
      "GitHub is unreachable — kept the last-known scope results.",
    );
  });

  it("reconcile captures REAL compare data → behind_main sync pill in the loader (ruling 12)", async () => {
    const { runReconcile } = await import("./github-actions.server");
    const { getGithubViewData } = await import("./github-query.server");

    const compareIdentical = {
      status: 200,
      body: { ahead_by: 0, behind_by: 0, status: "identical", commits: [] },
    };
    const seededVib142Commits = [
      { sha: "a91f7c2000000", commit: { message: "[VIB-142] add repo attach policy gate" } },
      { sha: "4ce0b18000000", commit: { message: "[VIB-142] branch reconciler + task projection" } },
      { sha: "12dd9af000000", commit: { message: "[VIB-142] tests for PR sync boundary" } },
    ];
    const prFixtures: Record<
      string,
      { number: number; state: string; title: string; merged_at: string | null }
    > = {
      "vib-142-attach-workspace": {
        number: 318, state: "open", title: "Attach execution workspace", merged_at: null,
      },
      "vib-145-sse-revalidate": {
        number: 311, state: "open", title: "SSE board revalidation", merged_at: null,
      },
      "vib-139-policy-split": {
        number: 298, state: "closed", title: "Policy split", merged_at: "2026-03-30T14:00:00Z",
      },
      "vib-141-typed-events": {
        number: 287, state: "closed", title: "Typed events", merged_at: "2026-03-30T12:00:00Z",
      },
    };

    const gh = fakeGithubFetch({
      [`GET /repos/${REPO}/compare/main...vib-139-policy-split`]: compareIdentical,
      [`GET /repos/${REPO}/compare/main...vib-141-typed-events`]: compareIdentical,
      [`GET /repos/${REPO}/compare/main...vib-142-attach-workspace`]: {
        status: 200,
        body: {
          ahead_by: 3, behind_by: 0, status: "ahead",
          commits: seededVib142Commits,
        },
      },
      [`GET /repos/${REPO}/compare/main...vib-145-sse-revalidate`]: compareIdentical,
      // THE ruling-12 case: VIB-151 is really behind the default branch.
      [`GET /repos/${REPO}/compare/main...vib-151-timeline-compression`]: {
        status: 200,
        body: { ahead_by: 1, behind_by: 2, status: "diverged", commits: [] },
      },
      [`GET /repos/${REPO}/compare/main...vib-153-operator-brevity`]: compareIdentical,
      [`GET /repos/${REPO}/compare/main...vib-160-rehydrate`]: compareIdentical,
      [`GET /repos/${REPO}/pulls`]: (call) => {
        const head = call.url.searchParams.get("head") ?? "";
        const branch = head.split(":")[1] ?? "";
        const pr = prFixtures[branch];
        return { status: 200, body: pr ? [pr] : [] };
      },
      [`GET /repos/${REPO}/pulls/318`]: { status: 200, body: prFixtures["vib-142-attach-workspace"] },
      [`GET /repos/${REPO}/pulls/311`]: { status: 200, body: prFixtures["vib-145-sse-revalidate"] },
      [`GET /repos/${REPO}/pulls/298`]: { status: 200, body: prFixtures["vib-139-policy-split"] },
      [`GET /repos/${REPO}/pulls/287`]: { status: 200, body: prFixtures["vib-141-typed-events"] },
    });

    const outcome = await runReconcile(
      app.db,
      "viberr-core",
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot, fetchImpl: gh.fetchImpl },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.result).toBe("ok");
    expect(outcome.toast).toBe(
      "Reconciled — every branch and PR maps to its task key",
    );

    const view = (await getGithubViewData(app.db, "viberr-core", {
      // Connection check hits GET /repos/{repo} — reuse a tiny fake.
      fetchImpl: fakeGithubFetch({
        [`GET /repos/${REPO}`]: {
          status: 200,
          body: { full_name: REPO, private: true, default_branch: "main" },
        },
      }).fetchImpl,
    }))!;
    const byKey = Object.fromEntries(view.branches.map((b) => [b.taskKey, b]));
    // Real compare data now drives the pill: merged > behind > synced.
    expect(byKey["VIB-151"]!.sync).toBe("behind_main");
    expect(byKey["VIB-139"]!.sync).toBe("merged");
    expect(byKey["VIB-142"]!.sync).toBe("synced");
    expect(byKey["VIB-142"]!.commitCount).toBe(3);
    // With a PAT bound the connection pill fact is real.
    expect(view.connection.status).toBe("connected");
  });

  it("reconcile while offline → stale-but-labeled toast, last-known rows kept", async () => {
    const { runReconcile } = await import("./github-actions.server");
    const { getGithubViewData } = await import("./github-query.server");
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const outcome = await runReconcile(
      app.db,
      "viberr-core",
      { userId: ids.arda, label: "arda@viberr.dev" },
      { dataRoot: app.dataRoot, fetchImpl: offline },
    );
    expect(outcome.result).toBe("ok");
    expect(outcome.toast).toBe(
      "GitHub is unreachable — showing the last-known branch and PR state.",
    );
    // Last-known projection data survives (spec §7.10).
    const view = (await getGithubViewData(app.db, "viberr-core", {
      fetchImpl: offline,
    }))!;
    expect(view.branches.length).toBe(7);
    expect(view.prs.length).toBe(4);
    expect(view.connection.status).toBe("network_unavailable");
  });
});
