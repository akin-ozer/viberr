# Audit-log export (CSV/JSON download + S3 SigV4 push) — how it works

Shipped in commit `aedbb9b` ("Add audit-log export: CSV/JSON download + S3
(SigV4) push"), then immediately patched by `d16f4b5` ("Fix full-suite
regressions: S3 secret rotation coverage, takeover rule, copy-ban"), which
moved the S3 secret out of `instance_settings` into a dedicated
`s3_audit_config` table. **Both commits are ancestors of HEAD on this
branch** (`fix/label-list-press-propagation`), so everything below describes
the CURRENT working tree — the two commits are not separately relevant, only
their combined end state is. Line numbers match the working tree.

This doc is written for an implementation agent with no other context. It
ends with a "Known correctness defects" section that is load-bearing: **the
top defect (path-style endpoint signing) means the one non-AWS use case the
feature explicitly advertises and tests — a custom S3-compatible endpoint —
is broken 100% of the time.** Read that section before changing anything.

## 1. Data model: `audit_events`

- `db/migrations/0001_baseline.sql:37-48` —
  `audit_events(id, occurred_at, actor_user_id, actor_label NOT NULL, action
  NOT NULL, subject_kind, subject_id, project_slug, task_key, details_json)`.
  No FK constraints; `details_json` is a free-form JSON string or NULL.
- Written by `recordAudit()`, `app/server/audit/audit-recorder.server.ts:61-89`.
  `actor.label` is, by convention, always the acting user's **email**
  (verified across every call site: `app/server/auth/login.server.ts:134,173`,
  `app/server/auth/require-project.server.ts:47`,
  `app/server/auth/oauth-provision.server.ts:122,149`, and ~30 sites in
  `app/server/tasks/task-actions.server.ts` that thread through a pre-resolved
  `actor.label`) or a fixed system string (`"system"`, `"operator"`,
  `"delivery"`, `encodeActorRef(...)` for agent actors — never raw user free
  text). `details` is documented (line 10-11) as "must be secret-free (ids,
  emails, field names — never passwords, tokens or hashes)" — this is a
  **convention, not code-enforced**. I grepped every `recordAudit(` call site
  under `app/server` for a `token:`/`secret:`/`password:`/`accessKey`-shaped
  field passed raw, and for a `...spread` of an input/config object into
  `details`; found none — GitHub PAT creation logs `pat.tokenSuffix` only
  (`app/server/org/connections.server.ts:482`), OAuth provider save logs
  `secretReplaced: boolean` only (`app/server/auth/oauth-providers.server.ts:180`).
  Nothing in the audit-export code path re-validates this at export time — the
  export is only as secret-free as every past and future `recordAudit` caller.
- Retention: `app/server/db/retention.server.ts:30` —
  `AUDIT_RETENTION_DAYS = 90`. `applyRetention()` (line 66-85) deletes
  `audit_events WHERE occurred_at < now-90d AND action NOT IN
  ('task.agent.replied', 'runtime.operator.plan_executed')` — those two
  actions are exempt (they double as boot-recovery idempotency keys, line
  33-48) and can survive indefinitely past 90 days; every other row is a hard
  delete, not a soft-delete/tombstone. Run best-effort at boot and on the
  maintenance interval (`app/server/ops/maintenance.server.ts`). **The export
  queries the live table, so it can only ever return what retention has not
  yet swept** — see defect #3.

## 2. The CSV/JSON download route

- `app/routes/org.settings.audit-export.ts` — `GET
  /org/settings/audit-export?format=csv|json&project=&action=&actor=&since=&until=`.
- Line 20: `await requireRole(request, "admin")` — the ONLY gate, server-side,
  before any query runs. `requireRole` (`app/server/auth/require-user.server.ts:201-208`)
  throws a 403 `Response` (line 184-198) if `roleSatisfies(user.role,
  "admin")` is false. `UserRole` is a 2-value enum, `"admin" | "member"`
  (`app/shared/mapping/user.server.ts:9`), ordered by
  `ROLE_ORDER = { member: 1, admin: 2 }` (require-user.server.ts:174-177) — no
  project-role escape hatch, this is the org-level role only. Confirmed
  tested: `app/routes/org.settings.audit.test.ts:79-81` asserts a non-admin's
  `loader()` call rejects.
- Lines 26-36: optional query-string filters (`project`, `action`, `actor`,
  `since`, `until`) map 1:1 onto `AuditExportFilters`. `limit` is part of the
  `AuditExportFilters` type but **the route never reads a `limit` query
  param** — every download uses the default cap (see §3). No validation that
  `since`/`until` parse as real dates; a garbage value just yields a
  lexical-string SQL comparison against `occurred_at` (garbage-in,
  empty/wrong-but-not-unsafe results out).
- Lines 38-49: `queryAuditEventsForExport` → `serializeAuditExport` → a raw
  `Response` with `Content-Type` (from `EXPORT_FORMATS`), `Content-Disposition:
  attachment; filename="viberr-audit-YYYY-MM-DD.<ext>"`, `Cache-Control:
  no-store`. No row-count header, no truncation indicator of any kind.

## 3. Query + serializers — `app/server/audit/audit-export.server.ts`

- `queryAuditEventsForExport(db, filters)` (lines 63-114): every filter is an
  optional `AND`-clause bound through a `?` placeholder (lines 69-88) — column
  names in the SQL text are hardcoded literals, filter **values** are never
  string-interpolated, so this is not SQL-injectable. `ORDER BY occurred_at
  DESC, id DESC LIMIT ?` (lines 97-98) — newest-first.
- `AUDIT_EXPORT_MAX_ROWS = 100_000` (line 14, doc comment lines 12-13: "The UI
  states the cap" — **false**, see defect #3). `limit` is clamped to `[1,
  100_000]` (lines 89-92); the route never overrides it (§2), so every
  download/S3-push is capped at the newest 100,000 rows that survived
  retention.
- `COLUMNS` (lines 118-129): fixed 10-column order —
  `id, occurredAt, actorUserId, actorLabel, action, subjectKind, subjectId,
  projectSlug, taskKey, details`. `cellFor` (131-135): every column is the row
  field verbatim (`?? ""` for null); the `details` column is `row.detailsJson`
  **verbatim, as stored** (the raw JSON string, not re-serialized) for CSV.
- `csvField` (lines 139-144): RFC-4180 escaping only — a value is quote-wrapped
  (and internal `"` doubled) if it contains `,`, `"`, `\r`, or `\n`. **No
  neutralization of a leading `=`, `+`, `-`, `@`, or tab** — see defect #4.
- `auditRowsToCsv` (146-153): header line + one line per row, `\r\n`
  terminators throughout (including after the header and the final row).
- `auditRowsToJson` (171-199): `details_json` is `JSON.parse`d and inlined as
  a real object tree under `details` when it parses; on a parse failure the
  raw string survives under `detailsRaw` instead (lines 187-195) so a
  malformed row is never silently dropped or emptied. `JSON.stringify(out,
  null, 2)` — pretty-printed array.
- `EXPORT_FORMATS` (201-205): `csv → text/csv; charset=utf-8` /
  `json → application/json; charset=utf-8`.

## 4. S3 push — signer: `app/server/audit/s3-put.server.ts`

Hand-rolled SigV4, `node:crypto` only, no `aws-sdk`. I independently
re-verified the entire signing pipeline against this file with tools that
never import it — see "Verification performed" below. **The core algorithm
(signing-key HMAC chain, canonical-request shape, string-to-sign, final
HMAC-signature) is correct.** The one place it is provably wrong is endpoint
path handling (defect #1).

- `signingKey()` (lines 40-50): `HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date),
  region), service), "aws4_request")` — the standard chain. Independently
  re-derived byte-for-byte via a fresh `openssl dgst -sha256 -hmac`/`-macopt
  hexkey:` chain against AWS's own published KAT inputs
  (secret `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`, date `20150830`, region
  `us-east-1`, service `iam`) — matches the repo's own KAT test
  (`s3-put.server.test.ts:11-25`) exactly:
  `2c94c0cf5378ada6887f09bb697df8fc0affdb34ba1cdd5bda32b664bd55b73c`.
- `encodeSegment`/`canonicalKeyPath()` (lines 52-70): `encodeURIComponent` per
  path segment, plus a fix-up (`!'()*`  → `%XX`) for the exact delta between
  what `encodeURIComponent` leaves unencoded (`- _ . ! ~ * ' ( )`) and RFC
  3986 unreserved (`- _ . ~`). This is the standard "extra-encode" shim used
  by AWS SDKs; correct. Slashes are preserved as segment separators.
- `payloadHash = sha256Hex(body)` (line 111) — the **real** SHA-256 of the
  actual PUT body, not `UNSIGNED-PAYLOAD`. Confirmed by
  `s3-put.server.test.ts:90-103` ("changing the body changes the signature").
- Canonical headers (lines 113-127): exactly 4, sorted lowercase —
  `content-type, host, x-amz-content-sha256, x-amz-date` (alphabetically
  correct order; the `.sort()` comparator technically isn't a total order for
  ties, but all 4 keys are distinct constants so this never matters). Values
  are used as-is with **no whitespace trimming/collapsing** despite the
  in-code comment claiming "trimmed values" (line 114) — harmless today
  because every call site's `contentType` is a fixed literal
  (`"text/csv; charset=utf-8"` / `"application/json; charset=utf-8"`,
  `audit-export.server.ts:203-204`) with no stray whitespace.
- `x-amz-date` (ISO-basic, always UTC via `.toISOString()` — line 81-86,
  `sigV4Dates()`) is signed and sent; there is no separate `Date` header.
  `isoNow` is always caller-supplied (`new Date().toISOString()`), never a
  bare local-time `Date` — no timezone bug.
- `signS3Put()` (98-166) assembles canonical request → string-to-sign →
  signature → `Authorization` header, in the standard shape. I reconstructed
  this whole pipeline from scratch in a throwaway script (not importing this
  file) for the exact `s3-put.server.test.ts:53-78` test vector (bucket
  `viberr-audit`, region `eu-central-1`, key `exports/log.csv`, body
  `"id,action\r\n1,task.created\r\n"`, date `2026-08-23T00:00:00.000Z`) and
  got a byte-identical `Authorization` header
  (`Signature=bd88b8021a4e9f73301ec725387498ebf766b7d33b73e9b4d7a5bc4d2453be1e`)
  to what `signS3Put()` actually produces.
- Default origin (no `endpoint` override): virtual-hosted-style,
  `https://<bucket>.s3.<region>.amazonaws.com` (lines 105-107) — this has no
  path component, so it is unaffected by defect #1.
- `putObjectToS3()` (182-201): signs, then `fetch`es; a non-2xx response
  resolves normally with `{ ok: false, status, error: <S3 error body> }`
  (line 199) rather than throwing — the caller decides how to surface it (see
  §5). `fetchImpl` is injectable for tests.

## 5. S3 push — route wiring: `app/routes/org.settings.tsx`

- Entire `action()` is gated once, up front:
  `await requireRoleAuth(request, "admin")` (line 187) — same admin-only gate
  as §2, applied to every intent in this file (there is no per-intent
  re-check). CSRF (`assertCsrf`, line 191) runs right after.
- `case "s3-config-save"` (251-268): calls `setS3AuditConfig` (see §6);
  catches its thrown `Error` locally and returns `fail(error.message)` — the
  message is always one of the two generic validation strings from
  `s3-config.server.ts`, never the secret.
- `case "s3-config-clear"` (269-272): `clearS3AuditConfig` — hard delete of
  the one row (`s3-config.server.ts:139-141`). Not audited (no
  `recordAudit` call anywhere in `s3-config.server.ts`) — changing or wiping
  the S3 exfiltration target leaves no trace in the audit log itself.
- `case "audit-export-s3"` (273-297):
  1. `getS3AuditConfigForUse(db)` (§6) — decrypts the secret. `null` → `fail("No
     S3 target is configured (or its secret could not be read). Save one
     first.")` (276-278) — this message conflates "never configured" with "key
     rotated and secret temporarily unreadable" (defect #2).
  2. `queryAuditEventsForExport(db)` — **no filters** — always the full
     (retention-and-cap-bounded) table, same 100k row cap as the download route.
  3. `objectKey = "viberr-audit-${stamp}.${ext}"`, `stamp` from a *second*,
     independent `new Date().toISOString()` call (line 285) than the one
     passed as `isoNow` to `putObjectToS3` (line 289) — cosmetic only (object
     key naming vs. signing clock), not a correctness issue since both are
     within microseconds of each other and the signature only depends on
     `isoNow`.
  4. `putObjectToS3(...)` — on `!result.ok`, returns `fail(`S3 upload failed
     (HTTP ${status}). ${error.slice(0,200)}`)` (291-294) — **this branch is
     the one place in the whole feature that is genuinely honest about
     failure**: a non-2xx never reads as success. Tested:
     `org.settings.audit.test.ts:121-135`.
  5. On success: `ok("Exported ${rows.length} audit rows to S3
     (${objectKey}).")` (296) — states a count, never compares it to a total
     or flags truncation.
  - **Gap**: this whole case has no local `try/catch`. If `fetch` itself
    throws (DNS failure, connection refused, TLS error — realistic for a
    misconfigured custom `endpoint`) rather than resolving to a non-2xx
    response, the exception is not an `AppError`, so the outer catch-all
    (line 662-664, `appErrorResponse`) re-throws it (`form-action.server.ts:25`:
    `if (!isAppError(cause)) throw cause;`) instead of producing the crafted
    "S3 upload failed" message — see defect #5.
- `loader()` (102-117): `s3Audit: getS3AuditConfigView(getDb())` (line 115) —
  the **view-only** projection (§6), confirmed never carrying the secret.

## 6. Secret storage at rest — `app/server/audit/s3-config.server.ts`

**This directly answers the prior-notes question: yes, as of `d16f4b5` the S3
secret has its own dedicated table + column, registered in `SEALED_STORES` —
the JSON-blob-in-`instance_settings` approach `aedbb9b` originally shipped was
replaced before this became HEAD.** Verified at every layer:

- Schema: `db/migrations/0001_baseline.sql:248-257` —
  `s3_audit_config(id TEXT PRIMARY KEY DEFAULT 'default', bucket, region,
  prefix, endpoint, access_key_id, secret_box TEXT NOT NULL, updated_at)`. At
  most one row (`id = 'default'`, `s3-config.server.ts:15`). `instance_settings`
  itself now carries an explicit "NEVER store a secret here" comment pointing
  at this table (`0001_baseline.sql:237-239`), and
  `instance-settings.server.ts`'s `InstanceSettingValue` type comment
  (lines 13-16) says the same.
- Secret sealing: `secret_box` column, written by `sealSecret()` (AES-256-GCM,
  `app/server/secrets/secret-box.server.ts:118-132`) — `setS3AuditConfig`
  (`s3-config.server.ts:93-136`) only reseals when a non-blank
  `secretAccessKey` is submitted (line 112-113); a blank submission keeps the
  existing sealed box (111) so an admin can edit bucket/region without
  re-typing the key. First-time save with no secret throws (114-116).
- Rotation coverage: registered in `SEALED_STORES`
  (`app/server/secrets/key-rotation.server.ts:76-83`) —
  `{ id: "s3_audit_config", table: "s3_audit_config", column: "secret_box",
  nameColumn: "bucket", idColumn: "id" }`. `scanStore`/`resealSecrets`
  (key-rotation.server.ts:138-177, 283+) are fully generic over this config —
  no per-store special-casing needed, confirmed by reading both. There is
  also a static guard test,
  `key-rotation.server.test.ts:198-246` ("no module seals a secret outside
  the known stores"), that greps every `.ts` file under `app/` for
  `sealSecret(` call sites and fails if one exists outside the 4 files
  `SEALED_STORES` accounts for — `s3-config.server.ts` is one of the 4
  (line 229). This part of the design is solid and end-to-end verified.
- **However**: `getS3AuditConfigForUse` (§5, `s3-config.server.ts:64-85`)
  reads the secret with plain `openSecret(row.secret_box)` (line 69) — the
  **non-rotating** opener, which only tries the current
  `VIBERR_SECRET_ENCRYPTION_KEY` and throws on anything else. Every other
  consumer of a `SEALED_STORES` secret (`pat-store.server.ts:222`,
  `oauth-providers.server.ts:112,188`, `org/resources.server.ts:689,755`)
  uses `openSecretRotating()` plus a lazy re-seal-on-read, specifically
  because (their own comment, `pat-store.server.ts:218-221`) *"Without this,
  rotating `VIBERR_SECRET_ENCRYPTION_KEY` bricked every stored PAT — the only
  signal being a 500 at the next GitHub call."* This exact bug class is
  reintroduced for the S3 secret — see defect #2.
- Client exposure: `getS3AuditConfigView` (49-60) is the only thing the
  loader passes to the browser (`org.settings.tsx:115`) — `hasSecret: boolean`
  only, never `secret_box` or the plaintext. `org-settings-page.tsx`'s secret
  `<input type="password">` (lines 257-265) is always seeded from local
  `useState("")`, never from loader data — genuinely write-only. Confirmed by
  `org.settings.audit.test.ts:96-100`: `JSON.stringify(view)` does not
  contain the saved secret value.

## 7. UI — `app/features/org-settings/org-settings-page.tsx`

- `AuditExportCard` (176-onward), rendered from `OrgSettingsPage` at line 164.
- Line 193-196, the card's lede, verbatim: *"Download the full audit log, or
  push it to an S3 bucket. Exports carry every recorded fact (actor, action,
  subject, details)."* — see defect #3.
- Download links (199-206) are plain `<a href="/org/settings/audit-export?...">`
  — real file responses via `Content-Disposition`, not a fetch+blob dance.
- S3 target form (208-266): bucket/region/prefix/endpoint/access-key-id text
  inputs plus the write-only secret password field; "Save target"
  (267-285)/"Upload the audit log to S3 now" (286-296) buttons, the latter
  disabled unless `configured` (`s3Audit !== null`).
- No mention anywhere in this file of the 90-day retention window or the
  100,000-row cap (grepped for "retention", "90", "swept", "purge",
  "100,000", "100000", "cap" — zero hits relevant to audit export; the only
  "cap" hits in the file are the unrelated run-concurrency control).

## Verification performed (so a reader can trust §4 without re-deriving it)

1. `signingKey()` KAT re-derived via a fresh, hand-typed `openssl dgst -sha256
   -hmac` / `-macopt hexkey:` 4-step chain (not the test file, not the source)
   against AWS's published example inputs — byte-identical result.
2. Full `signS3Put()` output for the `s3-put.server.test.ts:53-78` vector
   re-derived in a from-scratch Node script (independent canonical-request
   and HMAC-chain implementation, not importing `s3-put.server.ts`) — matched
   the real function's `Authorization` header exactly, including the 64-hex
   signature.
3. `npx vitest run` on `app/server/audit/`, `app/server/secrets/key-rotation.server.test.ts`,
   `app/routes/org.settings.audit.test.ts` — 7 files / 38 tests, all green in
   the current tree.
4. `app/routes/org.settings.upload.test.ts` (named in the task brief as a key
   file) was checked and is **unrelated** — it predates this feature
   (2026-08-21) and covers a different `org.settings.tsx` intent
   (`store-upload`, the KB-file silent-upload honesty fix from P13-UI-08).
   No audit-export relevance.

## Known correctness defects (ranked, most severe first)

### 1. CRITICAL/HIGH — path-style (bucket-in-path) S3-compatible endpoints sign the wrong canonical URI; every push 403s. CONFIRMED, cryptographically proven.

- **Where**: `app/server/audit/s3-put.server.ts:105-110` builds
  `origin = config.endpoint ?? <virtual-hosted default>`, then
  `canonicalUri = canonicalKeyPath(fullKey)` from **only** `prefix +
  objectKey` — never from anything in `origin`. Line 158 then builds the
  actual request URL as `` `${origin}${canonicalUri}` ``. If `endpoint`
  itself carries a path segment (e.g. `https://minio.internal:9000/viberr-audit`,
  the natural way to point at a path-style-addressed bucket on a self-hosted
  S3-compatible store), that path silently rides into the real request URL
  but is **absent** from what gets signed.
- **Concrete failure**: with `endpoint: "https://minio.internal:9000/viberr-audit"`,
  `prefix: "team/"`, key `"log.json"` — exactly the shape
  `s3-put.server.test.ts:80-88` itself exercises — the actual outgoing
  request line is `PUT /viberr-audit/team/log.json`, but the signed canonical
  URI is `/team/log.json`. I verified this concretely: reconstructed the
  canonical request twice, once exactly as the code does (canonical URI
  `/team/log.json`) and once as a spec-compliant receiver would (canonical
  URI = the real request path, `/viberr-audit/team/log.json`), through the
  identical signing-key/HMAC chain. The two signatures differ
  (`5cb67480a7bb…` vs `523c9ece5c1f…`) — proof that any S3-compatible
  server verifying this request per spec will reject it with
  `SignatureDoesNotMatch` (403). The existing test only asserts
  `signed.url` equals the expected string (`s3-put.server.test.ts:87`); it
  never independently verifies the signature is valid **for that URL**, so
  this shipped green.
- **Impact**: the feature's own doc comment frames `endpoint` as the escape
  hatch for "S3-compatible stores (MinIO, R2, …)" (`s3-put.server.ts:7`,
  `20-22`) and the only test for it uses path-style addressing. Any admin who
  configures a self-hosted store this way — a very ordinary way to describe
  "bucket X on host Y" and often the *only* option when the store lacks
  wildcard DNS/TLS for virtual-hosted-style — gets a 100%-reproducible,
  every-single-push failure. It is at least surfaced honestly as a 403 (not a
  false success, per §5's error path), but the feature is simply non-functional
  for that configuration shape.
- **Fix direction**: fold `new URL(origin).pathname` (when not just `/`) into
  the canonical URI (and therefore into what's hashed/signed), not just into
  `origin`; or explicitly strip/reject a path in `endpoint` at
  `setS3AuditConfig` and document that only host:port is accepted, and fix
  the test to no longer encode the broken shape as the expected one.

### 2. HIGH — S3 secret decrypt uses the non-rotating opener; reintroduces the exact "bricks after key rotation" bug class this codebase already fixed elsewhere. CONFIRMED.

- **Where**: `app/server/audit/s3-config.server.ts:69` —
  `secretAccessKey = openSecret(row.secret_box)`. `openSecret`
  (`secret-box.server.ts:144+`) tries only the current
  `VIBERR_SECRET_ENCRYPTION_KEY`; it has no fallback. Every other
  `SEALED_STORES` consumer instead calls `openSecretRotating()`
  (`secret-box.server.ts:88-104`, tries current then every
  `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS` entry) and, on a `staleKey` result,
  re-seals in place under the current key
  (`pat-store.server.ts:218-238`, `oauth-providers.server.ts:112,188`,
  `org/resources.server.ts:689,755`).
  `pat-store.server.ts:218-221`'s own comment names the exact failure mode:
  *"A9: accept a box sealed under a RETIRED key during a rotation window...
  Without this, rotating `VIBERR_SECRET_ENCRYPTION_KEY` bricked every stored
  PAT — the only signal being a 500 at the next GitHub call."*
  `s3-config.server.ts:63` even documents the symptom in its own doc comment
  ("Null when unconfigured or the secret cannot be opened **(bad/rotated
  key)**") without applying the fix already established for this exact
  scenario elsewhere in the same codebase.
- **Concrete failure**: operator rotates `VIBERR_SECRET_ENCRYPTION_KEY` (moves
  the old value to `VIBERR_SECRET_ENCRYPTION_KEY_PREVIOUS`, sets a new
  current value) — the documented, supported procedure this whole
  `SEALED_STORES`/`key-rotation.server.ts` mechanism exists for. Until an
  operator manually runs the batch reseal CLI (`resealSecrets`, which *does*
  cover this table — §6 confirms the registration is correct), every
  `"Export to S3 now"` click hits `getS3AuditConfigForUse` → `openSecret`
  throws → caught at `s3-config.server.ts:70-74` → returns `null` →
  `org.settings.tsx:275-279` reports *"No S3 target is configured (or its
  secret could not be read). Save one first."* — actively misleading (the
  target **is** configured; re-typing bucket/region achieves nothing, only
  re-entering the actual secret or running the CLI reseal fixes it), and
  unlike every sibling secret store, there is no self-healing on read.
- **Not covered by any test**: grepped `audit-export.server.test.ts`,
  `s3-put.server.test.ts`, `org.settings.audit.test.ts` for
  `rotat`/`staleKey`/`PREVIOUS` — zero hits. The rotation window is untested
  for this store specifically, unlike PATs
  (`pat-store.server.test.ts` presumably covers A9 — not read here, out of
  scope, but the live A9 comment confirms the scenario is a known, previously
  real production bug).
- **Fix direction**: `getS3AuditConfigForUse` should call
  `openSecretRotating` and, on `staleKey`, write back a fresh `sealSecret(...)`
  the same way `pat-store.server.ts:222-238` does.

### 3. HIGH — "Download the full audit log... every recorded fact" is false; two independent silent-truncation mechanisms are undisclosed, and a code comment's own honesty claim ("The UI states the cap") is false. CONFIRMED.

- **The claim**: `app/features/org-settings/org-settings-page.tsx:193-196`,
  verbatim: *"Download the full audit log, or push it to an S3 bucket.
  Exports carry every recorded fact (actor, action, subject, details)."*
- **Silent truncation #1 — retention**: `AUDIT_RETENTION_DAYS = 90`
  (`retention.server.ts:30`) permanently, physically deletes
  `audit_events` rows older than 90 days
  (`retention.server.ts:76-85`, a hard `DELETE`, not a tombstone) on every
  boot and maintenance tick. The export queries the live table
  (`audit-export.server.ts:94-101`) — it has no way to know, and gives no
  indication, that older events ever existed. "The full audit log" is, at
  best, "the audit log for whatever is left after the last sweep."
- **Silent truncation #2 — the row cap**: `AUDIT_EXPORT_MAX_ROWS = 100_000`
  (`audit-export.server.ts:14`), `ORDER BY occurred_at DESC ... LIMIT ?`
  (`audit-export.server.ts:97-98`) — for any org with >100k events inside the
  90-day window, the export silently returns only the newest 100k and drops
  the rest, with **no truncation flag, no total-count comparison, nothing**
  in the CSV/JSON body or the download response headers
  (`org.settings.audit-export.ts:42-49`) or the S3-push success toast
  (`"Exported ${rows.length} audit rows to S3..."`,
  `org.settings.tsx:296` — states a count, never "of N total").
- **The comment that's wrong**: `audit-export.server.ts:12-13` — *"Hard
  ceiling on rows per export — a guard so a single download can't try to
  materialize an unbounded table into one string. **The UI states the
  cap.**"* I grepped `org-settings-page.tsx` for `"100,000"`, `"100000"`,
  `AUDIT_EXPORT_MAX_ROWS`, and `cap` — the only `cap` hits are the unrelated
  run-concurrency control (lines 39-40, 342-344). The UI never states the
  cap. This is exactly the kind of comment-vs-code mismatch worth flagging on
  its own: a future reader trusting the comment would believe this is already
  disclosed.
- **No test would catch this**: `org-settings-page.test.tsx`'s only change in
  `aedbb9b` is mechanical `s3Audit={null}` prop-threading into unrelated
  pre-existing test cases (verified via `git show aedbb9b --
  app/features/org-settings/org-settings-page.test.tsx`) — nothing renders or
  asserts on `AuditExportCard`'s copy.
- **Fix direction**: state the retention window and the row cap in the card
  copy (and ideally surface `rows.length === AUDIT_EXPORT_MAX_ROWS` as an
  explicit "may be truncated" signal on both the download and the S3-push
  paths), and stop calling it "the full audit log."

### 4. MEDIUM/MEDIUM-HIGH — CSV/formula injection: leading `=`, `+`, `-`, `@` are never neutralized; the app's own email validator allows the two arithmetic trigger characters as the first character of `actorLabel`. CONFIRMED gap + CONFIRMED trigger characters permitted; full exploit chain PLAUSIBLE.

- **The gap**: `csvField()` (`audit-export.server.ts:139-144`) performs
  RFC-4180 escaping only (quote-wraps on `,`/`"`/`\r`/`\n`, doubles internal
  quotes). It does **not** prepend anything (e.g. a leading `'`) to a value
  that starts with `=`, `+`, `-`, `@`, or tab — the standard CSV/formula-
  injection defense (OWASP-documented; Excel/Sheets/LibreOffice evaluate such
  a leading character as a formula when a human opens the file, RFC-4180
  quoting does **not** prevent this since it's an application-layer
  interpretation, not a CSV-syntax one). Confirmed directly by reading
  `csvField` and by `audit-export.server.test.ts:41-48`, which tests
  comma/quote/newline escaping in `actorLabel` but never a leading
  `=`/`+`/`-`/`@` case.
- **Which of the 9 CSV columns can actually carry attacker-influenced text**:
  I traced all of them. `id`/`actorUserId`/`subjectId` are generated ids;
  `action`/`subjectKind` are fixed enums from code; `projectSlug` is built by
  `slugify()` (`app/shared/ids/slugify.ts:8-14`), which trims leading/trailing
  `-` and collapses every non-alphanumeric run to `-` — so a project slug can
  never start with `=`/`+`/`-`/`@`; `taskKey` is a generated key (`VIB-1`
  style); `details` is `JSON.stringify`d server-side and always starts with
  `{`/`[`/`"` — the CSV cell's own leading character is never a trigger char
  even though the JSON payload inside might contain one deep inside a string
  value. **`actorLabel` is the one real vector** — it's always the acting
  user's email (§1).
- **The email validator permits the trigger characters**: I tested the
  installed `zod` package directly —
  `z.email().safeParse("+1234567@evil.com").success === true` and
  `z.email().safeParse("-2+3+cmd@evil.com").success === true` (both `+` and
  `-` are accepted as the first character of the local-part; `=` and a
  leading `@` are rejected). This is the same `z.email()` used to gate a
  local user's email at `app/server/auth/user-admin.server.ts:39` and
  `app/server/org/org-users.server.ts:246` (`updateOrgUser`, the `user-edit`
  intent, and `invite-local`/`createLocalAccount`).
- **Who can set such an email**: every path in `org.settings.tsx` (including
  `user-edit`/`invite-local`) is admin-gated (`requireRoleAuth(request,
  "admin")`, line 187) — so the guaranteed-exploitable baseline is an admin
  setting a `+`/`-`-leading email for themselves or another local account,
  which is a self-inflicted / same-trust-level trigger (still worth fixing on
  output-encoding principle, since a defense that only neutralizes commas/
  quotes/CRLF but not the far more dangerous formula-execution class is an
  incomplete implementation of "safe CSV"). A cross-privilege path is
  **PLAUSIBLE but not live-verified here**: `applyOAuthUser`
  (`app/server/auth/oauth-provision.server.ts:95-154`) takes `user.email`
  straight from the OAuth callback (`normalizeEmail(user.email)`, line 96) —
  no `z.email()` re-validation at all — for a brand-new account, but only
  when the org has already domain-allowlisted a Google Workspace domain or an
  admin already pre-created a `github.com/<handle>` placeholder
  (`isOAuthWhitelisted`, lines 68-88) — i.e. the org has already extended
  *some* trust to that identity, just not admin trust. Whether a real
  Google Workspace or GitHub-verified email can actually carry a leading
  `+`/`-` local-part was not tested live (no OAuth credentials in this
  environment, matching the existing "NOT LIVE-VERIFIED" note at
  `oauth-provision.server.ts:43-46`).
- **Fix direction**: prefix a value with `'` (or a single space, matching
  common mitigations) in `csvField` whenever the raw value's first character
  is in `=+-@\t\r`, before the existing quote-wrap logic runs.

### 5. MEDIUM — a network-level `fetch` failure during the S3 push escapes the crafted error message and becomes a raw unhandled exception instead of "S3 upload failed...". CONFIRMED code path, impact PLAUSIBLE (depends on the app's generic error boundary).

- **Where**: `case "audit-export-s3"` (`org.settings.tsx:273-297`) has no
  local `try/catch` around `await putObjectToS3(...)` (line 287). The only
  surrounding handler is the switch-wide `catch (error) { return
  appErrorResponse(error); }` (line 662-664), and `appErrorResponse`
  (`app/server/auth/form-action.server.ts:24-30`) does `if
  (!isAppError(cause)) throw cause;` — a plain network error (e.g. Node's
  `fetch` throwing `TypeError: fetch failed` on DNS failure, connection
  refused, or a TLS handshake error) is not an `AppError`, so it is
  **re-thrown**, not turned into a friendly message.
- **Contrast**: the non-2xx HTTP path (`s3-put.server.ts:194-200`) is handled
  well — `fetch` resolving with e.g. a 403 becomes `{ ok: false, ... }`, which
  the route turns into a specific, honest `fail("S3 upload failed
  (HTTP 403)...")`. Only the "request never got a response at all" case is
  ungraceful.
- **Why plausible in practice**: the feature explicitly supports custom
  `endpoint`s for self-hosted S3-compatible stores (§4) — exactly the
  deployments most likely to have connectivity/TLS misconfiguration (wrong
  port, self-signed cert, store not running yet) rather than a clean HTTP
  error response.
- **Fix direction**: wrap the `putObjectToS3` call in its own `try/catch` and
  return the same `fail("S3 upload failed: ...")` shape for a thrown error as
  for a non-2xx response.

### 6. LOW — the `region` field is trimmed but never case-normalized; a mixed-case region breaks every signature.

- **Where**: `setS3AuditConfig` (`s3-config.server.ts:105`) does
  `input.region.trim()` only. `signS3Put` (`s3-put.server.ts:107,138,148`)
  uses `config.region` verbatim both in the virtual-hosted host and in the
  credential-scope string (`<date>/<region>/s3/aws4_request`) that feeds the
  signing-key HMAC chain. AWS's canonical region strings are lowercase; a
  credential scope built with e.g. `"EU-Central-1"` produces a signing key
  that AWS's own (lowercase-region) verification will never reproduce →
  `SignatureDoesNotMatch` on every push, for a purely cosmetic data-entry
  slip (the field's own placeholder text shows the lowercase form,
  `org-settings-page.tsx:226`, but nothing enforces it). Self-correcting once
  an admin sees the 403 and fixes the casing; not chained to any other
  defect.

### Checked, not a defect

- **Auth/RBAC** (checklist item c): both the download route and every
  `org.settings.tsx` mutation (including the two S3-config intents) are
  gated server-side by the same `admin`-only check; a non-admin's attempt is
  tested and rejected (§2, §5).
- **Secret/PAT/password leakage into the export** (checklist item d): grepped
  every `recordAudit(` call site under `app/server` for a raw
  token/secret/password/accessKey-shaped field or a `...spread` of an
  input/config object into `details` — found none. The S3 secret itself is
  never passed to `recordAudit` at all (§6).
- **Secret ever returned to the client or logged** (checklist item e): the
  loader only ever uses the view projection (§6); the one `logger.error` in
  the decrypt path logs the error object, never the ciphertext or plaintext
  (`s3-config.server.ts:70-74`).
- **SQL injection** in the filtered query: every filter value is bound via
  `?`; no filter value is ever concatenated into SQL text
  (`audit-export.server.ts:69-88`).
- **Core SigV4 math** (signing-key HMAC chain, payload hash, string-to-sign,
  final signature) for the default (no `endpoint` override) virtual-hosted
  case: independently re-derived twice (openssl chain + from-scratch Node
  script) and matches the shipped code exactly — see §4's "Verification
  performed."
