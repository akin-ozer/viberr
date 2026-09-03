// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createRoutesStub, useFetcher } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { DEFAULT_NOTIF_PREFS } from "./notification-prefs";
import {
  ProfilePage,
  type ProfileActionData,
  type ProfileData,
} from "./profile-page";

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
  githubConfigured: true,
  // Ruling 127: the viewer's own agent accounts, neither connected.
  backends: [
    {
      backend: "claude",
      health: {
        backend: "claude",
        userId: "u_arda",
        available: false,
        kind: null,
        method: null,
        verification: "none",
        secretSuffix: null,
        verifiedAt: null,
        connectedAt: null,
        detail:
          "Claude isn't connected. Connect it on your Profile → Agent accounts.",
      },
      login: null,
      methods: { signIn: ["claudeai", "console"], paste: ["api_key"] },
    },
    {
      backend: "codex",
      health: {
        backend: "codex",
        userId: "u_arda",
        available: false,
        kind: null,
        method: null,
        verification: "none",
        secretSuffix: null,
        verifiedAt: null,
        connectedAt: null,
        detail:
          "Codex isn't connected. Connect it on your Profile → Agent accounts.",
      },
      login: null,
      methods: { signIn: ["device"], paste: ["api_key", "access_token"] },
    },
  ],
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
        const identity = useFetcher<ProfileActionData>();
        const prefs = useFetcher<ProfileActionData>();
        // UI-56: Appearance has its own fetcher now (one per panel).
        const appearance = useFetcher<ProfileActionData>();
        const password = useFetcher<ProfileActionData>();
        const github = useFetcher<ProfileActionData>();
        const backends = useFetcher<ProfileActionData>();
        return (
          <ToastProvider>
            <ProfilePage
              data={data}
              theme="system"
              onTheme={(v) => {
                lastTheme = v;
              }}
              fetchers={{
                identity,
                prefs,
                appearance,
                password,
                github,
                backends,
              }}
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

/** The GitHub identity panel alone. Several of its assertions name classes the
 *  Agent accounts panel (ruling 127) also uses, and a page-wide query would
 *  read that panel's state as this one's. */
function githubPanel(getByText: (text: string) => HTMLElement): HTMLElement {
  return getByText("GitHub identity").closest(".panel")!;
}

describe("ProfilePage", () => {
  it("renders header, identity fields and membership facts", () => {
    const { getByText, getByDisplayValue, container } = renderProfile();
    expect(getByText("Profile & preferences")).toBeTruthy();
    expect(
      getByText(
        "Personal to your account. Project policy and roles stay in Policy",
      ),
    ).toBeTruthy();
    expect(getByDisplayValue("Arda Kaya")).toBeTruthy();
    expect(getByDisplayValue("Senior engineer")).toBeTruthy();
    const email = getByDisplayValue("arda@viberr.dev").closest("input")!;
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

  it("renders the 6 notification routing rows with app toggles that post", () => {
    const { container, getByText, queryByText } = renderProfile();
    expect(getByText("Notification routing")).toBeTruthy();
    const rows = container.querySelectorAll(".pref-row");
    // 6 routing rows (controller joined, ruling 99) + 3 appearance rows.
    expect(rows).toHaveLength(9);
    const toggles = container.querySelectorAll(".tgl[role='switch']");
    // 6 category toggles + reduce motion.
    expect(toggles).toHaveLength(7);

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
    // P11-40: the confirmation toast is gated on the server RESULT now, not
    // fired optimistically on submit — a failed POST must not report success.
    // (The stubbed submit never resolves the fetcher, so no toast appears.)
    expect(queryByText("Decision packets for you notifications off")).toBeNull();
  });

  it("MOUNTS the Appearance panel: theme seg, reduce motion, timeline default", () => {
    const { getByText, queryByText, container } = renderProfile();
    expect(getByText("Appearance & workspace")).toBeTruthy();

    // G5: the theme segmented control carries `aria-pressed`, not color alone.
    const themeSeg = getByText("System").closest(".mini-seg")!;
    expect(themeSeg.getAttribute("role")).toBe("group");
    expect(getByText("System").getAttribute("aria-pressed")).toBe("true"); // stub theme="system"
    expect(getByText("Light").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByText("Dark"));
    expect(lastTheme).toBe("dark");

    // UI-31: REWRITTEN — this asserted the bug. The toast fired synchronously at
    // SUBMIT time, before the server answered, and no handler ever read the
    // `set-motion` / `set-tl-default` result (the shared handler early-returned
    // unless the intent was `set-notif`), so a failure produced no error, no
    // rollback of the toggle and no rollback of `data-motion`. The optimistic
    // DOM/local flip still happens (it must, for a snappy pref), but the toast
    // now settles on the result — with this fake `submitWith` nothing ever
    // resolves, so no toast is the CORRECT observation here.
    const motion = container.querySelector(".tgl[aria-label='Reduce motion']")!;
    fireEvent.click(motion);
    expect(lastSubmit).toEqual({ intent: "set-motion", motion: "reduce" });
    expect(document.documentElement.dataset.motion).toBe("reduce");
    expect(queryByText("Motion reduced. Pulses and animation paused")).toBeNull();

    fireEvent.click(getByText("Important"));
    expect(lastSubmit).toEqual({ intent: "set-tl-default", tlDefault: "typed" });
    expect(queryByText("Timeline opens on “Important”")).toBeNull();
  });

  it("Your access renders the shared RBAC table for the REAL role", () => {
    const { container, getByText } = renderProfile();
    expect(getByText("Your access")).toBeTruthy();
    // Maintainer holds 14 of the 19 rows — all but the 5 admin-only actions
    // (release-any-owner, manage members, manage agent profiles, edit workflow/
    // policy, and force-accept past the review gate) — the total table (R8-2)
    // surfaces every enforced action. edit-task-meta (contributor+) is one of
    // the 14.
    expect(container.querySelectorAll(".rbac-yes")).toHaveLength(14);
    expect(container.querySelectorAll(".rbac-no")).toHaveLength(5);
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Policy → Human access")).toBeTruthy();
  });

  it("mounts Agent accounts in the right column ABOVE GitHub identity (ruling 127)", () => {
    const { container, getByText, getAllByText } = renderProfile();
    expect(getByText("Agent accounts")).toBeTruthy();
    // Both backends read "Not connected" on a fresh account.
    expect(getAllByText(/Not connected\. Runs on tasks you own/)).toHaveLength(2);
    // Order within the right column: the panel that decides whether this
    // person's agents can run at all comes before the attribution card.
    const headings = [...container.querySelectorAll(".profile-col")][1]!;
    const titles = [...headings.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titles.indexOf("Agent accounts")).toBeLessThan(
      titles.indexOf("GitHub identity"),
    );
  });

  it("GitHub identity: not-connected card with missing chips and a real Connect button", () => {
    const { getByText } = renderProfile();
    expect(getByText("GitHub identity")).toBeTruthy();
    expect(getByText("not connected")).toBeTruthy();
    // Ruling 127: `.cred-warn` is no longer unique to this panel — the Agent
    // accounts cards above it use the same class for their unconnected state —
    // so these assertions are scoped to the GitHub panel rather than the page.
    const github = githubPanel(getByText);
    expect(github.querySelectorAll(".scope-chip.miss")).toHaveLength(2);
    expect(github.querySelector(".cred-warn")).toBeTruthy();
    // MU-1: Connect starts the real OAuth flow via a button (POST to
    // /api/auth/sign-in/social), not a dead /auth/github link.
    const connect = github.querySelector<HTMLButtonElement>(
      ".cred-warn button.btn",
    )!;
    expect(connect).toBeTruthy();
    expect(connect.textContent).toContain("Connect");
    expect(github.querySelector(".cred-warn a.btn")).toBeNull();
  });

  it("F18-3: GitHub identity is a quiet one-liner (no warn chips, no Connect) when OAuth is unconfigured", () => {
    const { getByText } = renderProfile({
      ...BASE,
      githubConfigured: false,
      user: { ...BASE.user, githubConnected: false },
    });
    expect(getByText("GitHub identity")).toBeTruthy();
    // No doomed Connect affordance, no warn scope chips — in THIS panel.
    const github = githubPanel(getByText);
    expect(github.querySelector(".cred-warn")).toBeNull();
    expect(github.querySelectorAll(".scope-chip.miss")).toHaveLength(0);
    expect(getByText(/GitHub sign-in isn't configured on this deployment/)).toBeTruthy();
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
    expect(getByText(/No project membership yet/)).toBeTruthy();
    expect(container.querySelectorAll(".rbac-yes")).toHaveLength(0);
    // Nav copy renders as plain text (no dead keybtn).
    expect(container.querySelector(".keybtn")).toBeNull();
  });
});
