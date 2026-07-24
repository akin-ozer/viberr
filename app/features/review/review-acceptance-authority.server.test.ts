import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P13-D-9: the Review queue's "always a human action" claim is now conditional,
 * so the condition itself needs pinning. Owner ruling Q1 makes the exception
 * deliberately narrow — FULL autonomy *and* an explicit
 * `completion-for-acceptance: direct` grant — and `gate()` refuses to promote
 * `recommend → direct` for that one capability even at full autonomy, precisely
 * so an admin who configured `recommend` never gets a silent agent close.
 *
 * `resolveOperatorAuthority` reads the project file from disk; this test stubs
 * it so the decision table can be exercised directly.
 */

const resolveOperatorAuthority = vi.fn();

vi.mock("~/server/tasks/operator-actions.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/server/tasks/operator-actions.server")
  >("~/server/tasks/operator-actions.server");
  return { ...actual, resolveOperatorAuthority };
});


const { resolveAcceptanceAuthority } = await import(
  "./review-acceptance-authority.server"
);

function authority(patch: {
  deployed?: boolean;
  autonomy?: "supervised" | "full";
  completion?: string;
  name?: string;
}) {
  return {
    policy: new Map<string, string>([
      ["completion-for-acceptance", patch.completion ?? "recommend"],
    ]),
    autonomy: patch.autonomy ?? "supervised",
    backend: "claude",
    model: "claude-opus-4",
    effort: "",
    name: patch.name ?? "Operator",
    skills: [],
    kb: [],
    mcps: [],
    persona: null,
    deployed: patch.deployed ?? true,
  };
}

beforeEach(() => resolveOperatorAuthority.mockReset());

describe("resolveAcceptanceAuthority", () => {
  it("grants the exception only for full autonomy + an explicit direct grant", () => {
    resolveOperatorAuthority.mockReturnValue(
      authority({ autonomy: "full", completion: "direct", name: "Atlas" }),
    );
    expect(resolveAcceptanceAuthority("viberr-core")).toEqual({
      operatorCanAccept: true,
      operatorName: "Atlas",
    });
  });

  it("refuses to promote recommend → direct at full autonomy (ruling Q1)", () => {
    resolveOperatorAuthority.mockReturnValue(
      authority({ autonomy: "full", completion: "recommend" }),
    );
    expect(resolveAcceptanceAuthority("viberr-core").operatorCanAccept).toBe(
      false,
    );
  });

  it("refuses a direct grant held by a supervised operator", () => {
    resolveOperatorAuthority.mockReturnValue(
      authority({ autonomy: "supervised", completion: "direct" }),
    );
    expect(resolveAcceptanceAuthority("viberr-core").operatorCanAccept).toBe(
      false,
    );
  });

  it("refuses when no operator is deployed at all", () => {
    resolveOperatorAuthority.mockReturnValue(
      authority({ deployed: false, autonomy: "full", completion: "direct" }),
    );
    expect(resolveAcceptanceAuthority("viberr-core").operatorCanAccept).toBe(
      false,
    );
  });

  // The "unreadable project falls back to the strict boundary" case runs
  // against the REAL resolver in review-route.server.test.ts — throwing from
  // inside a vi.fn() is reported as a test failure by this Vitest even when the
  // subject catches it.
});
