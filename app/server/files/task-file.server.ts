import {
  diagInfo,
  diagWarning,
  type FileDiagnostic,
} from "~/schemas/file-diagnostics";
import {
  parseTaskFrontmatter,
  parseTaskPacket,
  TIMELINE_EVENT_TYPES,
  type ParsedTaskFile,
  type TaskFileEvent,
  type TaskPacket,
} from "~/schemas/task-file.schema";
import { decodeActorRef, encodeActorRef } from "./actor-ref.server";
import {
  parseYaml,
  serializeFrontmatterFile,
  splitFrontmatter,
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
 *                    <blank line>
 *                    <text — RichText micro-format>
 *                    evidence:                      (optional, completion only)
 *                    - <label> · <add> · <del>
 *
 * Unknown `## Sections` are preserved verbatim (round-trip safe); malformed
 * timeline entries are skipped with a diagnostic — never a crash, never a
 * dropped task.
 */

const SECTION_RE = /^## (.+)$/;
const EVENT_HEADING_PREFIX = "### ";
const SEP = " · ";

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

  if (!(TIMELINE_EVENT_TYPES as readonly string[]).includes(type)) {
    diagnostics.push(
      diagInfo(
        "timeline.unknown_type",
        `Timeline entry has unknown type "${type}" — rendered as a plain comment.`,
        "timeline",
      ),
    );
  }

  const actor = decodeActorRef(actorRaw);
  if (!actor) {
    diagnostics.push(
      diagWarning(
        "timeline.unknown_actor",
        `Timeline entry has an unrecognized actor ref "${actorRaw}" and was skipped.`,
        "timeline",
      ),
    );
    return null;
  }

  // Metadata lines: consecutive `title:` / `to:` lines directly after heading.
  let title: string | null = null;
  let toAgent = false;
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i]!;
    if (/^title:\s/.test(line)) {
      title = line.slice("title:".length).trim();
      i += 1;
    } else if (/^to:\s/.test(line)) {
      toAgent = line.slice("to:".length).trim() === "agent";
      i += 1;
    } else {
      break;
    }
  }

  // Body: everything up to an `evidence:` marker line.
  const rest = bodyLines.slice(i);
  const evidenceIdx = rest.findIndex((l) => l.trim() === "evidence:");
  const textLines = evidenceIdx === -1 ? rest : rest.slice(0, evidenceIdx);
  const text = textLines.join("\n").trim();

  let evidence: { label: string; add: string; del: string }[] | null = null;
  if (evidenceIdx !== -1) {
    evidence = [];
    for (const line of rest.slice(evidenceIdx + 1)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("- ")) break;
      const parts = trimmed.slice(2).split(SEP);
      if (parts.length < 3) {
        diagnostics.push(
          diagWarning(
            "timeline.malformed_evidence",
            `Evidence row could not be parsed and was skipped: "${trimmed.slice(0, 80)}"`,
            "timeline",
          ),
        );
        continue;
      }
      const del = parts.pop()!.trim();
      const add = parts.pop()!.trim();
      evidence.push({ label: parts.join(SEP).trim(), add, del });
    }
  }

  return { occurredAt, type, actor, title, text, toAgent, evidence };
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
  if (event.title) lines.push(`title: ${event.title}`);
  if (event.toAgent) lines.push(`to: agent`);
  lines.push("");
  lines.push(event.text);
  if (event.evidence && event.evidence.length > 0) {
    lines.push("");
    lines.push("evidence:");
    for (const row of event.evidence) {
      lines.push(`- ${row.label}${SEP}${row.add}${SEP}${row.del}`);
    }
  }
  return lines.join("\n");
}

// --------------------------------------------------------------- packet

function parsePacketSection(
  lines: string[],
  diagnostics: FileDiagnostic[],
): TaskPacket | null {
  const text = lines.join("\n");
  const fence = /```(?:yaml)?\n([\s\S]*?)```/.exec(text);
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
    raw = parseYaml(fence[1]!);
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
  const { packet, diagnostics: packetDiags } = parseTaskPacket(raw);
  diagnostics.push(...packetDiags);
  return packet;
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
  const diagnostics: FileDiagnostic[] = [];
  const { data, body, diagnostics: fmDiags } = splitFrontmatter(content);
  diagnostics.push(...fmDiags);

  const fm = parseTaskFrontmatter(data, context);
  diagnostics.push(...fm.diagnostics);

  const sections = splitSections(body);
  let goal = "";
  let sawGoal = false;
  let packet: TaskPacket | null = null;
  let timeline: TaskFileEvent[] = [];
  let sawTimeline = false;
  const extraSections: { title: string; raw: string }[] = [];

  for (const section of sections) {
    const raw = section.lines.join("\n");
    if (section.title === "" ) {
      if (raw.trim() !== "") extraSections.push({ title: "", raw: raw.trim() });
      continue;
    }
    if (section.title === "Goal") {
      goal = raw.trim();
      sawGoal = true;
    } else if (section.title === "Packet") {
      packet = parsePacketSection(section.lines, diagnostics);
    } else if (section.title === "Timeline") {
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
          "Timeline entries are not strictly newest-first — display sorts by timestamp.",
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

  bodyParts.push(`## Goal\n\n${parsed.goal}`.trimEnd());

  if (parsed.packet) {
    const yamlText = toYaml(parsed.packet).trimEnd();
    bodyParts.push(`## Packet\n\n\`\`\`yaml\n${yamlText}\n\`\`\``);
  }

  const eventsText = parsed.timeline.map(serializeEvent).join("\n\n");
  bodyParts.push(eventsText ? `## Timeline\n\n${eventsText}` : `## Timeline`);

  for (const extra of parsed.extraSections) {
    if (extra.title !== "") bodyParts.push(`## ${extra.title}\n\n${extra.raw}`.trimEnd());
  }

  const { frontmatter, unknownFrontmatter } = parsed;
  return serializeFrontmatterFile(
    frontmatter as unknown as Record<string, unknown>,
    unknownFrontmatter,
    bodyParts.join("\n\n"),
  );
}
