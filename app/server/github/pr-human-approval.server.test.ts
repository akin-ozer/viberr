import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDbContext, type TestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { updateUserFields } from "~/server/auth/user-store.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import type { PrRef, WorkRevision } from "~/schemas/task-file.schema";
import { acceptanceRefusalFor, acceptanceStanding } from "~/server/tasks/task-acceptance.server";
import {
  derivePrHumanApproval,
  humanVerdictApproval,
  humanVerdictNote,
  PR_HUMAN_APPROVAL_KEY,
  readPrHumanApproval,
  resolveGithubHandle,
  type PrHumanApproval,
} from "./pr-human-approval.server";

/**
 * R19-B (owner ruling, pass 19) — **a project member's GitHub approval on the
 * PR counts as the approving verdict.**
 *
 * Before this, `report-validation-verdict` was agent-only and a human reviewer's
 * only paths were (a) engage an AI reviewer he did not need or (b) be a project
 * admin and force-accept — writing a `task.acceptance.forced` row asserting he
 * bypassed a gate he had actually satisfied. On a project running no
 * verdict-capable agent, `deriveValidation` can never reach `healthy`, so EVERY
 * acceptance was permanently audited as bypassing a gate nobody could satisfy.
 */

let ctx: TestDbContext;
let store: TestStore;

const DELIVERED = "d3l1ver3dsha0000000000000000000000000000";
const OLDER = "01d3rsha00000000000000000000000000000000";

function revision(headSha = DELIVERED): WorkRevision {
  return {
    id: "rev_1",
    headSha,
    treeSha: null,
    branch: "vib-301-workspace",
    createdAt: "2026-08-08T08:00:00Z",
    sourceProfileId: "developer",
    kind: "delivered",
  };
}

function prWith(approval: PrHumanApproval | null): PrRef {
  const pr: PrRef = {
    number: 318,
    state: "review",
    title: "Attach execution workspace",
  };
  // The key's PRESENCE is the fact under test — `readPrHumanApproval` reads a
  // PR that never carried an approval differently from one carrying a null.
  if (approval) pr[PR_HUMAN_APPROVAL_KEY] = approval;
  return pr;
}

/** A delivered task sitting at the review boundary with no agent reviewer
 *  engaged — the project shape the gap is about. */
function seedDeliveredTask(pr: PrRef, rev: WorkRevision = revision()): void {
  writeTask(store.dataRoot, store.slug, {
    frontmatter: baseTaskFrontmatter("VIB-301", {
      title: "Attach execution workspace",
      stage: "review",
      branch: "vib-301-workspace",
      ownerUserId: store.users.arda.id,
      pr,
      workRevision: rev,
      engagements: [],
      verdicts: [],
    }),
    goal: "Deliver the workspace attach path.",
  });
  rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
}

beforeEach(() => {
  ctx = createTestDbContext();
  store = setupTestStore(ctx);
});
afterEach(() => ctx.cleanup());

describe("resolveGithubHandle — mapping a GitHub login to a Viberr user", () => {
  it("matches case-insensitively and tolerates a leading @", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "MuratDev" });
    expect(resolveGithubHandle(store.db, "muratdev")).toEqual({
      kind: "found",
      userId: store.users.murat.id,
      name: store.users.murat.name,
    });
    expect(resolveGithubHandle(store.db, "@MURATDEV").kind).toBe("found");
  });

  it("returns `none` when no account carries the handle", () => {
    expect(resolveGithubHandle(store.db, "octocat")).toEqual({ kind: "none" });
  });

  it("returns `ambiguous` rather than guessing when two accounts claim it", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "shared" });
    updateUserFields(store.db, store.users.selin.id, { githubHandle: "shared" });
    expect(resolveGithubHandle(store.db, "shared")).toEqual({ kind: "ambiguous" });
  });
});

describe("derivePrHumanApproval — fail closed unless it is confidently a member", () => {
  const members = () => new Set([store.users.murat.id, store.users.arda.id]);

  it("counts a mapped project member who approved the DELIVERED commit", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "muratdev", commitSha: DELIVERED, at: "2026-08-08T09:00:00Z" }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "counted", userId: store.users.murat.id, login: "muratdev" });
  });

  it("does NOT count an approval on an older commit (R15-1 revision binding)", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "muratdev", commitSha: OLDER, at: null }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "stale_revision" });
  });

  it("does NOT count an approval GitHub gave no commit for", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "muratdev", commitSha: null, at: null }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "stale_revision" });
  });

  it("does NOT count an unlinked handle, an ambiguous one, or a non-member", () => {
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "octocat", commitSha: DELIVERED, at: null }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "unlinked_handle", userId: null });

    updateUserFields(store.db, store.users.murat.id, { githubHandle: "twin" });
    updateUserFields(store.db, store.users.selin.id, { githubHandle: "twin" });
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "twin", commitSha: DELIVERED, at: null }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "ambiguous_handle" });

    // deniz is a registered user who is NOT a member of this project.
    updateUserFields(store.db, store.users.deniz.id, { githubHandle: "deniz" });
    expect(
      derivePrHumanApproval({
        approvals: [{ login: "deniz", commitSha: DELIVERED, at: null }],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "not_a_member", userId: store.users.deniz.id });
  });

  it("a member's counted approval outranks a stranger's — one cannot mask the other", () => {
    updateUserFields(store.db, store.users.murat.id, { githubHandle: "muratdev" });
    expect(
      derivePrHumanApproval({
        approvals: [
          { login: "octocat", commitSha: DELIVERED, at: null },
          { login: "muratdev", commitSha: DELIVERED, at: null },
        ],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toMatchObject({ status: "counted", login: "muratdev" });
  });

  it("nothing to record when the PR carries no standing approval", () => {
    expect(
      derivePrHumanApproval({
        approvals: [],
        deliveredSha: DELIVERED,
        memberUserIds: members(),
        db: store.db,
      }),
    ).toBeNull();
  });
});

/** The binding itself (current revision, re-delivery, a non-counted record) is
 *  proven at the gate, in the R19-B describe below. */
describe("humanVerdictApproval — the stored record, read and named", () => {
  const counted: PrHumanApproval = {
    login: "muratdev",
    commitSha: DELIVERED,
    at: "2026-08-08T09:00:00Z",
    userId: "u_murat",
    name: "Murat Test",
    status: "counted",
  };

  it("garbage in the file reads as 'no approval', never as a throw", () => {
    // `prRefSchema` is loose, so a hand-edited string under the approval key is
    // a type-valid PrRef — exactly the garbage a task.md can carry at rest.
    const pr: PrRef = { number: 1, state: "review", title: "t", humanApproval: "yes" };
    expect(readPrHumanApproval(pr)).toBeNull();
    expect(humanVerdictApproval({ pr, workRevision: revision() })).toBeNull();
  });

  it("names the human and the commit — a satisfied gate is never anonymous", () => {
    expect(humanVerdictNote(counted)).toContain("Murat Test (@muratdev)");
    expect(humanVerdictNote(counted)).toContain(DELIVERED.slice(0, 7));
  });
});

/**
 * The gate itself. This is the case gap [24] measured: a delivered task, a real
 * pull request, NO verdict-capable agent engaged — `deriveValidation` returns
 * `changed` forever and acceptance was reachable only through an admin
 * force-accept.
 */
describe("R19-B — the acceptance verdict gate accepts a member's GitHub approval", () => {
  const refusal = () =>
    acceptanceRefusalFor(
      { projectSlug: store.slug, taskKey: "VIB-301" },
      { dataRoot: store.dataRoot },
    );

  it("blocks with the ordinary sentence when nobody approved", () => {
    seedDeliveredTask(prWith(null));
    expect(refusal()).toContain("has no approving verdict yet");
    // The sentence now names the human path too, because there IS one.
    expect(refusal()).toContain("approve the pull request on GitHub");
  });

  it("UNBLOCKS once a project member approved the delivered revision", () => {
    seedDeliveredTask(
      prWith({
        login: "muratdev",
        commitSha: DELIVERED,
        at: "2026-08-08T09:00:00Z",
        userId: store.users.murat.id,
        name: store.users.murat.name,
        status: "counted",
      }),
    );
    expect(refusal()).toBeNull();
  });

  it("names the approver on the acceptance surface instead of going green in silence", () => {
    seedDeliveredTask(
      prWith({
        login: "muratdev",
        commitSha: DELIVERED,
        at: "2026-08-08T09:00:00Z",
        userId: store.users.murat.id,
        name: store.users.murat.name,
        status: "counted",
      }),
    );
    const affordance = acceptanceStanding(
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        viewerUserId: store.users.arda.id,
      },
      { dataRoot: store.dataRoot },
    ).affordance;
    expect(affordance.canAccept).toBe(true);
    expect(affordance.verdictSatisfiedBy).toContain("Approved on GitHub by");
    expect(affordance.verdictSatisfiedBy).toContain(store.users.murat.name);
  });

  it("STAYS BLOCKED on an approval of an older commit, and says which one", () => {
    seedDeliveredTask(
      prWith({
        login: "muratdev",
        commitSha: OLDER,
        at: null,
        userId: store.users.murat.id,
        name: store.users.murat.name,
        status: "stale_revision",
      }),
    );
    const reason = refusal();
    expect(reason).toContain("has no approving verdict yet");
    expect(reason).toContain(OLDER.slice(0, 7));
    expect(reason).toContain("not the delivered revision");
  });

  it("STAYS BLOCKED for an unmappable approver, and says why on the surface", () => {
    seedDeliveredTask(
      prWith({
        login: "octocat",
        commitSha: DELIVERED,
        at: null,
        userId: null,
        name: null,
        status: "unlinked_handle",
      }),
    );
    const affordance = acceptanceStanding(
      {
        projectSlug: store.slug,
        taskKey: "VIB-301",
        viewerUserId: store.users.arda.id,
      },
      { dataRoot: store.dataRoot },
    ).affordance;
    expect(affordance.canAccept).toBe(false);
    expect(affordance.verdictSatisfiedBy).toBeNull();
    expect(affordance.blockedReason).toContain("@octocat");
    expect(affordance.blockedReason).toContain(
      "no Viberr account carries that GitHub handle",
    );
    // Ruling 154: the way out is a door that exists on every deployment. The
    // old sentence sent people to a profile card that, without GitHub OAuth,
    // said there was nothing to connect.
    expect(affordance.blockedReason).toContain("Instance settings, Users & access");
    expect(affordance.blockedReason).not.toContain("Link it on their profile");
  });

  it("STAYS BLOCKED for a non-member's approval, and says so", () => {
    // Mapped, on the delivered commit: only the member check keeps it out.
    seedDeliveredTask(
      prWith({
        login: "deniz",
        commitSha: DELIVERED,
        at: null,
        userId: store.users.deniz.id,
        name: store.users.deniz.name,
        status: "not_a_member",
      }),
    );
    expect(refusal()).toContain(`${store.users.deniz.name} (@deniz)`);
    expect(refusal()).toContain("not a member of this project");
  });

  it("re-blocks the moment new work is delivered under a counted approval", () => {
    const counted: PrHumanApproval = {
      login: "muratdev",
      commitSha: DELIVERED,
      at: null,
      userId: store.users.murat.id,
      name: store.users.murat.name,
      status: "counted",
    };
    seedDeliveredTask(prWith(counted));
    expect(refusal()).toBeNull();
    // Same stored approval, a NEW delivered revision.
    seedDeliveredTask(prWith(counted), revision("aa11bb22cc33dd44ee55ff6677889900aabbccdd"));
    expect(refusal()).toContain("no longer the delivered revision");
  });
});
