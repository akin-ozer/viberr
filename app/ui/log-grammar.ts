import type { LanguageRegistration } from "shiki/types";
import upstream from "@shikijs/langs/log";

/**
 * Ruling 508: the reader's log grammar. It is Shiki's (the Log File
 * Highlighter grammar VS Code ships) with three repairs, and it rides the
 * grammar's own chunk: `code-highlight.ts` imports this module where it
 * imported `@shikijs/langs/log`.
 *
 * Numbers. Upstream colours `\b([0-9]+|true|false|null)\b`, so a digit run
 * is a number wherever it stands as a word, and `.` ends a word. Node's
 * `(0.73575ms)` coloured its `0` and left `.73575ms` plain, because `73575ms`
 * is not a word. `127.0.0.1` came back as four numbers and three plain dots,
 * and the `004` of `W-004` was a number inside a name. The rule also ran
 * ahead of the grammar's own dotted-token rule, which would have taken
 * `0.73575ms` whole. Here a number is one token or none. It has an optional
 * sign, digits, any `.digits` groups, an exponent, and a unit or `%` glued to
 * it (`12ms`, `85.5%`, `1.5GB`), with no word, hyphen or dot on either side.
 * A sentence's full stop may follow it. The hash rule steps aside for a
 * fraction, so `1727349634.123` is one number, not a 10-digit hash and `.123`.
 *
 * Levels. Upstream names each level by the colour VS Code's default theme
 * gives a scope, not by what it means: ERROR is `string.regexp`, WARN
 * `markup.deleted` and DEBUG `markup.changed`. The css-variables families
 * paint those as a string, a deletion and a change, so an ERROR read as a
 * pale string and a WARN as red. Each level now names the family whose
 * GitHub colour matches its severity: ERROR red and bold, WARN orange, INFO
 * green, DEBUG blue. TRACE and VERBOSE stay comments.
 */

type Rule = LanguageRegistration["patterns"][number];

/** Upstream's number rule, replaced by `NUMBER` and `KEYWORDS`. */
const WORD_DIGITS = String.raw`\b([0-9]+|true|false|null)\b`;
/** Upstream's hash rule: 7, 10 or 40 hex digits. */
const HASH = String.raw`\b(\h{40}|\h{10}|\h{7})\b`;

const NUMBER = String.raw`(?<![\w.-])-?\d+(?:\.\d+)*(?:[eE][-+]?\d+)?(?:%|[a-zA-Zµ]+)?(?![\w-]|\.\w)`;
const KEYWORDS = String.raw`\b(true|false|null)\b`;

/** A level's own scope (the last one upstream names) → the family it wears. */
const LEVEL_SCOPES: ReadonlyMap<string, string> = new Map([
  ["log.error", "markup.deleted strong log.error"],
  ["log.warning", "markup.changed log.warning"],
  ["log.info", "markup.inserted log.info"],
  ["log.debug", "constant.language log.debug"],
]);

function repair(rule: Rule): Rule[] {
  if (rule.match === WORD_DIGITS) {
    return [
      { match: NUMBER, name: "constant.numeric log.number" },
      { match: KEYWORDS, name: "constant.language log.constant" },
    ];
  }
  if (rule.match === HASH) return [{ ...rule, match: String.raw`${HASH}(?!\.\d)` }];
  const level = rule.name ? LEVEL_SCOPES.get(rule.name.split(" ").at(-1) ?? "") : undefined;
  return level ? [{ ...rule, name: level }] : [rule];
}

const log: LanguageRegistration[] = upstream.map((grammar) => ({
  ...grammar,
  patterns: grammar.patterns.flatMap(repair),
}));

export default log;
