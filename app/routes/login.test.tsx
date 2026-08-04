// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
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
  // Route components receive generated props; the stub can't supply them, so
  // hand the two the component reads (same cast style as the GithubViewPage
  // tests).
  const LoginStub = Login as unknown as React.ComponentType<{
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
    expect(queryByText("GitHub — not configured")).toBeNull();
    expect(queryByText("Google — not configured")).toBeNull();
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
    const googleBtn = getByText("Google — not configured").closest("button")!;
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
