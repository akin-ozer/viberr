// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NotificationItem, type NotificationView } from "./notification-item";

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
  // The literal shape `operatorOpenPacket` writes for a non-blocked packet
  // (operator-actions.server.ts) — every packet row's title is "Decision
  // needed: …", which is what made the old "completion" treatment self-contradictory.
  title: "Decision needed: which scope should we take?",
  text: "Workspace attach implemented, **PR #318** open, validation green.",
  projectSlug: "viberr-core",
  projectName: "Viberr Core",
  href: "/projects/viberr-core/tasks/VIB-142",
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
    // F19-24: packet/input → the INPUT palette, not the completion one. This
    // branch used to draw `act-completion` (a completion checkmark) on every
    // non-blocked packet, so an operator's scoping question wore the visual
    // vocabulary of something to accept.
    const ico = container.querySelector(".pev-ico")!;
    expect(ico.classList.contains("act-completion")).toBe(false);
    expect(ico.classList.contains("act-policy")).toBe(true);
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
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n-142-packet" }));
  });
});
