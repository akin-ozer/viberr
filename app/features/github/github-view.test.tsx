// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ProjectCredentialHealth } from "~/server/secrets/pat-store.server";
import { CredentialCard } from "./credential-card";
import {
  BranchesPanel,
  PullRequestsPanel,
  RepositoryPanel,
} from "./github-view";
import type { BranchRowView, PrRowView } from "./github-query.server";

afterEach(cleanup);

/* ----------------------------------------------------------- fixtures */

const seededCredential: ProjectCredentialHealth = {
  configured: false,
  source: "policy_display",
  patId: null,
  label: "viberr-bot · fine-grained PAT",
  masked: "github_pat_••••42af",
  lastValidatedAt: null,
  validation: null,
  requiredScopes: ["repo", "workflow", "read:org", "pull_request:write"],
  scopes: [
    { id: "repo", ok: true, source: "unchecked" },
    { id: "workflow", ok: true, source: "unchecked" },
    { id: "read:org", ok: true, source: "unchecked" },
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
  ...seededCredential,
  configured: true,
  source: "pat",
  scopes: seededCredential.scopes.map((s) => ({
    ...s,
    ok: true,
    source: "header" as const,
  })),
};

const noneCredential: ProjectCredentialHealth = {
  ...seededCredential,
  source: "none",
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
      <CredentialCard credential={seededCredential} onOpenTask={onOpenTask} />,
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

  it("renders the warnActions slot inside the banner", () => {
    const { container } = render(
      <CredentialCard
        credential={seededCredential}
        onOpenTask={() => {}}
        warnActions={<button className="btn sm">Grant scope</button>}
      />,
    );
    expect(container.querySelector(".cred-warn .btn")!.textContent).toBe(
      "Grant scope",
    );
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
          credential: seededCredential,
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
    // Footer note is verbatim contract.
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "Merging stays reserved for humans — accepting a completion in the review queue merges its PR.",
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
