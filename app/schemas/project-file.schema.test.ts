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
    // `tolerantRows(diagnostics, data, "agents", agentsSchema.element)` (drop
    // the `cleanAgentGrants` pre-pass) and the deployment disappears entirely.
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

/**
 * Ruling 458(h): project.md reads through the task file's tolerant helpers, so
 * a field that falls back names the value it used ("; using <fallback>."),
 * where it used to say "— using a default." and name nothing.
 */
describe("parseProjectFrontmatter — gates (ruling 482)", () => {
  it("keeps valid gates in order, drops only a malformed row, and stays absent when undeclared", () => {
    // CANARY: parse `gates` with the whole-array `tolerant` and one bad row
    // silently stops every gate from running or blocking.
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      {
        slug: "proj",
        gates: [
          { name: "install", command: "pnpm install --frozen-lockfile" },
          { name: "build" }, // malformed: no command
          { name: "check", command: "pnpm astro check", timeoutSeconds: 900 },
        ],
      },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.gates).toEqual([
      { name: "install", command: "pnpm install --frozen-lockfile" },
      { name: "check", command: "pnpm astro check", timeoutSeconds: 900 },
    ]);
    expect(diagnostics.some((d) => d.path === "gates[1]")).toBe(true);
    // A project.md without the key gains none on the next write.
    expect(
      parseProjectFrontmatter({ slug: "proj" }, { fallbackSlug: "proj" }).frontmatter.gates,
    ).toBeUndefined();
  });
});

describe("parseProjectFrontmatter — fallback wording (ruling 458(h))", () => {
  it("names the fallback for a missing or invalid field", () => {
    const { frontmatter, diagnostics } = parseProjectFrontmatter(
      { slug: "proj", defaultBranch: "" },
      { fallbackSlug: "proj" },
    );
    expect(frontmatter.name).toBe("proj");
    expect(frontmatter.defaultBranch).toBe("main");
    const byPath = new Map(
      diagnostics.filter((d) => d.code.startsWith("frontmatter.")).map((d) => [d.path, d]),
    );
    // CANARY: bind project-file.schema.ts to a helper that says "— using a
    // default." and these fail.
    expect(byPath.get("name")).toMatchObject({
      severity: "warning",
      code: "frontmatter.missing_field",
      message: 'Frontmatter field `name` is missing; using "proj".',
    });
    expect(byPath.get("stages")).toMatchObject({
      severity: "warning",
      code: "frontmatter.missing_field",
      message: "Frontmatter field `stages` is missing; using [].",
    });
    expect(byPath.get("defaultBranch")).toMatchObject({
      severity: "warning",
      code: "frontmatter.invalid_field",
    });
    expect(byPath.get("defaultBranch")!.message).toMatch(
      /^Frontmatter field `defaultBranch` is invalid \(.+\); using "main"\.$/,
    );
  });
});

/**
 * Ruling 696(a): every checkout path is `<taskDir>/workspace/<name>`, so a
 * hand-edited `owner/..` made the checkout the task directory itself, and
 * `owner/.` made it the whole workspace, support checkouts included. The
 * "no `.git/HEAD`, remove and re-clone" step could remove either.
 */
describe("parseProjectFrontmatter — repo (ruling 696(a))", () => {
  const read = (repo: string) =>
    parseProjectFrontmatter({ slug: "proj", repo }, { fallbackSlug: "proj" });

  it.each(["akin-ozer/..", "akin-ozer/."])(
    "reads %s, a repository GitHub could not name, as none with an error-severity diagnostic",
    (repo) => {
      // CANARY: read `repo` with the bare `repoSchema` (drop the
      // `REPO_SLUG_RE` refine) and both rows load as the project's repository,
      // with no diagnostic; drop the `?` from the name's `(?!\.\.?$)` and the
      // `akin-ozer/.` row does.
      const parsed = read(repo);
      expect(parsed.frontmatter.repo).toBeNull();
      expect(parsed.diagnostics.filter((d) => d.path === "repo")).toEqual([
        {
          severity: "error",
          code: "frontmatter.invalid_field",
          path: "repo",
          message:
            "Frontmatter field `repo` is invalid (not a GitHub owner/name, so the project reads as having no repository); using null.",
        },
      ]);
    },
  );

  it("keeps a name GitHub allows that starts with a dot", () => {
    // CANARY: refuse a name's leading dot, as the mirror's old rule did, and
    // this reads null.
    expect(read("akin-ozer/.github").frontmatter.repo).toBe("akin-ozer/.github");
  });
});
