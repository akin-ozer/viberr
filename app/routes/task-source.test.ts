import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";
import { writeTaskSource } from "~/server/files/task-sources.server";

/**
 * Ruling 690: the route that serves one kept source of a task by its id.
 * What it adds to the store: membership, the id lookup, and a kept page never
 * rendering on the app's origin (ruling 363).
 */

let app: AppTestContext;
let ardaId: string; // viberr-core member
let denizId: string; // signed-in NON-member

const PAGE = "<html><script>alert(1)</script>t3.medium $0.0416 per hour</html>";

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  denizId = userIds.deniz;
  // Kept the way a run's keep leaves it: by the store's own writer.
  writeTaskSource(
    "viberr-core",
    "VIB-142",
    {
      name: "aws-pricing.html",
      data: Buffer.from(PAGE),
      title: "AWS EC2 on-demand pricing",
      from: "https://aws.amazon.com/ec2/pricing/on-demand/",
      by: { backend: "claude", profileId: "researcher", roleHint: "Researcher" },
      runId: "run_abc",
    },
    app.dataRoot,
  );
});
afterAll(() => app.cleanup());

async function get(
  userId: string,
  id: string,
  key = "VIB-142",
): Promise<{ status: number; headers: Headers; body: () => Promise<string> }> {
  const { loader } = await import("~/routes/task-source");
  const { cookie } = await app.cookieFor(userId);
  try {
    // SAFETY: the loader reads only `request` and `params.{slug,key,id}`; the
    // rest of the generated `Route.LoaderArgs` is untouched on every path this
    // file exercises.
    const res = await loader({
      request: app.request(
        `/projects/viberr-core/tasks/${encodeURIComponent(key)}/sources/${encodeURIComponent(id)}`,
        { cookie },
      ),
      params: { slug: "viberr-core", key, id },
      context: {},
    } as never);
    return { status: res.status, headers: res.headers, body: () => res.text() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, headers: thrown.headers, body: () => thrown.text() };
    }
    // SAFETY: the only other thrower on this loader is requireProjectMember,
    // whose refusal is react-router's `data(message, { status })`, which
    // carries the refusal status under `init` (as in task-attachment.test.ts).
    const refusal = thrown as { init: { status: number } };
    return { status: refusal.init.status, headers: new Headers(), body: () => Promise.resolve("") };
  }
}

describe("GET /projects/:slug/tasks/:key/sources/:id (ruling 690)", () => {
  it("serves a member a kept page as a download under the sandbox headers, answers 404 for an id the task does not keep, and refuses a non-member", async () => {
    // CANARY: drop requireProjectMember and the signed-in non-member gets
    // the page's bytes. Serve the page under its own content type and a kept
    // `.html` renders, with its script, on the app's origin.
    const res = await get(ardaId, "S1");
    expect(res.status).toBe(200);
    expect(await res.body()).toBe(PAGE);
    // The name the agent saved it under decides the kind, and HTML is never
    // an inline kind.
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="aws-pricing.html"; filename*=UTF-8''aws-pricing.html`,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");

    // An id the task does not keep, the file's name in place of its id, and a
    // task that keeps nothing: one answer, no oracle.
    expect((await get(ardaId, "S2")).status).toBe(404);
    expect((await get(ardaId, "aws-pricing.html")).status).toBe(404);
    expect((await get(ardaId, "S1", "VIB-143")).status).toBe(404);
    // CANARY: drop the key's containment in resolveTaskSource and a key that
    // walks out of the tasks folder and back in is served the page.
    expect((await get(ardaId, "S1", "../tasks/VIB-142")).status).toBe(404);

    // The same request from someone who is not a member of the project.
    expect((await get(denizId, "S1")).status).toBe(404);
  });
});
