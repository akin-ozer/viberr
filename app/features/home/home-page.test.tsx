// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { HomePage, type HomePageData } from "./home-page";
import type { HomeProjectCard } from "./home-query.server";

/**
 * UI-26: `home-page.tsx` (1400+ lines) had NO component test — only `StageMeter`
 * was rendered anywhere, via `notification-item.test.tsx`. Pass-12's SELF-1
 * (a ReferenceError that 500'd every blocked task because no test rendered that
 * branch) is the same exposure. These cover the pass-13 honesty branches.
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "done", name: "Done", color: "#00b473" },
];

function card(patch: Partial<HomeProjectCard> = {}): HomeProjectCard {
  return {
    slug: "viberr-core",
    name: "Viberr Core",
    archived: false,
    key: "VIB",
    repo: "akin-ozer/viberr",
    desc: "The product.",
    stages: STAGES,
    dist: {},
    total: 0,
    running: 0,
    waiting: 0,
    overrideWaiting: 0,
    members: [{ name: "Arda Kaya", initials: "AK", tone: "" }],
    updatedAt: null,
    accent: "#5b76fe",
    ...patch,
  };
}

function baseData(projects: HomeProjectCard[]): HomePageData {
  return {
    user: {
      id: "u_arda",
      name: "Arda Kaya",
      email: "arda@viberr.dev",
      role: "admin",
      avatarTone: "",
    } as HomePageData["user"],
    greet: "Good evening",
    projects,
    prefs: { view: "grid", stars: {} },
    org: {
      connectionOwners: ["akin-ozer"],
      connectionHealth: { "akin-ozer": "valid" },
      users: { total: 5, admins: 1, members: 4, disabled: 2, first: [] },
      globalAgents: 3,
      knowledgeBases: 2,
      mcpServers: 1,
      skills: 4,
    },
    notifications: [],
    unread: 0,
    storeRoot: "/data",
  };
}

function renderHome(data: HomePageData, extra: Record<string, unknown> = {}) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <HomePage data={data} theme="system" {...extra} />
        </ToastProvider>
      ),
    },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("UI-02: project card recency", () => {
  it("says there is no activity instead of inventing a timestamp", () => {
    const { getByText, queryByText } = renderHome(baseData([card()]));
    expect(getByText("no task activity yet")).toBeTruthy();
    expect(queryByText(/^updated/)).toBeNull();
  });

  it("renders a relative label when the project really has task activity", () => {
    const { container } = renderHome(
      baseData([card({ total: 3, updatedAt: new Date().toISOString() })]),
    );
    const upd = container.querySelector("time.upd")!;
    expect(upd.textContent).toContain("updated");
    expect(upd.getAttribute("datetime")).toBeTruthy();
  });
});

describe("UI-10: the hero must not assert activity at zero", () => {
  it("reads as quiet with no runs and nothing waiting", () => {
    const { getByText, container } = renderHome(baseData([card()]));
    expect(
      getByText(/All quiet — no agent runs right now\./),
    ).toBeTruthy();
    // P14-WL-04: the hero's count is org-wide (every project the viewer is in),
    // so it says so — the board header and the Agents page count other things.
    expect(
      getByText(/Nothing is waiting on you in any of your projects\./),
    ).toBeTruthy();
    // The animated pulse dot is gone at zero (it used to render inside the
    // bold "0 runs active").
    expect(container.querySelector(".home-hero .working")).toBeNull();
  });

  it("still reports live runs with the pulse when something IS running", () => {
    const { getByText, container } = renderHome(
      baseData([card({ total: 2, running: 1 })]),
    );
    expect(getByText(/Your agents kept working/)).toBeTruthy();
    expect(container.querySelector(".home-hero .working")).toBeTruthy();
  });

  // P14-WL-04: Home said "5 decisions waiting on you", the board header
  // "4 waiting on a human decision" and the Agents page "6 threads waiting on a
  // human" in one session. Every number was right; none said what it counted.
  it("names the scope of the waiting count", () => {
    const { getByText } = renderHome(
      baseData([card({ total: 5, running: 1, waiting: 2 })]),
    );
    expect(getByText(/waiting on you across all your projects/)).toBeTruthy();
  });
});

describe("UI-22: override-available decisions are never hidden", () => {
  it("renders alongside a personal waiting count", () => {
    const { getByText } = renderHome(
      baseData([card({ total: 5, waiting: 2, overrideWaiting: 3 })]),
    );
    expect(getByText("2 waiting on you")).toBeTruthy();
    // Before the fix this pill only rendered when `waiting === 0`.
    expect(getByText("3 override-available")).toBeTruthy();
  });
});

describe("UI-15: the dimmed band is the TERMINAL stage, not the id 'done'", () => {
  it("dims the last stage on a board with renamed ids", () => {
    const renamed = [
      { id: "todo", name: "Todo", color: "#111111" },
      { id: "shipped", name: "Shipped", color: "#222222" },
    ];
    const { container } = renderHome(
      baseData([
        card({ stages: renamed, dist: { todo: 1, shipped: 1 }, total: 2 }),
      ]),
    );
    const bands = container.querySelectorAll<HTMLElement>(".pj-meter span");
    expect(bands).toHaveLength(2);
    expect(bands[0]!.style.opacity).toBe("1");
    expect(bands[1]!.style.opacity).toBe("0.45");
  });
});

describe("UI-21: the search empty state accounts for pinned matches", () => {
  it("does not claim 'no project matches' while a pinned match is on screen", () => {
    const data = baseData([card()]);
    data.prefs = { view: "grid", stars: { "viberr-core": true } };
    const { container, getByLabelText, queryByText } = renderHome(data);
    fireEvent.change(getByLabelText("Find a project"), {
      target: { value: "viberr" },
    });
    expect(queryByText(/No project matches/)).toBeNull();
    expect(container.querySelectorAll(".pj-card")).toHaveLength(1);
  });

  it("still says so when nothing matches at all", () => {
    const { getByLabelText, getByText } = renderHome(baseData([card()]));
    fireEvent.change(getByLabelText("Find a project"), {
      target: { value: "zzz" },
    });
    expect(getByText(/No project matches/)).toBeTruthy();
  });
});

describe("UI-24: the org tile counts the population the panel shows", () => {
  it("discloses disabled accounts inside the total", () => {
    const { getByText } = renderHome(baseData([card()]));
    expect(getByText("5 users")).toBeTruthy();
    expect(getByText(/1 admin · 4 members · 2 disabled/)).toBeTruthy();
  });
});

describe("UI-03: a dropped live-update stream is surfaced", () => {
  it("renders a paused chip only when the stream is down", () => {
    const { queryByText, rerender } = renderHome(baseData([card()]));
    expect(queryByText(/live updates paused/)).toBeNull();
    rerender(<div />);

    const { getByText } = renderHome(baseData([card()]), { livePaused: true });
    expect(getByText(/live updates paused/)).toBeTruthy();
  });
});

describe("LV-07: the New-project modal explains itself", () => {
  it("names what is stripped from the task key and why Create is disabled", () => {
    const { getByText, getAllByText, getByLabelText, container } = renderHome(
      baseData([card()]),
    );
    fireEvent.click(getAllByText("New project")[0]!);
    const key = getByLabelText(/Task key/) as HTMLInputElement;

    fireEvent.change(key, { target: { value: "P13" } });
    // Letters-only is the stored contract (`taskPrefix` is /^[A-Za-z]+$/), but
    // the modal used to strip silently — "P13" became "P" with no message.
    expect(key.value).toBe("P");
    expect(
      getByText(/Only letters are kept/),
    ).toBeTruthy();

    // …and Create says WHY it is disabled instead of being a dead button.
    const foot = container.querySelector(".modal-foot")!;
    expect(within(foot as HTMLElement).getByText(/Enter a project name/)).toBeTruthy();
  });
});
