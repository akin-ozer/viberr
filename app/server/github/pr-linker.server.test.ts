import { describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { createGithubClient } from "./github-client.server";
import {
  deriveMergeable,
  deriveReviewState,
  findPrForBranch,
  mapPrToCacheState,
} from "./pr-linker.server";

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
    detail: Record<string, unknown>,
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
