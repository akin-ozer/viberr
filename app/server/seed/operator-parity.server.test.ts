import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentProfileContent } from "~/server/files/agent-profile-file.server";
import { SEED_AGENT_PROFILES } from "./agent-catalog.server";

// Read from disk rather than Vite's `?raw`: that loader exists only under Vite,
// and an import graph that reaches it breaks every tsx/node CLI entrypoint (P13
// — `npm run seed` died with ERR_UNKNOWN_FILE_EXTENSION while the whole unit
// suite stayed green). See default-assets.server.test.ts.
const operatorProfileMd = readFileSync(
  path.join(import.meta.dirname, "assets/operator.profile.md"),
  "utf8",
);

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

const operatorDefinitionMd = readFileSync(
  path.join(import.meta.dirname, "assets/operator.definition.md"),
  "utf8",
);

/**
 * R19-1 (ruling 55) — the operator's persona must forbid the one false claim it
 * actually made. Live (F19-4): at triage its working directory held only
 * `task.md`, and with nothing else to look at it described that directory AS
 * the repository — writing `Repo contents visible to operator: "only task.md —
 * no docs/ or README found"` into a human-facing decision packet about a repo
 * that has both, then offering to write a README that already existed.
 *
 * The tool descriptions say this too, but a tool the operator does not call
 * teaches it nothing; the persona is read on every turn.
 */
describe("R19-1: the persona separates the task workspace from the repository", () => {
  it("says the working directory is NOT the repository", () => {
    expect(operatorDefinitionMd).toMatch(/It is NOT the repository/);
    expect(operatorDefinitionMd).toMatch(
      /never evidence about what the repository contains/i,
    );
  });

  it("names the read-only tools as the ONLY view of the real repository", () => {
    expect(operatorDefinitionMd).toContain("`list_repo_files`");
    expect(operatorDefinitionMd).toContain("`read_repo_file`");
    expect(operatorDefinitionMd).toMatch(/ONLY view of the real repository/);
  });

  it("forbids reporting a file missing on the strength of the workspace", () => {
    expect(operatorDefinitionMd).toMatch(
      /never report a file as missing, or a repository as empty/i,
    );
  });

  it("makes the triage gate look at the repository before proposing scope", () => {
    // The exact failure: options invented without reading the repo.
    expect(operatorDefinitionMd).toMatch(/LOOK AT THE REPOSITORY FIRST/);
    expect(operatorDefinitionMd).toMatch(
      /never offer to add something the repository already has/i,
    );
  });
});
