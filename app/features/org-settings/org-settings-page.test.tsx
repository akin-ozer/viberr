// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createRoutesStub } from "react-router";
import type { ConnectionRecord } from "~/server/org/connections.server";
import type { GagentView } from "~/server/org/gagents.server";
import type { DomainRecord, OrgUserView } from "~/server/org/org-users.server";
import type { KbView, McpView, SkillView } from "~/server/org/resources.server";
import { ToastProvider } from "~/ui/toast";
import { ConnectionsPanel } from "./connections-panel";
import { ResourcesPanel } from "./resources-panel";
import { UsersPanel } from "./users-panel";

/**
 * jsdom smokes for the three org-settings tabs: mock markup/copy fidelity,
 * client-side guard toasts, dialog open/confirm flows, and the intents the
 * panels post (captured by the stub action).
 */

afterEach(cleanup);

let lastForm: Record<string, string> | null = null;

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
          if (typeof v === "string") lastForm[k] = v;
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
    validationState: "unvalidated", lastValidatedAt: null,
    createdAt: "2026-07-01T09:00:00.000Z",
  },
  {
    id: "hepapi", owner: "hepapi", method: "PAT", patId: "pat_2",
    masked: "····42af", def: false, repos: 12, expiresAt: "2026-07-20T00:00:00.000Z",
    daysLeft: 15, validationState: "valid", lastValidatedAt: "2026-07-01T09:00:00.000Z",
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
    fireEvent.click(getByText("Remove", { selector: "button.btn.danger" }));
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
    expect(getByText("you")).toBeTruthy();
    expect(getByText("whitelisted")).toBeTruthy();
    expect(getByText("password reset pending")).toBeTruthy();
    expect(getByText("domain allowlist")).toBeTruthy();
    expect(getByText("any Google account with this domain · joins as member")).toBeTruthy();
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
    fireEvent.click(getByText("Remove", { selector: "button.btn.danger" }));
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
      <UsersPanel users={USERS} domains={DOMAINS} meId="u_arda" />,
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
    fileCount: 2, uri: "store://kb/architecture-notes",
  },
];
const MCPS: McpView[] = [
  { id: "m1", name: "github-mcp", transport: "HTTP", target: "https://mcp.internal:7801/sse",
    hasCred: true, tools: 14, up: true, lastCheckedAt: new Date().toISOString() },
  { id: "m2", name: "browserbase", transport: "HTTP", target: "https://mcp.internal:7809/sse",
    hasCred: false, tools: 0, up: false, lastCheckedAt: new Date().toISOString() },
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
    expect(getByText("store://kb/architecture-notes/ · 2 docs")).toBeTruthy();
    expect(getByText(/read live · re-scanned just now/)).toBeTruthy();
    expect(getByText(/14 tools · checked just now · auth: configured/)).toBeTruthy();
    expect(getByText(/unreachable · checked just now/)).toBeTruthy();
    expect(
      getByText(/store:\/\/skills\/terraform-review\/ · 1 file · updated just now · 1 template/),
    ).toBeTruthy();
    expect(getByText(/Codex · Ready · In Progress · 2 context resources · used in 4 projects/)).toBeTruthy();
    expect(getByText(/These are the shared base definitions/)).toBeTruthy();
  });

  it("renders a stale health check as amber (not a fresh-green 'up') with a retest hint", () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const staleMcps: McpView[] = [
      { id: "m3", name: "notes-fixture", transport: "stdio", target: "node /tmp/notes.mjs",
        hasCred: true, tools: 1, up: true, lastCheckedAt: threeHoursAgo },
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
    fireEvent.click(getByText("Remove", { selector: "button.btn.danger" }));
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
    expect(getByText("Done is human-only, always")).toBeTruthy();
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
});
