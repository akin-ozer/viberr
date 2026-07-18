#!/bin/sh
# Container entrypoint: seed the Codex CLI login into the writable CODEX_HOME
# from the optional read-only host mount, then exec the server command.
#
# Why a copy instead of pointing CODEX_HOME at the mount (owner design,
# 2026-07-18): CODEX_HOME must stay WRITABLE — the Codex runtime persists
# sessions/config there and refreshes auth.json itself — and a single-file
# bind mount goes stale when the host CLI rewrites the file (the rename swaps
# the inode out from under the mount). Seeding only-when-missing keeps the
# container copy self-managing; a wiped ./docker-data volume repairs itself on
# the next `docker compose up`, and the live availability re-probe picks the
# seeded file up without any restart.
set -eu

if [ -n "${CODEX_HOME:-}" ] && [ ! -f "$CODEX_HOME/auth.json" ] && [ -f /host-codex/auth.json ]; then
  mkdir -p "$CODEX_HOME"
  cp /host-codex/auth.json "$CODEX_HOME/auth.json"
  chmod 600 "$CODEX_HOME/auth.json" 2>/dev/null || true
  echo "viberr-entrypoint: seeded Codex CLI auth from the host mount into $CODEX_HOME/auth.json"
fi

exec "$@"
