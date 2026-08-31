import { describe, expect, it } from "vitest";
import { parseGoalFileContent, serializeGoalFile } from "./goal-writer.server";

/**
 * file-formats §2: the writers ALWAYS preserve unknown frontmatter fields, so a
 * hand-added or future/foreign key round-trips. serializeGoalFile used to emit
 * only the schema keys with `{}` extras, so the FIRST reconcile write (a link
 * completing, or even a no-op advance tick) silently destroyed any such key —
 * unlike the task and project writers, which preserve them.
 */
describe("goal-writer round-trip", () => {
  const RAW = [
    "---",
    "id: goal-1",
    "title: Ship the thing",
    "status: active",
    "createdBy: user-1",
    "createdByLabel: Ada",
    "onFailure: pause",
    "links: []",
    "createdAt: 2026-08-31T00:00:00.000Z",
    "updatedAt: 2026-08-31T00:00:00.000Z",
    "reviewLink: https://example.test/goal-1",
    "customNote: keep me",
    "---",
    "",
    "## Description",
    "",
    "Do the thing well.",
    "",
    "## Timeline",
    "",
    "- 2026-08-31T00:00:00.000Z · Goal created with 0 links by Ada.",
    "",
  ].join("\n");

  it("preserves unknown frontmatter keys through parse→serialize", () => {
    const parsed = parseGoalFileContent(RAW);
    expect(parsed).not.toBeNull();
    expect(parsed!.unknownFrontmatter).toMatchObject({
      reviewLink: "https://example.test/goal-1",
      customNote: "keep me",
    });

    const out = serializeGoalFile(parsed!);
    expect(out).toContain("reviewLink: https://example.test/goal-1");
    expect(out).toContain("customNote: keep me");
  });

  it("is stable on a second round-trip (the no-op-write guard holds)", () => {
    const once = serializeGoalFile(parseGoalFileContent(RAW)!);
    const twice = serializeGoalFile(parseGoalFileContent(once)!);
    expect(twice).toBe(once);
    // And the preserved key is still there after two passes.
    expect(twice).toContain("customNote: keep me");
  });
});
