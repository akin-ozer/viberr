// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { CommandHit } from "./command-search.server";
import { CommandPalette } from "./command-palette";

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
    label: "VIB-142 · Attach a project credential",
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

function renderPalette(hits: CommandHit[] = HITS) {
  let landedAt: string | null = null;
  const Stub = createRoutesStub([
    { path: "/", Component: () => <CommandPalette onClose={() => {}} /> },
    {
      path: "/resources/search",
      loader: ({ request }) => ({
        data: { q: new URL(request.url).searchParams.get("q") ?? "", hits },
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
  return { ...utils, landed: () => landedAt };
}

describe("CommandPalette", () => {
  it("says nothing until the viewer types", () => {
    const { getByText } = renderPalette();
    expect(getByText(/Type to jump to a task/)).toBeTruthy();
  });

  it("groups the server's hits by kind", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { getByLabelText, getByText } = renderPalette();
      fireEvent.change(
        getByLabelText("Search tasks, branches, agents, projects"),
        { target: { value: "vib" } },
      );
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(getByText("Tasks")).toBeTruthy());
      expect(getByText("Projects")).toBeTruthy();
      expect(getByText("Branches")).toBeTruthy();
      expect(getByText("vib-9-reviewer-binding")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arrow keys move the selection and Enter jumps to the hit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { getByLabelText, container, landed } = renderPalette();
      const input = getByLabelText("Search tasks, branches, agents, projects");
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

  it("reports an empty result instead of an empty box", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { getByLabelText, getByText } = renderPalette([]);
      fireEvent.change(
        getByLabelText("Search tasks, branches, agents, projects"),
        { target: { value: "zzzz" } },
      );
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() => expect(getByText(/Nothing matches/)).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });
});
