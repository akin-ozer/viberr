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
  # Ruling 485's tree, if its check stopped half-way: each uid removes its own.
  for agent in "$UID_B" "$UID_A"; do
    [ -d "$WS/support" ] && as_agent "$agent" "chmod -R u+rwX,g+rwX '$WS/support' 2>/dev/null; rm -rf '$WS/support' '$WS/deliver'" >/dev/null 2>&1
  done
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

# --- an agent-written tree is removed as its person (ruling 485) -------------
# F40-62, live on WEB-5: wrangler left 0700 `mkdtemp` directories in a
# supporting checkout, the server's own recursive remove deleted what the group
# could (`.git` first) and died on the rest, and every later review ran with no
# checkout. The server now removes such a tree as its person through the
# launcher, then as each other uid it can see in what is left
# (`removeAgentTree`, `app/server/runtimes/agent-trees.server.ts`). This runs
# that function itself (tsx ships in the image) against a checkout two agent
# uids wrote into, then clones fresh into the freed path as the person.
DELIVER="$WS/deliver"
SUPPORT="$WS/support/reviewer/website"
as_agent "$UID_A" "git init -q -b main '$DELIVER' && git -C '$DELIVER' -c user.email=a@t -c user.name=a commit -q --allow-empty -m one"
clone_support() {
  as_agent "$UID_A" "mkdir -p '$WS/support/reviewer' && git clone -q --no-local '$DELIVER' '$SUPPORT'"
}
clone_support
# What wrangler leaves (a directory only its uid can enter), and what a second
# person's agent left in the same tree (a task whose owner changed).
as_agent "$UID_A" "mkdir -p '$SUPPORT/.wrangler/tmp' && mkdir -m 0700 '$SUPPORT/.wrangler/tmp/dev-1wnDsF' \
  && echo a > '$SUPPORT/.wrangler/tmp/dev-1wnDsF/bundle.js'"
as_agent "$UID_B" "mkdir -m 0700 '$SUPPORT/by-another-owner' && echo b > '$SUPPORT/by-another-owner/f'"
if rm -rf "$SUPPORT" 2>/dev/null; then
  fail "the server's own rm -rf removed an agent's 0700 directory (this check proves nothing)"
elif [ ! -e "$SUPPORT/.git" ] && [ -d "$SUPPORT/.wrangler/tmp/dev-1wnDsF" ]; then
  pass "the server's own recursive remove dies half-way on an agent's 0700 directory, .git gone (F40-62)"
else
  fail "the server's own rm -rf failed without leaving the half-removed tree F40-62 found"
fi
APP_ROOT=$(cd "$(dirname "$0")/.." && pwd)
replaced=$(cd "$APP_ROOT" && node_modules/.bin/tsx -e "
  (async () => {
    const { removeAgentTree } = await import('./app/server/runtimes/agent-trees.server.ts');
    await removeAgentTree('$SUPPORT', { uid: $UID_A, launcher: '$LAUNCH' });
    console.log('removed');
  })().catch((error) => { console.error(String(error)); process.exit(1); });
" 2>&1)
if [ "$replaced" = "removed" ] && [ ! -e "$SUPPORT" ]; then
  pass "the server's replace removes the half-removed tree as its person, then as the other uid it found there"
else
  fail "the server's replace did not remove the tree: $replaced"
fi
clone_support
if [ -f "$SUPPORT/.git/HEAD" ] && [ "$(as_agent "$UID_A" "git -C '$SUPPORT' log -1 --format=%s")" = "one" ]; then
  pass "the fresh clone into the freed path has .git/HEAD"
else
  fail "the fresh clone into the freed path has no .git/HEAD"
fi
as_agent "$UID_A" "rm -rf '$WS/support' '$DELIVER'"

# --- what the server wrote in an agent tree (ruling 495) --------------------
# F40-71, live on deploy 10: the skill mount copied each granted skill into a
# run's plugin as the server with `cpSync`, which keeps the store folder's
# modes, so the plugin's files sat in 0755 folders the person could not write
# and every run's settle failed to remove it (52 plugins left); and a finished
# task's workspace root is the server's, in a task directory only the server
# writes, so no agent uid could unlink it, empty or not (15 workspaces logged
# on every boot). The mount now leaves every folder 2775 and every file
# group-readable; the removal opens what the server wrote before that
# (`chmod -R -P g+rwX` as the server) and removes an emptied root the server
# owns with `rmdir` (`removeAgentTree`, run with the image's `tsx`).
if [ "$(cat /proc/sys/fs/protected_hardlinks 2>/dev/null)" = "1" ]; then
  pass "the kernel protects hard links (fs.protected_hardlinks = 1)"
else
  fail "fs.protected_hardlinks is '$(cat /proc/sys/fs/protected_hardlinks 2>&1)', not 1"
fi
(umask 0022 && echo server > "$WS/server-file")
if as_agent "$UID_A" "ln '$WS/server-file' '$WS/agent-link'" >/dev/null 2>&1; then
  fail "an agent hard-linked a server file it cannot write into its tree"
else
  pass "an agent cannot hard-link a server file it cannot write into its tree"
fi
rm -f "$WS/server-file" "$WS/agent-link" 2>/dev/null
mkdir -p "$WS/opened-not" && chmod 0700 "$WS/opened-not" && ln -s "$WS/opened-not" "$WS/link-to-opened-not"
chmod -R -P g+rwX -- "$WS/link-to-opened-not" 2>/dev/null
if [ "$(stat -c '%a' "$WS/opened-not")" = "700" ]; then
  pass "the server's chmod -R -P follows no link it is handed"
else
  fail "the server's chmod -R -P followed a link to $(stat -c '%a' "$WS/opened-not")"
fi
rm -rf "$WS/opened-not" "$WS/link-to-opened-not"
# One server call through the image's tsx (APP_ROOT, above): prints what it
# printed, or the error. The server's own umask (0002), as boot sets it.
as_server_ts() {
  (cd "$APP_ROOT" && umask 0002 && LOG_LEVEL=error node_modules/.bin/tsx -e "
    (async () => { $1 })().catch((error) => { console.error(String(error)); process.exit(1); });
  " 2>&1)
}
remove_as_person() {
  as_server_ts "
    const { removeAgentTree } = await import('./app/server/runtimes/agent-trees.server.ts');
    await removeAgentTree('$1', { uid: $UID_A, launcher: '$LAUNCH' });
    console.log('removed');"
}
# A task directory only the server writes, holding a workspace the agents'
# group writes, as `enforceStoreLayout` leaves them.
TASK="$WS/tasks/WEB-2"
TASK_WS="$TASK/workspace"
mkdir -p "$TASK" && chgrp "$(id -g)" "$WS/tasks" "$TASK" && chmod 0755 "$WS/tasks" "$TASK"
mkdir "$TASK_WS" && chgrp viberr-agents "$TASK_WS" && chmod 2770 "$TASK_WS"
as_agent "$UID_A" "mkdir -p '$TASK_WS/website' && echo hi > '$TASK_WS/website/index.html'"
# A store skill at the modes that made F40-71: a 0755 folder (and, worse, a
# 0700 one and a 0600 file, which cpSync kept too).
SKILL_SRC="$WS/store/skills/sourced-content"
mkdir -p "$SKILL_SRC/checklists/deep"
echo "# Sourced content" > "$SKILL_SRC/SKILL.md"
echo "# Claims" > "$SKILL_SRC/checklists/deep/claims.md"
chmod 0755 "$WS/store" "$WS/store/skills" "$SKILL_SRC" "$SKILL_SRC/checklists"
chmod 0700 "$SKILL_SRC/checklists/deep"
chmod 0644 "$SKILL_SRC/SKILL.md"
chmod 0600 "$SKILL_SRC/checklists/deep/claims.md"
plugin=$(as_server_ts "
    const { mountGrantedSkills } = await import('./app/server/runtimes/skill-mount.server.ts');
    const mount = await mountGrantedSkills({ workspaceDir: '$TASK_WS/website', skills: ['sourced-content'],
      runId: 'run_${TAG}', dataRoot: '$WS/store', git: null });
    console.log(mount.plugin ? mount.plugin.path : 'nothing mounted: ' + JSON.stringify(mount.skipped));")
if [ -d "$plugin/skills/sourced-content" ] && [ -z "$(find "$plugin" -type d ! -perm 2775)" ] \
  && [ -z "$(find "$plugin" -type f ! -perm -g+r)" ]; then
  pass "the skill mount leaves every folder of a run's plugin 2775 and every file group-readable"
else
  fail "the skill mount's plugin: $plugin $(find "$plugin" -printf '%m %u:%g %p\n' 2>/dev/null | tr '\n' ';')"
fi
if as_agent "$UID_A" "cat '$plugin/skills/sourced-content/checklists/deep/claims.md'" | grep -qx "# Claims"; then
  pass "the run's person reads a skill file the store kept 0600"
else
  fail "the run's person cannot read the mounted skill's 0600 file"
fi
if as_agent "$UID_A" "rm -rf '$plugin'" && [ ! -e "$plugin" ]; then
  pass "the person's own rm removes a run's plugin the server mounted (a run's settle)"
else
  fail "the person's own rm could not remove the mounted plugin"
fi
# What the mount wrote before this ruling: the folder at the store's 0755,
# its file in the server's group.
OLD="$TASK_WS/.viberr-plugins/run_before-495"
(umask 0002 && mkdir -p "$OLD/skills/sourced-content" && chmod 0755 "$OLD/skills/sourced-content" \
  && echo "# Sourced content" > "$OLD/skills/sourced-content/SKILL.md")
as_agent "$UID_A" "rm -rf '$OLD'" 2>/dev/null
if [ -f "$OLD/skills/sourced-content/SKILL.md" ]; then
  pass "the person alone cannot remove a plugin the mount wrote before ruling 495 (F40-71)"
else
  fail "the person removed the old plugin alone (this check proves nothing)"
fi
removed=$(remove_as_person "$OLD")
if [ "$removed" = "removed" ] && [ ! -e "$OLD" ]; then
  pass "the removal opens the server's residue (chmod -R -P g+rwX as the server) and the person removes it"
else
  fail "the removal did not remove the server's residue: $removed"
fi
# The finished task's workspace: the person empties it and cannot unlink it.
as_agent "$UID_A" "rm -rf '$TASK_WS'" 2>/dev/null
if [ -d "$TASK_WS" ] && [ -z "$(ls -A "$TASK_WS")" ]; then
  pass "no agent uid may unlink the server's workspace root, even emptied (F40-71)"
else
  fail "the workspace root is not the emptied, unremovable root F40-71 found: $(ls -la "$TASK_WS" 2>&1 | tr '\n' ';')"
fi
removed=$(remove_as_person "$TASK_WS")
if [ "$removed" = "removed" ] && [ ! -e "$TASK_WS" ] && [ -d "$TASK" ]; then
  pass "the server's rmdir removes the emptied workspace root it owns, and nothing above it"
else
  fail "the emptied workspace root was not removed: $removed"
fi

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
