import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKET_OPTION_KINDS } from "~/schemas/task-file.schema";

/**
 * N19-3 — `docs/architecture/file-formats.md` enumerates the packet-option
 * kinds, and `PACKET_OPTION_KINDS` (app/schemas/task-file.schema.ts) IS the set.
 *
 * The doc said "The 8 kinds" and omitted `archive_task` for the whole life of
 * R14-3's task archive. `decisions.md` ruling 7 was corrected to nine on
 * 2026-08-05; this sibling enumeration was corrected a day later, by hand,
 * after a human happened to read both. Nothing linked the two, which is exactly
 * how the count went stale the first time — and a hand-correction with no gate
 * is a fix with a half-life (audit §2.4).
 *
 * The doc names itself a MIRROR ("the list below mirrors it"), so mirroring is
 * checked the way ruling 27 checks the PRD mirror: mechanically. Add a kind to
 * the schema and this fails, naming the missing one and the stale count.
 *
 * Edit the SCHEMA; this test makes the doc a mechanical follow-up instead of a
 * thing to remember.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const DOC = path.join(ROOT, "docs", "architecture", "file-formats.md");
const DOC_REL = "docs/architecture/file-formats.md";

/** Spelled counts the prose uses; digits are handled separately. */
const COUNT_WORDS = new Map<string, number>([
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);

const MD = readFileSync(DOC, "utf8");

/** The `## Packet` section only — the rest of the file counts other things. */
function packetSection(): string {
  const start = MD.indexOf("\n## Packet\n");
  expect(start, `${DOC_REL} must still have a "## Packet" section`).toBeGreaterThan(-1);
  const rest = MD.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The comment tail of a line, or "" when it carries no comment. */
function commentTail(line: string): string {
  const hash = line.indexOf("#");
  return hash === -1 ? "" : line.slice(hash + 1);
}

/**
 * The `|`-separated enumeration that continues below the "The N kinds:" marker.
 * Collection stops at the first continuation line without a `|`, so the trailing
 * "(acceptance path marker …)" note is not mistaken for a kind.
 */
function documentedKinds(section: string): string[] {
  const lines = section.split("\n");
  const markerAt = lines.findIndex((l) => /\bThe\s+\S+\s+kinds:/.test(l));
  expect(
    markerAt,
    `${DOC_REL} must keep the "The N kinds:" enumeration next to the packet example`,
  ).toBeGreaterThan(-1);
  const parts: string[] = [];
  for (let i = markerAt + 1; i < lines.length; i += 1) {
    const tail = commentTail(lines[i]!);
    if (!tail.includes("|")) break;
    parts.push(tail);
  }
  return parts
    .join(" ")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("N19-3: file-formats.md mirrors PACKET_OPTION_KINDS", () => {
  it("enumerates exactly the schema's kinds, in the schema's order", () => {
    // The gate. `archive_task` was missing here for as long as the archive has
    // existed, and the only thing that noticed was a person reading both files.
    expect(
      documentedKinds(packetSection()),
      `${DOC_REL} has drifted from PACKET_OPTION_KINDS ` +
        `(app/schemas/task-file.schema.ts). The schema is the source of truth — ` +
        `update the doc's "The N kinds:" enumeration to match it.`,
    ).toEqual([...PACKET_OPTION_KINDS]);
  });

  it("states the right COUNT, in the numeral and in the prose that corrects it", () => {
    // Quoted spans are CITATIONS of what the doc used to say — the correction
    // note quotes its own stale `"The 8 kinds"` on purpose. A quotation of a
    // wrong count is not a wrong count, so quoted text is dropped before the
    // scan; only the doc's own live claims are held to the schema.
    const section = packetSection().replace(/"[^"\n]*"/g, '""');
    const n = PACKET_OPTION_KINDS.length;
    // Every place the section commits to a number: the YAML comment's
    // "The 9 kinds:", and the dated correction note's prose ("corrected to
    // nine", "Nine is the count today"). "The 8 kinds" survived three passes
    // because a stale numeral reads exactly like a fresh one.
    const stated: string[] = [];
    for (const re of [
      /\b([A-Za-z0-9]+)\s+kinds\b/g,
      /\b([A-Za-z0-9]+)\s+is the count\b/g,
      /\bcorrected to\s+([A-Za-z0-9]+)\b/g,
    ]) {
      for (const m of section.matchAll(re)) {
        const token = m[1]!;
        const value = /^\d+$/.test(token)
          ? Number(token)
          : COUNT_WORDS.get(token.toLowerCase());
        // "option kinds", "packet kinds" — prose that states no number.
        if (value !== undefined) stated.push(token);
      }
    }
    expect(
      stated.length,
      `${DOC_REL} must still state the kind count somewhere in the Packet section`,
    ).toBeGreaterThan(0);
    for (const token of stated) {
      const value = /^\d+$/.test(token)
        ? Number(token)
        : COUNT_WORDS.get(token.toLowerCase())!;
      expect(
        value,
        `${DOC_REL} says "${token}" where PACKET_OPTION_KINDS has ${n}`,
      ).toBe(n);
    }
  });
});
