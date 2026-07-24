import { describe, expect, it } from "vitest";
import operatorProfileMd from "./assets/operator.profile.md?raw";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import { SEED_AGENT_PROFILES } from "./agent-catalog.server";

/**
 * The operator profile exists in TWO hand-synced sources (seed #4): the
 * boot-only asset template `assets/operator.profile.md` and the CLI/seed
 * catalog entry `SEED_AGENT_PROFILES[operator]`. They MUST agree on every
 * load-bearing field so a boot-only store and a CLI-seeded store deploy the
 * same operator. This guard fails if a future edit touches one and not the
 * other. (`kb` and `desc` differ intentionally — see default-assets.server.)
 */
describe("operator profile parity: asset template vs seed catalog (seed #4)", () => {
  it("agrees on kind/name/role/backends/model/stages/spanAll/capabilities", () => {
    const { parsed } = parseAgentProfileContent(operatorProfileMd, {
      fallbackId: "operator",
    });
    expect(parsed).not.toBeNull();
    const asset = parsed!.frontmatter;
    const catalog = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "operator")!
      .frontmatter;

    expect(asset.kind).toBe(catalog.kind);
    expect(asset.name).toBe(catalog.name);
    expect(asset.role).toBe(catalog.role);
    expect(asset.icon).toBe(catalog.icon);
    expect(asset.backends).toEqual(catalog.backends);
    expect(asset.model).toBe(catalog.model);
    expect(asset.scope).toBe(catalog.scope);
    expect(asset.stages).toEqual(catalog.stages);
    expect(asset.spanAll).toBe(catalog.spanAll);
    // Capability grants must match exactly (order-independent).
    const sortCaps = (caps: { capabilityId: string; mode: string }[]) =>
      [...caps].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
    expect(sortCaps(asset.capabilities)).toEqual(sortCaps(catalog.capabilities));
  });
});
