import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 341 (pass 37, F37-177) — `decisions.md` states a convention about
 * itself and did not keep it.
 *
 * Its own header: *"Several rulings have been narrowed or reversed by a later
 * owner decision. Those are marked **SUPERSEDED** inline, with what replaced
 * them and when… Never restore a superseded rule because you found the ruling
 * text."* That last sentence is the whole reason the marker matters, and it is
 * unenforceable by reading, because the two ends of a supersession are written
 * hours or weeks apart and only the NEW end knows.
 *
 * Measured when this was written: seven rulings are named by a later one as
 * narrowed, reversed or superseded, and **three of the seven carried no marker
 * at all** — 20 (narrowed by 59), 193 (whose revision-counting 204 reverses)
 * and 261 (superseded by 283, and its `RULINGS_KB_FLOOR` no longer exists in
 * the source). 193 is the sharp one: it is the operator doctrine for a reviewer
 * that cannot pass, its reversed half is a counter with a test that defended
 * it, and this file is what an agent working on Viberr is pointed at as the
 * binding rulings.
 *
 * So the convention is checked instead of asserted. A ruling that says it
 * changes an earlier one obliges the earlier one to say so too; this fails
 * naming both numbers, which is the follow-up edit rather than a thing to
 * remember. Same posture as `file-formats-sync.test.ts` one document over.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const DOC_REL = "docs/architecture/decisions.md";
const DOC = path.join(ROOT, DOC_REL);

/** One numbered ruling, with every block that carries its number (a few
 *  numbers appear twice — the file has an appended older section). */
function rulingBlocks(doc: string): Map<number, string[]> {
  const lines = doc.split("\n");
  const starts: { n: number; at: number }[] = [];
  lines.forEach((line, at) => {
    const m = /^(\d+)\. \*\*/.exec(line);
    if (m) starts.push({ n: Number(m[1]), at });
  });
  const out = new Map<number, string[]>();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.at : lines.length;
    const body = lines.slice(start.at, end).join("\n");
    out.set(start.n, [...(out.get(start.n) ?? []), body]);
  });
  return out;
}

/**
 * The verb, then the number it acts on. Matched against the block flattened to
 * one line, because these sentences wrap — "supersedes\n    261" is the shape
 * that hid ruling 261's for two days.
 *
 * `narrowed by` / `superseded by` are excluded deliberately: those are what the
 * OLD ruling says about itself, which is the marker, not a claim about someone
 * else.
 */
const CLAIM =
  /(?<!narrowed )(?<!superseded )(?<!reversed )\b(?:supersedes|superseding|replaces|retires|reverses|narrows)\b\s+(?:rulings?\s+)?(\d{1,3})\b/gi;

/** Whatever wording an old ruling uses to say it was changed. Deliberately
 *  loose: the point is that SOMETHING in the block tells the reader, not that
 *  it matches one house phrasing. */
const MARKED = /supersed|retired|narrow|withdrawn|reversed|replaced|no longer/i;

describe("decisions.md keeps its own supersession convention (ruling 341)", () => {
  const doc = readFileSync(DOC, "utf8");
  const blocks = rulingBlocks(doc);

  it("every ruling a later one changes says so in its own text", () => {
    const claims = new Map<number, Set<number>>();
    for (const [n, bodies] of blocks) {
      for (const body of bodies) {
        const flat = body.replace(/\s+/g, " ");
        for (const m of flat.matchAll(CLAIM)) {
          const target = Number(m[1]);
          // Self-reference and forward references to a number this file does
          // not define are not supersessions.
          if (target === n || !blocks.has(target)) continue;
          claims.set(target, new Set([...(claims.get(target) ?? []), n]));
        }
      }
    }
    // CANARY: break the CLAIM regex and the sweep finds nothing, which would
    // pass vacuously. The seven live when this shipped are 13, 20, 59, 149,
    // 182, 193 and 261; the count only ever goes UP.
    expect(claims.size).toBeGreaterThanOrEqual(7);

    const unmarked = [...claims.entries()]
      .filter(([target]) => !blocks.get(target)!.some((b) => MARKED.test(b)))
      .map(([target, by]) => `ruling ${target} (changed by ${[...by].join(", ")})`);
    expect(
      unmarked,
      `${DOC_REL}: these rulings are named as narrowed/reversed/superseded by a later ` +
        `ruling and say nothing about it in their own text. Add the inline marker — the ` +
        `document's own header promises it, and "never restore a superseded rule because ` +
        `you found the ruling text" is only followable if the text says so.`,
    ).toEqual([]);
  });
});
