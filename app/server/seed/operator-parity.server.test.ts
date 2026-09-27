import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATOR_SCOPE } from "~/server/agents/deployment-view.server";
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
    // Ruling 517: and it is the line the app shows, which no file changes.
    expect(asset.scope).toBe(OPERATOR_SCOPE);
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
 * R19-1 (ruling 55) — the operator gets a FULL read-only checkout of the
 * repository under its cwd and must ground repo claims in it, read via
 * Read/Grep/Glob. Live origin (F19-4): before the clone, at triage the working
 * directory held only `task.md`, and with nothing else to look at the operator
 * described that directory AS the repository — writing `Repo contents visible
 * to operator: "only task.md — no docs/ or README found"` into a human-facing
 * packet about a repo that has both, then offering to write a README that
 * already existed. The persona is read on every turn, so it must name the
 * checkout as the repository view — NOT the removed `list_repo_files` /
 * `read_repo_file` MCP tools, which the pass-19 merge dropped (a persona that
 * calls a nonexistent tool teaches the model a false affordance).
 */
describe("R19-1: the persona grounds repo claims in the read-only checkout", () => {
  it("names a read-only repository checkout read with Read/Grep/Glob", () => {
    expect(operatorDefinitionMd).toMatch(/read-only checkout of the project repository/i);
    expect(operatorDefinitionMd).toMatch(/`Read`, `Grep`, and `Glob`/);
  });

  it("does NOT name the removed repo-view MCP tools", () => {
    expect(operatorDefinitionMd).not.toContain("list_repo_files");
    expect(operatorDefinitionMd).not.toContain("read_repo_file");
  });

  it("grounds every repository claim in the checkout, not the bare task folder", () => {
    expect(operatorDefinitionMd).toMatch(
      /Ground EVERY claim about the repository .*in that checkout, never in the bare task folder/i,
    );
  });

  it("forbids reporting a file missing when the checkout is unavailable", () => {
    expect(operatorDefinitionMd).toMatch(
      /never report a file as missing, or the repository as empty/i,
    );
  });

  it("makes the triage gate read the checkout before proposing scope", () => {
    // The exact failure: options invented without reading the repo.
    expect(operatorDefinitionMd).toMatch(/READ THE REPOSITORY CHECKOUT FIRST/);
    expect(operatorDefinitionMd).toMatch(
      /never offer to add something the repository already has/i,
    );
  });
});

/**
 * Ruling 164 (pass 35, F35-14) — the persona is read on every turn, and it was
 * silent on the one thing that made KNC-3's decision inert: the operator wrote
 * "Force-accept as admin without a fresh verdict" as a `custom` title because
 * nothing told it a kind existed that performs it.
 */
describe("ruling 164: the persona says an option title is a promise", () => {
  it("names the promise, the two kinds that keep it, and the Agents surface for a profile", () => {
    // Canary: drop the paragraph and the operator is free to write a title its
    // kind cannot honour again.
    expect(operatorDefinitionMd).toMatch(
      /Every option you write is a promise the resolution keeps/,
    );
    expect(operatorDefinitionMd).toContain("`force_accept`");
    expect(operatorDefinitionMd).toContain("`move_stage` with `toStage`");
    expect(operatorDefinitionMd).toMatch(
      /Nothing a person confirms on a packet edits an agent profile/,
    );
  });

  /**
   * Pass-35 cluster review: the persona said both things. The capability-gap
   * paragraph told the operator to "offer it beside any workaround you
   * propose"; the paragraph four lines below refuses that option. Canary:
   * restore the older half.
   */
  it("says the capability remedy is named, not offered as an option", () => {
    expect(operatorDefinitionMd).toContain("grantable on an agent profile");
    expect(operatorDefinitionMd).toContain("Never write it as an OPTION");
    expect(operatorDefinitionMd).not.toMatch(/offer it beside any workaround/i);
  });
});

/**
 * Pass-35 cluster review of ruling 162: `notAcceptableReason` is the FIRST of
 * every acceptance gate, and one of them is "this task has not reached the
 * boundary yet". The doctrine forbade the move into the acceptance stage while
 * the field was set, which is every task short of that stage, by a sentence
 * whose own remedy is that exact move. `mergeStageEntryRefusal` reads the pull
 * request instead, which is what the doctrine now says.
 */
describe("the acceptance-stage move reads the pull request, not the whole gate", () => {
  it("keeps notAcceptableReason for the acceptance verbs and keys the move on the pull request", () => {
    // Canary: restore "never move the task into the acceptance stage" keyed on
    // `notAcceptableReason`.
    expect(operatorDefinitionMd).toContain("never recommend or accept completion");
    expect(operatorDefinitionMd).not.toMatch(
      /never move the task into the acceptance stage/,
    );
    expect(operatorDefinitionMd).toContain("`pr.unpushedRevision`");
    expect(operatorDefinitionMd).toContain("not reached the boundary yet");
  });
});
