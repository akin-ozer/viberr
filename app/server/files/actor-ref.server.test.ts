import { describe, expect, it } from "vitest";
import type { FileActorRef } from "~/schemas/task-file.schema";
import {
  agentRoleDisplay,
  decodeActorRef,
  encodeActorRef,
  roleToSlug,
} from "./actor-ref.server";

/**
 * Actor-ref codec invariants (VIB-12 + generic-agents D7):
 *  1. PROFILE-ID identity: an agent ref round-trips profileId + backend
 *     losslessly, with the role snapshot as a parenthesized display hint.
 *  2. LEGACY decode: pre-D7 `agent:<backend>/<role-slug>` refs decode as
 *     agents (slug → profileId) and DISPLAY exactly as they always did.
 *  3. TOTALITY: decode never returns null — an unrecognized ref becomes
 *     `{ kind: "unknown", raw }` and re-encodes verbatim, so a malformed
 *     author can never cost an event again (the VIB-12 failure shape).
 */

describe("encodeActorRef / decodeActorRef", () => {
  const cases: { profileId: string; roleHint: string | null }[] = [
    { profileId: "reviewer", roleHint: "Review & validation" },
    { profileId: "developer", roleHint: "Implementation" },
    { profileId: "qa-release", roleHint: "QA / Release" },
    { profileId: "3d-pipeline", roleHint: "3D pipeline" },
    { profileId: "developer", roleHint: null },
  ];

  for (const backend of ["claude", "codex"] as const) {
    for (const { profileId, roleHint } of cases) {
      it(`agent ${backend}/${profileId} (${roleHint ?? "no hint"}) round-trips`, () => {
        const ref: FileActorRef = { kind: "agent", backend, profileId, roleHint };
        const decoded = decodeActorRef(encodeActorRef(ref));
        expect(decoded.kind).toBe("agent");
        if (decoded.kind === "agent") {
          expect(decoded.backend).toBe(backend);
          expect(decoded.profileId).toBe(profileId);
          expect(decoded.roleHint).toBe(roleHint);
        }
      });
    }
  }

  it("LEGACY: a pre-D7 role-slug ref decodes as an agent and displays the original role", () => {
    // Exactly what a pre-migration task.md contains for the shipped reviewer.
    const decoded = decodeActorRef("agent:claude/review-&-validation");
    expect(decoded.kind).toBe("agent");
    if (decoded.kind === "agent") {
      expect(decoded.backend).toBe("claude");
      expect(decoded.profileId).toBe("review-&-validation");
      expect(decoded.roleHint).toBeNull();
      // Display falls back to un-slugging — renders as it always did.
      expect(agentRoleDisplay(decoded)).toBe("Review & validation");
    }
  });

  it("TOTALITY: unrecognized refs decode to `unknown` and re-encode verbatim", () => {
    for (const raw of [
      "agent:gpt/researcher", // unknown backend
      "bot:something",
      "agent:claude", // malformed — no profile id
      "totally malformed · text",
    ]) {
      const decoded = decodeActorRef(raw);
      expect(decoded.kind).toBe("unknown");
      expect(encodeActorRef(decoded)).toBe(raw);
    }
  });

  it("an empty profile id never yields a malformed ref", () => {
    expect(roleToSlug("   ")).not.toBe("");
    const decoded = decodeActorRef(
      encodeActorRef({
        kind: "agent",
        backend: "claude",
        profileId: "   ",
        roleHint: null,
      }),
    );
    expect(decoded.kind).toBe("agent");
  });

  it("a role hint containing the heading separator is sanitized, not corrupting", () => {
    const decoded = decodeActorRef(
      encodeActorRef({
        kind: "agent",
        backend: "codex",
        profileId: "weird",
        roleHint: "Role · with · separators",
      }),
    );
    expect(decoded.kind).toBe("agent");
    if (decoded.kind === "agent") {
      expect(decoded.profileId).toBe("weird");
      expect(decoded.roleHint).not.toContain("·");
    }
  });

  it("still decodes human, operator, and system refs", () => {
    expect(decodeActorRef("operator")).toEqual({ kind: "operator" });
    expect(decodeActorRef("user:u_ab12 (Arda)")).toEqual({
      kind: "human",
      userId: "u_ab12",
      nameHint: "Arda",
    });
    expect(decodeActorRef("system:policy-engine")).toEqual({
      kind: "system",
      systemId: "policy-engine",
    });
  });
});
