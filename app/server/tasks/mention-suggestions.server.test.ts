import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
  type TestStoreUser,
} from "../../../test-support/test-store";
import type { AgentDeployment } from "~/schemas/project-file.schema";
import { readProjectFile } from "~/server/files/project-writer.server";
import { getMentionables } from "./mention-suggestions.server";

/**
 * getMentionables: the composer's @-mention directory. Uses the shared
 * test-store fixture (arda=admin, murat=maintainer, selin=reviewer,
 * elif=viewer, deniz=registered non-member). A `dev` specialist is deployed
 * so the agents group is non-empty.
 *
 * The users group is MEMBERS ONLY (F33-9): deniz is the fixture's guest, so
 * every users assertion below is also a boundary assertion.
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
      },
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
      },
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
  getMentionables(store.db, store.slug, { dataRoot: store.dataRoot });

/** The handle the composer offers (and the fan-out resolves) for a user. */
const handleOf = (u: TestStoreUser) => u.email.split("@")[0]!.toLowerCase();

describe("getMentionables", () => {
  it("returns the deployed specialists as agents (handle = name lowercased)", () => {
    const { agents } = call();
    expect(agents).toEqual([
      { handle: "dev", name: "dev", role: "developer", backend: "claude" },
      { handle: "qa", name: "qa", role: "reviewer", backend: "codex" },
    ]);
  });

  it("returns the project's MEMBERS keyed by email local-part, in membership order", () => {
    const { users } = call();
    expect(users.map((u) => u.handle)).toEqual([
      handleOf(store.users.arda),
      handleOf(store.users.murat),
      handleOf(store.users.selin),
      handleOf(store.users.elif),
    ]);
    // The handle matches the server's resolver (email local-part), name kept.
    const arda = users[0]!;
    expect(arda.name).toBe(store.users.arda.name);
    expect(arda.email).toBe(store.users.arda.email);
  });

  /**
   * F33-9 — the picker used to append "any remaining registered app user" after
   * the members, so it offered someone who cannot open the project at all. Live:
   * an admin tagged a viewer of a DIFFERENT project, her inbox showed the
   * project name, the task key and the comment text, and the link served her the
   * members-only 404. Ruling 25 says a non-member gets the same bytes as an
   * unknown slug precisely so "a probe cannot learn a project exists" — a
   * suggestion whose only outcome is that disclosure must not be offered.
   */
  it("never offers a registered NON-member (F33-9)", () => {
    const handles = call().users.map((u) => u.handle);
    expect(handles).not.toContain(handleOf(store.users.deniz));
    // …and the guest is a real, enabled account — the exclusion is membership,
    // not existence.
    expect(
      store.db
        .prepare(`SELECT disabled FROM users WHERE id = ?`)
        .get(store.users.deniz.id),
    ).toEqual({ disabled: 0 });
  });

  it("skips a member whose account is disabled, and a member id with no user row", () => {
    const fm = readProjectFile({ projectSlug: store.slug, dataRoot: store.dataRoot })!
      .parsed.frontmatter;
    // LV-04: project.md keeps the entry after the org account is deleted.
    writeProject(store.dataRoot, {
      ...fm,
      members: [...fm.members, { userId: "u_ghost", role: "viewer" }],
    });
    store.db
      .prepare(`UPDATE users SET disabled = 1 WHERE id = ?`)
      .run(store.users.murat.id);
    const handles = call().users.map((u) => u.handle);
    expect(handles).toEqual([
      handleOf(store.users.arda),
      handleOf(store.users.selin),
      handleOf(store.users.elif),
    ]);
  });

  it("returns the reserved role handles, and names the profile each backend handle reaches", () => {
    expect(call().reserved).toEqual([
      { handle: "operator", label: "Operator" },
      // F19-12: the @-mention picker's subline is rendered copy and must use the
      // SHIPPED vocabulary. "Primary specialist" is retired (D9/Q17-5) — reading
      // "primary" as the DELIVERING engagement is exactly what `@agent` resolves
      // to. This assertion is the pin: restoring the old label fails it.
      { handle: "agent", label: "Delivering agent" },
      { handle: "claude", label: "Claude specialist (dev)" },
      { handle: "codex", label: "Codex specialist (qa)" },
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
    const claudeSpecialist = (
      profileId: string,
      name: string,
    ): AgentDeployment => ({
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
      ],
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
