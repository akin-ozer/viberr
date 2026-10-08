import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  clearModelMark,
  noteModelAvailabilityFromFailure,
  unavailableModels,
} from "./model-availability.server";

/**
 * R20-3 (F20-4): a model the provider REFUSED for this account is marked from a
 * REAL run's failure and cleared by a real run's success — no synthetic probe.
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

/** The live F20-4 refusal. */
const F20_4 = "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";

/** A Codex run on `model` that failed, the provider saying `providerText`. */
function failedRun(db: DatabaseSync, model: string | null, providerText: string): void {
  noteModelAvailabilityFromFailure(db, { runId: "run_1", backend: "codex", model, providerText });
}

describe("noteModelAvailabilityFromFailure", () => {
  it.each([
    // The live F20-4 sentence, and the other ways a provider says it.
    { providerText: F20_4, marked: true },
    { providerText: "unknown model: gpt-9", marked: true },
    { providerText: "that model does not exist", marked: true },
    // Quota, auth and a crash are not model problems.
    { providerText: "usage limit reached, retry later", marked: false },
    { providerText: "401 unauthorized — credential rejected", marked: false },
    { providerText: "segmentation fault in /opt/codex", marked: false },
  ])("marks the model only when the provider refused it: $providerText", ({ providerText, marked }) => {
    const db = dbCtx.makeDb();
    failedRun(db, "gpt-5.6-sol", providerText);
    expect(unavailableModels(db, "codex").has("gpt-5.6-sol")).toBe(marked);
  });

  it("marks nothing for a run that named no model (never a null or empty row)", () => {
    const db = dbCtx.makeDb();
    failedRun(db, null, "unknown model");
    expect(unavailableModels(db, "codex").size).toBe(0);
  });
});

describe("mark / read / clear round trip", () => {
  it("reads a mark back with the provider's sentence, on its own backend", () => {
    const db = dbCtx.makeDb();
    failedRun(db, "gpt-5.6-sol", F20_4);
    expect(unavailableModels(db, "codex").get("gpt-5.6-sol")?.reason).toBe(F20_4);
    // Scoped to the backend.
    expect(unavailableModels(db, "claude").size).toBe(0);
  });

  it("a real success clears the mark (the re-probe)", () => {
    const db = dbCtx.makeDb();
    failedRun(db, "gpt-5.6-sol", F20_4);
    clearModelMark(db, "codex", "gpt-5.6-sol");
    expect(unavailableModels(db, "codex").has("gpt-5.6-sol")).toBe(false);
  });

  it("upserts (the newest failure's sentence wins)", () => {
    const db = dbCtx.makeDb();
    failedRun(db, "m", "unknown model: m");
    failedRun(db, "m", "invalid model: m");
    expect(unavailableModels(db, "codex").get("m")?.reason).toBe("invalid model: m");
  });
});
