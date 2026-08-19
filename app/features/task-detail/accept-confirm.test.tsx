// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AcceptConfirm, type AcceptConfirmTask } from "./accept-confirm";

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
      "No linked pull request — the task closes without a merge",
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
          revisionDrift: { aheadBy, headSha: "a".repeat(40) },
        },
      },
    });

  it("uses the singular verb for exactly one commit", () => {
    expect(withDrift(1)).toContain("1 commit added since review; it merges unreviewed.");
    expect(withDrift(1)).not.toContain("they merge");
  });

  it("keeps the plural for more than one", () => {
    expect(withDrift(3)).toContain("3 commits added since review; they merge unreviewed.");
  });
});
