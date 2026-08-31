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
import { rebuildAll } from "~/server/projections/rebuilder.server";
import {
  ambiguousMentionNote,
  fanOutMentions,
  notifyMentionedUsers,
  resolveMentionTargets,
  withAmbiguityDisclosure,
} from "./mention-notify.server";
import { postAgentComment } from "./agent-toolkit.server";
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
      ambiguous: [],
    });
    expect(resolveMentionTargets(users, "@arda ship it")).toEqual({
      userIds: [],
      ambiguous: ["arda"],
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
      name: "operatorPromptAgent (the operator's directive comment)",
      roster: false,
      write: async (store, tag) => {
        // No specialist is deployed, so the RUN cannot start (the auto-engage
        // refuses an undeployed profileId) — but the directive COMMENT is
        // written (and fanned out) before the run is triggered, which is the
        // writer under test. This is the P14-GV-06 shape verbatim.
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
    });
  }

  /**
   * The completeness half. The table above is hand-written, so it can only fail
   * for a writer someone remembered to add to it — which is precisely NOT the
   * failure mode NEW-4 exists for (three separate writers were each missed by
   * everyone who touched them). This pins the SOURCE sites that append a
   * `comment` timeline event: a new one fails here until its author both wires
   * the fan-out and adds a row above.
   *
   * `task-actions.server.ts` has 3 sites serving 4 writers — `postAgentReplyComment`
   * and `recordAgentCompletion` share `prepareAgentReplyEvent`'s single
   * construction and fan out separately, which is exactly why site count and
   * writer count are pinned apart.
   */
  const COMMENT_WRITER_SITES = {
    "server/tasks/task-actions.server.ts": 3,
    "server/tasks/operator-actions.server.ts": 2,
    "server/tasks/agent-toolkit.server.ts": 1,
    // The ONE site that must NOT fan out: the compaction marker is synthesized
    // FROM events already on the timeline (whose mentions were fanned out when
    // they were written). Re-notifying on a fold would ping people for a
    // housekeeping pass.
    "server/tasks/timeline-compaction.server.ts": 1,
  } satisfies Readonly<Record<string, number>>;
  const NO_FANOUT_BY_DESIGN = new Set([
    "server/tasks/timeline-compaction.server.ts",
  ]);

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
        .reduce((n, [, c]) => n + c, 0),
    );
  });
});
