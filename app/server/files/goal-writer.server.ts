import { existsSync, readFileSync, readdirSync } from "node:fs";
import { freshestContent, rememberWrite } from "./write-cache.server";
import { diagError, type FileDiagnostic } from "~/schemas/file-diagnostics";
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

/**
 * The description is human/model prose that sits ABOVE the timeline in the
 * same file, so a `## Timeline` line inside it closes the description early
 * and turns whatever follows into forged history bullets. The timeline itself
 * is single-writer app narration and needs no escaping; the description does.
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

export function parseGoalFileContent(content: string): ParsedGoalFile | null {
  const { data, body } = splitFrontmatter(content);
  const mapping = yamlMappingSchema.safeParse(data);
  const rawMapping: YamlMapping = mapping.success ? mapping.data : {};
  const parsed = goalFrontmatterSchema.safeParse(rawMapping);
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
  description = unescapeDescription(descriptionLines.join("\n")).trim();
  // Preserve any frontmatter keys the schema does not know, so a hand-added or
  // future/foreign field survives the next write (file-formats §2) instead of
  // being dropped on the first reconcile tick that rewrites the file.
  const knownKeys = new Set<string>(GOAL_FRONTMATTER_KEYS);
  const unknownFrontmatter: YamlMapping = {};
  for (const [k, v] of Object.entries(rawMapping)) {
    if (!knownKeys.has(k)) unknownFrontmatter[k] = v;
  }
  return { frontmatter: parsed.data, description, timeline, unknownFrontmatter };
}

/**
 * Why a goal file could not be read, for the store doctor.
 *
 * {@link parseGoalFileContent} answers null — enough for a caller that just
 * needs to skip the file, useless to a human holding a rescan summary that
 * says `errors: 1`. Goal files are canonical (file-formats §2b), so the doctor
 * must NAME the file and the reason exactly as it does for task.md and
 * project.md. Unlike those two there is no tolerant field recovery here: a
 * goal whose frontmatter the schema rejects has no partially usable form, so
 * every finding is a hardStop.
 */
export function diagnoseGoalFileContent(content: string): FileDiagnostic[] {
  const { data, diagnostics } = splitFrontmatter(content);
  const found = [...diagnostics];
  const mapping = yamlMappingSchema.safeParse(data);
  if (!mapping.success) {
    found.push(
      diagError(
        "frontmatter.not_a_map",
        "Frontmatter is not a YAML mapping, so the goal cannot be read at all.",
        undefined,
        true,
      ),
    );
    return found;
  }
  const parsed = goalFrontmatterSchema.safeParse(mapping.data);
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
  }
  return found;
}

export function serializeGoalFile(parsed: ParsedGoalFile): string {
  const known: YamlMapping = {};
  for (const key of GOAL_FRONTMATTER_KEYS) known[key] = parsed.frontmatter[key];
  const timeline = parsed.timeline
    .map((entry) => `- ${entry.occurredAt} · ${flattenHistoryText(entry.text)}`)
    .join("\n");
  const body =
    `${DESCRIPTION_HEAD}\n\n${escapeDescription(parsed.description.trim())}\n\n` +
    `${TIMELINE_HEAD}\n\n${timeline}`;
  // Re-emit unknown frontmatter keys (file-formats §2 round-trip contract); the
  // frontmatter serializer keeps the known keys' canonical order and appends the
  // rest, so a foreign/future field is never dropped by a write.
  return serializeFrontmatterFile(known, parsed.unknownFrontmatter ?? {}, body);
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

/** The next free `goal-<n>` for a project, by directory scan (goals are rare;
 *  a scan is enough — there is no counter field in project.md).
 *
 *  UNLOCKED on purpose: an id is only reserved once the file bearing it
 *  exists, and creation does real work in between. Call it inside
 *  {@link withGoalsLock}, which the one caller holds across that whole
 *  sequence — a lock released at mint time would hand the same id to two
 *  concurrent creates. */
export function nextGoalId(projectSlug: string, dataRoot?: string): string {
  const max = listGoalIds(projectSlug, dataRoot).reduce((acc, id) => {
    const m = GOAL_ID_RE.exec(id);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `goal-${max + 1}`;
}

/** Serialize everything that mints a goal id for one project, from the scan
 *  through the write that makes the id real. */
export async function withGoalsLock<T>(
  projectSlug: string,
  dataRoot: string | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  return withFileLock(`goals:${goalsDir(projectSlug, dataRoot)}`, fn);
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
 * return a history line to prepend; `updatedAt` is bumped whenever the file
 * actually changes.
 *
 * A mutation that changes NOTHING writes nothing. The advance engine is
 * convergent, so it calls this on every hook and on every 60s runner tick for
 * every live goal; bumping `updatedAt` unconditionally would rewrite each of
 * those files a minute forever, re-project them (the content hash moved), and
 * fan a `goal.updated` event out to every client with the project open — churn
 * that also makes the displayed "updated" time meaningless.
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
    // C01-A2 (pass 32): the same VirtioFS read-your-own-writes repair the task
    // and project writers carry — two back-to-back link-status writes on a
    // cached bind mount could lose the first one (pass-31 gotcha 10).
    const raw = freshestContent(abs, readFileSync(abs, "utf8"), {
      kind: "goal-file",
      id: ref.goalId,
    });
    const parsed = parseGoalFileContent(raw);
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
    // Serialized with the OLD `updatedAt` still in place, so this compares the
    // substance of the file and not the timestamp we are about to set.
    if (serializeGoalFile(parsed) === raw) return parsed;
    parsed.frontmatter.updatedAt = new Date().toISOString();
    const serialized = serializeGoalFile(parsed);
    writeFileAtomic(abs, serialized);
    rememberWrite(abs, serialized);
    return parsed;
  });
}
