// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { HomePage, type HomePageData } from "./home-page";
import { ProjectCard, ProjectRow, StageMeter } from "./project-cards";
import type { HomeProjectCard } from "./home-query.server";

/**
 * UI-26: `home-page.tsx` (1400+ lines) had NO component test — only `StageMeter`
 * was rendered anywhere, from the notification suite (its tests live here now).
 * Pass-12's SELF-1 (a ReferenceError that 500'd every blocked task because no
 * test rendered that branch) is the same exposure. These cover the pass-13
 * honesty branches.
 */

afterEach(cleanup);

const STAGES = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "done", name: "Done", color: "green" },
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
    repoAccess: null,
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
      title: null,
      role: "admin",
      theme: "system",
      idp: "local",
      avatarTone: "",
    },
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
    unread: 0,
    orphanUnread: 0,
    storeRoot: "/data",
  };
}

/** The optional HomePage props a case drives directly (the live-stream state). */
type HomeOverrides = Omit<ComponentProps<typeof HomePage>, "data" | "theme">;

/** A query answers a plain `HTMLElement`, but `.value`/`setSelectionRange` live
 *  on the concrete control — so the node is CHECKED against its element class
 *  rather than asserted into it, and a wrong node fails here. */
function control<T extends HTMLElement>(
  node: Element | null,
  kind: new () => T,
): T {
  if (!(node instanceof kind)) {
    throw new Error(`expected ${kind.name}, got ${node?.nodeName ?? "nothing"}`);
  }
  return node;
}

function renderHome(data: HomePageData, extra: HomeOverrides = {}) {
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

describe("interface review 2026-09-06: the member stack is a named image", () => {
  it("carries its names on role=img, where a label is allowed", () => {
    const { container } = renderHome(
      baseData([
        card({
          members: [
            { name: "Arda Kaya", initials: "AK", tone: "" },
            { name: "Selin Aksoy", initials: "SA", tone: "teal" },
          ],
        }),
      ]),
    );
    // Phase 1 (2026-09-08): `.stack` is now the shared `AvatarGroup`
    // (`.avatar-group`), which owns the overlap, this label idiom and the `+N`
    // fold. The contract under test is unchanged.
    const stack = container.querySelector(".avatar-group")!;
    // ARIA prohibits aria-label on a role-less span and readers drop it, so the
    // names were never announced; the avatars are initials only.
    expect(stack.getAttribute("role")).toBe("img");
    expect(stack.getAttribute("aria-label")).toBe("Arda Kaya, Selin Aksoy");
  });

  it("folds past five into +N and still names everyone", () => {
    // The row was uncapped, so a twenty-member project drew twenty discs across
    // a card footer. The fold is presentational only: the group's label is the
    // full list, so nobody is hidden from a screen reader by a visual cap.
    const members = ["Arda Kaya", "Selin Aksoy", "Deniz Ari", "Ece Kurt", "Mert Oz", "Zeynep Il", "Kaan Ates"]
      .map((name) => ({ name, initials: name.slice(0, 2).toUpperCase(), tone: "" }));
    const { container } = renderHome(baseData([card({ members })]));
    const group = container.querySelector(".avatar-group")!;
    expect(group.querySelectorAll(".avatar:not(.count)")).toHaveLength(5);
    const count = group.querySelector(".avatar.count")!;
    expect(count.textContent).toBe("+2");
    // The fold is decorative — the group's own label already carries the names.
    expect(count.getAttribute("aria-hidden")).toBe("true");
    expect(group.getAttribute("aria-label")).toBe(members.map((m) => m.name).join(", "));
  });
});

describe("UI-10: the hero must not assert activity at zero", () => {
  it("reads as quiet with no runs and nothing waiting", () => {
    const { getByText, container } = renderHome(baseData([card()]));
    expect(
      getByText(/All quiet\. No agent runs right now\./),
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
      { id: "todo", name: "Todo", color: "stone" },
      { id: "shipped", name: "Shipped", color: "rose" },
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
    // Ruling 364: the band carries the preset NAME for the sheet to paint —
    // never an inline colour (the shopify meter's `amber` band painted nothing
    // that way). CANARY: put `background: s.color` back.
    expect(bands[0]!.dataset.stageColor).toBe("stone");
    expect(bands[1]!.dataset.stageColor).toBe("rose");
    expect(bands[0]!.style.background).toBe("");
  });
});

describe("StageMeter (per-project stages, ruling 15)", () => {
  const stages = [
    { id: "todo", name: "To do", color: "slate" },
    { id: "doing", name: "In progress", color: "violet" },
    { id: "done", name: "Done", color: "green" },
  ];

  it("renders flex-weighted segments for non-empty stages", () => {
    const { container } = render(
      <StageMeter stages={stages} dist={{ todo: 2, done: 3 }} />,
    );
    const meter = container.querySelector(".pj-meter")!;
    const segments = meter.querySelectorAll("span");
    expect(segments.length).toBe(2); // "doing" has 0 tasks → no segment
    // Each band's width is its stage's share of the tasks.
    expect([...segments].map((s) => s.style.flexGrow)).toEqual(["2", "3"]);
    expect(meter.getAttribute("title")).toBe("2 to do · 0 in progress · 3 done");
  });

  it("renders a ghost pipeline preview for zero tasks — one faint segment per stage", () => {
    const { container } = render(<StageMeter stages={stages} dist={{}} />);
    const meter = container.querySelector(".pj-meter.is-empty")!;
    expect(meter).not.toBeNull();
    // A fresh card previews the workflow: one segment per stage, not a dead bar.
    expect(meter.querySelectorAll("span").length).toBe(stages.length);
    expect(meter.getAttribute("title")).toContain("No tasks yet");
    // Regression guard: the empty meter must NOT reuse the global `.empty`
    // text utility (padding: 2rem), which inflated the 6px bar into a dead
    // block on freshly-created project cards.
    expect(meter.classList.contains("empty")).toBe(false);
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
  const PAUSED = "Live updates paused. Cards may be out of date.";
  // The announcer carries the same sentence, so queries pin the visible strip.
  const STRIP_TEXT = { selector: ".archived-banner span" };

  it("renders a paused strip only when the stream is down", () => {
    const { container, rerender } = renderHome(baseData([card()]));
    expect(container.querySelector(".archived-banner")).toBeNull();
    rerender(<div />);

    const paused = renderHome(baseData([card()]), { livePaused: true });
    // layo-10: a strip under the header row, inside the sticky header — the
    // chip and Retry in the row (which cannot wrap) scrolled the page
    // sideways at phone width. Canary: put the chip back in `.home-top-in`.
    const strip = paused.container.querySelector("header.home-top > .archived-banner");
    expect(strip?.textContent).toContain(PAUSED);
    expect(paused.container.querySelector(".home-top-in .pill")).toBeNull();
  });

  it("ruling 149: the sentence is a status line, the retry a real control", () => {
    // The same split the workspace header uses: a `.pill` has no cursor and no
    // hover, so one element that was both sentence and control read as neither.
    // Canary: put `role="status"` on the strip and the sentence is read twice.
    let retried = 0;
    const { container, getByText, getByRole } = renderHome(baseData([card()]), {
      livePaused: true,
      onReconnect: () => (retried += 1),
    });
    const sentence = getByText(PAUSED, STRIP_TEXT);
    expect(sentence.tagName).toBe("SPAN");
    expect(sentence.closest('[role="status"]')).toBeNull();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(retried).toBe(1);
    const live = container.querySelector('span.vh[role="status"]');
    expect(live?.textContent).toBe(PAUSED);
  });

  it("ruling 149: no Retry when there is nothing to reconnect", () => {
    // The prop is optional, and a button that calls nothing is a control that
    // does nothing — the strip still states the fact.
    const { getByText, queryByRole } = renderHome(baseData([card()]), {
      livePaused: true,
    });
    expect(getByText(PAUSED, STRIP_TEXT)).toBeTruthy();
    expect(queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("ruling 149: the announcer is mounted before the stream drops", () => {
    // A live region inserted together with its text is not announced, so the
    // node has to exist (and be empty) while the stream is healthy.
    const { container } = renderHome(baseData([card()]));
    const live = container.querySelector('span.vh[role="status"]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toBe("");
  });
});

describe("LV-07: the New-project modal explains itself", () => {
  it("names what is stripped from the task key and why Create will refuse", () => {
    const { getByText, getAllByText, getByLabelText, container } = renderHome(
      baseData([card()]),
    );
    fireEvent.click(getAllByText("New project")[0]!);
    const key = control(getByLabelText(/Task key/), HTMLInputElement);

    fireEvent.change(key, { target: { value: "P13" } });
    // Letters-only is the stored contract (`taskPrefix` is /^[A-Za-z]+$/), but
    // the modal used to strip silently — "P13" became "P" with no message.
    expect(key.value).toBe("P");
    expect(
      getByText(/Only letters are kept/),
    ).toBeTruthy();

    // …and the footer says why Create will refuse.
    const foot = container.querySelector<HTMLElement>(".modal-foot")!;
    expect(within(foot).getByText(/Enter a project name/)).toBeTruthy();
  });
});

describe("B-FD4: the Settings tiles are admin-only links", () => {
  it("an org admin gets the Manage links", () => {
    const { getAllByText, getAllByRole, container } = renderHome(baseData([card()]));
    expect(getAllByText("Manage").length).toBe(3);
    expect(container.querySelectorAll('a[href^="/org/settings"]').length).toBe(3);
    // A11Y-6 (pass 32): each tile link is NAMED by its content (heading +
    // count + "Manage"); the live tree tool reported them unnamed, so the
    // computed accessible name is pinned here.
    const tiles = getAllByRole("link", { name: /Manage/ });
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      expect(tile.textContent!.replace("Manage", "").trim().length).toBeGreaterThan(0);
    }
  });

  it("a member keeps the counts but gets no link into an admin-403 route", () => {
    const data = baseData([card()]);
    const { container, getAllByText, getByText } = renderHome({
      ...data,
      user: { ...data.user, role: "member" },
    });
    // The tiles still summarize the org…
    expect(getByText("5 users")).toBeTruthy();
    // …but the route they linked to hard-requires the org admin role.
    expect(container.querySelectorAll('a[href^="/org/settings"]').length).toBe(0);
    // Four admin-only tiles now: connections, users, resources, and Insights.
    expect(getAllByText("Org admins manage this").length).toBe(4);
  });

  it("a member's New-project hint drops the host store path", () => {
    const data = baseData([card()]);
    const { getAllByText, container } = renderHome({
      ...data,
      user: { ...data.user, role: "member" },
      // The loader ships null for a non-admin (B-FD4).
      storeRoot: null,
    });
    fireEvent.click(getAllByText("New project")[0]!.closest("button")!);
    const hint = container.querySelector(".modal-foot .foot-hint.mono")!;
    expect(hint.textContent).toBe("creates projects/…/");
    expect(hint.textContent).not.toContain("/data");
  });
});

describe("R15-5: ⌘K is one shortcut app-wide", () => {
  it("opens the palette from Home instead of focusing the project finder", () => {
    const { container } = renderHome(baseData([card()]));
    expect(container.querySelector("dialog.cmdk-card")).toBeNull();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(container.querySelector("dialog.cmdk-card")).toBeTruthy();
    // Home's own box keeps its honest, board-local job.
    expect(
      container.querySelector<HTMLInputElement>(".top-search input")!.placeholder,
    ).toBe("Find a project…");
  });

  it("leaves ⌥⌘K to the OS — Home used the shared hook's binding, not its own", () => {
    // Home carried a second copy of the topbar's keydown effect, matching on
    // metaKey||ctrlKey alone and so swallowing ⌥⌘K / Ctrl-Alt-K.
    const { container } = renderHome(baseData([card()]));
    fireEvent.keyDown(window, { key: "k", metaKey: true, altKey: true });
    expect(container.querySelector("dialog.cmdk-card")).toBeNull();
  });

  it("makes the shortcut chip the palette's affordance, not a label", () => {
    const { getByLabelText, container } = renderHome(baseData([card()]));
    const chip = getByLabelText("Search everything");
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);
    expect(container.querySelector("dialog.cmdk-card")).toBeTruthy();
  });
});

describe("F14: derived name-fields must not be typed INTO", () => {
  /* Typing a project name auto-fills the repo and the task key. Both are real
     input values, so clicking in put the caret after them and the next
     keystroke APPENDED — live this produced the repo name `viberrviberr`. */
  it("selects the derived repo value on focus so the first keystroke replaces it", () => {
    const { getAllByText, getByLabelText, getByPlaceholderText } = renderHome(
      baseData([card()]),
    );
    fireEvent.click(getAllByText("New project")[0]!.closest("button")!);
    fireEvent.change(getByPlaceholderText("e.g. Payments Gateway"), {
      target: { value: "Viberr" },
    });
    const repo = control(getByLabelText(/GitHub repository/), HTMLInputElement);
    expect(repo.value).toBe("viberr");

    repo.setSelectionRange(6, 6);
    fireEvent.focus(repo);
    expect(repo.selectionStart).toBe(0);
    expect(repo.selectionEnd).toBe("viberr".length);
    // …and the field says where the value came from, so the selection is not a
    // surprise.
    expect(fieldContains(repo, "from the project name (type to replace)")).toBe(
      true,
    );
  });

  it("stops selecting once the field holds the user's own value", () => {
    const { getAllByText, getByLabelText, getByPlaceholderText } = renderHome(
      baseData([card()]),
    );
    fireEvent.click(getAllByText("New project")[0]!.closest("button")!);
    fireEvent.change(getByPlaceholderText("e.g. Payments Gateway"), {
      target: { value: "Viberr" },
    });
    const repo = control(getByLabelText(/GitHub repository/), HTMLInputElement);
    fireEvent.change(repo, { target: { value: "viberr-app" } });
    repo.setSelectionRange(10, 10);
    fireEvent.focus(repo);
    expect(repo.selectionStart).toBe(10);
    expect(repo.selectionEnd).toBe(10);
  });

  it("applies the same rule to the derived task key", () => {
    const { getAllByText, getByLabelText, getByPlaceholderText } = renderHome(
      baseData([card()]),
    );
    fireEvent.click(getAllByText("New project")[0]!.closest("button")!);
    fireEvent.change(getByPlaceholderText("e.g. Payments Gateway"), {
      target: { value: "Viberr" },
    });
    const key = control(getByLabelText(/Task key/), HTMLInputElement);
    expect(key.value).toBe("VIB");
    // Put the caret where a click would leave it — after the derived text.
    key.setSelectionRange(3, 3);
    fireEvent.focus(key);
    expect(key.selectionStart).toBe(0);
    expect(key.selectionEnd).toBe(3);
  });
});

/** True when `text` appears anywhere in the input's own `.field` block. */
function fieldContains(input: HTMLInputElement, text: string): boolean {
  return Boolean(input.closest(".field")?.textContent?.includes(text));
}

describe("F13: the home footer says what it is", () => {
  it("frames the two store actions as admin-only maintenance", () => {
    const { container } = renderHome(baseData([card()]));
    const strip = container.querySelector(".store-strip")!;
    expect(strip.textContent).toContain("Store maintenance");
    expect(strip.textContent).toContain("admins only");
    // The reassurance an admin needs BEFORE clicking, not in a tooltip.
    expect(strip.textContent).toContain("Neither action edits a task file");
  });

  it("F18-5: names the data-root writer for an admin so one writer is visible", () => {
    const { container } = renderHome({
      ...baseData([card()]),
      lockHolder: { pid: 4242, hostname: "viberr-app-1", startedAt: "2026-08-05T00:00:00.000Z" },
    });
    const strip = container.querySelector(".store-strip")!;
    expect(strip.textContent).toContain("Writer: pid 4242 on viberr-app-1");
  });

  it("routes the projection rebuild through a confirmation", () => {
    const { container, getByText } = renderHome(baseData([card()]));
    expect(container.querySelector("dialog.confirm-card")).toBeNull();
    fireEvent.click(getByText("Rebuild projections…").closest("button")!);
    const dialog = container.querySelector("dialog.confirm-card")!;
    expect(dialog.textContent).toContain("Rebuild all projections?");
    // Named by its title, and labelled for tests and agents (surfaces.md §4).
    // It stays hand-written under ruling 457 (ruling 458's 2026-09-24 note).
    expect(dialog.getAttribute("aria-labelledby")).toBe("rebuild-confirm-title");
    expect(dialog.querySelector("#rebuild-confirm-title")!.textContent).toBe(
      "Rebuild all projections?",
    );
    expect(dialog.getAttribute("data-screen-label")).toBe("Rebuild projections dialog");
    expect(Array.from(dialog.querySelectorAll("p"), (p) => p.textContent)).toEqual([
      "Drops every derived board/task row and re-projects the whole store from the files on disk. Nothing is lost: task files, repositories and pull requests are never touched, and every row here is rebuilt from them.",
      "This is a recovery action. Day-to-day drift only needs Re-scan store. Use it when the board disagrees with the files.",
    ]);
    // Honest about the blast radius in both directions.
    expect(dialog.textContent).toContain("Drops every derived board/task row");
    expect(dialog.textContent).toContain("never touched");
  });

  // Ruling 368: the rebuild in flight shows itself on its trigger (busy, the
  // loader spinning, "Rebuilding…") and cannot be pressed again: it used to
  // stay live and reopen its confirm while the rebuild it had started ran.
  // Canary: drop `disabled={rebuilding}` from the strip's Rebuild button.
  it("ruling 368: a rebuild in flight is busy on its trigger and does not reopen the confirm", async () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <HomePage data={baseData([card()])} theme="system" />
          </ToastProvider>
        ),
        // Never answers: the test reads the wait itself.
        action: () => new Promise(() => {}),
      },
    ]);
    const { container, getByText } = render(<Stub initialEntries={["/"]} />);
    const trigger = getByText("Rebuild projections…").closest("button")!;
    fireEvent.click(trigger);
    fireEvent.click(
      within(container.querySelector("dialog.confirm-card")!).getByText("Rebuild projections"),
    );
    await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("true"));
    expect(trigger.textContent).toBe("Rebuilding…");
    expect(trigger.disabled).toBe(true);
    expect(trigger.querySelector("svg.ico.spin")).not.toBeNull();
    fireEvent.click(trigger);
    expect(container.querySelector("dialog.confirm-card")).toBeNull();
    // Re-scan is its own request, at rest.
    const rescan = getByText("Re-scan store").closest("button")!;
    expect(rescan.hasAttribute("aria-busy")).toBe(false);
  });

  it("hides both actions from a non-admin (they are 403 server-side)", () => {
    const data = baseData([card()]);
    const { container } = renderHome({
      ...data,
      user: { ...data.user, role: "member" },
    });
    expect(container.querySelector(".store-strip")).toBeNull();
  });
});

/**
 * Interface review 2026-09-24 (writ-2): files the re-scan could not project were
 * added into "N changed" and toasted with the success tick, in copy assembled
 * from fragments ("1 project dirs, no drift found").
 */
describe("writ-2: the re-scan toast tells a failure from a sync", () => {
  function rescanWith(result: {
    ok: boolean;
    projects?: number;
    changed?: number;
    removed?: number;
    errors?: number;
  }) {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <ToastProvider>
            <HomePage data={baseData([card()])} theme="system" />
          </ToastProvider>
        ),
        action: () => result,
      },
    ]);
    const view = render(<Stub initialEntries={["/"]} />);
    fireEvent.click(view.getByText("Re-scan store").closest("button")!);
    return view;
  }

  async function toast(container: HTMLElement): Promise<Element> {
    await waitFor(() => expect(container.querySelector(".toast")).not.toBeNull());
    return container.querySelector(".toast")!;
  }

  it("names unreadable files as an error, with the way out", async () => {
    const { container } = rescanWith({
      ok: true,
      projects: 3,
      changed: 1,
      removed: 0,
      errors: 2,
    });
    const t = await toast(container);
    expect(t.textContent).toContain(
      "Re-scan finished, but 2 files could not be read. The server log names each one. Fix them and re-scan.",
    );
    expect(t.getAttribute("data-kind")).toBe("error");
  });

  it("says nothing changed, with agreeing nouns, on a clean sync", async () => {
    const { container } = rescanWith({
      ok: true,
      projects: 1,
      changed: 0,
      removed: 0,
      errors: 0,
    });
    const t = await toast(container);
    expect(t.textContent).toContain("Store re-scanned: 1 project, nothing changed");
    expect(t.getAttribute("data-kind")).toBe("success");
  });

  it("counts updated files without the unreadable ones", async () => {
    const { container } = rescanWith({
      ok: true,
      projects: 3,
      changed: 1,
      removed: 1,
      errors: 0,
    });
    const t = await toast(container);
    expect(t.textContent).toContain("Store re-scanned: 3 projects, 2 files updated");
  });
});

describe("F12: counts and their nouns agree", () => {
  it("says '1 user' / '1 connection' / '1 knowledge base' at one", () => {
    const data = baseData([card()]);
    const { container } = renderHome({
      ...data,
      org: {
        ...data.org,
        connectionOwners: ["akin-ozer"],
        users: { total: 1, admins: 1, members: 0, disabled: 0, first: [] },
        globalAgents: 1,
        knowledgeBases: 1,
        mcpServers: 1,
        skills: 1,
      },
    });
    const tiles = container.querySelector(".org-tiles")!.textContent!;
    expect(tiles).toContain("1 connection");
    expect(tiles).not.toContain("1 connections");
    expect(tiles).toContain("1 user");
    expect(tiles).not.toContain("1 users");
    expect(tiles).toContain("1 agent profile");
    expect(tiles).toContain("1 knowledge base ·");
    expect(tiles).toContain("1 MCP server ·");
    expect(tiles).toContain("1 skill");
    expect(tiles).not.toContain("knowledge bases");
    expect(tiles).not.toContain("1 skills");
  });
});

describe("U33-2: an unreachable repository has a home on the project card", () => {
  /**
   * The card and the row are rendered DIRECTLY rather than through `renderHome`:
   * `HomeProjectCard` carries no repo-reachability fact yet, so `HomePage` has
   * nothing to hand down. These pin the presentation the loader will feed once
   * the fact is persisted (see the pass report) — and pin, today, that an
   * absent fact renders as silence rather than as health.
   */
  function renderPiece(node: ReactNode) {
    const Stub = createRoutesStub([{ path: "/", Component: () => <>{node}</> }]);
    return render(<Stub initialEntries={["/"]} />);
  }

  const repoLine = (container: HTMLElement) =>
    container.querySelector(".pj-name .repo")!;

  const noop = () => {};

  it("U39-20: renders the description's inline format instead of printing the marks", () => {
    // CANARY: render `p.desc` as plain text again.
    const { container } = renderPiece(
      <ProjectCard
        p={card({ desc: "A working Go clone of Google's `ax` (github.com/google/ax): a **declarative** tool." })}
        starred={false}
        onStar={noop}
        showDesc
      />,
    );
    const desc = container.querySelector(".pj-desc")!;
    expect(desc.querySelector("code.mono")?.textContent).toBe("ax");
    expect(desc.querySelector("strong")?.textContent).toBe("declarative");
    expect(desc.textContent).not.toContain("`");
  });

  it("leaves the repo line alone when no caller carries the fact", () => {
    const { container } = renderPiece(
      <ProjectCard p={card()} starred={false} onStar={noop} />,
    );
    expect(repoLine(container).textContent).toBe("akin-ozer/viberr");
    expect(repoLine(container).querySelector(".pill")).toBeNull();
  });

  it("marks the repository GitHub cannot find, in the GitHub page's words", () => {
    const { container } = renderPiece(
      <ProjectCard
        p={card({ repo: "akin-ozer/sandbox" })}
        starred={false}
        onStar={noop}
        repoAccess={{ status: "repo_not_found", repo: "akin-ozer/sandbox" }}
      />,
    );
    const line = repoLine(container);
    // The repo stays legible beside the verdict: the autocompleted name IS the
    // thing the reader has to notice.
    expect(line.textContent).toContain("akin-ozer/sandbox");
    const pill = line.querySelector(".pill")!;
    expect(pill.textContent).toBe("repo not found");
    // `risk`, the same kind the GitHub view's Connection row draws.
    expect(pill.className).toContain("risk");
    // Not a link: the whole card is already one anchor, so the pointer at the
    // repair rides on the title instead.
    expect(line.querySelector("a")).toBeNull();
    expect(line.querySelector("[title]")!.getAttribute("title")).toContain(
      "GitHub page",
    );
  });

  it("carries the same fact in the list row", () => {
    const { container } = renderPiece(
      <ProjectRow
        p={card({ repo: "akin-ozer/sandbox" })}
        starred={false}
        onStar={noop}
        repoAccess={{ status: "repo_not_found", repo: "akin-ozer/sandbox" }}
      />,
    );
    expect(repoLine(container).querySelector(".pill")!.textContent).toBe(
      "repo not found",
    );
  });

  it("stays quiet when GitHub serves the repository", () => {
    const { container } = renderPiece(
      <ProjectCard
        p={card()}
        starred={false}
        onStar={noop}
        repoAccess={{
          status: "connected",
          repo: "akin-ozer/viberr",
          remoteDefaultBranch: "main",
          private: true,
        }}
      />,
    );
    expect(repoLine(container).querySelector(".pill")).toBeNull();
  });

  it("stays quiet while GitHub itself is unreachable, and for no repo at all", () => {
    // Transient, and not evidence about the repository; and a project with no
    // repository already says so on this very line.
    const offline = renderPiece(
      <ProjectCard
        p={card()}
        starred={false}
        onStar={noop}
        repoAccess={{ status: "network_unavailable", repo: "akin-ozer/viberr" }}
      />,
    );
    expect(repoLine(offline.container).querySelector(".pill")).toBeNull();
    cleanup();
    const none = renderPiece(
      <ProjectCard
        p={card({ repo: null })}
        starred={false}
        onStar={noop}
        repoAccess={{ status: "no_repo_configured" }}
      />,
    );
    expect(repoLine(none.container).textContent).toBe("no repository");
    expect(repoLine(none.container).querySelector(".pill")).toBeNull();
  });
});

describe("acce-8: the project link is named by what it shows", () => {
  // "Open X board" as an aria-label replaced the content, so a screen reader
  // never heard the repo, the task counts, "N waiting on you" or the last
  // update. Canary: restore the aria-label on either form.
  function renderPiece(node: ReactNode) {
    const Stub = createRoutesStub([{ path: "/", Component: () => <>{node}</> }]);
    return render(<Stub initialEntries={["/"]} />);
  }
  const p = card({ total: 3, dist: { impl: 3 }, waiting: 2 });

  it.each([
    ["card", <ProjectCard key="c" p={p} starred={false} onStar={() => {}} />],
    ["row", <ProjectRow key="r" p={p} starred={false} onStar={() => {}} />],
  ])("the %s link carries the project's state and hides only the initial", (_, node) => {
    const { container, getByRole } = renderPiece(node);
    const link = container.querySelector("a.pj-link")!;
    expect(link.hasAttribute("aria-label")).toBe(false);
    expect(container.querySelector(".pj-mark")!.getAttribute("aria-hidden")).toBe("true");
    expect(
      getByRole("link", { name: /^Viberr Core.*akin-ozer\/viberr.*3 tasks.*2 waiting on you/ }),
    ).toBe(link);
  });
});
