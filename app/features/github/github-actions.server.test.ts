import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { setupTestStore } from "../../../test-support/test-store";
import { fakeGithubFetch } from "../../../test-support/fake-github";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import { createConnection } from "~/server/org/connections.server";
import { getProjectCredential } from "~/server/secrets/pat-store.server";
import { runSetCredential } from "./github-actions.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const REPO = "akin-ozer/viberr";
const FINE = "github_pat_11ATTACH0123456789_attachattach";

/**
 * The add-connection → attach story behind the "eternal ~ chips" complaint:
 * the connection modal necessarily validates with `repo: null`, which pins a
 * fine-grained token at all-"assumed" scope chips — and the ORG card renders
 * that same per-PAT cache forever. Attaching to a project is the first moment
 * a real repo exists, so `runSetCredential` now refreshes the shared cache
 * with project context and the chips upgrade to probe-backed verdicts.
 */
describe("runSetCredential refreshes the PAT cache with project context", () => {
  it("upgrades a fine-grained token's repo scope from 'assumed' to 'probe' on attach", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot }); // projects table (repo column)
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    // 1. Org-level connection add — no repo context exists here.
    const addTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /users/akin-ozer": { body: { public_repos: 3 } },
    });
    const created = await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      { fetchImpl: addTime.fetchImpl },
    );
    expect(created.status).toBe("saved");

    // 2. Attach to the project — the revalidation now runs WITH the repo.
    const attachTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      [`GET /repos/${REPO}`]: { body: { full_name: REPO } },
      [`GET /repos/${REPO}/pulls`]: { body: [] },
    });
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: attachTime.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    expect(attachTime.callsTo(`GET /repos/${REPO}`)).toHaveLength(1);

    // 3. The SHARED cache (what the org card renders too) is upgraded.
    const credential = getProjectCredential(store.db, store.slug);
    expect(credential?.validation?.repo).toBe(REPO);
    const repoScope = credential?.validation?.scopes.find((s) => s.id === "repo");
    expect(repoScope).toMatchObject({ ok: true, source: "probe" });
  });

  it("an unreachable GitHub degrades the refresh but never fails the attach", async () => {
    const store = setupTestStore(ctx);
    rebuildAll(store.db, { dataRoot: store.dataRoot });
    const actor = { userId: store.users.arda.id, label: "arda@viberr.test" };

    const addTime = fakeGithubFetch({
      "GET /user": { body: { login: "akin-ozer" } },
      "GET /user/orgs": { body: [] },
      "GET /users/akin-ozer": { body: { public_repos: 3 } },
    });
    await createConnection(
      store.db,
      { owner: "akin-ozer", token: FINE, userId: store.users.arda.id },
      actor,
      { fetchImpl: addTime.fetchImpl },
    );

    // Attach while GitHub is down: bind still lands, cache stays org-level.
    const down = fakeGithubFetch({}); // every route 404s; validator reports it
    const outcome = await runSetCredential(store.db, store.slug, actor, {
      dataRoot: store.dataRoot,
      fetchImpl: down.fetchImpl,
    });
    expect(outcome.result).toBe("attached");
    expect(getProjectCredential(store.db, store.slug)).not.toBeNull();
  });
});
