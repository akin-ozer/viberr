import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  GOAL_FRONTMATTER_KEYS,
  goalFrontmatterSchema,
  type GoalFrontmatter,
  type GoalTimelineEntry,
  type ParsedGoalFile,
} from "~/schemas/goal-file.schema";
import { AppError } from "~/server/errors/app-error.server";
import { writeFileAtomic } from "./atomic-file.server";
import { withFileLock } from "./file-mutex.server";
import { goalFilePath, goalsDir } from "./file-store-root.server";
import {
  serializeFrontmatterFile,
  splitFrontmatter,
  yamlMappingSchema,
  type YamlMapping,
} from "./frontmatter.server";

/**
 * Reader/writer for the canonical chained-goal files (ruling 99):
 * `projects/<slug>/goals/<id>.md`. Same substrate as the task writer — one
 * in-process mutex per file, atomic tmp+rename writes — with a simpler body:
 * `## Description` prose and `## Timeline` history bullets (newest first,
 * `- <UTC ISO> · <text>`). Goal files are app-written; hand edits are
 * tolerated by the parser (unknown keys round-trip via the shared serializer
 * contract, malformed fields fall back per zod defaults).
 */

export interface GoalFileRef {
  projectSlug: string;
  goalId: string;
  dataRoot?: string;
}

const DESCRIPTION_HEAD = "## Description";
const TIMELINE_HEAD = "## Timeline";
const TIMELINE_LINE_RE = /^-\s+(\S+)\s+·\s+(.*)$/;

export function parseGoalFileContent(content: string): ParsedGoalFile | null {
  const { data, body } = splitFrontmatter(content);
  const mapping = yamlMappingSchema.safeParse(data);
  const parsed = goalFrontmatterSchema.safeParse(mapping.success ? mapping.data : {});
  if (!parsed.success) return null;

  let description = "";
  const timeline: GoalTimelineEntry[] = [];
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
  description = descriptionLines.join("\n").trim();
  return { frontmatter: parsed.data, description, timeline };
}

export function serializeGoalFile(parsed: ParsedGoalFile): string {
  const known: YamlMapping = {};
  for (const key of GOAL_FRONTMATTER_KEYS) known[key] = parsed.frontmatter[key];
  const timeline = parsed.timeline
    .map((entry) => `- ${entry.occurredAt} · ${flattenHistoryText(entry.text)}`)
    .join("\n");
  const body =
    `${DESCRIPTION_HEAD}\n\n${parsed.description.trim()}\n\n` +
    `${TIMELINE_HEAD}\n\n${timeline}`;
  return serializeFrontmatterFile(known, {}, body);
}

/** History bullets are ONE line each — flatten whatever prose arrives. */
function flattenHistoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface GoalFileRead {
  parsed: ParsedGoalFile;
  raw: string;
  path: string;
}

export function readGoalFile(ref: GoalFileRef): GoalFileRead | null {
  const abs = goalFilePath(ref.projectSlug, ref.goalId, ref.dataRoot);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, "utf8");
  const parsed = parseGoalFileContent(raw);
  if (!parsed) return null;
  return { parsed, raw, path: abs };
}

/** Every goal id in a project's goals/ dir (file basenames, sorted). */
export function listGoalIds(projectSlug: string, dataRoot?: string): string[] {
  const dir = goalsDir(projectSlug, dataRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".md") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -3))
    .sort((a, b) => goalNumber(a) - goalNumber(b) || a.localeCompare(b));
}

const GOAL_ID_RE = /^goal-(\d+)$/;
function goalNumber(id: string): number {
  const m = GOAL_ID_RE.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Mint the next `goal-<n>` id by directory scan, under the goals-dir lock so
 *  two concurrent creates cannot collide (goals are rare; a scan is enough —
 *  no counter field in project.md). */
export async function allocateGoalId(
  projectSlug: string,
  dataRoot?: string,
): Promise<string> {
  return withFileLock(`goals:${goalsDir(projectSlug, dataRoot)}`, () => {
    const max = listGoalIds(projectSlug, dataRoot).reduce((acc, id) => {
      const m = GOAL_ID_RE.exec(id);
      return m ? Math.max(acc, Number(m[1])) : acc;
    }, 0);
    return `goal-${max + 1}`;
  });
}

export async function createGoalFile(
  ref: GoalFileRef,
  input: { frontmatter: GoalFrontmatter; description: string },
): Promise<void> {
  const abs = goalFilePath(ref.projectSlug, ref.goalId, ref.dataRoot);
  await withFileLock(abs, () => {
    if (existsSync(abs)) {
      throw AppError.conflict(`Goal ${ref.goalId} already exists.`);
    }
    writeFileAtomic(
      abs,
      serializeGoalFile({
        frontmatter: input.frontmatter,
        description: input.description,
        timeline: [
          {
            occurredAt: new Date().toISOString(),
            text: `Goal created with ${input.frontmatter.links.length} link${input.frontmatter.links.length === 1 ? "" : "s"} by ${input.frontmatter.createdByLabel || input.frontmatter.createdBy}.`,
          },
        ],
      }),
    );
  });
}

/**
 * Locked read-modify-write. `mutate` edits the parsed file in place and may
 * return a history line to prepend; `updatedAt` is bumped on every write.
 */
export async function updateGoalFile(
  ref: GoalFileRef,
  mutate: (parsed: ParsedGoalFile) => string | void,
): Promise<ParsedGoalFile> {
  const abs = goalFilePath(ref.projectSlug, ref.goalId, ref.dataRoot);
  return withFileLock(abs, () => {
    if (!existsSync(abs)) {
      throw AppError.notFound(`Goal ${ref.goalId} not found.`);
    }
    const parsed = parseGoalFileContent(readFileSync(abs, "utf8"));
    if (!parsed) {
      throw AppError.conflict(
        `Goal ${ref.goalId} could not be parsed. Repair the file before changing it.`,
      );
    }
    const history = mutate(parsed);
    if (history) {
      parsed.timeline.unshift({
        occurredAt: new Date().toISOString(),
        text: history,
      });
    }
    parsed.frontmatter.updatedAt = new Date().toISOString();
    writeFileAtomic(abs, serializeGoalFile(parsed));
    return parsed;
  });
}
