import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCssVariablesTheme } from "shiki/core";
import { describe, expect, it } from "vitest";
import { escapeRegExp } from "~/shared/text/regexp";
import { STAGE_COLORS } from "~/shared/workflow/stage-colors";
import { THEME_OPTIONS, toToken } from "~/ui/code-highlight";
import { CLEAR_PART } from "~/ui/collapsible";
import {
  balanced,
  cssRules,
  declsFor,
  requiredDecls,
  selectorParts,
  splitArgs,
  type CssRule,
} from "../test-support/css-rules";

/**
 * Stylesheet-integrity gate for `app/app.css`, the app's ONLY stylesheet.
 *
 * Two whole classes of defect have shipped repeatedly because nothing checks
 * CSS the way `tsc` checks TypeScript — an undefined token or an undefined
 * class is silently dropped by the browser, so the page still renders, just
 * wrong:
 *
 *   P13-D-18 — 11 `var(--x)` references to tokens declared nowhere. Seven had
 *     no fallback, so the whole declaration was thrown away: the entire
 *     Scheduled re-runs panel rendered with no border and no background, in
 *     both themes.
 *   P13-D-19 — four class names used in TSX that no rule defines, including two
 *     primary CTAs that fell back to the plain grey `.btn`. The check that
 *     shipped with it named those four by hand, so the next nine went
 *     unnoticed for three passes (P16-UI-02: `composer-input`, `mention-menu`,
 *     `cred-manage`, `cursor`, `faint`, `ho-exc`, `trans-list`,
 *     `ntf-truncated`, `rsrc-wrap`). It now scans every `className` literal in
 *     `app/` instead — see the last describe block.
 *   P13-D-12 — `--faint` (3.58:1) and `--placeholder` (2.37:1) carried small
 *     body text on white while `prd.md` promised a WCAG 2.2 AA baseline and the
 *     profile page asserted it to the user.
 *
 * These are static properties of the stylesheet, so they are checked
 * statically. The e2e axe run (`e2e/07-accessibility.spec.ts`) is the
 * rendered-page counterpart; this file fails in milliseconds and names the
 * offending token.
 *
 * Pass 16 added four more properties in the same spirit — things a browser
 * renders happily and only a human on the right device would ever notice:
 *
 *   P16-F7 — a hover-revealed control on a device with no hover. `opacity: 0`
 *     still hit-tests, so a finger lands on a button nothing on screen names.
 *   P16-F6 — two elements with the same silhouette and different behaviour (a
 *     search FIELD and a dialog TRIGGER).
 *   P16-F8 — one breakpoint value copied into nine unrelated blocks, so a
 *     change to "the collapse width" was nine edits and eight easy misses.
 *   P16-F3 — static styling living in JSX `style={{…}}` instead of here, where
 *     no theme, density or breakpoint rule can reach it.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("./app.css", import.meta.url)),
  "utf8",
);

/** Comments legitimately name dead tokens (that is what the fix notes say), so
 *  every check below runs against the declaration text only. */
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first `selector { … }` block in the sheet. The
 *  start is not anchored (`.x` also matches the tail of `.y .x {`); the
 *  controller-layout suite's `ruleBody` is the anchored variant. */
function decls(selector: string): string {
  const re = new RegExp(escapeRegExp(selector) + "\\s*\\{([^}]*)\\}");
  const m = CODE.match(re);
  expect(m, selector).not.toBeNull();
  return m![1];
}

/** `--x: value;` at the start of a declaration — i.e. a custom property being
 *  DEFINED, not one being read inside `var()`. */
function declaredTokens(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/(?:^|[{;])\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]),
  );
}

function referencedTokens(css: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}

/* --------------------------------------------------------------- contrast */

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` string. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` strings. */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Read a literal hex token out of a specific `:root` block. */
function tokenIn(block: string, name: string): string {
  const m = block.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"));
  if (!m) throw new Error(`${name} is not a literal hex in this block`);
  return m[1].toLowerCase();
}

const LIGHT_ROOT = CODE.slice(CODE.indexOf(":root {"), CODE.indexOf("* { box-sizing"));
const DARK_ROOT = CODE.slice(
  CODE.indexOf(':root[data-theme="dark"] {'),
  CODE.indexOf(
    "}",
    CODE.indexOf("--shadow-pop", CODE.indexOf(':root[data-theme="dark"] {')),
  ),
);

/* ------------------------------------------------------------------ tests */

describe("app.css custom properties (P13-D-18)", () => {
  it("every var(--x) reference resolves to a declared token", () => {
    const declared = declaredTokens(CODE);
    const undefinedTokens = [...referencedTokens(CODE).keys()]
      .filter((t) => !declared.has(t))
      .sort();
    // Named, not counted: a bare count sends the next person back to diffing
    // the stylesheet by hand — which is exactly how these survived.
    expect(undefinedTokens).toEqual([]);
  });
});

describe("app.css keyboard focus ring (P16-UI-01)", () => {
  /** The `:where(…):focus-visible` block, declarations only. */
  const ringRule = CODE.match(/:where\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*:focus-visible\s*\{([^}]*)\}/);

  it("declares one app-wide :focus-visible ring on the brand accent", () => {
    // Before this, exactly four selectors had a focus ring and every other
    // button, link, chip and menu item fell back to the UA outline — which
    // matches nothing in the design language and differs per theme. axe does
    // not catch it (2.4.7 / 2.4.11 are manual), so it is checked here.
    expect(ringRule, "the app-wide :focus-visible rule must exist").toBeTruthy();
    expect(ringRule![2]).toMatch(/outline:\s*2px solid var\(--blue\)/);
    expect(ringRule![2]).toMatch(/outline-offset:/);
  });

  it("covers the control kinds the markup actually uses", () => {
    const selector = ringRule![1];
    for (const part of [
      "a[href]",
      "button",
      "summary",
      "select",
      "input",
      "textarea",
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="switch"]',
    ]) {
      expect(selector, `${part} must carry the ring`).toContain(part);
    }
    // tabindex="-1" is programmatic focus (skip-link target, dialog panel,
    // roving-tabindex resting item) — a ring around a whole region is noise.
    expect(selector).toContain('[tabindex="0"]');
    expect(selector).not.toContain('[tabindex="-1"]');
  });

  it("the ring colour clears 3:1 against every surface it lands on", () => {
    // WCAG 1.4.11: a focus indicator needs 3:1 against its adjacent colours.
    // This is what stops --blue drifting lighter for aesthetic reasons.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      const blue = tokenIn(block, "--blue");
      for (const against of ["--bg", "--surface"] as const) {
        expect(
          contrastRatio(blue, tokenIn(block, against)),
          `${theme} --blue (${blue}) vs ${against}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("app.css dead-and-drifted rules (P16-UI-04)", () => {
  // Five rules that were doing nothing, doing it twice, or doing it to the
  // wrong element. Each one read like live intent to the next person, which is
  // the cost — a stylesheet you cannot trust is one you stop reading.

  it("declares --font-display exactly once", () => {
    // It was declared twice: the Roobert-first stack in the token block at the
    // top, and an overriding `:root { --font-display: "Manrope" }` 2600 lines
    // down. Manrope won, so the token block — the first place anyone looks —
    // gave the wrong answer. Ruling 365: Inter is the one UI face, so the
    // display token and the body token name the same family.
    const declarations = [...CODE.matchAll(/--font-display\s*:/g)];
    expect(declarations.length).toBe(1);
    expect(CODE).toMatch(/--font-display:\s*"Inter"/);
    expect(CODE).toMatch(/--font-body:\s*"Inter"/);
  });

  it("clears the UA button background in the element reset", () => {
    // The reset took `font`, `color` and `cursor` but left `background`, so a
    // button whose class declares no surface kept `ButtonFace` — which Chrome
    // resolves per color-scheme: #efefef light, #6b6b6b dark. `.nav-item` (the
    // settings tab rail) hit exactly that, and the mid-grey block dropped
    // `--muted` to 3.2:1 and its `.count` to 1.9:1 in dark. Caught by the axe
    // sweep this pass extended to org settings; pinned here because the sweep
    // only covers the buttons that happen to be on an audited surface.
    const reset = CODE.match(/\nbutton\s*\{[^}]*\}/)?.[0] ?? "";
    expect(reset).not.toBe("");
    expect(reset).toMatch(/background:\s*none/);
  });

  it("paints the board scroll fade only when there is something to scroll to", () => {
    // It used to paint unconditionally, tinting the right edge of a board that
    // fits and of a board already scrolled to its end. Driven by the board's
    // own scroll progress now; the base state MUST be hidden, because an
    // inactive timeline (no overflow) produces no animation output and the base
    // is what stands.
    expect(CODE).toMatch(/\.board\s*\{[^}]*scroll-timeline:\s*--board-scroll-x inline/);
    expect(CODE).toMatch(/\.board-wrap\s*\{[^}]*timeline-scope:\s*--board-scroll-x/);
    const fade = CODE.match(/\.board-wrap::after\s*\{([^}]*)\}/);
    expect(fade).toBeTruthy();
    expect(fade![1], "the base state must be hidden").toMatch(/opacity:\s*0\s*;/);
    expect(fade![1]).toMatch(/animation-timeline:\s*--board-scroll-x/);
  });

  it("lets each `.live-table` own its own column template", () => {
    // The shared rule carried the agents roster's five columns and `.gh-table`
    // overrode them, so editing the roster silently moved GitHub's branches
    // table. Two tables, two templates, one shared chrome rule.
    const shared = CODE.match(/(?:^|[};])\s*\.live-head,\s*\.live-row\s*\{([^}]*)\}/);
    expect(shared, "the shared rule must exist").toBeTruthy();
    expect(shared![1], "the shared rule must not pick a column count").not.toMatch(
      /grid-template-columns/,
    );
    expect(CODE).toMatch(/\.live-wrap \.live-head,\s*\.live-wrap \.live-row\s*\{[^}]*grid-template-columns/);
    expect(CODE).toMatch(/\.gh-table \.live-head,\s*\.gh-table \.live-row\s*\{[^}]*grid-template-columns/);
  });

  it("makes `.stg-x` neutral by default and names its destructive sites", () => {
    // `.stg-x` is the generic 24px row-action button now (browse, re-scan,
    // test, edit, enable, disable, dismiss AND remove), but its hover was
    // destructive coral for every one of them, with two `.rsrc-row` rules
    // patching the semantics back — so "Edit" hovered on a coral tint with
    // neutral text, which is neither.
    const hover = CODE.match(/(?:^|[};])\s*\.stg-x:hover\s*\{([^}]*)\}/);
    expect(hover, "`.stg-x:hover` must exist").toBeTruthy();
    expect(hover![1], "the default hover must not be destructive").not.toContain("coral");
    expect(hover![1]).toMatch(/color:\s*var\(--fg\)/);
    // The destructive treatment is opt-in: by position where the row's remove
    // IS its last control, and by name (`.destructive`) where it is not —
    // ruling 150(c): ruling 149's Disable sits before the user row's Remove.
    expect(CODE).toMatch(/\.rsrc-acts \.stg-x:last-child:not\(\.off\):hover/);
    expect(CODE).toMatch(/\.member-row \.stg-x:last-child:not\(\.off\):hover/);
    expect(CODE).toMatch(/\.stg-x\.destructive:not\(\.off\):hover/);
  });

  it("puts the grab cursor on the row that drags, not on the missing grip", () => {
    // The stage list is gripless (board parity). `.stg-handle` kept
    // `cursor: grab` + `:active { cursor: grabbing }` on a 22px square that now
    // holds only a lock glyph — a cursor promising a gesture it cannot answer.
    const handle = CODE.match(/(?:^|[};])\s*\.stg-handle\s*\{([^}]*)\}/);
    expect(handle, "`.stg-handle` must still exist for row alignment").toBeTruthy();
    expect(handle![1]).not.toMatch(/cursor:/);
    expect(CODE).not.toMatch(/\.stg-handle:active/);
    // The affordance mirrors the board's exactly — one drag idiom, one cursor.
    expect(CODE).toMatch(/\.stg-row\.draggable\s*\{[^}]*cursor:\s*grab/);
    expect(CODE).toMatch(/\.stg-row\.draggable:active\s*\{[^}]*cursor:\s*grabbing/);
    expect(CODE).toMatch(/\.card-wrap\.draggable\s*\{[^}]*cursor:\s*grab/);
  });

  it("offers a right-anchored `.own-menu` variant instead of an inline style", () => {
    const rule = CODE.match(/\.own-menu\.to-right\s*\{([^}]*)\}/);
    expect(rule).toBeTruthy();
    expect(rule![1]).toMatch(/left:\s*auto/);
    expect(rule![1]).toMatch(/right:\s*0/);
    // §4.1: a menu grows from the edge that touches its trigger. Re-anchoring
    // without moving the origin is the tell that it was done by hand.
    expect(rule![1]).toMatch(/transform-origin:\s*top right/);
  });

  it("pushes the store strip's action GROUP right, not every button in it", () => {
    // `.store-strip .btn { margin-left: auto }` is a descendant selector, so
    // both maintenance buttons took an auto margin and floated apart with the
    // explanatory label stretched between them.
    expect(CODE).not.toMatch(/\.store-strip \.btn\s*\{[^}]*margin-left:\s*auto/);
    expect(CODE).toMatch(/\.store-strip > :last-child\s*\{[^}]*margin-left:\s*auto/);
  });
});

describe("app.css select treatment (P16-UI-05)", () => {
  const base = CODE.match(/(?:^|[};])\s*select\s*\{([^}]*)\}/);

  it("declares one base rule that matches the app's inputs", () => {
    // Four ad-hoc select looks shipped before this: `.op-sel`,
    // `.sched-controls select`, `.fm-toolbar select`, and an inline
    // `selectStyle` in create-profile-modal.tsx whose comment said the design
    // system had no select rule.
    expect(base, "a base `select` rule must exist").toBeTruthy();
    // Pass 30: functional control boundaries moved to --border-control (the
    // 3:1 non-text token); --border stays on decorative frames.
    expect(base![1]).toMatch(/border:\s*1px solid var\(--border-control\)/);
    expect(base![1]).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(base![1]).toMatch(/background:\s*var\(--surface\)/);
    expect(base![1]).toMatch(/color:\s*var\(--fg\)/);
    // The one variant left (the KB destination picker) sizes the base, and
    // never redraws its box.
    const variant = declsFor(RULES.filter((r) => r.at.length === 0), ".fm-toolbar select");
    expect(variant.size).toBeGreaterThan(0);
    expect([variant.has("border"), variant.has("background")]).toEqual([false, false]);
  });
});

describe("app.css secondary text tokens meet WCAG AA (P13-D-12)", () => {
  const AA_SMALL_TEXT = 4.5;

  it("keeps the --muted > --faint > --placeholder subordination in both themes", () => {
    // AA compresses the ladder; it must not invert it. Secondary text stays
    // secondary — the fix is legibility, not promotion to body weight.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      const surface = tokenIn(block, "--surface");
      const ratios = (["--muted", "--faint", "--placeholder"] as const).map((t) =>
        contrastRatio(tokenIn(block, t), surface),
      );
      expect(ratios[0], `${theme} --muted vs --faint`).toBeGreaterThan(ratios[1]);
      expect(ratios[1], `${theme} --faint vs --placeholder`).toBeGreaterThan(ratios[2]);
    }
  });

  it("holds 4.5:1 for both tokens over the --tint-hover every row takes under the pointer", () => {
    // `.live-head`, `.cap-matrix-table tr.grp td` and `.field input[disabled]`
    // put --placeholder / --faint text on `color-mix(--fg, transparent 96-97%)`,
    // which is measurably darker than --surface. Interface review 2026-09-24
    // (colo-3): the gate mixed 4%, and missed the 5% --tint-hover that a
    // hovered `.rq-row`, `.ntf-item` or `.ctl-conv` paints under its
    // --placeholder timestamp: dark #868d9f measured 4.46:1 there. The mix is
    // now the darkest one secondary text sits on, read off the token itself
    // so a deeper --tint-hover is measured too. CANARY: set the dark
    // --placeholder back to #868d9f.
    for (const [theme, tokens] of THEMES) {
      const surface = resolveColor("var(--surface)", tokens)!.rgb;
      const tint = asHex(over(resolveColor("var(--tint-hover)", tokens)!, surface));
      for (const token of ["--faint", "--placeholder"]) {
        expect(
          contrastRatio(asHex(resolveColor(`var(${token})`, tokens)!.rgb), tint),
          `${theme} ${token} on --tint-hover over --surface (${tint})`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
    }
  });

  it("holds 4.5:1 for --faint on the --blue-soft selection fill", () => {
    // Pass 30: a selected decision-packet option (`.opt.sel`) paints
    // --blue-soft under --faint text (`.opt .od`). The R19-12
    // sweep pairs text only with its own selector part's backdrop, so this
    // sibling-state combination is invisible to it — and the dark pair clears
    // AA by just 0.17, the thinnest real margin in the sheet. Enumerated here
    // so the margin is guarded rather than commented.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      expect(
        contrastRatio(tokenIn(block, "--faint"), tokenIn(block, "--blue-soft")),
        `${theme} --faint on --blue-soft`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it("the primary CTA and its hover clear 4.5:1 in both themes", () => {
    // The brand accent cannot carry text: white on light --blue is 3.84:1 and
    // on dark --blue 3.19:1, and `.btn.primary` is every primary CTA in the app
    // at 14px/700 — below WCAG's large-text threshold, so 4.5:1 applies. The
    // CTA pair (--cta-bg / --cta-fg) exists precisely so the accent token can
    // stay an accent. Locked here because the failure is invisible by eye.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      const bg = tokenIn(block, "--cta-bg");
      const fg = tokenIn(block, "--cta-fg");
      expect(contrastRatio(fg, bg), `${theme} CTA ${fg} on ${bg}`).toBeGreaterThanOrEqual(
        AA_SMALL_TEXT,
      );
      const hover = tokenIn(block, "--blue-pressed");
      expect(
        contrastRatio(fg, hover),
        `${theme} CTA hover ${fg} on ${hover}`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it("keeps the CTA background distinguishable from the surface it sits on", () => {
    // WCAG 1.4.11: a filled control's own boundary needs 3:1 against its
    // backdrop. This is the constraint that stops "just darken it more".
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      expect(
        contrastRatio(tokenIn(block, "--cta-bg"), tokenIn(block, "--surface")),
        `${theme} CTA background vs --surface`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the control-boundary token at 3:1 on the surface in both themes", () => {
    // Pass 30: WCAG 1.4.11 splits borders into two tokens. --border (1.64:1)
    // may divide content; --border-control is the RESTING boundary of inputs,
    // selects, the toggle track and the search boxes — the only thing that
    // identifies those controls — so it must clear 3:1 like the focus ring
    // and the CTA boundary above.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      expect(
        contrastRatio(tokenIn(block, "--border-control"), tokenIn(block, "--surface")),
        `${theme} --border-control vs --surface`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

/* ------------------------------------------- every class name used in app/ */

/**
 * P16-UI-02. The P13-D-19 gate above named four classes by hand, so it could
 * only ever catch the four it already knew about — and nine more orphans
 * accumulated behind it. This block diffs *every* class name the markup uses
 * against the stylesheet.
 *
 * An orphan class is invisible: the browser drops the unknown selector, the
 * element renders with UA defaults, and the page still looks plausible. That is
 * exactly why it needs a static check rather than a review pass.
 */

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every `class` selector the stylesheet defines, compound parts included —
 *  `.stg-x.off` declares both `stg-x` and `off`. */
function definedClasses(css: string): Set<string> {
  return new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
}

/** The raw text of every `className=` attribute value: a quoted string, or the
 *  full balanced `{…}` expression. */
function classNameExpressions(src: string): string[] {
  const out: string[] = [];
  const re = /className\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      const end = src.indexOf(quote, i + 1);
      if (end > 0) out.push(src.slice(i + 1, end));
      continue;
    }
    if (quote !== "{") continue;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) break;
    }
    out.push(src.slice(i + 1, j));
  }
  return out;
}

/** Inside a `className={…}` expression, plenty of string literals are not class
 *  names: `view === "grid" ? "on" : ""`, `mode.startsWith("kb")`. Drop the ones
 *  in an operand or argument position before harvesting. */
function stripNonClassLiterals(expr: string): string {
  return expr
    .replace(/(?:===|!==|==|!=)\s*(["'])(?:(?!\1).)*\1/g, " ")
    .replace(/(["'])(?:(?!\1).)*\1\s*(?:===|!==|==|!=)/g, " ")
    .replace(/\.\w+\(\s*(["'])(?:(?!\1).)*\1/g, " ");
}

function literalChunks(expr: string): string[] {
  const parts: string[] = [];
  for (const m of expr.matchAll(/"([^"\\]*)"/g)) parts.push(m[1]);
  for (const m of expr.matchAll(/'([^'\\]*)'/g)) parts.push(m[1]);
  // Template literals contribute their static chunks; `${…}` holes are dynamic.
  for (const m of expr.matchAll(/`([^`]*)`/g)) {
    for (const chunk of m[1].split(/\$\{[^}]*\}/)) parts.push(chunk);
  }
  return parts;
}

describe("app.css defines every class the markup uses (P16-UI-02)", () => {
  const defined = definedClasses(CODE);
  const files = sourceFiles(APP_DIR);
  /** class -> the files that use it, for a failure message that can be acted on */
  const used = new Map<string, Set<string>>();
  /** `"pev-ico act-" + r.type` — a static prefix completed at runtime. */
  const prefixes = new Map<string, Set<string>>();

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(path.dirname(APP_DIR), file);
    const expressions = classNameExpressions(src);
    // The one imperative site in the app (`lexical-mention-plugin.tsx`).
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*"([^"]*)"/g)) {
      expressions.push(JSON.stringify(m[1]));
    }
    for (const expr of expressions) {
      const isPlainString = !/[{}`'"]/.test(expr);
      const chunks = isPlainString ? [expr] : literalChunks(stripNonClassLiterals(expr));
      for (const chunk of chunks) {
        for (const token of chunk.split(/\s+/)) {
          if (!token) continue;
          const bucket = token.endsWith("-") ? prefixes : used;
          if (!/^-?[_a-zA-Z][\w-]*$/.test(token.replace(/-$/, "x"))) continue;
          if (!bucket.has(token)) bucket.set(token, new Set());
          bucket.get(token)!.add(rel);
        }
      }
    }
  }

  it("scanned the whole app, not a hand-written list", () => {
    // A silent regression in the scanner (a rename of `app/`, a changed
    // attribute spelling) would turn every assertion below green for free.
    expect(files.length).toBeGreaterThan(150);
    expect(used.size).toBeGreaterThan(500);
    expect(used.has("btn")).toBe(true);
    expect(used.has("panel")).toBe(true);
  });

  it("has a rule for every class name used in app/", () => {
    const orphans = [...used.entries()]
      .filter(([name]) => !defined.has(name))
      // Named with their sites, not counted: a bare count sends the next person
      // back to grepping the tree, which is how P13-D-19 shipped in the first
      // place.
      .map(([name, sites]) => `${name} (${[...sites].sort().join(", ")})`)
      .sort();
    expect(orphans).toEqual([]);
  });

  it("has at least one rule behind every runtime-completed class prefix", () => {
    // `className={"pev-ico act-" + r.type}` cannot be resolved statically, but a
    // prefix that matches NO rule at all is dead for every possible suffix.
    const dead = [...prefixes.entries()]
      .filter(([prefix]) => ![...defined].some((c) => c.startsWith(prefix)))
      .map(([prefix, sites]) => `${prefix}* (${[...sites].sort().join(", ")})`)
      .sort();
    expect(dead).toEqual([]);
  });

  it("keeps the composer's positioning contract in the stylesheet (P16-UI-03)", () => {
    // MentionMenu positions itself absolutely, so it needs a positioned
    // ancestor. It used to be an inline `style={{position:"relative"}}` in
    // timeline.tsx — delete that attribute and it jumps to the viewport. (The
    // placeholder was absolute too until interface review 2026-09-24, layo-12:
    // it now shares the editor's grid cell, pinned in the block at the end.)
    for (const selector of [".composer-box", ".composer-input"]) {
      const rule = CODE.match(
        new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`),
      );
      expect(rule, `${selector} must have a rule`).toBeTruthy();
      expect(rule![1], `${selector} must be a containing block`).toMatch(
        /position:\s*relative/,
      );
    }
  });
});

/* ---------------------------- ruling 166: headless yes, utility classes no --- */

/**
 * Ruling 166 lets an UNSTYLED primitive package (`@base-ui/react`, `radix-ui`)
 * into `app/` on the condition that every element it renders wears a class
 * `app.css` already defines. The orphan-class gate above already fails a
 * Tailwind class that reaches a `className` — but only once someone ships one,
 * and by then the diff is a whole pasted component and the tempting fix is to
 * excuse the class instead of writing its rule.
 *
 * This is the earlier, narrower alarm: it fails the moment a file both imports
 * a primitive and carries utility-shaped classes, which is the signature of a
 * registry component pasted in wholesale rather than a primitive rendered with
 * viberr's own classes. It also pins the dependency half of the ruling, because
 * a Tailwind toolchain in `package.json` is the thing that would make every
 * other check here negotiable.
 */
describe("ruling 166: primitives may ship behaviour, never appearance", () => {
  // SAFETY: the file read is the repo's own `package.json`, which npm itself
  // requires to be a JSON object; only the two dependency maps are read, and
  // both are declared optional here, so a manifest without them still types.
  const PKG = JSON.parse(
    readFileSync(path.join(path.dirname(APP_DIR), "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...PKG.dependencies, ...PKG.devDependencies };

  /** The packages ruling 166 names as the skin, not the behaviour. */
  const FORBIDDEN = [
    "tailwindcss",
    "@tailwindcss/vite",
    "@tailwindcss/postcss",
    "class-variance-authority",
    "tailwind-merge",
    "tw-animate-css",
    "lucide-react",
    "next-themes",
    "shadcn",
    "shadcn-ui",
  ];

  /** Unstyled primitives ruling 166 permits behind an `app/ui/*` boundary. */
  const PRIMITIVES = ["@base-ui/react", "@base-ui-components/react", "radix-ui", "@radix-ui/"];

  /** `bg-primary`, `px-1.5`, `min-w-5`, `size-(--x)`, `rounded-sm` — a utility
   *  class is a known prefix followed by a value, which viberr's flat,
   *  unprefixed vocabulary (`card-top`, `pill`, `rev-stack`) never looks like.
   *  Anchored so `text-meta` style names in app.css cannot match by accident:
   *  the tail must be numeric, a bracket/paren value, or a Tailwind colour. */
  const UTILITY =
    /^(?:bg|text|border|ring|shadow|rounded|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|min-h|max-w|max-h|gap|space|flex|grid|col|row|items|justify|self|z|opacity|size|inset|top|left|right|bottom|leading|tracking|font|whitespace|overflow|outline|transition|duration|ease|animate)-(?:\d|\[|\()|^(?:bg|text|border|ring)-(?:primary|secondary|muted|accent|destructive|foreground|background|card|popover|input|border)(?:-|$)/;

  it("carries no Tailwind or shadcn toolchain in package.json", () => {
    const present = FORBIDDEN.filter((name) => name in deps);
    expect(
      present,
      "ruling 166 permits behaviour packages only — these are the skin",
    ).toEqual([]);
  });

  it("no file that imports a primitive also ships utility classes", () => {
    const offenders: string[] = [];
    let importers = 0;
    for (const file of sourceFiles(APP_DIR)) {
      const src = readFileSync(file, "utf8");
      const importsPrimitive = PRIMITIVES.some(
        (p) => src.includes(`from "${p}`) || src.includes(`from '${p}`),
      );
      if (!importsPrimitive) continue;
      importers++;
      const utilities = new Set<string>();
      for (const expr of classNameExpressions(src)) {
        for (const chunk of literalChunks(stripNonClassLiterals(expr))) {
          for (const name of chunk.split(/\s+/).filter(Boolean)) {
            if (UTILITY.test(name)) utilities.add(name);
          }
        }
      }
      if (utilities.size > 0) {
        const rel = path.relative(path.dirname(APP_DIR), file);
        offenders.push(`${rel} — ${[...utilities].sort().join(" ")}`);
      }
    }
    // The scan must reach the primitives the app renders (the radio segment
    // and the user menu today), or it passes everything.
    expect(importers).toBeGreaterThanOrEqual(2);
    expect(
      offenders,
      "a primitive must be rendered with app.css class names, not pasted with its skin",
    ).toEqual([]);
  });

  it("recognises a utility class when it sees one", () => {
    // Canary: without this the check above passes for the wrong reason, since
    // it is vacuously green until the first primitive lands.
    for (const util of [
      "bg-primary",
      "text-muted-foreground",
      "px-1.5",
      "min-w-5",
      "size-(--icon-tile-size)",
      "rounded-[8px]",
      "gap-1",
    ]) {
      expect(UTILITY.test(util), `${util} must read as a utility class`).toBe(true);
    }
    // …and must not fire on viberr's own flat, unprefixed vocabulary.
    for (const own of [
      "card-head",
      "rev-stack",
      "avatar-group",
      "agent-glyph",
      "label-chip",
      "own-menu",
      "text-col",
      "grid-view",
      "flex-foot",
    ]) {
      expect(UTILITY.test(own), `${own} is a viberr class, not a utility`).toBe(false);
    }
  });
});

/* ------------------------------------------------- W5: F7 / F6 / F8 / G3 */

describe("app.css hover-revealed board actions (P16-F7)", () => {
  it("still hides `.card-move` behind hover on a pointer device", () => {
    // The reveal is not the defect — a button drawn on every card at every
    // width would compete with the drag gesture that owns the whole card.
    expect(CODE).toMatch(/\.card-move\s*\{[^}]*opacity:\s*0\s*;/);
    expect(CODE).toMatch(/\.card-wrap:hover \.card-move, \.card-move:focus-within\s*\{[^}]*opacity:\s*1/);
  });

  it("draws it unconditionally where hover cannot happen", () => {
    // Without this the control is invisible-but-hit-testable in the card's
    // top-right corner on every phone and tablet — the exact hazard `.fm-acts`
    // was deleted for, and the one the KB browser's `.rsrc-acts` fixed.
    const hoverNone = CODE.match(/@media \(hover: none\)\s*\{([\s\S]*?)\n\}/);
    expect(hoverNone, "a `(hover: none)` block must exist").toBeTruthy();
    expect(hoverNone![1]).toMatch(/\.card-move\s*\{[^}]*opacity:\s*1/);
  });
});

describe("app.css search field vs palette trigger (P16-F6)", () => {
  /** Declarations of `button.top-search` — the workspace's palette trigger. */
  const trigger = CODE.match(/(?:^|[};])\s*button\.top-search\s*\{([^}]*)\}/);
  const box = CODE.match(/(?:^|[};])\s*\.top-search\s*\{([^}]*)\}/);

  it("keeps one silhouette for both (R15-5)", () => {
    // The trigger inherits the field's box on purpose: the topbar's truncation
    // tiers (1080/760/720) target `.top-search` and would need three more
    // copies if the two shapes diverged.
    expect(box![1]).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(trigger![1], "the trigger must not re-declare the box").not.toMatch(
      /border-radius:|border:\s/,
    );
  });

  it("gives the trigger a filled face the field does not have", () => {
    // Before this the two were pixel-identical: a <div> you type into and a
    // <button> that opens a dialog, same border, same white fill, same grey
    // text. Filled = a control, plain well = a field, which is the distinction
    // the rest of the sheet already draws.
    expect(box![1]).toMatch(/background:\s*var\(--surface\)/);
    // Pass 30: the fill comes from the neutral tint ladder (same composite the
    // old surface+fg mix produced, spelled as the token).
    expect(trigger![1]).toMatch(/background:\s*var\(--tint-(well|hover|press)\)/);
  });

  it("labels the trigger instead of faking a placeholder", () => {
    // `--placeholder` is the colour of text a user is invited to overwrite.
    // "Search…" on the button is a LABEL — nothing is typed there.
    const label = CODE.match(/(?:^|[};])\s*\.top-search-label\s*\{([^}]*)\}/);
    expect(label![1]).toMatch(/color:\s*var\(--muted\)/);
    expect(CODE).toMatch(/\.top-search input::placeholder\s*\{[^}]*var\(--placeholder\)/);
  });

  it("the label clears 4.5:1 on the fill it sits on, at rest and under the pointer", () => {
    // The trigger's face is an --fg tint over --surface, and its hover a
    // deeper one, so the label is no longer measured against plain white or
    // plain dark. Both fills are read off the trigger's own rules.
    const fills = ["button.top-search", "button.top-search:hover"].map((selector) => {
      const fill = RULES.find((r) => r.at.length === 0 && r.selector === selector)?.decls.get("background");
      expect(fill, `${selector} paints a tint`).toMatch(/^var\(--tint-(well|hover|press)\)$/);
      return fill!;
    });
    for (const [theme, tokens] of THEMES) {
      const surface = resolveColor("var(--surface)", tokens)!.rgb;
      const label = asHex(resolveColor("var(--muted)", tokens)!.rgb);
      for (const fill of fills) {
        const face = asHex(over(resolveColor(fill, tokens)!, surface));
        expect(contrastRatio(label, face), `${theme} --muted on ${fill} (${face})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/**
 * P16-F8. Every width breakpoint in the sheet, with the job it does. This map
 * IS the documentation — CSS custom properties cannot be used inside a media
 * query and `@custom-media` would need a build plugin this project does not
 * run, so the number lives in exactly one place per breakpoint and this test is
 * what makes that stick. Adding a rule at an existing breakpoint costs nothing;
 * inventing a tenth value (a stray `1120px` "just for this panel") fails here
 * until someone names what it means.
 */
const BREAKPOINTS = {
  "max-width: 1400px": "board columns tighten before any layout reflows",
  "max-width: 1100px": "THE TWO-COLUMN COLLAPSE — every 2-up layout goes 1-up",
  "width > 1100px": "the collapse's exact complement: the controller's full-height band (ruling 524(a))",
  "max-width: 1080px": "topbar tier 1 — brand wordmark, root crumb, shortcut chip",
  "max-width: 1000px": "settings tab rail goes horizontal",
  "max-width: 900px": "home topbar collapses to the palette; project-row stats drop",
  "min-width: 900px": "the login page's brand aside moves beside the card (the one min-width)",
  "max-width: 760px": "topbar tier 2 — the middle crumb",
  "max-width: 720px": "MOBILE SHELL — the project rail becomes an overlay",
  "max-width: 560px": "phone-width home rows — the pipeline meter yields",
} satisfies Record<string, string>;

describe("app.css breakpoints (P16-F8)", () => {
  /** Every `(max-width: Npx)` / `(min-width: Npx)` / `(width > Npx)` in the
   *  sheet, in order. */
  const widths = [...CODE.matchAll(/\((m(?:in|ax)-width:\s*\d+px|width\s*[<>]=?\s*\d+px)\)/g)].map((m) =>
    m[1].replace(/\s+/g, " "),
  );

  it("uses only the breakpoints this map names", () => {
    const stray = [...new Set(widths)].filter((w) => !(w in BREAKPOINTS)).sort();
    // Named, not counted: the fix for a stray is either "use the existing tier"
    // or "add it here with what it means", and the reader needs the value.
    expect(stray).toEqual([]);
  });

  it("declares each breakpoint exactly once", () => {
    // This is the whole mechanism. `max-width: 1100px` was NINE blocks spread
    // over 2800 lines doing unrelated jobs, so changing the collapse width was
    // nine edits and eight of them were easy to miss. One block per value means
    // a half-update is not expressible.
    const counts = new Map<string, number>();
    for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1);
    const duplicated = [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([w, n]) => `${w} × ${n}`)
      .sort();
    expect(duplicated).toEqual([]);
  });

  it("a complement starts exactly where the breakpoint it names ends", () => {
    // Ruling 524(a): the controller's band is `(width > 1100px)`, the
    // collapse's complement, so no zoomed width falls between the two blocks
    // (a `min-width: 1101px` left 1100.5px in neither). A complement is the
    // one breakpoint whose number another one owns, so it must move with it.
    // CANARY: move the collapse to 1200px and leave the band at 1100px.
    const complements = Object.keys(BREAKPOINTS).filter((w) => w.startsWith("width > "));
    expect(complements).not.toEqual([]);
    for (const w of complements) {
      expect(Object.keys(BREAKPOINTS), w).toContain(`max-width: ${w.slice("width > ".length)}`);
    }
  });

  it("every named breakpoint is actually used", () => {
    // The map documents the sheet; an entry with no block is a stale comment.
    const unused = Object.keys(BREAKPOINTS).filter((w) => !widths.includes(w)).sort();
    expect(unused).toEqual([]);
  });

  it("the 1100px block still carries all eight collapses", () => {
    // Regression anchor for the consolidation: these are the rules the nine
    // scattered blocks held. `.board { grid-auto-columns }` is deliberately NOT
    // among them — the 1400px block sets the same value later, so the 1100px
    // copy could never win and was dropped rather than carried.
    const block = CODE.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/);
    expect(block, "the consolidated block must exist").toBeTruthy();
    for (const selector of [
      ".field-row",
      ".detail",
      ".agents-layout",
      ".policy-cols",
      ".activity-cols",
      ".profile-cols",
      ".rq-row",
      ".pj-row .pj-stats .pill",
    ]) {
      expect(block![1], `${selector} must still collapse at 1100px`).toContain(selector);
    }
    // U39-11: the log line's collapse follows the CONSOLE's width, not the
    // viewport's; at 1100px it only narrowed the columns and left a phone's
    // text 89px wide. CANARY: drop the console's container query.
    expect(block![1], "the log line collapses on its console's width now").not.toContain(".log-line");
    expect(CODE.match(/\n\.console \{([^}]*)\}/)?.[1]).toMatch(/container-type:\s*inline-size/);
    const narrowConsole = [...CODE.matchAll(/@container \(max-width: 30rem\)\s*\{([\s\S]*?)\n\}/g)].find((m) =>
      m[1]!.includes(".log-line"),
    );
    expect(narrowConsole, "the narrow-console container query must exist").toBeTruthy();
    expect(narrowConsole![1]).toMatch(/\.log-line \.lx\s*\{\s*grid-column:\s*1 \/ -1;\s*\}/);
  });

  /**
   * U7 / U35-2 — the task detail's three regions are ordered in the MARKUP
   * (task-detail-page.tsx: `.detail-head`, then `.detail-side`, then
   * `.detail-main`, asserted in task-disposition.test.tsx) and placed by grid
   * cell here, so the sighted stack and the screen-reader/focus order are the
   * same order at every width.
   *
   * Pass 20 did it with `order: -1` in the 1100px block instead, which fixed the
   * paint and left a keyboard user tabbing to "Accept completion → Done" LAST,
   * after every timeline entry (WCAG 2.2 SC 1.3.2 / 2.4.3). Re-adding `order`
   * to any region would silently reopen that split, so the sheet is pinned
   * against it: the desktop arrangement must come from placement, and the
   * stacked one from source order. Pass 35 (U35-2) added the head region: the
   * title and goal come first, so a phone reads them before the metadata
   * panels instead of two screens after them. Owner, 2026-09-08: the open
   * packet is its own region right after the head — on desktop it opens the
   * MAIN column (row 2, column 1) while main auto-places under the packet or,
   * without one, into row 2. A head-wide packet had pushed Current state
   * under the packet instead. Owner, 2026-09-09 (ruling 170): the head is the
   * main column's first row and the side column spans rows 1–3, so the
   * GitHub trace that leads it sits beside the goal, in a cell that used to
   * be empty, and the main column's rows are sized by the main column alone.
   */
  it("U7 / U35-2: the detail regions are placed by grid cell — never by `order`", () => {
    const rules = CODE.match(/\.detail-(head|packet|main|side)[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length, "all four regions must still be styled").toBeGreaterThan(3);
    for (const rule of rules) {
      expect(rule, `\`order\` is banned on the detail regions:\n${rule}`).not.toMatch(
        /(^|[\s;{])order\s*:/,
      );
    }
    // The desktop arrangement, stated explicitly so source order cannot decide
    // which side of the page a region lands on: the head opening the main
    // column on the first row, the packet under it on the second, main
    // auto-placed in column 1, and the side column spanning all three rows —
    // into the `1fr` row, so its height never sizes the head's or the packet's.
    expect(CODE).toMatch(/\.detail\s*\{[^}]*grid-template-rows:\s*auto auto 1fr/);
    expect(CODE).toMatch(/\.detail-head\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1/);
    expect(CODE).toMatch(/\.detail-packet\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2/);
    expect(CODE).toMatch(/\.detail-main\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*auto/);
    expect(CODE).toMatch(/\.detail-side\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1 \/ span 3/);
    // And the 1100px collapse releases all four into the single column and
    // drops the explicit rows with them.
    const collapse = CODE.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/)![1];
    expect(collapse).toMatch(/\.detail\s*\{[^}]*grid-template-rows:\s*none/);
    expect(collapse).toMatch(
      /\.detail-head,\s*\.detail-packet,\s*\.detail-main,\s*\.detail-side\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*auto/,
    );
  });
});


describe("app.css palette reachability on touch (P16-G3)", () => {
  it("collapses Home's box to a palette trigger instead of deleting it", () => {
    const narrow = CODE.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow, "the 900px block must exist").toBeTruthy();
    // What replaces it: the input goes, the BUTTON becomes the whole box.
    expect(narrow![1]).toMatch(/\.home-top \.top-search input\s*\{[^}]*display:\s*none/);
    const trigger = narrow![1].match(/\.home-top \.top-search \.kbd\s*\{([^}]*)\}/);
    expect(trigger, "the chip must become the trigger").toBeTruthy();
    expect(trigger![1]).toMatch(/position:\s*absolute/);
    expect(trigger![1]).toMatch(/inset:\s*0/);
    // "⌘K" is not a thing a phone can type; the magnifier is the affordance.
    expect(trigger![1]).toMatch(/font-size:\s*0/);
    expect(narrow![1]).toMatch(/\.home-top \.top-search > \.ico\s*\{[^}]*pointer-events:\s*none/);
  });

  it("takes the trigger's LABEL with it when the box collapses (ruling 145)", () => {
    // The standalone-page header puts a palette BUTTON in `.home-top`'s search
    // box, where Home has an input. The 900 tier squares that box off at 36px,
    // and the 720 tier is where `.top-search-label` normally goes — so between
    // the two the label had nowhere to sit and painted across the bell.
    const narrow = CODE.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow![1]).toMatch(
      /\.home-top \.top-search-label\s*\{[^}]*display:\s*none/,
    );
  });

  it("gives the collapsed triggers a finger-sized target", () => {
    // WCAG 2.5.8 (24×24 minimum); both match `.rail-toggle`'s 34px square.
    const narrow = CODE.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/);
    const homeBox = narrow![1].match(/\.home-top \.top-search\s*\{([^}]*)\}/);
    expect(homeBox![1]).toMatch(/width:\s*36px/);
    expect(homeBox![1]).toMatch(/height:\s*36px/);
    const mobile = CODE.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/);
    expect(mobile![1]).toMatch(/\.top-search\s*\{[^}]*min-height:\s*34px/);
  });
});

/* ------------------------------------------------ W5: F3, inline styles */

/** Markup files only: this file and the component tests quote the attribute as
 *  prose. */
function markupFiles(): string[] {
  return sourceFiles(APP_DIR).filter(
    (f) => f.endsWith(".tsx") && !f.includes(".test."),
  );
}

/** Is this offset inside a `/* … *\/` comment? A fix note that NAMES the idiom
 *  it removed ("`PANEL_COUNT_STYLE` was a copy of `.fine`") is documentation,
 *  not a site — F19-33's own comments pushed the ceiling below from 20 to 22
 *  without a pixel changing. */
function inBlockComment(src: string, index: number): boolean {
  const open = src.lastIndexOf("/*", index);
  return open !== -1 && src.lastIndexOf("*/", index) < open;
}

const lineAt = (src: string, index: number) =>
  src.slice(0, index).split("\n").length;

/** Every `style={{ … }}` expression in `app/`, as `file:line` → object body. */
function inlineStyleSites(): { at: string; body: string }[] {
  const out: { at: string; body: string }[] = [];
  for (const file of markupFiles()) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(path.dirname(APP_DIR), file);
    const re = /style\s*=\s*\{\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (inBlockComment(src, m.index)) continue;
      const { body } = balanced(src, m.index + m[0].length - 1);
      out.push({ at: `${rel}:${lineAt(src, m.index)}`, body });
    }
  }
  return out;
}

/** Every `style={NAME}` whose NAME is a module const bound to an object literal
 *  — the HOISTED twin of `style={{…}}`. Same declarations, same distance from
 *  the sheet; the only difference is that P16-F3's scan above cannot see it,
 *  which is how three surfaces kept a private copy of `.fine` (F19-33). */
function hoistedStyleSites(): { at: string; body: string; name: string }[] {
  const out: { at: string; body: string; name: string }[] = [];
  for (const file of markupFiles()) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(path.dirname(APP_DIR), file);
    const re = /style\s*=\s*\{([A-Za-z_$][\w$]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      if (inBlockComment(src, m.index)) continue;
      const name = m[1];
      const decl = new RegExp(
        `\\bconst\\s+${name}\\b[^=;]*=\\s*\\{`,
      ).exec(src);
      if (!decl) continue; // a prop, a hook result — nothing static to move.
      const { body } = balanced(src, decl.index + decl[0].length - 1);
      out.push({ at: `${rel}:${lineAt(src, m.index)}`, body, name });
    }
  }
  return out;
}

/** A style object's declarations spelled the way CSS spells them, or null when
 *  any value is one the sheet could not hold: an identifier, a template, a
 *  ternary, or a bare non-zero number (React appends `px` — comparing those to
 *  a rem rule would be noise). */
function styleObjectDecls(body: string): Map<string, string> | null {
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (!code.trim()) return null;
  const decls = new Map<string, string>();
  const re = /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z][\w-]*))\s*:\s*([^,]+)/g;
  let m: RegExpExecArray | null;
  let seen = 0;
  while ((m = re.exec(code))) {
    seen++;
    const prop = (m[1] ?? m[2] ?? m[3]!).replace(
      /[A-Z]/g,
      (c) => `-${c.toLowerCase()}`,
    );
    const raw = m[4].trim().replace(/\s*as const\s*$/, "");
    const literal = /^(["'])(.*)\1$/.exec(raw);
    if (literal) decls.set(prop, literal[2].trim().replace(/^0\./, "."));
    else if (/^0$/.test(raw)) decls.set(prop, "0");
    else return null;
  }
  return seen > 0 && decls.size === seen ? decls : null;
}

/** A rule body with any NESTED block removed, its selector with it. Walking
 *  top-level blocks means a body can now contain CSS nesting, and a nested
 *  block's declarations belong to the nested selector — splitting them in with
 *  the rest would both invent properties (`&:hover { color`) and let a hover
 *  value overwrite the base one. Runs to a fixpoint, so nesting can be deep. */
function flatBody(body: string): string {
  let out = body;
  for (let prev = ""; out !== prev; ) {
    prev = out;
    out = out.replace(/(?:^|;)[^;{}]*\{[^{}]*\}/g, ";");
  }
  return out;
}

/** Every TOP-LEVEL rule whose selector is a SINGLE bare class — the sheet's
 *  shared idioms, the ones any surface opts into by name (`.fine`, `.push`,
 *  `.full`). Chains and descendant selectors are component rules, not
 *  utilities: a style object that happens to match `.field.packet-note-field`
 *  is a coincidence, not a fork.
 *
 *  Top-level is the other half of "utility". An innermost-brace scan
 *  (`/([^{}]*)\{([^{}]*)\}/g`) cannot see the `@media` wrapper, so it handed
 *  back all 40 of this sheet's breakpoint-scoped single-class rules as if they
 *  were unconditional — three of them (`.login-wrap-2col`, `.login-aside-mark`,
 *  `.login-aside-points`) exist ONLY inside `@media (min-width: 900px)`, and
 *  the other 37 are overrides of a name that also has a global rule, so the
 *  same selector came back twice with different declarations. Both are wrong
 *  for the fork check below: a style object cannot "restate" a rule that only
 *  applies inside a query — swapping the object for that class would change
 *  how the surface renders everywhere ELSE, which is the opposite of the fix
 *  the failure asks for. And with a selector appearing twice, "the rule named
 *  `.x`" stops being a question `.find` can answer — today the global rule
 *  happens to come first in every one of the 37, which is source order, not a
 *  guarantee. Walking blocks with `balanced()` steps over a nested rule along
 *  with its wrapper, so `@media` / `@supports` / `@container` bodies are out of
 *  scope by construction. */
function utilityRules(css: string): { selector: string; decls: Map<string, string> }[] {
  const out: { selector: string; decls: Map<string, string> }[] = [];
  for (let at = 0; ; ) {
    const open = css.indexOf("{", at);
    if (open < 0) break;
    const selector = css.slice(at, open).trim();
    const { body, end } = balanced(css, open);
    at = end + 1;
    if (!/^\.[-\w]+$/.test(selector)) continue;
    const decls = new Map<string, string>();
    for (const decl of flatBody(body).split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      decls.set(
        decl.slice(0, colon).trim(),
        decl.slice(colon + 1).trim().replace(/^0\./, "."),
      );
    }
    if (decls.size > 0) out.push({ selector, decls });
  }
  return out;
}

const sameDecls = (a: Map<string, string>, b: Map<string, string>) =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

/** A property value the stylesheet could have held: a bare literal. Anything
 *  else — an identifier, a template literal, a ternary, a concatenation — reads
 *  a runtime value the sheet cannot know. */
function isLiteral(value: string): boolean {
  return /^\s*(-?\d+(\.\d+)?|"[^"]*"|'[^']*')\s*$/.test(value);
}

describe("app.css draws a task key the same way everywhere (P16-F3 follow-on)", () => {
  it("gives the list row's key the treatment the grid card's key has", () => {
    // Every `.key` rule is scoped to a container (`.card-top`, `.task-hero`,
    // `.live-task`, `.pj-name`) and the board's LIST row is in none of them, so
    // its key alone rendered in the body face — the same value looking like a
    // different kind of value depending on the view you picked. Surfaced when
    // F3 moved its width out of an inline style and there was nothing else.
    const grid = CODE.match(/\.card-head \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    const list = CODE.match(/\.card\.list-row \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(grid, ".card-head .key must have a rule").not.toBe("");
    expect(list, ".card.list-row .key must have a rule").not.toBe("");
    // Anchored on a declaration boundary so `color` cannot match inside
    // `background-color` and `font-family` cannot match `font-size`.
    const value = (rule: string, prop: string) =>
      new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule)?.[1]?.trim();
    for (const prop of ["font-family", "font-size", "color", "white-space"]) {
      expect(value(list, prop), `${prop} must match the grid card's key`).toBe(
        value(grid, prop),
      );
    }
    // F21-18 residual: the nowrap landed on the grid card alone, so the same key
    // still broke mid-token ("VIB-\n8") in the list row's fixed 64px column (and,
    // then, in the drop preview — which now draws the grid card's own key). A
    // key is ONE identifier on every surface that draws it — reverting either
    // rule fails here.
    for (const [where, rule] of [
      ["grid card", grid],
      ["list row", list],
    ] as const) {
      expect(
        value(rule, "white-space"),
        `the ${where}'s task key must not wrap mid-token`,
      ).toBe("nowrap");
    }
  });
});

/**
 * The acceptance dialog's fact rows (`.obs`) put a label and a value in one
 * grid. The label column was a fixed 92px, which held until F19-3 added a
 * label wider than it — "RECOMMENDATION" — whose text then spilled across the
 * gap and printed over the value beside it (seen live in the acceptance
 * dialog on VC-6). A fixed column silently assumes every future label is
 * short; `minmax` keeps the shared alignment the fixed value was there for
 * and lets the widest label decide the width.
 */
describe("app.css .obs label column fits its longest label (F19-3 follow-on)", () => {
  it("sizes the label column with minmax, not a bare fixed width", () => {
    const rule = /^\.obs \{([^}]*)\}/m.exec(CODE)?.[1];
    expect(rule).toBeTruthy();
    const cols = /grid-template-columns:\s*([^;]+);/.exec(rule!)?.[1]?.trim();
    expect(cols).toBeTruthy();
    // Canary: restore `92px 1fr` and this fails.
    expect(cols).toMatch(/minmax\(/);
    expect(cols).not.toMatch(/^92px\s/);
  });
});

describe("app.css owns static styling, not the JSX (P16-F3)", () => {
  const sites = inlineStyleSites();

  it("scanned the tree, not an empty list", () => {
    // Ruling 364 moved the fifteen stage-colour sites into the sheet (a
    // stage's colour is a NAME the markup carries now), so the floor sits
    // under what is left: the dynamic bar sizes, tree depths and positions.
    expect(sites.length).toBeGreaterThan(5);
  });

  it("leaves no `style={{…}}` whose every value is a literal", () => {
    // THE rule this pass applied: a literal value is a design decision and
    // belongs in the sheet, where a theme or density change can reach it; a
    // value read at runtime (a stage's colour, a tree row's depth, a measured
    // popover position) belongs in the markup, because the sheet cannot know
    // it. 182 sites went to 20 on that rule and every survivor is dynamic.
    const staticSites = sites
      .filter(({ body }) => {
        const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
        const decls = [...code.matchAll(/(?:^|,)\s*[\w"'[\]]+\s*:([^,]*(?:\([^)]*\)[^,]*)*)/g)];
        return decls.length > 0 && decls.every((d) => isLiteral(d[1]));
      })
      .map(({ at, body }) => `${at} — ${body.trim().replace(/\s+/g, " ")}`)
      .sort();
    expect(staticSites).toEqual([]);
  });

  it("holds the line at 12 sites", () => {
    // A ceiling, not a target. It exists because the previous pass moved the
    // `<select>` half of this finding and left the inline-style half, and
    // nothing noticed the count climbing back for three passes. Raised 20 → 22
    // for the two data-driven bar sizes on the Insights dashboard (a bar-fill
    // width and a daily-column height, both a row's share of its max) — the
    // sheet cannot know a runtime percentage, which is exactly the dynamic case
    // this rule exempts. Raised 22 → 23 (pass 29) for the Backend-quota
    // utilization bar on the same dashboard: the same runtime-percentage
    // bar-fill width as its two Insights siblings, under the same exemption.
    // Raised 23 → 24 (pass 30) for the board list row's read-only stage dot:
    // the STAGE's own colour, the exact dynamic-value case already exempted
    // for the task page's identical `.stage-static` dot.
    // Ruling 364: 24 → 12 once the stage colours stopped being inline styles.
    expect(sites.length).toBeLessThanOrEqual(12);
  });
});

/* --------------------------------------------- F19-33: hoisting is no escape */

/**
 * P16-F3 moved literal `style={{…}}` objects into the sheet. Three surfaces
 * kept theirs by lifting them one scope — `const PANEL_COUNT_STYLE = { fontSize:
 * ".76rem", color: "var(--faint)" }` in github-view.tsx, policy-page.tsx and
 * settings-page.tsx, a byte copy of `.fine` that seven other panel heads already
 * write as `className="right sub fine"`. Nothing rendered differently, which is
 * the point: the copies drifted instead (the sibling note const sat at .8rem in
 * settings, .9rem in github-view and .85rem in the sheet), and a theme or
 * density pass reaches none of them. Ruling 14 — one shared implementation, no
 * per-surface forks.
 */
describe("app.css lets a container-sized button wrap (F19-42)", () => {
  // HALF THE GATE. This block binds the RULE and nothing else: a sheet test
  // cannot know whether any element still carries `full`, so dropping the class
  // from the force-accept button re-opens the live defect with every assertion
  // here green (audit §2.4). The CONSUMER half lives in
  // `features/task-detail/task-disposition.test.tsx`
  // ("F19-42: the force-accept button is container-sized"), which renders the
  // button and asserts its className. Both are required; neither is sufficient.
  const btn = CODE.match(/(?:^|[};])\s*\.btn\s*\{([^}]*)\}/);
  const full = CODE.match(/(?:^|[};])\s*\.btn\.full\s*\{([^}]*)\}/);

  it("keeps nowrap on ordinary buttons", () => {
    // Content-sized buttons should never break mid-label; that is what the
    // base rule protects and it stays.
    expect(btn![1]).toMatch(/white-space:\s*nowrap/);
  });

  it("releases it for `.full`, whose width comes from the container", () => {
    // Live defect: R19-5's honest force-accept label
    // ("Force accept (skips the remaining stages and the review gate)")
    // measured scrollWidth 351 against clientWidth 299 and painted 52px
    // outside the GitHub card. A governance affordance is exactly the kind
    // whose label must state the whole consequence, so the button wraps.
    expect(full, ".btn.full must exist to override the base nowrap").not.toBeNull();
    expect(full![1]).toMatch(/white-space:\s*normal/);
    expect(full![1], "a wrapped label needs a readable line-height").toMatch(
      /line-height:\s*[\d.]+/,
    );
  });
});

describe("app.css owns the shared idioms — hoisting is not an escape hatch (F19-33)", () => {
  const utilities = utilityRules(CODE);
  const objects = [
    ...inlineStyleSites().map((s) => ({ ...s, name: "inline" })),
    ...hoistedStyleSites(),
  ];

  it("scanned real utilities and real style objects", () => {
    // A scanner that silently matches nothing turns every assertion green.
    const named = new Set(utilities.map((u) => u.selector));
    for (const selector of [".fine", ".push", ".full", ".tally"]) {
      expect(named.has(selector), `${selector} must be scanned`).toBe(true);
    }
    expect(objects.length).toBeGreaterThan(10);
    expect(objects.some((o) => o.name !== "inline")).toBe(true);
  });

  it("scans UNCONDITIONAL rules only — an @media override is not a utility", () => {
    // A conditional rule cannot be the shared implementation a style object
    // forks: swapping the object for the class would change how the surface
    // renders OUTSIDE the query. `.login-wrap-2col` exists only inside
    // `@media (min-width: 900px)`, and `.rail-toggle` has a global rule plus a
    // `max-width: 720px` override that takes it from one property to nine.
    const named = utilities.filter((u) => u.selector === ".login-wrap-2col");
    expect(named, "media-only rules are not utilities").toEqual([]);
    expect(CODE).toContain(".login-wrap-2col");

    const toggles = utilities.filter((u) => u.selector === ".rail-toggle");
    expect(toggles).toHaveLength(1);
    expect([...toggles[0]!.decls]).toEqual([["display", "none"]]);
    // The nested body is genuinely skipped, not merged into the global rule.
    expect(toggles[0]!.decls.has("place-items")).toBe(false);
  });

  it("no style object restates a utility class's declarations", () => {
    const forks: string[] = [];
    for (const site of objects) {
      const decls = styleObjectDecls(site.body);
      if (!decls) continue; // dynamic, or a value the sheet cannot hold.
      for (const util of utilities) {
        if (sameDecls(decls, util.decls)) {
          forks.push(
            `${site.at} — ${site.name} restates ${util.selector} { ${[...decls]
              .map(([k, v]) => `${k}: ${v}`)
              .join("; ")} }`,
          );
        }
      }
    }
    expect(forks.sort()).toEqual([]);
  });

  it("every panel note takes its spacing from the sheet", () => {
    // `.pol-note` ships `before` / `after` / `last` spacing modifiers, so an
    // inline margin on one is always a fork — that is how the same note ended up
    // three different distances from the panel above it on three surfaces.
    const styled: string[] = [];
    let found = 0;
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(path.dirname(APP_DIR), file);
      for (const m of src.matchAll(/pol-note/g)) {
        if (inBlockComment(src, m.index)) continue;
        const open = src.lastIndexOf("<", m.index);
        if (open < 0) continue;
        found++;
        let depth = 0;
        let end = open;
        for (; end < src.length; end++) {
          if (src[end] === "{") depth++;
          else if (src[end] === "}") depth--;
          else if (src[end] === ">" && depth === 0) break;
        }
        if (/\sstyle\s*=/.test(src.slice(open, end))) {
          styled.push(`${rel}:${lineAt(src, m.index)}`);
        }
      }
    }
    // A scan that finds no note passes everything.
    expect(found).toBeGreaterThan(0);
    expect(styled.sort()).toEqual([]);
    // …and the modifiers the notes use in place of a margin are in the sheet.
    const sheet = RULES.filter((r) => r.at.length === 0);
    expect(requiredDecls(sheet, ".pol-note.after").get("margin-top")).toBe(".75rem");
    expect(requiredDecls(sheet, ".pol-note.last").get("margin-bottom")).toBe("0");
  });
});

/* ================================================== R19-12 · the two gates */

/**
 * Both gates below exist because the two contracts they check were, until now,
 * verified by REVIEW rather than by a gate — and the enumerated tests that
 * looked like gates were hand-lists:
 *
 *   Contrast. `describe("app.css secondary text tokens meet WCAG AA")` above
 *     measured the seven pairs P13-D-12 happened to find. A NEW token, or an
 *     old token used on a new fill, is checked by nobody. INTENT §4 promises
 *     "WCAG 2.2 AA baseline for core workflows in BOTH themes", and the sheet
 *     is the only place that promise can be kept or broken.
 *   Responsive. `BREAKPOINTS` above pins which widths exist; nothing pins what
 *     a breakpoint is allowed to DO. INTENT §4: "No control is hidden or
 *     disabled at any width, and nothing is gated on `matchMedia`" — because
 *     dropping a decision control on a small screen makes the surface
 *     dishonest about what the viewer may do.
 *
 * Both sweeps derive their inputs from the sheet and the markup, so a new rule
 * is in scope the moment it is written. Both carry small exemption maps in
 * which every entry states a reason and an unused entry FAILS — the
 * `ALLOW_SUBSTRINGS` lesson: an escape hatch that nobody has to justify is how
 * a gate rots back into the hand-list it replaced.
 */

// `cssRules` (test-support/css-rules.ts): every rule in the sheet, nesting
// resolved, with the at-rule context it sits under.
const RULES = cssRules(CODE);
/** The rules outside any at-rule: what every viewport and preference gets. */
const plain = RULES.filter((r) => r.at.length === 0);

/* ----------------------------------------------------- colour resolution */

type Rgba = { rgb: [number, number, number]; alpha: number };

/** One `color-mix()` stop: the colour, and the percentage it states (or none). */
type MixStop = { colour: Rgba; weight: number | null };

/**
 * A CSS colour, resolved against one theme's token map. Handles the four forms
 * the sheet uses — hex, `var()` (recursively, with fallbacks), `rgb[a]()` and
 * `color-mix(in srgb, …)` — and returns null for anything else (gradients,
 * `currentColor`, keywords), which the sweep reports rather than skips
 * silently.
 */
function resolveColor(value: string, tokens: Map<string, string>, depth = 0): Rgba | null {
  if (depth > 8) return null;
  const v = value.trim();
  if (!v) return null;
  if (v === "transparent") return { rgb: [0, 0, 0], alpha: 0 };
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const [r, g, b] = Array.from(v.slice(1), (c) => parseInt(c + c, 16));
    return { rgb: [r, g, b], alpha: 1 };
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    return { rgb: [r, g, b], alpha: 1 };
  }
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(v);
  if (ref) {
    const declared = tokens.get(ref[1]);
    if (declared) return resolveColor(declared, tokens, depth + 1);
    return ref[2] ? resolveColor(ref[2], tokens, depth + 1) : null;
  }
  const rgbFn = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (rgbFn) {
    const parts = rgbFn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return {
      rgb: [parts[0], parts[1], parts[2]],
      alpha: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1,
    };
  }
  const mix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/i.exec(v);
  if (mix) {
    const args = splitArgs(mix[1]);
    if (args.length !== 2) return null;
    const stops: MixStop[] = [];
    for (const arg of args) {
      const pct = /^([\s\S]*?)\s+(\d+(?:\.\d+)?)%$/.exec(arg);
      const colour = resolveColor(pct ? pct[1] : arg, tokens, depth + 1);
      if (!colour) return null;
      stops.push({ colour, weight: pct ? Number(pct[2]) : null });
    }
    const [a, b] = stops;
    // A stop that states no percentage takes the remainder; with neither
    // stated the two split the mix evenly.
    const wa = a.weight ?? (b.weight === null ? 50 : 100 - b.weight);
    const wb = b.weight ?? (a.weight === null ? 50 : 100 - a.weight);
    const total = wa + wb;
    if (!total) return null;
    const pa = wa / total;
    const pb = wb / total;
    const alpha = a.colour.alpha * pa + b.colour.alpha * pb;
    if (alpha === 0) return { rgb: [0, 0, 0], alpha: 0 };
    // Premultiplied, the way the browser mixes: a fully transparent stop must
    // not drag the result toward its (meaningless) channel values.
    const channel = (i: number) =>
      (a.colour.rgb[i] * a.colour.alpha * pa + b.colour.rgb[i] * b.colour.alpha * pb) / alpha;
    return { rgb: [channel(0), channel(1), channel(2)], alpha };
  }
  return null;
}

const asHex = (rgb: [number, number, number]) =>
  "#" +
  rgb
    .map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0"))
    .join("");

/** Composite a (possibly translucent) colour over an opaque backdrop. */
function over(c: Rgba, backdrop: [number, number, number]): [number, number, number] {
  if (c.alpha >= 1) return c.rgb;
  const channel = (i: number) => c.rgb[i] * c.alpha + backdrop[i] * (1 - c.alpha);
  return [channel(0), channel(1), channel(2)];
}

/* -------------------------------------------------------- what sits on what */

/** One theme's token table: `:root` plus, for dark, its override block. */
function themeTokens(dark: boolean): Map<string, string> {
  const table = new Map<string, string>();
  for (const rule of RULES) {
    if (rule.selector !== ":root" && !(dark && rule.selector === ':root[data-theme="dark"]')) {
      continue;
    }
    for (const [prop, value] of rule.decls) if (prop.startsWith("--")) table.set(prop, value);
  }
  return table;
}

const THEMES = [
  ["light", themeTokens(false)],
  ["dark", themeTokens(true)],
] as const;

/** A rule under `@media (forced-colors: active)` paints in the SYSTEM palette
 *  (`SelectedItem`, `Canvas`, …) that the UA and the user supply, not in either
 *  app theme, so neither theme's sweep reads it (interface review 2026-09-24:
 *  the selected chip, segment and calendar day name `SelectedItem` there). */
const forcedColors = (rule: CssRule) => rule.at.some((q) => /forced-colors:\s*active/.test(q));

/** A selector part with its state pseudo-classes and pseudo-elements dropped —
 *  `.card:hover` and `.card` paint the same box, and `.top-search input` is
 *  where `.top-search input::placeholder` sits. */
const bareSelector = (part: string) =>
  part.replace(/::[\w-]+(\([^)]*\))?/g, "").replace(/:[\w-]+(\([^)]*\))?/g, "").trim();

/** The compounds of a selector, outermost first. `>`, `+` and `~` are dropped:
 *  for "what is behind this text" the combinator does not matter, only the
 *  nesting. */
const compounds = (part: string) =>
  bareSelector(part)
    .split(/\s*[>+~]\s*|\s+/)
    .map((c) => c.trim())
    .filter(Boolean);

const DARK_SCOPE = ':root[data-theme="dark"] ';

/**
 * Selector → the background it paints, per theme. Built from every rule in the
 * sheet, so it answers "what is behind `.toast .ico`" without anyone writing
 * `.toast` down. First declaration wins (the base rule precedes its `:hover`);
 * the dark theme's selector-scoped fixups override.
 */
function paintMap(dark: boolean): Map<string, string> {
  const paints = new Map<string, string>();
  const scoped = new Map<string, string>();
  for (const rule of RULES) {
    if (forcedColors(rule)) continue;
    const bg = rule.decls.get("background") ?? rule.decls.get("background-color");
    if (!bg) continue;
    for (const part of splitArgs(rule.selector)) {
      // Test the RAW part for the dark scope BEFORE bareSelector strips the
      // `:root` pseudo-class — the stripped key could never match, so the
      // dark-override branch was dead and both theme sweeps measured e.g. the
      // console against its LIGHT fill only.
      const raw = part.trim();
      if (raw.startsWith(DARK_SCOPE)) {
        if (dark) {
          const key = bareSelector(raw.slice(DARK_SCOPE.length));
          if (key) scoped.set(key, bg);
        }
        continue;
      }
      const key = bareSelector(part);
      if (!key) continue;
      if (!paints.has(key)) paints.set(key, bg);
    }
  }
  return new Map([...paints, ...scoped]);
}

/**
 * Elements whose painting ancestor is NOT in their own selector, because the
 * markup nests them somewhere the sheet never names. Not an exemption — the
 * pair is still measured, just against the right backdrop. An entry that stops
 * being consulted fails below.
 */
const RENDERED_INSIDE = new Map(Object.entries({
  "log-line": {
    container: ".console",
    why: "runs-panels.tsx renders every log row inside `div.console`, which paints a fixed near-black fill in BOTH themes (that is why these rules use literal hex rather than tokens — see the .log-more comment). Measured against --bg/--surface they would read as failures in light and the console's real contrast would go unchecked.",
  },
  "log-chip": {
    container: ".console",
    why: "P19-RC1 tool chips render inside a `.log-line`'s `.lx`, which is inside `div.console` (runs-panels.tsx) — the same fixed near-black fill every log row is measured against.",
  },
  "log-file": {
    container: ".console",
    why: "P19-RC1 file-change chips render inside a `.log-line`'s `.lx`, which is inside `div.console` (runs-panels.tsx). Their add/update/delete tints are console-palette, so --bg/--surface would measure them against a backdrop they never touch.",
  },
  lcaret: {
    container: ".console",
    why: "the tail caret is the last child of `div.console` (runs-panels.tsx) — same fixed dark fill as the log rows it marks the end of.",
  },
  "log-more": {
    container: ".console",
    why: "the `load older lines` button is rendered inside a `.log-line` inside `div.console`, so it follows the console ladder, not the theme tokens.",
  },
  "log-more-note": {
    container: ".console",
    why: "the withheld-line count sits next to `.log-more` in the same console row.",
  },
  "lw-glyph": {
    container: ".console",
    why: "ruling 459: a wait row's orb-and-clock cell sits in a `.log-line`'s `.lx` inside `div.console` (runs-panels.tsx), so its clock is measured on the console's fixed dark fill.",
  },
  "log-orb": {
    container: ".console",
    why: "ruling 499: the wait row's CSS orb is drawn in that same `.lw-glyph` cell inside `div.console` (console-blocks.tsx), so its dots' ink is measured on the console's fixed dark fill, never on the page's --bg.",
  },
  "log-think": {
    container: ".console",
    why: "ruling 499: the thinking block's summary button is the `.lx` of a `.log-line.think` row inside `div.console` (runs-panels.tsx), the same fixed near-black fill every console row is measured against.",
  },
}));

/** Rules whose `color` paints a GLYPH, not text. WCAG 1.4.11 asks 3:1 of a
 *  meaningful non-text element, not 1.4.3's 4.5:1 — checked, at the right bar. */
const GLYPH_NOT_TEXT = new Map(Object.entries({
  ".stage-menu-pop .sm-check": "a 14×14 check mark marking the current stage in the stage menu; the row's selected state is also carried by `aria-checked` on the menuitemradio.",
  ".prop-menu .menu-item .prop-check": "ruling 501: the same 14×14 check, marking the current priority in the Details panel's priority menu; the row's selected state is also carried by `aria-checked` on the menuitemradio.",
  ".acct-menu .acct-check": "ruling 616: the same 14×14 check, marking the account in use in Profile's account picker; the row's selected state is also carried by `aria-checked` on the menuitemradio, and its line says \"in use\".",
}));

/**
 * Pairs that are deliberately below AA and stay that way. Each says why in
 * WCAG's own terms; an entry nobody hits fails the rot guard below.
 */
const BELOW_AA_BY_DESIGN = {
  ".pj-star.on": "the pinned-project star. --pin-star is a decorative accent on a glyph whose IDENTITY and STATE are carried elsewhere: the glyph swaps outline (`star`) for filled (`starfilled`), and the button's accessible name flips between `Pin <project>` and `Unpin <project>`. 1.4.11 exempts a graphic that is not required to understand the content, which is exactly the case when shape and name already carry it.",
  ".log-more:disabled": "`load older lines` while a fetch is in flight. WCAG 1.4.3 exempts text in an INACTIVE user-interface component by name, and the button also swaps its label to `loading older lines…`, so the state is not carried by contrast.",
} satisfies Record<string, string>;

/** WCAG 2.2: 24px, or 18.66px at 700+, is "large text" and drops to 3:1. */
function largeText(decls: Map<string, string>): boolean {
  const size = decls.get("font-size");
  const px = size ? /^([\d.]+)rem$/.exec(size.trim()) : null;
  if (!px) return false;
  const value = Number(px[1]) * 16;
  const weight = Number(decls.get("font-weight") ?? "400");
  return value >= 24 || (value >= 18.66 && weight >= 700);
}

type Pair = {
  key: string;
  theme: string;
  selector: string;
  fg: string;
  bg: string;
  ratio: number;
  need: number;
  where: string;
};

type Sweep = { pairs: Pair[]; unresolved: string[]; containerHits: Set<string> };

/** The sweep. For every rule that sets a text colour, in both themes: resolve
 *  the colour, work out what is behind it, and measure. */
function sweep(): Sweep {
  const pairs: Pair[] = [];
  const unresolved: string[] = [];
  const containerHits = new Set<string>();
  for (const [theme, tokens] of THEMES) {
    const paints = paintMap(theme === "dark");
    const ambient = (["--bg", "--surface"] as const).map(
      (t) => [t, resolveColor(`var(${t})`, tokens)!.rgb] as const,
    );
    const opaquePaint = (key: string): [number, number, number] | null => {
      const value = paints.get(key);
      if (!value || /^(none|transparent)$/i.test(value) || /gradient\(/i.test(value)) return null;
      const c = resolveColor(value, tokens);
      return c && c.alpha >= 1 ? c.rgb : null;
    };
    // One entry per selector, carrying what the CASCADE leaves it — not one per
    // rule. Two reasons. `:root[data-theme="dark"] .toast { color: var(--surface) }`
    // is not a rule about a `.toast` inside a root, it is an OVERRIDE of
    // `.toast`, and read standalone it loses the background the base rule
    // paints. And `.toast` appears in a `prefers-reduced-motion` rule that sets
    // only `animation` — a per-rule reading pairs that rule's inherited colour
    // with no background at all and invents a failure.
    const effective = new Map<string, Map<string, string>>();
    for (const rule of RULES) {
      if (forcedColors(rule)) continue;
      for (const part of splitArgs(rule.selector)) {
        let target = part;
        if (part.startsWith(DARK_SCOPE)) {
          if (theme !== "dark") continue;
          target = part.slice(DARK_SCOPE.length);
        } else if (part.startsWith(":root")) continue;
        const acc = effective.get(target) ?? new Map<string, string>();
        for (const prop of ["color", "background", "background-color", "background-clip", "content", "font-size", "font-weight"]) {
          const value = rule.decls.get(prop);
          if (value !== undefined) acc.set(prop, value);
        }
        if (acc.size) effective.set(target, acc);
      }
    }
    for (const [part, decls] of effective) {
      const colour = decls.get("color");
      if (!colour || /^(inherit|currentcolor|unset|initial)$/i.test(colour.trim())) continue;
      // An overlay copy of an element's own words, whose ink IS its background
      // (a `::before`/`::after` drawing `attr(…)` with `color: transparent` and
      // `background-clip: text`: ruling 451(a)'s shimmer band), is no
      // text-on-backdrop pair. It lays a band over words the element already
      // draws, and those words are measured on the element itself. Real text
      // painted this way (not a pseudo copy of attr()) is still swept.
      if (
        /::(before|after)$/.test(part) &&
        (decls.get("content") ?? "").startsWith("attr(") &&
        /^transparent$/i.test(colour.trim()) &&
        /\btext\b/i.test(decls.get("background-clip") ?? "")
      ) {
        continue;
      }
      const fg = resolveColor(colour, tokens);
      if (!fg) {
        unresolved.push(`${theme} ${part} { color: ${colour} }`);
        continue;
      }
      const chain = compounds(part);
      const atomPaint = (compound: string) =>
        opaquePaint(compound) ??
        [...compound.matchAll(/\.([-\w]+)/g)].map((m) => opaquePaint(`.${m[1]}`)).find(Boolean) ??
        null;
      // Behind the text, in order: the element's own fill (`.pill.done` takes
      // `.pill`'s), the nearest ancestor in the selector that paints, the
      // container the markup nests it in, and finally the page itself.
      let behind: readonly (readonly [string, [number, number, number]])[] = ambient;
      for (let i = chain.length - 1; i >= 0; i--) {
        const paint = atomPaint(chain[i]);
        if (paint) {
          behind = [[chain[i], paint]];
          break;
        }
      }
      if (behind === ambient) {
        for (const atom of [...part.matchAll(/\.([-\w]+)/g)].map((m) => m[1])) {
          const nest = RENDERED_INSIDE.get(atom);
          const paint = nest ? opaquePaint(nest.container) : null;
          if (nest && paint) {
            containerHits.add(atom);
            behind = [[`${nest.container} (${atom})`, paint]];
            break;
          }
        }
      }
      const own = decls.get("background") ?? decls.get("background-color");
      if (own && !/^none$/i.test(own.trim())) {
        if (/gradient\(/i.test(own)) {
          unresolved.push(`${theme} ${part} { background: ${own.split("(")[0]}(…) }`);
          continue;
        }
        const bg = resolveColor(own, tokens);
        if (!bg) {
          unresolved.push(`${theme} ${part} { background: ${own} }`);
          continue;
        }
        behind = bg.alpha >= 1
          ? [[own, bg.rgb]]
          : behind.map(([name, base]) => [`${own} over ${name}`, over(bg, base)] as const);
      }
      const need = GLYPH_NOT_TEXT.has(part) || largeText(decls) ? 3 : 4.5;
      for (const [name, backdrop] of behind) {
        pairs.push({
          key: `${theme} ${part}`,
          theme,
          selector: part,
          fg: asHex(over(fg, backdrop)),
          bg: asHex(backdrop),
          ratio: contrastRatio(asHex(over(fg, backdrop)), asHex(backdrop)),
          need,
          where: name,
        });
      }
    }
  }
  return { pairs, unresolved, containerHits };
}

const SWEEP = sweep();

describe("app.css: every pair it paints clears WCAG AA, in both themes (R19-12)", () => {
  const { pairs, unresolved, containerHits } = SWEEP;
  const below = pairs.filter((p) => p.ratio < p.need);
  const describePair = (p: Pair) =>
    `${p.key} — ${p.fg} on ${p.bg} (${p.where}) = ${p.ratio.toFixed(2)}:1, needs ${p.need}:1`;

  it("swept the whole sheet in both themes, not a hand-list", () => {
    // A scanner that silently matches nothing turns every assertion below
    // green, which is the failure mode this pass caught four times.
    expect(pairs.length).toBeGreaterThan(400);
    for (const theme of ["light", "dark"]) {
      expect(pairs.some((p) => p.theme === theme), `${theme} must be swept`).toBe(true);
    }
    // The rules P13-D-12 and P13-D-19 were about must be in here: `.fine` and
    // `.hint` carry --faint and --placeholder, and `.muted`, `.hint`,
    // `.btn.primary` and `.btn.ghost` are utilities the markup used before
    // any rule defined them. A sweep that measures them proves both.
    for (const selector of [".fine", ".btn.primary", ".btn.ghost", ".muted", ".hint"]) {
      expect(
        pairs.some((p) => p.selector === selector),
        `${selector} must be swept`,
      ).toBe(true);
    }
  });

  it("resolves every colour it meets, or names the ones it cannot", () => {
    // Silent skips are how a sweep becomes decoration. The list is EMPTY since
    // VIB-1 flattened the page canvas to `background: var(--bg)`: the two
    // pastel radial blobs on `body` were the sheet's only unresolvable paint,
    // so every pair the app renders is now measured against a real backdrop.
    // A new entry here is a new gradient/image backdrop that this sweep cannot
    // see through — teach the resolver about it rather than listing it.
    expect([...new Set(unresolved)].sort()).toEqual([]);
  });

  it("clears 4.5:1 for text and 3:1 for large text and meaningful glyphs", () => {
    const unexplained = below
      .filter((p) => !(p.selector in BELOW_AA_BY_DESIGN))
      .map(describePair)
      .sort();
    // Named with their ratios, not counted: the fix is a token swap and the
    // reader needs to know which pair and by how much.
    expect(unexplained).toEqual([]);
  });

  it("keeps every exemption load-bearing", () => {
    // An entry that no longer changes an outcome is a stale claim about the
    // sheet. `ALLOW_SUBSTRINGS` taught this file that lesson once already.
    const dead: string[] = [];
    for (const selector of GLYPH_NOT_TEXT.keys()) {
      const mine = pairs.filter((p) => p.selector === selector);
      if (!mine.length) dead.push(`GLYPH_NOT_TEXT ${selector}: matches no rule`);
      else if (mine.every((p) => p.ratio >= 4.5)) {
        dead.push(`GLYPH_NOT_TEXT ${selector}: clears 4.5:1 unaided`);
      }
    }
    for (const selector of Object.keys(BELOW_AA_BY_DESIGN)) {
      const mine = pairs.filter((p) => p.selector === selector);
      if (!mine.length) dead.push(`BELOW_AA_BY_DESIGN ${selector}: matches no rule`);
      else if (mine.every((p) => p.ratio >= p.need)) {
        dead.push(`BELOW_AA_BY_DESIGN ${selector}: passes now — delete it`);
      }
    }
    for (const atom of RENDERED_INSIDE.keys()) {
      if (!containerHits.has(atom)) dead.push(`RENDERED_INSIDE ${atom}: never consulted`);
    }
    expect(dead.sort()).toEqual([]);
  });

  it("makes every exemption say why, in the sheet's own terms", () => {
    const entries = [
      ...GLYPH_NOT_TEXT,
      ...Object.entries(BELOW_AA_BY_DESIGN),
      ...[...RENDERED_INSIDE].map(([k, v]) => [k, v.why] as const),
    ];
    for (const [name, why] of entries) {
      expect(why.length, `${name} needs a real reason, not a label`).toBeGreaterThan(60);
    }
  });
});

/* ================================================================== GATE 2
 *
 * "No control is hidden or disabled at any width, and nothing is gated on
 * `matchMedia`" (INTENT §4). The reason it is load-bearing is in the same
 * sentence: a decision surface that drops an action on a narrow window is
 * lying about what the viewer may do — and the viewer cannot tell, because
 * what is missing leaves nothing behind.
 *
 * `BREAKPOINTS` above pins WHICH widths the sheet may use. This pins what a
 * width is allowed to DO: reflow, never remove. Both halves are checked —
 * every hiding rule under a width query in `app.css`, resolved against the
 * markup that renders it, and every viewport read in `app/`.
 */

/** TS/TSX with comments removed, so a fix note that QUOTES markup ("was an
 *  anonymous `<div>` with a `<span class="cur">`" — topbar.tsx) cannot push a
 *  phantom element onto the nesting stack. Strings and regex literals are
 *  stepped over rather than scanned. */
function stripComments(src: string): string {
  let out = "";
  let prev = "";
  for (let i = 0; i < src.length; ) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
      continue;
    }
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i++;
        if (src[i - 1] === c) break;
      }
      prev = c;
      continue;
    }
    // A `/` after an operator or an opening bracket starts a regex literal, not
    // a division — a regex containing `//` would otherwise read as a line
    // comment. The closing brackets are deliberately NOT in this set: `</nav>`
    // and `<Icon name={x} />` put a `/` right after `<` and `}`, and reading
    // either as a regex swallows the markup up to the next slash — which is
    // exactly the corruption this function exists to prevent.
    if (c === "/" && (prev === "" || "(,=:[!&|?{;+-*%~^".includes(prev))) {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (src[i] === "[") {
          while (i < src.length && src[i] !== "]") {
            out += src[i];
            i += src[i] === "\\" ? 2 : 1;
          }
        }
        out += src[i];
        i++;
        if (src[i - 1] === "/") break;
      }
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

type Frame = { id: number; tag: string; classes: Set<string> };
type Element = Frame & { interactive: boolean; file: string; line: number; chain: Frame[] };

const INTERACTIVE_TAG = /^(button|a|input|select|textarea|summary|label)$/;
const INTERACTIVE_ROLE =
  /^(button|link|menuitem|menuitemradio|menuitemcheckbox|option|switch|tab|checkbox|radio|combobox|textbox|slider|searchbox)$/;

/** Every JSX element in `app/` with a class list, plus the ancestor chain it
 *  sits in inside its own file. Cross-component nesting is invisible here by
 *  construction — the sweep below handles that two ways: a selector that
 *  matches nothing is widened, never assumed harmless, and a COMPONENT child
 *  is treated as opaque (see `mayHoldControl`), never assumed empty. */
function jsxElements(): Element[] {
  const out: Element[] = [];
  let id = 0;
  for (const file of markupFiles()) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = path.relative(path.dirname(APP_DIR), file);
    const stack: Frame[] = [];
    // The lookbehind keeps TypeScript generics out: `useRef<HTMLDivElement>`
    // and `Record<string, string>` are not elements.
    const re = /(?<![\w$)\]])<(\/?)([A-Za-z][\w.]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = m[2];
      if (m[1] === "/") {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === tag) {
            stack.length = i;
            break;
          }
        }
        const gt = src.indexOf(">", m.index);
        re.lastIndex = gt < 0 ? src.length : gt + 1;
        continue;
      }
      let i = m.index + m[0].length;
      for (let depth = 0; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        else if (src[i] === ">" && depth === 0) break;
      }
      const attrs = src.slice(m.index, i);
      const classes = new Set<string>();
      const className = /className\s*=\s*(?:"([^"]*)"|\{)/.exec(attrs);
      if (className) {
        const text = className[1] !== undefined ? `"${className[1]}"` : attrs.slice(className.index);
        for (const literal of text.matchAll(/["'`]([^"'`]*)["'`]/g)) {
          for (const token of literal[1].split(/\s+/)) if (/^[-\w]+$/.test(token)) classes.add(token);
        }
      }
      const role = /\brole\s*=\s*"([^"]*)"/.exec(attrs);
      const frame: Frame = { id: id++, tag, classes };
      out.push({
        ...frame,
        interactive:
          INTERACTIVE_TAG.test(tag.toLowerCase()) ||
          /\bonClick\b|\bonKeyDown\b|\bhref\b|\bto=/.test(attrs) ||
          (role ? INTERACTIVE_ROLE.test(role[1]) : false),
        file: rel,
        line: src.slice(0, m.index).split("\n").length,
        chain: stack.slice(),
      });
      if (!/\/\s*$/.test(attrs)) stack.push(frame);
      re.lastIndex = i + 1;
    }
  }
  return out;
}

const ELEMENTS = jsxElements();

/**
 * Components PROVEN to render no control, so an opaque-boundary flag on them
 * would be noise (`<Icon>` is the breadcrumb separator the 1080 tier hides).
 * NOT trusted prose: `re-proves the renders-no-control claims` below re-reads
 * each component's defining file on every run and fails the moment any element
 * in it turns interactive or reaches for a component outside this map — and an
 * entry no width-hidden scope consults fails the rot guard.
 */
const RENDERS_NO_CONTROL = {
  Icon: {
    file: "app/ui/icon.tsx",
    why: "renders exactly one `aria-hidden=\"true\"` <svg> whose body is a path string from ICON_PATHS — a glyph by construction, with no handler, no href and no children of its own.",
  },
  Pill: {
    file: "app/ui/pill.tsx",
    why: "renders one status <span class=\"pill …\"> (plus an optional dot <span>). The interactive pills elsewhere in the app (`button.pill` — the notification filter, the live-paused retry) are plain DOM buttons, not this component, so the sweep still sees them as controls.",
  },
} satisfies Record<string, { file: string; why: string }>;

/** A component boundary is OPAQUE to a file-local scan: `<StageMenu>` inside
 *  board-page.tsx's `.card-move` renders its <button> over in stage-menu.tsx,
 *  where no ancestor chain built here can see it. So a capitalized descendant
 *  counts as a control unless its component is PROVEN empty of them — the
 *  gate's own canary proved the alternative: with components assumed empty,
 *  hiding `.card-move` (whose ONLY child is the keyboard stage-move menu, the
 *  board's drag fallback) passed this whole block green. */
const mayHoldControl = (el: Element) =>
  el.interactive || (/^[A-Z]/.test(el.tag) && !(el.tag in RENDERS_NO_CONTROL));

/** `.a.b`, `input`, `a.card` — the tag and classes one element must carry. */
const compoundOf = (text: string) => ({
  tag: /^([a-zA-Z][\w-]*)/.exec(text)?.[1]?.toLowerCase() ?? null,
  classes: [...text.matchAll(/\.([-\w]+)/g)].map((m) => m[1]),
});

const carries = (el: { tag: string; classes: Set<string> }, part: string) => {
  const want = compoundOf(part);
  if (want.tag && el.tag.toLowerCase() !== want.tag) return false;
  return want.classes.every((c) => el.classes.has(c));
};

/** Does this element match a class/tag selector with descendant and `>`
 *  combinators? Ancestors are matched against the in-file nesting stack. */
function matchesSelector(el: Element, selector: string): boolean {
  const tokens = bareSelector(selector).replace(/\s*>\s*/g, " > ").split(/\s+/).filter(Boolean);
  const last = tokens.pop();
  if (!last || !carries(el, last)) return false;
  let at = el.chain.length - 1;
  for (let t = tokens.length - 1; t >= 0; t--) {
    let child = false;
    if (tokens[t] === ">") {
      child = true;
      t--;
      if (t < 0) return false;
    }
    let found = false;
    for (; at >= 0; at--) {
      if (carries(el.chain[at], tokens[t])) {
        found = true;
        at--;
        break;
      }
      if (child) return false;
    }
    if (!found) return false;
  }
  return true;
}

/** Declarations that take an element's capability away, as opposed to moving
 *  or resizing it. `opacity: 0` is here because P16-F7 found the invisible
 *  element still hit-testing under a finger. */
function removesTheElement(decls: Map<string, string>): string | null {
  for (const [prop, expected] of [
    ["display", "none"],
    ["visibility", "hidden"],
    ["content-visibility", "hidden"],
    ["pointer-events", "none"],
  ] as const) {
    if ((decls.get(prop) ?? "").trim() === expected) return `${prop}: ${expected}`;
  }
  for (const prop of ["width", "height"] as const) {
    if (/^0(px|rem|em|%)?$/.test((decls.get(prop) ?? "").trim())) return `${prop}: 0`;
  }
  if (/^0(\.0+)?$/.test((decls.get("opacity") ?? "").trim())) return "opacity: 0";
  return null;
}

/**
 * Width-scoped hiding that costs the viewer nothing, because the capability is
 * reachable another way at that width. Every entry says HOW — "it is only a
 * label" is a claim about the markup that the reader can check.
 */
const HIDDEN_BY_DESIGN = {
  ".crumbs .crumb-root": "topbar tier 1 drops the project crumb at 1080px. The destination is the board, which the project rail links from every width — INTENT §4 keeps the rail's width at every breakpoint precisely so the crumbs can truncate. Navigation duplicated, not removed.",
  ".crumbs .crumb-mid": "topbar tier 2 drops the middle crumb at 760px. Same duplication: the view it links to is a rail item, and at 720px the rail becomes an overlay that still lists all of them.",
  ".home-top .top-search input": "P16-G3. At 900px Home's finder collapses to its `.kbd` BUTTON, which becomes the whole 36×36 box and opens the command palette — the same search over the same projects. The capability moves to a control a phone can actually use; it is not withdrawn. The three tests in `app.css palette reachability on touch` pin the replacement.",
  ".rail": "interface review 2026-09-24 (acce-13). At 720px the project rail is a drawer behind `.rail-toggle` (aria-expanded), and closed it is `visibility: hidden` so its links leave the tab order instead of taking nine invisible Tab stops off-screen. `.app[data-rail-open=\"true\"] .rail` restores visibility, so every link is one toggle press away, not removed.",
  ".pj-row .pj-stats .pill": "the 1100px tier drops the least load-bearing stat from a Home project ROW. `.pill` is a shared chip class that is a <button> elsewhere (the notification filter, the topbar's live-paused retry), and the ancestors here live in a different component from the pills, so the sweep widens to every `.pill` and picks those buttons up. The pills this rule reaches are project-cards.tsx spans inside `.pj-stats`, and the same numbers stay on the project's own page.",
} satisfies Record<string, string>;

/** Files allowed to read the viewport, and what they do with it. A read that
 *  changes WHAT IS RENDERED is the thing the contract bans; these move things
 *  that are already there. */
const VIEWPORT_READS = {
  "app/ui/stage-menu.tsx": "clamps the stage popover's left edge into the window with an 8px gutter after `getBoundingClientRect()`, and (interface review 2026-09-24, layo-8) flips it above its trigger or caps its height when the room below runs out. It positions an element that is already open and already rendered — no branch of the tree depends on the number.",
  "app/features/profile/agent-accounts-panel.tsx": "ruling 616: the account picker clips the box its menu shows in (the overlay's scrolling body) to the window, then opens the menu above its trigger or caps its height when the room below runs out, as the stage menu does. It positions a menu that is already open and already rendered — no branch of the tree depends on the number.",
} satisfies Record<string, string>;

type Hidden = {
  selector: string;
  query: string;
  how: string;
  resolved: boolean;
  self: Element[];
  inside: Element[];
};

type HiddenSweep = { rules: Hidden[]; suppressed: Set<string> };

/** Every width-scoped rule that removes an element, with the controls it takes
 *  with it — plus which RENDERS_NO_CONTROL entries a hidden scope actually
 *  consulted, so an entry that suppresses nothing can fail the rot guard. */
function hiddenControls(): HiddenSweep {
  const out: Hidden[] = [];
  const suppressed = new Set<string>();
  for (const rule of RULES) {
    const query = rule.at.filter((q) => /\((?:min|max)-width/.test(q)).join(" ");
    if (!query) continue;
    const how = removesTheElement(rule.decls);
    if (!how) continue;
    for (const selector of splitArgs(rule.selector)) {
      const matched = ELEMENTS.filter((el) => matchesSelector(el, selector));
      // A selector whose ancestors live in a different component resolves to
      // nothing here. Widen to the target compound rather than conclude the
      // rule is harmless — over-reporting costs an exemption with a reason;
      // under-reporting costs a control nobody notices is gone.
      const target = bareSelector(selector).replace(/\s*[>+~]\s*/g, " ").split(/\s+/).pop()!;
      const scope = matched.length
        ? matched
        : compoundOf(target).classes.length
          ? ELEMENTS.filter((el) => carries(el, target))
          : [];
      const inScope = (el: Element) =>
        scope.some((host) => host.id === el.id || el.chain.some((f) => f.id === host.id));
      for (const el of ELEMENTS) {
        if (el.tag in RENDERS_NO_CONTROL && inScope(el)) suppressed.add(el.tag);
      }
      const inside = ELEMENTS.filter(
        (el) => mayHoldControl(el) && scope.some((host) => el.chain.some((f) => f.id === host.id)),
      );
      out.push({
        selector,
        query,
        how,
        resolved: matched.length > 0,
        self: scope.filter(mayHoldControl),
        inside,
      });
    }
  }
  return { rules: out, suppressed };
}

const { rules: HIDDEN, suppressed: SUPPRESSED_COMPONENTS } = hiddenControls();

describe("app.css hides no control at any width (R19-12)", () => {
  const costly = HIDDEN.filter((h) => h.self.length > 0 || h.inside.length > 0);
  const describeHide = (h: Hidden) =>
    `${h.query} { ${h.selector} { ${h.how} } } takes ` +
    [...h.self, ...h.inside]
      .slice(0, 4)
      .map((el) => `<${el.tag}> ${el.file}:${el.line}`)
      .join(", ");

  it("read both sides — the sheet's width queries and the markup they land on", () => {
    // Either scanner silently matching nothing turns this whole block green.
    expect(ELEMENTS.length).toBeGreaterThan(2000);
    expect(ELEMENTS.filter((el) => el.interactive).length).toBeGreaterThan(300);
    expect(HIDDEN.length).toBeGreaterThan(5);
    expect(HIDDEN.every((h) => h.query.includes("width"))).toBe(true);
    // The stripper is what makes the nesting stack trustworthy: topbar.tsx's
    // P13-D-37 note quotes `<div>` and `<span class="cur">` inside a comment,
    // and an unbalanced phantom `<div>` corrupts every chain after it. The
    // canary rides the ⌘K chip, which lives in the shared trigger component
    // (ruling 145) — inside the button whose tag is what scopes the 1080 tier.
    const trigger = ELEMENTS.filter((el) =>
      el.file.endsWith("shell/palette-trigger.tsx"),
    );
    const kbd = trigger.find((el) => el.classes.has("kbd"));
    expect(kbd, "the palette trigger's ⌘K chip must be found").toBeTruthy();
    expect(kbd!.tag).toBe("span");
    expect(
      kbd!.chain.map((f) => [f.tag, ...f.classes]).flat(),
      "and must be seen inside button.top-search",
    ).toEqual(expect.arrayContaining(["button", "top-search"]));
  });

  it("removes no interactive element under a width query", () => {
    const unexplained = costly
      .filter((h) => !(h.selector in HIDDEN_BY_DESIGN))
      .map(describeHide)
      .sort();
    // Named with the file and line of the control that disappears — "3
    // violations" would send the next reader back to resizing the window.
    expect(unexplained).toEqual([]);
  });

  it("does not let `button.top-search .kbd` stand in for Home's palette button", () => {
    // The scoping P16-G3 fought for, checked from the markup rather than from
    // the selector text: the chip the 1080 tier hides is the trigger's <span>,
    // and home-sections.tsx's <button className="kbd"> — the only other caller
    // of `onOpenPalette` — is NOT matched by it. The tier used to hide `.kbd`
    // unscoped, and a 1000px window lost Home's palette and the palette's own
    // "esc" hint to a rule about breadcrumb room. Ruling 145 scopes it to
    // `button.top-search` rather than `.topbar >`: the trigger is one shared
    // component (`palette-trigger.tsx`) rendered by the workspace topbar AND the
    // standalone-page header, and a chip inside a button-trigger is a HINT.
    const rule = HIDDEN.find((h) => h.selector === "button.top-search .kbd");
    expect(rule, "the scoped chip rule must be seen by the sweep").toBeTruthy();
    expect(rule!.resolved, "and must resolve against the markup").toBe(true);
    expect(rule!.self).toEqual([]);
    expect(rule!.inside).toEqual([]);
    const homeButton = ELEMENTS.find(
      (el) => el.file.endsWith("home/home-sections.tsx") && el.classes.has("kbd"),
    );
    expect(homeButton?.tag).toBe("button");
    expect(matchesSelector(homeButton!, "button.top-search .kbd")).toBe(false);
  });

  it("treats a component boundary as opaque — a control can hide behind it", () => {
    // THE hole the canary found: board-page.tsx's `.card-move` is a plain
    // <div> whose only child is <StageMenu>, and StageMenu's <button> lives in
    // stage-menu.tsx where no in-file ancestor chain can see it. With
    // components assumed empty, `@media (max-width: 720px) { .card-move {
    // display: none } }` — deleting the board's only keyboard stage-move at
    // phone widths — left every test in this block green.
    const host = ELEMENTS.find(
      (el) => el.file.endsWith("board/board-page.tsx") && el.classes.has("card-move"),
    );
    expect(host, "the board's .card-move host must be found").toBeTruthy();
    expect(host!.interactive, "the host div itself is NOT interactive — that is the trap").toBe(false);
    const menu = ELEMENTS.find(
      (el) => el.tag === "StageMenu" && el.chain.some((f) => f.id === host!.id),
    );
    expect(menu, "<StageMenu> must be seen inside it").toBeTruthy();
    expect(
      mayHoldControl(menu!),
      "an unproven component counts as a control — reverting this re-opens the hole",
    ).toBe(true);
  });

  it("re-proves the renders-no-control claims against each component's own file", () => {
    // The map is a claim about ANOTHER file, so it is re-checked here rather
    // than trusted: give Pill an onClick, or render some new component inside
    // Icon, and this fails before the weakened exemption can hide anything.
    for (const [name, entry] of Object.entries(RENDERS_NO_CONTROL)) {
      const src = readFileSync(path.join(path.dirname(APP_DIR), entry.file), "utf8");
      expect(src, `${entry.file} must define ${name}`).toMatch(
        new RegExp(`(?:function|const)\\s+${name}\\b`),
      );
      const rendered = ELEMENTS.filter((el) => el.file === entry.file);
      expect(rendered.length, `${entry.file} must render something`).toBeGreaterThan(0);
      for (const el of rendered) {
        expect(
          el.interactive,
          `${entry.file}:${el.line} <${el.tag}> is interactive — ${name} no longer renders no control`,
        ).toBe(false);
        expect(
          /^[A-Z]/.test(el.tag) && !(el.tag in RENDERS_NO_CONTROL),
          `${entry.file}:${el.line} <${el.tag}> is an unproven component — the ${name} claim no longer holds transitively`,
        ).toBe(false);
      }
    }
  });

  it("keeps every responsive exemption load-bearing and explained", () => {
    const flagged = new Set(costly.map((h) => h.selector));
    const dead = Object.keys(HIDDEN_BY_DESIGN)
      .filter((selector) => !flagged.has(selector))
      .map((selector) => `${selector}: hides no control any more — delete it`)
      .sort();
    // A proven-empty component no width-hidden scope contains is the same kind
    // of rot: the exemption gates nothing, so it must go before it can excuse
    // some future component that DOES hold a control.
    for (const name of Object.keys(RENDERS_NO_CONTROL)) {
      if (!SUPPRESSED_COMPONENTS.has(name)) {
        dead.push(`RENDERS_NO_CONTROL ${name}: no width-hidden scope contains one — delete it`);
      }
    }
    expect(dead.sort()).toEqual([]);
    for (const [name, why] of [
      ...Object.entries(HIDDEN_BY_DESIGN),
      ...Object.entries(VIEWPORT_READS),
      ...Object.entries(RENDERS_NO_CONTROL).map(([k, v]) => [k, v.why] as const),
    ]) {
      expect(why.length, `${name} needs a real reason, not a label`).toBeGreaterThan(60);
    }
  });
});

describe("app/ gates no rendering on the viewport (R19-12)", () => {
  const sources = sourceFiles(APP_DIR).filter((f) => !f.includes(".test."));

  it("uses matchMedia for user PREFERENCES only, never for width", () => {
    // A width-driven matchMedia is how "no control is hidden at any width"
    // gets broken in a place `app.css` cannot be read to find out. Every live
    // use asks the OS for a preference: colour scheme or reduced motion.
    const queries: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(path.dirname(APP_DIR), file);
      for (const m of src.matchAll(/matchMedia\(\s*["'`]([^"'`]*)/g)) {
        queries.push(`${rel} — ${m[1]}`);
      }
    }
    // Five sites: the SSR-safe first-paint script inlined in root.tsx, the
    // listener that keeps `system` live, `theme-preference.ts`, the board's
    // drop animation asking for reduced motion before it flies a card
    // (board-page.tsx, 2026-09-08), and the dock sheet's release asking the
    // same before it springs (use-sheet-drag.ts, ruling 454). The sheet knows
    // it IS a sheet from the `--sheet-draggable` flag the 720px block sets,
    // never from a width query.
    expect(queries.length, "the scan must find the five preference reads").toBe(5);
    for (const q of queries) {
      expect(q, "matchMedia may only ask about a preference").toMatch(/\(prefers-[\w-]+:/);
      expect(q, "a width query here is the banned form").not.toMatch(/width/);
    }
  });

  it("reads the viewport in exactly the places that only POSITION things", () => {
    const readers = new Map<string, number>();
    for (const file of sources) {
      const src = stripComments(readFileSync(file, "utf8"));
      const rel = path.relative(path.dirname(APP_DIR), file);
      const count = [
        ...src.matchAll(/window\.(?:innerWidth|innerHeight|outerWidth|screen)\b/g),
        ...src.matchAll(/documentElement\.client(?:Width|Height)\b/g),
      ].length;
      if (count) readers.set(rel, count);
    }
    const unexpected = [...readers.keys()].filter((f) => !(f in VIEWPORT_READS)).sort();
    expect(unexpected, "a new viewport read must say what it does with it").toEqual([]);
    const stale = Object.keys(VIEWPORT_READS).filter((f) => !readers.has(f)).sort();
    expect(stale, "an entry for a file that no longer reads the viewport").toEqual([]);
  });
});

/* --------------------------------------- field chrome per input type (P21) */

/**
 * P21 — pass 20 changed the login email input from `type="text"` to
 * `type="email"` for autofill semantics, and the `.field input[type=…]` rule —
 * which opts fields in per TYPE so checkboxes and file pickers keep their
 * native chrome — silently stopped matching it. The email field rendered in UA
 * default chrome next to a fully styled password field: the browser is happy,
 * only a human notices, which is this file's exact remit. The owner was the
 * human who noticed.
 */
describe("app.css field chrome covers every text-like input type (P21)", () => {
  const ruleStart = CODE.indexOf('.field input[type="text"]');
  const fieldSelector =
    ruleStart >= 0 ? CODE.slice(ruleStart, CODE.indexOf("{", ruleStart)) : "";

  /** The `type=` vocabulary that means "the user types here" — the values that
   *  must take the shared field box when they sit inside a `.field`. Picker and
   *  button types (checkbox, radio, file, submit, …) are excluded by not being
   *  named: their UA rendering is the point. */
  const TEXT_LIKE = new Set([
    "text", "password", "email", "search", "url", "tel", "number",
    "date", "datetime-local", "month", "week", "time",
  ]);

  // Harvested as bare `type="…"` literals rather than by matching <input>
  // elements: JSX attribute lists hold arrow functions, so an element regex
  // stops at the first `=>` and misses any `type` declared after a handler. No
  // other element legally carries these attribute values, so the literal alone
  // identifies a text input.
  const used = new Map<string, Set<string>>();
  for (const file of markupFiles()) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(path.dirname(APP_DIR), file);
    for (const m of src.matchAll(/\btype="([a-z-]+)"/g)) {
      if (!TEXT_LIKE.has(m[1])) continue;
      if (!used.has(m[1])) used.set(m[1], new Set());
      used.get(m[1])!.add(rel);
    }
  }

  it("found the rule and the app's real inputs", () => {
    // A scanner that silently harvests nothing would turn the gate green for
    // free — the login form alone guarantees these two.
    expect(fieldSelector, "the `.field input[type=…]` rule must exist").not.toBe("");
    expect(used.has("text")).toBe(true);
    expect(used.has("password")).toBe(true);
  });

  it("lists every text-like type the markup uses", () => {
    const uncovered = [...used.entries()]
      .filter(([type]) => !fieldSelector.includes(`input[type="${type}"]`))
      // Named with their sites: the fix is one selector added to the list at
      // the named rule, and the reader needs to know which flip caused it.
      .map(([type, sites]) => `${type} (${[...sites].sort().join(", ")})`)
      .sort();
    expect(uncovered).toEqual([]);
  });

  it("keeps the base rule at the specificity the mono override beats", () => {
    // `.field input.mono` (0,2,1) wins over the base rule by SOURCE ORDER, not
    // by weight. Rewriting the type list as `.field input:not([type="…"]…)`
    // reads as equivalent but scores (0,n+1,1) and would flip every mono field
    // input in the app back to the body face.
    expect(fieldSelector).not.toContain(":not(");
    expect(CODE).toMatch(/\.field input\.mono\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  });
});

/* --------------------------------------------------------- the type scale */

describe("app.css type scale (recut 2026-09-08)", () => {
  // Six steps, one per role (documented at the token block). This is the lock
  // that keeps the next `.73rem` from creeping back in: a new size is a
  // deliberate widening of the scale, made here.
  const TYPE_SCALE = [
    ".69rem", ".75rem", ".88rem", "1rem", "1.25rem", "1.75rem",
  ];

  it("every font-size is a scale step (or the sanctioned 0/inherit)", () => {
    const offScale = [...CODE.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => !TYPE_SCALE.includes(v) && v !== "0" && v !== "inherit");
    expect([...new Set(offScale)].sort()).toEqual([]);
  });

  it("declares only weights the loaded fonts ship", () => {
    // root.tsx loads Inter by weight (ruling 365: the one UI face) and
    // JetBrains Mono 400/500/600. Declared weights above a family's ceiling
    // silently render one step down (and flash heavier in font fallback), so
    // the sheet declares only real ones; 800 is legal only where the display
    // face applies. The weights are read off root.tsx's imports, so dropping
    // one fails every rule that still declares it.
    const root = readFileSync(fileURLToPath(new URL("./root.tsx", import.meta.url)), "utf8");
    const loaded = [...root.matchAll(/^import "@fontsource\/inter\/(\d{3})\.css";$/gm)].map((m) => m[1]!);
    expect(loaded.length, "root.tsx loads Inter weight by weight").toBeGreaterThan(2);
    const weights = [...CODE.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = new Set([...loaded, "inherit"]);
    expect([...new Set(weights.filter((w) => !allowed.has(w)))]).toEqual([]);
  });

  it("scopes font-weight: 800 to rules that resolve the display face", () => {
    // Inter ships 800 for both tokens now, but 800 stays a heading weight: a
    // body-face rule at 800 is the "heap of bold" the design pass removed.
    // Each 800 rule must either declare the display family itself or select
    // an h1-h4 element, which the global heading rule puts on the display face.
    const offenders: string[] = [];
    for (const rule of CODE.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, selector, body] = rule;
      if (!/font-weight:\s*800\b/.test(body)) continue;
      const declaresDisplay = /font-family:\s*var\(--font-display\)/.test(body);
      const headingSelector = /(^|[\s.>+~])h[1-4]\b/.test(selector);
      if (!declaresDisplay && !headingSelector) offenders.push(selector.trim());
    }
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------- the radius scale */

describe("app.css radius scale (pass 30)", () => {
  // The radius family is SIX steps, declared once at the token block. Unlike
  // the type scale it is tokenized, so it needs two locks: the values must not
  // drift (a 16px card quietly becoming 14px changes every top-level surface),
  // and no `border-radius` may sidestep the tokens with a literal.
  const RADIUS_SCALE = {
    "--radius-small": "6px",
    "--radius-button": "8px",
    "--radius-box": "12px",
    "--radius-chip": "999px",
    "--radius-card": "16px",
    "--radius-panel": "22px",
  };

  /** The proportional micro radii the token block sanctions: 2-3px on meters,
   *  progress bars and inline text highlights, 4px on 16px boxes. They are a
   *  fraction of a tiny box, not steps — a scale step on a 16px square reads as
   *  a circle. */
  const MICRO = ["2px", "3px", "4px"];

  /** `50%` is a true circle (avatars, dots), `0` un-rounds a corner, `inherit`
   *  makes a child follow the box it fills. None of them is a length choice. */
  const NON_STEPS = ["50%", "0", "inherit"];

  it("declares the six radius tokens, and only those", () => {
    const declared = [...CODE.matchAll(/(--radius-[a-z0-9-]+)\s*:\s*([^;}]+)/g)]
      .map((m) => [m[1], m[2].trim()] as const);
    // One definition each — a second `--radius-card` further down the file is
    // exactly how `--font-display` came to lie for four passes (P16-UI-04).
    expect(declared.map(([name]) => name).sort()).toEqual(
      Object.keys(RADIUS_SCALE).sort(),
    );
    expect(Object.fromEntries(declared)).toEqual(RADIUS_SCALE);
  });

  it("every border-radius is a scale token (or a sanctioned non-step)", () => {
    // Shorthands round individual corners (`0 2px 2px 0` on a progress fill),
    // so the check is per corner value, not per declaration.
    const allowed = new Set([
      ...Object.keys(RADIUS_SCALE).map((t) => `var(${t})`),
      ...MICRO,
      ...NON_STEPS,
    ]);
    const offScale = [...CODE.matchAll(/border-radius:\s*([^;}]+)/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((corner) => !allowed.has(corner));
    expect([...new Set(offScale)].sort()).toEqual([]);
  });

  it("rounds no corner with a bare copy of a token's own value", () => {
    // `border-radius: 8px` renders identically to `var(--radius-button)` and is
    // the way a scale dies: the literal survives a token change. The micro set
    // shares no value with the scale, so this stays unambiguous.
    const literals = new Set(Object.values(RADIUS_SCALE));
    const bare = [...CODE.matchAll(/border-radius:\s*([^;}]+)/g)]
      .flatMap((m) => m[1].trim().split(/\s+/))
      .filter((corner) => literals.has(corner));
    expect([...new Set(bare)].sort()).toEqual([]);
  });
});

/* ------------------------------------------------------ the spacing scale */

describe("app.css spacing scale (pass 30)", () => {
  // Nine steps, documented at the token block and deliberately untokenized.
  // They are not lockable the way font-size is: 81 of the sheet's 944 spacing
  // declarations carry an off-scale value, and most are not drift — negative
  // optical nudges (`margin-top: -1px`), sub-step chip padding (`.04rem`), and
  // fixed panel measures (`4.4rem`) are one-site decisions, not steps. Snapping
  // them would be 81 layout changes wearing a lint fix's clothes.
  //
  // So the lock is on the scale's SHAPE instead of on every usage: a value that
  // reaches ten spacing sites is, by then, a step of the app's rhythm whether
  // anyone chose it or not. The set of those must be exactly the nine.
  const SPACING_SCALE = [
    "0", ".125rem", ".25rem", ".375rem", ".5rem", ".75rem", "1rem", "1.5rem",
    "2rem",
  ];
  /** Not a length — `margin: 0 auto` centres, it does not space. And not a
   *  step — `var(--dock-clear)` is the dock trigger's reach (interface review
   *  2026-09-06), a chrome measure every scroll container ending under the
   *  trigger reserves; it will pass ten sites without becoming a step. */
  const STRUCTURAL = ["auto", "var(--dock-clear)"];
  const DE_FACTO_STEP_AT = 10;

  const SPACING_PROP =
    /(?:^|[{;\s])(?:padding|margin|gap|row-gap|column-gap|(?:padding|margin)-(?:top|right|bottom|left|block|inline))\s*:\s*([^;}]+)/g;

  function spacingValueCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const m of CODE.matchAll(SPACING_PROP)) {
      // `calc(26px + .75rem)` splits into fragments no lookup will match; it is
      // one site either way, and one site never reaches the step threshold.
      for (const part of m[1].trim().split(/\s+/)) {
        counts.set(part, (counts.get(part) ?? 0) + 1);
      }
    }
    return counts;
  }

  it("has exactly nine de-facto steps, and they are the nine it declares", () => {
    const steps = [...spacingValueCounts()]
      .filter(([value, n]) => n >= DE_FACTO_STEP_AT && !STRUCTURAL.includes(value))
      .map(([value]) => value);
    expect(steps.sort()).toEqual([...SPACING_SCALE].sort());
  });

  it("keeps every declared step in real use", () => {
    // The other direction of the same gate: a step nothing uses is not a scale,
    // it is a comment. `2rem` is the thin one (10 sites, exactly the floor since
    // the task page's bottom padding became the dock reserve, interface review
    // 2026-09-06) — if a pass retires it, that is a decision made here, not a
    // silent narrowing.
    const counts = spacingValueCounts();
    const unused = SPACING_SCALE.filter(
      (step) => (counts.get(step) ?? 0) < DE_FACTO_STEP_AT,
    );
    expect(unused).toEqual([]);
  });
});

describe("D32-5 (pass 32): a SELECTED segment keeps its text color under hover", () => {
  // `.mini-seg button:hover:not(:disabled)` carries higher specificity than
  // `.mini-seg button.on` (the `:not()` argument counts), so the hover color
  // won on the selected segment: --fg on --fg, invisible. The contrast gate
  // is hover-blind (it composites declared pairs, not pseudo-class cascades),
  // so the restoring rule is pinned here for every segment family that has a
  // hover color AND a selected background.
  it("every segment family with a hover color restores the selected color under hover, or orders `.on` after the hover rule", () => {
    const families = ["seg", "mini-seg", "cap-seg"];
    for (const f of families) {
      const hover = CODE.match(new RegExp(`\\.${f} button:hover:not\\(:disabled\\)\\s*\\{([^}]*)\\}`));
      if (!hover) continue; // no hover color rule → nothing to outrank
      const onRule = CODE.match(new RegExp(`\\.${f} button(?:\\.[a-z-]+)*\\.on\\s*\\{([^}]*)\\}`));
      expect(onRule, `.${f} button.on must exist`).toBeTruthy();
      const restored = CODE.match(
        new RegExp(`\\.${f} button\\.on:hover:not\\(:disabled\\)\\s*\\{([^}]*)\\}`),
      );
      const onAfterHover = CODE.indexOf(onRule![0]) > CODE.indexOf(hover[0]);
      const onSpecificityWins = /button\.[a-z-]+\.on/.test(onRule![0]); // two classes ⇒ equal specificity, order decides
      expect(
        restored !== null || (onAfterHover && onSpecificityWins),
        `.${f}: the selected segment's color must survive hover`,
      ).toBe(true);
      if (restored) {
        // The restored color is the selected color, not the hover color.
        const selectedColor = /color:\s*([^;]+);/.exec(onRule![1])?.[1]?.trim();
        expect(restored[1]).toContain(`color: ${selectedColor}`);
      }
    }
  });
});

/**
 * Interface review 2026-09-06 — the sheet-side half of the entry-flow fixes.
 * The markup half is pinned by the board, home, login and shell suites; these
 * are the rules whose removal no other test would notice.
 */
describe("interface review 2026-09-06: the rules the fixes rest on", () => {
  it("declares the dock reserve once and every scroll container under the trigger takes it", () => {
    expect(CODE.match(/--dock-clear:/g)).toHaveLength(1);
    expect(decls(":root")).toMatch(
      /--dock-clear:\s*calc\(max\(20px, env\(safe-area-inset-bottom\)\) \+ 44px \+ 1rem\)/,
    );
    for (const selector of [
      ".home-shell",
      ".insights",
      ".policy-wrap",
      ".detail",
      ".col-body",
      ".live-wrap",
      ".profile-list",
      ".ag-detail",
    ]) {
      expect(decls(selector), selector).toMatch(/padding:[^;]*var\(--dock-clear\)/);
    }
    expect(decls(".board.list")).toMatch(/padding-block:\s*0 var\(--dock-clear\)/);
  });

  it("overlays the stage-move control in the card's bottom-right corner (ruling 365)", () => {
    // The control used to sit top-right and the head row reserved 36px for
    // it; it is a bare 20px chevron in the corner the property row leaves
    // free now, absolute, so no row reserves anything.
    expect(decls(".card-move")).toMatch(/position:\s*absolute/);
    expect(decls(".card-move")).toMatch(/bottom:\s*\.75rem/);
    expect(decls(".card-move .stage-menu-btn")).toMatch(/width:\s*24px;\s*height:\s*24px/);
    // One level above the trigger's own `.stage-menu-btn .sm-current`, which
    // comes later in the sheet: at equal specificity the dot came back.
    expect(decls(".card-move .stage-menu-btn .sm-current")).toMatch(/display:\s*none/);
    expect(decls(".card-move .stage-menu-btn .sm-caret")).toMatch(/width:\s*14px/);
    expect(decls(".col-head .add")).toMatch(/width:\s*24px;\s*height:\s*24px/);
  });

  it("wraps the store strip's button group and the list rows", () => {
    expect(decls(".store-strip .inline-row")).toMatch(/flex-wrap:\s*wrap/);
    expect(decls(".card.list-row")).toMatch(/flex-wrap:\s*wrap/);
    expect(decls(".card.list-row h3")).toMatch(/flex:\s*1 1 14rem/);
    expect(decls(".pj-grid")).toMatch(/minmax\(min\(320px, 100%\), 1fr\)/);
  });

  it("sizes every .field input at a 16px+ step under the mobile breakpoint", () => {
    // Asserts the INTENT, not a literal step: iOS zooms the viewport when a
    // focused input is under 16px, so the mobile block has to lift it to at
    // least 1rem. Pinning the exact value made the 2026-09-08 scale recut fail
    // here for no reason — the size had moved from 16.8px to 18px, which is
    // more compliant, not less.
    const mobile = RULES.filter((r) => r.at.includes("@media (max-width: 720px)"));
    const base = CODE.match(/\.field input\[type="text"\][^{]*\{/)![0];
    const inputs = [
      ...(base.match(/type="([a-z]+)"/g) ?? []).map((type) => `.field input[${type}]`),
      ...["text", "email", "password"].map((type) => `.field input[type="${type}"].mono`),
      ".cmdk-input",
    ];
    for (const selector of inputs) {
      const size = declsFor(mobile, selector).get("font-size");
      expect(size, `${selector} must be resized in the mobile block`).toMatch(/^[\d.]+rem$/);
      expect(Number.parseFloat(size!), `${selector}: 16px minimum, or iOS zooms on focus`).toBeGreaterThanOrEqual(1);
    }
  });

  it("marks an invalid field on the control itself, frame included", () => {
    expect(decls('.field input[aria-invalid="true"], .field textarea[aria-invalid="true"]')).toMatch(
      /border-color:\s*var\(--coral-dark\)/,
    );
    expect(decls('.repo-input:has(input[aria-invalid="true"])')).toMatch(/border-color:/);
  });

  it("keeps the drawer quiet: no UA ring on the focused rail, no reachable dock", () => {
    expect(decls(".rail:focus,\n.rail:focus-visible")).toMatch(/outline:\s*none/);
    expect(decls('body[data-rail-open="true"] .dock')).toMatch(/visibility:\s*hidden/);
  });
});

/* ------------------------------------------------- ruling 148: profile pass */

describe("app.css ruling 148 (profile pass, 2026-09-06)", () => {
  it("(a) the 2-up settings grids stretch their rows; the feed page does not", () => {
    // `align-items: start` was what let the two profile columns end at
    // different heights. Grid items stretch by default, and the stacked
    // column hands its slack to its last panel.
    expect(CODE).toMatch(/\.profile-cols\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(CODE).not.toMatch(/\.profile-cols\s*\{[^}]*align-items:\s*start/);
    expect(CODE).not.toMatch(/\.policy-cols\s*\{[^}]*align-items:\s*start/);
    // Ruling 149 re-application: Settings > Agent resources pairs four peer
    // panels two to a row, so its grid stretches for the same reason.
    expect(CODE).toMatch(/\.rsrc-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
    expect(CODE).not.toMatch(/\.rsrc-grid\s*\{[^}]*align-items:\s*start/);
    expect(CODE).toMatch(/\.profile-col > :last-child\s*\{[^}]*flex:\s*1 0 auto/);
    // A feed beside a short panel is the exemption: stretching the panel to the
    // feed's height would only produce a tall empty box.
    expect(CODE).toMatch(/\.activity-cols\s*\{[^}]*align-items:\s*start/);
  });

  it("(c) the OS preference stills every infinite loop but a spinner", () => {
    // With the in-app kill switch gone, `prefers-reduced-motion` is the one
    // signal, and each loop needs its own answer. They were found one at a
    // time: `.chip .working` (the status-chip dot on EVERY board card with an
    // agent at work) and `.rdot.running` kept pulsing under the preference
    // while three dots on the same `pulse-a` loop held still, and the log's
    // `.lcaret` kept blinking. The loops are read from the sheet, so the next
    // one is in scope the moment it is written; the three named ones keep the
    // scan from going vacuous. A loop is answered by a LATER reduce rule on the
    // same selector (same specificity, so source order decides) that sets
    // `animation: none`, or `display: none` for a decoration that has nothing
    // to show once it stops moving (the controller's highlight band).
    //
    // Canary: drop any selector from its reduce rule and this goes red, naming it.
    const SPINNERS = {
      ".run-spin": "the live run's loading ring: essential motion",
      ".ico.spin": "the shared loading icon: essential motion",
      ".store-strip .spin": "the store strip's loading icon: essential motion",
    } satisfies Record<string, string>;
    const reduced = (rule: CssRule) =>
      rule.at.some((q) => /prefers-reduced-motion:\s*reduce/.test(q));
    const looping = RULES.flatMap((rule, index) =>
      !reduced(rule) &&
      /\binfinite\b/.test(
        `${rule.decls.get("animation") ?? ""} ${rule.decls.get("animation-iteration-count") ?? ""}`,
      )
        ? selectorParts(rule).map((selector) => ({ selector, index }))
        : [],
    );
    const selectors = looping.map((l) => l.selector);
    // Ruling 457 moved the `pulse-a` loop onto each dot's `::after`, where it
    // scales and fades a copy of the dot instead of animating box-shadow.
    expect(selectors).toEqual(
      expect.arrayContaining([".chip .working::after", ".rdot.running::after", ".lcaret"]),
    );
    for (const spinner of Object.keys(SPINNERS)) {
      expect(selectors, `${spinner} is exempt as a spinner but no longer loops`).toContain(spinner);
    }
    for (const { selector, index } of looping) {
      if (selector in SPINNERS) continue;
      const stilled = RULES.some(
        (rule, at) =>
          at > index &&
          reduced(rule) &&
          (rule.decls.get("animation") === "none" || rule.decls.get("display") === "none") &&
          selectorParts(rule).includes(selector),
      );
      expect(stilled, `${selector} must hold still under prefers-reduced-motion`).toBe(true);
    }
  });

  it("(d) the warning pair is GitHub's, and dark boxes print their sentence in --fg", () => {
    const light = themeTokens(false);
    const dark = themeTokens(true);
    expect(light.get("--amber-light")).toBe("#fff8c5");
    expect(light.get("--amber-dark")).toBe("#735c0f");
    expect(dark.get("--amber-light")).toBe("#3a3019");
    expect(dark.get("--amber-dark")).toBe("#d29922");
    // The box text: olive on pale yellow in light (the base rule), the default
    // foreground on dark (the scoped override), amber only on the icon.
    expect(CODE).toMatch(/\.cred-warn\s*\{[^}]*color:\s*var\(--amber-dark\)/);
    expect(CODE).toMatch(
      /:root\[data-theme="dark"\] \.cred-warn,\s*:root\[data-theme="dark"\] \.archived-banner\s*\{\s*color:\s*var\(--fg\)/,
    );
    expect(CODE).toMatch(
      /:root\[data-theme="dark"\] \.cred-warn \.ico,\s*:root\[data-theme="dark"\] \.archived-banner \.ico\s*\{\s*color:\s*var\(--amber-dark\)/,
    );
  });

  it("ruling 149: the two release ✕ controls hover on the danger pair, not the error pair", () => {
    // `.rev-x` (release an engagement) and `.own-x` (release the owner) are
    // remove controls whose ceremonies commit in red, but they still hovered
    // on --coral-dark / --rose-light: the ERROR vocabulary, which reads brown
    // beside the destructive row-remove hovers.
    //
    // Canary: put either rule back on the coral pair and this goes red.
    expect(CODE).toMatch(
      /\.rev-x:hover:not\(:disabled\)\s*\{[^}]*color:\s*var\(--danger\)/,
    );
    expect(CODE).toMatch(/\.own-x:hover\s*\{[^}]*color:\s*var\(--danger\)/);
    for (const rule of [/\.rev-x:hover[^{]*\{([^}]*)\}/, /\.own-x:hover\s*\{([^}]*)\}/]) {
      const body = CODE.match(rule)![1];
      expect(body).not.toMatch(/--coral-/);
      expect(body).not.toMatch(/--rose-/);
    }
  });

  it("(150b) the board's attention notices take the amber pair, faults keep coral", () => {
    // Ruling 150(b): `.board-orphans` carried four tones through one class.
    // The archived-filter caption and the "no stages yet" empty
    // state are attention, not faults, so they take 148(d)'s recipe through a
    // modifier — amber on the icon, the border and the fill, the sentence
    // already `--fg` via `.board-orphans-label`. The base rule stays coral for
    // the unstaged-task and repository boxes.
    //
    // Canary: drop the modifier's own fill and the sweep measures its amber
    // label against the rose one underneath instead.
    const notice = CODE.match(/\.board-orphans\.notice\s*\{([^}]*)\}/);
    expect(notice, "the notice modifier must exist").toBeTruthy();
    expect(notice![1]).toMatch(/background:\s*color-mix\(in srgb, var\(--amber-light\)/);
    expect(notice![1]).toMatch(/border-color:\s*color-mix\(in srgb, var\(--amber-dark\)/);
    expect(notice![1]).toMatch(/color:\s*var\(--amber-dark\)/);
    expect(CODE).toMatch(/\.board-orphans\.notice > \.ico\s*\{\s*color:\s*var\(--amber-dark\)/);
    expect(CODE).toMatch(/(?:^|[};])\s*\.board-orphans\s*\{[^}]*background:\s*var\(--rose-light\)/);
  });

  it("one close control on every modal head and the page overlay", () => {
    const rule = CODE.match(/(?:^|[};])\s*\.icon-btn\.modal-close\s*\{([^}]*)\}/);
    expect(rule, "the shared close rule must exist").toBeTruthy();
    expect(rule![1]).toMatch(/border-radius:\s*50%/);
    expect(rule![1]).toMatch(/background:\s*transparent/);
    expect(rule![1]).toMatch(/box-shadow:\s*none/);
    // Phase 1 (2026-09-08): the page overlay's button WEARS `.modal-close`
    // rather than being named beside it in every selector, so `.overlay-x`
    // carries position and nothing else. Guard both halves: the appearance
    // rule must not re-acquire the overlay selector, and the overlay rule must
    // paint nothing (a fill or radius here means the pair drifted apart again).
    expect(CODE).not.toMatch(/\.icon-btn\.modal-close,\s*\.overlay-x/);
    const overlay = CODE.match(/(?:^|[};])\s*\.overlay-x\s*\{([^}]*)\}/);
    expect(overlay, "the overlay's positioning rule must exist").toBeTruthy();
    expect(overlay![1]).not.toMatch(/box-shadow:\s*var/);
    expect(overlay![1]).not.toMatch(/background|border-radius|width|height/);
    expect(overlay![1]).toMatch(/position:\s*absolute/);
    // Interface review 2026-09-06: the temp-password notice's dismiss joined
    // the same control at notice scale — one design, two sizes, and the glyph
    // keeps the 34/16 ratio. `flex: none` is what its old `.stg-x` carried:
    // `.cred-ok` is a flex row, so without it the circle shrinks under its
    // sentence.
    const inNotice = CODE.match(/\.cred-ok \.modal-close\s*\{([^}]*)\}/);
    expect(inNotice, "the notice-scale close must exist").toBeTruthy();
    expect(inNotice![1]).toMatch(/width:\s*28px/);
    expect(inNotice![1]).toMatch(/flex:\s*none/);
    expect(CODE).toMatch(/\.cred-ok \.modal-close \.ico\s*\{[^}]*width:\s*14px/);
  });
});

/* -------------------------- ruling 149: the fields that had no chrome ---- */

describe("app.css ruling 149: every typing control wears the sheet's chrome", () => {
  const mobile = CODE.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/)![1];

  it("the guardrail threshold field is boxed", () => {
    // It was the app's only text-like input outside `.field`: UA border, UA
    // fill, UA radius, no focus wash, beside an `Apply` wearing `.btn`.
    // Canary: cut the rule back to `width: 5.5rem` and this goes red.
    const box = decls('.guard-ctl input[type="number"]');
    expect(box).toMatch(/border:\s*1px solid var\(--border-control\)/);
    expect(box).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(box).toMatch(/background:\s*var\(--surface\)/);
    expect(box).toMatch(/color:\s*var\(--fg\)/);
    expect(box).toMatch(/padding:\s*\.25rem \.5rem/);
    // Design pass 2026-09-08: org settings' run-concurrency field sits in a
    // `.guard-ctl` too, so there is one box to drift.
    expect(decls('.guard-ctl input[type="number"]:focus')).toMatch(
      /box-shadow:\s*0 0 0 3px var\(--focus-wash\)/,
    );
    expect(decls('.guard-ctl input[type="number"]:disabled')).toMatch(/opacity:/);
    // 16px+ on a phone, or iOS Safari zooms the page on focus.
    expect(mobile).toContain('.guard-ctl input[type="number"]');
  });

  it("a mono textarea keeps its face inside a .field, at both widths", () => {
    // `.field textarea` sets the body face at (0,1,1) and outranks bare
    // `.mono`, so the store document editor needed the textarea twin of
    // `.field input.mono` — which the P21 gate pins by its exact selector and
    // therefore cannot absorb a second one.
    expect(decls(".field textarea.mono")).toMatch(/font-family:\s*var\(--font-mono\)/);
    // Declared after the mobile block, so the mobile rule needs one selector
    // more to be reached from there.
    expect(mobile).toContain(".field textarea[rows].mono");
  });
});

/* ------------------- ruling 149: GitHub's danger button, pinned by value --- */

describe("app.css ruling 149: the destructive control is GitHub's danger button", () => {
  it("the pair is defined in both palettes at the owner's values", () => {
    // Nothing pinned the headline of the pass: reverting `.btn.danger` to the
    // tinted-pink face it replaced (`--coral-dark` on a `--coral-light` wash)
    // left the whole suite green, because the contrast sweep clears both faces
    // and the TSX tests only assert that the `danger` CLASS is applied.
    //
    // Canary: change either hex and this goes red.
    const light = themeTokens(false);
    const dark = themeTokens(true);
    expect(light.get("--danger")).toBe("#cf222e");
    expect(light.get("--danger-fill")).toBe("#a40e26");
    expect(dark.get("--danger")).toBe("#f85149");
    expect(dark.get("--danger-fill")).toBe("#da3633");
    // One label colour for the filled state, inherited by dark from `:root`.
    for (const table of [light, dark]) {
      expect(table.get("--on-danger")).toBe("#ffffff");
    }
  });

  it("a neutral face with a red label, filling red on hover", () => {
    const rest = decls(".btn.danger");
    expect(rest).toMatch(/color:\s*var\(--danger\)/);
    // The rest fill is DECLARED, not inherited: the sweep pairs a selector's
    // label with the FIRST background declared for it, which would otherwise be
    // the hover's red.
    expect(rest).toMatch(/background:\s*var\(--surface\)/);
    expect(rest).toMatch(/border-color:\s*var\(--border\)/);

    const hover = decls(".btn.danger:hover:not(:disabled)");
    expect(hover).toMatch(/background:\s*var\(--danger-fill\)/);
    expect(hover).toMatch(/border-color:\s*var\(--danger-fill\)/);
    expect(hover).toMatch(/color:\s*var\(--on-danger\)/);

    // The ghost variant keeps the ghost's transparent face and hairline.
    expect(decls(".btn.ghost.danger")).toMatch(/background:\s*transparent/);
    expect(decls(".btn.ghost.danger")).toMatch(/border-color:\s*var\(--hairline\)/);
  });

  it("no destructive surface still paints itself from the error pair", () => {
    // `--coral-*` is ERROR TEXT now, not a control colour.
    for (const selector of [
      ".menu-item.danger",
      ".danger-panel",
      ".fm-act.del",
    ]) {
      const body = decls(selector);
      expect(body, selector).not.toMatch(/--coral-/);
      expect(body, selector).toMatch(/var\(--danger\)/);
    }
    // The row-remove hovers the same sweep re-pointed keep the danger pair too.
    expect(decls(".fm-act.del:hover")).not.toMatch(/--coral-/);
    expect(decls(".menu-item.danger:hover")).not.toMatch(/--coral-/);
  });

  it("(150a) error boxes print their sentence in --fg on dark", () => {
    // Ruling 150(a): 148(d)'s split, applied to the pair ruling 149 keeps for
    // errors — the box holds its coral border, fill and icon, and only the
    // SENTENCE moves, and only on dark, where `--coral-dark` is #ff9e9e: a
    // tint doing a paragraph's work. Light keeps GitHub's near-black red,
    // which is already body-weight ink.
    //
    // Canary: delete either rule below and this goes red.
    expect(CODE).toMatch(
      /:root\[data-theme="dark"\] \.login-err,\s*:root\[data-theme="dark"\] \.form-err,\s*:root\[data-theme="dark"\] \.rsrc-main \.rsrc-err\s*\{\s*color:\s*var\(--fg\)/,
    );
    expect(CODE).toMatch(
      /:root\[data-theme="dark"\] \.login-err \.ico,\s*:root\[data-theme="dark"\] \.form-err \.ico\s*\{\s*color:\s*var\(--coral-dark\)/,
    );
    // The pair is narrowed, not retired: the base rule is still coral.
    expect(decls(".login-err, .form-err")).toMatch(/color:\s*var\(--coral-dark\)/);
    // The consequence row (R17-1) carries no icon, so its uppercase kicker is
    // the tone carrier there — it stays coral while the value takes --fg.
    expect(CODE).toMatch(
      /:root\[data-theme="dark"\] \.obs\.warn > span:last-child\s*\{\s*color:\s*var\(--fg\)/,
    );
    expect(decls(".obs.warn .k")).toMatch(/color:\s*var\(--coral-dark\)/);
  });
});

/**
 * 2026-09-07: the New project primary shows its request in flight (the loader
 * glyph spinning where the plus was, "Creating project…"), and like every
 * create/save primary it is `disabled={busy}`. The sheet names two opacity
 * steps for unavailable controls, .45 disabled and .7 busy, but
 * `.btn:disabled` is declared AFTER `.btn[aria-busy="true"]` at equal
 * specificity, so a button that was both painted at .45 with a not-allowed
 * cursor: in flight read as refused.
 */
describe("app.css paints a busy AND disabled button with the busy step", () => {
  it("keeps the two steps: .45 disabled, .7 busy", () => {
    expect(CODE).toMatch(/\.btn\[aria-busy="true"\]\s*\{[^}]*opacity:\s*\.7/);
    expect(CODE).toMatch(/\.btn:disabled,[^{]*\{[^}]*opacity:\s*\.45/);
  });

  it("lets the busy step win where both apply, by specificity rather than order", () => {
    // Order is a fragile tie-break (the disabled rule sits 400 lines later);
    // the override adds a pseudo-class so it wins wherever it is declared.
    const both = CODE.match(/\.btn\[aria-busy="true"\]:disabled\s*\{([^}]*)\}/);
    expect(both, "the busy+disabled override must exist").not.toBeNull();
    expect(both![1]).toMatch(/opacity:\s*\.7/);
    expect(both![1]).not.toMatch(/cursor:\s*not-allowed/);
  });
});

// Design pass 2026-09-08: the second pill tier (`.pill.quiet`) reaches the
// chips that are not `.pill`, and the tone survives in the dot.
describe("app.css: the quiet tier reaches every surface (design pass 2026-09-08)", () => {
  const declsOf = (selector: string) => {
    const rule = RULES.find((r) => r.selector === selector);
    expect(rule, selector).toBeDefined();
    return rule!.decls;
  };
  it("the task key rests quiet with a control edge, and takes its blue on hover", () => {
    // It was a filled --blue-soft chip on every row of the activity stream.
    const rest = declsOf(".keybtn");
    expect(rest.get("background")).toBe("transparent");
    expect(rest.get("color")).toBe("var(--muted)");
    expect(rest.get("box-shadow")).toContain("var(--border-control)");
    expect(declsOf(".keybtn:hover").get("background")).toBe("var(--blue-soft)");
    // "Show more" shares the class and is a link, not a key.
    expect(declsOf(".act-toggle").get("box-shadow")).toBe("none");
  });
  it("an ineligible stage chip is demoted in ink, not opacity", () => {
    const off = declsOf(".stage-chip.off");
    expect(off.get("opacity")).toBeUndefined();
    expect(off.get("color")).toBe("var(--placeholder)");
  });
  it("a quiet chip keeps its tone in the dot", () => {
    for (const kind of ["ready", "done", "info", "input", "agent"]) {
      expect(
        RULES.some((r) => r.selector === `.pill.quiet.${kind} .pdot`),
        kind,
      ).toBe(true);
    }
  });
});

/* Ruling 363: the code reader's syntax palette is small text on --bg (the
   reader's ground) inside a dialog on --surface — both must clear AA, in both
   themes, for every scope family the highlighter can colour.
   Ruling 508: the families are read off the reader's own theme, through the
   reader's own token-to-class map. A hand-written list of eight left out the
   three a diff's lines and a log's levels resolve to, so both rendered in the
   plain foreground. Punctuation is the one family that stays --fg. */
describe("app.css code reader palette meets WCAG AA (ruling 363)", () => {
  const AA_SMALL_TEXT = 4.5;
  const FOREGROUND_FAMILIES = ["punctuation"];
  const EMITTED_FAMILIES = [
    ...new Set(
      (createCssVariablesTheme(THEME_OPTIONS).tokenColors ?? []).flatMap(({ settings }) => {
        const className = toToken({ content: "", offset: 0, color: settings.foreground })
          .className;
        return className ? [className.replace(/^tk-/, "")] : [];
      }),
    ),
  ];
  const SYNTAX_FAMILIES = EMITTED_FAMILIES.filter(
    (family) => !FOREGROUND_FAMILIES.includes(family),
  );
  const THEMES = { light: LIGHT_ROOT, dark: DARK_ROOT };

  it("reads every family off the theme, the diff and log families among them", () => {
    // A floor, so a theme whose colours stop parsing cannot pass by listing none.
    expect(EMITTED_FAMILIES).toEqual(
      expect.arrayContaining([
        "keyword", "string", "string-expression", "comment", "constant", "parameter",
        "function", "link", "inserted", "deleted", "changed", ...FOREGROUND_FAMILIES,
      ]),
    );
  });
  for (const [theme, root] of Object.entries(THEMES)) {
    it(`${theme} theme: every --syn-* token clears 4.5:1 on --bg and --surface`, () => {
      for (const family of SYNTAX_FAMILIES) {
        const value = tokenIn(root, `--syn-${family}`);
        for (const ground of ["--bg", "--surface"]) {
          const groundValue = tokenIn(root, ground);
          expect(
            contrastRatio(value, groundValue),
            `${theme} --syn-${family} (${value}) on ${ground} (${groundValue})`,
          ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
        }
      }
    });
  }

  it("every scope family the highlighter emits has a rule that reads its token", () => {
    for (const family of SYNTAX_FAMILIES) {
      expect(CODE, family).toMatch(
        new RegExp(`\\.code-view \\.tk-${family} \\{ color: var\\(--syn-${family}\\); \\}`),
      );
    }
  });
});

/* Ruling 364: a stage colour is a preset NAME; these rules are the one place it
   becomes paint. Every preset needs a token in both theme blocks that clears
   WCAG 1.4.11's 3:1 on the surfaces the dots and the home meter sit on, and
   the attribute rule that carries the name to `--stage`. */
describe("app.css stage colour presets (ruling 364)", () => {
  const NON_TEXT_CONTRAST = 3;
  const THEMES = { light: LIGHT_ROOT, dark: DARK_ROOT };
  for (const [theme, root] of Object.entries(THEMES)) {
    it(`${theme} theme: every --stage-* token exists and clears 3:1 on --surface and --bg`, () => {
      // Every preset the schema accepts (`STAGE_COLORS`): a name added there
      // without its tokens and its `[data-stage-color]` rule fails here.
      for (const preset of STAGE_COLORS) {
        const value = tokenIn(root, `--stage-${preset}`);
        for (const ground of ["--surface", "--bg"]) {
          const groundValue = tokenIn(root, ground);
          expect(
            contrastRatio(value, groundValue),
            `${theme} --stage-${preset} (${value}) on ${ground} (${groundValue})`,
          ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST);
        }
      }
    });
  }

  it("every preset name resolves to its token through data-stage-color, and the stage surfaces read it", () => {
    for (const preset of STAGE_COLORS) {
      expect(CODE, preset).toContain(
        `[data-stage-color="${preset}"] { --stage: var(--stage-${preset}); }`,
      );
    }
    for (const consumer of [".sdot[data-stage-color]", ".col-stage-dot[data-stage-color]", ".pj-meter span[data-stage-color]", ".swatch[data-stage-color]"]) {
      expect(CODE, consumer).toContain(consumer);
    }
    expect(CODE).toMatch(/\.pj-meter\.is-empty span\[data-stage-color\] \{\s*flex: 1;\s*background: color-mix\(in srgb, var\(--stage\), transparent 82%\);\s*\}/);
  });
});

/**
 * Ruling 419(b): the controller page's rail scrolls itself and the conversation
 * stays a capped scroller at every width. jsdom has no layout, so the rules that
 * produce the layout are pinned here; the live measurements are in the ruling
 * (rail 4,539px scrolling with the page, a 12,625px phone transcript).
 */
describe("app.css controller layout (ruling 419)", () => {
  const ruleBody = (css: string, selector: string): string => {
    const m = css.match(new RegExp(`(?:^|\\n|\\})\\s*${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
    expect(m, `${selector} must have a rule`).toBeTruthy();
    return m![1]!;
  };
  const collapse = () => CODE.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/)![1]!;

  it("keeps the rail its own scroller, a column of the band beside the conversation", () => {
    // Ruling 524(a): the rail no longer pins a short card over empty page; the
    // band's one row gives it the conversation's height and it scrolls inside
    // that. CANARY: drop `overflow-y: auto` from `.ctl-side`, or the band's
    // row, and the rail scrolls with the page and stretches it again.
    const side = requiredDecls(plain, ".ctl-side");
    expect(side.get("overflow-y")).toBe("auto");
    expect(side.get("min-height")).toBe("0");
    expect(requiredDecls(plain, ".ctl-layout").get("grid-template-rows")).toBe("minmax(0, 1fr)");
  });

  it("keeps the transcript a capped scroller in the one-column layout", () => {
    // CANARY: restore `.ctl-wrap .ctl-transcript { max-height: none; }`.
    const narrow = ruleBody(collapse(), ".ctl-wrap .ctl-transcript");
    expect(narrow).not.toMatch(/max-height:\s*none/);
    expect(narrow).toMatch(/max-height:\s*calc\(100dvh - \d+px\)/);
    // One column: the rail flows after the conversation instead of pinning.
    expect(ruleBody(collapse(), ".ctl-wrap .ctl-side")).toMatch(/position:\s*static/);
  });

  it("ruling 419(j): the open dock's button perches ABOVE the phone sheet, clear of its header", () => {
    // Measured live at 375×812: the sheet's top at y=172 and the perched button
    // at 169-203, across the header's pop-out and Close buttons. The travel
    // must count the dock's own bottom inset and the scaled button's
    // half-height. CANARY: restore `- 56px`.
    const collapse720 = CODE.match(/\.dock\[data-open="true"\] \.dock-fab \{([^}]*)\}/);
    expect(collapse720, "the perch rule must exist").toBeTruthy();
    // Ruling 454 adds the sheet's drag to the travel, so the button rides a
    // pulled sheet; at rest the term is 0px.
    expect(collapse720![1]).toContain(
      "calc(-1 * (min(80dvh, 640px) - max(20px, env(safe-area-inset-bottom)) + 3px) + var(--sheet-drag, 0px))",
    );
  });

  it("U39-11: a console tool chip wraps rather than pushing its detail past a phone's edge", () => {
    // Measured at 375px: `mcp__viberr_controller__write_knowledge_doc` is one
    // unbreakable run, and the console scrolled sideways (285px of 271).
    // CANARY: drop `flex-wrap: wrap` from `.log-chip`.
    expect(ruleBody(CODE, ".log-chip")).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(CODE, ".log-chip .lc-name")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("U39-17: a long sha in a stream notice may break rather than push the page sideways", () => {
    // Measured at 375px: a 40-character sha made the overlay 413px wide inside
    // 323. CANARY: drop the rule.
    const all = [...CODE.matchAll(/\n\.pev-main \{([^}]*)\}/g)].map((m) => m[1]).join(" ");
    expect(all).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("U39-16: on a phone a notification's trailing controls take their own line", () => {
    // Measured at 375px: the text column was 90px beside Mark read, the dot
    // and the time. CANARY: drop `flex-wrap: wrap` from the phone rule.
    const phone = CODE.match(/@media \(max-width: 560px\) \{([\s\S]*?)\n\}/);
    expect(phone, "the 560px block must exist").toBeTruthy();
    expect(phone![1]).toMatch(/\.ntf-ev \{[^}]*flex-wrap:\s*wrap/);
  });

  it("U39-13: a wrapped review-queue row reads its chips left to right from the row's edge", () => {
    // CANARY: drop the `.rq-meta` override from the 1100px block.
    const narrow = collapse();
    expect(ruleBody(narrow, ".rq-meta")).toMatch(/justify-content:\s*flex-start/);
    expect(ruleBody(narrow, ".rq-meta")).toMatch(/max-width:\s*none/);
    expect(ruleBody(narrow, ".rq-meta .wait-tag")).toMatch(/margin-left:\s*0/);
  });

  it("U39-12: the dock's scope pill gives way before the controller's name", () => {
    // Measured at 375px: "Contro…" beside "AX-21 · ax-cl…". CANARY: drop the
    // pill's shrink weight and the two shrink alike again.
    expect(ruleBody(CODE, ".dock-head .pill")).toMatch(/flex:\s*0 100 auto/);
    // Measured in the preview with only the pill's weight: the title still
    // lost a pixel (79 of 80). It does not shrink at all now; a long name is
    // capped instead.
    expect(ruleBody(CODE, ".dock-title")).toMatch(/flex:\s*0 0 auto;\s*max-width:\s*45%/);
  });

  it("ruling 419(i): inline code in markdown may break a long token rather than overflow", () => {
    // CANARY: drop `overflow-wrap: anywhere` from `.md-body code.mono`.
    expect(ruleBody(CODE, ".md-body code.mono")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("ruling 476(a): a link in markdown may break a long URL rather than push the transcript sideways", () => {
    // Measured live (F40-21): the dock's transcript scrolled 702px in 388,
    // with 142 of 228 links past its edge; /controller at 375px 693px in 315.
    // CANARY: drop `overflow-wrap: anywhere` from `.md-body a`.
    expect(ruleBody(CODE, ".md-body a")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("ruling 476(i): markdown prose may break any long token, and code blocks and tables keep their scrollers", () => {
    // Measured live after the 476(a) fix: "Added/Changed/Deprecated/Removed/
    // Fixed/Security." in a list item scrolled /controller's transcript at
    // 375px 433px in 315, and the dock's 442 in 388.
    // CANARY: drop the prose rule, or the reset on code blocks and tables.
    const wrap = (selector: string) => declsFor(plain, selector).get("overflow-wrap");
    const prose = [".md-body p", ".md-body li", ".md-body blockquote", ".md-body h1", ".md-body h2", ".md-body h3", ".md-body h4", ".md-body h5", ".md-body h6"];
    for (const selector of prose) expect(wrap(selector), selector).toBe("anywhere");
    for (const scroller of [".md-body pre", ".md-table-wrap"]) expect(wrap(scroller), scroller).toBe("normal");
  });

  it("ruling 476(e): in one column the thread switcher takes a row of its own", () => {
    // Measured at 375px (F40-25): 97px beside New and Home, reading "Hi. I'm s".
    // CANARY: restore `flex: 1 1 0` on the picker, or drop the row's wrap.
    const narrow = collapse();
    expect(ruleBody(narrow, ".ctl-wrap .ctl-head-acts")).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(narrow, ".ctl-wrap .ctl-picker")).toMatch(/flex:\s*1 1 100%/);
  });

  it("ruling 419(e): a packet's code observation keeps its line breaks", () => {
    // CANARY: drop `white-space: pre-wrap` from `.obs code`.
    expect(ruleBody(CODE, ".obs code")).toMatch(/white-space:\s*pre-wrap/);
  });

  it("shows the thread switcher only where the rail's list is out of view, and no key hint on touch", () => {
    expect(ruleBody(CODE, ".ctl-picker")).toMatch(/display:\s*none/);
    expect(ruleBody(collapse(), ".ctl-wrap .ctl-picker")).toMatch(/display:\s*block/);
    const coarse = CODE.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/);
    expect(coarse, "a coarse-pointer block must exist").toBeTruthy();
    expect(coarse![1]).toMatch(/\.kbd-hint\s*\{\s*display:\s*none;\s*\}/);
  });

  it("U39-27: on a touch screen the rail's small links are tall enough for a finger", () => {
    // Measured at 375px: 15-16px tall. CANARY: drop the padding rule. (The
    // goal chains' own controls it also listed left with them, ruling 503.)
    const coarse = CODE.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/)![1];
    expect(coarse).toMatch(/\.ctl-all-toggle \.linkish\s*\{\s*padding-block:\s*\.3rem;\s*\}/);
  });
});

/**
 * Ruling 524 (owner, 2026-09-27: "it show lots of empty space everywhere"). The
 * controller page was a 1200px column centred on a 1920px screen, its console
 * a 320px box under the composer, and the rail and the transcript each ended
 * at a height of their own over empty page. jsdom has no layout, so the rules
 * the band rests on are pinned here; the before and after screenshots are on
 * the ruling's PR.
 */
describe("app.css controller band (ruling 524)", () => {
  const band = RULES.filter((r) => r.at.some((a) => a === "@media (width > 1100px)"));
  const split = band.filter((r) => r.at.some((a) => a.startsWith("@container ctl")));
  const wide = band.filter((r) => !split.includes(r));
  const OPEN = '.ctl-layout:has(> .ctl-run:not([data-console="closed"]))';
  const CLOSED = '.ctl-layout:has(> .ctl-run[data-console="closed"])';

  it("(a) puts the run in a column between the conversation and the rail", () => {
    // CANARY: drop the three-column rule, and the pane lands in the rail's
    // 17rem column with the rail pushed under the conversation.
    expect(requiredDecls(wide, OPEN).get("grid-template-columns")).toBe("minmax(0, 1fr) minmax(0, 1fr) 17rem");
    // Too narrow for three (a project's page on a laptop): the conversation
    // and the run split the band, the rail follows under it, and the head's
    // switcher names the thread.
    expect(requiredDecls(split, OPEN).get("grid-template-columns")).toBe("minmax(0, 1fr) minmax(0, 1fr)");
    expect(requiredDecls(split, `${OPEN} > .ctl-side`).get("grid-column")).toBe("1 / -1");
    const picker = '.ctl-wrap:has(> .ctl-layout > .ctl-run:not([data-console="closed"])) .ctl-picker';
    expect(requiredDecls(split, picker).get("display")).toBe("block");
    // A hidden console leaves the strip alone: it goes under the composer and
    // the rail comes back beside the conversation.
    expect(requiredDecls(wide, '.ctl-layout > .ctl-run[data-console="closed"]').get("grid-row")).toBe("2");
    expect(requiredDecls(wide, `${CLOSED} > .ctl-side`).get("grid-row")).toBe("1 / -1");
    // The standalone page is no longer a 1200px column, and it is the
    // screen's height so the band has one to fill.
    expect(requiredDecls(plain, ".ctl-wrap.standalone").get("max-width")).toBe("1920px");
    expect(requiredDecls(wide, ".ctl-wrap.standalone").get("height")).toBe("100dvh");
  });

  it("(a) gives the console the pane's height, where it was a 320px box", () => {
    // CANARY: drop the `.ctl-run .console` rule and the console is 320px
    // however tall the screen, over an empty pane.
    const box = requiredDecls(wide, ".ctl-run .console");
    expect(box.get("flex")).toBe("1");
    expect(box.get("height")).toBe("auto");
    // Every box between the pane and the console passes the height down.
    for (const link of [".ctl-run > .runbar", ".ctl-run > .panel", ".ctl-run > .runbar > .runbar-body", ".ctl-run .runbar-console > .panel"]) {
      expect(requiredDecls(wide, link).get("flex"), link).toBe("1");
    }
    // One column is no band: the collapse keeps the page flowing, and the
    // console its own 320px.
    expect(requiredDecls(RULES.filter((r) => r.at.includes("@media (max-width: 1100px)")), ".ctl-wrap .ctl-layout").get("flex")).toBe("none");
    expect(requiredDecls(plain, ".console").get("height")).toBe("320px");
  });

  it("(d) reads the run's facts as one strip under its phase, with the actions beside the phase", () => {
    // The four cells were boxes floated right of the phase, and Hide console
    // and Interrupt took a row of their own under them: 140px of card for
    // two lines of text. CANARY: restore `.run-stats { display: flex }`.
    const body = requiredDecls(plain, ".runbar-body");
    expect(body.get("display")).toBe("grid");
    expect(body.get("grid-template-areas")).toBe('"phase actions" "stats stats"');
    const stats = requiredDecls(plain, ".run-stats");
    expect(stats.get("display")).toBe("grid");
    expect(stats.get("grid-area")).toBe("stats");
    expect(stats.get("grid-template-columns")).toBe("repeat(4, minmax(0, 1fr))");
    // A narrow card stacks, and a phone's takes the cells two by two.
    const narrow = RULES.filter((r) => r.at.some((a) => a.startsWith("@container runbar")));
    expect(requiredDecls(narrow, ".run-stats").get("grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("(d) wraps the SDK line inside its own box before the console's toggles leave the row", () => {
    // In the run pane the line dropped under the state pill and pushed
    // "{ } raw" and "follow" to a third row. CANARY: drop `min-width: 0`
    // from `.logs-meta`, or the toggles' `margin-left: auto`.
    const meta = requiredDecls(plain, ".logs-meta");
    expect(meta.get("flex")).toBe("1 1 12rem");
    expect(meta.get("min-width")).toBe("0");
    expect(requiredDecls(plain, ".logs-tools").get("margin-left")).toBe("auto");
  });
});

/**
 * Ruling 451 (owner, 2026-09-23): seven places move, drawn from transitions.dev.
 * jsdom runs no animation, so the rules the motion rests on are pinned here;
 * the components' own suites pin the keys and attributes that trigger it.
 */
describe("app.css ruling 451: motion from transitions.dev", () => {
  const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const declared = new Set([...CODE.matchAll(/@keyframes\s+([-\w]+)/g)].map((m) => m[1]!));
  /** The keyframes names an `animation` value plays, one per layer. */
  const animationNames = (value: string): string[] => {
    const KEYWORDS = new Set([
      "none", "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
      "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards", "backwards",
      "both", "running", "paused", "initial", "inherit", "unset",
    ]);
    return value
      .replace(/[-\w]+\([^()]*\)/g, " ")
      .split(",")
      .map((layer) => layer.trim().split(/\s+/).find((t) => /^[a-z_][-\w]*$/i.test(t) && !KEYWORDS.has(t)))
      .filter((n): n is string => n !== undefined);
  };

  it("(b) every animation in the sheet plays a @keyframes the sheet declares", () => {
    // CANARY: delete `@keyframes reveal-down`. `.cap-mbody` named the board's
    // `dropPreviewIn` after the drag rebuild deleted it (7c24fabc), so the
    // capability group opened with no entrance for anyone but a reduced-motion
    // reader, and no gate noticed.
    const played = RULES.flatMap((r) =>
      animationNames(r.decls.get("animation") ?? r.decls.get("animation-name") ?? "").map((n) => `${r.selector} → ${n}`),
    );
    // A floor against a vacuous scan (it counts rules, and ruling 457 folded
    // the five `pulse-a` rules into one).
    expect(played.length).toBeGreaterThan(35);
    expect(played.filter((p) => !declared.has(p.split(" → ")[1]!))).toEqual([]);
    expect(requiredDecls(plain, ".cap-mbody").get("animation")).toMatch(/^reveal-down\b/);
  });

  it("(a) a status line's new words rise in, and the working sentence carries a band over its own words", () => {
    // CANARY: drop `.ctl-working-step[data-fresh]` from the swap-in rule.
    // Ruling 459: only a line that replaced the first words carries
    // `data-fresh`, so the line on screen at first paint stands still.
    for (const selector of [".run-phase .ph[data-fresh]", ".run-phase .step[data-fresh]", ".ctl-working-step[data-fresh]"]) {
      expect(requiredDecls(plain, selector).get("animation"), selector).toMatch(/^swap-in \.15s var\(--ease-out\)$/);
    }
    expect(CODE).toMatch(/@keyframes swap-in \{ from \{ opacity: 0; transform: translateY\(4px\); filter: blur\(2px\); \}/);
    const band = requiredDecls(plain, ".ctl-working-text::before");
    // The copy is the element's own `data-text`, silenced for assistive tech
    // (the `/ ""` alt text) so the sentence is not read twice.
    expect(band.get("content")).toBe('attr(data-text) / ""');
    expect(band.get("background-clip")).toBe("text");
    expect(band.get("color")).toBe("transparent");
    expect(band.get("background")).toMatch(/var\(--fg\) 50%/);
    expect(band.get("animation")).toMatch(/^shimmer 2s linear infinite$/);
    expect(requiredDecls(plain, ".ctl-working-text").get("position")).toBe("relative");
  });

  it("(f) the sign-in check's dash covers the whole check path, and a check that never animates is whole", () => {
    // The dash must be at least the drawn path's length or the tail of the
    // check never appears; far longer and the draw spends its first frames on
    // nothing. Measured off the icon set itself, so redrawing the glyph
    // re-measures. CANARY: set the dash to 20.
    const icons = readFileSync(fileURLToPath(new URL("./ui/icon.tsx", import.meta.url)), "utf8");
    const d = icons.match(/\n\s*check: '<path d="([^"]+)"\/>'/)![1]!;
    expect(d).toMatch(/^[MLml0-9.\s-]+$/);
    let at: [number, number] = [0, 0];
    let length = 0;
    for (const [, cmd, args] of d.matchAll(/([MLml])\s*([-0-9.\s]+)/g)) {
      const pair = args!.trim().split(/\s+/).map(Number);
      expect(pair).toHaveLength(2);
      const x = pair[0]!;
      const y = pair[1]!;
      const next: [number, number] = cmd === cmd!.toLowerCase() ? [at[0] + x, at[1] + y] : [x, y];
      if (cmd !== "M" && cmd !== "m") length += Math.hypot(next[0] - at[0], next[1] - at[1]);
      at = next;
    }
    const path = requiredDecls(plain, '.signin-step[data-state="done"] .signin-mark .ico path');
    const dash = Number(path.get("stroke-dasharray"));
    expect(dash).toBeGreaterThanOrEqual(length);
    expect(dash - length).toBeLessThan(1.5);
    // The offset lives only in the keyframe's `from`, held through the delay
    // by `backwards`: with the animation off, the check is drawn whole.
    expect(path.has("stroke-dashoffset")).toBe(false);
    expect(path.get("animation")).toMatch(/^check-draw \.3s var\(--ease-out\) 80ms backwards$/);
    expect(CODE).toMatch(new RegExp(`@keyframes check-draw \\{ from \\{ stroke-dashoffset: ${dash}; \\}`));
  });

  it("(g) .refused plays the recipe's shake: legs of 80/80/60/60ms over .28s", () => {
    // The record says which legs the stops make, so the stops are pinned.
    // CANARY: move the second stop to 50% (80/60/80/60).
    expect(requiredDecls(plain, ".refused").get("animation")).toMatch(/^shake \.28s linear$/);
    const body = CODE.match(/@keyframes shake \{([\s\S]*?)\n\}/)![1]!;
    const stops = [...body.matchAll(/([\d.]+)% \{ transform: translateX\((-?\d+)(?:px)?\)/g)].map((m) => ({
      at: Number(m[1]),
      x: Number(m[2]),
    }));
    expect(stops.map((s) => s.x)).toEqual([0, 6, -6, 4, 0]);
    const legs = stops.slice(1).map((s, i) => Math.round(((s.at - stops[i]!.at) / 100) * 280));
    expect(legs).toEqual([80, 80, 60, 60]);
  });

  it("(g) every refusal box carries .refused, keyed on its refusal, and shakes once per refusal", () => {
    // Two-way. A box that answers a refused click (an alert keyed on the
    // refusal, so a repeat mounts a new one) must be able to shake; a box that
    // can shake must be keyed on its refusal (a stable key never replays), and
    // must say when its shake has played (`useRefusalShake`'s onAnimationEnd),
    // or else be keyed on the refusal object itself (login's `refusalKey`), so
    // that typing it invalid again does not shake it. CANARY: drop `.refused`
    // from any box (the five this check found first were new-project-modal,
    // create-profile-modal, execution-profile and settings-page's invite and
    // repair boxes), or its onAnimationEnd.
    /** Every JSX opening tag in a source, braces, strings and comments skipped.
     *  A line comment inside an attribute's braces is skipped too: read as code,
     *  the apostrophe in "the project's epics" (task-details-panel.tsx, ruling
     *  548's review) opened a string that ran the Epic row's tag on for 333
     *  lines, into the wait editor's alert below it. */
    const openingTags = (src: string): { tag: string; line: number }[] => {
      const out: { tag: string; line: number }[] = [];
      for (const m of src.matchAll(/<([A-Za-z][\w.]*)[\s>]/g)) {
        let depth = 0;
        let i = m.index! + 1;
        for (; i < src.length; i++) {
          const c = src[i]!;
          if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
          else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) + 1;
          else if ((c === '"' || c === "'" || c === "`") && (depth > 0 || c === '"')) {
            const close = src.indexOf(c, i + 1);
            if (close < 0) break;
            i = close;
          } else if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (c === ">" && depth === 0) break;
          if (i < 0) break;
        }
        out.push({ tag: src.slice(m.index!, i + 1), line: src.slice(0, m.index).split("\n").length });
      }
      return out;
    };
    // A regex, not a string: the sheet's own class scan reads this file too,
    // and takes a quoted attribute name followed by a quote for markup.
    const CLASS_ATTR = /className=/;
    const classExpr = (tag: string): string => {
      const hit = CLASS_ATTR.exec(tag);
      if (!hit) return "";
      const start = hit.index + hit[0].length;
      if (tag[start] === '"') return tag.slice(start, tag.indexOf('"', start + 1) + 1);
      return balanced(tag, start).body;
    };
    const carriers: string[] = [];
    const problems: string[] = [];
    for (const file of sourceFiles(APP_DIR)) {
      if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) continue;
      const src = readFileSync(file, "utf8");
      for (const { tag, line } of openingTags(src)) {
        const where = `${path.relative(APP_DIR, file)}:${line}`;
        const alert = /\brole=(?:"alert"|\{[^{}]*"alert"[^{}]*\})/.test(tag);
        const dynamicKey = /\bkey=\{/.test(tag);
        const carries = /"[^"]*\brefused\b[^"]*"/.test(classExpr(tag));
        if (carries) carriers.push(where);
        if (alert && dynamicKey && !carries) problems.push(`${where}: an alert keyed per refusal that never shakes`);
        if (carries && !dynamicKey) problems.push(`${where}: shakes, but a stable key never replays it`);
        if (carries && !/\bonAnimationEnd=/.test(tag) && !/\bkey=\{refusalKey\(/.test(tag)) {
          problems.push(`${where}: shakes on every mount, not once per refusal`);
        }
      }
    }
    expect(problems).toEqual([]);
    // Nineteen boxes keyed on a refusal counter, and the login page's two.
    // Ruling 478(e) added the packet's "Choose an answer" and "Write your
    // answer" refusals; ruling 507 the agent account's over-long name.
    expect(carriers).toHaveLength(21);
  });

  it("every motion this ruling adds has a reduced-motion answer that does not move", () => {
    // CANARY: drop `.refused` from the closing reduced-motion block.
    const answer = (selector: string) => requiredDecls(reduced, selector);
    for (const selector of [
      ".run-phase .ph[data-fresh]", ".run-phase .step[data-fresh]", ".ctl-working-step[data-fresh]", ".copy-done",
      '.signin-step[data-state="done"] .signin-mark .ico', ".cap-mbody", ".ctl-msg[data-fresh]",
    ]) {
      expect(answer(selector).get("animation"), selector).toMatch(/^fade-in \.12s ease$/);
    }
    expect(answer('.signin-step[data-state="done"] .signin-mark .ico path').get("animation")).toBe("none");
    expect(answer(".refused").get("animation")).toBe("none");
  });
});

/**
 * Ruling 457 (CSS-6): the console lays out only the rows near its viewport. A
 * 400-row console showed about 14 and styled, laid out and painted all 400 on
 * every pass (mount, a thread switch, load older, the width query). The rows
 * keep their real height once seen (`auto`), which the console's follow-tail
 * and load-older anchoring read back through `scrollHeight`.
 */
describe("app.css console rows skip off-screen work (ruling 457, CSS-6)", () => {
  it("declares content-visibility and a remembered intrinsic size on the console's rows", () => {
    // CANARY: drop the `.console > .log-line` rule.
    const row = RULES.find((r) => r.at.length === 0 && r.selector === ".console > .log-line");
    expect(row?.decls.get("content-visibility")).toBe("auto");
    expect(row?.decls.get("contain-intrinsic-size")).toMatch(/^auto \d+px$/);
  });
});

describe("app.css ruling 453: the Apple design pass", () => {

  it("(a) every transform transition answers a press on the sheet's ease-out, never plain `ease`", () => {
    // CANARY: put `.btn` back on `transform .15s ease`. Plain `ease` starts
    // at under half its average speed, so a press visibly lagged the finger —
    // on 25 controls whose neighbours already used --ease-out.
    const layers = RULES.flatMap((r) =>
      splitArgs(r.decls.get("transition") ?? "")
        .filter((layer) => /^transform\b/.test(layer))
        .map((layer) => `${r.selector} → ${layer}`),
    );
    expect(layers.length).toBeGreaterThan(40);
    const offCurve = layers.filter((l) => !/ var\(--ease-out\)/.test(l.split(" → ")[1]!));
    expect(offCurve).toEqual([]);
  });

  it("(b) tracking tightens with size, at Inter's own curve, one token per display step", () => {
    // CANARY: set --track-page back to -.015em, or drop the tracking from
    // `.task-hero h1` (the page title that had none of its own).
    const curve = (px: number) => -0.0223 + 0.185 * Math.exp(-0.1745 * px);
    const root = requiredDecls(plain, ":root");
    for (const [token, px] of [["--track-title", 16], ["--track-section", 20], ["--track-page", 28]] as const) {
      const em = Number(/^(-?[\d.]+)em$/.exec(root.get(token) ?? "")?.[1]);
      expect(em, token).toBeCloseTo(curve(px), 3);
    }
    expect(requiredDecls(plain, "h1").get("letter-spacing")).toBe("var(--track-title)");
    // Every rule that sets text at a display step tracks at that step — but
    // for a glyph that is not running text, each saying why.
    const NOT_RUNNING_TEXT = {
      ".avatar.xl": "two initials centred in a 56px disc; tracking would push them off centre.",
      ".login-brand .mark": "the one-letter product mark in its tile.",
      ".login-aside-mark": "the product mark again, in the mono face, whose metrics are its own.",
    } satisfies Record<string, string>;
    const TRACK = new Map([
      ["1.25rem", "var(--track-section)"],
      ["1.75rem", "var(--track-page)"],
    ]);
    const hits = new Set<string>();
    const wrong: string[] = [];
    let checked = 0;
    for (const r of RULES) {
      const size = r.decls.get("font-size");
      const track = size === undefined ? undefined : TRACK.get(size);
      if (track === undefined) continue;
      if (r.selector in NOT_RUNNING_TEXT) {
        hits.add(r.selector);
        continue;
      }
      checked++;
      if (r.decls.get("letter-spacing") !== track) wrong.push(`${r.selector} (${size})`);
    }
    expect(checked).toBeGreaterThanOrEqual(12);
    expect(wrong).toEqual([]);
    expect([...hits].sort()).toEqual(Object.keys(NOT_RUNNING_TEXT).sort());
  });

  it("(c) the translucent bars draw their bottom edge only once content scrolls under them", () => {
    // CANARY: drop `border-bottom-color: transparent` (the edge stands on an
    // unscrolled page), or move `animation-timeline` above the `animation`
    // shorthand, which resets it to the document clock.
    expect(CODE).toMatch(
      /@keyframes scroll-edge \{ from \{ border-bottom-color: transparent; \} to \{ border-bottom-color: var\(--hairline\); \} \}/,
    );
    for (const [selector, timeline] of [
      [".home-top", "scroll(root block)"],
      [".page-overlay .board-head", "scroll(nearest block)"],
    ] as const) {
      const d = requiredDecls(plain, selector);
      expect(d.get("border-bottom-color"), selector).toBe("transparent");
      const own = plain.filter((r) => r.selector === selector && r.decls.has("animation"));
      expect(own, selector).toHaveLength(1);
      const order = [...own[0]!.decls.keys()];
      expect(order, selector).toEqual(["animation", "animation-timeline", "animation-range"]);
      expect(own[0]!.decls.get("animation")).toBe("scroll-edge linear both");
      expect(own[0]!.decls.get("animation-timeline")).toBe(timeline);
      expect(own[0]!.decls.get("animation-range")).toBe("0 1.5rem");
    }
  });

  it("(b) a pinned close never replays an entrance: a closing dialog switches its own off", () => {
    // pinLivePose switches the entrance off inline and releases it once
    // data-closing lands, so the closing rule has to keep it off. Dialogs
    // outrank their own reduced-motion fade-in by weight. Amended by ruling
    // 459's deferred dock half: the dock's entrance is a transition, so it is
    // not pinned ("app.css ruling 459: the dock's deferred half").
    // CANARY: drop `animation: none` from `dialog[data-closing]`.
    expect(requiredDecls(plain, "dialog[data-closing]").get("animation")).toBe("none");
  });

  it("(d) the OS increased-contrast setting gets defined edges and solid chrome, in both themes", () => {
    // CANARY: delete the `prefers-contrast: more` block — the app had no
    // answer to it before this pass.
    const more = RULES.filter((r) => r.at.some((a) => /prefers-contrast:\s*more/.test(a)));
    const tokens = requiredDecls(more, ":root[data-theme]");
    for (const token of ["--border", "--hairline", "--ring"]) {
      expect(tokens.get(token), token).toBe("var(--border-control)");
    }
    for (const token of ["--faint", "--placeholder"]) expect(tokens.get(token), token).toBe("var(--muted)");
    // Later than the dark block, so the equal-specificity override wins there.
    expect(CODE.indexOf("@media (prefers-contrast: more)")).toBeGreaterThan(
      CODE.indexOf(':root[data-theme="dark"] {'),
    );
    // Translucent chrome goes solid, as it does for reduced transparency.
    const lessGlass = RULES.filter((r) => r.at.some((a) => /prefers-reduced-transparency:\s*reduce/.test(a)));
    for (const rules of [more, lessGlass]) {
      expect(requiredDecls(rules, ".home-top").get("background")).toBe("var(--bg)");
      expect(requiredDecls(rules, ".home-top").get("backdrop-filter")).toBe("none");
      expect(requiredDecls(rules, ".topbar").get("background")).toBe("var(--surface)");
    }
  });
});

describe("app.css ruling 454: the dock sheet under a finger", () => {
  const sheetWidth = RULES.filter((r) => r.at.some((a) => /max-width:\s*720px/.test(a)));

  it("marks the panel a sheet only at sheet width — the flag the script reads instead of the viewport", () => {
    // CANARY: move `--sheet-draggable: 1` to the base `.dock-panel` rule and
    // the floating desktop panel drags too.
    expect(requiredDecls(sheetWidth, ".dock .dock-panel").get("--sheet-draggable")).toBe("1");
    expect(RULES.filter((r) => r.decls.has("--sheet-draggable") && !sheetWidth.includes(r))).toEqual([]);
  });

  it("runs the sheet's surface on below its edge, so the spring's give never shows a gap", () => {
    // CANARY: drop the extension layer — a return that overshoots, or a
    // rubber-banded pull, lifts the sheet off the bottom edge. Or list it
    // second: the first shadow paints on top, and the pop shadow's blur then
    // draws a dark seam across the extension (seen live).
    expect(requiredDecls(sheetWidth, ".dock .dock-panel").get("box-shadow")).toBe(
      "0 calc(min(80dvh, 640px) - var(--radius-panel)) 0 var(--surface), var(--shadow-pop)",
    );
  });

  it("shows the grabber only on the sheet, and gives the handles every one-finger touch", () => {
    // CANARY: drop the touch-action — a pull on the header then scrolls the
    // page behind the non-modal sheet instead of moving it. `pinch-zoom`, not
    // `none`: a pinch that starts on the header still zooms (review), and
    // `none` stands first for an engine that lacks the value.
    expect(requiredDecls(plain, ".dock-grabber").get("display")).toBe("none");
    expect(requiredDecls(sheetWidth, ".dock .dock-grabber").get("display")).toBe("block");
    const handles = sheetWidth.find((r) => selectorParts(r).includes(".dock .dock-head") && r.decls.has("touch-action"));
    expect(handles, "the handles' touch rule").toBeTruthy();
    expect(CODE).toMatch(
      /\.dock \.dock-grabber, \.dock \.dock-head \{ touch-action: none; touch-action: pinch-zoom;/,
    );
    for (const handle of [".dock .dock-grabber", ".dock .dock-head"]) {
      const d = requiredDecls(sheetWidth, handle);
      expect(d.get("touch-action"), handle).toBe("pinch-zoom");
      expect(d.get("user-select"), handle).toBe("none");
    }
  });

  it("moves the sheet and its perched button on one value, with no transition behind the script's clock", () => {
    // CANARY: drop `transition: none` from `.dock[data-sheet-drag] .dock-fab`
    // and the perched button trails the finger. The held sheet is ruling
    // 459's dock-half table (F20, "a sheet caught mid-entrance").
    expect(requiredDecls(plain, ".dock").get("--sheet-drag")).toBe("0px");
    expect(requiredDecls(plain, ".dock[data-sheet-drag] .dock-fab").get("transition")).toBe("none");
    for (const perch of ['.dock[data-open="true"] .dock-fab', '.dock[data-open="true"] .dock-fab:active']) {
      const transform = requiredDecls(sheetWidth, perch).get("transform") ?? "";
      expect(transform, perch).toContain("+ var(--sheet-drag, 0px))");
      // CANARY: drop the `min(0px, …)` — a sheet pulled all the way out then
      // carries the button 17px below its home, and it springs back up.
      expect(transform, perch).toMatch(/^translate\(-8px, min\(0px, calc\(/);
    }
  });

  it("under reduced motion the perched button never slides home", () => {
    // CANARY: drop the reduced-motion `.dock .dock-fab` transition list — the
    // button left hundreds of pixels up by a dismissed pull slides down on
    // the base rule's transform transition.
    const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
    expect(requiredDecls(reduced, ".dock .dock-fab").get("transition")).not.toMatch(/transform/);
    expect(requiredDecls(reduced, ".dock:has(.dock-panel[data-closing]) .dock-fab").get("transition")).toBe("none");
    // Later than the 720px block's equal-weight `:has()` return, so it wins.
    const reducedAt = CODE.lastIndexOf(".dock:has(.dock-panel[data-closing]) .dock-fab { transition: none; }");
    const sheetAt = CODE.indexOf(".dock:has(.dock-panel[data-closing]) .dock-fab {");
    expect(reducedAt).toBeGreaterThan(sheetAt);
  });
});

/* -------------------------------------- interface review 2026-09-24 (sheet) */

/**
 * Interface review 2026-09-24 — the sheet-side half of the whole-UI pass. Each
 * of these rules is one declaration a later tidy-up could drop without any
 * other test noticing, and each one's absence was measured: a clipped primary
 * action, a heading cut to "E.", nine invisible Tab stops, a selected chip
 * told apart by a 1.17:1 fill.
 */
describe("interface review 2026-09-24: the rules the fixes rest on", () => {
  const within = (query: RegExp) => RULES.filter((r) => r.at.some((a) => query.test(a)));
  const mobile = within(/max-width: 720px/);
  const collapse = within(/max-width: 1100px/);
  const reduce = within(/prefers-reduced-motion:\s*reduce/);

  it("layo-1: a dialog's action row wraps at phone width, and only there", () => {
    // The footer sits outside the scrolling body of an overflow-hidden card, so
    // at 320px a nowrap row put "Create project" 0% on screen. CANARY: move the
    // wrap to the base rules; at 1440 it re-rowed the Archive footer.
    for (const selector of [".modal-foot", ".modal-foot .foot-actions", ".confirm-actions"]) {
      expect(requiredDecls(mobile, selector).get("flex-wrap"), selector).toBe("wrap");
      expect(requiredDecls(plain, selector).get("flex-wrap"), `${selector} wraps only at 720px`).toBeUndefined();
    }
    expect(requiredDecls(mobile, ".confirm-actions .btn").get("white-space")).toBe("normal");
  });

  it("layo-2: a panel title counts toward its head's line at phone width, so the wrap fires", () => {
    // `flex: 1` is a zero basis: the title added nothing to the line, the
    // cluster never dropped, and the title was squeezed to one letter.
    const h2 = requiredDecls(mobile, ".panel-head h2");
    expect(h2.get("flex")).toBe("1 1 auto");
    expect(h2.get("white-space")).toBe("normal");
    expect(requiredDecls(mobile, ".panel-head").get("flex-wrap")).toBe("wrap");
  });

  it("acce-13: the closed drawer is hidden, so its links leave the tab order", () => {
    const rail = requiredDecls(mobile, ".rail");
    expect(rail.get("visibility")).toBe("hidden");
    // The hide waits out the close's slide; ruling 459's F25 holds that timing.
    const open = requiredDecls(mobile, '.app[data-rail-open="true"] .rail');
    expect(open.get("visibility")).toBe("visible");
    expect(open.get("transition-delay")).toBe("0s");
  });

  it("ui-1: every entrance that rises has a later reduced-motion answer that does not", () => {
    // The reduce block is an allow-list, and `.login-aside` was missing from it.
    // Ruling 459 split the aside's rise across its chunks (`.login-aside > *`,
    // staggered), so the chunks are the riser that needs the answer now.
    // CANARY: drop `.login-aside > *` from the closing reduced-motion list.
    const risers = RULES.flatMap((rule, index) =>
      !rule.at.some((a) => /prefers-reduced-motion/.test(a)) &&
      /^rise\b/.test(rule.decls.get("animation") ?? "")
        ? selectorParts(rule).map((selector) => ({ selector, index }))
        : [],
    );
    expect(risers.map((r) => r.selector)).toEqual(
      expect.arrayContaining([".toast", ".login-card", ".login-aside > *"]),
    );
    for (const { selector, index } of risers) {
      const answered = RULES.some(
        (rule, at) =>
          at > index &&
          reduce.includes(rule) &&
          selectorParts(rule).includes(selector) &&
          /^(fade-in\b|none$)/.test(rule.decls.get("animation") ?? ""),
      );
      expect(answered, `${selector} rises; it needs a later reduced-motion answer`).toBe(true);
    }
  });

  it("colo-1 / colo-2: a selected chip or segment carries an edge, not only a fill", () => {
    // Weight, size and width are the same in both states, so the edge is the
    // only non-hue cue. --border-control is held at 3:1 on --surface above.
    // The chip's hover selector is in the rule because the plain hover rule
    // outranks `.fchip.on` and would swap the edge back.
    for (const selector of [".fchip.on", ".fchip.on:hover:not(:disabled)"]) {
      expect(requiredDecls(plain, selector).get("border-color"), selector).toBe("var(--border-control)");
    }
    expect(requiredDecls(plain, ".seg button.on").get("box-shadow")).toBe("inset 0 0 0 1px var(--border-control)");
    expect(requiredDecls(plain, ".mini-seg button.on").get("box-shadow")).toBe("inset 0 0 0 1px var(--blue)");
    expect(requiredDecls(plain, ".mini-seg button.on:hover:not(:disabled)").has("box-shadow")).toBe(false);
    // Forced colors paints both states alike unless the selected one names a
    // system colour.
    const forced = within(/forced-colors:\s*active/);
    for (const selector of [".fchip.on", ".seg button.on", ".cal-day.sel"]) {
      expect(requiredDecls(forced, selector).get("background"), selector).toBe("SelectedItem");
    }
    // Ruling 459's hover on the selected segment sets its ink and outranks
    // `.seg button.on`, so the forced rule names the hovered state as well.
    for (const selector of [".fchip.on:hover:not(:disabled)", ".seg button.on:hover:not(:disabled)"]) {
      expect(requiredDecls(forced, selector).get("color"), selector).toBe("SelectedItemText");
    }
  });

  it("acce-9: an open conversation or profile wears the selected pair, not the focus idiom", () => {
    for (const selector of [".ctl-conv.on", ".ag-item.on"]) {
      const decls = requiredDecls(plain, selector);
      expect(decls.get("background"), selector).toBe("var(--blue-soft)");
      expect(decls.get("border-color"), selector).toBe("var(--blue)");
      expect(decls.get("box-shadow") ?? "", selector).not.toContain("--focus-wash");
    }
    // --placeholder is 4.26:1 / 4.10:1 on --blue-soft; the selected rows lift
    // their dim line to --faint, the pair the P13-D-12 block holds at 4.5:1.
    expect(requiredDecls(plain, ".ctl-conv.on .fine.dim").get("color")).toBe("var(--faint)");
    expect(requiredDecls(plain, ".ag-item.on .ag-idle").get("color")).toBe("var(--faint)");
  });

  it("acce-4: component focus rules add to the app ring instead of erasing it", () => {
    for (const selector of [
      "select:focus", ".goal-textarea:focus", ".datepick-trigger:focus-visible", ".op-steer:focus",
      '.field input[type="text"]', ".field input:focus", ".field textarea:focus",
      ".fm-gh input:focus", ".feed-filters .ff-task:focus",
      '.guard-ctl input[type="number"]:focus', ".stg-input",
    ]) {
      expect(requiredDecls(plain, selector).get("outline") ?? "", selector).not.toMatch(/^(0|none)$/);
    }
    // A select takes the ring the text inputs take, not one of its own.
    for (const prop of ["border-color", "box-shadow"]) {
      expect(requiredDecls(plain, "select:focus").get(prop), prop).toBe(
        requiredDecls(plain, ".field input:focus").get(prop),
      );
    }
    // The two rules that replaced the ring with a box-shadow (which forced
    // colors drops) are gone.
    expect(CODE).not.toMatch(/\.cal-day[^{]*:focus-visible/);
    expect(CODE).not.toMatch(/\.top-search \.kbd:focus-visible/);
    // A borderless input's wrapper draws the ring for it: `.top-search input`
    // and `.board-filter-input input` set `outline: 0` unconditionally, and
    // Home's project finder had no focus indicator at all (P16-UI-01).
    for (const selector of [
      "div.top-search:has(input:focus-visible)", ".board-filter-input:focus-within",
      ".label-input:focus-within", ".repo-input:focus-within", ".feed-filters .ff-search:focus-within",
      ".attach-add > label:has(input:focus-visible)", ".ctl-composer:has(textarea:focus-visible)",
    ]) {
      expect(requiredDecls(plain, selector).get("outline"), selector).toBe("2px solid var(--blue)");
    }
  });

  it("layo-5: the three horizontal scrollers mark their cut edge on their own timeline", () => {
    for (const selector of [".rbac-scroll", ".md-table-wrap", ".md-body pre"]) {
      const decls = requiredDecls(plain, selector);
      expect(decls.get("animation"), selector).toBe("x-cut-edge linear both");
      expect(decls.get("animation-timeline"), selector).toBe("scroll(self inline)");
    }
    // The shorthand resets `animation-timeline`, so it has to come first.
    expect(CODE).toMatch(
      /\.rbac-scroll, \.md-table-wrap, \.md-body pre\s*\{\s*animation:[^;]*;\s*animation-timeline:/,
    );
    // No overflow (an inactive timeline) or no support must leave NO mask.
    const frames = CODE.match(/@keyframes x-cut-edge\s*\{([\s\S]*?)\n\}/);
    expect(frames, "the cue's keyframes must exist").toBeTruthy();
    expect(frames![1]).toMatch(/100%\s*\{[^}]*\bmask-image:\s*none/);
  });

  it("acce-10: a long token may break rather than widen the page or run under a row's controls", () => {
    for (const selector of [
      ".conn-main .sub.mono", ".rsrc-main .sub.mono", ".rsrc-main b.mono-b", ".pol-note", ".hero-file",
      // Ruling 515, the same flaw as the owner's clipped address: a Google
      // client ID ran under the SSO row's pills, and at 320px an address ran
      // out of the account in use's green line and past "Disconnect <address>?".
      ".conn-main", ".cred-ok > span:not(.warn-acts)", ".cred-warn > span:not(.warn-acts)",
      ".confirm-card h3", ".confirm-card p",
    ]) {
      expect(requiredDecls(plain, selector).get("overflow-wrap"), selector).toBe("anywhere");
    }
  });

  it("layo-12: the composer's placeholder shares the editor's cell instead of floating over the foot", () => {
    expect(requiredDecls(plain, ".composer-input").get("display")).toBe("grid");
    const placeholder = requiredDecls(plain, ".composer-box .composer-placeholder");
    expect(placeholder.get("grid-area")).toBe("1 / 1");
    expect(placeholder.has("position")).toBe(false);
    expect(requiredDecls(plain, ".composer-box .composer-ce").get("grid-area")).toBe("1 / 1");
  });

  it("layo-19 / acce-12: the stacked tables and the stacked Agents page can be scrolled to", () => {
    // `.live-table` clips (overflow: hidden rounds its head band), so a row
    // min-width only cut the columns off. CANARY: put it back on the rows.
    expect(requiredDecls(collapse, ".gh-table .live-table").get("min-width")).toBe("34rem");
    expect(requiredDecls(collapse, ".live-wrap .live-table").get("min-width")).toBe("42rem");
    expect(collapse.some((r) => selectorParts(r).includes(".gh-table .live-row") && r.decls.has("min-width"))).toBe(false);
    const block = CODE.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/)![1]!;
    expect(block).toMatch(/\.board-wrap:has\(> \.agents-layout, > \.live-wrap\)\s*\{\s*overflow-y:\s*auto/);
    // The shell-less controller is opted out of the clipped body like Home.
    expect(CODE).toMatch(/body:has\(\.ctl-wrap\.standalone\)\s*\{[^}]*overflow:\s*auto/);
  });

  it("the credential card's green footer wraps like its warn box, so the re-check can take its own line", () => {
    // The card puts its Re-check scopes slot in `.cred-ok` while an advisory is
    // open. CANARY: drop `flex-wrap` and the button squeezes the sentence at
    // 320px; drop the basis and the sentence falls under its own glyph.
    expect(requiredDecls(plain, ".cred-ok").get("flex-wrap")).toBe("wrap");
    // Measured at 320px: a bare 12rem basis put the glyph on a line of its own
    // (202px row on the card, 160px in the profile dialog). The cap is the row
    // minus the glyph and the gap, so the pair always shares the first line.
    for (const box of [".cred-ok", ".cred-warn"]) {
      const sentence = requiredDecls(plain, `${box} > span:not(.warn-acts)`);
      expect(sentence.get("flex"), box).toBe("1 1 min(12rem, 100% - 14px - .5rem)");
      expect(sentence.get("min-width"), box).toBe("0");
      expect(requiredDecls(plain, `${box} .ico`).get("width"), box).toBe("14px");
      expect(requiredDecls(plain, box).get("gap"), box).toBe(".5rem");
    }
    // A dismiss stays beside the sentence it dismisses, and the action pair may
    // wrap its buttons rather than run past the card (266px in a 202px row).
    expect(requiredDecls(plain, ".cred-ok:has(> .modal-close)").get("flex-wrap")).toBe("nowrap");
    const acts = requiredDecls(plain, ".warn-acts");
    expect(acts.get("flex-wrap")).toBe("wrap");
    expect(acts.get("flex")).toBe("0 1 auto");
  });

  it("layo-8: a flipped stage menu has its own reduced-motion answer", () => {
    // ui-3's closing dock button is ruling 454's reduced-motion test.
    expect(requiredDecls(plain, '.stage-menu-pop[data-side="top"]').get("animation-name")).toBe("menu-in-up");
    expect(requiredDecls(plain, ".stage-menu-pop").get("overflow-y")).toBe("auto");
    // The data-side rule outranks `.stage-menu-pop`, so it needs its own entry.
    expect(requiredDecls(reduce, '.stage-menu-pop[data-side="top"]').get("animation")).toMatch(/^fade-in\b/);
  });
});

/**
 * Interface review 2026-09-24, the MEDIUM findings (the owner: "fix the 12
 * MEDIUM findings too"). The sheet-side halves; the markup halves are pinned
 * by the GitHub view, store browser and login suites.
 */
describe("interface review 2026-09-24: the MEDIUM fixes", () => {
  const within = (query: RegExp) => RULES.filter((r) => r.at.some((a) => query.test(a)));
  const collapse = within(/max-width: 1100px/);
  const wide = within(/min-width: 900px/);

  it("colo-4: a locked policy row takes one opacity step, and its chosen value keeps full strength", () => {
    // CANARY: put `opacity: .55` back on `.cap-seg.locked`. Every option in a
    // locked group is also disabled, so the two steps composited to .25.
    const locked = requiredDecls(plain, ".cap-seg.locked");
    expect(locked.has("opacity")).toBe(false);
    // The rule stays: it is the only one that defines `locked`.
    expect(locked.get("pointer-events")).toBe("none");
    expect(requiredDecls(plain, ".cap-seg button:disabled").get("opacity")).toBe(".45");
    expect(requiredDecls(plain, ".cap-seg button.on:disabled").get("opacity")).toBe("1");
  });

  it("colo-8: today is a bold numeral with no ring, so only the selected day has ring and fill", () => {
    const today = requiredDecls(plain, ".cal-day.today:not(.sel)");
    expect(today.has("box-shadow")).toBe(false);
    expect(today.get("font-weight")).toBe("700");
    const selected = requiredDecls(plain, ".cal-day.sel");
    expect(selected.get("box-shadow")).toBe("inset 0 0 0 1px var(--blue)");
    expect(selected.get("background")).toBe("var(--blue-soft)");
  });

  it("typo-2 / colo-11: a commit subject wraps instead of ellipsizing, and its static SHA is not link-blue", () => {
    const msg = requiredDecls(plain, ".commit .msg");
    for (const prop of ["overflow", "text-overflow", "white-space"]) {
      expect(msg.has(prop), `.commit .msg ${prop}`).toBe(false);
    }
    expect(msg.get("overflow-wrap")).toBe("anywhere");
    expect(requiredDecls(plain, ".commit").get("align-items")).toBe("baseline");
    expect(requiredDecls(plain, ".commit .sha").has("color")).toBe(false);
  });

  it("colo-12: a branch trace takes the base ink, not the teal ready/OK one", () => {
    expect(CODE).not.toMatch(/\.trace\.ok\b/);
    expect(requiredDecls(plain, ".trace").get("color")).toBe("var(--faint)");
  });

  it("layo-6: under 1100px a queue row's title takes line 1 by basis, not a 220px floor", () => {
    // CANARY: put `min-width: 220px` back. It overflowed the Notifications
    // panel at 320px and held titles at 220px beside the pills up to 1100px.
    const main = requiredDecls(collapse, ".rq-main");
    expect(main.has("min-width")).toBe(false);
    expect(main.get("flex")).toBe("1 1 calc(100% - 62px - 1rem)");
    // The basis subtracts the key column and the row gap; they move together.
    expect(requiredDecls(plain, ".rq-key").get("width")).toBe("62px");
    expect(requiredDecls(plain, ".rq-row").get("gap")).toBe("1rem");
  });

  it("acce-27: below 900px the login aside stacks under the card instead of disappearing", () => {
    // CANARY: put `.login-aside { display: none }` back outside the query. At
    // 720px (200% zoom) and 320px the heading and the three claims, which
    // appear nowhere else, were gone for everyone.
    const aside = requiredDecls(plain, ".login-aside");
    expect(aside.get("display")).toBe("flex");
    expect(aside.get("order")).toBe("1");
    for (const selector of [".login-aside h2", ".login-aside p", ".login-aside-points", ".login-aside-points li"]) {
      expect(requiredDecls(plain, selector).get("display") ?? "", selector).not.toBe("none");
    }
    // The card right above shows the same mark, so the stacked aside drops it.
    expect(requiredDecls(plain, ".login-aside-mark").get("display")).toBe("none");
    const beside = requiredDecls(wide, ".login-aside");
    expect(beside.get("order")).toBe("0");
    // Stacked it has no entrance of its own (beside the card its chunks rise,
    // ruling 459's F28).
    expect(aside.has("animation")).toBe(false);
    expect(requiredDecls(wide, ".login-aside-mark").get("display")).toBe("inline-grid");
    const wrap = requiredDecls(plain, ".login-wrap");
    expect(wrap.get("gap")).toBe("1.5rem");
    expect(wrap.get("align-content")).toBe("center");
  });

  it("acce-32: the store tree's open control is a bare button laid out as the row was", () => {
    const open = requiredDecls(plain, ".fm-open");
    expect(open.get("display")).toBe("flex");
    expect(open.get("flex-wrap")).toBe("wrap");
    // A zero-basis button whose name keeps a 5rem basis inside it: at 320px the
    // twist, glyph and name hold line 1 and the actions keep the row's line. A
    // 12rem button basis dropped them to a third line (rows 85-101px, now 51-83).
    expect(open.get("flex")).toBe("1 1 0");
    expect(requiredDecls(plain, ".fm-open .fm-name").get("flex")).toBe("1 1 5rem");
    expect(requiredDecls(plain, ".fm-name").get("flex")).toBe("1 1 9rem");
    expect(open.get("min-width")).toBe("0");
    expect(open.get("padding")).toBe("0");
    expect(open.get("border")).toBe("0");
    expect(open.get("text-align")).toBe("start");
    // No cursor (the span on a file that cannot open must not show a hand) and
    // no outline (the app ring draws its focus).
    expect(open.has("cursor")).toBe(false);
    expect(open.has("outline")).toBe(false);
    // The glyph moved into the button; the new-folder row still has it bare.
    expect(requiredDecls(plain, ".fm-open > .ico").get("color")).toBe("var(--faint)");
    expect(requiredDecls(plain, ".fm-row.dir .fm-open > .ico").get("color")).toBe("var(--muted)");
    expect(requiredDecls(plain, ".fm-row.dir > .ico").get("color")).toBe("var(--muted)");
    // The hand is the button's: the row's padding and gutter open nothing.
    for (const selector of [".fm-row.dir", ".fm-row.openable"]) {
      expect(plain.some((r) => selectorParts(r).includes(selector) && r.decls.has("cursor")), selector).toBe(false);
    }
    expect(requiredDecls(plain, ".fm-row.dir .fm-open").get("cursor")).toBe("pointer");
  });
});

/**
 * Better-ui review 2026-09-24, five small leftovers it filed. Two were already
 * fixed by the interface review (ruling 455): the locked policy row's stacked
 * opacity is pinned by colo-4 above, and the GitHub bar's neutral pill is
 * pinned here, because the sweep only sees that pair while its rule exists.
 * The move-back glyph and the markup halves of the other two are pinned by
 * the task-disposition, execution-profile and top-bell suites.
 */
describe("app.css ruling 478: the task page at phone width", () => {
  const PHONE = "@media (max-width: 720px)";
  /** The declarations `selector` gets from its own rules in `at` (plain when empty). */
  const declsAt = (selector: string, at: string[]) =>
    requiredDecls(RULES.filter((r) => r.at.join("|") === at.join("|")), selector);

  it("(b) F40-32: a file row's name takes its own line on a phone and shows whole", () => {
    // WEB-3 at 375px: both files read "WEB-3…", the name left 48px beside a
    // fixed 144px by-line and the size. CANARY: drop the `a.attach-file` rules
    // from the 720px block.
    expect(declsAt("a.attach-file", [PHONE]).get("flex-wrap")).toBe("wrap");
    const name = declsAt("a.attach-file .attach-name", [PHONE]);
    // The whole row beside the icon (15px) and its gap (.5rem).
    expect(name.get("flex")).toBe("1 1 calc(100% - 15px - .5rem)");
    expect(name.get("white-space")).toBe("normal");
    expect(name.get("overflow-wrap")).toBe("anywhere");
    // The by-line gives way instead of holding its width.
    const by = declsAt("a.attach-file .attach-by", [PHONE]);
    expect(by.get("flex")).toBe("0 1 auto");
    expect(by.get("min-width")).toBe("0");
    // The base rules the phone rules must outrank are declared LATER in the
    // sheet, so the phone selectors carry one type selector more.
    expect(declsAt(".attach-file .attach-name", []).get("flex")).toBe("1");
    expect(declsAt(".attach-file .attach-by", []).get("flex")).toBe("none");
  });

  it("(c) F40-33: the live strip's text column may shrink, and a long step ends in an ellipsis", () => {
    // WEB-2 at 375px: the step ran to x=388 in a 341px strip and the page
    // scrolled sideways. CANARY: drop `.run-phase-text { min-width: 0 }`.
    expect(declsAt(".run-phase-text", []).get("min-width")).toBe("0");
    expect(declsAt(".run-phase", []).get("min-width")).toBe("0");
    expect(declsAt(".run-phase .step", []).get("text-overflow")).toBe("ellipsis");
  });
});

describe("better-ui review 2026-09-24: the small leftovers", () => {

  it("the GitHub bar's neutral pill keeps a fill of its own and clears AA on the bar, in both themes", () => {
    // CANARY: delete `.gh-bar .pill.neutral`. The sweep stays green, because it
    // then measures only the base pill (--muted on --tint-press) against the
    // page; on the inverted bar that pair drew at 2.48:1 light, 1.62:1 dark.
    const onBar = SWEEP.pairs.filter((p) => p.selector === ".gh-bar .pill.neutral");
    expect(onBar.map((p) => p.theme).sort()).toEqual(["dark", "light"]);
    const barPaint = requiredDecls(plain, ".gh-bar").get("background")!;
    for (const p of onBar) {
      expect(p.ratio, `${p.theme} ink on the pill`).toBeGreaterThanOrEqual(4.5);
      // "Lost its fill" was a --fg tint on a --fg ground: the pill's own fill
      // has to stand a visible step off the bar it sits on.
      const tokens = THEMES.find(([theme]) => theme === p.theme)![1];
      const bar = asHex(resolveColor(barPaint, tokens)!.rgb);
      expect(contrastRatio(p.bg, bar), `${p.theme} fill against the bar`).toBeGreaterThan(1.25);
    }
  });

  it("ruling 511: the PR card's status marks keep the pills' tones, under the bar", () => {
    // CANARY: drop the done mark's fill, and a passing gate run reads grey
    // (ruling 491: a pass is green); or give the section after the bar its
    // hairline back, a grey rule drawn against the black.
    expect(requiredDecls(plain, ".pr-card > .gh-bar + *").get("border-top")).toBe("0");
    expect(requiredDecls(plain, '.pr-sig[data-kind="done"] > .ico').get("color")).toBe("var(--success-dark)");
    expect(requiredDecls(plain, '.pr-sig[data-kind="done"] > .ico circle').get("fill")).toBe("var(--success-soft)");
    expect(requiredDecls(plain, '.pr-sig[data-kind="blocked"] > .ico').get("color")).toBe("var(--coral-dark)");
    expect(requiredDecls(plain, '.pr-sig[data-kind="blocked"] > .ico circle').get("fill")).toBe("var(--red-light)");
    // An approval is a quiet pill, the outline tier: its mark is the ink alone.
    expect(requiredDecls(plain, '.pr-sig[data-kind="ready"] > .ico').get("color")).toBe("var(--teal-dark)");
    expect(plain.some((r) => selectorParts(r).includes('.pr-sig[data-kind="ready"] > .ico circle'))).toBe(false);
    // The freshness facts are small print, not the bold display face a side
    // panel gives a fact, and they close the card on a well.
    const facts = requiredDecls(plain, ".pr-facts .kv-row .v");
    expect(facts.get("font-weight")).toBe("400");
    expect(facts.get("color")).toBe("var(--muted)");
    expect(requiredDecls(plain, ".pr-card > .pr-facts").get("background")).toBe("var(--tint-well)");
    // The branch chip and the fold toggle are links and buttons in small type:
    // each stands a 24px target (WCAG 2.2, 2.5.8).
    expect(requiredDecls(plain, ".pr-branch").get("min-height")).toBe("24px");
    expect(requiredDecls(plain, ".pr-fold").get("min-height")).toBe("24px");
    // The fold's chevron points down while the gates are folded, up when open.
    expect(requiredDecls(plain, ".pr-fold .ico").get("transform")).toBe("rotate(90deg)");
    expect(requiredDecls(plain, '.pr-fold[aria-expanded="true"] .ico').get("transform")).toBe("rotate(-90deg)");
  });

  it("a run control's start holds the width of its widest label", () => {
    // CANARY: drop the min-width, and the when-picker slides 21px (operator)
    // or 32px (dispatch) under the pointer that just switched it to Schedule,
    // and the row shifts again when the start reads "Scheduling…" (ruling 368).
    // One floor serves both starts: "Scheduling…" is the widest label on each.
    expect(requiredDecls(plain, ".op-run > .run-go").get("min-width")).toBe("7.4rem");
    // The widths were measured at these metrics; a change here re-opens them.
    const sm = requiredDecls(plain, ".btn.sm");
    expect(sm.get("font-size")).toBe(".75rem");
    expect(sm.get("padding")).toBe(".375rem .5rem");
    expect(requiredDecls(plain, ".btn").get("gap")).toBe(".375rem");
  });

  it("the open bell holds the icon-button family's pressed look", () => {
    // CANARY: delete the rule, and the bell reads the same with its popover up
    // as at rest while the account trigger beside it rings.
    const open = requiredDecls(plain, '.bell-btn[aria-expanded="true"]');
    const pressed = requiredDecls(plain, '.dock-head-acts .icon-btn[aria-pressed="true"]');
    for (const prop of ["background", "color", "border-color"]) {
      expect(open.get(prop), prop).toBe(pressed.get(prop));
    }
    expect(open.get("border-color")).toBe("var(--border)");
  });
});

describe("app.css ruling 459: the better-ui pass — concentric radius", () => {
  // Outer radius = inner radius + the inset between them (better-ui,
  // surfaces.md), wherever the layers share a visible, even inset. The scale
  // is locked, so the answer is the nearest step or a changed inset, and the
  // house counts the container's border as part of the inset.
  const phone = RULES.filter((r) => r.at.some((a) => /max-width:\s*720px/.test(a)));
  const root = requiredDecls(plain, ":root");
  /** A length in px: a `var(--radius-*)` through the token block, rem at 16px. */
  const px = (value: string): number => {
    const token = /^var\((--[\w-]+)\)$/.exec(value);
    if (token) return px(root.get(token[1]!) ?? "");
    if (value === "0") return 0;
    const m = /^(-?[\d.]+)(px|rem)$/.exec(value);
    expect(m, `${value} must be a px or rem length`).toBeTruthy();
    return Number(m![1]) * (m![2] === "rem" ? 16 : 1);
  };
  /** A 1-4 value shorthand, expanded clockwise from the top (from the
   *  top-left corner for a radius). */
  const four = (value: string): [string, string, string, string] => {
    const [a, b = a, c = a, d = b] = value.trim().split(/\s+/);
    return [a!, b!, c!, d!];
  };
  const TL = 0, BR = 2, BL = 3;
  const radius = (selector: string, corner = TL) =>
    px(four(requiredDecls(plain, selector).get("border-radius") ?? "")[corner]);
  const pad = (selector: string, side = 0) => px(four(requiredDecls(plain, selector).get("padding") ?? "")[side]);
  const border = (selector: string) => px((requiredDecls(plain, selector).get("border") ?? "").split(/\s+/)[0]!);
  const STEPS = ["--radius-small", "--radius-button", "--radius-box", "--radius-card", "--radius-panel"]
    .map((t) => px(`var(${t})`));
  const nearestStep = (want: number) =>
    STEPS.reduce((best, s) => (Math.abs(s - want) < Math.abs(best - want) ? s : best));

  it("(a) a board lane keeps one radius while a card is dragged over it", () => {
    // CANARY: put `border-radius: var(--radius-card)` back on
    // `.column.drop-over`. The radius is not in the lane's transition, so every
    // lane a drag crossed snapped its corners from 22 to 16 and back, with the
    // sticky head's 22px corners left standing inside the smaller lane.
    const lane = plain
      .filter((r) => selectorParts(r).some((s) => /^\.column\b/.test(s)) && r.decls.has("border-radius"))
      .map((r) => r.selector);
    expect(lane).toEqual([".column"]);
    const own = requiredDecls(plain, ".column").get("border-radius")!;
    expect(four(requiredDecls(plain, ".col-head").get("border-radius")!).slice(0, 2)).toEqual([own, own]);
    // The lane's step is the nearest to a card's radius plus .col-body's gutter.
    expect(px(own)).toBe(nearestStep(radius(".card") + pad(".col-body", 1)));
  });

  const NESTS: [string, () => { outer: number; edge: number; inset: number; inner: number }][] = [
    // CANARY (each): put the old inset or radius back — .cmdk-row on
    // --radius-button, .user-menu at .375rem, the lightbox bodies on
    // --radius-button, .dock-composer at .75rem, .seg at .25rem, .datepick-pop
    // at .5rem, the swatch menu on .own-menu's --radius-box, the closing code
    // block on its own 8px.
    ["the palette's last row in .cmdk-card", () => ({
      outer: radius(".cmdk-card", BL), edge: border(".cmdk-card"),
      inset: pad(".cmdk-list", 2), inner: radius(".cmdk-row", BL),
    })],
    ["Sign out, the account menu's last row", () => ({
      outer: radius(".user-menu", BL), edge: border(".user-menu"),
      inset: pad(".user-menu", 2), inner: radius(".menu-item", BL),
    })],
    ["the lightbox picture in its dialog", () => ({
      outer: radius(".modal-card"), edge: border(".modal-card"),
      inset: pad(".modal-card.lightbox-card"), inner: radius(".lightbox-card .lightbox-img"),
    })],
    ["the lightbox code reader in its dialog", () => ({
      outer: radius(".modal-card"), edge: border(".modal-card"),
      inset: pad(".modal-card.lightbox-card"), inner: radius(".lightbox-card .lightbox-text"),
    })],
    ["the dock composer in the panel's bottom corners", () => ({
      outer: radius(".dock-panel", BL), edge: border(".dock-panel"),
      inset: pad(".dock-composer", 2), inner: radius(".ctl-composer", BL),
    })],
    ["a selected segment in the .seg well", () => ({
      outer: radius(".seg"), edge: border(".seg"),
      inset: pad(".seg"), inner: radius(".seg button"),
    })],
    ["a month arrow in the date picker's top corner", () => ({
      outer: radius(".datepick-pop"), edge: border(".datepick-pop"),
      inset: pad(".datepick-pop"), inner: radius(".cal-nav"),
    })],
    ["a corner swatch in the colour menu", () => {
      const swatch = requiredDecls(plain, ".swatch");
      expect(swatch.get("border-radius")).toBe("50%");
      return {
        outer: radius(".own-menu.swatch-menu"), edge: border(".own-menu"),
        inset: pad(".own-menu.swatch-menu"), inner: px(swatch.get("width")!) / 2,
      };
    }],
    ["a code block closing a controller message", () => ({
      outer: radius(".ctl-msg", BL), edge: border(".ctl-msg"),
      inset: pad(".ctl-msg", 2), inner: radius(".ctl-msg > .md-body > pre:last-child", BL),
    })],
    ["a code block closing a comment, bottom-left", () => ({
      outer: radius(".comment-card", BL), edge: border(".comment-card"),
      inset: pad(".comment-card", 2),
      inner: radius(".comment-card .md-collapse > .md-body:last-child > pre:last-child", BL),
    })],
  ];
  it.each(NESTS)("(b) %s nests concentrically, within a pixel", (_, measure) => {
    const { outer, edge, inset, inner } = measure();
    expect(Math.abs(inner + inset + edge - outer), `${inner} + ${inset} + ${edge} against ${outer}`)
      .toBeLessThanOrEqual(1);
  });

  it("(c) the dock composer's inset is even on the desktop panel, and the phone sheet keeps the gutter", () => {
    // CANARY: drop `.dock .dock-composer` from the 720px block — the phone
    // sheet has square bottom corners, so nothing there wants the 6px inset.
    const [, right, bottom, left] = four(requiredDecls(plain, ".dock-composer").get("padding")!);
    expect(new Set([right, bottom, left]).size).toBe(1);
    expect(four(requiredDecls(phone, ".dock .dock-panel").get("border-radius")!).slice(2)).toEqual(["0", "0"]);
    const sheet = four(requiredDecls(phone, ".dock .dock-composer").get("padding")!);
    expect(sheet.slice(1).map(px)).toEqual([1, 2, 3].map(() => pad(".dock-body")));
  });

  it("(d) the .seg well trades inset for segment padding, so the control keeps its height", () => {
    // CANARY: set `.seg button` back to `.375rem .5rem` — the toggle shrinks
    // to 33px beside Home's 38px button. The well's inset is its family's.
    expect(requiredDecls(plain, ".seg").get("padding")).toBe(requiredDecls(plain, ".cap-seg").get("padding"));
    expect(requiredDecls(plain, ".seg").get("padding")).toBe(requiredDecls(plain, ".mini-seg").get("padding"));
    // Block padding, well + segment: the 4px + 6px the 37px control was built on.
    expect(pad(".seg") + pad(".seg button")).toBe(10);
  });

  it("(e) pending schedules are a divided list, not boxes in a box", () => {
    // CANARY: put `border: 1px solid var(--hairline); border-radius:
    // var(--radius-button)` back on `.sched-row`. No step nests both of a boxed
    // row's corners: the Cancel button's 8 wants 16, the cell's inset wants 0.
    const row = requiredDecls(plain, ".sched-row");
    expect(row.has("border-radius")).toBe(false);
    expect(row.has("border")).toBe(false);
    expect(row.get("border-top")).toBe("1px solid var(--hairline)");
    expect(row.get("padding")).toBe(requiredDecls(plain, ".kv-row").get("padding"));
    expect(requiredDecls(plain, ".sched-list").has("gap")).toBe(false);
  });

  it("(f) a closing code block rounds only the corners it shares with its card", () => {
    // CANARY: square the comment block's bottom-RIGHT corner too — .tl-text
    // caps the body at 70ch, so on a desktop column that corner stands well
    // inside the card and nests in nothing.
    const closing = requiredDecls(plain, ".md-body > :last-child");
    expect(closing.get("margin-bottom")).toBe("0");
    const button = "var(--radius-button)";
    const msg = four(requiredDecls(plain, ".ctl-msg > .md-body > pre:last-child").get("border-radius")!);
    expect(msg.slice(0, 2)).toEqual([button, button]);
    expect(msg[BR]).toBe(msg[BL]);
    const comment = four(
      requiredDecls(plain, ".comment-card .md-collapse > .md-body:last-child > pre:last-child").get("border-radius")!,
    );
    expect(requiredDecls(plain, ".tl-text").get("max-width")).toBe("70ch");
    expect(comment.slice(0, 3)).toEqual([button, button, button]);
  });
});

describe("app.css ruling 459: the better-ui pass — optical alignment", () => {
  // better-ui: when geometric centring looks off, align optically. A glyph on
  // the 24 grid carries its own blank bearing, so the side it sits on takes
  // the text side less 2px (surfaces.md); a glyph drawn off the centre of its
  // box is fixed in the SVG, so no component has to nudge it.
  const decls = (selector: string) => requiredDecls(plain, selector);
  /** A length in px, rem at 16px. */
  const px = (value: string | undefined): number => {
    if (value === "0") return 0;
    const m = /^(-?[\d.]+)(px|rem)$/.exec(value ?? "");
    expect(m, `${value} must be a px or rem length`).toBeTruthy();
    return Number(m![1]) * (m![2] === "rem" ? 16 : 1);
  };
  /** A padding shorthand's four sides. */
  const sides = (selector: string) => {
    const [top, right = top, bottom = top, left = right] = (decls(selector).get("padding") ?? "").trim().split(/\s+/);
    return { top: px(top), right: px(right), bottom: px(bottom), left: px(left) };
  };

  const LEADING: [string, string[]][] = [
    [".btn", [".btn:has(> .ico:first-child:not(.ico-end))", ".btn:has(> .copy-glyph:first-child)"]],
    [".btn.sm", [".btn.sm:has(> .ico:first-child:not(.ico-end))", ".btn.sm:has(> .copy-glyph:first-child)"]],
    [".seg button", [".seg button:has(> .ico:first-child)"]],
    [".fchip", [".fchip:has(> .ico:first-child)"]],
    [".rev-add", [".rev-add:has(> .ico:first-child)"]],
    [".rev-add.sm", [".rev-add.sm:has(> .ico:first-child)"]],
  ];
  it.each(LEADING)("(a) %s gives a leading glyph's side the text side less 2px", (base, trims) => {
    // CANARY: drop `.seg button:has(> .ico:first-child)` — Grid/List and
    // Board/List read pushed toward their labels again.
    const { right } = sides(base);
    for (const trim of trims) expect(px(decls(trim).get("padding-left")), trim).toBe(right - 2);
  });

  it("(a) a trailing glyph's side is the text side less 2px, on a .btn and on every caret control", () => {
    // CANARY: put `.own-btn` back on `.25rem .75rem`.
    for (const base of [".btn", ".btn.sm"]) {
      expect(px(decls(`${base}:has(> .ico-end:last-child)`).get("padding-right")), base).toBe(sides(base).left - 2);
    }
    for (const caret of [".own-btn", ".rsel-btn", ".stage-menu-btn", ".project-switch"]) {
      const { left, right } = sides(caret);
      expect(right, caret).toBe(left - 2);
    }
    // The board card's square stage trigger still has no padding at all.
    expect(decls(".card-move .stage-menu-btn").get("padding")).toBe("0");
  });

  it("(b) a .btn whose glyph FOLLOWS its label marks it .ico-end", () => {
    // `:first-child` skips text nodes, so "See all <Icon/>" is the button's
    // first ELEMENT and would take the leading trim on the wrong side.
    // CANARY: drop className="ico-end" from the bell's "See all" arrow.
    const trailing: string[] = [];
    const unmarked: string[] = [];
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(path.dirname(APP_DIR), file);
      for (const m of src.matchAll(/className\s*=\s*/g)) {
        const at = m.index + m[0].length;
        const open = src[at]!;
        const chunks = open === "{"
          ? literalChunks(balanced(src, at).body)
          : [src.slice(at + 1, src.indexOf(open, at + 1))];
        if (!chunks.some((c) => /(?:^|\s)btn(?:\s|$)/.test(c))) continue;
        const start = src.lastIndexOf("<", m.index);
        const tag = /^<([\w.]+)/.exec(src.slice(start))?.[1];
        if (!tag) continue;
        // The end of the opening tag: the first `>` outside a `{…}`.
        let i = start;
        for (let depth = 0; i < src.length; i++) {
          if (src[i] === "{") depth++;
          else if (src[i] === "}") depth--;
          else if (src[i] === ">" && depth === 0) break;
        }
        if (src[i - 1] === "/") continue;
        const body = src
          .slice(i + 1, src.indexOf(`</${tag}>`, i))
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
          .trim();
        const last = /<Icon\b([^>]*)\/>$/.exec(body);
        if (!last || last.index === 0) continue;
        trailing.push(`${rel}:${lineAt(src, start)}`);
        if (!/className="[^"]*\bico-end\b/.test(last[1]!)) unmarked.push(`${rel}:${lineAt(src, start)}`);
      }
    }
    expect(trailing.length).toBeGreaterThanOrEqual(3);
    expect(unmarked).toEqual([]);
  });

  /** The drawn extent of an icon's markup, [x0, y0, x1, y1]: path commands
   *  walked (curves and arcs sampled), circles and rects taken whole. */
  const glyphBox = (markup: string): [number, number, number, number] => {
    const xs: number[] = [];
    const ys: number[] = [];
    const add = (x: number, y: number) => {
      xs.push(x);
      ys.push(y);
    };
    for (const [, tag, attrs] of markup.matchAll(/<(\w+)([^>]*)\/>/g)) {
      const a = new Map([...attrs!.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
      const n = (k: string) => Number(a.get(k));
      if (tag === "circle") {
        add(n("cx") - n("r"), n("cy") - n("r"));
        add(n("cx") + n("r"), n("cy") + n("r"));
        continue;
      }
      if (tag === "rect") {
        add(n("x"), n("y"));
        add(n("x") + n("width"), n("y") + n("height"));
        continue;
      }
      expect(tag).toBe("path");
      const d = a.get("d")!;
      const tokens = [...d.matchAll(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)/g)].map((m) => m[0]);
      let i = 0;
      let cmd = "";
      let [x, y, sx, sy] = [0, 0, 0, 0];
      let ctrl: [number, number] | null = null;
      const num = () => Number(tokens[i++]);
      while (i < tokens.length) {
        if (/[A-Za-z]/.test(tokens[i]!)) cmd = tokens[i++]!;
        const C = cmd.toUpperCase();
        const [ox, oy] = cmd === C ? [0, 0] : [x, y];
        if (C === "Z") {
          [x, y, ctrl, cmd] = [sx, sy, null, "?"];
        } else if (C === "M" || C === "L") {
          [x, y, ctrl] = [ox + num(), oy + num(), null];
          if (C === "M") [sx, sy, cmd] = [x, y, cmd === "M" ? "L" : "l"];
          add(x, y);
        } else if (C === "H" || C === "V") {
          if (C === "H") x = ox + num();
          else y = oy + num();
          ctrl = null;
          add(x, y);
        } else if (C === "C" || C === "S") {
          const [x1, y1] = C === "C" ? [ox + num(), oy + num()] : ctrl ? [2 * x - ctrl[0], 2 * y - ctrl[1]] : [x, y];
          const [x2, y2, ex, ey] = [ox + num(), oy + num(), ox + num(), oy + num()];
          for (let s = 0; s <= 64; s++) {
            const t = s / 64;
            const u = 1 - t;
            add(
              u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex,
              u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey,
            );
          }
          [x, y, ctrl] = [ex, ey, [x2, y2]];
        } else if (C === "A") {
          // The endpoint form converted to a centre (SVG 2, appendix B.2.4);
          // every arc in the set is unrotated, so the rotation must be 0.
          let [rx, ry] = [Math.abs(num()), Math.abs(num())];
          expect(num(), `${d} rotates an arc`).toBe(0);
          const [large, sweep, ex, ey] = [num(), num(), ox + num(), oy + num()];
          const [hx, hy] = [(x - ex) / 2, (y - ey) / 2];
          const scale = Math.max(1, Math.sqrt((hx * hx) / (rx * rx) + (hy * hy) / (ry * ry)));
          [rx, ry] = [rx * scale, ry * scale];
          const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0,
            (rx * rx * ry * ry - rx * rx * hy * hy - ry * ry * hx * hx) / (rx * rx * hy * hy + ry * ry * hx * hx)));
          const [cx, cy] = [(k * rx * hy) / ry + (x + ex) / 2, (-k * ry * hx) / rx + (y + ey) / 2];
          const from = Math.atan2((y - cy) / ry, (x - cx) / rx);
          let turn = Math.atan2((ey - cy) / ry, (ex - cx) / rx) - from;
          if (sweep && turn < 0) turn += 2 * Math.PI;
          if (!sweep && turn > 0) turn -= 2 * Math.PI;
          for (let s = 0; s <= 64; s++) {
            const t = from + (turn * s) / 64;
            add(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
          }
          [x, y, ctrl] = [ex, ey, null];
        } else {
          throw new Error(`unhandled path command "${cmd}" in ${d}`);
        }
      }
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  it("(c) every glyph in the icon set is drawn on the centre of its 24px box", () => {
    // Measured off the icon set itself, as ruling 451(f) measures the check.
    // CANARY: put the mock's sparkle back (`M12 3l1.8 5.2L19 10…`), 2 units
    // high in every round agent badge on the board.
    const src = readFileSync(fileURLToPath(new URL("./ui/icon.tsx", import.meta.url)), "utf8");
    const glyphs = [...src.matchAll(/\n\s*(\w+):\s*'([^']+)',/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(glyphs.length).toBeGreaterThan(40);
    const offset = new Map(glyphs.map(([name, markup]) => {
      const [x0, y0, x1, y1] = glyphBox(markup);
      return [name, [(x0 + x1) / 2 - 12, (y0 + y1) / 2 - 12]] as const;
    }));
    // A unit of drift is under a pixel at any size the app draws a glyph; the
    // mock's sparkle, hand and flag were two.
    const off = [...offset].filter(([, [dx, dy]]) => Math.max(Math.abs(dx), Math.abs(dy)) > 1);
    expect(off.map(([name, [dx, dy]]) => `${name} (${dx.toFixed(2)}, ${dy.toFixed(2)})`)).toEqual([]);
    for (const name of ["sparkle", "hand", "flag"]) {
      for (const drift of offset.get(name)!) expect(Math.abs(drift), name).toBeLessThanOrEqual(0.5);
    }
  });

  it("(d) a hint that leads with a glyph is a row, with the glyph on its first line", () => {
    // The .deny-note recipe: a 13px glyph, top-aligned, nudged .125rem onto
    // the first line of .75rem text. CANARY: drop `display: flex` from the
    // icon-led hint rule — the 16px svg falls back onto the baseline.
    const note = decls(".deny-note");
    const noteGlyph = decls(".deny-note .ico");
    for (const hint of [".hint", ".fhint"]) {
      const row = decls(`${hint}:has(> .ico:first-child)`);
      expect(row.get("display"), hint).toBe("flex");
      for (const p of ["align-items", "gap", "line-height"]) expect(row.get(p), `${hint} ${p}`).toBe(note.get(p));
      const glyph = decls(`${hint} > .ico:first-child`);
      for (const p of ["width", "height", "flex", "margin-top"]) expect(glyph.get(p), `${hint} ${p}`).toBe(noteGlyph.get(p));
    }
    // The ruling 144(a) advisory is 16px body text: its glyph stays the 16px
    // svg.ico default (1em) and only takes the row and the nudge.
    const advisory = decls(".cred-card > .sub:has(> .ico:first-child)");
    expect(advisory.get("display")).toBe("flex");
    expect(advisory.get("align-items")).toBe("flex-start");
    const flag = decls(".cred-card > .sub > .ico:first-child");
    expect(flag.get("margin-top")).toBe(".125rem");
    expect(flag.has("width")).toBe(false);
  });

  it("(e) a text-only chip is centred; only a glyph-led one keeps the short start side", () => {
    // CANARY: put `.pick-chip` back on `.375rem .75rem .375rem .5rem`.
    const pick = sides(".pick-chip");
    expect(pick.left).toBe(pick.right);
    for (const lead of [".ico", ".sdot", ".agent-glyph"]) {
      expect(px(decls(`.pick-chip:has(> ${lead}:first-child)`).get("padding-left")), lead).toBeLessThan(pick.right);
    }
    const board = sides(".chip");
    expect(board.left).toBeLessThan(board.right);
    expect(px(decls(".chip.more").get("padding-left"))).toBe(board.right);
  });

  it("(f) a pill that leads with its mark takes 2px less on that side", () => {
    // CANARY: drop `.pill:has(> .col-stage-dot:first-child)` — the task hero's
    // stage pill stands 2px wider at the start than the status pill beside it.
    for (const base of [".pill", ".pill.sm"]) {
      const { left, right } = sides(base);
      expect(left, base).toBe(right);
      for (const mark of [".pdot", ".ico", ".col-stage-dot"]) {
        expect(px(decls(`${base}:has(> ${mark}:first-child)`).get("padding-left")), `${base} ${mark}`).toBe(right - 2);
      }
    }
  });

  it("(g) a credential notice's check sits on the first line, as its warning twin's alert does", () => {
    // CANARY: drop `align-items: flex-start` from the .cred-ok first-line rule.
    const warn = decls(".cred-warn");
    const ok = decls(".cred-ok");
    for (const p of ["font-size", "line-height"]) expect(ok.get(p), p).toBe(warn.get(p));
    const firstLine = ".cred-ok:not(:has(> .modal-close))";
    expect(decls(firstLine).get("align-items")).toBe(warn.get("align-items"));
    expect(decls(`${firstLine} > .ico`).get("margin-top")).toBe(decls(".cred-warn .ico").get("margin-top"));
    // The notice with the ruling 148 close keeps its centred row.
    expect(ok.get("align-items")).toBe("center");
  });
});

describe("app.css ruling 459: the better-ui pass — surfaces, shadows and image outlines", () => {
  // Shadows for elevation, borders for structure; images wear a neutral
  // 1px outline, pure black at 10% on light and pure white at 10% on dark
  // (better-ui, surfaces.md). The values are the skill's, exactly.
  const phone = RULES.filter((r) => r.at.some((a) => /max-width:\s*720px/.test(a)));
  const more = RULES.filter((r) => r.at.some((a) => /prefers-contrast:\s*more/.test(a)));
  const light = requiredDecls(plain, ":root");
  const dark = requiredDecls(plain, ':root[data-theme="dark"]');
  /** A length in px, rem at 16px, a `var(--radius-*)` through the token block. */
  const px = (value: string | undefined): number => {
    const token = /^var\((--[\w-]+)\)$/.exec(value ?? "");
    if (token) return px(light.get(token[1]!));
    if (value === "0") return 0;
    const m = /^(-?[\d.]+)(px|rem)$/.exec(value ?? "");
    expect(m, `${value} must be a px or rem length`).toBeTruthy();
    return Number(m![1]) * (m![2] === "rem" ? 16 : 1);
  };
  /** A padding shorthand's four sides, in px. */
  const sides = (rules: CssRule[], selector: string) => {
    const [top, right = top, bottom = top, left = right] = (requiredDecls(rules, selector).get("padding") ?? "").trim().split(/\s+/);
    return { top: px(top), right: px(right), bottom: px(bottom), left: px(left) };
  };

  const POP = [".confirm-card", ".modal-card", ".cmdk-card", ".page-overlay", ".dock-panel"];
  const MENUS = [".user-menu", ".stage-menu-pop", ".datepick-pop", ".label-select", ".ntf-pop", ".rsel-menu", ".own-menu"];

  it("(a) a floating surface's edge is a translucent ring, not an opaque border outside which the ring drew a second rim", () => {
    // CANARY: put `.modal-card` back on `border: 1px solid var(--border)`, or
    // `.user-menu` back on a bare `var(--shadow-menu)`.
    expect(light.get("--shadow-ring")).toBe("0 0 0 1px oklch(0 0 0 / 0.06)");
    expect(dark.get("--shadow-ring")).toBe("0 0 0 1px oklch(1 0 0 / 0.08)");
    for (const theme of [light, dark]) expect(theme.get("--shadow-pop")).toMatch(/, var\(--shadow-ring\)$/);
    // Not folded into --shadow-menu: the round dock trigger wears that token
    // with its own agent-tinted border and must not gain a second rim.
    for (const theme of [light, dark]) expect(theme.get("--shadow-menu")).not.toMatch(/shadow-ring/);
    for (const surface of POP) {
      const d = requiredDecls(plain, surface);
      expect(d.get("border"), surface).toBe("1px solid transparent");
      expect(d.get("box-shadow"), surface).toBe("var(--shadow-pop)");
    }
    for (const menu of MENUS) {
      const d = requiredDecls(plain, menu);
      expect(d.get("border"), menu).toBe("1px solid transparent");
      expect(d.get("box-shadow"), menu).toBe("var(--shadow-ring), var(--shadow-menu)");
    }
    // The sweep, so the next floating surface is in scope when it is written:
    // nothing that wears an elevation token draws its edge with a decorative
    // opaque border.
    const elevated = [...new Set(plain
      .filter((r) => /var\(--shadow-(?:pop|menu)\)/.test(r.decls.get("box-shadow") ?? ""))
      .flatMap(selectorParts))];
    expect(elevated).toEqual(expect.arrayContaining([...POP, ...MENUS, ".toast", ".dock-fab"]));
    const opaque = elevated.filter((s) => /var\(--(?:border|hairline)\)/.test(requiredDecls(plain, s).get("border") ?? ""));
    expect(opaque).toEqual([]);
  });

  it("(a) the phone drawer floats too, while the desktop rail keeps its divider", () => {
    // CANARY: drop `border-right-color: transparent` from the 720px `.rail`.
    const drawer = requiredDecls(phone, ".rail");
    expect(drawer.get("box-shadow")).toBe("var(--shadow-pop)");
    expect(drawer.get("border-right-color")).toBe("transparent");
    // A divider between the rail and the page is structure; it stays a border.
    expect(requiredDecls(plain, ".rail").get("border-right")).toBe("1px solid var(--hairline)");
  });

  it("(a) increased contrast still reaches the ring, now the floating surfaces' only edge (ruling 453(d))", () => {
    // CANARY: delete `--shadow-ring` from the `prefers-contrast: more` block —
    // every modal, menu and the dock is left with a 6-8% ring there.
    expect(requiredDecls(more, ":root[data-theme]").get("--shadow-ring")).toBe("0 0 0 1px var(--border-control)");
  });

  it("(b) an image's edge is pure black or white at 10%, in both themes", () => {
    // CANARY: set the dark --image-outline to `var(--ring)`, a tinted neutral.
    expect(light.get("--image-outline")).toBe("oklch(0 0 0 / 0.1)");
    expect(dark.get("--image-outline")).toBe("oklch(1 0 0 / 0.1)");
  });

  // Every rule that targets an emitted <img>: the markdown embed, the
  // lightbox picture, the two attachment tiles, and (ruling 573) a picture
  // in a composer's tray and in a controller message.
  const IMAGES = [
    ".md-body img",
    ".lightbox-card .lightbox-img",
    ".attach-thumb img",
    ".tl-attach-thumb img",
    ".att-chip-media img",
    ".ctl-file-pic img",
  ];
  it.each(IMAGES)("(b) %s draws the image edge just inside the picture", (selector) => {
    // CANARY: drop the outline from `.md-body img`.
    const d = requiredDecls(plain, selector);
    expect(d.get("outline"), selector).toBe("1px solid var(--image-outline)");
    expect(d.get("outline-offset"), selector).toBe("-1px");
  });

  it("(b) no other rule targets an image without the edge", () => {
    // `.md-img-btn` is only ever emitted inside a `.md-body`, so `.md-body img`
    // reaches its picture. Anything else aimed at an <img> must be listed.
    const COVERED_BY = { ".md-img-btn > img": ".md-body img" } satisfies Record<string, string>;
    const aimed = [...new Set(plain.flatMap(selectorParts).filter((s) => /(?:^|[\s>])img$|\.lightbox-img$/.test(s)))];
    expect(aimed.filter((s) => !IMAGES.includes(s) && !(s in COVERED_BY))).toEqual([]);
    for (const [s, by] of Object.entries(COVERED_BY)) {
      expect(aimed, s).toContain(s);
      expect(IMAGES).toContain(by);
    }
  });

  it("(c) an attachment tile insets its picture concentrically, so the image has an edge on all four sides", () => {
    // CANARY: take `padding: .25rem` off `.attach-thumb` — the picture runs
    // flush again and its bottom edge meets the caption with no line.
    for (const [tile, img] of [[".attach-thumb", ".attach-thumb img"], [".tl-attach-thumb", ".tl-attach-thumb img"]] as const) {
      const inset = sides(plain, tile);
      expect(new Set(Object.values(inset)).size, tile).toBe(1);
      expect(inset.top, tile).toBeGreaterThan(0);
      const outer = px(requiredDecls(plain, tile).get("border-radius"));
      const inner = px(requiredDecls(plain, img).get("border-radius"));
      const edge = px((requiredDecls(plain, tile).get("border") ?? "").split(/\s+/)[0]);
      expect(Math.abs(inner + inset.top + edge - outer), `${tile}: ${inner} + ${inset.top} + ${edge} against ${outer}`)
        .toBeLessThanOrEqual(1);
      // A failed load fills the picture's slot, so it takes the picture's corner.
      expect(requiredDecls(plain, `${tile} .attach-broken`).get("border-radius"), tile).toBe(requiredDecls(plain, img).get("border-radius"));
    }
  });

  it("(c) the captions keep the distances they had before the inset", () => {
    // CANARY: put `.tl-attach-thumb .nm` back on `.25rem .5rem` — the name
    // stands 4px further in than the picture's edge rhythm allows.
    const panel = sides(plain, ".attach-thumb");
    const meta = sides(plain, ".attach-meta");
    const by = sides(plain, ".attach-thumb .attach-by");
    expect(panel.left + meta.left).toBe(8);
    expect(panel.right + meta.right).toBe(8);
    expect(meta.top).toBe(6);
    expect(meta.bottom + panel.bottom).toBe(6); // a tile with no producer line
    expect(meta.bottom + by.top).toBe(6);
    expect(by.bottom + panel.bottom).toBe(6);
    expect(panel.left + by.left).toBe(8);
    const feed = sides(plain, ".tl-attach-thumb");
    const nm = sides(plain, ".tl-attach-thumb .nm");
    expect(feed.left + nm.left).toBe(8);
    expect(nm.top).toBe(4);
    expect(nm.bottom + feed.bottom).toBe(4);
  });

  /** A shadow layer with its colour functions removed, so the lengths remain. */
  const bare = (layer: string) => {
    let out = "";
    let depth = 0;
    for (const ch of layer) {
      if (ch === "(") depth++;
      if (depth === 0) out += ch;
      if (ch === ")") depth--;
    }
    return out;
  };

  it("(d) no drop shadow is mixed from the ink, which turns into a light glow on dark", () => {
    // CANARY: put `.tgl .knob` back on `0 1px 2px color-mix(in srgb,
    // var(--fg), transparent 70%)`, or `.fm-act` on `var(--tint-press)`.
    const drops = RULES.flatMap((r) =>
      splitArgs(r.decls.get("box-shadow") ?? "").map((layer) => ({ at: r.selector, layer })),
    ).filter(({ layer }) => {
      const words = bare(layer).trim().split(/\s+/);
      if (words.includes("inset")) return false;
      const [, y = "0", blur = "0"] = words.filter((w) => /^-?[\d.]+(?:px|rem|em)?$/.test(w));
      return y !== "0" || blur !== "0";
    });
    // The board card's two contact shadows, the knob (both themes) and .fm-act.
    expect(drops.length).toBeGreaterThanOrEqual(5);
    const inked = drops.filter(({ layer }) => /var\(--(?:fg|tint-[\w-]+)\)/.test(layer));
    expect(inked.map(({ at, layer }) => `${at} → ${layer}`)).toEqual([]);
    // The elevation tokens mix the ink in light and so must each be
    // redeclared, in black, on dark.
    const tokens = [...light].filter(([k, v]) => k.startsWith("--shadow-") && /var\(--fg\)/.test(v));
    expect(tokens.length).toBeGreaterThanOrEqual(4);
    for (const [k] of tokens) {
      expect(dark.has(k), k).toBe(true);
      expect(dark.get(k), k).not.toMatch(/var\(--fg\)/);
    }
  });

  it("(d) the dark toggle knob takes the white edge ring; light keeps a plain contact shadow", () => {
    // CANARY: delete the `:root[data-theme="dark"] .tgl .knob` rule.
    const drop = requiredDecls(plain, ".tgl .knob").get("box-shadow")!;
    expect(drop).toBe("0 1px 2px rgba(0, 0, 0, .3)");
    expect(requiredDecls(plain, ':root[data-theme="dark"] .tgl .knob').get("box-shadow")).toBe(`var(--shadow-ring), ${drop}`);
    expect(requiredDecls(plain, ".fm-act").get("box-shadow")).toBe("0 1px 2px rgba(0, 0, 0, .08)");
  });
});

describe("app.css ruling 459: the better-ui pass — press and hover feedback", () => {
  // Scale on press: always .96 for a control (the sheet's .99 for a surface),
  // never below .95, and a CSS transition so a release mid-press eases back.
  // High-frequency hovers change colour, not position (better-ui, SKILL.md and
  // animations.md). The press block states the rest: the press belongs to the
  // element pressed, and only a control that can act presses.
  const phone = RULES.filter((r) => r.at.some((a) => /max-width:\s*720px/.test(a)));
  // Top-level commas only: `:not(:disabled, [aria-disabled="true"])` is one part.
  /** A state selector with its states taken off: `:active`, `:hover`, and the
   *  `:not()` / `:where()` guards on them. */
  const stateless = (part: string) =>
    part
      .replace(/:(?:not|where)\((?:[^()]|\([^()]*\))*\)/g, "")
      .replace(/:(?:active|hover)\b/g, "")
      .trim();
  /** The element a press rule scales, and the element that is pressed. They
   *  differ for a container that dips only when a child is pressed. */
  const pressOf = (part: string) => {
    const child = /:has\(>\s*([^()]*?):active\)/.exec(part);
    const scaled = stateless(part.replace(/:has\([^()]*\)/g, ""));
    return { scaled, pressed: child ? `${scaled} > ${child[1]!.trim()}` : scaled };
  };
  /** A selector, then the same with its last compound's tag dropped, then that
   *  compound alone: where an element's own transition or transform lives. */
  const lookups = (selector: string) => {
    const last = selector.split(/\s+/).pop()!;
    return [...new Set([selector, selector.replace(/(^|\s)[a-z]+(?=\.)/g, "$1"), last, last.replace(/^[a-z]+(?=\.)/, "")])];
  };
  const firstOwn = (rules: CssRule[][], selector: string, prop: string) => {
    for (const s of lookups(selector)) {
      for (const set of rules) {
        const v = declsFor(set, s).get(prop);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  };
  const scaleOf = (transform: string | undefined) => {
    const m = /scale\(([\d.]+)\)/.exec(transform ?? "");
    return m ? Number(m[1]) : 1;
  };
  /** Everything a transform does besides scale, with no-op offsets dropped. */
  const moves = (transform: string | undefined) =>
    (transform === undefined || transform === "none" ? "" : transform)
      .replace(/scale\([^)]*\)/g, "")
      .replace(/translate[XY]?\(0\)/g, "")
      .trim();

  type Press = { at: "plain" | "phone"; part: string; transform: string; scaled: string; pressed: string };
  const PRESSES: Press[] = [
    ...plain.map((r) => ["plain", r] as const),
    ...phone.map((r) => ["phone", r] as const),
  ].flatMap(([at, r]) => {
    const transform = r.decls.get("transform");
    if (transform === undefined || transform === "none") return [];
    return selectorParts(r)
      .filter((p) => /:active\b/.test(p))
      .map((part) => ({ at, part, transform, ...pressOf(part) }));
  });
  const contexts = (p: Press) => (p.at === "phone" ? [phone, plain] : [plain]);

  it("(F22, F32) found the press block, not an empty list", () => {
    expect(PRESSES.length).toBeGreaterThan(50);
  });

  it("(F22) every press eases in on a transform leg of its element's own transition", () => {
    // CANARY: take `transform` back out of `.nav-item`'s transition, or delete
    // `.cal-day`'s. Fourteen press-scaled controls had a list without it, or
    // no transition at all, so the scale jumped in one frame and snapped back.
    const snaps = PRESSES.filter((p) => {
      const transition = firstOwn(contexts(p), p.scaled, "transition") ?? "";
      return !splitArgs(transition).some((layer) => /^transform\b.* var\(--ease-out\)$/.test(layer));
    }).map((p) => `${p.at} ${p.part}`);
    expect(snaps).toEqual([]);
  });

  it("(F30) every press is the control step or the surface step of its element's resting size, never under .95", () => {
    // CANARY: put `.fm-act:active` back on scale(.94), `.pj-star:active` on
    // .9, or the perched dock button's press on .72 (.935 of its .77 rest).
    const off = PRESSES.flatMap((p) => {
      const rest = firstOwn(contexts(p), p.scaled, "transform");
      const ratio = scaleOf(p.transform) / scaleOf(rest);
      const step = [0.96, 0.99].find((s) => Math.abs(ratio - s) < 0.005);
      // The press keeps whatever else the element's resting transform does
      // (the date picker's clear and the row pin stay centred, the perched
      // dock button stays perched).
      const kept = moves(p.transform) === moves(rest);
      return step !== undefined && kept ? [] : [`${p.at} ${p.part} → ${ratio.toFixed(3)} ${kept ? "" : "(moved)"}`];
    });
    expect(off).toEqual([]);
    expect(declsFor(phone, '.dock[data-open="true"] .dock-fab:active').get("transform")).toMatch(/\) scale\(\.74\)$/);
    expect(declsFor(phone, '.dock[data-open="true"] .dock-fab:active').get("transition-duration")).toBe(".1s");
    expect(declsFor(plain, ".dock-fab:active").get("transform")).toBe("scale(.96)");
  });

  it("(F31) the press belongs to the element pressed, never to a container that holds it", () => {
    // CANARY: put `.card:active` back (the board's list row is a div holding
    // two links and the Move button, and dipped ~9px for a press on any of
    // them), or `.pj-card:active` (a press on the pin dipped the whole card).
    // `:active` matches every ancestor of what is pressed, so a pressed
    // element must be a control and hold no DOM control of its own (a
    // component child is opaque to this file-local scan).
    const NOT_A_CONTAINER = {
      '.btn:active:not(:disabled, [aria-disabled="true"]) → <label> app/features/task-detail/attachments-panel.tsx holds <input>':
        "the attach button is a <label> wrapping its own hidden file input: pressing the label is pressing that input, one control.",
      '.btn:active:not(:disabled, [aria-disabled="true"]) → <label> app/features/board/filed-files.tsx holds <input>':
        "the New task dialog's Attach files button (ruling 533) is the same <label> around its own hidden file input, one control.",
      ".keybtn:active → <span> app/features/notifications/notifications-page.tsx is not a control":
        "`.keybtn.dead`, an orphan row's project note, is an inline <span>; a transform does not apply to a non-replaced inline box, so no press draws on it.",
    } satisfies Record<string, string>;
    // A component that renders exactly one control and passes the class to it
    // is that control (the scan cannot see through a component boundary).
    const ONE_CONTROL = {
      RadioSegOption: "renders one Radix ToggleGroup.Item, a <button>, carrying its className (ui/radio-seg.tsx)",
    } satisfies Record<string, string>;
    expect(readFileSync(path.join(APP_DIR, "ui/radio-seg.tsx"), "utf8")).toMatch(/<ToggleGroup\.Item value=\{value\} \{\.\.\.\{ className \}\}/);
    const offenders = new Set<string>();
    let judged = 0;
    for (const p of PRESSES) {
      const matched = ELEMENTS.filter((el) => matchesSelector(el, p.pressed));
      if (matched.length) judged++;
      for (const el of matched) {
        const where = `${p.part} → <${el.tag}> ${el.file}`;
        if (!el.interactive && !(el.tag in ONE_CONTROL)) offenders.add(`${where} is not a control`);
        const inner = ELEMENTS.find(
          (d) => d.interactive && /^[a-z]/.test(d.tag) && d.chain.some((f) => f.id === el.id),
        );
        if (inner) offenders.add(`${where} holds <${inner.tag}>`);
      }
    }
    expect(judged).toBeGreaterThan(30);
    expect([...offenders].filter((o) => !(o in NOT_A_CONTAINER))).toEqual([]);
    // Every exemption is still load-bearing.
    expect(Object.keys(NOT_A_CONTAINER).filter((k) => !offenders.has(k))).toEqual([]);
    for (const container of [".pj-card", ".pj-row"]) {
      expect(PRESSES.some((p) => p.part === `${container}:has(> .pj-link:active)`), container).toBe(true);
    }
    expect(PRESSES.some((p) => p.part === "a.card:active")).toBe(true);
  });

  it("(F32) the controls the block had missed press at their step, as their neighbours do", () => {
    // CANARY: drop `.rsel-btn:active` (the run selector beside the stage
    // trigger that presses), or `.rail-toggle:active` from the 720px block
    // (the hamburger beside the bell that presses).
    const stepOf = (part: string, rules: "plain" | "phone" = "plain") =>
      PRESSES.find((p) => p.at === rules && p.part === part)?.transform;
    for (const part of [
      '.prop-btn:active:where(:not([aria-busy="true"]))', ".rsel-btn:active", ".cal-nav:active", ".cal-day:active", "button.kbd:active",
      ".home-user:active", ".board-orphan-key:active",
    ]) {
      expect(stepOf(part), part).toBe("scale(.96)");
    }
    expect(stepOf(".datepick-clear:active")).toBe("translateY(-50%) scale(.96)");
    for (const part of [
      ".ag-newbtn:active", ".live-row:active", ".ctl-example:active:not(:disabled)", ".ctl-conv:active",
      ".project-switch:active", '.ntf-item:active:not([aria-disabled="true"])', ".attach-file:active",
      ".attach-thumb:active", ".tl-attach-thumb:active", "button.top-search:active",
    ]) {
      expect(stepOf(part), part).toBe("scale(.99)");
    }
    // The hamburger exists only at 720px, so its press lives there too; the
    // global rule stays `display: none` alone (F19-33 pins that). The palette
    // trigger is a 360px surface above it and a 34px icon box below it.
    expect(stepOf(".rail-toggle:active", "phone")).toBe("scale(.96)");
    expect(stepOf("button.top-search:active:not(:disabled)", "phone")).toBe("scale(.96)");
    // Transition only what changes: its hover moves the fill, not the border.
    expect(requiredDecls(plain, "button.top-search").get("transition")).toBe(
      "background-color .14s ease, transform .15s var(--ease-out)",
    );
    // A link-styled "Show more" inside a sentence opts out of its .keybtn's press.
    expect(declsFor(plain, ".keybtn.act-toggle:active").get("transform")).toBe("none");
  });

  it("(F33) a refused or disabled control neither hovers nor presses, and dims at the house step", () => {
    // CANARY: put `.btn:hover` back on `:not(:disabled)` (the refused Confirm
    // lifted and turned blue-pressed), or drop `.stg-x:disabled`'s
    // `pointer-events: none` (a viewer's disabled stage ✕ turned destructive
    // red under the pointer).
    const refusedToo = ':not(:disabled, [aria-disabled="true"])';
    expect(declsFor(plain, `.btn:hover${refusedToo}`).get("border-color")).toBe("var(--fg)");
    expect(declsFor(plain, `.btn:active${refusedToo}`).get("transform")).toBe("scale(.96)");
    expect(declsFor(plain, `.btn.primary:hover${refusedToo}`).get("background")).toBe("var(--blue-pressed)");
    expect(plain.some((r) => selectorParts(r).includes(".btn:hover:not(:disabled)"))).toBe(false);
    // The refusal dims at the disabled step, in the P14-LV-08 group.
    const refused = requiredDecls(plain, '.btn[aria-disabled="true"]');
    expect(refused.get("opacity")).toBe(".45");
    expect(refused.get("cursor")).toBe("not-allowed");
    expect(refused.get("transform")).toBe("none");
    // A refused option dims; the decided record's options (natively disabled,
    // ruling 138) stay at full ink and only drop the pointer.
    expect(declsFor(plain, `.opt:hover:where(${refusedToo})`).get("border-color")).toBe("var(--border)");
    expect(declsFor(plain, '.opt[aria-disabled="true"]:not(:disabled)').get("opacity")).toBe(".45");
    expect(declsFor(plain, ".opt:disabled").get("opacity")).toBeUndefined();
    expect(PRESSES.some((p) => p.part === `.opt:active:where(${refusedToo})`)).toBe(true);
    // A disabled ✕ answers nothing and reads disabled; the pinned destructive
    // hovers keep their exact selectors (P16-UI-04).
    expect(declsFor(plain, ".stg-x:disabled").get("pointer-events")).toBe("none");
    expect(declsFor(plain, ".stg-name:disabled").get("pointer-events")).toBe("none");
    expect(declsFor(plain, ".stg-x:disabled:not(.off)").get("opacity")).toBe(".45");
    // A backend option that is not configured holds still, and the selected
    // one keeps its blue edge on hover (`:where()` keeps the hover's weight).
    expect(declsFor(plain, ".be-opt:disabled").get("opacity")).toBe(".45");
    expect(declsFor(plain, ".be-opt:hover:where(:not(:disabled))").get("border-color")).toBe("var(--border)");
    expect(declsFor(plain, ".stage-menu-btn:hover:where(:not(:disabled))").get("background")).toBe("var(--tint-press)");
    // Disabled only while their own request is in flight: the busy step.
    for (const busy of [".deploy-row:disabled", ".rev-x:disabled", ".stage-menu-btn:disabled", '.stg-x[aria-busy="true"]:disabled']) {
      expect(declsFor(plain, busy).get("opacity"), busy).toBe(".7");
      expect(declsFor(plain, busy).get("cursor"), busy).toBe("default");
    }
    // Every press on a class that renders disabled or refused is guarded, and
    // a locked grant chip (a <span>) is not a control.
    for (const part of [
      ".be-opt:active:not(:disabled)", ".deploy-row:active:not(:disabled)", "button.pick-chip:active:not(:disabled)",
      ".rev-add:active:not(:disabled)", ".handoff-chip:active:not(:disabled)", ".rev-x:active:not(:disabled)",
      ".stg-x:active:not(:disabled)",
    ]) {
      expect(PRESSES.some((p) => p.part === part), part).toBe(true);
    }
    expect(PRESSES.some((p) => p.part.startsWith(".pick-chip:active"))).toBe(false);
  });

  it("(F43) a control or row hovered all day changes colour, not position; the infrequent tiles keep their lift", () => {
    // CANARY: put `.btn:hover`'s translateY(-1px) back, or `.pj-row:hover`'s
    // translateX(2px) (which also slid the pin's hit area under the pointer).
    const FREQUENT = [".btn", ".ag-item", ".pcap-row", ".deploy-row", ".pj-row", ".fm-act", ".pj-star", ".pj-row .pj-star"];
    const moving = plain
      .filter((r) => r.decls.has("transform"))
      .flatMap((r) => selectorParts(r).filter((p) => /:hover\b/.test(p)).map((p) => ({ p, base: stateless(p) })))
      .filter(({ base }) => FREQUENT.includes(base))
      .map(({ p }) => p);
    expect(moving).toEqual([]);
    // Each keeps a static hover cue.
    for (const [hover, prop] of [
      [".ag-item:hover", "border-color"],
      [".pcap-row:hover", "border-color"],
      [".deploy-row:hover:not(:disabled)", "border-color"],
      [".pj-row:hover", "border-color"],
      [".fm-act:hover", "border-color"],
      [".pj-star:hover", "background"],
      // Its resting border is already --fg, so the base border hover is no
      // cue on it; the fill moves instead (review, same pass).
      ['.btn.provider.github:hover:not(:disabled, [aria-disabled="true"])', "background"],
    ] as const) {
      expect(declsFor(plain, hover).get(prop), hover).toBeTruthy();
    }
    expect(declsFor(plain, ".btn.provider.github").get("border-color")).toBe(declsFor(plain, ".btn:hover:not(:disabled, [aria-disabled=\"true\"])").get("border-color"));
    // The row's chevron brightens in place, on a colour transition.
    expect(declsFor(plain, ".pj-row .go").get("transition")).toBe("color .14s ease");
    expect(declsFor(plain, ".pj-row:hover .go").get("transform")).toBeUndefined();
    // A tile chosen once, not hovered all day, keeps its lift.
    for (const tile of [".pj-card:hover", ".org-tile.go:hover", ".be-opt:hover:where(:not(:disabled))"]) {
      expect(declsFor(plain, tile).get("transform"), tile).toMatch(/^translateY\(-\dpx\)$/);
    }
  });

  it("(F50) the unselected .seg option brightens on hover like its sibling families", () => {
    // CANARY: delete `.seg button:hover:not(:disabled)` (Grid/List changed
    // nothing but the cursor). D32-5 holds the selected option's colour.
    for (const family of [".seg button", ".mini-seg button", ".cap-seg button"]) {
      expect(declsFor(plain, `${family}:hover:not(:disabled)`).get("color"), family).toBe("var(--fg)");
    }
    expect(declsFor(plain, ".fchip:hover:not(:disabled)").get("color")).toBe("var(--fg)");
    // On the high-frequency clock: colour at 150ms or less.
    const color = splitArgs(declsFor(plain, ".seg button").get("transition") ?? "").find((l) => /^color\b/.test(l));
    expect(color).toBe("color .14s ease");
  });
});

describe("app.css ruling 459: the better-ui pass — enter and exit", () => {
  // Enter and exit (better-ui, enter-exit.md and animations.md): a small fixed
  // translate, exits softer and shorter than enters, every veil fades, what is
  // already on screen at first paint moves only on a later change, and UI the
  // keyboard opens appears at once. Every motion keeps a reduced-motion answer
  // that the cascade actually reaches.
  const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const phone = RULES.filter((r) => r.at.some((a) => /max-width:\s*720px/.test(a)));
  const wide = RULES.filter((r) => r.at.some((a) => /min-width:\s*900px/.test(a)));
  const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

  it("(F23) the bell badge pulses only when a notification arrives, and reduced motion stills it", () => {
    // CANARY: put `animation: stagePulse .45s ease` back on the bare
    // `.bell-badge` (it pulsed on every first paint, every Home / workspace /
    // standalone remount and every fall), or move the reduced-motion answer
    // above the rule it answers (the old one lost on source order).
    expect(declsFor(plain, ".bell-badge").has("animation")).toBe(false);
    expect(declsFor(plain, ".bell-badge[data-arrived]").get("animation")).toBe("stagePulse .45s ease");
    expect(declsFor(reduced, ".bell-badge[data-arrived]").get("animation")).toBe("none");
    // Equal specificity, so the answer must come later in the sheet.
    const rule = CODE.indexOf(".bell-badge[data-arrived] { animation: stagePulse");
    const answer = CODE.indexOf(".bell-badge[data-arrived] { animation: none");
    expect(rule).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(rule);
  });

  it("(F25) the drawer's veil fades in and out, and the drawer closes faster than it opens", () => {
    // CANARY: put the scrim back on `display: none` / `display: block` alone
    // (the 30% veil switched on and off in one frame), or the rail's close
    // back on .2s.
    const closed = declsFor(plain, ".rail-scrim");
    expect(closed.get("display")).toBe("none");
    expect(closed.get("opacity")).toBe("0");
    expect(closed.get("visibility")).toBe("hidden");
    expect(closed.get("pointer-events")).toBe("none");
    expect(closed.get("transition")).toBe("opacity .15s var(--ease-out), visibility 0s linear .15s");
    // Under the breakpoint it is laid out, so it has a box to fade; what hides
    // it stays outside the width query (R19-12 reads a width-scoped
    // visibility / opacity / pointer-events as a removed control).
    const laidOut = declsFor(phone, ".rail-scrim");
    expect(laidOut.get("display")).toBe("block");
    for (const prop of ["opacity", "visibility", "pointer-events"]) expect(laidOut.has(prop), prop).toBe(false);
    const open = declsFor(phone, '.app[data-rail-open="true"] .rail-scrim');
    expect(open.get("opacity")).toBe("1");
    expect(open.get("visibility")).toBe("visible");
    expect(open.get("pointer-events")).toBe("auto");
    expect(open.get("transition")).toBe("opacity .2s var(--ease-out)");
    // The drawer: out in .15s, in over .2s, both on --ease-out. The open rule
    // names only a duration, so reduced motion's `transition: none` keeps the
    // slide off in both directions. The visibility step that takes the closed
    // drawer's links out of the tab order (ruling 455, acce-13) waits out the
    // same .15s slide.
    expect(declsFor(phone, ".rail").get("transition")).toBe(
      "transform .15s var(--ease-out), visibility 0s linear .15s",
    );
    const opening = declsFor(phone, '.app[data-rail-open="true"] .rail');
    // Transform over .2s; visibility at once, or the nav the toggle focuses
    // on the opening frame is still hidden and refuses focus.
    expect(opening.get("transition-duration")).toBe(".2s, 0s");
    expect(opening.has("transition")).toBe(false);
    expect(opening.has("transition-property")).toBe(false);
    expect(declsFor(reduced, ".rail").get("transition")).toBe("none");
    // The layers that sit above the veil (the topbar at 60, the dock at 55)
    // drop under it at once and come back only once it has faded.
    expect(declsFor(phone, ".topbar").get("transition")).toBe("z-index 0s linear .15s");
    expect(declsFor(phone, '.app[data-rail-open="true"] .topbar').get("transition")).toBe("none");
    expect(declsFor(plain, ".dock").get("transition")).toBe("visibility 0s linear .15s");
    expect(declsFor(plain, 'body[data-rail-open="true"] .dock').get("transition")).toBe("none");
  });

  it("(F26) a centred dialog rises a fixed 8px and leaves by a softer, shorter 6px", () => {
    // CANARY: put pop-center back on translate(-50%, -46%): a percentage is 4%
    // of the card's own height, 9px on a confirm and 31px on the overlay.
    const frames =
      /@keyframes pop-center \{\s*from \{ opacity: 0; transform: translate\(-50%, calc\(-50% \+ (\d+)px\)\) scale\(([\d.]+)\); \}\s*to \{ opacity: 1; transform: translate\(-50%, -50%\) scale\(1\); \}\s*\}/.exec(
        CODE,
      );
    expect(frames, "pop-center travels a fixed px offset").not.toBeNull();
    const enter = { px: Number(frames![1]), scale: Number(frames![2]) };
    expect(enter.px).toBeLessThanOrEqual(12);
    const closing = declsFor(plain, "dialog[data-closing]");
    const exit = /^translate\(-50%, calc\(-50% \+ (\d+)px\)\) scale\(([\d.]+)\)$/.exec(closing.get("transform") ?? "");
    expect(exit, "the close travels a fixed px offset").not.toBeNull();
    // Softer: less travel and less shrink than the enter, the same direction.
    expect(Number(exit![1])).toBeGreaterThan(0);
    expect(Number(exit![1])).toBeLessThan(enter.px);
    expect(Number(exit![2])).toBeGreaterThan(enter.scale);
    // Shorter: .15s against the enter's .18s, both on --ease-out.
    for (const card of [".confirm-card", ".modal-card", ".page-overlay"]) {
      expect(declsFor(plain, card).get("animation"), card).toBe("pop-center .18s var(--ease-out)");
    }
    expect(closing.get("transition")).toBe("opacity .15s var(--ease-out), transform .15s var(--ease-out)");
    // Reduced motion still re-centres the close and only fades it.
    expect(declsFor(reduced, "dialog[data-closing]").get("transform")).toBe("translate(-50%, -50%)");
    expect(CODE).not.toMatch(/translate\(-50%, -4\d%\)/);
  });

  it("(F28) the login pitch reads in after the card, ~100ms a chunk, and reduced motion fades it at once", () => {
    // CANARY: put `animation: rise .3s var(--ease-out)` back on `.login-aside`
    // (the pitch rose as one block, in step with the card), or drop
    // `.login-aside > p` from the reduced-motion list (its 200ms delay then
    // survives the fade: the paragraph shows, blanks and fades in).
    expect(declsFor(plain, ".login-card").get("animation")).toBe("rise .3s var(--ease-out)");
    expect(declsFor(wide, ".login-aside").has("animation")).toBe(false);
    expect(declsFor(wide, ".login-aside > *").get("animation")).toBe("rise .3s var(--ease-out) 100ms backwards");
    expect(declsFor(wide, ".login-aside > p").get("animation-delay")).toBe("200ms");
    expect(declsFor(wide, ".login-aside > .login-aside-points").get("animation-delay")).toBe("300ms");
    // Those are the aside's own chunks, in reading order.
    const aside = /<aside className="login-aside">([\s\S]*?)<\/aside>/.exec(source("./routes/login.tsx"))![1]!;
    const chunks = [...aside.matchAll(/\n {8}<(\w+)(?: className="([\w-]+)")?/g)].map((m) => m[2] ?? m[1]);
    expect(chunks).toEqual(["login-aside-mark", "h2", "p", "login-aside-points"]);
    // Reduced motion: one quick fade, every delay reset by the shorthand.
    for (const selector of [".login-aside > *", ".login-aside > p", ".login-aside > .login-aside-points"]) {
      expect(declsFor(reduced, selector).get("animation"), selector).toBe("fade-in .12s ease");
    }
  });

  it("(F44) the listboxes typing opens appear at once; the click-opened run selector keeps its entrance", () => {
    // CANARY: delete `.rsel-menu.mention-menu { animation: none; }` (the
    // mention list rose in on every '@' and every 0 -> n keystroke).
    expect(declsFor(plain, ".rsel-menu.mention-menu").get("animation")).toBe("none");
    expect(declsFor(plain, ".rsel-menu").get("animation")).toBe("menu-in .16s var(--ease-out)");
    // Two classes against the reduced-motion block's one, so it wins there too.
    expect(declsFor(reduced, ".rsel-menu").get("animation")).toBe("fade-in .12s ease");
    expect(declsFor(reduced, ".rsel-menu.mention-menu").has("animation")).toBe(false);
    // Nothing grows any more, so no origin to grow from.
    expect(declsFor(plain, ".mention-menu").has("transform-origin")).toBe(false);
    for (const file of ["./features/task-detail/mention-menu.tsx", "./features/task-detail/agent-select.tsx"]) {
      expect(source(file), file).toContain("rsel-menu mention-menu");
    }
  });

  it("(F64) the status line on screen at first paint stands still", () => {
    // CANARY: put `swap-in` back on the bare `.run-phase .step` (opening a
    // task mid-run made its current step rise as if it had just changed).
    // Ruling 451(a) holds the `[data-fresh]` line's rise and its answer.
    for (const selector of [".run-phase .ph", ".run-phase .step", ".ctl-working-step"]) {
      expect(declsFor(plain, selector).has("animation"), selector).toBe(false);
      expect(declsFor(reduced, selector).has("animation"), selector).toBe(false);
    }
    // Both lines take the mark from the one latch.
    for (const file of ["./features/runtime/runs-panels.tsx", "./features/controller/turn-step.tsx"]) {
      expect(source(file), file).toMatch(/useFreshLine\(/);
    }
  });
});

describe("app.css ruling 459: the better-ui pass — icons", () => {
  // better-ui icons.md: a glyph carries its label's weight; one icon library
  // per surface, so no typed letter, font arrow or CSS-border caret stands in
  // for a glyph; one SVG recoloured per state, never by an unrelated rule; and
  // one glyph per meaning.
  const isReduced = (r: CssRule) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a));
  const reduced = RULES.filter(isReduced);
  const wide = RULES.filter((r) => r.at.some((a) => /min-width:\s*900px/.test(a)));
  /** A base rule's index and the index of the reduced-motion rule that
   *  answers it; at equal specificity the answer must come later. */
  const order = (selector: string) => ({
    base: RULES.findIndex((r) => r.at.length === 0 && selectorParts(r).includes(selector)),
    answer: RULES.findLastIndex((r) => isReduced(r) && selectorParts(r).includes(selector)),
  });
  const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  /** Every `<Icon … />` in the markup, with its name and className expressions. */
  /** A `<GlyphSwap rest="a" alt="b" … spinAlt />` (ruling 459) draws both of
   *  its glyphs where it is written, the alternate spinning under `spinAlt`,
   *  so it counts as those two Icons there; the component's own two
   *  prop-named Icons are counted at every call site instead. */
  const GLYPH_SWAP_SOURCE = path.join("ui", "copy-glyph.tsx");
  const icons = () =>
    markupFiles().flatMap((file) => {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(APP_DIR, file);
      const drawn = rel === GLYPH_SWAP_SOURCE ? [] : [...src.matchAll(/<Icon\b([\s\S]*?)\/>/g)].map((m) => {
        const name = /name=(?:"(\w+)"|\{([^}]*)\})/.exec(m[1]!);
        const cls = /className=(?:"([^"]*)"|\{([^}]*)\})/.exec(m[1]!);
        return {
          rel,
          at: `${rel}:${lineAt(src, m.index)}`,
          literal: name?.[1],
          name: (name?.[1] ?? name?.[2] ?? "").trim(),
          cls: (cls?.[1] ?? cls?.[2] ?? "").trim(),
        };
      });
      const swapped = [...src.matchAll(/<GlyphSwap\b([\s\S]*?)\/>/g)].flatMap((m) => {
        const at = `${rel}:${lineAt(src, m.index)}`;
        const rest = /\brest="(\w+)"/.exec(m[1]!)![1]!;
        const alt = /\balt="(\w+)"/.exec(m[1]!)![1]!;
        const spin = /\bspinAlt\b/.test(m[1]!) ? "spin" : "";
        return [
          { rel, at, literal: rest, name: rest, cls: "" },
          { rel, at, literal: alt, name: alt, cls: spin },
        ];
      });
      return [...drawn, ...swapped];
    });

  it("(F35) a glyph's stroke follows its label's weight: 2 beside 500–600, 2.5 beside 700–800", () => {
    // CANARY: drop `.btn .ico` from the heavier group (every button glyph
    // falls back to the set's 1.7, about 1px beside Inter Bold), or add
    // `.kv-row .v .ico` to it (a 2.5 glyph beside 400 mono text).
    const LABEL = {
      ".nav-item .ico": ".nav-item",
      ".seg .ico": ".seg button",
      ".fchip .ico": ".fchip",
      ".chip .ico": ".chip",
      ".card-head .trace .ico": ".card-head .trace",
      ".pick-chip.mono > .ico": ".pick-chip.mono",
      ".menu-item .ico": ".menu-item",
      ".toast .ico": ".toast",
      ".deny-note .ico": ".deny-note",
      ".pill.quiet .ico": ".pill.quiet",
      ".sched-when .ico": ".sched-when",
      ".stage-menu-btn .sm-caret": ".stage-menu-btn",
      ".rq-row .wait-tag.human .ico": ".rq-row .wait-tag.human",
      ".gh-freshness .ico": ".gh-freshness",
      ".ctl-msg-who .ico": ".ctl-msg-who",
      ".prop-empty .ico": ".prop-empty",
      ".wait-chip .ico": ".label-chip",
      ".btn .ico": ".btn",
      ".pill .ico": ".pill",
      ".wait-tag .ico": ".wait-tag",
      ".op-rec-kind .ico": ".op-rec-kind",
      ".model-sub .ico": ".model-sub",
      ".cmdk-row .ico": ".cmdk-label",
      ".rev-add .ico": ".rev-add",
      ".own-btn .ico": ".own-btn",
      ".rsel-btn .caret": ".rsel-btn",
      ".pick-chip:not(.mono) > .ico": ".pick-chip",
      ".go-hint .ico": ".go-hint",
      ".ag-newbtn .ico": ".ag-newbtn",
      ".trans-lock .ico": ".trans-lock",
      ".trans-path .ico": ".trans-path",
      ".guard-name .ico": ".guard-name",
      ".cred-top .ico": ".cred-name",
      ".org-tile .lbl .ico": ".org-tile .lbl",
      ".cap-col-head .ico": ".cap-col-head",
      ".md-collapse-toggle .ico": ".md-collapse-toggle",
      ".rq-go .ico": ".rq-go",
      ".session-id-export .ico": ".session-id-export",
      ".panel-head > .ico": "h2",
      ".sec-h > .ico": "h2",
      ".flabel .lbl-lock": ".flabel",
      ".ctx-lbl .lbl-lock": ".ctx-lbl",
    } satisfies Record<string, string>;
    const weight = (label: string) => {
      const w = declsFor(plain, label).get("font-weight");
      expect(w, `${label} states its weight`).toMatch(/^[1-9]00$/);
      return Number(w);
    };
    const wrong: string[] = [];
    for (const [glyph, label] of Object.entries(LABEL)) {
      const w = weight(label);
      const want = w >= 700 ? "2.5" : w >= 500 ? "2" : undefined;
      const got = declsFor(plain, glyph).get("stroke-width");
      if (got !== want) wrong.push(`${glyph} beside ${label} (${w}): ${got ?? "1.7"}, wants ${want ?? "1.7"}`);
    }
    expect(wrong).toEqual([]);
    // Every stroke width in the sheet is one of these, so a new one has to
    // name the label it sits beside here.
    const stroked = RULES.filter((r) => r.decls.has("stroke-width")).flatMap(selectorParts);
    expect(stroked.sort()).toEqual(Object.keys(LABEL).sort());
    // The rail glyph does not thicken as its item turns active.
    expect(weight(".nav-item.active")).toBeLessThan(700);
    // The .kv-row value glyph sits beside 400 mono text and keeps the set's 1.7.
    expect(weight(".kv-row .v .mono")).toBe(400);
    expect(source("./ui/icon.tsx")).toMatch(/strokeWidth="1\.7"/);
    // A bold control inside a medium one (the .btn in a decision card's
    // .deny-note) ties at equal specificity, so the heavier group comes later.
    const at = (selector: string) => RULES.findIndex((r) => r.decls.has("stroke-width") && selectorParts(r).includes(selector));
    expect(at(".btn .ico")).toBeGreaterThan(at(".deny-note .ico"));
  });

  it("(F37) every disclosure's caret is the set's chevron: one rule, turned only by its own <details>", () => {
    // CANARY: drop the chevron from "About this chain", or the reduced-motion
    // answer to `.ico.disc-chev`.
    // No pseudo-element draws a mitred V out of two borders any more.
    const borderCarets = RULES.filter(
      (r) =>
        /::(?:before|after)/.test(r.selector) &&
        /solid/.test(r.decls.get("border-right") ?? "") &&
        /solid/.test(r.decls.get("border-bottom") ?? ""),
    ).map((r) => r.selector);
    expect(borderCarets).toEqual([]);
    const chev = declsFor(plain, ".ico.disc-chev");
    expect(chev.get("width")).toBe("12px");
    expect(chev.get("height")).toBe("12px");
    // The chevron points right on the grid: down when folded, up when open.
    expect(chev.get("transform")).toBe("rotate(90deg)");
    expect(chev.get("transition")).toBe("transform .15s var(--ease-out)");
    expect(declsFor(plain, "details[open] > summary .disc-chev").get("transform")).toBe("rotate(-90deg)");
    expect(declsFor(reduced, ".ico.disc-chev").get("transition")).toBe("none");
    const { base, answer } = order(".ico.disc-chev");
    expect(answer).toBeGreaterThan(base);
    // The advisory's shield keeps its 13px and its colour; the caret takes the
    // summary's, so it follows the hover. (The goal chains' own caret colour
    // left with the Goals panel, ruling 503.)
    expect(declsFor(plain, ".cap-advisory > summary > .ico:not(.disc-chev)").get("width")).toBe("13px");
    // Every <summary> in the app carries the chevron, once.
    const summaries: string[] = [];
    const bare: string[] = [];
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)) {
        const where = `${path.relative(APP_DIR, file)}:${lineAt(src, m.index)}`;
        summaries.push(where);
        if ((m[1]!.match(/<Icon name="chevron" className="disc-chev" \/>/g) ?? []).length !== 1) bare.push(where);
      }
    }
    // Four, and since ruling 463 a GitHub connection's reach, and since ruling
    // 479(a) the capability matrix's "Advisory only" list, and since ruling 484
    // a changed file in the task's Changes panel, and since ruling 486 the
    // scopes an MCP server's OAuth sign-in was granted, and since ruling 498 a
    // knowledge-base correction's evidence. Ruling 503 took the goal chains'
    // three (a chain, a link's waits, "About this chain") and added an epic's
    // archived tasks.
    expect(summaries).toHaveLength(7);
    expect(bare).toEqual([]);
  });

  it("(F38) a busy state spins the set's loader; only a refresh control spins its own arrow", () => {
    // CANARY: put the attach button back on `busy ? "refresh" : "file"`, or
    // Rebuild back on the memory chip.
    const spinning = icons().filter((i) => /(?:^|[\s"])spin(?:[\s"]|$)/.test(i.cls));
    const loaders: string[] = [];
    const arrows: string[] = [];
    const wrong: string[] = [];
    for (const i of spinning) {
      if (i.literal === "loader") loaders.push(i.at);
      else if (i.literal === "refresh") arrows.push(i.rel);
      else {
        // A glyph that swaps to the loader on the same condition that spins it.
        const swap = /^(.+?)\s*\?\s*"loader"\s*:\s*"\w+"$/.exec(i.name);
        const spin = /^(.+?)\s*\?\s*"spin"\s*:\s*""$/.exec(i.cls);
        if (swap && spin && swap[1] === spin[1]) loaders.push(i.at);
        else wrong.push(`${i.at}: spins ${i.name}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(loaders.length).toBeGreaterThanOrEqual(8);
    // The control whose arrow IS the meaning and already its glyph at rest,
    // so busy swaps nothing: the board's re-scan. Home's re-scan, re-index and
    // test connection spun their own arrow too until ruling 368's 2026-09-24
    // extension put the loader in place of every in-flight starter's icon.
    expect(arrows.sort()).toEqual([path.join("features", "board", "board-page.tsx")]);
    expect(source("./ui/icon.tsx")).toMatch(/\n\s*loader: '/);
  });

  it("(F47) the wait row's rule reaches its own clock, never the Viberr chip's mark", () => {
    // CANARY: put the rule back on the bare `.log-line.wait .ico`.
    expect(RULES.some((r) => selectorParts(r).includes(".log-line.wait .ico"))).toBe(false);
    // The clock now sits in the orb's 20px cell (the contextual-icon block
    // below), still a direct child of what sizes it.
    const clock = declsFor(plain, ".lw-glyph > .ico");
    expect(clock.get("width")).toBe("14px");
    expect(clock.get("height")).toBe("14px");
    expect(clock.get("color")).toBe("#8a95b1");
    // The mark keeps its 9px and inherits the tile's dark ink.
    const mark = declsFor(plain, ".log-chip .lc-mark .ico");
    expect(mark.get("width")).toBe("9px");
    expect(mark.has("color")).toBe(false);
    expect(declsFor(plain, ".log-chip .lc-mark").get("color")).toBe("#1a1433");
    // No other console rule reaches a glyph through a bare descendant.
    const leaks = RULES.flatMap(selectorParts).filter((s) => /^\.(?:log-(?:line|wait)|lw-glyph)\b/.test(s) && /[^>] \.ico$/.test(s));
    expect(leaks).toEqual([]);
  });

  it("(F48) the Google mark is the set's glyph on every surface, not a typed letter", () => {
    // CANARY: put the typed "G" span back in the domain row.
    expect(source("./ui/icon.tsx")).toMatch(/\n\s*google: '<path d="[^"]+"\/>',/);
    const typed: string[] = [];
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/<span\b[^>]*>\s*G\s*<\/span>/g)) {
        typed.push(`${path.relative(APP_DIR, file)}:${lineAt(src, m.index)}`);
      }
    }
    expect(typed).toEqual([]);
    const marks = icons().filter((i) => /"google"/.test(i.name) || i.literal === "google").map((i) => i.rel);
    expect(marks.sort()).toEqual([
      path.join("features", "org-settings", "users-panel.tsx"),
      path.join("features", "org-settings", "users-panel.tsx"),
      path.join("features", "org-settings", "users-panel.tsx"),
      path.join("routes", "login.tsx"),
    ]);
    // The domain row's box names the colour and size the letter carried, as
    // the picker tile beside it does.
    expect(declsFor(plain, ".dom-ic").get("color")).toBe("var(--muted)");
    expect(declsFor(plain, ".dom-ic .ico").get("width")).toBe("14px");
    expect(declsFor(plain, ".be-ic").get("color")).toBe("var(--muted)");
  });

  it("(F52) the Agents page's running count carries the house's working dot", () => {
    // CANARY: put the pulse back on `.ag-running .working` itself. The pulse
    // is the house's compositor copy of the dot on ::after (ruling 457), so
    // the dot matches the house's box and its ::after the house's ring; ruling
    // 148(c)'s sweep holds the ring still under reduced motion.
    const house = declsFor(plain, ".wait-tag .working");
    const houseRing = declsFor(plain, ".wait-tag .working::after");
    for (const selector of [".ag-active .working", ".ag-running .working"]) {
      const dot = declsFor(plain, selector);
      for (const p of ["position", "width", "height", "border-radius", "background"]) {
        expect(dot.get(p), `${selector} ${p}`).toBe(house.get(p));
      }
      expect(dot.get("flex"), selector).toBe("none");
      expect(dot.has("animation"), selector).toBe(false);
      const ring = `${selector}::after`;
      for (const p of ["content", "position", "inset", "border-radius", "background", "animation"]) {
        expect(declsFor(plain, ring).get(p), `${ring} ${p}`).toBe(houseRing.get(p));
      }
    }
    const agents = source("./features/agents/agents-page.tsx");
    expect(agents).toMatch(/<span className="ag-active">\s*<span className="working" \/>/);
    expect(agents).toMatch(/<span className="ag-running">\s*<span className="working" \/>/);
  });

  it("(F68) no typed glyph stands in for an icon: generated content is empty, an attr() or a counter", () => {
    // CANARY: put `content: "→"` back on `.login-aside-points li::before`.
    const typed = RULES.filter(
      (r) => r.decls.has("content") && !/^(?:""|attr\([^)]*\)(?: \/ "")?|counter\([^)]*\))$/.test(r.decls.get("content")!),
    ).map((r) => `${r.selector}: ${r.decls.get("content")}`);
    expect(typed).toEqual([]);
    // Stacked under the card (ruling 455, acce-27) or beside it, the same
    // points: the rules sit outside the 900px query, which adds nothing.
    const li = declsFor(plain, ".login-aside-points li");
    expect(li.get("display")).toBe("flex");
    expect(li.get("align-items")).toBe("flex-start");
    // 16px glyph + .5rem = the 24px the text sat at under the old indent.
    expect(li.get("gap")).toBe(".5rem");
    expect(li.has("padding-left")).toBe(false);
    const glyph = declsFor(plain, ".login-aside-points .ico");
    expect(glyph.get("margin-top")).toBe(".125rem");
    expect(glyph.get("color")).toBe("var(--teal-dark)");
    for (const selector of [".login-aside-points li", ".login-aside-points .ico"]) {
      expect(declsFor(wide, selector).size, selector).toBe(0);
    }
    const points = /<ul className="login-aside-points">([\s\S]*?)<\/ul>/.exec(source("./routes/login.tsx"))![1]!;
    const items = [...points.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
    expect(items).toHaveLength(3);
    for (const item of items) expect(item).toMatch(/^<Icon name="arrow" \/>\s*\w/);
  });
});

describe("app.css ruling 459: the better-ui pass — contextual icon motion", () => {
  // better-ui icon-transitions.md: an icon that changes with state keeps both
  // glyphs in the DOM and cross-fades them with opacity, scale and blur. Every
  // swap here takes ruling 451(c)'s trim of the recipe for a 13-20px glyph:
  // scale .25, a 2px blur, .2s on the sheet's --ease-out.
  const isReduced = (r: CssRule) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a));
  const reduced = RULES.filter(isReduced);
  const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
  /** (ids, classes + attributes + pseudo-classes, elements) as one number;
   *  `:not()` counts its argument. Enough for the simple selectors here. */
  const specificity = (selector: string) => {
    const s = selector.replace(/:not\(([^()]*)\)/g, " $1");
    const ids = (s.match(/#[\w-]+/g) ?? []).length;
    const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
    const elements = (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
    return ids * 10000 + classes * 100 + elements;
  };

  /** Every icon swap in the sheet: the rule that carries its transition, the
   *  states that hide a glyph and the states that show one, and which
   *  property scales it. The copy-glyph cell scales on `scale` because its
   *  loader turns through `transform` (see F39). */
  const SWAPS = [
    {
      finding: "F39 GlyphSwap",
      base: ".copy-glyph > *",
      hidden: [".copy-glyph > :last-child", ".copy-glyph[data-copied] > :first-child"],
      shown: [".copy-glyph[data-copied] > :last-child"],
      prop: "scale",
    },
    {
      finding: "F40 grant chip",
      base: ".pick-chip .pc-check",
      hidden: [".pick-chip .pc-check"],
      shown: [".pick-chip.on .pc-check"],
      prop: "transform",
    },
    {
      finding: "F42 wait row",
      base: ".lw-glyph > *",
      hidden: [".lw-glyph[data-live] > .ico", ".lw-glyph:not([data-live]) > .log-orb"],
      shown: [],
      prop: "transform",
    },
    {
      finding: "F73 picker",
      base: ".be-opt .bcheck",
      hidden: [".be-opt .bcheck"],
      shown: [".be-opt.on .bcheck"],
      prop: "transform",
    },
  ] as const;
  const at = (prop: "scale" | "transform", size: ".25" | "1") =>
    prop === "scale" ? size : size === "1" ? "none" : "scale(.25)";

  it("every icon swap hides its glyph at scale .25 behind a 2px blur and trades over .2s on --ease-out", () => {
    // CANARY: put `.be-opt .bcheck` back on `transform: scale(.8)` with no
    // blur, or the copy-glyph cell back on `transform: scale(.25)`.
    for (const swap of SWAPS) {
      expect(declsFor(plain, swap.base).get("transition"), swap.finding).toBe(
        `opacity .2s var(--ease-out), ${swap.prop} .2s var(--ease-out), filter .2s var(--ease-out)`,
      );
      for (const selector of swap.hidden) {
        const d = declsFor(plain, selector);
        expect(d.get("opacity"), selector).toBe("0");
        expect(d.get(swap.prop), selector).toBe(at(swap.prop, ".25"));
        expect(d.get("filter"), selector).toBe("blur(2px)");
      }
      for (const selector of swap.shown) {
        const d = declsFor(plain, selector);
        expect(d.get("opacity"), selector).toBe("1");
        expect(d.get(swap.prop), selector).toBe(at(swap.prop, "1"));
        expect(d.get("filter"), selector).toBe("none");
      }
    }
    // Two-way: anything the sheet hides by shrinking is one of these, so a
    // new swap has to join the table, and so its recipe. A surface that is
    // leaving (`[data-closing]`: a dialog, the dock) is an exit, not a swap.
    const shrunk = plain
      .filter((r) => r.decls.get("opacity") === "0" && (r.decls.has("scale") || /scale\(/.test(r.decls.get("transform") ?? "")))
      .flatMap(selectorParts)
      .filter((s) => !s.includes("[data-closing]"))
      .sort();
    expect(shrunk).toEqual(SWAPS.flatMap((s) => s.hidden).sort());
  });

  it("every icon swap has a reduced-motion answer that only fades, after the rule it answers", () => {
    // CANARY: drop `.be-opt .bcheck` from the OS reduced-motion block, or
    // move the grant chip's answer above `.pick-chip .pc-check`.
    for (const swap of SWAPS) {
      for (const selector of [swap.base, ...swap.hidden, ...swap.shown]) {
        const d = declsFor(reduced, selector);
        expect(d.get("transition"), selector).toBe("opacity .12s ease");
        expect(d.get(swap.prop), selector).toBe(at(swap.prop, "1"));
        expect(d.get("filter"), selector).toBe("none");
        // Equal specificity, so the answer must come later in the sheet.
        const base = RULES.findLastIndex((r) => !isReduced(r) && selectorParts(r).includes(selector));
        const answer = RULES.findLastIndex((r) => isReduced(r) && selectorParts(r).includes(selector));
        expect(answer, selector).toBeGreaterThan(base);
      }
    }
  });

  it("(F39) a glyph that trades with its control's state goes through GlyphSwap, never a ternary on the icon name", () => {
    // CANARY: put the archive button back on
    // `<Icon name={archived ? "refresh" : "lock"} />`.
    const swaps: string[] = [];
    const ternaries: string[] = [];
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(APP_DIR, file).split(path.sep).join("/");
      for (const m of src.matchAll(/<GlyphSwap\b([\s\S]*?)\/>/g)) {
        const rest = /\brest="(\w+)"/.exec(m[1]!)?.[1];
        const alt = /\balt="(\w+)"/.exec(m[1]!)?.[1];
        swaps.push(
          `${rel}: ${rest} → ${alt}${/\bspinAlt\b/.test(m[1]!) ? " (spins)" : ""}${/\bbusy=/.test(m[1]!) ? " (busy)" : ""}`,
        );
      }
      // The loader only ever arrives through the cell (or alone, where the
      // control had no glyph at rest: Dismiss).
      for (const m of src.matchAll(/<Icon\b[^>]*?name=\{[^}]*\?[^}]*"loader"[^}]*\}/g)) {
        ternaries.push(`${rel}:${lineAt(src, m.index)}`);
      }
    }
    expect(ternaries).toEqual([]);
    expect(swaps.sort()).toEqual(
      [
        "features/home/home-sections.tsx: memory → loader (spins)",
        "features/home/new-project-modal.tsx: plus → loader (spins)",
        "features/kb-browser/store-browser.tsx: arrow → loader (spins)",
        "features/task-detail/attachments-panel.tsx: file → loader (spins)",
        "features/task-detail/execution-profile.tsx: bolt → clock (busy)",
        "features/task-detail/execution-profile.tsx: shield → clock (busy)",
        "features/task-detail/operator-recommendations.tsx: check → loader (spins)",
        "features/task-detail/task-side-panels.tsx: lock → refresh (busy)",
        "routes/login.tsx: github → loader (spins)",
        "routes/login.tsx: google → loader (spins)",
        "ui/copy-glyph.tsx: copy → check",
        // Ruling 368's 2026-09-24 extension: every in-flight starter's loader
        // takes its icon's place, and through the cell it trades rather than
        // replacing it in one frame. Home's re-scan, Interrupt, Retry, Force
        // accept, Deliver, Complete merge, Accept, Re-check scopes (GitHub
        // page and Settings), Update status, the credential's Remove, Connect
        // GitHub, Reset password, the KB re-scan and MCP test probes, Send to
        // a maintainer and a stale guardrail's Remove. A control whose resting
        // mark already trades with its state carries the loader one cell up
        // (`busy`): the run starts, Archive, and the credential's Attach/Rotate.
        "features/home/home-sections.tsx: refresh → loader (spins)",
        "features/runtime/runs-panels.tsx: hand → loader (spins)",
        "features/runtime/runs-panels.tsx: refresh → loader (spins)",
        "features/task-detail/task-side-panels.tsx: shield → loader (spins)",
        "features/task-detail/task-side-panels.tsx: branch → loader (spins)",
        "features/task-detail/task-side-panels.tsx: check → loader (spins)",
        "features/task-detail/task-side-panels.tsx: check → loader (spins)",
        "features/github/credential-card.tsx: lock → refresh (busy)",
        "features/github/credential-card.tsx: x → loader (spins)",
        "features/github/github-view.tsx: check → loader (spins)",
        "features/github/github-view.tsx: refresh → loader (spins)",
        "features/project-settings/settings-page.tsx: check → loader (spins)",
        "features/profile/profile-page.tsx: github → loader (spins)",
        "features/org-settings/users-panel.tsx: lock → loader (spins)",
        "features/org-settings/resource-rows.tsx: refresh → loader (spins)",
        "features/org-settings/resource-rows.tsx: refresh → loader (spins)",
        // Ruling 469: the MCP editor's Sign in and Sign out.
        "features/org-settings/resource-modals.tsx: user → loader (spins)",
        "features/org-settings/resource-modals.tsx: x → loader (spins)",
        "features/task-detail/decision-packet.tsx: message → loader (spins)",
        "features/policy/policy-page.tsx: x → loader (spins)",
        // Ruling 463: a GitHub connection's Re-check.
        "features/org-settings/connections-panel.tsx: refresh → loader (spins)",
        // Ruling 482: the PR card's Run gates, an in-flight starter like the
        // ones above.
        "features/task-detail/task-side-panels.tsx: refresh → loader (spins)",

        // Ruling 484: the Changes panel's toggle (while its reader loads), its
        // Try again, a file's Load this file, and Send to the deliverer.
        "features/task-detail/changes-slot.tsx: chevron → loader (spins)",
        "features/task-detail/changes-panel.tsx: refresh → loader (spins)",
        "features/task-detail/changes-panel.tsx: file → loader (spins)",
        "features/task-detail/changes-panel.tsx: send → loader (spins)",
        // Ruling 503: an epic task row's Remove.
        "features/epics/epic-page.tsx: x → loader (spins)",
      ].sort(),
    );
    // The cell centres both marks, whatever their box, in one grid area: drop
    // `grid-area: 1 / 1` and the check draws beside the copy mark (ruling
    // 451(c)). The "Copied" word rises in as a status line's new words do.
    const cell = declsFor(plain, ".copy-glyph");
    expect(cell.get("display")).toBe("inline-grid");
    expect(cell.get("place-items")).toBe("center");
    expect(declsFor(plain, ".copy-glyph > *").get("grid-area")).toBe("1 / 1");
    expect(declsFor(plain, ".copy-done").get("animation")).toMatch(/^swap-in\b/);
    // No copy-glyph rule moves a glyph on `transform`, where the loader's spin
    // animation would override it.
    const onTransform = RULES.filter((r) => selectorParts(r).some((p) => p.startsWith(".copy-glyph")) && r.decls.has("transform"));
    expect(onTransform.map((r) => r.selector)).toEqual([]);
  });

  it("(F39) a loader resting hidden holds still, outranking every rule that spins it", () => {
    // CANARY: drop the `animation-play-state: paused` rule, and a leaving
    // loader snaps back to 0deg (spinAlt only while on) or turns unseen.
    const pause = ".copy-glyph:not([data-copied]) > .spin";
    expect(declsFor(plain, pause).get("animation-play-state")).toBe("paused");
    const spinners = RULES.filter((r) => /^spin\b/.test(r.decls.get("animation") ?? "")).flatMap(selectorParts);
    expect(spinners).toContain(".ico.spin");
    for (const spinner of spinners) {
      expect(specificity(pause), spinner).toBeGreaterThan(specificity(spinner));
    }
    // The component spins the alternate for good; the sheet decides when.
    expect(source("./ui/copy-glyph.tsx")).toMatch(/<Icon name=\{alt\} className=\{spinAlt \? "spin" : ""\} \/>/);
  });

  it("(F40) a grant chip's check is always drawn, so a toggle never resizes the chip", () => {
    // CANARY: put back `{granted.has(o.id) && <Icon name="check" />}`.
    const mounted: string[] = [];
    const drawn: string[] = [];
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(APP_DIR, file).split(path.sep).join("/");
      for (const m of src.matchAll(/&&\s*<Icon name="check" \/>/g)) mounted.push(`${rel}:${lineAt(src, m.index)}`);
      drawn.push(...Array.from(src.matchAll(/<Icon name="check" className="pc-check" \/>/g), () => rel));
    }
    expect(mounted).toEqual([]);
    expect(drawn.sort()).toEqual([
      "features/agents/create-profile-modal.tsx",
      "features/org-settings/controller-admin-panel.tsx",
    ]);
    // The check leads, so every grant chip takes the glyph-led start side.
    expect(declsFor(plain, ".pick-chip:has(> .ico:first-child)").get("padding-left")).toBe(".5rem");
    expect(declsFor(plain, ".pick-chip .ico").get("width")).toBe("13px");
  });

  it("(F42) the wait row's orb and clock share one 20px cell, and the orb stops drawing once hidden", () => {
    // CANARY: set `.lw-glyph` to 14px, or drop the paused rule (a hidden orb
    // keeps its dots animating on every row seen live). Ruling 499: the orb is
    // AICSS's CSS lattice now, not a canvas, so its size and its pause are the
    // sheet's.
    const cell = declsFor(plain, ".lw-glyph");
    expect(cell.get("display")).toBe("inline-grid");
    expect(cell.get("place-items")).toBe("center");
    expect(cell.get("flex")).toBe("none");
    expect(cell.get("width")).toBe("20px");
    expect(cell.get("height")).toBe("20px");
    expect(declsFor(plain, ".lw-glyph > *").get("grid-area")).toBe("1 / 1");
    const row = source("./features/runtime/runs-panels.tsx");
    const markup = /<span className="lw-glyph"[^>]*>([\s\S]*?)<\/span>/.exec(row)![1]!;
    // The orb is exactly the cell, so neither state moves the chip.
    const orb = declsFor(plain, ".log-orb");
    expect(orb.get("width")).toBe(cell.get("width"));
    expect(orb.get("height")).toBe(cell.get("height"));
    expect(declsFor(plain, ".lw-glyph:not([data-live]) > .log-orb > i").get("animation-play-state")).toBe("paused");
    expect(markup).toMatch(/<ConsoleOrb motion=/);
    expect(markup).toMatch(/<Icon name="clock" \/>/);
  });
});

/* ------------------------------------- ruling 459: the dock's deferred half */

/**
 * Ruling 459 deferred two dock findings until they could be built on ruling
 * 454's sheet (owner, 2026-09-24: "do the two dock fixes now").
 *
 *   F20 — the dock's open and close could not be turned around. The entrance
 *     was a keyframe, which restarts instead of retargeting, and Chrome starts
 *     no transition on a property an animation drives; and a trigger click
 *     while the panel left was dropped. The entrance is now a transition from
 *     @starting-style, and `[data-closing]` is the same transition's far end.
 *   F24 — a dock the per-tab restore reopened replayed its entrance, and on a
 *     phone its trigger flew up to the perch, on every reload and every return
 *     from a page the dock is hidden on. `data-restored` shows it in place.
 *
 * What the panel and its trigger do is decided across four places (the 720px
 * block, the base dock section after it, the reduced-motion block and the
 * appended ruling-454 section), so these checks resolve the real cascade
 * (weight, then source order, then the `transition` shorthand against its
 * longhands) for each state, instead of reading one rule.
 */
describe("app.css ruling 459: the dock's deferred half", () => {
  type Ctx = { phone: boolean; reduced: boolean; starting?: boolean };
  const CONTEXTS: Ctx[] = [
    { phone: false, reduced: false },
    { phone: true, reduced: false },
    { phone: false, reduced: true },
    { phone: true, reduced: true },
  ];
  const name = (ctx: Ctx) => `${ctx.phone ? "phone" : "desktop"}${ctx.reduced ? ", reduced" : ""}`;
  /** Whether a rule's at-rules all hold in `ctx`; any other query is off. */
  const holds = (r: CssRule, ctx: Ctx) =>
    r.at.every((a) =>
      a === "@media (max-width: 720px)"
        ? ctx.phone
        : a === "@media (prefers-reduced-motion: reduce)"
          ? ctx.reduced
          : a === "@starting-style"
            ? ctx.starting === true
            : false,
    );
  const heavier = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  /** [ids, classes + attributes + pseudo-classes, types + pseudo-elements].
   *  `:not()`, `:is()` and `:has()` weigh their heaviest argument; `:where()`
   *  weighs nothing. */
  const weight = (selector: string): number[] => {
    const w = [0, 0, 0];
    let rest = "";
    for (let i = 0; i < selector.length; i++) {
      const fn = /^:(not|is|has|where)\(/.exec(selector.slice(i));
      if (!fn) {
        rest += selector[i];
        continue;
      }
      let depth = 0;
      let j = i + fn[0].length - 1;
      for (; j < selector.length; j++) {
        if (selector[j] === "(") depth++;
        else if (selector[j] === ")" && --depth === 0) break;
      }
      if (fn[1] !== "where") {
        const inner = splitArgs(selector.slice(i + fn[0].length, j)).map(weight).sort(heavier).at(-1)!;
        inner.forEach((n, k) => (w[k]! += n));
      }
      rest += " ";
      i = j;
    }
    const attributes = rest.match(/\[[^\]]*\]/g)?.length ?? 0;
    rest = rest.replace(/\[[^\]]*\]/g, "");
    w[0]! += rest.match(/#[-\w]+/g)?.length ?? 0;
    w[1]! += attributes + (rest.match(/\.[-\w]+/g)?.length ?? 0) + (rest.match(/(?<!:):[-\w]+/g)?.length ?? 0);
    w[2]! += (rest.match(/::[-\w]+/g)?.length ?? 0) + (rest.match(/(?:^|[\s>+~])[a-z][-\w]*/gi)?.length ?? 0);
    return w;
  };
  /** A layer's words, split on spaces outside parentheses. */
  const words = (layer: string) => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of layer) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) {
        if (cur) out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };
  const TIME = /^-?(\d*\.)?\d+m?s$/;
  const EASING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$|^(var|cubic-bezier|steps|linear)\(/;
  const LONGHANDS = ["transition-property", "transition-duration", "transition-timing-function"] as const;
  const isLonghand = (prop: string): prop is (typeof LONGHANDS)[number] => LONGHANDS.some((l) => l === prop);
  /** The `transition` shorthand's three longhands, as lists. */
  const longhands = (shorthand: string) => {
    const layers = splitArgs(shorthand).map(words);
    return {
      "transition-property": layers.map((l) => l.find((t) => !TIME.test(t) && !EASING.test(t)) ?? "all").join(", "),
      "transition-duration": layers.map((l) => l.find((t) => TIME.test(t)) ?? "0s").join(", "),
      "transition-timing-function": layers.map((l) => l.find((t) => EASING.test(t)) ?? "ease").join(", "),
    };
  };
  /** One rule's value for `prop`; a later declaration in the rule wins. */
  const valueOf = (decls: Map<string, string>, prop: string) => {
    let value: string | undefined;
    for (const [k, v] of decls) {
      if (k === prop) value = v;
      else if (k === "transition" && isLonghand(prop)) value = longhands(v)[prop];
    }
    return value;
  };
  /** What the cascade gives `prop` on an element exactly the `matching`
   *  selectors match: the heaviest wins, and a tie goes to the later rule. */
  const cascaded = (matching: string[], ctx: Ctx, prop: string) => {
    let won: { weight: number[]; value: string } | undefined;
    for (const r of RULES) {
      if (!holds(r, ctx)) continue;
      const hits = selectorParts(r).filter((s) => matching.includes(s));
      if (!hits.length) continue;
      const value = valueOf(r.decls, prop);
      if (value === undefined) continue;
      const w = hits.map(weight).sort(heavier).at(-1)!;
      if (!won || heavier(w, won.weight) >= 0) won = { weight: w, value };
    }
    return won?.value;
  };
  /** The transitions that run on a change, one `property duration easing`
   *  per property, the lists repeated as the longhands repeat them. */
  const transition = (matching: string[], ctx: Ctx) => {
    const props = splitArgs(cascaded(matching, ctx, "transition-property") ?? "all");
    if (props.join() === "none") return "none";
    const durations = splitArgs(cascaded(matching, ctx, "transition-duration") ?? "0s");
    const easings = splitArgs(cascaded(matching, ctx, "transition-timing-function") ?? "ease");
    return props.map((p, i) => `${p} ${durations[i % durations.length]} ${easings[i % easings.length]}`).join(", ");
  };
  const seconds = (value: string) => Number(/^(\d*\.?\d+)s$/.exec(value)![1]);
  /** The compound a selector styles, its `:not()`/`:has()` arguments dropped. */
  const subject = (selector: string) =>
    selector.replace(/:(not|has|is|where)\([^()]*\)/g, "").trim().split(/\s*[\s>+~]\s*/).pop()!;

  // The panel's states: the selectors that match it in each.
  const PANEL = [".dock-panel", ".dock .dock-panel"];
  const CLOSING = [...PANEL, ".dock-panel[data-closing]", ".dock .dock-panel[data-closing]"];
  const RESTORED = [...PANEL, ".dock[data-restored] .dock-panel:not([data-closing])"];
  const HELD = [...PANEL, ".dock[data-sheet-drag] .dock-panel:not([data-closing])"];
  const EASE_OUT = "var(--ease-out)";

  it("keeps every rule on the panel in the table this cascade is read against", () => {
    // Two-way: a new rule whose subject is the panel has to be read against
    // the states below before it joins.
    const onPanel = [...new Set(RULES.flatMap(selectorParts).filter((s) => subject(s).startsWith(".dock-panel")))].sort();
    expect(onPanel).toEqual([...new Set([...CLOSING, ...RESTORED, ...HELD])].sort());
  });

  it("(F20) the panel enters on a transition from @starting-style, at ruling 121(e)'s values", () => {
    // CANARY: put `animation: dock-in .18s var(--ease-out)` back on
    // `.dock-panel` in place of the transition, or drop either @starting-style.
    const desktop = { phone: false, reduced: false };
    const phone = { phone: true, reduced: false };
    expect(transition(PANEL, desktop)).toBe(`opacity .18s ${EASE_OUT}, transform .18s ${EASE_OUT}`);
    expect(cascaded(PANEL, { ...desktop, starting: true }, "opacity")).toBe("0");
    expect(cascaded(PANEL, { ...desktop, starting: true }, "transform")).toBe("translateY(8px) scale(.97)");
    // The sheet rises one sheet-height from the bottom edge and never fades.
    expect(transition(PANEL, phone)).toBe(`opacity .22s ${EASE_OUT}, transform .22s ${EASE_OUT}`);
    expect(cascaded(PANEL, { ...phone, starting: true }, "opacity")).toBe("1");
    expect(cascaded(PANEL, { ...phone, starting: true }, "transform")).toBe("translateY(100%)");
    // At rest the panel is where the entrance lands: nothing sets a pose.
    for (const ctx of CONTEXTS) {
      expect(cascaded(PANEL, ctx, "opacity"), name(ctx)).toBeUndefined();
      expect(cascaded(PANEL, ctx, "transform"), name(ctx)).toBeUndefined();
    }
  });

  it("(F20) the exit is that transition's far end, softer and shorter than the entrance at both widths", () => {
    // CANARY: put `.dock-panel[data-closing]` back on the old `.12s`
    // transition list, or drop the sheet's `transition-duration: .15s`.
    const desktop = { phone: false, reduced: false };
    const phone = { phone: true, reduced: false };
    expect(transition(CLOSING, desktop)).toBe(`opacity .12s ${EASE_OUT}, transform .12s ${EASE_OUT}`);
    expect(cascaded(CLOSING, desktop, "opacity")).toBe("0");
    expect(cascaded(CLOSING, desktop, "pointer-events")).toBe("none");
    const exit = /^translateY\((\d+)px\) scale\(([\d.]+)\)$/.exec(cascaded(CLOSING, desktop, "transform")!)!;
    const enter = /^translateY\((\d+)px\) scale\(([\d.]+)\)$/.exec(
      cascaded(PANEL, { ...desktop, starting: true }, "transform")!,
    )!;
    expect([Number(exit[1]), Number(exit[2])]).toEqual([6, 0.98]);
    expect(Number(exit[1])).toBeLessThan(Number(enter[1]));
    expect(Number(exit[2])).toBeGreaterThan(Number(enter[2]));
    expect(transition(CLOSING, phone)).toBe(`opacity .15s ${EASE_OUT}, transform .15s ${EASE_OUT}`);
    expect(cascaded(CLOSING, phone, "opacity")).toBe("1");
    expect(cascaded(CLOSING, phone, "transform")).toBe("translateY(100%)");
    for (const ctx of [desktop, phone]) {
      const [out, into] = [CLOSING, PANEL].map((state) =>
        seconds(splitArgs(cascaded(state, ctx, "transition-duration")!)[0]!),
      );
      expect(out, name(ctx)).toBeLessThan(into!);
    }
    // A closing rule names a duration and never the properties, so taking
    // the close back retargets the same two properties instead of snapping.
    const closing = RULES.filter((r) => selectorParts(r).some((s) => s.endsWith("[data-closing]") && subject(s).startsWith(".dock-panel")));
    expect(closing.length).toBeGreaterThanOrEqual(3);
    for (const r of closing) {
      expect(r.decls.has("transition"), r.selector).toBe(false);
      expect(r.decls.has("transition-property"), r.selector).toBe(false);
    }
  });

  it("(F20) nothing animates the panel at any width or preference", () => {
    // CANARY: restore `.dock .dock-panel { animation: fade-in .12s ease }` in
    // the reduced-motion block. A keyframe on the panel is what made the
    // close unable to start from mid-entrance and the reversal replay.
    const animated = RULES.filter((r) => selectorParts(r).some((s) => subject(s).startsWith(".dock-panel")))
      .filter((r) => r.decls.has("animation") || r.decls.has("animation-name"))
      .map((r) => r.selector);
    expect(animated).toEqual([]);
  });

  it("(F20) reduced motion fades the panel in and out over .12s at both widths, and nothing slides", () => {
    // CANARY: drop `transition-duration: .12s` from the reduced-motion
    // `.dock .dock-panel[data-closing]`: the 720px block's closing rule, one
    // attribute heavier than the reduced `.dock .dock-panel`, then hands the
    // sheet's .15s to the fade out.
    for (const ctx of CONTEXTS.filter((c) => c.reduced)) {
      expect(transition(PANEL, ctx), name(ctx)).toBe("opacity .12s ease");
      expect(cascaded(PANEL, { ...ctx, starting: true }, "opacity"), name(ctx)).toBe("0");
      expect(transition(CLOSING, ctx), name(ctx)).toBe("opacity .12s ease");
      expect(cascaded(CLOSING, ctx, "opacity"), name(ctx)).toBe("0");
      expect(cascaded(CLOSING, ctx, "transform"), name(ctx)).toBe("none");
    }
  });

  it("(F20) a sheet caught mid-entrance is held where the finger took it, under either preference", () => {
    // CANARY: drop `transition: none` from the ruling-454 drag rule: the
    // entrance transition then carries on under the finger.
    for (const ctx of CONTEXTS.filter((c) => c.phone)) {
      expect(transition(HELD, ctx), name(ctx)).toBe("none");
      expect(cascaded(HELD, ctx, "transform"), name(ctx)).toBe("translateY(var(--sheet-drag, 0px))");
    }
  });

  it("(F24) a restored panel appears in place everywhere, and its later close still animates", () => {
    // CANARY: drop `:not([data-closing])` from the restored rule, and the
    // restored dock's pointer close snaps shut instead of leaving.
    for (const ctx of CONTEXTS) {
      expect(transition(RESTORED, ctx), name(ctx)).toBe("none");
      const closingRestored = CLOSING.concat(
        RESTORED.filter((s) => !s.includes(":not([data-closing])")),
      );
      expect(transition(closingRestored, ctx), name(ctx)).toBe(transition(CLOSING, ctx));
      expect(transition(closingRestored, ctx), name(ctx)).not.toBe("none");
    }
    // Its weight, not its place in the sheet, is what beats the panel's own
    // rules at both widths and under the preference.
    const restored = weight(".dock[data-restored] .dock-panel:not([data-closing])");
    for (const s of [...PANEL, ".dock-panel[data-closing]"]) expect(heavier(restored, weight(s)), s).toBeGreaterThan(0);
  });

  it("(F24) a restored dock's trigger lands on its perch at sheet width; a press still eases and a close still carries it home", () => {
    // CANARY: move `.dock[data-restored] .dock-fab:not(:active)` below the
    // `:has()` return (the pointer close then snaps the trigger home), or drop
    // its `:not(:active)` (the press on the perched trigger snaps).
    const FAB = [".dock-fab", '.dock[data-open="true"] .dock-fab'];
    const RESTORED_FAB = [...FAB, ".dock[data-restored] .dock-fab:not(:active)"];
    const PRESSED = [...FAB, ".dock-fab:active", '.dock[data-open="true"] .dock-fab:active'];
    const HOME = ".dock:has(.dock-panel[data-closing]) .dock-fab";
    const RESTORED_RULE = ".dock[data-restored] .dock-fab:not(:active)";
    // Two-way, as the panel's table: every rule on the trigger is one of these.
    const onFab = [...new Set(RULES.flatMap(selectorParts).filter((s) => subject(s).startsWith(".dock-fab")))].sort();
    expect(onFab).toEqual(
      [...new Set([...RESTORED_FAB, ...PRESSED, HOME, ".dock-fab:hover", ".dock .dock-fab", ".dock[data-sheet-drag] .dock-fab"])].sort(),
    );
    // The restored rule steps aside while the trigger is pressed, so the
    // press eases on the perch rule's `:active` clock.
    expect(RESTORED_RULE).toMatch(/:not\(:active\)$/);
    const phone = { phone: true, reduced: false };
    const perch = cascaded(FAB, phone, "transform")!;
    expect(perch).toMatch(/^translate\(-8px, min\(0px, calc\(/);
    // The trigger the person opened flies up on the sheet's clock…
    expect(transition(FAB, phone)).toBe(`transform .22s ${EASE_OUT}`);
    // …and the restored one is simply there.
    expect(cascaded(RESTORED_FAB, phone, "transform")).toBe(perch);
    expect(transition(RESTORED_FAB, phone)).toBe("none");
    expect(transition(PRESSED, phone)).toBe(`transform .1s ${EASE_OUT}`);
    expect(transition([...RESTORED_FAB, HOME], phone)).toBe(`transform .15s ${EASE_OUT}`);
    expect(cascaded([...RESTORED_FAB, HOME], phone, "transform")).toBe("none");
    // Equal weight, so the return has to come later in the sheet.
    const at = (selector: string) => RULES.findIndex((r) => holds(r, phone) && selectorParts(r).includes(selector));
    expect(weight(RESTORED_RULE)).toEqual(weight(HOME));
    expect(at(HOME)).toBeGreaterThan(at(RESTORED_RULE));
    // Nothing moves the trigger above 720px, so the rule lives only in the
    // sheet's block; under reduced motion the trigger never slides at all.
    const restoredRules = RULES.filter((r) => selectorParts(r).includes(RESTORED_RULE));
    expect(restoredRules).toHaveLength(1);
    expect(restoredRules[0]!.at).toEqual(["@media (max-width: 720px)"]);
    const desktop = { phone: false, reduced: false };
    expect(transition(RESTORED_FAB, desktop)).toBe(transition(FAB, desktop));
    for (const state of [RESTORED_FAB, [...RESTORED_FAB, HOME]]) {
      expect(transition(state, { phone: true, reduced: true })).toBe("none");
    }
  });
});

/**
 * Ruling 500 (AICSS's AI Agent Input, Approval Card, Data Table and Code
 * Block on the task page): the task's composer takes the controller
 * composer's frame, the packet's tone is its head's tile, and a comment's
 * table and fenced block are one card each.
 */
describe("app.css ruling 500: the task page's agent components", () => {
  const decl = (selector: string, prop: string) => declsFor(plain, selector).get(prop);

  it("frames the task composer as the controller's: the card radius and the 4px ring", () => {
    // CANARY: put `.composer-box` back on `--radius-box` and the two inputs an
    // agent is addressed through are two shapes again.
    expect(decl(".composer-box", "border-radius")).toBe(decl(".ctl-composer", "border-radius"));
    expect(decl(".composer-box:focus-within", "box-shadow")).toBe(decl(".ctl-composer:focus-within", "box-shadow"));
  });

  it("carries the packet's tone on its tile, not a left accent, and fills the chosen key", () => {
    expect(decl(".packet", "border-left")).toBeUndefined();
    expect(decl(".packet-tile", "color")).toBe("var(--amber-dark)");
    expect(decl(".packet.blocked .packet-tile", "color")).toBe("var(--coral-dark)");
    expect(decl(".opt.sel .opt-key", "background")).toBe("var(--cta-bg)");
    expect(decl(".opt.sel .opt-key", "color")).toBe("var(--cta-fg)");
  });

  it("draws a comment's table and fenced block as one card each", () => {
    expect(decl(".md-table-wrap", "border-radius")).toBe("var(--radius-button)");
    // Hairlines between cells, not a box around each.
    expect(decl(".md-body td", "border")).toBeUndefined();
    expect(decl(".md-body td", "border-top")).toBe("1px solid var(--hairline)");
    expect(decl(".md-body th", "border-left")).toBe("1px solid var(--hairline)");
    expect(decl(".md-code", "overflow")).toBe("hidden");
    expect(decl(".md-body .md-code pre", "border")).toBe("0");
  });
});

describe("app.css ruling 501: the Details panel's properties", () => {
  const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const decl = (rules: CssRule[], selector: string, prop: string) => declsFor(rules, selector).get(prop);

  it("never sets a Details value in the bold a side panel gives a fact, and says an empty one quietly", () => {
    // CANARY: drop the `.kv.props` weight and "Normal / None / None / Nothing"
    // are the four loudest words in the panel again, the owner's screenshot.
    expect(decl(plain, ".kv-row .v", "font-weight")).toBe("700");
    expect(decl(plain, ".kv.props .kv-row .v", "font-weight")).toBe("400");
    expect(decl(plain, ".prop-empty", "color")).toBe("var(--placeholder)");
    expect(decl(plain, ".prop-empty", "font-weight")).toBe("500");
  });

  it("makes the value a ghost trigger: no chrome at rest, the hover fill, a blue edge while open", () => {
    expect(decl(plain, ".prop-btn", "background")).toBe("transparent");
    expect(decl(plain, ".prop-btn", "border")).toBe("1px solid transparent");
    expect(decl(plain, '.prop-btn:hover:where(:not([aria-busy="true"]))', "background")).toBe("var(--tint-hover)");
    expect(decl(plain, '.prop-btn[aria-expanded="true"]', "border-color")).toBe("var(--blue)");
    // Its padding and border run past the value column's left edge (ruling
    // 520), so the value it holds starts where the text values start.
    expect(decl(plain, ".prop-btn", "margin-left")).toBe("calc(-.375rem - 1px)");
    expect(decl(plain, ".prop-btn", "padding")).toBe(".25rem .375rem");
  });

  it("floats the editor as the app's menus float, and fades it under reduced motion", () => {
    // CANARY: take `.prop-pop` out of the reduced-motion list and it drops in
    // with the menu-in rise for a person who asked for none.
    expect(decl(plain, ".prop-pop", "box-shadow")).toBe("var(--shadow-ring), var(--shadow-menu)");
    expect(decl(plain, ".prop-pop", "border-radius")).toBe("var(--radius-box)");
    expect(decl(plain, ".prop-pop", "position")).toBe("absolute");
    expect(decl(plain, ".kv.props .kv-row", "position")).toBe("relative");
    expect(decl(reduced, ".prop-pop", "animation")).toBe("fade-in .12s ease");
  });

  it("rings a wait's entry by its state, and paints one that can never complete as a problem", () => {
    expect(decl(plain, '.wait-chip[data-wait-state="done"] .ico', "color")).toBe("var(--success-dark)");
    // Ruling 503 retired the `cancelled` state with the goal links it named.
    const dead = '.wait-chip:is([data-wait-state="failed"], [data-wait-state="missing"])';
    expect(RULES.some((r) => r.selector.includes(dead) && r.decls.get("color") === "var(--danger)")).toBe(true);
  });
});

describe("app.css ruling 510: a task's attachment list folds like a long comment", () => {
  const decl = (selector: string, prop: string) => declsFor(plain, selector).get(prop);

  it("clips and fades any fold's box, and fades it where the keyboard check says plain sight ends", () => {
    // CANARY: put `.md-body` back in the clamped selector and the attachment
    // list clamps with no clip and no fade, its rows painted over the toggle.
    expect(decl(".md-collapse > .clamped", "overflow")).toBe("hidden");
    const fade = `linear-gradient(to bottom, #000 ${Math.round(CLEAR_PART * 100)}%, transparent)`;
    expect(decl(".md-collapse > .clamped", "mask-image")).toBe(fade);
    expect(decl(".md-collapse > .clamped", "-webkit-mask-image")).toBe(fade);
  });

  it("leaves the folded list room for a row's focus ring, and moves no row to make it", () => {
    // CANARY: drop the list's padding and a clamped list cuts the sides off the
    // ring of every row, which runs the panel's full width.
    expect(decl(".attach-list", "padding")).toBe("4px");
    expect(decl(".attach-list", "margin")).toBe("-4px");
    // Spaced by the list's gap, so no row's margin collapses through the box
    // one moment and stays inside it the next, when the fold clamps.
    expect(decl(".attach-list", "display")).toBe("flex");
    expect(decl(".attach-list", "gap")).toBe(".5rem");
    expect(decl(".attach-file", "margin-top")).toBeUndefined();
  });
});

describe("app.css ruling 522: a timeline entry's pictures fold to their first row", () => {
  const decl = (selector: string, prop: string) => requiredDecls(plain, selector).get(prop);

  it("gives every tile of the strip one width, which the first row's count reads off the first tile", () => {
    // CANARY: give `.tl-attach-file` a width of its own and a strip that
    // starts with a picture counts the wrong number of tiles on its first line,
    // folding one too many or leaving a lone tile on a second row.
    expect(decl(".tl-attach-file", "width")).toBe(decl(".tl-attach-thumb", "width"));
    expect(decl(".tl-attach-file", "max-width")).toBe(decl(".tl-attach-thumb", "max-width"));
    // Laid out as a wrapping row, whose first line the count models.
    expect(decl(".tl-attach", "flex-wrap")).toBe("wrap");
  });
});

describe("app.css ruling 515: an account's name never runs under its buttons", () => {
  const decl = (selector: string, prop: string) => declsFor(plain, selector).get(prop);

  it("stacks an account row, its name and facts over its buttons, and keeps the name on one line", () => {
    // CANARY: drop the block display and the row is the connections list's
    // flex row again: at the card's 473px its three buttons leave the name
    // 171px, and "realvega1534@gmail.com" (182px) runs under Use this account.
    expect(decl(".acct-list .conn-row", "display")).toBe("block");
    // One line, cut with an ellipsis only where the row is narrower than it.
    expect(decl(".acct-list .conn-main b", "display")).toBe("block");
    expect(decl(".acct-list .conn-main b", "white-space")).toBe("nowrap");
    expect(decl(".acct-list .conn-main b", "overflow")).toBe("hidden");
    expect(decl(".acct-list .conn-main b", "text-overflow")).toBe("ellipsis");
  });
});

describe("app.css ruling 520: Current state on the property grid", () => {
  const decl = (selector: string, prop: string) => declsFor(plain, selector).get(prop);

  it("sets the side column's facts on one grid: one label column, one value edge, no rule between rows", () => {
    // CANARY: give `.kv.props .kv-row .v` back `justify-content: flex-end` and
    // the values right-align again, no two starting at the same x (the
    // owner's screenshot of Current state).
    const grid = requiredDecls(plain, ".kv.props .kv-row");
    expect(grid.get("display")).toBe("grid");
    expect(grid.get("grid-template-columns")).toBe("5.5rem minmax(0, 1fr)");
    expect(grid.get("border-bottom")).toBe("0");
    expect(decl(".kv.props .kv-row .v", "justify-content")).toBe("flex-start");
    // A held entry's key stays whole in the narrower value column.
    expect(decl(".prop-fact .hold-ref", "white-space")).toBe("nowrap");
    // A value's lines start as far down the row as a one-line value's does,
    // so a wrapped one keeps its first line on its label's. CANARY: drop the
    // padding and a wrapped hold's first line rides 6px over its label.
    const rem = (value: string | undefined) => Number(/^(-?[\d.]+)rem$/.exec(value ?? "")?.[1]);
    const v = requiredDecls(plain, ".kv.props .kv-row .v");
    const labelBox = rem(decl(".kv.props .kv-row .k", "min-height"));
    expect(rem(v.get("padding-block"))).toBe((labelBox - rem(v.get("line-height"))) / 2);
    // A ghost trigger's padding and border hang outside those lines.
    expect(decl(".prop-btn", "margin-block")).toBe("calc(-.25rem - 1px)");
    expect(decl(".kv.props .stage-menu-btn", "margin-block")).toBe(decl(".prop-btn", "margin-block"));
    // The PR card's facts close the card above Current state: the same label
    // column, so their words start on the same value line.
    const facts = requiredDecls(plain, ".pr-facts .kv-row");
    expect(facts.get("grid-template-columns")).toBe(grid.get("grid-template-columns"));
    expect(facts.get("column-gap")).toBe(grid.get("column-gap"));
    expect(decl(".pr-facts .kv-row .v", "text-align")).toBeUndefined();
    // A ghost trigger's padding and border hang past the edge, so the words
    // it holds start on it: the stage, and "Assign me" (a `.prop-btn`).
    expect(decl(".kv.props .stage-menu-btn", "margin-left")).toBe(decl(".prop-btn", "margin-left"));
  });

  it("draws the stage trigger as a ghost, as every other value is: no chrome at rest, the hover fill, a blue edge while open", () => {
    // CANARY: drop the rest rule and Stage is a bordered pill again, the one
    // boxed value in the panel.
    expect(decl(".kv.props .stage-menu-btn", "border-color")).toBe("transparent");
    expect(decl(".kv.props .stage-menu-btn", "background")).toBe("transparent");
    expect(decl(".kv.props .stage-menu-btn:hover:where(:not(:disabled))", "background")).toBe("var(--tint-hover)");
    expect(decl(".kv.props .stage-menu-btn.open", "border-color")).toBe("var(--blue)");
    // The caret points down at the menu, and up while it is open, as the PR
    // card's fold does.
    expect(decl(".kv.props .stage-menu-btn .sm-caret", "transform")).toBe(decl(".pr-fold .ico", "transform"));
    expect(decl(".kv.props .stage-menu-btn.open .sm-caret", "transform")).toBe(
      decl('.pr-fold[aria-expanded="true"] .ico', "transform"),
    );
  });

  it("puts a wait's tone on its mark, never on its words, and pulses Agent work with the house's dot", () => {
    // CANARY: put back `.by-agent { color: var(--agent-dark) }` and "Agent
    // work" is violet words at the one weight the row's other values drop.
    for (const who of [".by-human", ".by-agent"]) expect(decl(who, "color"), who).toBeUndefined();
    expect(decl(".prop-fact.by-human > .ico", "color")).toBe("var(--blue-pressed)");
    expect(decl(".prop-fact.by-agent > .ico", "color")).toBe("var(--agent-dark)");
    // The board card's pulse (ruling 365(b)), on its ::after (ruling 457).
    const house = declsFor(plain, ".wait-tag .working");
    const dot = declsFor(plain, ".prop-fact .working");
    for (const p of ["position", "width", "height", "border-radius", "background"]) {
      expect(dot.get(p), p).toBe(house.get(p));
    }
    expect(decl(".prop-fact .working::after", "animation")).toBe(decl(".wait-tag .working::after", "animation"));
  });
});

describe("app.css ruling 525: deleting a controller conversation from the rail", () => {
  it("draws a sealed row in the box a conversation row draws, with none of its hover or press", () => {
    // Somebody else's thread, listed to a project admin to delete, is a <div>,
    // so it cannot be a `.ctl-conv` (that presses, and ruling 459's F31 finds
    // a press on a div). CANARY: set `.ctl-conv-sealed`'s padding to `.5rem`
    // and it sits out of line with the rows above and below it.
    const row = requiredDecls(plain, ".ctl-conv");
    const sealed = requiredDecls(plain, ".ctl-conv-sealed");
    for (const p of ["display", "flex-direction", "gap", "padding", "border-radius", "border"]) {
      expect(sealed.get(p), p).toBe(row.get(p));
    }
    // It answers the pointer only at its delete.
    const pointer = RULES.flatMap((r) => selectorParts(r)).filter((s) => /\.ctl-conv-sealed:(hover|active)\b/.test(s));
    expect(pointer).toEqual([]);
    // Its words stop short of that delete, as a deletable link's do.
    expect(requiredDecls(plain, ".ctl-conv-row.deletable > .ctl-conv-sealed").get("padding-right")).toBe(
      requiredDecls(plain, ".ctl-conv-row.deletable > .ctl-conv").get("padding-right"),
    );
  });
});

/**
 * Ruling 572, after the shadcn chatbot template: the controller transcript
 * reads as one column (b), and its jump back to the newest message takes no
 * room in the box it scrolls (a).
 */
describe("app.css ruling 572: the controller transcript reads as one column", () => {
  it("(b) centres one 48rem column, keeps the person's bubble and frames no reply", () => {
    // CANARY: put the agent-tinted border and padding back on
    // `.ctl-msg.from-controller`, and a reply is a card inside the
    // transcript's card again.
    const column = requiredDecls(plain, ".ctl-msgs");
    expect(column.get("max-width")).toBe("48rem");
    expect(column.get("margin-inline")).toBe("auto");
    const reply = requiredDecls(plain, ".ctl-msg.from-controller");
    expect([reply.get("border"), reply.get("padding"), reply.get("max-width")]).toEqual(["0", "0", "none"]);
    // No width or preference puts a frame back on a reply.
    const framing = RULES.filter((r) => selectorParts(r).some((s) => s.includes(".from-controller")))
      .flatMap((r) => [...r.decls])
      .filter(([prop, value]) => /^(border(?!-radius)|background|box-shadow|padding)/.test(prop) && !/^(0|none)$/.test(value));
    expect(framing).toEqual([]);
    const user = requiredDecls(plain, ".ctl-msg.from-user");
    expect(user.get("align-self")).toBe("flex-end");
    expect(user.get("background")).toBe("var(--tint-well)");
  });

  it("(a) pins the jump to its box's foot in a row of no height, and it only fades under reduced motion", () => {
    // CANARY: drop `height: 0`, and the box's end moves by the button's height
    // each time the jump comes and goes.
    const slot = requiredDecls(plain, ".ctl-jump");
    expect([slot.get("position"), slot.get("height"), slot.get("align-items")]).toEqual(["sticky", "0", "flex-end"]);
    const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
    expect(requiredDecls(reduced, ".ctl-jump > .btn").get("animation")).toBe("fade-in .12s ease");
  });
});
