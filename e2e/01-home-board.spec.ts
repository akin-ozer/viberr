import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Golden path (a): login (via stored session) → Home renders the three
 * seeded projects → open the viberr-core board → stage columns render
 * with the VIB-142 card in Review.
 *
 * Plus the board's drag-and-drop stage moves (dnd-kit): real pointer input —
 * down, stepped moves (crossing the activation distance), up. The server
 * stays authoritative, so every assertion is on the submitted governed
 * request, the settled toast, and the revalidated column — never on
 * optimistic client order. Between a cross-lane drop and the server's answer
 * a landing preview stands in the requested slot, drawn with the card's own
 * face; it is a `div.card`, the real card an `a.card`, so a column read after
 * a drop counts `a.card` only.
 */

function column(page: Page, name: string): Locator {
  return page
    .locator("section.column")
    .filter({ has: page.locator(".col-head .nm", { hasText: name }) });
}

/** The next governed reorder POST whose form body satisfies `match`. */
function reorderPost(page: Page, match: (body: string) => boolean) {
  return page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.url().includes("/projects/viberr-core/board") &&
      (request.postData() ?? "").includes("intent=reorder") &&
      match(request.postData() ?? ""),
  );
}

/** Lift `key`'s card and hold it over the centre of `target` without
 *  releasing (the old `bottom`/`center` aim modes are gone). */
async function liftOver(
  page: Page,
  key: string,
  target: Locator,
): Promise<void> {
  const card = page.locator(".card-wrap", { hasText: key }).first();
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
}

test("home renders the three seeded projects", async ({ page }) => {
  await page.goto("/");

  const cards = page.locator(".pj-card, .pj-row");
  await expect(cards).toHaveCount(3);
  await expect(page.getByText("Viberr Core").first()).toBeVisible();
});

test("viberr-core board renders stage columns and the VIB-142 card", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('a[href="/projects/viberr-core/board"]')
    .first()
    .click();
  await page.waitForURL("**/projects/viberr-core/board");

  // Five seeded stages, one column each.
  const columns = page.locator("section.column");
  await expect(columns).toHaveCount(5);
  for (const stage of ["Triage", "Ready", "In Progress", "Review", "Done"]) {
    await expect(
      page.locator("section.column .col-head").getByText(stage, { exact: true }),
    ).toBeVisible();
  }

  // VIB-142 card is on the board and links to the task workspace.
  const card = page.locator("a.card", { hasText: "VIB-142" });
  await expect(card).toBeVisible();
  await card.click();
  await page.waitForURL("**/projects/viberr-core/tasks/VIB-142");
  await expect(page.getByText("VIB-142").first()).toBeVisible();
});

test("same-stage pointer reorder submits a non-append slot and the server order lands", async ({
  page,
}, testInfo) => {
  await page.goto("/projects/viberr-core/board");
  await expect(column(page, "In Progress")).toBeVisible();

  // VIB-153 sits below VIB-151 in the seeded In Progress column. Drag it over
  // VIB-151's TOP half → "insert before VIB-151", a real non-append slot.
  const target = page.locator(".card-wrap", { hasText: "VIB-151" }).first();
  const card = page.locator(".card-wrap", { hasText: "VIB-153" }).first();
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  const to = (await target.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + 8, { steps: 12 });

  // Mid-drag (owner, 2026-09-08: the faded ghost the card used to leave read
  // as "a shadow of itself as if it were another task"). The card in hand is
  // the source element, solid; the slot it left is a hole — the same box with
  // its face hidden; and the one preview stands in the slot the drop will
  // submit, right before VIB-151. The hole is dnd-kit's clone of the card, so
  // the two are told apart by dnd-kit's attributes, never by a class.
  const preview = page.locator(".card-drop-preview");
  await expect(preview).toHaveCount(1);
  await expect(preview).toBeVisible();
  await expect(page.locator(".drop-preview + .card-wrap")).toHaveAttribute(
    "data-card-key",
    "VIB-151",
  );
  const lifted = page.locator(".card-wrap[data-dnd-dragging]");
  await expect(lifted).toHaveCount(1);
  await expect(lifted).toHaveAttribute("data-card-key", "VIB-153");
  await expect(lifted.locator(".card")).toHaveCSS("opacity", "1");
  await expect(lifted.locator(".key")).toBeVisible();
  const hole = page.locator(".card-wrap[data-dnd-placeholder]");
  await expect(hole).toHaveCount(1);
  await expect(hole).toHaveAttribute("data-card-key", "VIB-153");
  await expect(hole.locator(".key")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("a2-mid-drag.png") });

  const request = reorderPost(
    page,
    (body) =>
      body.includes("taskKey=VIB-153") &&
      body.includes("to=impl") &&
      body.includes("beforeKey=VIB-151"),
  );
  await page.mouse.up();
  await request;

  // A drop is not a click: releasing over a card must not navigate.
  await expect(page).toHaveURL(/\/projects\/viberr-core\/board/);

  // The revalidated column carries the server's order: VIB-153 above VIB-151
  // (real cards only, per the note at the top of this file).
  await expect
    .poll(async () =>
      (await column(page, "In Progress").locator("a.card .key").allTextContents()).slice(0, 2),
    )
    .toEqual(["VIB-153", "VIB-151"]);
});

test("cross-stage drop onto a column body appends and the card changes column", async ({
  page,
}, testInfo) => {
  await page.goto("/projects/viberr-core/board");
  const triage = column(page, "Triage");
  await expect(triage).toBeVisible();

  // The APPEND slot, by the board's slot rule (board-dnd.ts `slotInLane`):
  // the pointer over the LAST card's bottom half asks for the card after it —
  // none, so the lane's end — and the preview drawn there moves nothing above
  // it, so the slot holds under the pointer. The approach decides it: crossing
  // an earlier card's bottom half on the way in opens the preview ABOVE the
  // last card and pushes that card down, and a preview keeps its slot while
  // the pointer is over it (the fix for the drop preview that traded places
  // with a card ten times a second). So VIB-148 is carried down its own lane
  // first — nothing there touches Triage — and then straight across into the
  // last Triage card's bottom half.
  const lastTriageCard = triage.locator(".card-wrap").last();
  await lastTriageCard.scrollIntoViewIfNeeded();
  const last = (await lastTriageCard.boundingBox())!;
  const y = last.y + last.height * 0.75;
  const card = page.locator(".card-wrap", { hasText: "VIB-148" }).first();
  const from = (await card.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, y, { steps: 8 });
  await page.mouse.move(last.x + last.width / 2, y, { steps: 12 });

  // The preview stands after every card in the lane: the slot the drop is
  // about to submit.
  await expect(page.locator(".card-drop-preview")).toBeVisible();
  await expect(triage.locator(".col-body > .card-wrap").last()).toHaveClass(
    /\bdrop-preview\b/,
  );

  const request = reorderPost(
    page,
    (body) => body.includes("taskKey=VIB-148") && body.includes("to=triage"),
  );
  await page.mouse.up();
  const submitted = await request;
  // Column-body drop is an append: the slot is empty.
  expect(submitted.postData()).toContain("beforeKey=");
  expect(submitted.postData()).not.toContain("beforeKey=VIB");

  // The server's answer, not the landing preview: the real card is in Triage,
  // last, and gone from Ready.
  await expect(triage.locator("a.card", { hasText: "VIB-148" })).toBeVisible();
  await expect(triage.locator("a.card").last()).toContainText("VIB-148");
  await expect(
    column(page, "Ready").locator(".card", { hasText: "VIB-148" }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("a2-after-move.png") });
});

test("Escape cancels a lifted drag — no request, visuals cleared, card unmoved", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/board");
  const ready = column(page, "Ready");
  await expect(ready).toBeVisible();

  let reorders = 0;
  page.on("request", (request) => {
    if ((request.postData() ?? "").includes("intent=reorder")) reorders += 1;
  });

  await liftOver(page, "VIB-166", ready.locator(".col-body"));
  await expect(page.locator(".card-drop-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // Visuals cleared: no preview, and once the cancelled card has flown home,
  // neither dnd-kit's lifted card nor the hole it left. Until then the hole —
  // dnd-kit's clone of the card, its face in the DOM though never drawn —
  // stands in Triage beside it, so the lane holds two VIB-166 `.card`s.
  await expect(page.locator(".card-drop-preview")).toHaveCount(0);
  await expect(page.locator(".card-wrap[data-dnd-dragging]")).toHaveCount(0);
  await expect(page.locator(".card-wrap[data-dnd-placeholder]")).toHaveCount(0);
  const home = column(page, "Triage").locator(".card", { hasText: "VIB-166" });
  await expect(home).toHaveCount(1);
  await expect(home).toBeVisible();
  expect(reorders).toBe(0);
});

// Ruling 53 (R18-7/B1) put a confirm in front of the board drop, because
// "the most irreversible action in the product was also its most casual one".
// This test predated that and still asserted the OLD flow — drop, POST, error
// toast — so it waited for a request the confirm now withholds and timed out.
// CI has been red on main since. The behaviour it should pin is the shipped
// one: the drop ASKS first, dismissing writes nothing, and confirming still
// meets the server's verdict gate.
test("a Done-stage drop asks before it accepts, and dismissing writes nothing", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/board");
  const done = column(page, "Done");
  await expect(done).toBeVisible();

  let posts = 0;
  page.on("request", (r) => {
    if (
      r.method() === "POST" &&
      r.url().includes("/projects/viberr-core/board")
    ) {
      posts += 1;
    }
  });

  await liftOver(page, "VIB-142", done.locator(".col-body"));
  await page.mouse.up();

  // The confirm names the task and what accepting does, per ruling 20 (R15-1).
  // D3 (pass 20): the board now renders the ONE shared acceptance ceremony
  // (task-detail/accept-confirm), matched by its stable data-screen-label; its
  // aria-label carries the task key ("Accept by moving to Done: VIB-142").
  const confirm = page.locator(
    'dialog[data-screen-label="Accept completion dialog"]',
  );
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("VIB-142");
  await expect(confirm).toContainText("Merging is one-way");

  // "Not yet" is the escape, and it must write NOTHING.
  await confirm.getByRole("button", { name: "Not yet" }).click();
  await expect(confirm).toBeHidden();
  expect(posts).toBe(0);
  // `.first()`: the snap-back drop animation transiently overlays a clone of
  // the card, so strict mode would see two while it settles.
  await expect(
    column(page, "Review").locator(".card", { hasText: "VIB-142" }).first(),
  ).toBeVisible();
  await expect(done.locator(".card", { hasText: "VIB-142" })).toHaveCount(0);
});

test("confirming a Done-stage drop still meets the verdict gate, and the board snaps back", async ({
  page,
}) => {
  await page.goto("/projects/viberr-core/board");
  const done = column(page, "Done");
  await expect(done).toBeVisible();

  // VIB-142 is awaiting its verdict, so the governed transition must refuse it
  // even once the human has confirmed — the dialog discloses, it never grants.
  await liftOver(page, "VIB-142", done.locator(".col-body"));
  const request = reorderPost(page, (body) => body.includes("taskKey=VIB-142"));
  await page.mouse.up();

  const confirm = page.locator(
    'dialog[data-screen-label="Accept completion dialog"]',
  );
  await expect(confirm).toBeVisible();
  // The ceremony DISCLOSES the gate before the click: VIB-142 delivered a
  // revision its one required reviewer has not approved, so the Blocked row
  // carries the projected `acceptanceBlockedReason` — the same sentence the
  // server refuses the confirmed move with.
  await expect(confirm).toContainText(
    "Waiting on 1 required reviewer approval of the current revision.",
  );
  // The shared ceremony's confirm reads "Move → Done" in its stage-move mode
  // (with "& merge" appended because VIB-142 carries a PR).
  await confirm.getByRole("button", { name: /^Move → Done/ }).click();
  await request;

  // Any error toast used to satisfy this, and one of them was the WRONG
  // refusal: VIB-142 really has delivered a revision, the board's ceremony
  // disclosed "No delivered revision recorded." anyway, and ruling 88 made the
  // server refuse that stale echo ("VIB-142 changed after the accept dialog was
  // opened…") before the verdict gate this test is named for ever spoke. Pin the
  // gate's own words, so a board move refused for the wrong reason — or for a
  // broken ceremony — cannot pass as this behaviour.
  const toast = page.locator('.toast[data-kind="error"]');
  await expect(toast).toContainText(
    "Waiting on 1 required reviewer approval of the current revision.",
  );
  await expect(toast).not.toContainText("changed after the accept dialog");
  await expect(
    column(page, "Review").locator(".card", { hasText: "VIB-142" }).first(),
  ).toBeVisible();
  await expect(done.locator(".card", { hasText: "VIB-142" })).toHaveCount(0);
});
