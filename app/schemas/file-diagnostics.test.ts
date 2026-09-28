import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  tolerantField,
  tolerantListField,
  type FileDiagnostic,
} from "./file-diagnostics";

/**
 * Ruling 458(h): `project.md` and `task.md` read their frontmatter through
 * these two helpers, on the task file's wording — a field that falls back
 * names the value it fell back to. The messages are pinned byte for byte:
 * they reach the diagnostics console and `npm run store:check`.
 */

describe("tolerantField (ruling 458(h))", () => {
  const readiness = z.enum(["ready", "blocked"]);

  it("returns a valid value and says nothing", () => {
    const diagnostics: FileDiagnostic[] = [];
    expect(tolerantField(diagnostics, { readiness: "blocked" }, "readiness", readiness, "ready")).toBe(
      "blocked",
    );
    expect(diagnostics).toEqual([]);
  });

  it("reads an absent optional field as its fallback in silence", () => {
    const diagnostics: FileDiagnostic[] = [];
    expect(tolerantField(diagnostics, {}, "readiness", readiness, "ready")).toBe("ready");
    expect(diagnostics).toEqual([]);
  });

  it("names the fallback when a required field is missing", () => {
    const diagnostics: FileDiagnostic[] = [];
    const value = tolerantField(diagnostics, {}, "readiness", readiness, "ready", {
      required: true,
    });
    expect(value).toBe("ready");
    // CANARY: end the message "— using a default." (project.md's old wording)
    // and this fails.
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        code: "frontmatter.missing_field",
        message: 'Frontmatter field `readiness` is missing; using "ready".',
        path: "readiness",
      },
    ]);
  });

  it("names the fallback and the first issue when a field is invalid", () => {
    const diagnostics: FileDiagnostic[] = [];
    const value = tolerantField(diagnostics, { repo: 42 }, "repo", z.string().nullable(), null);
    expect(value).toBeNull();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      severity: "warning",
      code: "frontmatter.invalid_field",
      path: "repo",
    });
    expect(diagnostics[0]!.message).toMatch(
      /^Frontmatter field `repo` is invalid \(.+\); using null\.$/,
    );
  });

  it("reports at info severity when the field asks for it, missing or invalid", () => {
    const diagnostics: FileDiagnostic[] = [];
    tolerantField(diagnostics, {}, "validation", readiness, "ready", {
      required: true,
      severity: "info",
    });
    tolerantField(diagnostics, { validation: "nope" }, "validation", readiness, "ready", {
      severity: "info",
    });
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["frontmatter.missing_field", "info"],
      ["frontmatter.invalid_field", "info"],
    ]);
  });
});

describe("tolerantListField (F18, ruling 458(h))", () => {
  const member = z.object({ userId: z.string() });

  it("keeps the good rows and drops only the bad one, at its index", () => {
    const diagnostics: FileDiagnostic[] = [];
    const rows = tolerantListField(
      diagnostics,
      { members: [{ userId: "a" }, { role: "x" }, { userId: "c" }] },
      "members",
      member,
    );
    expect(rows).toEqual([{ userId: "a" }, { userId: "c" }]);
    expect(diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["frontmatter.invalid_field", "members[1]"],
    ]);
    expect(diagnostics[0]!.message).toMatch(
      /^Frontmatter `members\[1\]` is invalid \(.+\); dropping this entry, keeping the rest\.$/,
    );
  });

  it("reads an absent list as [] — in silence unless the list is required", () => {
    const quiet: FileDiagnostic[] = [];
    expect(tolerantListField(quiet, {}, "members", member)).toEqual([]);
    expect(quiet).toEqual([]);

    const loud: FileDiagnostic[] = [];
    expect(tolerantListField(loud, {}, "stages", member, { required: true })).toEqual([]);
    expect(loud).toEqual([
      {
        severity: "warning",
        code: "frontmatter.missing_field",
        message: "Frontmatter field `stages` is missing; using [].",
        path: "stages",
      },
    ]);
  });

  it("falls a value that is not a list back to [] with one warning", () => {
    const diagnostics: FileDiagnostic[] = [];
    expect(tolerantListField(diagnostics, { members: "everyone" }, "members", member)).toEqual([]);
    expect(diagnostics).toEqual([
      {
        severity: "warning",
        code: "frontmatter.invalid_field",
        message: "Frontmatter field `members` is not a list; using an empty list.",
        path: "members",
      },
    ]);
  });
});
