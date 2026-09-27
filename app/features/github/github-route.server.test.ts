import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RouterContextProvider } from "react-router";
import type { Route } from "../../routes/+types/project.github";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import type { SeedUserIds } from "../../../test-support/demo-data";
import { fakeGithubFetch } from "../../../test-support/fake-github";

/**
 * Route-level tests for /projects/:slug/github: loader shape from the
 * seeded store, action RBAC + degraded no-PAT results end-to-end, and the
 * grant-scope / reconcile flows against the canned GitHub transport
 * (fetchImpl injection via the feature action wrappers — the route module
 * itself has no transport hook by design).
 */

let app: AppTestContext;

/**
 * The seeded users these cases act as: arda, murat (project maintainer), selin
 * (project contributor) and deniz (NOT a member).
 */
let ids: SeedUserIds;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../../test-support/demo-seed");
  ids = (await runDemoSeed(app.db, { dataRoot: app.dataRoot })).userIds;
});
afterAll(() => app.cleanup());

/** The route pattern the framework matches these calls under. */
const ROUTE_PATTERN = "/projects/:slug/github";

/** The loader/action argument the framework builds, assembled by hand: the
 *  route module is called directly here, so nothing else fills these in. */
function routeArgs(request: Request, params: { slug: string }): Route.LoaderArgs {
  return {
    request,
    url: new URL(request.url),
    params,
    pattern: ROUTE_PATTERN,
    context: new RouterContextProvider(),
  };
}

function loaderArgs(url: string, params: { slug: string }, cookie?: string) {
  return routeArgs(app.request(url, cookie ? { cookie } : {}), params);
}

/**
 * What this route's action hands back, as these cases read it: the typed
 * `GithubActionOutcome` (`ok`/`toast`/`result`), or the `data(…, { status })`
 * envelope a refusal returns (`init`/`data`). Every field is optional because
 * a case reads exactly one of the two halves.
 */
interface GithubActionReply {
  ok?: boolean;
  toast?: string;
  result?: string;
  init?: ResponseInit | null;
  data?: unknown;
}

async function postAction(
  userId: string,
  intent: string,
): Promise<GithubActionReply> {
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
  return action(routeArgs(request, { slug: "viberr-core" }));
}

describe("loader", () => {
  it("redirects signed-out users to /login", async () => {
    const { loader } = await import("~/routes/project.github");
    const thrown: unknown = await loader(
      loaderArgs("/projects/viberr-core/github", { slug: "viberr-core" }),
    ).catch((e) => e);
    expect(thrown).toBeInstanceOf(Response);
    // SAFETY: the assertion on the line above fails the case unless `thrown` is
    // a Response, so the status read below can only run on one.
    expect((thrown as Response).status).toBe(302);
  });

  it("returns the seeded GithubViewData: repo panel, credential health, PR + branch rows", async () => {
    const { loader } = await import("~/routes/project.github");
    const { cookie } = await app.cookieFor(ids.arda);
    const { view } = await loader(
      loaderArgs("/projects/viberr-core/github", { slug: "viberr-core" }, cookie),
    );

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
      // P13-D-28: null because the demo fixture's PR ref carries no reconciled
      // check-runs or reviews — the row now CARRIES the facts instead of
      // narrowing them away, which is what the finding was about.
      checks: null,
      // Ruling 276: which KIND of null. The fixture's ref carries no `checks`
      // key at all, so this is "never read" rather than "GitHub reported no
      // check runs" — two facts the row now keeps apart for the readers that
      // act on them differently.
      checksRead: false,
      // Ruling 360: the refused read, absent here (nothing refused in the seed).
      checksUnread: null,
      review: null,
      // F17-L6: the demo fixture's PR carries no reconciled mergeability.
      mergeable: null,
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
    // UI-05: REWRITTEN — this assertion pinned the bug. With NO
    // `github.reconcile` provenance row the branch was never compared against
    // main, and the old resolver defaulted behindBy to 0 so the row rendered
    // the green "synced" pill for a measurement that never ran (directly
    // contradicting the page's own "Not yet synced" freshness chip). An
    // unmeasured branch is `unknown` → "not compared". VIB-160 stays here for
    // the original point too: `validation: failing` must NOT imply "behind
    // main" (the mock's conflation, deleted per spec §7.3).
    expect(byKey["VIB-142"]!.sync).toBe("unknown");
    expect(byKey["VIB-160"]!.sync).toBe("unknown");
    // Commit association from the github cache (VIB-142 seeds 3 commits).
    expect(byKey["VIB-142"]!.commitCount).toBe(3);
    expect(byKey["VIB-142"]!.pr).toEqual({
      number: 318,
      state: "review",
      checks: null, // P13-D-28: carried, not narrowed away
      checksUnread: null, // Ruling 360: nothing refused in the seed
      review: null,
      mergeable: null, // F17-L6: carried, not narrowed away
    });
    expect(byKey["VIB-151"]!.pr).toBeNull();
  });

  // F10-28: the branch/PR rows above are a CACHE — there is no scheduled sync,
  // only the last manual reconcile. A surface that looks "live" while serving
  // stale state misleads, so the loader must disclose its own freshness.
  it("discloses freshness: never reconciled → no timestamp, no label, stale", async () => {
    const { loader } = await import("~/routes/project.github");
    const { cookie } = await app.cookieFor(ids.arda);
    const { view } = await loader(
      loaderArgs("/projects/viberr-core/github", { slug: "viberr-core" }, cookie),
    );

    // No `github.reconcile` provenance yet → null `at` (the view renders
    // "Never reconciled"), no relative label, and honestly stale.
    expect(view.reconcile).toEqual({ at: null, label: null, stale: true });
  });
});

describe("action RBAC + degraded no-PAT results", () => {
  it("rejects a reviewer from grant-scope (admin|maintainer only)", async () => {
    const result = await postAction(ids.selin, "grant-scope");
    expect(result.init?.status).toBe(403);
  });

  it("rejects a contributor from reconcile (R8-4: maintainer+, aligned with rescan)", async () => {
    const result = await postAction(ids.selin, "reconcile");
    expect(result.init?.status).toBe(403);
  });

  it("allows a maintainer to reconcile", async () => {
    const result = await postAction(ids.murat, "reconcile");
    expect(result.ok).toBe(true);
    expect(result.result).toBe("no_pat_configured");
  });

  it("reconcile with no PAT → typed result + honest toast, not a crash", async () => {
    const result = await postAction(ids.arda, "reconcile");
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured. Connect a PAT to reconcile branches and PRs.",
      result: "no_pat_configured",
    });
  });

  it("grant-scope with no PAT → typed no_pat_configured copy, not a crash", async () => {
    const result = await postAction(ids.arda, "grant-scope");
    expect(result).toEqual({
      ok: true,
      toast:
        "No GitHub credential configured. Connect a PAT before re-checking scopes.",
      result: "no_pat_configured",
    });
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
      toast: "Scopes re-checked · VIB-142 policy flag resolved",
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
      "**Policy update:** `pull_request:write` granted on the project credential. The earlier violation is resolved, and operations needing `pull_request:write` will work now.",
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
    expect(outcome.toast).toBe("Scopes re-checked. All required scopes granted.");
  });

  it("grant-scope while offline → network_unavailable copy, violation state untouched", async () => {
    const { runGrantScope } = await import("./github-actions.server");
    // P13-D-33: a SUCCESSFUL validation younger than REVALIDATE_COOLDOWN_MS is
    // reused instead of re-probing GitHub — and the case above just made one.
    // Drop the cached result so this case exercises the offline path it is
    // about, rather than the cooldown.
    app.db
      .prepare(
        `UPDATE github_pats SET validation_json = NULL, last_validated_at = NULL`,
      )
      .run();
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
      "GitHub is unreachable. Kept the last-known scope results.",
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
    /** The PR GitHub answers with for one task branch. */
    interface PrFixture {
      number: number;
      state: string;
      title: string;
      merged_at: string | null;
    }
    // Keyed by branch, and looked up by the `head` the reconciler asks for — a
    // real dictionary, so a Map rather than an object indexed by a computed key.
    const prFixtures = new Map<string, PrFixture>([
      ["vib-142-attach-workspace", {
        number: 318, state: "open", title: "Attach execution workspace", merged_at: null,
      }],
      ["vib-145-sse-revalidate", {
        number: 311, state: "open", title: "SSE board revalidation", merged_at: null,
      }],
      ["vib-139-policy-split", {
        number: 298, state: "closed", title: "Policy split", merged_at: "2026-03-30T14:00:00Z",
      }],
      ["vib-141-typed-events", {
        number: 287, state: "closed", title: "Typed events", merged_at: "2026-03-30T12:00:00Z",
      }],
    ]);

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
        const pr = prFixtures.get(branch);
        return { status: 200, body: pr ? [pr] : [] };
      },
      [`GET /repos/${REPO}/pulls/318`]: { status: 200, body: prFixtures.get("vib-142-attach-workspace") },
      [`GET /repos/${REPO}/pulls/311`]: { status: 200, body: prFixtures.get("vib-145-sse-revalidate") },
      [`GET /repos/${REPO}/pulls/298`]: { status: 200, body: prFixtures.get("vib-139-policy-split") },
      [`GET /repos/${REPO}/pulls/287`]: { status: 200, body: prFixtures.get("vib-141-typed-events") },
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
      "Status updated. Every branch and PR maps to its task key",
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

  /**
   * Ruling 401 (F39-28), live on ax-clone AX-12. A task can finish without ever
   * committing anything — that one delivered an upstream comparison as an
   * attachment, `noChanges: true`, no PR, zero commits, and no `ax-12` branch
   * anywhere on the remote or in the mirror. Viberr allocates the branch NAME
   * at creation, so the row existed and carried whatever the last compare had
   * said about its recorded revision: "behind main", in a RISK fill. A demand,
   * on finished work, for a branch that does not exist and never will — and
   * one that could never clear, because nothing about a completed task moves.
   *
   * VIB-151 is the perfect A/B: the ruling-12 `behind_main` case above, with
   * zero commits and no PR. Only its stage differs.
   */
  it("ruling 401: a finished task that committed nothing has no branch to be behind", async () => {
    const { getGithubViewData } = await import("./github-query.server");
    const { updateTaskFile } = await import("~/server/files/task-writer.server");
    const { rebuildTaskFile } = await import("~/server/projections/rebuilder.server");
    const syncOf = async (key: string) => {
      const view = (await getGithubViewData(app.db, "viberr-core", {
        fetchImpl: fakeGithubFetch({
          [`GET /repos/${REPO}`]: {
            status: 200,
            body: { full_name: REPO, private: true, default_branch: "main" },
          },
        }).fetchImpl,
      }))!;
      return view.branches.find((b) => b.taskKey === key)!;
    };

    // Control, and the state the previous test left: still in flight, really
    // behind, and the pill is a demand someone can meet.
    const before = await syncOf("VIB-151");
    expect(before.sync).toBe("behind_main");
    expect(before.pr).toBeNull();
    expect(before.commitCount).toBe(0);

    await updateTaskFile(
      { projectSlug: "viberr-core", taskKey: "VIB-151", dataRoot: app.dataRoot },
      (parsed) => {
        parsed.frontmatter.previousStageId = parsed.frontmatter.stage;
        parsed.frontmatter.stage = "done";
      },
    );
    rebuildTaskFile(app.db, "viberr-core", "VIB-151", { dataRoot: app.dataRoot });

    // CANARY: drop the terminal-stage arm and this stays `behind_main` — a red
    // pill on a completed task, forever, which is AX-12's row verbatim.
    const after = await syncOf("VIB-151");
    expect(after.sync).toBe("no_branch");

    // A finished task that DID commit keeps its real comparison: this arm is
    // about work that never reached a branch, not about being done.
    expect((await syncOf("VIB-142")).sync).toBe("synced");
    expect((await syncOf("VIB-139")).sync).toBe("merged");
  });

  // F10-28 (second half): a reconcile that just ran must flip the disclosure
  // from "never / stale" to a real timestamp, so the freshness badge is
  // evidence of the last sync rather than decoration.
  it("a successful reconcile stamps freshness: `at` set, label rendered, stale false", async () => {
    const { getGithubViewData } = await import("./github-query.server");
    const view = (await getGithubViewData(app.db, "viberr-core", {
      fetchImpl: fakeGithubFetch({
        [`GET /repos/${REPO}`]: {
          status: 200,
          body: { full_name: REPO, private: true, default_branch: "main" },
        },
      }).fetchImpl,
    }))!;
    expect(view.reconcile.at).not.toBeNull();
    expect(Number.isFinite(Date.parse(view.reconcile.at!))).toBe(true);
    // The label is computed server-side (SSR-stable) from that timestamp.
    expect(view.reconcile.label).toBe("just now");
    expect(view.reconcile.stale).toBe(false);
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
      "GitHub is unreachable. Showing the last-known branch and PR state.",
    );
    // Last-known projection data survives (spec §7.10).
    const view = (await getGithubViewData(app.db, "viberr-core", {
      fetchImpl: offline,
    }))!;
    expect(view.branches.length).toBe(7);
    expect(view.prs.length).toBe(4);
    expect(view.connection.status).toBe("network_unavailable");
  });

  // F10-28 (threshold): staleness is time-based — anything older than one hour
  // is stale, because the only sync is manual. Pinned here by backdating the
  // reconcile provenance, so the badge can't quietly widen its "fresh" window.
  // Runs last: it rewrites the project's `github.reconcile` observed_at rows.
  it("a reconcile older than the one-hour threshold reads stale, timestamp still shown", async () => {
    const { getGithubViewData } = await import("./github-query.server");
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const backdate = (msAgo: number) => {
      const at = new Date(Date.now() - msAgo).toISOString();
      app.db
        .prepare(
          `UPDATE provenance SET observed_at = ?
            WHERE action = 'github.reconcile'
              AND source_path LIKE 'projects/viberr-core/%'`,
        )
        .run(at);
      return at;
    };

    // Just inside the hour → still fresh.
    const fresh = backdate(59 * 60_000);
    let view = (await getGithubViewData(app.db, "viberr-core", {
      fetchImpl: offline,
    }))!;
    expect(view.reconcile.at).toBe(fresh);
    expect(view.reconcile.stale).toBe(false);

    // Past the hour → stale, but the `at`/label stay so the age is legible
    // (the view keeps rendering "Reconciled <label>" with the stale styling).
    const old = backdate(61 * 60_000);
    view = (await getGithubViewData(app.db, "viberr-core", {
      fetchImpl: offline,
    }))!;
    expect(view.reconcile.at).toBe(old);
    expect(view.reconcile.stale).toBe(true);
    expect(view.reconcile.label).not.toBeNull();
  });
});

/**
 * R19-11 (owner ruling, Q-V1 PAT half) — "a read-only Viewer must not see the
 * Danger zone or the PAT."
 *
 * The render gate in `github-view.tsx` is only half the ruling: single-fetch
 * serializes this loader's payload into the document, so hiding the card leaves
 * the masked tail sitting in a viewer's HTML — which is precisely the form the
 * pass-18 live session reported it in. So the LOADER withholds it, and these
 * cases assert the payload rather than the DOM.
 *
 * The bar is the SERVER's own: `grant-github-scope` (admin|maintainer), the
 * ACTION_ROLES entry this route's action guard enforces on grant-scope,
 * set-credential and clear-credential — which is why a contributor is refused
 * here for the same reason a viewer is. `roleCan` reads that entry; nothing
 * names a role.
 *
 * Runs last: it binds its own PAT and adds a viewer to project.md (the demo
 * seed's viberr-core has admin/admin/maintainer/contributor and no viewer).
 */
describe("R19-11: the loader withholds credential detail from readers without the grant", () => {
  const MASKED = "····9f3c";
  let realFetch: typeof fetch;

  beforeAll(async () => {
    // The route loader takes no fetchImpl by design, and a bound PAT makes
    // `checkRepoAccess` reach for the network. Offline keeps it hermetic.
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = offline;

    const { createPat, setProjectCredential } = await import(
      "~/server/secrets/pat-store.server"
    );
    const actor = { userId: ids.arda, label: "arda@viberr.dev" };
    const pat = createPat(
      app.db,
      { userId: ids.arda, label: "r19-11 fixture PAT", token: "ghp_r1911fixture9f3c" },
      actor,
    );
    setProjectCredential(app.db, { projectSlug: "viberr-core", patId: pat.id }, actor);

    const { updateProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    await updateProjectFile({ projectSlug: "viberr-core" }, (parsed) => {
      parsed.frontmatter.members.push({ userId: ids.deniz, role: "viewer" });
    });
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  const loadAs = async (userId: string) => {
    const { loader } = await import("~/routes/project.github");
    const { cookie } = await app.cookieFor(userId);
    return await loader(
      loaderArgs("/projects/viberr-core/github", { slug: "viberr-core" }, cookie),
    );
  };

  it("hands a maintainer the real credential — the control case", async () => {
    const { view } = await loadAs(ids.murat);
    expect(view.credential.source).toBe("pat");
    expect(view.credential.masked).toBe(MASKED);
    expect(view.credential.label).toBe("r19-11 fixture PAT");
    expect(view.credential.patId).not.toBeNull();
    expect(view.credential.scopes.length).toBeGreaterThan(0);
  });

  it("strips the tail, label, id and scope verdicts for a VIEWER", async () => {
    const { view } = await loadAs(ids.deniz);
    expect(view.credential.masked).toBeNull();
    expect(view.credential.label).toBeNull();
    expect(view.credential.patId).toBeNull();
    expect(view.credential.lastValidatedAt).toBeNull();
    expect(view.credential.validation).toBeNull();
    expect(view.credential.scopes).toEqual([]);
    expect(view.credential.openViolations).toEqual([]);
    // Nowhere in the payload, not merely on a hidden card.
    expect(JSON.stringify(view)).not.toContain("9f3c");
    expect(JSON.stringify(view)).not.toContain("r19-11 fixture PAT");
  });

  it("strips it for a CONTRIBUTOR too — the grant is maintainer+", async () => {
    const { view } = await loadAs(ids.selin);
    expect(view.credential.masked).toBeNull();
    expect(view.credential.label).toBeNull();
    expect(view.credential.scopes).toEqual([]);
  });

  it("keeps the non-secret facts the surface still renders", async () => {
    // The withheld card is replaced by a lock note plus the Connection row, and
    // that row must stay truthful: `configured`/`source` say only what the
    // connection pill says out loud, and required scopes are project policy —
    // published to every member on the Policy surface. Redacting them would buy
    // nothing and make the remaining copy guesswork.
    const { view } = await loadAs(ids.deniz);
    expect(view.credential.configured).toBe(true);
    expect(view.credential.source).toBe("pat");
    expect(view.credential.requiredScopes).toEqual([
      "repo",
      "workflow",
      "read:org",
      "pull_request:write",
    ]);
    // Everything that is NOT the credential is untouched by the redaction.
    expect(view.project.repo).toBe("akin-ozer/viberr");
    expect(view.branches.length).toBe(7);
    expect(view.prs.length).toBe(4);
  });
});
