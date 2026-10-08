import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readZip } from "~/server/files/zip.server";
import { createPat } from "~/server/secrets/pat-store.server";
import { routeArgs, setupAppTest, type AppTestContext } from "../../test-support/test-app";

/**
 * Ruling 653: what the routes add to a board's export and import — the
 * org-admin gate, the file response, the multipart upload, the settings
 * reply's shape and the refusals a form can cause. What the file carries and
 * what an import writes is `board-import.server.test.ts`'s.
 */

let app: AppTestContext;
let ardaId: string;
let elifId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
  elifId = userIds.elif; // org member
  const pat = createPat(
    app.db,
    { userId: ardaId, label: "connection · acme", token: "ghp_routeroutetroutetroutetroute0000" },
    { userId: ardaId, label: "seed" },
  );
  const now = new Date().toISOString();
  app.db
    .prepare(
      `INSERT INTO github_connections (id, owner, pat_id, is_default, created_at, updated_at)
       VALUES ('acme', 'acme', ?, 1, ?, ?)`,
    )
    .run(pat.id, now, now);
});
afterAll(() => app.cleanup());
afterEach(() => {
  vi.unstubAllGlobals();
});

async function exportAs(userId: string, slug: string): Promise<Response> {
  const { loader } = await import("~/routes/org.settings.board-export");
  const { cookie } = await app.sessionFor(userId);
  try {
    return await loader({ request: app.request(`/org/settings/board-export?project=${slug}`, { cookie }) });
  } catch (thrown) {
    // requireRole throws its 403 as a Response.
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/** The settings reply, success or refusal: `fail()` parks its body under `.data`. */
type SettingsReply = {
  ok: boolean;
  toast?: string;
  error?: string;
  slug?: string;
  boardImport?: { name: string; problems: string[]; resources: { status: string }[] };
};

async function post(fields: Record<string, string>, file?: { name: string; bytes: Uint8Array }): Promise<SettingsReply> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, csrf } = await app.sessionFor(ardaId);
  const fd = new FormData();
  for (const [name, value] of Object.entries(fields)) fd.set(name, value);
  if (file) fd.set("file", new File([new Uint8Array(file.bytes)], file.name, { type: "application/zip" }));
  fd.set("_csrf", csrf);
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  const result = await action(routeArgs(request, {}, "/org/settings"));
  return "data" in result ? result.data : result;
}

describe("ruling 653: the board export route", () => {
  it("hands an org admin the board file, refuses anyone else, and answers an unknown board with its reason", async () => {
    // CANARY: drop `requireRole` from the loader and a member downloads every
    // board's knowledge bases and personas.
    const res = await exportAs(ardaId, "viberr-core");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="viberr-core.viberr-board.zip"');
    const paths = readZip(new Uint8Array(await res.arrayBuffer()), { maxEntries: 2000, maxTotalBytes: 100_000_000 }).map(
      (f) => f.path,
    );
    expect(paths).toContain("viberr-core/board.md");
    expect(paths).toContain("viberr-core/README.md");

    expect((await exportAs(elifId, "viberr-core")).status).toBe(403);

    const missing = await exportAs(ardaId, "no-such-board");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "No project at projects/no-such-board." });
  });
});

describe("ruling 653: the board import intents", () => {
  it("previews an uploaded file, then imports it, answering in the settings reply's fields", async () => {
    // CANARY: read the upload from another field, or drop `slug` from the
    // reply, and the dialog never opens or never lands on the new board.
    const exported = await exportAs(ardaId, "viberr-core");
    const file = { name: "viberr-core.viberr-board.zip", bytes: new Uint8Array(await exported.arrayBuffer()) };

    const preview = await post({ intent: "board-import-preview" }, file);
    expect(preview.ok).toBe(true);
    expect(preview.boardImport?.name).toBe("Viberr Core");
    expect(preview.boardImport?.problems).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ default_branch: "main", permissions: { push: true }, size: 3 })),
    );
    const imported = await post(
      { intent: "board-import", name: "Ship Board", key: "SHB", owner: "acme", repoName: "ship-board", choices: "{}" },
      file,
    );
    expect(imported).toMatchObject({ ok: true, slug: "ship-board" });
    expect(imported.toast).toMatch(/^Ship Board imported as SHB:/);
  });

  it.each([
    ["no file", { intent: "board-import-preview" }, undefined, "Choose a board file (.zip) to import."],
    [
      "choices that are not the dialog's",
      { intent: "board-import", name: "X Board", key: "XB", owner: "acme", repoName: "x", choices: '{"skill:a":"overwrite"}' },
      { name: "a.zip", bytes: new Uint8Array([1]) },
      "The import's choices did not arrive as expected. Reload the page and import again.",
    ],
    ["a file that is not a zip", { intent: "board-import-preview" }, { name: "notes.zip", bytes: new TextEncoder().encode("hello") }, "This file is not a zip archive."],
  ])("refuses %s with its reason", async (_case, fields, file, error) => {
    // CANARY: let any of these through and the dialog shows a blank preview
    // or imports with choices nobody made.
    expect(await post(fields, file)).toEqual({ ok: false, error });
  });
});
