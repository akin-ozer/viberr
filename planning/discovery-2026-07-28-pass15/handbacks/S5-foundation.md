# S5-foundation handbacks (pass 15, W5)

Work that belongs to items assigned to S5 but lives in files owned by another
stream. Each entry names the exact edit; the mechanism it needs already exists
and is unit-tested in an S5-owned file.

---

## H1 — B-FD5: `input_required` into the board's "Needs attention" filter

**File (not mine):** `app/features/board/board-filters.ts` — S6/UX is actively
editing it this pass (F15-16 search rework landed there mid-session).

**Change:** in `matchesBoardFilter`, the `risk` branch lists
`inconsistency_risk_detected` and `blocked` but not `input_required`, so the one
readiness value that literally means "a human must supply something" matches no
filter at all. Add it:

```ts
task.readiness === "input_required" ||
task.readiness === "inconsistency_risk_detected" ||
task.readiness === "blocked" ||
```

**Test to add** (`board-filters.test.ts`), fails on today's code:

```ts
it("`input_required` is Needs attention — a human has to supply something", () => {
  expect(matchesBoardFilter({ ...base, readiness: "input_required" }, "risk")).toBe(true);
});
```

The server half of B-FD5 (Home card counts + notifications inbox) is DONE in
`app/server/projections/decisions.server.ts`.

---

## H2 — B-FD8: wire the honest guardrail outcome into the comment writers

**Mechanism (mine, done + tested):** `app/server/tasks/comment-guardrails.server.ts`
now exports

- `applyCommentGuardrails({ text, previousText, meaningful, evidence, brevity, noDuplicate, brevityMax })`
  → `{ text: string | null, dropped: "meaningless" | "duplicate" | null, trimmedBy: [...] }`
- `commentOutcomeMessage(result)` → the honest tool-result string
- `COMMENT_DROPPED_AUDIT_ACTION = "task.comment.dropped"`

**Files (not mine):**

1. `app/server/tasks/operator-actions.server.ts`
   - `writeOperatorComment` (~:290-400) inlines the guardrail sequence and
     returns `void`. Replace the inline sequence with `applyCommentGuardrails`
     and return the result so the caller can report it. The dedupe is currently
     done inside the `updateTaskFile` callback against the last operator
     comment — keep reading `lastOperator` there and pass it as `previousText`.
   - **(a) honesty:** `operatorPostComment` (~:898-907) returns
     `{ outcome: "done", message: "Comment posted to the timeline." }`
     unconditionally. Return `commentOutcomeMessage(result)` instead (and
     `outcome: "noop"` when `result.dropped` is set), so a dropped/deduped
     narration is not reported as posted. `app/server/tasks/operator-toolkit.server.ts`
     (~:104-113) relays the message verbatim, so it needs no change.
   - **(b) mention fan-out before the trim:** the `notifyMentionedUsers` call at
     ~:369 passes the POST-trim `text`, so an `@handle` past the 1000-char
     brevity cap never notifies. Pass the ORIGINAL input text to the fan-out and
     the trimmed text to the file write. (`applyCommentGuardrails` deliberately
     returns the trimmed text separately for exactly this.)
   - **(c) audit parity:** both drop paths return with no audit row (the
     no-duplicate path leaves no log line either). Record
     `COMMENT_DROPPED_AUDIT_ACTION` with
     `details: { droppedByGuardrail: result.dropped, variant }` — parity with the
     agent-reply path's `task.agent.replied` + `droppedByGuardrail`
     (`task-actions.server.ts:1325-1343`).

2. `app/server/tasks/agent-toolkit.server.ts`
   - `postAgentComment` (~:83-129) is "guardrail-light" — it runs NO guardrail,
     and the tool always reports `[done]` (~:227). At minimum make the result
     honest once guardrails apply there; if the mid-run path stays
     guardrail-free by design, say so in the header comment instead of leaving
     it implicit.

**Tests:** the pure mechanism is covered in
`app/server/tasks/comment-guardrails.server.test.ts`
("applyCommentGuardrails + commentOutcomeMessage (B-FD8)"). The wiring needs one
test per call site: an operator comment of `"ok"` must come back as NOT posted
and leave a `task.comment.dropped` audit row; an `@handle` beyond the brevity cap
must still produce a `mention` notification.

---

## H3 — B-FD2: surface the ambiguous-mention policy note on human comments

**Mechanism (mine, done + tested):** `app/server/tasks/mention-notify.server.ts`
exports `fanOutMentions(db, input)` → `{ mentioned, ambiguous }` and
`ambiguousMentionNote(handles)`. `notifyMentionedUsers` keeps its old
`string[]` shape, so nothing breaks until a caller opts in.

**File (not mine):** `app/server/tasks/task-actions.server.ts`, `appendComment`
(~:664-765, the fan-out call at ~:741).

**Change:** switch that call to `fanOutMentions`; when `ambiguous.length > 0`,
append a `note`-typed timeline event (or a policy stub) carrying
`ambiguousMentionNote(ambiguous)` so the author sees that the tag reached
nobody. Human comments are the only path where the note is actionable — the
author is still on the page and is the only one who can retag.

**Test:** two enabled users named "Arda …"; a comment "@arda ping" writes no
`mention` notification and the task timeline gains the note.

---

## H4 — B-FD6: render notification rows that have no destination

**Mechanism (mine, done + tested):** `listNotifications` now returns
`NotificationListItem[]` = `NotificationRecord & { href: string | null }`, with
`notificationHref` exported from
`app/server/projections/notifications.server.ts`:
task ref → `/projects/<slug>/tasks/<key>`, project-only ref →
`/projects/<slug>`, no project ref → `null`.

**Files (not mine):** `app/routes/notifications.tsx` (~:105-108) and the
`NotificationsPage`/`TopBell` row components.

**Change:** `openItem` currently does nothing when a row lacks `taskKey` — a
dead click that looks identical to a live one. Navigate to `n.href` when it is
non-null, and give `href === null` rows a non-interactive presentation (no
pointer cursor, not focusable, no hover affordance). Project-only rows now have
somewhere real to go.

**Test:** a `policy` notification with no project ref renders non-clickable; a
project-scoped one navigates to the board.

---

## H5 — B-FD9: run compaction on the agent write paths

**Mechanism (mine, done + tested):** `compactTimelineEvents` now folds
agent-authored comments (keeping the newest reply of each run as rework
evidence) and never folds a human comment.

**Files (not mine):** `app/server/tasks/task-actions.server.ts`
(`postAgentReplyComment`, ~:1345-1406) and
`app/server/tasks/agent-toolkit.server.ts` (`postAgentComment`, ~:83-129).

**Change:** neither path calls `compactTimelineEvents`, so an agent-heavy
timeline only shrinks when a human or the operator next comments. Add the same
`compression-threshold`-gated compaction call the human/operator writers use
(`task-actions.server.ts:707-724`, `operator-actions.server.ts:337-350` — both
derive `keepRecent = min(24, max(4, floor(value / 2)))`).

**Test:** 60 consecutive agent replies on one task; after the next agent reply
the canonical timeline contains a `Compacted` marker and exactly one surviving
agent reply from the folded run.
