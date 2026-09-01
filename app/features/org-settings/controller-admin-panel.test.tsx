// @vitest-environment jsdom
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelCatalog } from "~/server/runtimes/model-catalog.server";
import { ToastProvider } from "~/ui/toast";
import {
  ControllerAdminPanel,
  type ControllerConfigView,
} from "./controller-admin-panel";

/**
 * Ruling 106 locks: the controller settings tab speaks the agent editor's
 * language — the model/effort CATALOG pickers instead of a free-text model
 * field, pick-chip resource grants with removable red `missing` chips instead
 * of checkbox lists, and KB grants displayed by name while stored by dir.
 */

const CLAUDE_CATALOG: ModelCatalog = {
  models: [
    {
      value: "sonnet",
      displayName: "Claude Sonnet",
      description: "Balanced.",
      supportsEffort: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "opus",
      displayName: "Claude Opus",
      description: "Most capable.",
      supportsEffort: true,
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultModel: "sonnet",
  defaultEffort: "high",
};

const CONFIG: ControllerConfigView = {
  name: "Controller",
  model: "opus",
  effort: "max",
  skills: ["controller-guide"],
  kb: ["controller-handbook"],
  mcps: [],
  definition: "doctrine text",
  profilePresent: true,
};

const KBS = [
  {
    dir: "controller-handbook",
    name: "Controller handbook",
    uri: "store://kb/controller-handbook",
  },
];

afterEach(cleanup);

let lastForm: Record<string, string> | null = null;

/** A posted form field the panel sets (text only — the page-test rule). */
const textField = z.string();

function renderPanel(overrides: Partial<ControllerConfigView> = {}) {
  lastForm = null;
  const config = { ...CONFIG, ...overrides };
  const Stub = createRoutesStub([
    {
      path: "/org/settings",
      Component: () => (
        <ToastProvider>
          <ControllerAdminPanel
            config={config}
            kbs={KBS}
            skills={["controller-guide", "developer-expertise"]}
            mcps={["qa-echo"]}
          />
        </ToastProvider>
      ),
      action: async ({ request }) => {
        const fd = await request.formData();
        lastForm = {};
        for (const [k, v] of fd.entries()) {
          // The panel posts text fields only; a File entry names no field
          // these tests capture (the page-test harness's textField rule).
          const field = textField.safeParse(v);
          if (field.success) lastForm[k] = field.data;
        }
        return { ok: true, toast: "stub done" };
      },
    },
    {
      path: "/resources/model-catalog",
      loader: () => ({ data: CLAUDE_CATALOG }),
    },
  ]);
  return render(<Stub initialEntries={["/org/settings"]} />);
}

describe("ControllerAdminPanel (ruling 106: agent-editor parity)", () => {
  it("picks the model from the catalog select, not a free-text field", async () => {
    const { container, getByText } = renderPanel();
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Model"]',
    );
    expect(select).toBeTruthy();
    // The old panel's free-text model input is gone for good.
    expect(
      container.querySelector('input[placeholder*="model id or alias"]'),
    ).toBeNull();
    // Catalog answered: the stored model is the selected option, and the
    // catalog's own description renders under the select — the profile
    // editor's exact treatment.
    await waitFor(() => expect(select?.value).toBe("opus"));
    expect(getByText("Most capable.")).toBeTruthy();
  });

  it("seeds an empty stored model to the catalog default the runtime would use", async () => {
    const { container } = renderPanel({ model: "", effort: "" });
    const model = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Model"]',
    );
    await waitFor(() => expect(model?.value).toBe("sonnet"));
    // Effort defaults alongside (resolveRunModel/resolveRunEffort honesty).
    expect(
      container.querySelector<HTMLSelectElement>('select[aria-label="Effort"]')
        ?.value,
    ).toBe("high");
  });

  it("saves model, effort and the grants (KBs by dir) in one intent", async () => {
    const { container, getByText } = renderPanel();
    const model = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Model"]',
    );
    const effortSel = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Effort"]',
    );
    await waitFor(() => expect(model?.value).toBe("opus"));
    expect(effortSel).toBeTruthy();
    fireEvent.change(effortSel!, { target: { value: "xhigh" } });
    fireEvent.click(getByText("Save controller"));
    await waitFor(() => expect(lastForm).not.toBeNull());
    expect(lastForm).toMatchObject({
      intent: "controller-save",
      model: "opus",
      effort: "xhigh",
      definition: "doctrine text",
      skills: "controller-guide",
      // Granted + displayed by name in the chip, STORED by dir — the same
      // split the global-profile editor draws (P13-KM-01).
      kb: "controller-handbook",
      mcps: "",
    });
  });

  it("renders grants as toggle chips: KB by display name, aria-pressed state", async () => {
    const { getByRole, getByText } = renderPanel();
    // The KB chip shows the display NAME; the raw dir is not the label.
    const kbChip = getByRole("button", { name: /Controller handbook/ });
    expect(kbChip.getAttribute("aria-pressed")).toBe("true");
    const skillChip = getByRole("button", { name: /controller-guide/ });
    expect(skillChip.getAttribute("aria-pressed")).toBe("true");
    const unGranted = getByRole("button", { name: /developer-expertise/ });
    expect(unGranted.getAttribute("aria-pressed")).toBe("false");
    // Toggling off drops the grant from the save payload.
    fireEvent.click(kbChip);
    expect(kbChip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(getByText("Save controller"));
    await waitFor(() => expect(lastForm).not.toBeNull());
    expect(lastForm?.kb).toBe("");
  });

  it("shows a granted resource the store lost as a removable red chip", async () => {
    const { container, getByText, getByTitle } = renderPanel({
      skills: ["controller-guide", "ghost-skill"],
    });
    const ghost = getByTitle(
      "No longer in the store. Click to remove this grant",
    );
    expect(ghost.textContent).toContain("ghost-skill");
    expect(ghost.className).toContain("missing");
    expect(ghost.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(ghost);
    expect(
      container.querySelector(".pick-chip.missing"),
    ).toBeNull();
    fireEvent.click(getByText("Save controller"));
    await waitFor(() => expect(lastForm).not.toBeNull());
    expect(lastForm?.skills).toBe("controller-guide");
  });

  it("discloses a missing profile template with the shared warning treatment", () => {
    const { container } = renderPanel({ profilePresent: false });
    const warn = container.querySelector(".deny-note");
    expect(warn?.textContent).toContain(
      "The controller profile file is missing from the store",
    );
  });
});
