#!/bin/bash
# accept.sh <TASK-KEY> [jar] — the human acceptance ceremony, from the shell.
# Reads the CURRENT disclosure (pr state, delivered revision, verdict) off the
# canonical task.md exactly as the dialog does, echoes it back (ruling 88), and
# POSTs accept-completion. A stale echo is refused by the server, which is the
# point: you cannot accept blind.
set -uo pipefail
KEY="$1"; JAR="${2:-/tmp/claude-501/-Users-akinozer-projects-viberr/22224644-c840-4206-b917-ee9ec7ebcb58/scratchpad/viberr.cookies}"
BASE="http://localhost:5173"; SLUG="ax-clone"
F="/Users/akinozer/projects/viberr/docker-data/projects/$SLUG/tasks/$KEY/task.md"
read -r PR REV VER < <(python3 - "$F" <<'PY'
import re,sys
s=open(sys.argv[1]).read().split('\n---')[0]
def nested(block,leaf):
    m=re.search(r'^%s:\n(?: {2}.*\n)*?  %s: (.*)$'%(block,leaf), s, re.M)
    return m.group(1).strip().strip('"') if m else None
pr=nested('pr','state') or 'none'
rev=nested('workRevision','headSha') or 'none'
ver=(re.search(r'^validation: (.*)$',s,re.M) or [None,'none'])[1].strip()
print(pr,rev,ver)
PY
)
CSRF=$(curl -s -b "$JAR" "$BASE/projects/$SLUG/tasks/$KEY" | python3 /tmp/claude-501/-Users-akinozer-projects-viberr/22224644-c840-4206-b917-ee9ec7ebcb58/scratchpad/csrf.py)
echo "$KEY · pr=$PR · revision=${REV:0:12} · verdict=$VER"
curl -s -b "$JAR" -X POST "$BASE/projects/$SLUG/tasks/$KEY" -H "Origin: $BASE" \
  --data-urlencode "intent=accept-completion" --data-urlencode "_csrf=$CSRF" \
  --data-urlencode "ackPr=$PR" --data-urlencode "ackRevision=$REV" --data-urlencode "ackVerdict=$VER" \
  | python3 -c 'import sys,re; t=sys.stdin.read(); m=re.findall(r"\\?\"(?:toast|error)\\?\":\\?\"([^\"\\\\]{5,180})", t); print("  →", m[0] if m else t[:200])'
