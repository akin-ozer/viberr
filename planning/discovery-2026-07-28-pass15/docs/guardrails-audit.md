# Code map: comment guardrails, compaction, audit/retention, provenance, mentions, model-prose, gagents, env, logging/errors

Pass-15 discovery. Every claim cites `path:line`. Special focus: paths where user-visible content is silently suppressed.

## Comment guardrails (`app/server/tasks/comment-guardrails.server.ts`)

Pure helpers + per-project toggle lookups (owner ruling Q3, header comment at `comment-guardrails.server.ts:4-22`):

- **`isMeaninglessComment`** (`:28-33`) — drops trivial chatter matching `CHATTER_RE` (`:25-26`: "ok", "done", "on it", "👍" …). Anything over 60 chars is never meaningless (`:31`). An empty/whitespace text is meaningless (`:30`).
- **`enforceOperatorBrevity`** (`:38-53`) — hard-caps operator narration at 1000 chars (`:36`), closes an odd open ``` fence before appending the visible trim marker (`:47-48`).
- **`separateEvidence`** (`:63-80`) — replaces fenced blocks longer than 12 lines (`:56`) with a 3-line head + "_N more lines in the agent logs_" marker; both fences anchored to line starts (`:70-71`).
- **`guardrailOn` / `guardrailValue`** (`:83-113`) — read `project.md` frontmatter `guardrails[]` **per call** via `readProjectFile`. Missing project file or missing entry ⇒ `false`/`null` (guardrail silently off).

Defaults ship ON for every project: `app/shared/workflow/templates.ts:81-87` (`DEFAULT_GUARDRAILS`, compression-threshold `value: 40`). Schema is tolerant/loose: `app/schemas/project-file.schema.ts:155-164` and `:454-458`.

### Enforcement sites (who calls, and what is suppressed)

1. **Operator comments** — `writeOperatorComment` (`app/server/tasks/operator-actions.server.ts:277-351`), used by `operatorPostComment` (`:888-908`) and the recommend variant.
   - meaningful-comment drop: `logger.info` only, then `return` **before** any audit row or notification (`:292-300`).
   - evidence-separation then brevity applied in order (`:301-306`).
   - **no-duplicate-summary**: if the text equals the last operator comment, `suppressed = true` and the function returns (`:316-329`, `:352`) — **zero trace: no log line, no audit row, no notification**.
   - Mention fan-out uses the **post-trim** text (`:356-362`), so an `@mention` sitting past the 1000-char cut never notifies anyone.
   - **The model is lied to**: `operatorPostComment` returns `{outcome:"done", message:"Comment posted to the timeline."}` unconditionally after the write call (`operator-actions.server.ts:898-907`), and the toolkit relays that verbatim (`app/server/tasks/operator-toolkit.server.ts:104-113`). A dropped/deduped narration reads as posted to the operator model.

2. **Agent final replies** — `prepareAgentReplyEvent` (`app/server/tasks/task-actions.server.ts:1286-1320`) applies meaningful-comment + evidence-separation (no brevity, no dedupe). `postAgentReplyComment` (`:1345-1406`) logs the drop and records a `task.agent.replied` audit row with `droppedByGuardrail: "meaningful-comment"` so boot recovery does not reprocess it (`:1325-1343`, adversarial-review #11). Errors on the write are logged, never propagated (`:1399-1405`).

3. **Mid-run agent comments** — `postAgentComment` (`app/server/tasks/agent-toolkit.server.ts:83-129`) is explicitly "guardrail-light" (`:79-82`): **no guardrail runs at all** — an agent's `post_comment` tool can put unlimited chatter/evidence dumps on the timeline. Audited as `task.agent.commented` under the agent's identity (`:109-117`).

4. **Human comments** — `appendComment` (`app/server/tasks/task-actions.server.ts:664-736`) applies **no drop/trim guardrails** (humans are never suppressed), only timeline compaction (`:702-725`).

## Timeline compaction (`app/server/tasks/timeline-compaction.server.ts`)

`compactTimelineEvents` (`:37-90`): when the newest-first timeline exceeds `threshold`, keeps `keepRecent` newest events verbatim, then collapses each run of ≥2 consecutive "routine" comments in the older region into one operator-authored marker titled `Compacted` (`:17`, `:55-63`). Never folds: typed events, existing markers, `toAgent` prompts, or **agent-authored** replies (`:69-78` — rework evidence protection). Returns the same array reference when nothing changed so callers skip the file write (`:33`, `:89`).

Callers (both derive `keepRecent = min(24, max(4, floor(value/2)))` from the configured threshold):
- operator comment writes (`operator-actions.server.ts:337-350`),
- human comment writes (`task-actions.server.ts:707-724`).

Notable: compaction rewrites **canonical `task.md`** — folded human comment text is permanently deleted from the source of truth (the marker records only a count, `timeline-compaction.server.ts:60-61`). Agent reply floods never compact (agent actor excluded), and agent/reply write paths never invoke compaction, so agent-heavy timelines only shrink when a human or the operator next comments.

## Audit recorder + retention

- **`recordAudit`** (`app/server/audit/audit-recorder.server.ts:41-69`) inserts into `audit_events`; failures are logged and swallowed (`:63-68`) so auditing never breaks the action. `details` secret-freeness is convention only (`:9-14`). Shared actors: `SYSTEM_ACTOR`, `OPERATOR_AUDIT_ACTOR` (`:23-28`). Coverage is enforced by a table-driven sweep test (`app/server/audit/audit-coverage.server.test.ts:96-97`).
- **`applyRetention`** (`app/server/db/retention.server.ts:37-75`), called best-effort at boot (`app/server/boot.server.ts:218`): `run_log_lines` kept 30 days (`:21`), `audit_events` 90 days (`:23`), notifications newest 500/user (`:25`, window-function delete `:55-68`). Canonical Markdown is never touched (`:12-14`).
- **Workspace reclamation** (`app/server/tasks/workspace-retention.server.ts:85-123`) — deliberately separate from db retention (`:21-24`); deletes `<taskDir>/workspace` clones for tasks in the project's **last** stage (`:95-98`), best-effort at boot after run recovery (`:38-41`).
- **Retention × guardrails interaction**: the brevity/evidence trim markers promise "the full narration/output is in the agent logs" (`comment-guardrails.server.ts:51`, `:77`), but `run_log_lines` expire after 30 days while `task.md` lives forever — the truthful reference becomes a dangling pointer on any task older than a month.

## Provenance

- Write layer `recordProvenance`/`recordProvenanceForFile` (`app/server/provenance/provenance-recorder.server.ts:33-64`): append-only observations (`projected|removed|error|rescan|github.reconcile|github.merge`), **never pruned by `applyRetention`** (`:15-16`) — an unbounded table. Callers: projection rebuilder (`app/server/projections/rebuilder.server.ts:157,231,295,500,551,631,734`) and the GitHub reconciler (via the absolute-path variant, `provenance-recorder.server.ts:49-64`).
- Read layer (`app/server/provenance/provenance-query.server.ts`): `taskProvenancePath` (`:63-68`), `listProvenance`/`latestProvenance` (`:73-108`), `createReconcileBehindByLookup` returning **null when never compared** (load-bearing null, `:110-134`), `latestProjectReconcileAt`/`latestTaskReconcileAt` (`:137-168`). Malformed `details_json` parses to null silently (`:40-47`). No user-facing provenance view exists (`:15-17`).

## Mention suggestions + fan-out

- **`getMentionables`** (`app/server/tasks/mention-suggestions.server.ts:78-135`), read-only, called from the task route loader (`app/routes/project.task.tsx:170`). Three groups mirroring the server resolver (`:10-28`): deployed specialists keyed by lowercased profile id (`:90-102`), users keyed by email local-part with members first (`:104-132`), reserved handles `operator|agent|claude|codex` (`:57-62`). Failure mode: a **local-part collision silently skips the later user** (`:128-129`) — that person becomes unsuggestable (though the resolver could still match their first/full name).
- **`notifyMentionedUsers`** (`app/server/tasks/mention-notify.server.ts:57-94`) — the NEW-4 shared fan-out every comment writer funnels through (`task-actions.server.ts:741`, `:1389`, `agent-toolkit.server.ts:121`, `operator-actions.server.ts:356`). Resolves `@handle` against enabled users by local-part / first name / full display name via `extractMentions` with display names as known handles (`:64-81`); reserved handles never notify (`:71`); quotes are clipped to 240 chars (`:32-37`); routing prefs respected inside `createNotification` (`:53-55`).

## Model-prose repair (`app/server/tasks/model-prose.server.ts`)

`normalizeEscapedNewlines` (`:32-46`) converts literal `\n` two-char sequences the operator/agent model double-escapes into real newlines — only when the string has no real newline and no fence (`:33-35`); single `\n` before a word char is left as a Windows-path separator (`:41-42`). Applied at the model→store boundary: operator plan text/reason (`app/server/runtimes/operator-run.server.ts:1053-1056`) and every prose argument of both toolkits via `const prose = normalizeEscapedNewlines` (`operator-toolkit.server.ts:70` with ~14 sites, `agent-toolkit.server.ts:73` with ~7 sites). Known blind spots are documented in the header (`:25-27`).

## Gagents + resource references

- **`gagents.server.ts`** (`app/server/org/gagents.server.ts`): CRUD for global agent profile templates under `${DATA_ROOT}/agents/profiles/<id>.md` (`:21-35`); operator template hidden (`:25-26`); `usedByProject` counts distinct non-archived deployments from `projects.agent_policy_json` (`:87-115`, malformed rows tolerated `:110-112`) and gates deletion. Exports at `:140,199,319`.
- **`resource-references.server.ts`** (`app/server/org/resource-references.server.ts`): referential integrity for KB/skill/MCP slugs (P13-KM-07 — the "silent-resource" class where a rename orphaned every grant, `:26-31`). `updateResourceReferences` (`:45-64`) rewrites (rename) or drops (delete) the slug in template frontmatter (`:86-126`) and each project's `agents[].definition.resources` snapshot (`:135-189`). Set semantics dedupe a rename onto an existing grant (`:66-84`, P14-KM-07). **Best-effort per file**: a malformed profile/project logs a warn and is skipped (`:116-123`, `:179-186`) — a partially-applied rename is possible with only log-level visibility. Callers: KB rename/delete, MCP, skills mutations (`app/server/org/resources.server.ts:297,357,1032,1116,1331,1406`).

## env.server (`app/server/config/env.server.ts`)

`loadEnvFile()` at module import, ENOENT tolerated (`:4-8`). Zod schema (`:12-131`): required `VIBERR_SESSION_SECRET` (≥32 chars) and `VIBERR_SECRET_ENCRYPTION_KEY` (base64 → exactly 32-byte Buffer, `:50-73`); `VIBERR_DATA_ROOT` defaults `"./data"` (`:76` — the dual-writer hazard when launch config points elsewhere); optional OAuth, seed-admin, runtime keys (`:79-117`), and tuning knobs kept as raw strings (`:128-130`). `parseEnv` treats empty strings as unset and throws one multi-line message listing every problem (`:152-162`). `getEnv` caches once per process via a global symbol surviving HMR (`:164-179`).

## Logging + errors taxonomy

- **Logger** (`app/server/logging/logger.server.ts`): dependency-free JSON-per-line on stdout (`:4-11`); levels debug<info<warn<error, min level from `LOG_LEVEL` else prod=info/dev=debug (`:36-40`); `Error` fields serialized to `{name,message,stack}` (`:42-47`); unserializable fields degrade to a stub record (`:72-81`); `child()` binds fields for run/job paths (`:31-33`, `:94`).
- **Correlation** (`app/server/logging/request-context.server.ts`): `AsyncLocalStorage` per request (`:35`); seeded from inbound `X-Request-Id` ≤128 chars else a 12-hex id (`:46-59`); path only, never query string (`:44-45`); `bindCorrelation` adds ids mid-request, `requestId` immutable (`:91-98`); mounted as root-route middleware (`:113-114`). Explicit call-site fields win over correlation on key clash (`logger.server.ts:62-70` assign order).
- **Errors** (`app/server/errors/app-error.server.ts`): `AppError` carries stable `code` (7 codes, `app/server/errors/error-codes.ts:6-14`, append-only contract), HTTP `status`, log-only `message`, and a safe `userMessage` defaulting to "Something went wrong on our side." (`:16`, `:31`). Static builders notFound/validation/forbidden/conflict/internal (`:35-82`). Boundary: `appErrorResponse` maps an AppError to `{ok:false, error: userMessage}` with its status and **rethrows anything else** (`app/server/auth/form-action.server.ts:21-27`); also consumed in `require-project.server.ts:39` and `app/routes/profile.tsx:128`.

## Suspect areas

- **Silent zero-trace drop**: `no-duplicate-summary` suppression leaves no log, no audit row, nothing (`operator-actions.server.ts:316-329,352`); meaningful-comment drops of operator comments leave only a server log line (`:296-299`) — no audit parity with the agent-reply drop path (`task-actions.server.ts:1332-1343`).
- **Toolkit lies to the model**: `operatorPostComment` reports "Comment posted to the timeline." even when the guardrail dropped or deduped it (`operator-actions.server.ts:898-907`); agent `post_comment` similarly always says "[done]" (`agent-toolkit.server.ts:227`) — the model may believe narration exists that no human ever sees.
- **Mentions trimmed away**: operator fan-out runs on the post-brevity text (`operator-actions.server.ts:356-362`), so an `@handle` past the 1000-char cap silently never notifies.
- **Dangling evidence references**: trim markers point at "the agent logs" while `run_log_lines` expire in 30 days (`retention.server.ts:21,41-45`) — permanent canonical text referencing purged evidence.
- **Compaction deletes human prose from canonical `task.md`** with only a count marker (`timeline-compaction.server.ts:55-63`); agent-reply floods never compact at all (agent exclusion `:78` + no compaction call in the agent write paths).
- **Mid-run agent comments bypass every guardrail** (`agent-toolkit.server.ts:79-103`) — the anti-noise regime can be sidestepped by any agent granted `collab.comment`.
- **`guardrailOn`/`guardrailValue` re-read + re-parse `project.md` per call** — an operator comment costs ~6 file reads (`comment-guardrails.server.ts:88-96,105-112`; call cluster `operator-actions.server.ts:292-318`).
- **Provenance grows without bound** — append-only and exempt from retention by contract (`provenance-recorder.server.ts:15-16`).
- **Audit trail only 90 days** (`retention.server.ts:23`) while the same rows serve as boot-recovery idempotency keys (e.g. `task.agent.replied`, `task-actions.server.ts:1322-1343`) — a >90-day-old dropped reply could in principle be reprocessed after retention deletes its marker row.
- **Local-part collisions** silently hide a user from mention autocomplete (`mention-suggestions.server.ts:128-129`).

## Open questions

- Should guardrail drops surface in the UI (e.g. a muted timeline stub or a settings counter) instead of only stdout logs — especially the zero-trace dedupe path?
- Should the operator/agent tool result distinguish "posted" from "dropped by guardrail" so the model can rephrase instead of assuming delivery?
- Is 90-day audit retention compatible with all audit-keyed idempotency checks, or should recovery-keyed actions be exempt like provenance?
- Are agent run transcripts persisted anywhere longer-lived than `run_log_lines` (files under the task dir?) — i.e. is the "full output is in the agent logs" claim recoverable after 30 days?
- Is folding older **human** comments out of canonical `task.md` intended, or should compaction spare human-authored events the way it spares agent replies?
- Should compaction also run on agent-reply/mid-run comment writes so agent-heavy timelines compact without waiting for a human/operator comment?
