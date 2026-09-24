// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ProjectCredentialHealth } from "~/server/secrets/pat-store.server";
import { CredentialCard, CredentialManageActions } from "./credential-card";
import { createRoutesStub } from "react-router";
import { ToastProvider } from "~/ui/toast";
import {
  BranchesPanel,
  GithubViewPage,
  PullRequestsPanel,
  RepositoryPanel,
  type ReconcileCheckView,
} from "./github-view";
import type {
  BranchRowView,
  GithubViewData,
  PrRowView,
} from "./github-query.server";

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
  advisories: [],
};

const healthyCredential: ProjectCredentialHealth = {
  ...violationCredential,
  scopes: violationCredential.scopes.map((s) => ({
    ...s,
    ok: true,
    source: "header" as const,
  })),
};

/** A `workflow` violation GitHub already raised: the advisory the delivery
 *  refusal's remedy points at. */
const workflowAdvisory: ProjectCredentialHealth["advisories"][number] = {
  id: "workflow_scope",
  scope: "workflow",
  source: "violation",
  text: "GitHub refused a push under .github/workflows/ with this token (VIB-142): it lacks the workflow scope. Grant it on GitHub, then use Re-check scopes on the project's GitHub page.",
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

/** A connected project with nothing on the board — the base every whole-page
 *  fixture below patches. `connection` carries the full `checkRepoAccess`
 *  result: the page reads only `status`/`reason`, but a partial one is a
 *  fixture that has drifted from what the loader hands the page. */
function viewData(patch: Partial<GithubViewData> = {}): GithubViewData {
  return {
    project: {
      slug: "viberr-core",
      name: "Viberr Core",
      repo: "akin-ozer/viberr",
      defaultBranch: "main",
    },
    githubHost: "https://github.com",
    connection: {
      status: "connected",
      repo: "akin-ozer/viberr",
      remoteDefaultBranch: "main",
      private: false,
    },
    credential: noneCredential,
    prs: [],
    branches: [],
    reconcile: { at: null, label: null, stale: true },
    ...patch,
  };
}

const prs: PrRowView[] = [
  {
    taskKey: "VIB-142",
    number: 318,
    state: "review",
    title: "Attach execution workspace",
    branch: "vib-142-attach-workspace",
    checks: null,
    checksRead: false,
    review: null,
    // F17-L6: an open PR that conflicts with the base branch.
    mergeable: "conflicting",
  },
  {
    taskKey: "VIB-139",
    number: 298,
    state: "merged",
    title: "Policy split",
    branch: "vib-139-policy-split",
    checks: null,
    checksRead: false,
    review: null,
    mergeable: null,
  },
  {
    taskKey: "VIB-777",
    number: 200,
    state: "closed",
    title: "Abandoned spike",
    branch: "vib-777-spike",
    checks: null,
    checksRead: false,
    review: null,
    mergeable: null,
  },
];

const branches: BranchRowView[] = [
  {
    taskKey: "VIB-142",
    title: "Attach execution workspace to task runtime",
    branch: "vib-142-attach-workspace",
    pr: { number: 318, state: "review", checks: null, review: null, mergeable: "conflicting" },
    sync: "synced",
    commitCount: 3,
    unpushedCommitCount: 0,
  },
  {
    taskKey: "VIB-151",
    title: "Compress long-running task timelines",
    branch: "vib-151-timeline-compression",
    pr: null,
    sync: "behind_main",
    commitCount: 0,
    unpushedCommitCount: 0,
  },
  {
    taskKey: "VIB-139",
    title: "Separate human RBAC from agent capability policy",
    branch: "vib-139-policy-split",
    pr: { number: 298, state: "merged", checks: null, review: null, mergeable: null },
    sync: "merged",
    commitCount: 0,
    unpushedCommitCount: 0,
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
    // "proven", not "granted" — every chip here is header/probe evidence
    // (owner ruling 2026-07-25: chips render proven verdicts only).
    expect(container.querySelector(".cred-ok")!.textContent).toContain(
      "All required scopes proven. Secrets stay isolated from task records and timelines.",
    );
  });

  it("ruling 144(a): an advisory renders as a line, never as a missing chip or a warning", () => {
    // Canary: render the advisory only when the scope is granted (filter it out).
    const { container } = render(
      <CredentialCard
        credential={{
          ...healthyCredential,
          advisories: [{ id: "workflow_scope", scope: "workflow", source: "header", text: "This classic token has no workflow scope, so it cannot push changes under .github/workflows/." }],
        }}
        onOpenTask={() => {}}
      />,
    );
    const line = container.querySelector('[data-advisory="workflow_scope"]');
    expect(line?.textContent).toContain("cannot push changes under .github/workflows/");
    expect(container.querySelector(".cred-warn")).toBeNull();
    expect(container.querySelectorAll(".scope-chip.miss").length).toBe(0);
    const none = render(<CredentialCard credential={healthyCredential} onOpenTask={() => {}} />);
    expect(none.container.querySelector("[data-advisory]")).toBeNull();
  });

  it("assumed scopes render NO chip — the honest 'unproven' line instead", () => {
    const mixed: ProjectCredentialHealth = {
      ...healthyCredential,
      scopes: [
        { id: "repo", ok: true, source: "probe" },
        { id: "workflow", ok: true, source: "assumed" },
      ],
    };
    const { container } = render(
      <CredentialCard credential={mixed} onOpenTask={() => {}} />,
    );
    const chips = [...container.querySelectorAll(".scope-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["repo"]); // the assumed scope is not a chip
    expect(container.querySelector(".scope-chips")!.textContent).toContain(
      "workflow unproven (verified on first use)",
    );
    expect(container.querySelector(".cred-ok")!.textContent).toContain(
      "Every provable scope verified.",
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
      "Scopes not yet verified",
    );
    // writ-6: the sentence names the button by its label.
    expect(container.querySelector(".cred-warn")!.textContent).toContain(
      "Use Re-check scopes to verify them.",
    );
  });

  /**
   * F15-01 (live repro): a fine-grained PAT attached at project creation is
   * validated with `repo: null`, so EVERY chip comes back `assumed` — which
   * dodged the all-"unchecked" test and fell straight through to the green
   * footer. The card affirmed "Every provable scope verified" while proving
   * exactly nothing.
   */
  it("all-assumed scopes are the unverified state, never the green line", () => {
    const assumed: ProjectCredentialHealth = {
      ...healthyCredential,
      scopes: [
        { id: "repo", ok: true, source: "assumed" },
        { id: "pull_request:write", ok: true, source: "assumed" },
      ],
    };
    const { container } = render(
      <CredentialCard credential={assumed} onOpenTask={() => {}} />,
    );
    // Fails on main: `.cred-ok` rendered with the "Every provable scope
    // verified" affirmation and no warn banner at all.
    expect(container.querySelector(".cred-ok")).toBeNull();
    expect(container.textContent).not.toContain("Every provable scope verified");
    const warn = container.querySelector(".cred-warn")!;
    expect(warn.textContent).toContain("Scopes not yet verified");
    expect(warn.textContent).toContain("repo, pull_request:write");
    // No pseudo-chips either — nothing here is evidence.
    expect(container.querySelectorAll(".scope-chip")).toHaveLength(0);
  });

  it("keeps the green line when at least one scope is proven and none miss", () => {
    const mixed: ProjectCredentialHealth = {
      ...healthyCredential,
      scopes: [
        { id: "repo", ok: true, source: "probe" },
        { id: "pull_request:write", ok: true, source: "assumed" },
      ],
    };
    const { container } = render(
      <CredentialCard credential={mixed} onOpenTask={() => {}} />,
    );
    expect(container.querySelector(".cred-ok")!.textContent).toContain(
      "Every provable scope verified.",
    );
  });

  it("renders the warnActions slot inside the banner", () => {
    const { container } = render(
      <CredentialCard
        credential={violationCredential}
        onOpenTask={() => {}}
        warnActions={<button className="btn sm">Re-check scopes</button>}
      />,
    );
    expect(container.querySelector(".cred-warn .btn")!.textContent).toBe(
      "Re-check scopes",
    );
  });

  it("an advisory-only credential keeps the green footer, and the re-check slot with it", () => {
    // `workflow` and `checks:read` are never required scopes, so a card whose
    // only problem is an advisory renders `.cred-ok`, which had no action slot
    // while the advisory said to use Re-check scopes. CANARY: drop the slot
    // from the `.cred-ok` branch.
    const slot = <button className="btn sm">Re-check scopes</button>;
    const advised = render(
      <CredentialCard
        credential={{ ...healthyCredential, advisories: [workflowAdvisory] }}
        onOpenTask={() => {}}
        warnActions={slot}
      />,
    );
    expect(advised.container.querySelector(".cred-warn")).toBeNull();
    expect(advised.container.querySelector(".cred-ok .btn")!.textContent).toBe(
      "Re-check scopes",
    );
    // No advisory, nothing to re-check: the all-good footer stays bare.
    const clean = render(
      <CredentialCard
        credential={healthyCredential}
        onOpenTask={() => {}}
        warnActions={slot}
      />,
    );
    expect(clean.container.querySelector(".cred-ok")).not.toBeNull();
    expect(clean.container.querySelector(".cred-ok .btn")).toBeNull();
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
        inFlight={null}
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
        inFlight={null}
        onSet={onSet}
        onClear={onClear}
      />,
    );
    fireEvent.click(bound.getByText("Rotate credential"));
    expect(onSet).toHaveBeenCalledTimes(2);
    // Ruling 149: the destructive half of this row wears the danger label, the
    // rotate/attach half stays neutral. Canary: drop `danger` from the Remove
    // className in `credential-card.tsx`.
    expect(
      Array.from(bound.getByText("Remove credential").closest("button")!.classList),
    ).toContain("danger");
    expect(
      Array.from(bound.getByText("Rotate credential").closest("button")!.classList),
    ).not.toContain("danger");
    // Remove is gated by the confirm dialog.
    fireEvent.click(bound.getByText("Remove credential"));
    expect(onClear).not.toHaveBeenCalled();
    // Ruling 458(f): the shared ConfirmDialog, named by its title.
    expect(
      bound
        .getByRole("alertdialog", { name: "Remove this credential?" })
        .getAttribute("data-screen-label"),
    ).toBe("Credential removal dialog");
    fireEvent.click(
      bound.getByText("Remove credential", {
        selector: ".confirm-actions button.btn.danger",
      }),
    );
    expect(onClear).toHaveBeenCalled();
  });

  it("renders nothing when the viewer can't manage credentials", () => {
    const { container } = render(
      <CredentialManageActions
        configured
        canManage={false}
        inFlight={null}
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
        canSeeCredential
      />,
    );
    const rows = container.querySelectorAll(".kv-row");
    expect(rows.length).toBe(3);
    expect(rows[0]!.textContent).toContain("akin-ozer/viberr");
    // Degraded: the pill must NOT claim connected (spec §7.9c).
    expect(rows[1]!.querySelector(".pill")!.textContent).toContain(
      "no credential",
    );
    // P13-D-5: this row hardcoded "task-level override allowed" — a capability
    // nothing implemented, asserted regardless of the (now deleted) toggle.
    expect(rows[2]!.textContent).toContain("every task uses this repository");
    expect(container.textContent).not.toContain("override");
  });

  it("says an unset repository in words, not a dash (ruling 148)", () => {
    const { container } = render(
      <RepositoryPanel
        data={{
          project: {
            slug: "viberr-core",
            name: "Viberr Core",
            repo: null,
            defaultBranch: "main",
          },
          connection: { status: "no_repo_configured" },
          credential: noneCredential,
        }}
        onOpenTask={() => {}}
        canSeeCredential
      />,
    );
    const rows = container.querySelectorAll(".kv-row");
    // The same word the identical row on the settings page uses, and NOT the
    // Connection pill's "no repository" one line below (ruling 14: one fact,
    // one wording, said once).
    expect(rows[0]!.textContent).toContain("not set");
    expect(rows[0]!.textContent).not.toContain("−");
    expect(rows[1]!.querySelector(".pill")!.textContent).toContain(
      "no repository",
    );
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
        canSeeCredential
      />,
    );
    expect(
      container.querySelectorAll(".kv-row")[1]!.querySelector(".pill.ready"),
    ).not.toBeNull();
  });

  /**
   * R19-11 (owner ruling, Q-V1 PAT half) — the credential card is WITHDRAWN
   * from a reader without the `grant-github-scope` grant, not disabled (ruling
   * 37: a withdrawn affordance is honest, a disabled one invites a support
   * question). The panel must still answer "is this repository connected?",
   * which is legitimate context for reading the board — so the Connection row
   * stays and a lock note explains the gap. A blank space under the kv rows
   * would be its own defect.
   */
  it("withdraws the credential card from a reader without the grant, keeping the connection facts", () => {
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
          credential: violationCredential,
        }}
        onOpenTask={() => {}}
        canSeeCredential={false}
        warnActions={<button className="btn sm">Fix in Settings</button>}
        manageActions={<div className="cred-manage">manage</div>}
      />,
    );
    // The card and every credential fact on it: gone.
    expect(container.querySelector(".cred-card")).toBeNull();
    expect(container.textContent).not.toContain("github_pat_••••42af");
    expect(container.textContent).not.toContain("viberr-bot");
    expect(container.querySelectorAll(".scope-chip")).toHaveLength(0);
    expect(container.querySelector(".cred-warn")).toBeNull();
    expect(container.querySelector(".cred-ok")).toBeNull();
    // The card owns both action slots, so neither leaks out of the withdrawal.
    expect(container.querySelector(".cred-manage")).toBeNull();
    expect(container.textContent).not.toContain("Fix in Settings");
    // …but the panel still answers the question a reader of the board has.
    const rows = container.querySelectorAll(".kv-row");
    expect(rows[0]!.textContent).toContain("akin-ozer/viberr");
    expect(rows[1]!.querySelector(".pill.ready")!.textContent).toContain(
      "connected",
    );
    // …and says why the rest is missing, naming the grant that carries it.
    const note = container.querySelector(".pol-note")!;
    expect(note.textContent).toContain(
      "Credential details need the Manage the GitHub credential grant (project admin or maintainer).",
    );
    expect(note.textContent).toContain(
      "The Connection row above still shows whether this repository is reachable.",
    );
  });

  /**
   * G8's probe note names the card ("the stored project credential is shown
   * below"). With the card withdrawn there is nothing below, so the note must
   * go with it — a sentence pointing at an absent surface is worse than none.
   */
  it("drops the probe note with the card it points at", () => {
    const degraded = {
      project: {
        slug: "viberr-core",
        name: "Viberr Core",
        repo: "akin-ozer/viberr",
        defaultBranch: "main",
      },
      // Degraded probe + a stored PAT = exactly the divergence G8 explains.
      connection: { status: "repo_not_found" as const, repo: "akin-ozer/viberr" },
      credential: violationCredential,
    };
    const holder = render(
      <RepositoryPanel data={degraded} onOpenTask={() => {}} canSeeCredential />,
    );
    expect(holder.container.querySelector(".probe-note")).not.toBeNull();
    cleanup();

    const reader = render(
      <RepositoryPanel
        data={degraded}
        onOpenTask={() => {}}
        canSeeCredential={false}
      />,
    );
    expect(reader.container.querySelector(".probe-note")).toBeNull();
    // The pill itself — the honest degraded fact — still renders.
    expect(
      reader.container.querySelectorAll(".kv-row")[1]!.textContent,
    ).toContain("repo not found");
  });
});

/* -------------------------------------------------------------- PR panel */

describe("PullRequestsPanel", () => {
  it("ruling 360: a refused check-runs read renders as 'checks not readable', not as nothing", () => {
    // CANARY: drop the `checksUnread` arm in the PR list.
    const refused = {
      ...prs[0]!,
      checks: null,
      checksRead: false,
      checksUnread: {
        status: 403,
        message: "Resource not accessible by personal access token",
        at: "2026-09-18T08:00:00.000Z",
      },
    };
    const { container } = render(
      <PullRequestsPanel prs={[refused]} defaultBranch="main" onOpenTask={() => {}} />,
    );
    expect(container.querySelector(".rq-row")!.textContent).toContain("checks not readable");
  });

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
    expect(rows[0]!.textContent).toContain("in review");
    expect(rows[1]!.querySelector(".pill.done")!.textContent).toContain(
      "merged",
    );
    expect(rows[0]!.textContent).not.toContain("checks not readable");
    // Ruling 12: closed-unmerged renders the risk pill.
    expect(rows[2]!.querySelector(".pill.risk")!.textContent).toContain(
      "closed",
    );
    // F17-L6: the conflicting open PR surfaces a risk "conflicts" pill so a
    // human sees it cannot be merged, right where they decide to accept.
    expect(rows[0]!.querySelector(".pill.risk")!.textContent).toContain(
      "conflicts",
    );
    // A merged / clean PR shows no conflict pill.
    expect(rows[1]!.textContent).not.toContain("conflicts");
    fireEvent.click(rows[0]!);
    expect(onOpenTask).toHaveBeenCalledWith("VIB-142");
    // Footer note is verbatim contract (B10: honest about the offline path).
    // F19-34: it used to say "in the review queue". The queue is a read-only
    // triage list — it performs no mutation at all, which is exactly why ruling
    // 30 (R15-11) labels its row "Review" and not "Accept". Naming it as the
    // surface that merges pointed a reader at a page with no such control.
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "Merging stays reserved for humans. Accepting a completion on its task page merges its PR when GitHub is reachable; otherwise it records accepted (merge pending).",
    );
    expect(container.querySelector(".pol-note")!.textContent).not.toContain(
      "review queue",
    );
  });

  /* F19-33: the count and the note took their type scale and spacing from two
     private inline-style consts (`PANEL_COUNT_STYLE`, `POL_NOTE_STYLE`) that
     copied `.fine` and `.pol-note.after`/`.last` — and had drifted from them.
     app.css.test.ts holds the structural gate; these assert what the surface
     actually renders. */
  it("takes the count's type scale and the note's spacing from the sheet", () => {
    const { container } = render(
      <PullRequestsPanel prs={prs} defaultBranch="main" onOpenTask={() => {}} />,
    );
    const count = container.querySelector(".panel-head .right")!;
    expect(count.className.split(/\s+/)).toEqual(["right", "sub", "fine"]);
    expect(count.getAttribute("style")).toBeNull();
    const note = container.querySelector(".pol-note")!;
    expect(note.className.split(/\s+/)).toEqual(["pol-note", "after", "last"]);
    expect(note.getAttribute("style")).toBeNull();
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
    // colo-12: the branch name is a plain `.trace` (secondary ink); the Sync
    // pill carries the state.
    const trace = rows[0]!.querySelector(".live-branch .trace")!;
    expect(trace.textContent).toBe("vib-142-attach-workspace");
    expect(trace.classList.contains("ok")).toBe(false);
    expect(rows[0]!.textContent).toContain("3 commits");
    expect(rows[0]!.textContent).toContain("#318");
    expect(rows[0]!.querySelector(".pill.ready")!.textContent).toContain(
      "synced",
    );
    // F17-L6: VIB-142's open PR conflicts — the branch row surfaces it too, so
    // a rebase-needed branch is visible in the execution-branches table.
    expect(rows[0]!.textContent).toContain("conflicts");
    // A merged branch row shows no conflict pill.
    expect(rows[2]!.textContent).not.toContain("conflicts");

    // VIB-151: no PR → the fact in words, not a "−" that reads as a control
    // inside the row button; behind main risk pill.
    expect(rows[1]!.textContent).toContain("no PR");
    expect(rows[1]!.textContent).not.toContain("−");
    expect(rows[1]!.querySelector(".pill.risk")!.textContent).toContain(
      "behind main",
    );

    // VIB-139: merged everywhere.
    expect(rows[2]!.querySelector(".pill.done")).not.toBeNull();

    fireEvent.click(rows[1]!);
    expect(onOpenTask).toHaveBeenCalledWith("VIB-151");
  });

  /**
   * F20-23: a closed-not-merged (or merge-pending) PR rendered a bare `#162` in
   * the PR column — only a colour tint, no state word — so a reader scanning
   * the branch table could not tell the delivery had been rejected. The state
   * word now rides in the pill, the way the PR list above shows it. A merged
   * row stays bare here (the Sync column already says "merged"); an open
   * "in review" PR stays bare too (the common state, kept uncluttered).
   */
  it("F20-23: a closed PR shows the 'closed' state word; a merged one stays bare", () => {
    const rows: BranchRowView[] = [
      {
        taskKey: "VIB-8",
        title: "Abandoned probe",
        branch: "vib-8-probe",
        pr: { number: 162, state: "closed", checks: null, review: null, mergeable: null },
        sync: "unknown",
        commitCount: 1,
        unpushedCommitCount: 0,
      },
      {
        taskKey: "VIB-9",
        title: "Merged work",
        branch: "vib-9-merged",
        pr: { number: 170, state: "merged", checks: null, review: null, mergeable: null },
        sync: "merged",
        commitCount: 0,
        unpushedCommitCount: 0,
      },
    ];
    const { container } = render(
      <BranchesPanel branches={rows} onOpenTask={() => {}} />,
    );
    const liveRows = container.querySelectorAll(".live-row");
    // The closed row: the PR pill names the rejection, not just the number.
    const closedPill = [...liveRows[0]!.querySelectorAll(".pill")].find((p) =>
      p.textContent?.includes("#162"),
    )!;
    expect(closedPill.textContent).toContain("closed");
    expect(closedPill.classList.contains("risk")).toBe(true);
    // The merged row's PR pill stays bare (#170 only) — the "merged" word lives
    // in the Sync column, so the narrow PR column is not doubled up.
    const mergedPrPill = [...liveRows[1]!.querySelectorAll(".pill")].find((p) =>
      p.textContent?.includes("#170"),
    )!;
    expect(mergedPrPill.textContent).not.toContain("merged");
    // …and the Sync column still carries the merged fact.
    expect(liveRows[1]!.textContent).toContain("merged");
  });

  it("takes the count's type scale and the note's spacing from the sheet (F19-33)", () => {
    const { container } = render(
      <BranchesPanel branches={branches} onOpenTask={() => {}} />,
    );
    const count = container.querySelector(".panel-head .right")!;
    expect(count.className.split(/\s+/)).toEqual(["right", "sub", "fine"]);
    expect(count.getAttribute("style")).toBeNull();
    const note = container.querySelector(".pol-note")!;
    expect(note.className.split(/\s+/)).toEqual(["pol-note", "after", "last"]);
    expect(note.getAttribute("style")).toBeNull();
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
        unpushedCommitCount: 0,
      },
      {
        taskKey: "VIB-2",
        title: "Measured, up to date",
        branch: "vib-2",
        pr: null,
        sync: "synced",
        commitCount: 1,
        unpushedCommitCount: 0,
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
    // "Not synced yet" freshness chip.
    expect(pills).toContain("not compared");
    expect(pills).toContain("synced");
  });
});

describe("UI-37: 'Update status' is gated like the action it calls", () => {
  const data = viewData();

  const renderPage = (myRole: string | null) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={data}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole={myRole}
            />
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

/**
 * R19-11 (owner ruling, Q-V1 PAT half) — "a read-only Viewer must not see the
 * Danger zone or the PAT". The Danger-zone half shipped in pass 18
 * (`settings-page.tsx`, gated on `edit-policy`); the PAT half did not, so every
 * project member — a viewer included — read the token's label, its masked tail
 * and its scope verdicts off this page.
 *
 * The gate is the SERVER's, not a fresh rule: `grant-github-scope` is the
 * ACTION_ROLES entry `routes/project.github.tsx` enforces on grant-scope,
 * set-credential and clear-credential alike, and it resolves to admin|maintainer
 * — so a contributor is below the bar for the same reason a viewer is. Mirroring
 * the action id through `roleCan` (never a role literal) is what keeps the
 * display and the enforcement bound; the loader redacts the payload on the same
 * rule, so the tail is absent from the HTML too, not merely unrendered.
 */
describe("R19-11: the credential card is disclosed only to the roles that may change it", () => {
  const renderPage = (myRole: string | null) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              // A real bound PAT — the state that has something to disclose.
              data={viewData({ credential: violationCredential })}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole={myRole}
            />
          </ToastProvider>
        ),
      },
    ]);
    return render(<Stub initialEntries={["/projects/viberr-core/github"]} />);
  };

  it("withholds it from a viewer — no tail, no label, no scope verdicts", () => {
    const { container } = renderPage("viewer");
    expect(container.querySelector(".cred-card")).toBeNull();
    expect(container.textContent).not.toContain("github_pat_••••42af");
    expect(container.textContent).not.toContain("viberr-bot");
    expect(container.textContent).not.toContain("pull_request:write");
    // The viewer is told why, and still learns the repository is connected.
    expect(container.textContent).toContain(
      "Credential details need the Manage the GitHub credential grant",
    );
    expect(container.querySelector(".kv-row .pill.ready")!.textContent).toContain(
      "connected",
    );
  });

  it("withholds it from a contributor too — the grant is maintainer+", () => {
    const { container } = renderPage("contributor");
    expect(container.querySelector(".cred-card")).toBeNull();
    expect(container.textContent).not.toContain("github_pat_••••42af");
    expect(container.textContent).toContain(
      "Credential details need the Manage the GitHub credential grant",
    );
  });

  it("discloses it to a maintainer, with the controls that action authorizes", () => {
    const { container } = renderPage("maintainer");
    expect(container.querySelector(".cred-card")).not.toBeNull();
    expect(container.querySelector(".cred-name")!.textContent).toBe(
      "viberr-bot · fine-grained PAT",
    );
    expect(container.textContent).toContain("github_pat_••••42af");
    expect(container.querySelectorAll(".scope-chip").length).toBe(4);
    // Same grant, so the card's own actions come with it. writ-6: the button
    // re-checks scopes (Viberr cannot grant one), and its label says so.
    expect(container.textContent).toContain("Re-check scopes");
    expect(container.textContent).not.toContain("Grant scope");
    expect(container.querySelector(".cred-manage")).not.toBeNull();
    expect(container.textContent).toContain("Rotate credential");
    // The withheld-note is the viewer's line, not a second permanent fixture.
    expect(container.textContent).not.toContain(
      "Credential details need the Manage the GitHub credential grant",
    );
  });

  it("discloses it to an admin (incl. the D2 org-admin override, which resolves to admin)", () => {
    const { container } = renderPage("admin");
    expect(container.querySelector(".cred-card")).not.toBeNull();
    expect(container.textContent).toContain("github_pat_••••42af");
  });

  it("withholds it from a non-member role value, never defaulting open", () => {
    // `myRole` is null for a reader the layout could not place (and `roleCan`
    // answers false for null by construction). Failing open here would be the
    // whole finding again, so it is pinned.
    const { container } = renderPage(null);
    expect(container.querySelector(".cred-card")).toBeNull();
    expect(container.textContent).not.toContain("github_pat_••••42af");
  });
});

/**
 * The delivery refusal's remedy says "Grant the `workflow` scope on GitHub,
 * then use Re-check on the project's GitHub view", and the pre-push check reads
 * the cached header scopes. The card that remedy lands on is the green one (no
 * required scope is missing), so the re-check has to be there or the only way
 * out is rotating the credential.
 */
describe("an advisory's re-check is reachable from the green footer", () => {
  it("a maintainer re-checks the credential from the card whose only problem is an advisory", async () => {
    const intents: string[] = [];
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        action: async ({ request }) => {
          intents.push(String((await request.formData()).get("intent")));
          return { ok: true as const, toast: "Re-checked." };
        },
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={viewData({
                credential: { ...healthyCredential, advisories: [workflowAdvisory] },
              })}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole="maintainer"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/github"]} />,
    );
    expect(container.querySelector(".cred-warn")).toBeNull();
    const recheck = container.querySelector<HTMLButtonElement>(
      `.cred-ok button[title="Re-check the credential's scopes against GitHub"]`,
    );
    expect(recheck, "the re-check must sit in the green footer").not.toBeNull();
    expect(recheck!.textContent).toBe("Re-check scopes");
    fireEvent.click(recheck!);
    await waitFor(() => expect(intents).toEqual(["grant-scope"]));
  });
});

/**
 * The pre-F19-22 world in one value: no completed reconcile pass on record, so
 * the chip has nothing but the CHANGE timestamp to reason from and the R17-5
 * rules below decide the tone. Every block that predates the audit read keeps
 * asserting against exactly that fallback.
 */
const NO_CHECK_ON_RECORD: ReconcileCheckView = {
  at: null,
  label: null,
  stale: true,
};

describe("R17-5: never-synced is neutral, only a stale cache warns", () => {
  const renderChip = (reconcile: {
    at: string | null;
    label: string | null;
    stale: boolean;
  }) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={viewData({ reconcile })}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole="maintainer"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/github"]} />,
    );
    return container.querySelector(".gh-freshness")!;
  };

  it("renders an empty-provenance surface neutral with a nudge to check now", () => {
    // A brand-new project's first look at this page used to be a coral alert
    // ("Not yet synced") though nothing was wrong — no sync had simply run.
    const chip = renderChip({ at: null, label: null, stale: true });
    expect(chip.classList.contains("stale")).toBe(false);
    // F19-22: the copy used to be "Not synced yet" / "runs the first sync" — a
    // claim `at: null` cannot support, because DG-3 skips the provenance row on
    // every unchanged poller tick. A project with one branched task and a quiet
    // repo lands here after a hundred successful passes.
    expect(chip.textContent).toContain("No changes recorded");
    expect(chip.textContent).not.toContain("Not synced yet");
    expect(chip.getAttribute("title")).toContain("Update status checks GitHub now");
  });

  it("keeps the warn tone for a cache older than the staleness threshold", () => {
    const chip = renderChip({
      at: "2026-08-04T00:00:00.000Z",
      label: "2h ago",
      stale: true,
    });
    expect(chip.classList.contains("stale")).toBe(true);
    expect(chip.textContent).toContain("Last change 2h ago");
  });

  it("carries its title's explanation as text for assistive tech (interface review 2026-09-24, acce-5)", () => {
    // The stale warning's "the branch and PR state below may be out of date"
    // lived only in a hover title, which touch and screen-reader users never get.
    const chip = renderChip({
      at: "2026-08-04T00:00:00.000Z",
      label: "2h ago",
      stale: true,
    });
    expect(chip.querySelector(".vh")!.textContent).toBe(` · ${chip.getAttribute("title")}`);
  });

  it("renders a fresh cache neutral", () => {
    const chip = renderChip({
      at: "2026-08-04T00:00:00.000Z",
      label: "3m ago",
      stale: false,
    });
    expect(chip.classList.contains("stale")).toBe(false);
    expect(chip.textContent).toContain("Last change 3m ago");
  });
});

/**
 * F19-22 — the freshness cue reported the last CHANGING reconcile as though it
 * were the last successful one.
 *
 * `data.reconcile.at` is `MAX(observed_at)` over `github.reconcile` provenance,
 * and the reconciler deliberately skips that row on an unchanged poller tick
 * (DG-3, `github-reconciler.server.ts`: `if (changed ||
 * !ctx.skipUnchangedProvenance)`), so a repository nothing is happening in has
 * no fresh row however many passes succeed. Labelled "Updated 2h ago" over a
 * tooltip promising a refresh "every 5 minutes", the chip contradicted itself —
 * live-proven on the task panel ("Synced 1h ago" at 12:42Z with successful
 * `github.reconcile.task` audit rows at 12:07/12:12/…/12:42).
 *
 * DG-3 stays. What this file owns is the NAME of the number it renders.
 */
describe("F19-22: the freshness chip names the last CHANGE, not the last check", () => {
  const chip = (reconcile: {
    at: string | null;
    label: string | null;
    stale: boolean;
  }) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={viewData({ reconcile })}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole="maintainer"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/github"]} />,
    );
    return container.querySelector(".gh-freshness")!;
  };

  it("never says 'Updated' of a timestamp that only moves when something changed", () => {
    const fresh = chip({
      at: "2026-08-06T12:01:55.000Z",
      label: "40m ago",
      stale: false,
    });
    expect(fresh.textContent).toContain("Last change 40m ago");
    expect(fresh.textContent).not.toContain("Updated");
  });

  it("tells the reader that a pass finding nothing new records nothing", () => {
    // The old tooltip asserted the opposite of the code ("auto-refreshes every
    // 5 minutes" next to an hours-old number), which is exactly how a healthy
    // task looked broken.
    for (const stale of [false, true]) {
      const title =
        chip({
          at: "2026-08-06T12:01:55.000Z",
          label: stale ? "3h ago" : "4m ago",
          stale,
        }).getAttribute("title") ?? "";
      expect(title).toContain("every 5 minutes");
      expect(title).toContain("records nothing on a pass that finds nothing new");
      expect(title).not.toContain("auto-refreshes every 5 minutes — click");
      cleanup();
    }
  });
});

/**
 * F19-22, second half — the chip can finally say the poller is alive.
 *
 * `reconcileCheck` is the newest COMPLETED pass (`github.reconcile.task` audit
 * rows, unioned with the human sweep's project row — see
 * `server/audit/audit-query.server.ts`, whose test proves the two clocks
 * diverge against the real reconciler). Rendering it beside the change makes
 * the healthy-but-quiet case ("Checked 2m ago · last change 40m ago")
 * distinguishable from the case that actually needs attention — a poller or a
 * credential that stopped working — which the single-number chip could not
 * express at all.
 */
describe("F19-22: the chip renders the last CHECK beside the last change", () => {
  const chip = (
    reconcile: { at: string | null; label: string | null; stale: boolean },
    reconcileCheck: ReconcileCheckView,
  ) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={viewData({ reconcile })}
              reconcileCheck={reconcileCheck}
              myRole="maintainer"
            />
          </ToastProvider>
        ),
      },
    ]);
    const { container } = render(
      <Stub initialEntries={["/projects/viberr-core/github"]} />,
    );
    return container.querySelector(".gh-freshness")!;
  };

  it("names both facts, and never lets the older one look like the check", () => {
    // The live case: seven successful passes in the hour, one change at the
    // start of it. The chip used to render only "40m ago".
    const c = chip(
      { at: "2026-08-06T12:01:55.000Z", label: "40m ago", stale: false },
      { at: "2026-08-06T12:42:00.000Z", label: "2m ago", stale: false },
    );
    expect(c.textContent).toContain("Checked 2m ago");
    expect(c.textContent).toContain("last change 40m ago");
    expect(c.classList.contains("stale")).toBe(false);
  });

  it("stays neutral on a fresh check whose last change is HOURS old", () => {
    // The whole finding: a quiet repository is not a broken one. `stale: true`
    // on the change must no longer paint the coral alert once a completed pass
    // 2 minutes ago proves the poller is working.
    const c = chip(
      { at: "2026-08-05T09:00:00.000Z", label: "yesterday", stale: true },
      { at: "2026-08-06T12:42:00.000Z", label: "2m ago", stale: false },
    );
    expect(c.classList.contains("stale")).toBe(false);
    expect(c.textContent).toContain("Checked 2m ago");
    expect(c.textContent).toContain("last change yesterday");
    expect(c.getAttribute("title")).toContain("a quiet repository");
  });

  it("warns when no pass has COMPLETED for over an hour, however fresh the change", () => {
    // The case the old chip could not see at all: the poller (or the PAT) is
    // down. A change recorded 4 minutes ago by the last pass before it died
    // used to render neutral "Updated 4m ago".
    const c = chip(
      { at: "2026-08-06T12:38:00.000Z", label: "4m ago", stale: false },
      { at: "2026-08-06T09:10:00.000Z", label: "3h ago", stale: true },
    );
    expect(c.classList.contains("stale")).toBe(true);
    expect(c.textContent).toContain("Checked 3h ago");
    expect(c.getAttribute("title")).toContain(
      "No reconcile pass has completed for over an hour",
    );
  });

  it("is honest about a checked project that has never recorded a change", () => {
    const c = chip(
      { at: null, label: null, stale: true },
      { at: "2026-08-06T12:42:00.000Z", label: "2m ago", stale: false },
    );
    expect(c.textContent).toContain("Checked 2m ago");
    expect(c.textContent).toContain("no changes recorded");
    // Nothing is wrong here — a checked project with a quiet repo (ruling 46).
    expect(c.classList.contains("stale")).toBe(false);
  });

  it("falls back to the change cue when no pass is on record, and never warns about a never-checked project", () => {
    const neither = chip(
      { at: null, label: null, stale: true },
      NO_CHECK_ON_RECORD,
    );
    expect(neither.textContent).toContain("No changes recorded");
    expect(neither.textContent).not.toContain("Checked");
    expect(neither.classList.contains("stale")).toBe(false);
    cleanup();

    // A change with no audit row behind it (rows aged past the 90-day audit
    // window, or a heartbeat pass over a board with no branched task): the
    // change is the only evidence a pass ran, so it decides the tone.
    const changeOnly = chip(
      { at: "2026-08-06T12:38:00.000Z", label: "4m ago", stale: false },
      NO_CHECK_ON_RECORD,
    );
    expect(changeOnly.textContent).toContain("Last change 4m ago");
    expect(changeOnly.classList.contains("stale")).toBe(false);
  });
});

/**
 * Ruling 368 (and 147(a)): a request shows itself in flight on the button that
 * started it. Update status, Re-check scopes and the credential row used to go
 * `disabled` for the whole wait with their resting glyph and label, so they
 * painted the .45 refused step with a not-allowed cursor and said nothing. Now
 * the starter carries `aria-busy` (the sheet's .7 busy step), the loader spins
 * where its glyph was, and the label names the work; the sibling that merely
 * waits stays at the disabled step and claims nothing.
 *
 * Canary: drop `aria-busy` from Update status in `github-view.tsx` and the first
 * test fails; pass `inFlight={null}` to `CredentialManageActions` there and the
 * credential test does.
 */
describe("ruling 368: the GitHub page's requests in flight", () => {
  /** An action the TEST answers, when it decides to. */
  function heldAction() {
    let answer: (reply: { ok: true; toast: string }) => void = () => {};
    const reply = new Promise<{ ok: true; toast: string }>((resolve) => {
      answer = resolve;
    });
    return { action: () => reply, answer: () => answer({ ok: true, toast: "Done" }) };
  }
  const renderHeld = (action: () => Promise<{ ok: true; toast: string }>) => {
    const Stub = createRoutesStub([
      {
        path: "/projects/:slug/github",
        Component: () => (
          <ToastProvider>
            <GithubViewPage
              data={viewData({ credential: violationCredential })}
              reconcileCheck={NO_CHECK_ON_RECORD}
              myRole="maintainer"
            />
          </ToastProvider>
        ),
        action,
      },
    ]);
    return render(<Stub initialEntries={["/projects/viberr-core/github"]} />);
  };
  const button = (c: HTMLElement, text: string) =>
    [...c.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes(text),
    )!;

  it("Update status says it is updating while Re-check scopes only waits", async () => {
    const held = heldAction();
    const { container } = renderHeld(held.action);
    fireEvent.click(button(container, "Update status"));
    await waitFor(() =>
      expect(button(container, "Updating…").getAttribute("aria-busy")).toBe("true"),
    );
    const update = button(container, "Updating…");
    expect(update.disabled).toBe(true);
    // Ruling 459: the loader is always drawn in the glyph's cell (GlyphSwap),
    // so "spinning" is the cell having traded the resting glyph for it.
    expect(update.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    const recheck = button(container, "Re-check scopes");
    expect(recheck.disabled).toBe(true);
    expect(recheck.hasAttribute("aria-busy")).toBe(false);
    expect(recheck.querySelector(".copy-glyph[data-copied]")).toBeNull();

    held.answer();
    await waitFor(() => expect(button(container, "Update status")).toBeTruthy());
    expect(button(container, "Update status").hasAttribute("aria-busy")).toBe(false);
  });

  it("Re-check scopes says it is checking while Update status only waits", async () => {
    const held = heldAction();
    const { container } = renderHeld(held.action);
    fireEvent.click(button(container, "Re-check scopes"));
    await waitFor(() =>
      expect(button(container, "Checking…").getAttribute("aria-busy")).toBe("true"),
    );
    expect(button(container, "Checking…").querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
    const update = button(container, "Update status");
    expect(update.disabled).toBe(true);
    expect(update.hasAttribute("aria-busy")).toBe(false);
  });

  it("a rotation says it is rotating while Remove only waits", async () => {
    const held = heldAction();
    const { container } = renderHeld(held.action);
    fireEvent.click(button(container, "Rotate credential"));
    await waitFor(() =>
      expect(button(container, "Rotating…").getAttribute("aria-busy")).toBe("true"),
    );
    const remove = button(container, "Remove credential");
    expect(remove.disabled).toBe(true);
    expect(remove.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("ruling 368: CredentialManageActions names the request in flight", () => {
  const renderRow = (configured: boolean, inFlight: string | null) =>
    render(
      <CredentialManageActions
        configured={configured}
        canManage
        inFlight={inFlight}
        onSet={() => {}}
        onClear={() => {}}
      />,
    ).container;

  it("an attach in flight: Attaching…, busy, the loader spinning", () => {
    const c = renderRow(false, "set-credential");
    const attach = c.querySelector<HTMLButtonElement>("button")!;
    expect(attach.textContent).toBe("Attaching…");
    expect(attach.getAttribute("aria-busy")).toBe("true");
    expect(attach.disabled).toBe(true);
    expect(attach.querySelector(".copy-glyph[data-copied] > svg.ico.spin")).not.toBeNull();
  });

  it("a removal in flight: Removing… on Remove, Rotate only waits", () => {
    const c = renderRow(true, "clear-credential");
    const [rotate, remove] = [...c.querySelectorAll<HTMLButtonElement>("button")];
    expect(remove!.textContent).toBe("Removing…");
    expect(remove!.getAttribute("aria-busy")).toBe("true");
    expect(rotate!.textContent).toBe("Rotate credential");
    expect(rotate!.disabled).toBe(true);
    expect(rotate!.hasAttribute("aria-busy")).toBe(false);
  });

  it("at rest: no busy mark anywhere", () => {
    const c = renderRow(true, null);
    for (const b of c.querySelectorAll<HTMLButtonElement>("button")) {
      expect(b.hasAttribute("aria-busy")).toBe(false);
      expect(b.disabled).toBe(false);
    }
  });
});
