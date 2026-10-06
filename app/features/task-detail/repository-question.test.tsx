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

  it("is a project admin's to answer: both answers are inert for anyone else, and each says who can", () => {
    // CANARY: drop either row from PACKET_TIER_GATES and a maintainer is
    // handed a Confirm the server refuses.
    const onResolve = vi.fn();
    const { container } = renderQuestion(QUESTION, false, onResolve);
    const [connect, keep] = radios(container);
    expect(connect!.textContent).toContain("your role can't connect one (a project admin must)");
    expect(keep!.textContent).toContain("your role can't decide this for the board (a project admin must)");
    expect(connect!.getAttribute("title")).toBe("Connecting a repository to the board is reserved for project admins");
    fireEvent.click(confirmButton(container));
    expect(onResolve).not.toHaveBeenCalled();
  });
});
