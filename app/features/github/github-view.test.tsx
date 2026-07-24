// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectCredentialHealth } from "~/server/secrets/pat-store.server";
import { CredentialCard, CredentialManageActions } from "./credential-card";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import {
  BranchesPanel,
  GithubViewPage,
  PullRequestsPanel,
  RepositoryPanel,
} from "./github-view";
import type { BranchRowView, PrRowView } from "./github-query.server";

afterEach(cleanup);

/* ----------------------------------------------------------- fixtures */

// A REAL bound PAT that carries an open scope violation — the honest case the
// card must render (the removed `policy_display` fabrication no longer exists).
const violationCredential: ProjectCredentialHealth = {
  configured: true,
  source: "pat",
  patId: "pat_seed_1",
  label: "viberr-bot · fine-grained PAT",
  masked: "github_pat_••••42af",
  lastValidatedAt: "2026-07-10T00:00:00.000Z",
  validation: null,
  requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
  scopes: [
    { id: "repo", ok: true, source: "header" },
    { id: "workflow", ok: true, source: "header" },
    { id: "read:org", ok: true, source: "header" },
    {
      id: "pull_request:write",
      ok: false,
      source: "violation",
      flaggedTaskKey: "VIB-142",
    },
  ],
  openViolations: [],
};

const healthyCredential: ProjectCredentialHealth = {
  ...violationCredential,
  scopes: violationCredential.scopes.map((s) => ({
    ...s,
    ok: true,
    source: "header" as const,
  })),
};

const noneCredential: ProjectCredentialHealth = {
  ...violationCredential,
  configured: false,
  source: "none",
  patId: null,
  label: null,
  masked: null,
  scopes: [],
};

const prs: PrRowView[] = [
  {
    taskKey: "VIB-142",
    number: 318,
    state: "review",
    title: "Attach execution workspace",
    branch: "vib-142-attach-workspace",
  },
  {
    taskKey: "VIB-139",
    number: 298,
    state: "merged",
    title: "Policy split",
    branch: "vib-139-policy-split",
  },
  {
    taskKey: "VIB-777",
    number: 200,
    state: "closed",
    title: "Abandoned spike",
    branch: "vib-777-spike",
  },
];

const branches: BranchRowView[] = [
  {
    taskKey: "VIB-142",
    title: "Attach execution workspace to task runtime",
    branch: "vib-142-attach-workspace",
    pr: { number: 318, state: "review" },
    sync: "synced",
    commitCount: 3,
  },
  {
    taskKey: "VIB-151",
    title: "Compress long-running task timelines",
    branch: "vib-151-timeline-compression",
    pr: null,
    sync: "behind_main",
    commitCount: 0,
  },
  {
    taskKey: "VIB-139",
    title: "Separate human RBAC from agent capability policy",
    branch: "vib-139-policy-split",
    pr: { number: 298, state: "merged" },
    sync: "merged",
    commitCount: 0,
  },
];

/* ------------------------------------------------- credential card matrix */

describe("CredentialCard states", () => {
  it("open violation → cred-warn with the missing scope, flagged task keybtn", () => {
    const onOpenTask = vi.fn();
    const { container } = render(
      <CredentialCard credential={violationCredential} onOpenTask={onOpenTask} />,
    );
    expect(container.querySelector(".cred-name")!.textContent).toBe(
      "viberr-bot · fine-grained PAT",
    );
    expect(container.textContent).toContain("github_pat_••••42af");
    const chips = container.querySelectorAll(".scope-chip");
    expect(chips.length).toBe(4);
    expect(container.querySelectorAll(".scope-chip.miss").length).toBe(1);
    expect(
      container.querySelector(".scope-chip.miss")!.textContent,
    ).toContain("pull_request:write");
    const warn = container.querySelector(".cred-warn")!;
    expect(warn.textContent).toContain(
      "PR status can't auto-sync after merge",
    );
    fireEvent.click(container.querySelector(".keybtn")!);
    expect(onOpenTask).toHaveBeenCalledWith("VIB-142");
    expect(container.querySelector(".cred-ok")).toBeNull();
  });

  it("all scopes ok → cred-ok with the verbatim all-good copy", () => {
    const { container } = render(
      <CredentialCard credential={healthyCredential} onOpenTask={() => {}} />,
    );
    expect(container.querySelector(".cred-warn")).toBeNull();
    expect(container.querySelectorAll(".scope-chip.miss").length).toBe(0);
    expect(container.querySelector(".cred-ok")!.textContent).toContain(
      "All required scopes granted. Secrets stay isolated from task records and timelines.",
    );
  });

  it("no credential at all → connect-credential affordance, no chips", () => {
    const { container } = render(
      <CredentialCard credential={noneCredential} onOpenTask={() => {}} />,
    );
    expect(container.querySelector(".scope-chips")).toBeNull();
    expect(container.querySelector(".cred-name")!.textContent).toBe(
      "No credential configured",
    );
    expect(container.querySelector(".cred-warn")!.textContent).toContain(
      "No GitHub PAT is connected to this project",
    );
  });

  it("a bound-but-unvalidated PAT is NOT claimed 'granted' — shows an honest 'not yet verified' warn", () => {
    // Every scope at source "unchecked" = a PAT attached but never probed. The
    // card must not affirm "All required scopes granted" without evidence.
    const unverified: ProjectCredentialHealth = {
      ...healthyCredential,
      lastValidatedAt: null,
      scopes: healthyCredential.scopes.map((s) => ({
        ...s,
        ok: true,
        source: "unchecked" as const,
      })),
    };
    const { container } = render(
      <CredentialCard credential={unverified} onOpenTask={() => {}} />,
    );
    expect(container.querySelector(".cred-ok")).toBeNull();
    expect(container.querySelector(".cred-warn")!.textContent).toContain(
      "scopes not yet verified",
    );
  });

  it("renders the warnActions slot inside the banner", () => {
    const { container } = render(
      <CredentialCard
        credential={violationCredential}
        onOpenTask={() => {}}
        warnActions={<button className="btn sm">Grant scope</button>}
      />,
    );
    expect(container.querySelector(".cred-warn .btn")!.textContent).toBe(
      "Grant scope",
    );
  });

  it("renders the manageActions slot in every state, including 'none'", () => {
    const slot = <div className="cred-manage">manage-slot</div>;
    const withPat = render(
      <CredentialCard
        credential={healthyCredential}
        onOpenTask={() => {}}
        manageActions={slot}
      />,
    );
    expect(withPat.container.querySelector(".cred-manage")).not.toBeNull();
    cleanup();
    const withNone = render(
      <CredentialCard
        credential={noneCredential}
        onOpenTask={() => {}}
        manageActions={slot}
      />,
    );
    expect(withNone.container.querySelector(".cred-manage")).not.toBeNull();
  });
});

describe("CredentialManageActions (finding #13)", () => {
  it("unconfigured → only Attach; configured → Rotate + confirmed Remove", () => {
    const onSet = vi.fn();
    const onClear = vi.fn();
    const attach = render(
      <CredentialManageActions
        configured={false}
        canManage
        busy={false}
        onSet={onSet}
        onClear={onClear}
      />,
    );
    expect(attach.queryByText("Remove credential")).toBeNull();
    fireEvent.click(attach.getByText("Attach credential"));
    expect(onSet).toHaveBeenCalled();
    cleanup();

    const bound = render(
      <CredentialManageActions
        configured
        canManage
        busy={false}
        onSet={onSet}
        onClear={onClear}
      />,
    );
    fireEvent.click(bound.getByText("Rotate credential"));
    expect(onSet).toHaveBeenCalledTimes(2);
    // Remove is gated by the confirm dialog.
    fireEvent.click(bound.getByText("Remove credential"));
    expect(onClear).not.toHaveBeenCalled();
    expect(bound.container.querySelector('[role="alertdialog"]')).not.toBeNull();
    fireEvent.click(
      bound.getByText("Remove credential", { selector: "button.btn.danger" }),
    );
    expect(onClear).toHaveBeenCalled();
  });

  it("renders nothing when the viewer can't manage credentials", () => {
    const { container } = render(
      <CredentialManageActions
        configured
        canManage={false}
        busy={false}
        onSet={() => {}}
        onClear={() => {}}
      />,
    );
    expect(container.querySelector(".cred-manage")).toBeNull();
  });
});

/* ------------------------------------------------------ repository panel */

describe("RepositoryPanel", () => {
  it("renders repo, degraded connection pill and the fixed kv copy", () => {
    const { container } = render(
      <RepositoryPanel
        data={{
          project: {
            slug: "viberr-core",
            name: "Viberr Core",
            repo: "akin-ozer/viberr",
            defaultBranch: "main",
          },
          connection: { status: "no_pat_configured", repo: "akin-ozer/viberr" },
          credential: noneCredential,
        }}
        onOpenTask={() => {}}
      />,
    );
    const rows = container.querySelectorAll(".kv-row");
    expect(rows.length).toBe(4);
    expect(rows[0]!.textContent).toContain("akin-ozer/viberr");
    // Degraded: the pill must NOT claim connected (spec §7.9c).
    expect(rows[1]!.querySelector(".pill")!.textContent).toContain(
      "no credential",
    );
    expect(rows[2]!.textContent).toContain(
      "project default · task-level override allowed",
    );
    expect(rows[3]!.textContent).toContain("1 · V1 limit");
  });

  it("claims connected only for a connected result", () => {
    const { container } = render(
      <RepositoryPanel
        data={{
          project: {
            slug: "viberr-core",
            name: "Viberr Core",
            repo: "akin-ozer/viberr",
            defaultBranch: "main",
          },
          connection: {
            status: "connected",
            repo: "akin-ozer/viberr",
            remoteDefaultBranch: "main",
            private: true,
          },
          credential: healthyCredential,
        }}
        onOpenTask={() => {}}
      />,
    );
    expect(
      container.querySelectorAll(".kv-row")[1]!.querySelector(".pill.ready"),
    ).not.toBeNull();
  });
});

/* -------------------------------------------------------------- PR panel */

describe("PullRequestsPanel", () => {
  it("renders count, rows with pills (incl. closed risk) and sub-lines", () => {
    const onOpenTask = vi.fn();
    const { container } = render(
      <PullRequestsPanel prs={prs} defaultBranch="main" onOpenTask={onOpenTask} />,
    );
    expect(container.querySelector(".panel-head .right")!.textContent).toBe(
      "3 linked to tasks",
    );
    const rows = container.querySelectorAll(".rq-row");
    expect(rows.length).toBe(3);
    expect(rows[0]!.querySelector(".rq-key")!.textContent).toBe("#318");
    expect(rows[0]!.querySelector(".sub")!.textContent).toBe(
      "vib-142-attach-workspace → main · VIB-142",
    );
    expect(rows[0]!.querySelector(".pill")!.textContent).toContain("in review");
    expect(rows[1]!.querySelector(".pill.done")!.textContent).toContain(
      "merged",
    );
    // Ruling 12: closed-unmerged renders the risk pill.
    expect(rows[2]!.querySelector(".pill.risk")!.textContent).toContain(
      "closed",
    );
    fireEvent.click(rows[0]!);
    expect(onOpenTask).toHaveBeenCalledWith("VIB-142");
    // Footer note is verbatim contract (B10: honest about the offline path).
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "Merging stays reserved for humans — accepting a completion in the review queue merges its PR when GitHub is reachable; otherwise it records accepted (merge pending).",
    );
  });

  it("zero PRs → quiet empty line (spec §7.9a addition)", () => {
    const { container } = render(
      <PullRequestsPanel prs={[]} defaultBranch="main" onOpenTask={() => {}} />,
    );
    expect(container.querySelectorAll(".rq-row").length).toBe(0);
    expect(container.querySelector(".rq-list")!.textContent).toContain(
      "No pull requests yet",
    );
  });
});

/* ---------------------------------------------------------- branch table */

describe("BranchesPanel", () => {
  it("renders the 4-column table with sync pills per ruling 12", () => {
    const onOpenTask = vi.fn();
    const { container } = render(
      <BranchesPanel branches={branches} onOpenTask={onOpenTask} />,
    );
    expect(container.querySelector(".panel-head .right")!.textContent).toBe(
      "3 task-key branches",
    );
    const head = container.querySelector(".live-head")!;
    expect(head.textContent).toBe("TaskExecution branchPull requestSync");
    const rows = container.querySelectorAll(".live-row");
    expect(rows.length).toBe(3);

    // VIB-142: PR pill without dot, synced pill, commit association count.
    expect(rows[0]!.querySelector(".live-task .key")!.textContent).toBe(
      "VIB-142",
    );
    expect(rows[0]!.querySelector(".trace.ok")!.textContent).toBe(
      "vib-142-attach-workspace",
    );
    expect(rows[0]!.textContent).toContain("3 commits");
    expect(rows[0]!.textContent).toContain("#318");
    expect(rows[0]!.querySelector(".pill.ready")!.textContent).toContain(
      "synced",
    );

    // VIB-151: no PR → em-dash placeholder; behind main risk pill.
    expect(rows[1]!.textContent).toContain("—");
    expect(rows[1]!.querySelector(".pill.risk")!.textContent).toContain(
      "behind main",
    );

    // VIB-139: merged everywhere.
    expect(rows[2]!.querySelector(".pill.done")).not.toBeNull();

    fireEvent.click(rows[1]!);
    expect(onOpenTask).toHaveBeenCalledWith("VIB-151");
  });

  it("zero branches → quiet empty state (spec §7.9b addition)", () => {
    const { container } = render(
      <BranchesPanel branches={[]} onOpenTask={() => {}} />,
    );
    expect(container.querySelectorAll(".live-row").length).toBe(0);
    expect(container.querySelector(".empty")!.textContent).toContain(
      "No execution branches yet",
    );
  });
});

/* --------------------------------------- UI-05 / UI-37 (pass-13 honesty) */

describe("UI-05: a never-compared branch is not 'synced'", () => {
  it("renders the neutral 'not compared' pill for unknown sync state", () => {
    const rows: BranchRowView[] = [
      {
        taskKey: "VIB-1",
        title: "Never reconciled",
        branch: "vib-1",
        pr: null,
        sync: "unknown",
        commitCount: 0,
      },
      {
        taskKey: "VIB-2",
        title: "Measured, up to date",
        branch: "vib-2",
        pr: null,
        sync: "synced",
        commitCount: 1,
      },
    ];
    const { container } = render(
      <BranchesPanel branches={rows} onOpenTask={() => {}} />,
    );
    const pills = [...container.querySelectorAll(".live-row .pill")].map(
      (p) => p.textContent,
    );
    // Before the fix a branch with NO compare data borrowed "behindBy === 0"
    // and rendered the green "synced" pill, contradicting the page's own
    // "Not yet synced" freshness chip.
    expect(pills).toContain("not compared");
    expect(pills).toContain("synced");
  });
});

describe("UI-37: 'Update status' is gated like the action it calls", () => {
  const data = {
    project: {
      slug: "viberr-core",
      name: "Viberr Core",
      repo: "akin-ozer/viberr",
      defaultBranch: "main",
    },
    githubHost: "https://github.com",
    connection: { status: "connected" as const },
    credential: noneCredential,
    prs: [],
    branches: [],
    reconcile: { at: null, label: null, stale: true },
  } as unknown as Parameters<typeof GithubViewPage>[0]["data"];

  const renderPage = (myRole: string | null) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage data={data} myRole={myRole} />
          </ToastProvider>
        ),
      },
    ]);
    return render(<Stub initialEntries={["/projects/viberr-core/github"]} />);
  };

  it("hides it from a viewer (who would get a 403 after fake progress)", () => {
    const { queryByText } = renderPage("viewer");
    expect(queryByText("Update status")).toBeNull();
  });

  it("shows it to a maintainer", () => {
    const { getByText } = renderPage("maintainer");
    expect(getByText("Update status")).toBeTruthy();
  });
});
