import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  setupAppTest,
  type AppTestContext,
} from "../../test-support/test-app";

/**
 * Ruling 663 — the document editor saves against the version it read.
 *
 * `store-write-doc` was a blind whole-document replace: the editor sent back
 * the text it had loaded, edited, whatever had been written to the file since.
 * On the AWS board agents merge knowledge-base corrections during their runs
 * and a person hand-edits the same documents (the board's rulings §6), so a
 * correction merged while the editor was open would have been wiped by the
 * person's Save, under a success toast. The controller's replace has named
 * the version it read since ruling 305; this is the editor's half.
 */

let app: AppTestContext;
let ardaId: string;

beforeAll(async () => {
  app = await setupAppTest();
  const { runDemoSeed } = await import("../../test-support/demo-seed");
  const { userIds } = await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  const { seedOrgResources } = await import("~/server/org/org-seed.server");
  seedOrgResources(app.db, { dataRoot: app.dataRoot });
  ardaId = userIds.arda; // org admin
});
afterAll(() => app.cleanup());

/** The members of an org-settings reply the editor reads. */
type DocReply = { ok: boolean; error?: string; text?: string; version?: string };

async function post(fields: Record<string, string>): Promise<DocReply> {
  const { action } = await import("~/routes/org.settings");
  const { cookie, sessionId } = await app.cookieFor(ardaId);
  const fd = new FormData();
  for (const [name, value] of Object.entries(fields)) fd.set(name, value);
  fd.set("kind", "kb");
  fd.set("id", "kb_seed_arch");
  fd.set("_csrf", await app.csrfFor(sessionId));
  const request = app.request("/org/settings", { method: "POST", body: fd, cookie });
  const result = await action({
    request,
    url: new URL(request.url),
    pattern: "/org/settings",
    params: {},
    context: new RouterContextProvider(),
  });
  // `fail()` answers through `data()`, which parks the body under `.data`;
  // `ok()` hands the body back directly.
  return "data" in result ? result.data : result;
}

const NAME = "facts-663.md";
const read = () => post({ intent: "store-read-doc", path: JSON.stringify([NAME]) });
const save = (body: string, more: Record<string, string> = {}) =>
  post({ intent: "store-write-doc", path: JSON.stringify([]), name: NAME, body, ...more });

describe("ruling 663: the document editor's save", () => {
  it("is refused once the file is no longer the version it read, and the other write survives", async () => {
    expect((await save("ORIGINAL")).ok).toBe(true);
    // The editor opens the document: the read hands back its version.
    const opened = await read();
    expect(opened.text).toBe("ORIGINAL");
    expect(opened.version).toMatch(/^[0-9a-f]{12}$/);

    // Another writer replaces it while the person still has it open.
    expect((await save("ORIGINAL, corrected by an agent", { overwrite: "1" })).ok).toBe(true);

    // CANARY: stop passing the form's version to `writeStoreDoc`, or drop its
    // check there, and this save wins: the correction is gone.
    const stale = await save("ORIGINAL, edited by hand", { overwrite: "1", version: opened.version! });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/facts-663\.md changed after you opened it/);
    const reopened = await read();
    expect(reopened.text).toBe("ORIGINAL, corrected by an agent");

    // Reopened, the same edit saves on top of what is there now.
    const merged = await save("ORIGINAL, corrected by an agent, edited by hand", {
      overwrite: "1",
      version: reopened.version!,
    });
    expect(merged.ok).toBe(true);
    expect((await read()).text).toBe("ORIGINAL, corrected by an agent, edited by hand");
  });
});
