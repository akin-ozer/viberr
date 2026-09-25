import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDbContext } from "../../../test-support/test-db";
import {
  baseTaskFrontmatter,
  setupTestStore,
  writeProject,
  writeTask,
  type TestStore,
} from "../../../test-support/test-store";
import { insertUser } from "~/server/auth/user-store.server";
import { readProjectFile } from "~/server/files/project-writer.server";
import { readTaskFile } from "~/server/files/task-writer.server";
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  ambiguousMentionNote,
  fanOutMentions,
  mentionNonDeliveryNote,
  nonMemberMentionNote,
  notifyMentionedUsers,
  RESERVED_HANDLES,
  resolveMentionTargets,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import { postAgentComment } from "./agent-toolkit.server";
import { relayToTask } from "./task-relay.server";
import {
  operatorDispatchAgent,
  operatorPostComment,
  resolveOperatorAuthority,
} from "./operator-actions.server";
import {
  appendComment,
  operatorPromptAgent,
  postAgentReplyComment,
  recordAgentCompletion,
} from "./task-actions.server";
import type { FileActorRef } from "~/schemas/task-file.schema";
import type { ActorRender } from "~/shared/mapping/actor.server";

/**
 * NEW-4: the shared @mention → `mention`-notification fan-out. Every comment
 * writer (human appendComment AND the agent/operator writers) funnels through
 * this helper, so the matching rules asserted here are THE routing contract.
 */

const ctx = createTestDbContext();
afterEach(ctx.cleanup);

const OPERATOR_FROM: ActorRender = { kind: "agent", name: "Operator" };

function notificationRows(store: TestStore) {
  return store.db
    .prepare(`SELECT user_id, kind, text, actor_json FROM notifications ORDER BY user_id`)
    .all();
}

describe("notifyMentionedUsers", () => {
  it("matches by first name and email local-part, case-insensitively, with the agent as `from`", () => {
    const store = setupTestStore(ctx);
    const selinLocal = store.users.selin.email.split("@")[0]!; // e.g. selin7
    const matched = notifyMentionedUsers(store.db, {
      text: `@ARDA the review is clean; @${selinLocal} please take acceptance.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(new Set(matched)).toEqual(
      new Set([store.users.arda.id, store.users.selin.id]),
    );
    const rows = notificationRows(store);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe("mention");
      expect(JSON.parse(String(row.actor_json))).toEqual(OPERATOR_FROM);
    }
  });

  it("a multi-word display-name mention (@Arda Test) matches via its first token", () => {
    const store = setupTestStore(ctx);
    const matched = notifyMentionedUsers(store.db, {
      text: `@${store.users.arda.name} the file listing landed — over to you.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([store.users.arda.id]);
  });

  it("reserved agent handles never notify a person; no handles → no rows", () => {
    const store = setupTestStore(ctx);
    expect(
      notifyMentionedUsers(store.db, {
        text: "@operator @agent @claude @codex all reserved",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([]);
    expect(
      notifyMentionedUsers(store.db, {
        text: "no mentions here at all",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("skips exactly the reserved handles plus the controller's (ruling 99)", () => {
    // Derived from the one home in ~/ui/mention-spans; this pins its members.
    expect([...RESERVED_HANDLES].sort()).toEqual([
      "agent",
      "claude",
      "codex",
      "controller",
      "operator",
    ]);
    // A person whose handles spell a reserved word is still never the target.
    const users = [
      { id: "u_ctl", email: "controller@viberr.test", name: "Controller" },
      { id: "u_cla", email: "claude@viberr.test", name: "Claude" },
    ];
    expect(resolveMentionTargets(users, "@controller @claude look").userIds).toEqual([]);
  });

  it("never notifies the excluded author, and skips disabled users", () => {
    const store = setupTestStore(ctx);
    store.db
      .prepare(`UPDATE users SET disabled = 1 WHERE id = ?`)
      .run(store.users.selin.id);
    const matched = notifyMentionedUsers(store.db, {
      text: "@arda @selin ping",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
      excludeUserId: store.users.arda.id,
    });
    expect(matched).toEqual([]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("clips a long agent report in the notification text (the timeline keeps the rest)", () => {
    const store = setupTestStore(ctx);
    const report = `@arda done. ${"evidence ".repeat(80)}`;
    notifyMentionedUsers(store.db, {
      text: report,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    const [row] = notificationRows(store);
    expect(String(row!.text).length).toBeLessThan(300);
    expect(row!.text).toContain("mentioned you");
    expect(row!.text).toContain("…");
  });

  /**
   * Ruling 233 — the quote must contain the mention it was sent for.
   *
   * The head clip is the right window only when the handle is near the top. An
   * operator directive opens by naming the AGENT it is dispatching and reaches
   * the person hundreds of characters later; measured on pass 37's live
   * instance, 19 of 49 mention notifications quoted a window that excluded the
   * handle they were sent for, so the row read "mentioned you" above a sentence
   * addressed to somebody else.
   */
  it("quotes the window around the mention when the handle sits past the cap (ruling 233)", () => {
    const store = setupTestStore(ctx);
    const head = "@Platform Architect, revise the deliverable on the task branch.";
    const directive =
      `${head} ${"Keep the diff inside the owned path. ".repeat(8)}` +
      "Ensure the document ends with an explicit @arda question naming every option.";
    // The premise: the handle is genuinely outside the head window.
    expect(directive.indexOf("@arda")).toBeGreaterThan(240);

    notifyMentionedUsers(store.db, {
      text: directive,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });

    const [row] = notificationRows(store);
    const text = String(row!.text);
    expect(text).toContain("@arda question naming every option");
    // …and it is still a quote, not the whole comment.
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("…");
    // The head the old clip showed is text addressed to somebody else.
    expect(text).not.toContain(head);
  });

  it("keeps the head window when the mention is already inside it (ruling 233)", () => {
    const store = setupTestStore(ctx);
    const report = `@arda done. ${"evidence ".repeat(80)}`;
    notifyMentionedUsers(store.db, {
      text: report,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    const [row] = notificationRows(store);
    // Unchanged by ruling 233: no leading ellipsis, opens on the comment.
    expect(String(row!.text)).toContain("mentioned you — “@arda done.");
  });

  /**
   * Ruling 232 (owner, 2026-09-14) — a comment whose DECLARED audience is the
   * agent notifies no person. Asserted at the seam, so every writer that
   * declares it inherits the rule; `operatorPromptAgent` proves it end to end
   * in the writer-enumeration block below.
   */
  it("a declared agent audience notifies nobody (ruling 232)", () => {
    const store = setupTestStore(ctx);
    const directive =
      "@dev implement the cart endpoint, and leave the schema question for @arda.";

    const open = notifyMentionedUsers(store.db, {
      text: directive,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(open).toEqual([store.users.arda.id]);
    expect(notificationRows(store)).toHaveLength(1);

    const toAgent = notifyMentionedUsers(store.db, {
      text: directive,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
      audience: "agent",
    });
    expect(toAgent).toEqual([]);
    // The same text, the same resolvable handle, and no second row.
    expect(notificationRows(store)).toHaveLength(1);
  });
});

/**
 * B-FD2: a mention addresses ONE person. On a team with two Ardas the flat
 * first-name OR notified both, and neither could tell who was meant.
 */
describe("mention disambiguation (B-FD2)", () => {
  /** A second Arda: same first name, distinct local-part and full name. */
  function addSecondArda(store: TestStore) {
    return insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
  }

  it("an ambiguous FIRST-NAME mention notifies nobody and is reported back", () => {
    const store = setupTestStore(ctx);
    addSecondArda(store);
    const result = fanOutMentions(store.db, {
      text: "@arda can you take acceptance?",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.ambiguous).toEqual(["arda"]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("the full display name and its dashed form each route to exactly one Arda", () => {
    const store = setupTestStore(ctx);
    const second = addSecondArda(store);
    expect(
      notifyMentionedUsers(store.db, {
        text: `@${store.users.arda.name} please look`,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([store.users.arda.id]);
    expect(
      notifyMentionedUsers(store.db, {
        text: "@arda-yilmaz please look",
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([second.id]);
  });

  it("an exact email local-part outranks another user's first name", () => {
    const store = setupTestStore(ctx);
    // A user whose local-part IS someone else's first name: the handle belongs
    // to its owner, not to the person who happens to be called that.
    const impostor = insertUser(store.db, {
      id: "u_localpart_owner",
      email: "murat@viberr.test",
      name: "Deniz Kara",
      role: "member",
    });
    const matched = notifyMentionedUsers(store.db, {
      text: "@murat over to you",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([impostor.id]);
  });

  it("one person tagged twice in a comment gets ONE notification", () => {
    const store = setupTestStore(ctx);
    const local = store.users.selin.email.split("@")[0]!;
    const matched = notifyMentionedUsers(store.db, {
      text: `@${local} and @${store.users.selin.name} — same person, one ping.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(matched).toEqual([store.users.selin.id]);
    expect(notificationRows(store)).toHaveLength(1);
  });

  it("ambiguity is judged before the author exclusion", () => {
    const store = setupTestStore(ctx);
    addSecondArda(store);
    // One Arda writing "@arda" must NOT be silently redirected to the other.
    const result = fanOutMentions(store.db, {
      text: "@arda take it from here",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
      excludeUserId: store.users.arda.id,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.ambiguous).toEqual(["arda"]);
  });

  it("resolveMentionTargets is pure and keeps users-table order", () => {
    const users = [
      { id: "u1", email: "arda.kaya@x.test", name: "Arda Kaya" },
      { id: "u2", email: "selin@x.test", name: "Selin Ay" },
      { id: "u3", email: "arda.yilmaz@x.test", name: "Arda Yilmaz" },
    ];
    expect(resolveMentionTargets(users, "@selin @arda-kaya ship it")).toEqual({
      userIds: ["u1", "u2"],
      // Ruling 233: which handle won which user, so a caller can quote the
      // span that actually names the recipient.
      matchedBy: new Map([
        ["selin", "u2"],
        ["arda-kaya", "u1"],
      ]),
      ambiguous: [],
      nonMembers: [],
    });
    expect(resolveMentionTargets(users, "@arda ship it")).toEqual({
      userIds: [],
      matchedBy: new Map(),
      ambiguous: ["arda"],
      nonMembers: [],
    });
  });

  it("the non-delivery note names the handle and both unambiguous forms", () => {
    expect(ambiguousMentionNote([])).toBe("");
    const note = ambiguousMentionNote(["arda"]);
    expect(note).toContain("@arda");
    expect(note).toContain("nobody was notified");
    expect(note).toContain("email handle");
  });

  it("the appended disclosure closes an unclosed ``` fence so the note renders as prose", () => {
    // Ruling-104 review: the operator-brevity truncation was the only code that
    // balanced fences before a tail was appended; with it gone, the disclosure
    // append is the one tail-adder and owns the balance. An author text ending
    // inside an open fence must not swallow the note into a code block.
    const store = setupTestStore(ctx);
    addSecondArda(store);
    const text = "@arda decide please. Output:\n```\nlog line 1\nlog line 2";
    const out = withAmbiguityDisclosure(store.db, text);
    expect(out).toContain("nobody was notified");
    // Fences in the result are balanced, and the note sits OUTSIDE the fence.
    expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(out.indexOf("nobody was notified")).toBeGreaterThan(out.lastIndexOf("```"));
    // A balanced text is left untouched apart from the appended note.
    const balanced = "@arda decide please.\n```\nlog\n```";
    expect(withAmbiguityDisclosure(store.db, balanced).startsWith(balanced)).toBe(true);
  });
});

/**
 * F33-9 — a mention may not cross the members-only boundary (ruling 25).
 *
 * Live: a project admin commented on `sandbox/SBX-3` tagging a viewer of a
 * DIFFERENT project. Her inbox showed "mentioned you — '@Elif Maintainer can you
 * look at this sandbox probe?'  Sandbox · SBX-3", and opening it gave "Page not
 * found — No project at projects/sandbox". Two failures in one row: a
 * notification that routes a person to a task the product then refuses to show
 * them, and a disclosure that the layout loader and every action work to
 * prevent — they return the SAME bytes for a non-member as for an unknown slug
 * so "a probe cannot learn a project exists", and the row named the project, the
 * task AND what someone wrote on it.
 *
 * The fixture's `deniz` is a registered, enabled, NON-member — the finding's
 * shape exactly.
 */
describe("mentions stay inside the project (F33-9)", () => {
  /** Project the fixture, i.e. put the store in the shape every RUNNING instance
   *  is in (boot rebuild + reproject on every project write) — that is what lets
   *  `project_members` answer the boundary question at all. */
  function project(store: TestStore): void {
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1"),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  const localPartOf = (email: string) => email.split("@")[0]!;

  it("a MACHINE-authored comment discloses the non-member tag, which needs the project slug", () => {
    // `withAmbiguityDisclosure`'s third argument is what lets it resolve
    // membership at all — its own docblock says "pass it whenever the comment
    // belongs to a project, or a non-member tag is dropped without the author
    // being told". Every writing call site omitted it, so a machine-authored
    // comment disclosed the AMBIGUOUS half and stayed silent about the
    // non-member half, which the fan-out drops. An agent cannot retag itself,
    // so its comment is the only surface a human would ever read this on.
    // Canary: drop the slug argument and the disclosure comes back unchanged.
    const store = setupTestStore(ctx);
    project(store);
    const handle = localPartOf(store.users.deniz.email);
    const text = `@${handle} can you look at this sandbox probe?`;

    // Without the slug: nothing to say, because membership is unknown.
    expect(withAmbiguityDisclosure(store.db, text)).toBe(text);

    // With it: the author is told the tag reached nobody.
    const disclosed = withAmbiguityDisclosure(store.db, text, store.slug);
    expect(disclosed).not.toBe(text);
    expect(disclosed).toContain(handle);
    expect(disclosed).toContain("not a member");
  });

  it("a non-member is NOT notified, and the handle comes back as a non-delivery", () => {
    const store = setupTestStore(ctx);
    project(store);
    const handle = localPartOf(store.users.deniz.email);
    const result = fanOutMentions(store.db, {
      text: `@${handle} can you look at this sandbox probe?`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.nonMembers).toEqual([handle]);
    expect(result.ambiguous).toEqual([]);
    // The whole point: no inbox row exists to leak the project, the task or the
    // comment text to someone who cannot open any of them.
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("the human comment path writes the non-delivery next to the comment", async () => {
    // The seam, not the note: `appendComment` used to ask only for the ambiguous
    // handles, with no project, so the F33-9 half of the report never reached
    // the author — proven live before this test existed
    // (the comment landed, the notification was correctly withheld, and nothing
    // on the page said the tag had gone nowhere).
    const store = setupTestStore(ctx);
    project(store);
    await appendComment(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        text: `@${localPartOf(store.users.deniz.email)} post-fix probe: can you see this?`,
      },
      { userId: store.users.arda.id, label: store.users.arda.email },
      { dataRoot: store.dataRoot },
    );
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const note = file.parsed.timeline.find(
      (e) => e.type === "note" && /is not a member of this project/.test(e.text),
    );
    expect(note).toBeDefined();
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("the full-name form is refused too — it is membership, not the handle spelling", () => {
    const store = setupTestStore(ctx);
    project(store);
    const result = fanOutMentions(store.db, {
      text: `@${store.users.deniz.name} can you look at this?`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([]);
    expect(notificationRows(store)).toHaveLength(0);
  });

  it("members in the same comment are still notified", () => {
    const store = setupTestStore(ctx);
    project(store);
    const result = fanOutMentions(store.db, {
      text: `@${localPartOf(store.users.selin.email)} over to you — @${localPartOf(
        store.users.deniz.email,
      )} FYI.`,
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([store.users.selin.id]);
    expect(result.nonMembers).toEqual([localPartOf(store.users.deniz.email)]);
    expect(notificationRows(store)).toHaveLength(1);
  });

  it("a non-member sharing a member's first name keeps the handle AMBIGUOUS, not deliverable", () => {
    const store = setupTestStore(ctx);
    project(store);
    // Resolution runs over all enabled users on purpose: narrowing the ladder to
    // members first would silently hand "@arda" to the member, which is the
    // guess B-FD2 exists to refuse.
    insertUser(store.db, {
      id: "u_arda_outsider",
      email: "arda.outsider@viberr.test",
      name: "Arda Outsider",
      role: "member",
    });
    const result = fanOutMentions(store.db, {
      text: "@arda take it from here",
      projectSlug: store.slug,
      taskKey: "VIB-1",
      from: OPERATOR_FROM,
    });
    expect(result.mentioned).toEqual([]);
    expect(result.ambiguous).toEqual(["arda"]);
    expect(result.nonMembers).toEqual([]);
  });

  it("the note names the handle and says the person is not a member", () => {
    expect(nonMemberMentionNote([])).toBe("");
    const one = nonMemberMentionNote(["elif"]);
    expect(one).toContain("@elif");
    expect(one).toContain("is not a member of this project");
    expect(one).toContain("nobody was notified");
    expect(nonMemberMentionNote(["elif", "deniz"])).toContain(
      "@elif, @deniz are not members",
    );
  });

  it("mentionNonDeliveryNote reports BOTH reasons a tag reached nobody", () => {
    const store = setupTestStore(ctx);
    project(store);
    insertUser(store.db, {
      id: "u_arda_second",
      email: "arda.yilmaz@viberr.test",
      name: "Arda Yilmaz",
      role: "member",
    });
    const deniz = localPartOf(store.users.deniz.email);
    const note = mentionNonDeliveryNote(
      store.db,
      `@arda and @${deniz} — please pick this up.`,
      store.slug,
    );
    expect(note).toContain("@arda matches more than one person");
    expect(note).toContain(`@${deniz} is not a member of this project`);
    // Nothing to say when every handle routed.
    expect(
      mentionNonDeliveryNote(
        store.db,
        `@${localPartOf(store.users.selin.email)} over to you`,
        store.slug,
      ),
    ).toBe("");
  });

  it("a MACHINE author's comment carries the non-member disclosure", () => {
    const store = setupTestStore(ctx);
    project(store);
    const deniz = localPartOf(store.users.deniz.email);
    const text = `@${deniz} the reviewer approved — acceptance is yours.`;
    // An agent cannot retag itself, so the comment is the only surface that can
    // say the tag went nowhere (the withAmbiguityDisclosure rationale, widened).
    expect(withAmbiguityDisclosure(store.db, text, store.slug)).toContain(
      "is not a member of this project",
    );
    // …and without the slug the caller gets the app-wide answer it asked for.
    expect(withAmbiguityDisclosure(store.db, text)).toBe(text);
  });

  it("a store with no projected project resolves app-wide (membership unknown)", () => {
    // `projects` empty means nothing here has ever been projected — a file-only
    // fixture, or a read before the boot rebuild. Scoping to an EMPTY member set
    // there would stop every mention in the app, so the scope is left off; a
    // projected project with zero members still refuses everyone.
    const store = setupTestStore(ctx);
    expect(
      notifyMentionedUsers(store.db, {
        text: `@${localPartOf(store.users.deniz.email)} ping`,
        projectSlug: store.slug,
        taskKey: "VIB-1",
        from: OPERATOR_FROM,
      }),
    ).toEqual([store.users.deniz.id]);
  });
});

/* ------------------------------------------------ the writers, enumerated */

/**
 * NEW-4 is not "the helper works" — it is "**every** comment writer uses it".
 * The convention exists because the fan-out was wired into ONE writer (the human
 * `appendComment`) while the agents were being instructed to "@tag the human you
 * answer"; every machine-authored tag was decoration. It has since regressed
 * exactly this way twice more on writers nobody had counted — P14-GV-06
 * (`operatorPromptAgent` wrote the timeline directly) and P13-RT-01 (the FINISHED
 * completion path, i.e. the majority of all agent tags, on BOTH backends).
 *
 * So this drives every writer through its real seam and asserts the ping lands.
 * A writer that forgets the helper fails HERE, in one place, with its own name
 * on the failure — and {@link COMMENT_WRITER_SITES} below fails when a writer is
 * ADDED that this table does not cover.
 */
describe("every comment writer notifies the human it @tags (NEW-4)", () => {
  const AGENT: FileActorRef = {
    kind: "agent",
    backend: "claude",
    profileId: "developer",
    roleHint: "Implementation",
  };

  /** A task owned by Arda, plus the roster the operator writers need. */
  function seed(store: TestStore, withRoster: boolean): void {
    if (withRoster) {
      const file = readProjectFile({
        projectSlug: store.slug,
        dataRoot: store.dataRoot,
      })!;
      writeProject(store.dataRoot, {
        ...file.parsed.frontmatter,
        repo: null,
        agents: [
          {
            profileId: "operator",
            capabilities: [
              { capabilityId: "append-typed-events", mode: "direct" },
              // `recommend` is what routes operatorDispatchAgent into
              // addRecommendation — the writer under test in that row.
              { capabilityId: "dispatch-agents", mode: "recommend" },
            ],
            extras: [],
            definition: {
              kind: "operator",
              name: "Operator",
              backends: ["claude"],
              model: "sonnet",
            },
          },
          {
            profileId: "developer",
            capabilities: [],
            extras: [],
            definition: {
              kind: "specialist",
              name: "Dev",
              role: "Implementation",
              backends: ["claude"],
              model: "sonnet",
            },
          },
        ],
      });
    }
    writeTask(store.dataRoot, store.slug, {
      frontmatter: baseTaskFrontmatter("VIB-1", {
        stage: "impl",
        ownerUserId: store.users.arda.id,
      }),
    });
    rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
  }

  /**
   * Every writer that appends a `comment` timeline event, each driven through the
   * function a run/route actually calls. `roster` is only about what the writer
   * needs to exist, never about the fan-out.
   */
  const WRITERS: {
    name: string;
    roster: boolean;
    write: (store: TestStore, tag: string) => Promise<void>;
  }[] = [
    {
      name: "appendComment (a human comment)",
      roster: false,
      // Authored by Selin so the tag is not the author's own (never self-notify).
      write: async (store, tag) => {
        await appendComment(
          store.db,
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            text: `${tag} can you take the acceptance gate?`,
          },
          { userId: store.users.selin.id, label: store.users.selin.email },
          { dataRoot: store.dataRoot },
        );
      },
    },
    {
      name: "postAgentReplyComment (an interrupted/errored agent reply)",
      roster: false,
      write: async (store, tag) => {
        await postAgentReplyComment(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            runId: "run_reply",
            actorRef: AGENT,
            replyText: `${tag} I stopped at the migration — your call on the schema.`,
          },
        );
      },
    },
    {
      name: "recordAgentCompletion (the FINISHED run — the common case)",
      roster: false,
      write: async (store, tag) => {
        await recordAgentCompletion(
          store.db,
          { dataRoot: store.dataRoot },
          store.slug,
          "VIB-1",
          {
            actorRef: AGENT,
            runId: "run_done",
            replyText: `${tag} implemented and self-checked; over to you.`,
            verdict: null,
            question: null,
          },
        );
      },
    },
    {
      name: "operatorPostComment (operator narration)",
      roster: true,
      write: async (store, tag) => {
        const result = await operatorPostComment(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            text: `${tag} the reviewer approved — acceptance is yours.`,
          },
          resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
            autonomy: "supervised",
          }),
        );
        // Guard the setup, not the behavior: a denied write would fan nothing
        // out for a reason that has nothing to do with NEW-4.
        expect(result.outcome).toBe("done");
      },
    },
    {
      name: "addRecommendation (the operator's recommendation reasoning)",
      roster: true,
      write: async (store, tag) => {
        const result = await operatorDispatchAgent(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            profileId: "developer",
            reason: `${tag} I want the Dev on this — confirm and I'll start its run.`,
          },
          resolveOperatorAuthority({ dataRoot: store.dataRoot }, store.slug, {
            autonomy: "supervised",
          }),
        );
        expect(result.outcome).toBe("recommended");
      },
    },
    {
      name: "postAgentComment (an agent's mid-run comment tool)",
      roster: false,
      write: async (store, tag) => {
        await postAgentComment(
          store.db,
          { dataRoot: store.dataRoot },
          {
            projectSlug: store.slug,
            taskKey: "VIB-1",
            actorRef: AGENT,
            text: `${tag} heads-up mid-run: the fixture data is stale.`,
          },
        );
      },
    },
    {
      // Ruling 488: a relay from another task lands on VIB-1 as a comment.
      name: "relayToTask (another task's relay, the operator's or an agent's)",
      roster: false,
      write: async (store, tag) => {
        writeTask(store.dataRoot, store.slug, {
          frontmatter: baseTaskFrontmatter("VIB-2", { stage: "impl", ownerUserId: store.users.arda.id }),
        });
        rebuildAll(store.db, { dataRoot: store.dataRoot, force: true });
        const result = await relayToTask(store.db, { dataRoot: store.dataRoot }, {
          projectSlug: store.slug,
          fromTaskKey: "VIB-2",
          toTaskKey: "VIB-1",
          text: `${tag} the deployed CPU numbers you asked for: 5 ms and 6 ms of 10.`,
          author: { actorRef: AGENT, name: "Dev", auditActor: { userId: null, label: "agent" }, notifyFrom: OPERATOR_FROM },
        });
        expect(result.outcome).toBe("done");
      },
    },
  ];

  for (const writer of WRITERS) {
    it(`${writer.name} fans the mention out`, async () => {
      const store = setupTestStore(ctx);
      seed(store, writer.roster);
      // The email local-part is the unambiguous tier of the routing ladder, so
      // this test measures the fan-out and not name collisions in the fixture.
      const tag = `@${store.users.arda.email.split("@")[0]}`;

      await writer.write(store, tag);

      const mentions = notificationRows(store).filter(
        (r) => r.kind === "mention",
      );
      expect(mentions).toHaveLength(1);
      expect(mentions[0]!.user_id).toBe(store.users.arda.id);
      expect(mentions[0]!.text).toContain("mentioned you");
      // …and it says WHO tagged them: a bare row with no author is how a
      // machine-authored ping reads as a system notice instead of an answer.
      expect(mentions[0]!.actor_json).toBeTruthy();
      // Ruling 382 (F39-9): the EVENT records who the fan-out reached, so
      // compaction can never fold a comment somebody was told about. Asserted
      // here, on the same enumerated table, because a writer that notifies but
      // does not stamp leaves the notification pointing at text the canonical
      // file will delete — and the marker would still read "human comments are
      // never compacted". CANARY: drop `stampNotifiedRecipients` from any
      // writer and that writer's row fails with its own name.
      const stamped = readTaskFile({
        projectSlug: store.slug,
        taskKey: "VIB-1",
        dataRoot: store.dataRoot,
      })!.parsed.timeline.filter((e) =>
        (e.notified ?? []).includes(store.users.arda.id),
      );
      expect(
        stamped.length,
        `${writer.name} notified Arda but stamped no event with it`,
      ).toBe(1);
    });
  }

  /**
   * Ruling 232 (owner, 2026-09-14) — the ONE writer that must NOT fan out to a
   * person, and the reason it is carved out of the table above rather than
   * missing from it.
   *
   * `operatorPromptAgent` writes the operator's directive to a specialist, so
   * its declared audience is the agent. P14-GV-06 had added the fan-out here
   * because "…coordinate with @Arda" inside a directive was a real ping going
   * nowhere. Pass 37 measured what those tags actually are on a live instance:
   * 19 of 49 mention notifications came from directives where the handle was the
   * operator specifying a deliverable ("end with an explicit @Arda question"),
   * re-sent on every rework round. Viberr cannot tell the two apart by parsing,
   * and the owner ruled that a declared-agent audience notifies nobody.
   *
   * The directive below is P14-GV-06's own shape verbatim, so this test fails
   * the moment the audience stops being declared at that call site.
   */
  it("operatorPromptAgent notifies nobody: its audience is the agent (ruling 232)", async () => {
    const store = setupTestStore(ctx);
    seed(store, false);
    const tag = `@${store.users.arda.email.split("@")[0]}`;
    // No specialist is deployed, so the RUN cannot start (the auto-engage
    // refuses an undeployed profileId) — but the directive COMMENT is written
    // before the run is triggered, which is the writer under test.
    await operatorPromptAgent(
      store.db,
      {
        projectSlug: store.slug,
        taskKey: "VIB-1",
        directive: `Implement the fix and coordinate with ${tag} on the copy.`,
        profileId: "developer",
        handle: "dev",
      },
      { dataRoot: store.dataRoot },
    ).catch(() => {});

    expect(notificationRows(store).filter((r) => r.kind === "mention")).toEqual([]);
    // The comment itself still lands, tagged to-agent: the ruling changes who
    // hears about it, not whether the hand-off is on the record.
    const file = readTaskFile({
      projectSlug: store.slug,
      taskKey: "VIB-1",
      dataRoot: store.dataRoot,
    })!;
    const directive = file.parsed.timeline.find((e) => e.type === "comment");
    expect(directive?.toAgent).toBe(true);
    expect(directive?.text).toContain(tag);
  });

  /**
   * The completeness half. The table above is hand-written, so it can only fail
   * for a writer someone remembered to add to it — which is precisely NOT the
   * failure mode NEW-4 exists for (three separate writers were each missed by
   * everyone who touched them). This pins the SOURCE sites that append a
   * `comment` timeline event: a new one fails here until its author both wires
   * the fan-out and adds a row above.
   *
   * `task-actions.server.ts` has 4 sites serving 4 writers — `postAgentReplyComment`
   * and `recordAgentCompletion` share `prepareAgentReplyEvent`'s single
   * construction and fan out separately, which is exactly why site count and
   * writer count are pinned apart, and its fourth site announces ruling 237's
   * deadlock packet (see `SITES_WITHOUT_MENTIONS`).
   */
  const COMMENT_WRITER_SITES = {
    "server/tasks/task-actions.server.ts": 4,
    "server/tasks/operator-actions.server.ts": 2,
    "server/tasks/agent-toolkit.server.ts": 1,
    // Ruling 488: the relay's comment on the target task.
    "server/tasks/task-relay.server.ts": 1,
    // The ONE site that must NOT fan out: the compaction marker is synthesized
    // FROM events already on the timeline (whose mentions were fanned out when
    // they were written). Re-notifying on a fold would ping people for a
    // housekeeping pass.
    "server/tasks/timeline-compaction.server.ts": 1,
  } satisfies Readonly<Record<string, number>>;
  const NO_FANOUT_BY_DESIGN = new Set([
    "server/tasks/timeline-compaction.server.ts",
  ]);
  /**
   * Sites inside a fanning-out file whose event text cannot carry a human
   * @mention, counted out of the writer floor below so it stays a real floor.
   *
   * Ruling 237's deadlock announcement is the only one: the text is built from
   * a constant and the packet title, and the packet is announced to people
   * through `notifyTaskWatchers` in the same breath. Per FILE is the wrong
   * granularity for it — `task-actions.server.ts` fans out on three other
   * sites, and exempting the file would stop checking them.
   */
  const SITES_WITHOUT_MENTIONS = 1;

  const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  }

  it("no comment writer exists that this file does not account for", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(APP)) {
      // The object-literal shape every timeline-event construction uses;
      // `e.type === "comment"` comparisons are a different shape and out of scope.
      const hits = readFileSync(file, "utf8").match(/\btype:\s*"comment"/g);
      if (hits) found[path.relative(APP, file)] = hits.length;
    }
    expect(found).toEqual(COMMENT_WRITER_SITES);

    for (const file of Object.keys(COMMENT_WRITER_SITES)) {
      if (NO_FANOUT_BY_DESIGN.has(file)) continue;
      const src = readFileSync(path.join(APP, file), "utf8");
      expect(
        /\b(notifyMentionedUsers|fanOutMentions)\s*\(/.test(src),
        `${file} appends comments but never calls the shared mention fan-out`,
      ).toBe(true);
    }
    // Every writer the table drives is covered; the counts differ on purpose
    // (see the doc comment) so this asserts the direction that matters.
    expect(WRITERS.length).toBeGreaterThanOrEqual(
      Object.entries(COMMENT_WRITER_SITES)
        .filter(([f]) => !NO_FANOUT_BY_DESIGN.has(f))
        .reduce((n, [, c]) => n + c, 0) - SITES_WITHOUT_MENTIONS,
    );
  });
});
