import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  closeRequestsAnsweredByGrants,
  openRequestsContextLine,
  openResourceRequests,
  raiseResourceRequest,
  readResourceRequests,
  resourceRequestRemedy,
} from "./controller-requests.server";

/**
 * Ruling 390 (F39-17) — the controller's standing ask for a resource it cannot
 * grant itself.
 *
 * Live in pass 39 the owner's instance-wide model rule was broken on a new
 * deployment: told once in a conversation that had since ended, it reached the
 * next turn through nothing at all. The controller wrote the rule into a new
 * knowledge base — correctly, with the rule as the HEADING, because a KB is
 * injected as an index of names and headings — and then could not attach it.
 * The document sat unread and the ask existed only as prose in the conversation
 * that was about to end.
 */
const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "viberr-requests-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const ASK = {
  kind: "kb" as const,
  name: "instance-standing-rules",
  reason: "It carries the model and effort rule Arda set, as its heading.",
  askedByUserId: "u_arda",
  askedByLabel: "arda@viberr.dev · via controller",
};

describe("ruling 390: a grant request the controller cannot answer itself", () => {
  it("has nothing to say on a store that has never had one", () => {
    const root = makeRoot();
    expect(readResourceRequests(root)).toEqual([]);
    expect(openResourceRequests(root)).toEqual([]);
    expect(openRequestsContextLine(root)).toBe("");
  });

  it("writes the ask to a FILE beside the profile, never into it", () => {
    const root = makeRoot();
    const { request, created } = raiseResourceRequest(ASK, root);
    expect(created).toBe(true);
    expect(request.status).toBe("open");
    // The profile is what the controller is read BY and ruling 108 locks it;
    // this record is about the controller, so it lives next door.
    const file = path.join(root, "agents", "controller-requests.md");
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("instance-standing-rules");
    expect(raw).toContain(request.id);
    // And it round-trips through the reader.
    expect(readResourceRequests(root)).toEqual([request]);
  });

  it("is idempotent per (kind, name) while open, so re-asking stacks nothing", () => {
    const root = makeRoot();
    const first = raiseResourceRequest(ASK, root);
    const again = raiseResourceRequest({ ...ASK, reason: "said differently" }, root);
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(first.request.id);
    expect(readResourceRequests(root)).toHaveLength(1);

    // A DIFFERENT resource is a different ask.
    raiseResourceRequest({ ...ASK, name: "controller-handbook" }, root);
    expect(openResourceRequests(root)).toHaveLength(2);
  });

  it("re-opens once the first is answered, because the situation is new", () => {
    const root = makeRoot();
    raiseResourceRequest(ASK, root);
    // A Controller-tab save that leaves the knowledge base granted answers it.
    const [closed] = closeRequestsAnsweredByGrants(
      ctx.makeDb(),
      { skills: [], kb: [ASK.name], mcps: [] },
      { userId: ASK.askedByUserId, label: "arda@viberr.dev" },
      root,
    );
    expect(closed?.status).toBe("granted");
    expect(closed?.closedAt).toBeTruthy();
    expect(openResourceRequests(root)).toHaveLength(0);
    // The history stays: an answered ask is a record, not a deletion.
    expect(readResourceRequests(root)).toHaveLength(1);

    const reopened = raiseResourceRequest(ASK, root);
    expect(reopened.created).toBe(true);
    expect(readResourceRequests(root)).toHaveLength(2);
  });

  it("drops one malformed row and keeps the rest", () => {
    const root = makeRoot();
    const { request } = raiseResourceRequest(ASK, root);
    const file = path.join(root, "agents", "controller-requests.md");
    mkdirSync(path.dirname(file), { recursive: true });
    const raw = readFileSync(file, "utf8");
    // A hand-edited file with one entry missing its id.
    writeFileSync(
      file,
      raw.replace("requests:\n", "requests:\n  - kind: kb\n    name: broken\n"),
      "utf8",
    );
    // CANARY: parse the array whole instead of per row, and the real ask
    // disappears with the broken one — an unanswered ask nobody can see.
    expect(readResourceRequests(root).map((r) => r.id)).toEqual([request.id]);
  });

  it("the remedy names the variable, the value and the restart, never a button", () => {
    // Ruling 108 put these grants outside the app, so a surface that offered a
    // Grant control would promise what no code here can do.
    const remedy = resourceRequestRemedy("kb");
    expect(remedy).toContain("VIBERR_UNLOCK_CONTROLLER_KB=enabled");
    expect(remedy).toContain("restart");
    expect(remedy).toContain("no in-app grant");
    // Amended 2026-09-23: the save that grants it is also what closes the ask,
    // and the controller reads this same sentence in its own context.
    expect(remedy).toContain("saving it there answers this request");
    expect(resourceRequestRemedy("skills")).toContain(
      "VIBERR_UNLOCK_CONTROLLER_SKILLS=enabled",
    );
    expect(resourceRequestRemedy("mcps")).toContain(
      "VIBERR_UNLOCK_CONTROLLER_MCPS=enabled",
    );
  });
});
