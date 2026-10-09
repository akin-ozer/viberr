import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EPIC_COLORS,
  EPIC_FRONTMATTER_KEYS,
  defaultEpicColor,
  type EpicColor,
  type EpicFrontmatter,
  type ParsedEpicFile,
} from "~/schemas/epic-file.schema";
import { STAGE_COLORS } from "~/shared/workflow/stage-colors";
import {
  createEpicFile,
  diagnoseEpicFileContent,
  nextEpicId,
  parseEpicFileContent,
  readEpicFile,
  serializeEpicFile,
  updateEpicFile,
  withEpicsLock,
  type EpicFileRef,
} from "./epic-writer.server";
import { epicFilePath, epicsDir } from "./file-store-root.server";
import { createTempDirs } from "../../../test-support/temp-dirs";

/**
 * Ruling 17: the canonical epic file, `projects/<slug>/epics/epic-<n>.md`,
 * and its one writer. Frontmatter in `EPIC_FRONTMATTER_KEYS` order, then
 * `## Description` and the newest-first `## Timeline`; keys the schema does
 * not know round-trip; a file the schema rejects is named field by field; ids
 * are minted from a directory scan under the project's epics lock.
 */

const temp = createTempDirs();
afterAll(temp.cleanup);

const SLUG = "viberr-core";
const CREATED = "2026-09-01T09:00:00.000Z";
const EDITED = "2026-09-02T09:00:00.000Z";

function frontmatter(id: string, patch: Partial<EpicFrontmatter> = {}): EpicFrontmatter {
  // Keys deliberately NOT in EPIC_FRONTMATTER_KEYS order: the serializer owns
  // the order a file is written in, whatever order the object was built in.
  return {
    updatedAt: EDITED,
    createdAt: CREATED,
    convertedFrom: "goal-3",
    conversationId: "conv_epic_1",
    title: "Checkout redesign",
    id,
    createdByLabel: "creator@viberr.test",
    createdBy: "u_creator",
    targetDate: "2026-12-15",
    startDate: "2026-10-01",
    leadUserId: "u_lead",
    color: "teal",
    status: "in_progress",
    ...patch,
  };
}

/** A ref to one epic in a data root of its own. */
function freshRef(epicId: string): EpicFileRef {
  return { projectSlug: SLUG, epicId, dataRoot: temp.make("viberr-epic-writer-") };
}

function absPathOf(ref: EpicFileRef): string {
  return epicFilePath(ref.projectSlug, ref.epicId, ref.dataRoot);
}

/** Write a file by hand, as a person editing the store would. */
function handWrite(ref: EpicFileRef, lines: string[]): string {
  const abs = absPathOf(ref);
  mkdirSync(path.dirname(abs), { recursive: true });
  const content = lines.join("\n");
  writeFileSync(abs, content);
  return content;
}

/** The top-level frontmatter keys of a written file, in the order written. */
function writtenKeys(text: string): string[] {
  const close = text.indexOf("\n---\n");
  return text
    .slice("---\n".length, close)
    .split("\n")
    .filter((line) => !line.startsWith(" "))
    .map((line) => line.slice(0, line.indexOf(":")));
}

/** Everything after the closing frontmatter fence. */
function bodyOf(text: string): string {
  return text.slice(text.indexOf("\n---\n") + "\n---\n".length);
}

describe("ruling 17: an epic file round-trips through the writer", () => {
  it("writes the frontmatter in EPIC_FRONTMATTER_KEYS order, then ## Description and ## Timeline newest first, and reads back exactly what it wrote", () => {
    // CANARY: build the known mapping from `Object.keys(parsed.frontmatter)`
    // instead of EPIC_FRONTMATTER_KEYS in serializeEpicFile.
    const fm = frontmatter("epic-3");
    expect(Object.keys(fm), "the fixture must not already be in canonical order").not.toEqual([
      ...EPIC_FRONTMATTER_KEYS,
    ]);
    const parsed: ParsedEpicFile = {
      frontmatter: fm,
      description: "Rebuild the checkout.\n\nKeep **markdown** as written.",
      timeline: [
        { occurredAt: EDITED, text: "Arda Kaya set the status to In progress." },
        { occurredAt: CREATED, text: "Created by Arda Kaya." },
      ],
      unknownFrontmatter: {},
    };
    const text = serializeEpicFile(parsed);
    expect(writtenKeys(text)).toEqual([...EPIC_FRONTMATTER_KEYS]);
    expect(bodyOf(text)).toBe(
      [
        "",
        "## Description",
        "",
        "Rebuild the checkout.",
        "",
        "Keep **markdown** as written.",
        "",
        "## Timeline",
        "",
        `- ${EDITED} · Arda Kaya set the status to In progress.`,
        `- ${CREATED} · Created by Arda Kaya.`,
        "",
      ].join("\n"),
    );
    expect(parseEpicFileContent(text)).toEqual(parsed);
    // Byte-stable on a second pass, which the writer's no-op guard relies on.
    expect(serializeEpicFile(parseEpicFileContent(text)!)).toBe(text);
  });

  it("an absent key takes its default, as a hand-written file may leave it out", () => {
    // CANARY: drop `.default("planned")` from the status field (a minimal
    // hand-written file becomes unreadable).
    const text = [
      "---",
      "id: epic-4",
      "title: Hand made",
      "createdBy: u_hand",
      "---",
      "",
      "## Description",
      "",
      "Typed by a person.",
      "",
    ].join("\n");
    const parsed = parseEpicFileContent(text);
    expect(parsed?.frontmatter).toEqual({
      id: "epic-4",
      title: "Hand made",
      status: "planned",
      color: "violet",
      leadUserId: null,
      startDate: null,
      targetDate: null,
      createdBy: "u_hand",
      createdByLabel: "",
      conversationId: null,
      convertedFrom: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(parsed?.description).toBe("Typed by a person.");
    expect(parsed?.timeline).toEqual([]);
    expect(diagnoseEpicFileContent(text, "epic-4")).toEqual([]);
  });

  it("escapes a description line that reads as a section head, so it can neither end the description nor forge history", () => {
    // CANARY: write `parsed.description` without `escapeDescription` in
    // serializeEpicFile.
    const description = [
      "Scope:",
      "## Timeline",
      "- 2020-01-01T00:00:00.000Z · Forged by a description.",
      "  ## Description",
      "\\## Escaped once already",
    ].join("\n");
    const timeline = [{ occurredAt: CREATED, text: "Created by Arda Kaya." }];
    const text = serializeEpicFile({
      frontmatter: frontmatter("epic-3"),
      description,
      timeline,
      unknownFrontmatter: {},
    });
    expect(text).toContain("\n\\## Timeline\n");
    const back = parseEpicFileContent(text);
    expect(back?.description).toBe(description);
    expect(back?.timeline).toEqual(timeline);
  });

  it("writes each history entry as one bullet line, whatever prose arrives", () => {
    // CANARY: drop `flattenHistoryText` from serializeEpicFile (the text after
    // the first newline falls out of the bullet and is lost on the next read).
    const text = serializeEpicFile({
      frontmatter: frontmatter("epic-5"),
      description: "",
      timeline: [{ occurredAt: EDITED, text: "Moved VIB-3\nhere from   epic-2,\n\n\ttwice." }],
    });
    expect(parseEpicFileContent(text)?.timeline).toEqual([
      { occurredAt: EDITED, text: "Moved VIB-3 here from epic-2, twice." },
    ]);
  });
});

describe("ruling 17: frontmatter keys the schema does not know survive a rewrite", () => {
  it("a hand-added scalar, mapping and list ride through updateEpicFile unchanged, after the known keys", async () => {
    // CANARY: pass `{}` instead of `parsed.unknownFrontmatter` to
    // serializeFrontmatterFile in serializeEpicFile.
    const ref = freshRef("epic-6");
    handWrite(ref, [
      "---",
      "jiraKey: WEB-12",
      "id: epic-6",
      "title: Imported",
      "external:",
      "  tracker: linear",
      "  id: PRJ-4",
      "createdBy: u_hand",
      "tags:",
      "  - billing",
      "  - q4",
      "---",
      "",
      "## Description",
      "",
      "Carried over.",
      "",
      "## Timeline",
      "",
      `- ${CREATED} · Imported by hand.`,
      "",
    ]);
    const unknown = {
      jiraKey: "WEB-12",
      external: { tracker: "linear", id: "PRJ-4" },
      tags: ["billing", "q4"],
    };
    expect(readEpicFile(ref)?.parsed.unknownFrontmatter).toEqual(unknown);

    await updateEpicFile(ref, (epic) => {
      epic.frontmatter.title = "Imported and renamed";
      return "Renamed it.";
    });

    const text = readFileSync(absPathOf(ref), "utf8");
    const after = parseEpicFileContent(text);
    expect(after?.unknownFrontmatter).toEqual(unknown);
    expect(after?.frontmatter.title).toBe("Imported and renamed");
    expect(after?.description).toBe("Carried over.");
    expect(writtenKeys(text)).toEqual([...EPIC_FRONTMATTER_KEYS, "jiraKey", "external", "tags"]);
  });
});

describe("ruling 17: diagnoseEpicFileContent names what is wrong with a broken file", () => {
  const clean = serializeEpicFile({
    frontmatter: frontmatter("epic-3"),
    description: "Fine.",
    timeline: [{ occurredAt: CREATED, text: "Created by Arda Kaya." }],
  });

  it("a clean file has no findings, with or without the name it is filed under", () => {
    // CANARY: compare the frontmatter id against the file's name when no name
    // was given (`fileId !== undefined` dropped).
    expect(diagnoseEpicFileContent(clean)).toEqual([]);
    expect(diagnoseEpicFileContent(clean, "epic-3")).toEqual([]);
  });

  it("names every field the schema rejects, each a hard stop, and such a file does not parse", () => {
    // CANARY: report one generic "invalid frontmatter" finding instead of one
    // per zod issue in diagnoseEpicFileContent.
    const broken = [
      "---",
      "id: epic-7",
      "title: ''",
      "status: finished",
      "color: chartreuse",
      "startDate: 26/09/2026",
      "convertedFrom: chain-3",
      "---",
      "",
    ].join("\n");
    const findings = diagnoseEpicFileContent(broken, "epic-7");
    expect(findings.map((f) => f.path)).toEqual([
      "title",
      "status",
      "color",
      "startDate",
      "createdBy",
      "convertedFrom",
    ]);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        severity: "error",
        code: "frontmatter.invalid_field",
        hardStop: true,
      });
      expect(finding.message.startsWith(`${finding.path}: `)).toBe(true);
    }
    expect(parseEpicFileContent(broken)).toBeNull();
    const ref = freshRef("epic-7");
    handWrite(ref, [broken]);
    expect(readEpicFile(ref)).toBeNull();
  });

  it("names a file whose frontmatter id is not the id its name gives it", () => {
    // CANARY: drop the `parsed.data.id !== fileId` branch of
    // diagnoseEpicFileContent.
    expect(diagnoseEpicFileContent(clean, "epic-2")).toEqual([
      {
        severity: "error",
        code: "frontmatter.invalid_field",
        path: "id",
        message: "id: the file is named epic-2 but says it is epic-3.",
        hardStop: true,
      },
    ]);
    const misnamed = clean.replace("id: epic-3", "id: epic-three");
    expect(diagnoseEpicFileContent(misnamed).map((f) => f.path)).toEqual(["id"]);
  });

  it("says so when there is no frontmatter mapping to read at all", () => {
    // CANARY: return only the schema's findings, dropping the split's own
    // diagnostics (`[...diagnostics]`) in diagnoseEpicFileContent.
    const noFence = diagnoseEpicFileContent("## Description\n\nJust prose.\n");
    expect(noFence.map((f) => f.code)).toEqual([
      "frontmatter.missing",
      "frontmatter.invalid_field",
      "frontmatter.invalid_field",
      "frontmatter.invalid_field",
    ]);
    expect(noFence.slice(1).map((f) => f.path)).toEqual(["id", "title", "createdBy"]);

    const sequence = diagnoseEpicFileContent("---\n- one\n- two\n---\n");
    expect(sequence.map((f) => f.code)).toEqual(["frontmatter.not_a_map"]);

    const unparseable = diagnoseEpicFileContent("---\nid: [epic-3\n---\n");
    expect(unparseable[0]?.code).toBe("frontmatter.invalid_yaml");

    for (const finding of [...noFence, ...sequence, ...unparseable]) {
      expect(finding.hardStop).toBe(true);
    }
  });
});

describe("ruling 17: nextEpicId mints the next id from a directory scan", () => {
  it("mints epic-1 in a project with no epics yet", () => {
    // CANARY: start the scan's reduce from 1 instead of 0 in nextEpicId.
    const dataRoot = temp.make("viberr-epic-mint-");
    expect(nextEpicId(SLUG, dataRoot)).toBe("epic-1");
    mkdirSync(epicsDir(SLUG, dataRoot), { recursive: true });
    expect(nextEpicId(SLUG, dataRoot)).toBe("epic-1");
  });

  it("mints the numeric max plus one, and ignores every file that is not epic-N.md", () => {
    // CANARY: compare the ids as strings in nextEpicId ("epic-9" is the
    // lexicographic max, which mints epic-10 over an existing file).
    const dataRoot = temp.make("viberr-epic-mint-");
    const dir = epicsDir(SLUG, dataRoot);
    mkdirSync(dir, { recursive: true });
    for (const name of [
      "epic-2.md",
      "epic-9.md",
      "epic-10.md",
      // None of these is an epic, and each would mint a larger id if counted.
      "Epic-50.md",
      ".epic-40.md",
      "epic-7a.md",
      "draft-epic-45.md",
      "epic-30.md.bak",
      "epic-31.txt",
      "epic-35.md.1a2b3c4d.tmp",
      "notes.md",
    ]) {
      writeFileSync(path.join(dir, name), "x");
    }
    expect(nextEpicId(SLUG, dataRoot)).toBe("epic-11");
  });
});

describe("ruling 17: updateEpicFile, the locked read-modify-write", () => {
  it("a mutator returning a line puts it on top of the history and bumps updatedAt", async () => {
    // CANARY: `push` the returned line instead of `unshift` in updateEpicFile
    // (the history stops being newest first).
    const ref = freshRef("epic-1");
    await createEpicFile(ref, { frontmatter: frontmatter("epic-1"), description: "d" });
    const startedAt = Date.now();
    await updateEpicFile(ref, () => "Arda Kaya added VIB-3.");
    const returned = await updateEpicFile(ref, () => "Arda Kaya added VIB-4.");

    const onDisk = readEpicFile(ref)!.parsed;
    expect(onDisk.timeline.map((e) => e.text)).toEqual([
      "Arda Kaya added VIB-4.",
      "Arda Kaya added VIB-3.",
      // createEpicFile's own opening line, from the creator's label.
      "Created by creator@viberr.test.",
    ]);
    expect(Date.parse(onDisk.timeline[0]!.occurredAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(onDisk.frontmatter.updatedAt!)).toBeGreaterThanOrEqual(startedAt);
    expect(onDisk.frontmatter.createdAt).toBe(CREATED);
    // What it returns is what landed.
    expect(returned).toEqual(onDisk);
  });

  it("a mutator returning nothing writes no history line, and one that changes nothing writes nothing at all", async () => {
    // CANARY: drop the `serializeEpicFile(parsed) === raw` early return in
    // updateEpicFile (every no-op edit rewrites the file with a new updatedAt).
    const ref = freshRef("epic-2");
    await createEpicFile(ref, { frontmatter: frontmatter("epic-2"), description: "d" });
    const abs = absPathOf(ref);
    const created = readFileSync(abs, "utf8");
    const history = readEpicFile(ref)!.parsed.timeline;

    const same = await updateEpicFile(ref, () => undefined);
    expect(readFileSync(abs, "utf8")).toBe(created);
    expect(same.frontmatter.updatedAt).toBe(EDITED);
    // Setting a field to the value it already has is no change either.
    await updateEpicFile(ref, (epic) => {
      epic.frontmatter.status = "in_progress";
    });
    expect(readFileSync(abs, "utf8")).toBe(created);

    await updateEpicFile(ref, (epic) => {
      epic.frontmatter.status = "paused";
    });
    const after = readEpicFile(ref)!.parsed;
    expect(after.frontmatter.status).toBe("paused");
    expect(after.frontmatter.updatedAt).not.toBe(EDITED);
    expect(after.timeline).toEqual(history);
  });

  it("refuses a missing epic, and an unparseable one without touching it", async () => {
    // CANARY: let updateEpicFile fall back to defaults for a file
    // parseEpicFileContent rejects (it would overwrite the person's edit).
    const ref = freshRef("epic-8");
    await expect(updateEpicFile(ref, () => "Never written.")).rejects.toMatchObject({
      status: 404,
      userMessage: "Epic epic-8 not found.",
    });
    const broken = handWrite(ref, ["---", "id: epic-8", "title: Broken", "status: finished", "createdBy: u_hand", "---", ""]);
    await expect(updateEpicFile(ref, () => "Never written.")).rejects.toMatchObject({
      status: 409,
      userMessage: "Epic epic-8 could not be parsed. Repair the file before changing it.",
    });
    expect(readFileSync(absPathOf(ref), "utf8")).toBe(broken);
  });
});

describe("ruling 17: ids are minted under the project's epics lock", () => {
  it("two concurrent creates under withEpicsLock get distinct ids", async () => {
    // CANARY: make withEpicsLock call `fn` without taking the lock (both scans
    // read an empty directory and mint epic-1).
    const dataRoot = temp.make("viberr-epic-lock-");
    const create = (title: string) =>
      withEpicsLock(SLUG, dataRoot, async () => {
        const id = nextEpicId(SLUG, dataRoot);
        // Yield between the scan and the write: the window the lock closes.
        await new Promise((resolve) => setImmediate(resolve));
        await createEpicFile(
          { projectSlug: SLUG, epicId: id, dataRoot },
          { frontmatter: frontmatter(id, { title }), description: "" },
        );
        return id;
      });
    const ids = await Promise.all([create("First"), create("Second")]);
    expect(ids).toEqual(["epic-1", "epic-2"]);
    const titleOf = (epicId: string) =>
      readEpicFile({ projectSlug: SLUG, epicId, dataRoot })?.parsed.frontmatter.title;
    expect(titleOf("epic-1")).toBe("First");
    expect(titleOf("epic-2")).toBe("Second");
  });

  it("createEpicFile never overwrites an epic that already exists", async () => {
    // CANARY: drop the `existsSync(abs)` refusal from createEpicFile.
    const ref = freshRef("epic-1");
    await createEpicFile(ref, { frontmatter: frontmatter("epic-1", { title: "Original" }), description: "" });
    await expect(
      createEpicFile(ref, { frontmatter: frontmatter("epic-1", { title: "Impostor" }), description: "" }),
    ).rejects.toMatchObject({ status: 409, userMessage: "Epic epic-1 already exists." });
    expect(readEpicFile(ref)?.parsed.frontmatter.title).toBe("Original");
  });
});

describe("ruling 17: defaultEpicColor", () => {
  it("gives consecutive ids far-apart hues: never the same, never neighbours on the wheel, never a neutral", () => {
    // CANARY: put two neighbouring hues next to each other in
    // EPIC_COLOR_SEQUENCE (blue then sky), or add a neutral (slate) to it.
    // STAGE_COLORS lists the chromatic presets in hue order, red round to rose,
    // after the three neutrals.
    const neutrals = new Set<EpicColor>(["slate", "gray", "stone"]);
    const wheel = STAGE_COLORS.filter((color) => !neutrals.has(color));
    const apart = (a: EpicColor, b: EpicColor) => {
      const steps = Math.abs(wheel.indexOf(a) - wheel.indexOf(b));
      return Math.min(steps, wheel.length - steps);
    };
    const colours = Array.from({ length: 40 }, (_, i) => defaultEpicColor(`epic-${i + 1}`));
    for (const colour of colours) {
      expect(EPIC_COLORS).toContain(colour);
      expect(neutrals.has(colour), `${colour} is a neutral, not a hue`).toBe(false);
    }
    for (let n = 1; n < colours.length; n += 1) {
      expect(
        apart(colours[n - 1]!, colours[n]!),
        `epic-${n} (${colours[n - 1]}) and epic-${n + 1} (${colours[n]})`,
      ).toBeGreaterThanOrEqual(2);
    }
    // The colour follows the epic's number, not the order of the calls.
    expect(defaultEpicColor("epic-7")).toBe(colours[6]);
  });
});
