// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import * as searchRoute from "~/routes/resources.search";
import type { CommandHit } from "./command-search.server";
import { CommandPalette } from "./command-palette";
import { clientLoaderOver, unreachable } from "../../../test-support/client-data";

/**
 * R15-5 — the ⌘K palette. Before it, the topbar's box promised a global search
 * over "tasks, branches, agents" and filtered whichever board was open.
 */

afterEach(cleanup);

const HITS: CommandHit[] = [
  {
    kind: "project",
    id: "project:viberr-core",
    label: "Viberr Core",
    sub: "akin-ozer/viberr",
    href: "/projects/viberr-core/board",
  },
  {
    kind: "task",
    id: "task:viberr-core/VIB-142",
    label: "Attach a project credential",
    key: "VIB-142",
    sub: "Viberr Core",
    href: "/projects/viberr-core/tasks/VIB-142",
  },
  {
    kind: "branch",
    id: "branch:viberr-core/VIB-9",
    label: "vib-9-reviewer-binding",
    sub: "VIB-9 · Viberr Core",
    href: "/projects/viberr-core/tasks/VIB-9",
  },
];

/** `search` answers a query with its hits, or is `unreachable`: a server
 *  that gives no answer (a restart, a dead network). */
function renderPalette(search: () => CommandHit[] = () => HITS) {
  let landedAt: string | null = null;
  let searches = 0;
  const Stub = createRoutesStub([
    { path: "/", Component: () => <CommandPalette onClose={() => {}} /> },
    {
      path: "/resources/search",
      loader: clientLoaderOver(searchRoute, ({ request }) => {
        searches += 1;
        return { data: { q: new URL(request.url).searchParams.get("q") ?? "", hits: search() } };
      }),
    },
    {
      path: "/projects/:slug/tasks/:key",
      Component: () => {
        landedAt = "task";
        return <p>task page</p>;
      },
    },
    {
      path: "/projects/:slug/board",
      Component: () => {
        landedAt = "board";
        return <p>board page</p>;
      },
    },
  ]);
  const utils = render(<Stub initialEntries={["/"]} />);
  return { ...utils, landed: () => landedAt, searches: () => searches };
}

describe("CommandPalette", () => {
  it("says nothing until the viewer types", () => {
    const { getByText } = renderPalette();
    expect(getByText(/Type to jump to a task/)).toBeTruthy();
  });

  it("arrow keys move the selection and Enter jumps to the hit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { getByLabelText, container, landed } = renderPalette();
      const input = getByLabelText("Search tasks, epics, branches, agents, projects");
      fireEvent.change(input, { target: { value: "vib" } });
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() =>
        expect(container.querySelectorAll(".cmdk-row")).toHaveLength(3),
      );
      // First row is active by default; one ArrowDown lands on the task.
      await waitFor(() =>
        expect(
          container.querySelectorAll(".cmdk-row")[0]!.getAttribute("data-active"),
        ).toBe("true"),
      );
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(
        container.querySelectorAll(".cmdk-row")[1]!.getAttribute("data-active"),
      ).toBe("true");
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(landed()).toBe("task"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("ruling 503: an epic hit sits in its own group after the projects and opens the epic", async () => {
    // CANARY: drop `epic` from GROUP_LABEL, and the run renders with no heading.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const epic: CommandHit = {
        kind: "epic",
        id: "epic:viberr-core/epic-2",
        label: "Checkout revamp",
        sub: "epic-2 · Viberr Core",
        href: "/projects/viberr-core/epics/epic-2",
      };
      const { getByLabelText, getByRole, container } = renderPalette(() => [HITS[0]!, epic, HITS[1]!]);
      fireEvent.change(getByLabelText("Search tasks, epics, branches, agents, projects"), {
        target: { value: "check" },
      });
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(getByRole("group", { name: "Epics" })).toBeTruthy());
      const rows = [...container.querySelectorAll(".cmdk-row")].map((row) => row.textContent);
      expect(rows[1]).toContain("Checkout revamp");
      expect(rows[1]).toContain("epic-2 · Viberr Core");
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * UI-C (inventory rough edge #7) — the palette DECLARED `role="listbox"` and
 * `role="option"` without any of the wiring that makes them mean something:
 * the options sat inside anonymous <div>s next to their heading (so the
 * listbox owned nothing), the input was a plain textbox with no
 * `role="combobox"` / `aria-expanded`, and nothing carried
 * `aria-activedescendant` — so arrowing through the results, with focus pinned
 * in the input, announced absolutely nothing.
 *
 * The mention composer next door already had this contract right (the
 * `ContentEditable` rendered by `CommentComposer` + the listbox `MentionMenu`
 * renders); this mirrors it.
 */
describe("CommandPalette: the combobox/listbox contract", () => {
  async function openWithHits() {
    const utils = renderPalette();
    const input = utils.getByLabelText(
      "Search tasks, epics, branches, agents, projects",
    );
    fireEvent.change(input, { target: { value: "vib" } });
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() =>
      expect(utils.container.querySelectorAll('[role="option"]')).toHaveLength(
        3,
      ),
    );
    return { ...utils, input };
  }

  const options = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));

  it("declares the input a combobox and closes it when there is nothing to show", () => {
    const { getByLabelText, container } = renderPalette();
    const input = getByLabelText("Search tasks, epics, branches, agents, projects");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    // A combobox that is not expanded must not point at a listbox that is not
    // on the page — a dangling aria-controls/activedescendant is worse than none.
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });

  it("owns every option through the listbox, via role=group", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container, input } = await openWithHits();
      const listbox = container.querySelector<HTMLElement>('[role="listbox"]')!;
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(input.getAttribute("aria-controls")).toBe(listbox.id);

      // A listbox may only own `option` and `group`. Every direct child is a
      // labelled group, and every option's parent is one of those groups —
      // before the fix each option hung off an anonymous <div>.
      const groups = Array.from(listbox.children);
      expect(groups.length).toBeGreaterThan(0);
      for (const group of groups) {
        expect(group.getAttribute("role")).toBe("group");
        expect(group.getAttribute("aria-label")).toBeTruthy();
      }
      expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
        "Projects",
        "Tasks",
        "Branches",
      ]);
      for (const option of options(container)) {
        expect(option.parentElement!.getAttribute("role")).toBe("group");
      }
      // The visible heading is the group's name; announcing it twice is noise.
      for (const heading of container.querySelectorAll(".cmdk-group")) {
        expect(heading.getAttribute("aria-hidden")).toBe("true");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("points aria-activedescendant at the row the arrow keys highlight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container, input } = await openWithHits();
      const rows = options(container);
      expect(rows[0]!.id).toBeTruthy();
      await waitFor(() =>
        expect(input.getAttribute("aria-activedescendant")).toBe(rows[0]!.id),
      );
      expect(rows[0]!.getAttribute("aria-selected")).toBe("true");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input.getAttribute("aria-activedescendant")).toBe(rows[1]!.id);
      expect(rows[1]!.getAttribute("aria-selected")).toBe("true");
      expect(rows[0]!.getAttribute("aria-selected")).toBe("false");

      // Wrapping must keep the pointer honest too.
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.getAttribute("aria-activedescendant")).toBe(rows[2]!.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the rows out of the tab sequence and the focus in the input", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await openWithHits();
      for (const option of options(container)) {
        expect(option.getAttribute("tabindex")).toBe("-1");
      }
      // Clicking a row must not blur the combobox mid-click, or
      // aria-activedescendant is stale by the time the navigation runs.
      const mousedown = fireEvent.mouseDown(options(container)[0]!);
      expect(mousedown).toBe(false); // preventDefault()ed
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Ruling 457: a search the server can't answer (a restart, a 5xx, a dead
   * network) is the palette's, never the page's. React Router sent it to the
   * error boundary of the route that owns the palette, which replaced the
   * page. The route's `clientLoader` now answers null, which the palette reads
   * as no match.
   */
  it.each<[string, () => CommandHit[]]>([
    ["matches nothing", () => []],
    ["can't reach the server", unreachable],
  ])("announces an empty result when the search %s, instead of leaving the combobox silent", async (_label, search) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { getByLabelText, getByText, searches } = renderPalette(search);
      fireEvent.change(
        getByLabelText("Search tasks, epics, branches, agents, projects"),
        { target: { value: "zzzz" } },
      );
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(searches()).toBe(1));
      // Let the answer land: the line reads the same before the search goes
      // out. CANARY: delete `resources.search.ts`'s `clientLoader` and the
      // unreachable search takes the palette down with the page.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(getByText(/Nothing matches/).getAttribute("role")).toBe("status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still navigates on click", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container, landed } = await openWithHits();
      fireEvent.click(options(container)[1]!);
      await waitFor(() => expect(landed()).toBe("task"));
    } finally {
      vi.useRealTimers();
    }
  });
});
