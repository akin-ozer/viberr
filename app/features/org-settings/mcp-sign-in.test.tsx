// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { z } from "zod";
import type { McpView } from "~/server/org/resources.server";
import { ToastProvider } from "~/ui/toast";
import { ResourcesPanel } from "./resources-panel";

/**
 * Ruling 469: the Settings MCP editor offers "Sign in" for an HTTP server,
 * shows where the sign-in stands (needs sign-in / signed in until when /
 * expired), sends the admin to the authorization URL through a link (no popup
 * to block), and offers "Sign out". The row says the same without a click.
 * Copy follows docs/ui/surfaces.md: no em or en dashes, sentences an admin
 * can act on.
 */

afterEach(cleanup);

const AUTHORIZE_URL = "https://mcp.cloudflare.com/authorize?client_id=c1&state=s1";
let posted: Record<string, string>[] = [];
const textField = z.string();

const BASE: McpView = {
  id: "mcp_cf",
  name: "cloudflare-api",
  transport: "HTTP",
  target: "https://mcp.cloudflare.com/mcp",
  hasCred: false,
  tools: null,
  up: false,
  lastCheckedAt: new Date().toISOString(),
  lastError:
    "needs sign-in: this server asks for an OAuth sign-in, which an org admin does from its editor in Instance settings → Agent resources",
  warmingSince: null,
  writeTools: [],
  writeToolsReviewed: true,
  discoveredTools: null,
  storePaths: [],
  oauth: { status: "needs_sign_in", expiresAt: null, renews: false, issuer: null, reason: null },
};

function renderPanel(mcp: McpView) {
  posted = [];
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <ResourcesPanel
            kbs={[]}
            mcps={[mcp]}
            skills={[]}
            gagents={[]}
            templateGrants={{ kbs: {}, mcps: {}, skills: {} }}
            stages={[]}
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fields: Record<string, string> = {};
        for (const [key, value] of (await request.formData()).entries()) {
          const text = textField.safeParse(value);
          if (text.success) fields[key] = text.data;
        }
        posted.push(fields);
        if (fields.intent === "mcp-oauth-start") {
          return { ok: true, authorizeUrl: AUTHORIZE_URL, issuer: "mcp.cloudflare.com" };
        }
        return { ok: true, toast: "cloudflare-api signed out." };
      },
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

function row(container: HTMLElement): HTMLElement {
  const name = within(container).getByText("cloudflare-api");
  const found = name.closest<HTMLElement>(".rsrc-row");
  if (!found) throw new Error("no MCP row");
  return found;
}

describe("the MCP editor's OAuth sign-in (ruling 469)", () => {
  it("a server that asks for a sign-in reads 'needs sign-in' on its row and in its editor", () => {
    const { container, getByLabelText, getByRole } = renderPanel(BASE);
    const text = row(container).textContent ?? "";
    expect(text).toContain("needs sign-in · checked");
    expect(text).not.toContain("unreachable");
    expect(row(container).querySelector(".stat-dot")?.getAttribute("title")).toBe("needs sign-in");
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    const group = getByRole("group", { name: /OAuth sign-in/ });
    expect(within(group).getByRole("button", { name: /^Sign in$/ })).toBeTruthy();
    expect(within(group).queryByRole("button", { name: /Sign out/ })).toBeNull();
    expect(getByRole("status").textContent).toBe("Needs sign-in");
    // The pasted-credential field stays for static tokens.
    expect(getByLabelText(/Credential/)).toBeTruthy();
  });

  it("Sign in posts the start and offers the authorization URL as a link to a new tab", async () => {
    const { getByLabelText, getByRole, findByRole } = renderPanel(BASE);
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    fireEvent.click(getByRole("button", { name: /^Sign in$/ }));
    const link = await findByRole("link", { name: "Continue at mcp.cloudflare.com" });
    expect(posted).toEqual([expect.objectContaining({ intent: "mcp-oauth-start", mcpId: "mcp_cf" })]);
    expect(link.getAttribute("href")).toBe(AUTHORIZE_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("a signed-in server says until when and that it renews, hides the pasted credential and offers Sign out", async () => {
    const signedIn: McpView = {
      ...BASE,
      up: true,
      tools: 87,
      lastError: null,
      oauth: {
        status: "signed_in",
        expiresAt: new Date(Date.now() + 52 * 60_000 + 20_000).toISOString(),
        renews: true,
        issuer: "mcp.cloudflare.com",
        reason: null,
      },
    };
    const { container, getByLabelText, getByRole, queryByLabelText } = renderPanel(signedIn);
    expect(row(container).textContent).toContain(
      "auth: OAuth, signed in (expires in 52 minutes, renews itself); held by Viberr, runs connect through its gateway",
    );
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    expect(getByRole("status").textContent).toBe(
      "Signed in (expires in 52 minutes, renews itself) · mcp.cloudflare.com",
    );
    expect(queryByLabelText(/Credential/)).toBeNull();
    // Re-pointing drops the sign-in on save; the editor says so first.
    const endpoint = getByLabelText(/Endpoint/);
    fireEvent.change(endpoint, { target: { value: "https://mcp.cloudflare.com/other" } });
    expect(getByRole("dialog").textContent).toContain("Saving this drops the server's OAuth sign-in");
    fireEvent.change(endpoint, { target: { value: signedIn.target } });
    fireEvent.click(getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(posted).toEqual([expect.objectContaining({ intent: "mcp-oauth-sign-out", mcpId: "mcp_cf" })]),
    );
  });

  it("an expired sign-in says so with the server's reason and offers to sign in again", () => {
    const expired: McpView = {
      ...BASE,
      oauth: {
        status: "expired",
        expiresAt: null,
        renews: false,
        issuer: "mcp.cloudflare.com",
        reason: "the authorization server answered invalid_grant: The refresh token is no longer valid.",
      },
    };
    const { container, getByLabelText, getByRole } = renderPanel(expired);
    const text = row(container).textContent ?? "";
    expect(text).toContain("sign-in expired: an admin must sign in again · checked");
    expect(text).toContain("invalid_grant: The refresh token is no longer valid.");
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    expect(getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("a stdio server has no sign-in", () => {
    const { getByLabelText, queryByRole } = renderPanel({
      ...BASE,
      transport: "stdio",
      target: "npx -y @mcp/server-postgres",
      oauth: null,
      lastError: null,
    });
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    expect(queryByRole("group", { name: /OAuth sign-in/ })).toBeNull();
  });
});
