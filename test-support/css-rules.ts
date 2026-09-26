/**
 * The stylesheet parser the `app/app.css` gates share: `app.css.test.ts` (the
 * integrity gate) and `app.css.perf.test.ts` (ruling 457's CSS ratchets). It
 * reads the one sheet the app has, comments already stripped by the caller,
 * and answers the questions both ask of a rule: which selectors it names, and
 * what the rules naming one selector leave it.
 */

export type Balanced = { body: string; end: number };

/** The balanced `{…}` body starting at `open` (the index OF the brace). */
export function balanced(src: string, open: number): Balanced {
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return { body: src.slice(open + 1, i), end: i };
}

export type CssRule = { selector: string; decls: Map<string, string>; at: string[] };

/**
 * Every rule in the sheet: selector resolved through CSS nesting, declarations
 * separated from nested blocks, and the at-rule context it sits under.
 * `@keyframes` / `@font-face` bodies are not rules and are skipped.
 */
export function cssRules(css: string, parent = "", at: string[] = []): CssRule[] {
  const out: CssRule[] = [];
  for (let i = 0; ; ) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const head = css.slice(i, open).trim();
    const { body, end } = balanced(css, open);
    i = end + 1;
    if (!head || head.startsWith("@keyframes") || head.startsWith("@font-face")) continue;
    if (head.startsWith("@")) {
      out.push(...cssRules(body, parent, [...at, head]));
      continue;
    }
    const selector = head
      .split(",")
      .map((s) => s.trim())
      .map((s) => (parent ? (s.includes("&") ? s.replace(/&/g, parent) : `${parent} ${s}`) : s))
      .join(", ");
    let rest = body;
    for (;;) {
      const nested = rest.indexOf("{");
      if (nested < 0) break;
      const cut = rest.lastIndexOf(";", nested);
      const { body: nb, end: ne } = balanced(rest, nested);
      out.push(...cssRules(`${rest.slice(cut + 1, nested).trim()}{${nb}}`, selector, at));
      rest = rest.slice(0, cut + 1) + rest.slice(ne + 1);
    }
    const decls = new Map<string, string>();
    for (const d of rest.split(";")) {
      const colon = d.indexOf(":");
      if (colon < 0) continue;
      const prop = d.slice(0, colon).trim();
      // Standard properties are letters/hyphens; custom properties may carry
      // digits (a digit-bearing token used to be silently INVISIBLE to every
      // gate built on this parser — found when --tint-1 resolved nowhere).
      if (!/^[a-z-]+$/i.test(prop) && !/^--[\w-]+$/.test(prop)) continue;
      decls.set(prop, d.slice(colon + 1).trim());
    }
    if (decls.size) out.push({ selector, decls, at });
  }
  return out;
}

/** Split a list on TOP-LEVEL commas: a function's arguments, a `transition`'s
 *  layers, a selector list (`:not(a, b)` stays one selector). */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The selectors a rule names, one per entry of its selector list. */
export function selectorParts(rule: CssRule): string[] {
  return splitArgs(rule.selector);
}

/** What `rules` leave `selector`: the declarations of every rule that names it
 *  exactly, later ones winning. Empty when none does. */
export function declsFor(rules: readonly CssRule[], selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    if (selectorParts(rule).includes(selector)) for (const [prop, value] of rule.decls) out.set(prop, value);
  }
  return out;
}

/** `declsFor` a selector the sheet must style: with no rule naming it this
 *  throws, so a check that reads nothing off it cannot pass. */
export function requiredDecls(rules: readonly CssRule[], selector: string): Map<string, string> {
  if (!rules.some((rule) => selectorParts(rule).includes(selector))) {
    throw new Error(`${selector} must have a rule`);
  }
  return declsFor(rules, selector);
}
