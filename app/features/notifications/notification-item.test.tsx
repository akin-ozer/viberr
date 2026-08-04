// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NotificationItem, type NotificationView } from "./notification-item";
import { StageMeter } from "~/features/home/project-cards";

afterEach(cleanup);

const todayIso = (() => {
  const d = new Date();
  d.setHours(9, 41, 0, 0);
  return d.toISOString();
})();

const base: NotificationView = {
  id: "n-142-packet",
  kind: "packet",
  ptype: "input",
  title: "Completion report — waiting on your acceptance",
  text: "Workspace attach implemented, **PR #318** open, validation green.",
  projectSlug: "viberr-core",
  projectName: "Viberr Core",
  taskKey: "VIB-142",
  occurredAt: todayIso,
  unread: true,
};

describe("NotificationItem (shared bell/page row)", () => {
  it("renders title, stripped text, meta line and the unread dot", () => {
    const { container } = render(
      <NotificationItem notification={base} onOpen={() => {}} />,
    );
    const item = container.querySelector(".ntf-item")!;
    expect(item.classList.contains("read")).toBe(false);
    expect(container.querySelector(".tt")!.textContent).toBe(base.title);
    // Markdown markers are stripped in the popover form.
    expect(container.querySelector(".tx")!.textContent).toContain("PR #318");
    expect(container.querySelector(".tx")!.textContent).not.toContain("**");
    expect(container.querySelector(".mt")!.textContent).toBe(
      "Viberr Core · VIB-142 · 09:41",
    );
    expect(container.querySelector(".unread-dot")).not.toBeNull();
    // Packet/input → completion palette.
    expect(container.querySelector(".pev-ico")!.classList.contains("act-completion")).toBe(true);
  });

  it("read rows get the read modifier and no dot; clicks bubble the record", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <NotificationItem
        notification={{ ...base, unread: false, ptype: "blocked" }}
        onOpen={onOpen}
      />,
    );
    const item = container.querySelector<HTMLButtonElement>(".ntf-item")!;
    expect(item.classList.contains("read")).toBe(true);
    expect(container.querySelector(".unread-dot")).toBeNull();
    expect(container.querySelector(".pev-ico")!.classList.contains("act-blocked")).toBe(true);
    item.click();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("StageMeter (per-project stages, ruling 15)", () => {
  const stages = [
    { id: "todo", name: "To do", color: "#a5a8b5" },
    { id: "doing", name: "In progress", color: "#7b61ff" },
    { id: "done", name: "Done", color: "#00b473" },
  ];

  it("renders flex-weighted segments for non-empty stages, done at 0.45 opacity", () => {
    const { container } = render(
      <StageMeter stages={stages} dist={{ todo: 2, done: 3 }} />,
    );
    const meter = container.querySelector(".pj-meter")!;
    const segments = meter.querySelectorAll("span");
    expect(segments.length).toBe(2); // "doing" has 0 tasks → no segment
    expect(meter.getAttribute("title")).toBe("2 to do · 0 in progress · 3 done");
    expect((segments[1] as HTMLElement).style.opacity).toBe("0.45");
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
