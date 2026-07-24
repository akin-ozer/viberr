import { describe, expect, it } from "vitest";
import { fakeGithubFetch, unreachableFetch } from "../../../test-support/fake-github";
import { createGithubClient } from "./github-client.server";
import { findPrForBranch, mapPrToCacheState } from "./pr-linker.server";

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
