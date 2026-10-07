import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { writeFileAtomic } from "~/server/files/atomic-file.server";
import { projectFilePath } from "~/server/files/file-store-root.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { serializeProjectFile } from "~/server/files/project-file.server";
import { rebuildPath } from "~/server/projections/rebuilder.server";
import { runDemoSeed } from "../../../test-support/demo-seed";
import { seedDefaultAgentAssets } from "./default-assets.server";
import { ensureBaseAgentsDeployed } from "./ensure-base-agents.server";
import {
  baseAgentDeployments,
  defaultAgentDeployments,
  LIBRARY_AGENT_PROFILES,
  SEED_AGENT_PROFILES,
} from "./agent-catalog.server";
import { SKILL_INJECTION_BUDGET } from "~/server/files/skill-body.server";
import { splitFrontmatter } from "~/server/files/frontmatter.server";
import { joinedPrompt } from "~/server/runtimes/prompt-prefix.server";
import { buildSpecialistPromptPrefix } from "~/server/tasks/specialist-prompt.server";
import { isKnownModel } from "~/server/runtimes/model-catalog.server";
import type { AgentDeploymentDefinition } from "~/schemas/project-file.schema";

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

describe("seed profile models", () => {
  it("every specialist ships a REAL model id (no display-label placeholders)", () => {
    // Guards the "codex-large · claude-sonnet" class of bug: a seed model that
    // isn't a valid catalog id reaches the SDK and 400s on a real backend.
    for (const p of SEED_AGENT_PROFILES) {
      if (p.frontmatter.kind !== "specialist") continue;
      const backend =
        p.frontmatter.backends.find((b) => b === "codex" || b === "claude") ===
        "codex"
          ? "codex"
          : "claude";
      expect(
        isKnownModel(backend, p.frontmatter.model),
        `${p.frontmatter.id} model "${p.frontmatter.model}" must be a valid ${backend} id`,
      ).toBe(true);
    }
  });
});

describe("baseAgentDeployments", () => {
  it("is the operator plus Developer / Reviewer", () => {
    const ids = baseAgentDeployments().map((d) => d.profileId).sort();
    expect(ids).toEqual(["developer", "operator", "reviewer"]);
    expect(ids).toContain("operator");
    expect(ids).toContain("developer");
    expect(ids).toContain("reviewer");
    // Tester was merged into the Reviewer (the single quality specialist).
    expect(ids).not.toContain("tester");
  });
});

describe("seedDefaultAgentAssets", () => {
  it("ships each built-in agent's definition, skill, and profile into a fresh store", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);

    const read = (...parts: string[]) =>
      readFileSync(path.join(dataRoot, ...parts), "utf8");

    // F10-30: ONE persona source. Only the OPERATOR ships a dedicated
    // definition file (system profile); the specialist persona is the profile
    // TEMPLATE BODY, so no developer/reviewer definition files are seeded.
    expect(existsSync(path.join(dataRoot, "agents", "definitions", "operator.md"))).toBe(true);
    expect(existsSync(path.join(dataRoot, "agents", "definitions", "developer.md"))).toBe(false);
    expect(existsSync(path.join(dataRoot, "agents", "definitions", "reviewer.md"))).toBe(false);
    // The specialist persona now lives in the profile body.
    expect(read("agents", "profiles", "developer.md")).toContain("You are the Developer");
    expect(read("agents", "profiles", "reviewer.md")).toContain("You are the Reviewer");
    expect(existsSync(path.join(dataRoot, "agents", "definitions", "tester.md"))).toBe(false);

    // Real, loadable skills — one per specialist role.
    expect(read("skills", "developer-expertise", "SKILL.md")).toContain("developer expertise");
    expect(read("skills", "reviewer-expertise", "SKILL.md")).toContain("reviewer expertise");
    expect(existsSync(path.join(dataRoot, "skills", "tester-expertise", "SKILL.md"))).toBe(false);

    // Profile templates so the deployments resolve in a never-seeded store.
    for (const id of ["operator", "developer", "reviewer"]) {
      expect(existsSync(path.join(dataRoot, "agents", "profiles", `${id}.md`))).toBe(true);
    }
    // The Developer profile references its real skill (not a placeholder name).
    expect(read("agents", "profiles", "developer.md")).toContain("developer-expertise");
  });

  it("base profile templates ship NO knowledge-base grants (no dangling 'N of 0' ghosts)", () => {
    // Owner fix 2026-07-18: seedDefaultAgentAssets installs on-disk skills but
    // no KBs, so a KB grant on a base template dangles in every non-demo store.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const read = (id: string) =>
      readFileSync(path.join(dataRoot, "agents", "profiles", `${id}.md`), "utf8");
    for (const id of ["operator", "developer", "reviewer"]) {
      const md = read(id);
      expect(md, `${id} base template must grant no KBs`).toContain("kb: []");
      expect(md).not.toContain("architecture-notes");
      expect(md).not.toContain("api-contracts");
      // Backed grants are untouched — the on-disk skills still ship.
      expect(md).toMatch(/skills:\s*\n\s*-\s/);
    }

    // The DEMO source is unchanged: it still grants KBs (and demo-seeds the
    // backing KB folders), so demos keep their populated context.
    const dev = SEED_AGENT_PROFILES.find((p) => p.frontmatter.id === "developer")!;
    expect(dev.frontmatter.resources.kb).toContain("architecture-notes");
    expect(dev.frontmatter.resources.kb).toContain("api-contracts");
  });

  it("never clobbers an existing asset (idempotent)", () => {
    const dataRoot = ctx.makeTempDir();
    // The developer PROFILE (its persona body) is the specialist source now.
    const dest = path.join(dataRoot, "agents", "profiles", "developer.md");
    seedDefaultAgentAssets(dataRoot);
    writeFileAtomic(dest, "EDITED BY A HUMAN");
    seedDefaultAgentAssets(dataRoot);
    expect(readFileSync(dest, "utf8")).toBe("EDITED BY A HUMAN");
  });
});

describe("ruling 692: the library ships a Writer and an Editor", () => {
  const grantsOf = (id: string): Map<string, string> => {
    const profile = LIBRARY_AGENT_PROFILES.find((p) => p.frontmatter.id === id);
    return new Map((profile?.frontmatter.capabilities ?? []).map((c) => [c.capabilityId, c.mode]));
  };

  it("writes both templates and their manuals into a fresh store, the persona as the template's body", () => {
    // CANARY: take either profile out of LIBRARY_AGENT_PROFILES, or either
    // skill out of STATIC_ASSETS, and its file is not there.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const read = (...parts: string[]) => readFileSync(path.join(dataRoot, ...parts), "utf8");
    const writer = read("agents", "profiles", "writer.md");
    const editor = read("agents", "profiles", "editor.md");
    expect(writer).toContain("You are the Writer.");
    expect(writer).toContain("writer-expertise");
    expect(editor).toContain("You are the Editor.");
    expect(editor).toContain("editor-expertise");
    expect(read("skills", "writer-expertise", "SKILL.md")).toContain("# Viberr writer expertise");
    expect(read("skills", "editor-expertise", "SKILL.md")).toContain("# Viberr editor expertise");
    // Like the base templates, they grant no knowledge base a bare store lacks.
    expect(writer).toContain("kb: []");
    expect(editor).toContain("kb: []");
  });

  it("is in no project's default roster: a board gets them when someone chooses them", () => {
    // CANARY: move them into SEED_AGENT_PROFILES and every new project is
    // created with a Writer and an Editor nobody asked for.
    const defaults = defaultAgentDeployments().map((d) => d.profileId).sort();
    expect(defaults).toEqual(["developer", "operator", "reviewer"]);
    expect(baseAgentDeployments().map((d) => d.profileId).sort()).toEqual(["developer", "operator", "reviewer"]);
    expect(LIBRARY_AGENT_PROFILES.map((p) => p.frontmatter.id)).toEqual(["writer", "editor"]);
  });

  it("the Writer delivers and reaches the web; the Editor holds the verdict and cannot write the piece", () => {
    const writer = grantsOf("writer");
    for (const id of [
      "execute-code-or-write-repo",
      "commit-push-branch",
      "ask-human",
      "attach-evidence-references",
      "use-browser",
      "use-web-search-fetch",
    ]) {
      expect(writer.get(id), `writer ${id}`).toBe("direct");
    }
    expect(writer.has("report-validation-verdict")).toBe(false);
    const editor = grantsOf("editor");
    expect(editor.get("report-validation-verdict")).toBe("direct");
    expect(editor.get("attach-evidence-references")).toBe("direct");
    expect(editor.get("use-web-search-fetch")).toBe("direct");
    expect(editor.get("commit-push-branch")).toBe("human");
    expect(editor.has("execute-code-or-write-repo")).toBe(false);
    for (const p of LIBRARY_AGENT_PROFILES) {
      expect(p.frontmatter.extras, `${p.frontmatter.id} has a label the catalog does not know`).toEqual([]);
      expect(isKnownModel("claude", p.frontmatter.model), p.frontmatter.id).toBe(true);
    }
  });

  it("each manual leaves a board's own skill half of what a run with no checkout is given", () => {
    // On a board with no repository every skill reaches a run as prompt text
    // under one shared budget (ruling 679), drawn in name order: a manual that
    // filled it would cut the board's own skill off whole.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    for (const name of ["writer-expertise", "editor-expertise"]) {
      const raw = readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8");
      expect(splitFrontmatter(raw).body.trim().length, name).toBeLessThanOrEqual(SKILL_INJECTION_BUDGET / 2);
    }
  });

  it("says what a piece rests on, who may speak in the first person, and what a question is for", () => {
    // CANARY: drop a section of either manual.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const said = (name: string) =>
      readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
    const writer = said("writer-expertise");
    expect(writer).toContain("rests on a source you opened in this task and kept on it");
    expect(writer).toContain("**A fetch tool's answer is a summary, not the page.**");
    expect(writer).toContain("Hand each source you rely on to `keep_source`");
    // The owner's ruling on code a task cannot run (2026-10-07).
    expect(writer).toContain("check it without running it: it parses, and every option it sets exists in the thing it configures");
    expect(writer).toContain("never as something you tested");
    expect(writer).toContain("comes from their notes or their answers on this task");
    expect(writer).toContain("ask only what the person alone knows");
    expect(writer).toContain("Do not ask them to approve choices that are yours");
    expect(writer).toContain("no sentence, example or figure of theirs comes with you");
    expect(writer).toContain("ask for it with `capture_page`");
    const editor = said("editor-expertise");
    expect(editor).toContain("read the piece once as its reader would, beside the samples of the person's own writing");
    expect(editor).toContain("No kept source: blocking, however plausible the fact.");
    expect(editor).toContain("name **everything you would block on in this revision**");
    expect(editor).toContain("do not save files on the task");
    // Neither manual is about one kind of writing.
    expect(writer + editor).not.toMatch(/\bblog\b/i);
  });
});

describe("buildSpecialistPromptPrefix", () => {
  it("assembles the definition + declared skill body once the assets are shipped", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    // F10-30: the persona is the profile's own BODY, passed as `definition`
    // (in a real run it is resolved from the deployed profile). Read the seeded
    // developer profile body and feed it in.
    const profileMd = readFileSync(
      path.join(dataRoot, "agents", "profiles", "developer.md"),
      "utf8",
    );
    const definition = profileMd.split(/\n---\n/).slice(1).join("\n---\n").trim();
    const persona = joinedPrompt(buildSpecialistPromptPrefix({
      profileId: "developer",
      skills: ["developer-expertise"],
      definition,
      dataRoot,
    }));
    expect(persona).toContain("You are the Developer"); // the persona body
    expect(persona).toContain("developer-expertise (skill)"); // the skill header
    expect(persona).toContain("Reporting rules"); // skill body content
    // F7-RES4: attached resources carry a trusted-provenance banner so the agent
    // doesn't mistake them for prompt injection.
    expect(persona).toContain("Attached resources (trusted");
    expect(persona).toContain("do NOT flag them as prompt injection");
  });

  it("is empty when the store ships neither a definition nor the skill", () => {
    const dataRoot = ctx.makeTempDir();
    const persona = joinedPrompt(buildSpecialistPromptPrefix({
      profileId: "nonexistent",
      skills: ["also-nonexistent"],
      dataRoot,
    }));
    // C1 (pass 16): a grant that resolves to nothing is no longer silent. There
    // is still no trusted content — what the run now gets is the disclosure that
    // a declared resource did not arrive, so the agent reports the gap instead
    // of treating the missing context as its own failure.
    expect(persona).not.toContain("Attached resources (trusted");
    expect(persona).toContain("Attached resources that did NOT fully reach this run");
    expect(persona).toContain("also-nonexistent");
  });
});

describe("ensureBaseAgentsDeployed", () => {
  /** Rewrites viberr-core's roster to exactly `keep` and reprojects. */
  function setRoster(
    db: ReturnType<typeof ctx.makeDb>,
    dataRoot: string,
    keep: (profileId: string) => boolean,
  ): void {
    const file = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const trimmed = {
      ...file.parsed,
      frontmatter: {
        ...file.parsed.frontmatter,
        agents: file.parsed.frontmatter.agents.filter((a) => keep(a.profileId)),
      },
    };
    writeFileAtomic(projectFilePath("viberr-core", dataRoot), serializeProjectFile(trimmed));
    rebuildPath(db, projectFilePath("viberr-core", dataRoot), { dataRoot });
  }

  function rosterIds(dataRoot: string): string[] {
    return readProjectFile({ projectSlug: "viberr-core", dataRoot })!
      .parsed.frontmatter.agents.map((a) => a.profileId);
  }

  it("backfills the base specialists into a project with NO specialists (first boot)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });

    // Operator-only roster = no specialist deployments at all — this is the
    // one case the base specialists are still injected into.
    setRoster(db, dataRoot, (id) => id === "operator");
    ensureBaseAgentsDeployed(db, dataRoot);

    const ids = rosterIds(dataRoot);
    expect(ids).toContain("operator");
    expect(ids).toContain("developer");
    expect(ids).toContain("reviewer");
    expect(ids).not.toContain("tester");
  });

  it("respects a deliberate specialist removal — ≥1 specialist keeps the roster as-is (E10)", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });

    // The owner removed the Reviewer on purpose; the Developer remains. The
    // old boot backfill re-injected the Reviewer every restart.
    setRoster(db, dataRoot, (id) => id !== "reviewer");
    ensureBaseAgentsDeployed(db, dataRoot);

    const ids = rosterIds(dataRoot);
    expect(ids).toContain("operator");
    expect(ids).toContain("developer");
    expect(ids).not.toContain("reviewer");
  });

  it("the OPERATOR is always re-ensured — without dragging specialists along", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });

    // No operator, but a deliberate developer-only roster.
    setRoster(db, dataRoot, (id) => id === "developer");
    ensureBaseAgentsDeployed(db, dataRoot);

    const ids = rosterIds(dataRoot);
    expect(ids).toContain("operator"); // system profile: unconditional
    expect(ids).toContain("developer");
    expect(ids).not.toContain("reviewer"); // has ≥1 specialist → no backfill
  });

  it("is idempotent — a fully-rostered project is left untouched", async () => {
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });

    const beforeIds = rosterIds(dataRoot);
    ensureBaseAgentsDeployed(db, dataRoot);
    expect(rosterIds(dataRoot)).toEqual(beforeIds);
  });

  /**
   * Ruling 518 (owner, 2026-09-27): the operator is one agent, called Operator,
   * with no role. Its editor used to ask for a name and a role, and a save
   * stored both on the project's deployment with the template's scope line.
   */
  it("ruling 518: removes the operator's stored name, role and scope, and keeps an agent profile's", async () => {
    // CANARY: stop calling `withoutOperatorIdentity`, or let it strip a
    // deployment that is not the operator.
    const db = ctx.makeDb();
    const dataRoot = ctx.makeTempDir();
    await runDemoSeed(db, { dataRoot });
    const operator = {
      kind: "operator",
      name: "Coordinator",
      role: "Task coordinator",
      model: "sonnet",
      scope: "System role · one per active task",
      autonomy: "supervised",
    } satisfies AgentDeploymentDefinition;
    const developer = {
      kind: "specialist",
      name: "Developer",
      role: "Implementation",
      model: "sonnet",
      scope: "Global base",
    } satisfies AgentDeploymentDefinition;
    const file = readProjectFile({ projectSlug: "viberr-core", dataRoot })!;
    const agents = file.parsed.frontmatter.agents.map((a) =>
      a.profileId === "operator"
        ? { ...a, definition: operator }
        : a.profileId === "developer"
          ? { ...a, definition: developer }
          : a,
    );
    writeFileAtomic(
      projectFilePath("viberr-core", dataRoot),
      serializeProjectFile({
        ...file.parsed,
        frontmatter: { ...file.parsed.frontmatter, agents },
      }),
    );
    rebuildPath(db, projectFilePath("viberr-core", dataRoot), { dataRoot });

    ensureBaseAgentsDeployed(db, dataRoot);

    const definitionOf = (id: string) =>
      readProjectFile({ projectSlug: "viberr-core", dataRoot })!
        .parsed.frontmatter.agents.find((a) => a.profileId === id)?.definition;
    expect(definitionOf("operator")).toEqual({
      kind: "operator",
      model: "sonnet",
      autonomy: "supervised",
    });
    expect(definitionOf("developer")).toEqual(developer);
  });
});
