// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub, data, Outlet } from "react-router";
import { isThemePreference, type ThemePreference } from "~/server/theme/theme-cookie.server";
import { ToastProvider } from "~/ui/toast";
import { PROFILE_DATA } from "../../test-support/profile-data";
import Profile from "./profile";

/**
 * The Appearance panel's theme segment, as the route drives it. The page flips
 * at the press, but the root loader confirms the new value only when the
 * save's revalidation lands. The segment used to read that confirmed value, so
 * the old theme stayed selected while the page showed the new one, and
 * pressing the confirmed theme during the save was taken for a repeat (RU-1)
 * and dropped. Each save here is held at the server until the test releases it.
 */

afterEach(cleanup);

beforeEach(() => {
  document.documentElement.dataset.theme = "light";
});
afterEach(() => {
  delete document.documentElement.dataset.theme;
});

async function mountSaving({ refuse = false } = {}) {
  let saved: ThemePreference = "light";
  const posted: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      loader: () => ({ theme: saved, csrf: "csrf-token" }),
      Component: () => (
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      ),
      children: [
        { path: "profile", loader: () => ({ profile: PROFILE_DATA }), Component: Profile },
      ],
    },
    {
      path: "/prefs/theme",
      action: async ({ request }) => {
        const theme = String((await request.formData()).get("theme"));
        if (!isThemePreference(theme)) throw new Error(`not a theme: ${theme}`);
        posted.push(theme);
        await held;
        if (refuse) {
          return data({ ok: false, error: "Session expired. Reload the page." }, { status: 403 });
        }
        saved = theme;
        return { ok: true };
      },
    },
  ]);
  const view = render(<Stub initialEntries={["/profile"]} />);
  const segment = within(await view.findByRole("group", { name: "Theme" }));
  const selected = () =>
    segment
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);
  const page = () => document.documentElement.dataset.theme;
  return { ...view, segment, selected, page, posted, release, saved: () => saved };
}

describe("Profile: the theme segment shows the theme on screen", () => {
  it("selects the choice a save is carrying, before the loader confirms it", async () => {
    const { segment, selected, page, posted, release, findByText, saved } = await mountSaving();
    expect(selected()).toEqual(["Light"]);
    fireEvent.click(segment.getByRole("button", { name: "Dark" }));
    // CANARY: hand the page the loader's `theme` and this stays on Light.
    expect(selected()).toEqual(["Dark"]);
    expect(page()).toBe("dark");
    await waitFor(() => expect(posted).toEqual(["dark"]));
    act(release);
    await findByText("Theme · Dark");
    expect(saved()).toBe("dark");
    expect(selected(), "confirmed").toEqual(["Dark"]);
  });

  it("pressing the confirmed theme while another is saving is a change back, not a repeat", async () => {
    const { segment, selected, page, posted, release, findByText, saved } = await mountSaving();
    fireEvent.click(segment.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(posted).toEqual(["dark"]));
    fireEvent.click(segment.getByRole("button", { name: "Light" }));
    // CANARY: compare the press with the loader's `theme` and Light is dropped.
    await waitFor(() => expect(posted).toEqual(["dark", "light"]));
    expect(selected()).toEqual(["Light"]);
    expect(page()).toBe("light");
    act(release);
    await findByText("Theme · Light");
    expect(saved()).toBe("light");
    expect(selected()).toEqual(["Light"]);
  });

  it("a refused save puts the segment and the page back on the confirmed theme", async () => {
    const { segment, selected, page, release, findByText } = await mountSaving({ refuse: true });
    fireEvent.click(segment.getByRole("button", { name: "Dark" }));
    expect(selected()).toEqual(["Dark"]);
    act(release);
    await findByText("Session expired. Reload the page.");
    expect(selected()).toEqual(["Light"]);
    expect(page()).toBe("light");
  });
});
