// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub, useFetcher } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { DEFAULT_NOTIF_PREFS } from "./notification-prefs";
import { ProfilePage, type ProfileData } from "./profile-page";

afterEach(cleanup);

const BASE: ProfileData = {
  user: {
    id: "u_arda",
    name: "Arda Kaya",
    title: "Senior engineer",
    email: "arda@viberr.dev",
    idp: "local",
    createdAt: "2026-02-18T09:00:00.000Z",
    avatarTone: "",
    hasPassword: true,
    githubConnected: false,
    githubHandle: null,
  },
  memberships: [{ slug: "viberr-core", name: "Viberr Core", role: "maintainer" }],
  accessRole: "maintainer",
  prefs: { notifs: DEFAULT_NOTIF_PREFS, motion: "full", tlDefault: "all" },
};

let lastSubmit: Record<string, string> | null = null;
let lastTheme: string | null = null;

function renderProfile(data: ProfileData = BASE) {
  lastSubmit = null;
  lastTheme = null;
  const Stub = createRoutesStub([
    {
      path: "/profile",
      Component: () => {
        const identity = useFetcher();
        const prefs = useFetcher();
        const password = useFetcher();
        const github = useFetcher();
        return (
          <ToastProvider>
            <ProfilePage
              data={data}
              theme="system"
              onTheme={(v) => {
                lastTheme = v;
              }}
              fetchers={
                { identity, prefs, password, github } as never
              }
              submitWith={() => (fields) => {
                lastSubmit = fields;
              }}
            />
          </ToastProvider>
        );
      },
    },
  ]);
  return render(<Stub initialEntries={["/profile"]} />);
}

describe("ProfilePage", () => {
  it("renders header, identity fields and membership facts", () => {
    const { getByText, getByDisplayValue, container } = renderProfile();
    expect(getByText("Profile & preferences")).toBeTruthy();
    expect(
      getByText(
        "Personal to your account — project policy and roles stay in Policy",
      ),
    ).toBeTruthy();
    expect(getByDisplayValue("Arda Kaya")).toBeTruthy();
    expect(getByDisplayValue("Senior engineer")).toBeTruthy();
    const email = getByDisplayValue("arda@viberr.dev") as HTMLInputElement;
    expect(email.disabled).toBe(true);
    // Membership facts + role pill + sign-in method.
    expect(getByText("Member of")).toBeTruthy();
    expect(getByText("Viberr Core")).toBeTruthy();
    expect(getByText("local account")).toBeTruthy();
    expect(container.querySelector(".avatar.xl")!.textContent).toBe("AK");
  });

  it("identity blur-commit only fires when dirty", () => {
    const { getByDisplayValue } = renderProfile();
    const name = getByDisplayValue("Arda Kaya");
    fireEvent.blur(name); // untouched → no submit (fix over the mock)
    expect(lastSubmit).toBeNull();
    fireEvent.change(name, { target: { value: "Arda K." } });
    fireEvent.blur(name);
    expect(lastSubmit).toEqual({
      intent: "identity",
      name: "Arda K.",
      title: "Senior engineer",
    });
  });

  it("renders the 5 notification routing rows with app toggles that post", () => {
    const { container, getByText } = renderProfile();
    expect(getByText("Notification routing")).toBeTruthy();
    const rows = container.querySelectorAll(".pref-row");
    // 5 routing rows + 3 appearance rows.
    expect(rows).toHaveLength(8);
    const toggles = container.querySelectorAll(".tgl[role='switch']");
    // 5 category toggles + reduce motion.
    expect(toggles).toHaveLength(6);

    const packets = container.querySelector(
      ".tgl[aria-label='Decision packets for you']",
    )!;
    expect(packets.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(packets);
    expect(lastSubmit).toEqual({
      intent: "set-notif",
      category: "packets",
      on: "0",
    });
    expect(getByText("Decision packets for you notifications off")).toBeTruthy();
  });

  it("MOUNTS the Appearance panel: theme seg, reduce motion, timeline default", () => {
    const { getByText, container } = renderProfile();
    expect(getByText("Appearance & workspace")).toBeTruthy();

    fireEvent.click(getByText("Dark"));
    expect(lastTheme).toBe("dark");

    const motion = container.querySelector(".tgl[aria-label='Reduce motion']")!;
    fireEvent.click(motion);
    expect(lastSubmit).toEqual({ intent: "set-motion", motion: "reduce" });
    expect(document.documentElement.dataset.motion).toBe("reduce");
    expect(
      getByText("Motion reduced — pulses and animation paused"),
    ).toBeTruthy();

    fireEvent.click(getByText("Important"));
    expect(lastSubmit).toEqual({ intent: "set-tl-default", tlDefault: "typed" });
    expect(getByText("Timeline opens on “Important”")).toBeTruthy();
  });

  it("Your access renders the shared RBAC table for the REAL role", () => {
    const { container, getByText } = renderProfile();
    expect(getByText("Your access")).toBeTruthy();
    // Maintainer holds 8 of 11 rows (all but release-any-owner, manage
    // members, and edit workflow/policy).
    expect(container.querySelectorAll(".rbac-yes")).toHaveLength(8);
    expect(container.querySelectorAll(".rbac-no")).toHaveLength(3);
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Policy → Human access")).toBeTruthy();
  });

  it("GitHub identity: not-connected card with missing chips and a real Connect link", () => {
    const { container, getByText } = renderProfile();
    expect(getByText("GitHub identity")).toBeTruthy();
    expect(getByText("not connected")).toBeTruthy();
    expect(container.querySelectorAll(".scope-chip.miss")).toHaveLength(2);
    expect(container.querySelector(".cred-warn")).toBeTruthy();
    const connect = container.querySelector(".cred-warn a.btn") as HTMLAnchorElement;
    expect(connect.getAttribute("href")).toBe("/auth/github?returnTo=/profile");
  });

  it("GitHub identity: connected card offers Disconnect", () => {
    const { container } = renderProfile({
      ...BASE,
      user: { ...BASE.user, githubConnected: true, idp: "github" },
    });
    expect(container.querySelector(".cred-ok")).toBeTruthy();
    expect(container.querySelectorAll(".scope-chip.miss")).toHaveLength(0);
    fireEvent.click(container.querySelector(".cred-ok button")!);
    expect(lastSubmit).toEqual({ intent: "github-disconnect" });
  });

  it("Change password panel: client-side validation copy before any submit", () => {
    const { container, getByText } = renderProfile();
    expect(getByText("Change password", { selector: "h2" })).toBeTruthy();
    const inputs = [...container.querySelectorAll("input[type='password']")];
    expect(inputs).toHaveLength(3);

    fireEvent.change(inputs[1]!, { target: { value: "short" } });
    fireEvent.change(inputs[2]!, { target: { value: "short" } });
    fireEvent.click(getByText("Change password", { selector: "button" }));
    expect(getByText("New password needs at least 8 characters.")).toBeTruthy();
    expect(lastSubmit).toBeNull();

    fireEvent.change(inputs[1]!, { target: { value: "long-enough-pw" } });
    fireEvent.change(inputs[2]!, { target: { value: "different-pw!!!" } });
    fireEvent.click(getByText("Change password", { selector: "button" }));
    expect(getByText("Passwords don't match.")).toBeTruthy();
    expect(lastSubmit).toBeNull();

    fireEvent.change(inputs[0]!, { target: { value: "current-pw-here" } });
    fireEvent.change(inputs[2]!, { target: { value: "long-enough-pw" } });
    fireEvent.click(getByText("Change password", { selector: "button" }));
    expect(lastSubmit).toEqual({
      intent: "change-password",
      current: "current-pw-here",
      next: "long-enough-pw",
      confirm: "long-enough-pw",
    });
  });

  it("hides the password panel for accounts without a local password", () => {
    const { queryByText } = renderProfile({
      ...BASE,
      user: { ...BASE.user, hasPassword: false },
    });
    expect(queryByText("Change password")).toBeNull();
  });

  it("degrades without memberships: empty access matrix, plain-text nav copy", () => {
    const { container, getByText } = renderProfile({
      ...BASE,
      memberships: [],
      accessRole: null,
    });
    expect(getByText("No project membership yet.")).toBeTruthy();
    expect(container.querySelectorAll(".rbac-yes")).toHaveLength(0);
    // Nav copy renders as plain text (no dead keybtn).
    expect(container.querySelector(".keybtn")).toBeNull();
  });
});
