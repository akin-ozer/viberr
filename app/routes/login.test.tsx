// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { Icon, type IconName } from "~/ui/icon";
import Login from "./login";

afterEach(cleanup);

/**
 * R17-4 (pass-17 UX-1): the sign-in card's layout forks on whether ANY OAuth
 * provider is configured. `login.server.test.ts` covers the loader/action;
 * this file covers the render fork itself, which no server test can see.
 *
 * - Neither provider configured (the common self-hosted case): the card used
 *   to lead with two DISABLED "not configured" buttons — its most prominent
 *   elements were things that cannot work. Now the local form leads and SSO
 *   shrinks to a one-line note.
 * - At least one provider configured: SSO-first stands, with the D12 disabled
 *   button for the unconfigured one.
 */

const renderLogin = (providersOn: { github: boolean; google: boolean }) => {
  const loaderData = {
    mode: "login" as const,
    returnTo: null,
    providers: providersOn,
  };
  // SAFETY: `Login` destructures exactly `loaderData` and `actionData` off its
  // generated `Route.ComponentProps` (login.tsx) — the two this stub supplies.
  // The rest of the generated props (params, matches) are never read, and the
  // stub has no way to produce them.
  const LoginStub = Login as React.ComponentType<{
    loaderData: typeof loaderData;
    actionData: undefined;
  }>;
  const Stub = createRoutesStub([
    {
      path: "/login",
      Component: () => (
        <LoginStub loaderData={loaderData} actionData={undefined} />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/login"]} />);
};

describe("R17-4: local form leads when no OAuth provider is configured", () => {
  it("renders no provider buttons and demotes SSO to a one-line note", () => {
    const { container, queryByText, getByLabelText } = renderLogin({
      github: false,
      google: false,
    });
    // The two disabled buttons are gone entirely…
    expect(container.querySelector(".login-providers")).toBeNull();
    expect(queryByText("GitHub (not configured)")).toBeNull();
    expect(queryByText("Google (not configured)")).toBeNull();
    // …the "or a local account" divider with them (the form IS the account
    // path, not the fallback)…
    expect(queryByText("or a local account")).toBeNull();
    // …the form is present and the note sits BELOW it in document order.
    const form = container.querySelector("form")!;
    const note = container.querySelector(".login-tag.providers")!;
    expect(note.textContent).toContain("SSO isn't configured");
    expect(
      form.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(getByLabelText("Email")).toBeTruthy();
  });

  it("keeps SSO-first when exactly one provider is configured", () => {
    const { container, getByText } = renderLogin({
      github: true,
      google: false,
    });
    const providersEl = container.querySelector(".login-providers")!;
    expect(providersEl).toBeTruthy();
    expect(getByText("Continue with GitHub")).toBeTruthy();
    // D12: the unconfigured provider renders disabled, not hidden.
    const googleBtn = getByText("Google (not configured)").closest("button")!;
    expect(googleBtn.disabled).toBe(true);
    expect(getByText("or a local account")).toBeTruthy();
    expect(
      container.querySelector(".login-tag.providers")!.textContent,
    ).toContain("Google sign-in isn't configured");
    // The providers block precedes the form — SSO-first stands.
    const form = container.querySelector("form")!;
    expect(
      providersEl.compareDocumentPosition(form) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no not-configured note when both providers are configured", () => {
    const { container, getByText } = renderLogin({
      github: true,
      google: true,
    });
    expect(getByText("Continue with GitHub")).toBeTruthy();
    expect(getByText("Continue with Google")).toBeTruthy();
    expect(container.querySelector(".login-tag.providers")).toBeNull();
    // The whitelist footnote (SSO deployments only) is back.
    expect(container.textContent).toContain("whitelist-based access");
  });
});

/**
 * Interface review 2026-09-06: a refused sign-in used to render its alert
 * with nothing tying it to the field that failed — no aria-invalid, no
 * describedby, focus left on the button. Both the client-side and the server
 * refusal now name their field, and the page marks, describes and focuses it.
 */
describe("a refused sign-in names its field", () => {
  type ActionData = { error: string; field: "email" | "password" | null };
  const renderWithAction = (
    action: () => ActionData | Promise<ActionData>,
  ) => {
    const loaderData = {
      mode: "login" as const,
      returnTo: null,
      providers: { github: false, google: false },
    };
    // SAFETY: as in renderLogin above — the stub supplies exactly the two props
    // the component reads, and the action's reply is what useActionData hands
    // it in the real route.
    const LoginStub = Login as React.ComponentType<{
      loaderData: typeof loaderData;
      actionData: ActionData | undefined;
    }>;
    const Stub = createRoutesStub([
      {
        path: "/login",
        Component: ({ actionData }) => {
          // SAFETY: the stub's action is the `action` this helper was given,
          // whose reply is typed ActionData; the router hands that reply (or
          // undefined before any submit) through as `actionData`.
          const reply = actionData as ActionData | undefined;
          return <LoginStub loaderData={loaderData} actionData={reply} />;
        },
        action,
      },
    ]);
    return render(<Stub initialEntries={["/login"]} />);
  };

  it("renders a pristine form with nothing accused", () => {
    const { container } = renderLogin({ github: false, google: false });
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(container.querySelector("[aria-describedby]")).toBeNull();
  });

  it("client-side: an empty email marks, describes and focuses the email field", () => {
    const { container } = renderLogin({ github: false, google: false });
    fireEvent.submit(container.querySelector("form")!);
    const email = container.querySelector<HTMLInputElement>("#lg-email")!;
    const alert = container.querySelector("#lg-err")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Enter your email.");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe("lg-err");
    expect(document.activeElement).toBe(email);
    expect(container.querySelector("#lg-pw")!.getAttribute("aria-invalid")).toBeNull();
  });

  it("server-side: a wrong password marks, describes and focuses the password field", async () => {
    const { container } = renderWithAction(() => ({
      error: "Wrong password. Ask an admin to reset it if you're locked out.",
      field: "password",
    }));
    fireEvent.change(container.querySelector("#lg-email")!, {
      target: { value: "arda@viberr.dev" },
    });
    fireEvent.change(container.querySelector("#lg-pw")!, {
      target: { value: "nope" },
    });
    fireEvent.submit(container.querySelector("form")!);
    // Focus lands in a mount-order effect: assert inside waitFor, since a
    // resolved findBy* does not guarantee effects ran.
    await waitFor(() => {
      const pw = container.querySelector<HTMLInputElement>("#lg-pw")!;
      expect(container.querySelector("#lg-err")!.textContent).toContain("Wrong password");
      expect(pw.getAttribute("aria-invalid")).toBe("true");
      expect(pw.getAttribute("aria-describedby")).toBe("lg-err");
      expect(document.activeElement).toBe(pw);
    });
    expect(container.querySelector("#lg-email")!.getAttribute("aria-invalid")).toBeNull();
  });

  it("ruling 451(g): a second refused submit without typing is a new alert", async () => {
    // The person clicks Sign in again on the same wrong password. Nothing was
    // typed, so nothing dismissed the first box; the second answer must still
    // arrive as a new one.
    const { container } = renderWithAction(() => ({
      error: "Wrong password. Ask an admin to reset it if you're locked out.",
      field: "password",
    }));
    fireEvent.change(container.querySelector("#lg-email")!, {
      target: { value: "arda@viberr.dev" },
    });
    fireEvent.change(container.querySelector("#lg-pw")!, { target: { value: "nope" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(container.querySelector("#lg-err")).not.toBeNull());
    const first = container.querySelector("#lg-err")!;
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(container.querySelector("#lg-err")).not.toBe(first));
    expect(container.querySelector("#lg-err")!.textContent).toContain("Wrong password");
    expect(container.querySelector("#lg-err")!.classList.contains("refused")).toBe(true);
  });

  it("re-shows the same refusal after it was dismissed by typing", async () => {
    // Dismissal is keyed on the result object, not its text: a second submit
    // that fails the same way is a new result and must surface again.
    const { container } = renderWithAction(() => ({
      error: "Wrong password. Ask an admin to reset it if you're locked out.",
      field: "password",
    }));
    const pw = container.querySelector<HTMLInputElement>("#lg-pw")!;
    fireEvent.change(container.querySelector("#lg-email")!, {
      target: { value: "arda@viberr.dev" },
    });
    fireEvent.change(pw, { target: { value: "nope" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(container.querySelector("#lg-err")).not.toBeNull());
    fireEvent.change(pw, { target: { value: "nope2" } });
    expect(container.querySelector("#lg-err")).toBeNull();
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(container.querySelector("#lg-err")).not.toBeNull());
  });
});

/**
 * Ruling 451(g): a second refusal that reads the same is still a second
 * refusal. The box stayed mounted across it, so the sentence stood still as if
 * the click had been ignored, and an unchanged `role="alert"` is not announced
 * again. Keyed on the refusal itself, the box remounts and shakes (`.refused`).
 */
describe("ruling 451(g): every refused sign-in is a new alert", () => {
  it("client-side: a second empty submit replaces the box, and each one shakes", () => {
    // CANARY: drop `key={refusalKey(...)}` from #lg-err and the second submit
    // leaves the first node in place.
    const { container } = renderLogin({ github: false, google: false });
    fireEvent.submit(container.querySelector("form")!);
    const first = container.querySelector("#lg-err")!;
    expect(first.classList.contains("refused")).toBe(true);
    fireEvent.submit(container.querySelector("form")!);
    const second = container.querySelector("#lg-err")!;
    expect(second).not.toBe(first);
    expect(second.textContent).toBe(first.textContent);
    expect(second.classList.contains("refused")).toBe(true);
  });
});

describe("the forced set-new-password step names its field the same way", () => {
  type ResetAction = { error: string; field: "npw" | "npw2" | null };
  const renderReset = (action?: () => ResetAction) => {
    const loaderData = {
      mode: "reset" as const,
      returnTo: null,
      providers: { github: false, google: false },
    };
    // SAFETY: as in renderLogin — the component reads exactly these two props.
    const LoginStub = Login as React.ComponentType<{
      loaderData: typeof loaderData;
      actionData: ResetAction | undefined;
    }>;
    const Stub = createRoutesStub([
      {
        path: "/login",
        Component: ({ actionData }) => {
          // SAFETY: the stub's action (when given) returns ResetAction; before
          // any submit the router hands through undefined.
          const reply = actionData as ResetAction | undefined;
          return <LoginStub loaderData={loaderData} actionData={reply} />;
        },
        // A client-only case leaves the route without an action, so a submit
        // the client did not block would surface as the stub's own 405.
        action,
      },
    ]);
    return render(<Stub initialEntries={["/login"]} />);
  };

  it("client-side: a short password marks, describes and focuses the first field", () => {
    const { container } = renderReset();
    fireEvent.change(container.querySelector("#npw")!, { target: { value: "abc" } });
    fireEvent.submit(container.querySelector("form")!);
    const npw = container.querySelector<HTMLInputElement>("#npw")!;
    expect(container.querySelector("#npw-err")!.textContent).toContain("at least");
    expect(npw.getAttribute("aria-invalid")).toBe("true");
    expect(npw.getAttribute("aria-describedby")).toBe("npw-err");
    expect(document.activeElement).toBe(npw);
    expect(container.querySelector("#npw2")!.getAttribute("aria-invalid")).toBeNull();
  });

  it("server-side: a mismatch lands on the confirmation field", async () => {
    const { container } = renderReset(() => ({
      error: "Passwords don't match.",
      field: "npw2",
    }));
    fireEvent.change(container.querySelector("#npw")!, {
      target: { value: "long-enough-password" },
    });
    fireEvent.change(container.querySelector("#npw2")!, {
      target: { value: "long-enough-password" },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      const npw2 = container.querySelector<HTMLInputElement>("#npw2")!;
      expect(container.querySelector("#npw-err")!.textContent).toContain("don't match");
      expect(npw2.getAttribute("aria-invalid")).toBe("true");
      expect(npw2.getAttribute("aria-describedby")).toBe("npw-err");
      expect(document.activeElement).toBe(npw2);
    });
  });
});

/**
 * Ruling 459 (better-ui icons): one icon library per surface, one glyph per
 * meaning. Google's button led with a typed ExtraBold "G" beside GitHub's
 * outline glyph (its accessible name read "GContinue with Google"), and both
 * buttons spun the `refresh` arrow while the sign-in was in flight, where the
 * set's busy glyph is `loader`.
 */
describe("ruling 459: the provider buttons draw the icon set's glyphs", () => {
  /** The path markup a glyph renders, to tell two `svg.ico`s apart. */
  const glyph = (name: IconName) => {
    const { container, unmount } = render(<Icon name={name} />);
    const inner = container.querySelector("svg")!.innerHTML;
    unmount();
    return inner;
  };

  it("leads each button with its mark as an svg glyph, so the name is the label alone", () => {
    // Canary: put the typed "G" span back in front of the Google label.
    const { getByRole } = renderLogin({ github: true, google: true });
    for (const [name, mark] of [
      ["Continue with GitHub", "github"],
      ["Continue with Google", "google"],
    ] as const) {
      const button = getByRole("button", { name });
      expect(button.textContent).toBe(name);
      // Ruling 459: the mark leads in its GlyphSwap cell, the loader resting
      // hidden behind it until the sign-in is in flight.
      const cell = button.firstElementChild!;
      expect(cell.matches(".copy-glyph[aria-hidden='true']:not([data-copied])"), name).toBe(true);
      const svg = cell.firstElementChild!;
      expect(svg.matches("svg.ico"), name).toBe(true);
      expect(svg.innerHTML, name).toBe(glyph(mark));
    }
  });

  it("spins the loader, not the refresh arrow, while a sign-in is in flight", () => {
    // Canary: put the Google button back on `alt="refresh"`.
    const origFetch = globalThis.fetch;
    // SAFETY: the provider click awaits fetch(url, init) and nothing else; a
    // promise that never settles holds the button in its busy state.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const { getByRole } = renderLogin({ github: true, google: true });
      const button = getByRole("button", { name: "Continue with Google" });
      fireEvent.click(button);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.textContent).toBe("Checking whitelist…");
      // The spinning loader trades in for the mark, in the same cell.
      expect(button.querySelector(".copy-glyph")!.getAttribute("data-copied")).toBe("true");
      const spinner = button.querySelector(".copy-glyph > svg.ico.spin:last-child")!;
      expect(spinner.innerHTML).toBe(glyph("loader"));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
