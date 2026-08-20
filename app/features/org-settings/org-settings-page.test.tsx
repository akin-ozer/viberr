// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createRoutesStub } from "react-router";
import { z } from "zod";
import type { ConnectionRecord } from "~/server/org/connections.server";
import type { GagentView } from "~/server/org/gagents.server";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { ToastProvider } from "~/ui/toast";
import { ConnectionsPanel } from "./connections-panel";
import { OrgSettingsPage } from "./org-settings-page";
import type { AuthProviderView } from "~/server/org/org-view.server";
import { ResourcesPanel } from "./resources-panel";
import { UsersPanel } from "./users-panel";

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

function renderPanel(ui: ReactNode) {
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
  return render(<Stub initialEntries={["/org/settings"]} />);
}

const CONNECTIONS: ConnectionRecord[] = [
  {
    id: "akin-ozer", owner: "akin-ozer", method: "PAT", patId: "pat_1",
    masked: "····0000", def: true, repos: null, expiresAt: null, daysLeft: null,
    validationState: "unvalidated", scopes: [], lastValidatedAt: null,
    createdAt: "2026-07-01T09:00:00.000Z",
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
    createdAt: "2026-07-01T09:05:00.000Z",
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
    expect(
      getByText(/Projects already created from hepapi keep their repos/),
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

  it("add-connection modal: duplicate guard fires client-side", async () => {
    const { getByText, getByLabelText, getByPlaceholderText } = renderPanel(
      <ConnectionsPanel connections={CONNECTIONS} />,
    );
    fireEvent.click(getByText("Add connection"));
    expect(getByText("New GitHub connection")).toBeTruthy();
    const save = getByText("Validate & connect").closest("button")!;
    expect(save.disabled).toBe(true);

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
  disabled: false,
};
const USERS: OrgUserView[] = [
  ME,
  {
    id: "u_gh", name: "@octocat", email: "github.com/octocat", initials: "O",
    tone: "teal", role: "member", status: "whitelisted", idp: "github",
    pwreset: false, disabled: false,
  },
  {
    id: "u_selin", name: "Selin Aksoy", email: "selin@viberr.dev", initials: "SA",
    tone: "violet", role: "member", status: "active", idp: "local",
    pwreset: true, disabled: false,
  },
];
const DISABLED_USER: OrgUserView = {
  id: "u_dz", name: "Deniz Yıldız", email: "deniz@viberr.dev", initials: "DY",
  tone: "", role: "member", status: "active", idp: "local", pwreset: false,
  disabled: true,
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
    const { getByText, getByLabelText, queryByRole } = renderPanel(
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
    const { getByText, getByPlaceholderText } = renderPanel(
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
    expect(whitelistBtn.disabled).toBe(true);

    fireEvent.click(getByText("Local", { selector: ".bnm" }).closest("button")!);
    expect(getByPlaceholderText("Full name")).toBeTruthy();
    const createBtn = getByText("Create account").closest("button")!;
    expect(createBtn.disabled).toBe(true);
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
    hasCred: true, tools: 14, up: true, lastCheckedAt: new Date().toISOString(), lastError: null, warmingSince: null },
  { id: "m2", name: "browserbase", transport: "HTTP", target: "https://mcp.internal:7809/sse",
    hasCred: false, tools: 0, up: false, lastCheckedAt: new Date().toISOString(), lastError: null, warmingSince: null },
];
const SKILLS: SkillView[] = [
  { id: "s1", name: "terraform-review", summary: "Module review checklist.",
    updatedAt: new Date().toISOString(), body: "## Review checklist",
    tree: [{ type: "file", name: "SKILL.md", sizeBytes: 340, mtime: new Date().toISOString() }],
    fileCount: 1, uri: "store://skills/terraform-review" },
];
const GAGENTS: GagentView[] = [
  { id: "developer", name: "Developer", backend: "codex",
    summary: "Primary implementation specialist.",
    persona: "", stages: ["ready", "impl"],
    skills: ["terraform-review"], mcps: ["github-mcp"], kbs: [], used: 4 },
  { id: "spare", name: "Spare", backend: "claude", summary: "Unused.",
    persona: "", stages: ["impl"], skills: [], mcps: [], kbs: [], used: 0 },
];
const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "ready", name: "Ready", color: "#187574" },
  { id: "impl", name: "In Progress", color: "#7b61ff" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

function renderResources() {
  return renderPanel(
    <ResourcesPanel kbs={KBS} mcps={MCPS} skills={SKILLS} gagents={GAGENTS} stages={STAGES} />,
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
      },
    ];
    const { container } = renderPanel(
      <ResourcesPanel kbs={[]} mcps={warming} skills={[]} gagents={[]} stages={STAGES} />,
    );
    // R20-4 (N20-2): softened to one copy for both the evidence and heuristic
    // warm-up bases — the reader can act on neither distinction.
    expect(container.textContent).toContain("first run — installing in the background");
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
        hasCred: true, tools: 1, up: true, lastCheckedAt: threeHoursAgo, lastError: null, warmingSince: null },
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
    expect(container.textContent).toContain("1 tools · checked");
  });

  it("kb delete confirms with the spec copy; deployed profile delete is guarded", async () => {
    const { getByText, getByLabelText } = renderResources();
    fireEvent.click(getByLabelText("Delete Architecture notes"));
    expect(getByText(/The index is removed from the store/)).toBeTruthy();
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
    const { getByText, getByLabelText } = renderResources();
    fireEvent.click(getByLabelText("Edit Developer"));
    expect(getByText("Edit agent profile")).toBeTruthy();
    // P13-D-9: "always" was an over-promise — a project's operator can close a
    // task under the auto preset. No AGENT profile ever can, which is the
    // guarantee this org-scoped editor is actually in a position to make.
    expect(getByText("Done is closed by a human, never by an agent")).toBeTruthy();
    const chips = [...document.querySelectorAll(".pick-chip")];
    expect(chips.some((c) => c.textContent === "Done")).toBe(false);
    // P13-AP-05/AP-07: a template is ADOPTED (copied) by a project, so an org
    // edit does not silently reach an already-adopted project on its next run.
    expect(
      getByText(
        "adopted by 4 projects — each keeps its own copy; re-adopt to pick up this edit",
      ),
    ).toBeTruthy();
    // Three ctx groups over the org resources; the selected skill chip is on.
    expect(document.querySelectorAll(".ctx-group")).toHaveLength(3);
    const skillChip = chips.find((c) => c.textContent === "terraform-review")!;
    expect(skillChip.className).toContain(" on");
  });

  it("kb name opens the StoreBrowser over the real tree", () => {
    const { getByText } = renderResources();
    fireEvent.click(getByText("Architecture notes", { selector: "button.linkish" }));
    expect(
      document.querySelector('[aria-label="Files — Architecture notes"]'),
    ).toBeTruthy();
    expect(getByText("overview.md")).toBeTruthy();
    expect(
      getByText(/This is the real folder on disk — files added outside Viberr/),
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
    expect(getByText(/folder missing — no docs reach a granted agent/)).toBeTruthy();
    // It must NOT read like a normal empty KB.
    expect(queryByText(/0 docs · agents read the live folder/)).toBeNull();
  });

  it("P14-KM-09: MCP rows and the delete confirm count the templates that grant them", () => {
    const { getByText, getByLabelText } = renderResources();
    // KB and skill rows have counted templates since P13-KM-08; the MCP row was
    // the one destructive path with no idea what depended on it.
    expect(getByText(/14 tools · checked just now · auth: configured · 1 template/)).toBeTruthy();

    fireEvent.click(getByLabelText("Remove github-mcp"));
    expect(
      getByText(/The grant is dropped from 1 agent template and from every project/),
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
      "repo, pull_request:write unproven — verified when attached to a project",
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
    expect(save.hasAttribute("disabled")).toBe(true); // no summary yet
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
          stages: STAGES,
          providers: { github: false, google: false },
          authProviders: AUTH_PROVIDERS,
        }}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
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
          stages: STAGES,
          providers: { github: false, google: false },
          authProviders: AUTH_PROVIDERS,
        }}
        meId={ME.id}
        callbackOrigin="http://localhost:5173"
      />,
    );
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("Instance settings");
    expect(h1s[0]!.textContent).not.toContain("Viberr");
    // The subtitle already carried the scope; it must keep doing so.
    expect(container.textContent).toContain("Instance level — shared by every project");
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
