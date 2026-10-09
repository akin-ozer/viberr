// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub, data, useLoaderData } from "react-router";
import { z } from "zod";
import type { McpView } from "~/server/org/resources.server";
import { CLOUDFLARE_READ_ONLY_GRANT } from "../../../test-support/cloudflare-read-only-grant";
import { ToastProvider } from "~/ui/toast";
import { ResourcesPanel } from "./resources-panel";

/**
 * Ruling 192: the Settings MCP editor offers "Sign in" for an HTTP server,
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
  credUnreadable: false,
  firstSuccessAt: null,
  heuristicWarmups: 0,
  oauth: { status: "needs_sign_in", expiresAt: null, renews: false, issuer: null, reason: null, scope: null },
  requestedScope: null,
};

/** What the stub server does beyond answering every intent `ok`. */
interface StubServer {
  /** The row once the sign-in started in the editor has landed: the callback
   *  publishes, and the page reads the row again after the start answers. A
   *  sign-out reads the row the page opened with. */
  landed?: McpView;
  /** How `mcp-save` is refused, as `appErrorResponse` answers it. */
  refuseSave?: { ok: false; error: string; field?: string };
}

function renderPanel(mcp: McpView, server: StubServer = {}) {
  posted = [];
  let current = mcp;
  function loader() {
    return { mcps: [current] };
  }
  function Page() {
    const { mcps } = useLoaderData<typeof loader>();
    return (
      <ToastProvider>
        <ResourcesPanel
          kbs={[]}
          mcps={mcps}
          skills={[]}
          gagents={[]}
          templateGrants={{ kbs: {}, mcps: {}, skills: {} }}
          stages={[]}
          projectStages={[]}
        />
      </ToastProvider>
    );
  }
  const Stub = createRoutesStub([
    {
      id: "settings",
      path: "/org/settings",
      Component: Page,
      loader,
      action: async ({ request }) => {
        const fields: Record<string, string> = {};
        for (const [key, value] of (await request.formData()).entries()) {
          const text = textField.safeParse(value);
          if (text.success) fields[key] = text.data;
        }
        posted.push(fields);
        if (fields.intent === "mcp-oauth-start") {
          current = server.landed ?? current;
          return { ok: true, authorizeUrl: AUTHORIZE_URL, issuer: "mcp.cloudflare.com" };
        }
        if (fields.intent === "mcp-oauth-sign-out") current = mcp;
        if (fields.intent === "mcp-save" && server.refuseSave) return data(server.refuseSave, { status: 400 });
        return { ok: true, toast: "cloudflare-api signed out." };
      },
    },
  ]);
  return render(
    <Stub initialEntries={["/org/settings"]} hydrationData={{ loaderData: { settings: loader() } }} />,
  );
}

function row(container: HTMLElement): HTMLElement {
  const name = within(container).getByText("cloudflare-api");
  const found = name.closest<HTMLElement>(".rsrc-row");
  if (!found) throw new Error("no MCP row");
  return found;
}

describe("the MCP editor's OAuth sign-in (ruling 192)", () => {
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
        scope: null,
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
        scope: null,
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
    // Ruling 192: a command signs nothing in, so it asks for no scopes.
    expect(queryByRole("textbox", { name: /Requested scopes/ })).toBeNull();
  });
});

describe("a pasted credential and an OAuth sign-in in one editor (ruling 192)", () => {
  const CONFLICT = "cloudflare-api is signed in with OAuth. Sign it out first to use a pasted credential instead.";
  /** The row after the sign-in: its connection check listed the tools. */
  const LANDED: McpView = {
    ...BASE,
    up: true,
    tools: 2,
    lastError: null,
    discoveredTools: ["whoami", "delete_zone"],
    oauth: {
      status: "signed_in",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      renews: true,
      issuer: "mcp.cloudflare.com",
      reason: null,
      scope: null,
    },
  };

  /** The owner's steps (2026-09-27): paste an API key into the editor, then
   *  sign in with OAuth instead, and wait until the editor says so. */
  async function pasteThenSignIn() {
    const view = renderPanel(BASE, { landed: LANDED });
    fireEvent.click(view.getByLabelText("Edit cloudflare-api"));
    fireEvent.change(view.getByLabelText(/Credential/), { target: { value: "a-pasted-api-token-123" } });
    fireEvent.click(view.getByRole("button", { name: /^Sign in$/ }));
    await view.findByRole("button", { name: "Sign out" });
    return view;
  }

  it("Save & re-test saves the write tools with the sign-in, and sends no key typed before it landed", async () => {
    // CANARY: keep the draft once the field gives way to the sentence, and the
    // save posts the hidden key, which the server refuses with CONFLICT under
    // a form that shows no credential at all (the owner's screenshot).
    const { getByRole, queryByLabelText } = await pasteThenSignIn();
    expect(queryByLabelText(/Credential/)).toBeNull();
    const dialog = getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "whoami" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Save & re-test/ }));
    await waitFor(() => expect(posted.map((fields) => fields.intent)).toContain("mcp-save"));
    const save = posted.find((fields) => fields.intent === "mcp-save");
    expect(save).toMatchObject({ mcpId: "mcp_cf", cred: "", writeTools: '["whoami"]' });
    expect(save).not.toHaveProperty("clearCred");
  });

  it("a sign-out brings the credential field back empty", async () => {
    // CANARY: blank the draft only when saving, and the key typed before the
    // sign-in is back in the field, where the next paste lands beside it.
    const { getByRole, findByLabelText } = await pasteThenSignIn();
    fireEvent.click(getByRole("button", { name: "Sign out" }));
    expect(await findByLabelText(/Credential/)).toHaveProperty("value", "");
  });

  const REFUSALS: [string, NonNullable<StubServer["refuseSave"]>, boolean][] = [
    ["the credential is said under its field", { ok: false, error: CONFLICT, field: "cred" }, true],
    [
      "another field stays at the form's foot",
      { ok: false, error: "An MCP server named cloudflare-api already exists." },
      false,
    ],
  ];
  it.each(REFUSALS)("a refusal about %s", async (_about, refusal, atField) => {
    // CANARY: ignore the refusal's `field` and the conflict reads under the
    // write tools, far from the credential it is about; send every refusal
    // to the field and a name clash reads there. This editor never saw the
    // sign-in land (its live update was missed), so its field is still up
    // when the server refuses.
    const { getByLabelText, getByRole } = renderPanel(BASE, { refuseSave: refusal });
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    const input = getByLabelText(/Credential/);
    fireEvent.change(input, { target: { value: "a-pasted-api-token-123" } });
    fireEvent.click(getByRole("button", { name: /Save & re-test/ }));
    const shown = await within(getByRole("dialog")).findByText(refusal.error);
    expect(input.closest(".field")?.contains(shown)).toBe(atField);
    expect(input.getAttribute("aria-invalid")).toBe(atField ? "true" : null);
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy === null ? null : document.getElementById(describedBy)).toBe(atField ? shown : null);
  });
});

describe("what the sign-in was granted, and what it asks for (ruling 192)", () => {
  const signedIn: NonNullable<McpView["oauth"]> = {
    status: "signed_in",
    expiresAt: new Date(Date.now() + 52 * 60_000 + 20_000).toISOString(),
    renews: true,
    issuer: "mcp.cloudflare.com",
    reason: null,
    scope: CLOUDFLARE_READ_ONLY_GRANT,
  };
  const readOnly: McpView = { ...BASE, up: true, tools: 2, lastError: null, requestedScope: null, oauth: signedIn };

  it("the row and the editor say 'read-only · 194 scopes', and the editor's disclosure lists every scope", () => {
    // CANARY: drop the grant from the row's auth phrase, or the editor's
    // grant block, and a read-only sign-in reads like any other.
    const { container, getByLabelText, getByRole, getByText } = renderPanel(readOnly);
    expect(row(container).textContent).toContain(
      "auth: OAuth, signed in (expires in 52 minutes, renews itself), read-only · 194 scopes; held by Viberr, runs connect through its gateway",
    );
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    const dialog = getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Granted read-only · 194 scopes. Runs can read through it, and the server refuses any call that writes.",
    );
    const summary = getByText("The 194 scopes it granted");
    const disclosure = summary.closest("details");
    if (!disclosure) throw new Error("no disclosure");
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    const list = within(disclosure).getByRole("list", { name: "Granted scopes" });
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(194);
    expect(items).toContain("workers-ci.read");
    expect(items).toContain("teams.report");
    expect(items.filter((item) => item?.endsWith("write"))).toEqual([]);
  });

  it("a grant that writes is counted, and each write is marked in the list", () => {
    const { container, getByLabelText, getByRole } = renderPanel({
      ...readOnly,
      oauth: { ...signedIn, scope: "zone.read workers-scripts.write dns.edit" },
    });
    expect(row(container).textContent).toContain("renews itself), 3 scopes · 2 writes; held by Viberr");
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    const list = within(getByRole("dialog")).getByRole("list", { name: "Granted scopes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "zone.read",
      "workers-scripts.writewrite",
      "dns.editwrite",
    ]);
  });

  it("the editor offers Requested scopes, explains who decides the grant, and saves what the admin typed", async () => {
    // CANARY: drop the field (or stop sending it) and the only way to ask
    // for write scopes is gone.
    const { getByLabelText, getByRole } = renderPanel({ ...readOnly, requestedScope: "zone.read" });
    fireEvent.click(getByLabelText("Edit cloudflare-api"));
    const field = getByRole("textbox", { name: /Requested scopes/ });
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("Requested scopes is not a text area");
    expect(field.value).toBe("zone.read");
    expect(field.getAttribute("aria-describedby")).toBe("mcp-scopes-hint");
    expect(document.getElementById("mcp-scopes-hint")?.textContent).toContain(
      "The server's own sign-in page decides what it grants, so this editor shows what it granted.",
    );
    fireEvent.change(field, { target: { value: "zone.read workers-scripts.write" } });
    fireEvent.click(getByRole("button", { name: /Save & re-test/ }));
    await waitFor(() =>
      expect(posted).toEqual([
        expect.objectContaining({ intent: "mcp-save", mcpId: "mcp_cf", requestedScopes: "zone.read workers-scripts.write" }),
      ]),
    );
  });
});
