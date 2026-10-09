// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createRoutesStub, useParams } from "react-router";
import { ToastProvider } from "~/ui/toast";
import { NewProjectModal } from "./new-project-modal";

/**
 * Pass-19 UX coherence audit — two findings on this one dialog.
 *
 * #14 (empty & error states): creating a project is deliberately self-serve for
 * ANY org member, but it needs a repository, so a connectionless instance sends
 * every member through this note. It was a live link into /org/settings, which
 * is `requireRole(…, "admin")` — a member clicked the instruction they were
 * given and got a bare 403 splash. OrgTile and the user menu had already been
 * fixed for exactly this (B-FD4); this dialog was the surface left over.
 *
 * #20 (a11y): success on the Create button toasts (the app's one announcer) and
 * the pre-submit blocker hint carries `role="status"`, but the SERVER's refusal
 * rendered in a roleless `.form-err` — the one branch nobody was told about.
 */

afterEach(cleanup);

/** The create-project action's reply, as NewProjectModal's own fetcher declares it. */
interface CreateProjectReply {
  ok: boolean;
  key?: string;
  slug?: string;
  storePath?: string;
  repoWarning?: string | null;
  repoNote?: string | null;
  error?: string;
}

function renderModal(
  props: Partial<Parameters<typeof NewProjectModal>[0]> = {},
  action: (args: { request: Request }) => Promise<CreateProjectReply> = async () => ({
    ok: true,
  }),
) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <NewProjectModal
            connections={[]}
            connectionHealth={{}}
            storeRoot={null}
            isAdmin={false}
            onClose={() => {}}
            {...props}
          />
        </ToastProvider>
      ),
      action,
    },
    { path: "/projects/:slug/board", Component: () => <div>board {useParams().slug}</div> },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

/** The "This board delivers" chip, by its first word (ruling 224). */
const deliversChip = (container: HTMLElement, word: "Software" | "Results") =>
  [...container.querySelectorAll<HTMLButtonElement>("button.pick-chip")].find((b) =>
    b.textContent!.trim().startsWith(word),
  )!;

/** One GitHub connection whose token passed its last check. */
const withConnection = {
  connections: ["akin-ozer"],
  connectionHealth: { "akin-ozer": "valid" as const },
};

/** Name the project "Estimates", apply `pick`, press Create; resolves with the
 *  posted form and the view. */
async function submitWith(
  props: Parameters<typeof renderModal>[0],
  pick: (container: HTMLElement) => void,
) {
  let posted: FormData | null = null;
  const view = renderModal(props, async ({ request }) => {
    posted = await request.formData();
    return { ok: false, error: "held for the test" };
  });
  fireEvent.change(view.container.querySelector("#np-name")!, { target: { value: "Estimates" } });
  pick(view.container);
  fireEvent.click(view.getByText("Create project"));
  await waitFor(() => expect(posted).not.toBeNull());
  return { form: posted!, view };
}

describe("#14: the zero-connections note never hands a member a 403", () => {
  const orgSettingsLink = (container: HTMLElement) =>
    container.querySelector('a[href^="/org/settings"]');
  /** Ruling 224: with no connection the dialog opens on a board that needs
   *  none, so the note stands behind the software choice. */
  const renderSoftware = (props: Parameters<typeof renderModal>[0]) => {
    const view = renderModal(props);
    fireEvent.click(deliversChip(view.container, "Software"));
    return view;
  };

  it("an org ADMIN keeps the link — they are the one who can add the PAT", () => {
    const { container } = renderSoftware({ isAdmin: true });
    expect(container.textContent).toContain("No GitHub connections yet");
    expect(orgSettingsLink(container)).not.toBeNull();
  });

  it("a MEMBER is told who adds it instead of being handed the admin-only door", () => {
    const { container } = renderSoftware({ isAdmin: false });
    const text = container.textContent ?? "";
    expect(text).toContain("No GitHub connections yet");
    expect(orgSettingsLink(container)).toBeNull();
    // Not merely link-less: the member is left with a next step they can take.
    expect(text).toContain("An org admin adds the PAT");
    expect(text).toContain("Ask an admin");
  });
});

/**
 * Ruling 224: the dialog asks what the board delivers. Software needs a
 * repository, as every project did; results needs none, and takes one only
 * when the person attaches it for the agents to read.
 */
describe("ruling 224: a board that delivers results needs no repository", () => {
  const repoField = (container: HTMLElement) => container.querySelector("#np-repo");
  const attachBox = (container: HTMLElement) =>
    [...container.querySelectorAll("label")]
      .find((l) => l.textContent!.includes("Attach a repository for the agents to read"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

  it("opens on results where no connection exists, asks for no repository, and posts none", async () => {
    // CANARY: keep `effOwner.length > 0` in `ok` whatever the board delivers
    // and an instance with no GitHub connection cannot create its first board.
    const view = renderModal();
    expect(deliversChip(view.container, "Results").getAttribute("aria-pressed")).toBe("true");
    expect(repoField(view.container)).toBeNull();
    expect(view.container.textContent).not.toContain("No GitHub connections yet");
    cleanup();

    const { form } = await submitWith({}, () => {});
    expect(form.get("delivers")).toBe("results");
    expect(form.get("owner")).toBe("");
    expect(form.get("repoName")).toBe("");
  });

  it("opens on software where a connection exists, and a software board with no connection is refused by name", () => {
    const withOne = renderModal(withConnection);
    expect(deliversChip(withOne.container, "Software").getAttribute("aria-pressed")).toBe("true");
    expect(repoField(withOne.container)).not.toBeNull();
    expect(attachBox(withOne.container)).toBeNull();
    cleanup();

    const { container, getByText } = renderModal();
    fireEvent.change(container.querySelector("#np-name")!, { target: { value: "Website" } });
    fireEvent.click(deliversChip(container, "Software"));
    fireEvent.click(getByText("Create project"));
    expect(container.querySelector("#np-block-reason")!.textContent).toBe("Pick a GitHub connection.");
  });

  it("drops the repository when results is chosen, and takes one back when the person attaches it", async () => {
    // CANARY: post `effOwner` and `effRepo` whatever `needsRepo` says and a
    // results board is bound to the repository its name happened to spell.
    const { form: none } = await submitWith(withConnection, (c) => fireEvent.click(deliversChip(c, "Results")));
    expect(none.get("delivers")).toBe("results");
    expect(none.get("owner")).toBe("");
    expect(none.get("repoName")).toBe("");
    cleanup();

    const { form: attached } = await submitWith(withConnection, (c) => {
      fireEvent.click(deliversChip(c, "Results"));
      expect(repoField(c)).toBeNull();
      fireEvent.click(attachBox(c)!);
      expect(repoField(c)).not.toBeNull();
      expect(c.textContent).toContain("The agents read it and commit nothing to it.");
    });
    expect(attached.get("delivers")).toBe("results");
    expect(attached.get("owner")).toBe("akin-ozer");
    expect(attached.get("repoName")).toBe("estimates");
  });

  /**
   * Ruling 224 (owner, 2026-10-06): "repoless boards should exist … at
   * creation". A software board says it will connect its repository later,
   * and is created with none.
   */
  const laterBox = (container: HTMLElement) =>
    [...container.querySelectorAll("label")]
      .find((l) => l.textContent!.includes("Connect the repository later"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

  it("ruling 224: a software board can connect its repository later: the fields go, the hint says what happens, and none is posted", async () => {
    // CANARY: keep `needsRepo` true for every software board and the box
    // changes nothing, so a person with no repository yet cannot create one;
    // post the derived repository anyway and the board is bound to a name
    // nobody chose.
    const { form } = await submitWith(withConnection, (c) => {
      expect(c.textContent).toContain("Agents change a repository and each task ships as a pull request.");
      fireEvent.click(laterBox(c)!);
      expect(repoField(c)).toBeNull();
      expect(c.textContent).toContain(
        "The board starts with no repository. Tasks come back as files until one is connected, and the operator asks for it the first time a task needs a pull request.",
      );
    });
    expect(form.get("delivers")).toBe("software");
    expect(form.get("owner")).toBe("");
    expect(form.get("repoName")).toBe("");
    expect(form.get("createRepository")).toBeNull();
  });

  it("ruling 224: with no GitHub connection a software board is still creatable, once it says it connects later", async () => {
    // CANARY: block a software board on a connection whatever the box says
    // and an instance with no connection can only make a no-code board.
    const { form } = await submitWith({}, (c) => {
      fireEvent.click(deliversChip(c, "Software"));
      expect(c.textContent).toContain("No GitHub connections yet");
      fireEvent.click(laterBox(c)!);
      expect(c.textContent).not.toContain("No GitHub connections yet");
    });
    expect(form.get("delivers")).toBe("software");
    expect([form.get("owner"), form.get("repoName")]).toEqual(["", ""]);
    // The results choice has its own box, and not this one.
    const view = renderModal();
    expect(laterBox(view.container)).toBeNull();
  });
});

describe("Q26-3: a task key already used by another project is flagged (not blocked)", () => {
  it("notes the collision when the resolved key matches an existing project's", () => {
    const { getByLabelText, getByText } = renderModal({
      existingKeys: ["VIB", "PAY"],
    });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "vib" } });
    expect(getByText(/Another project already uses VIB/)).toBeTruthy();
  });

  it("shows the normal hint for a unique key", () => {
    const { getByLabelText, getByText, queryByText } = renderModal({
      existingKeys: ["VIB"],
    });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "QAX" } });
    expect(queryByText(/already uses/)).toBeNull();
    expect(getByText(/ids look like QAX-1/)).toBeTruthy();
  });

  it("does not flag a 1-letter partial key as a collision", () => {
    const { getByLabelText, queryByText } = renderModal({ existingKeys: ["V"] });
    fireEvent.change(getByLabelText("Task key"), { target: { value: "v" } });
    // Too short to be a real key yet — the "at least 2 letters" hint owns it.
    expect(queryByText(/already uses/)).toBeNull();
  });
});

describe("N20-11: the repo field says the owner is fixed by the connection", () => {
  it("names the connection owner and tells the typist to enter just the repo name", () => {
    const { container } = renderModal(withConnection);
    const text = container.textContent ?? "";
    expect(text).toContain("Owner is fixed by the");
    expect(text).toContain("Enter just the");
    // The fixed owner is named, so a `owner/name` entry is visibly redundant.
    expect(text).toContain("akin-ozer");
  });
});

/**
 * Ruling 225 (F40-5): the modal offers the same choice as the controller's
 * `create_project`: create the repository on GitHub when it does not exist,
 * private by default. The intent carries it as one field, and the success
 * toast says what became of the repository.
 */
describe("ruling 225: the modal can ask for the repository to be created", () => {
  const box = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll("label")]
      .find((l) => l.textContent!.includes(label))!
      .querySelector<HTMLInputElement>('input[type="checkbox"]')!;

  it("is off by default and sends nothing", async () => {
    // CANARY: default `createRepo` to true and a typo becomes a repository.
    const { form, view } = await submitWith(withConnection, () => {});
    expect(box(view.container, "Create this repository on GitHub").checked).toBe(false);
    expect(view.container.textContent).not.toContain("Create it as a private repository");
    expect(form.get("createRepository")).toBeNull();
  });

  it("checked, it asks for a private repository unless the private box is cleared", async () => {
    // CANARY: drop the `fd.set("createRepository", …)` line and both reads are null.
    const privateRun = await submitWith(withConnection, (c) =>
      fireEvent.click(box(c, "Create this repository on GitHub")),
    );
    expect(box(privateRun.view.container, "Create it as a private repository").checked).toBe(true);
    expect(privateRun.form.get("createRepository")).toBe("private");
    cleanup();

    const publicRun = await submitWith(withConnection, (c) => {
      fireEvent.click(box(c, "Create this repository on GitHub"));
      fireEvent.click(box(c, "Create it as a private repository"));
    });
    expect(publicRun.form.get("createRepository")).toBe("public");
  });

  it("the success toast carries what became of the repository", async () => {
    const { getByText, container } = renderModal(withConnection, async () => ({
      ok: true,
      key: "WEB",
      slug: "website",
      storePath: "projects/website",
      repoWarning: null,
      repoNote: "Created akin-ozer/website on GitHub (private).",
    }));
    fireEvent.change(container.querySelector("#np-name")!, { target: { value: "Website" } });
    fireEvent.click(box(container, "Create this repository on GitHub"));
    fireEvent.click(getByText("Create project"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "WEB initialized. Task store created at projects/website. Created akin-ozer/website on GitHub (private).",
      ),
    );
  });
});

describe("F15-04: creating a project lands you in it", () => {
  it("navigates to the new project's board instead of the home grid", async () => {
    // CANARY: drop the success effect's `navigate(…/board)` and the stub never
    // leaves the modal's route.
    const { container, getByText, findByText } = renderModal(
      withConnection,
      async () => ({ ok: true, key: "NEW", slug: "new-project", storePath: "projects/new-project" }),
    );
    fireEvent.change(container.querySelector("#np-name")!, { target: { value: "New Project" } });
    fireEvent.click(getByText("Create project"));
    await findByText("board new-project");
  });
});

describe("#20: the server's refusal is announced, not just drawn", () => {
  it("renders the create failure in a live region", async () => {
    const { container, getByPlaceholderText, getByText } = renderModal(
      withConnection,
      async () => ({ ok: false, error: "projects/payments already exists." }),
    );
    fireEvent.change(getByPlaceholderText("e.g. Payments Gateway"), {
      target: { value: "Payments" },
    });
    fireEvent.click(getByText("Create project"));

    const err = await waitFor(() => {
      const node = container.querySelector(".form-err");
      expect(node).not.toBeNull();
      return node!;
    });
    expect(err.textContent).toContain("projects/payments already exists.");
    expect(err.getAttribute("role")).toBe("alert");
  });
});

/**
 * Interface review 2026-09-06: the primary used to be hard-disabled (with an
 * inline `pointer-events: none`) until the form was valid, so a click on Create
 * gave no feedback and the button was missing from the tab order. It stays
 * enabled now; a refused submit turns the blocker into an alert, marks the
 * field it names and moves focus there.
 */
describe("Create project stays enabled and refuses with the field named", () => {
  const createButton = (container: HTMLElement) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent!.trim() === "Create project",
    )!;

  it("opens with an enabled primary and no field accused", () => {
    const { container } = renderModal(withConnection);
    const create = createButton(container);
    expect(create.disabled).toBe(false);
    expect(create.getAttribute("style")).toBeNull();
    expect(create.getAttribute("title")).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    // The blocker explains itself before any attempt, as a status line.
    const blocker = container.querySelector("#np-block-reason")!;
    expect(blocker.getAttribute("role")).toBe("status");
    expect(blocker.className).not.toContain("err");
  });

  it("refuses an empty form: the name is marked, described and focused", async () => {
    let posted = 0;
    const { container } = renderModal(withConnection, async () => {
      posted += 1;
      return { ok: true };
    });
    fireEvent.click(createButton(container));
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe("np-block-reason");
    expect(document.activeElement).toBe(name);
    const blocker = container.querySelector("#np-block-reason")!;
    expect(blocker.textContent).toBe("Enter a project name (2+ characters).");
    expect(blocker.getAttribute("role")).toBe("alert");
    expect(blocker.className).toContain("err");
    await act(async () => {});
    expect(posted).toBe(0);
  });

  it("re-inserts the blocker as a fresh alert on every refusal", () => {
    const { container } = renderModal(withConnection);
    const before = container.querySelector("#np-block-reason")!;
    fireEvent.click(createButton(container));
    const first = container.querySelector("#np-block-reason")!;
    // Readers announce an alert's insertion, not a role flip on the same
    // node with the same text, so the refusal has to mount a new element.
    expect(first).not.toBe(before);
    expect(first.getAttribute("role")).toBe("alert");
    fireEvent.click(createButton(container));
    expect(container.querySelector("#np-block-reason")).not.toBe(first);
  });

  it("moves the flag to the key when the name yields no letters, keeping the strip note described", () => {
    const { container } = renderModal(withConnection);
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "1234" },
    });
    fireEvent.click(createButton(container));
    const name = container.querySelector<HTMLInputElement>("#np-name")!;
    const key = container.querySelector<HTMLInputElement>("#np-key")!;
    expect(name.getAttribute("aria-invalid")).toBeNull();
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(key.getAttribute("aria-describedby")).toBe("np-key-note np-block-reason");
    expect(document.activeElement).toBe(key);
  });

  it("submits a valid form from the same click path", async () => {
    let posted = 0;
    const { container } = renderModal(withConnection, async () => {
      posted += 1;
      return { ok: false, error: "refused for the test" };
    });
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "Payments" },
    });
    expect(container.querySelector("#np-block-reason")).toBeNull();
    expect(container.querySelector('[aria-invalid="true"]')).toBeNull();
    fireEvent.click(createButton(container));
    await waitFor(() => expect(posted).toBe(1));
  });
});

describe("the Workflow field states the starting board, it does not pretend to pick it", () => {
  it("renders a statement, not a selected option nobody can change", () => {
    const { container, getByText } = renderModal();
    // `.pick-chip` is the option BUTTON class in every other field of this
    // dialog and `.on` is its selected fill, so a one-option picker read as a
    // control you cannot use, and `aria-disabled` on a role-less span told
    // assistive tech nothing.
    expect(getByText("Workflow")).toBeTruthy();
    expect(
      container.textContent,
    ).toContain("Starts on the Standard · 5 stages board");
    expect(container.querySelector(".pick-chip:not(button)")).toBeNull();
    expect(container.querySelector("span[aria-disabled]")).toBeNull();
  });
});

/**
 * 2026-09-07, owner report with a screenshot: the key-collision note flipped
 * to "Another project already uses PA" for the last ~300ms of a SUCCESSFUL
 * create, then the dialog closed. `existingKeys` is the home loader's project
 * list, and `/` revalidates it on the all-projects live scope, which fires the
 * moment the new project is projected, still mid-request (createProject
 * writes and re-projects before it proves the credential and returns). Read
 * live, the list then carried the very key being created. The note now reads
 * the list as it was when Create was pressed and goes live again once a
 * refused submit has settled, so a collision that appeared meanwhile is still
 * shown.
 *
 * Same block: the primary shows the request in flight the way the app's other
 * busy buttons already do (and reui's "spinner in button" pattern the owner
 * pointed at): a spinning loader glyph in place of the plus, "Creating
 * project…" in place of the label, `aria-busy` and `disabled` until the server
 * answers.
 */
describe("the create request in flight", () => {
  /** A create action the TEST answers, when it decides to. */
  function heldAction() {
    let answer: (reply: CreateProjectReply) => void = () => {};
    let posted = 0;
    const reply = new Promise<CreateProjectReply>((resolve) => {
      answer = resolve;
    });
    return {
      action: async () => {
        posted += 1;
        return reply;
      },
      answer: (reply: CreateProjectReply) => answer(reply),
      posted: () => posted,
    };
  }
  const primary = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(".modal-foot .btn.primary")!;

  /** The handle the stub page hands out for replacing its project list. */
  interface LiveList {
    setKeys?: (keys: string[]) => void;
  }

  /**
   * The stub page OWNS `existingKeys`, so a test can play the home loader's
   * mid-request revalidation by handing the modal a new list.
   */
  function renderLive(action: () => Promise<CreateProjectReply>) {
    const live: LiveList = {};
    function Page() {
      const [keys, setKeys] = useState<string[]>([]);
      useEffect(() => {
        live.setKeys = setKeys;
      }, []);
      return (
        <ToastProvider>
          <NewProjectModal
            {...withConnection}
            storeRoot={null}
            isAdmin={false}
            existingKeys={keys}
            onClose={() => {}}
          />
        </ToastProvider>
      );
    }
    const Stub = createRoutesStub([
      { path: "/", Component: Page, action },
      { path: "/projects/:slug/board", Component: () => <div>board</div> },
    ]);
    const rendered = render(<Stub initialEntries={["/"]} />);
    // Every text the key note ever showed, so a flip that lasts a single
    // render is still caught after the fact.
    const noteTexts: string[] = [];
    const watch = new MutationObserver(() => {
      const note = rendered.container.querySelector("#np-key-note");
      if (note) noteTexts.push(note.textContent ?? "");
    });
    watch.observe(rendered.container, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return {
      ...rendered,
      listNowCarries: (keys: string[]) => act(() => live.setKeys!(keys)),
      noteTexts,
      stopWatching: () => watch.disconnect(),
    };
  }

  it("keeps the collision note quiet while the list starts carrying the key being created", async () => {
    const server = heldAction();
    const { container, queryByText, getByText, findByText, noteTexts, listNowCarries, stopWatching } =
      renderLive(server.action);
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "Payments" },
    });
    fireEvent.click(primary(container));
    await waitFor(() => expect(server.posted()).toBe(1));

    // The new project is projected, the live scope revalidates, and the
    // list lists PAY while the request is still open.
    listNowCarries(["PAY"]);
    expect(queryByText(/already uses/)).toBeNull();
    expect(getByText(/ids look like PAY-1/)).toBeTruthy();

    await act(async () => {
      server.answer({ ok: true, key: "PAY", slug: "payments", storePath: "projects/payments" });
    });
    // F15-04 lands in the new project; up to that unmount the note never flipped.
    await findByText("board");
    stopWatching();
    expect(noteTexts.filter((t) => /already uses/.test(t))).toEqual([]);
  });

  it("reads the live list again once a refused submit has settled", async () => {
    const server = heldAction();
    const { container, queryByText, getByText, stopWatching, listNowCarries } =
      renderLive(server.action);
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "Payments" },
    });
    fireEvent.click(primary(container));
    await waitFor(() => expect(server.posted()).toBe(1));
    listNowCarries(["PAY"]);
    expect(queryByText(/already uses/)).toBeNull();

    await act(async () => {
      server.answer({ ok: false, error: "refused for the test" });
    });
    await waitFor(() =>
      expect(container.querySelector(".form-err")).not.toBeNull(),
    );
    // Settled and refused: PAY really is in use now, and the note says so.
    expect(getByText(/Another project already uses PAY/)).toBeTruthy();
    stopWatching();
  });

  it("spins a loader on the primary and reads 'Creating project…' until the server answers", async () => {
    const server = heldAction();
    const { container } = renderModal(withConnection, server.action);
    fireEvent.change(container.querySelector("#np-name")!, {
      target: { value: "Payments" },
    });
    const create = primary(container);
    expect(create.textContent!.trim()).toBe("Create project");
    // Ruling 284: the plus and the loader share one cell (GlyphSwap) and trade
    // on `data-copied`; at rest the plus shows and the loader rests hidden.
    const cell = create.querySelector(".copy-glyph")!;
    expect(cell.hasAttribute("data-copied")).toBe(false);
    expect(cell.querySelectorAll("svg.ico")).toHaveLength(2);

    fireEvent.click(create);
    await waitFor(() => expect(create.getAttribute("aria-busy")).toBe("true"));
    expect(create.disabled).toBe(true);
    expect(create.textContent!.trim()).toBe("Creating project…");
    // The spinning loader trades in for the plus, in the same cell.
    expect(cell.getAttribute("data-copied")).toBe("true");
    expect(cell.lastElementChild!.matches("svg.ico.spin")).toBe(true);
    expect(create.querySelector(".copy-glyph")).toBe(cell);

    await act(async () => {
      server.answer({ ok: false, error: "refused for the test" });
    });
    await waitFor(() =>
      expect(container.querySelector(".form-err")).not.toBeNull(),
    );
    // Back to the resting label and glyph, enabled again for the retry.
    expect(create.getAttribute("aria-busy")).not.toBe("true");
    expect(create.disabled).toBe(false);
    expect(create.textContent!.trim()).toBe("Create project");
    expect(cell.hasAttribute("data-copied")).toBe(false);
  });
});
