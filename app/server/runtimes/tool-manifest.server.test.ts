import { describe, expect, it } from "vitest";
import { toolManifest } from "./tool-manifest.server";
import { strictTool } from "./strict-tool.server";

const probe = (name: string, description: string) =>
  strictTool(name, description, {}, async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));

/**
 * Ruling 255 (pass 37, F37-132). The controller reported this from inside its
 * own prompt, and the report is the specification: three tools arrive whole,
 * everything else is names only in a per-turn reminder, and "the list is
 * incremental, not a manifest -- the turn that shipped `list_decisions` listed
 * four names, the turn that shipped `read_timeline_entry` listed three. So the
 * complete toolkit exists in my context only as a union across eleven turns of
 * reminders, never as one list."
 */
describe("toolManifest (ruling 255)", () => {
  it("lists every tool it is given, with the count, so a short list is visibly short", () => {
    const manifest = toolManifest(
      [
        probe("whoami", "Who you are. Call it when unsure."),
        probe("list_runs", "Agent runs you can see, as run ids `read_run_log` takes."),
      ],
      "viberr_controller",
    );
    // CANARY: slice the tool list, or hand-write it.
    expect(manifest).toContain("# Every tool on viberr_controller (2)");
    expect(manifest).toContain("- mcp__viberr_controller__whoami: Who you are.");
    expect(manifest).toContain(
      "- mcp__viberr_controller__list_runs: Agent runs you can see, as run ids `read_run_log` takes.",
    );
  });

  it("says that absence from the list is the answer, because a search returning nothing is not", () => {
    const manifest = toolManifest([probe("whoami", "Who you are.")], "viberr_controller");
    // The whole cost of the gap was the controller reporting a negative it had
    // inferred from a search that found nothing. CANARY: drop this paragraph.
    expect(manifest).toContain("you do not have it");
    expect(manifest).toMatch(/search that returns nothing is not evidence/);
  });

  it("takes the first SENTENCE, not the first period, so an abbreviation does not truncate it", () => {
    const manifest = toolManifest(
      [
        probe(
          "save_knowledge_base",
          "Create or rename a knowledge base, e.g. the conventions one. Org admins only.",
        ),
      ],
      "s",
    );
    // CANARY: split on /\./ and this reads "Create or rename a knowledge base, e.g."
    expect(manifest).toContain("e.g. the conventions one.");
    expect(manifest).not.toContain("Org admins only");
  });

  it("clips a long purpose at a word and SAYS it clipped, naming where the rest is", () => {
    const long = `Do the thing ${"and then some more of it ".repeat(12)}right now.`;
    const manifest = toolManifest([probe("big", long)], "s");
    const line = manifest.split("\n").find((l) => l.startsWith("- mcp__s__big:"))!;
    // Ruling 117's rule: a cut that does not say it cut is the defect, and it
    // has to name where the rest is. CANARY: drop the marker.
    expect(line).toContain("... (clipped; the whole description is in the tool itself)");
    // And the cut lands on a word boundary of the original, never mid-word:
    // what survives is a prefix the source continues with a space.
    const kept = line.slice("- mcp__s__big: ".length, line.indexOf("... (clipped"));
    // CANARY: `sentence.slice(0, PURPOSE_CHARS)` with no `lastIndexOf(" ")`.
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("lists the MOUNTED name, mcp__<server>__<name>, never the bare registry name", () => {
    // Pass 38, F38-1, live 2026-09-18, the first controller turn of a new
    // conversation: two `select:whoami,list_capabilities,…` searches answered
    // "No matching deferred tools found" before the model guessed the prefix.
    // Measured over the board: 8 of the 40 controller runs that searched
    // wasted their first calls this way, because the manifest said
    // `select:<name>` and listed bare names. CANARY: list `t.name` instead of
    // the mounted name.
    const manifest = toolManifest([probe("whoami", "Who you are.")], "viberr_controller");
    expect(manifest).not.toMatch(/^- whoami:/m);
    // The hint must not promise a `select:` shape the listed names do not satisfy.
    expect(manifest).not.toContain("`select:<name>`");
    expect(manifest).toContain("exactly as listed");
  });
});
