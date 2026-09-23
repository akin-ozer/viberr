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
    // D04-U5 (pass 32): the schedule FORM (`.sched-form`, `.sched-note`) is
    // gone from the markup, so its rules went with it — only the pending-row
    // frame remains to pin.
    for (const [selector, borderRe] of [
      [".sched-row", /border(-top)?:\s*1px solid var\(--(hairline|border)\)/],
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

  it("keeps the retired schedule-form and owner-role rules out (D04-U5)", () => {
    // The class-coverage gate below is one-directional (markup → rule), so a
    // rule whose emitter was deleted lingers unnoticed: `.sched-form`,
    // `.sched-controls`, `.sched-note(-inline)` and `.own-role` outlived the
    // schedule form and the owner-role tag by several passes. Pinned by name
    // rather than by a reverse gate, because the sheet legitimately styles
    // states no static markup names (`.on`, `.leaving`, runtime-composed
    // prefixes).
    expect(CODE).not.toMatch(/\.(sched-form|sched-controls|sched-note|sched-note-inline|own-role)\b/);
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
    // Ruling 148(c): the in-app `[data-motion="reduce"]` kill switch is gone
    // (with the setting that drove it), so the fade needs no restoring rule.
    // The OS `prefers-reduced-motion` query is the one reduced-motion signal.
    expect(CODE).not.toMatch(/\[data-motion/);
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

/* ---------------------------- ruling 166: headless yes, utility classes no --- */

/**
 * Ruling 166 lets an UNSTYLED primitive package (`@base-ui/react`, `radix-ui`)
 * into `app/` on the condition that every element it renders wears a class
 * `app.css` already defines. The orphan-class gate above already fails a
 * Tailwind class that reaches a `className` — but only once someone ships one,
 * and by then the diff is a whole pasted component and the tempting fix is to
 * widen `CLASSLESS_BY_DESIGN`.
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
    for (const file of sourceFiles(APP_DIR)) {
      const src = readFileSync(file, "utf8");
      const importsPrimitive = PRIMITIVES.some(
        (p) => src.includes(`from "${p}`) || src.includes(`from '${p}`),
      );
      if (!importsPrimitive) continue;
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
    expect(block![1], "the dead `.board` duplicate must not come back").not.toMatch(
      /\.board\s*\{/,
    );
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
  it("hides the shortcut chip on the palette TRIGGER only", () => {
    // The 1080 tier used to hide `.kbd` unscoped. On Home `button.kbd` IS the
    // palette trigger (the only caller of `onOpenPalette` besides the keyboard
    // hook), and `.kbd` is also the command palette's own "esc" hint — so a
    // 1000px-wide window lost both to a rule about breadcrumb room.
    //
    // Ruling 145: the scope is `button.top-search` rather than `.topbar >`.
    // The trigger is one shared component now (`palette-trigger.tsx`), rendered
    // by the workspace topbar AND by the standalone-page header, so a rule
    // written around one header would have missed the other. `button.` is the
    // real distinction: a chip inside a button-trigger is a HINT, Home's
    // `button.kbd` inside `div.top-search` is the control. It also keeps the
    // palette's own "esc" chip, which renders inside the topbar but not inside
    // the trigger.
    expect(CODE).toMatch(/button\.top-search \.kbd\s*\{\s*display:\s*none/);
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
  it("gives the list row's key the treatment the grid card's key has", () => {
    // Every `.key` rule is scoped to a container (`.card-top`, `.task-hero`,
    // `.live-task`, `.pj-name`) and the board's LIST row is in none of them, so
    // its key alone rendered in the body face — the same value looking like a
    // different kind of value depending on the view you picked. Surfaced when
    // F3 moved its width out of an inline style and there was nothing else.
    const grid = CODE.match(/\.card-head \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    const list = CODE.match(/\.card\.list-row \.key\s*\{([^}]*)\}/)?.[1] ?? "";
    // F21-18 named a third key rule, the drop preview's. Since 2026-09-08 the
    // preview renders the card's own face (`CardFace` in board-page.tsx), so its
    // key IS `.card-top .key` and a private rule would be the drift this test
    // exists to catch.
    expect(CODE).not.toMatch(/\.card-drop-preview \.key\s*\{/);
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

  it("keeps the declarations the three surfaces now depend on", () => {
    // Delete these and the counts/notes lose their type scale and spacing with
    // nothing in the markup to fall back on.
    const fine = utilities.find((u) => u.selector === ".fine")!.decls;
    // The 2026-09-08 recut merged the five near-identical small steps into two.
    // `.fine` is the app's secondary-text utility, so it sits on the secondary
    // step: .75rem (12px), within a pixel of the .74rem (11.8px) it always had.
    expect(fine.get("font-size")).toBe(".75rem");
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

  it("does not let `button.top-search .kbd` stand in for Home's palette button", () => {
    // The scoping P16-G3 fought for, checked from the markup rather than from
    // the selector text: the chip the 1080 tier hides is the trigger's <span>,
    // and home-sections.tsx's <button className="kbd"> — the only other caller
    // of `onOpenPalette` — is NOT matched by it.
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
    // Four sites: the SSR-safe first-paint script inlined in root.tsx, the
    // listener that keeps `system` live, `theme-preference.ts`, and the board's
    // drop animation asking for reduced motion before it flies a card
    // (board-page.tsx, 2026-09-08).
    expect(queries.length, "the scan must find the four preference reads").toBe(4);
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
    // root.tsx loads Inter 400/500/600/700/800 (ruling 365: the one UI face)
    // and JetBrains Mono 400/500/600. Declared weights above a family's ceiling
    // silently render one step down (and flash heavier in font fallback), so
    // the sheet declares only real ones; 800 is legal only where the display
    // face applies. 900/650 are gone for good.
    const weights = [...CODE.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const allowed = new Set(["400", "500", "600", "700", "800", "inherit"]);
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
  const decls = (selector: string): string => {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    );
    const m = CODE.match(re);
    expect(m, selector).not.toBeNull();
    return m![1];
  };

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

  it("lets the list layout scroll (it inherited the lane grid's hidden overflow)", () => {
    expect(decls(".board.list")).toMatch(/overflow-y:\s*auto/);
  });

  it("overlays the stage-move control in the card's bottom-right corner (ruling 365)", () => {
    // The control used to sit top-right and the head row reserved 36px for
    // it; it is a bare 20px chevron in the corner the property row leaves
    // free now, absolute, so no row reserves anything.
    expect(decls(".card-move")).toMatch(/position:\s*absolute/);
    expect(decls(".card-move")).toMatch(/bottom:\s*\.75rem/);
    expect(CODE).not.toMatch(/\.card-wrap:has\(\.card-move\)/);
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
    const block = CODE.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/)![1];
    const base = CODE.match(/\.field input\[type="text"\][^{]*\{/)![0];
    for (const type of base.match(/type="([a-z]+)"/g) ?? []) {
      expect(block, type).toContain(`.field input[${type}]`);
    }
    for (const type of ["text", "email", "password"]) {
      expect(block).toContain(`.field input[type="${type}"].mono`);
    }
    // Asserts the INTENT, not a literal step: iOS zooms the viewport when a
    // focused input is under 16px, so the mobile block has to lift it to at
    // least 1rem. Pinning the exact value made the 2026-09-08 scale recut fail
    // here for no reason — the size had moved from 16.8px to 18px, which is
    // more compliant, not less.
    const cmdk = block.match(/\.cmdk-input[^{]*\{\s*font-size:\s*([\d.]+)rem/);
    expect(cmdk, ".cmdk-input must be resized in the mobile block").toBeTruthy();
    expect(Number(cmdk![1]), "16px minimum, or iOS zooms on focus").toBeGreaterThanOrEqual(1);
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
    expect(CODE).not.toMatch(/\.app\[data-rail-open="true"\] \.dock\b/);
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

  it("(c) the OS preference stills every `pulse-a` 'agent working' dot", () => {
    // With the in-app kill switch gone, `prefers-reduced-motion` is the one
    // signal, and the stilling rule named three of the five dots on this loop.
    // `.chip .working` (the status-chip dot on EVERY board card with an agent
    // at work) and `.rdot.running` kept pulsing forever under the preference.
    // The loop's users are read from the sheet, so a sixth dot is in scope the
    // moment it is written; the two named ones keep the scan from going vacuous.
    // Spinners (`runSpin`, `spin`) are a different loop: they convey loading
    // and stay essential motion.
    //
    // Canary: drop either selector from the reduced-motion list and this goes red.
    const parts = (rule: CssRule) => rule.selector.split(",").map((s) => s.trim());
    const reduced = (rule: CssRule) =>
      rule.at.some((q) => /prefers-reduced-motion:\s*reduce/.test(q));
    const pulsing = RULES.flatMap((rule, index) =>
      !reduced(rule) && /^pulse-a\b[^;]*\binfinite\b/.test(rule.decls.get("animation") ?? "")
        ? parts(rule).map((selector) => ({ selector, index }))
        : [],
    );
    expect(pulsing.map((p) => p.selector)).toEqual(
      expect.arrayContaining([".chip .working", ".rdot.running"]),
    );
    for (const { selector, index } of pulsing) {
      // Same selector, same specificity: the stilling rule has to come later.
      const stilled = RULES.some(
        (rule, at) =>
          at > index &&
          reduced(rule) &&
          rule.decls.get("animation") === "none" &&
          parts(rule).includes(selector),
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
  const decls = (selector: string): string => {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    );
    const m = CODE.match(re);
    expect(m, selector).not.toBeNull();
    return m![1];
  };
  const mobile = CODE.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/)![1];

  it("the guardrail threshold field is boxed, and org settings' cap field IS that rule", () => {
    // It was the app's only text-like input outside `.field`: UA border, UA
    // fill, UA radius, no focus wash, beside an `Apply` wearing `.btn`.
    // Canary: cut the rule back to `width: 5.5rem` and this goes red.
    const box = decls('.guard-ctl input[type="number"]');
    expect(box).toMatch(/border:\s*1px solid var\(--border-control\)/);
    expect(box).toMatch(/border-radius:\s*var\(--radius-button\)/);
    expect(box).toMatch(/background:\s*var\(--surface\)/);
    expect(box).toMatch(/color:\s*var\(--fg\)/);
    expect(box).toMatch(/padding:\s*\.25rem \.5rem/);
    // Design pass 2026-09-08: the run-concurrency field used to carry a twin
    // copy of these declarations under `.conc-edit input`; it sits in a
    // `.guard-ctl` now and the copy is gone, so there is one box to drift.
    expect(CODE).not.toMatch(/\.conc-edit/);
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
  const decls = (selector: string): string => {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    );
    const m = CODE.match(re);
    expect(m, selector).not.toBeNull();
    return m![1];
  };

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
  it("the audit log's scope tag has one look; the blue `org` variant is gone", () => {
    expect(declsOf(".audit-scope-tag").get("background")).toBe("transparent");
    expect(RULES.some((r) => r.selector === ".audit-scope-tag.org")).toBe(false);
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
   themes, for every scope family the highlighter can colour. */
describe("app.css code reader palette meets WCAG AA (ruling 363)", () => {
  const AA_SMALL_TEXT = 4.5;
  const SYNTAX_FAMILIES = [
    "keyword",
    "string",
    "string-expression",
    "comment",
    "constant",
    "parameter",
    "function",
    "link",
  ];
  const THEMES = { light: LIGHT_ROOT, dark: DARK_ROOT };
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
  const PRESETS = [
    "slate", "gray", "stone", "red", "orange", "amber", "yellow", "lime", "green", "emerald",
    "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose",
  ];
  const THEMES = { light: LIGHT_ROOT, dark: DARK_ROOT };
  for (const [theme, root] of Object.entries(THEMES)) {
    it(`${theme} theme: every --stage-* token exists and clears 3:1 on --surface and --bg`, () => {
      for (const preset of PRESETS) {
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
    for (const preset of PRESETS) {
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
    const m = css.match(new RegExp(`(?:^|\\n|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    expect(m, `${selector} must have a rule`).toBeTruthy();
    return m![1]!;
  };
  const collapse = () => CODE.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/)![1]!;

  it("pins the rail beside the conversation and makes it its own scroller", () => {
    // CANARY: drop `position: sticky` or `overflow-y: auto` from `.ctl-side`.
    const side = ruleBody(CODE, ".ctl-side");
    expect(side).toMatch(/position:\s*sticky/);
    expect(side).toMatch(/align-self:\s*start/);
    expect(side).toMatch(/overflow-y:\s*auto/);
    // Capped at the scrollport: under the top bar, clear of the dock button.
    expect(side).toMatch(/max-height:\s*calc\(100dvh - var\(--topbar-h\) - var\(--dock-clear\)\)/);
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
    expect(collapse720![1]).toContain(
      "calc(-1 * (min(80dvh, 640px) - max(20px, env(safe-area-inset-bottom)) + 3px))",
    );
  });

  it("ruling 425(b): a wait list's entries line up in columns, and stack in the narrow rail", () => {
    // Measured in a production preview: at 1440 wide the rail gives the list
    // 258px, and a third column truncated every title after four words; at
    // 375 it showed "ax log…". CANARY: drop the container query.
    expect(ruleBody(CODE, ".ctl-link-waits")).toMatch(/container-type:\s*inline-size/);
    expect(ruleBody(CODE, ".ctl-link-waits li")).toMatch(/grid-template-columns:\s*subgrid/);
    const narrow = [...CODE.matchAll(/@container \(max-width: 30rem\)\s*\{([\s\S]*?)\n\}/g)].find((m) =>
      m[1]!.includes(".ctl-wait-title"),
    );
    expect(narrow, "the narrow-list container query must exist").toBeTruthy();
    expect(narrow![1]).toMatch(/\.ctl-wait-title\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*white-space:\s*normal/);
  });

  it("U39-11: a console tool chip wraps rather than pushing its detail past a phone's edge", () => {
    // Measured at 375px: `mcp__viberr_controller__write_knowledge_doc` is one
    // unbreakable run, and the console scrolled sideways (285px of 271).
    // CANARY: drop `flex-wrap: wrap` from `.log-chip`.
    expect(ruleBody(CODE, ".log-chip")).toMatch(/flex-wrap:\s*wrap/);
    expect(ruleBody(CODE, ".log-chip .lc-name")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("ruling 425(c): a link's title wraps beside its pill, which stays on the title's first line", () => {
    // Measured live at 1440: with a 12rem basis the title dropped under "held
    // AX-6" whole; centred alignment then floated the pill mid-block.
    // CANARY: restore `align-items: center`.
    expect(ruleBody(CODE, ".ctl-link-title")).toMatch(/flex:\s*1 1 8rem/);
    expect(ruleBody(CODE, ".ctl-links li")).toMatch(/align-items:\s*baseline/);
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

  it("ruling 419(e): a packet's code observation keeps its line breaks", () => {
    // CANARY: drop `white-space: pre-wrap` from `.obs code`.
    expect(ruleBody(CODE, ".obs code")).toMatch(/white-space:\s*pre-wrap/);
  });

  it("shows the thread switcher only in the one-column layout, and no key hint on touch", () => {
    expect(ruleBody(CODE, ".ctl-picker")).toMatch(/display:\s*none/);
    expect(ruleBody(collapse(), ".ctl-wrap .ctl-picker")).toMatch(/display:\s*block/);
    const coarse = CODE.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/);
    expect(coarse, "a coarse-pointer block must exist").toBeTruthy();
    expect(coarse![1]).toMatch(/\.kbd-hint\s*\{\s*display:\s*none;\s*\}/);
  });

  it("U39-27: on a touch screen the goal chains' controls are tall enough for a finger", () => {
    // Measured at 375px: 15-16px tall. CANARY: drop the padding rule.
    const coarse = CODE.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/)![1];
    for (const selector of [
      ".ctl-link-waits > summary",
      ".ctl-link-waits li > a.mono",
      ".ctl-links .ctl-link-task",
      ".ctl-goal-more .linkish",
      ".ctl-all-toggle .linkish",
    ]) {
      expect(coarse, selector).toContain(selector);
    }
    expect(coarse).toMatch(/\.ctl-all-toggle \.linkish\s*\{\s*padding-block:\s*\.3rem;\s*\}/);
  });
});

/**
 * Ruling 451 (owner, 2026-09-23): seven places move, drawn from transitions.dev.
 * jsdom runs no animation, so the rules the motion rests on are pinned here;
 * the components' own suites pin the keys and attributes that trigger it.
 */
describe("app.css ruling 451: motion from transitions.dev", () => {
  const plain = RULES.filter((r) => r.at.length === 0);
  const reduced = RULES.filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)));
  const parts = (r: CssRule) => r.selector.split(",").map((s) => s.trim());
  const rule = (rules: CssRule[], selector: string) => {
    const hit = rules.filter((r) => parts(r).includes(selector));
    expect(hit.length, `${selector} must have a rule`).toBeGreaterThan(0);
    // What the cascade leaves the selector: later declarations win.
    const decls = new Map<string, string>();
    for (const r of hit) for (const [k, v] of r.decls) decls.set(k, v);
    return decls;
  };
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
    expect(played.length).toBeGreaterThan(40);
    expect(played.filter((p) => !declared.has(p.split(" → ")[1]!))).toEqual([]);
    expect(rule(plain, ".cap-mbody").get("animation")).toMatch(/^reveal-down\b/);
  });

  it("(a) a status line's new words rise in, and the working sentence carries a band over its own words", () => {
    // CANARY: drop `.ctl-working-step` from the swap-in rule.
    for (const selector of [".run-phase .ph", ".run-phase .step", ".ctl-working-step"]) {
      expect(rule(plain, selector).get("animation"), selector).toMatch(/^swap-in \.15s var\(--ease-out\)$/);
    }
    expect(CODE).toMatch(/@keyframes swap-in \{ from \{ opacity: 0; transform: translateY\(4px\); filter: blur\(2px\); \}/);
    const band = rule(plain, ".ctl-working-text::before");
    // The copy is the element's own `data-text`, silenced for assistive tech
    // (the `/ ""` alt text) so the sentence is not read twice.
    expect(band.get("content")).toBe('attr(data-text) / ""');
    expect(band.get("background-clip")).toBe("text");
    expect(band.get("color")).toBe("transparent");
    expect(band.get("background")).toMatch(/var\(--fg\) 50%/);
    expect(band.get("animation")).toMatch(/^shimmer 2s linear infinite$/);
    expect(rule(plain, ".ctl-working-text").get("position")).toBe("relative");
  });

  it("(c) a copy control's two glyphs share one cell and trade places on data-copied", () => {
    // CANARY: drop `grid-area: 1 / 1` and the check draws beside the copy mark.
    expect(rule(plain, ".copy-glyph").get("display")).toBe("inline-grid");
    expect(rule(plain, ".copy-glyph > .ico").get("grid-area")).toBe("1 / 1");
    const hidden = rule(plain, ".copy-glyph[data-copied] > .ico:first-child");
    expect(hidden.get("opacity")).toBe("0");
    expect(hidden.get("transform")).toBe("scale(.25)");
    expect(rule(plain, ".copy-glyph > .ico + .ico").get("opacity")).toBe("0");
    expect(rule(plain, ".copy-glyph[data-copied] > .ico + .ico").get("opacity")).toBe("1");
    expect(rule(plain, ".copy-done").get("animation")).toMatch(/^swap-in\b/);
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
    const path = rule(plain, '.signin-step[data-state="done"] .signin-mark .ico path');
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
    expect(rule(plain, ".refused").get("animation")).toMatch(/^shake \.28s linear$/);
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
    /** Every JSX opening tag in a source, braces, strings and comments skipped. */
    const openingTags = (src: string): { tag: string; line: number }[] => {
      const out: { tag: string; line: number }[] = [];
      for (const m of src.matchAll(/<([A-Za-z][\w.]*)[\s>]/g)) {
        let depth = 0;
        let i = m.index! + 1;
        for (; i < src.length; i++) {
          const c = src[i]!;
          if (c === "/" && src[i + 1] === "/" && depth === 0) i = src.indexOf("\n", i);
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
    // Sixteen boxes keyed on a refusal counter, and the login page's two.
    expect(carriers).toHaveLength(18);
  });

  it("every motion this ruling adds has a reduced-motion answer that does not move", () => {
    // CANARY: drop `.refused` from the closing reduced-motion block.
    const answer = (selector: string) => {
      const hit = reduced.filter((r) => parts(r).includes(selector));
      expect(hit.length, `${selector} needs a reduced-motion rule`).toBeGreaterThan(0);
      return rule(reduced, selector);
    };
    for (const selector of [
      ".run-phase .ph", ".run-phase .step", ".ctl-working-step", ".copy-done",
      '.signin-step[data-state="done"] .signin-mark .ico', ".cap-mbody", ".ctl-msg[data-fresh]",
    ]) {
      expect(answer(selector).get("animation"), selector).toMatch(/^fade-in \.12s ease$/);
    }
    expect(answer(".ctl-working-text::before").get("display")).toBe("none");
    expect(answer('.signin-step[data-state="done"] .signin-mark .ico path').get("animation")).toBe("none");
    expect(answer(".refused").get("animation")).toBe("none");
    for (const selector of [
      ".copy-glyph > .ico", ".copy-glyph > .ico + .ico",
      ".copy-glyph[data-copied] > .ico:first-child", ".copy-glyph[data-copied] > .ico + .ico",
    ]) {
      const decls = answer(selector);
      expect(decls.get("transform"), selector).toBe("none");
      expect(decls.get("filter"), selector).toBe("none");
      expect(decls.get("transition"), selector).toBe("opacity .12s ease");
    }
  });
});
