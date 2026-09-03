import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDbContext,
  type TestDbContext,
} from "../../../test-support/test-db";
import { setupTestStore, type TestStore } from "../../../test-support/test-store";
import { setBackendApiKey } from "~/server/runtimes/backend-credentials.server";
import { getControllerSurface } from "./controller-query.server";

/**
 * Ruling 127 — `available` on the controller surface is a fact about the PERSON
 * looking at it.
 *
 * A controller turn runs on the ASKER's own Claude account (the run row records
 * them as its credential principal), so the surface cannot go on answering one
 * deployment-wide boolean: on the same instance, at the same second, a member
 * who has connected Claude converses and one who has not is refused. The old
 * shape could not express that, and the page it fed said "the Claude backend is
 * unavailable" to everybody or to nobody.
 *
 * These pin the per-viewer answer and the rule that the surface carries no
 * credential material of any kind (it is loader data, i.e. a public payload).
 */

const CLAUDE_KEY = "sk-ant-api03-viberr-controller-surface-test";

/** A provider that accepts the pasted key, so a person can be connected with no
 *  network (`npm test` never opens a socket). */
const acceptingProvider: typeof fetch = () =>
  Promise.resolve(new Response("{}", { status: 200 }));

let ctx: TestDbContext;
let store: TestStore;

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

async function connectClaude(userId: string, label: string): Promise<void> {
  await setBackendApiKey(store.db, { userId, label }, "claude", "api_key", CLAUDE_KEY, {
    fetchImpl: acceptingProvider,
    dataRoot: store.dataRoot,
  });
}

function surfaceFor(user: { id: string; email: string }) {
  return getControllerSurface(store.db, user, {
    projectSlug: null,
    conversationId: null,
    all: false,
    dataRoot: store.dataRoot,
  });
}

describe("getControllerSurface — availability is the viewer's own Claude (ruling 127)", () => {
  it("is false for a viewer who has connected nothing", () => {
    const view = surfaceFor(store.users.murat);
    expect(view.available).toBe(false);
  });

  it("is true once THAT person connects Claude, and stays false for everyone else", async () => {
    await connectClaude(store.users.murat.id, store.users.murat.email);
    expect(surfaceFor(store.users.murat).available).toBe(true);
    // The canary for a regression back to an instance-level probe: one member's
    // connection must never answer for another's.
    expect(surfaceFor(store.users.selin).available).toBe(false);
  });

  it("carries no key, no sealed box and no home path in the loader payload", async () => {
    await connectClaude(store.users.murat.id, store.users.murat.email);
    const wire = JSON.stringify(surfaceFor(store.users.murat));
    expect(wire).not.toContain(CLAUDE_KEY);
    expect(wire).not.toContain("secret_box");
    expect(wire).not.toContain(store.dataRoot);
  });
});
