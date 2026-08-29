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
    // Pass 30 split the pin: .sched-note is a textarea, so its resting
    // boundary is EXACTLY the 3:1 --border-control token (a 3-way alternation
    // would let it silently fall back to the decorative 1.64:1 --border); the
    // row/form frames stay decorative.
    for (const [selector, borderRe] of [
      [".sched-row", /border(-top)?:\s*1px solid var\(--(hairline|border)\)/],
      [".sched-form", /border(-top)?:\s*1px solid var\(--(hairline|border)\)/],
      [".sched-note", /border:\s*1px solid var\(--border-control\)/],
    ] as const) {
      const rule = CODE.match(
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
      );
      expect(rule, `${selector} must have a rule`).toBeTruthy();
      expect(rule![1]).toMatch(borderRe);
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
    // Pass 30: functional control boundaries moved to --border-control (the
    // 3:1 non-text token); --border stays on decorative frames.
    expect(base![1]).toMatch(/border:\s*1px solid var\(--border-control\)/);
    expect(base![1]).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(base![1]).toMatch(/background:\s*var\(--surface\)/);
    expect(base![1]).toMatch(/color:\s*var\(--fg\)/);
  });

  it("gives it the same focus ring the app's text inputs use", () => {
    const focus = CODE.match(/(?:^|[};])\s*select:focus\s*\{([^}]*)\}/);
    expect(focus, "`select:focus` must exist").toBeTruthy();
    expect(focus![1]).toMatch(/border-color:\s*var\(--blue\)/);
    // Pass 30: the ring's wash is the named --focus-wash token.
    expect(focus![1]).toMatch(/box-shadow:\s*0 0 0 3px var\(--focus-wash\)/);
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

  it("holds 4.5:1 for --faint on the --blue-soft selection fill", () => {
    // Pass 30: a selected decision-packet option (`.opt.sel`) paints
    // --blue-soft under --faint text (`.opt .od`, `.opt .opt-kbd`). The R19-12
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
const BREAKPOINTS = {
  "max-width: 1400px": "board columns tighten before any layout reflows",
  "max-width: 1300px": "the invite row's three fields stack",
  "max-width: 1100px": "THE TWO-COLUMN COLLAPSE — every 2-up layout goes 1-up",
  "max-width: 1080px": "topbar tier 1 — brand wordmark, root crumb, shortcut chip",
  "max-width: 1000px": "settings tab rail goes horizontal",
  "max-width: 900px": "home topbar collapses to the palette; project-row stats drop",
  "min-width: 900px": "the login page earns its brand aside (the one min-width)",
  "max-width: 760px": "topbar tier 2 — the middle crumb",
  "max-width: 720px": "MOBILE SHELL — the project rail becomes an overlay",
  "max-width: 560px": "phone-width home rows — the pipeline meter yields",
} satisfies Record<string, string>;

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

  /**
   * U7 — the task detail's two columns are ordered in the MARKUP
   * (task-detail-page.tsx: `.detail-side` first, asserted there) and placed by
   * grid cell here, so the sighted stack and the screen-reader/focus order are
   * the same order at every width.
   *
   * Pass 20 did it with `order: -1` in the 1100px block instead, which fixed the
   * paint and left a keyboard user tabbing to "Accept completion → Done" LAST,
   * after every timeline entry (WCAG 2.2 SC 1.3.2 / 2.4.3). Re-adding `order`
   * to either column would silently reopen that split, so the sheet is pinned
   * against it: the desktop arrangement must come from placement, and the
   * stacked one from source order.
   */
  it("U7: the detail columns are placed by grid cell — never by `order`", () => {
    const rules = CODE.match(/\.detail-(main|side)[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length, "both columns must still be styled").toBeGreaterThan(1);
    for (const rule of rules) {
      expect(rule, `\`order\` is banned on the detail columns:\n${rule}`).not.toMatch(
        /(^|[\s;{])order\s*:/,
      );
    }
    // The desktop two-column arrangement, stated explicitly so source order
    // cannot decide which side of the page a column lands on.
    expect(CODE).toMatch(/\.detail-main\s*\{[^}]*grid-column:\s*1[^}]*grid-row:\s*1/);
    expect(CODE).toMatch(/\.detail-side\s*\{[^}]*grid-column:\s*2[^}]*grid-row:\s*1/);
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

type Balanced = { body: string; end: number };

/** The balanced `{…}` body starting at `open` (the index OF the brace). */
function balanced(src: string, open: number): Balanced {
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return { body: src.slice(open + 1, i), end: i };
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
  it("gives the list row's key the mono treatment the grid card's key has", () => {
    // Every `.key` rule is scoped to a container (`.card-top`, `.task-hero`,
    // `.live-task`, `.pj-name`) and the board's LIST row is in none of them, so
    // its key alone rendered in the body face — the same value looking like a
    // different kind of value depending on the view you picked. Surfaced when
    // F3 moved its width out of an inline style and there was nothing else.
    const grid = CODE.match(/\.card-top \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    const list = CODE.match(/\.card\.list-row \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    // F21-18: the third rule that draws a task key — the drop preview at the top
    // of a target column. Its color is deliberately its own (`--blue-pressed`,
    // the preview's accent), so it joins the nowrap assertion below rather than
    // the value-parity loop.
    const preview = CODE.match(/\.card-drop-preview \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(grid, ".card-top .key must have a rule").not.toBe("");
    expect(list, ".card.list-row .key must have a rule").not.toBe("");
    expect(preview, ".card-drop-preview .key must have a rule").not.toBe("");
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
    // still broke mid-token ("VIB-\n8") in the list row's fixed 64px column and
    // in the drop preview. A key is ONE identifier on every surface that draws
    // it — reverting any of the three rules fails here.
    for (const [where, rule] of [
      ["grid card", grid],
      ["list row", list],
      ["drop preview", preview],
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

  it("holds the line at 24 sites", () => {
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
    expect(sites.length).toBeLessThanOrEqual(24);
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

  it("keeps the declarations the three surfaces now depend on", () => {
    // Delete these and the counts/notes lose their type scale and spacing with
    // nothing in the markup to fall back on.
    const fine = utilities.find((u) => u.selector === ".fine")!.decls;
    // Pass 30 snapped the whole sheet onto the 13-step type scale; .fine's
    // step is .74rem (11.8px, a 0.3px move from the old .76).
    expect(fine.get("font-size")).toBe(".74rem");
    expect(fine.get("color")).toBe("var(--faint)");
    // .75rem since the pass-30 spacing snap (.85 was off-scale).
    expect(CODE).toMatch(/\.pol-note\.after\s*\{[^}]*margin-top:\s*\.75rem/);
    expect(CODE).toMatch(/\.pol-note\.last\s*\{[^}]*margin-bottom:\s*0/);
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
    for (const file of markupFiles()) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(path.dirname(APP_DIR), file);
      for (const m of src.matchAll(/pol-note/g)) {
        if (inBlockComment(src, m.index)) continue;
        const open = src.lastIndexOf("<", m.index);
        if (open < 0) continue;
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
    expect(styled.sort()).toEqual([]);
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

/* ================================================== R19-12 · the two gates */

/**
 * Both gates below exist because the two contracts they check were, until now,
 * verified by REVIEW rather than by a gate — and the enumerated tests that
 * looked like gates were hand-lists:
 *
 *   Contrast. `describe("app.css secondary text tokens meet WCAG AA")` above
 *     measures the seven pairs P13-D-12 happened to find. A NEW token, or an
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

type CssRule = { selector: string; decls: Map<string, string>; at: string[] };

/**
 * Every rule in the sheet: selector resolved through CSS nesting, declarations
 * separated from nested blocks, and the at-rule context it sits under.
 * `@keyframes` / `@font-face` bodies are not rules and are skipped.
 */
function cssRules(css: string, parent = "", at: string[] = []): CssRule[] {
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

const RULES = cssRules(CODE);

/* ----------------------------------------------------- colour resolution */

type Rgba = { rgb: [number, number, number]; alpha: number };

/** One `color-mix()` stop: the colour, and the percentage it states (or none). */
type MixStop = { colour: Rgba; weight: number | null };

/** Split a function's argument list on TOP-LEVEL commas. */
function splitArgs(text: string): string[] {
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
    const bg = rule.decls.get("background") ?? rule.decls.get("background-color");
    if (!bg) continue;
    for (const part of rule.selector.split(",")) {
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
}));

/** Rules whose `color` paints a GLYPH, not text. WCAG 1.4.11 asks 3:1 of a
 *  meaningful non-text element, not 1.4.3's 4.5:1 — checked, at the right bar. */
const GLYPH_NOT_TEXT = new Map(Object.entries({
  ".stage-menu-pop .sm-check": "a 14×14 check mark marking the current stage in the stage menu; the row's selected state is also carried by `aria-checked` on the menuitemradio.",
}));

/**
 * Pairs that are deliberately below AA and stay that way. Each says why in
 * WCAG's own terms; an entry nobody hits fails the rot guard below.
 */
const BELOW_AA_BY_DESIGN = {
  ".pj-star.on": "the pinned-project star. --pin-star is a decorative accent on a glyph whose IDENTITY and STATE are carried elsewhere: `StarIco` swaps outline for filled, and the button's accessible name flips between `Pin <project>` and `Unpin <project>`. 1.4.11 exempts a graphic that is not required to understand the content, which is exactly the case when shape and name already carry it.",
  ".log-more:disabled": "`load older lines` while a fetch is in flight. WCAG 1.4.3 exempts text in an INACTIVE user-interface component by name, and the button also swaps its label to `loading older lines…`, so the state is not carried by contrast.",
} satisfies Record<string, string>;

/**
 * Pairs that fail today and are NOT by design — the sweep's first catch, with
 * the themes each one fails in. This is a BASELINE, asserted as an exact SET:
 * adding a violation fails, and so does FIXING one without deleting its line
 * here, which is what keeps the list shrinking instead of becoming the
 * suppression file every such list becomes.
 *
 * Pass 30 (the refactoring-ui design pass) fixed every recorded pair and the
 * list is now EMPTY — the sweep enforces AA outright. For the record, the
 * fixes were: .goal-edit-btn and .rq-row:hover .rq-go --blue -> --blue-pressed;
 * .mx-scope --blue -> --blue-pressed on its wash; .rbac-no --ring ->
 * --placeholder; .login-aside-mark #fff -> var(--surface) (flips with the
 * theme); and the run-console dim ladder lifted in place (#4d566b -> #7c87a2,
 * #6b7590 -> #8a95b1, #5f6a85 -> #828da9) keeping the terminal look and the
 * ladder's brightness ordering.
 */
const UNFIXED_BELOW_AA: Record<string, { themes: readonly string[]; why: string }> =
  {};

/** `${theme} ${selector}` for every pair the baseline records. */
const UNFIXED_KEYS = Object.entries(UNFIXED_BELOW_AA).flatMap(([selector, entry]) =>
  entry.themes.map((theme) => `${theme} ${selector}`),
);

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
      for (const rawPart of rule.selector.split(",")) {
        const part = rawPart.trim();
        if (!part) continue;
        let target = part;
        if (part.startsWith(DARK_SCOPE)) {
          if (theme !== "dark") continue;
          target = part.slice(DARK_SCOPE.length);
        } else if (part.startsWith(":root")) continue;
        const acc = effective.get(target) ?? new Map<string, string>();
        for (const prop of ["color", "background", "background-color", "font-size", "font-weight"]) {
          const value = rule.decls.get(prop);
          if (value !== undefined) acc.set(prop, value);
        }
        if (acc.size) effective.set(target, acc);
      }
    }
    for (const [part, decls] of effective) {
      const colour = decls.get("color");
      if (!colour || /^(inherit|currentcolor|unset|initial)$/i.test(colour.trim())) continue;
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
    // The pairs the enumerated P13-D-12 tests above check by hand must be in
    // here too — that is the proof this SUPERSEDES them rather than sitting
    // next to them.
    for (const selector of [".fine", ".btn.primary", ".muted", ".hint"]) {
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
      .filter((p) => !(p.selector in BELOW_AA_BY_DESIGN) && !UNFIXED_KEYS.includes(p.key))
      .map(describePair)
      .sort();
    // Named with their ratios, not counted: the fix is a token swap and the
    // reader needs to know which pair and by how much.
    expect(unexplained).toEqual([]);
  });

  it("holds the not-yet-fixed pairs as an exact, shrinking list", () => {
    // Asserted as a SET, so fixing one of these fails until its line is
    // deleted. A `toBeLessThanOrEqual` ceiling would let a fix be swallowed by
    // a new violation, which is how a baseline becomes a suppression file.
    const found = [...new Set(below.filter((p) => UNFIXED_KEYS.includes(p.key)).map((p) => p.key))];
    expect(found.sort()).toEqual([...UNFIXED_KEYS].sort());
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
      ...Object.entries(UNFIXED_BELOW_AA).map(([k, v]) => [k, v.why] as const),
      ...[...RENDERED_INSIDE].map(([k, v]) => [k, v.why] as const),
    ];
    for (const [name, why] of entries) {
      expect(why.length, `${name} needs a real reason, not a label`).toBeGreaterThan(60);
    }
  });

  it("reads the console's own fill, not the page's, for its log ladder", () => {
    // The regression this guards: drop `RENDERED_INSIDE` and eleven literal-hex
    // log colours get measured against white, which reports nine failures on a
    // surface that is near-black in both themes — and hides whether the real
    // console contrast is any good. `.log-line .lx` is #c9d1e3 on #0e1117.
    const lx = pairs.filter((p) => p.selector === ".log-line .lx");
    expect(lx.length).toBe(2);
    for (const p of lx) {
      expect(p.bg, `${p.theme} console fill`).toMatch(/^#0[be]/);
      expect(p.ratio, describePair(p)).toBeGreaterThanOrEqual(4.5);
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
  ".pj-row .pj-stats .pill": "the 1100px tier drops the least load-bearing stat from a Home project ROW. `.pill` is a shared chip class that is a <button> elsewhere (the notification filter, the topbar's live-paused retry), and the ancestors here live in a different component from the pills, so the sweep widens to every `.pill` and picks those buttons up. The pills this rule reaches are project-cards.tsx spans inside `.pj-stats`, and the same numbers stay on the project's own page.",
} satisfies Record<string, string>;

/**
 * Width-scoped hiding that DOES cost the viewer a control. Recorded exactly,
 * for the same reason as the contrast baseline: a fix that leaves the entry
 * behind fails. EMPTY as of this pass — the one entry it held
 * (`.profile-list .ag-group-label`, whose row contained the `New specialist
 * profile` button) was fixed in `app.css` by deleting the 1100px
 * `display: none`, so the labels now ride along in the horizontal strip and
 * the button stays reachable at every width.
 */
const UNFIXED_HIDDEN: Record<string, string> = {};

/** Files allowed to read the viewport, and what they do with it. A read that
 *  changes WHAT IS RENDERED is the thing the contract bans; these move things
 *  that are already there. */
const VIEWPORT_READS = {
  "app/ui/stage-menu.tsx": "clamps the stage popover's left edge into the window with an 8px gutter after `getBoundingClientRect()`. It positions an element that is already open and already rendered — no branch of the tree depends on the number.",
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
    for (const raw of rule.selector.split(",")) {
      const selector = raw.trim();
      if (!selector) continue;
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
    // and an unbalanced phantom `<div>` corrupts every chain after it.
    const topbar = ELEMENTS.filter((el) => el.file.endsWith("shell/topbar.tsx"));
    const kbd = topbar.find((el) => el.classes.has("kbd"));
    expect(kbd, "topbar's ⌘K chip must be found").toBeTruthy();
    expect(
      kbd!.chain.map((f) => [...f.classes]).flat(),
      "and must be seen inside .topbar > .top-search",
    ).toEqual(expect.arrayContaining(["topbar", "top-search"]));
  });

  it("removes no interactive element under a width query", () => {
    const unexplained = costly
      .filter((h) => !(h.selector in HIDDEN_BY_DESIGN) && !(h.selector in UNFIXED_HIDDEN))
      .map(describeHide)
      .sort();
    // Named with the file and line of the control that disappears — "3
    // violations" would send the next reader back to resizing the window.
    expect(unexplained).toEqual([]);
  });

  it("holds the controls it still drops as an exact, shrinking list", () => {
    const found = [...new Set(costly.filter((h) => h.selector in UNFIXED_HIDDEN).map((h) => h.selector))];
    expect(found.sort()).toEqual(Object.keys(UNFIXED_HIDDEN).sort());
  });

  it("does not let `.topbar > .top-search .kbd` stand in for Home's palette button", () => {
    // The scoping P16-G3 fought for, checked from the markup rather than from
    // the selector text: the chip the 1080 tier hides is topbar.tsx's <span>,
    // and home-sections.tsx's <button className="kbd"> — the only other caller
    // of `onOpenPalette` — is NOT matched by it.
    const rule = HIDDEN.find((h) => h.selector === ".topbar > .top-search .kbd");
    expect(rule, "the scoped chip rule must be seen by the sweep").toBeTruthy();
    expect(rule!.resolved, "and must resolve against the markup").toBe(true);
    expect(rule!.self).toEqual([]);
    expect(rule!.inside).toEqual([]);
    const homeButton = ELEMENTS.find(
      (el) => el.file.endsWith("home/home-sections.tsx") && el.classes.has("kbd"),
    );
    expect(homeButton?.tag).toBe("button");
    expect(matchesSelector(homeButton!, ".topbar > .top-search .kbd")).toBe(false);
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
    const dead = [
      ...Object.keys(HIDDEN_BY_DESIGN),
      ...Object.keys(UNFIXED_HIDDEN),
    ]
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
      ...Object.entries(UNFIXED_HIDDEN),
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
    // gets broken in a place `app.css` cannot be read to find out. Both live
    // uses ask the OS for a colour-scheme preference.
    const queries: string[] = [];
    for (const file of sources) {
      const src = readFileSync(file, "utf8");
      const rel = path.relative(path.dirname(APP_DIR), file);
      for (const m of src.matchAll(/matchMedia\(\s*["'`]([^"'`]*)/g)) {
        queries.push(`${rel} — ${m[1]}`);
      }
    }
    // Three sites: the SSR-safe first-paint script inlined in root.tsx, the
    // listener that keeps `system` live, and `theme-preference.ts`.
    expect(queries.length, "the scan must find the three colour-scheme reads").toBe(3);
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

describe("app.css type scale (pass 30)", () => {
  // The whole sheet was snapped onto 13 hand-picked steps (documented at the
  // token block). This is the lock that keeps the next `.73rem` from creeping
  // back in: a new size is a deliberate widening of the scale, made here.
  const TYPE_SCALE = [
    ".62rem", ".68rem", ".74rem", ".8rem", ".86rem", ".92rem", ".98rem",
    "1.05rem", "1.18rem", "1.3rem", "1.5rem", "1.7rem", "1.9rem",
  ];

  it("every font-size is a scale step (or the sanctioned 0/inherit)", () => {
    const offScale = [...CODE.matchAll(/font-size:\s*([^;}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => !TYPE_SCALE.includes(v) && v !== "0" && v !== "inherit");
    expect([...new Set(offScale)].sort()).toEqual([]);
  });

  it("declares only weights the loaded fonts ship", () => {
    // root.tsx loads Noto Sans 400/500/600/700, Manrope 500/600/700/800,
    // JetBrains Mono 400/500/600. Declared weights above a family's ceiling
    // silently render one step down (and flash heavier in font fallback), so
    // the sheet declares only real ones; 800 is legal only where the display
    // face applies. 900/650 are gone for good.
    const weights = [...CODE.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = new Set(["400", "500", "600", "700", "800", "inherit"]);
    expect([...new Set(weights.filter((w) => !allowed.has(w)))]).toEqual([]);
  });

  it("scopes font-weight: 800 to rules that resolve the display face", () => {
    // 800 exists only in Manrope. A body/mono-face rule declaring 800 silently
    // clamps to 700/600 — the exact fiction the pass removed (and the
    // drop-preview's visible mid-drag typeface swap). Each 800 rule must
    // either declare the display family itself or select an h1-h4 element,
    // which the global heading rule puts on the display face.
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
