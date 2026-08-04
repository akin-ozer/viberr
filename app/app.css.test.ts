import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` strings. */
export function contrastRatio(a: string, b: string): number {
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

  it("keeps the tokens D-18's dropped declarations were remapped onto", () => {
    // Regression anchors: these are the real tokens the dead references
    // (--mono, --coral, --line, --panel, --font-sans, --ink, --teal, --link,
    // --accent, --panel-2, --surface-2) were mapped to.
    const declared = declaredTokens(CODE);
    for (const token of [
      "--font-mono",
      "--font-body",
      "--coral-light",
      "--coral-dark",
      "--hairline",
      "--border",
      "--surface",
      "--fg",
      "--teal-dark",
    ]) {
      expect(declared.has(token), `${token} must stay declared`).toBe(true);
    }
  });

  it("gives the Scheduled re-runs panel a real border and background", () => {
    // The panel that D-18 found rendering completely unstyled.
    // `.sched-controls select` used to be checked here too; P16-UI-05 folded it
    // into the one app-wide `select` rule, which the next test locks instead.
    for (const selector of [".sched-row", ".sched-form", ".sched-note"]) {
      const rule = CODE.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
      );
      expect(rule, `${selector} must have a rule`).toBeTruthy();
      expect(rule![1]).toMatch(/border(-top)?:\s*1px solid var\(--(hairline|border)\)/);
    }
  });
});

describe("app.css utility classes (P13-D-19)", () => {
  it("defines the `muted` and `hint` utilities the markup uses", () => {
    // `--muted` the variable existed; `.muted` the class did not, so
    // `<span className="right muted">` rendered at full weight.
    expect(CODE).toMatch(/(^|[},])\s*\.muted\s*\{/);
    // `.hint` existed only as `.pj-new .hint`, so the DG-2 "Acceptance is
    // blocked" line was an unstyled <p>.
    expect(CODE).toMatch(/(^|[},])\s*\.hint\s*\{/);
  });

  it("still defines the `.btn.primary` / `.btn.ghost` vocabulary", () => {
    expect(CODE).toMatch(/\.btn\.primary\s*\{/);
    expect(CODE).toMatch(/\.btn\.ghost\s*\{/);
  });

  it("never declares the hyphenated `btn-primary` / `btn-ghost` aliases", () => {
    // The stylesheet is the source of truth for the vocabulary: if these ever
    // appear, the TSX assertion in task-detail-components.test.tsx is moot.
    expect(CODE).not.toMatch(/\.btn-(primary|ghost|danger)\b/);
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

  it("is wrapped in :where() so component focus rules still win", () => {
    // `.field input:focus { outline: 0 }` and friends must keep their own
    // treatment without needing !important. :where() weighs 0, so the whole
    // selector is one pseudo-class.
    expect(CODE).toMatch(/:where\([^)]*(?:\([^)]*\)[^)]*)*\)\s*:focus-visible/);
  });

  it("dropped the four per-selector copies it replaced", () => {
    for (const dead of [
      ".card:focus-visible",
      ".cap-advisory > summary:focus-visible",
      ".pj-link:focus-visible",
      ".log-more:focus-visible",
    ]) {
      expect(CODE, `${dead} is redundant now`).not.toContain(dead);
    }
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

  it("gives the two borderless search fields a wrapper ring", () => {
    // `.top-search input` and `.board-filter-input input` set `outline: 0`
    // unconditionally — they are borderless fills inside a framed wrapper — so
    // the ring has to be drawn by the wrapper or the field has no focus
    // indicator at all. Home's project finder had none.
    expect(CODE).toMatch(/div\.top-search:focus-within/);
    expect(CODE).toMatch(/\.board-filter-input:focus-within/);
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
    // gave the wrong answer.
    const declarations = [...CODE.matchAll(/--font-display\s*:/g)];
    expect(declarations.length).toBe(1);
    expect(CODE).toMatch(/--font-display:\s*"Manrope"/);
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

  it("has no `.card.wait-human` no-op", () => {
    // `.card.wait-human { box-shadow: var(--shadow-card) }` re-stated the base
    // card's own shadow to neutralise a treatment ruling 16 had removed.
    expect(CODE).not.toContain("wait-human");
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
    // The [data-motion="reduce"] kill switch clamps every animation-duration to
    // .01ms !important, which on a progress-based timeline hides the fade for
    // good. It is an indicator, not decoration.
    expect(CODE).toMatch(
      /\[data-motion="reduce"\]\s*\.board-wrap::after\s*\{[^}]*animation-duration:\s*auto\s*!important/,
    );
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
    // The destructive treatment is opt-in, and every list puts its remove last.
    expect(CODE).toMatch(/\.rsrc-acts \.stg-x:last-child:not\(\.off\):hover/);
    expect(CODE).toMatch(/\.member-row \.stg-x:last-child:not\(\.off\):hover/);
    // The per-site colour patches are gone.
    expect(CODE).not.toMatch(/\.rsrc-row \.stg-x[^{]*:hover\s*\{/);
  });

  it("has no `.fm-acts` rules left", () => {
    // The KB browser's row actions are always drawn now (`.rsrc-acts`), so the
    // opacity-0 hover-reveal has no emitter — and hover-reveal was the touch
    // hazard that moved them in the first place.
    expect(CODE).not.toContain("fm-acts");
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

  it("does not reset a border on `.rail-scrim`, which is a div", () => {
    // Leftover from when the scrim was a <button>.
    const scrim = CODE.match(/\.rail-scrim\s*\{([^}]*)\}[\s\S]*?/);
    expect(scrim).toBeTruthy();
    const railOpen = CODE.match(/\.app\[data-rail-open="true"\] \.rail-scrim\s*\{([^}]*)\}/);
    expect(railOpen).toBeTruthy();
    expect(railOpen![1]).not.toMatch(/border:/);
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
    expect(base![1]).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(base![1]).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(base![1]).toMatch(/background:\s*var\(--surface\)/);
    expect(base![1]).toMatch(/color:\s*var\(--fg\)/);
  });

  it("gives it the same focus ring the app's text inputs use", () => {
    const focus = CODE.match(/(?:^|[};])\s*select:focus\s*\{([^}]*)\}/);
    expect(focus, "`select:focus` must exist").toBeTruthy();
    expect(focus![1]).toMatch(/border-color:\s*var\(--blue\)/);
    expect(focus![1]).toMatch(/box-shadow:\s*0 0 0 3px color-mix\(/);
  });

  it("leaves the remaining select rules as variants, not re-inventions", () => {
    // The variants may change size/typeface; re-declaring the box means the
    // consolidation has been undone.
    for (const selector of [".op-sel", ".fm-toolbar select"]) {
      const rule = CODE.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
      );
      if (!rule) continue;
      expect(rule[1], `${selector} must not re-declare the border`).not.toMatch(/border:/);
      expect(rule[1], `${selector} must not re-declare the background`).not.toMatch(
        /background:/,
      );
    }
  });
});

describe("app.css secondary text tokens meet WCAG AA (P13-D-12)", () => {
  const AA_SMALL_TEXT = 4.5;

  it("light theme: --faint and --placeholder clear 4.5:1 on --surface", () => {
    const surface = tokenIn(LIGHT_ROOT, "--surface");
    expect(surface).toBe("#ffffff");
    for (const token of ["--faint", "--placeholder"]) {
      const value = tokenIn(LIGHT_ROOT, token);
      expect(
        contrastRatio(value, surface),
        `light ${token} (${value}) on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

  it("dark theme: --faint and --placeholder clear 4.5:1 on --surface", () => {
    const surface = tokenIn(DARK_ROOT, "--surface");
    for (const token of ["--faint", "--placeholder"]) {
      const value = tokenIn(DARK_ROOT, token);
      expect(
        contrastRatio(value, surface),
        `dark ${token} (${value}) on ${surface}`,
      ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    }
  });

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

  it("holds 4.5:1 for both tokens over the 4% --fg surface tint labels sit on", () => {
    // `.live-head`, `.cap-matrix-table tr.grp td` and `.field input[disabled]`
    // put --placeholder / --faint text on `color-mix(--fg, transparent 96-97%)`,
    // which is measurably darker than --surface.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      const surface = tokenIn(block, "--surface");
      const fg = tokenIn(block, "--fg");
      const tint = mixHex(surface, fg, 0.04);
      for (const token of ["--faint", "--placeholder"]) {
        expect(
          contrastRatio(tokenIn(block, token), tint),
          `${theme} ${token} on a 4% --fg tint (${tint})`,
        ).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
      }
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

/**
 * Classes the markup names that deliberately carry no rule. Every entry states
 * why, because an unexplained entry is how this check rots back into the
 * hand-maintained list it replaced.
 */
// Empty on purpose. Do NOT grow this map to keep a red build green: an entry
// here is a class the markup ships and the sheet does not style, which is the
// exact defect this suite exists to catch. Its one occupant (`rsrc-wrap`) was
// deleted from resources-panel.tsx rather than excused.
const CLASSLESS_BY_DESIGN: Record<string, string> = {};

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
      .filter(([name]) => !defined.has(name) && !(name in CLASSLESS_BY_DESIGN))
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

  it("keeps the classless-by-design list short and justified", () => {
    // The escape hatch is the failure mode: if it grows, the gate is gone.
    expect(Object.keys(CLASSLESS_BY_DESIGN).length).toBeLessThanOrEqual(3);
    for (const [name, why] of Object.entries(CLASSLESS_BY_DESIGN)) {
      expect(why.length, `${name} needs a real reason`).toBeGreaterThan(20);
    }
  });

  it("still defines the nine orphans P16-UI-02 found", () => {
    // Regression anchors. These rendered unstyled on shipping surfaces: the
    // comment composer's positioning contract lived in a JSX inline style, the
    // mention listbox and the credential-card action row had no rule at all.
    for (const name of [
      "composer-input",
      "mention-menu",
      "cred-manage",
      "cursor",
      "faint",
      "ho-exc",
      "trans-list",
      "ntf-truncated",
    ]) {
      expect(defined.has(name), `.${name} must have a rule`).toBe(true);
    }
  });

  it("keeps the composer's positioning contract in the stylesheet (P16-UI-03)", () => {
    // `.composer-box .composer-placeholder` is position:absolute and MentionMenu
    // positions itself absolutely, so both need a positioned ancestor. It used
    // to be an inline `style={{position:"relative"}}` in timeline.tsx — delete
    // that attribute and both jump to the viewport.
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

  it("solves it without reintroducing a grip", () => {
    // A drag handle on the card was proposed and REJECTED (the board drags
    // whole-card, like the stage list). The cursor stays on the card, and no
    // rule may reappear that carves a grip out of the drag surface.
    expect(CODE).not.toMatch(/\.card-(grip|handle)\b/);
    expect(CODE).toMatch(/\.card-wrap\.draggable\s*\{[^}]*cursor:\s*grab/);
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
    expect(trigger![1]).toMatch(
      /background:\s*color-mix\(in srgb, var\(--surface\), var\(--fg\) \d+%\)/,
    );
  });

  it("labels the trigger instead of faking a placeholder", () => {
    // `--placeholder` is the colour of text a user is invited to overwrite.
    // "Search…" on the button is a LABEL — nothing is typed there.
    const label = CODE.match(/(?:^|[};])\s*\.top-search-label\s*\{([^}]*)\}/);
    expect(label![1]).toMatch(/color:\s*var\(--muted\)/);
    expect(CODE).toMatch(/\.top-search input::placeholder\s*\{[^}]*var\(--placeholder\)/);
  });

  it("the label clears 4.5:1 on the fill it now sits on", () => {
    // The trigger's face is a 5% --fg tint of --surface, so the label is no
    // longer measured against plain white/plain dark.
    for (const [theme, block] of [["light", LIGHT_ROOT], ["dark", DARK_ROOT]] as const) {
      const face = mixHex(tokenIn(block, "--surface"), tokenIn(block, "--fg"), 0.05);
      expect(
        contrastRatio(tokenIn(block, "--muted"), face),
        `${theme} --muted on the trigger face (${face})`,
      ).toBeGreaterThanOrEqual(4.5);
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
const BREAKPOINTS: Record<string, string> = {
  "max-width: 1400px": "board columns tighten before any layout reflows",
  "max-width: 1300px": "the invite row's three fields stack",
  "max-width: 1100px": "THE TWO-COLUMN COLLAPSE — every 2-up layout goes 1-up",
  "max-width: 1080px": "topbar tier 1 — brand wordmark, root crumb, shortcut chip",
  "max-width: 1000px": "settings tab rail goes horizontal",
  "max-width: 900px": "home topbar collapses to the palette; project-row stats drop",
  "min-width: 900px": "the login page earns its brand aside (the one min-width)",
  "max-width: 760px": "topbar tier 2 — the middle crumb",
  "max-width: 720px": "MOBILE SHELL — the project rail becomes an overlay",
};

describe("app.css breakpoints (P16-F8)", () => {
  /** Every `(max-width: Npx)` / `(min-width: Npx)` in the sheet, in order. */
  const widths = [...CODE.matchAll(/\((m(?:in|ax)-width:\s*\d+px)\)/g)].map((m) =>
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
      ".log-line",
      ".pj-row .pj-stats .pill",
    ]) {
      expect(block![1], `${selector} must still collapse at 1100px`).toContain(selector);
    }
    expect(block![1], "the dead `.board` duplicate must not come back").not.toMatch(
      /\.board\s*\{/,
    );
  });
});

describe("app.css palette reachability on touch (P16-G3)", () => {
  it("hides the shortcut chip in the workspace topbar only", () => {
    // The 1080 tier used to hide `.kbd` unscoped. On Home `button.kbd` IS the
    // palette trigger (the only caller of `onOpenPalette` besides the keyboard
    // hook), and `.kbd` is also the command palette's own "esc" hint — so a
    // 1000px-wide window lost both to a rule about breadcrumb room.
    // `.topbar >` matters: the palette renders inside the topbar, so a
    // descendant selector would still swallow its "esc" chip.
    expect(CODE).toMatch(/\.topbar > \.top-search \.kbd\s*\{\s*display:\s*none/);
    expect(CODE, "an unscoped `.kbd { display: none }` takes Home's palette with it")
      .not.toMatch(/(?:^|[};])\s*\.kbd\s*\{\s*display:\s*none/m);
  });

  it("collapses Home's box to a palette trigger instead of deleting it", () => {
    const narrow = CODE.match(/@media \(max-width: 900px\)\s*\{([\s\S]*?)\n\}/);
    expect(narrow, "the 900px block must exist").toBeTruthy();
    // The regression: `display: none` on the whole box left a phone with no
    // project finder AND no way into the palette at all.
    expect(narrow![1]).not.toMatch(/\.home-top \.top-search\s*\{[^}]*display:\s*none/);
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

/** Every `style={{ … }}` expression in `app/`, as `file:line` → object body. */
function inlineStyleSites(): { at: string; body: string }[] {
  const out: { at: string; body: string }[] = [];
  // Markup only: this file and the component tests quote `style={{` as prose.
  const markup = sourceFiles(APP_DIR).filter(
    (f) => f.endsWith(".tsx") && !f.includes(".test."),
  );
  for (const file of markup) {
    const src = readFileSync(file, "utf8");
    const rel = path.relative(path.dirname(APP_DIR), file);
    const re = /style\s*=\s*\{\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < src.length && depth > 0; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
      }
      out.push({
        at: `${rel}:${src.slice(0, m.index).split("\n").length}`,
        body: src.slice(m.index + m[0].length, i - 1),
      });
    }
  }
  return out;
}

/** A property value the stylesheet could have held: a bare literal. Anything
 *  else — an identifier, a template literal, a ternary, a concatenation — reads
 *  a runtime value the sheet cannot know. */
function isLiteral(value: string): boolean {
  return /^\s*(-?\d+(\.\d+)?|"[^"]*"|'[^']*')\s*$/.test(value);
}

describe("app.css draws a task key the same way everywhere (P16-F3 follow-on)", () => {
  it("gives the list row's key the mono treatment the grid card's key has", () => {
    // Every `.key` rule is scoped to a container (`.card-top`, `.task-hero`,
    // `.live-task`, `.pj-name`) and the board's LIST row is in none of them, so
    // its key alone rendered in the body face — the same value looking like a
    // different kind of value depending on the view you picked. Surfaced when
    // F3 moved its width out of an inline style and there was nothing else.
    const grid = CODE.match(/\.card-top \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    const list = CODE.match(/\.card\.list-row \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(grid, ".card-top .key must have a rule").not.toBe("");
    expect(list, ".card.list-row .key must have a rule").not.toBe("");
    for (const prop of ["font-family", "font-size", "color"]) {
      const value = (re: string) =>
        new RegExp(`${prop}\\s*:\\s*([^;]+)`).exec(re)?.[1]?.trim();
      expect(value(list), `${prop} must match the grid card's key`).toBe(
        value(grid),
      );
    }
  });
});

describe("app.css owns static styling, not the JSX (P16-F3)", () => {
  const sites = inlineStyleSites();

  it("scanned the tree, not an empty list", () => {
    expect(sites.length).toBeGreaterThan(10);
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

  it("holds the line at 20 sites", () => {
    // A ceiling, not a target. It exists because the previous pass moved the
    // `<select>` half of this finding and left the inline-style half, and
    // nothing noticed the count climbing back for three passes.
    expect(sites.length).toBeLessThanOrEqual(20);
  });
});

/** sRGB linear-channel-free approximation of `color-mix(in srgb, a, b p%)`,
 *  which the browser performs on the raw channel values. */
function mixHex(a: string, b: string, ratioB: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    "#" +
    [0, 1, 2]
      .map((i) =>
        Math.round(ch(a, i) * (1 - ratioB) + ch(b, i) * ratioB)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
