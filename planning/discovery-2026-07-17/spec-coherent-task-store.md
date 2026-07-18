# Implementation spec: coherent task-file store (fix VirtioFS read-after-write loss)

**For a fresh implementer (no prior context).** Self-contained. Branch from
`fix-reviewer-comment-atomic` (it already has the atomic reviewer write + a first-pass
`coherentTaskContent`; this spec supersedes that mitigation with a real fix).

## The bug (proven)
Viberr is a single Node process. Task state is canonical markdown at
`<dataRoot>/projects/<slug>/tasks/<KEY>/task.md`; every mutation is a locked read-modify-write
(`updateTaskFile` in `app/server/files/task-writer.server.ts`, serialized per-path by
`withFileLock`). On the docker **Docker Desktop VirtioFS bind mount** (`./docker-data:/data`), a
`readFileSync` issued shortly after this same process's own `writeFileAtomic` (write-temp +
`renameSync`) can return the **PREVIOUS** file content — read-your-own-writes is NOT coherent, even
for a **serialized** write (the file-lock keys are identical; confirmed by logging).

Consequence: two writes close in time lose data. Concretely — a reviewer run's completion posts the
reviewer's reply comment, then the operator reacts ~seconds later and its `updateTaskFile` reads the
**pre-comment** stale file and rewrites without it, erasing the reviewer's comment (only the typed
`quality` verdict event, written in the same atomic write as the comment, is what the operator's
stale base happened to still contain… actually it loses the comment because the operator's base
predates BOTH — see note). The projector (`rebuilder.server.ts`) also reads raw and can publish a
`task_events` timeline missing a just-written entry.

**Verified root-cause boundary:** on a **coherent filesystem** (a Docker *named volume* = ext4 in
the VM, or the host during unit tests) the loss does NOT occur — the reviewer comment persists
through the operator react. So this is purely the mount's incoherence, not app logic. The owner wants
to KEEP the bind mount (host-side `./docker-data` inspection/backup), so the fix must live in the app.

## The fix: an in-process canonical task-file cache (authoritative over disk)
Because viberr is single-process, an in-memory copy of each task file that WE wrote is more
authoritative than a possibly-stale disk read. Maintain it and make every reader prefer it.

### Design
In `app/server/files/task-writer.server.ts`:
1. Replace/extend the existing `lastWritten` map with a canonical cache:
   `Map<absPath, { content: string; parsed: ParsedTaskFile; wroteAtMs: number }>`
   (parse once at write time; cap size like the current 500-entry bound).
2. `updateTaskFile`: the mutation base is the **cache entry if present**, else a disk read+parse.
   NEVER re-read disk for the base when we have a cache entry. After serialize+`writeFileAtomic`,
   update the cache (content + freshly-parsed + wroteAtMs).
3. `readTaskFile`: return the cache entry's `{parsed, content}` when present; else disk read+parse
   (populate nothing — reads don't author). This makes ALL readers (loaders, queries) coherent.
4. Projector: `rebuilder.server.ts` task-file read must go through the coherent read (it already
   calls `readCoherentTaskContent` on this branch — keep it pointed at the cache).
5. `createTaskFile`: seed the cache on create.

### External-edit invalidation (keep files canonical)
A human editing `task.md` directly must still win. The chokidar watcher
(`app/server/files/*watch*` — find the task-file change handler) already fires a reproject on change.
Extend it: on a change event, compare on-disk content to the cache entry's `content`.
- If they MATCH → it's the echo of our own write; keep the cache, reproject as today.
- If they DIFFER → genuine external edit: **replace the cache entry with the disk content+parse**,
  then reproject. (Do not use mtime heuristics; content comparison is exact.)
On process start the cache is empty, so first reads come from disk (coherent after a clean boot).

### Remove the band-aids this supersedes
Delete `coherentTaskContent`'s mtime-slack guessing and `STALE_READ_SLACK_MS`; the cache is exact.
Keep `readCoherentTaskContent` as the projector's entry point but back it with the cache.

## Acceptance criteria
- `updateTaskFile`'s base is never a stale disk read when we hold a cache entry (unit test: mock
  `readFileSync`/`node:fs` to return STALE content after a write; assert the next `updateTaskFile`
  base + the resulting file still contain the prior write's timeline entry).
- A genuine external edit (write the file out-of-band with different content, fire the watcher)
  invalidates the cache and reprojects — assert the external edit is honored.
- The reviewer regression test in `app/server/tasks/agent-completion.server.test.ts` still passes;
  add one that drives a reviewer completion FOLLOWED BY an operator-style second `updateTaskFile`
  reading a mocked-stale disk, asserting the reviewer comment survives.
- Full suite green (`npx vitest run`), `npm run typecheck` clean. No new migrations.
- Preserve the "files are canonical" contract: disk is still the source of truth; the cache is only a
  read-your-own-writes coherence layer for the single writer process, reconciled to disk on any
  external change and empty on boot.

## Verify in docker (the real environment) — hand back to the owner/parent for this
The bind-mount repro (needs a running `docker compose` + a Claude/Codex reviewer run):
1. `docker compose up -d --build` (bind mount, NOT a named volume — must reproduce on the mount).
2. Create a review-stage task on the `viberr` project, assign the `reviewer` profile, run the
   operator; poll `docker-data/projects/viberr/tasks/<KEY>/task.md` for a
   `· comment · agent:*review*` entry that PERSISTS after the operator settles (posts a
   Recommendation). Before this fix it appears then vanishes; after, it must persist.
A repro harness exists at `docker-data/scratch/rev-repro3.mjs` (+ `harness.mjs`) from the diagnosis
session — reuse it (`docker compose exec app node /data/scratch/rev-repro3.mjs`).

## Files
- `app/server/files/task-writer.server.ts` — the cache + updateTaskFile/readTaskFile/createTaskFile.
- `app/server/projections/rebuilder.server.ts` — coherent task read (already wired to
  `readCoherentTaskContent`).
- the task-file watcher (grep `chokidar` / `rescan` / `rebuildPath` under `app/server/files` +
  `app/server/projections`) — external-edit invalidation.
- tests: `app/server/files/*task-writer*.test.ts` (add stale-read + external-edit cases),
  `app/server/tasks/agent-completion.server.test.ts` (reviewer-survives-operator-react).
