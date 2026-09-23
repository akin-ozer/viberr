import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { expectWithinBudget } from "../test-support/perf-ratchet";
import { balanced, cssRules, type CssRule } from "../test-support/css-rules";

/**
 * Ruling 454: the stylesheet's share of the main thread and of layout shift,
 * counted off `app/app.css` itself (the one sheet the app has).
 *
 *   - An endless animation of anything but transform and opacity repaints on
 *     the main thread every frame for as long as it runs, and stalls whenever a
 *     revalidation holds that thread (BOARD-8 / CSS-1: the "agent working"
 *     pulse, on every working card, run dot, wait tag and Home stat).
 *   - A scroller whose content changes live narrows by the scrollbar's width
 *     the moment it starts to overflow, rewrapping everything in it (CSS-4;
 *     owner, 2026-09-24: the live scrollers reserve the gutter).
 *   - A feed thumbnail with no box of its own is 0px tall until its picture
 *     arrives, then pushes the feed down (CSS-7).
 */

const CODE = readFileSync(fileURLToPath(new URL("./app.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const RULES = cssRules(CODE);

const parts = (rule: CssRule) => rule.selector.split(",").map((s) => s.trim());
const reduced = (rule: CssRule) => rule.at.some((q) => /prefers-reduced-motion:\s*reduce/.test(q));

/** Every `@keyframes` block: its name, and the properties its stops set. */
function keyframes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of CODE.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    const { body } = balanced(CODE, m.index + m[0].length - 1);
    out.set(m[1]!, new Set(cssRules(body).flatMap((stop) => [...stop.decls.keys()])));
  }
  return out;
}

/** Properties the compositor animates without the main thread. */
const COMPOSITED = new Set(["transform", "opacity", "translate", "scale", "rotate"]);

/** The selectors whose endless animation needs the main thread every frame. */
function mainThreadLoops(): string[] {
  const frames = keyframes();
  return RULES.flatMap((rule) => {
    if (reduced(rule)) return [];
    const animation = rule.decls.get("animation") ?? "";
    const count = rule.decls.get("animation-iteration-count") ?? "";
    if (!/\binfinite\b/.test(`${animation} ${count}`)) return [];
    const names = `${animation} ${rule.decls.get("animation-name") ?? ""}`
      .split(/[\s,]+/)
      .filter((token) => frames.has(token));
    const offCompositor = names.some((name) =>
      [...frames.get(name)!].some((prop) => !COMPOSITED.has(prop)),
    );
    return offCompositor ? parts(rule) : [];
  });
}

/** The scrollers whose content changes while someone watches (CSS-4). */
const LIVE_SCROLLERS = [".col-body", ".board.list", ".detail", ".console", ".ctl-transcript", ".dock-body"];

function declares(selector: string, prop: string, value: RegExp): boolean {
  return RULES.some(
    (rule) => rule.at.length === 0 && parts(rule).includes(selector) && value.test(rule.decls.get(prop) ?? ""),
  );
}

describe("app.css main-thread and layout-shift costs (ruling 454)", () => {
  it("animates only transform and opacity in an endless loop, but the controller's shimmer", () => {
    const loops = mainThreadLoops();
    // Ruling 451(a): the "Controller is working…" band animates its gradient's
    // position. One element, drawn only while the controller works.
    expect(loops).toContain(".ctl-working-text::before");
    expectWithinBudget("render:css.main-thread-infinite-loops", loops.length);
  });

  it("reserves the scrollbar gutter on every live scroller", () => {
    for (const selector of LIVE_SCROLLERS) {
      expect(declares(selector, "overflow-y", /\bauto\b/), `${selector} scrolls`).toBe(true);
    }
    const missing = LIVE_SCROLLERS.filter((s) => !declares(s, "scrollbar-gutter", /^stable\b/));
    expectWithinBudget("render:css.live-scrollers-without-gutter", missing.length);
  });

  it("gives every attachment thumbnail's picture its box before it loads", () => {
    const thumbs = RULES.filter((rule) =>
      parts(rule).some((s) => /(^|\s)\.(tl-)?attach-thumb img$/.test(s)),
    );
    expect(thumbs.length).toBeGreaterThanOrEqual(2);
    const unreserved = thumbs.filter((rule) => !rule.decls.has("height") && !rule.decls.has("aspect-ratio"));
    expectWithinBudget("render:css.feed-thumbs-without-a-box", unreserved.length);
  });
});
