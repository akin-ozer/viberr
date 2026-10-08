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
import { seedDefaultAgentAssets, shippedCopyIsUnedited } from "./default-assets.server";
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
import { effectiveCollabMode } from "~/server/tasks/agent-outcome.server";
import { grantsWriteRepository } from "~/server/tasks/specialist-tool-policy";
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
    expect(LIBRARY_AGENT_PROFILES.map((p) => p.frontmatter.id)).toEqual([
      "writer",
      "editor",
      "diagrammer",
      "cover-designer",
    ]);
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
    expect(editor).toContain("save no file on the task under a name the delivery holds");
    // A piece with no page to picture is judged from its file, not sent back
    // for a picture nobody could take.
    expect(editor).toContain("do not block on a picture nobody could take");
    expect(writer).toContain("Where you could not look, say so in your note.");
    // Ruling 695: three readers out of three picked a piece whose facts all
    // held, for a narrator who cited his own log and quoted his own messages.
    // CANARY: drop either paragraph from the Writer's manual, or the cold
    // read's line from the Editor's.
    expect(writer).toContain("Their notes and answers are your material, not quotations: do not quote the person to themselves");
    expect(writer).toContain("Quote them only where the exact words are the point of the passage.");
    expect(writer).toContain("belongs in your notes, never in the piece's voice.");
    expect(writer).toContain("Where only a record shows what they did or decided,");
    expect(writer).toContain("Name or link one of their records in the piece only where its reader would want to open it.");
    // The rule is about the person's own records. CANARY: drop this sentence
    // and a report states a third party's figure as the person's own.
    expect(writer).toContain("a source from outside that the reader should know of (a study, a vendor's page, someone else's words) is still named where the piece uses it");
    // And the Editor holds the same two exceptions the Writer is given, or a
    // letter that quotes an earlier letter is sent back for it.
    expect(editor).toContain("A quotation whose exact words are the point of the passage, and a record the reader would want to open, are not that;");
    expect(editor).toContain("the fix is the plain fact without \"I\", or the person's own answer");
    expect(writer).toContain("state the outcome as a plain fact about the thing, without \"I\", and list it in your note as theirs to confirm");
    expect(editor).toContain("what reads as put together from files: a narrator who cites their own records");
    expect(editor).toContain("\"I chose\" or \"I decided\" on the strength of a record alone is the same defect");
    // A store whose copy nobody edited takes the new text at its next boot.
    // CANARY: remove either outgoing hash.
    expect(
      shippedCopyIsUnedited("skills/writer-expertise/SKILL.md", "7f3e87f2478e5c2b798d2b45884ff95f9e62f81f25faa5cefc92161bd1166244", {}),
    ).toBe(true);
    expect(
      shippedCopyIsUnedited("skills/editor-expertise/SKILL.md", "26b0210af906fd9b5495af1f5b343654422cee54986f86808e6285c3508cf253", {}),
    ).toBe(true);
    // Neither manual is about one kind of writing.
    expect(writer + editor).not.toMatch(/\bblog\b/i);
  });
});

describe("ruling 699: the library ships a Diagrammer and a Cover Designer", () => {
  const profileOf = (id: string) => LIBRARY_AGENT_PROFILES.find((p) => p.frontmatter.id === id);
  const grantsOf = (id: string): Map<string, string> =>
    new Map((profileOf(id)?.frontmatter.capabilities ?? []).map((c) => [c.capabilityId, c.mode]));
  const said = (dataRoot: string, name: string) =>
    readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");

  it("writes both templates and their manuals into a fresh store, the persona as the template's body", () => {
    // CANARY: take either profile out of LIBRARY_AGENT_PROFILES, or either
    // skill out of STATIC_ASSETS, and its file is not there.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const read = (...parts: string[]) => readFileSync(path.join(dataRoot, ...parts), "utf8");
    const diagrammer = read("agents", "profiles", "diagrammer.md");
    const cover = read("agents", "profiles", "cover-designer.md");
    expect(diagrammer).toContain("You are the Diagrammer.");
    expect(diagrammer).toContain("diagrammer-expertise");
    expect(cover).toContain("You are the Cover Designer.");
    expect(cover).toContain("cover-designer-expertise");
    expect(read("skills", "diagrammer-expertise", "SKILL.md")).toContain("# Viberr diagrammer expertise");
    expect(read("skills", "cover-designer-expertise", "SKILL.md")).toContain("# Viberr cover designer expertise");
    expect(diagrammer).toContain("kb: []");
    expect(cover).toContain("kb: []");
  });

  it("each saves files and reaches the web, delivers nothing, holds no verdict and asks the person nothing", () => {
    // CANARY: move "Ask the human a question" out of either `forbidden` list
    // and the grant is absent, which the catalog reads as granted.
    for (const id of ["diagrammer", "cover-designer"]) {
      const grants = grantsOf(id);
      expect(grants.get("attach-evidence-references"), id).toBe("direct");
      expect(grants.get("use-web-search-fetch"), id).toBe("direct");
      expect(grants.get("ask-human"), id).toBe("human");
      expect(grants.get("commit-push-branch"), id).toBe("human");
      expect(grants.has("execute-code-or-write-repo"), id).toBe(false);
      expect(grants.has("report-validation-verdict"), id).toBe(false);
      // What the stored modes come to at run time, which is what the claim
      // is about. CANARY: add "Create the task-key branch" to either `direct`
      // list and the profile can write a repository.
      const stored = profileOf(id)!.frontmatter.capabilities;
      expect(grantsWriteRepository(stored), id).toBe(false);
      expect(effectiveCollabMode(stored, "ask-human"), id).toBe("human");
      expect(effectiveCollabMode(stored, "report-validation-verdict"), id).toBe("off");
      expect(effectiveCollabMode(stored, "attach-evidence-references"), id).toBe("direct");
      const profile = profileOf(id)!;
      expect(profile.frontmatter.extras, `${id} has a label the catalog does not know`).toEqual([]);
      expect(isKnownModel("claude", profile.frontmatter.model), id).toBe(true);
      // They look at the picture a tool returns, which is proven on Claude only.
      expect(profile.frontmatter.backends, id).toEqual(["claude"]);
    }
  });

  it("each manual leaves a board's own skill half of what a run with no checkout is given", () => {
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    for (const name of ["diagrammer-expertise", "cover-designer-expertise", "editor-expertise", "writer-expertise"]) {
      const raw = readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8");
      expect(splitFrontmatter(raw).body.trim().length, name).toBeLessThanOrEqual(SKILL_INJECTION_BUDGET / 2);
    }
  });

  it("says a picture shows only what is true, is judged by looking at it, and is placed in the piece by its maker", () => {
    // CANARY: drop a section of either manual.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const diagrammer = said(dataRoot, "diagrammer-expertise");
    expect(diagrammer).toContain("**None is a result.**");
    expect(diagrammer).toContain("Every box, every arrow and every label comes from the piece or from a source kept on the task.");
    expect(diagrammer).toContain("Do not draw from your memory of how such systems usually look.");
    expect(diagrammer).toContain("Write the question the diagram answers in one line before you draw");
    // The picture is made at a size the run names, and looked at.
    expect(diagrammer).toContain("`capture_page` with the drawing's name and its `width` and `height` returns the picture");
    // Read before it shipped: the reply's word on a layout that runs past
    // the box cannot see inside a drawing's own canvas. CANARY: drop the
    // sentence and a label cut at the canvas edge is "said to fit".
    expect(diagrammer).toContain("It cannot see what a drawing's own canvas cuts off");
    expect(diagrammer).toContain("Read the piece again just before you do, and add your line to the file as it stands then");
    expect(diagrammer).toContain("A picture the piece already carries stays where it is");
    expect(diagrammer).toContain("Check what you see, not what you meant");
    expect(diagrammer).toContain("If you cannot read a main label in the phone picture, neither can the reader");
    // Rehearsed: the run re-checked the piece's own facts in seven sources,
    // looked at the piece eight times, and left the pictures' field for the
    // writer, which would have cost a writer's run. CANARY: drop any of the
    // three sentences.
    expect(diagrammer).toContain("**What the piece states, draw as it states it.**");
    expect(diagrammer).toContain("Look again only when the picture itself changed.");
    expect(diagrammer).toContain("the field that lists its pictures is yours to bring up to date");
    const cover = said(dataRoot, "cover-designer-expertise");
    expect(cover).toContain("**It shows something from the piece.**");
    expect(cover).toContain("would this cover fit another piece on the same topic? Then it is wallpaper.");
    expect(cover).toContain("Generated or stock imagery, and anything drawn to look like either.");
    expect(cover).toContain("An invented screen, output, quote or number.");
    // Read before it shipped: the recipe hid the page's overflow, and the
    // reply then said a cover with a line below its box fitted. CANARY: put
    // `overflow: hidden` back in the recipe's place.
    expect(cover).toContain("Do not hide overflow on the page or on that box");
    expect(cover).not.toContain("overflow: hidden");
    expect(cover).toContain("Take the look and nothing else.");
    // Rehearsed: a board's later covers follow its first, and a person who
    // publishes in two places has two looks.
    expect(cover).toContain("those are the look");
    expect(cover).toContain("Another publication's covers are that publication's look, not the person's");
    expect(cover).toContain("the field that names its cover is yours to fill");
    // The list of the piece's pictures holds other makers' entries too.
    expect(cover).toContain("add the cover and leave every other entry as it is");
    expect(cover).toContain("the same call with `scale` 0.25 is the cover as a feed shows it");
    for (const manual of [diagrammer, cover]) {
      // A supporting agent's save of the piece is what puts its picture under
      // review (ruling 587), so both manuals say the save is theirs to make
      // and that nothing else in the piece is.
      expect(manual).toContain("That save makes the assembled piece the delivery a reviewer judges.");
      expect(manual).toContain("Copy the picture `capture_page` saved for your run");
      expect(manual).toContain("a face it lacks is replaced without a word");
      expect(manual).toContain("Change nothing else in the piece");
      // The picture that is kept is the scale 2 one, and a rework that only
      // replaces it still reaches review (ruling 699's delivery rule).
      // Within 2,000 px on a side, so its maker and whoever opens it next
      // both see the picture that goes out, not a smaller render of it.
      expect(manual).toMatch(/the same call with `scale` (2|1\.5) makes the (picture|cover) you keep/);
      expect(manual).toContain("it is the picture that goes out");
      expect(manual).toContain("within 2,000 px on a side");
      expect(manual).toContain("puts the piece back under review");
      // Rehearsed against the renderer (2026-10-08): a run that measured its
      // own picture with scripts took 15 minutes over a cover.
      expect(manual).toContain("Judge by eye, as a reader does: run no script over the picture's pixels.");
      // What only the person can supply is a line of the report, never a question.
      expect(manual).not.toMatch(/ask_human|ask the person/i);
      // Neither manual is about one kind of writing.
      expect(manual).not.toMatch(/\bblog\b/i);
    }
  });

  it("has the Editor open every picture, and the Writer leave the drawing to a board's drawing agent", () => {
    // CANARY: drop the Editor's picture section, or the Writer's paragraph.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const editor = said(dataRoot, "editor-expertise");
    expect(editor).toContain("### 7. Every picture, by looking at it");
    expect(editor).toContain("Never judge a picture from the file that drew it.");
    expect(editor).toContain("every box, arrow and label is in the piece or in a kept source");
    expect(editor).toContain("One that would fit any piece on the topic blocks");
    expect(editor).toContain("Name the file with each finding and say what would fix it, so the fix goes to whoever made that picture.");
    const writer = said(dataRoot, "writer-expertise");
    expect(writer).toContain("the diagrams and the cover are that agent's. Draw none yourself");
    const guide = said(dataRoot, "controller-guide");
    expect(guide).toContain("add the shipped Diagrammer and Cover Designer** (ruling 699)");
    expect(guide).toContain("each deployed at the stage where its step happens");
    // Two at once would each save the piece, and the writer has to be told
    // the drawing is not its to do. CANARY: drop either clause.
    expect(guide).toContain("to run the two one after the other, the diagrams first");
    expect(guide).toContain("so its writer draws none");
    // A store whose copy nobody edited takes the new text at its next boot.
    // CANARY: remove any of the three outgoing hashes.
    const outgoing: [string, string][] = [
      ["skills/writer-expertise/SKILL.md", "8c133fa610e494f0497b114cf71f64f08d91c9d08e6974634f1f4129fb64e870"],
      ["skills/editor-expertise/SKILL.md", "62e62eed5108c4228e92c228d082d9815cb79c450d64b8d79f07beab7e30538a"],
      ["skills/controller-guide/SKILL.md", "e51e4710c9719b8bae32484e443a0c8be92e5fe6298e03dd53bc78eb26abb208"],
    ];
    for (const [rel, hash] of outgoing) expect(shippedCopyIsUnedited(rel, hash, {}), rel).toBe(true);
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
