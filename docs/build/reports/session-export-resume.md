# Feature — export an agent session and resume it on your own machine

The agent sessions run inside the container; the user asked whether a session
shown in the UI can be exported and resumed on their own laptop (same
subscription), for both Claude and Codex. Researched, experimented, implemented,
and **proven end-to-end**.

## Verdict (researched + verified live)

**Yes — for both**, with the mechanics below. A 5-agent research workflow
(Claude CLI, Claude Agent SDK, Codex CLI, Codex SDK, cross-machine gotchas) with
an adversarial verify pass established the resume model; a live experiment on
this machine then **confirmed a real Claude resume**: the exported CTL-1
transcript resumed under a local `claude --resume <id>` and correctly recalled
the conversation ("the repository … is `containerless` … written in Go"),
billed to the local subscription.

- **Claude** — sessions are flat JSONL transcripts at
  `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl` (container:
  `/data/runtimes/claude-home/…`). The filename **is** the session id the UI
  shows. `claude --resume <id>` is **scoped to the encoded name of the current
  directory** — `<abs cwd>` with every non-alphanumeric char → `-`, computed on
  the **physical** (symlink-resolved) path. Place the transcript in the folder
  matching a local dir's encoding, `cd` there, `claude --resume <id>`.
- **Codex** — rollouts at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`.
  `codex resume <id>` is **not** cwd-scoped (it filesystem-scans), so the rollout
  can go anywhere under `~/.codex/sessions` and resume from any directory.
- Neither carries credentials — the laptop signs in with its own (same)
  subscription; continued turns bill the laptop.

## The live experiment (what it caught)

Running the generated installer and `claude --resume` exposed one real gotcha
the docs alone didn't: the folder-name encoding must use the **physical** path.
On macOS a temp dir `pwd` reports `/var/folders/…` but Claude resolves
`/private/var/folders/…`; encoding the logical path produced
`No conversation found with session ID`. Switching the script to `pwd -P` fixed
it — resume then located the session (and fully resumed against the authed
config). The "all non-alphanumeric → `-`" rule (incl. `_` and `.`) was confirmed
correct in the same test.

## Implementation

- **`app/server/runtimes/session-export.server.ts`** (new):
  - `locateTranscript(backend, sessionId)` — finds the transcript by **session
    id** (Claude: scans `projects/*/<id>.jsonl`; Codex: DFS-walks the dated
    `sessions` dirs for a `rollout-…jsonl` whose name/first-line embeds the id),
    so it never depends on reproducing the container's cwd encoding. Reads the
    baked-in cwd for the recipe.
  - `buildResumeScript(located, {taskKey})` — generates a **self-contained bash
    installer** with the transcript base64-embedded. On the user's machine it
    decodes the transcript, places it where the local CLI looks (Claude: under
    the `pwd -P`-encoded folder of the dir you run it from — default your local
    checkout; Codex: `~/.codex/sessions/imported/`), and prints the exact resume
    command. One file, **no credentials**.
- **`app/routes/resources.session-export.ts`** (new) — `GET
  /resources/session-export?run=<runId>` → resolves the run's backend +
  session_id, locates the transcript, returns the installer as a download
  (`application/x-sh`, `resume-<task>-<shortid>.sh`). 404 for simulated runs or
  when no on-disk session exists.
- **`app/features/runtime/runs-panels.tsx`** — an **Export** affordance next to
  the Agent-logs session-id chip (shown for real, non-simulated runs with a
  session). Also **corrects the earlier tooltip**, which wrongly said the
  session "can't be resumed with `claude --resume` on your own machine" — it can.

## Tests + verification

- `session-export.server.test.ts` (+6): locate-by-id for Claude (any encoded
  folder) and Codex (dated rollout), null when absent, and script generation
  (embeds the transcript verbatim — decodes byte-identical — prints the right
  per-backend command). Suite **890/890**, typecheck + build clean.
- Live: generated the real installer for CTL-1's `c5e944e2…` session; it placed
  the transcript at the physical-path-encoded folder (byte-identical to source)
  and `claude --resume` **fully resumed** it. UI verified against a data copy:
  the Export button renders and the endpoint returns the 137 KB installer.

## Honest caveats (surfaced in the script + tooltip)

- Same subscription/tier needed on the laptop; log in there independently — do
  NOT copy the container's tokens.
- Claude version skew: the JSONL format is internal/version-dependent; keep the
  laptop `claude` close to the container's. Resume by **exact id** (imported
  sessions may not show in the interactive picker).
- Codex resume adopts the laptop's cwd; run it from your local checkout so file
  ops in continued turns make sense. Codex resume-by-id was verified against
  source/docs but not executed live here (no Codex session existed to export —
  Codex isn't logged in on this container).
- The transcript is conversation content only; it does not restore the
  filesystem/git working tree.
