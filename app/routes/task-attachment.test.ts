import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * R19-19 — the attachment serving route: member-only, traversal-proof, and
 * hostile to content smuggling (stored HTML must never render on this origin).
 */

let app: AppTestContext;
let ardaId: string; // viberr-core member, and billing-service's only one
let muratId: string; // viberr-core member, NOT in billing-service
let denizId: string; // signed-in NON-member

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda;
  muratId = userIds.murat;
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
  { slug, key } = { slug: "viberr-core", key: "VIB-142" },
): Promise<{ status: number; headers: Headers; body: () => Promise<ArrayBuffer> }> {
  const { loader } = await import("~/routes/task-attachment");
  const { cookie } = await app.cookieFor(userId);
  try {
    // SAFETY: the loader reads only `request` and `params.{slug,key,file}`; the
    // rest of the generated `Route.LoaderArgs` (the router context provider and
    // its matches) is untouched on every path this file exercises.
    const res = await loader({
      request: app.request(
        `/projects/${slug}/tasks/${encodeURIComponent(key)}/attachments/${encodeURIComponent(file)}${query}`,
        { cookie },
      ),
      params: { slug, key, file },
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

  /**
   * Ruling 76: a header value is Latin-1, so a name with a letter outside it
   * made `new Response` throw. The owner's own input on AWSC-117, a PDF named
   * in Turkish and stored decomposed by a Mac's upload, answered 500 from its
   * tile and 404 when its name was typed.
   */
  it("ruling 76: serves a file named outside Latin-1, under either Unicode form, with its name in a header that can carry it", async () => {
    const composed = "Aidea _ İçerik ve Eğitim _ AWS Maliyet Teklifi.pdf";
    const dir = path.join(app.dataRoot, "projects", "viberr-core", "tasks", "VIB-142", "attachments");
    writeFileSync(path.join(dir, composed.normalize("NFD")), "%PDF-1.4 the proposal");
    // CANARY: put the raw name in the header again and both requests are 500.
    // CANARY: resolve the name byte for byte and the typed one is 404.
    for (const asked of [composed.normalize("NFD"), composed]) {
      const res = await get(ardaId, asked);
      expect(res.status, asked === composed ? "composed" : "decomposed").toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(new TextDecoder().decode(await res.body())).toBe("%PDF-1.4 the proposal");
      const disposition = res.headers.get("content-disposition")!;
      // The ASCII fallback, then the whole name as the file is stored.
      expect(disposition.startsWith('inline; filename="Aidea _ ')).toBe(true);
      expect(disposition).toContain(`; filename*=UTF-8''${encodeURIComponent(composed.normalize("NFD"))}`);
    }

    // CANARY: leave `'`, `(`, `)` and `*` as `encodeURIComponent` leaves them
    // and the extended value is not one RFC 5987 allows: its own quote ends
    // the charset part a second time.
    writeFileSync(path.join(dir, "it's (final)*.txt"), "notes");
    const res = await get(ardaId, "it's (final)*.txt");
    expect(res.headers.get("content-disposition")).toBe(
      `inline; filename="it's (final)*.txt"; filename*=UTF-8''it%27s%20%28final%29%2A.txt`,
    );
  });

  it("NEVER renders stored HTML on the app origin — download-only, generic type", async () => {
    const res = await get(ardaId, "sneaky.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("ruling 76: a yml serves as inert text/plain inline (the viewer fetches it)", async () => {
    const res = await get(ardaId, "page-snap.yml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ruling 317: ?download=1 forces the save dialog on an inline type", async () => {
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

  /**
   * Ruling 15(b): the task key is one folder under the project's tasks. The
   * router hands a loader its params decoded, `%2F` as `/` (measured over HTTP
   * on the production build, 2026-10-07: `/projects/viberr-core/tasks/
   * ..%2F..%2Fbilling-service%2Ftasks%2FBIL-9/attachments/<file>` answered 200
   * with billing-service's bytes to a person who is not in it), so the key
   * this loader reads can hold a path.
   */
  it("ruling 15(b): a key that walks to another task's folder serves nothing, another project's files least of all", async () => {
    const billing = { slug: "billing-service", key: "BIL-9" };
    const dir = path.join(app.dataRoot, "projects", billing.slug, "tasks", billing.key, "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "invoice-run.txt"), "billing only");
    // The file is there, and its own door serves it to the project's member.
    const own = await get(ardaId, "invoice-run.txt", "", billing);
    expect(own.status).toBe(200);
    expect(new TextDecoder().decode(await own.body())).toBe("billing only");
    // Murat is in viberr-core, whose files he is served, and not in
    // billing-service, which answers him as a project that is not there.
    expect((await get(muratId, "board-after.png")).status).toBe(200);
    expect((await get(muratId, "invoice-run.txt", "", billing)).status).toBe(404);

    // CANARY: drop the containment in `taskDir` and both are 200: the first
    // with billing-service's bytes, the second by a key that left the tasks
    // folder and came back.
    for (const [key, file] of [
      ["../../billing-service/tasks/BIL-9", "invoice-run.txt"],
      ["../tasks/VIB-142", "board-after.png"],
    ] as const) {
      const walked = await get(muratId, file, "", { slug: "viberr-core", key });
      expect(walked.status, key).toBe(404);
    }
  });
});
