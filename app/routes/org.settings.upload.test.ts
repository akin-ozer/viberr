import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * P13-UI-08 residual — the server half of the silent upload.
 *
 * `writeStoreFiles` filters dot-prefixed paths (never trust the client), and
 * the route answered a zero-file write with a bare `ok()` — no toast, no error,
 * so the browser rendered nothing at all and the user could not tell a rejected
 * upload from a stored one. The client filter is the other half
 * (`local-files.test.ts`, `store-browser.test.tsx`).
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  const { findUserByEmail } = await import("~/server/auth/user-store.server");
  ardaId = findUserByEmail(app.db, "arda@viberr.dev")!.id; // org admin
});
afterAll(() => app.cleanup());

async function upload(files: { name: string; relPath: string }[]) {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(ardaId);
  const csrf = await app.csrfFor(sessionId);
  const fd = new FormData();
  fd.set("intent", "store-upload");
  fd.set("mode", "files");
  fd.set("kind", "kb");
  fd.set("id", "kb_seed_arch");
  fd.set("path", JSON.stringify([]));
  for (const f of files) {
    fd.append("files", new File(["x"], f.name, { type: "text/plain" }));
    fd.append("filePaths", f.relPath);
  }
  fd.set("_csrf", csrf);
  const result = await action({
    request: app.request("/org/settings", { method: "POST", body: fd, cookie }),
    params: {},
    context: {},
  } as never);
  return (
    result && typeof result === "object" && "data" in result
      ? (result as { data: Record<string, unknown> }).data
      : (result as Record<string, unknown>)
  );
}

describe("store-upload reports what it did NOT store", () => {
  it("an all-hidden upload answers with the reason instead of a bare ok", async () => {
    const result = await upload([
      { name: ".DS_Store", relPath: ".DS_Store" },
      { name: "config", relPath: ".git/config" },
    ]);
    expect(result.ok).toBe(true);
    expect(String(result.toast)).toContain("Nothing uploaded");
    expect(String(result.toast)).toContain("2 hidden files skipped");
  });

  it("a partly-hidden upload states the count it dropped alongside the success", async () => {
    const result = await upload([
      { name: "kept.md", relPath: "kept.md" },
      { name: ".DS_Store", relPath: ".DS_Store" },
    ]);
    expect(result.ok).toBe(true);
    expect(String(result.toast)).toContain("1 file added to");
    expect(String(result.toast)).toContain("1 hidden file skipped");
  });
});
