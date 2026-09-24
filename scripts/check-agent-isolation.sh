#!/bin/sh
# Ruling 460's in-image check: an agent process runs as its person's own OS
# user and reaches nothing of the server's and nothing of another person's.
#
# Run INSIDE the production image, as the server user (`node`), against a store
# on a NAMED volume — a macOS bind mount does not enforce file permissions, and
# the store half of this check fails there on purpose. The e2e job runs it in
# the e2e stack's app container (`docker compose exec -T app sh
# scripts/check-agent-isolation.sh`); by hand:
#
#   docker run --rm --init -v <volume>:/data viberr-app sh scripts/check-agent-isolation.sh
#
# It uses two throwaway agent uids at the top of the range (never a real
# person's, which are allocated from the floor up) and removes everything it
# creates. Exit 0 when every check holds; 1 with the failures listed.
set -u

LAUNCH=/usr/local/libexec/viberr-launch
DATA=${VIBERR_DATA_ROOT:-/data}
UID_A=59990
UID_B=59991
AGENT_GID=20000
TAG="isolation-check-$$"
HOME_A="$DATA/runtimes/users/$TAG-a"
HOME_B="$DATA/runtimes/users/$TAG-b"
# A directory shared the way a task's workspace is — outside projects/, which
# the server's file watcher follows.
WS="$DATA/runtimes/$TAG-workspace"
failures=0
STAGE=""
helpers=""

pass() { echo "ok    $*"; }
fail() {
  echo "FAIL  $*"
  failures=$((failures + 1))
}

# A command as an agent uid, through the launcher (argv[1..] pass through).
as_agent() {
  agent_uid=$1
  shift
  VIBERR_LAUNCH_UID=$agent_uid VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c "$*"
}

alive() {
  # A zombie is dead for this purpose: it runs nothing.
  [ -r "/proc/$1/stat" ] && ! awk '{ exit ($3 == "Z") ? 0 : 1 }' "/proc/$1/stat" 2>/dev/null
}

wait_gone() {
  i=0
  while alive "$1" && [ $i -lt 80 ]; do
    sleep 0.1
    i=$((i + 1))
  done
  ! alive "$1"
}

cleanup() {
  for pid in $helpers; do kill -KILL "$pid" 2>/dev/null; done
  "$LAUNCH" --reap KILL "run_${TAG}_reap" >/dev/null 2>&1
  [ -d "$WS/repo" ] && as_agent "$UID_A" "rm -rf '$WS/repo'" >/dev/null 2>&1
  rm -rf "$HOME_A" "$HOME_B" "$WS" ${STAGE:+"$STAGE"} 2>/dev/null
}
trap cleanup EXIT

echo "agent isolation check (ruling 460) as $(id -un) on $DATA"

# A volume no server has booted on yet: the two directories the checks need,
# made the way the server's boot makes them (enforceStoreLayout).
if [ ! -d "$DATA/runtimes/users" ]; then
  mkdir -p "$DATA/runtimes/users" && chgrp viberr-agents "$DATA/runtimes" "$DATA/runtimes/users" \
    && chmod 0750 "$DATA/runtimes" && chmod 0710 "$DATA/runtimes/users"
  echo "note  no server has booted on $DATA: created runtimes/users as the boot would"
fi
if [ ! -d "$DATA/state" ]; then
  mkdir -p -m 0700 "$DATA/state"
  echo "note  no server has booted on $DATA: created state/ 0700 as the boot would"
fi

# --- the launcher itself -----------------------------------------------------
if [ "$(stat -c '%U:%G %a' "$LAUNCH" 2>/dev/null)" = "root:node 4750" ]; then
  pass "the launcher is root:node 4750"
else
  fail "the launcher is $(stat -c '%U:%G %a' "$LAUNCH" 2>&1), not root:node 4750"
fi
if id -Gn | tr ' ' '\n' | grep -qx viberr-agents; then
  pass "the server user is in viberr-agents"
else
  fail "the server user is not in viberr-agents ($(id -Gn))"
fi

# --- who the agent is ----------------------------------------------------------
ids=$(as_agent "$UID_A" 'echo "$(id -u) $(id -g) $(id -G)"')
if [ "$ids" = "$UID_A $AGENT_GID $AGENT_GID" ]; then
  pass "a launched process runs as uid $UID_A, group $AGENT_GID, no other group"
else
  fail "a launched process ran as '$ids'"
fi
if as_agent "$UID_A" 'env' | grep -q '^VIBERR_LAUNCH_'; then
  fail "the launcher's own variables reached the agent"
else
  pass "no VIBERR_LAUNCH_* variable reaches the agent"
fi
umask_seen=$(as_agent "$UID_A" 'umask')
[ "$umask_seen" = "0007" ] && pass "the agent's umask is 0007" || fail "the agent's umask is $umask_seen"

# --- the server's process -----------------------------------------------------
server=""
real_server=""
for dir in /proc/[0-9]*; do
  # The node process itself (argv[0] is node), not the init that started it,
  # whose command line names the server too.
  argv0=$(tr '\0' '\n' <"$dir/cmdline" 2>/dev/null | head -n 1)
  [ "${argv0##*/}" = "node" ] || continue
  if tr '\0' ' ' <"$dir/cmdline" 2>/dev/null | grep -q '@react-router/serve'; then
    server=${dir#/proc/}
    real_server=$server
    break
  fi
done
if [ -z "$server" ]; then
  # No server in this container: a stand-in holding a secret, as the server user.
  VIBERR_SECRET_ENCRYPTION_KEY=isolation-check-secret sleep 300 &
  server=$!
  helpers="$helpers $server"
fi
if as_agent "$UID_A" "cat /proc/$server/environ" >/dev/null 2>&1; then
  fail "an agent read the server's /proc/$server/environ"
else
  pass "an agent is refused the server's /proc/$server/environ"
fi

# --- the store ------------------------------------------------------------------
if [ -e "$DATA/state/projection.sqlite" ]; then
  if as_agent "$UID_A" "cat '$DATA/state/projection.sqlite'" >/dev/null 2>&1; then
    fail "an agent read the projection database"
  else
    pass "an agent is refused the projection database"
  fi
  "$LAUNCH" --probe "$DATA/state/projection.sqlite"
  probe=$?
  [ "$probe" -eq 0 ] && pass "the boot probe is refused (the store enforces permissions)" \
    || fail "the boot probe answered $probe (3 = the store is readable: a bind mount?)"
fi
if as_agent "$UID_A" "ls '$DATA/state'" >/dev/null 2>&1; then
  fail "an agent listed $DATA/state"
else
  pass "an agent cannot list $DATA/state"
fi

# --- homes -------------------------------------------------------------------------
"$LAUNCH" --prepare-home "$UID_A" "$HOME_A" && "$LAUNCH" --prepare-home "$UID_B" "$HOME_B"
if [ "$(stat -c '%u:%g %a' "$HOME_A")" = "$UID_A:$(id -g) 2770" ]; then
  pass "--prepare-home gives the home to its uid, the server's group, 2770"
else
  fail "--prepare-home left $(stat -c '%u:%g %a' "$HOME_A")"
fi
if as_agent "$UID_A" "echo mine > '$HOME_A/own' && cat '$HOME_A/own'" | grep -qx mine; then
  pass "an agent writes its own home"
else
  fail "an agent could not write its own home"
fi
as_agent "$UID_B" "umask 077; echo b-secret > '$HOME_B/secret'"
if as_agent "$UID_A" "cat '$HOME_B/secret'" >/dev/null 2>&1 || as_agent "$UID_A" "ls '$HOME_B'" >/dev/null 2>&1; then
  fail "an agent reached another person's home"
else
  pass "an agent is refused another person's home"
fi
if cat "$HOME_A/own" >/dev/null 2>&1; then
  pass "the server reads a home through its group"
else
  fail "the server cannot read an agent's home"
fi

# --- a workspace ---------------------------------------------------------------------
mkdir -p "$WS" && chgrp viberr-agents "$WS" && chmod 2770 "$WS"
if as_agent "$UID_A" "echo edit > '$WS/by-agent' && echo ok" | grep -qx ok; then
  pass "an agent writes a shared workspace"
else
  fail "an agent could not write a shared workspace"
fi
if echo server >>"$WS/by-agent" 2>/dev/null; then
  pass "the server writes what an agent created in a workspace"
else
  fail "the server cannot write what an agent created in a workspace"
fi
(umask 0002 && echo server-file >"$WS/by-server")
if as_agent "$UID_B" "echo more >> '$WS/by-server' && echo ok" | grep -qx ok; then
  pass "an agent writes what the server created in a workspace under the server's umask"
else
  fail "an agent cannot write a server-created workspace file"
fi
if [ -n "$real_server" ]; then
  server_umask=$(awk '/^Umask:/ { print $2 }' "/proc/$real_server/status")
  [ "$server_umask" = "0002" ] && pass "the server runs with umask 0002" \
    || fail "the server's umask is $server_umask, not 0002"
fi
if as_agent "$UID_A" "git config --system --get safe.directory" | grep -qx '\*'; then
  pass "git trusts every repository (safe.directory=* in the root-owned system config)"
else
  fail "the system git config has no safe.directory=*"
fi
if as_agent "$UID_A" "git config --system core.x y" >/dev/null 2>&1; then
  fail "an agent could write the system git config"
else
  pass "an agent cannot write the system git config"
fi

# --- git in a workspace (pass 40 review, R-seams-1) ----------------------------
# The server never runs git with an agent-writable repository as its working
# repository under its own uid. A workspace's git runs as the person through
# the launcher, with hooks and fsmonitor off at command-line precedence
# (GIT_CONFIG_*), and the delivery reads a branch OUT of a workspace into a
# repository of its own with git-upload-pack launched as the person. This is
# the kernel's half of what `workspace-git.server.test.ts` pins in the code.
REPO="$WS/repo"
PLANTED="$WS/planted-ran"
OFF="GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false"
GIT_BIN=$(command -v git)
UPLOAD_PACK=$(command -v git-upload-pack || echo "$(git --exec-path)/git-upload-pack")
as_agent "$UID_A" "git init -q -b main '$REPO' && git -C '$REPO' -c user.email=a@t -c user.name=a commit -q --allow-empty -m one"
# What any agent can write into any checkout: hooks and an fsmonitor command.
as_agent "$UID_A" "printf '#!/bin/sh\nid -u >> $PLANTED\n' > '$REPO/.git/planted.sh' && chmod 755 '$REPO/.git/planted.sh' \
  && for h in pre-commit post-commit post-checkout reference-transaction; do cp '$REPO/.git/planted.sh' '$REPO/.git/hooks/'\$h; done \
  && git -C '$REPO' config core.fsmonitor '$REPO/.git/planted.sh'"
as_agent "$UID_A" "git -C '$REPO' -c user.email=a@t -c user.name=a commit -q --allow-empty -m two && git -C '$REPO' status --porcelain" >/dev/null
if grep -qx "$UID_A" "$PLANTED" 2>/dev/null; then
  pass "an agent's own git runs the hooks it planted (the overrides are not global)"
else
  fail "an agent's own git did not run its hooks"
fi
planted_before=$(wc -l <"$PLANTED" 2>/dev/null || echo 0)
env $OFF VIBERR_LAUNCH_UID=$UID_B VIBERR_LAUNCH_EXEC="$GIT_BIN" "$LAUNCH" -C "$REPO" status --porcelain >/dev/null 2>&1
env $OFF VIBERR_LAUNCH_UID=$UID_B VIBERR_LAUNCH_EXEC="$GIT_BIN" "$LAUNCH" -C "$REPO" \
  -c user.email=s@t -c user.name=s commit -q --allow-empty -m three >/dev/null 2>&1
if [ "$(as_agent "$UID_A" "git -C '$REPO' log -1 --format=%s")" = "three" ] \
  && [ "$(wc -l <"$PLANTED")" = "$planted_before" ]; then
  pass "a workspace git launched as a person with hooks and fsmonitor off runs nothing planted"
else
  fail "a launched workspace git ran what an agent planted, or did not commit"
fi
STAGE=$(mktemp -d)
git init -q --bare "$STAGE/stage.git"
# Only its agent can read the checkout now: the server's own git cannot.
as_agent "$UID_A" "chmod 700 '$REPO'"
if env $OFF git --git-dir="$STAGE/stage.git" fetch -q --no-tags "$REPO" +refs/heads/main:refs/heads/main >/dev/null 2>&1; then
  fail "the server read a checkout only its agent can read"
else
  pass "the server's own git cannot read a checkout only its agent can read"
fi
if env $OFF VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC="$UPLOAD_PACK" \
  git --git-dir="$STAGE/stage.git" fetch -q --no-tags --upload-pack="$LAUNCH" "$REPO" +refs/heads/main:refs/heads/main \
  && [ "$(git --git-dir="$STAGE/stage.git" rev-parse refs/heads/main)" = "$(as_agent "$UID_A" "git -C '$REPO' rev-parse HEAD")" ] \
  && [ "$(wc -l <"$PLANTED")" = "$planted_before" ]; then
  pass "the server fetches a branch out of a checkout with git-upload-pack launched as its person"
else
  fail "the server could not fetch through the launcher's git-upload-pack"
fi
rm -rf "$STAGE"
# The checkout is its agent's alone now, so its agent removes it.
as_agent "$UID_A" "rm -rf '$REPO'"

# --- signals -------------------------------------------------------------------------
VIBERR_LAUNCH_HOME="$HOME_A" VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c \
  "trap 'echo term > \"$HOME_A/term\"; umask 077; echo private > \"$HOME_A/private\"; exit 0' TERM; echo \$\$ > '$WS/relay-pid'; while :; do sleep 0.1; done" &
launcher=$!
sleep 1
kill -TERM "$launcher"
wait "$launcher"
if [ "$(cat "$HOME_A/term" 2>/dev/null)" = "term" ]; then
  pass "the launcher relays SIGTERM to the agent"
else
  fail "SIGTERM did not reach the agent"
fi
if cat "$HOME_A/private" >/dev/null 2>&1 && [ "$(stat -c '%u' "$HOME_A/private")" = "$UID_A" ]; then
  pass "after the agent exits, its home is handed back (a 0600 file gains group read)"
else
  fail "a file the agent wrote 0600 is not readable by the server after it exited"
fi

VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c \
  "sleep 1000 & echo \$! > '$WS/grandchild'; wait" &
launcher=$!
sleep 1
grandchild=$(cat "$WS/grandchild" 2>/dev/null)
if [ -n "$grandchild" ] && kill -0 "$grandchild" 2>/dev/null; then
  fail "the server could signal an agent's process directly"
fi
kill -USR2 "$launcher"
wait "$launcher"
if [ -n "$grandchild" ] && wait_gone "$grandchild"; then
  pass "SIGUSR2 kills the agent's whole group, grandchild included"
else
  fail "SIGUSR2 left the grandchild $grandchild alive"
fi

# The server dies: PDEATHSIG takes the launcher (SIGTERM, relayed) and the agent.
sh -c "VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC=/bin/sh '$LAUNCH' -c 'echo \$\$ > \"$WS/orphan\"; exec sleep 1000' & wait" &
stand_in=$!
helpers="$helpers $stand_in"
sleep 1
orphan=$(cat "$WS/orphan" 2>/dev/null)
kill -KILL "$stand_in"
if [ -n "$orphan" ] && wait_gone "$orphan"; then
  pass "a dying server takes its launched agent down (PDEATHSIG)"
else
  fail "the agent $orphan outlived the server that launched it"
fi

# A process that left the group (its own session, as Claude Code starts a Bash
# command) is found by its run marker and reaped by the launcher as root.
# (The pause lets the child leave the group before the agent exits: the
# launcher TERMs whatever is still in the group once its agent is gone.)
VIBERR_RUN_ID="run_${TAG}_reap" VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC=/bin/sh "$LAUNCH" -c \
  "setsid sleep 1000 </dev/null >/dev/null 2>&1 & echo \$! > '$WS/detached'; sleep 0.5"
detached=$(cat "$WS/detached" 2>/dev/null)
sleep 0.5
listed=$("$LAUNCH" --reap 0 "run_${TAG}_reap")
if [ -n "$detached" ] && echo "$listed" | grep -qx "$detached"; then
  pass "--reap finds a detached agent process by its run marker"
else
  fail "--reap did not find the detached process $detached (listed: $listed)"
fi
"$LAUNCH" --reap KILL "run_${TAG}_reap" >/dev/null
if [ -n "$detached" ] && wait_gone "$detached"; then
  pass "--reap KILL ends it"
else
  fail "--reap KILL left $detached alive"
fi

# --- refusals ---------------------------------------------------------------------------
refused() {
  label=$1
  shift
  out=$("$@" 2>&1)
  code=$?
  if [ "$code" -eq 126 ]; then
    pass "refused: $label"
  else
    fail "not refused ($code): $label — $out"
  fi
}
refused "a uid below the floor (1000)" env VIBERR_LAUNCH_UID=1000 VIBERR_LAUNCH_EXEC=/bin/true "$LAUNCH"
refused "uid 0" env VIBERR_LAUNCH_UID=0 VIBERR_LAUNCH_EXEC=/bin/true "$LAUNCH"
refused "the probe uid (floor - 1)" env VIBERR_LAUNCH_UID=20000 VIBERR_LAUNCH_EXEC=/bin/true "$LAUNCH"
refused "a relative exec path" env VIBERR_LAUNCH_UID=$UID_A VIBERR_LAUNCH_EXEC=sh "$LAUNCH"
refused "a home outside the runtime homes" "$LAUNCH" --prepare-home "$UID_A" "$DATA/state"
refused "a .. in a home path" "$LAUNCH" --prepare-home "$UID_A" "$DATA/runtimes/users/../../state"
refused "a home inside another agent's home" "$LAUNCH" --prepare-home "$UID_A" "$HOME_B/inner"
refused "--reap with a malformed marker" "$LAUNCH" --reap KILL 'run;x'
if as_agent "$UID_A" "'$LAUNCH' --probe /" >/dev/null 2>&1; then
  fail "an agent could execute the launcher"
else
  pass "an agent cannot execute the launcher"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "agent isolation: every check holds"
  exit 0
fi
echo "agent isolation: $failures check(s) FAILED"
exit 1
