// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { AgentAccountsPanel } from "./agent-accounts-panel";
import type { ProfileBackend } from "./profile-query.server";
import * as backendLoginRoute from "~/routes/resources.backend-login";
import type {
  BackendLoginPollAnswer,
  BackendLoginPollData,
} from "~/routes/resources.backend-login";
import { clientLoaderOver, unreachable } from "../../../test-support/client-data";

/**
 * Profile → Agent accounts, rendered (ruling 127).
 *
 * The card states are asserted as a reader meets them: not connected, signing
 * in (including while a credential already works), connected, a connection
 * whose credential file vanished, and a sign-in that failed. The poll is driven through
 * a REAL stub route, because the honest question about this panel is not "does
 * it call `fetcher.load`" but "does it toast a connection only once the SERVER
 * says there is one" — the toast-honesty rule that the P11-40 family of fixes
 * exists to enforce.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let lastSubmit: Record<string, string> | null = null;

const HEALTH_NONE = {
  available: false,
  kind: null,
  method: null,
  verification: "none",
  secretSuffix: null,
  verifiedAt: null,
  connectedAt: null,
  detail: "Claude isn't connected. Connect it on your Profile → Agent accounts.",
  accountId: null,
  accountName: null,
} as const;

function backend(
  name: "claude" | "codex",
  overrides: Partial<ProfileBackend> = {},
): ProfileBackend {
  const health = overrides.health ?? { ...HEALTH_NONE, backend: name, userId: "u_arda" };
  return {
    backend: name,
    health,
    login: null,
    methods:
      name === "claude"
        ? { signIn: ["claudeai", "console"], paste: ["api_key"] }
        : { signIn: ["device"], paste: ["api_key", "access_token"] },
    // What the loader sends (ruling 507): the connected account, active.
    accounts:
      health.kind === null
        ? []
        : [
            {
              id: health.accountId ?? "",
              name: health.accountName ?? (name === "claude" ? "Claude" : "Codex"),
              label: null,
              active: true,
              health,
            },
          ],
    limits: { maxAccounts: 10, maxLabelLength: 60 },
    lastRefusal: null,
    usage: null,
    ...overrides,
  };
}

const BOTH_UNCONNECTED: ProfileBackend[] = [backend("claude"), backend("codex")];

function runningLogin(
  name: "claude" | "codex",
  overrides: Partial<ProfileBackend["login"] & object> = {},
): NonNullable<ProfileBackend["login"]> {
  return {
    id: "bkl_1",
    backend: name,
    method: name === "claude" ? "claudeai" : "device",
    accountId: "ubc_new",
    existingAccount: false,
    state: "awaiting-browser",
    url: name === "claude" ? "https://claude.ai/oauth" : "https://auth.openai.com/codex/device",
    userCode: name === "codex" ? "WDJB-MJHT" : null,
    needsCode: false,
    startedAt: "2026-09-02T09:00:00.000Z",
    expiresAt: "2026-09-02T09:15:00.000Z",
    error: null,
    ...overrides,
  };
}

/** The panel on one fetcher, as the profile page mounts it. A submit is
 *  recorded in `lastSubmit` and never reaches a server. */
function PanelOver({ backends }: { backends: ProfileBackend[] }) {
  const fetcher = useFetcher();
  return (
    <ToastProvider>
      <AgentAccountsPanel
        backends={backends}
        fetcher={fetcher}
        submit={(fields) => {
          lastSubmit = fields;
        }}
      />
    </ToastProvider>
  );
}

/** `poll` answers the card's poll, or is `unreachable`: a server that gives
 *  no answer (a restart, a dead network). */
function panelElement(
  backends: ProfileBackend[],
  poll: () => BackendLoginPollAnswer | null = () => null,
) {
  lastSubmit = null;
  const Stub = createRoutesStub([
    { path: "/profile", Component: () => <PanelOver backends={backends} /> },
    {
      // The real poll target, through the route's own `clientLoader`. Its
      // answer is what the success toast must settle on, so it is a route
      // with a loader, not a stubbed function.
      path: "/resources/backend-login",
      loader: clientLoaderOver(backendLoginRoute, poll),
    },
  ]);
  return <Stub initialEntries={["/profile"]} />;
}

function renderPanel(
  backends: ProfileBackend[],
  poll: () => BackendLoginPollAnswer | null = () => null,
) {
  return render(panelElement(backends, poll));
}

describe("AgentAccountsPanel", () => {
  it("renders one card per backend with the vendor's own sign-in options", () => {
    const { getByText, getAllByText, container } = renderPanel(BOTH_UNCONNECTED);
    expect(getByText("Agent accounts")).toBeTruthy();
    expect(container.querySelectorAll(".cred-card")).toHaveLength(2);
    expect(
      getAllByText(/Tasks you own and your controller conversations run on your own/),
    ).toHaveLength(2);

    // Claude: two Anthropic flows plus a Console key. Codex: the ChatGPT device
    // flow, a Platform key and a workspace token.
    expect(getByText("Sign in with Claude")).toBeTruthy();
    expect(getByText("Sign in with Console")).toBeTruthy();
    expect(getByText("Sign in with ChatGPT")).toBeTruthy();
    expect(getAllByText("Use an API key")).toHaveLength(2);
    expect(getByText("Use a workspace access token")).toBeTruthy();

    fireEvent.click(getByText("Sign in with Claude"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "claude",
      method: "claudeai",
    });
    fireEvent.click(getByText("Sign in with ChatGPT"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "codex",
      method: "device",
    });
  });

  it("reveals a password-type paste field that promises the value is never shown again", () => {
    const { getByText, getAllByText, getByRole, queryByRole, container } =
      renderPanel(BOTH_UNCONNECTED);
    fireEvent.click(getAllByText("Use an API key")[0]!);
    const field = container.querySelector<HTMLInputElement>(
      "#agentacc-claude-api_key",
    )!;
    expect(field).toBeTruthy();
    // The label promises the value is never displayed, so the field must not
    // display it either.
    expect(field.type).toBe("password");
    expect(field.autocomplete).toBe("new-password");
    expect(getByText(/stored sealed, never shown again/)).toBeTruthy();

    // Ruling 147: Save stays enabled on an empty field and REFUSES the click
    // with the sentence the server would have thrown, the field marked and
    // focused, and nothing submitted.
    const save = getByText("Save API key").closest("button")!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(lastSubmit).toBeNull();
    const first = getByRole("alert");
    expect(first.textContent).toContain("Paste the API key first.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(first.id);
    expect(document.activeElement).toBe(field);

    // A second refusal inserts a NEW element, because readers announce an
    // insertion, not a role flip on unchanged text.
    fireEvent.click(save);
    expect(getByRole("alert")).not.toBe(first);

    // Typing clears the mark.
    fireEvent.change(field, { target: { value: "sk-ant-api03-abc" } });
    expect(queryByRole("alert")).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
    fireEvent.click(save);
    expect(lastSubmit).toEqual({
      intent: "backend-set-key",
      backend: "claude",
      kind: "api_key",
      secret: "sk-ant-api03-abc",
    });
  });

  it("refuses an empty workspace access token in the server's own words (ruling 147)", () => {
    const { getByText, getByRole, container } = renderPanel(BOTH_UNCONNECTED);
    fireEvent.click(getByText("Use a workspace access token"));
    const field = container.querySelector<HTMLInputElement>(
      "#agentacc-codex-access_token",
    )!;
    const save = getByText("Save workspace access token").closest("button")!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(lastSubmit).toBeNull();
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("Paste the access token first.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "sk-tok" } });
    fireEvent.click(save);
    expect(lastSubmit).toEqual({
      intent: "backend-set-key",
      backend: "codex",
      kind: "access_token",
      secret: "sk-tok",
    });
  });

  it("says a workspace access token is stored unverified before it is pasted", () => {
    const { getByText } = renderPanel(BOTH_UNCONNECTED);
    fireEvent.click(getByText("Use a workspace access token"));
    expect(getByText(/There is no free way to check a workspace token/)).toBeTruthy();
  });

  it("Codex in progress: the vendor URL, the one-time code and Cancel", () => {
    vi.stubGlobal("navigator", {
      ...window.navigator,
      clipboard: { writeText: () => Promise.resolve() },
    });
    const { getByText, container } = renderPanel([
      backend("claude"),
      backend("codex", { login: runningLogin("codex") }),
    ]);
    expect(getByText("Sign in on OpenAI's page")).toBeTruthy();
    const link = container.querySelector<HTMLAnchorElement>(
      "a[href='https://auth.openai.com/codex/device']",
    )!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noreferrer");
    // The link is a button that names its host, never the printed URL: a few
    // hundred characters of OAuth parameters crushed the labels beside them.
    expect(link.textContent).toContain("Open sign-in page");
    expect(getByText("auth.openai.com")).toBeTruthy();
    expect(container.textContent).not.toContain("https://auth.openai.com");
    expect(getByText("Enter this code on that page")).toBeTruthy();
    expect(getByText("WDJB-MJHT")).toBeTruthy();
    expect(getByText("Waiting for you to finish in the browser")).toBeTruthy();
    // Codex has no paste step: the person types the code on OpenAI's page.
    expect(container.querySelector("input[type='text']")).toBeNull();
    // Both steps are actionable at once: the URL and the code arrive together.
    const marks = container.querySelectorAll(".signin-step");
    expect(marks[0]!.getAttribute("data-state")).toBe("current");
    expect(marks[1]!.getAttribute("data-state")).toBe("current");

    fireEvent.click(getByText("Cancel"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-cancel",
      backend: "codex",
    });
  });

  it("Claude in progress: the paste field is inert until Anthropic asks for a code", () => {
    const waiting = renderPanel([
      backend("claude", { login: runningLogin("claude") }),
      backend("codex"),
    ]);
    // The step title is the field's real label, not an aria-label.
    const before = waiting.container.querySelector<HTMLInputElement>(
      "#agentacc-claude-code",
    )!;
    expect(waiting.getByLabelText("Paste the code Anthropic shows you")).toBe(before);
    expect(before.disabled).toBe(true);
    // Availability, not validation: the step is pending until the code prompt
    // arrives, and its Submit is disabled with it.
    const pendingSteps = waiting.container.querySelectorAll(".signin-step");
    expect(pendingSteps[0]!.getAttribute("data-state")).toBe("current");
    expect(pendingSteps[1]!.getAttribute("data-state")).toBe("pending");
    expect(waiting.getByText("Submit code").closest("button")!.disabled).toBe(true);
    cleanup();

    const { container, getByText, queryByRole } = renderPanel([
      backend("claude", {
        login: runningLogin("claude", {
          state: "awaiting-code",
          needsCode: true,
        }),
      }),
      backend("codex"),
    ]);
    const field = container.querySelector<HTMLInputElement>("#agentacc-claude-code")!;
    expect(field.disabled).toBe(false);
    expect(getByText("Waiting for you to sign in and paste the code")).toBeTruthy();
    const steps = container.querySelectorAll(".signin-step");
    expect(steps[0]!.getAttribute("data-state")).toBe("current");
    expect(steps[1]!.getAttribute("data-state")).toBe("current");

    // Ruling 147: Submit is enabled on the empty field and REFUSES the click
    // with the server's own sentence, the field marked and focused, and no
    // request made.
    const submitBtn = getByText("Submit code").closest("button")!;
    expect(submitBtn.disabled).toBe(false);
    expect(queryByRole("alert")).toBeNull();
    fireEvent.click(submitBtn);
    expect(lastSubmit).toBeNull();
    const alert = queryByRole("alert")!;
    expect(alert.textContent).toContain("Paste the code Anthropic showed you.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(alert.id);
    expect(document.activeElement).toBe(field);

    // Typing clears the accusation; the next click is a request.
    fireEvent.change(field, { target: { value: "paste-me" } });
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(queryByRole("alert")).toBeNull();
    fireEvent.click(submitBtn);
    expect(lastSubmit).toEqual({
      intent: "backend-login-code",
      backend: "claude",
      code: "paste-me",
    });
  });

  it("marks both steps done once the code is on its way, and step 1 never on its own", () => {
    // Nothing on the server can tell whether the person opened the link, so
    // the only evidence that step 1 happened is a submitted code.
    const { container } = renderPanel([
      backend("claude", {
        login: runningLogin("claude", { state: "finishing", needsCode: false }),
      }),
      backend("codex"),
    ]);
    const steps = container.querySelectorAll(".signin-step");
    expect(steps[0]!.getAttribute("data-state")).toBe("done");
    expect(steps[1]!.getAttribute("data-state")).toBe("done");
    // Both carry the hidden word a reader needs, since the check is a glyph.
    expect(container.querySelectorAll(".signin-step .vh")).toHaveLength(2);
  });

  it("before the vendor has printed its link, Open is a disabled button and the host is absent", () => {
    const { container, getByText } = renderPanel([
      backend("claude", {
        login: runningLogin("claude", { state: "starting", url: null }),
      }),
      backend("codex"),
    ]);
    const open = getByText("Open sign-in page").closest("button")!;
    expect(open.disabled).toBe(true);
    expect(container.querySelector(".signin-host")).toBeNull();
    expect(container.querySelector("a[target='_blank']")).toBeNull();
    expect(getByText("Starting the Claude sign-in on this server")).toBeTruthy();
  });

  it("connected: names the method, dates the connection and offers Disconnect", () => {
    const { container, getByText, getByRole } = renderPanel([
      backend("claude", {
        health: {
          ...HEALTH_NONE,
          backend: "claude",
          userId: "u_arda",
          available: true,
          kind: "login",
          method: "claudeai",
          verification: "file",
          verifiedAt: "2026-09-01T10:00:00.000Z",
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail: null,
          accountId: "ubc_claude",
          accountName: "person@example.com",
        },
      }),
      backend("codex", {
        health: {
          ...HEALTH_NONE,
          backend: "codex",
          userId: "u_arda",
          available: true,
          kind: "api_key",
          verification: "credential",
          secretSuffix: "wxyz",
          verifiedAt: null,
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail: null,
        },
      }),
    ]);
    expect(getByText(/Connected via Claude sign-in \(claude\.ai\)/)).toBeTruthy();
    expect(getByText(/Connected via API key · ending in wxyz/)).toBeTruthy();
    expect(container.querySelectorAll(".cred-ok")).toHaveLength(2);
    // A pasted key with no provider verification says so rather than implying a
    // check that never happened.
    expect(getByText("unverified")).toBeTruthy();
    expect(getByText(/verified /)).toBeTruthy();

    // Ruling 149: dropping the stored credential is destructive, so the
    // control carries the danger label. Canary: drop `danger` from the
    // Disconnect className in `ManageButtons` (agent-accounts-regions.tsx).
    const disconnect = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".cred-card .cred-manage button"),
    ).find((button) => button.textContent === "Disconnect")!;
    expect(disconnect.textContent).toContain("Disconnect");
    expect(Array.from(disconnect.classList)).toContain("danger");
    // Ruling 481(b) (F40-49): the press asks first. It used to post the
    // disconnect (the vendor logout and the credential's deletion) at once.
    // Canary: submit from the button's onClick again and `lastSubmit` is set
    // before the dialog exists.
    fireEvent.click(disconnect);
    expect(lastSubmit).toBeNull();
    const dialog = getByRole("alertdialog", { name: "Disconnect Claude?" });
    expect(dialog.getAttribute("data-screen-label")).toBe("Disconnect agent account dialog");
    expect(dialog.textContent).toContain(
      "Tasks you own and your controller conversations can't start a Claude run until you connect again.",
    );
    // Cancel leaves the account connected.
    fireEvent.click(getByText("Cancel", { selector: ".confirm-actions button" }));
    expect(lastSubmit).toBeNull();

    fireEvent.click(disconnect);
    fireEvent.click(
      getByText("Disconnect Claude", { selector: ".confirm-actions button.btn.danger" }),
    );
    // Ruling 507: a disconnect names the account it removes.
    expect(lastSubmit).toEqual({
      intent: "backend-disconnect",
      backend: "claude",
      account: "ubc_claude",
    });
  });

  it("ruling 130(d): a connected card shows the last refusal Viberr observed on the account, or a spent window as a neutral pill", () => {
    // Canary: remove the `lastRefusal` render branch and both pills vanish.
    const connected = (name: "claude" | "codex") => ({
      ...HEALTH_NONE,
      backend: name,
      userId: "u_arda",
      available: true,
      kind: "login" as const,
      method: name === "claude" ? ("claudeai" as const) : ("device" as const),
      verification: "file" as const,
      verifiedAt: "2026-09-01T10:00:00.000Z",
      connectedAt: "2026-09-01T10:00:00.000Z",
      detail: null,
    });
    const { container } = renderPanel([
      backend("claude", {
        health: connected("claude"),
        lastRefusal: {
          kind: "credential",
          providerText: "The account's organization does not allow Claude Code (oauth_org_not_allowed).",
          observedAt: "2026-09-07T10:00:00.000Z",
          runId: "run_refused",
          resetsAt: null,
          resetsAtPrecision: null,
        },
      }),
      backend("codex", {
        health: connected("codex"),
        lastRefusal: {
          kind: "quota",
          providerText: "You've hit your usage limit.",
          observedAt: "2026-09-07T10:05:00.000Z",
          runId: "run_spent",
          resetsAt: "2026-09-07T11:50:00.000Z",
          resetsAtPrecision: "exact",
        },
      }),
    ]);
    const pills = Array.from(container.querySelectorAll(".pill")).map((p) => p.textContent ?? "");
    expect(pills.some((t) => t.startsWith("refused by the provider · "))).toBe(true);
    expect(pills.some((t) => t.startsWith("usage window spent · reopens "))).toBe(true);
    // The credential refusal is a risk pill; the spent window is neutral.
    const refused = Array.from(container.querySelectorAll(".pill")).find((p) => /refused by the provider/.test(p.textContent ?? ""))!;
    expect(refused.className).toMatch(/risk/);
    const spent = Array.from(container.querySelectorAll(".pill")).find((p) => /usage window spent/.test(p.textContent ?? ""))!;
    expect(spent.className).not.toMatch(/risk/);
    // The note carries the provider's own words and says what the pill is.
    const note = container.querySelector('[data-refusal="credential"]')!;
    expect(note.textContent).toContain("The account's organization does not allow Claude Code (oauth_org_not_allowed).");
    expect(note.textContent).toContain("last refusal Viberr observed on this account");
    expect(note.textContent).toContain("not proof the account works");
    expect(note.textContent).toContain("any completed Claude run retires it");
    // Ruling 165: the card names the second retirement, the one the remedy
    // asks for, so a person who connects another account is not told the old
    // account's verdict still stands.
    expect(note.textContent).toContain("as does switching to or connecting a different Claude account here");
    const window_ = container.querySelector('[data-refusal="quota"]')!;
    expect(window_.textContent).toContain("Spent as of");
    expect(window_.textContent).toContain("reopens");
    expect(window_.textContent).toContain("Any completed Codex run retires this notice");
    expect(window_.textContent).toContain("as does switching to or connecting a different Codex account here");
  });

  it("ruling 130(d): no refusal, no pill and no note", () => {
    const { container } = renderPanel([
      backend("claude", { lastRefusal: null }),
      backend("codex"),
    ]);
    expect(container.querySelector("[data-refusal]")).toBeNull();
    expect(container.textContent).not.toMatch(/refused by the provider|usage window spent/);
  });

  it("C6: the connected-on and verified dates hydrate safely — the UTC day first, the viewer's calendar date after hydration", () => {
    const backends = [
      backend("claude", {
        health: {
          ...HEALTH_NONE,
          backend: "claude",
          userId: "u_arda",
          available: true,
          kind: "login",
          method: "claudeai",
          verification: "file",
          verifiedAt: "2026-09-01T10:00:00.000Z",
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail: null,
        },
      }),
    ];
    // The server pass depends on the timestamp alone: the SSR host's zone is
    // not the viewer's, and a calendar date rendered in it hydrates to
    // different text near midnight (React #418).
    const ssr = renderToString(panelElement(backends));
    expect(ssr).toContain(" on ");
    expect(ssr).toContain("verified ");
    expect(ssr.split("2026-09-01 (UTC)")).toHaveLength(3);
    expect(ssr).not.toContain("Sep 1, 2026");
    // After hydration the effect swaps in the viewer-local calendar date, on
    // the sentence AND on the pill.
    const { container } = renderPanel(backends);
    expect(container.textContent).toContain("on Sep 1, 2026.");
    expect(container.textContent).toContain("verified Sep 1, 2026");
    expect(container.textContent).not.toContain("(UTC)");
  });

  it("a login whose credential file vanished warns with the server's own sentence", () => {
    const { container, getByText } = renderPanel([
      backend("claude", {
        health: {
          ...HEALTH_NONE,
          backend: "claude",
          userId: "u_arda",
          available: false,
          kind: "login",
          method: "console",
          verification: "none",
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail:
            "Your Claude sign-in file is missing from this server (the runtime volume was wiped). Sign in again on your Profile → Agent accounts.",
        },
      }),
      backend("codex"),
    ]);
    expect(getByText("sign-in file missing")).toBeTruthy();
    expect(getByText(/the runtime volume was wiped/)).toBeTruthy();
    expect(container.querySelector(".cred-warn")).toBeTruthy();
  });

  it("keeps showing an in-progress sign-in even when a credential already works", () => {
    // Replacing a key with a hosted sign-in, or restarting one from the "Start
    // again" button on a card that already has a key, must not run the vendor's
    // process invisibly: the link, the status line and Cancel are the only way
    // the person can finish (or stop) it.
    const { getByText, container } = renderPanel([
      backend("claude", {
        health: {
          ...HEALTH_NONE,
          backend: "claude",
          userId: "u_arda",
          available: true,
          kind: "api_key",
          verification: "credential",
          secretSuffix: "wxyz",
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail: null,
        },
        login: runningLogin("claude", { id: "bkl_2", state: "awaiting-browser" }),
      }),
      backend("codex"),
    ]);
    expect(
      container.querySelector("a[href='https://claude.ai/oauth']"),
    ).toBeTruthy();
    expect(getByText("Sign in on Anthropic's page")).toBeTruthy();
    expect(getByText("claude.ai")).toBeTruthy();
    expect(getByText("Waiting for you to finish in the browser")).toBeTruthy();
    expect(getByText("Cancel")).toBeTruthy();
    // The badge says what is happening now, not what was true before it started.
    expect(getByText("signing in")).toBeTruthy();
  });

  it("moves focus into the labelled step group, and keeps the live region to the status line", () => {
    // The card replaces the button the person just pressed, and every value in
    // it (the URL, the code, the status) arrives seconds later from the poll.
    const { container } = renderPanel([
      backend("claude"),
      backend("codex", { login: runningLogin("codex") }),
    ]);
    const group = container.querySelector<HTMLDivElement>("[role='group']")!;
    expect(group.getAttribute("aria-label")).toBe("Codex sign-in");
    expect(document.activeElement).toBe(group);
    // ONE live region, and it is the sentence, not the list: a status role is
    // implicitly atomic, so a region wrapping the link would re-read the whole
    // URL on every poll that changed anything.
    // Scoped to the card: the toast host outside it has its own live region.
    const regions = group.closest(".cred-card")!.querySelectorAll("[aria-live]");
    expect(regions).toHaveLength(1);
    const status = regions[0]!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Waiting for you to finish in the browser");
    expect(status.querySelector("a, button, input")).toBeNull();
    expect(status.contains(container.querySelector("a[target='_blank']"))).toBe(false);
  });

  it("offers the sign-in it tells the person to use when the credential file is gone", () => {
    // The health sentence for this state ends "Sign in again on your Profile →
    // Agent accounts", which is this card: it has to carry that sign-in — into
    // THAT account's own home (ruling 507), not a new one.
    const { getByText } = renderPanel([
      backend("claude", {
        health: {
          ...HEALTH_NONE,
          backend: "claude",
          userId: "u_arda",
          available: false,
          kind: "login",
          method: "console",
          verification: "none",
          connectedAt: "2026-09-01T10:00:00.000Z",
          detail:
            "Your Claude sign-in file is missing from this server (the runtime volume was wiped). Sign in again on your Profile → Agent accounts.",
          accountId: "ubc_wiped",
          accountName: "Console sign-in",
        },
      }),
      backend("codex"),
    ]);
    expect(getByText("Disconnect")).toBeTruthy();
    fireEvent.click(getByText("Sign in with Console"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "claude",
      method: "console",
      account: "ubc_wiped",
    });
  });

  it("a failed sign-in shows the server's sentence and a Start again for that flow", () => {
    const { getByText } = renderPanel([
      backend("claude", {
        login: runningLogin("claude", {
          state: "failed",
          method: "console",
          error: "error: browser authorization was refused.",
        }),
      }),
      backend("codex"),
    ]);
    expect(getByText("error: browser authorization was refused.")).toBeTruthy();
    fireEvent.click(getByText("Start again"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "claude",
      method: "console",
    });
  });

  it("toasts the connection only when the POLL says the vendor confirmed it", async () => {
    vi.useFakeTimers();
    const succeeded: BackendLoginPollData = {
      login: runningLogin("claude", { state: "succeeded", needsCode: false }),
      health: {
        available: true,
        kind: "login",
        method: "claudeai",
        detail: null,
        secretSuffix: null,
        verifiedAt: "2026-09-02T09:10:00.000Z",
        connectedAt: "2026-09-02T09:10:00.000Z",
      },
    };
    const { queryByText } = renderPanel(
      [
        backend("claude", {
          login: runningLogin("claude", {
            state: "awaiting-code",
            needsCode: true,
          }),
        }),
        backend("codex"),
      ],
      () => succeeded,
    );

    // Nothing has come back yet: a card that is still waiting must not claim a
    // connection (the toast-honesty rule).
    expect(queryByText("Claude connected")).toBeNull();

    // One poll interval later the server answers, and only then does the toast
    // appear.
    // Inside `act` so the poll's state update, the toast host's two-step
    // promotion and the revalidation all commit before the DOM is read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(queryByText("Claude connected")).toBeTruthy();
  });

  /**
   * Ruling 457, test audit L14-29: a poll from a signed-out tab used to
   * navigate it to /login. It now answers 401 with the conventions' error
   * body, and that body reaches this card as the poll's answer; the page's
   * next navigation asks for the sign-in. A poll the server can't answer at
   * all (a restart, a 5xx, a dead network) reached the Profile page's error
   * boundary and replaced the page; the route's `clientLoader` now answers
   * null. Either way the card keeps the sign-in the page drew, claims
   * nothing, and polls on.
   */
  it.each<[string, () => BackendLoginPollAnswer]>([
    [
      "is refused as signed out",
      () => ({ error: { code: "unauthorized", message: "Sign in to see your agent accounts." } }),
    ],
    ["can't reach the server", unreachable],
  ])("keeps the sign-in the page drew when a poll %s", async (_label, poll) => {
    vi.useFakeTimers();
    const { getByText, queryByText } = renderPanel(
      [backend("claude", { login: runningLogin("claude") }), backend("codex")],
      poll,
    );
    // Two poll intervals: the answer has landed, and been read again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });
    // CANARY: let a refusal past the session-id match in `useSignInPoll`
    // (agent-accounts-actions.ts; its SAFETY cast then hides it from the type
    // checker) and reading its absent `health` takes the Profile page down
    // with it; delete the route's `clientLoader` and the unreachable poll does.
    expect(getByText("signing in")).toBeTruthy();
    expect(getByText("Waiting for you to finish in the browser")).toBeTruthy();
    expect(queryByText("Claude connected")).toBeNull();
  });
});

/**
 * Pass 34 review: a reset the provider gave in WORDS is a UTC calendar day,
 * not a minute — the card rendered it as a to-the-minute local time, which can
 * name the wrong day and claims precision the record never had.
 */
describe("the usage-window reset renders at the precision it has", () => {
  const connectedHealth = (name: "claude" | "codex") => ({
    ...HEALTH_NONE,
    backend: name,
    userId: "u_arda",
    available: true,
    kind: "login" as const,
    method: name === "claude" ? ("claudeai" as const) : ("device" as const),
    verification: "file" as const,
    verifiedAt: "2026-09-01T10:00:00.000Z",
    connectedAt: "2026-09-01T10:00:00.000Z",
    detail: null,
  });

  it("a prose-derived reset shows the UTC day; an exact one keeps its clock", () => {
    // Canary: drop `resetsAtPrecision` from the card (render every reset with
    // `LocalDayDotTime`) — the prose case regains a minute it never had.
    const prose = renderPanel([
      backend("claude", {
        health: connectedHealth("claude"),
          lastRefusal: {
            kind: "quota",
            providerText: "Usage limit reached.",
            observedAt: "2026-09-04T10:00:00.000Z",
            runId: "run_a",
            resetsAt: "2026-09-07T00:00:00.000Z",
          resetsAtPrecision: "prose",
        },
      }),
    ]);
    expect(prose.container.textContent).toContain("2026-09-07 (UTC)");
    prose.unmount();

    const exact = renderPanel([
      backend("claude", {
        health: connectedHealth("claude"),
          lastRefusal: {
            kind: "quota",
            providerText: "Usage limit reached.",
            observedAt: "2026-09-04T10:00:00.000Z",
            runId: "run_b",
            resetsAt: "2026-09-07T11:50:00.000Z",
          resetsAtPrecision: "exact",
        },
      }),
    ]);
    expect(exact.container.textContent).not.toContain("2026-09-07 (UTC)");
  });
});

/**
 * Ruling 294 (pass 37, F37-129): the sign-in link is copyable, and the account's
 * own usage reading is on the card.
 *
 * The owner asked for both. The link half exists because opening it here only
 * works when the browser reading this page is the one holding the vendor
 * session, and often it is not; until now the only way to move the URL was to
 * right-click an anchor whose href is a 300-character OAuth redirect.
 */
describe("ruling 294: copy the sign-in link", () => {
  const CONNECTED_CLAUDE = {
    ...HEALTH_NONE,
    backend: "claude" as const,
    userId: "u_arda",
    available: true,
    kind: "login" as const,
    method: "claudeai" as const,
    verification: "file" as const,
    verifiedAt: "2026-09-15T09:00:00.000Z",
    connectedAt: "2026-09-15T09:00:00.000Z",
    detail: null,
  };

  function clipboardSpy() {
    const writes: string[] = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: (v: string) => {
          writes.push(v);
          return Promise.resolve();
        },
      },
    });
    return writes;
  }

  it("offers it on BOTH backends, carrying each vendor's own url", async () => {
    // CANARY: drop the copy button from step 1 and neither label is found.
    // Both are asserted together because step 1 is shared JSX: claude's
    // Anthropic OAuth url and codex's device-login page are the same prop, and
    // a change that serves one serves both or neither.
    const writes = clipboardSpy();
    const { getByLabelText } = renderPanel([
      backend("claude", { login: runningLogin("claude") }),
      backend("codex", { login: runningLogin("codex") }),
    ]);

    await act(async () => {
      fireEvent.click(getByLabelText("Copy the Anthropic sign-in link"));
    });
    expect(writes).toEqual(["https://claude.ai/oauth"]);

    await act(async () => {
      fireEvent.click(getByLabelText("Copy the OpenAI sign-in link"));
    });
    expect(writes).toEqual([
      "https://claude.ai/oauth",
      "https://auth.openai.com/codex/device",
    ]);
  });

  it("the link button and the code button do not both say Copied", async () => {
    // CANARY: make `copied` a boolean again. Codex is the only backend where
    // both buttons are on screen at once, and one flag made copying the link
    // announce that the CODE had been copied too.
    clipboardSpy();
    const { getByLabelText, getAllByText, queryAllByText } = renderPanel([
      backend("codex", { login: runningLogin("codex") }),
    ]);
    expect(getByLabelText("Copy the sign-in code WDJB-MJHT")).toBeTruthy();

    await act(async () => {
      fireEvent.click(getByLabelText("Copy the OpenAI sign-in link"));
    });
    // Exactly one control reads "Copied": the link's. The code button still
    // offers its own action.
    expect(getAllByText("Copied")).toHaveLength(1);
    expect(queryAllByText("Copy")).toHaveLength(1);
  });

  it("shows the viewer's own usage reading, with its age and the clamp", () => {
    // CANARY: render `usage.utilization` without the clamp and an overage
    // account reads "118% of seven day" on the card built to be trusted.
    const { getByText, container } = renderPanel([
      backend("claude", {
        health: CONNECTED_CLAUDE,
        usage: {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 1.18,
          resetsAt: "2026-09-17T10:00:00.000Z",
          isUsingOverage: true,
          observedAt: "2026-09-15T18:02:00.000Z",
          windowReset: false,
        },
      }),
    ]);
    expect(getByText("100% of seven day")).toBeTruthy();
    expect(container.querySelector('[data-usage="seven_day"]')).toBeTruthy();
    // An observation, never a probe: the age is what stops a figure from this
    // morning reading as current.
    expect(getByText(/Observed/)).toBeTruthy();
    expect(getByText(/not a live reading/)).toBeTruthy();
    // Runs report readings as they work (Codex's on each call, ruling 604), so
    // it is not "only when another run finishes".
    expect(getByText(/it moves when a run reports another/)).toBeTruthy();
    expect(getByText(/running on overage/)).toBeTruthy();
  });

  it("says a missing utilization is not reported, never a fabricated 0%", () => {
    // CANARY: `?? 0`. A fabricated zero on this card reads as a completely
    // fresh window, which is the opposite of not knowing.
    const { getByText, queryByText } = renderPanel([
      backend("claude", {
        health: CONNECTED_CLAUDE,
        usage: {
          status: "allowed",
          // The wire format turns a missing provider string into "", not null,
          // so an empty window name must not compose "0% of ".
          rateLimitType: "",
          utilization: null,
          resetsAt: null,
          isUsingOverage: false,
          observedAt: "2026-09-15T18:02:00.000Z",
          windowReset: false,
        },
      }),
    ]);
    expect(getByText("window usage not reported")).toBeTruthy();
    expect(queryByText(/0%/)).toBeNull();
  });

  /**
   * Ruling 481(d) (F40-50): once the reading's own window has reset, the card
   * stops presenting it as current. It used to keep "92% of five hour" and
   * "The window resets 03:30" in the present tense hours after 03:30.
   *
   * Canary: drop the `windowReset` branch in `usageText`
   * (agent-accounts-derive.ts; the percentage comes back) or in `UsageNote`
   * (agent-account-in-use.tsx; the present tense comes back).
   */
  it("words a reading whose window has reset in the past tense, with no percentage (ruling 481)", () => {
    const { getByText, queryByText, container } = renderPanel([
      backend("claude", {
        health: CONNECTED_CLAUDE,
        usage: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          utilization: 0.92,
          resetsAt: "2026-09-25T00:30:00.000Z",
          isUsingOverage: false,
          observedAt: "2026-09-25T00:01:00.000Z",
          windowReset: true,
        },
      }),
    ]);
    const pill = getByText("five hour window reset");
    expect(pill.closest(".pill")!.classList.contains("risk")).toBe(false);
    expect(queryByText(/92%/)).toBeNull();
    const note = container.querySelector('[data-usage="five_hour"]')!;
    expect(note.textContent).toContain("That window reset");
    expect(note.textContent).toContain("no Claude run has reported a reading since");
    expect(note.textContent).not.toContain("The window resets");
  });

  it("renders no usage at all when the card carries none", () => {
    // The honest sparse case, and the one codex is in permanently: only Claude
    // runs report a rate-limit reading, so a card with no reading shows nothing
    // rather than an empty row that reads as broken.
    const { queryByText, container } = renderPanel([
      backend("codex", { health: { ...CONNECTED_CLAUDE, backend: "codex" } }),
    ]);
    expect(container.querySelector("[data-usage]")).toBeNull();
    expect(queryByText(/usage not reported/)).toBeNull();
  });
});

/**
 * Ruling 507: one account of several on a backend, as the loader lists it:
 * a Claude sign-in by default, connected and verified on 2026-09-01.
 */
type Account = NonNullable<ProfileBackend["accounts"]>[number];

function account(
  id: string,
  name: string,
  overrides: Partial<Account["health"]> & { active?: boolean; label?: string | null } = {},
): Account {
  const { active = false, label = null, ...health } = overrides;
  return {
    id,
    name,
    label,
    active,
    health: {
      ...HEALTH_NONE,
      backend: "claude",
      userId: "u_arda",
      available: true,
      kind: "login",
      method: "claudeai",
      verification: "file",
      verifiedAt: "2026-09-01T10:00:00.000Z",
      connectedAt: "2026-09-01T10:00:00.000Z",
      detail: null,
      accountId: id,
      accountName: name,
      ...health,
    },
  };
}

const WORK = account("ubc_work", "Work", { active: true, label: "Work" });
const PERSONAL = account("ubc_personal", "personal@example.com", {
  connectedAt: "2026-08-20T10:00:00.000Z",
});
const KEY = account("ubc_key", "API key ending in abcd", {
  kind: "api_key",
  method: null,
  verification: "credential",
  secretSuffix: "abcd",
});

/** A backend card holding `accounts`, the active one's health leading it. */
function withAccounts(
  name: "claude" | "codex",
  accounts: Account[],
  overrides: Partial<ProfileBackend> = {},
): ProfileBackend {
  const active = accounts.find((a) => a.active)!;
  return backend(name, {
    health: active.health,
    accounts,
    limits: { maxAccounts: 10, maxLabelLength: 60 },
    ...overrides,
  });
}

/** Ruling 616: a card's account picker, named by its label and the account
 *  in use ("Runs use Work Claude sign-in (claude.ai)"). */
function pickerFor(view: RenderResult, accountName: string): HTMLElement {
  return view.getByRole("button", { name: (name) => name.startsWith(`Runs use ${accountName} `) });
}

/** One account in the open picker's menu, named by the account and its line. */
function accountRow(view: RenderResult, accountName: string): HTMLElement {
  return view.getByRole("menuitemradio", { name: (name) => name.startsWith(`${accountName} `) });
}

/**
 * Ruling 368: both cards share one fetcher, so every control went `disabled`
 * for the whole wait with its resting label, the one that was pressed
 * included: it painted the .45 refused step and said nothing while the server
 * started the sign-in. The request is read off the fetcher (its intent, its
 * backend, its method) and shows on the button that sent it; everything else,
 * the other card's controls included, only waits.
 * Canary: drop the `fetcher.formData?.get("backend") === backend` check in
 * `cardRequest` (agent-accounts-derive.ts) and the other card's button claims
 * the work too.
 */
describe("ruling 368: the account request in flight", () => {
  function renderHeld(backends: ProfileBackend[]) {
    const Stub = createRoutesStub([
      {
        path: "/profile",
        Component: () => {
          const fetcher = useFetcher();
          return (
            <ToastProvider>
              <AgentAccountsPanel
                backends={backends}
                fetcher={fetcher}
                submit={(fields) => fetcher.submit(fields, { method: "post" })}
              />
            </ToastProvider>
          );
        },
        // Never answers: the test reads the wait itself.
        action: () => new Promise(() => {}),
      },
    ]);
    return render(<Stub initialEntries={["/profile"]} />);
  }

  it("a sign-in start reads Starting sign-in… on its own button only", async () => {
    const { getByText } = renderHeld(BOTH_UNCONNECTED);
    const claude = getByText("Sign in with Claude").closest("button")!;
    fireEvent.click(claude);
    await waitFor(() => expect(claude.getAttribute("aria-busy")).toBe("true"));
    expect(claude.textContent).toBe("Starting sign-in…");
    expect(claude.disabled).toBe(true);
    expect(claude.querySelector("svg.ico.spin")).not.toBeNull();
    // The same card's other method, and the other card, only wait.
    for (const text of ["Sign in with Console", "Sign in with ChatGPT"]) {
      const b = getByText(text).closest("button")!;
      expect(b.disabled).toBe(true);
      expect(b.hasAttribute("aria-busy")).toBe(false);
    }
  });

  it("a cancel reads Cancelling…, and Submit code does not claim it", async () => {
    const { getByText } = renderHeld([
      backend("claude", {
        login: runningLogin("claude", { state: "awaiting-code", needsCode: true }),
      }),
      backend("codex"),
    ]);
    const cancel = getByText("Cancel").closest("button")!;
    fireEvent.click(cancel);
    await waitFor(() => expect(cancel.getAttribute("aria-busy")).toBe("true"));
    expect(cancel.textContent).toBe("Cancelling…");
    const submitCode = getByText("Submit code").closest("button")!;
    expect(submitCode.disabled).toBe(true);
    expect(submitCode.hasAttribute("aria-busy")).toBe(false);
  });

  // Ruling 616: the switch is sent from the picker's menu, so the picker is
  // the control that shows it, and it names the account in use until the
  // loader says otherwise (no optimistic switch).
  // CANARY: stop handing the picker the account its switch names
  // (`switchingTo`) and it sits still through the switch, the press lost.
  it("a switch reads Switching to… on its own picker, and the other card's picker only waits", async () => {
    const codexAccount = account("ubc_cx", "cx@example.com", {
      active: true,
      backend: "codex",
      method: "device",
    });
    const view = renderHeld([withAccounts("claude", [WORK, PERSONAL]), withAccounts("codex", [codexAccount])]);
    const claude = pickerFor(view, "Work");
    fireEvent.click(claude);
    fireEvent.click(accountRow(view, "personal@example.com"));
    await waitFor(() => expect(claude.getAttribute("aria-busy")).toBe("true"));
    expect(claude.querySelector(".acct-nm")!.textContent).toBe("Work");
    expect(claude.textContent).toContain("Switching to personal@example.com…");
    expect(claude.querySelector("svg.ico.spin")).not.toBeNull();
    // A second press opens nothing while the first is in flight.
    fireEvent.click(claude);
    expect(view.queryByRole("menu")).toBeNull();
    const codex = pickerFor(view, "cx@example.com");
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(codex.hasAttribute("aria-busy")).toBe(false);
  });
});


/**
 * Rulings 507 and 616: a person may keep several accounts per backend. The
 * card leads with the one runs use, as a picker whose menu lists every
 * account, the one in use checked, and switches to the one chosen (no
 * sign-in). The same menu adds another account and opens the others'
 * management, where each is renamed, signed in again or disconnected without
 * first becoming the one in use.
 */
describe("rulings 507 and 616: several accounts on one backend", () => {
  const claudeWith = (accounts: Account[], overrides: Partial<ProfileBackend> = {}) =>
    withAccounts("claude", accounts, overrides);

  function rowOf(container: HTMLElement, id: string): HTMLElement {
    return container.querySelector<HTMLElement>(`[data-account="${id}"]`)!;
  }

  function buttonIn(scope: HTMLElement, text: string): HTMLButtonElement {
    const found = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === text,
    );
    if (!found) throw new Error(`no "${text}" button`);
    return found;
  }

  /** Open the picker over `accountName` and choose a menu action. */
  function chooseAction(view: RenderResult, accountName: string, action: string | RegExp): void {
    fireEvent.click(pickerFor(view, accountName));
    fireEvent.click(view.getByRole("menuitem", { name: action }));
  }

  // The switch is the picker's whole job: the row chosen is the account the
  // next run bills, and the store refuses nothing a person can choose here.
  // CANARY: submit the active account's id instead of the chosen row's and
  // runs keep billing the account the person just left.
  it("the picker names the account runs use and lists every account, the one in use checked; a choice is one switch", () => {
    const view = renderPanel([claudeWith([WORK, PERSONAL, KEY]), backend("codex")]);
    const trigger = pickerFor(view, "Work");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    expect(view.getByRole("menu", { name: "Claude accounts 3 of 10" })).toBeTruthy();
    expect(view.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(accountRow(view, "Work").getAttribute("aria-checked")).toBe("true");
    expect(accountRow(view, "Work").textContent).toContain("in use");
    expect(accountRow(view, "personal@example.com").getAttribute("aria-checked")).toBe("false");
    expect(accountRow(view, "personal@example.com").textContent).toContain("Claude sign-in (claude.ai)");
    expect(accountRow(view, "API key ending in abcd").getAttribute("aria-checked")).toBe("false");

    // Choosing the account in use closes the menu and asks the server nothing.
    fireEvent.click(accountRow(view, "Work"));
    expect(view.queryByRole("menu")).toBeNull();
    expect(lastSubmit).toBeNull();

    fireEvent.click(trigger);
    fireEvent.click(accountRow(view, "personal@example.com"));
    expect(lastSubmit).toEqual({
      intent: "backend-account-switch",
      backend: "claude",
      account: "ubc_personal",
    });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // The menu keeps the contract of the repo's other menus (StageMenu, the run
  // picker): it opens on the checked row, the arrows wrap, Home and End jump,
  // and Escape hands the focus back to the trigger.
  // CANARY: drop the focus-on-open effect and the arrows have no row to walk
  // from; drop `close(true)`'s refocus and Escape leaves the focus on <body>.
  it("the keyboard opens the menu on the account in use, walks its rows, and Escape hands the focus back", () => {
    const view = renderPanel([claudeWith([WORK, PERSONAL]), backend("codex")]);
    const trigger = pickerFor(view, "Work");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(accountRow(view, "Work"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(accountRow(view, "personal@example.com"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Manage other accounts" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(accountRow(view, "Work"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(view.getByRole("menuitem", { name: "Manage other accounts" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(accountRow(view, "Work"));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(view.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  // The store refuses a switch to an account whose sign-in file is gone, so
  // the row must not send one; the account's way back is its own sign-in.
  // CANARY: let the dimmed row's press reach `onSwitch` and the person is
  // sent the refusal the store has already decided.
  it("lists an account whose sign-in file is gone without letting it be chosen, and its management offers the sign-in", () => {
    const wiped = account("ubc_wiped", "wiped@example.com", {
      available: false,
      verification: "none",
      detail: "Your Claude sign-in file is missing from this server (the runtime volume was wiped).",
    });
    const view = renderPanel([claudeWith([WORK, wiped]), backend("codex")]);
    fireEvent.click(pickerFor(view, "Work"));
    const row = accountRow(view, "wiped@example.com");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("sign-in file missing");
    fireEvent.click(row);
    expect(lastSubmit).toBeNull();
    expect(view.getByRole("menu")).toBeTruthy();

    fireEvent.click(view.getByRole("menuitem", { name: "Manage other accounts" }));
    const managed = rowOf(view.container, "ubc_wiped");
    expect(managed.textContent).toContain("sign-in file missing");
    fireEvent.click(buttonIn(managed, "Sign in with Claude"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "claude",
      method: "claudeai",
      account: "ubc_wiped",
    });
  });

  // What the menu opens replaces the row that opened it, so the focus has to
  // be put somewhere: into the section, and back on the picker when it closes.
  // CANARY: drop the `focusAsked` effect and a keyboard user is left on
  // <body> once the menu row they chose has gone.
  it("what the menu opens takes the focus, and closing it hands the focus back to the picker", () => {
    const view = renderPanel([claudeWith([WORK, PERSONAL]), backend("codex")]);
    const trigger = pickerFor(view, "Work");
    chooseAction(view, "Work", "Manage other accounts");
    expect(document.activeElement).toBe(view.getByRole("group", { name: "Other Claude accounts" }));
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(view.queryByRole("group", { name: "Other Claude accounts" })).toBeNull();
    expect(document.activeElement).toBe(trigger);

    chooseAction(view, "Work", "Add another Claude account");
    const adding = view.getByRole("group", { name: "Add another Claude account" });
    expect(document.activeElement).toBe(adding);
    fireEvent.click(buttonIn(adding, "Cancel"));
    expect(document.activeElement).toBe(trigger);
  });

  it("disconnecting another account says runs keep the one in use; the one in use says who takes over", () => {
    const view = renderPanel([claudeWith([WORK, PERSONAL, KEY]), backend("codex")]);
    chooseAction(view, "Work", "Manage other accounts");
    // The management lists only the others; the account in use is managed
    // under its own health line.
    expect(view.container.querySelector('[data-account="ubc_work"]')).toBeNull();
    fireEvent.click(buttonIn(rowOf(view.container, "ubc_key"), "Disconnect"));
    const other = view.getByRole("alertdialog", { name: "Disconnect API key ending in abcd?" });
    expect(other.textContent).toContain("Your runs keep using Work.");
    fireEvent.click(buttonIn(other, "Disconnect API key ending in abcd"));
    expect(lastSubmit).toEqual({ intent: "backend-disconnect", backend: "claude", account: "ubc_key" });
    cleanup();

    const again = renderPanel([claudeWith([WORK, PERSONAL, KEY]), backend("codex")]);
    const activeManage = again.container.querySelector<HTMLElement>(".cred-card .cred-manage")!;
    fireEvent.click(buttonIn(activeManage, "Disconnect"));
    const active = again.getByRole("alertdialog", { name: "Disconnect Work?" });
    // The next account in the list is the one used before it: that is who
    // the store hands runs to.
    expect(active.textContent).toContain(
      "Your runs switch to personal@example.com, the Claude account you used before it.",
    );
  });

  /** What the loader finds for the Claude card: its accounts and sign-in. */
  interface ClaudeOnServer {
    accounts: Account[];
    login: ProfileBackend["login"];
  }

  /** The panel over a loader that reads `server` on every load, a fresh copy
   *  each time as a decoded payload is; `reload` is a live event or another
   *  panel's post revalidating the page. */
  async function renderLoaded(server: ClaudeOnServer) {
    lastSubmit = null;
    let revalidate: () => Promise<void> = async () => {};
    const Stub = createRoutesStub([
      {
        path: "/profile",
        loader: (): ProfileBackend[] => [
          server.accounts.length > 0
            ? claudeWith(structuredClone(server.accounts), { login: server.login })
            : backend("claude", { login: server.login }),
          backend("codex"),
        ],
        Component: () => {
          revalidate = useRevalidator().revalidate;
          return <PanelOver backends={useLoaderData<ProfileBackend[]>()} />;
        },
      },
      // A sign-in on the card starts its poll; nothing here answers it.
      { path: "/resources/backend-login", loader: clientLoaderOver(backendLoginRoute, () => null) },
    ]);
    const view = render(<Stub initialEntries={["/profile"]} />);
    await view.findByText("Agent accounts");
    return { view, reload: () => act(() => revalidate()) };
  }

  // The confirm asks about an account on screen. An account disconnected in
  // another tab while its "Disconnect …?" was open here left the dialog open
  // over an account that no longer existed while others remained; with none
  // left, or a sign-in from another tab in the card's place, the dialog went
  // with the accounts but the card's state kept it, and the next load that
  // showed an account opened it again with nobody asking.
  // CANARY: drop `setConfirmDisconnect(null)` from the region reset in
  // `AgentAccountCard` (agent-accounts-panel.tsx) and the sign-in row ends
  // with the dialog open; render the dialog from the account the Disconnect
  // was pressed on instead of finding it in the load (agent-account-in-use.tsx)
  // and the other rows do too; hold the account itself and find it by
  // identity instead of id, and the load that changed nothing closes it under
  // the person reading it.
  it.each<[string, ClaudeOnServer[], string]>([
    [
      "another tab disconnects it and other accounts remain",
      [{ accounts: [WORK, PERSONAL], login: null }],
      "Work",
    ],
    [
      "another tab disconnects every account, then connects a new one",
      [
        { accounts: [], login: null },
        { accounts: [account("ubc_fresh", "fresh@example.com", { active: true })], login: null },
      ],
      "fresh@example.com",
    ],
    [
      "another tab starts a sign-in, then cancels it",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude", { state: "cancelled" }) },
      ],
      "Work",
    ],
  ])("a Disconnect confirm closes, and stays closed, when %s", async (_label, loads, inUse) => {
    const server: ClaudeOnServer = { accounts: [WORK, PERSONAL, KEY], login: null };
    const { view, reload } = await renderLoaded(server);
    chooseAction(view, "Work", "Manage other accounts");
    fireEvent.click(buttonIn(rowOf(view.container, "ubc_key"), "Disconnect"));
    // A load that still lists the account (a live event about something
    // else) leaves the dialog where the person is reading it.
    await reload();
    expect(view.getByRole("alertdialog", { name: "Disconnect API key ending in abcd?" })).toBeTruthy();

    for (const [index, load] of loads.entries()) {
      Object.assign(server, load);
      await reload();
      expect(view.queryByRole("alertdialog"), `after load ${index + 1}`).toBeNull();
    }
    // The card shows an account in use again, where the dialog would be.
    expect(pickerFor(view, inUse)).toBeTruthy();
  });

  // Every word of an open confirm is about what confirming does now. The
  // dialog read the account's name and whether runs use it off the account
  // the Disconnect was pressed on, and who else is in use off the latest
  // load: after a switch in another tab, "Disconnect API key ending in abcd?"
  // said "Your runs keep using API key ending in abcd." over a Disconnect
  // that hands runs to Work, and after a rename its title kept the old name.
  // CANARY: give DisconnectConfirm the account the Disconnect was pressed on
  // instead of the loaded account with its id (agent-account-in-use.tsx) and
  // each row keeps the name or the sentence the dialog opened with.
  it.each<[string, string, Account[], string, string]>([
    [
      "another tab switches runs to it",
      "ubc_key",
      [{ ...KEY, active: true }, { ...WORK, active: false }, PERSONAL],
      "API key ending in abcd",
      "Your runs switch to Work, the Claude account you used before it.",
    ],
    [
      "another tab switches runs away from it",
      "ubc_work",
      [{ ...PERSONAL, active: true }, { ...WORK, active: false }, KEY],
      "Work",
      "Your runs keep using personal@example.com.",
    ],
    [
      "another tab renames it",
      "ubc_key",
      [WORK, PERSONAL, { ...KEY, name: "Spare key", label: "Spare key" }],
      "Spare key",
      "Your runs keep using Work.",
    ],
  ])("an open Disconnect confirm says what confirming does when %s", async (_label, id, loaded, name, sentence) => {
    const server: ClaudeOnServer = { accounts: [WORK, PERSONAL, KEY], login: null };
    const { view, reload } = await renderLoaded(server);
    // The account in use is disconnected under its health line; another one
    // from the management.
    if (id !== WORK.id) chooseAction(view, "Work", "Manage other accounts");
    const scope =
      id === WORK.id
        ? view.container.querySelector<HTMLElement>(".cred-card .cred-manage")!
        : rowOf(view.container, id);
    fireEvent.click(buttonIn(scope, "Disconnect"));

    server.accounts = loaded;
    await reload();
    const dialog = view.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-label")).toBe(`Disconnect ${name}?`);
    expect(dialog.textContent).toContain(sentence);
    fireEvent.click(buttonIn(dialog, `Disconnect ${name}`));
    expect(lastSubmit).toEqual({ intent: "backend-disconnect", backend: "claude", account: id });
  });

  // What the picker's menu opens ("Add another account", the other accounts'
  // management) sits in the card's account-in-use region, so it goes when
  // that region does: no account left, or a sign-in under way in the card's
  // place. It stayed open in the card's state instead, and the next load that
  // showed an account in use opened it again with nobody asking, over an
  // account a sign-in in another tab had just added. The add section goes as
  // its Cancel closes it, key form and all, so opening it again later starts
  // from the ways to connect.
  // CANARY: drop `setAdding(false)` from the region reset in
  // `AgentAccountCard` (agent-accounts-panel.tsx) and every row ends with the
  // add section open; drop its `setPaste(null)` and every row opens it again
  // on the key form; drop its `setManaging(false)` and the sign-in rows end
  // with the management open.
  it.each<[string, ClaudeOnServer[], string]>([
    [
      "another tab disconnects every account, then connects a new one",
      [
        { accounts: [], login: null },
        { accounts: [account("ubc_fresh", "fresh@example.com", { active: true })], login: null },
      ],
      "fresh@example.com",
    ],
    [
      "another tab adds an account through a sign-in",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        {
          accounts: [
            account("ubc_new", "new@example.com", { active: true }),
            { ...WORK, active: false },
            PERSONAL,
            KEY,
          ],
          login: runningLogin("claude", { state: "succeeded" }),
        },
      ],
      "new@example.com",
    ],
    [
      "another tab starts a sign-in, then cancels it",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude", { state: "cancelled" }) },
      ],
      "Work",
    ],
  ])("what the picker's menu opened closes, and stays closed, when %s", async (_label, loads, inUse) => {
    const server: ClaudeOnServer = { accounts: [WORK, PERSONAL, KEY], login: null };
    const { view, reload } = await renderLoaded(server);
    const sections = ["Other Claude accounts", "Add another Claude account"];
    const adding = { name: "Add another Claude account" };
    const keyField = () => view.container.querySelector("#agentacc-claude-api_key");
    chooseAction(view, "Work", "Manage other accounts");
    chooseAction(view, "Work", "Add another Claude account");
    fireEvent.click(buttonIn(view.getByRole("group", adding), "Use an API key"));
    // A load that still shows the account in use (a live event about
    // something else) leaves both where the person opened them.
    await reload();
    for (const name of sections) expect(view.getByRole("group", { name })).toBeTruthy();
    expect(keyField()).toBeTruthy();

    for (const [index, load] of loads.entries()) {
      Object.assign(server, load);
      await reload();
      for (const name of sections) {
        expect(view.queryByRole("group", { name }), `${name} after load ${index + 1}`).toBeNull();
      }
    }
    // The card shows an account in use again, where the sections would be,
    // and the add section opens again on the ways to connect.
    chooseAction(view, inUse, "Add another Claude account");
    expect(keyField(), "the key form, opened again").toBeNull();
  });

  // A rename form sits under the account it renames: under the health line
  // while that account is in use, in the management while it is another. It
  // goes when its place does, as the management's Done closes it: a sign-in
  // under way takes that place while the account is still listed, and a
  // switch in another tab moves the account in use into a management nobody
  // has open. It stayed open in the card's state instead, and the load that
  // showed its place again, or the person opening the management later,
  // showed it again with nobody asking (under the account in use, its field
  // took the focus as it mounted).
  // CANARY: drop `setRenaming(null)` from the region reset in
  // `AgentAccountCard` (agent-accounts-panel.tsx) and the first row ends with
  // the form open; drop the reset of a rename form whose account is in
  // neither place, and the switch row does; drop both, and every row does.
  it.each<[string, string, ClaudeOnServer[], string | null]>([
    [
      "a sign-in takes the place of the account in use it renames, then is cancelled",
      "ubc_work",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude", { state: "cancelled" }) },
      ],
      null,
    ],
    [
      "a sign-in takes the place of the management it is in, then is cancelled",
      "ubc_personal",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude", { state: "cancelled" }) },
      ],
      "Work",
    ],
    [
      "a sign-in takes the place of the management it is in, then adds an account",
      "ubc_personal",
      [
        { accounts: [WORK, PERSONAL, KEY], login: runningLogin("claude") },
        {
          accounts: [
            account("ubc_new", "new@example.com", { active: true }),
            { ...WORK, active: false },
            PERSONAL,
            KEY,
          ],
          login: runningLogin("claude", { state: "succeeded" }),
        },
      ],
      "new@example.com",
    ],
    [
      "another tab switches runs away from the account in use it renames",
      "ubc_work",
      [{ accounts: [{ ...PERSONAL, active: true }, { ...WORK, active: false }, KEY], login: null }],
      "personal@example.com",
    ],
  ])("a rename form closes, and stays closed, when %s", async (_label, id, loads, manageOver) => {
    const server: ClaudeOnServer = { accounts: [WORK, PERSONAL, KEY], login: null };
    const { view, reload } = await renderLoaded(server);
    const field = () => view.container.querySelector(`#agentacc-${id}-name`);
    // The account in use is renamed under its health line; another one in
    // the management.
    if (id !== WORK.id) chooseAction(view, "Work", "Manage other accounts");
    const scope =
      id === WORK.id
        ? view.container.querySelector<HTMLElement>(".cred-card .cred-manage")!
        : rowOf(view.container, id);
    fireEvent.click(buttonIn(scope, "Rename"));
    // A load that changes nothing leaves the form where the person is typing.
    await reload();
    expect(field()).toBeTruthy();

    for (const load of loads) {
      Object.assign(server, load);
      await reload();
    }
    // Where the form would be again: under the account in use, or in the
    // management the person opens from the picker.
    if (manageOver) chooseAction(view, manageOver, "Manage other accounts");
    expect(field(), "the rename form, after the loads").toBeNull();
  });

  // The key form of a card with no account sits with the ways to connect, so
  // it goes when they do: an account connected in another tab, or a sign-in
  // under way in their place. It stayed open in the card's state instead, so
  // the card that came back with no account showed it again, and the first
  // "Add another account" on a card that came back with one opened on the key
  // form rather than on the ways to connect.
  // CANARY: drop `setPaste(null)` from the region reset in `AgentAccountCard`
  // (agent-accounts-panel.tsx) and every row ends with the key form open.
  it.each<[string, ClaudeOnServer[], string | null]>([
    [
      "another tab connects an API key",
      [{ accounts: [{ ...KEY, active: true }], login: null }],
      "API key ending in abcd",
    ],
    [
      "another tab's sign-in connects an account",
      [
        { accounts: [], login: runningLogin("claude") },
        {
          accounts: [account("ubc_new", "new@example.com", { active: true })],
          login: runningLogin("claude", { state: "succeeded" }),
        },
      ],
      "new@example.com",
    ],
    [
      "another tab's sign-in is cancelled",
      [
        { accounts: [], login: runningLogin("claude") },
        { accounts: [], login: runningLogin("claude", { state: "cancelled" }) },
      ],
      null,
    ],
  ])("the key form of a card with no account closes, and stays closed, when %s", async (_label, loads, inUse) => {
    const server: ClaudeOnServer = { accounts: [], login: null };
    const { view, reload } = await renderLoaded(server);
    const keyField = () => view.container.querySelector("#agentacc-claude-api_key");
    fireEvent.click(buttonIn(view.container.querySelector<HTMLElement>(".cred-card")!, "Use an API key"));
    // A load that changes nothing leaves the form where the person is typing.
    await reload();
    expect(keyField()).toBeTruthy();

    for (const load of loads) {
      Object.assign(server, load);
      await reload();
    }
    // Where the form would be again: on the card with no account, or in the
    // first "Add another account" over the account connected.
    if (inUse) chooseAction(view, inUse, "Add another Claude account");
    expect(keyField(), "the key form, after the loads").toBeNull();
  });

  it("renames in place, and refuses a name too long in the store's own words (ruling 147)", () => {
    const view = renderPanel([claudeWith([WORK, PERSONAL]), backend("codex")]);
    const { container, getByLabelText, getByRole, queryByRole } = view;
    chooseAction(view, "Work", "Manage other accounts");
    fireEvent.click(buttonIn(rowOf(container, "ubc_personal"), "Rename"));
    const field = container.querySelector<HTMLInputElement>("#agentacc-ubc_personal-name")!;
    // The label is the field's real label, not an aria-label.
    expect(getByLabelText(/Account name/)).toBe(field);
    expect(document.activeElement).toBe(field);
    // An unnamed account starts empty; the hint says what empty means.
    expect(field.value).toBe("");
    expect(container.textContent).toContain("leave it empty to go back to personal@example.com");

    fireEvent.change(field, { target: { value: "x".repeat(61) } });
    fireEvent.click(buttonIn(rowOf(container, "ubc_personal"), "Save name"));
    expect(lastSubmit).toBeNull();
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("An account name can be at most 60 characters.");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(field, { target: { value: "Personal" } });
    expect(queryByRole("alert")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(lastSubmit).toEqual({
      intent: "backend-account-rename",
      backend: "claude",
      account: "ubc_personal",
      name: "Personal",
    });
  });

  it("adds another account through the same sign-in and paste methods, never into an existing one", () => {
    const view = renderPanel([claudeWith([WORK]), backend("codex")]);
    fireEvent.click(pickerFor(view, "Work"));
    // One account: nothing else to manage yet.
    expect(view.queryByRole("menuitem", { name: "Manage other accounts" })).toBeNull();
    fireEvent.click(view.getByRole("menuitem", { name: "Add another Claude account" }));
    expect(view.getByText(/switching back needs no sign-in/)).toBeTruthy();
    fireEvent.click(view.getByText("Sign in with Claude"));
    expect(lastSubmit).toEqual({ intent: "backend-login-start", backend: "claude", method: "claudeai" });
    fireEvent.click(buttonIn(view.container.querySelector<HTMLElement>(".cred-card")!, "Use an API key"));
    expect(view.container.querySelector("#agentacc-claude-api_key")).toBeTruthy();
  });

  it("stops offering another account at the ceiling, and says why", () => {
    const view = renderPanel([
      claudeWith([WORK, PERSONAL], { limits: { maxAccounts: 2, maxLabelLength: 60 } }),
      backend("codex"),
    ]);
    fireEvent.click(pickerFor(view, "Work"));
    const add = view.getByRole("menuitem", { name: /^Add another Claude account/ });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.textContent).toContain("2 is the most one person can keep; disconnect one to add another.");
    fireEvent.click(add);
    expect(view.queryByText(/switching back needs no sign-in/)).toBeNull();
  });

  it("says which account a running sign-in is for", () => {
    const adding = renderPanel([
      claudeWith([WORK], { login: runningLogin("claude") }),
      backend("codex"),
    ]);
    expect(adding.getByText(/Adding another Claude account\. The one you have stays connected\./)).toBeTruthy();
    cleanup();

    const again = renderPanel([
      claudeWith([WORK, PERSONAL], {
        login: runningLogin("claude", { accountId: "ubc_personal", existingAccount: true }),
      }),
      backend("codex"),
    ]);
    expect(again.getByText("Signing in to personal@example.com again.")).toBeTruthy();
  });

  it("starts a failed sign-in again into the account it was for", () => {
    const { getByText } = renderPanel([
      claudeWith([WORK, PERSONAL], {
        login: runningLogin("claude", {
          state: "failed",
          error: "error: browser authorization was refused.",
          accountId: "ubc_personal",
          existingAccount: true,
        }),
      }),
      backend("codex"),
    ]);
    fireEvent.click(getByText("Start again"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-start",
      backend: "claude",
      method: "claudeai",
      account: "ubc_personal",
    });
  });
});
