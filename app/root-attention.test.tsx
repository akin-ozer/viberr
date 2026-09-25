// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import App from "./root";
import { MemoryStorage } from "../test-support/memory-storage";

/**
 * Ruling 481(c) (F40-51): root mounts the attention watcher for a signed-in
 * tab (a csrf token in root's data is the signed-in signal, as for the dock)
 * and for nobody else, so every signed-in page's title carries the count of
 * unread decisions. The watcher's own behaviour is `attention-watcher.test.tsx`.
 *
 * Canary: drop `<AttentionWatcherSlot />` from `App` and the title never
 * carries the count.
 */

let reads = 0;

function renderRoot(csrf: string | null) {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ theme: "system", csrf }),
      Component: App,
      // The profile page's id: the dock hides itself there, so this test
      // reads the watcher alone.
      children: [{ id: "routes/profile", index: true, Component: () => <p>Profile</p> }],
    },
  ]);
  render(<Stub initialEntries={["/"]} />);
}

beforeEach(() => {
  reads = 0;
  document.title = "Profile & preferences · Viberr";
  vi.stubGlobal("localStorage", new MemoryStorage());
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/resources/attention") reads += 1;
    return Response.json({ waiting: 3, items: [] });
  });
  vi.stubGlobal(
    "matchMedia",
    () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("root mounts the attention watcher (ruling 481)", () => {
  it("a signed-in tab's title counts the unread decisions", async () => {
    renderRoot("csrf-token");
    await waitFor(() => expect(document.title).toBe("(3) Profile & preferences · Viberr"));
    expect(reads).toBeGreaterThan(0);
  });

  it("a signed-out tab reads nothing", async () => {
    renderRoot(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(0);
    expect(document.title).toBe("Profile & preferences · Viberr");
  });
});
