import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freshestContent, writeAndRemember } from "./write-cache.server";
import { diagError, type FileDiagnostic } from "~/schemas/file-diagnostics";
import {
  EPIC_FRONTMATTER_KEYS,
  EPIC_ID_RE,
  epicFrontmatterSchema,
  type EpicFrontmatter,
  type EpicTimelineEntry,
  type ParsedEpicFile,
} from "~/schemas/epic-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { withFileLock } from "./file-mutex.server";
import { epicFilePath, epicsDir } from "./file-store-root.server";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
  yamlMappingSchema,
  type YamlMapping,
} from "./frontmatter.server";

/**
 * Reader/writer for the canonical epic files (ruling 503):
 * `projects/<slug>/epics/<id>.md`. Same substrate as the task writer, one
 * in-process mutex per file and atomic tmp+rename writes, with the body the
 * goal files it replaced carried: `## Description` prose and `## Timeline`
 * history bullets (newest first, `- <UTC ISO> · <text>`). Epic files are
 * app-written; hand edits are tolerated by the parser (unknown keys round-trip
 * through the shared serializer, an absent field takes its default).
 */

export interface EpicFileRef {
  projectSlug: string;
  epicId: string;
  dataRoot?: string;
}

const DESCRIPTION_HEAD = "## Description";
const TIMELINE_HEAD = "## Timeline";
const TIMELINE_LINE_RE = /^-\s+(\S+)\s+·\s+(.*)$/;

/**
 * The description is human or model prose that sits ABOVE the timeline in the
 * same file, so a `## Timeline` line inside it would close the description
 * early and turn whatever follows into forged history bullets. The timeline
 * itself is single-writer app narration and needs no escaping; the description
 * does.
 *
 * Same backslash convention as task.md (file-formats §2): the serializer adds
 * one to any line that reads as a section fence, the parser strips exactly
 * one, so round-trips are byte-exact for every input.
 */
const NEEDS_HEAD_ESCAPE_RE = /^\\*\s*## /;
const ESCAPED_HEAD_RE = /^\\+\s*## /;

function escapeDescription(text: string): string {
  return text
    .split("\n")
    .map((line) => (NEEDS_HEAD_ESCAPE_RE.test(line) ? `\\${line}` : line))
    .join("\n");
}

function unescapeDescription(text: string): string {
  return text
    .split("\n")
    .map((line) => (ESCAPED_HEAD_RE.test(line) ? line.slice(1) : line))
    .join("\n");
}

/** What an epic file's body holds: its description and its history. */
export interface EpicFileBody {
  description: string;
  timeline: EpicTimelineEntry[];
}

/**
 * The body grammar epic files share with the chained-goal files they replaced
 * (`## Description`, then `## Timeline` bullets). Exported for the one reader
 * of those older files, the goal-to-epic conversion.
 */
export function parseDescriptionAndTimeline(body: string): EpicFileBody {
  const timeline: EpicTimelineEntry[] = [];
  let section: "none" | "description" | "timeline" = "none";
  const descriptionLines: string[] = [];
  for (const line of body.split("\n")) {
    const head = line.trim();
    if (head === DESCRIPTION_HEAD) {
      section = "description";
      continue;
    }
    if (head === TIMELINE_HEAD) {
      section = "timeline";
      continue;
    }
    if (section === "description") {
      descriptionLines.push(line);
    } else if (section === "timeline") {
      const entry = TIMELINE_LINE_RE.exec(head);
      if (entry) timeline.push({ occurredAt: entry[1]!, text: entry[2]! });
    }
  }
  return { description: unescapeDescription(descriptionLines.join("\n")).trim(), timeline };
}

export function parseEpicFileContent(content: string): ParsedEpicFile | null {
  const { data, body } = splitFrontmatter(content);
  const mapping = yamlMappingSchema.safeParse(data);
  const rawMapping: YamlMapping = mapping.success ? mapping.data : {};
  const parsed = epicFrontmatterSchema.safeParse(rawMapping);
  if (!parsed.success) return null;
  const { description, timeline } = parseDescriptionAndTimeline(body);
  // Keep any frontmatter key the schema does not know, so a hand-added or
  // future field survives the next write (file-formats §2).
  const knownKeys = new Set<string>(EPIC_FRONTMATTER_KEYS);
  const unknownFrontmatter: YamlMapping = {};
  for (const [k, v] of Object.entries(rawMapping)) {
    if (!knownKeys.has(k)) unknownFrontmatter[k] = v;
  }
  return { frontmatter: parsed.data, description, timeline, unknownFrontmatter };
}

/**
 * Why an epic file could not be read, for the store doctor and the rebuilder.
 * Epic files are canonical, so the doctor names the file and the reason
 * exactly as it does for task.md and project.md. A frontmatter the schema
 * rejects has no partially usable form, so every finding is a hard stop.
 *
 * `fileId` is the id the file's NAME gives it: a file whose frontmatter says
 * another id would project under one and be looked up under the other, so it
 * is as unreadable as a broken one, and says why.
 */
export function diagnoseEpicFileContent(content: string, fileId?: string): FileDiagnostic[] {
  const { data, diagnostics } = splitFrontmatter(content);
  const found = [...diagnostics];
  const mapping = yamlMappingSchema.safeParse(data);
  if (!mapping.success) {
    found.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping, so the epic cannot be read at all.",
        undefined,
        true,
      ),
    );
    return found;
  }
  const parsed = epicFrontmatterSchema.safeParse(mapping.data);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join(".");
      found.push(
        diagError(
          "frontmatter.invalid_field",
          `${at || "frontmatter"}: ${issue.message}`,
          at || undefined,
          true,
        ),
      );
    }
  } else if (fileId !== undefined && parsed.data.id !== fileId) {
    found.push(
      diagError(
        "frontmatter.invalid_field",
        `id: the file is named ${fileId} but says it is ${parsed.data.id}.`,
        "id",
        true,
      ),
    );
  }
  return found;
}

export function serializeEpicFile(parsed: ParsedEpicFile): string {
  const known: YamlMapping = {};
  for (const key of EPIC_FRONTMATTER_KEYS) known[key] = parsed.frontmatter[key];
  const timeline = parsed.timeline
    .map((entry) => `- ${entry.occurredAt} · ${flattenHistoryText(entry.text)}`)
    .join("\n");
  const body =
    `${DESCRIPTION_HEAD}\n\n${escapeDescription(parsed.description.trim())}\n\n` +
    `${TIMELINE_HEAD}\n\n${timeline}`;
  return serializeFrontmatterFile(known, parsed.unknownFrontmatter ?? {}, body);
}

/** History bullets are ONE line each: flatten whatever prose arrives. */
function flattenHistoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface EpicFileRead {
  parsed: ParsedEpicFile;
}

export function readEpicFile(ref: EpicFileRef): EpicFileRead | null {
  const abs = epicFilePath(ref.projectSlug, ref.epicId, ref.dataRoot);
  if (!existsSync(abs)) return null;
  const parsed = parseEpicFileContent(readFileSync(abs, "utf8"));
  return parsed ? { parsed } : null;
}

/** Every epic id in a project's epics/ dir (file basenames, by number). */
export function listEpicIds(projectSlug: string, dataRoot?: string): string[] {
  const dir = epicsDir(projectSlug, dataRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -3))
    .sort((a, b) => epicOrder(a) - epicOrder(b) || a.localeCompare(b));
}

function epicOrder(id: string): number {
  const m = EPIC_ID_RE.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The next free `epic-<n>` for a project, by directory scan (there is no
 * counter field in project.md).
 *
 * UNLOCKED on purpose: an id is only reserved once the file bearing it exists.
 * Call it inside {@link withEpicsLock}, which the caller holds from the scan
 * through the write; a lock released at mint time would hand the same id to
 * two concurrent creates.
 */
export function nextEpicId(projectSlug: string, dataRoot?: string): string {
  const max = listEpicIds(projectSlug, dataRoot).reduce((acc, id) => {
    const m = EPIC_ID_RE.exec(id);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `epic-${max + 1}`;
}

/** Serialize everything that mints an epic id for one project, from the scan
 *  through the write that makes the id real. */
export async function withEpicsLock<T>(
  projectSlug: string,
  dataRoot: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withFileLock(`epics:${epicsDir(projectSlug, dataRoot)}`, fn);
}

export async function createEpicFile(
  ref: EpicFileRef,
  input: {
    frontmatter: EpicFrontmatter;
    description: string;
    /** The history the file opens with, newest first. Defaults to one line
     *  naming who created it. */
    timeline?: EpicTimelineEntry[];
  },
): Promise<void> {
  const abs = epicFilePath(ref.projectSlug, ref.epicId, ref.dataRoot);
  await withFileLock(abs, () => {
    if (existsSync(abs)) {
      throw AppError.conflict(`Epic ${ref.epicId} already exists.`);
    }
    const serialized = serializeEpicFile({
      frontmatter: input.frontmatter,
      description: input.description,
      timeline: input.timeline ?? [
        {
          occurredAt: input.frontmatter.createdAt ?? new Date().toISOString(),
          text: `Created by ${input.frontmatter.createdByLabel || input.frontmatter.createdBy}.`,
        },
      ],
    });
    writeAndRemember(abs, serialized);
  });
}

/**
 * Locked read-modify-write. `mutate` edits the parsed file in place and may
 * return a history line to prepend; `updatedAt` is bumped whenever the file
 * actually changes. A mutation that changes NOTHING writes nothing, so a
 * repeated edit neither rewrites the file nor fans an `epic.updated` out.
 */
export async function updateEpicFile(
  ref: EpicFileRef,
  mutate: (parsed: ParsedEpicFile) => string | void,
): Promise<ParsedEpicFile> {
  const abs = epicFilePath(ref.projectSlug, ref.epicId, ref.dataRoot);
  return withFileLock(abs, () => {
    if (!existsSync(abs)) {
      throw AppError.notFound(`Epic ${ref.epicId} not found.`);
    }
    // The same VirtioFS read-your-own-writes repair the task and project
    // writers carry (C01-A2).
    const raw = freshestContent(abs, readFileSync(abs, "utf8"), {
      kind: "epic-file",
      id: ref.epicId,
    });
    const parsed = parseEpicFileContent(raw);
    if (!parsed) {
      throw AppError.conflict(
        `Epic ${ref.epicId} could not be parsed. Repair the file before changing it.`,
      );
    }
    const history = mutate(parsed);
    if (history) {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        text: history,
      });
    }
    // Serialized with the OLD `updatedAt` still in place, so this compares the
    // substance of the file and not the timestamp about to be set.
    if (serializeEpicFile(parsed) === raw) return parsed;
    parsed.frontmatter.updatedAt = new Date().toISOString();
    const serialized = serializeEpicFile(parsed);
    writeAndRemember(abs, serialized);
    return parsed;
  });
}
