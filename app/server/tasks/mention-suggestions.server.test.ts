import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { readProjectFile } from "~/server/files/project-writer.server";
import { getMentionables } from "./mention-suggestions.server";

/**
 * getMentionables: the composer's @-mention directory. Uses the shared
 * test-store fixture (arda=admin, murat=maintainer, selin=reviewer,
 * elif=viewer, deniz=registered non-member). A `dev` specialist is deployed
 * so the agents group is non-empty.
 */

let ctx: TestDbContext;
let store: TestStore;

/** Deploy a `dev` (claude) + `qa` (codex) specialist on the project. */
function deploySpecialists(): void {
  const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
    .parsed.frontmatter;
  writeProject(store.dataRoot, {
    ...fm,
    repo: null,
    agents: [
      {
        profileId: "dev",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "dev",
          role: "developer",
          backends: ["claude"],
          model: "claude-sonnet",
        },
      } as never,
      {
        profileId: "qa",
        capabilities: [],
        extras: [],
        definition: {
          kind: "specialist",
          name: "qa",
          role: "reviewer",
          backends: ["codex"],
          model: "gpt-5-codex",
        },
      } as never,
    ],
  });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
  deploySpecialists();
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-1", {
      engagements: [
        { profileId: "dev", backend: "claude", role: "developer", delivers: true, verdictCapable: false },
      ],
    }),
  });
});

afterEach(() => ctx.cleanup());

const call = () =>
  getMentionables(store.db, store.slug, "VIB-1", { dataRoot: store.dataRoot });

describe("getMentionables", () => {
  it("returns the deployed specialists as agents (handle = name lowercased)", () => {
    const { agents } = call();
    expect(agents).toEqual([
      { handle: "dev", name: "dev", role: "developer", backend: "claude" },
      { handle: "qa", name: "qa", role: "reviewer", backend: "codex" },
    ]);
  });

  it("returns registered users keyed by email local-part, members first", () => {
    const { users } = call();
    // Every seeded user is registered → all five appear.
    const handles = users.map((u) => u.handle);
    for (const u of Object.values(store.users)) {
      expect(handles).toContain(u.email.split("@")[0]!.toLowerCase());
    }
    // Project members (arda…elif) sort ahead of the non-member (deniz).
    const ardaHandle = store.users.arda.email.split("@")[0]!.toLowerCase();
    const denizHandle = store.users.deniz.email.split("@")[0]!.toLowerCase();
    expect(handles.indexOf(ardaHandle)).toBeLessThan(handles.indexOf(denizHandle));
    // The handle matches the server's resolver (email local-part), name kept.
    const arda = users.find((u) => u.handle === ardaHandle)!;
    expect(arda.name).toBe(store.users.arda.name);
    expect(arda.email).toBe(store.users.arda.email);
  });

  it("returns the reserved role handles, and names the profile each backend handle reaches", () => {
    expect(call().reserved).toEqual([
      { handle: "operator", label: "Operator" },
      // F19-12: the @-mention picker's subline is rendered copy and must use the
      // SHIPPED vocabulary. "Primary specialist" is retired (D9/Q17-5) — reading
      // "primary" as the DELIVERING engagement is exactly what `@agent` resolves
      // to. This assertion is the pin: restoring the old label fails it.
      { handle: "agent", label: "Delivering agent" },
      { handle: "claude", label: "Claude specialist — dev" },
      { handle: "codex", label: "Codex specialist — qa" },
    ]);
    // Belt and braces on the whole directory, not just this row: no reserved
    // subline may reintroduce the retired phrase.
    for (const r of call().reserved) {
      expect(r.label).not.toMatch(/primary specialist/i);
    }
  });

  /**
   * B-AG2: `@claude` names a RUNTIME. With two claude profiles deployed the
   * resolver engages nobody, so offering the handle promises a target that
   * cannot be reached — the composer suggested it anyway, and the comment
   * routed nowhere.
   */
  it("does NOT offer a backend handle that covers more than one deployed specialist", () => {
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    const claudeSpecialist = (profileId: string, name: string) => ({
      profileId,
      capabilities: [],
      extras: [],
      definition: {
        kind: "specialist",
        name,
        role: name,
        backends: ["claude"],
        model: "claude-sonnet",
      },
    });
    writeProject(store.dataRoot, {
      ...fm,
      agents: [
        claudeSpecialist("docs-writer", "Docs Writer"),
        claudeSpecialist("security-reviewer", "Security Reviewer"),
      ] as never,
    });
    const { reserved, agents } = call();
    expect(reserved.map((r) => r.handle)).toEqual(["operator", "agent", "codex"]);
    // The precise handles the human must tag instead are still offered.
    expect(agents.map((a) => a.handle)).toEqual([
      "docs-writer",
      "security-reviewer",
    ]);
  });

  it("returns empty agents when no specialist is deployed", () => {
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    writeProject(store.dataRoot, { ...fm, agents: [] });
    expect(call().agents).toEqual([]);
    // Users + reserved still populated (no deployment ⇒ no backend is ambiguous).
    expect(call().reserved).toHaveLength(4);
    expect(call().users.length).toBeGreaterThan(0);
  });
});
