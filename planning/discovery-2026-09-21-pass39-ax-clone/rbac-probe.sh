#!/bin/bash
# rbac-probe.sh — hit real governed intents as each project role and print the
# server's answer. Read-only where it can be; every write here is on a task the
# pass treats as a probe target.
S=/tmp/claude-501/-Users-akinozer-projects-viberr/22224644-c840-4206-b917-ee9ec7ebcb58/scratchpad
BASE=http://localhost:5173; SLUG=ax-clone; KEY="${1:-AX-7}"
csrf () { curl -s -b "$1" "$BASE/projects/$SLUG/tasks/$KEY" | python3 /tmp/claude-501/-Users-akinozer-projects-viberr/22224644-c840-4206-b917-ee9ec7ebcb58/scratchpad/csrf.py; }
post () { # post <jar> <label> <field=value>...
  local jar="$1"; shift; local label="$1"; shift
  local c; c=$(csrf "$jar"); local args=(); for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  local out; out=$(curl -s -b "$jar" -X POST "$BASE/projects/$SLUG/tasks/$KEY" -H "Origin: $BASE" \
    --data-urlencode "_csrf=$c" "${args[@]}" -w '\n#HTTP:%{http_code}')
  local code; code=$(printf '%s' "$out" | tail -1 | sed 's/#HTTP://')
  local msg; msg=$(printf '%s' "$out" | python3 -c '
import sys,re
t=sys.stdin.read()
m=re.findall(r"\\\\?\"(?:toast|error)\\\\?\":\\\\?\"([^\"\\\\]{4,140})",t)
print(m[0] if m else ("(no message)" if "#HTTP:200" in t else "(none)"))')
  printf "  %-28s %s  %s\n" "$label" "$code" "$msg"
}
for who in nadia:admin ravi:maintainer tomas:contributor priya:viewer; do
  name="${who%%:*}"; role="${who##*:}"; jar="$S/$name.cookies"
  echo "== $name ($role) on $KEY =="
  printf "  %-28s %s\n" "GET task page" "$(curl -s -b $jar -o /dev/null -w '%{http_code}' $BASE/projects/$SLUG/tasks/$KEY)"
  printf "  %-28s %s\n" "GET policy" "$(curl -s -b $jar -o /dev/null -w '%{http_code}' $BASE/projects/$SLUG/policy)"
  printf "  %-28s %s\n" "GET agents" "$(curl -s -b $jar -o /dev/null -w '%{http_code}' $BASE/projects/$SLUG/agents)"
  post "$jar" "comment"            "intent=comment" "body=RBAC probe comment from $name ($role) - checking who may write here."
  post "$jar" "set-task-metadata"  "intent=set-task-metadata" "priority=high" "labels=" "dueDate="
  post "$jar" "run-operator"       "intent=run-operator" "when=now"
  post "$jar" "accept-completion"  "intent=accept-completion" "ackPr=none" "ackRevision=none" "ackVerdict=none"
  post "$jar" "force-accept"       "intent=force-accept" "ackPr=none" "ackRevision=none" "ackVerdict=none" "reason=rbac probe"
done
