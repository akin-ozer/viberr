#!/bin/bash
# auto-accept.sh — the human acceptance gate, run on a timer.
# Accepts a task ONLY when every condition the acceptance gate itself checks is
# already true on the canonical file: at the review stage, waiting on a human,
# validation healthy, and an `approve` verdict from the project's required
# reviewer bound to the DELIVERED revision. Anything else is left alone and
# reported, so a failing or drifted task always stops here for a person.
cd /Users/akinozer/projects/viberr || exit 1
DIR=planning/discovery-2026-09-21-pass39-ax-clone
while true; do
  for f in docker-data/projects/ax-clone/tasks/*/task.md; do
    KEY=$(basename "$(dirname "$f")")
    read -r ok why < <(python3 - "$f" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
fm=s.split('\n---')[0]
g=lambda k:(re.search(r'^%s: (.*)$'%k,fm,re.M) or [None,''])[1].strip()
if g('archived')=='true' or g('stage')!='review' or g('waiting')!='human':
    print('no quiet'); raise SystemExit
if g('validation')!='healthy':
    print('no validation=%s'%(g('validation') or 'none')); raise SystemExit
head=re.search(r'^workRevision:\n(?: {2}.*\n)*?  headSha: (\S+)',fm,re.M)
if not head: print('no no-revision'); raise SystemExit
block=re.search(r'^verdicts:\n((?: {2}[-\s].*\n)+)',fm,re.M)
if not block: print('no no-verdict'); raise SystemExit
ok=False
for v in block.group(1).split('  - '):
    if 'reviewer' in v and 'result: approve' in v and head.group(1) in v: ok=True
print('yes ok' if ok else 'no verdict-not-on-delivered-revision')
PY
)
    [ "$ok" = "yes" ] || { [ "$why" = "quiet" ] || echo "[$(date +%H:%M:%S)] $KEY HELD: $why"; continue; }
    echo "[$(date +%H:%M:%S)] $KEY accepting…"
    bash $DIR/accept.sh "$KEY" >/dev/null 2>&1
    sleep 6
    st=$(grep -m1 '^stage:' "$f" | awk '{print $2}')
    pr=$(python3 -c "
import re;s=open('$f').read()
m=re.search(r'^pr:\n(?: {2}.*\n)*?  number: (\d+)',s,re.M);print(m.group(1) if m else '-')")
    echo "[$(date +%H:%M:%S)] $KEY → stage=$st pr=#$pr"
  done
  sleep 45
done
