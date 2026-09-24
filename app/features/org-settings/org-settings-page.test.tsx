// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { z } from "zod";
import type { StageDef } from "~/schemas/project-file.schema";
import type { ConnectionRecord } from "~/server/org/connections.server";
import { formatCalendarDate } from "~/shared/dates/format";
import type { GagentView } from "~/server/org/gagents.server";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { ToastProvider } from "~/ui/toast";
import { ConnectionsPanel } from "./connections-panel";
import { OrgSettingsPage } from "./org-settings-page";
import type {
  AuthProviderView,
  OrgSettingsView,
} from "~/server/org/org-view.server";
import { ResourcesPanel } from "./resources-panel";
import { UsersPanel } from "./users-panel";

/** Ruling 99: minimal controller config for page renders. */
const CONTROLLER_CONFIG = {
  name: "Controller",
  model: "",
  effort: "",
  skills: ["controller-guide"],
  kb: [],
  mcps: [],
  definition: "doctrine",
  profilePresent: true,
};

/** Ruling 108: the PRODUCT default — every section locked (no unlock vars). */
const CONTROLLER_LOCKS = {
  skills: true,
  kb: true,
  mcps: true,
  instructions: true,
};


/**
 * jsdom smokes for the three org-settings tabs: mock markup/copy fidelity,
 * client-side guard toasts, dialog open/confirm flows, and the intents the
 * panels post (captured by the stub action).
 */

afterEach(cleanup);

let lastForm: Record<string, string> | null = null;

/** A posted form field the panels set — file entries are not part of any
 *  intent these tests capture, so they are skipped rather than stringified. */
const textField = z.string();

function panelElement(ui: ReactNode) {
  lastForm = null;
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => <ToastProvider>{ui}</ToastProvider>,
      action: async ({ request }) => {
        const fd = await request.formData();
        lastForm = {};
        for (const [k, v] of fd.entries()) {
          const field = textField.safeParse(v);
          if (field.success) lastForm[k] = field.data;
        }
        return { ok: true, toast: "stub done" };
      },
    },
  ]);
  return <Stub initialEntries={["/org/settings"]} />;
}

function renderPanel(ui: ReactNode) {
  return render(panelElement(ui));
}

const CONNECTIONS: ConnectionRecord[] = [
  {
    id: "akin-ozer", owner: "akin-ozer", method: "PAT", patId: "pat_1",
    masked: "····0000", def: true, repos: null, expiresAt: null, daysLeft: null,
    validationState: "unvalidated", scopes: [], lastValidatedAt: null,
    createdAt: "2026-07-01T09:00:00.000Z", boundProjects: 0, advisories: [],
  },
  {
    id: "hepapi", owner: "hepapi", method: "PAT", patId: "pat_2",
    masked: "····42af", def: false, repos: 12, expiresAt: "2026-07-20T00:00:00.000Z",
    daysLeft: 15, validationState: "valid",
    scopes: [
      { id: "repo", ok: true, source: "header" },
      { id: "workflow", ok: true, source: "header" },
      { id: "pull_request:write", ok: true, source: "header" },
    ], lastValidatedAt: "2026-07-01T09:00:00.000Z",
    createdAt: "2026-07-01T09:05:00.000Z", boundProjects: 2, advisories: [],
  },
];

describe("ConnectionsPanel", () => {
  it("renders rows with honest validation state + expiry pills", () => {
    const { getByText, queryByText } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    expect(getByText("2 connections.")).toBeTruthy();
    expect(getByText("akin-ozer")).toBeTruthy();
    expect(getByText("not validated")).toBeTruthy();
    expect(getByText("default")).toBeTruthy();
    expect(getByText("expires in 15 days")).toBeTruthy();
    expect(queryByText("validation failed")).toBeNull();
  });

  it("C6: a PAT expiry hydrates safely — the UTC day first, the viewer's calendar date after hydration", () => {
    // The server pass depends on the timestamp alone: the SSR host's zone is
    // not the viewer's, and a calendar date rendered in it hydrates to
    // different text near midnight (React #418). Midnight UTC is exactly the
    // instant a host west of Greenwich puts on the previous day.
    const ssr = renderToString(
      panelElement(<ConnectionsPanel connections={CONNECTIONS} />),
    );
    expect(ssr).toContain("expires ");
    expect(ssr).toContain("2026-07-20 (UTC)");
    expect(ssr).not.toMatch(/Jul (19|20), 2026/);
    expect(ssr).toContain("no expiry date");
    // After hydration the effect swaps in the viewer-local calendar date.
    const { container } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    expect(container.textContent).toContain(
      `expires ${formatCalendarDate("2026-07-20T00:00:00.000Z")}`,
    );
    expect(container.textContent).not.toContain("(UTC)");
  });

  it("refuses to remove the default with the mock toast; confirms others", async () => {
    const { getByLabelText, getByText, queryByRole } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    fireEvent.click(getByLabelText("Remove akin-ozer"));
    await waitFor(() =>
      expect(getByText("Set another connection as default first")).toBeTruthy(),
    );
    expect(queryByRole("alertdialog")).toBeNull();

    fireEvent.click(getByLabelText("Remove hepapi"));
    expect(getByText("Remove hepapi?")).toBeTruthy();
    // A4 (pass 23): hepapi has 2 bound projects (fixture), so the confirm
    // discloses the sync loss the PAT-delete cascade causes, not just the
    // harmless half the old copy named.
    expect(
      getByText(/2 projects bound to it lose branch and PR sync/),
    ).toBeTruthy();
    // C6: the confirm button now names the outcome instead of a bare "Remove".
    fireEvent.click(getByText("Remove connection", { selector: "button.btn.danger" }));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "connection-remove",
        connectionId: "hepapi",
      }),
    );
  });

  it("A4: with no bound projects, the confirm keeps the harmless copy (no false sync-loss claim)", async () => {
    const unbound: ConnectionRecord[] = [
      { ...CONNECTIONS[1]!, id: "solo", owner: "solo", def: false, boundProjects: 0, advisories: [] },
    ];
    const { getByLabelText, getByText, queryByText } = renderPanel(
      <ConnectionsPanel connections={unbound} />,
    );
    fireEvent.click(getByLabelText("Remove solo"));
    expect(
      getByText(/Projects already created from solo keep their repos/),
    ).toBeTruthy();
    expect(queryByText(/branch and PR sync/)).toBeNull();
  });

  it("A4: one bound project reads in the singular", () => {
    const one: ConnectionRecord[] = [
      { ...CONNECTIONS[1]!, id: "solo", owner: "solo", def: false, boundProjects: 1, advisories: [] },
    ];
    const { getByLabelText, getByText } = renderPanel(
      <ConnectionsPanel connections={one} />,
    );
    fireEvent.click(getByLabelText("Remove solo"));
    expect(
      getByText(/1 project bound to it loses branch and PR sync/),
    ).toBeTruthy();
  });

  it("add-connection modal: duplicate guard fires client-side", async () => {
    const { getByText, getByLabelText, getByPlaceholderText } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    fireEvent.click(getByText("Add connection"));
    expect(getByText("New GitHub connection")).toBeTruthy();
    const save = getByText("Validate & connect").closest("button")!;
    // Ruling 147: enabled while incomplete; a click is refused with the
    // unmet-requirements line as an alert and focus on the first empty field.
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(
      getByText(/Fill the required fields/).closest("span")!.getAttribute("role"),
    ).toBe("alert");
    expect(document.activeElement).toBe(getByPlaceholderText("owner"));

    fireEvent.change(getByPlaceholderText("owner"), { target: { value: "hepapi" } });
    fireEvent.change(getByPlaceholderText("ghp_…"), { target: { value: "ghp_x_1234" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(getByText("That connection already exists.")).toBeTruthy(),
    );
    expect(lastForm).toBeNull(); // no server round-trip
    expect(getByLabelText("Close")).toBeTruthy();
  });

  it("F11: the PAT field is a secret field, matching its own promise", () => {
    // The label says "stored encrypted · never displayed" while the input was
    // type="text" — the one moment the token IS on screen is the moment the
    // copy denies. Also kept out of autofill stores and spell-checkers.
    const { getByText, getByPlaceholderText } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    fireEvent.click(getByText("Add connection"));
    // SAFETY: the placeholder belongs to the token `<input>` in the add-connection
    // form (connections-panel.tsx); the bound query cannot be told that element
    // type, so it is stated here.
    const token = getByPlaceholderText("ghp_…") as HTMLInputElement;
    expect(token.type).toBe("password");
    // P21 (owner report): `off` is ignored on login-shaped pairs — browsers
    // filled a saved password here. `new-password` is what they honor.
    expect(token.getAttribute("autocomplete")).toBe("new-password");
    expect(token.getAttribute("spellcheck")).toBe("false");
    // The owner field beside it is NOT a secret and stays readable.
    // SAFETY: same form, the owner `<input>` beside the token field.
    expect((getByPlaceholderText("owner") as HTMLInputElement).type).toBe("text");
  });

  it("F12: the connection count agrees with its noun", () => {
    const { getByText } = renderPanel(
      <ConnectionsPanel connections={[CONNECTIONS[0]!]} />,
    );
    expect(getByText("1 connection.")).toBeTruthy();
  });
});

const ME: OrgUserView = {
  id: "u_arda", name: "Arda Kaya", email: "arda@viberr.dev", initials: "AK",
  tone: "", role: "admin", status: "active", idp: "local", pwreset: false,
  disabled: false, githubHandle: null,
};
const USERS: OrgUserView[] = [
  ME,
  {
    id: "u_gh", name: "@octocat", email: "github.com/octocat", initials: "O",
    tone: "teal", role: "member", status: "whitelisted", idp: "github",
    pwreset: false, disabled: false, githubHandle: "octocat",
  },
  {
    id: "u_selin", name: "Selin Aksoy", email: "selin@viberr.dev", initials: "SA",
    tone: "violet", role: "member", status: "active", idp: "local",
    pwreset: true, disabled: false, githubHandle: null,
  },
];
const DISABLED_USER: OrgUserView = {
  id: "u_dz", name: "Deniz Yıldız", email: "deniz@viberr.dev", initials: "DY",
  tone: "", role: "member", status: "active", idp: "local", pwreset: false,
  disabled: true, githubHandle: null,
};
const DOMAINS: DomainRecord[] = [
  { id: "d1", domain: "@viberr.dev", role: "member", createdAt: "2026-07-01T09:00:00.000Z" },
];

describe("UsersPanel", () => {
  it("renders accounts, pills, domain allowlist and the you-tag", () => {
    const { getByText } = renderPanel(
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
    );
    expect(getByText("3 instance accounts")).toBeTruthy();
    // F12: …and the noun follows the count. "1 instance accounts" was live.
    expect(getByText("you")).toBeTruthy();
    expect(getByText("whitelisted")).toBeTruthy();
    expect(getByText("password reset pending")).toBeTruthy();
    expect(getByText("domain allowlist")).toBeTruthy();
    expect(getByText("any Google account with this domain · joins as member")).toBeTruthy();
  });

  it("F12: one account is '1 instance account', not '1 instance accounts'", () => {
    const { getByText, queryByText } = renderPanel(
      <UsersPanel users={[ME]} domains={[]} meId="u_arda" />,
    );
    expect(getByText("1 instance account")).toBeTruthy();
    expect(queryByText("1 instance accounts")).toBeNull();
  });

  it("self guards: demote + remove are client-toasted, never posted", async () => {
    const { getAllByText, getByText, getByLabelText } = renderPanel(
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
    );
    const myRow = getByText("arda@viberr.dev").closest(".member-row")!;
    fireEvent.click(myRow.querySelector(".mini-seg button:not(.on)")!);
    await waitFor(() => expect(getByText("You can't demote yourself")).toBeTruthy());
    expect(lastForm).toBeNull();

    fireEvent.click(getByLabelText("Remove Arda Kaya"));
    await waitFor(() =>
      expect(getByText("You can't remove your own account")).toBeTruthy(),
    );
    expect(lastForm).toBeNull();
    expect(getAllByText("Admin").length).toBeGreaterThan(0);
  });

  it("role toggle posts user-role; remove confirms with the audit-history copy", async () => {
    const { getByText, getByLabelText } = renderPanel(
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
    );
    const selinRow = getByText("selin@viberr.dev").closest(".member-row")!;
    fireEvent.click(selinRow.querySelectorAll(".mini-seg button")[0]!); // → Admin
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "user-role", userId: "u_selin", role: "admin" }),
    );

    fireEvent.click(getByLabelText("Remove Selin Aksoy"));
    expect(getByText(/Their comments and decisions stay in the audit history/)).toBeTruthy();
    // C6: outcome-naming confirm label.
    fireEvent.click(getByText("Remove member", { selector: "button.btn.danger" }));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "user-remove", userId: "u_selin" }),
    );
  });

  it("disable confirms then posts user-disable; self-disable is client-guarded", async () => {
    const { getByText, getByLabelText, getByRole, queryByRole } = renderPanel(
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
    );
    // Self-disable is refused client-side — no dialog, no server round-trip.
    fireEvent.click(getByLabelText("Disable Arda Kaya"));
    await waitFor(() =>
      expect(getByText("You can't disable your own account")).toBeTruthy(),
    );
    expect(queryByRole("alertdialog")).toBeNull();
    expect(lastForm).toBeNull();

    // Disabling another user goes through the confirm.
    fireEvent.click(getByLabelText("Disable Selin Aksoy"));
    expect(getByText("Disable Selin Aksoy?")).toBeTruthy();
    // Ruling 455(f): the shared ConfirmDialog, named by its title.
    expect(
      getByRole("alertdialog", { name: "Disable Selin Aksoy?" }).getAttribute(
        "data-screen-label",
      ),
    ).toBe("Disable user dialog");
    fireEvent.click(getByText("Disable", { selector: "button.btn.danger" }));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "user-disable", userId: "u_selin" }),
    );
  });

  it("a disabled user shows the pill + an enable action that posts user-enable", async () => {
    const { getByText, getByLabelText, queryByLabelText } = renderPanel(
      <UsersPanel users={[ME, DISABLED_USER]} domains={DOMAINS} meId="u_arda" />,
    );
    expect(getByText("disabled")).toBeTruthy();
    // The disable button is replaced by an enable button (no confirm needed).
    expect(queryByLabelText("Disable Deniz Yıldız")).toBeNull();
    fireEvent.click(getByLabelText("Enable Deniz Yıldız"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "user-enable", userId: "u_dz" }),
    );
  });

  it("edit modal: idp accounts are read-only with the sync note; local shows reset", () => {
    const { getByText, getByLabelText, queryByText } = renderPanel(
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
    );
    fireEvent.click(getByLabelText("Edit @octocat"));
    expect(getByText("Signs in with GitHub")).toBeTruthy();
    expect(getByText(/Name & email sync from GitHub/)).toBeTruthy();
    expect(queryByText("Reset password")).toBeNull();
    fireEvent.click(getByLabelText("Close"));

    fireEvent.click(getByLabelText("Edit Arda Kaya"));
    expect(getByText("Local account")).toBeTruthy();
    expect(getByText("this is your own account")).toBeTruthy();
    expect(getByText("Reset password")).toBeTruthy();
  });

  it("invite modal switches idp fields and gates the save button", () => {
    const { getByText, getByPlaceholderText, getByRole } = renderPanel(
      // F18-3: with GitHub configured the modal leads with GitHub, as before.
      <UsersPanel
        users={USERS}
        domains={DOMAINS}
        meId="u_arda"
        providers={{ github: true, google: true }}
      />,
    );
    fireEvent.click(getByText("Allow access"));
    expect(getByPlaceholderText("username")).toBeTruthy();
    const whitelistBtn = getByText("Whitelist user").closest("button")!;
    // Ruling 147: never disabled for an incomplete form; the click refuses.
    expect(whitelistBtn.disabled).toBe(false);
    fireEvent.click(whitelistBtn);
    expect(document.activeElement).toBe(getByPlaceholderText("username"));

    // A11Y-1 (pass 32): every sign-in method button carries its accessible
    // name from its visible label — the live tree tool under-reported the
    // nested span, so this pins the computed name rather than the markup.
    expect(getByRole("button", { name: "Local" })).toBeTruthy();
    expect(getByRole("button", { name: /^GitHub/ })).toBeTruthy();
    fireEvent.click(getByText("Local", { selector: ".bnm" }).closest("button")!);
    expect(getByPlaceholderText("Full name")).toBeTruthy();
    const createBtn = getByText("Create account").closest("button")!;
    expect(createBtn.disabled).toBe(false);
    fireEvent.change(getByPlaceholderText("Full name"), { target: { value: "Yeni Kişi" } });
    fireEvent.change(getByPlaceholderText("name@company.dev"), {
      target: { value: "yeni@viberr.dev" },
    });
    expect(createBtn.disabled).toBe(false);
  });
});

const KBS: KbView[] = [
  {
    id: "kb1", name: "Architecture notes", dir: "architecture-notes",
    refresh: "on change", lastIndexedAt: new Date().toISOString(),
    tree: [
      { type: "dir", name: "decisions", children: [
        { type: "file", name: "adr-001.md", sizeBytes: 4300, mtime: new Date().toISOString() },
      ] },
      { type: "file", name: "overview.md", sizeBytes: 9100, mtime: new Date().toISOString() },
    ],
    fileCount: 2, injectableCount: 2, folderExists: true, uri: "store://kb/architecture-notes",
  },
];
const MCPS: McpView[] = [
  { id: "m1", name: "github-mcp", transport: "HTTP", target: "https://mcp.internal:7801/sse",
    hasCred: true, tools: 14, up: true, lastCheckedAt: new Date().toISOString(), lastError: null, warmingSince: null, writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [] },
  { id: "m2", name: "browserbase", transport: "HTTP", target: "https://mcp.internal:7809/sse",
    hasCred: false, tools: 0, up: false, lastCheckedAt: new Date().toISOString(), lastError: null, warmingSince: null, writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [] },
];
const SKILLS: SkillView[] = [
  { id: "s1", name: "terraform-review", summary: "Module review checklist.",
    updatedAt: new Date().toISOString(), body: "## Review checklist",
    tree: [{ type: "file", name: "SKILL.md", sizeBytes: 340, mtime: new Date().toISOString() }],
    fileCount: 1, uri: "store://skills/terraform-review" },
];
const GAGENTS: GagentView[] = [
  { id: "developer", name: "Developer", backend: "codex",
    summary: "Primary implementation specialist.", role: "Implementation",
    persona: "", stages: ["ready", "impl"], model: "", effort: "",
    skills: ["terraform-review"], mcps: ["github-mcp"], kbs: [], used: 4 },
  { id: "spare", name: "Spare", backend: "claude", summary: "Unused.",
    role: "Spare hands", model: "", effort: "",
    persona: "", stages: ["impl"], skills: [], mcps: [], kbs: [], used: 0 },
];
const STAGES: StageDef[] = [
  { id: "triage", name: "Triage", color: "slate" },
  { id: "ready", name: "Ready", color: "teal" },
  { id: "impl", name: "In Progress", color: "violet" },
  { id: "review", name: "Review", color: "blue" },
  { id: "done", name: "Done", color: "green" },
];

/** The template-grant counts the LOADER supplies, matching what GAGENTS
 *  declares. They are counted server-side over the profile files now, because
 *  `gagents` is the specialist CRUD list and hides the controller and operator
 *  templates whose grants the delete still rewrites. */
const TEMPLATE_GRANTS = {
  kbs: {},
  mcps: { "github-mcp": 1 },
  skills: { "terraform-review": 1 },
};

function renderResources() {
  return renderPanel(
    <ResourcesPanel
      kbs={KBS}
      mcps={MCPS}
      skills={SKILLS}
      gagents={GAGENTS}
      templateGrants={TEMPLATE_GRANTS}
      stages={STAGES}
    />,
  );
}

describe("ResourcesPanel", () => {
  it("renders the four panels with store paths, health and usage lines", () => {
    const { getByText } = renderResources();
    expect(
      getByText(
        "store://kb/architecture-notes/ · 2 docs · agents read the live folder",
      ),
    ).toBeTruthy();
    expect(getByText(/re-scanned just now/)).toBeTruthy();
    expect(getByText(/14 tools · checked just now · auth: configured/)).toBeTruthy();
    expect(getByText(/unreachable · checked just now/)).toBeTruthy();
    expect(
      getByText(/store:\/\/skills\/terraform-review\/ · 1 file · updated just now · 1 template/),
    ).toBeTruthy();
    expect(getByText(/Codex · Ready · In Progress · 2 context resources · used in 4 projects/)).toBeTruthy();
    expect(getByText(/These are the shared base definitions/)).toBeTruthy();
  });

  it("R19-17: an unreachable MCP shows WHY on the row, not just a red dot", () => {
    // The reason used to live only in the probe's toast, so once it faded the
    // dot was the entire story and the cause was unrecoverable without
    // re-running the test.
    const failed: McpView[] = [
      {
        id: "m7",
        name: "uvx-fetch",
        transport: "stdio",
        target: "uvx mcp-server-fetch",
        hasCred: false,
        tools: null,
        up: false,
        lastCheckedAt: new Date().toISOString(),
        lastError:
          "exited before responding — ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'",
        warmingSince: null,
        writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [],
      },
    ];
    const { container } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={failed} skills={[]} gagents={[]} stages={STAGES} />,
    );
    const err = container.querySelector(".rsrc-err")!;
    expect(err).toBeTruthy();
    expect(err.textContent).toContain("ImportError: cannot import name 'McpError'");
  });

  it("R19-18: an installing server reads as installing, not unreachable", () => {
    // The row carries a stale `up: false` — the verdict of the probe that
    // STARTED this install — and must not show it as the answer.
    const warming: McpView[] = [
      {
        id: "m8",
        name: "writing-tools",
        transport: "stdio",
        target: "uvx --from git+https://example.dev/w writing-tools-mcp",
        hasCred: false,
        tools: null,
        up: false,
        lastCheckedAt: new Date().toISOString(),
        lastError: "still installing after 20s — …",
        warmingSince: new Date().toISOString(),
        writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [],
      },
    ];
    const { container } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={warming} skills={[]} gagents={[]} stages={STAGES} />,
    );
    // R20-4 (N20-2): softened to one copy for both the evidence and heuristic
    // warm-up bases — the reader can act on neither distinction.
    expect(container.textContent).toContain("first run, installing in the background");
    expect(container.textContent).not.toContain("unreachable");
    // Its own dot state, and no red error block shouting while it works.
    expect(container.querySelector(".stat-dot.warming")).toBeTruthy();
    expect(container.querySelector(".stat-dot.down")).toBeNull();
    expect(container.querySelector(".rsrc-err")).toBeNull();
  });

  it("R19-17: a HEALTHY server shows no error line", () => {
    // A stale reason under a green dot would be worse than none.
    const { container } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={MCPS.filter((m) => m.up === true)} skills={[]} gagents={[]} stages={STAGES} />,
    );
    expect(container.querySelector(".rsrc-err")).toBeNull();
  });

  it("A9/F17: an MCP whose stored credential no longer decrypts reads 'auth: unreadable', not 'configured'", () => {
    const brokenMcps: McpView[] = [
      {
        id: "m9",
        name: "broken-mcp",
        transport: "HTTP",
        target: "https://mcp.internal:7810/sse",
        hasCred: true,
        credUnreadable: true,
        lastError: null, warmingSince: null,
        writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [],
        tools: null,
        up: null,
        lastCheckedAt: new Date().toISOString(),
      },
    ];
    const { getByText, queryByText } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={brokenMcps} skills={[]} gagents={[]} stages={STAGES} />,
    );
    expect(getByText(/auth: unreadable/)).toBeTruthy();
    expect(queryByText(/auth: configured/)).toBeNull();
  });

  it("P14-WL-06: says 'resource' for one and 'resources' for several", () => {
    // The `used in N project(s)` half of the same line always pluralized; the
    // resource count always said "resources", so a single grant read
    // "1 context resources".
    const { getByText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={[
          { ...GAGENTS[0]!, id: "one", name: "One", skills: ["terraform-review"], mcps: [], kbs: [], used: 1 },
          { ...GAGENTS[0]!, id: "many", name: "Many", skills: ["terraform-review"], mcps: ["github-mcp"], kbs: [], used: 3 },
        ]}
        stages={STAGES}
      />,
    );
    expect(getByText(/1 context resource · used in 1 project$/)).toBeTruthy();
    expect(getByText(/2 context resources · used in 3 projects$/)).toBeTruthy();
  });

  /**
   * F15-05 guard: a profile created with nothing granted counts ZERO context
   * resources — the row never invents one. (Live, two org profiles DID carry a
   * `reviewer-expertise` grant in their template files; the count was reading
   * the store faithfully, and this pins that it keeps doing so.)
   */
  it("a profile with no granted resources reads '0 context resources'", () => {
    const { getByText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={[
          {
            ...GAGENTS[0]!,
            id: "docs-writer",
            name: "Docs writer",
            skills: [],
            mcps: [],
            kbs: [],
            used: 0,
          },
        ]}
        stages={STAGES}
      />,
    );
    expect(getByText(/0 context resources · not deployed$/)).toBeTruthy();
  });

  it("renders a stale health check as amber (not a fresh-green 'up') with a retest hint", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const staleMcps: McpView[] = [
      { id: "m3", name: "notes-fixture", transport: "stdio", target: "node /tmp/notes.mjs",
        hasCred: true, tools: 1, up: true, lastCheckedAt: threeHoursAgo, lastError: null, warmingSince: null, writeTools: [], writeToolsReviewed: false, discoveredTools: null, storePaths: [] },
    ];
    const { container } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={staleMcps} skills={[]} gagents={[]} stages={STAGES} />,
    );
    // The dot is amber (stale), NOT the fresh-green `up`.
    const dot = container.querySelector(".stat-dot")!;
    expect(dot.classList.contains("stale")).toBe(true);
    expect(dot.classList.contains("up")).toBe(false);
    // And the line flags it as stale + prompts a retest.
    expect(container.textContent).toContain("· stale, retest");
    // D32-6: one tool is "1 tool", not "1 tools".
    expect(container.textContent).toContain("1 tool · checked");
  });

  it("kb delete confirms with the spec copy; deployed profile delete is guarded", async () => {
    const { getByText, getByLabelText } = renderResources();
    fireEvent.click(getByLabelText("Delete Architecture notes"));
    // A2: the confirm discloses the permanent document deletion (server rmSync's
    // the whole folder), not the euphemistic "the index is removed".
    expect(getByText(/Permanently deletes the folder/)).toBeTruthy();
    // C6: outcome-naming confirm label per resource kind.
    fireEvent.click(getByText("Remove knowledge base", { selector: "button.btn.danger" }));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "kb-delete", kbId: "kb1" }),
    );

    fireEvent.click(getByLabelText("Delete Developer"));
    await waitFor(() =>
      expect(getByText("Detach Developer from its 4 projects first")).toBeTruthy(),
    );
  });

  it("agent modal: stage chips exclude Done; context chips list org resources", () => {
    const { getByText, getByLabelText, getByRole, getAllByRole } = renderResources();
    fireEvent.click(getByLabelText("Edit Developer"));
    expect(getByText("Edit agent profile")).toBeTruthy();
    // A11Y-3/A11Y-4 (pass 32): the backend segment buttons and the KB chips
    // are named by their visible text (backend name; KB DISPLAY name, with the
    // store path only as the description) — the live tree tool showed them
    // unnamed / path-named, so the computed names are pinned here.
    expect(getByRole("button", { name: "Codex" })).toBeTruthy();
    expect(getByRole("button", { name: "Claude" })).toBeTruthy();
    // (The KB row's own name button shares the name; the chip is the one
    // carrying the store path as its description.)
    const kbChip = getAllByRole("button", { name: "Architecture notes" }).find(
      (b) => b.classList.contains("pick-chip"),
    )!;
    expect(kbChip.getAttribute("title")).toBe("store://kb/architecture-notes/");
    // P13-D-9: "always" was an over-promise — a project's operator can close a
    // task under the auto preset. No AGENT profile ever can, which is the
    // guarantee this org-scoped editor is actually in a position to make.
    expect(getByText("Done is closed by a human, never by an agent")).toBeTruthy();
    const chips = [...document.querySelectorAll(".pick-chip")];
    expect(chips.some((c) => c.textContent === "Done")).toBe(false);
    // P13-AP-05/AP-07: a template is ADOPTED (copied) by a project, so an org
    // edit does not silently reach an already-adopted project on its next run.
    // Ruling 156 (pass 35): the hint no longer points at "re-adopt" (a door the
    // deploy refuses); the box above the foot copies the grants with this save.
    expect(
      getByText(
        "adopted by 4 projects. Each project keeps its own copy of the grants and its own capability policy; the box above updates the grants with this save",
      ),
    ).toBeTruthy();
    // Three ctx groups over the org resources; the selected skill chip is on.
    expect(document.querySelectorAll(".ctx-group")).toHaveLength(3);
    const skillChip = chips.find((c) => c.textContent === "terraform-review")!;
    expect(skillChip.className).toContain(" on");
  });

  /**
   * Ruling 156 (pass 35, F35-7): a project's deployment is its own COPY of the
   * grants, so an org edit never reached it. The modal offers the propagation
   * as a box, unchecked by default, and the save carries the decision. Canary:
   * drop `propagate` from the submitted fields.
   */
  it("ruling 156: the copy-grants box posts propagate=1 with the save, and an unadopted template has no box", async () => {
    const { getByLabelText, getByText, queryByLabelText } = renderResources();
    fireEvent.click(getByLabelText("Edit Developer"));
    const box = getByLabelText(
      "Copy these grants to the 4 projects that adopted this profile",
    );
    expect(box.getAttribute("type")).toBe("checkbox");
    fireEvent.click(box);
    fireEvent.click(getByText("Save changes"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "agent-save",
        profileId: "developer",
        propagate: "1",
      }),
    );
    cleanup();

    // Spare is adopted by nobody: nothing to copy to, so no box, and the save
    // says so explicitly.
    const again = renderResources();
    fireEvent.click(again.getByLabelText("Edit Spare"));
    expect(queryByLabelText(/Copy these grants/)).toBeNull();
    fireEvent.click(again.getByText("Save changes"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "agent-save", profileId: "spare", propagate: "0" }),
    );
  });

  it("review F10: a legacy template whose role repeats its name explains the greyed Save", () => {
    const legacy: GagentView[] = [{ ...GAGENTS[1]!, role: GAGENTS[1]!.name }];
    const { getByText, getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={legacy}
        templateGrants={TEMPLATE_GRANTS}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Edit Spare"));
    const save = getByText("Save changes").closest("button")!;
    // Ruling 147: the explanation is shown up front and Save stays enabled; a
    // click refuses (the modal's unmet line becomes an alert) and lands on the
    // empty role field.
    expect(save.disabled).toBe(false);
    expect(
      getByText(/This template's stored role repeated its name; give it a real role to save\./),
    ).toBeTruthy();
    fireEvent.click(save);
    expect(getByText(/Fill the required fields/).getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(document.getElementById("ga-role"));
    fireEvent.change(document.getElementById("ga-role")!, { target: { value: "Spare hands" } });
    expect(save.disabled).toBe(false);
  });

  it("kb name opens the StoreBrowser over the real tree", () => {
    const { getByText } = renderResources();
    fireEvent.click(getByText("Architecture notes", { selector: "button.linkish" }));
    expect(
      document.querySelector('[aria-label="Files · Architecture notes"]'),
    ).toBeTruthy();
    expect(getByText("overview.md")).toBeTruthy();
    expect(
      getByText(/This is the real folder on disk\. Files added outside Viberr/),
    ).toBeTruthy();
  });

  /* ---- honesty deltas (P14-KM-09 / KM-10 / KM-13) */

  it("P14-KM-13: a KB row counts the docs a run reads and names the rest", () => {
    const withBinaries: KbView[] = [
      {
        ...KBS[0]!,
        tree: [
          ...KBS[0]!.tree,
          { type: "file", name: "contract.pdf", sizeBytes: 900, mtime: new Date().toISOString() },
        ],
        fileCount: 3,
        injectableCount: 2,
      },
    ];
    const { getByText } = renderPanel(
      <ResourcesPanel
        kbs={withBinaries}
        mcps={[]}
        skills={[]}
        gagents={[]}
        stages={STAGES}
      />,
    );
    // The old row said "3 docs" — a KB of PDFs read as healthy and injected
    // nothing, because only six text extensions ever reach a run.
    expect(
      getByText(
        "store://kb/architecture-notes/ · 2 docs · agents read the live folder · 1 non-text file skipped",
      ),
    ).toBeTruthy();
  });

  it("F18-4: a KB whose store folder is gone reads 'folder missing', not a healthy empty KB", () => {
    const missing: KbView[] = [
      { ...KBS[0]!, tree: [], fileCount: 0, injectableCount: 0, folderExists: false },
    ];
    const { getByText, queryByText } = renderPanel(
      <ResourcesPanel kbs={missing} mcps={[]} skills={[]} gagents={[]} stages={STAGES} />,
    );
    expect(getByText(/folder missing: no docs reach a granted agent/)).toBeTruthy();
    // It must NOT read like a normal empty KB.
    expect(queryByText(/0 docs · agents read the live folder/)).toBeNull();
  });

  it("P14-KM-09: MCP rows and the delete confirm count the templates that grant them", () => {
    const { getByText, getByLabelText } = renderResources();
    // KB and skill rows have counted templates since P13-KM-08; the MCP row was
    // the one destructive path with no idea what depended on it.
    // F-P3 (pass 25): a credentialed server's row now carries the backend caveat
    // between "auth: configured" and the grant tail.
    expect(
      getByText(
        /14 tools · checked just now · auth: configured \(Claude runs only · Codex mounts it unauthenticated\) · 1 template/,
      ),
    ).toBeTruthy();

    fireEvent.click(getByLabelText("Remove github-mcp"));
    // A2: the tail now names templates AND project agents; this panel render
    // supplies no `projectGrants` map, so only the 1 template is counted.
    expect(
      getByText(/The grant is dropped from 1 agent template\./),
    ).toBeTruthy();
  });

  it("A2: the delete tail names PROJECT agents, not just org templates", () => {
    // A KB granted by NO org template but by two project deployments read as
    // "Nothing grants it" while the delete silently dropped both grants. The
    // loader now supplies a per-slug count so the confirm discloses it.
    const { getByText, getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={GAGENTS}
        projectGrants={{ kbs: { "architecture-notes": 2 }, mcps: {}, skills: {} }}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Delete Architecture notes"));
    // No template grants this KB (GAGENTS[].kbs is empty), so the OLD copy would
    // have said "Nothing grants it" — the exact lie A2 fixes.
    expect(
      getByText(/The grant is dropped from 2 project agents\./),
    ).toBeTruthy();
  });

  it("counts a template the specialist list hides (the controller's own resources)", () => {
    // `gagents` is the specialist CRUD list: the controller and operator
    // templates are never in it, while the delete rewrites EVERY profile file.
    // Deriving the count from `gagents` told an admin "Nothing grants it" about
    // the controller's own knowledge base, right before the delete took it.
    const { getByText, getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={GAGENTS}
        templateGrants={{
          kbs: { "architecture-notes": 1 }, // granted by the controller alone
          mcps: {},
          skills: {},
        }}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Delete Architecture notes"));
    expect(
      getByText(/The grant is dropped from 1 agent template\./),
    ).toBeTruthy();
  });

  it("A2: templates AND project agents are counted together in one tail", () => {
    // github-mcp is granted by 1 org template (Developer) and, say, 3 project
    // deployments — the tail must name both, joined.
    const { getByText, getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={GAGENTS}
        projectGrants={{ kbs: {}, mcps: { "github-mcp": 3 }, skills: {} }}
        templateGrants={TEMPLATE_GRANTS}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Remove github-mcp"));
    expect(
      getByText(
        /The grant is dropped from 1 agent template and 3 project agents\./,
      ),
    ).toBeTruthy();
  });

  it("P14-KM-09: editing an MCP warns how many grants a rename will rewrite", () => {
    const { getByText, getByLabelText } = renderResources();
    fireEvent.click(getByLabelText("Edit github-mcp"));
    expect(getByText(/1 agent template grants/)).toBeTruthy();
    expect(getByText(/Renaming it rewrites their grants/)).toBeTruthy();
  });

  it("N20-5: the Add-MCP modal shows the slug the name will actually be saved as", () => {
    const { getByText, container } = renderResources();
    // Open the MCP panel's own "Add" button (KB/skills have one too).
    const mcpPanel = [...container.querySelectorAll("section.panel")].find(
      (s) => s.querySelector("h2")?.textContent === "MCP servers",
    )!;
    const addBtn = [...mcpPanel.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add"),
    )!;
    fireEvent.click(addBtn);

    // The name is slugified before saving (`_`→`-`), which silently rewrote what
    // the admin typed — and the reserved-name refusal then quoted a name they
    // never entered. The field now discloses the slug the moment it differs.
    const nameInput = container.querySelector<HTMLInputElement>("#mcp-name")!;
    fireEvent.change(nameInput, { target: { value: "viberr_browser" } });
    expect(getByText(/will be saved as/)).toBeTruthy();
    expect(getByText("viberr-browser")).toBeTruthy();
  });

  it("P14-KM-10: the agent modal renders orphaned grants as removable red chips", () => {
    const orphaned: GagentView[] = [
      {
        ...GAGENTS[0]!,
        skills: ["terraform-review", "deleted-craft"],
        mcps: ["vm-memory"],
        kbs: ["gone-kb"],
      },
    ];
    const { getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={orphaned}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Edit Developer"));

    // They were preserved on every save and rendered NOWHERE, so an orphan
    // could not be seen or removed from org settings at all.
    const missing = [...document.querySelectorAll(".pick-chip.missing")].map(
      (c) => c.textContent,
    );
    expect(missing).toEqual(["deleted-craft", "vm-memory", "gone-kb"]);

    // Clicking one drops it from the grant list that gets submitted.
    fireEvent.click(
      [...document.querySelectorAll(".pick-chip.missing")].find(
        (c) => c.textContent === "vm-memory",
      )!,
    );
    expect(
      [...document.querySelectorAll(".pick-chip.missing")].map((c) => c.textContent),
    ).toEqual(["deleted-craft", "gone-kb"]);
  });

  it("F19-5: a missing chip announces itself as GRANTED, not as an ungranted resource", () => {
    const orphaned: GagentView[] = [
      {
        ...GAGENTS[0]!,
        skills: ["terraform-review", "deleted-craft"],
        mcps: ["vm-memory"],
        kbs: ["gone-kb"],
      },
    ];
    const { getByLabelText, getAllByRole } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={orphaned}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Edit Developer"));

    // A red chip only renders BECAUSE its id is still in the grant list, so it
    // is by construction a pressed toggle. Its six sibling chip groups in this
    // modal already report state; these announced nothing at all.
    const missing = [...document.querySelectorAll(".pick-chip.missing")];
    expect(missing.length).toBe(3);
    for (const chip of missing) {
      expect(chip.getAttribute("aria-pressed")).toBe("true");
    }

    // The point of the attribute: a screen reader can now tell a dangling grant
    // apart from a live resource this profile does NOT grant. `pressed` matches
    // on the attribute, so an element without it lands in neither list.
    const pressed = getAllByRole("button", { pressed: true }).map((b) => b.textContent);
    expect(pressed).toEqual(
      expect.arrayContaining(["deleted-craft", "vm-memory", "gone-kb"]),
    );
    const unpressed = getAllByRole("button", { pressed: false }).map((b) => b.textContent);
    expect(unpressed).toEqual(
      expect.arrayContaining(["github-mcp", "Architecture notes"]),
    );
  });

  it("P14-KM-10: dropped orphans are gone from the submitted grants", async () => {
    const orphaned: GagentView[] = [
      { ...GAGENTS[1]!, skills: ["deleted-craft"], mcps: [], kbs: [] },
    ];
    const { getByText, getByLabelText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={MCPS}
        skills={SKILLS}
        gagents={orphaned}
        stages={STAGES}
      />,
    );
    fireEvent.click(getByLabelText("Edit Spare"));
    fireEvent.click(
      [...document.querySelectorAll(".pick-chip.missing")].find(
        (c) => c.textContent === "deleted-craft",
      )!,
    );
    fireEvent.click(getByText("Save changes"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({ intent: "agent-save", skills: "[]" }),
    );
  });
});

/* ---------------- PAT scope evidence (P13-UI-01, hardened) ---------------- */

describe("ConnectionsPanel — scope evidence", () => {
  it("renders chips for PROVEN scopes only; assumed ones collapse into the honest line", () => {
    // Owner ruling 2026-07-25: an `assumed` entry is not evidence — P13-UI-01's
    // `~` pseudo-chips still LOOKED like verification, so they render no chip
    // at all now. A validated-but-unprobed fine-grained PAT shows zero chips
    // and says its scopes are proven once attached to a project.
    const assumed: ConnectionRecord = {
      ...CONNECTIONS[1]!,
      id: "cx_fine",
      owner: "fine-grained",
      scopes: [
        { id: "repo", ok: true, source: "assumed" },
        { id: "pull_request:write", ok: true, source: "assumed" },
      ],
    };
    const { container } = renderPanel(
      <ConnectionsPanel connections={[assumed]} />,
    );
    expect(container.querySelectorAll(".conn-row .scope-chip").length).toBe(0);
    expect(container.querySelector(".conn-row .scope-chips")!.textContent).toContain(
      "repo, pull_request:write unproven. Verified when attached to a project",
    );
  });

  it("probe-backed verdicts render real chips — ✓ for held, alert for refused", () => {
    const probed: ConnectionRecord = {
      ...CONNECTIONS[1]!,
      id: "cx_probed",
      owner: "fine-grained",
      scopes: [
        { id: "repo", ok: true, source: "probe", note: "read + write proven by dry-run" },
        { id: "pull_request:write", ok: false, source: "probe", note: "pull-request write refused" },
      ],
    };
    const { container } = renderPanel(
      <ConnectionsPanel connections={[probed]} />,
    );
    const chips = [...container.querySelectorAll(".conn-row .scope-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["repo", "pull_request:write"]);
    expect(chips[0]!.className).not.toContain("miss");
    expect(chips[1]!.className).toContain("miss");
    // No unproven line when every scope has a verdict.
    expect(container.querySelector(".conn-row .scope-chips")!.textContent).not.toContain(
      "unproven",
    );
  });
});

/* -------------- unified New-skill flow (owner request 2026-07-25) -------------- */

describe("SkillModal — one entry point, two content modes", () => {
  function openNewSkill() {
    const utils = renderPanel(
      <ResourcesPanel kbs={KBS} mcps={MCPS} skills={SKILLS} gagents={GAGENTS} stages={STAGES} />,
    );
    const skillsPanel = [...document.querySelectorAll(".panel")].find(
      (p) => p.querySelector("h2")?.textContent === "Skills",
    )!;
    fireEvent.click(skillsPanel.querySelector(".panel-head .btn")!);
    const nameInput = document.querySelector<HTMLInputElement>("#sk-name")!;
    return { ...utils, nameInput };
  }

  it("'Start from files' needs only a name and submits contentMode=files", async () => {
    const { nameInput, getByText } = openNewSkill();
    fireEvent.change(nameInput, { target: { value: "conventional commits" } });
    // Classic fields are visible under the default write mode…
    expect(document.querySelector("#sk-sum")).not.toBeNull();
    expect(document.querySelector("#sk-body")).not.toBeNull();

    fireEvent.click(getByText("Start from files"));
    // …and gone in files mode: name is the whole form.
    expect(document.querySelector("#sk-sum")).toBeNull();
    expect(document.querySelector("#sk-body")).toBeNull();

    fireEvent.click(getByText("Create & add files"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "skill-save",
        name: "conventional-commits",
        summary: "",
        body: "",
        contentMode: "files",
      }),
    );
  });

  it("'Write SKILL.md' keeps the classic contract (summary required, contentMode=write)", async () => {
    const { nameInput, getByText } = openNewSkill();
    fireEvent.change(nameInput, { target: { value: "tf-review" } });
    const save = getByText("Create skill").closest("button")!;
    // No summary yet: Save is enabled (ruling 147) but a click refuses and
    // lands on the summary field.
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    expect(document.activeElement).toBe(document.querySelector("#sk-sum"));
    fireEvent.change(document.querySelector("#sk-sum")!, {
      target: { value: "Module review checklist." },
    });
    fireEvent.change(document.querySelector("#sk-body")!, {
      target: { value: "## Checklist" },
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "skill-save",
        name: "tf-review",
        summary: "Module review checklist.",
        body: "## Checklist",
        contentMode: "write",
      }),
    );
  });
});

const AUTH_PROVIDERS: AuthProviderView[] = [
  {
    provider: "github",
    source: "none",
    active: false,
    disabledInApp: false,
    clientId: null,
    configuredInApp: false,
    verifiedAt: null,
    verifiedDetail: null,
    envAvailable: false,
  },
  {
    provider: "google",
    source: "none",
    active: false,
    disabledInApp: false,
    clientId: null,
    configuredInApp: false,
    verifiedAt: null,
    verifiedDetail: null,
    envAvailable: false,
  },
];

const STORAGE: OrgSettingsView["storage"] = {
  disk: null,
  maintenance: {
    intervalMs: 6 * 3_600_000,
    diskCheckIntervalMs: 5 * 60_000,
    lastPassAt: null,
    lastPassReason: null,
    lastFreedBytes: 0,
    scheduled: true,
  },
};

describe("F32-2 (pass 32): the Settings page holds a live stream", () => {
  it("opens a user-scoped EventSource on mount, so a KB re-index (resource.updated) revalidates the page", () => {
    // Live: a host-side file drop re-indexed the KB (log: docCount 1) while the
    // Agent resources tab kept "0 docs · re-scanned just now" until a manual
    // reload — this page had no stream at all. Broadcast events reach every
    // connection, so the `user` scope is enough.
    // Canary: drop the `useLiveUpdates` call from OrgSettingsPage.
    const opened: string[] = [];
    class FakeEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = 1;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      renderPanel(
        <OrgSettingsPage
          view={{
            connections: CONNECTIONS,
            users: [ME],
            domains: DOMAINS,
            kbs: KBS,
            mcps: MCPS,
            skills: SKILLS,
            gagents: GAGENTS,
            projectGrants: { kbs: {}, mcps: {}, skills: {} },
            templateGrants: { kbs: {}, mcps: {}, skills: {} },
            stages: STAGES,
            providers: { github: false, google: false },
            authProviders: AUTH_PROVIDERS,
            storage: STORAGE,
          }}
          meId={ME.id}
          callbackOrigin="http://localhost:5173"
          runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
          runSpendCapUsd={null}
          s3Audit={null}
          controllerConfig={CONTROLLER_CONFIG}
          controllerLocks={CONTROLLER_LOCKS}
          controllerRequests={[]}
          auditEvents={[]}
          auditEventsOrgScoped={[]}
        />,
      );
      expect(opened).toHaveLength(1);
      expect(opened[0]).toContain("/resources/events");
      expect(opened[0]).toContain("scope=user");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("resources tab badge counts resources, not resources+templates", () => {
  it("shows the resource count and discloses profiles in the tooltip", () => {
    const { getByRole } = renderPanel(
      <OrgSettingsPage
        view={{
          connections: CONNECTIONS,
          users: [ME],
          domains: DOMAINS,
          kbs: KBS,
          mcps: MCPS,
          skills: SKILLS,
          gagents: GAGENTS,
          projectGrants: { kbs: {}, mcps: {}, skills: {} },
          templateGrants: { kbs: {}, mcps: {}, skills: {} },
          stages: STAGES,
          providers: { github: false, google: false },
          authProviders: AUTH_PROVIDERS,
          storage: STORAGE,
        }}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    // 1 KB + 2 MCP + 1 skill = 4. It used to add the 2 agent templates and
    // read 6 — a number the Home tile presents as a separate concept.
    const tab = getByRole("button", { name: /Agent resources/ });
    const badge = tab.querySelector(".count")!;
    expect(badge.textContent).toBe("4");
    expect(badge.getAttribute("title")).toContain("2 agent profiles");
  });
});

describe("C9: instance storage line", () => {
  const viewWith = (storage: OrgSettingsView["storage"]): OrgSettingsView => ({
    connections: CONNECTIONS,
    users: [ME],
    domains: DOMAINS,
    kbs: KBS,
    mcps: MCPS,
    skills: SKILLS,
    gagents: GAGENTS,
    projectGrants: { kbs: {}, mcps: {}, skills: {} },
    templateGrants: { kbs: {}, mcps: {}, skills: {} },
    stages: STAGES,
    providers: { github: false, google: false },
    authProviders: AUTH_PROVIDERS,
    storage,
  });

  it("shows free space, usage, and the automatic-cleanup cadence; flags a low disk", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewWith({
          disk: {
            freeBytes: 900_000_000,
            totalBytes: 20_000_000_000,
            usedPercent: 95.5,
            status: "low",
            lowThresholdBytes: 1_000_000_000,
            criticalThresholdBytes: 200_000_000,
          },
          maintenance: {
            intervalMs: 6 * 3_600_000,
            diskCheckIntervalMs: 5 * 60_000,
            lastPassAt: "2026-08-22T00:00:00.000Z",
            lastPassReason: "interval",
            lastFreedBytes: 45_000_000,
            scheduled: true,
          },
        })}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    // Free-of-total with the usage percent, the low flag, and the cleanup cadence.
    expect(getByText(/free of 20\.0 GB on the data volume \(95\.5% used\)/)).toBeTruthy();
    expect(getByText(/· low/)).toBeTruthy();
    // D32-1: opens a sentence after the disk line's full stop, so it is capitalised.
    expect(getByText(/Automatic cleanup runs every 6h/)).toBeTruthy();
  });

  it("says cleanup is not scheduled when the maintenance timer is not live", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewWith({
          disk: null,
          maintenance: {
            intervalMs: 6 * 3_600_000,
            diskCheckIntervalMs: 5 * 60_000,
            lastPassAt: null,
            lastPassReason: null,
            lastFreedBytes: 0,
            scheduled: false,
          },
        })}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    expect(getByText(/Automatic cleanup is not scheduled/)).toBeTruthy();
  });
});

describe("run concurrency control", () => {
  const viewBase: OrgSettingsView = {
    connections: CONNECTIONS,
    users: [ME],
    domains: DOMAINS,
    kbs: KBS,
    mcps: MCPS,
    skills: SKILLS,
    gagents: GAGENTS,
    projectGrants: { kbs: {}, mcps: {}, skills: {} },
    templateGrants: { kbs: {}, mcps: {}, skills: {} },
    stages: STAGES,
    providers: { github: false, google: false },
    authProviders: AUTH_PROVIDERS,
    storage: STORAGE,
  };

  it("shows the cap and the live/queued counts", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 2, lane: 1, live: 2, queued: 1 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    expect(getByText(/Capped at 2/)).toBeTruthy();
    expect(getByText(/2 runs live, 1 queued/)).toBeTruthy();
  });

  // Ruling 152(b): a cap carries a coordination lane, and the control says so
  // under the field, because "capped at 2" beside three live runs would
  // otherwise read as a cap that does not hold.
  it("ruling 152: a positive cap names the coordination lane under the field", () => {
    // Canary: drop the `.conc-lane` sentence from RunConcurrencyControl and
    // the first assertion fails.
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 2, lane: 1, live: 3, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    const sentence = getByText(/Cap 2: up to 2 agent runs at once,/);
    expect(sentence.textContent).toContain(
      "plus 1 slot for operator and controller turns so a decision is not stuck behind the builds it is about.",
    );
    expect(sentence.className).toContain("conc-lane");
  });

  // The lane is `max(1, ceil(cap / 4))`, so a sentence that states the rule
  // instead of the number lies at every cap that is not a multiple of four:
  // "one extra slot per four" reads as none at cap 2 and as one at cap 5.
  it("ruling 152: the sentence prints the lane the server derived, at any cap", () => {
    // Canary: render the words "one extra slot per four" again (or `cap` in
    // place of `countLabel`) and both assertions fail.
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 5, lane: 2, live: 5, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    expect(
      getByText(/Cap 5: up to 5 agent runs at once, plus 2 slots for/).textContent,
    ).toContain("operator and controller turns");
  });

  it("ruling 152: a cap of 1 counts one agent run and one slot", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 1, lane: 1, live: 1, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    expect(getByText(/Cap 1: up to 1 agent run at once, plus 1 slot for/)).toBeTruthy();
  });

  it("ruling 152: an unlimited cap has no lane sentence", () => {
    const { queryByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    expect(queryByText(/for operator and controller turns/)).toBeNull();
  });

  it("says unlimited when the cap is 0", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    // The reading says "Unlimited · 0 runs live" — distinct from the "0 =
    // unlimited" field hint.
    expect(getByText(/Unlimited · 0 runs live/)).toBeTruthy();
  });

  // Design pass 2026-09-08: the control was a `.pol-note` — fine print with
  // the field pushed to the far end of the line, unframed between two panels.
  // It is a guard row (Policy's numeric-guardrail shape) on a well now, and
  // the field sits under `.guard-ctl` so it is boxed by that one rule.
  it("is a guard row on a well, not a footnote", () => {
    const { getByLabelText, getByRole } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    const input = getByLabelText(/Maximum concurrent agent runs/);
    expect(input.closest(".guard-ctl")).not.toBeNull();
    const row = input.closest(".guard-row")!;
    expect(row.querySelector(".guard-name")?.textContent).toBe("Run concurrency");
    expect(input.closest(".pol-note")).toBeNull();
    // Ruling 175 put a second limit in the well, so the ROW is the group now,
    // named by its own name, and the well is the ground both rows stand on.
    const group = getByRole("group", { name: "Run concurrency" });
    expect(group.className).toBe("guard-row");
    expect(group.contains(input)).toBe(true);
    expect(group.closest(".conc-well")).not.toBeNull();
  });

  // PG26-A: the in-app audit browse + the Org-scoped toggle that isolates the
  // events the project Activity page cannot show.
  it("browses recent audit events; the Org-scoped toggle swaps to its own window (ruling 234)", () => {
    const { getByText, queryByText } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      // Ruling 234: the two windows are fetched SEPARATELY, so the unscoped
        // list here deliberately does NOT contain the PAT row. That is the live
        // shape the ruling fixes: on a busy instance the org-scoped events fall
        // out of the unscoped window entirely (measured at 2 visible against 96
        // on file), and a client-side filter of this list could never find them.
        auditEvents={[
          {
            id: "a2",
            occurredAt: "2026-08-21T10:00:00.000Z",
            actorLabel: "arda@viberr.dev",
            action: "task.metadata.updated",
            subjectKind: "task",
            subjectId: "VIB-1",
            projectSlug: "viberr-core", // project-scoped
          },
        ]}
        auditEventsOrgScoped={[
          {
            id: "a1",
            occurredAt: "2026-08-22T10:00:00.000Z",
            actorLabel: "arda@viberr.dev",
            action: "github.pat.created",
            subjectKind: "github_pat",
            subjectId: "pat_1",
            projectSlug: null, // org-scoped
          },
        ]}
      />,
    );
    // The default view is the unscoped window, and the PAT row is not in it.
    expect(getByText("task.metadata.updated")).toBeTruthy();
    expect(queryByText("github.pat.created")).toBeNull();
    // P07-H (pass 32): the list caps at 15rem and scrolls, so it must be
    // reachable by keyboard and named (WCAG 2.1.1 / axe
    // scrollable-region-focusable). The fix had no lock; this is it.
    const list = document.querySelector("ul.audit-list")!;
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(list.getAttribute("aria-label")).toBe("Recent audit events");
    // Toggling "Org-scoped" swaps to the scoped window: the PAT change the
    // unscoped list never carried is now reachable, and the project-scoped row
    // is gone. Filtering one list could not have produced this.
    fireEvent.click(getByText("Org-scoped"));
    expect(getByText("github.pat.created")).toBeTruthy();
    expect(queryByText("task.metadata.updated")).toBeNull();
  });

  it("submits set-concurrency with the new value", async () => {
    const { getByLabelText, getByRole } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    const input = getByLabelText(/Maximum concurrent agent runs/);
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(lastForm?.intent).toBe("set-concurrency");
      expect(lastForm?.maxConcurrentRuns).toBe("3");
    });
  });

  // Ruling 147(d): "nothing changed" is the only gate that keeps Save disabled.
  // Validity used to be folded into that gate, so a typed "-1" was a changed
  // value that left Save dead with nothing said.
  it("ruling 147: an unusable cap is refused on the click, not by a dead Save", async () => {
    const { getByLabelText, getByRole, queryByRole } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 2, lane: 1, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    const input = getByLabelText(/Maximum concurrent agent runs/);
    const save = getByRole("button", { name: "Save" });
    // The pristine field equals the stored cap: the dirty gate still disables.
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: "-1" } });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    expect(lastForm).toBeNull();
    const first = queryByRole("alert")!;
    expect(first.textContent).toContain("Enter a whole number (0 = unlimited).");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(
      "max-concurrent-runs-err",
    );
    expect(first.id).toBe("max-concurrent-runs-err");
    expect(document.activeElement).toBe(input);

    // Each refusal is a fresh element.
    fireEvent.click(save);
    expect(queryByRole("alert")).not.toBe(first);

    // A corrected value clears the mark and submits.
    fireEvent.change(input, { target: { value: "4" } });
    expect(queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    await waitFor(() => expect(lastForm?.maxConcurrentRuns).toBe("4"));
  });

  // `Number("")` is 0, so an emptied box used to look like a valid, changed
  // value and silently set the cap to unlimited.
  it("ruling 147: an emptied cap field is refused, never submitted as unlimited", () => {
    const { getByLabelText, getByRole, queryByRole } = renderPanel(
      <OrgSettingsPage
        view={viewBase}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 2, lane: 1, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    const input = getByLabelText(/Maximum concurrent agent runs/);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(getByRole("button", { name: "Save" }));
    expect(lastForm).toBeNull();
    expect(queryByRole("alert")).toBeTruthy();
  });
});

/**
 * Owner decision, 2026-08-31: the 90-day purge exports expiring rows to the data
 * root before deleting them. The card used to send an admin to a backup schedule
 * for ANY record past the window, which is now false, so the disclosure has to
 * name where the rows actually land and when.
 */
/**
 * Ruling 175: the instance's spending cap per Claude run, the second row in the
 * run-limits well. Blank means no cap; the action refuses what it cannot store,
 * and the row says plainly that Codex has no budget option.
 */
describe("spending cap control (ruling 175)", () => {
  const view: OrgSettingsView = {
    connections: CONNECTIONS,
    users: [ME],
    domains: DOMAINS,
    kbs: KBS,
    mcps: MCPS,
    skills: SKILLS,
    gagents: GAGENTS,
    projectGrants: { kbs: {}, mcps: {}, skills: {} },
    templateGrants: { kbs: {}, mcps: {}, skills: {} },
    stages: STAGES,
    providers: { github: false, google: false },
    authProviders: AUTH_PROVIDERS,
    storage: STORAGE,
  };
  const page = (runSpendCapUsd: number | null) => (
    <OrgSettingsPage
      view={view}
      meId={ME.id}
      callbackOrigin="http://localhost:5173"
      runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
      runSpendCapUsd={runSpendCapUsd}
      s3Audit={null}
      controllerConfig={CONTROLLER_CONFIG}
      controllerLocks={CONTROLLER_LOCKS}
      controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
    />
  );

  it("is its own row in the same well as run concurrency, and says Codex has no budget option", () => {
    const { getByRole, getByText, getByLabelText } = renderPanel(page(null));
    const row = getByRole("group", { name: "Spending cap" });
    expect(row.className).toBe("guard-row");
    expect(row.closest(".conc-well")).toBe(
      getByRole("group", { name: "Run concurrency" }).closest(".conc-well"),
    );
    expect(getByText("No cap")).toBeTruthy();
    expect(getByText(/Codex has no budget option, so a Codex run is bounded by its idle timer only/)).toBeTruthy();
    expect(getByLabelText("Max spend per Claude run, USD")).toHaveProperty("value", "");
  });

  it("reads a set cap back in dollars", () => {
    const { getByText, getByLabelText } = renderPanel(page(5));
    expect(getByText("$5.00 per Claude run")).toBeTruthy();
    expect(getByLabelText("Max spend per Claude run, USD")).toHaveProperty("value", "5.00");
  });

  it("submits a new cap, and a cleared field submits blank to lift it", async () => {
    const set = renderPanel(page(null));
    fireEvent.change(set.getByLabelText("Max spend per Claude run, USD"), { target: { value: "2.5" } });
    fireEvent.click(set.getByRole("button", { name: "Save spending cap" }));
    await waitFor(() => {
      expect(lastForm?.intent).toBe("set-run-spend-cap");
      expect(lastForm?.maxRunSpendUsd).toBe("2.5");
    });
    set.unmount();

    lastForm = null;
    const clear = renderPanel(page(5));
    fireEvent.change(clear.getByLabelText("Max spend per Claude run, USD"), { target: { value: "" } });
    fireEvent.click(clear.getByRole("button", { name: "Save spending cap" }));
    await waitFor(() => {
      expect(lastForm?.intent).toBe("set-run-spend-cap");
      expect(lastForm?.maxRunSpendUsd).toBe("");
    });
  });

  it("ruling 147: zero or a third decimal is refused on the click, not by a dead Save", () => {
    const { getByLabelText, getByRole, queryByRole } = renderPanel(page(null));
    const input = getByLabelText("Max spend per Claude run, USD");
    const save = getByRole("button", { name: "Save spending cap" });
    expect(save.hasAttribute("disabled")).toBe(true);
    for (const bad of ["0", "1.234"]) {
      fireEvent.change(input, { target: { value: bad } });
      expect(save.hasAttribute("disabled"), bad).toBe(false);
      fireEvent.click(save);
      expect(lastForm, bad).toBeNull();
      expect(queryByRole("alert")?.textContent, bad).toContain("at most two decimals");
      expect(input.getAttribute("aria-invalid"), bad).toBe("true");
    }
  });
});

describe("D04-U7 (pass 32): the S3 target card keeps the page to one primary", () => {
  const S3 = {
    bucket: "audit-bkt",
    region: "eu-west-1",
    prefix: "viberr/",
    endpoint: "",
    accessKeyId: "AKIAEXAMPLE",
    hasSecret: true,
  };
  const page = (s3Audit: typeof S3 | null) => (
    <OrgSettingsPage
      view={{
        connections: CONNECTIONS,
        users: [ME],
        domains: DOMAINS,
        kbs: KBS,
        mcps: MCPS,
        skills: SKILLS,
        gagents: GAGENTS,
        projectGrants: { kbs: {}, mcps: {}, skills: {} },
        templateGrants: { kbs: {}, mcps: {}, skills: {} },
        stages: STAGES,
        providers: { github: false, google: false },
        authProviders: AUTH_PROVIDERS,
        storage: STORAGE,
      }}
      meId={ME.id}
      callbackOrigin="http://localhost:5173"
      runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
      runSpendCapUsd={null}
      s3Audit={s3Audit}
      controllerConfig={CONTROLLER_CONFIG}
      controllerLocks={CONTROLLER_LOCKS}
      controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
    />
  );

  it("ruling 148(b): unconfigured, the six fields sit behind a Set up button", () => {
    const { getByText, container } = renderPanel(page(null));
    // The card used to serve the whole credential form open, on every tab.
    expect(document.querySelector(".audit-s3-grid")).toBeNull();
    expect(getByText("No S3 target")).toBeTruthy();
    // D04-U7: the card still adds no primary to the page.
    // Selected by the section's screen label rather than by `.audit-export`,
    // which was a presentational class carrying one margin. `.set-main`'s gap
    // owns that spacing now, so the class went with its rule (the sheet's gate
    // requires the two to travel together) and the hook became a semantic one.
    expect(
      container.querySelector('[data-screen-label="Audit log"] .btn.primary'),
    ).toBeNull();
    fireEvent.click(getByText("Set up S3 target").closest("button")!);
    expect(document.querySelector(".audit-s3-grid")).toBeTruthy();
    expect(getByText("Save target")).toBeTruthy();
    // "Export to S3 now" stays on the card, unavailable until a target exists.
    const push = getByText("Export to S3 now").closest("button")!;
    expect(push.disabled).toBe(true);
  });

  it("ruling 147: an incomplete target is refused in the modal, field by field", () => {
    const { getByText, getByPlaceholderText } = renderPanel(page(null));
    fireEvent.click(getByText("Set up S3 target").closest("button")!);
    const save = getByText("Save target").closest("button")!;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const bucket = getByPlaceholderText("my-audit-bucket");
    expect(bucket.getAttribute("aria-invalid")).toBe("true");
    // MiniModal owns the refusal: ONE alert, in its foot, per refused save.
    const alerts = document.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(document.querySelector('.modal-foot [role="alert"]')!.textContent).toContain(
      "bucket name",
    );
    expect(document.activeElement).toBe(bucket);
    fireEvent.change(bucket, { target: { value: "audit" } });
    fireEvent.click(save);
    expect(bucket.getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(getByPlaceholderText("eu-central-1"));
    expect(document.querySelector('.modal-foot [role="alert"]')!.textContent).toContain(
      "region",
    );
  });

  it("a saved target keeps the server toast and closes the modal on the result", async () => {
    const { getByText, getByLabelText, getByPlaceholderText, findByText } =
      renderPanel(page(null));
    fireEvent.click(getByText("Set up S3 target").closest("button")!);
    fireEvent.change(getByPlaceholderText("my-audit-bucket"), {
      target: { value: "bkt" },
    });
    fireEvent.change(getByPlaceholderText("eu-central-1"), {
      target: { value: "eu-west-1" },
    });
    fireEvent.change(getByPlaceholderText("AKIA…"), { target: { value: "AKIA1" } });
    fireEvent.change(getByLabelText("S3 secret access key"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(getByText("Save target").closest("button")!);
    await waitFor(() => expect(lastForm).toBeTruthy());
    expect(lastForm!.intent).toBe("s3-config-save");
    expect(lastForm!.secretAccessKey).toBe("s3cret");
    // Canary: `useOrgAction` returns early once `onResult` is supplied — drop the
    // push in it and the save goes silent.
    expect(await findByText("stub done")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".audit-s3-grid")).toBeNull());
  });

  it("review F7: a target change closes the modal (card state follows the stored target)", () => {
    // The page re-renders with a NEW stored target after a save (loader
    // revalidation); a harness stands in for the loader so the render stays
    // inside renderPanel's router.
    function Harness() {
      const [s3, setS3] = useState<typeof S3 | null>(S3);
      return (
        <>
          <button type="button" onClick={() => setS3({ ...S3, region: "eu-west-2" })}>
            harness: saved
          </button>
          <button type="button" onClick={() => setS3(null)}>
            harness: cleared
          </button>
          {page(s3)}
        </>
      );
    }
    const { getByText } = renderPanel(<Harness />);
    fireEvent.click(getByText("Edit target").closest("button")!);
    expect(document.querySelector(".audit-s3-grid")).toBeTruthy();
    // Canary: drop the `key` on <AuditExportCard> and the modal stays open over
    // a target its fields no longer describe.
    fireEvent.click(getByText("harness: saved"));
    expect(document.querySelector(".audit-s3-grid")).toBeNull();
    expect(getByText(/eu-west-2/)).toBeTruthy();
    fireEvent.click(getByText("harness: cleared"));
    expect(document.querySelector(".audit-s3-grid")).toBeNull();
    // Reopening on a cleared target seeds EMPTY fields, not the cleared values.
    fireEvent.click(getByText("Set up S3 target").closest("button")!);
    expect(
      [...document.querySelectorAll<HTMLInputElement>(".audit-s3-grid input")].every((i) => i.value === ""),
    ).toBe(true);
  });

  it("configured: the summary line is the only S3 fact until Edit target", () => {
    const { getByText, queryByText } = renderPanel(page(S3));
    expect(getByText(/s3:\/\/audit-bkt\/viberr\//)).toBeTruthy();
    expect(document.querySelector(".audit-s3-grid")).toBeNull();
    expect(queryByText("Save target")).toBeNull();
    fireEvent.click(getByText("Edit target").closest("button")!);
    expect(document.querySelector(".audit-s3-grid")).toBeTruthy();
    expect(getByText("Save target")).toBeTruthy();
    fireEvent.click(getByText("Cancel").closest("button")!);
    expect(document.querySelector(".audit-s3-grid")).toBeNull();
  });
});

describe("FR33: the audit card discloses the export-before-purge record", () => {
  it("names the folder, the shape, and that the write precedes the delete", () => {
    const { getByText } = renderPanel(
      <OrgSettingsPage
        view={{
          connections: CONNECTIONS,
          users: [ME],
          domains: DOMAINS,
          kbs: KBS,
          mcps: MCPS,
          skills: SKILLS,
          gagents: GAGENTS,
          projectGrants: { kbs: {}, mcps: {}, skills: {} },
          templateGrants: { kbs: {}, mcps: {}, skills: {} },
          stages: STAGES,
          providers: { github: false, google: false },
          authProviders: AUTH_PROVIDERS,
          storage: STORAGE,
        }}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
        auditEvents={[]}
        auditEventsOrgScoped={[]}
      />,
    );
    const copy = getByText(/Download the audit log/).textContent ?? "";
    expect(copy).toContain("audit-exports/ in the instance data root");
    expect(copy).toContain("one JSON object per line");
    // Ordering is the whole promise: exported, THEN deleted.
    expect(copy).toContain("before the retention sweep deletes them");
    // The two bounds on the DOWNLOAD are unchanged and still stated.
    expect(copy).toContain("100,000 rows");
    expect(copy).toContain("90-day retention window");
    // The superseded claim that a schedule is the only longer record is gone.
    expect(copy).not.toContain("For a longer record");
  });
});

describe("R15-13: instance settings name their scope, not a project's name", () => {
  it("titles itself 'Instance settings' — never the product name", () => {
    // "Viberr settings" collided with a PROJECT named Viberr: the surface that
    // is NOT about that project was the one carrying its name, while the
    // project's own settings page said only "Settings". Both now answer
    // "settings for what?" on their own, like every other heading in the app.
    // Canary: put "Viberr settings" back and both halves fail.
    const { container } = renderPanel(
      <OrgSettingsPage
        view={{
          connections: CONNECTIONS,
          users: [ME],
          domains: DOMAINS,
          kbs: KBS,
          mcps: MCPS,
          skills: SKILLS,
          gagents: GAGENTS,
          projectGrants: { kbs: {}, mcps: {}, skills: {} },
          templateGrants: { kbs: {}, mcps: {}, skills: {} },
          stages: STAGES,
          providers: { github: false, google: false },
          authProviders: AUTH_PROVIDERS,
          storage: STORAGE,
        }}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
        runConcurrency={{ cap: 0, lane: 0, live: 0, queued: 0 }}
        runSpendCapUsd={null}
        s3Audit={null}
        controllerConfig={CONTROLLER_CONFIG}
        controllerLocks={CONTROLLER_LOCKS}
        controllerRequests={[]}
      auditEvents={[]}
      auditEventsOrgScoped={[]}
      />,
    );
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("Instance settings");
    expect(h1s[0]!.textContent).not.toContain("Viberr");
    // The subtitle already carried the scope; it must keep doing so.
    expect(container.textContent).toContain("Instance level, shared by every project");
  });
});

describe("KBModal — two content modes (P21, the skill modal's twin)", () => {
  function openNewKb() {
    const utils = renderPanel(
      <ResourcesPanel kbs={KBS} mcps={MCPS} skills={SKILLS} gagents={GAGENTS} stages={STAGES} />,
    );
    const kbPanel = [...document.querySelectorAll(".panel")].find(
      (p) => p.querySelector("h2")?.textContent === "Knowledge bases",
    )!;
    fireEvent.click(kbPanel.querySelector(".panel-head .btn")!);
    const nameInput = document.querySelector<HTMLInputElement>("#kb-name")!;
    return { ...utils, nameInput };
  }

  it("'Start from files' relabels the save and submits the same kb-save", async () => {
    const { nameInput, getByText } = openNewKb();
    fireEvent.change(nameInput, { target: { value: "Design notes" } });
    expect(getByText("Create & index")).not.toBeNull();

    fireEvent.click(getByText("Start from files"));
    // The create is identical server-side — only the handoff differs, and the
    // label says where the human lands.
    fireEvent.click(getByText("Create & add files"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "kb-save",
        name: "Design notes",
        refresh: "on change",
      }),
    );
  });

  /**
   * Ruling 455(f), UI-58: the content group was a `role="radiogroup"` of plain
   * buttons, so it promised arrow keys it never wired and each radio was its
   * own tab stop. On `RadioSeg` it is one tab stop that ←/→ traverse, and a
   * choice commits on activation, never on focus (RadioSeg's note).
   */
  it("the content radiogroup moves with arrow keys and commits on activation", async () => {
    const { nameInput, getByText } = openNewKb();
    fireEvent.change(nameInput, { target: { value: "Design notes" } });
    const group = document.querySelector<HTMLElement>('.mode-radios[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("How the knowledge base gets its content");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["Empty for now", "Start from files"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(radios.map((r) => r.className)).toEqual(["btn sm", "btn sm ghost"]);
    // One tab stop: the group holds it and hands entry focus to the checked
    // option.
    expect(group.getAttribute("tabindex")).toBe("0");
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
    // Radix moves focus in a `setTimeout`, so each move is awaited.
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));
    // Focus alone chose nothing.
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(getByText("Create & index")).not.toBeNull();
    // Activation (what Enter / Space do on a focused button) chooses.
    fireEvent.click(radios[1]!);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(radios.map((r) => r.className)).toEqual(["btn sm ghost", "btn sm"]);
    expect(getByText("Create & add files")).not.toBeNull();
    // The ends wrap.
    fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));
    // Activating the chosen option again keeps it chosen: a radio group always
    // holds one value.
    fireEvent.click(radios[1]!);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("edit mode never offers the mode radios (content already exists)", () => {
    const utils = renderPanel(
      <ResourcesPanel kbs={KBS} mcps={MCPS} skills={SKILLS} gagents={GAGENTS} stages={STAGES} />,
    );
    const kbPanel = [...document.querySelectorAll(".panel")].find(
      (p) => p.querySelector("h2")?.textContent === "Knowledge bases",
    )!;
    fireEvent.click(kbPanel.querySelector('[title="Edit"]')!);
    expect(document.querySelector("#kb-name")).not.toBeNull();
    expect(utils.queryByText("Start from files")).toBeNull();
  });
});

/* ------------- ruling 176: the MCP editor's "Write tools" section --------- */

/**
 * Ruling 220 (F37-40). The MCP row stated the write-tool position only when a
 * server was GATED, so the one state worth seeing — tools that look like
 * writes, nobody has reviewed them, so nothing is withheld — was the state the
 * list was silent about. Live on this instance, `kb-architecture` and
 * `kb-conventions` are `server-filesystem` rooted at a knowledge base, 14 tools
 * each, granted to three agent templates each, unmarked: those agents can
 * rewrite the knowledge bases that are injected into every other agent's prompt
 * as configuration. The controller reasoned about that exact hazard for a third
 * such server and granted nothing; the list gave it and the admin nothing.
 */
describe("MCP rows state where a server stands on write tools (ruling 220)", () => {
  const FS_TOOLS = ["read_file", "list_directory", "write_file", "edit_file", "move_file"];

  function rowText(m: McpView): string {
    // Two rows in one test would make `getByText` ambiguous; each reading is
    // its own render.
    cleanup();
    const { getByText } = renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={[m]}
        skills={SKILLS}
        gagents={GAGENTS}
        templateGrants={TEMPLATE_GRANTS}
        stages={STAGES}
      />,
    );
    // The posture rides the row's meta line, beside the transport and target —
    // read the whole row so the assertion cannot pass on a fragment.
    const row = getByText(m.name).closest("li, .rsrc-row, div");
    return row?.textContent ?? "";
  }

  it("names the unreviewed write-looking tools and says nothing is withheld", () => {
    // CANARY: render "" for the unreviewed case (the old behaviour) and the
    // row goes back to saying nothing about a server three templates can write
    // the knowledge bases with.
    const text = rowText({
      ...MCPS[0]!,
      discoveredTools: FS_TOOLS,
      writeTools: [],
      writeToolsReviewed: false,
    });
    expect(text).toContain("3 tools look like a write and nothing is withheld: not reviewed");
  });

  it("says so when an admin reviewed the server and withheld nothing", () => {
    const text = rowText({
      ...MCPS[0]!,
      discoveredTools: FS_TOOLS,
      writeTools: [],
      writeToolsReviewed: true,
    });
    expect(text).toContain("reviewed: none of its 3 write-looking tools is withheld");
    expect(text).not.toContain("not reviewed");
  });

  it("keeps ruling 176's sentence for a gated server, and stays quiet when nothing looks like a write", () => {
    expect(
      rowText({ ...MCPS[0]!, discoveredTools: FS_TOOLS, writeTools: ["write_file"] }),
    ).toContain("1 write tool withheld from read-only runs");
    // A read-only server has no position to state, and a row that alarms on
    // everything is a row nobody reads.
    const quiet = rowText({
      ...MCPS[0]!,
      discoveredTools: ["read_file", "list_directory"],
      writeTools: [],
      writeToolsReviewed: false,
    });
    expect(quiet).not.toMatch(/write/i);
  });
});

describe("McpModal — write tools (ruling 176)", () => {
  const LISTED = ["get_issue", "create_pull_request", "merge_pull_request", "list_commits"];

  function renderWith(mcps: McpView[]) {
    return renderPanel(
      <ResourcesPanel
        kbs={KBS}
        mcps={mcps}
        skills={SKILLS}
        gagents={GAGENTS}
        templateGrants={TEMPLATE_GRANTS}
        stages={STAGES}
      />,
    );
  }

  it("a server nobody has reviewed opens with the write-looking names selected, and saves them", async () => {
    // Canary: seed `marked` with `[]` instead of the heuristic and the save
    // below sends an empty list.
    const unreviewed: McpView[] = [{ ...MCPS[0]!, discoveredTools: LISTED }];
    const { getByLabelText, getByRole, getByText } = renderWith(unreviewed);
    fireEvent.click(getByLabelText("Edit github-mcp"));
    const group = getByRole("group", { name: /Write tools/ });
    const pressed = [...group.querySelectorAll('[aria-pressed="true"]')].map((b) => b.textContent);
    expect(pressed).toEqual(["create_pull_request", "merge_pull_request"]);
    expect(getByText(/Review them before you save/)).toBeTruthy();
    fireEvent.click(getByText("Save & re-test"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        intent: "mcp-save",
        writeTools: JSON.stringify(["create_pull_request", "merge_pull_request"]),
      }),
    );
  });

  it("a reviewed server opens with exactly its saved marks; a toggle and a typed name change the list", async () => {
    const reviewed: McpView[] = [
      {
        ...MCPS[0]!,
        discoveredTools: LISTED,
        writeTools: ["merge_pull_request"],
        writeToolsReviewed: true,
      },
    ];
    const { getByLabelText, getByRole, getByText, queryByText } = renderWith(reviewed);
    // The row says the server is gated.
    expect(getByText(/1 write tool withheld from read-only runs/)).toBeTruthy();
    fireEvent.click(getByLabelText("Edit github-mcp"));
    expect(queryByText(/Review them before you save/)).toBeNull();
    const group = getByRole("group", { name: /Write tools/ });
    const chip = (name: string) =>
      [...group.querySelectorAll("button")].find((b) => b.textContent === name)!;
    expect(chip("merge_pull_request").getAttribute("aria-pressed")).toBe("true");
    expect(chip("create_pull_request").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(chip("create_pull_request"));
    const input = getByLabelText("Add a write tool by name");
    const add = getByText("Add tool");
    fireEvent.change(input, { target: { value: "delete repo" } });
    expect(add).toHaveProperty("disabled", true);
    fireEvent.change(input, { target: { value: "delete_repo" } });
    fireEvent.click(add);
    expect(chip("delete_repo").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(getByText("Save & re-test"));
    await waitFor(() =>
      expect(lastForm).toMatchObject({
        writeTools: JSON.stringify(["merge_pull_request", "create_pull_request", "delete_repo"]),
      }),
    );
  });

  it("a new server with nothing to show yet saves without the list, so its first probe still suggests", async () => {
    const { getByLabelText, getByText } = renderWith(MCPS);
    fireEvent.click(getByLabelText("Add MCP server"));
    fireEvent.change(getByLabelText(/Server name/), { target: { value: "gh-new" } });
    fireEvent.change(getByLabelText(/Endpoint/), { target: { value: "https://mcp.example/gh" } });
    expect(getByText(/Its tools are listed here once the connection test answers/)).toBeTruthy();
    fireEvent.click(getByText("Add & test connection"));
    await waitFor(() => expect(lastForm).toMatchObject({ intent: "mcp-save", name: "gh-new" }));
    expect(lastForm).not.toHaveProperty("writeTools");
  });
});
