// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useFreshMessageIds } from "./use-fresh-messages";

afterEach(cleanup);

/**
 * The entry-motion rule the dock and the controller page share (ruling 121,
 * ruling 451(d)): a message is fresh only if it arrived while its conversation
 * was already on screen.
 */
describe("useFreshMessageIds", () => {
  const m = (id: string) => ({ id });

  it("never marks history, marks an arrival once, and settles a switched thread", () => {
    const { result, rerender } = renderHook(
      ({ messages, conversationId }) => useFreshMessageIds(messages, conversationId),
      { initialProps: { messages: [m("a"), m("b")], conversationId: "cnv_1" } },
    );
    // CANARY: return every unseen id on the first render and the whole history
    // animates in on every page load.
    expect([...result.current]).toEqual([]);
    rerender({ messages: [m("a"), m("b"), m("c")], conversationId: "cnv_1" });
    expect([...result.current]).toEqual(["c"]);
    // The next refresh brings nothing new: "c" has settled.
    rerender({ messages: [m("a"), m("b"), m("c")], conversationId: "cnv_1" });
    expect([...result.current]).toEqual([]);
    // Another thread's history is history too, however new to this hook.
    rerender({ messages: [m("x"), m("y")], conversationId: "cnv_2" });
    expect([...result.current]).toEqual([]);
    rerender({ messages: [m("x"), m("y"), m("z")], conversationId: "cnv_2" });
    expect([...result.current]).toEqual(["z"]);
  });
});
