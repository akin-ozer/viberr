// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { describeRevisionDrift } from "~/shared/revision-drift";
import { cleanup, render } from "@testing-library/react";
import { AcceptConfirm, type AcceptConfirmTask } from "./accept-confirm";
import type { AcceptanceDisclosure } from "~/shared/acceptance-disclosure";

afterEach(cleanup);

/**
 * The acceptance dialog's copy, tested where it is written rather than through
 * the page — these are sentences the human reads immediately before a one-way
 * merge, and two of them asserted things that were not true of the task in hand.
 */

const STAGES = [
  { id: "triage", name: "Triage", color: "#a5a8b5" },
  { id: "review", name: "Review", color: "#5b76fe" },
  { id: "done", name: "Done", color: "#00b473" },
];

function detail(patch: Partial<AcceptConfirmTask> = {}): AcceptConfirmTask {
  return {
    key: "VIB-151",
    title: "Confirm the smoke suite still passes",
    stage: "review",
    validation: "healthy",
    branch: "vib-151",
    pr: null,
    stages: STAGES,
    ...patch,
  };
}

function open(props: {
  task?: Partial<AcceptConfirmTask>;
  noChanges?: boolean;
  workRevisionSha?: string | null;
}): string {
  const { container } = render(
    <AcceptConfirm
      task={detail(props.task ?? {})}
      workRevisionSha={props.workRevisionSha ?? null}
      noChanges={props.noChanges ?? false}
      defaultBranch="main"
      ceremony={{ mode: "accept" }}
      blockedReason={null}
      busy={false}
      onCancel={() => {}}
      onConfirm={() => {}}
    />,
  );
  return (
    container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )?.textContent ?? ""
  );
}

/**
 * F19-21 opened a SECOND no-change shape — a verification-only task that never
 * branched at all — and this row kept asserting the FIRST one's cause at both:
 * "The branch is empty, so there is no pull request to merge." On the F19-21
 * shape there is no branch to be empty, said on the dialog that authorizes the
 * close. (Same copy class as F19-23, one dialog over.)
 */
describe("F32-11 (pass 32): the ceremony names the open decision it withdraws", () => {
  function withPacket(title: string | null, force = false): string {
    const { container } = render(
      <AcceptConfirm
        task={detail({ stage: force ? "triage" : "review" })}
        workRevisionSha={null}
        noChanges={false}
        defaultBranch="main"
        ceremony={{ mode: force ? "force" : "accept" }}
        atBoundary={!force}
        blockedReason={force ? "An open blocked decision is holding this task." : null}
        openPacketTitle={title}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    // Two dialogs render in one test; read the one THIS call mounted.
    const dialogs = container.ownerDocument.querySelectorAll(
      'dialog[data-screen-label="Accept completion dialog"]',
    );
    return dialogs[dialogs.length - 1]?.textContent ?? "";
  }

  it("renders a Withdraws row naming the packet, on accept and on force-accept", () => {
    // Live (VIB-3): force-accepting at Triage cleared the open decision with
    // no word anywhere — the ceremony listed MERGES/REVISION/VERDICT/SKIPS/
    // BYPASSING and never the question that died. Canary: drop the
    // `openPacketTitle` row from AcceptConfirm.
    const accept = withPacket("Which environment should the smoke suite target?");
    expect(accept).toContain("Withdraws");
    expect(accept).toContain("Which environment should the smoke suite target?");
    expect(accept).toContain("closes unanswered");
    const force = withPacket("Which environment should the smoke suite target?", true);
    expect(force).toContain("Withdraws");
    expect(force).toContain("Bypassing");
  });

  it("shows NO Withdraws row when there is no open decision", () => {
    expect(withPacket(null)).not.toContain("Withdraws");
  });
});

describe("the no-change row states what is true of THIS task", () => {
  it("names the empty branch when there is one (the R17-2/F17-L9 shape)", () => {
    const text = open({ noChanges: true, task: { branch: "vib-151" } });
    expect(text).toContain("completed with no changes");
    expect(text).toContain("vib-151 carries no commits");
    expect(text).toContain("no pull request was opened");
  });

  it("claims NO branch when the task never opened one (the F19-21 shape)", () => {
    const text = open({ noChanges: true, task: { branch: null } });
    expect(text).toContain("completed with no changes");
    expect(text).toContain("VIB-151 never opened a branch or a pull request");
    // The false sentence, in either of its readings.
    expect(text).not.toContain("branch is empty");
    expect(text).not.toContain("carries no commits");
  });

  it("is not shown at all for an ordinary acceptance with no PR", () => {
    const text = open({ noChanges: false, task: { branch: "vib-151" } });
    expect(text).toContain("No linked pull request");
    expect(text).not.toContain("completed with no changes");
  });
});

/**
 * F20-6 (R20-2) — a PR-less task whose completion NEVER claimed `noChanges` is
 * auto-detected at acceptance by re-probing the branch. The dialog cannot
 * promise a merge (there is nothing to merge) and cannot promise the close
 * either (the probe decides) — so it states exactly what the click will do.
 */
describe("F20-6: the no-PR auto-detect arm", () => {
  const openAutoDetect = (task: Partial<AcceptConfirmTask>) => {
    const { container } = render(
      <AcceptConfirm
        task={detail(task)}
        workRevisionSha={null}
        noChanges={false}
        noPullRequest
        defaultBranch="main"
        ceremony={{ mode: "accept" }}
        blockedReason={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    return (
      container.ownerDocument.querySelector(
        'dialog[data-screen-label="Accept completion dialog"]',
      )?.textContent ?? ""
    );
  };

  it("states the branch re-check and promises no merge", () => {
    const text = openAutoDetect({ branch: "vib-151" });
    expect(text).toContain("Nothing to merge yet");
    expect(text).toContain("vib-151");
    expect(text).toContain("completed with no changes");
    // It must NOT fall back to the ordinary "closes without a merge" line, and
    // it must NOT claim the merge is one-way (nothing merges here).
    expect(text).not.toContain(
      "No linked pull request. The task closes without a merge",
    );
    expect(text).not.toContain("Merging is one-way");
  });

  it("names the branch generically when the task never opened one", () => {
    const text = openAutoDetect({ branch: null });
    expect(text).toContain("Nothing to merge yet");
    expect(text).toContain("re-checks the branch");
  });

  it("the flag is required — an ordinary no-PR accept still reads 'closes without a merge'", () => {
    // Canary: derive `noPullRequest` from `!task.pr` inside the component and
    // this ordinary accept would flip to the auto-detect copy.
    const text = open({ noChanges: false, task: { branch: "vib-151" } });
    expect(text).toContain("No linked pull request");
    expect(text).not.toContain("Nothing to merge yet");
  });
});

/**
 * F19-23 — the drift note's noun was switched with its count and the verb was
 * not, so a one-commit drift read "1 commit added since review; THEY MERGE
 * unreviewed". The server-side sentence was fixed; this dialog's own copy (and
 * the board's identical row) was not.
 */
describe("the revision-drift row agrees with its own number", () => {
  const withDrift = (aheadBy: number) =>
    open({
      task: {
        pr: {
          number: 150,
          state: "review",
          title: "[VIB-151] work",
          revisionDrift: { headSha: "a".repeat(40), authored: aheadBy, baseRefresh: null },
        },
      },
    });

  it("uses the singular verb for exactly one commit", () => {
    expect(withDrift(1)).toContain("1 authored commit since review merges unreviewed");
    expect(withDrift(1)).not.toContain("commits since review merge");
  });

  it("keeps the plural for more than one", () => {
    expect(withDrift(3)).toContain("3 authored commits since review merge unreviewed");
  });

  it("ruling 132: a base refresh prints the canonical sentence verbatim and is not a warning", () => {
    // Canary: restore the count-based sentence (`authored + baseRefresh.commits`
    // "commit(s) added since review; they merge unreviewed"), which renders 5
    // for this fixture.
    const record = { headSha: "a".repeat(40), authored: 0, baseRefresh: { merges: 1, commits: 4 } };
    const text = open({ task: { pr: { number: 150, state: "review", title: "[VIB-151] work", revisionDrift: record } } });
    expect(text).toContain(describeRevisionDrift(record).sentence);
    expect(text).toContain("base refreshed · 1 merge commit · 4 base commits · 0 authored commits since review");
    expect(text).not.toContain("unreviewed");
    expect(text).not.toContain("5 commit");
  });
});

/**
 * F21-2 / ruling 88 — the confirmed click hands back the disclosure this render
 * made, so the submit can echo it and the server can verify it. Read off the
 * SAME props the three rows above display: a value the human never saw would
 * acknowledge nothing.
 */
describe("the confirmed click carries the disclosure it just made", () => {
  function confirmed(props: {
    task?: Partial<AcceptConfirmTask>;
    workRevisionSha?: string | null;
    mode?: "accept" | "force";
  }): AcceptanceDisclosure | null {
    let got: AcceptanceDisclosure | null = null;
    const { container } = render(
      <AcceptConfirm
        task={detail(props.task ?? {})}
        workRevisionSha={props.workRevisionSha ?? null}
        defaultBranch="main"
        ceremony={{ mode: props.mode ?? "accept" }}
        blockedReason={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={(disclosure) => {
          got = disclosure;
        }}
      />,
    );
    const confirm = [
      ...container.ownerDocument.querySelectorAll<HTMLButtonElement>(
        'dialog[data-screen-label="Accept completion dialog"] .foot-actions button',
      ),
    ].at(-1);
    confirm?.click();
    return got;
  }

  it("echoes the PR state, the delivered revision and the verdict", () => {
    expect(
      confirmed({
        workRevisionSha: "a".repeat(40),
        task: {
          validation: "healthy",
          pr: { number: 150, state: "review", title: "[VIB-151] work" },
        },
      }),
    ).toEqual({ pr: "review", revision: "a".repeat(40), verdict: "healthy" });
  });

  it("says 'none' for the facts the dialog itself reports as absent", () => {
    // The rows read "No linked pull request" and "No delivered revision
    // recorded" — the echo has to say the same thing, or the server would be
    // comparing a silence against a value.
    expect(
      confirmed({ workRevisionSha: null, task: { pr: null, validation: "none" } }),
    ).toEqual({ pr: "none", revision: "none", verdict: "none" });
  });

  it("force discloses on the same terms", () => {
    expect(
      confirmed({ mode: "force", workRevisionSha: null, task: { validation: "changed" } }),
    ).toEqual({ pr: "none", revision: "none", verdict: "changed" });
  });
});

/**
 * F21-23 (live, UC-15) — a human merged PR #172 on GitHub out of band. The
 * poller adopted `state: merged`, the reviewer verdict still ran, and this
 * dialog's Merges row correctly read "PR #172 · merged into main" — while the
 * button under it said "Apply → Done & merge" and the footer "Merging is
 * one-way." The dialog knew the merge had happened and promised to perform it.
 *
 * The disclosure rows are the point of the ceremony and are unchanged; what
 * changes is the two lines that PREDICT a merge.
 */
describe("F21-23: an already-merged PR is not promised a merge", () => {
  const MERGED = {
    number: 172,
    state: "merged" as const,
    title: "[VIB-151] work",
  };
  const OPEN_PR = {
    number: 172,
    state: "review" as const,
    title: "[VIB-151] work",
  };

  function ceremonyDialog(props: {
    pr: AcceptConfirmTask["pr"];
    mode?: "accept" | "apply-recommendation" | "complete-merge" | "stage-move";
  }) {
    const { container } = render(
      <AcceptConfirm
        task={detail({ pr: props.pr })}
        workRevisionSha={"a".repeat(40)}
        defaultBranch="main"
        ceremony={{ mode: props.mode ?? "apply-recommendation", label: "Accept completion" }}
        blockedReason={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const dialog = container.ownerDocument.querySelector(
      'dialog[data-screen-label="Accept completion dialog"]',
    )!;
    return {
      text: dialog.textContent ?? "",
      confirm:
        [
          ...dialog.querySelectorAll<HTMLButtonElement>(".foot-actions button"),
        ].at(-1)?.textContent ?? "",
    };
  }

  it("the recommendation button drops '& merge' and the footer says nothing merges", () => {
    const merged = ceremonyDialog({ pr: MERGED });
    expect(merged.confirm).toBe("Apply → Done");
    expect(merged.text).toContain(
      "Nothing merges: the pull request was already merged on GitHub.",
    );
    expect(merged.text).not.toContain("Merging is one-way");
    // Every disclosure row survives: the PR, the revision and the verdict are
    // exactly what the human is accepting against.
    expect(merged.text).toContain("PR #172");
    expect(merged.text).toContain("into main");
    expect(merged.text).toContain("a".repeat(12));
    expect(merged.text).toContain("Verdict");
  });

  it("an OPEN pull request still promises the merge it is about to perform", () => {
    // Canary: the fix must be about the PR's state, not about the mode.
    const open = ceremonyDialog({ pr: OPEN_PR });
    expect(open.confirm).toBe("Apply → Done & merge");
    expect(open.text).toContain("Merging is one-way");
    expect(open.text).not.toContain("already merged on GitHub");
  });

  it("the merge-pending ceremony stops offering to merge a merged PR", () => {
    // R16-6's second half can find the PR merged out of band between the
    // recommendation and the click — "Merge PR #172 into main" would name work
    // GitHub has already done.
    const merged = ceremonyDialog({ pr: MERGED, mode: "complete-merge" });
    expect(merged.confirm).toBe("Finish accepting VIB-151");
    expect(merged.text).toContain("Nothing merges");

    cleanup();
    const pending = ceremonyDialog({ pr: OPEN_PR, mode: "complete-merge" });
    expect(pending.confirm).toBe("Merge PR #172 into main");
    expect(pending.text).toContain("Merging is one-way");
  });

  it("promises no record either on the arm where the server writes nothing", () => {
    // Residual: "Finish accepting VIB-151" sat above "The completion event is
    // recorded on the timeline", and on THIS arm nothing is recorded — the task
    // was accepted when the PR was stamped "accepted" (that write put the
    // completion on the timeline), and `completeTaskMerge` now settles an
    // already-merged PR as a no-op success. Only this arm may say so: every
    // other mode still performs the acceptance write, merge or no merge.
    const finishing = ceremonyDialog({ pr: MERGED, mode: "complete-merge" });
    expect(finishing.text).toContain("Nothing is written either");

    cleanup();
    const applying = ceremonyDialog({ pr: MERGED });
    expect(applying.text).toContain(
      "The completion event is recorded on the timeline.",
    );
    expect(applying.text).not.toContain("Nothing is written either");
  });
});

/**
 * Ruling 162 / G35-5(d) (pass 35): the acceptance ceremony brings the branch up
 * to date with the base and PUSHES that merge before it merges the PR. That is
 * a write to the person's branch on GitHub performed by this click, and the
 * dialog is the ruling-88 disclosure of what the click does.
 */
describe("ruling 162: the ceremony discloses the base refresh it performs", () => {
  const OPEN_PR = { number: 16, state: "review" as const, title: "[VIB-151] t" };
  function dialogText(props: {
    pr: AcceptConfirmTask["pr"];
    branch?: string | null;
    mode?: "accept" | "complete-merge";
  }): string {
    const { container } = render(
      <AcceptConfirm
        task={detail({
          pr: props.pr,
          branch: props.branch === undefined ? "vib-151" : props.branch,
        })}
        workRevisionSha={"a".repeat(40)}
        defaultBranch="main"
        ceremony={{ mode: props.mode ?? "accept" }}
        blockedReason={null}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    return (
      container
        .querySelector('dialog[data-screen-label="Accept completion dialog"]')
        ?.textContent?.replace(/\s+/g, " ") ?? ""
    );
  }

  it("names the branch, the base and the merge head the refresh creates", () => {
    // CANARY: delete the Branch row — the dialog authorizes a push to the
    // branch while enumerating only the merge.
    const text = dialogText({ pr: OPEN_PR });
    expect(text).toContain(
      "vib-151 is brought up to date with main first. If the base has moved, that merge commit is pushed to the branch and becomes the merge head.",
    );
  });

  it("says nothing about a refresh on the paths that perform none", () => {
    // `complete-merge` runs `completeTaskMerge`, which merges the PR without
    // the ceremony; a task with no pull request has no branch to refresh.
    expect(dialogText({ pr: OPEN_PR, mode: "complete-merge" })).not.toContain(
      "is brought up to date with",
    );
    expect(dialogText({ pr: null })).not.toContain("is brought up to date with");
    expect(dialogText({ pr: OPEN_PR, branch: null })).not.toContain(
      "is brought up to date with",
    );
  });
});

/**
 * Ruling 162 (pass 35, F35-12 (c)): the accept dialog prints the gate's
 * refusal above a DISABLED confirm; only force-accept, which bypasses the
 * gate, keeps its button. Live (KNC-6) the dialog's controls were all enabled
 * while the server answered 409 on every click.
 */
describe("ruling 162: a standing refusal disables the confirm", () => {
  const REFUSAL =
    "VIB-151's review PR #16 conflicts with the base branch. GitHub can't merge it, so it can't be accepted. Resolve the conflict on the branch by merging the base INTO it — never by rebasing, which rewrites commits the pull request already published — then re-review, or archive the task.";
  function confirmButton(mode: "accept" | "force", blockedReason: string | null) {
    const { container } = render(
      <AcceptConfirm
        task={detail({ stage: mode === "force" ? "triage" : "review", pr: { number: 16, state: "review", title: "[VIB-151] t" } })}
        workRevisionSha={"a".repeat(40)}
        noChanges={false}
        defaultBranch="main"
        ceremony={{ mode }}
        atBoundary={mode !== "force"}
        blockedReason={blockedReason}
        busy={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const dialog = container.querySelector('dialog[data-screen-label="Accept completion dialog"]')!;
    const buttons = Array.from(dialog.querySelectorAll("button"));
    return { dialog, button: buttons[buttons.length - 1]! };
  }

  it("prints the reason and disables the confirm on the accept ceremony", () => {
    // Canary: disable on `busy` alone.
    const { dialog, button } = confirmButton("accept", REFUSAL);
    expect(dialog.textContent).toContain("Blocked");
    expect(dialog.textContent).toContain(REFUSAL);
    expect(button.textContent).toContain("Accept");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe("accept-confirm-blocked");
    expect(dialog.querySelector("#accept-confirm-blocked")?.textContent).toContain(REFUSAL);
  });

  it("keeps the confirm enabled with no refusal, and on force-accept, which bypasses the gate", () => {
    expect(confirmButton("accept", null).button.disabled).toBe(false);
    const forced = confirmButton("force", REFUSAL);
    expect(forced.dialog.textContent).toContain("Bypassing");
    expect(forced.button.disabled).toBe(false);
    expect(forced.button.getAttribute("aria-describedby")).toBeNull();
  });
});
