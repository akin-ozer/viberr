// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { startTransition, type ReactElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type { StageDef } from "~/schemas/project-file.schema";
import type { GagentView } from "~/server/org/gagents.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";

/**
 * Ruling 293 (F40-44): the Agent resources tab's hydration gate, the task
 * page's (`task-detail/hydration-determinism.test.tsx`) applied to
 * /org/settings?tab=resources.
 *
 * Live, every load of the tab threw React #418 (`args[]=text`) and rebuilt
 * <main>: the server rendered "re-scanned yesterday" where the viewer's
 * browser rendered "re-scanned 1h ago", because the rows built their "when"
 * with `formatRelative`, which reads NOW and the host zone. A real
 * `renderToString` in the SERVER's zone and clock, then a real `hydrateRoot` of
 * that markup in the VIEWER's, with React's recoverable-error collector wired:
 * a text mismatch lands in `recoverable` and the assertion prints it.
 *
 * The two environments are the task page's: the server in UTC at 23:59:59Z,
 * the viewer in Pacific/Auckland (UTC+12) at 00:00:01Z, two seconds later and
 * a calendar day apart. The zone is applied per environment with
 * `vi.resetModules()` + a dynamic import, because the formatters in
 * `shared/dates/format.ts` resolve their zone at import.
 */

type PanelModule = typeof import("./resources-panel");
type ToastModule = typeof import("~/ui/toast");

const SERVER_ZONE = "UTC";
const VIEWER_ZONE = "Pacific/Auckland";
const SERVER_NOW = "2026-07-03T23:59:59.000Z";
const VIEWER_NOW = "2026-07-04T00:00:01.000Z";
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Stamps against the two clocks: 23:30Z is 29 minutes old on the server and
 * 30 on the viewer (a minute rollover); 09:41Z is the server's "14h ago" and
 * the viewer's "yesterday" (a local midnight between them); an MCP check three
 * hours old sits either side of nothing, so the stale mark alone is tested on
 * it; the OAuth token runs out 52 minutes after the server's now.
 */
const KBS: KbView[] = [
  {
    id: "kb1", name: "Architecture notes", dir: "architecture-notes",
    refresh: "on change", lastIndexedAt: "2026-07-03T23:30:00.000Z", tree: [],
    fileCount: 2, injectableCount: 2, folderExists: true, private: false, uri: "store://kb/architecture-notes",
  },
  {
    id: "kb2", name: "Gone", dir: "gone", refresh: "manual",
    lastIndexedAt: "2026-07-03T09:41:00.000Z", tree: [],
    fileCount: 0, injectableCount: 0, folderExists: false, private: false, uri: "store://kb/gone",
  },
];
const MCP_BASE: McpView = {
  id: "m1", name: "github-mcp", transport: "HTTP", target: "https://mcp.internal/sse",
  hasCred: true, tools: 14, up: true, lastCheckedAt: "2026-07-03T21:00:00.000Z",
  lastError: null, warmingSince: null, writeTools: [], writeToolsReviewed: true,
  discoveredTools: null, storePaths: [],
  credUnreadable: false, firstSuccessAt: null, heuristicWarmups: 0, oauth: null, requestedScope: null,
};
const MCPS: McpView[] = [
  MCP_BASE,
  { ...MCP_BASE, id: "m2", name: "browserbase", hasCred: false, up: false, lastCheckedAt: "2026-07-03T09:41:00.000Z" },
  {
    ...MCP_BASE, id: "m3", name: "cloudflare-api", hasCred: false, up: false,
    lastCheckedAt: "2026-07-03T23:30:00.000Z",
    oauth: { status: "needs_sign_in", expiresAt: null, renews: false, issuer: "mcp.cloudflare.com", reason: null, scope: null },
  },
  {
    ...MCP_BASE, id: "m4", name: "linear", hasCred: false, up: true,
    lastCheckedAt: "2026-07-03T23:30:00.000Z",
    oauth: { status: "signed_in", expiresAt: "2026-07-04T00:52:00.000Z", renews: true, issuer: "mcp.linear.app", reason: null, scope: null },
  },
];
const SKILLS: SkillView[] = [
  {
    id: "s1", name: "terraform-review", summary: "Module review checklist.",
    updatedAt: "2026-07-03T09:41:00.000Z", body: "## Review checklist", tree: [],
    fileCount: 1, uri: "store://skills/terraform-review",
  },
  {
    id: "s2", name: "seeded", summary: "Never edited.", updatedAt: null, body: "", tree: [],
    fileCount: 1, uri: "store://skills/seeded",
  },
];
const GAGENTS: GagentView[] = [];
const STAGES: StageDef[] = [{ id: "triage", name: "Triage", color: "slate" }];

async function tabIn(zone: string): Promise<() => ReactElement> {
  process.env.TZ = zone;
  vi.resetModules();
  const panel: PanelModule = await import("./resources-panel");
  const toast: ToastModule = await import("~/ui/toast");
  return () => {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <toast.ToastProvider>
            <panel.ResourcesPanel kbs={KBS} mcps={MCPS} skills={SKILLS} gagents={GAGENTS} stages={STAGES} projectStages={[]} />
          </toast.ToastProvider>
        ),
      },
    ]);
    return <Stub initialEntries={["/org/settings?tab=resources"]} />;
  };
}

function messageOf(error: Error | string): string {
  return error instanceof Error ? error.message : String(error);
}

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.useRealTimers();
  process.env.TZ = SYSTEM_ZONE;
  vi.resetModules();
});

async function serverHtml(): Promise<string> {
  vi.setSystemTime(new Date(SERVER_NOW));
  const tab = await tabIn(SERVER_ZONE);
  return renderToString(tab());
}

async function hydrate(html: string) {
  vi.setSystemTime(new Date(VIEWER_NOW));
  const tab = await tabIn(VIEWER_ZONE);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  containers.push(container);
  const recoverable: string[] = [];
  const warnings: string[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: (Error | string)[]) => {
      warnings.push(args.map(messageOf).join(" "));
    });
  try {
    await act(async () => {
      startTransition(() => {
        roots.push(
          hydrateRoot(container, tab(), {
            onRecoverableError: (error) => {
              recoverable.push(messageOf(error instanceof Error ? error : String(error)));
            },
          }),
        );
      });
    });
    await act(async () => {});
  } finally {
    consoleError.mockRestore();
  }
  return { container, recoverable, warnings };
}

function rowText(root: ParentNode, name: string): string {
  const row = [...root.querySelectorAll(".rsrc-row")].find((r) =>
    (r.textContent ?? "").includes(name),
  );
  return (row?.textContent ?? "").replace(/ /g, " ");
}

describe("ruling 293: the Agent resources tab hydrates clean across the zone and midnight pair", () => {
  it("the server's markup depends on the timestamps alone", async () => {
    // Canary: build a row's stamp with `formatRelative` again (the old
    // `rel()`), and "29m ago" / "14h ago" land in the server's markup.
    vi.useFakeTimers({ toFake: ["Date"] });
    const html = await serverHtml();
    expect(html).not.toMatch(/\d+[mhd] ago|yesterday|just now|stale, retest|expires in/);
    expect(html).toContain("not yet edited");
  });

  it("hydrates the server's markup in the viewer's zone with no recoverable error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const html = await serverHtml();
    const { container, recoverable, warnings } = await hydrate(html);
    expect(recoverable, recoverable.join("\n\n")).toEqual([]);
    expect(warnings, warnings.join("\n\n")).toEqual([]);
    // After hydration the viewer-local forms are in: 23:30Z is 30 minutes old
    // at the viewer's now, 09:41Z is 21:41 on the viewer's yesterday.
    expect(rowText(container, "Architecture notes")).toContain("re-scanned 30m ago");
    expect(rowText(container, "Gone")).toContain("last scanned yesterday");
    expect(rowText(container, "terraform-review")).toContain("updated yesterday");
    expect(rowText(container, "seeded")).toContain("not yet edited");
    expect(rowText(container, "github-mcp")).toContain(
      "14 tools · checked 3h ago · stale, retest",
    );
    expect(rowText(container, "browserbase")).toContain("unreachable · checked yesterday");
    expect(rowText(container, "cloudflare-api")).toContain("needs sign-in · checked 30m ago");
    expect(rowText(container, "linear")).toContain(
      "auth: OAuth, signed in (expires in 52 minutes, renews itself)",
    );
  });
});
