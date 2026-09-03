// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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

function renderPanel(
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
  return render(<Stub initialEntries={["/profile"]} />);
}

describe("AgentAccountsPanel", () => {
  it("renders one card per backend with the vendor's own sign-in options", () => {
    const { getByText, getAllByText, container } = renderPanel(BOTH_UNCONNECTED);
    expect(getByText("Agent accounts")).toBeTruthy();
    expect(container.querySelectorAll(".cred-card")).toHaveLength(2);
    expect(
      getAllByText(/Not connected\. Runs on tasks you own/),
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
    const { getByText, getAllByText, container } = renderPanel(BOTH_UNCONNECTED);
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

    // Nothing is submitted until there is something to submit.
    const save = getByText("Save API key").closest("button")!;
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "sk-ant-api03-abc" } });
    fireEvent.click(save);
    expect(lastSubmit).toEqual({
      intent: "backend-set-key",
      backend: "claude",
      kind: "api_key",
      secret: "sk-ant-api03-abc",
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
    expect(getByText("1. Open this link and sign in")).toBeTruthy();
    const link = container.querySelector<HTMLAnchorElement>(
      "a[href='https://auth.openai.com/codex/device']",
    )!;
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noreferrer");
    expect(getByText("2. Enter this code")).toBeTruthy();
    expect(getByText("WDJB-MJHT")).toBeTruthy();
    expect(getByText("Waiting for you to finish in the browser")).toBeTruthy();
    // Codex has no paste step: the person types the code on OpenAI's page.
    expect(container.querySelector("input[type='text']")).toBeNull();

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
    const before = waiting.container.querySelector<HTMLInputElement>(
      "input[aria-label='Code from Anthropic']",
    )!;
    expect(before.disabled).toBe(true);
    cleanup();

    const { container, getByText } = renderPanel([
      backend("claude", {
        login: runningLogin("claude", {
          state: "awaiting-code",
          needsCode: true,
        }),
      }),
      backend("codex"),
    ]);
    const field = container.querySelector<HTMLInputElement>(
      "input[aria-label='Code from Anthropic']",
    )!;
    expect(field.disabled).toBe(false);
    expect(getByText("Waiting for the code Anthropic showed you")).toBeTruthy();
    fireEvent.change(field, { target: { value: "paste-me" } });
    fireEvent.click(getByText("Submit"));
    expect(lastSubmit).toEqual({
      intent: "backend-login-code",
      backend: "claude",
      code: "paste-me",
    });
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

    fireEvent.click(container.querySelectorAll(".cred-manage button")[0]!);
    expect(lastSubmit).toEqual({
      intent: "backend-disconnect",
      backend: "claude",
    });
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
    expect(getByText("1. Open this link and sign in")).toBeTruthy();
    expect(getByText("Waiting for you to finish in the browser")).toBeTruthy();
    expect(getByText("Cancel")).toBeTruthy();
    // The badge says what is happening now, not what was true before it started.
    expect(getByText("signing in")).toBeTruthy();
  });

  it("announces the step list politely and moves focus into it", () => {
    // The card replaces the button the person just pressed, and every value in
    // it (the URL, the code, the status) arrives seconds later from the poll.
    const { container } = renderPanel([
      backend("claude"),
      backend("codex", { login: runningLogin("codex") }),
    ]);
    const steps = container.querySelector<HTMLDivElement>("div[role='status']")!;
    expect(steps).toBeTruthy();
    expect(steps.getAttribute("aria-live")).toBe("polite");
    expect(steps.getAttribute("aria-label")).toBe("Codex sign-in");
    expect(document.activeElement).toBe(steps);
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
