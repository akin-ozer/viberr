// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub, useFetcher } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { PROFILE_DATA as BASE } from "../../../test-support/profile-data";
import {
  ProfilePage,
  type ProfileActionData,
  type ProfileData,
} from "./profile-page";

afterEach(cleanup);

let lastSubmit: Record<string, string> | null = null;
let lastTheme: string | null = null;

function profileElement(data: ProfileData = BASE) {
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
  return <Stub initialEntries={["/profile"]} />;
}

function renderProfile(data: ProfileData = BASE) {
  return render(profileElement(data));
}

/** The GitHub identity panel alone. Several of its assertions name classes the
 *  Agent accounts panel (ruling 127) also uses, and a page-wide query would
 *  read that panel's state as this one's. */
function githubPanel(getByText: (text: string) => HTMLElement): HTMLElement {
  return getByText("GitHub identity").closest(".panel")!;
}

describe("ProfilePage", () => {
  it("renders header, identity fields and membership facts", () => {
    const { getByText, getAllByText, getByDisplayValue, container } = renderProfile();
    expect(getByText("Profile & preferences")).toBeTruthy();
    expect(
      getByText(
        "Personal to your account. Project policy and roles stay in Policy",
      ),
    ).toBeTruthy();
    expect(getByDisplayValue("Arda Kaya")).toBeTruthy();
    expect(getByDisplayValue("Senior engineer")).toBeTruthy();
    // Design pass 2026-09-08: the email is a fact row, not a disabled control
    // — nothing on this page can edit it, so nothing on this page is a field
    // for it. The row sits with the sign-in facts, and the governance
    // sentence (who CAN change it) is the panel's closing note.
    // The header prints the email too; the fact row is the one in a `.kv-row`.
    const email = getAllByText("arda@viberr.dev")
      .map((el) => el.closest(".kv-row"))
      .find((row) => row !== null)!;
    expect(email.querySelector(".k")!.textContent).toBe("Email");
    expect(container.querySelector("input#profile-email")).toBeNull();
    expect(container.textContent).toContain("An org admin can change your email");
    // Membership facts + role pill + sign-in method.
    expect(getByText("Member of")).toBeTruthy();
    expect(getByText("Viberr Core")).toBeTruthy();
    expect(getByText("local account")).toBeTruthy();
    expect(container.querySelector(".avatar.xl")!.textContent).toBe("AK");
  });

  it("C6: the Joined date hydrates safely — the UTC day first, the viewer's calendar date after hydration", () => {
    // The server pass depends on the timestamp alone: the SSR host's zone is
    // not the viewer's, and a calendar date rendered in it hydrates to
    // different text near midnight (React #418).
    const ssr = renderToString(profileElement());
    expect(ssr).toContain("Joined");
    expect(ssr).toContain("2026-02-18 (UTC)");
    expect(ssr).not.toContain("Feb 18, 2026");
    // After hydration the effect swaps in the viewer-local calendar date.
    const { getByText, container } = renderProfile();
    expect(getByText("Feb 18, 2026")).toBeTruthy();
    expect(container.textContent).not.toContain("(UTC)");
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

  it("renders the 8 notification routing rows with app toggles that post", () => {
    const { container, getByText, queryByText } = renderProfile();
    expect(getByText("Notification routing")).toBeTruthy();
    const rows = container.querySelectorAll(".pref-row");
    // 8 routing rows (controller joined, ruling 99; dependencies, ruling 131;
    // ownership, ruling 140) + 2 appearance rows (theme, timeline default —
    // ruling 148(c) removed the reduce-motion row).
    expect(rows).toHaveLength(10);
    const toggles = container.querySelectorAll(".tgl[role='switch']");
    // The 8 category toggles; nothing else on the page is a switch now.
    expect(toggles).toHaveLength(8);

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

  it("MOUNTS the Appearance panel: theme seg and timeline default (ruling 148(c): no motion toggle)", () => {
    const { getByText, queryByText, container } = renderProfile();
    expect(getByText("Appearance & workspace")).toBeTruthy();

    // G5: the theme segmented control carries `aria-pressed`, not color alone.
    const themeSeg = getByText("System").closest(".mini-seg")!;
    expect(themeSeg.getAttribute("role")).toBe("group");
    expect(getByText("System").getAttribute("aria-pressed")).toBe("true"); // stub theme="system"
    expect(getByText("Light").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(getByText("Dark"));
    expect(lastTheme).toBe("dark");

    // Ruling 148(c): the "Reduce motion" toggle is gone; the OS preference is
    // the one reduced-motion signal.
    expect(container.querySelector(".tgl[aria-label='Reduce motion']")).toBeNull();
    expect(queryByText("Reduce motion")).toBeNull();

    // UI-31: the toast settles on the result — with this fake `submitWith`
    // nothing ever resolves, so no toast is the CORRECT observation here.
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
    // Ruling 309(a): the same scope line the Policy table carries. This list is
    // the one a person reads about THEMSELVES, so a maintainer learning they
    // hold "Edit task priority, labels & due date" has to also learn that the
    // grant releases held tasks. CANARY: drop `covers` from RBAC_ROWS.
    expect(
      getByText("and what a task waits on, which releases it when cleared"),
    ).toBeTruthy();
    // Ruling 379 added the `attach-file` row (contributor and above), so a
    // maintainer holds one more.
    expect(container.querySelectorAll(".rbac-yes")).toHaveLength(15);
    expect(container.querySelectorAll(".rbac-no")).toHaveLength(5);
    // Ruling 148: each cell says the fact. The check is aria-hidden, so a
    // glyph-only pair announced nothing at all, and the denied "−" read as a
    // collapse control in the value slot.
    expect(container.querySelector(".rbac-yes")!.textContent).toContain("yes");
    expect(container.querySelector(".rbac-no")!.textContent).toBe("no");
    expect(container.textContent).not.toContain("−");
    expect(getByText("Release any task owner")).toBeTruthy();
    expect(getByText("Policy → Human access")).toBeTruthy();
  });

  it("mounts Agent accounts in the right column ABOVE GitHub identity (ruling 127)", () => {
    const { container, getByText, getAllByText } = renderProfile();
    expect(getByText("Agent accounts")).toBeTruthy();
    // Both backends read "Not connected" on a fresh account.
    expect(getAllByText(/Tasks you own and your controller conversations run on your own/)).toHaveLength(2);
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
    // Ruling 127: `.cred-warn` is no longer unique to this panel — the Agent
    // accounts cards above it use the same class for their unconnected state —
    // so these assertions are scoped to the GitHub panel rather than the page
    // (and "not connected" is now every unconnected card's badge, ruling 148).
    const github = githubPanel(getByText);
    expect(github.textContent).toContain("not connected");
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

  it("ruling 154: an admin-linked handle reads as such on an OAuth-less deployment, with no Connect", () => {
    const { getByText } = renderProfile({
      ...BASE,
      githubConfigured: false,
      user: { ...BASE.user, githubConnected: false, githubHandle: "arda-kaya" },
    });
    const github = githubPanel(getByText);
    expect(github.textContent).toContain("@arda-kaya · linked by an org admin");
    expect(github.textContent).toContain(
      "An org admin linked your GitHub handle, so your approvals on review pull requests count as the review verdict.",
    );
    expect(github.textContent).not.toContain("isn't configured on this deployment");
    // The person cannot change it here: no field, no Connect, no warn chips.
    expect(github.querySelector("input")).toBeNull();
    expect(github.querySelector(".cred-warn")).toBeNull();
  });

  // Ruling 154: the admin link is not confined to an OAuth-less deployment.
  // Where GitHub sign-in IS configured, an unconnected local or Google account
  // with a linked handle takes the cred-card branch, whose warning used to deny
  // the very capability the line above grants.
  it("ruling 154: a linked handle on a GitHub-configured deployment is not denied by the warning", () => {
    const { getByText } = renderProfile({
      ...BASE,
      githubConfigured: true,
      user: { ...BASE.user, githubConnected: false, githubHandle: "arda-kaya" },
    });
    const github = githubPanel(getByText);
    expect(github.textContent).toContain("@arda-kaya · linked by an org admin");
    expect(github.textContent).not.toContain("can't be matched back to you");
    expect(github.querySelector(".cred-warn")!.textContent).toContain(
      "already count as the review verdict",
    );
    // The Connect affordance stays: this person still has no OAuth identity.
    expect(github.querySelector(".cred-warn button.btn")!.textContent).toContain("Connect");
  });

  it("GitHub identity: connected card offers Disconnect", () => {
    const { container } = renderProfile({
      ...BASE,
      user: { ...BASE.user, githubConnected: true, idp: "github" },
    });
    expect(container.querySelector(".cred-ok")).toBeTruthy();
    expect(container.querySelectorAll(".scope-chip.miss")).toHaveLength(0);
    // Ruling 149: disconnecting an identity is destructive, so the control
    // carries the danger label. Canary: drop `danger` in `profile-page.tsx`.
    expect(
      Array.from(container.querySelector(".cred-ok button")!.classList),
    ).toContain("danger");
    fireEvent.click(container.querySelector(".cred-ok button")!);
    expect(lastSubmit).toEqual({ intent: "github-disconnect" });
  });

  it("ruling 148(b): Change password is a row on the Profile card whose button opens a modal", () => {
    const { container, getByText, queryByRole } = renderProfile();
    // No inline three-field form on the page, and no panel of its own.
    expect(container.querySelectorAll("input[type='password']")).toHaveLength(0);
    expect(queryByRole("heading", { name: "Change password" })).toBeNull();
    const row = getByText("Password").closest(".kv-row")!;
    // The row sits on the Profile card, under the sign-in facts.
    expect(row.closest(".panel")!.textContent).toContain("Signs in via");

    fireEvent.click(row.querySelector("button")!);
    const dialog = container.querySelector<HTMLDialogElement>("dialog.modal-card")!;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-label")).toBe("Change password");
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("input[type='password']")];
    expect(inputs).toHaveLength(3);
    const save = dialog.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!;
    expect(save.textContent).toBe("Change password");

    // Ruling 147: enabled on an incomplete form, and a submit is REFUSED with
    // the first empty field marked and focused, no request made.
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(lastSubmit).toBeNull();
    expect(inputs[0]!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(inputs[0]);
    expect(dialog.querySelector(".modal-foot [role='alert']")!.textContent).toContain(
      "Fill in all three fields",
    );

    // The two checks the server would also make, refused with the field named.
    fireEvent.change(inputs[0]!, { target: { value: "current-pw-here" } });
    fireEvent.change(inputs[1]!, { target: { value: "short" } });
    fireEvent.change(inputs[2]!, { target: { value: "short" } });
    fireEvent.click(save);
    expect(getByText("New password needs at least 8 characters.")).toBeTruthy();
    expect(inputs[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(inputs[1]);
    expect(lastSubmit).toBeNull();

    fireEvent.change(inputs[1]!, { target: { value: "long-enough-pw" } });
    fireEvent.change(inputs[2]!, { target: { value: "different-pw!!!" } });
    fireEvent.click(save);
    expect(getByText("Passwords don't match.")).toBeTruthy();
    expect(inputs[2]!.getAttribute("aria-invalid")).toBe("true");
    expect(lastSubmit).toBeNull();

    fireEvent.change(inputs[2]!, { target: { value: "long-enough-pw" } });
    expect(inputs[2]!.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
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

/**
 * Ruling 368: Connect named its work ("Connecting…") but kept the GitHub glyph
 * and sat at the .45 refused step with a not-allowed cursor while better-auth
 * built the OAuth redirect. It is `aria-busy` now, the loader spinning.
 * Canary: drop `aria-busy={connectBusy || undefined}` in `profile-page.tsx`.
 */
describe("ruling 368: GitHub Connect in flight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads Connecting…, busy, the loader spinning, until the redirect", () => {
    // The OAuth start never answers here: the test reads the wait itself.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { getByText } = renderProfile();
    const connect = githubPanel(getByText).querySelector<HTMLButtonElement>(
      ".cred-warn button.btn",
    )!;
    fireEvent.click(connect);
    expect(connect.getAttribute("aria-busy")).toBe("true");
    expect(connect.textContent).toBe("Connecting…");
    expect(connect.disabled).toBe(true);
    expect(connect.querySelector("svg.ico.spin")).not.toBeNull();
  });
});
