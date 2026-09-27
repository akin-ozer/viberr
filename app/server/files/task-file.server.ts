import YAML from "yaml";
import { z } from "zod";
import {
  diagError,
  diagInfo,
  diagWarning,
  tolerantRowsOf,
  type FileDiagnostic,
} from "~/schemas/file-diagnostics";
import {
  EVIDENCE_EMPTY_COLUMN,
  EVIDENCE_STATUSES,
  packetObservationSchema,
  packetOptionSchema,
  parseTaskFrontmatter,
  taskPacketSchema,
  TIMELINE_EVENT_TYPES,
  type EvidenceRow,
  type ParsedTaskFile,
  type TaskFileEvent,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { decodeActorRef, encodeActorRef } from "./actor-ref.server";
import {
  serializeFrontmatterFile,
  splitFrontmatterMapping,
  toYaml,
} from "./frontmatter.server";

/**
 * task.md parse/serialize (canonical format — docs/architecture/file-formats.md).
 *
 * Layout:
 *   ---            YAML frontmatter (task-file.schema.ts, tolerant)
 *   ## Goal        prose
 *   ## Packet      one fenced ```yaml block — the active decision packet
 *                  (section absent when no packet is open)
 *   ## Timeline    typed event log, NEWEST FIRST; each event:
 *                    ### <UTC ISO> · <type> · <actor-ref>
 *                    title: …          (optional metadata, completion only)
 *                    to: agent         (optional metadata, comments only)
 *                    notified: <id, id> (optional — who this event's own
 *                                       notification reached; ruling 382)
 *                    <blank line>
 *                    <text — RichText micro-format>
 *                    evidence:            (optional, outcome events — P13-D-26:
 *                    - [<status>] <label> · <result>   a completion, a
 *                                         reviewer's verdict, or an agent's
 *                                         report; ruling 526 put the status
 *                                         first, and an older
 *                                         `- <label> · <add> · <del>` row
 *                                         still reads)
 *                    attachments:         (optional — names of files the
 *                    - <file name>         event's run saved into the task's
 *                                          attachments/ dir; the dir is truth)
 *
 * Unknown `## Sections` are preserved verbatim (round-trip safe); malformed
 * timeline entries are skipped with a diagnostic — never a crash, never a
 * dropped task.
 *
 * Event-body escaping: free text inside a timeline event may legitimately
 * contain lines that would otherwise read as file STRUCTURE (`## ` section
 * headings, `### ` event headings, `title:`/`to:`/`notified:` metadata lines, the
 * `evidence:` / `attachments:` markers). The serializer prefixes such lines with a single
 * backslash (`\## Notes`); the parser strips exactly one backslash from any
 * line that is one-or-more backslashes followed by a structural pattern —
 * so lines that already start that way gain one more backslash on write and
 * lose it on read. The mapping is bijective: round-trips stay byte-stable
 * and comment text can never split sections, forge events, or override the
 * real `## Packet`. Documented in docs/architecture/file-formats.md §2.
 */

const SECTION_RE = /^## (.+)$/;
const EVENT_HEADING_PREFIX = "### ";
const SEP = " · ";

/** Membership test for a heading's type token, which is free text off disk. */
const KNOWN_EVENT_TYPES = new Set<string>(TIMELINE_EVENT_TYPES);

/** Line patterns the parser treats as structure inside an event block
 * (mirrors SECTION_RE / EVENT_HEADING_PREFIX / metadata / evidence rules). */
const STRUCTURAL_LINE_SRC = String.raw`## |### |title:\s|to:\s|notified:\s|\s*evidence:\s*$|\s*attachments:\s*$`;
/** Serialize side: line needs a(nother) escape backslash. */
const NEEDS_ESCAPE_RE = new RegExp(String.raw`^\\*(?:${STRUCTURAL_LINE_SRC})`);
/** Parse side: line carries at least one escape backslash — strip one. */
const ESCAPED_LINE_RE = new RegExp(String.raw`^\\+(?:${STRUCTURAL_LINE_SRC})`);

function escapeEventText(text: string): string {
  return text
    .split("\n")
    .map((line) => (NEEDS_ESCAPE_RE.test(line) ? `\\${line}` : line))
    .join("\n");
}

function unescapeEventTextLine(line: string): string {
  return ESCAPED_LINE_RE.test(line) ? line.slice(1) : line;
}

/**
 * The same escape, narrowed for a BODY SECTION's prose (`## Goal`).
 *
 * Only `## ` ends a section, so only `## ` needs escaping here — `### ` and
 * the `title:`/`to:`/`evidence:` metadata lines are structure inside a
 * timeline EVENT and are ordinary prose in the goal. Escaping them too would
 * mangle sentences like "title: Ship it" for no protection.
 *
 * Without this the goal is written from untrusted places (the task form, an
 * agent's goal edit, the controller's chain context) straight into a section
 * whose fence it can close: a plain `## Acceptance` heading truncates the goal
 * at that line, and a `## Timeline` block forges the history the acceptance
 * decision is read from while demoting the real one to a duplicate.
 */
const NEEDS_SECTION_ESCAPE_RE = /^\\*## /;
const ESCAPED_SECTION_RE = /^\\+## /;

function escapeSectionText(text: string): string {
  return text
    .split("\n")
    .map((line) => (NEEDS_SECTION_ESCAPE_RE.test(line) ? `\\${line}` : line))
    .join("\n");
}

function unescapeSectionText(text: string): string {
  return text
    .split("\n")
    .map((line) => (ESCAPED_SECTION_RE.test(line) ? line.slice(1) : line))
    .join("\n");
}

interface RawSection {
  title: string; // "" = preamble before the first `## `
  lines: string[];
}

function splitSections(body: string): RawSection[] {
  const sections: RawSection[] = [];
  let current: RawSection = { title: "", lines: [] };
  for (const line of body.split("\n")) {
    const m = SECTION_RE.exec(line);
    if (m) {
      sections.push(current);
      current = { title: m[1]!.trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

// ------------------------------------------------------------- timeline

/** Ruling 526: an evidence row opens with its status in brackets. */
const EVIDENCE_ROW_RE = /^\[([a-z]+)\] (.+)$/;
/** A count cell of an older row that is a diff's size ("+412", "−87"). */
const SIGNED_COUNT_RE = /^[+−-]?\d+$/;

/**
 * One `evidence:` row, less its `- `. A row reads `[<status>] <label> ·
 * <result>`, the result being the last segment (the label may hold the
 * separator itself). A row written before ruling 526 reads
 * `<label> · <add> · <del>`: it becomes an `info` row whose result is its two
 * cells, a diff's two counts side by side ("+412 −87") and any other pair
 * with a comma ("102 passed, 0 failed"). Null for a row in neither shape.
 */
function parseEvidenceRow(line: string): EvidenceRow | null {
  const marked = EVIDENCE_ROW_RE.exec(line);
  const status = EVIDENCE_STATUSES.find((s) => s === marked?.[1]);
  if (marked && status) {
    const parts = marked[2]!.split(SEP);
    const result = parts.length > 1 ? parts.pop()!.trim() : "";
    return {
      label: parts.join(SEP).trim(),
      result: result === EVIDENCE_EMPTY_COLUMN ? "" : result,
      status,
    };
  }
  const parts = line.split(SEP);
  if (parts.length < 3) return null;
  const del = parts.pop()!.trim();
  const add = parts.pop()!.trim();
  const cells = [add, del].filter((cell) => cell !== "" && cell !== EVIDENCE_EMPTY_COLUMN);
  return {
    label: parts.join(SEP).trim(),
    result: cells.join(cells.every((cell) => SIGNED_COUNT_RE.test(cell)) ? " " : ", "),
    status: "info",
  };
}

function parseEventBlock(
  headingLine: string,
  bodyLines: string[],
  diagnostics: FileDiagnostic[],
): TaskFileEvent | null {
  const heading = headingLine.slice(EVENT_HEADING_PREFIX.length);
  const firstSep = heading.indexOf(SEP);
  const secondSep = firstSep === -1 ? -1 : heading.indexOf(SEP, firstSep + SEP.length);
  if (firstSep === -1 || secondSep === -1) {
    diagnostics.push(
      diagWarning(
        "timeline.malformed_heading",
        `Timeline entry heading is malformed and was skipped: "${headingLine.slice(0, 80)}"`,
        "timeline",
      ),
    );
    return null;
  }

  const occurredAt = heading.slice(0, firstSep).trim();
  const type = heading.slice(firstSep + SEP.length, secondSep).trim();
  const actorRaw = heading.slice(secondSep + SEP.length).trim();

  if (Number.isNaN(Date.parse(occurredAt))) {
    diagnostics.push(
      diagWarning(
        "timeline.invalid_timestamp",
        `Timeline entry has an unparseable timestamp "${occurredAt}" and was skipped.`,
        "timeline",
      ),
    );
    return null;
  }

  if (!KNOWN_EVENT_TYPES.has(type)) {
    diagnostics.push(
      diagInfo(
        "timeline.unknown_type",
        `Timeline entry has unknown type "${type}" — rendered as a plain comment.`,
        "timeline",
      ),
    );
  }

  // Total decode: an unrecognized author becomes `{kind:"unknown", raw}` and
  // round-trips verbatim — the event is KEPT (VIB-12 class: a dropped decode
  // used to silently erase the event on the next read-modify-write).
  const actor = decodeActorRef(actorRaw);
  if (actor.kind === "unknown") {
    diagnostics.push(
      diagWarning(
        "timeline.unknown_actor",
        `Timeline entry has an unrecognized actor ref "${actorRaw}" — kept verbatim.`,
        "timeline",
      ),
    );
  }

  // Metadata lines: consecutive `title:` / `to:` lines directly after heading.
  let title: string | null = null;
  let toAgent = false;
  let notified: string[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i]!;
    if (/^title:\s/.test(line)) {
      title = line.slice("title:".length).trim();
      i += 1;
    } else if (/^to:\s/.test(line)) {
      toAgent = line.slice("to:".length).trim() === "agent";
      i += 1;
    } else if (/^notified:\s/.test(line)) {
      // Ruling 382: the recipients this event's fan-out reached. One line,
      // comma separated, ids only — compaction reads it and folds nothing that
      // notified somebody.
      notified = line
        .slice("notified:".length)
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
      i += 1;
    } else {
      break;
    }
  }

  // Body: everything up to the first `evidence:` / `attachments:` marker line.
  // Escaped structural lines (`\## …`, `\### …`, `\title: …`, `\to: …`,
  // `\evidence:`, `\attachments:`) lose exactly one backslash — the reverse of
  // escapeEventText.
  const rest = bodyLines.slice(i);
  const evidenceIdx = rest.findIndex((l) => l.trim() === "evidence:");
  const attachIdx = rest.findIndex((l) => l.trim() === "attachments:");
  const markerIdxs = [evidenceIdx, attachIdx].filter((idx) => idx !== -1);
  const textEnd = markerIdxs.length > 0 ? Math.min(...markerIdxs) : -1;
  const textLines = textEnd === -1 ? rest : rest.slice(0, textEnd);
  const text = textLines.map(unescapeEventTextLine).join("\n").trim();

  let evidence: EvidenceRow[] | null = null;
  if (evidenceIdx !== -1) {
    evidence = [];
    for (const line of rest.slice(evidenceIdx + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // A following `attachments:` marker (or any other non-row line) ends the
      // block — same tolerance the rows always had.
      if (!trimmed.startsWith("- ")) break;
      const row = parseEvidenceRow(trimmed.slice(2));
      if (!row) {
        diagnostics.push(
          diagWarning(
            "timeline.malformed_evidence",
            `Evidence row could not be parsed and was skipped: "${trimmed.slice(0, 80)}"`,
            "timeline",
          ),
        );
        continue;
      }
      evidence.push(row);
    }
  }

  // `attachments:` — one `- <name>` line per file the event's run saved into
  // the task's attachments/ dir. Names only; the directory stays the truth.
  let attachments: string[] | null = null;
  if (attachIdx !== -1) {
    attachments = [];
    for (const line of rest.slice(attachIdx + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("- ")) break;
      const name = trimmed.slice(2).trim();
      if (name) attachments.push(name);
    }
  }

  const event: TaskFileEvent = {
    occurredAt,
    type,
    actor,
    title,
    text,
    toAgent,
    evidence,
  };
  if (attachments && attachments.length > 0) event.attachments = attachments;
  if (notified.length > 0) event.notified = notified;
  return event;
}

function parseTimeline(
  lines: string[],
  diagnostics: FileDiagnostic[],
): TaskFileEvent[] {
  const events: TaskFileEvent[] = [];
  let heading: string | null = null;
  let block: string[] = [];
  const flush = () => {
    if (heading !== null) {
      const event = parseEventBlock(heading, block, diagnostics);
      if (event) events.push(event);
    } else if (block.some((l) => l.trim() !== "")) {
      diagnostics.push(
        diagWarning(
          "timeline.stray_content",
          "Timeline section contains content outside any `###` entry — ignored.",
          "timeline",
        ),
      );
    }
    heading = null;
    block = [];
  };
  for (const line of lines) {
    if (line.startsWith(EVENT_HEADING_PREFIX)) {
      flush();
      heading = line;
    } else {
      block.push(line);
    }
  }
  flush();
  return events;
}

function serializeEvent(event: TaskFileEvent): string {
  const lines: string[] = [
    `${EVENT_HEADING_PREFIX}${event.occurredAt}${SEP}${event.type}${SEP}${encodeActorRef(event.actor)}`,
  ];
  // `title:` is a SINGLE metadata line — the parser reads one line and trims
  // it, so a title can never come back off disk with a newline in it. Writing
  // one raw was the escaping machinery's own hole: a title carrying
  // "\n### <ts> · accepted · <actor>" forged a whole timeline event with an
  // arbitrary type and actor, which is exactly what the bijection promised at
  // the top of this file rules out. Folding to a space keeps the round-trip
  // byte-stable (a parsed title has no newline to fold) and closes it.
  if (event.title) lines.push(`title: ${event.title.replace(/\s*\n\s*/g, " ")}`);
  if (event.toAgent) lines.push(`to: agent`);
  // Ruling 382: one metadata line, same shape as `title:`/`to:` — a comma
  // separated id list the parser reads back whole.
  if (event.notified && event.notified.length > 0) {
    lines.push(`notified: ${event.notified.join(", ")}`);
  }
  lines.push("");
  lines.push(escapeEventText(event.text));
  if (event.evidence && event.evidence.length > 0) {
    lines.push("");
    lines.push("evidence:");
    for (const row of event.evidence) {
      lines.push(`- [${row.status}] ${row.label}${SEP}${row.result || EVIDENCE_EMPTY_COLUMN}`);
    }
  }
  if (event.attachments && event.attachments.length > 0) {
    lines.push("");
    lines.push("attachments:");
    for (const name of event.attachments) {
      lines.push(`- ${name}`);
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- packet

/** Tolerant packet parse (the fenced yaml block under `## Packet`). Returns
 * null + diagnostics when the block cannot be salvaged. */
function parsePacketSection(
  lines: string[],
  diagnostics: FileDiagnostic[],
): TaskPacket | null {
  const text = lines.join("\n");
  // The opening run of backticks is captured and the CLOSE must be at least as
  // long (CommonMark's own rule), so a fence inside the packet's own prose —
  // an operator quoting a snippet in `body`, an option's `d`, or a markdown
  // `goalDraft` — cannot terminate the block early. A fixed ``` close with a
  // lazy body matched the first inner fence instead, truncating the yaml mid
  // document: the options array parsed away to empty, WITHOUT a diagnostic,
  // and the next write serialized that loss over the real packet.
  const fence = /(`{3,})(?:yaml)?\n([\s\S]*?)\n\1/.exec(text);
  if (!fence) {
    if (text.trim() !== "") {
      diagnostics.push(
        diagWarning(
          "packet.no_yaml_block",
          "Packet section has no fenced yaml block — packet ignored.",
          "packet",
        ),
      );
    }
    return null;
  }
  let raw: unknown;
  try {
    raw = YAML.parse(fence[2]!);
  } catch (error) {
    diagnostics.push(
      diagWarning(
        "packet.invalid_yaml",
        `Packet yaml is unparseable (${error instanceof Error ? error.message.split("\n")[0] : String(error)}) — packet ignored.`,
        "packet",
      ),
    );
    return null;
  }
  if (raw === undefined || raw === null) return null;
  // F31-C5 — per-ROW option tolerance, the F18 idiom the frontmatter lists
  // already use. `options: z.array(packetOptionSchema)` voided the WHOLE
  // packet on one malformed row, and "packet ignored" here is durable loss:
  // the task reads `waiting: human` with no card to answer, and the next
  // `updateTaskFile` serializes the packet section away entirely. One bad
  // option now drops only itself (with a diagnostic); the human still gets
  // the surviving options plus the always-offered custom directive.
  const optionsProbe = z
    .object({ options: z.array(z.unknown()) })
    .loose()
    .safeParse(raw);
  if (optionsProbe.success) {
    optionsProbe.data.options = tolerantRowsOf(
      diagnostics,
      optionsProbe.data.options,
      packetOptionSchema,
      "packet.invalid_option",
      (i) => ({
        subject: `Packet option [${i}]`,
        noun: "option",
        path: "packet.options",
      }),
    );
    raw = optionsProbe.data;
  }
  // C01-A1 (pass 32): the same per-row tolerance for `observations` — the
  // sibling the C5 fix left behind. One hand-edited `v: 9` (a YAML number
  // where a string was meant) failed the whole packet parse with a diagError,
  // not a hardStop, so the write guard let the next `updateTaskFile` serialize
  // the `## Packet` section away: the identical durable-loss shape.
  const observationsProbe = z
    .object({ observations: z.array(z.unknown()) })
    .loose()
    .safeParse(raw);
  if (observationsProbe.success) {
    observationsProbe.data.observations = tolerantRowsOf(
      diagnostics,
      observationsProbe.data.observations,
      packetObservationSchema,
      "packet.invalid_observation",
      (i) => ({
        subject: `Packet observation [${i}]`,
        noun: "observation",
        path: "packet.observations",
      }),
    );
    raw = observationsProbe.data;
  }
  const result = taskPacketSchema.safeParse(raw);
  if (result.success) {
    // Ruling 478(e): NO recommendation is a legitimate packet (an agent's
    // question it has no pick on), so only a second recommendation is news.
    const recCount = result.data.options.filter((o) => o.rec).length;
    if (recCount > 1) {
      diagnostics.push(
        diagInfo(
          "packet.rec_count",
          `Packet has ${recCount} recommended options (expected at most 1).`,
          "packet.options",
        ),
      );
    }
    return result.data;
  }
  const issue = result.error.issues[0];
  diagnostics.push(
    diagError(
      "packet.invalid",
      `Packet block is invalid at \`${issue?.path.join(".") || "packet"}\` (${issue?.message ?? "unparseable"}) — packet ignored.`,
      "packet",
    ),
  );
  return null;
}

// ----------------------------------------------------------- public API

export interface TaskFileParseResult {
  parsed: ParsedTaskFile;
  diagnostics: FileDiagnostic[];
}

export function parseTaskFileContent(
  content: string,
  context: { fallbackKey?: string } = {},
): TaskFileParseResult {
  const { data, body, diagnostics } = splitFrontmatterMapping(content);
  const fm = parseTaskFrontmatter(data, context);
  diagnostics.push(...fm.diagnostics);

  const sections = splitSections(body);
  let goal = "";
  let sawGoal = false;
  let packet: TaskPacket | null = null;
  let sawPacket = false;
  let timeline: TaskFileEvent[] = [];
  let sawTimeline = false;
  const extraSections: { title: string; raw: string }[] = [];

  // Duplicate known sections: the FIRST occurrence wins (never silent
  // last-wins — a later duplicate must not override real state). The
  // duplicate is flagged and preserved verbatim as an extra section so no
  // data is dropped.
  const duplicateSection = (title: string, raw: string) => {
    diagnostics.push(
      diagWarning(
        "body.duplicate_section",
        `Duplicate \`## ${title}\` section — the first occurrence wins; the duplicate is preserved as an unrecognized section.`,
        title.toLowerCase(),
      ),
    );
    extraSections.push({ title, raw: raw.trim() });
  };

  for (const section of sections) {
    const raw = section.lines.join("\n");
    if (section.title === "" ) {
      if (raw.trim() !== "") extraSections.push({ title: "", raw: raw.trim() });
      continue;
    }
    if (section.title === "Goal") {
      if (sawGoal) {
        duplicateSection("Goal", raw);
        continue;
      }
      goal = unescapeSectionText(raw).trim();
      sawGoal = true;
    } else if (section.title === "Packet") {
      if (sawPacket) {
        duplicateSection("Packet", raw);
        continue;
      }
      packet = parsePacketSection(section.lines, diagnostics);
      sawPacket = true;
    } else if (section.title === "Timeline") {
      if (sawTimeline) {
        duplicateSection("Timeline", raw);
        continue;
      }
      timeline = parseTimeline(section.lines, diagnostics);
      sawTimeline = true;
    } else {
      extraSections.push({ title: section.title, raw: raw.trim() });
    }
  }

  if (!sawGoal) {
    diagnostics.push(
      diagInfo(
        "body.missing_goal",
        "Task file has no `## Goal` section.",
        "goal",
      ),
    );
  }
  if (!sawTimeline) {
    diagnostics.push(
      diagInfo(
        "body.missing_timeline",
        "Task file has no `## Timeline` section.",
        "timeline",
      ),
    );
  }

  // Timeline must be newest-first; out-of-order entries are tolerated but
  // flagged (external editors may append at the bottom).
  for (let i = 1; i < timeline.length; i++) {
    if (Date.parse(timeline[i]!.occurredAt) > Date.parse(timeline[i - 1]!.occurredAt)) {
      diagnostics.push(
        diagInfo(
          "timeline.out_of_order",
          // The message used to end "display sorts by timestamp". Nothing sorts:
          // `listTaskEvents` is ORDER BY position ASC (the verbatim file index
          // the rebuilder writes), `timelineSlice` takes the first N off the
          // front of that array, and the task timeline component only filters
          // it. So the reader of a task whose file HAS an inversion was told the
          // page had compensated, on the one panel whose job is to tell them the
          // truth about the record. Ruling 237's own note-ordering fix was made
          // in the WRITE for exactly this reason.
          "Timeline entries are not strictly newest-first. The page renders file order, so an entry may sit out of place until the file is rewritten.",
          "timeline",
        ),
      );
      break;
    }
  }

  return {
    parsed: {
      frontmatter: fm.frontmatter,
      unknownFrontmatter: fm.unknown,
      goal,
      packet,
      timeline,
      extraSections,
    },
    diagnostics,
  };
}

export function serializeTaskFile(parsed: ParsedTaskFile): string {
  const bodyParts: string[] = [];

  // Preserved preamble first (extra sections with empty title).
  for (const extra of parsed.extraSections) {
    if (extra.title === "") bodyParts.push(extra.raw);
  }

  bodyParts.push(`## Goal\n\n${escapeSectionText(parsed.goal)}`.trimEnd());

  if (parsed.packet) {
    const yamlText = toYaml(parsed.packet).trimEnd();
    // Fence longer than the longest backtick run the yaml itself contains, so
    // packet prose that quotes a code fence stays inside the block (the read
    // side matches the close against this same run length).
    const longestRun = Math.max(
      0,
      ...(yamlText.match(/`+/g) ?? []).map((run) => run.length),
    );
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    bodyParts.push(`## Packet\n\n${fence}yaml\n${yamlText}\n${fence}`);
  }

  const eventsText = parsed.timeline.map(serializeEvent).join("\n\n");
  bodyParts.push(eventsText ? `## Timeline\n\n${eventsText}` : `## Timeline`);

  for (const extra of parsed.extraSections) {
    if (extra.title !== "") bodyParts.push(`## ${extra.title}\n\n${extra.raw}`.trimEnd());
  }

  const { frontmatter, unknownFrontmatter } = parsed;
  return serializeFrontmatterFile(
    frontmatter,
    unknownFrontmatter,
    bodyParts.join("\n\n"),
  );
}
