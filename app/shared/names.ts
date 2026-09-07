/**
 * Display names as a person meant them (pass 35, U35-1).
 *
 * The controller stored `Test &amp; CI Engineer` verbatim: the model had
 * HTML-escaped its own tool input, the writer trimmed and kept it, the id was
 * slugified from the escaped text (`test-amp-ci-engineer`) and React then
 * escaped the stored `&amp;` a second time, so every card printed the entity
 * literally. A name is text a person reads, never markup, so the five XML
 * entities and numeric character references are decoded ONCE here, whitespace
 * is collapsed, and a name that still carries angle brackets or control
 * characters is refused by the writer with `displayNameRefusal`'s sentence.
 *
 * Client-safe (no `.server` suffix): the same rule serves a form's own
 * validation and the server writers, so the two can never disagree about what
 * a name is.
 */

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** One decode pass: `&amp;` → `&`, `&#39;` → `'`, `&#x26;` → `&`; an entity
 *  nothing here names is left as typed (a name may legitimately mention one). */
function decodeEntities(raw: string): string {
  return raw.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (whole, body: string) => {
      const lower = body.toLowerCase();
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITIES.get(lower) ?? whole;
    },
  );
}

/**
 * The name as a person meant it: entities decoded once, whitespace collapsed
 * to single spaces, trimmed. Ids are derived from THIS text, never from the
 * raw input.
 */
export function normalizeDisplayName(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/** Control characters (C0 and DEL) never belong in a name a card renders. */
function hasControlCharacter(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The refusal sentence for a name that is still markup after normalization,
 * or null when the name is acceptable. Angle brackets are refused rather than
 * stripped: silently rewriting `<b>x</b>` to `x` would store a name nobody
 * typed.
 */
export function displayNameRefusal(name: string): string | null {
  if (/[<>]/.test(name) || hasControlCharacter(name)) {
    return "Names cannot contain < or > or control characters.";
  }
  return null;
}
