import { existsSync } from "node:fs";
import path from "node:path";

/**
 * E2E-only GitHub transport.
 *
 * The completion golden paths must exercise exact live repo/base/head checks
 * without touching a real pull request. This preload intercepts only the two
 * impossible fixture PR numbers; every other request keeps the native fetch.
 */
const nativeFetch = globalThis.fetch.bind(globalThis);
const repo = "akin-ozer/viberr";
const pendingHeadSha = "2".repeat(40);
const externallyMergedHeadSha = "3".repeat(40);
const externallyMergedMarker = path.resolve(
  process.cwd(),
  "e2e/.github-fixture-pr-999003-merged",
);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "x-oauth-scopes": "repo",
    },
  });
}

function pull(headSha, merged) {
  return {
    head: { sha: headSha },
    base: { ref: "main", repo: { full_name: repo } },
    state: merged ? "closed" : "open",
    merged,
    merged_at: merged ? "2026-07-13T08:30:00.000Z" : null,
    merge_commit_sha: merged ? "4".repeat(40) : null,
  };
}

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input));
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

  if (url.origin !== "https://api.github.com") {
    return nativeFetch(input, init);
  }

  if (url.pathname === `/repos/${repo}/pulls/999002`) {
    if (method === "GET") return json(pull(pendingHeadSha, false));
    if (method === "PUT") {
      return json({ message: "The E2E fixture deliberately remains open." }, 409);
    }
  }

  if (url.pathname === `/repos/${repo}/pulls/999003`) {
    if (method === "GET") {
      return json(
        pull(externallyMergedHeadSha, existsSync(externallyMergedMarker)),
      );
    }
    if (method === "PUT") {
      // This path is externally merged. A successful test proves the service
      // observed that exact fact and did not issue a second merge request.
      return json({ message: "A repeated merge PUT is forbidden." }, 500);
    }
  }

  return nativeFetch(input, init);
};
