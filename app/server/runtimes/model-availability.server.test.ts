import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  MODEL_UNSUPPORTED_RE,
  clearModelMark,
  markModelUnavailable,
  noteModelAvailabilityFromFailure,
  unavailableModels,
} from "./model-availability.server";

/**
 * R20-3 (F20-4): a model the provider REFUSED for this account is marked from a
 * REAL run's failure and cleared by a real run's success — no synthetic probe.
 */

const dbCtx = createTestDbContext();
afterEach(dbCtx.cleanup);

describe("MODEL_UNSUPPORTED_RE", () => {
  it("matches the live F20-4 'not supported' sentence", () => {
    expect(
      MODEL_UNSUPPORTED_RE.test(
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
    expect(MODEL_UNSUPPORTED_RE.test("unknown model: gpt-9")).toBe(true);
    expect(MODEL_UNSUPPORTED_RE.test("that model does not exist")).toBe(true);
  });

  it("does NOT match quota, auth, or crash text (those are not model problems)", () => {
    expect(MODEL_UNSUPPORTED_RE.test("usage limit reached, retry later")).toBe(false);
    expect(MODEL_UNSUPPORTED_RE.test("401 unauthorized — credential rejected")).toBe(false);
    expect(MODEL_UNSUPPORTED_RE.test("segmentation fault in /opt/codex")).toBe(false);
  });
});

describe("mark / read / clear round trip", () => {
  it("marks a model unavailable and reads it back", () => {
    const db = dbCtx.makeDb();
    markModelUnavailable(db, {
      backend: "codex",
      model: "gpt-5.6-sol",
      reason: "The 'gpt-5.6-sol' model is not supported …",
      runId: "run_1",
    });
    const marks = unavailableModels(db, "codex");
    expect(marks.has("gpt-5.6-sol")).toBe(true);
    expect(marks.get("gpt-5.6-sol")?.reason).toContain("not supported");
    // Scoped to the backend.
    expect(unavailableModels(db, "claude").size).toBe(0);
  });

  it("a real success clears the mark (the re-probe)", () => {
    const db = dbCtx.makeDb();
    markModelUnavailable(db, {
      backend: "codex",
      model: "gpt-5.6-sol",
      reason: "not supported",
    });
    clearModelMark(db, "codex", "gpt-5.6-sol");
    expect(unavailableModels(db, "codex").has("gpt-5.6-sol")).toBe(false);
  });

  it("upserts (the newest failure's sentence wins)", () => {
    const db = dbCtx.makeDb();
    markModelUnavailable(db, { backend: "codex", model: "m", reason: "first" });
    markModelUnavailable(db, { backend: "codex", model: "m", reason: "second" });
    expect(unavailableModels(db, "codex").get("m")?.reason).toBe("second");
  });
});

describe("noteModelAvailabilityFromFailure", () => {
  it("marks ONLY when the provider text matches and a model is named", () => {
    const db = dbCtx.makeDb();
    // Matches → marked.
    noteModelAvailabilityFromFailure(db, {
      runId: "run_1",
      backend: "codex",
      model: "gpt-5.6-sol",
      providerText:
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    });
    expect(unavailableModels(db, "codex").has("gpt-5.6-sol")).toBe(true);

    // Quota text → NOT marked.
    noteModelAvailabilityFromFailure(db, {
      runId: "run_2",
      backend: "codex",
      model: "gpt-5.6-terra",
      providerText: "usage limit reached, retry later",
    });
    expect(unavailableModels(db, "codex").has("gpt-5.6-terra")).toBe(false);

    // No model named → no-op (never a null/empty row).
    noteModelAvailabilityFromFailure(db, {
      runId: "run_3",
      backend: "codex",
      model: null,
      providerText: "unknown model",
    });
    expect(unavailableModels(db, "codex").size).toBe(1);
  });
});
