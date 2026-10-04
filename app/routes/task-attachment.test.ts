import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * R19-19 — the attachment serving route: member-only, traversal-proof, and
 * hostile to content smuggling (stored HTML must never render on this origin).
 */

let app: AppTestContext;
let ardaId: string; // viberr-core member
let denizId: string; // signed-in NON-member

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  denizId = userIds.deniz;

  const dir = path.join(
    app.dataRoot,
    "projects",
    "viberr-core",
    "tasks",
    "VIB-142",
    "attachments",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "board-after.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, "sneaky.html"), "<script>alert(1)</script>");
  writeFileSync(path.join(dir, "page-snap.yml"), "aria: snapshot");
});
afterAll(() => app.cleanup());

async function get(
  userId: string,
  file: string,
  query = "",
): Promise<{ status: number; headers: Headers; body: () => Promise<ArrayBuffer> }> {
  const { loader } = await import("~/routes/task-attachment");
  const { cookie } = await app.cookieFor(userId);
  try {
    // SAFETY: the loader reads only `request` and `params.{slug,key,file}`; the
    // rest of the generated `Route.LoaderArgs` (the router context provider and
    // its matches) is untouched on every path this file exercises.
    const res = await loader({
      request: app.request(
        `/projects/viberr-core/tasks/VIB-142/attachments/${encodeURIComponent(file)}${query}`,
        { cookie },
      ),
      params: { slug: "viberr-core", key: "VIB-142", file },
      context: {},
    } as never);
    return { status: res.status, headers: res.headers, body: () => res.arrayBuffer() };
  } catch (thrown) {
    if (thrown instanceof Response) {
      // The login redirect: requireProjectMember signs the request in first.
      return { status: thrown.status, headers: thrown.headers, body: () => thrown.arrayBuffer() };
    }
    // SAFETY: the only other thrower on this loader is requireProjectMember,
    // whose refusal is react-router's `data(message, { status })` — a
    // DataWithResponseInit, not a Response (see run-artifact-routes tests) —
    // and it carries the refusal status under `init`.
    const refusal = thrown as { init: { status: number } };
    return {
      status: refusal.init.status,
      headers: new Headers(),
      body: () => Promise.resolve(new ArrayBuffer(0)),
    };
  }
}

describe("GET /projects/:slug/tasks/:key/attachments/:file (R19-19)", () => {
  it("serves a member an image inline — sandboxed, nosniff, private", async () => {
    const res = await get(ardaId, "board-after.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("cache-control")).toContain("private");
    expect((await res.body()).byteLength).toBe(4);
  });

  it("NEVER renders stored HTML on the app origin — download-only, generic type", async () => {
    const res = await get(ardaId, "sneaky.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("ruling 105: a yml serves as inert text/plain inline (the viewer fetches it)", async () => {
    const res = await get(ardaId, "page-snap.yml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ruling 105: ?download=1 forces the save dialog on an inline type", async () => {
    const res = await get(ardaId, "page-snap.yml", "?download=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    // Content itself is unchanged — only the disposition flips.
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a signed-in NON-member with the same 404 an unknown project gets (R15-4)", async () => {
    const res = await get(denizId, "board-after.png");
    expect(res.status).toBe(404);
  });

  it("404s a missing file and every traversal shape without an oracle", async () => {
    for (const file of ["nope.png", "../task.md", "..", "a/b.png", "\\bad.png"]) {
      const res = await get(ardaId, file);
      expect(res.status, file).toBe(404);
    }
  });
});
