// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { createRoutesStub, useFetcher } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { AgentAccountsPanel } from "./agent-accounts-panel";
import type { ProfileBackend } from "./profile-query.server";
import type { BackendLoginPollData } from "~/routes/resources.backend-login";

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
} as const;

function backend(
  name: "claude" | "codex",
  overrides: Partial<ProfileBackend> = {},
): ProfileBackend {
  return {
    backend: name,
    health: { ...HEALTH_NONE, backend: name, userId: "u_arda" },
    login: null,
    methods:
      name === "claude"
        ? { signIn: ["claudeai", "console"], paste: ["api_key"] }
        : { signIn: ["device"], paste: ["api_key", "access_token"] },
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

function panelElement(
  backends: ProfileBackend[],
  poll: BackendLoginPollData | null = null,
) {
  lastSubmit = null;
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
              submit={(fields) => {
                lastSubmit = fields;
              }}
            />
          </ToastProvider>
        );
      },
    },
    {
      // The real poll target. Its answer is what the success toast must settle
      // on, so it is a route with a loader, not a stubbed function.
      path: "/resources/backend-login",
      loader: () => poll,
    },
  ]);
  return <Stub initialEntries={["/profile"]} />;
}

function renderPanel(
  backends: ProfileBackend[],
  poll: BackendLoginPollData | null = null,
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
    const { container, getByText } = renderPanel([
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
    // Disconnect className in `agent-accounts-panel.tsx`.
    const disconnect = container.querySelectorAll(".cred-manage button")[0]!;
    expect(disconnect.textContent).toContain("Disconnect");
    expect(Array.from(disconnect.classList)).toContain("danger");
    fireEvent.click(disconnect);
    expect(lastSubmit).toEqual({
      intent: "backend-disconnect",
      backend: "claude",
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
    expect(note.textContent).toContain("as does connecting a different Claude account here");
    const window_ = container.querySelector('[data-refusal="quota"]')!;
    expect(window_.textContent).toContain("Spent as of");
    expect(window_.textContent).toContain("reopens");
    expect(window_.textContent).toContain("Any completed Codex run retires this notice");
    expect(window_.textContent).toContain("as does connecting a different Codex account here");
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
    // Agent accounts", which is this card: it has to carry that sign-in.
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
      succeeded,
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
        },
      }),
    ]);
    expect(getByText("100% of seven day")).toBeTruthy();
    expect(container.querySelector('[data-usage="seven_day"]')).toBeTruthy();
    // An observation, never a probe: the age is what stops a figure from this
    // morning reading as current.
    expect(getByText(/Observed/)).toBeTruthy();
    expect(getByText(/not a live reading/)).toBeTruthy();
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
        },
      }),
    ]);
    expect(getByText("window usage not reported")).toBeTruthy();
    expect(queryByText(/0%/)).toBeNull();
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
