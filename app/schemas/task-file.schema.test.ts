import { describe, expect, it } from "vitest";
import {
  parseTaskFrontmatter,
  parseTaskPacket,
} from "./task-file.schema";

describe("parseTaskFrontmatter (tolerant)", () => {
  const valid = {
    key: "VIB-142",
    title: "Attach execution workspace to task runtime",
    stage: "review",
    readiness: "input_required",
    waiting: "human",
    ownerUserId: "u_abc",
    specialist: { profileId: "developer", backend: "codex", role: "Developer" },
    consultants: [],
    operator: { assignedAtStageId: "triage" },
    urgent: true,
    validation: "changed",
    branch: "vib-142-attach-workspace",
    repo: null,
    pr: { number: 318, state: "review", title: "Attach execution workspace" },
    github: null,
    createdAt: "2026-07-03T06:00:00.000Z",
    updatedAt: "2026-07-04T06:58:00.000Z",
  };

  it("parses a fully valid frontmatter without diagnostics", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-142" });
    expect(result.diagnostics).toEqual([]);
    expect(result.frontmatter.key).toBe("VIB-142");
    expect(result.frontmatter.readiness).toBe("input_required");
    expect(result.frontmatter.urgent).toBe(true);
    expect(result.unknown).toEqual({});
  });

  it("preserves unknown fields without diagnostics", () => {
    const result = parseTaskFrontmatter(
      { ...valid, futureField: { nested: [1, 2] }, xCustom: "keep me" },
      { fallbackKey: "VIB-142" },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.unknown).toEqual({
      futureField: { nested: [1, 2] },
      xCustom: "keep me",
    });
  });

  it("missing required fields → warnings + safe fallbacks, never a throw", () => {
    const result = parseTaskFrontmatter({}, { fallbackKey: "VIB-9" });
    expect(result.frontmatter.key).toBe("VIB-9");
    expect(result.frontmatter.title).toBe("VIB-9");
    expect(result.frontmatter.stage).toBe("triage");
    expect(result.frontmatter.readiness).toBe("ready");
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.urgent).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("frontmatter.missing_key");
    expect(codes).toContain("frontmatter.missing_field");
    expect(result.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("invalid enum values → warning diagnostics with field paths", () => {
    const result = parseTaskFrontmatter(
      { ...valid, readiness: "done", waiting: "everyone", validation: 42 },
      { fallbackKey: "VIB-142" },
    );
    expect(result.frontmatter.readiness).toBe("ready"); // fallback
    expect(result.frontmatter.waiting).toBe("none");
    expect(result.frontmatter.validation).toBe("none");
    const paths = result.diagnostics.map((d) => d.path);
    expect(paths).toContain("readiness");
    expect(paths).toContain("waiting");
    expect(paths).toContain("validation");
  });

  it("key mismatch with directory → directory wins + error diagnostic", () => {
    const result = parseTaskFrontmatter(valid, { fallbackKey: "VIB-999" });
    expect(result.frontmatter.key).toBe("VIB-999");
    const diag = result.diagnostics.find(
      (d) => d.code === "frontmatter.key_mismatch",
    );
    expect(diag?.severity).toBe("error");
  });

  it("non-mapping frontmatter → hard stop + all defaults", () => {
    const result = parseTaskFrontmatter("just a string", {
      fallbackKey: "VIB-7",
    });
    expect(result.frontmatter.key).toBe("VIB-7");
    expect(result.diagnostics.some((d) => d.hardStop)).toBe(true);
  });

  it("absent urgent stays false with NO diagnostic (optional by contract)", () => {
    const { urgent, ...withoutUrgent } = valid;
    const result = parseTaskFrontmatter(withoutUrgent, {
      fallbackKey: "VIB-142",
    });
    expect(result.frontmatter.urgent).toBe(false);
    expect(result.diagnostics.filter((d) => d.path === "urgent")).toEqual([]);
  });
});

describe("parseTaskPacket (tolerant)", () => {
  it("valid packet parses with option kinds intact", () => {
    const { packet, diagnostics } = parseTaskPacket({
      type: "input",
      kind: "Completion report",
      from: "operator",
      title: "Accept completion, or send back for one fix?",
      body: "…",
      observations: [{ k: "Changed", v: "9 files", code: true }],
      options: [
        { kind: "accept_completion", t: "Accept completion", d: "", rec: true, accept: true },
        { kind: "request_edit", t: "Request one edit", d: "", rec: false, ev: "**Decision:** …" },
      ],
    });
    expect(diagnostics).toEqual([]);
    expect(packet?.options[0]?.kind).toBe("accept_completion");
    expect(packet?.options[1]?.ev).toBe("**Decision:** …");
  });

  it("invalid packet → null + error diagnostic (never a throw)", () => {
    const { packet, diagnostics } = parseTaskPacket({ type: "nope" });
    expect(packet).toBeNull();
    expect(diagnostics[0]?.code).toBe("packet.invalid");
  });

  it("zero or multiple recommended options → info diagnostic", () => {
    const { diagnostics } = parseTaskPacket({
      type: "blocked",
      kind: "Blocked decision",
      title: "t",
      options: [
        { kind: "redirect", t: "a", rec: true },
        { kind: "redirect", t: "b", rec: true },
      ],
    });
    expect(diagnostics.some((d) => d.code === "packet.rec_count")).toBe(true);
  });

  it("null/undefined → no packet, no diagnostics", () => {
    expect(parseTaskPacket(null)).toEqual({ packet: null, diagnostics: [] });
  });
});
