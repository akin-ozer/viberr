// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import { Icon } from "~/ui/icon";
import { ToastProvider } from "~/ui/toast";
import { UsersPanel } from "./users-panel";

/**
 * P13-D-10 (UX-5): the panel's three client-side refusals ("you can't demote /
 * disable / remove yourself") are the only feedback those actions ever produce
 * — no dialog opens, nothing is posted. They pushed through `push`'s default
 * `"success"` kind, so a refusal arrived wearing the green tick.
 */

afterEach(cleanup);

const ME: OrgUserView = {
  id: "u_arda",
  name: "Arda Kaya",
  email: "arda@viberr.dev",
  initials: "AK",
  tone: "",
  role: "admin",
  status: "active",
  idp: "local",
  pwreset: false,
  disabled: false,
  githubHandle: null,
};
const DOMAINS: DomainRecord[] = [];

function renderPanel(
  providers: { github: boolean; google: boolean } = { github: false, google: false },
) {
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <UsersPanel users={[ME]} domains={DOMAINS} meId="u_arda" providers={providers} />
        </ToastProvider>
      ),
      action: async () => ({ ok: true, toast: "stub done" }),
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

async function kindOf(
  container: HTMLElement,
  text: string,
): Promise<string | null> {
  await waitFor(() =>
    expect(
      [...container.querySelectorAll(".toast")].some((t) =>
        t.textContent!.includes(text),
      ),
    ).toBe(true),
  );
  return [...container.querySelectorAll(".toast")]
    .find((t) => t.textContent!.includes(text))!
    .getAttribute("data-kind");
}

describe("P13-D-10: the self-guard toasts are failures", () => {
  it("marks a refused self-demotion as an error", async () => {
    const { container, getByText } = renderPanel();
    const myRow = getByText("arda@viberr.dev").closest(".member-row")!;
    fireEvent.click(myRow.querySelector(".mini-seg button:not(.on)")!);
    expect(await kindOf(container, "You can't demote yourself")).toBe("error");
  });

  it("marks a refused self-disable as an error", async () => {
    const { container, getByLabelText } = renderPanel();
    fireEvent.click(getByLabelText("Disable Arda Kaya"));
    expect(
      await kindOf(container, "You can't disable your own account"),
    ).toBe("error");
  });

  it("marks a refused self-removal as an error", async () => {
    const { container, getByLabelText } = renderPanel();
    fireEvent.click(getByLabelText("Remove Arda Kaya"));
    expect(await kindOf(container, "You can't remove your own account")).toBe(
      "error",
    );
  });
});

describe("F18-3: the Allow-access modal keys its method off configured providers", () => {
  const openModal = (container: HTMLElement, getByText: (t: string) => HTMLElement) => {
    fireEvent.click(getByText("Allow access"));
    return [...container.querySelectorAll<HTMLButtonElement>(".be-opt")];
  };

  it("with NO OAuth provider: defaults to Local; GitHub + Google are disabled and marked off", () => {
    const { container, getByText } = renderPanel({ github: false, google: false });
    const opts = openModal(container, getByText);
    const [github, google, local] = opts;
    expect(github!.disabled).toBe(true);
    expect(google!.disabled).toBe(true);
    expect(local!.disabled).toBe(false);
    // Local is the selected default (a whitelisted OAuth account could never
    // sign in on this deployment).
    expect(local!.getAttribute("aria-pressed")).toBe("true");
    expect(github!.textContent).toContain("off");
    expect(google!.textContent).toContain("off");
  });

  it("with GitHub configured: GitHub leads and is enabled", () => {
    const { container, getByText } = renderPanel({ github: true, google: false });
    const opts = openModal(container, getByText);
    const [github, google] = opts;
    expect(github!.disabled).toBe(false);
    expect(github!.getAttribute("aria-pressed")).toBe("true");
    expect(google!.disabled).toBe(true);
  });
});

/**
 * LV-F1 — the new-account LOCKOUT (live-reproduced by the owner: "I created the
 * user but couldn't log in since it asked for a password").
 *
 * A freshly created local account always carries `pwreset: true`. The Password
 * field rendered the "Reset pending" banner INSTEAD of the "Reset password"
 * button on exactly that condition, so the one-time temp password shown at
 * creation was the account's ONLY credential — miss it, reload past it, or
 * dismiss it and the account could never sign in again. The backend could
 * always re-issue (`user-reset-password` returns a fresh tempPassword); only
 * the UI hid the door. The action must therefore survive the pending state.
 */
describe("LV-F1: a pending reset never hides the re-issue action", () => {
  const localUser = (over: Partial<OrgUserView> = {}): OrgUserView => ({
    ...ME,
    id: "u_new",
    name: "Test Contributor",
    email: "contributor@viberr.dev",
    role: "member",
    ...over,
  });

  function renderWith(user: OrgUserView) {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, user]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async () => ({ ok: true, toast: "stub done" }),
      },
    ]);
    return render(<Stub initialEntries={["/org/settings"]} />);
  }

  const openEdit = (getByLabelText: (t: string) => HTMLElement) =>
    fireEvent.click(getByLabelText("Edit Test Contributor"));

  it("a just-created account (pwreset pending) STILL offers a way to issue a new temp password", () => {
    const { getByLabelText, getByText, container } = renderWith(
      localUser({ pwreset: true, status: "invited" }),
    );
    openEdit(getByLabelText);
    // The pending state is shown as CONTEXT…
    expect(container.textContent).toContain("Reset pending");
    // …and the recovery action is still reachable — this is the regression.
    const btn = getByText("Generate a new temp password");
    expect(btn).toBeTruthy();
    expect(btn.closest("button")!.disabled).toBe(false);
  });

  it("an established account (no pending reset) keeps the plain Reset password action", () => {
    const { getByLabelText, getByText, container } = renderWith(
      localUser({ pwreset: false, status: "active" }),
    );
    openEdit(getByLabelText);
    expect(container.textContent).not.toContain("Reset pending");
    expect(getByText("Reset password")).toBeTruthy();
  });
});

/**
 * Ruling 154 (pass 35, G35-3): the Edit-user modal is the org admin's door to
 * `users.github_handle` for a local or Google account. A GitHub account's
 * handle syncs from the provider, so that modal carries no field.
 */
describe("ruling 154: the Edit-user modal links a GitHub handle", () => {
  const OTHER = (over: Partial<OrgUserView> = {}): OrgUserView => ({
    ...ME,
    id: "u_maya",
    name: "Maya Lin",
    email: "maya@viberr.dev",
    initials: "ML",
    role: "member",
    ...over,
  });

  function renderEditing(user: OrgUserView) {
    let submitted: Record<string, string> | null = null;
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, user]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async ({ request }) => {
          submitted = Object.fromEntries(
            [...(await request.formData()).entries()].map(([k, v]) => [k, String(v)]),
          );
          return { ok: true, toast: "stub done" };
        },
      },
    ]);
    const rendered = render(<Stub initialEntries={["/org/settings"]} />);
    fireEvent.click(rendered.getByLabelText("Edit Maya Lin"));
    return { ...rendered, submitted: () => submitted };
  }

  it("a local account gets a GitHub handle field whose value rides the save", async () => {
    const { getByLabelText, getByText, submitted } = renderEditing(OTHER());
    const field = getByLabelText("GitHub handle");
    expect(field.tagName).toBe("INPUT");
    expect(field.getAttribute("placeholder")).toBe("octocat");
    expect(getByText(/Counts this person's GitHub approval/)).toBeTruthy();
    fireEvent.change(field, { target: { value: "@OctoCat" } });
    fireEvent.click(getByText("Save changes"));
    await waitFor(() => expect(submitted()).not.toBeNull());
    expect(submitted()).toMatchObject({
      intent: "user-edit",
      userId: "u_maya",
      githubHandle: "octocat",
    });
  });

  it("a stored handle is shown, and a malformed one is refused at Save with its rule", () => {
    const { getByLabelText, getByText, getByRole, submitted } = renderEditing(
      OTHER({ githubHandle: "mayalin" }),
    );
    const field = getByLabelText("GitHub handle");
    expect(field).toHaveProperty("value", "mayalin");
    fireEvent.change(field, { target: { value: "not a handle!" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.click(getByText("Save changes"));
    expect(getByRole("alert").textContent).toContain("Enter a GitHub username");
    expect(document.activeElement).toBe(field);
    expect(submitted()).toBeNull();
  });

  it("a GitHub-signed-in account carries no handle field and sends none", async () => {
    const { queryByLabelText, getByText, submitted } = renderEditing(
      OTHER({ idp: "github", githubHandle: "mayalin", status: "whitelisted" }),
    );
    expect(queryByLabelText("GitHub handle")).toBeNull();
    fireEvent.click(getByText("Save changes"));
    await waitFor(() => expect(submitted()).not.toBeNull());
    expect(submitted()).not.toHaveProperty("githubHandle");
  });
});

/**
 * Pass-19 UX coherence audit, finding #20 (a11y).
 *
 * One panel, one server guard, two feedback semantics: the member row's role
 * toggle routes its refusal through `useOrgAction`'s default handler and toasts
 * it (`ui/toast.tsx` — role="status", "the app's ONE announcer"), and the
 * client-side "You can't demote yourself" on the modal's own Save button toasts
 * too. Only the SERVER saying no — the duplicate-email and last-admin guards in
 * org-users.server.ts — landed in a roleless box, because the modals
 * pass an `onResult` that replaces the default toast. A screen-reader user
 * pressed Save changes and heard nothing at all while the dialog sat open.
 */
describe("#20: a server refusal inside these modals is announced", () => {
  const OTHER: OrgUserView = {
    ...ME,
    id: "u_elif",
    name: "Elif Demir",
    email: "elif@viberr.dev",
    initials: "ED",
    role: "member",
  };

  function renderRefusing(error: string) {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, OTHER]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async () => ({ ok: false, error }),
      },
    ]);
    return render(<Stub initialEntries={["/org/settings"]} />);
  }

  // Interface review 2026-09-06: a server refusal is an ERROR, so it wears the
  // app's one inline-error box (`.form-err`) rather than the amber warning box
  // it shared with "not connected" and "scopes unverified".
  const warning = async (container: HTMLElement, text: string) =>
    await waitFor(() => {
      const node = container.querySelector(".form-err");
      expect(node?.textContent).toContain(text);
      return node!;
    });

  it("the Edit-user modal's refusal is a live region, like the toast its own row gets", async () => {
    const { container, getByLabelText, getByText } = renderRefusing(
      "A user with email elif@viberr.dev already exists.",
    );
    fireEvent.click(getByLabelText("Edit Elif Demir"));
    fireEvent.click(getByText("Save changes"));
    const node = await warning(container, "already exists.");
    expect(node.getAttribute("role")).toBe("alert");
  });

  it("the invite modal's refusal is a live region too", async () => {
    const { container, getByText, getByPlaceholderText } = renderRefusing(
      "Enter a valid email address.",
    );
    fireEvent.click(getByText("Allow access"));
    fireEvent.change(getByPlaceholderText("Full name"), {
      target: { value: "Yeni Kişi" },
    });
    fireEvent.change(getByPlaceholderText("name@company.dev"), {
      target: { value: "yeni@viberr.dev" },
    });
    fireEvent.click(getByText("Create account"));
    const node = await warning(container, "Enter a valid email address.");
    expect(node.getAttribute("role")).toBe("alert");
  });
});

/**
 * Interface review 2026-09-06 (ruling 148): the temp-password notice's dismiss
 * was the app's only `.stg-x` that closed something rather than acting on a
 * list row — a 24px square with a different hover from every other ✕ the user
 * meets. It takes the shared close control now, at notice scale.
 */
describe("the temp-password notice dismisses on the shared close control", () => {
  function renderCreating() {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async () => ({
          ok: true,
          toast: "Account created",
          email: "yeni@viberr.dev",
          tempPassword: "T3mp-pass-9",
        }),
      },
    ]);
    return render(<Stub initialEntries={["/org/settings"]} />);
  }

  it("shows the once-only password and closes on the shared ✕", async () => {
    const { container, getByText, getByPlaceholderText, getByLabelText } =
      renderCreating();
    fireEvent.click(getByText("Allow access"));
    fireEvent.change(getByPlaceholderText("Full name"), {
      target: { value: "Yeni Kişi" },
    });
    fireEvent.change(getByPlaceholderText("name@company.dev"), {
      target: { value: "yeni@viberr.dev" },
    });
    fireEvent.click(getByText("Create account"));

    const notice = await waitFor(() => {
      const node = container.querySelector(".cred-ok");
      expect(node?.textContent).toContain("T3mp-pass-9");
      return node!;
    });
    const dismiss = getByLabelText("Dismiss");
    expect(notice.contains(dismiss)).toBe(true);
    expect(dismiss.className).toBe("icon-btn modal-close");

    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(container.querySelector(".cred-ok")).toBeNull(),
    );
  });
});

/**
 * Ruling 149 (2026-09-06): the destructive row treatment is opt-in by NAME
 * where position cannot identify it.
 *
 * `.stg-x`'s destructive hover is positional for this list
 * (`.member-row .stg-x:last-child`) and the user row ends on Remove, so Disable
 * — which signs the person out at once and locks the account until someone
 * re-enables it, and whose confirm commits on a `btn danger` — hovered exactly
 * like Edit. It carries `.destructive` now; the self-guarded copy keeps `.off`
 * so it reads as unavailable rather than as a threat.
 */
describe("ruling 149: Disable takes the destructive row treatment", () => {
  const OTHER: OrgUserView = {
    ...ME,
    id: "u_deniz",
    name: "Deniz Yildiz",
    email: "deniz@viberr.dev",
    initials: "DY",
    role: "member",
  };

  function renderTwo() {
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, OTHER]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        action: async () => ({ ok: true, toast: "stub done" }),
      },
    ]);
    return render(<Stub initialEntries={["/org/settings"]} />);
  }

  it("names Disable destructive, leaves Remove on its position, and keeps the self copy off", () => {
    const { getByLabelText } = renderTwo();
    // Canary: drop `destructive` and this control hovers like Edit does.
    expect(getByLabelText("Disable Deniz Yildiz").className).toBe(
      "stg-x destructive",
    );
    // Remove is the row's last child, so it needs no second name.
    expect(getByLabelText("Remove Deniz Yildiz").className).toBe("stg-x");
    // Your own row: refused, so it stays dimmed rather than turning red.
    expect(getByLabelText("Disable Arda Kaya").className).toBe(
      "stg-x destructive off",
    );
  });
});

/**
 * Ruling 459 (better-ui icons): the Google mark was a typed ExtraBold "G" in
 * the identity chip, the Allow-access tile and the domain row, beside the
 * set's outline GitHub and lock glyphs. It is the set's `google` glyph now,
 * hidden from assistive tech like every Icon, so the names read "Google",
 * not "GGoogle".
 */
describe("ruling 459: the Google mark is the icon set's glyph", () => {
  it("draws it in the chip, the Allow-access tile and the domain row, and no letter stands in", () => {
    // Canary: put the typed "G" span back in the identity chip.
    const googleUser: OrgUserView = {
      ...ME,
      id: "u_gul",
      name: "Gul Demir",
      email: "gul@acme.dev",
      initials: "GD",
      idp: "google",
    };
    const domains: DomainRecord[] = [
      { id: "d_acme", domain: "acme.dev", role: "member", createdAt: "2026-09-01T00:00:00Z" },
    ];
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, googleUser]}
              domains={domains}
              meId="u_arda"
              providers={{ github: false, google: true }}
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container, getByText } = render(<Stub initialEntries={["/org/settings"]} />);
    const mark = (() => {
      const probe = render(<Icon name="google" />);
      const inner = probe.container.querySelector("svg")!.innerHTML;
      probe.unmount();
      return inner;
    })();
    const isMark = (el: Element | null) =>
      el !== null && el.matches("svg.ico[aria-hidden='true']") && el.innerHTML === mark;

    const chip = [...container.querySelectorAll(".idp-chip")].find((c) => c.textContent!.includes("Google"))!;
    expect(chip.textContent).toBe("Google");
    expect(isMark(chip.firstElementChild)).toBe(true);

    const row = getByText("acme.dev").closest(".member-row")!;
    expect(isMark(row.querySelector(".dom-ic")!.firstElementChild)).toBe(true);
    expect(row.querySelector(".dom-ic")!.textContent).toBe("");

    fireEvent.click(getByText("Allow access"));
    const tile = [...container.querySelectorAll<HTMLButtonElement>(".be-opt")][1]!;
    expect(tile.textContent).toMatch(/^Google/);
    expect(isMark(tile.querySelector(".be-ic")!.firstElementChild)).toBe(true);
  });
});

/**
 * Ruling 368: the password reset in flight shows itself on its button — busy,
 * the loader spinning where the lock was, and a label naming the work — rather
 * than dimming to the .45 refused step with its resting label.
 * Canary: drop `aria-busy` from the reset button in `users-panel.tsx`.
 */
describe("ruling 368: the reset in flight", () => {
  it("Reset password reads Resetting… and is busy until the server answers", async () => {
    const user: OrgUserView = {
      ...ME,
      id: "u_new",
      name: "Test Contributor",
      email: "contributor@viberr.dev",
      role: "member",
    };
    const Stub = createRoutesStub([
      {
        path: "/org/settings",
        Component: () => (
          <ToastProvider>
            <UsersPanel
              users={[ME, user]}
              domains={DOMAINS}
              meId="u_arda"
              providers={{ github: false, google: false }}
            />
          </ToastProvider>
        ),
        // Never answers: the test reads the wait itself.
        action: () => new Promise(() => {}),
      },
    ]);
    const { getByLabelText, getByText } = render(<Stub initialEntries={["/org/settings"]} />);
    fireEvent.click(getByLabelText("Edit Test Contributor"));
    const reset = getByText("Reset password").closest("button")!;
    fireEvent.click(reset);
    await waitFor(() => expect(reset.getAttribute("aria-busy")).toBe("true"));
    expect(reset.textContent).toBe("Resetting…");
    expect(reset.disabled).toBe(true);
    expect(reset.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
  });
});
