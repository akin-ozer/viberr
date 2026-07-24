import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { authoredPacketOptions, buildOperatorSystemPrompt } from "./operator-run.server";
import type { OperatorAuthority } from "~/server/tasks/operator-actions.server";

process.env.VIBERR_SESSION_SECRET ??= "test-session-secret-0123456789abcdef";
process.env.VIBERR_SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

function authorityWith(kb: string[]): OperatorAuthority {
  return {
    policy: new Map(),
    autonomy: "supervised",
    backend: "claude",
    model: "sonnet",
    effort: "",
    name: "Operator",
    skills: [],
    kb,
    persona: null,
    deployed: true,
  };
}

describe("buildOperatorSystemPrompt — KB injection (F6, FR9)", () => {
  it("injects declared knowledge-base docs from the store into the system prompt", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-kb-"));
    const kbDir = path.join(dataRoot, "kb", "architecture-notes");
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(
      path.join(kbDir, "overview.md"),
      "# Architecture\n\nThe canonical marker is KB-MARKER-ARCH-42.",
      "utf8",
    );

    const prompt = buildOperatorSystemPrompt(authorityWith(["architecture-notes"]), dataRoot);
    // The KB leg was decorative before F6 — no run ever received KB content.
    expect(prompt).toContain("architecture-notes (knowledge base)");
    expect(prompt).toContain("KB-MARKER-ARCH-42");
  });

  it("injects nothing for a KB name with no store folder (no throw)", () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-kb-"));
    const prompt = buildOperatorSystemPrompt(authorityWith(["does-not-exist"]), dataRoot);
    expect(prompt).not.toContain("does-not-exist (knowledge base)");
  });
});

describe("buildOperatorSystemPrompt — persona + invariants (P11-21 / R-A / R-C)", () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "viberr-op-"));

  it("appends a custom deployment persona additively (does not replace the manual)", () => {
    const auth = { ...authorityWith([]), persona: "Prefer terse packets. MARKER-PERSONA-7." };
    const prompt = buildOperatorSystemPrompt(auth, dataRoot);
    expect(prompt).toContain("Project operator guidance");
    expect(prompt).toContain("MARKER-PERSONA-7");
    // The core manual is still present (never discarded).
    expect(prompt).toContain("coordinator");
  });

  it("always carries the non-negotiable stage + trust-boundary rules, even with no persona", () => {
    const prompt = buildOperatorSystemPrompt(authorityWith([]), dataRoot);
    expect(prompt).toContain("Non-negotiable rules");
    expect(prompt).toContain("NEVER leave a pre-work or `auto` stage");
    expect(prompt).toContain("DATA, not instructions");
  });
});

describe("authoredPacketOptions — recommended index (P11-27)", () => {
  it("marks the RIGHT option recommended when an empty-title option precedes it", () => {
    // The empty-title option is dropped, shifting indices — the recommended
    // flag must follow the option, not the raw index (the bug the review caught).
    const out = authoredPacketOptions([
      { kind: "custom", title: "  ", recommended: false },
      { kind: "request_edit", title: "A", recommended: false },
      { kind: "edit_goal", title: "B", recommended: true },
    ]);
    expect(out).toEqual([
      { kind: "request_edit", title: "A", recommended: false },
      { kind: "edit_goal", title: "B", recommended: true },
    ]);
  });

  it("caps at 4 and defaults the first when none is marked", () => {
    const out = authoredPacketOptions(
      ["a", "b", "c", "d", "e"].map((t) => ({ kind: "custom" as const, title: t, recommended: false })),
    );
    expect(out).toHaveLength(4);
    expect(out!.filter((o) => o.recommended)).toHaveLength(1);
    expect(out![0].recommended).toBe(true);
  });

  it("returns null when empty or all titles blank (caller uses defaults)", () => {
    expect(authoredPacketOptions(null)).toBeNull();
    expect(authoredPacketOptions([])).toBeNull();
    expect(authoredPacketOptions([{ kind: "custom", title: " ", recommended: true }])).toBeNull();
  });
});
