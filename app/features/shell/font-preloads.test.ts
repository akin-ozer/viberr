import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LinkDescriptor } from "react-router";
import { links as rootLinks } from "~/root";

/**
 * Ruling 454: the Inter faces a first paint draws are preloaded, and the
 * system face that stands in until they arrive is metric-matched to Inter so
 * the swap does not re-wrap the page. Before this, `links()` returned only the
 * favicon (0 font preloads) and the stack fell straight through to the system
 * face (0 fallback faces with size-adjust).
 */

const APP = path.join(process.cwd(), "app");

/** The Inter weight a preload names, or null for any other link. */
function preloadedInterWeight(link: LinkDescriptor): string | null {
  if (!("rel" in link) || link.rel !== "preload") return null;
  const m = /inter-latin-(\d+)-normal[^/]*\.woff2$/.exec(link.href ?? "");
  expect(m, `a preload that is not an Inter latin woff2: ${link.href}`).not.toBeNull();
  expect(link).toMatchObject({ as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return m![1]!;
}

function weights(links: LinkDescriptor[]): string[] {
  return links.map(preloadedInterWeight).filter((w): w is string => w !== null);
}

describe("font preloads (ruling 454)", () => {
  it("every page preloads Inter 400 and 700, and no other face", () => {
    expect(weights(rootLinks())).toEqual(["400", "700"]);
  });

  it("the project workspace adds Inter 500 for its rail, crumbs and board chrome", async () => {
    // Imported late: the layout module pulls the server graph in with it.
    const { links } = await import("~/routes/project");
    expect(weights(links())).toEqual(["500"]);
  });

  it("preloads only faces the root stylesheet really declares", () => {
    const root = readFileSync(path.join(APP, "root.tsx"), "utf8");
    for (const w of ["400", "500", "700"]) {
      expect(root).toContain(`import "@fontsource/inter/${w}.css";`);
    }
  });
});

describe("the metric-matched Inter fallback (ruling 454)", () => {
  const css = readFileSync(path.join(APP, "app.css"), "utf8");
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
  const fallback = faces.filter((body) => /font-family:\s*"Inter Fallback"/.test(body));

  it("declares a regular and a bold face over local system fonts", () => {
    expect(fallback.map((body) => /font-weight:\s*(\d+)/.exec(body)?.[1])).toEqual([
      "400",
      "700",
    ]);
    for (const body of fallback) {
      expect(body).toMatch(/src:\s*local\("Arial/);
      for (const descriptor of ["size-adjust", "ascent-override", "descent-override", "line-gap-override"]) {
        expect(body, descriptor).toMatch(new RegExp(`${descriptor}:\\s*[\\d.]+%`));
      }
    }
  });

  it("sits right after Inter in both type tokens", () => {
    expect(css).toMatch(/--font-body:\s*"Inter",\s*"Inter Fallback",/);
    expect(css).toMatch(/--font-display:\s*"Inter",\s*"Inter Fallback",/);
  });
});
