import { describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import type { PrReviewState } from "~/schemas/task-file.schema";
import { createGithubClient } from "./github-client.server";
import {
  deriveMergeable,
  findPrForBranch,
  mapPrToCacheState,
  type PrApproval,
} from "./pr-linker.server";

/** The mergeability half of a PR detail payload — the only part these cases
 *  vary, and `deriveMergeable`'s own contract for it. */
type MergeabilityDetail = Parameters<typeof deriveMergeable>[0];

const REPO = "akin-ozer/viberr";
const REPO_PATH = `/repos/${REPO}`;

function client(routes: Parameters<typeof fakeGithubFetch>[0]) {
  const gh = fakeGithubFetch(routes);
  return {
    gh,
    client: createGithubClient({ token: "ghp_x", fetchImpl: gh.fetchImpl }),
  };
}

describe("PR state mapping matrix (ruling 12)", () => {
  it("maps merged / open / draft / closed-unmerged", () => {
    expect(mapPrToCacheState({ state: "closed", merged: true })).toBe("merged");
    expect(
      mapPrToCacheState({ state: "closed", merged_at: "2026-07-01T00:00:00Z" }),
    ).toBe("merged");
    expect(mapPrToCacheState({ state: "open" })).toBe("review");
    expect(mapPrToCacheState({ state: "open", merged: false })).toBe("review");
    expect(mapPrToCacheState({ state: "closed", merged_at: null })).toBe("closed");
  });
});

describe("findPrForBranch", () => {
  it("finds the newest head PR with detail stats and a checks summary", async () => {
    const { gh, client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 318,
            title: "Attach execution workspace",
            state: "open",
            draft: false,
            merged_at: null,
            head: { sha: "headsha318" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          draft: false,
          merged: false,
          merged_at: null,
          head: { sha: "headsha318" },
          additions: 412,
          deletions: 87,
          changed_files: 9,
        },
      },
      [`GET ${REPO_PATH}/commits/headsha318/check-runs`]: {
        body: {
          total_count: 3,
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "failure" },
            { status: "in_progress", conclusion: null },
          ],
        },
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.pr).toMatchObject({
        number: 318,
        state: "review",
        changed: { files: 9, add: 412, del: 87 },
        checks: { total: 3, passing: 1, failing: 1, pending: 1 },
      });
    }
    // head filter uses owner:branch
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls`)[0]!.url.searchParams.get("head")).toBe(
      "akin-ozer:vib-142-attach-workspace",
    );
  });

  it("maps a merged PR", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 298,
            title: "Store scan hardening",
            state: "closed",
            merged_at: "2026-07-01T10:00:00Z",
            head: { sha: "sha298" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/298`]: {
        body: {
          number: 298,
          title: "Store scan hardening",
          state: "closed",
          merged: true,
          merged_at: "2026-07-01T10:00:00Z",
          head: { sha: "sha298" },
          additions: 1,
          deletions: 1,
          changed_files: 1,
        },
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-139-store-scan");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.pr.state).toBe("merged");
      expect(result.pr.checks).toBeNull(); // check-runs route absent → 404 → null
    }
    // F26 fail-safe: the branch-head lookup route is absent (→ 404), so a
    // terminal PR still links (legitimate accepted/merged case is preserved).
  });

  it("F26: a stale terminal PR on a branch that MOVED ON is not linked (opens fresh)", async () => {
    // A reused branch: its only PR (#35) merged long ago at `oldsha`, but the
    // branch has since been force-pushed to `newsha` for a new delivery. The
    // merged PR must NOT be linked — the caller opens a fresh PR instead.
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          { number: 35, title: "[VIB-6] old merged work", state: "closed", merged_at: "2026-07-17T20:00:00Z", head: { sha: "oldsha" } },
        ],
      },
      [`GET ${REPO_PATH}/pulls/35`]: {
        body: { number: 35, state: "closed", merged: true, merged_at: "2026-07-17T20:00:00Z", head: { sha: "oldsha" } },
      },
      [`GET ${REPO_PATH}/branches/vib-6`]: { body: { commit: { sha: "newsha" } } },
    });
    const result = await findPrForBranch(c, REPO, "vib-6");
    expect(result.status).toBe("none");
  });

  it("F26: a terminal PR whose head STILL matches the branch is linked (merged/divergence case)", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          { number: 40, title: "[VIB-7] merged out of band", state: "closed", merged_at: "2026-07-18T10:00:00Z", head: { sha: "samesha" } },
        ],
      },
      [`GET ${REPO_PATH}/pulls/40`]: {
        body: { number: 40, state: "closed", merged: true, merged_at: "2026-07-18T10:00:00Z", head: { sha: "samesha" } },
      },
      [`GET ${REPO_PATH}/branches/vib-7`]: { body: { commit: { sha: "samesha" } } },
    });
    const result = await findPrForBranch(c, REPO, "vib-7");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.pr.number).toBe(40);
  });

  it("maps a closed-unmerged PR to 'closed' (risk pill)", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 300,
            title: "Abandoned spike",
            state: "closed",
            merged_at: null,
            head: { sha: "sha300" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/300`]: {
        body: {
          number: 300,
          title: "Abandoned spike",
          state: "closed",
          merged: false,
          merged_at: null,
          head: { sha: "sha300" },
        },
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-160-spike");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.pr.state).toBe("closed");
      expect(result.pr.changed).toBeNull(); // detail carried no stats
    }
  });

  it("no PR for the branch → none", async () => {
    const { client: c } = client({ [`GET ${REPO_PATH}/pulls`]: { body: [] } });
    expect(await findPrForBranch(c, REPO, "vib-153-nothing")).toEqual({
      status: "none",
    });
  });

  it("degrades typed on 403 / 401 / network", async () => {
    const forbidden = client({
      [`GET ${REPO_PATH}/pulls`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    expect(
      (await findPrForBranch(forbidden.client, REPO, "b")).status,
    ).toBe("forbidden");

    const auth = client({
      [`GET ${REPO_PATH}/pulls`]: { status: 401, body: { message: "Bad credentials" } },
    });
    expect((await findPrForBranch(auth.client, REPO, "b")).status).toBe(
      "auth_failed",
    );

    const offline = createGithubClient({
      token: "ghp_x",
      fetchImpl: unreachableFetch(),
    });
    expect((await findPrForBranch(offline, REPO, "b")).status).toBe(
      "network_unavailable",
    );
  });
});

// ------------------------------------------------ F21-7 check-runs accounting

/**
 * F21-7: every run GitHub reported is accounted for by exactly one counter. A
 * `null` conclusion is pending (still running, a real answer); an entry that
 * did not decode, an absent or unrecognized conclusion (GitHub's `stale`) and
 * the shortfall against `total_count` are `unknown`, never passing. The old
 * rollup summed `{ total_count: 3, check_runs: [null, "x"] }` to three runs
 * with nothing counted, which the pill mapper read as "3 checks passing" and
 * the reconciler persisted into task.md.
 */
describe("findPrForBranch check-runs accounting (F21-7)", () => {
  /** A check-runs answer as these cases send it: GitHub's two fields, with the
   *  drift each case injects into the entries. */
  interface CheckRunsBody {
    total_count?: number;
    check_runs?: unknown;
  }

  /** The PR fixture the drifted check-runs payloads hang off. */
  function driftedChecks(checkRunsBody: CheckRunsBody) {
    return client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 318,
            title: "Attach execution workspace",
            state: "open",
            draft: false,
            merged_at: null,
            head: { sha: "headsha318" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/318`]: {
        body: {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          merged: false,
          head: { sha: "headsha318" },
        },
      },
      [`GET ${REPO_PATH}/commits/headsha318/check-runs`]: {
        body: checkRunsBody,
      },
    });
  }

  it.each<[string, CheckRunsBody, Record<string, number>]>([
    [
      "counts every run GitHub reported into exactly one bucket",
      {
        total_count: 4,
        check_runs: [
          { conclusion: "success" },
          { conclusion: "skipped" },
          { conclusion: "failure" },
          { conclusion: null },
        ],
      },
      { total: 4, passing: 2, failing: 1, pending: 1 },
    ],
    [
      "reads undecodable entries and absent or unrecognized conclusions as unknown",
      { total_count: 3, check_runs: [null, {}, { conclusion: "stale" }] },
      { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 },
    ],
    [
      "never lets a null or non-object entry inflate passing",
      { total_count: 3, check_runs: [null, "x"] },
      { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 },
    ],
    [
      // Per-ENTRY tolerance: one bad entry used to void the whole array, which
      // discarded the runs GitHub reported perfectly well next to it.
      "still counts the readable siblings of an undecodable or conclusion-less run",
      {
        total_count: 4,
        check_runs: [
          { status: "completed", conclusion: "success" },
          null,
          { status: "completed" },
          { status: "completed", conclusion: "failure" },
        ],
      },
      { total: 4, passing: 1, failing: 1, pending: 0, unknown: 2 },
    ],
    [
      "leaves a reported total unaccounted when no runs are carried",
      { total_count: 3 },
      { total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 },
    ],
    [
      "leaves a reported total unaccounted when check_runs is not an array",
      { total_count: 2, check_runs: {} },
      { total: 2, passing: 0, failing: 0, pending: 0, unknown: 2 },
    ],
    [
      // The counters can never exceed the total they are shown against.
      "raises the total to the runs carried beyond it",
      { total_count: 1, check_runs: [{ conclusion: "success" }, { conclusion: "success" }] },
      { total: 2, passing: 2, failing: 0, pending: 0 },
    ],
    [
      "omits the unknown key on a clean read",
      { total_count: 2, check_runs: [{ conclusion: "success" }, { conclusion: "neutral" }] },
      { total: 2, passing: 2, failing: 0, pending: 0 },
    ],
  ])("%s", async (_label, checkRunsBody, checks) => {
    // CANARY: count an absent conclusion as passing and three rows fail.
    const { client: c } = driftedChecks(checkRunsBody);
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    // Strict, so an `unknown` key on a clean read fails even when undefined.
    expect(result.pr.checks).toStrictEqual(checks);
  });
});

// ------------------------------------------------------- P13-D-28 review state

describe("findPrForBranch review-state fetch (P13-D-28)", () => {
  const openRoutes = (
    extra: Parameters<typeof fakeGithubFetch>[0] = {},
    requested = 1,
  ): Parameters<typeof fakeGithubFetch>[0] => ({
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          merged_at: null,
          head: { sha: "headsha318" },
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/318`]: {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        merged: false,
        merged_at: null,
        head: { sha: "headsha318" },
        requested_reviewers: Array.from({ length: requested }, (_, i) => ({ login: `r${i}` })),
      },
    },
    ...extra,
  });

  it("reads reviews for an OPEN PR and reports the derived state", async () => {
    const { gh, client: c } = client(
      openRoutes({
        [`GET ${REPO_PATH}/pulls/318/reviews`]: {
          body: [
            { user: { login: "ayse" }, state: "COMMENTED" },
            { user: { login: "ayse" }, state: "CHANGES_REQUESTED" },
          ],
        },
      }),
    );
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.pr.review).toBe("changes_requested");
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/318/reviews`)).toHaveLength(1);
  });

  it("requested reviewers come free off the detail fetch → review_required", async () => {
    const { client: c } = client(
      openRoutes({ [`GET ${REPO_PATH}/pulls/318/reviews`]: { body: [] } }),
    );
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.pr.review).toBe("review_required");
  });

  it("a FAILED reviews read leaves `review` ABSENT (unknown), not null", async () => {
    // The route is missing → 404. "We could not read it" must be distinguishable
    // from "we read it and nobody has reviewed", or the caller blanks the pill.
    const { client: c } = client(openRoutes());
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect("review" in result.pr).toBe(false);
    }
  });

  it("spends NO reviews call on a settled (merged) PR — the whole point of D-28", async () => {
    const { gh, client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 298,
            title: "Store scan hardening",
            state: "closed",
            merged_at: "2026-07-01T10:00:00Z",
            head: { sha: "sha298" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/298`]: {
        body: {
          number: 298,
          title: "Store scan hardening",
          state: "closed",
          merged: true,
          merged_at: "2026-07-01T10:00:00Z",
          head: { sha: "sha298" },
        },
      },
      [`GET ${REPO_PATH}/branches/vib-139-store-scan`]: {
        body: { commit: { sha: "sha298" } },
      },
      [`GET ${REPO_PATH}/pulls/298/reviews`]: { body: [{ user: { login: "a" }, state: "APPROVED" }] },
    });
    const result = await findPrForBranch(c, REPO, "vib-139-store-scan");
    expect(result.status).toBe("found");
    if (result.status === "found") expect("review" in result.pr).toBe(false);
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/298/reviews`)).toHaveLength(0);
  });

  /** One `/reviews` entry as GitHub sends it. An omitted `commit_id` or
   *  `submitted_at` is what an older entry looks like on the wire. */
  const entry = (
    login: string,
    state: string,
    more: { commit_id?: string; submitted_at?: string } = {},
  ) => ({ user: { login }, state, ...more });

  // `/pulls/{n}/reviews` is an append-only EVENT log, oldest first, so each
  // reviewer's state is their LATEST verdict: COMMENTED and PENDING are not
  // verdicts, DISMISSED withdraws one, and changes_requested outranks approved
  // (P13-D-28). The approvals keep WHO approved and on WHICH commit, off the
  // same payload, since GitHub keeps an approval standing after new pushes
  // (R19-B).
  it.each<[string, object[], number, PrReviewState | null, PrApproval[]]>([
    [
      // Ayse asked for changes and then approved the fix; counting events would
      // leave the PR changes_requested forever.
      "uses each reviewer's LATEST verdict, not every review event",
      [entry("ayse", "CHANGES_REQUESTED"), entry("ayse", "APPROVED")],
      0,
      "approved",
      [{ login: "ayse", commitSha: null, at: null }],
    ],
    [
      "ranks changes_requested over approved when both are outstanding",
      [entry("ayse", "APPROVED"), entry("mert", "CHANGES_REQUESTED")],
      0,
      "changes_requested",
      [{ login: "ayse", commitSha: null, at: null }],
    ],
    [
      "ranks them the same whichever came first",
      [entry("mert", "CHANGES_REQUESTED"), entry("ayse", "APPROVED")],
      0,
      "changes_requested",
      [{ login: "ayse", commitSha: null, at: null }],
    ],
    [
      "never lets COMMENTED or PENDING displace a standing verdict",
      [
        entry("ayse", "APPROVED", { commit_id: "abc" }),
        entry("ayse", "COMMENTED"),
        entry("mert", "PENDING"),
      ],
      0,
      "approved",
      [{ login: "ayse", commitSha: "abc", at: null }],
    ],
    ["reads comments alone as no verdict", [entry("ayse", "COMMENTED")], 0, null, []],
    [
      "withdraws a verdict its reviewer DISMISSED",
      [entry("ayse", "APPROVED", { commit_id: "abc" }), entry("ayse", "DISMISSED")],
      0,
      null,
      [],
    ],
    [
      "waits on a requested reviewer once the verdict is dismissed",
      [entry("ayse", "APPROVED"), entry("ayse", "DISMISSED")],
      1,
      "review_required",
      [],
    ],
    ["reads no verdict and a requested reviewer as review_required", [], 2, "review_required", []],
    ["reads no verdict and nobody requested as null", [], 0, null, []],
    [
      "carries a standing approver with the commit and time they approved",
      [entry("ayse", "APPROVED", { commit_id: "abc123", submitted_at: "2026-08-08T09:00:00Z" })],
      0,
      "approved",
      [{ login: "ayse", commitSha: "abc123", at: "2026-08-08T09:00:00Z" }],
    ],
    [
      "carries the commit of a re-approval, not the first one",
      [
        entry("ayse", "APPROVED", { commit_id: "old111" }),
        entry("ayse", "APPROVED", { commit_id: "new222" }),
      ],
      0,
      "approved",
      [{ login: "ayse", commitSha: "new222", at: null }],
    ],
    [
      "drops an approver whose latest state is CHANGES_REQUESTED",
      [
        entry("ayse", "APPROVED", { commit_id: "abc" }),
        entry("ayse", "CHANGES_REQUESTED", { commit_id: "abc" }),
      ],
      0,
      "changes_requested",
      [],
    ],
  ])("%s", async (_label, reviews, requested, review, approvals) => {
    const { client: c } = client(
      openRoutes({ [`GET ${REPO_PATH}/pulls/318/reviews`]: { body: reviews } }, requested),
    );
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.review).toBe(review);
    expect(result.pr.approvals).toEqual(approvals);
  });
});

describe("deriveMergeable (P14-LV-07)", () => {
  it("maps GitHub's mergeable + mergeable_state onto the cache vocabulary", () => {
    // A conflict is reported EITHER way depending on how fresh the computation
    // is — both must read "conflicting".
    expect(deriveMergeable({ mergeable: false })).toBe("conflicting");
    expect(deriveMergeable({ mergeable: null, mergeable_state: "dirty" })).toBe(
      "conflicting",
    );
    expect(deriveMergeable({ mergeable: true, mergeable_state: "clean" })).toBe("clean");
    // "blocked" (required review/checks) is still MERGEABLE — the merge attempt
    // is that state's gate, not this pill.
    expect(deriveMergeable({ mergeable: true, mergeable_state: "blocked" })).toBe(
      "clean",
    );
    // Still computing (the first read after a push) — never asserted either way.
    expect(deriveMergeable({ mergeable: null })).toBe("unknown");
    expect(deriveMergeable({})).toBe("unknown");
  });
});

describe("findPrForBranch mergeability (P14-LV-07)", () => {
  const routesFor = (
    detail: MergeabilityDetail,
  ): Parameters<typeof fakeGithubFetch>[0] => ({
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          merged_at: null,
          head: { sha: "headsha318" },
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/318`]: {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        merged: false,
        merged_at: null,
        head: { sha: "headsha318" },
        ...detail,
      },
    },
    [`GET ${REPO_PATH}/pulls/318/reviews`]: { body: [] },
  });

  it("carries a conflicting open PR's mergeability off the detail fetch it already makes", async () => {
    const { gh, client: c } = client(routesFor({ mergeable: false, mergeable_state: "dirty" }));
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.pr.mergeable).toBe("conflicting");
    // No extra API call was paid for it.
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/318`)).toHaveLength(1);
  });

  it("leaves the key ABSENT while GitHub is still computing (unknown ≠ mergeable)", async () => {
    const { client: c } = client(routesFor({ mergeable: null }));
    const result = await findPrForBranch(c, REPO, "vib-301-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") expect("mergeable" in result.pr).toBe(false);
  });

  it("a settled (merged) PR reports no mergeability at all", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 298,
            title: "Store scan hardening",
            state: "closed",
            merged_at: "2026-07-01T10:00:00Z",
            head: { sha: "sha298" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/298`]: {
        body: {
          number: 298,
          title: "Store scan hardening",
          state: "closed",
          merged: true,
          merged_at: "2026-07-01T10:00:00Z",
          head: { sha: "sha298" },
          mergeable: false,
        },
      },
      [`GET ${REPO_PATH}/branches/vib-139-store-scan`]: {
        body: { commit: { sha: "sha298" } },
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-139-store-scan");
    expect(result.status).toBe("found");
    if (result.status === "found") expect("mergeable" in result.pr).toBe(false);
  });
});

/**
 * R19-B — the identities and commits behind the review pill. `deriveApprovals`
 * reduces the SAME `/reviews` event log `deriveReviewState` reads (no second
 * API call), keeping what the pill throws away: WHO approved and WHAT commit
 * they approved. Without the commit, "approved" says nothing about the
 * delivered revision — GitHub keeps an approval standing after new pushes.
 */
describe("findPrForBranch approvals (R19-B)", () => {
  it("carries the approvals onto PrFacts from the reviews call already made", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 401,
            title: "Human-approved delivery",
            state: "open",
            merged_at: null,
            head: { sha: "sha401" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/401`]: {
        body: {
          number: 401,
          title: "Human-approved delivery",
          state: "open",
          merged: false,
          merged_at: null,
          head: { sha: "sha401" },
        },
      },
      [`GET ${REPO_PATH}/commits/sha401/check-runs`]: {
        body: { total_count: 0, check_runs: [] },
      },
      [`GET ${REPO_PATH}/pulls/401/reviews`]: {
        body: [{ user: { login: "murat" }, state: "APPROVED", commit_id: "sha401" }],
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-401");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.review).toBe("approved");
    expect(result.pr.approvals).toEqual([
      { login: "murat", commitSha: "sha401", at: null },
    ]);
  });

  it("leaves `approvals` ABSENT on a terminal PR — unread is UNKNOWN, not 'nobody approved'", async () => {
    const { client: c } = client({
      [`GET ${REPO_PATH}/pulls`]: {
        body: [
          {
            number: 402,
            title: "Merged",
            state: "closed",
            merged_at: "2026-08-01T00:00:00Z",
            head: { sha: "sha402" },
          },
        ],
      },
      [`GET ${REPO_PATH}/pulls/402`]: {
        body: {
          number: 402,
          title: "Merged",
          state: "closed",
          merged: true,
          merged_at: "2026-08-01T00:00:00Z",
          head: { sha: "sha402" },
        },
      },
      [`GET ${REPO_PATH}/commits/sha402/check-runs`]: {
        body: { total_count: 0, check_runs: [] },
      },
    });
    const result = await findPrForBranch(c, REPO, "vib-402");
    expect(result.status).toBe("found");
    if (result.status === "found") expect("approvals" in result.pr).toBe(false);
  });
});

/**
 * Ruling 236 (owner, 2026-09-14) — the changed-file list behind the review
 * queue's collision chip, and the head pin that keeps it nearly free.
 *
 * A pull request's file list cannot change without its head moving, so the
 * fetch is made only when the caller's cached head no longer matches. On a
 * board where most reconcile ticks find nothing new, that is zero extra API
 * calls; without the pin it would be one per open PR per tick, every tick,
 * forever.
 */
describe("ruling 236: the PR's changed paths", () => {
  const routes = (files: { filename: string }[]) => ({
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: 500,
          title: "Shared surface",
          state: "open",
          draft: false,
          merged_at: null,
          head: { sha: "head500" },
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/500`]: {
      body: {
        number: 500,
        title: "Shared surface",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        head: { sha: "head500" },
        additions: 1,
        deletions: 0,
        changed_files: files.length,
        mergeable: true,
        mergeable_state: "clean",
      },
    },
    [`GET ${REPO_PATH}/pulls/500/files`]: { body: files },
  });

  it("reads the file list when the head is new, pinned to that head", async () => {
    const { gh, client: c } = client(
      routes([{ filename: "pnpm-lock.yaml" }, { filename: "scripts/stack.test.mjs" }]),
    );
    const result = await findPrForBranch(c, REPO, "shared", null);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.paths).toEqual({
      headSha: "head500",
      changed: ["pnpm-lock.yaml", "scripts/stack.test.mjs"],
      truncated: false,
    });
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/500/files`)).toHaveLength(1);
  });

  it("SKIPS the read when the caller's cached head still matches", async () => {
    const { gh, client: c } = client(routes([{ filename: "pnpm-lock.yaml" }]));
    const result = await findPrForBranch(c, REPO, "shared", "head500");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    // ABSENT, not empty: "not read this pass", so the caller keeps its cached
    // list rather than erasing a real one. Erasing it would make every row's
    // collision chip vanish on the next tick.
    expect(result.pr.paths).toBeUndefined();
    expect(gh.callsTo(`GET ${REPO_PATH}/pulls/500/files`)).toHaveLength(0);
  });

  it("leaves the key absent when the files call fails, rather than reporting no paths", async () => {
    const base = routes([{ filename: "pnpm-lock.yaml" }]);
    const { client: c } = client({
      ...base,
      [`GET ${REPO_PATH}/pulls/500/files`]: { status: 500, body: { message: "boom" } },
    });
    const result = await findPrForBranch(c, REPO, "shared", null);
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.paths).toBeUndefined();
  });
});

/**
 * Ruling 360 (pass 38, F38-14). The check-runs read failed on every one of
 * this instance's 97 PRs (a fine-grained token without Checks: read answers
 * 403), and the linker turned each refusal into `checks: null` — the same
 * value as "never looked". The refusal is now carried beside it.
 */
describe("ruling 360: a refused check-runs read is a fact, not a blank", () => {
  const routes = (checkRuns: { status?: number; body: unknown }) => ({
    [`GET ${REPO_PATH}/pulls`]: {
      body: [
        {
          number: 318,
          title: "Attach execution workspace",
          state: "open",
          draft: false,
          merged_at: null,
          head: { sha: "headsha318" },
        },
      ],
    },
    [`GET ${REPO_PATH}/pulls/318`]: {
      body: {
        number: 318,
        title: "Attach execution workspace",
        state: "open",
        draft: false,
        merged: false,
        merged_at: null,
        head: { sha: "headsha318" },
        additions: 1,
        deletions: 1,
        changed_files: 1,
      },
    },
    [`GET ${REPO_PATH}/commits/headsha318/check-runs`]: checkRuns,
  });

  it("carries GitHub's refusal beside `checks: null`", async () => {
    // CANARY: drop the `else if` arms after the check-runs request.
    const { client: c } = client(
      routes({ status: 403, body: { message: "Resource not accessible by personal access token" } }),
    );
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.pr.checks).toBeNull();
      expect(result.pr.checksUnread).toEqual({
        status: 403,
        message: "Resource not accessible by personal access token",
      });
    }
  });

  it("a read that succeeds carries no refusal", async () => {
    const { client: c } = client(
      routes({ body: { total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] } }),
    );
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.pr.checks).toEqual({ total: 1, passing: 1, failing: 0, pending: 0 });
      expect(result.pr.checksUnread).toBeUndefined();
    }
  });
});
