import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Ruling 342 (pass 37, F37-178) — a tool description is a prompt, and it is
 * edited the way prose is edited.
 *
 * `list_decisions`' description shipped ruling 336's new `releases` paragraph
 * with its closing sentence pasted twice: *"`kind` and `notAcceptableReason`
 * carry that other half. `kind` and `notAcceptableReason` carry that other
 * half."* It is 1,900 characters long, it is assembled from adjacent string
 * literals, and every controller turn reads it. Nothing anywhere looked at it.
 *
 * These strings are the only agent instructions in the product with no reader
 * but the model — a persona is reviewed in the editor, a KB document is opened
 * by a person, a packet body is read on a card. So the one property worth
 * checking mechanically is the one a careless edit produces: the same sentence
 * twice inside one description.
 *
 * Deliberately narrow. It is not a style gate and it says nothing about length,
 * tone or content; a repeated sentence is simply never intended, and a model
 * spending tokens reading the same clause twice is being charged for an edit
 * nobody finished.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");

/** Every surface that hands descriptions to a model. */
const SURFACES = [
  "app/server/controller/controller-toolkit.server.ts",
  "app/server/controller/controller-ops-mcp.server.ts",
  "app/server/tasks/operator-toolkit.server.ts",
  "app/server/tasks/agent-toolkit.server.ts",
  "app/server/runtimes/operator-run.server.ts",
  "app/server/runtimes/operator-prompt.server.ts",
];

/**
 * Adjacent double-quoted literals joined by `+` are ONE string by the time a
 * model sees it, and the duplicate that prompted this ruling spanned two of
 * them — so a concatenation chain is joined, and nothing else is.
 *
 * Scoping to the chain is what makes this a real check rather than a style
 * complaint: the first draft split on statements, which swept three sibling
 * `.describe()` calls into one text and called `"Omit to keep the deployment's
 * grants; [] clears them."` a duplicate. It is said once per field, about that
 * field, and saying it three times is correct.
 */
const STRING_CHAIN = /"(?:[^"\\]|\\.){0,4000}"(?:\s*\+\s*"(?:[^"\\]|\\.){0,4000}")*/g;

function agentStrings(source: string): string[] {
  return [...source.matchAll(STRING_CHAIN)]
    .map((m) =>
      [...m[0].matchAll(/"((?:[^"\\]|\\.){0,4000})"/g)].map((lit) => lit[1]).join(""),
    )
    .filter((joined) => joined.length >= 200);
}

function repeatedSentences(text: string): string[] {
  const counts = new Map<string, number>();
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const sentence = raw.trim();
    // Short fragments repeat legitimately even inside one description.
    if (sentence.length < 28) continue;
    counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([s]) => s);
}

describe("tool descriptions say each thing once (ruling 342)", () => {
  it("the sweep reads real descriptions, not an empty set", () => {
    // CANARY: break `agentStrings` and every assertion below passes vacuously.
    const found = SURFACES.flatMap((rel) =>
      agentStrings(readFileSync(path.join(ROOT, rel), "utf8")),
    );
    expect(found.length).toBeGreaterThanOrEqual(40);
    // The description this ruling came from, so the joiner is proven to span
    // concatenated literals.
    expect(
      found.some(
        (s) =>
          s.includes("Everything on a board that is waiting for a PERSON") &&
          s.includes("carry that other half"),
      ),
      "the `list_decisions` description did not reassemble from its literals",
    ).toBe(true);
  });

  it.each(SURFACES)("%s repeats no sentence inside one description", (rel) => {
    const offenders = agentStrings(readFileSync(path.join(ROOT, rel), "utf8"))
      .flatMap(repeatedSentences)
      .map((s) => s.slice(0, 120));
    // CANARY: paste ruling 336's "`kind` and `notAcceptableReason` carry that
    // other half." back a second time and this names it.
    expect(
      offenders,
      `${rel}: a sentence appears twice inside one description a model reads.`,
    ).toEqual([]);
  });
});
