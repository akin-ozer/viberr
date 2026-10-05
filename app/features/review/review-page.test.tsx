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
  stageName: "Review",
  atAcceptanceBoundary: true,
  priority: "normal",
  labels: [],
  dueDate: null,
  waiting: "human",
  packet: {
    kind: "Completion report",
    title: "Accept completion, or send back for one fix?",
  },
  goalEditPending: false,
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
  stageName: "Review",
  atAcceptanceBoundary: true,
  priority: "normal",
  labels: [],
  dueDate: null,
  waiting: "agent",
  packet: null,
  goalEditPending: false,
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
  waitingOnMe?: ReadonlySet<string>,
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
          waitingOnMe={waitingOnMe}
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
        "2 in review · 1 waiting on your acceptance",
      ),
    ).toBeTruthy();
    // UI-27/UI-49: REWRITTEN. The chip used to be a `<button class="hero-file">`
    // — visually identical to the non-interactive `hero-file` spans elsewhere,
    // so nothing announced it navigates; it became a real button, and is a
    // real link now (ruling 477(c)). And the
    // "Review → Done" wording is no longer hardcoded: the page renders the
    // project's RESOLVED stage names (the default prop keeps this fixture's).
    const chip = getByTitle("Review → Done is locked to humans. See Policy");
    expect(chip.tagName).toBe("A");
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
      "Completion report: Accept completion, or send back for one fix?",
    );
    // C4: the viewer-scoped canonical phrase — the same "waiting on you" the
    // board card uses. (The panel HEADING still names the acceptance action;
    // this per-row tag is a status, and shares the app's two-phrase vocabulary.)
    expect(first.querySelector(".chip.st.you")!.textContent).toContain(
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
      "PR #311 is merged on GitHub. Accept the completion to close the task.",
    );
    expect(second.querySelector(".chip.st.agent")!.textContent).toContain(
      "agent working",
    );
    expect(second.querySelector(".chip.st.agent .working")).toBeTruthy();
    // Merged PR renders the done pill kind.
    expect(second.querySelector(".pill.done")!.textContent).toBe("PR #311");
  });

  it("D4: a row whose task has degraded continuity carries the same cue the board card does", () => {
    // The state used to live only on the task page's Continuity Recovery panel;
    // the review boundary is exactly where a supervisor looks, so it surfaces
    // here too — the board card's problem chip, the panel's refresh glyph, one
    // vocabulary. Canary: drop the `t.continuity === "degraded"` block and this
    // (and the negative case below) go red.
    const degraded: ReviewRowView = { ...rowHuman, continuity: "degraded" };
    const { container } = renderQueue([degraded], []);
    const row = container.querySelector(".rq-row")!;
    expect(row.textContent).toContain("degraded continuity");
    // Ruling 625: the chip, not a risk pill. CANARY: render the Pill again.
    expect(row.querySelector(".rq-meta .chip.pb")!.textContent).toContain("degraded continuity");
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
    const { container, getByRole } = renderQueue([rowHuman], [rowAgent]);
    const rows = container.querySelectorAll(".rq-row");
    for (const row of rows) {
      const go = row.querySelector(".rq-go");
      expect(go, "each row needs a named primary action").toBeTruthy();
      expect(go!.textContent).toContain("Review");
      // Interface review 2026-09-24 (acce-8): the visible "Review" IS the
      // action in the row's name now, so it is not hidden from AT.
      expect(go!.hasAttribute("aria-hidden")).toBe(false);
      // No aria-label: one replaced the row's content, so a screen reader
      // heard key + title and never the PR, validation or wait tag.
      expect(row.hasAttribute("aria-label")).toBe(false);
    }
    // It must NOT say "Accept": acceptance is verdict-gated (R15-1) and can
    // refuse, and this surface cannot promise an outcome it does not evaluate.
    expect(container.querySelector(".rq-go")!.textContent).not.toContain("Accept");
    // The name comes from the content: key, title, state, and the action.
    // Canary: restore the aria-label and this lookup finds no link.
    expect(
      getByRole("link", {
        name: /VIB-142.*Attach execution workspace to task runtime.*PR #318.*waiting on you.*Review/,
      }),
    ).toBe(rows[0]);
  });

  // Ruling 477(c) (F40-29, live on akinozer.com): the WEB-4 row was
  // `<button type="button" class="rq-row">` with a <div> inside, calling
  // navigate() on click, so the queue could not open rows in new tabs or copy
  // their addresses and announced a button for a page link.
  it("rows and the policy chip are links to their pages, not buttons that navigate", () => {
    // CANARY: render the row as `<button type="button" onClick={…}>` again and
    // no row is a link, and none carries an address.
    const { container, getByTitle, queryAllByRole } = renderQueue([rowHuman], [rowAgent]);
    const rows = [...container.querySelectorAll(".rq-row")];
    expect(rows.map((r) => r.tagName)).toEqual(["A", "A"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/projects/viberr-core/tasks/VIB-142",
      "/projects/viberr-core/tasks/VIB-145",
    ]);
    // Nothing on the page is a button that goes somewhere.
    expect(queryAllByRole("button")).toEqual([]);
    const chip = getByTitle("Review → Done is locked to humans. See Policy");
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toBe("/projects/viberr-core/policy");
  });

  it("writ-3: a row the board marks waitingOnMe reads 'waiting on you' in either panel", () => {
    // The queue tested acceptance alone, so a viewer who owns an open decision
    // on a review task read "waiting on a human" here while the board, one
    // click away, said "waiting on you". The flag is the board's own, handed in
    // by the route. Canary: drop the `waitingOnMe` term from the tag test.
    const mine: ReviewRowView = { ...rowAgent, key: "VIB-150", waiting: "human" };
    const theirs: ReviewRowView = { ...rowAgent, key: "VIB-151", waiting: "human" };
    // The board's precedence: an agent at work reads "agent working" even when
    // the viewer also owns a decision on the task (card-status.ts).
    const running: ReviewRowView = { ...rowAgent, key: "VIB-152" };
    const { container } = renderQueue(
      [],
      [mine, theirs, running],
      3,
      undefined,
      new Set(["VIB-150", "VIB-152"]),
    );
    const [a, b, c] = [...container.querySelectorAll(".rq-row")];
    expect(a!.querySelector(".chip.st.you")!.textContent).toContain("waiting on you");
    expect(a!.querySelector(".chip.st.human")).toBeNull();
    expect(b!.querySelector(".chip.st.human")!.textContent).toContain(
      "waiting on a human",
    );
    expect(c!.querySelector(".chip.st.agent")).toBeTruthy();
    expect(c!.querySelector(".chip.st.you")).toBeNull();
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
      goalEditPending: false,
      latestEventText: null,
      pr: null,
    };
    const { container } = renderQueue([], [noneRow]);
    const row = container.querySelector(".rq-row")!;
    expect(row.querySelector(".chip.st")).toBeNull();
    expect(row.textContent).not.toContain("agent working");
    // The row is not silent about itself — the subline says what "none" means.
    expect(row.querySelector(".sub")!.textContent).toBe(
      "At the review boundary: no agent is running and no decision is pending.",
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
      goalEditPending: false,
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
      "PR #420 is accepted. The merge is still pending; a human completes it on the task.",
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
        "Nothing waits on your acceptance. Completion reports land here when a task reaches the boundary.",
      ),
    ).toBeTruthy();
    expect(getByText(/No review work in flight/)).toBeTruthy();
    expect(
      getByText("0 in review · 0 waiting on your acceptance"),
    ).toBeTruthy();
  });

  it("header copy for exactly one review task carries no stage word (U35-5)", () => {
    const { getByText } = renderQueue([rowHuman], []);
    expect(
      getByText("1 in review · 1 waiting on your acceptance"),
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
    stageName: "Review",
    atAcceptanceBoundary: true,
    priority: "normal",
    labels: [],
    dueDate: null,
    waiting: "human",
    packet: null,
    goalEditPending: false,
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
      "PR #124 was closed on GitHub without merging. Rework and reopen it, or archive the task.",
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
});

describe("P13-D-9: the queue stops promising human-only Done unconditionally", () => {
  it("keeps the absolute claim when no operator holds the direct grant", () => {
    const { container, getByTitle } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: false,
      operatorName: "Operator",
    });
    expect(
      getByTitle("Review → Done is locked to humans. See Policy").textContent,
    ).toContain("Review → Done · human only");
    expect(container.querySelector(".pol-note")!.textContent).toContain(
      "always a human action, always in the audit log",
    );
  });

  it("qualifies the chip and the footer for a direct-authority operator", () => {
    // Owner ruling Q1: a full-autonomy operator with an explicit
    // `completion-for-acceptance: direct` grant moves tasks to Done itself
    // (`operatorAcceptCompletion`, operator-moves.server.ts). The create
    // modal and the Policy note were updated to disclose it; the Review queue —
    // where a maintainer forms the acceptance belief — shipped "always a human
    // action" regardless.
    const { container, getByText } = renderQueue([rowHuman], [], 1, {
      operatorCanAccept: true,
      operatorName: "Atlas",
    });
    const chip = getByText("Review → Done · human or operator");
    expect(chip).toBeTruthy();
    const title = chip.closest("a")!.getAttribute("title")!;
    expect(title).toContain("Atlas runs at full autonomy");

    const note = container.querySelector(".pol-note")!.textContent!;
    expect(note).not.toContain("always a human action");
    expect(note).toContain("Atlas");
    expect(note).toContain("full autonomy");
    expect(note).toContain("Direct");
    // It stays an exception, not a licence.
    expect(note).toContain("one exception");
    expect(note).toContain("always in the audit log");
    // The exception needs BOTH facts — full autonomy alone never confers it
    // (`promotable: false`), so the copy must not read as a consequence of the
    // autonomy setting.
    expect(note).toContain("separately holds");
    expect(note).toContain("never implied by the autonomy setting");

    // UXV19-1: this queue named the capability by hand and kept the RETIRED
    // label ("Completion for human acceptance") after the catalog renamed it —
    // on the one surface that tells the reader to go verify the claim on Policy,
    // where only "Accept completion into Done" exists. Both the tooltip and the
    // footer now render the catalog's own label, by id.
    // Canary: hardcode "Completion for human acceptance" back into either the
    // title at review-page.tsx or the footer <strong> and this test fails.
    const label = capabilityById("completion-for-acceptance")!.label;
    expect(label).toBe("Accept completion into Done");
    for (const copy of [title, note]) {
      expect(copy).toContain(label);
      // The name it was renamed AWAY from must not survive anywhere here: it
      // matches no control on Policy, on the operator profile, or in the
      // capability editor.
      expect(copy).not.toContain("Completion for human acceptance");
    }
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

/**
 * U35-5 (pass 35): the header used to read "N tasks at the review boundary",
 * naming the one stage every row shared. The rows are review work now,
 * wherever it sits, so the count says what it counts and nothing about a
 * stage. The live shape: eight tasks at Validation with open PRs under review
 * and no one owed an acceptance yet. Canary: restore the old sentence.
 */
describe("U35-5: the header counts review work, not a stage", () => {
  it("renders `8 in review · 0 waiting on your acceptance` for eight off-boundary rows", () => {
    const working = Array.from({ length: 8 }, (_, i): ReviewRowView => ({
      ...rowAgent,
      key: `KNC-${i + 8}`,
      stageName: "Validation",
      atAcceptanceBoundary: false,
      pr: { number: i + 1, state: "review" },
      validation: "changed",
    }));
    const { getByText, container } = renderQueue([], working);
    expect(getByText("8 in review · 0 waiting on your acceptance")).toBeTruthy();
    expect(container.textContent).not.toContain("at the review boundary");
    expect(container.textContent).not.toContain("No review work in flight");
    // The rows say where they are.
    expect(container.querySelector(".rq-row .sub")!.textContent).toBe(
      "Review in progress at Validation · PR #1 · awaiting verdict",
    );
    expect(getByText("0 of 8")).toBeTruthy();
  });
});

/**
 * Ruling 236 (owner, 2026-09-14) — the collision chip. Names the tasks, not the
 * count: "two others" says there is a problem and nothing about which merge to
 * do first, which is the whole question a person is at this queue to answer.
 */
describe("ruling 236: the collision chip", () => {
  const colliding = (overlaps: NonNullable<ReviewRowView["pr"]>["overlaps"]) => ({
    ...rowHuman,
    pr: { ...rowHuman.pr!, overlaps },
  });

  it("names the colliding tasks and puts the shared files in the tooltip", () => {
    const { container } = renderQueue(
      [
        colliding([
          { taskKey: "VIB-9", prNumber: 9, paths: ["pnpm-lock.yaml"], partial: false },
        ]),
      ],
      [],
    );
    expect(container.textContent).toContain("collides with VIB-9");
    const chip = [...container.querySelectorAll("[title]")].find((e) =>
      (e.getAttribute("title") ?? "").includes("into conflict"),
    );
    expect(chip?.getAttribute("title")).toContain("VIB-9");
    expect(chip?.getAttribute("title")).toContain("Shared files: pnpm-lock.yaml");
  });

  it("summarises past two, still by name", () => {
    const { container } = renderQueue(
      [
        colliding([
          { taskKey: "VIB-9", prNumber: 9, paths: ["a.ts"], partial: false },
          { taskKey: "VIB-10", prNumber: 10, paths: ["a.ts"], partial: false },
          { taskKey: "VIB-11", prNumber: 11, paths: ["a.ts"], partial: false },
        ]),
      ],
      [],
    );
    expect(container.textContent).toContain("collides with VIB-9, VIB-10 and 1 more");
    // The tooltip must not claim a PAIRING once there is more than one
    // collision: "both change" was true of the first overlap and false of every
    // board that actually needs this chip.
    const chip = [...container.querySelectorAll("[title]")].find((e) =>
      (e.getAttribute("title") ?? "").includes("into conflict"),
    );
    expect(chip?.getAttribute("title")).toContain("VIB-9, VIB-10, VIB-11 into conflict");
    expect(chip?.getAttribute("title")).not.toContain("both change");
  });

  it("says so when a capped list makes the overlap a floor", () => {
    const { container } = renderQueue(
      [
        colliding([
          { taskKey: "VIB-9", prNumber: 9, paths: ["a.ts"], partial: true },
        ]),
      ],
      [],
    );
    const chip = [...container.querySelectorAll("[title]")].find((e) =>
      (e.getAttribute("title") ?? "").includes("into conflict"),
    );
    expect(chip?.getAttribute("title")).toContain("may be larger");
  });

  it("acce-5: the tooltip's facts reach assistive tech through a .vh copy", () => {
    // `title` never opens for keyboard, touch or most screen readers, and it
    // was the only copy of the shared files and the keys folded into "1 more".
    const { container } = renderQueue(
      [
        colliding([
          { taskKey: "VIB-9", prNumber: 9, paths: ["a.ts"], partial: false },
          { taskKey: "VIB-10", prNumber: 10, paths: ["b.ts"], partial: false },
          { taskKey: "VIB-11", prNumber: 11, paths: ["a.ts"], partial: false },
        ]),
      ],
      [],
    );
    const chip = [...container.querySelectorAll("[title]")].find((e) =>
      (e.getAttribute("title") ?? "").includes("into conflict"),
    )!;
    const vh = chip.querySelector(".vh")!;
    expect(vh.textContent).toContain("VIB-11");
    expect(vh.textContent).toContain("Shared files: a.ts, b.ts");
    // The same sentence the pointer gets, and title stays as a mouse extra.
    expect(vh.textContent!.trim()).toBe(chip.getAttribute("title"));
  });

  it("renders nothing when no pull request collides", () => {
    const { container } = renderQueue([colliding([])], []);
    expect(container.textContent).not.toContain("collides with");
  });
});
