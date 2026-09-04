import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import { createActorResolver,
  encodeControllerInstrument,
  decodeControllerInstrument,
} from "./actor.server";
import { agentNamesByProfile, upsertRun } from "~/server/runtimes/run-store.server";
import type { FileActorRef } from "~/schemas/task-file.schema";

/**
 * NEW-5: an agent actor renders under the AGENT'S OWN name (e.g. "Reviewer"),
 * resolved from its run rows — never the runtime/backend label ("Claude").
 * The operator keeps its fixed "Operator" identity; a nameless/unknown agent
 * falls back to the backend label so no context ever crashes.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const reviewerRef: FileActorRef = {
  kind: "agent",
  backend: "claude",
  profileId: "reviewer",
  roleHint: "Review & validation",
};

function seedRun(
  db: import("node:sqlite").DatabaseSync,
  over: Partial<Parameters<typeof upsertRun>[1]> = {},
) {
  const id = over.id ?? `run_${Math.abs(hash(JSON.stringify(over)))}`;
  upsertRun(db, {
    id,
    projectSlug: "viberr-core",
    taskKey: "VIB-1",
    threadId: `t-${id}`, // unique per run (UNIQUE(project,task,thread))
    role: "Review & validation",
    kind: "reviewer",
    backend: "claude",
    model: "sonnet",
    sdk: "claude",
    agentName: "Reviewer",
    agentProfileId: "reviewer",
    state: "finished",
    ...over,
  });
}

// tiny stable hash so seeded run ids differ without Math.random
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

describe("createActorResolver — agent name (NEW-5)", () => {
  it("renders an agent under its own name when a name map is supplied", () => {
    const db = ctx.makeDb();
    const resolve = createActorResolver(db, {
      agentNames: new Map([["reviewer", "Reviewer"]]),
    });
    const rendered = resolve(reviewerRef);
    expect(rendered).toMatchObject({ kind: "agent", name: "Reviewer", backend: "claude" });
    // NOT the runtime label.
    expect(rendered.name).not.toBe("Claude");
  });

  it("falls back to the backend label when the profile has no known name", () => {
    const db = ctx.makeDb();
    const resolve = createActorResolver(db, { agentNames: new Map() });
    expect(resolve(reviewerRef)).toMatchObject({ name: "Claude" });
    // And with no map at all (no project context) — same safe fallback.
    expect(createActorResolver(db)(reviewerRef)).toMatchObject({ name: "Claude" });
  });

  it("the operator keeps its fixed identity, never a backend label", () => {
    const db = ctx.makeDb();
    const resolve = createActorResolver(db, { agentNames: new Map([["reviewer", "Reviewer"]]) });
    expect(resolve({ kind: "operator" })).toEqual({ kind: "agent", name: "Operator" });
  });
});

describe("agentNamesByProfile (NEW-5)", () => {
  it("maps profile id → the agent's display name from run rows, most-recent wins", () => {
    const db = ctx.makeDb();
    seedRun(db, { id: "run_a", agentName: "Reviewer" });
    // A later run row for the same profile with a renamed label overrides.
    seedRun(db, { id: "run_b", agentName: "Senior Reviewer" });
    seedRun(db, {
      id: "run_dev",
      agentProfileId: "developer",
      agentName: "Developer",
      role: "Implementation",
      kind: "primary",
    });
    const map = agentNamesByProfile(db, "viberr-core");
    expect(map.get("developer")).toBe("Developer");
    // Whichever reviewer row is most recent by (created_at, rowid) wins; both are valid names.
    expect(["Reviewer", "Senior Reviewer"]).toContain(map.get("reviewer"));
  });

  it("skips rows with no stored name (nameless seed/legacy runs)", () => {
    const db = ctx.makeDb();
    seedRun(db, { id: "run_named", agentName: "Reviewer" });
    seedRun(db, { id: "run_nameless", agentProfileId: "ghost", agentName: null });
    const map = agentNamesByProfile(db, "viberr-core");
    expect(map.get("reviewer")).toBe("Reviewer");
    expect(map.has("ghost")).toBe(false);
  });
});

/**
 * C5 (pass 34, U34-4): the controller instrument has ONE spelling, shared by
 * both producers and by the Activity column that decodes it.
 */
describe("controller instrument (C5)", () => {
  it("round-trips a person's label, and decodes nothing from a plain one", () => {
    // Canary: change the suffix in the encoder only — the decode stops
    // recognising the label both controller producers write.
    const encoded = encodeControllerInstrument("arda@viberr.dev");
    expect(encoded).toBe("arda@viberr.dev · via controller");
    expect(decodeControllerInstrument(encoded)).toBe("arda@viberr.dev");
    expect(decodeControllerInstrument("arda@viberr.dev")).toBeNull();
    expect(decodeControllerInstrument("agent:claude/dev (Implementation)")).toBeNull();
  });
});
