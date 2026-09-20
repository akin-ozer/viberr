import { describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { checksPill } from "~/features/github/github-pills";
import { mapPrChecks } from "~/shared/mapping/task.server";
import { createGithubClient } from "./github-client.server";
import {
  deriveMergeable,
  deriveApprovals,
  deriveReviewState,
  findPrForBranch,
  mapPrToCacheState,
  summarizeCheckRuns,
  type GhReview,
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

  it("draft PRs read 'in review' like open ones", () => {
    // draft is carried separately; state mapping treats open===review.
    expect(mapPrToCacheState({ state: "open" })).toBe("review");
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

describe("summarizeCheckRuns (F21-7)", () => {
  it("counts every run GitHub reported into exactly one bucket", () => {
    expect(
      summarizeCheckRuns({
        totalCount: 4,
        runs: [
          { conclusion: "success" },
          { conclusion: "skipped" },
          { conclusion: "failure" },
          { conclusion: null },
        ],
      }),
    ).toEqual({ total: 4, passing: 2, failing: 1, pending: 1 });
  });

  it("undecodable entries, absent and unrecognized conclusions are UNKNOWN", () => {
    // A conclusion GitHub added later ("stale") is not a pass, an entry with no
    // conclusion at all is not a pass, and an entry that did not decode (null)
    // is not a pass.
    expect(
      summarizeCheckRuns({
        totalCount: 3,
        runs: [null, {}, { conclusion: "stale" }],
      }),
    ).toEqual({ total: 3, passing: 0, failing: 0, pending: 0, unknown: 3 });
  });

  it("a total GitHub reported but did not carry is unaccounted, not passing", () => {
    // The whole array drifted away (`check_runs` non-array → undefined) while
    // total_count survived: three runs exist and none of them were read.
    expect(summarizeCheckRuns({ totalCount: 3, runs: undefined })).toEqual({
      total: 3,
      passing: 0,
      failing: 0,
      pending: 0,
      unknown: 3,
    });
    // Entries beyond the reported total raise the total instead of going
    // missing — the counters can never exceed what they are shown against.
    expect(
      summarizeCheckRuns({
        totalCount: 1,
        runs: [{ conclusion: "success" }, { conclusion: "success" }],
      }),
    ).toEqual({ total: 2, passing: 2, failing: 0, pending: 0 });
  });

  it("omits the key entirely on a clean read", () => {
    const summary = summarizeCheckRuns({
      totalCount: 2,
      runs: [{ conclusion: "success" }, { conclusion: "neutral" }],
    });
    expect(summary.unknown).toBeUndefined();
    expect(Object.keys(summary).sort()).toEqual([
      "failing",
      "passing",
      "pending",
      "total",
    ]);
  });
});

describe("findPrForBranch check-runs drift (F21-7)", () => {
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

  it("a null / non-object entry can never inflate 'passing'", async () => {
    // The reported failure: `{ total_count: 3, check_runs: [null, "x"] }` used
    // to summarize as 3 total with nothing counted, which the pill mapper reads
    // as "3 checks passing" and the reconciler then persists into task.md.
    const { client: c } = driftedChecks({
      total_count: 3,
      check_runs: [null, "x"],
    });
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.checks).toEqual({
      total: 3,
      passing: 0,
      failing: 0,
      pending: 0,
      unknown: 3,
    });
    expect(mapPrChecks({ number: 318, state: "review", title: "t", checks: result.pr.checks })).toMatchObject({
      state: "unknown",
    });
    expect(
      checksPill(
        mapPrChecks({ number: 318, state: "review", title: "t", checks: result.pr.checks })!,
      ).kind,
    ).not.toBe("ready");
  });

  it("an undecodable or conclusion-less run is unknown, and its readable siblings still count", async () => {
    // Per-ENTRY tolerance: one bad entry used to void the whole array, which
    // discarded the runs GitHub reported perfectly well next to it.
    const { client: c } = driftedChecks({
      total_count: 4,
      check_runs: [
        { status: "completed", conclusion: "success" },
        null,
        { status: "completed" },
        { status: "completed", conclusion: "failure" },
      ],
    });
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.checks).toEqual({
      total: 4,
      passing: 1,
      failing: 1,
      pending: 0,
      unknown: 2,
    });
    // A real failure still outranks the drift.
    expect(mapPrChecks({ number: 318, state: "review", title: "t", checks: result.pr.checks })).toMatchObject({
      state: "failing",
    });
  });

  it("a non-array check_runs leaves the reported total unaccounted", async () => {
    const { client: c } = driftedChecks({ total_count: 2, check_runs: {} });
    const result = await findPrForBranch(c, REPO, "vib-142-attach-workspace");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.pr.checks).toMatchObject({ total: 2, unknown: 2 });
    expect(mapPrChecks({ number: 318, state: "review", title: "t", checks: result.pr.checks })).toMatchObject({
      state: "unknown",
    });
  });
});

// ------------------------------------------------------- P13-D-28 review state

describe("deriveReviewState (P13-D-28)", () => {
  const by = (login: string, state: string) => ({ user: { login }, state });

  it("uses each reviewer's LATEST verdict, not every review event", () => {
    // `/pulls/{n}/reviews` is an append-only EVENT log, oldest first. Ayse asked
    // for changes and then approved the fix — counting events would leave the PR
    // permanently "changes_requested".
    expect(
      deriveReviewState(
        [by("ayse", "CHANGES_REQUESTED"), by("ayse", "APPROVED")],
        0,
      ),
    ).toBe("approved");
  });

  it("changes_requested OUTRANKS approved when both are outstanding", () => {
    expect(
      deriveReviewState([by("ayse", "APPROVED"), by("mert", "CHANGES_REQUESTED")], 0),
    ).toBe("changes_requested");
    // Order-independent.
    expect(
      deriveReviewState([by("mert", "CHANGES_REQUESTED"), by("ayse", "APPROVED")], 0),
    ).toBe("changes_requested");
  });

  it("COMMENTED / PENDING are not verdicts and never displace a standing one", () => {
    expect(
      deriveReviewState(
        [by("ayse", "APPROVED"), by("ayse", "COMMENTED"), by("mert", "PENDING")],
        0,
      ),
    ).toBe("approved");
    // Comments alone say nothing about the review verdict.
    expect(deriveReviewState([by("ayse", "COMMENTED")], 0)).toBeNull();
  });

  it("a DISMISSED review withdraws that reviewer's verdict", () => {
    expect(
      deriveReviewState([by("ayse", "APPROVED"), by("ayse", "DISMISSED")], 0),
    ).toBeNull();
    expect(
      deriveReviewState([by("ayse", "APPROVED"), by("ayse", "DISMISSED")], 1),
    ).toBe("review_required");
  });

  it("no verdict + a requested reviewer → review_required; nobody asked → null", () => {
    expect(deriveReviewState([], 2)).toBe("review_required");
    expect(deriveReviewState([], 0)).toBeNull();
  });
});

describe("findPrForBranch review-state fetch (P13-D-28)", () => {
  const openRoutes = (
    extra: Parameters<typeof fakeGithubFetch>[0] = {},
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
        requested_reviewers: [{ login: "mert" }],
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
describe("deriveApprovals (R19-B)", () => {
  // Key PRESENCE is the fixture's point: an omitted `commit_id`/`submitted_at`
  // is what an older review entry looks like on the wire, and the reducer must
  // tell that apart from an explicit null.
  const review = (login: string, state: string, commit?: string, at?: string) => {
    const entry: GhReview = { user: { login }, state };
    if (commit !== undefined) entry.commit_id = commit;
    if (at !== undefined) entry.submitted_at = at;
    return entry;
  };

  it("returns each standing approver with the commit they approved", () => {
    expect(
      deriveApprovals([review("ayse", "APPROVED", "abc123", "2026-08-08T09:00:00Z")]),
    ).toEqual([{ login: "ayse", commitSha: "abc123", at: "2026-08-08T09:00:00Z" }]);
  });

  it("uses the reviewer's LATEST entry — a re-approval on a newer commit wins", () => {
    expect(
      deriveApprovals([
        review("ayse", "APPROVED", "old111"),
        review("ayse", "APPROVED", "new222"),
      ]),
    ).toEqual([{ login: "ayse", commitSha: "new222", at: null }]);
  });

  it("drops a reviewer whose latest state is CHANGES_REQUESTED or DISMISSED", () => {
    expect(
      deriveApprovals([review("ayse", "APPROVED", "abc"), review("ayse", "DISMISSED")]),
    ).toEqual([]);
    expect(
      deriveApprovals([
        review("ayse", "APPROVED", "abc"),
        review("ayse", "CHANGES_REQUESTED", "abc"),
      ]),
    ).toEqual([]);
  });

  it("ignores COMMENTED / PENDING entries — they are not verdicts", () => {
    expect(
      deriveApprovals([review("ayse", "APPROVED", "abc"), review("ayse", "COMMENTED")]),
    ).toEqual([{ login: "ayse", commitSha: "abc", at: null }]);
  });

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
