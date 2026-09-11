import { describe, expect, it } from "vitest";
import { parseProjectFrontmatter } from "./project-file.schema";

describe("parseProjectFrontmatter — per-entry tolerance (F18)", () => {
  it("keeps valid members and drops only the malformed row (never wipes the ACL)", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        members: [
          { userId: "u_admin", role: "admin" },
          { role: "maintainer" }, // malformed: no userId
          { userId: "u_contrib", role: "contributor" },
        ],
      },
      { fallbackSlug: "proj" },
    );
    // Both valid members survive — one bad row no longer strips EVERY role.
    expect(frontmatter.members.map((m) => m.userId)).toEqual([
      "u_admin",
      "u_contrib",
    ]);
    // The bad row is reported at its index.
    expect(diagnostics.some((d) => d.path === "members[1]")).toBe(true);
  });

  it("keeps valid agent deployments and drops only the malformed one", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        agents: [
          { profileId: "operator", capabilities: [], extras: [] },
          { capabilities: "not-a-list" }, // malformed: no profileId, bad caps
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.agents.map((a) => a.profileId)).toEqual(["operator"]);
    expect(diagnostics.some((d) => d.path === "agents[1]")).toBe(true);
  });

  /**
   * `guardrails` was left on the whole-array path when F18 moved the other
   * four lists. An emptied list reads to every consumer as "nothing
   * configured": each anti-noise guardrail reads OFF, and a
   * `delete-branch-after-merge` an admin explicitly disabled flips back to its
   * ON default — after which the next project write persists the loss.
   */
  it("keeps valid guardrails and drops only the malformed row", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        guardrails: [
          { id: "evidence-separation", on: true },
          "run-cap", // malformed: a bare string, not an entry
          { id: "delete-branch-after-merge", on: false },
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.guardrails.map((g) => g.id)).toEqual([
      "evidence-separation",
      "delete-branch-after-merge",
    ]);
    // The disabled guardrail stays disabled rather than reverting to its
    // default by disappearing.
    expect(
      frontmatter.guardrails.find((g) => g.id === "delete-branch-after-merge")?.on,
    ).toBe(false);
    expect(diagnostics.some((d) => d.path === "guardrails[1]")).toBe(true);
  });

  it("a non-list value for a list field degrades to empty (never throws)", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      { slug: "proj", members: "not-a-list" },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.members).toEqual([]);
    expect(diagnostics.some((d) => d.path === "members")).toBe(true);
  });
});

describe("parseProjectFrontmatter — one bad capability grant costs only itself", () => {
  it("keeps the deployment and its other grants, and names the dropped grant", () => {
    // `capabilities` was a plain z.array(capabilityGrantSchema), so ONE bad
    // grant failed the whole deployment row and the per-row tolerance then
    // dropped the ENTIRE agent — its other grants, its extras, its definition
    // — and the next project write serialized that away. Exactly the
    // whole-array fallback the rule forbids (F31-C5 fixed the same shape for
    // packet options).
    // Canary: replace the `agents:` value with a plain
    // `tolerantArray(diagnostics, data, "agents", agentsSchema)` and the
    // deployment disappears entirely.
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        agents: [
          {
            profileId: "developer",
            capabilities: [
              { capabilityId: "write-repo", mode: "direct" },
              { mode: "direct" }, // malformed: no capabilityId
              { capabilityId: "run-tests", mode: "direct" },
            ],
            extras: [{ label: "bespoke", mode: "direct" }],
          },
        ],
      },
      { fallbackSlug: "proj" },
    );

    // The agent is still deployed…
    expect(frontmatter.agents.map((a) => a.profileId)).toEqual(["developer"]);
    const deployment = frontmatter.agents[0]!;
    // …with every grant that parsed, and everything else on the row intact.
    expect(deployment.capabilities.map((c) => c.capabilityId)).toEqual([
      "write-repo",
      "run-tests",
    ]);
    expect(deployment.extras.map((e) => e.label)).toEqual(["bespoke"]);
    // The dropped grant is reported at its own index, not the deployment's.
    expect(
      diagnostics.some((d) => d.path === "agents[0].capabilities[1]"),
      "the bad grant must be named",
    ).toBe(true);
    expect(
      diagnostics.some((d) => d.path === "agents[0]"),
      "the deployment itself is not a casualty",
    ).toBe(false);
  });
});

/**
 * Ruling 178 (pass 36, G36-3): `requiredReviewers` is a project rule whose loss
 * would silently reopen the acceptance gate, so it is parsed per row like the
 * other lists and defaults to an empty list when the file predates it.
 */
describe("parseProjectFrontmatter — requiredReviewers (ruling 178)", () => {
  it("keeps valid rules, drops only a malformed row, and defaults to [] when absent", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        requiredReviewers: [
          { stageId: "review", profileId: "reviewer" },
          { stageId: "review" }, // malformed: no profileId
          { stageId: "qa", profileId: "qa-bot" },
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.requiredReviewers).toEqual([
      { stageId: "review", profileId: "reviewer" },
      { stageId: "qa", profileId: "qa-bot" },
    ]);
    expect(diagnostics.some((d) => d.path === "requiredReviewers[1]")).toBe(true);

    const absent = parseProjectFrontmatter({ slug: "proj" }, { fallbackSlug: "proj" });
    expect(absent.frontmatter.requiredReviewers).toEqual([]);
    // The key is a known field: it is never round-tripped as unknown frontmatter.
    const raw = parseProjectFrontmatter(
      { slug: "proj", requiredReviewers: [{ stageId: "review", profileId: "reviewer" }] },
      { fallbackSlug: "proj" },
    );
    expect(Object.keys(raw.unknown)).not.toContain("requiredReviewers");
  });
});
