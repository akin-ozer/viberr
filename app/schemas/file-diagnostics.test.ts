import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  tolerantField,
  tolerantListField,
  type FileDiagnostic,
} from "./file-diagnostics";

/**
 * Ruling 16(a): `project.md` and `task.md` read their frontmatter through
 * these two helpers, on the task file's wording — a field that falls back
 * names the value it fell back to. The messages are pinned byte for byte:
 * they reach the diagnostics console and `npm run store:check`. A missing or
 * invalid field's sentence is pinned where project.md reads it
 * (project-file.schema.test.ts, "fallback wording" and "repo").
 */

describe("tolerantField (ruling 16(a))", () => {
  const readiness = z.enum(["ready", "blocked"]);

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

describe("tolerantListField (F18, ruling 16(a))", () => {
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
