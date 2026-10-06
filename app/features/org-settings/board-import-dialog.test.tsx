// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createRoutesStub, useParams } from "react-router";
import type { BoardExportSummary } from "~/server/org/board-export.server";
import type { BoardImportPreview, BoardImportResource } from "~/server/org/board-import.server";
import { ToastProvider } from "~/ui/toast";
import { BoardImportDialog } from "./board-import-dialog";

/**
 * Ruling 653: the import dialog's own contract — what it posts (the file, the
 * form, and the choice made for each resource this instance holds
 * differently), and what it refuses to send. What the server does with the
 * post is `board-import.server.test.ts`'s and the route suite's.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * A file the request body can carry, as a browser's can: jsdom's `File` is
 * not one Node's `Request` encodes or parses back, and jsdom's `FormData`
 * turns Node's `File` into a string, so a test that posts runs on Node's pair
 * (the controller dock's tests do the same).
 */
async function postsLikeABrowser(): Promise<void> {
  const nodeForm = await new Response(new URLSearchParams("a=1")).formData();
  vi.stubGlobal("FormData", nodeForm.constructor);
  vi.stubGlobal("File", NodeFile);
}

function resource(kind: BoardImportResource["kind"], key: string, status: BoardImportResource["status"]): BoardImportResource {
  return { kind, key, label: key, detail: "2 files", status, createAs: status === "same" ? key : `${key}-2`, usedBy: ["Release Manager"] };
}

const PREVIEW: BoardImportPreview = {
  fileName: "release-train.viberr-board.zip",
  name: "Release Train",
  taskPrefix: "REL",
  description: "Ships a release.",
  suggestedName: "Release Train",
  exportedAt: "2026-10-04T12:00:00.000Z",
  exportedFrom: "release-train",
  viberrVersion: "0.19.0",
  stages: [
    { id: "draft", name: "Draft", color: "violet" },
    { id: "done", name: "Done", color: "green" },
  ],
  workflow: [{ from: "draft", to: "done", boundary: "human" }],
  delivers: "software",
  agents: [
    { profileId: "operator", name: "Operator", role: "Runs every task", backend: null, model: "", operator: true },
    { profileId: "release-manager", name: "Release Manager", role: "Release notes", backend: "claude", model: "sonnet", operator: false },
  ],
  guardrails: 4,
  gates: [],
  requiredReviewers: [],
  rulingsKb: null,
  resources: [
    resource("kb", "release-rulings", "differs"),
    resource("skill", "release-notes", "differs"),
    resource("mcp", "linear", "same"),
  ],
  problems: [],
  notes: [],
};

const BOARD: BoardExportSummary = {
  slug: "viberr-core",
  name: "Viberr Core",
  taskPrefix: "VIB",
  archived: false,
  stages: 5,
  agents: 3,
  skills: 0,
  knowledgeBases: 0,
  mcpServers: 0,
  missing: [],
};

function renderDialog(
  preview: BoardImportPreview,
  action: (args: { request: Request }) => Promise<{ ok: boolean; slug?: string; toast?: string; error?: string }>,
  props: { boards?: BoardExportSummary[]; onChooseAnother?: () => void } = {},
) {
  const file = new File(["zip"], preview.fileName, { type: "application/zip" });
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <ToastProvider>
          <BoardImportDialog
            file={file}
            preview={preview}
            boards={props.boards ?? [BOARD]}
            connections={["acme"]}
            connectionHealth={{ acme: "valid" }}
            onChooseAnother={props.onChooseAnother ?? (() => {})}
            onClose={() => {}}
          />
        </ToastProvider>
      ),
    },
    { path: "/org/settings", action },
    { path: "/projects/:slug/board", Component: () => <div>board {useParams().slug}</div> },
  ]);
  return render(<Stub initialEntries={["/"]} />);
}

describe("ruling 653: the board import dialog", () => {
  it("posts the file, the new project and the choice made for each resource held differently here", async () => {
    // CANARY: post the choices under another key, or leave out a resource the
    // person did not touch (the server reads its absence as copy), and an
    // import does what nobody chose.
    await postsLikeABrowser();
    let posted: FormData | null = null;
    const { getByRole, findByText } = renderDialog(PREVIEW, async ({ request }) => {
      posted = await request.formData();
      return { ok: true, slug: "release-train", toast: "Release Train imported as REL: 2 stages, 2 agents." };
    });
    const rulings = getByRole("radiogroup", { name: "What to do with release-rulings" });
    fireEvent.click(within(rulings).getByRole("radio", { name: "Use this instance's" }));
    fireEvent.click(getByRole("button", { name: "Import board" }));
    expect(await findByText("board release-train")).toBeTruthy();
    const form = posted!;
    expect(form.get("intent")).toBe("board-import");
    const sent = form.get("file");
    if (!(sent instanceof NodeFile)) throw new Error("the form carried the file as a string");
    expect(sent.name).toBe("release-train.viberr-board.zip");
    expect([form.get("name"), form.get("key"), form.get("owner"), form.get("repoName")]).toEqual([
      "Release Train",
      "REL",
      "acme",
      "release-train",
    ]);
    expect(JSON.parse(String(form.get("choices")))).toEqual({
      "kb:release-rulings": "existing",
      "skill:release-notes": "copy",
    });
  });

  it("ruling 667: a board none of whose agents writes a repository imports without one, unless the person attaches it", async () => {
    // CANARY: require a connection and a repository whatever the board
    // delivers and a no-code board cannot be imported on an instance with no
    // GitHub connection; post them whatever `needsRepo` says and it is bound
    // to the repository its name happened to spell.
    await postsLikeABrowser();
    const posts: FormData[] = [];
    const results = { ...PREVIEW, delivers: "results" as const };
    const { container, getByRole, getByLabelText } = renderDialog(results, async ({ request }) => {
      posts.push(await request.formData());
      return { ok: false, error: "held for the test" };
    });
    expect(container.textContent).toContain("None of this board's agents writes a repository, so it needs none.");
    expect(container.querySelector("#np-repo")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Import board" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect([posts[0]!.get("owner"), posts[0]!.get("repoName")]).toEqual(["", ""]);

    fireEvent.click(getByLabelText("Attach a repository for the agents to read"));
    expect(container.querySelector("#np-repo")).not.toBeNull();
    fireEvent.click(getByRole("button", { name: "Import board" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect([posts[1]!.get("owner"), posts[1]!.get("repoName")]).toEqual(["acme", "release-train"]);
  });

  it("ruling 672: a board whose agents write a repository imports without one when the person connects it later", async () => {
    // CANARY: require a repository of every software board and one exported
    // from an instance cannot be brought up before its repository exists.
    await postsLikeABrowser();
    const posts: FormData[] = [];
    const { container, getByRole, getByLabelText } = renderDialog(PREVIEW, async ({ request }) => {
      posts.push(await request.formData());
      return { ok: false, error: "held for the test" };
    });
    expect(container.textContent).toContain("This board's agents write a repository, and each task ships as a pull request.");
    expect(container.querySelector("#np-repo")).not.toBeNull();
    fireEvent.click(getByLabelText("Connect the repository later"));
    expect(container.querySelector("#np-repo")).toBeNull();
    expect(container.textContent).toContain("The board starts with no repository.");
    fireEvent.click(getByRole("button", { name: "Import board" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect([posts[0]!.get("owner"), posts[0]!.get("repoName"), posts[0]!.get("createRepository")]).toEqual(["", "", null]);
  });

  it("refuses a name whose project already exists, sending nothing", async () => {
    // CANARY: drop the taken-slug check and the server's 409 is the person's
    // first word of it, after the upload.
    const action = vi.fn(async () => ({ ok: true }));
    const { getByRole, findByRole } = renderDialog({ ...PREVIEW, suggestedName: "Viberr Core" }, action);
    fireEvent.click(getByRole("button", { name: "Import board" }));
    expect((await findByRole("alert")).textContent).toBe(
      "A project at projects/viberr-core already exists. Give the board another name.",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("shows every problem of a file that cannot be imported, and offers the fixed file instead of Import", async () => {
    // CANARY: show only the first problem, or keep Import on screen, and a
    // person fixes one line per round trip or presses a button that refuses.
    const chooseAnother = vi.fn();
    const problems = ["board.md has a key Viberr does not read: `stage`.", "board.md: two stages have the id `draft`."];
    const { getByRole, queryByRole, getAllByRole } = renderDialog({ ...PREVIEW, problems }, async () => ({ ok: true }), {
      onChooseAnother: chooseAnother,
    });
    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual(problems);
    expect(queryByRole("button", { name: "Import board" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Choose the fixed file" }));
    expect(chooseAnother).toHaveBeenCalledOnce();
    await waitFor(() => expect(queryByRole("textbox", { name: /Project name/ })).toBeNull());
  });
});
