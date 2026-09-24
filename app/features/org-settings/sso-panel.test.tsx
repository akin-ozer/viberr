// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import type { AuthProviderView } from "~/server/org/org-view.server";
import { ToastProvider } from "~/ui/toast";
import { SsoPanel } from "./sso-panel";

/**
 * R19-16 — the tab that replaced the dead end. "GitHub · off" used to be the
 * whole story; these pin the three things the card must say instead.
 */

const BLANK: AuthProviderView = {
  provider: "github",
  source: "none",
  active: false,
  disabledInApp: false,
  clientId: null,
  configuredInApp: false,
  verifiedAt: null,
  verifiedDetail: null,
  envAvailable: false,
};

function panelElement(providers: AuthProviderView[]) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <SsoPanel providers={providers} callbackOrigin="https://viberr.example" />
        </ToastProvider>
      ),
    },
  ]);
  return <Stub initialEntries={["/"]} />;
}

function renderPanel(providers: AuthProviderView[]) {
  return render(panelElement(providers));
}

describe("SsoPanel", () => {
  it("shows the CALLBACK URL an OAuth app has to carry, per provider", () => {
    // The credential test cannot prove this is registered, so the card has to
    // hand it over — otherwise a perfectly good client id/secret still fails at
    // the real sign-in with nothing on screen explaining why.
    const { container } = renderPanel([
      BLANK,
      { ...BLANK, provider: "google" },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("https://viberr.example/api/auth/callback/github");
    expect(text).toContain("https://viberr.example/api/auth/callback/google");
  });

  it("offers Set up when unconfigured, and no Test/Turn-on until it exists", () => {
    const { container } = renderPanel([BLANK, { ...BLANK, provider: "google" }]);
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent ?? "",
    );
    // One per unconfigured provider — and nothing that acts on a credential
    // that does not exist yet.
    expect(labels.filter((l) => l === "Set up")).toHaveLength(2);
    expect(labels).not.toContain("Test");
    expect(labels.some((l) => l.includes("Turn on"))).toBe(false);
  });

  it("keeps Turn on DISABLED until the provider has accepted the credentials", () => {
    const { getByRole } = renderPanel([
      { ...BLANK, configuredInApp: true, clientId: "Iv1.abc" },
    ]);
    const turnOn = getByRole("button", { name: /Turn on/ });
    expect(turnOn.hasAttribute("disabled")).toBe(true);
    expect(turnOn.getAttribute("title")).toContain("Test the credentials first");
  });

  it("states the LIMIT of a passing test next to the verdict", () => {
    const { container } = renderPanel([
      {
        ...BLANK,
        configuredInApp: true,
        clientId: "Iv1.abc",
        source: "app",
        active: true,
        verifiedAt: "2026-08-10T09:00:00.000Z",
        verifiedDetail: "GitHub accepted the client ID and secret.",
      },
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("GitHub accepted the client ID and secret.");
    // A green "live" pill must not be read as "sign-in definitely works".
    expect(text).toContain("still has to be registered on the provider");
  });

  it("C6: the proof date hydrates safely — the UTC day first, the viewer's calendar date after hydration", () => {
    const providers: AuthProviderView[] = [
      {
        ...BLANK,
        configuredInApp: true,
        clientId: "Iv1.abc",
        source: "app",
        active: true,
        verifiedAt: "2026-08-10T09:00:00.000Z",
        verifiedDetail: "GitHub accepted the client ID and secret.",
      },
    ];
    // The server pass depends on the timestamp alone: the SSR host's zone is
    // not the viewer's, and a calendar date rendered in it hydrates to
    // different text near midnight (React #418).
    const ssr = renderToString(panelElement(providers));
    expect(ssr).toContain("proved ");
    expect(ssr).toContain("2026-08-10 (UTC)");
    expect(ssr).not.toContain("Aug 10, 2026");
    // After hydration the effect swaps in the viewer-local calendar date.
    const { container } = renderPanel(providers);
    expect(container.textContent).toContain("proved Aug 10, 2026");
    expect(container.textContent).not.toContain("(UTC)");
  });

  it("colo-13: off is a quiet fact, and only 'not tested' asks for action", () => {
    // Local accounts only is a valid setup, so "off" wears the describe tier a
    // disabled user wears, not the amber input_required fill.
    const off = renderPanel([BLANK]).container.querySelector(".pill")!;
    expect(off.textContent).toBe("off");
    expect(off.className).toBe("pill neutral sm quiet");

    const configured = renderPanel([
      { ...BLANK, configuredInApp: true, clientId: "Iv1.abc" },
    ]).container;
    const notTested = [...configured.querySelectorAll(".pill")].find(
      (el) => el.textContent === "not tested",
    );
    expect(notTested?.className).toBe("pill input sm");
  });

  it("says when the app's OFF switch is overriding the deployment env", () => {
    const { container } = renderPanel([
      {
        ...BLANK,
        configuredInApp: true,
        clientId: "Iv1.abc",
        source: "app",
        active: false,
        disabledInApp: true,
        envAvailable: true,
      },
    ]);
    expect(container.textContent).toContain(
      "overrides the credentials in this deployment",
    );
  });
});
