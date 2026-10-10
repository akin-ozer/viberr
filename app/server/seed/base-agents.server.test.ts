import { PAGE_PICTURES_PACKET_SENTENCE } from "~/server/tasks/completion-packet.server";
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
import { KEEP_PAGE_LOOK_TOOL, PAGE_CAPTURE_TOOL, PAGE_MEASURE_TOOL } from "~/server/mcp-proxy/board-tool.server";
import { PAGE_CAPTURE_VIEWS } from "~/shared/page-capture";

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

    // Real, loadable skills — one per specialist role.
    expect(read("skills", "developer-expertise", "SKILL.md")).toContain("developer expertise");
    expect(read("skills", "reviewer-expertise", "SKILL.md")).toContain("reviewer expertise");

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
});

describe("ruling 179: the library ships a Writer and an Editor", () => {
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
    // Ruling 179: three readers out of three picked a piece whose facts all
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

/**
 * Ruling 218, live on BLOG-7. The post said of a request, "How much of it
 * comes from the cache isn't recorded", on the word of a ruling of
 * 2026-09-26. A ruling two days later, 62 lines further down the same kept
 * decisions file, had the product print exactly that. The Writer cited the
 * entry it found, and the Editor checked the sentence against the line cited:
 * at high effort in four minutes, and again at max in nineteen. Two outside
 * checks, told only to check every claim, both found the later entry.
 */
describe("ruling 218: a record that grows is read to its latest entry on the subject", () => {
  const said = (dataRoot: string, name: string) =>
    readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");

  it("has the Writer state what holds after the latest entry, and the Editor read beyond the entry cited", () => {
    // CANARY: drop the Writer's bullet, or the Editor's, or the sentence that
    // says reading the kept record further is not research.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const writer = said(dataRoot, "writer-expertise");
    expect(writer).toContain("**A record that grows goes stale inside itself.**");
    expect(writer).toContain("an entry says what held on its date, and a later entry may have changed it");
    expect(writer).toContain(
      "Before you state what holds now from one entry, search the whole record for the later entries on the same subject and read them. " +
        "State what holds after the latest one that speaks to it, and cite that one.",
    );
    // The reviews of BLOG-7 read the cuts the writer had made of the record,
    // where the later entry was not. CANARY: drop the sentence.
    expect(writer).toContain("Keep the record whole, beside any cut of it you made for reading: the editor searches it.");
    const editor = said(dataRoot, "editor-expertise");
    expect(editor).toContain(
      "The source is a record that grows (a decisions file, a changelog, release notes, a thread) and the piece says what holds now: " +
        "the entry cited is where you start, not where you stop.",
    );
    // The search is for the thing by its name, in the whole record. In
    // rehearsal the sentence's own words led back to the entry it cited, and
    // the later entry, whose title is about cost, came up only under the
    // feature's name.
    // What is gone through is the places found, not every later entry: in the
    // rehearsal's record the later entries were twenty-six pages of a read.
    expect(editor).toContain(
      "Search the whole kept record, not a cut of it, for the thing that sentence is about, under the name the record gives it and not the sentence's own words, " +
        "which a later entry seldom repeats, and go through every place found in an entry dated after the one cited.",
    );
    // What the manual says of the tool is what the tool does: a page of
    // places, not every one. CANARY: restore "lists every place".
    expect(editor).toContain(
      "`read_task_source` with `find` lists the places that hold a word or phrase, up to forty to a call, each with its line and the words around it; " +
        "search on from `nextOffset` while it gives one.",
    );
    expect(editor).not.toContain("lists every place");
    expect(editor).toContain("A record kept only as a cut cannot be checked this way, and that is a finding too.");
    expect(editor).toContain("A later entry that changes what the piece states is blocking: quote the piece, the entry it rests on and the later one.");
    // The line under the list told the Editor not to research the subject
    // again, which reads as a reason to stop at the line cited.
    // "Beyond", not "past the line": a changelog runs newest first.
    expect(editor).toContain("Reading a kept record beyond the entry cited is neither: it is finding the words that hold now.");
    // Neither rule is about one kind of record.
    for (const manual of [writer, editor]) expect(manual).toContain("decisions file, a changelog, release notes");
    // A store whose copy nobody edited takes the new text at its next boot.
    // CANARY: remove either outgoing hash.
    expect(shippedCopyIsUnedited("skills/writer-expertise/SKILL.md", "92789f682bfe7b9bc16780687ce552ad79b729a9af4a768be5ef36b63935004f", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/editor-expertise/SKILL.md", "4db16badd8b3fccd4e2e0bcbe9a09709da677d53584de03baf77adb230a18709", {})).toBe(true);
  });

  it("has the Reviewer every other board deploys do the same, in one sentence of its source check", () => {
    // The Editor is one board's reviewer. A price list, a changelog or an
    // issue thread kept on any results board goes stale the same way, and the
    // Reviewer's manual sent it to "the source it cites" and no further.
    // CANARY: drop the sentence, or its outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const reviewer = said(dataRoot, "reviewer-expertise");
    expect(reviewer).toContain(
      "When the source is a record that grows (a changelog, a decisions file, a thread) and the work states what holds now, a later entry may have changed the one it cites: " +
        "search the source for the subject (`read_task_source` with `find`), read the later entries, and report one that says otherwise.",
    );
    expect(shippedCopyIsUnedited("skills/reviewer-expertise/SKILL.md", "6703e3624becd424684c32a912b403fddf5d71994023d706fdac6613d724def7", {})).toBe(true);
  });

  it("has the guide deploy the Editor at high effort, with what a review took at each", () => {
    // The owner's trial on BLOG-7: the Editor at `high` reviewed a full post
    // in under four minutes and sent two real faults back; at `max`, on the
    // same post and pictures, it took nineteen and found nothing more. The
    // first board's controller had given it the writer's `max`.
    // CANARY: drop the sentence, or its outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const guide = said(dataRoot, "controller-guide");
    expect(guide).toContain("Deploy the Editor at `high` effort");
    expect(guide).toContain("its review of a full piece took 4 minutes at `high`, and a review of the same piece and pictures at `max` took 19 and found nothing more");
    expect(shippedCopyIsUnedited("skills/controller-guide/SKILL.md", "a9ff90ee8fc6a085586d661a8d56cccdb5e52f489027afd4f0db9d71db5bd3e7", {})).toBe(true);
  });
});

describe("rulings 178 and 268: work that is looked at is made, judged and planned on what Viberr pictures", () => {
  const said = (dataRoot: string, name: string) =>
    readFileSync(path.join(dataRoot, "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
  /** The arguments a tool's own schema takes, as the manuals may name them. */
  const argsOf = (tool: { inputSchema: { properties?: object } }) => Object.keys(tool.inputSchema.properties ?? {});

  it("has the Developer look at, measure and keep the look of what it makes, with the tools as they are", () => {
    // The first board asked for a page built one from the reference as it
    // read that day, pictured it with a script of its own at a width Viberr
    // does not use, and drew the product's screens in markup: nothing in the
    // manual every Developer reads said how work that is looked at is made.
    // CANARY: drop the section, a bullet of it, or the outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const developer = said(dataRoot, "developer-expertise");
    expect(developer).toContain("## When what you make is looked at");
    expect(developer).toContain("**Look at it yourself, at both widths, before you hand it over.**");
    expect(developer).toContain("Say nothing about how the page looks that a picture you opened does not show.");
    expect(developer).toContain("**Measure it before you hand it over.**");
    expect(developer).toContain("**When it is made to look like something that exists, keep that look and work from it.**");
    expect(developer).toContain("The address reads differently next week and a description is its writer's reading, so neither is what you work from");
    expect(developer).toContain("**Take the look, never the thing.**");
    expect(developer).toContain("Every link and every control goes somewhere real or is not there.");
    // What the manual says of a tool is what the tool takes: each state it
    // names is an argument of `capture_page`, and the look is kept and taken
    // over by the arguments `keep_page_look` has.
    for (const tool of [PAGE_CAPTURE_TOOL, PAGE_MEASURE_TOOL, KEEP_PAGE_LOOK_TOOL]) expect(developer).toContain(`\`${tool.name}\``);
    for (const state of ["press", "hover", "tab", "motion", "moving"]) {
      expect(argsOf(PAGE_CAPTURE_TOOL)).toContain(state);
      expect(developer).toContain(`(\`${state}\`)`);
    }
    expect(argsOf(KEEP_PAGE_LOOK_TOOL)).toContain("from");
    expect(developer).toContain("take that one over (`from`)");
    expect(shippedCopyIsUnedited("skills/developer-expertise/SKILL.md", "dabe7985106e69d4351cc6d7feec4a11ab42ee65f15cacc3d8bbf7a16093b3bb", {})).toBe(true);
  });

  it("has the Reviewer look the way an approval is held to, and write a finding as what is seen", () => {
    // The first board's reviewer looked only because the board's own rulings
    // told it to, in its own browser, at the reference as it read that day.
    // CANARY: drop the section, a bullet of it, or the outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const reviewer = said(dataRoot, "reviewer-expertise");
    expect(reviewer).toContain("## When the work is looked at");
    // The way to look that the manual gives is the one the gate counts
    // (ruling 329): `capture_page` in stretches to the page's end, since one
    // kept picture of a long page is taller than a look.
    expect(reviewer).toContain(
      "Look with `capture_page`: the page's name, one width at a time, on from each `nextFrom` until the reply gives none. " +
        "An approval from a run that has not is not recorded",
    );
    expect(argsOf(PAGE_CAPTURE_TOOL)).toEqual(expect.arrayContaining(["name", "view", "from"]));
    expect(reviewer).toContain("Judge against the kept pictures, never against the address as it reads today or a description of it.");
    expect(reviewer).toContain("Work made to a look the task keeps no pictures of cannot be judged: request changes and say so.");
    expect(reviewer).toContain("**Read what Viberr measured.**");
    expect(reviewer).toContain("Nothing is borrowed from the reference");
    expect(reviewer).toContain("A finding about the look with no picture behind it is an opinion.");
    for (const state of ["press", "hover", "tab", "motion", "moving"]) expect(reviewer).toContain(`(\`${state}\`)`);
    expect(shippedCopyIsUnedited("skills/reviewer-expertise/SKILL.md", "9e5360754136f8feeeb5a3c14813e3ac4dbf8a49e2145edc26e619896e0ddbc9", {})).toBe(true);
  });

  it("has whoever makes and whoever judges work made to a kept look say what differs, and take a placeholder or an unreadable word for unfinished", () => {
    // The second board's first page was approved by a review that had looked
    // at the page and at every kept picture of the look: the product's
    // screens were drawn with untitled cards, empty pills and grey bars for
    // lines, and at the phone width one was the desktop's, shrunk until its
    // labels stood 5 px high. The review named the blanks and let them stand
    // as showing nothing the board's facts did not hold, and nothing asked
    // either agent to say what differed from the kept pictures.
    // CANARY: drop any sentence below from either manual, or either outgoing
    // hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const developer = said(dataRoot, "developer-expertise");
    const reviewer = said(dataRoot, "reviewer-expertise");
    // One list of what a look is judged on, the same for both.
    const judgedOn = "layout and rhythm, the scale and weight of type, colour and contrast, depth, density, how the product is shown, what moves";
    expect(developer).toContain(`set your own beside them, section by section at each width, on each of: ${judgedOn}. Say in your report what still differs on each and why you left it.`);
    expect(reviewer).toContain(`set the two side by side at each width, section by section: ${judgedOn}.`);
    // The account comes after the findings, a line a section and width: a
    // verdict keeps the first 2,000 characters of a report (ruling 88), and
    // those are the findings' to have.
    expect(reviewer).toContain(
      "Your report says, after its findings, what differs from the kept pictures: one line for each section at each width you were shown, naming what differs on those seven or that nothing does. " +
        "A difference you do not name is one you did not see. An approval says of each difference it leaves standing why it is not a finding.",
    );
    // "Those seven" are the ones the manual itself lists.
    const listed = /section by section: ([^.]+)\. Judge against the kept pictures/.exec(reviewer)?.[1].split(", ");
    expect(listed).toHaveLength(7);
    // A placeholder is neither content nor honesty about its absence, and a
    // word nobody can read says nothing: unfinished to the maker, a finding
    // to the judge. The maker is told the way out, which is never to write
    // something in.
    // What the work is meant to carry: a template's own placeholders and a
    // product's empty state shown as it is are content, and what must be
    // read is what a reader is meant to read at that width, which is what
    // the Diagrammer's and the Editor's manuals hold a picture to.
    const placeholder = (verdict: string) =>
      `Nothing stands in for content the work is meant to carry: an empty box, a bar drawn where words belong or a blank label is ${verdict}, in a picture of the product as anywhere else.`;
    expect(developer).toContain(
      `${placeholder("unfinished work")} Put there what is on record, or take it out. ` +
        "At each width a reader can read every word they are meant to read there, the words inside a picture included: " +
        "a picture shrunk until those words cannot be read is cropped, or made again for that width.",
    );
    expect(reviewer).toContain(
      `${placeholder("a finding")} So is a word a reader is meant to read at a width and cannot, the words inside a picture included.`,
    );
    expect(shippedCopyIsUnedited("skills/developer-expertise/SKILL.md", "5af46bab6b9f1fb52a15d2ea6647bd94040be2c3e676713f8471ba55d8a4c614", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/reviewer-expertise/SKILL.md", "8eb176885fd2c7d2f8a9e3764d1341cd96c510e85117adc5bf07937ec28244e4", {})).toBe(true);
  });

  it("has a picture of the product show what is on record: the product's own demo data or what the person gave for it, never content made up or put in for it", () => {
    // Sent back for its blanks, the second board's page came back with its
    // screens filled: a project, nine tasks, a person and a repository made
    // up for the pictures and marked as sample, which the review took for
    // demo data. The manuals said a picture shows "demo data", not whose.
    // CANARY: drop a sentence; drop the person's gift from either manual,
    // and a product with no demo data has no picture of itself a review can
    // pass; drop "and nothing else", and a maker types a project of its own
    // into the running product and keeps the screenshot as its own proof;
    // drop what the product makes of it from the Reviewer's, and no honest
    // picture of a command's output can be approved; drop the kept run from
    // either, and a screen drawn in markup passes with totals nobody ran.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const developer = said(dataRoot, "developer-expertise");
    const reviewer = said(dataRoot, "reviewer-expertise");
    // One list of what a product may be given, the same in both.
    const demo = "own demo data (a demo seed, its documented examples)";
    const gift = "what the person gave for the picture";
    expect(developer).toContain(
      `What a picture of the product itself shows comes from one of two places, each kept with \`keep_source\` like any statement: the product's ${demo}, or ${gift} on the task. ` +
        "Give the product that and nothing else: whatever else you put into it or draw in for the picture is made up, whatever it is marked as. " +
        "What the product makes of it (its output, a total, a date) is the product's own; " +
        "where the picture is drawn from a run and not taken of it, keep the run's output too, and draw in nothing that output does not show. " +
        "A person's live data goes in only when they gave it for this. " +
        "Where neither place holds anything, see what another task of the board keeps of either (`read_task_source` with its key); " +
        "where that holds none, ask the person for the content itself, their own screens or the names and figures to show, and keep what they give; " +
        "where they give none, leave the picture out.",
    );
    // The reviewer holds what the product was given to the same two places,
    // wherever on the board the source is kept (a source of another task
    // can be read from this one and cannot be kept again on it), takes the
    // rest for the product's, and holds a drawn picture to the run the
    // maker kept: only that run tells an honest transcript from an invented
    // one.
    expect(reviewer).toContain(
      "What a picture of the product itself shows rests on a kept source like any statement, on this task or another of the board's. " +
        `What the product was given comes from its ${demo} or from ${gift}: ` +
        "a name, a title or a figure given to it from neither was made up for the picture, whatever it is marked as, and is a finding, " +
        "and so is a person's live data they did not give for it. " +
        "The rest is what the product itself made of that (its output, a total, a date): " +
        "where the picture is drawn and not taken of the running product, hold the rest to the kept output of a run, and what that output does not show is a finding too.",
    );
    // And to the same two kinds of picture the maker is.
    expect(developer).toContain("A picture on it is the product itself, running, or it explains the product: never a drawing of a screen that does not exist, or a stock picture.");
    expect(reviewer).toContain("Every picture is the product or explains it: a drawing of a screen the product does not have, or a stock picture, is a finding.");
    // The maker's sentence rests on two things the seeded Developer may do:
    // ask the person, which the catalog grants it, and keep a source, which
    // the catalog leaves to that grant's default. CANARY: move "Ask the
    // human a question" from the profile's `direct` list to its `forbidden`.
    const granted = SEED_AGENT_PROFILES.find((profile) => profile.frontmatter.id === "developer")!.frontmatter.capabilities;
    expect(effectiveCollabMode(granted, "ask-human")).toBe("direct");
    expect(effectiveCollabMode(granted, "attach-evidence-references")).toBe("direct");
  });

  it("has the guide plan a page on Viberr's own pictures, widths and figures, as files when nobody named a repository, and as one task", () => {
    // The first board asked for a page was planned as four pull-request tasks
    // (27 runs and $24.93 before a section of the page existed), with a
    // review procedure of the controller's own at 1440 px, a width Viberr
    // pictures nothing at; its pages, in pull requests, were never pictured.
    // CANARY: drop the section, a bullet of it, the price of a task, or the
    // outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const guide = said(dataRoot, "controller-guide");
    expect(guide).toContain("## Work a person looks at");
    expect(guide).toContain("write none of it into the rulings as your own procedure: no other widths, no browser steps, no description of the look");
    // The widths the guide names are the ones a delivered page is pictured at.
    const widths = PAGE_CAPTURE_VIEWS.map((view) => `${view.width} px`);
    expect(widths).toEqual(["1280 px", "390 px"]);
    expect(guide).toContain(`(rulings 86 and 328): at ${widths[0]} and at ${widths[1]}`);
    expect(guide).toContain("**A reviewer's approval of a page counts only from a run that looked** (ruling 329)");
    expect(guide).toContain("**Work made to look like something keeps that look** (ruling 327)");
    expect(guide).toContain("Never describe the reference in a goal or in the rulings");
    expect(guide).toContain("**A page nobody named a repository for is delivered as files.**");
    // Ruling 86: a board that ships pull requests is planned on the same
    // pictures, through the folder a gate names.
    expect(guide).toContain("**On a board that ships pull requests, the site is what its gates build.**");
    expect(guide).toContain("its `pages` folder (`set_project_gates`)");
    expect(guide).toContain("Without it nothing above holds a page there.");
    expect(guide).not.toContain("Viberr does not open the pages inside a pull request");
    expect(guide).toContain("**A task has a price**: a making run, a review of every delivery and an operator turn at each hand-off.");
    expect(guide).toContain("What one agent makes and one review judges as a whole is one task: a page is one");
    for (const tool of [PAGE_CAPTURE_TOOL, PAGE_MEASURE_TOOL, KEEP_PAGE_LOOK_TOOL]) expect(guide).toContain(`\`${tool.name}\``);
    expect(shippedCopyIsUnedited("skills/controller-guide/SKILL.md", "e9766677fe0e282ae0662b4ccc2ee69e90ebca9e1115703b6baf8a7b9ae55480", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/controller-guide/SKILL.md", "1237c0afcc06838ace073a279c3828a87df97f79200560eb061d9a031fb29e3c", {})).toBe(true);
  });

  it("ruling 86: tells whoever makes and whoever judges a site that the pages are the ones the project's gates build", () => {
    // On the first board that shipped a site through pull requests the
    // Developer and the Reviewer each looked at a build of their own, and
    // nothing said the gates' build was the one judged.
    // CANARY: drop either sentence, or either outgoing hash.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    const developer = said(dataRoot, "developer-expertise");
    expect(developer).toContain("a page is asked for by its path in the built site (`index.html`, or `about/` for `about/index.html`)");
    expect(developer).toContain("A review is shown the pages as the gates build your delivered revision, never your own build");
    const reviewer = said(dataRoot, "reviewer-expertise");
    expect(reviewer).toContain("the pages are the ones the gates built of the delivered revision, which Viberr kept");
    expect(reviewer).toContain("never judge the look from a build of your own");
    expect(shippedCopyIsUnedited("skills/developer-expertise/SKILL.md", "5cb078e4c8b33d04cd2f6fc2f7a9d75c131722b180d1c7684b43744cf6064856", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/reviewer-expertise/SKILL.md", "b72b5f22a49af310d470db6afa0d48c69b5866460edeefeae5bd8adb83bed825", {})).toBe(true);
    // The operator was told every picture Viberr makes shows beside its page
    // on the result, which a pull request's result never does: the person
    // accepting a site saw none. It is told a revision's are the packet's
    // to show, in its definition and where the tool is described.
    const operator = readFileSync(path.join(dataRoot, "agents", "definitions", "operator.md"), "utf8").replace(/\s+/g, " ");
    const revisions =
      "On a task delivered as a revision they are the pages the project's gates built of it, and no result card shows them: " +
      "name the ones a person should see among the `screenshots`.";
    expect(operator).toContain(revisions);
    expect(PAGE_PICTURES_PACKET_SENTENCE).toContain(revisions);
    expect(shippedCopyIsUnedited("agents/definitions/operator.md", "db773c4586a50c81b59d3224b0361158fc6dcb9181ad97344bb5e520b39723c3", {})).toBe(true);
  });
});

describe("ruling 179: the library ships a Diagrammer and a Cover Designer", () => {
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
    // On a board with no repository every skill reaches a run as prompt text
    // under one shared budget (ruling 186), drawn in name order: a manual that
    // filled it would cut the board's own skill off whole. The Writer's and the
    // Editor's manuals (ruling 179) are held to it here too, and so are the
    // Developer's and the Reviewer's (ruling 178), which every board deploys
    // and which grow with each thing learned about work that is looked at.
    const dataRoot = ctx.makeTempDir();
    seedDefaultAgentAssets(dataRoot);
    for (const name of ["diagrammer-expertise", "cover-designer-expertise", "editor-expertise", "writer-expertise", "developer-expertise", "reviewer-expertise"]) {
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
    // Rehearsed on a fourth post with the manuals as first shipped: 21
    // minutes, three looks at the piece and a hash of both files to prove
    // nothing else changed. The half-size look judges legibility without a
    // hunt through the page. CANARY: drop any of the five sentences.
    expect(diagrammer).toContain("the same call with `scale` 0.5 is about how wide a phone shows a canvas of 700 to 800 px. If you cannot read a main label there, neither can the reader");
    expect(diagrammer).toContain("how it reads you judged at scale 0.5, and the desktop width needs no look");
    // The half-size look flatters a wide canvas, and the reviewer judges the
    // phone picture: what is plainly unreadable in place is still fixed.
    expect(diagrammer).toContain("If a main label is plainly unreadable there all the same, fix it.");
    expect(diagrammer).toContain("an exact replacement of the lines it touches in the file as it stands, never a rewrite of the file");
    expect(diagrammer).toContain("Leave a brief or a list of sources alone unless the picture needs a fact from it");
    // Rehearsed: the run re-checked the piece's own facts in seven sources,
    // looked at the piece eight times, and left the pictures' field for the
    // writer, which would have cost a writer's run. CANARY: drop any of the
    // three sentences.
    expect(diagrammer).toContain("**What the piece states, draw as it states it.**");
    expect(diagrammer).toContain("the field that lists its pictures is yours to bring up to date");
    const cover = said(dataRoot, "cover-designer-expertise");
    expect(cover).toContain("**It shows something from the piece.**");
    expect(cover).toContain("would this cover fit another piece on the same topic? Then it is wallpaper.");
    // Live on BLOG-5, the first post through both stages: each agent hashed
    // the task's files, kept copies to diff against, rendered its drawing
    // again to show the kept picture still matched and pictured the notes
    // file as a page, and a one-entry fix to a field took eight minutes, five
    // captures and a kept source of its own check. A second reader then found
    // what a literal follower could still do (`cmp`, a count of bytes, a
    // picture of the brief) and what the first wording would have stopped (a
    // finding, a look after a picture moved). CANARY: drop any sentence.
    for (const manual of [diagrammer, cover]) {
      expect(manual).toContain("## What you do not prove");
      expect(manual).toMatch(/Your (picture|cover) is what the reviewer judges: you looked at it, and the reviewer opens it and looks again\./);
      expect(manual).toContain("Prove nothing about a file you did not change: no checksum, no copy kept to compare it with, no diff or `cmp`, no count of lines or bytes before and after.");
      expect(manual).toMatch(/A render is for looking: make one for the looks above, or after you change the (drawing|page)\./);
      expect(manual).toMatch(/Picture only your (drawing|page) and the piece\. Every other file on the task \(the writer's note, a file of fields, a brief, a list of sources\) is text: read it, and do not `capture_page` it\./);
      expect(manual).toContain("Write up no check of your own work and keep none as a source. Report every finding all the same");
      expect(manual).toMatch(/A rework that changes (no picture and moves none|nothing on the cover and does not move it) \(an alt text, a field's entry\) needs no render and no look/);
      expect(manual).toMatch(/Finish the (drawing|page) before you keep the (picture|cover)/);
      expect(manual).toMatch(/after that you edit it only to fix a fault you have seen, and then you keep a new (picture|cover) over the old one/);
      expect(manual).toContain("an exact replacement of the lines it touches in the file as it stands, never a rewrite of the file");
      expect(manual).toMatch(/On a rework that changed (no picture|nothing on the cover), only the last two apply\./);
    }
    expect(diagrammer).toContain("One that moves a picture gets one look at the piece at the phone width.");
    expect(diagrammer).toContain("Look again only when the picture changed or moved. Where the piece is not a file `capture_page` takes, say so in your report.");
    expect(diagrammer).toContain("into the field as it stands, leaving every other entry as it is");
    expect(cover).toContain("look at the piece at the phone width after you place it (`view` chooses the width), and again only when the cover changed or moved");
    expect(cover).toContain("Where it does not take the piece, say so in your report.");
    expect(cover).toContain("is yours to fill, whatever stands there now");
    // The same post went back to its writer before review, 36 minutes and
    // $15, for lines of the writer's own note the two pictures had made
    // untrue: `wc -w` of the whole file, "the post has no images", "you
    // supply the cover". CANARY: drop any sentence.
    const writerOnPictures = said(dataRoot, "writer-expertise");
    expect(writerOnPictures).toContain("write nothing in your note that they will make untrue: not a count of the whole file, not a line number of the piece, not that the piece has no pictures, not that the cover is the person's to supply");
    expect(writerOnPictures).toContain("Say once that the board's drawing agent adds the diagrams and the cover afterwards.");
    expect(writerOnPictures).toContain("Give the length as the words of the piece's text alone, without fields, picture lines or alt texts, and say that is what you counted.");
    expect(writerOnPictures).toContain("list your own screenshots and photographs in its pictures field as usual, and leave the entries for the diagrams and the cover to the agent that makes them");
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
    // Rehearsed: half of a first cover's 17 minutes went on the pages and
    // stylesheets around their covers. CANARY: drop the sentence.
    expect(cover).toContain("Open a page only to find their covers, and keep the covers, not the pages or stylesheets around them");
    // One place that would not open must not become the series look in
    // silence. CANARY: drop the sentence.
    expect(cover).toContain("Name in your report any place you could not open");
    expect(cover).toContain("Another publication's covers are that publication's look, not the person's");
    expect(cover).toContain("the field that names its cover is yours to fill");
    // The list of the piece's pictures holds other makers' entries too.
    expect(cover).toContain("add the cover and leave every other entry as it is");
    expect(cover).toContain("the same call with `scale` 0.25 is the cover as a feed shows it");
    for (const manual of [diagrammer, cover]) {
      // A supporting agent's save of the piece is what puts its picture under
      // review (ruling 85), so both manuals say the save is theirs to make
      // and that nothing else in the piece is.
      expect(manual).toContain("That save makes the assembled piece the delivery a reviewer judges.");
      expect(manual).toContain("Copy the picture `capture_page` saved for your run");
      expect(manual).toContain("a face it lacks is replaced without a word");
      expect(manual).toContain("Change nothing else in the piece");
      // The picture that is kept is the scale 2 one, and a rework that only
      // replaces it still reaches review (ruling 81's delivery rule).
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
    expect(guide).toContain("add the shipped Diagrammer and Cover Designer** (ruling 268)");
    expect(guide).toContain("each deployed at the stage where its step happens");
    // Two at once would each save the piece, and the writer has to be told
    // the drawing is not its to do. CANARY: drop either clause.
    expect(guide).toContain("to run the two one after the other, the diagrams first");
    expect(guide).toContain("so its writer draws none");
    // Live: the first board's controller gave both the writer's `max`, and a
    // six-box diagram took seventeen minutes, eight of them before a first
    // draft. At `high`, on the next post, it took two. CANARY: drop the
    // sentence and the next board's controller chooses by analogy again.
    expect(guide).toContain("Deploy both at `high` effort, whatever the writer runs at");
    expect(guide).toContain("a picture took 17 and 20 minutes at `max` and a little over two at `high`");
    expect(guide).toContain("sent one label back at `high`, which its maker fixed in under a minute");
    // A store whose copy nobody edited takes the new text at its next boot.
    // CANARY: remove any of the three outgoing hashes.
    const outgoing: [string, string][] = [
      ["skills/writer-expertise/SKILL.md", "8c133fa610e494f0497b114cf71f64f08d91c9d08e6974634f1f4129fb64e870"],
      ["skills/editor-expertise/SKILL.md", "62e62eed5108c4228e92c228d082d9815cb79c450d64b8d79f07beab7e30538a"],
      ["skills/controller-guide/SKILL.md", "e51e4710c9719b8bae32484e443a0c8be92e5fe6298e03dd53bc78eb26abb208"],
      ["skills/controller-guide/SKILL.md", "56c5a3ff8a12958bdd1b0307b5eb3f9ad9b9d31fb273dba734dc7b915a6acf53"],
    ];
    for (const [rel, hash] of outgoing) expect(shippedCopyIsUnedited(rel, hash, {}), rel).toBe(true);
    // The two new manuals as they first shipped, hours before their pace
    // changed. CANARY: remove either hash.
    expect(shippedCopyIsUnedited("skills/diagrammer-expertise/SKILL.md", "e9fc50d6d8b5faec3d5cc42c1769c1294f754b1c646e8b4a7bbd2149f9041cb4", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/cover-designer-expertise/SKILL.md", "2d5812d25c1d2a95b4dbc865c37fba3eec8c743bf4b0923fdcb51bf88940f5e0", {})).toBe(true);
    // And as they stood for the first live post. CANARY: remove any hash.
    expect(shippedCopyIsUnedited("skills/writer-expertise/SKILL.md", "d6d81936257867a5e9989e6986262d8cbcc034a69b4f350c6f15eaaa21da6c11", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/diagrammer-expertise/SKILL.md", "dee86c6136a016eeaf393b461996152fd62ee49ac879b9ad61a7ece73dbb3564", {})).toBe(true);
    expect(shippedCopyIsUnedited("skills/cover-designer-expertise/SKILL.md", "943933d71103d9fc7665ba1ce87f887129cc87394d5171ecb09c81d857afbf78", {})).toBe(true);
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
   * Ruling 176 (owner, 2026-09-27): the operator is one agent, called Operator,
   * with no role. Its editor used to ask for a name and a role, and a save
   * stored both on the project's deployment with the template's scope line.
   */
  it("ruling 176: removes the operator's stored name, role and scope, and keeps an agent profile's", async () => {
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
