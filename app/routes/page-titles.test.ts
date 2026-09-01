import { describe, expect, it } from "vitest";
import { pageTitle } from "~/shared/page-title";

/**
 * D32-3 (pass 32): every titled route follows ONE grammar —
 * "<Page> · <project> · Viberr" — checked by calling each route's `meta`
 * with the args it reads. Three grammars used to coexist (bare project title
 * on six workspace views, "Instance settings" with no product name, "Viberr ·
 * Sign in" reversed).
 */
describe("document titles follow one grammar (D32-3)", () => {
  const slugArgs = { params: { slug: "viberr-core" } };
  const cases: { route: string; args: unknown; title: string }[] = [
    { route: "~/routes/project.board", args: slugArgs, title: "Board · viberr-core · Viberr" },
    { route: "~/routes/project.review", args: slugArgs, title: "Review queue · viberr-core · Viberr" },
    { route: "~/routes/project.controller", args: slugArgs, title: "Controller · viberr-core · Viberr" },
    { route: "~/routes/project.agents", args: slugArgs, title: "Agents · viberr-core · Viberr" },
    { route: "~/routes/project.policy", args: slugArgs, title: "Policy · viberr-core · Viberr" },
    { route: "~/routes/project.github", args: slugArgs, title: "GitHub · viberr-core · Viberr" },
    { route: "~/routes/project.activity", args: slugArgs, title: "Activity · viberr-core · Viberr" },
    { route: "~/routes/project.settings", args: slugArgs, title: "Settings · viberr-core · Viberr" },
    {
      route: "~/routes/project.task",
      args: { params: { slug: "viberr-core", key: "VIB-1" }, loaderData: { task: { key: "VIB-1", title: "Ship it" } } },
      title: "VIB-1 · Ship it · Viberr",
    },
    { route: "~/routes/org.settings", args: {}, title: "Instance settings · Viberr" },
    { route: "~/routes/login", args: {}, title: "Sign in · Viberr" },
    { route: "~/routes/controller", args: {}, title: "Controller · Viberr" },
    { route: "~/routes/insights", args: {}, title: "Insights · Viberr" },
    { route: "~/routes/notifications", args: {}, title: "Notifications · Viberr" },
    { route: "~/routes/profile", args: {}, title: "Profile & preferences · Viberr" },
  ];

  type MetaCase = (typeof cases)[number];

  for (const c of cases) {
    it(`${c.route} → "${c.title}"`, async () => {
      // SAFETY: each route module exports `meta`; the args are the subset it reads.
      const mod = (await import(/* @vite-ignore */ c.route)) as {
        meta: (args: MetaCase["args"]) => { title?: string }[];
      };
      expect(mod.meta(c.args)).toEqual([{ title: c.title }]);
    });
  }

  it("pageTitle skips empty parts and always ends with the product name", () => {
    expect(pageTitle("Board", undefined)).toBe("Board · Viberr");
    expect(pageTitle(null)).toBe("Viberr");
    expect(pageTitle("VIB-1 · Ship it")).toBe("VIB-1 · Ship it · Viberr");
  });
});
