// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { PacketRender } from "~/shared/mapping/task.server";
import { DecisionPacket } from "./decision-packet";

/**
 * Ruling 672: the operator's repository question on the task page. Its two
 * answers decide the board, so they take the board's tier, and connecting one
 * takes the repository as the person's typed answer.
 */

afterEach(cleanup);

const QUESTION: PacketRender = {
  type: "input",
  kind: "Decision required",
  from: "Operator",
  title: "Connect a repository to Viberr Core?",
  body: "VIB-1 changes the checkout page, whose code this board has no repository for.",
  observations: [],
  options: [
    {
      kind: "connect_repository",
      t: "Connect a repository",
      d: "Type it as owner/name. Viberr checks it on GitHub and attaches it.",
      rec: true,
      reply: true,
      repo: "acme/site",
    },
    { kind: "keep_without_repository", t: "Keep this board without one", d: "Tasks keep coming back as files.", rec: false },
  ],
};

function renderQuestion(
  packet: PacketRender,
  canEditPolicy: boolean,
  onResolve: (i: number, note: string) => void = () => {},
  onRequestMaintainer?: () => void,
) {
  return render(
    <DecisionPacket
      packet={packet}
      busy={false}
      canResolve
      canResolveCompletion
      canEditGoal
      canArchive
      canEditPolicy={canEditPolicy}
      onResolveCustom={() => {}}
      onResolve={onResolve}
      onAsk={() => {}}
      {...(onRequestMaintainer ? { onRequestMaintainer } : {})}
    />,
  );
}

const radios = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLButtonElement>('.options [role="radio"]'),
];
const confirmButton = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLButtonElement>(".packet-actions .btn.primary")].find((b) =>
    b.textContent?.includes("Confirm decision"),
  )!;
const box = (container: HTMLElement) => container.querySelector<HTMLTextAreaElement>("#pkt-note")!;
const boxLabel = (container: HTMLElement) => container.querySelector('label[for="pkt-note"]')!.textContent!;

describe("ruling 672: the repository question's card", () => {
  it("asks for the repository in the box, opened with the one the operator named, and sends what the person typed", () => {
    // CANARY: leave the box "Note for the operator · optional" and nothing
    // says where the repository goes; send the note state and Confirm
    // attaches an empty name.
    const onResolve = vi.fn();
    const { container } = renderQuestion(QUESTION, true, onResolve);
    expect(radios(container)[0]!.getAttribute("aria-checked")).toBe("true");
    expect(boxLabel(container)).toContain("Repository to connect");
    expect(boxLabel(container)).toContain("required · owner/name · checked on GitHub before anything changes");
    expect(box(container).value).toBe("acme/site");
    expect(box(container).placeholder).toBe("owner/name");

    fireEvent.change(box(container), { target: { value: "acme/checkout" } });
    fireEvent.click(confirmButton(container));
    expect(onResolve).toHaveBeenCalledWith(0, "acme/checkout");
  });

  it("refuses an empty repository in place, and keeps the repository out of the other answer's note", () => {
    // CANARY: share one text between the two answers and choosing "Keep this
    // board without one" records the repository's name as the person's note.
    const onResolve = vi.fn();
    const { options } = QUESTION;
    const unnamed = { ...QUESTION, options: [{ ...options[0]!, repo: undefined }, options[1]!] };
    const { container } = renderQuestion(unnamed, true, onResolve);
    expect(box(container).value).toBe("");
    fireEvent.click(confirmButton(container));
    expect(onResolve).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      "Enter the repository as owner/name first.",
    );

    fireEvent.change(box(container), { target: { value: "acme/site" } });
    fireEvent.click(radios(container)[1]!);
    expect(boxLabel(container)).toContain("Note for the operator");
    expect(boxLabel(container)).toContain("optional");
    expect(box(container).value).toBe("");
    fireEvent.click(confirmButton(container));
    expect(onResolve).toHaveBeenCalledWith(1, "");
    // Going back, the repository typed is still there.
    fireEvent.click(radios(container)[0]!);
    expect(box(container).value).toBe("acme/site");
  });

  it("is a project admin's to answer: both answers are inert for anyone else, and the card says who answers once", () => {
    // CANARY: drop either row from PACKET_TIER_GATES and a maintainer is
    // handed a Confirm the server refuses. Ruling 673: put a clause or a
    // hover title back on each answer, or print the selected one's refusal
    // beside the note, and the card names a project admin again and again;
    // drop `aria-describedby` and a screen reader on a dimmed answer hears no
    // reason at all.
    const onResolve = vi.fn();
    const { container } = renderQuestion(QUESTION, false, onResolve);
    const [connect, keep] = radios(container);
    for (const answer of [connect!, keep!]) {
      expect(answer.getAttribute("aria-disabled")).toBe("true");
      expect(answer.getAttribute("aria-describedby")).toBe("pkt-block-reason");
      expect(answer.textContent).not.toContain("project admin");
      expect(answer.getAttribute("title")).toBeNull();
    }
    expect(container.querySelector("#pkt-block-reason")!.textContent).toContain(
      "Both answers decide the board, so a project admin gives one.",
    );
    expect(container.textContent!.match(/project admin/g)).toHaveLength(1);
    const confirm = confirmButton(container);
    expect(confirm.getAttribute("aria-describedby")).toBe("pkt-block-reason");
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("tells whoever cannot answer it that a project admin does, and sends it to one", () => {
    // CANARY: keep the note written for a contributor-owner on a
    // maintainer's packet and a maintainer reads "needs maintainer or admin
    // authority" under two answers marked admin-only, beside a button that
    // sends it to people who cannot answer it either.
    const send = vi.fn();
    const { container, getByRole } = renderQuestion(QUESTION, false, () => {}, send);
    const note = [...container.querySelectorAll(".deny-note")].map((n) => n.textContent ?? "").join(" ");
    expect(note).toContain("Both answers decide the board, so a project admin gives one. You can still answer with your own directive above.");
    expect(note).not.toContain("maintainer or admin authority");
    fireEvent.click(getByRole("button", { name: "Send to a project admin" }));
    expect(send).toHaveBeenCalledOnce();
    cleanup();
    // A project admin has neither the note nor the button.
    const admin = renderQuestion(QUESTION, true, () => {}, send);
    expect(admin.container.textContent).not.toContain("a project admin gives one");
    expect(admin.queryByRole("button", { name: "Send to a project admin" })).toBeNull();
  });

  it("still says why a repository answer is refused on a packet that is not the question's own card", () => {
    // No writer in the app makes such a packet; a task file edited by hand
    // can. There the card has no note for both answers, so the selected one
    // prints its own refusal, as every other gated kind does. CANARY: drop
    // the kind's `denyNote` as text nobody reads and Confirm is refused there
    // in silence, described by an element that is not on the page.
    const { options } = QUESTION;
    const mixed: PacketRender = {
      ...QUESTION,
      options: [options[0]!, { kind: "custom", t: "Something else", d: "", rec: false }],
    };
    const onResolve = vi.fn();
    const { container } = renderQuestion(mixed, false, onResolve);
    expect(container.querySelector("#pkt-block-reason")!.textContent).toBe(
      "Connecting a repository to the board is reserved for project admins.",
    );
    const confirm = confirmButton(container);
    expect(confirm.getAttribute("aria-describedby")).toBe("pkt-block-reason");
    fireEvent.click(confirm);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("tells a person who resolves no packets that a project admin answers, not a maintainer or the task's owner", () => {
    // CANARY: keep the sentence every other packet shows and a viewer reads
    // that a maintainer or the task's owner can answer, under two answers
    // each marked as a project admin's.
    const { container } = render(
      <DecisionPacket
        packet={QUESTION}
        busy={false}
        canResolve={false}
        canResolveCompletion={false}
        canEditGoal={false}
        canArchive={false}
        onResolveCustom={() => {}}
        onResolve={() => {}}
        onAsk={() => {}}
      />,
    );
    const note = [...container.querySelectorAll(".deny-note")].map((n) => n.textContent ?? "").join(" ");
    expect(note).toContain(
      "You can\u2019t answer this decision: both answers decide the board, so a project admin gives one. You can still comment or ask the operator below.",
    );
    expect(note).not.toContain("owner can");
    // Ruling 673: said once here too, and each answer is described by it.
    expect(container.textContent!.match(/project admin/g)).toHaveLength(1);
    expect(container.querySelector("#pkt-block-reason")!.textContent).toContain("so a project admin gives one");
    for (const answer of radios(container)) {
      expect(answer.getAttribute("aria-describedby")).toBe("pkt-block-reason");
    }
  });
});
