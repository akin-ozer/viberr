// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { ReviewQueuePage } from "./review-page";
import { capabilityById } from "~/shared/capabilities";
import type { ReviewRowView } from "./review-helpers";

afterEach(cleanup);

const rowHuman: ReviewRowView = {
  key: "VIB-142",
  title: "Attach execution workspace to task runtime",
  waiting: "human",
  packet: {
    kind: "Completion report",
    title: "Accept completion, or send back for one fix?",
  },
  latestEventText: null,
  pr: { number: 318, state: "review" },
  validation: "changed",
  blockReason: null,
  lastActivityAt: "2026-07-02T09:41:00.000Z",
  quiet: false,
  continuity: null,
};

const rowAgent: ReviewRowView = {
  key: "VIB-145",
  title: "Live task activity via SSE",
  waiting: "agent",
  packet: null,
  latestEventText:
    "**Transition request:** move VIB-145 from In Progress to Review — evidence attached.",
  pr: { number: 311, state: "merged" },
  validation: "healthy",
  blockReason: null,
  lastActivityAt: "2026-07-02T09:41:00.000Z",
  quiet: false,
  continuity: null,
};

function renderQueue(
  ready: ReviewRowView[],
  working: ReviewRowView[],
  total = ready.length + working.length,
  acceptance?: { operatorCanAccept: boolean; operatorName: string },
) {
  const Stub = createRoutesStub([
    {
      path: "/projects/:slug/review",
      Component: () => (
        <ReviewQueuePage
          projectSlug="viberr-core"
          ready={ready}
          working={working}
          total={total}
          acceptance={acceptance}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/projects/viberr-core/review"]} />);
}

describe("ReviewQueuePage", () => {
  it("renders header counts, the policy chip, and both panels", () => {
    const { container, getByText, getByTitle } = renderQueue(
      [rowHuman],
      [rowAgent],
    );
    expect(getByText("Review queue")).toBeTruthy();
    expect(
      getByText(
        "2 tasks at the review boundary · 1 waiting on your acceptance",
      ),
    ).toBeTruthy();
    // UI-27/UI-49: REWRITTEN. The chip used to be a `<button class="hero-file">`
    // — visually identical to the non-interactive `hero-file` spans elsewhere,
    // so nothing announced it navigates; it is a real button now. And the
    // "Review → Done" wording is no longer hardcoded: the page renders the
    // project's RESOLVED stage names (the default prop keeps this fixture's).
    const chip = getByTitle("Review → Done is locked to humans — see Policy");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.classList.contains("btn")).toBe(true);
    expect(chip.textContent).toContain("Review → Done · human only");
    // Panel heads + "X of Y" count pair.
    expect(getByText("Waiting on your acceptance")).toBeTruthy();
    expect(getByText("1 of 2")).toBeTruthy();
    expect(getByText("Still in review")).toBeTruthy();
    // The pol-note acceptance explainer always renders.
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action, always in the audit log",
    );
  });

  it("rows carry key, subline, PR pill, validation pill and the scoped wait-tag copy", () => {
    const { container } = renderQueue([rowHuman], [rowAgent]);
    const rows = container.querySelectorAll(".rq-row");
    expect(rows).toHaveLength(2);

    const first = rows[0]!;
    expect(first.querySelector(".rq-key")!.textContent).toBe("VIB-142");
    expect(first.querySelector(".sub")!.textContent).toBe(
      "Completion report — Accept completion, or send back for one fix?",
    );
    // C4: the viewer-scoped canonical phrase — the same "waiting on you" the
    // board card uses. (The panel HEADING still names the acceptance action;
    // this per-row tag is a status, and shares the app's two-phrase vocabulary.)
    expect(first.querySelector(".wait-tag.human")!.textContent).toContain(
      "waiting on you",
    );
    expect(first.textContent).toContain("PR #318");
    // validation `changed` names what is OWED, not the mechanism (owner
    // feedback 2026-07-26 — was "evidence changed").
    expect(first.textContent).toContain("awaiting verdict");

    const second = rows[1]!;
    // P14-LV-05: a row that carries a PR describes the PR's LIVE state — the
    // newest timeline note (here a stale "Transition request") is history, and
    // rendering it as the row's current state is how a REOPENED PR kept reading
    // "closed on GitHub without merging".
    expect(second.querySelector(".sub")!.textContent).toBe(
      "PR #311 is merged on GitHub — accept the completion to close the task.",
    );
    expect(second.querySelector(".wait-tag.agent")!.textContent).toContain(
      "agent working",
    );
    expect(second.querySelector(".wait-tag.agent .working")).toBeTruthy();
    // Merged PR renders the done pill kind.
    expect(second.querySelector(".pill.done")!.textContent).toBe("PR #311");
  });

  it("D4: a row whose task has degraded continuity carries the same cue the board card does", () => {
    // The state used to live only on the task page's Continuity Recovery panel;
    // the review boundary is exactly where a supervisor looks, so it surfaces
    // here too — warning tone (risk pill), the panel's refresh glyph, one
    // vocabulary. Canary: drop the `t.continuity === "degraded"` block and this
    // (and the negative case below) go red.
    const degraded: ReviewRowView = { ...rowHuman, continuity: "degraded" };
    const { container } = renderQueue([degraded], []);
    const row = container.querySelector(".rq-row")!;
    expect(row.textContent).toContain("degraded continuity");
    expect(row.querySelector(".rq-meta .pill.risk")).toBeTruthy();
  });

  it("D4: a healthy-continuity row shows no continuity cue", () => {
    const { container } = renderQueue([rowHuman], []);
    expect(container.querySelector(".rq-row")!.textContent).not.toContain(
      "degraded continuity",
    );
  });

  it("R15-11: every row names its primary action and where it goes", () => {
    // The queue's job is deciding, but the row was an unlabeled clickable
    // region — the surface read as having no action at all. It stays a triage
    // list; the row just says what the click does.
    // Canary: delete the .rq-go span and both halves fail.
    const { container } = renderQueue([rowHuman], [rowAgent]);
    const rows = container.querySelectorAll(".rq-row");
    for (const row of rows) {
      const go = row.querySelector(".rq-go");
      expect(go, "each row needs a named primary action").toBeTruthy();
      expect(go!.textContent).toContain("Review");
      // Decorative for AT — the row's own aria-label already names the target,
      // so the chevron+label must not be read a second time.
      expect(go!.getAttribute("aria-hidden")).toBe("true");
    }
    // It must NOT say "Accept": acceptance is verdict-gated (R15-1) and can
    // refuse, and this surface cannot promise an outcome it does not evaluate.
    expect(container.querySelector(".rq-go")!.textContent).not.toContain("Accept");
    expect(rows[0]!.getAttribute("aria-label")).toBe(
      "Review VIB-142: Attach execution workspace to task runtime",
    );
  });

  it("labels a human-waiting row in the working panel 'waiting on a human', never 'agent working'", () => {
    // R8-3: a review task waiting on a human someone ELSE must accept lands in
    // "Still in review" — it must read "waiting on a human", not the false
    // "agent working" (no agent is running on a human-waiting task).
    const humanNotMine: ReviewRowView = {
      ...rowAgent,
      key: "VIB-150",
      waiting: "human",
    };
    const { container } = renderQueue([], [humanNotMine]);
    const row = container.querySelector(".rq-row")!;
    expect(row.querySelector(".wait-tag.human")!.textContent).toContain(
      "waiting on a human",
    );
    expect(row.querySelector(".wait-tag.agent")).toBeNull();
  });

  it("F19-31: a `waiting: none` row shows NO wait tag — the board's answer for the same value", () => {
    // `review + none` is legal and listed (review-queue.server.ts puts it in
    // "Still in review"). The wait-tag ladder used to end in a bare `else`, so
    // this row rendered the pulsing "agent working" while the board's WaitTag
    // renders nothing at all for the identical stored value — the same defect
    // R8-3 fixed for "human", one branch further down.
    const noneRow: ReviewRowView = {
      ...rowAgent,
      key: "VIB-160",
      waiting: "none",
      latestEventText: null,
      pr: null,
    };
    const { container } = renderQueue([], [noneRow]);
    const row = container.querySelector(".rq-row")!;
    expect(row.querySelector(".wait-tag")).toBeNull();
    expect(row.textContent).not.toContain("agent working");
    // The row is not silent about itself — the subline says what "none" means.
    expect(row.querySelector(".sub")!.textContent).toBe(
      "At the review boundary — no agent is running and no decision is pending.",
    );
    // Still a triage row: it keeps its named action.
    expect(row.querySelector(".rq-go")!.textContent).toContain("Review");
  });

  it("F19-32: an ACCEPTED PR renders the amber 'merge pending' pill, not a bare in-review one", () => {
    // Ruling 40/R16-6: acceptance and the real GitHub merge are two facts, and
    // the difference must be visible on the board card AND here. The row type
    // hard-coded review|merged|closed and the projection coerced everything
    // else to "review", so prStatePill's `accepted` branch was unreachable from
    // this surface however the queue was rendered.
    const mergePending: ReviewRowView = {
      ...rowAgent,
      key: "VIB-170",
      waiting: "human",
      latestEventText: null,
      pr: { number: 420, state: "accepted" },
    };
    const { container } = renderQueue([], [mergePending]);
    const row = container.querySelector(".rq-row")!;
    // First pill in the meta cluster is the PR pill (validation follows).
    const pill = row.querySelectorAll(".pill")[0]!;
    expect(pill.className).toContain("input"); // amber, same tone as task detail
    expect(pill.textContent).toBe("PR #420 · merge pending");
    expect(row.querySelector(".sub")!.textContent).toBe(
      "PR #420 is accepted — the merge is still pending; a human completes it on the task.",
    );
    // The colour alone must not be the whole signal (F19-14's rule), but the
    // states the subline already spells out stay bare — density is the board's.
    const openRow = renderQueue([], [
      { ...mergePending, pr: { number: 420, state: "review" } },
    ]);
    expect(
      openRow.container.querySelectorAll(".rq-row .pill")[0]!.textContent,
    ).toBe("PR #420");
  });

  it("renders both empty states with exact copy (no all-empty hero)", () => {
    const { getByText } = renderQueue([], []);
    expect(
      getByText(
        "Nothing waits on you. Completion reports land here when a task reaches the boundary.",
      ),
    ).toBeTruthy();
    expect(getByText("No review work in flight.")).toBeTruthy();
    expect(
      getByText("0 tasks at the review boundary · 0 waiting on your acceptance"),
    ).toBeTruthy();
  });

  it("singular header copy for exactly one review task", () => {
    const { getByText } = renderQueue([rowHuman], []);
    expect(
      getByText("1 task at the review boundary · 1 waiting on your acceptance"),
    ).toBeTruthy();
  });
});

describe("R16-3: a closed PR is stated as the terminal fact it is", () => {
  // Live (H10): this row read "…no approving verdict yet — run a review for a
  // verdict, or an admin can force-accept" next to a "PR #124 · closed" pill.
  // The pill was the only thing telling the truth, and the sentence pointed at
  // two paths that do not exist once GitHub has closed the PR — one of which
  // the task page now withholds outright (acceptanceTerminallyBlocked).
  const closedRow: ReviewRowView = {
    key: "VIB-9",
    title: "Delivered, then rejected on GitHub",
    waiting: "human",
    packet: null,
    latestEventText: null,
    pr: { number: 124, state: "closed" },
    validation: "changed",
    blockReason:
      "VIB-9's delivered revision has no approving verdict yet — run a review for a verdict, or an admin can force-accept.",
    lastActivityAt: "2026-07-02T09:41:00.000Z",
    quiet: false,
    continuity: null,
  };

  it("the subline names the closed PR and the queue never advertises force-accept", () => {
    const { container } = renderQueue([], [closedRow]);
    const row = container.querySelector(".rq-row")!;
    expect(row.querySelector(".sub")!.textContent).toBe(
      "PR #124 was closed on GitHub without merging — rework and reopen it, or archive the task.",
    );
    expect(row.textContent).not.toContain("force-accept");
    expect(row.textContent).not.toContain("approving verdict");
    // The pill stays — it was the only honest signal before, and it still
    // carries the PR number the subline names.
    // UXA-2: it is now the CANONICAL `prStatePill` tone. This queue used to
    // colour PR state with its own private map, so a closed-unmerged (rejected)
    // PR read neutral grey here while ruling 12's map renders it `risk` on the
    // board, task detail and the GitHub page — the same state wearing two
    // colours one click apart. The neutral class was incidental to this test's
    // point (the pill is present and names the PR); the rejection tone is not.
    expect(row.querySelector(".pill.risk")!.textContent).toBe(
      "PR #124 · closed",
    );
  });

  it("an OPEN PR with the same gate still shows the process gate", () => {
    const { container } = renderQueue([], [
      { ...closedRow, pr: { number: 124, state: "review" } },
    ]);
    expect(container.querySelector(".rq-row .sub")!.textContent).toBe(
      closedRow.blockReason,
    );
  });
});

describe("P13-D-9: the queue stops promising human-only Done unconditionally", () => {
  it("keeps the absolute claim when no operator holds the direct grant", () => {
    const { container, getByTitle } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: false,
      operatorName: "Operator",
    });
    expect(
      getByTitle("Review → Done is locked to humans — see Policy").textContent,
    ).toContain("Review → Done · human only");
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action, always in the audit log",
    );
  });

  it("qualifies the chip and the footer for a direct-authority operator", () => {
    // Owner ruling Q1: a full-autonomy operator with an explicit
    // `completion-for-acceptance: direct` grant moves tasks to Done itself
    // (operator-actions.server.ts:1632). The create modal and the Policy note
    // were updated to disclose it; the Review queue — where a maintainer forms
    // the acceptance belief — shipped "always a human action" regardless.
    const { container, getByText } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: true,
      operatorName: "Atlas",
    });
    const chip = getByText("Review → Done · human or operator");
    expect(chip).toBeTruthy();
    expect(chip.closest("button")!.getAttribute("title")).toContain(
      "Atlas runs at full autonomy",
    );

    const note = container.querySelector(".pol-note")!.textContent!;
    expect(note).not.toContain("always a human action");
    expect(note).toContain("Atlas");
    expect(note).toContain("full autonomy");
    expect(note).toContain("Accept completion into Done");
    expect(note).toContain("Direct");
    // It stays an exception, not a licence.
    expect(note).toContain("one exception");
    expect(note).toContain("always in the audit log");
  });

  // UXV19-1: this queue named the capability by hand and kept the RETIRED
  // label ("Completion for human acceptance") after the catalog renamed it —
  // on the one surface that tells the reader to go verify the claim on Policy,
  // where only "Accept completion into Done" exists. Both the tooltip and the
  // footer now render the catalog's own label, by id.
  // Canary: hardcode "Completion for human acceptance" back into either the
  // title at review-page.tsx or the footer <strong> and this test fails.
  it("names the acceptance capability exactly as the catalog does, in the chip AND the footer", () => {
    const label = capabilityById("completion-for-acceptance")!.label;
    expect(label).toBe("Accept completion into Done");

    const { container, getByText } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: true,
      operatorName: "Atlas",
    });
    const title = getByText("Review → Done · human or operator")
      .closest("button")!
      .getAttribute("title")!;
    const note = container.querySelector(".pol-note")!.textContent!;

    for (const copy of [title, note]) {
      expect(copy).toContain(label);
      // The name it was renamed AWAY from must not survive anywhere here: it
      // matches no control on Policy, on the operator profile, or in the
      // capability editor.
      expect(copy).not.toContain("Completion for human acceptance");
    }
    // The exception needs BOTH facts — full autonomy alone never confers it
    // (`promotable: false`), so the copy must not read as a consequence of the
    // autonomy setting.
    expect(note).toContain("full autonomy");
    expect(note).toContain("separately holds");
    expect(note).toContain("never implied by the autonomy setting");
  });

  it("defaults to the strict boundary when the caller passes no acceptance data", () => {
    const { container } = renderQueue([rowHuman], []);
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action",
    );
  });
});

/**
 * Pass-19 gap 10 — the acceptance boundary carried no time at all. A completion
 * report that landed five minutes ago and one that has waited since Tuesday
 * rendered identically, on the queue whose entire job is triage.
 */
describe("gap-10: a review row that has gone quiet says so", () => {
  const stale: ReviewRowView = {
    ...rowHuman,
    key: "VIB-777",
    lastActivityAt: new Date(Date.now() - 4 * 24 * 60 * 60_000).toISOString(),
    quiet: true,
  };

  it("draws the neutral cue and keeps the acceptance wait-tag beside it", () => {
    const { container } = renderQueue([stale], []);
    const meta = container.querySelector(".rq-meta")!;
    expect(meta.textContent).toContain("no activity");
    expect(meta.querySelector(".pill.neutral")).toBeTruthy();
    // The row still says whose move it is — the cue adds time, it never replaces
    // the wait state. C4: the viewer-scoped "waiting on you".
    expect(meta.textContent).toContain("waiting on you");
  });

  it("says nothing on a row that is still moving", () => {
    const { container } = renderQueue([rowHuman], [rowAgent]);
    expect(container.textContent).not.toContain("no activity");
  });
});
