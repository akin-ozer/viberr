import { describe, expect, it } from "vitest";
import type { TaskLinks } from "~/shared/task-key-links";
import { expectWithinBudget } from "../../test-support/perf-ratchet";
import { sameMarkdownProps } from "./markdown";

/**
 * Ruling 457, CTL-7: a transcript hands every message ONE conversation-wide
 * `taskLinks` map (the dock, the controller page, the task timeline). When a
 * reply names a task key nothing named before, that map gains a key, and the
 * `Markdown` memo used to compare the whole map, so every unchanged message
 * went back through remark/rehype.
 *
 * React re-renders a memo'd element exactly when its comparator says the
 * props differ, so the figure is counted through `sameMarkdownProps`, the
 * comparator `Markdown` is memo'd with: the old messages it lets through, plus
 * the new reply, which mounts.
 */

function transcript(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const key = `VIB-${100 + (i % 6)}`;
    return i % 2 === 0
      ? `Please look at ${key} and tell me what blocks it. `.repeat(8)
      : `${key} waits on review. The branch is green and the PR is open. `.repeat(24);
  });
}

function linksFor(texts: readonly string[]): TaskLinks {
  const links: Record<string, string> = {};
  for (const text of texts) {
    for (const [key] of text.matchAll(/\b[A-Z][A-Z0-9]{0,9}-\d{1,6}\b/g)) {
      links[key] = `/projects/viberr/tasks/${key}`;
    }
  }
  return links;
}

describe("Markdown re-parses when a reply names a new task key (ruling 457, CTL-7)", () => {
  it("re-renders only the reply, not the thirty messages before it", () => {
    const before = transcript(30);
    const reply = "Created VIB-7 for the follow-up.";
    const after = [...before, reply];
    const oldLinks = linksFor(before);
    const newLinks = linksFor(after);
    expect(Object.keys(newLinks)).toContain("VIB-7");

    const reparsed =
      before.filter(
        (text) =>
          !sameMarkdownProps({ text, taskLinks: oldLinks }, { text, taskLinks: newLinks }),
      ).length + 1; // the reply mounts
    expectWithinBudget("controller:markdown.reparses-per-new-key", reparsed);
  });

  it("still re-renders an older message whose own key became a link", () => {
    // Correctness beside the figure: a message that named VIB-7 before it was
    // linkable must pick the link up.
    const text = "VIB-7 is not filed yet.";
    expect(
      sameMarkdownProps(
        { text, taskLinks: { "VIB-1": "/projects/viberr/tasks/VIB-1" } },
        {
          text,
          taskLinks: {
            "VIB-1": "/projects/viberr/tasks/VIB-1",
            "VIB-7": "/projects/viberr/tasks/VIB-7",
          },
        },
      ),
    ).toBe(false);
  });
});
