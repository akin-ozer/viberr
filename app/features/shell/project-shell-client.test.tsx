// @vitest-environment jsdom
import { useRef, useState } from "react";
import {
  Link,
  MemoryRouter,
  RouterProvider,
  createMemoryRouter,
} from "react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Rail } from "./rail";
import {
  LiveUpdateIndicator,
  NavigationStatus,
  RailToggle,
} from "./topbar";
import { ArchivedProjectBanner } from "~/ui/archived-badge";

afterEach(cleanup);

function RailHarness() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <MemoryRouter initialEntries={["/projects/p/board"]}>
      <RailToggle
        open={open}
        onToggle={() => setOpen((value) => !value)}
        buttonRef={toggleRef}
      />
      <Rail
        projectSlug="p"
        projectName="Project"
        projectRepo="org/repo"
        membersCount={2}
        boardCount={3}
        reviewCount={1}
        violations={0}
        mobile
        open={open}
        onClose={close}
      />
    </MemoryRouter>
  );
}

function AlwaysOpenRail({ revision }: { revision: number }) {
  return (
    <MemoryRouter initialEntries={["/projects/p/board"]}>
      <span data-testid="revision">{revision}</span>
      <Rail
        projectSlug="p"
        projectName="Project"
        projectRepo="org/repo"
        membersCount={2}
        boardCount={3}
        reviewCount={1}
        violations={0}
        mobile
        open
        onClose={() => undefined}
      />
    </MemoryRouter>
  );
}

describe("compact project rail", () => {
  it("opens accessibly, focuses the drawer, and restores focus on Escape", async () => {
    render(<RailHarness />);
    const toggle = screen.getByRole("button", {
      name: "Open project navigation",
    });
    const rail = screen.getByRole("navigation", { hidden: true });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(rail.getAttribute("aria-hidden")).toBe("true");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rail.hasAttribute("aria-hidden")).toBe(false);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        rail.querySelector(".rail-close"),
      ),
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("closes after selecting a project destination", () => {
    render(<RailHarness />);
    const toggle = screen.getByRole("button", {
      name: "Open project navigation",
    });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("link", { name: /Review/ }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("does not steal focus back to Close on an unrelated re-render", async () => {
    const { container, rerender } = render(<AlwaysOpenRail revision={1} />);
    const review = screen.getByRole("link", { name: /Review/ });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector(".rail-close"),
      ),
    );
    review.focus();
    expect(document.activeElement).toBe(review);
    rerender(<AlwaysOpenRail revision={2} />);
    expect(document.activeElement).toBe(review);
  });
});

describe("project shell status", () => {
  it("keeps a visible label for every live-update state", () => {
    const statuses = [
      ["connecting", "Connecting"],
      ["connected", "Live"],
      ["reconnecting", "Reconnecting"],
      ["offline", "Offline"],
      ["paused", "Paused"],
      ["unavailable", "Unavailable"],
    ] as const;

    const { rerender } = render(
      <LiveUpdateIndicator status={statuses[0][0]} />,
    );
    for (const [status, label] of statuses) {
      rerender(<LiveUpdateIndicator status={status} />);
      expect(screen.getByRole("status").textContent).toContain(label);
      expect(screen.getByRole("status").classList.contains(status)).toBe(true);
    }
  });

  it("shows navigation progress while a destination loader is pending", async () => {
    let finish!: () => void;
    const slowLoader = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const router = createMemoryRouter(
      [
        {
          path: "/start",
          element: (
            <>
              <Link to="/slow">Open slow view</Link>
              <NavigationStatus />
            </>
          ),
        },
        {
          path: "/slow",
          loader: () => slowLoader,
          element: <p>Slow view ready</p>,
        },
      ],
      { initialEntries: ["/start"] },
    );

    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("link", { name: "Open slow view" }));
    expect((await screen.findByRole("status")).textContent).toContain(
      "Loading view…",
    );

    await act(async () => finish());
    expect(await screen.findByText("Slow view ready")).toBeTruthy();
  });
});

describe("archived project banner", () => {
  it("links members to Settings so they can restore the project", () => {
    render(
      <MemoryRouter>
        <ArchivedProjectBanner projectSlug="p" canOpenSettings />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("link", { name: "Open Settings" }).getAttribute("href"),
    ).toBe("/projects/p/settings");
  });

  it("gives nonmembers remediation without exposing a dead Settings link", () => {
    render(
      <MemoryRouter>
        <ArchivedProjectBanner projectSlug="p" canOpenSettings={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("link", { name: "Open Settings" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Ask a project admin to restore it",
    );
  });
});
