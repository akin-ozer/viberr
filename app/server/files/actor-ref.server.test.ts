import { describe, expect, it } from "vitest";
import type { FileActorRef } from "~/schemas/task-file.schema";
import { decodeActorRef, encodeActorRef, roleToSlug } from "./actor-ref.server";

/**
 * Actor-ref codec round-trip. The load-bearing invariant (VIB-12): an AGENT
 * actor must survive encode → decode with `kind: "agent"` intact for ANY role,
 * including roles with punctuation. The shipped `reviewer` profile's role is
 * "Review & validation"; a strict decode regex rejected the `&`, so the
 * timeline parser dropped the reviewer's reply comment on every re-parse.
 */

describe("encodeActorRef / decodeActorRef round-trip", () => {
  const roles = [
    "Reviewer",
    "Review & validation",
    "QA / Release",
    "Senior Reviewer",
    "3D pipeline",
    "developer",
  ];

  for (const backend of ["claude", "codex"] as const) {
    for (const role of roles) {
      it(`agent ${backend}/"${role}" round-trips as an agent`, () => {
        const ref: FileActorRef = { kind: "agent", backend, role };
        const decoded = decodeActorRef(encodeActorRef(ref));
        expect(decoded, `"${role}" must not decode to null (would be dropped)`).not.toBeNull();
        expect(decoded!.kind).toBe("agent");
        if (decoded!.kind === "agent") {
          expect(decoded!.backend).toBe(backend);
          // The role text is display-only; the governance-critical property is
          // kind === "agent". For the exact reviewer role it round-trips fully.
          if (role === "Review & validation") expect(decoded!.role).toBe("Review & validation");
        }
      });
    }
  }

  it("an empty role never yields an undecodable ref", () => {
    expect(roleToSlug("   ")).not.toBe("");
    const decoded = decodeActorRef(
      encodeActorRef({ kind: "agent", backend: "claude", role: "   " }),
    );
    expect(decoded?.kind).toBe("agent");
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
