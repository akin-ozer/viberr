import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDeploymentDefinition } from "~/schemas/project-file.schema";
import {
  setupAppTest,
  type AppTestContext,
} from "../../../test-support/test-app";
import {
  deploymentRuntimeIdentity,
  parseDeploymentDefinition,
  primaryRunBackend,
} from "./deployment-view.server";

/**
 * #183 — the server-layer home of the live-backend overlay. These pin the two
 * things nothing else pinned before the move: the tolerant `definition` decode
 * (a hand-edited project.md with one junk field must lose only that field), and
 * the single-source invariant the module doc promises — `effectiveProfileView`
 * (the display view) and `deployedSpecialistBackends` (the run overlay) both
 * resolve kind/backends through THIS module, so display and run cannot drift.
 */

describe("primaryRunBackend — the first real backend, else claude", () => {
  it("takes the first codex/claude in order", () => {
    expect(primaryRunBackend(["codex", "claude"])).toBe("codex");
    expect(primaryRunBackend(["claude", "codex"])).toBe("claude");
  });
  it("skips unknown entries and defaults to claude", () => {
    expect(primaryRunBackend(["gpt", "codex"])).toBe("codex");
    expect(primaryRunBackend([])).toBe("claude");
    expect(primaryRunBackend(["mystery"])).toBe("claude");
  });
});

describe("parseDeploymentDefinition — tolerant per-field decode", () => {
  // The decode exists to survive a hand-edited (untrusted) project.md, so every
  // case below feeds a shape the TS type forbids on purpose.
  const raw = (v: unknown) =>
    // SAFETY: the decode's whole job is to accept malformed input; the test
    // deliberately feeds shapes the compile-time type rules out.
    parseDeploymentDefinition(v as AgentDeploymentDefinition | undefined);

  it("drops one junk field without losing the rest of the override", () => {
    expect(raw({ kind: 42, name: "Dev" })).toEqual({ name: "Dev" });
  });
  it("treats an empty-string name as ABSENT (the template's name wins)", () => {
    expect(raw({ name: "" })).toEqual({});
  });
  it("treats a non-list `stages` as absent rather than corrupting it", () => {
    expect(raw({ stages: "not-a-list" })).toEqual({});
  });
  it("fills all three resource lists so a partial override inherits nothing", () => {
    expect(raw({ resources: { skills: ["a"] } })).toEqual({
      resources: { skills: ["a"], mcps: [], kb: [] },
    });
  });
  it("keeps only codex/claude in a backends override", () => {
    expect(raw({ backends: ["gpt", "claude", 7] })).toEqual({
      backends: ["claude"],
    });
  });
});

describe("deploymentRuntimeIdentity", () => {
  let app: AppTestContext;
  beforeAll(async () => {
    app = await setupAppTest();
    const { runDemoSeed } = await import("../../../test-support/demo-seed");
    await runDemoSeed(app.db, { dataRoot: app.dataRoot });
  });
  afterAll(() => app.cleanup());

  it("defaults to specialist + [] when neither a template nor an override names them", () => {
    const id = deploymentRuntimeIdentity(
      { profileId: "ghost-no-template", capabilities: [], extras: [] },
      app.dataRoot,
    );
    expect(id.kind).toBe("specialist");
    expect(id.backends).toEqual([]);
  });

  it("is the SINGLE source: effectiveProfileView resolves kind/backends the same way, even when the override disagrees with the template", async () => {
    const { updateProjectFile, readProjectFile } = await import(
      "~/server/files/project-writer.server"
    );
    const { effectiveProfileView, VIEW_WITHOUT_POLICY } = await import(
      "~/features/agents/agents-query.server"
    );
    const ref = { projectSlug: "viberr-core", dataRoot: app.dataRoot };
    // The developer TEMPLATE is ["codex","claude"]; pin an override that
    // disagrees, so a re-fork with the wrong precedence would diverge.
    await updateProjectFile(ref, (parsed) => {
      const dev = parsed.frontmatter.agents.find(
        (a) => a.profileId === "developer",
      )!;
      dev.definition = { backends: ["claude"] };
    });
    const dep = readProjectFile(ref)!.parsed.frontmatter.agents.find(
      (a) => a.profileId === "developer",
    )!;

    const overlay = deploymentRuntimeIdentity(dep, app.dataRoot);
    const view = effectiveProfileView(dep, app.dataRoot, VIEW_WITHOUT_POLICY);
    // The override wins on BOTH, identically — one computation, no drift.
    expect(overlay.backends).toEqual(["claude"]);
    expect(view.backends).toEqual(overlay.backends);
    expect(view.kind).toBe(overlay.kind);
    // …and the map a run reads agrees with the primary-backend rule.
    expect(primaryRunBackend(view.backends)).toBe("claude");
  });
});
